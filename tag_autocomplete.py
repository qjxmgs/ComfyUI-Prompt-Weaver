import asyncio
import calendar
import csv
import hashlib
import json
import os
import tempfile
import threading
import time
import unicodedata
from pathlib import Path
from urllib.parse import urlparse


CHECK_INTERVAL_SECONDS = 7 * 24 * 60 * 60
MAX_MANIFEST_BYTES = 64 * 1024
MAX_DATASET_BYTES = 8 * 1024 * 1024
MAX_QUERY_LENGTH = 128
MAX_RESOLVE_TAGS = 256
DEFAULT_RESULT_LIMIT = 20
MAX_RESULT_LIMIT = 50
MANIFEST_SCHEMA_VERSION = 1
METADATA_SCHEMA_VERSION = 1
REMOTE_MANIFEST_URL = (
    "https://raw.githubusercontent.com/qjxmgs/ComfyUI-Prompt-Weaver/"
    "master/data/tag_sources.json"
)
ALLOWED_DOWNLOAD_HOSTS = frozenset({"huggingface.co", "raw.githubusercontent.com"})
EXPECTED_SOURCE_FILES = {
    "base": "danbooru.base.csv",
    "zh-CN": "danbooru.zh-CN.csv",
}
EXPECTED_SOURCE_FORMATS = {
    "base": "danbooru_tag_csv_v1",
    "zh-CN": "tag_translation_csv_v1",
}
BASE_HEADER = ["tag", "category", "count", "alias"]


class TagAutocompleteError(Exception):
    pass


class TagAutocompleteValidationError(TagAutocompleteError):
    pass


class TagAutocompleteUnavailableError(TagAutocompleteError):
    pass


def normalize_locale(value):
    locale = str(value or "").strip().replace("_", "-").lower()
    if locale == "zh" or locale.startswith("zh-cn") or locale.startswith("zh-hans"):
        return "zh-CN"
    return "en"


def _normalize_search_text(value):
    return unicodedata.normalize("NFKC", str(value or "")).strip().casefold()


def _canonical_search_text(value):
    return _normalize_search_text(value).replace(" ", "_")


def _compact_fuzzy_text(value):
    return "".join(
        character
        for character in _normalize_search_text(value)
        if not character.isspace() and character not in "_-"
    )


def _contains_han(value):
    return any(
        "CJK UNIFIED IDEOGRAPH" in unicodedata.name(character, "")
        or "CJK COMPATIBILITY IDEOGRAPH" in unicodedata.name(character, "")
        for character in value
    )


def _fuzzy_query_is_eligible(value):
    query = _compact_fuzzy_text(value)
    if not query:
        return False
    return len(query) >= (2 if _contains_han(query) else 3)


def _ordered_subsequence_score(field_value, query_value):
    if not _fuzzy_query_is_eligible(query_value):
        return None
    field = _compact_fuzzy_text(field_value)
    query = _compact_fuzzy_text(query_value)
    return _ordered_subsequence_score_compact(field, query)


def _ordered_subsequence_score_compact(field, query):
    if not field or len(query) > len(field):
        return None

    query_index = 0
    first = -1
    last = -1
    for index, character in enumerate(field):
        if character != query[query_index]:
            continue
        if first < 0:
            first = index
        last = index
        query_index += 1
        if query_index == len(query):
            return first, last - first + 1 - len(query), len(field)
    return None


def _iso_timestamp(now):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))


def _parse_timestamp(value):
    if not isinstance(value, str) or not value:
        return 0.0
    try:
        return float(calendar.timegm(time.strptime(value, "%Y-%m-%dT%H:%M:%SZ")))
    except (OverflowError, ValueError):
        return 0.0


def _atomic_write_json(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_path = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=str(path.parent),
    )
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    except Exception:
        try:
            os.unlink(temporary_path)
        except FileNotFoundError:
            pass
        raise


def _read_json_file(path, label):
    try:
        raw = Path(path).read_bytes()
    except OSError as error:
        raise TagAutocompleteValidationError(f"could not read {label}: {error}") from error
    if len(raw) > MAX_MANIFEST_BYTES:
        raise TagAutocompleteValidationError(f"{label} is too large")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TagAutocompleteValidationError(f"{label} is invalid JSON: {error}") from error
    if not isinstance(payload, dict):
        raise TagAutocompleteValidationError(f"{label} must be an object")
    return payload


def _validate_https_url(value, label):
    if not isinstance(value, str):
        raise TagAutocompleteValidationError(f"{label} URL is missing")
    parsed = urlparse(value)
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_DOWNLOAD_HOSTS:
        raise TagAutocompleteValidationError(f"{label} URL is not an allowed HTTPS source")


def _header_value(headers, name):
    expected = name.casefold()
    for key, value in (headers or {}).items():
        if str(key).casefold() == expected:
            return str(value)
    return ""


def validate_manifest(payload):
    if not isinstance(payload, dict) or payload.get("schema_version") != MANIFEST_SCHEMA_VERSION:
        raise TagAutocompleteValidationError("unsupported tag source manifest schema")
    version = payload.get("version")
    if not isinstance(version, str) or not version.strip() or len(version) > 64:
        raise TagAutocompleteValidationError("tag source manifest version is invalid")
    if payload.get("content_scope") != "full":
        raise TagAutocompleteValidationError("tag source manifest content scope is invalid")
    sources = payload.get("sources")
    if not isinstance(sources, dict) or "base" not in sources:
        raise TagAutocompleteValidationError("tag source manifest has no base source")

    normalized_sources = {}
    for source_id in EXPECTED_SOURCE_FILES:
        source = sources.get(source_id)
        if source is None and source_id != "base":
            continue
        if not isinstance(source, dict):
            raise TagAutocompleteValidationError(f"tag source {source_id} is invalid")
        if source.get("filename") != EXPECTED_SOURCE_FILES[source_id]:
            raise TagAutocompleteValidationError(f"tag source {source_id} filename is invalid")
        if source.get("format") != EXPECTED_SOURCE_FORMATS[source_id]:
            raise TagAutocompleteValidationError(f"tag source {source_id} format is invalid")
        _validate_https_url(source.get("url"), f"tag source {source_id}")
        digest = source.get("sha256")
        if (
            not isinstance(digest, str)
            or len(digest) != 64
            or any(character not in "0123456789abcdefABCDEF" for character in digest)
        ):
            raise TagAutocompleteValidationError(f"tag source {source_id} SHA-256 is invalid")
        size_bytes = source.get("size_bytes")
        min_rows = source.get("min_rows")
        if not isinstance(size_bytes, int) or size_bytes <= 0 or size_bytes > MAX_DATASET_BYTES:
            raise TagAutocompleteValidationError(f"tag source {source_id} size is invalid")
        if not isinstance(min_rows, int) or min_rows <= 0:
            raise TagAutocompleteValidationError(f"tag source {source_id} row limit is invalid")
        for field in ("license", "attribution", "source_page"):
            if not isinstance(source.get(field), str) or not source[field].strip():
                raise TagAutocompleteValidationError(f"tag source {source_id} {field} is invalid")
        normalized_sources[source_id] = {
            **source,
            "sha256": digest.lower(),
        }

    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "version": version.strip(),
        "published_at": str(payload.get("published_at") or ""),
        "content_scope": "full",
        "sources": normalized_sources,
    }


def _validate_dataset_bytes(source_id, source, payload):
    if len(payload) != source["size_bytes"]:
        raise TagAutocompleteValidationError(
            f"tag source {source_id} has unexpected size {len(payload)}"
        )
    digest = hashlib.sha256(payload).hexdigest()
    if digest != source["sha256"]:
        raise TagAutocompleteValidationError(f"tag source {source_id} failed SHA-256 validation")
    try:
        text = payload.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise TagAutocompleteValidationError(f"tag source {source_id} is not UTF-8") from error

    reader = csv.reader(text.splitlines())
    row_count = 0
    if source_id == "base":
        try:
            header = next(reader)
        except StopIteration as error:
            raise TagAutocompleteValidationError("base tag source is empty") from error
        if header != BASE_HEADER:
            raise TagAutocompleteValidationError("base tag source header is invalid")
        for row in reader:
            if len(row) != 4 or not row[0].strip():
                raise TagAutocompleteValidationError("base tag source contains an invalid row")
            try:
                int(row[1])
                count = int(row[2])
            except ValueError as error:
                raise TagAutocompleteValidationError(
                    "base tag source contains invalid category or count data"
                ) from error
            if count < 0:
                raise TagAutocompleteValidationError("base tag source contains a negative count")
            row_count += 1
    else:
        for row in reader:
            if not row:
                continue
            if len(row) != 2 or not row[0].strip() or not row[1].strip():
                raise TagAutocompleteValidationError(
                    f"tag source {source_id} contains an invalid translation row"
                )
            row_count += 1
    if row_count < source["min_rows"]:
        raise TagAutocompleteValidationError(
            f"tag source {source_id} contains only {row_count} rows"
        )
    return row_count


async def _default_fetch(url, *, headers=None, maximum_bytes=MAX_DATASET_BYTES):
    import aiohttp

    timeout = aiohttp.ClientTimeout(total=60, connect=15, sock_read=30)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(url, headers=headers or {}, allow_redirects=True) as response:
            if response.status == 304:
                return response.status, b"", dict(response.headers)
            if response.status != 200:
                raise TagAutocompleteUnavailableError(
                    f"download failed with HTTP {response.status}"
                )
            content_length = response.headers.get("Content-Length")
            if content_length:
                try:
                    if int(content_length) > maximum_bytes:
                        raise TagAutocompleteValidationError("download is too large")
                except ValueError:
                    pass
            chunks = []
            total = 0
            async for chunk in response.content.iter_chunked(64 * 1024):
                total += len(chunk)
                if total > maximum_bytes:
                    raise TagAutocompleteValidationError("download is too large")
                chunks.append(chunk)
            return response.status, b"".join(chunks), dict(response.headers)


class TagAutocompleteStore:
    def __init__(
        self,
        metadata_path,
        manifest_path,
        *,
        remote_manifest_url=REMOTE_MANIFEST_URL,
        fetcher=None,
        now=None,
    ):
        self.metadata_path = Path(metadata_path)
        self.root = self.metadata_path.parent
        self.manifest_path = Path(manifest_path)
        self.remote_manifest_url = remote_manifest_url
        self.fetcher = fetcher or _default_fetch
        self.now = now or time.time
        self._update_task = None
        self._update_lock = asyncio.Lock()
        self._cache_lock = threading.RLock()
        self._search_cache_key = None
        self._search_records = []
        self._resolve_cache_key = None
        self._resolve_index = {}
        self._last_error = ""

    def bundled_manifest(self):
        return validate_manifest(_read_json_file(self.manifest_path, "bundled tag source manifest"))

    def _read_metadata(self):
        if not self.metadata_path.exists():
            return {
                "schema_version": METADATA_SCHEMA_VERSION,
                "sources": {},
            }
        payload = _read_json_file(self.metadata_path, "tag autocomplete metadata")
        if payload.get("schema_version") != METADATA_SCHEMA_VERSION:
            raise TagAutocompleteValidationError("unsupported tag autocomplete metadata schema")
        if not isinstance(payload.get("sources"), dict):
            raise TagAutocompleteValidationError("tag autocomplete metadata sources are invalid")
        return payload

    def _write_metadata(self, metadata):
        metadata = {
            **metadata,
            "schema_version": METADATA_SCHEMA_VERSION,
            "sources": dict(metadata.get("sources") or {}),
        }
        _atomic_write_json(self.metadata_path, metadata)

    def _source_path(self, source_id):
        return self.root / EXPECTED_SOURCE_FILES[source_id]

    def _source_is_available(self, metadata, source_id):
        source_metadata = metadata.get("sources", {}).get(source_id)
        path = self._source_path(source_id)
        return (
            isinstance(source_metadata, dict)
            and isinstance(source_metadata.get("sha256"), str)
            and path.is_file()
            and path.stat().st_size > 0
        )

    def status(self, locale="en"):
        normalized_locale = normalize_locale(locale)
        try:
            metadata = self._read_metadata()
        except TagAutocompleteError as error:
            metadata = {"schema_version": METADATA_SCHEMA_VERSION, "sources": {}}
            self._last_error = str(error)
        base_available = self._source_is_available(metadata, "base")
        translation_required = normalized_locale == "zh-CN"
        translation_available = self._source_is_available(metadata, "zh-CN")
        row_count = 0
        source_metadata = metadata.get("sources", {}).get("base")
        if isinstance(source_metadata, dict) and isinstance(source_metadata.get("rows"), int):
            row_count = source_metadata["rows"]
        return {
            "available": base_available,
            "ready": base_available and (not translation_required or translation_available),
            "needs_download": not base_available or (translation_required and not translation_available),
            "translation_available": translation_available,
            "locale": normalized_locale,
            "version": metadata.get("manifest_version") or "",
            "row_count": row_count,
            "last_checked_at": metadata.get("last_checked_at") or "",
            "last_updated_at": metadata.get("last_updated_at") or "",
            "updating": bool(self._update_task and not self._update_task.done()),
            "error": self._last_error,
            "content_scope": "full",
        }

    def _weekly_check_due(self):
        try:
            metadata = self._read_metadata()
        except TagAutocompleteError:
            return False
        last_checked = _parse_timestamp(metadata.get("last_checked_at"))
        return self.now() - last_checked >= CHECK_INTERVAL_SECONDS

    def maybe_start_weekly_check(self, locale="en"):
        state = self.status(locale)
        if state["ready"] and self._weekly_check_due():
            self.start_update(locale, force=False)
        return self.status(locale)

    def start_update(self, locale="en", *, force=True):
        if self._update_task and not self._update_task.done():
            return self._update_task
        self._update_task = asyncio.create_task(self.update(locale, force=force))
        return self._update_task

    async def _fetch_manifest(self, metadata):
        bundled = self.bundled_manifest()
        if not self.remote_manifest_url:
            return bundled, metadata.get("manifest_etag") or ""
        headers = {}
        if metadata.get("manifest_etag"):
            headers["If-None-Match"] = metadata["manifest_etag"]
        try:
            status, payload, response_headers = await self.fetcher(
                self.remote_manifest_url,
                headers=headers,
                maximum_bytes=MAX_MANIFEST_BYTES,
            )
            if status == 304:
                installed_manifest = metadata.get("manifest")
                if installed_manifest:
                    return (
                        validate_manifest(installed_manifest),
                        metadata.get("manifest_etag") or "",
                    )
                return bundled, metadata.get("manifest_etag") or ""
            if status != 200:
                raise TagAutocompleteUnavailableError(
                    f"manifest download failed with HTTP {status}"
                )
            try:
                remote_payload = json.loads(payload.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise TagAutocompleteValidationError(
                    f"remote tag source manifest is invalid JSON: {error}"
                ) from error
            manifest = validate_manifest(remote_payload)
            installed_version = str(metadata.get("manifest_version") or "")
            if installed_version and manifest["version"] < installed_version:
                installed_manifest = metadata.get("manifest")
                if installed_manifest:
                    return (
                        validate_manifest(installed_manifest),
                        metadata.get("manifest_etag") or "",
                    )
                raise TagAutocompleteValidationError(
                    "remote tag source manifest is older than the installed manifest"
                )
            return manifest, _header_value(response_headers, "etag")
        except Exception:
            if not self._source_is_available(metadata, "base"):
                return bundled, metadata.get("manifest_etag") or ""
            raise

    async def update(self, locale="en", *, force=True):
        del force  # Calling update already bypasses the seven-day scheduling gate.
        normalized_locale = normalize_locale(locale)
        async with self._update_lock:
            self._last_error = ""
            now = self.now()
            try:
                metadata = self._read_metadata()
                manifest, manifest_etag = await self._fetch_manifest(metadata)
                required_sources = ["base"]
                if normalized_locale == "zh-CN" and "zh-CN" in manifest["sources"]:
                    required_sources.append("zh-CN")

                staged = []
                next_sources = dict(metadata.get("sources") or {})
                try:
                    for source_id in required_sources:
                        source = manifest["sources"][source_id]
                        installed = next_sources.get(source_id)
                        target_path = self._source_path(source_id)
                        if (
                            isinstance(installed, dict)
                            and installed.get("sha256") == source["sha256"]
                            and target_path.is_file()
                            and target_path.stat().st_size == source["size_bytes"]
                        ):
                            continue
                        _validate_https_url(source["url"], f"tag source {source_id}")
                        status, payload, response_headers = await self.fetcher(
                            source["url"],
                            headers={},
                            maximum_bytes=min(MAX_DATASET_BYTES, source["size_bytes"] + 1),
                        )
                        if status != 200:
                            raise TagAutocompleteUnavailableError(
                                f"tag source {source_id} download failed with HTTP {status}"
                            )
                        row_count = _validate_dataset_bytes(source_id, source, payload)
                        self.root.mkdir(parents=True, exist_ok=True)
                        file_descriptor, temporary_path = tempfile.mkstemp(
                            prefix=f".{target_path.name}.",
                            suffix=".tmp",
                            dir=str(self.root),
                        )
                        try:
                            with os.fdopen(file_descriptor, "wb") as handle:
                                handle.write(payload)
                                handle.flush()
                                os.fsync(handle.fileno())
                        except Exception:
                            try:
                                os.unlink(temporary_path)
                            except FileNotFoundError:
                                pass
                            raise
                        staged.append((source_id, Path(temporary_path), target_path))
                        next_sources[source_id] = {
                            "sha256": source["sha256"],
                            "rows": row_count,
                            "etag": _header_value(response_headers, "etag"),
                            "downloaded_at": _iso_timestamp(now),
                            "license": source["license"],
                            "attribution": source["attribution"],
                            "source_page": source["source_page"],
                        }

                    for _source_id, temporary_path, target_path in staged:
                        os.replace(temporary_path, target_path)
                finally:
                    for _source_id, temporary_path, _target_path in staged:
                        try:
                            temporary_path.unlink()
                        except FileNotFoundError:
                            pass

                changed = bool(staged)
                metadata = {
                    **metadata,
                    "schema_version": METADATA_SCHEMA_VERSION,
                    "manifest_version": manifest["version"],
                    "manifest": manifest,
                    "manifest_etag": manifest_etag,
                    "last_checked_at": _iso_timestamp(now),
                    "last_updated_at": (
                        _iso_timestamp(now) if changed else metadata.get("last_updated_at") or ""
                    ),
                    "sources": next_sources,
                }
                self._write_metadata(metadata)
                if changed:
                    with self._cache_lock:
                        self._search_cache_key = None
                        self._search_records = []
                        self._resolve_cache_key = None
                        self._resolve_index = {}
                return self.status(normalized_locale)
            except Exception as error:
                self._last_error = str(error)
                try:
                    metadata = self._read_metadata()
                    metadata["last_checked_at"] = _iso_timestamp(now)
                    self._write_metadata(metadata)
                except Exception:
                    pass
                raise

    def _cache_key(self, locale):
        paths = [self._source_path("base")]
        if locale == "zh-CN":
            paths.append(self._source_path("zh-CN"))
        result = [locale]
        for path in paths:
            if path.is_file():
                stat = path.stat()
                result.extend((str(path), stat.st_mtime_ns, stat.st_size))
            else:
                result.extend((str(path), 0, 0))
        return tuple(result)

    def _load_records(self, locale):
        base_path = self._source_path("base")
        if not base_path.is_file():
            raise TagAutocompleteUnavailableError("Danbooru tag dictionary has not been downloaded")

        translations = {}
        translation_path = self._source_path("zh-CN")
        if locale == "zh-CN" and translation_path.is_file():
            try:
                with translation_path.open("r", encoding="utf-8-sig", newline="") as handle:
                    for row in csv.reader(handle):
                        if len(row) == 2 and row[0].strip() and row[1].strip():
                            translations[_canonical_search_text(row[0])] = row[1].strip()
            except (OSError, UnicodeError, csv.Error) as error:
                raise TagAutocompleteValidationError(
                    f"could not read Chinese tag translations: {error}"
                ) from error

        records = []
        try:
            with base_path.open("r", encoding="utf-8-sig", newline="") as handle:
                reader = csv.DictReader(handle)
                if reader.fieldnames != BASE_HEADER:
                    raise TagAutocompleteValidationError("base tag source header is invalid")
                for index, row in enumerate(reader):
                    tag = str(row.get("tag") or "").strip()
                    if not tag:
                        continue
                    try:
                        category = int(row.get("category") or 0)
                        post_count = max(0, int(row.get("count") or 0))
                    except ValueError:
                        continue
                    canonical = _canonical_search_text(tag)
                    ascii_aliases = []
                    for alias in str(row.get("alias") or "").split(","):
                        normalized_alias = _normalize_search_text(alias)
                        if normalized_alias and normalized_alias.isascii():
                            ascii_aliases.append(normalized_alias.replace(" ", "_"))
                    translation = translations.get(canonical, "")
                    records.append({
                        "tag": tag,
                        "insert_text": tag.replace("_", " "),
                        "translation": translation,
                        "category": category,
                        "post_count": post_count,
                        "source": "danbooru",
                        "_canonical": canonical,
                        "_aliases": tuple(dict.fromkeys(ascii_aliases)),
                        "_translation": _normalize_search_text(translation),
                        "_fuzzy_canonical": _compact_fuzzy_text(canonical),
                        "_fuzzy_aliases": tuple(
                            _compact_fuzzy_text(alias)
                            for alias in dict.fromkeys(ascii_aliases)
                        ),
                        "_fuzzy_translation": _compact_fuzzy_text(translation),
                        "_index": index,
                    })
        except (OSError, UnicodeError, csv.Error) as error:
            raise TagAutocompleteValidationError(f"could not read base tag dictionary: {error}") from error
        return records

    def _records_for_locale(self, locale):
        cache_key = self._cache_key(locale)
        with self._cache_lock:
            if cache_key != self._search_cache_key:
                self._search_records = self._load_records(locale)
                self._search_cache_key = cache_key
                self._resolve_cache_key = None
                self._resolve_index = {}
            return self._search_records

    def _exact_index_for_locale(self, locale):
        cache_key = self._cache_key(locale)
        with self._cache_lock:
            if cache_key != self._search_cache_key:
                self._search_records = self._load_records(locale)
                self._search_cache_key = cache_key
                self._resolve_cache_key = None
                self._resolve_index = {}
            if cache_key != self._resolve_cache_key:
                index = {}
                for record in self._search_records:
                    for key in (record["_canonical"], *record["_aliases"]):
                        if key:
                            index.setdefault(key, record)
                self._resolve_index = index
                self._resolve_cache_key = cache_key
            return self._resolve_index

    def resolve(self, tags, locale="zh-CN"):
        if not isinstance(tags, list):
            raise TagAutocompleteValidationError("tag autocomplete resolve tags must be an array")
        if len(tags) > MAX_RESOLVE_TAGS:
            raise TagAutocompleteValidationError("too many tags to resolve")

        normalized_values = []
        for value in tags:
            if not isinstance(value, str):
                raise TagAutocompleteValidationError("tag autocomplete resolve values must be strings")
            normalized = _normalize_search_text(value)
            if len(normalized) > MAX_QUERY_LENGTH:
                raise TagAutocompleteValidationError("tag autocomplete resolve value is too long")
            normalized_values.append(normalized)
        if not normalized_values:
            return []

        normalized_locale = normalize_locale(locale)
        exact_index = self._exact_index_for_locale(normalized_locale)
        results = []
        for normalized in normalized_values:
            record = exact_index.get(normalized.replace(" ", "_")) if normalized else None
            if record is None:
                results.append(None)
                continue
            results.append({
                "tag": record["tag"],
                "insert_text": record["insert_text"],
                "translation": record["translation"],
                "category": record["category"],
                "post_count": record["post_count"],
                "source": "danbooru",
            })
        return results

    @staticmethod
    def _match_record(record, query, canonical_query, fuzzy_query):
        def rank_field(field, candidate_query, fuzzy_field):
            if field == candidate_query:
                return 0, None
            if field.startswith(candidate_query):
                return 1, None
            if candidate_query in field:
                return 2, None
            score = (
                _ordered_subsequence_score_compact(fuzzy_field, fuzzy_query)
                if fuzzy_query
                else None
            )
            return (3, score) if score is not None else (4, None)

        best = rank_field(
            record["_canonical"],
            canonical_query,
            record["_fuzzy_canonical"],
        )
        if record["_translation"]:
            candidate = rank_field(
                record["_translation"],
                query,
                record["_fuzzy_translation"],
            )
            if candidate[0] < best[0] or (
                candidate[0] == best[0] == 3 and candidate[1] < best[1]
            ):
                best = candidate
        for alias, fuzzy_alias in zip(record["_aliases"], record["_fuzzy_aliases"]):
            candidate = rank_field(alias, canonical_query, fuzzy_alias)
            if candidate[0] < 2:
                candidate = 2, None
            if candidate[0] < best[0] or (
                candidate[0] == best[0] == 3 and candidate[1] < best[1]
            ):
                best = candidate
        return best

    def search(self, query, locale="en", limit=DEFAULT_RESULT_LIMIT):
        normalized_query = _normalize_search_text(query)
        if not normalized_query:
            return []
        if len(normalized_query) > MAX_QUERY_LENGTH:
            raise TagAutocompleteValidationError("tag autocomplete query is too long")
        try:
            safe_limit = int(limit)
        except (TypeError, ValueError) as error:
            raise TagAutocompleteValidationError("tag autocomplete limit is invalid") from error
        if safe_limit < 1 or safe_limit > MAX_RESULT_LIMIT:
            raise TagAutocompleteValidationError("tag autocomplete limit is out of range")
        normalized_locale = normalize_locale(locale)
        canonical_query = normalized_query.replace(" ", "_")
        fuzzy_query = (
            _compact_fuzzy_text(normalized_query)
            if _fuzzy_query_is_eligible(normalized_query)
            else ""
        )
        matches = []
        for record in self._records_for_locale(normalized_locale):
            rank, score = self._match_record(
                record,
                normalized_query,
                canonical_query,
                fuzzy_query,
            )
            if rank < 4:
                score_key = score if score is not None else (0, 0, 0)
                matches.append((rank, score_key, -record["post_count"], record["_index"], record))
        matches.sort(key=lambda item: item[:4])
        result = []
        for rank, score, _negative_count, _index, record in matches[:safe_limit]:
            item = {
                "tag": record["tag"],
                "insert_text": record["insert_text"],
                "translation": record["translation"],
                "category": record["category"],
                "post_count": record["post_count"],
                "source": "danbooru",
                "match_rank": rank,
            }
            if rank == 3:
                item["match_score"] = {
                    "start": score[0],
                    "gaps": score[1],
                    "length": score[2],
                }
            result.append(item)
        return result
