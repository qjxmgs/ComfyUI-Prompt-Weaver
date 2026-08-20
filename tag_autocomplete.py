import asyncio
import csv
import hashlib
import json
import os
import re
import sqlite3
import tempfile
import threading
import time
import unicodedata
from pathlib import Path
from urllib.parse import urlparse


MAX_MANIFEST_BYTES = 64 * 1024
MAX_DATASET_BYTES = 8 * 1024 * 1024
MAX_SQLITE_DATASET_BYTES = 64 * 1024 * 1024
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
ALLOWED_DOWNLOAD_HOSTS = frozenset({
    "api.github.com",
    "huggingface.co",
    "raw.githubusercontent.com",
})
EXPECTED_SOURCE_FILES = {
    "base": "danbooru.base.csv",
    "zh-CN": "danbooru.zh-CN.csv",
    "zh-CN-supplement": "danbooru.zh-CN.supplement.sqlite",
}
EXPECTED_SOURCE_FORMATS = {
    "base": "danbooru_tag_csv_v1",
    "zh-CN": "tag_translation_csv_v1",
    "zh-CN-supplement": "tag_translation_sqlite_v1",
}
BASE_HEADER = ["tag", "category", "count", "alias"]
SUPPLEMENT_SOURCE_ID = "zh-CN-supplement"
SUPPLEMENT_REQUIRED_COLUMNS = {
    "name": "TEXT",
    "category": "INTEGER",
    "cn_name": "TEXT",
    "post_count": "INTEGER",
}
SUPPLEMENT_QUERY_BATCH_SIZE = 500
SUPPLEMENT_REPOSITORY = "ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table"
SUPPLEMENT_REF = "main"
SUPPLEMENT_REMOTE_PATH = "tag.sqlite"
LOCAL_SUPPLEMENT_FILENAME = "tag.sqlite"
LOCAL_SUPPLEMENT_DROP_IN_PATH = (
    "ComfyUI-Prompt-Weaver/tag-autocomplete/tag.sqlite"
)


class TagAutocompleteError(Exception):
    pass


class TagAutocompleteValidationError(TagAutocompleteError):
    pass


class TagAutocompleteUnavailableError(TagAutocompleteError):
    pass


class TagAutocompleteCapacityError(TagAutocompleteError):
    pass


def normalize_locale(value):
    locale = str(value or "").strip().replace("_", "-").lower()
    if locale == "zh" or locale.startswith("zh-cn") or locale.startswith("zh-hans"):
        return "zh-CN"
    return "en"


def _normalize_search_text(value):
    text = unicodedata.normalize("NFKC", str(value or "")).strip().casefold()
    # ComfyUI escapes literal grouping characters in prompts (for example
    # ``karin \\(blue archive\\)``), while Danbooru stores the tag without
    # those prompt-syntax escapes. Treat the escaped and unescaped forms as
    # the same lookup key without changing the original text used for insert.
    return re.sub(r"\\([()\[\]{}])", r"\1", text)


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


def _sha256_file(path):
    digest = hashlib.sha256()
    try:
        with Path(path).open("rb") as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
    except OSError as error:
        raise TagAutocompleteValidationError(
            f"could not hash local supplement source: {error}"
        ) from error
    return digest.hexdigest()


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


def _validate_source_attribution(source_id, source):
    for field in ("license", "attribution", "source_page"):
        if not isinstance(source.get(field), str) or not source[field].strip():
            raise TagAutocompleteValidationError(f"tag source {source_id} {field} is invalid")


def _validate_static_source(source_id, source):
    _validate_https_url(source.get("url"), f"tag source {source_id}")
    digest = source.get("sha256")
    if (
        not isinstance(digest, str)
        or len(digest) != 64
        or any(character not in "0123456789abcdefABCDEF" for character in digest)
    ):
        raise TagAutocompleteValidationError(f"tag source {source_id} SHA-256 is invalid")
    size_bytes = source.get("size_bytes")
    if not isinstance(size_bytes, int) or size_bytes <= 0 or size_bytes > MAX_DATASET_BYTES:
        raise TagAutocompleteValidationError(f"tag source {source_id} size is invalid")
    return {
        **source,
        "sha256": digest.lower(),
    }


def _validate_supplement_source(source_id, source):
    enabled = source.get("enabled")
    if not isinstance(enabled, bool):
        raise TagAutocompleteValidationError(f"tag source {source_id} enabled state is invalid")
    license_status = source.get("license_status")
    if license_status not in {"pending", "cleared", "user-directed"}:
        raise TagAutocompleteValidationError(f"tag source {source_id} license status is invalid")
    if enabled and license_status not in {"cleared", "user-directed"}:
        raise TagAutocompleteValidationError(
            f"tag source {source_id} cannot be enabled without cleared or user-directed use"
        )
    if source.get("repository") != SUPPLEMENT_REPOSITORY:
        raise TagAutocompleteValidationError(f"tag source {source_id} repository is invalid")
    if source.get("ref") != SUPPLEMENT_REF or source.get("path") != SUPPLEMENT_REMOTE_PATH:
        raise TagAutocompleteValidationError(f"tag source {source_id} Git reference is invalid")
    _validate_https_url(source.get("api_url"), f"tag source {source_id}")
    api_url = urlparse(source["api_url"])
    expected_api_path = f"/repos/{SUPPLEMENT_REPOSITORY}/contents/{SUPPLEMENT_REMOTE_PATH}"
    if api_url.hostname != "api.github.com" or api_url.path != expected_api_path:
        raise TagAutocompleteValidationError(f"tag source {source_id} API URL is invalid")
    max_size_bytes = source.get("max_size_bytes")
    if (
        not isinstance(max_size_bytes, int)
        or max_size_bytes <= 0
        or max_size_bytes > MAX_SQLITE_DATASET_BYTES
    ):
        raise TagAutocompleteValidationError(f"tag source {source_id} size limit is invalid")
    return dict(source)


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
        min_rows = source.get("min_rows")
        if not isinstance(min_rows, int) or min_rows <= 0:
            raise TagAutocompleteValidationError(f"tag source {source_id} row limit is invalid")
        _validate_source_attribution(source_id, source)
        normalized_sources[source_id] = (
            _validate_supplement_source(source_id, source)
            if source_id == SUPPLEMENT_SOURCE_ID
            else _validate_static_source(source_id, source)
        )

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


def _validate_github_file_metadata(payload, source):
    if not isinstance(payload, dict):
        raise TagAutocompleteValidationError("supplement source metadata must be an object")
    if payload.get("type") != "file" or payload.get("path") != SUPPLEMENT_REMOTE_PATH:
        raise TagAutocompleteValidationError("supplement source metadata does not describe tag.sqlite")
    blob_sha = payload.get("sha")
    if (
        not isinstance(blob_sha, str)
        or len(blob_sha) not in {40, 64}
        or any(character not in "0123456789abcdefABCDEF" for character in blob_sha)
    ):
        raise TagAutocompleteValidationError("supplement source blob SHA is invalid")
    size_bytes = payload.get("size")
    if (
        not isinstance(size_bytes, int)
        or size_bytes <= 0
        or size_bytes > source["max_size_bytes"]
    ):
        raise TagAutocompleteValidationError("supplement source size is invalid")
    download_url = payload.get("download_url")
    _validate_https_url(download_url, "supplement source download")
    parsed = urlparse(download_url)
    expected_path = f"/{SUPPLEMENT_REPOSITORY}/{SUPPLEMENT_REF}/{SUPPLEMENT_REMOTE_PATH}"
    if parsed.hostname != "raw.githubusercontent.com" or parsed.path != expected_path:
        raise TagAutocompleteValidationError("supplement source download URL is invalid")
    return {
        "blob_sha": blob_sha.lower(),
        "size_bytes": size_bytes,
        "download_url": download_url,
    }


def _validate_sqlite_dataset(path, source):
    path = Path(path)
    try:
        with path.open("rb") as handle:
            if handle.read(16) != b"SQLite format 3\x00":
                raise TagAutocompleteValidationError("supplement source is not a SQLite database")
        connection = sqlite3.connect(
            f"{path.resolve().as_uri()}?mode=ro&immutable=1",
            uri=True,
            timeout=5,
        )
        try:
            connection.execute("PRAGMA query_only = ON")
            check = connection.execute("PRAGMA quick_check").fetchone()
            if not check or check[0] != "ok":
                raise TagAutocompleteValidationError("supplement source failed SQLite quick_check")
            columns = {
                row[1]: {
                    "type": str(row[2] or "").upper(),
                    "primary_key": bool(row[5]),
                }
                for row in connection.execute("PRAGMA table_info(tags)")
            }
            for name, expected_type in SUPPLEMENT_REQUIRED_COLUMNS.items():
                if name not in columns or columns[name]["type"] != expected_type:
                    raise TagAutocompleteValidationError(
                        f"supplement source tags.{name} column is invalid"
                    )
            if not columns["name"]["primary_key"]:
                raise TagAutocompleteValidationError(
                    "supplement source tags.name must be the primary key"
                )
            row = connection.execute(
                """
                SELECT
                    COUNT(*),
                    SUM(CASE WHEN name IS NULL OR trim(name) = '' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN cn_name IS NULL OR trim(cn_name) = '' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN category IS NULL OR category NOT IN (0, 1, 3, 4, 5) THEN 1 ELSE 0 END),
                    SUM(CASE WHEN post_count IS NULL OR post_count < 10 THEN 1 ELSE 0 END),
                    MAX(length(name)),
                    MAX(length(cn_name))
                FROM tags
                """
            ).fetchone()
            if not row or row[0] < source["min_rows"]:
                count = row[0] if row else 0
                raise TagAutocompleteValidationError(
                    f"supplement source contains only {count} rows"
                )
            if any(row[index] for index in range(1, 5)):
                raise TagAutocompleteValidationError("supplement source contains invalid tag rows")
            if row[5] > 256 or row[6] > 512:
                raise TagAutocompleteValidationError("supplement source contains oversized tag text")
            return row[0]
        finally:
            connection.close()
    except TagAutocompleteError:
        raise
    except (OSError, sqlite3.Error) as error:
        raise TagAutocompleteValidationError(
            f"could not validate supplement source: {error}"
        ) from error


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


async def _default_fetch_to_file(
    url,
    destination,
    *,
    headers=None,
    maximum_bytes=MAX_SQLITE_DATASET_BYTES,
):
    import aiohttp

    timeout = aiohttp.ClientTimeout(total=180, connect=15, sock_read=60)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(url, headers=headers or {}, allow_redirects=True) as response:
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
            digest = hashlib.sha256()
            total = 0
            with Path(destination).open("wb") as handle:
                async for chunk in response.content.iter_chunked(64 * 1024):
                    total += len(chunk)
                    if total > maximum_bytes:
                        raise TagAutocompleteValidationError("download is too large")
                    digest.update(chunk)
                    handle.write(chunk)
                handle.flush()
                os.fsync(handle.fileno())
            return response.status, {
                "size_bytes": total,
                "sha256": digest.hexdigest(),
            }, dict(response.headers)


class TagAutocompleteStore:
    def __init__(
        self,
        metadata_path,
        manifest_path,
        *,
        remote_manifest_url=REMOTE_MANIFEST_URL,
        fetcher=None,
        file_fetcher=None,
        now=None,
    ):
        self.metadata_path = Path(metadata_path)
        self.root = self.metadata_path.parent
        self.manifest_path = Path(manifest_path)
        self.remote_manifest_url = remote_manifest_url
        self.fetcher = fetcher or _default_fetch
        self.file_fetcher = file_fetcher or _default_fetch_to_file
        self.now = now or time.time
        self._update_task = None
        self._update_lock = asyncio.Lock()
        self._local_import_lock = threading.Lock()
        self._cache_lock = threading.RLock()
        self._local_supplement_cache_key = None
        self._local_supplement_cache = {
            "exists": False,
            "valid": False,
            "error": "",
            "sha256": "",
            "rows": 0,
            "size_bytes": 0,
            "modified_at": "",
        }
        self._search_cache_key = None
        self._search_records = []
        self._resolve_cache_key = None
        self._resolve_index = {}
        self._coverage_cache_key = None
        self._coverage_metrics = {
            "primary_translation_count": 0,
            "translated_tag_count": 0,
            "translation_coverage_percent": 0.0,
        }
        self._last_error = ""
        self._last_supplement_error = ""

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

    def _local_supplement_path(self):
        return self.root / LOCAL_SUPPLEMENT_FILENAME

    def _reset_data_caches(self):
        with self._cache_lock:
            self._search_cache_key = None
            self._search_records = []
            self._resolve_cache_key = None
            self._resolve_index = {}
            self._coverage_cache_key = None

    def _invalidate_local_supplement(self):
        with self._cache_lock:
            self._local_supplement_cache_key = None
            self._local_supplement_cache = {
                "exists": False,
                "valid": False,
                "error": "",
                "sha256": "",
                "rows": 0,
                "size_bytes": 0,
                "modified_at": "",
            }
        self._reset_data_caches()

    def _local_supplement_state(self, *, force=False):
        path = self._local_supplement_path()
        try:
            stat = path.stat()
            cache_key = (str(path), stat.st_mtime_ns, stat.st_size)
        except FileNotFoundError:
            cache_key = (str(path), 0, 0)
            state = {
                "exists": False,
                "valid": False,
                "error": "",
                "sha256": "",
                "rows": 0,
                "size_bytes": 0,
                "modified_at": "",
            }
            with self._cache_lock:
                changed = cache_key != self._local_supplement_cache_key
                self._local_supplement_cache_key = cache_key
                self._local_supplement_cache = state
            if changed:
                self._reset_data_caches()
            return dict(state)
        except OSError as error:
            cache_key = (str(path), "error", str(error))
            state = {
                "exists": True,
                "valid": False,
                "error": f"could not inspect local supplement source: {error}",
                "sha256": "",
                "rows": 0,
                "size_bytes": 0,
                "modified_at": "",
            }
            with self._cache_lock:
                changed = cache_key != self._local_supplement_cache_key
                self._local_supplement_cache_key = cache_key
                self._local_supplement_cache = state
            if changed:
                self._reset_data_caches()
            return dict(state)

        with self._cache_lock:
            if not force and cache_key == self._local_supplement_cache_key:
                return dict(self._local_supplement_cache)

        state = {
            "exists": True,
            "valid": False,
            "error": "",
            "sha256": "",
            "rows": 0,
            "size_bytes": stat.st_size,
            "modified_at": _iso_timestamp(stat.st_mtime),
        }
        try:
            source = self._supplement_config({})
            if not source or not source.get("enabled"):
                raise TagAutocompleteValidationError(
                    "local supplement source is disabled by the bundled source policy"
                )
            if stat.st_size <= 0 or stat.st_size > source["max_size_bytes"]:
                raise TagAutocompleteCapacityError(
                    "local supplement source is empty or exceeds the size limit"
                )
            state["rows"] = _validate_sqlite_dataset(path, source)
            state["sha256"] = _sha256_file(path)
            state["valid"] = True
        except TagAutocompleteError as error:
            state["error"] = str(error)

        with self._cache_lock:
            changed = cache_key != self._local_supplement_cache_key
            self._local_supplement_cache_key = cache_key
            self._local_supplement_cache = state
        if changed or force:
            self._reset_data_caches()
        return dict(state)

    def _active_supplement(self, metadata=None):
        if metadata is None:
            try:
                metadata = self._read_metadata()
            except TagAutocompleteError:
                metadata = {"sources": {}}
        source = self._supplement_config(metadata)
        enabled = bool(source and source.get("enabled"))
        local = self._local_supplement_state()
        if enabled and local["valid"]:
            return {
                "available": True,
                "origin": "local",
                "path": self._local_supplement_path(),
                "local": local,
            }
        if enabled and self._source_is_available(metadata, SUPPLEMENT_SOURCE_ID):
            return {
                "available": True,
                "origin": "downloaded",
                "path": self._source_path(SUPPLEMENT_SOURCE_ID),
                "local": local,
            }
        return {
            "available": False,
            "origin": "",
            "path": None,
            "local": local,
        }

    def begin_local_import(self):
        if self._update_task and not self._update_task.done():
            raise TagAutocompleteUnavailableError(
                "a prompt translation update is already running"
            )
        if not self._local_import_lock.acquire(blocking=False):
            raise TagAutocompleteUnavailableError(
                "a local supplement import is already running"
            )

    def finish_local_import(self):
        if self._local_import_lock.locked():
            self._local_import_lock.release()

    def install_local_supplement(self, temporary_path):
        source = self._supplement_config({})
        if not source or not source.get("enabled"):
            raise TagAutocompleteValidationError(
                "local supplement source is disabled by the bundled source policy"
            )
        temporary_path = Path(temporary_path)
        try:
            size_bytes = temporary_path.stat().st_size
        except OSError as error:
            raise TagAutocompleteValidationError(
                f"could not inspect uploaded local supplement source: {error}"
            ) from error
        if size_bytes <= 0:
            raise TagAutocompleteValidationError("local supplement upload is empty")
        if size_bytes > source["max_size_bytes"]:
            raise TagAutocompleteCapacityError(
                "local supplement upload exceeds the size limit"
            )
        _validate_sqlite_dataset(temporary_path, source)
        self.root.mkdir(parents=True, exist_ok=True)
        os.replace(temporary_path, self._local_supplement_path())
        self._invalidate_local_supplement()
        return self._local_supplement_state(force=True)

    def rescan_local_supplement(self):
        if self._update_task and not self._update_task.done():
            raise TagAutocompleteUnavailableError(
                "a prompt translation update is already running"
            )
        if self._local_import_lock.locked():
            raise TagAutocompleteUnavailableError(
                "a local supplement import is already running"
            )
        self._invalidate_local_supplement()
        return self._local_supplement_state(force=True)

    def _source_is_available(self, metadata, source_id):
        source_metadata = metadata.get("sources", {}).get(source_id)
        path = self._source_path(source_id)
        return (
            isinstance(source_metadata, dict)
            and isinstance(source_metadata.get("sha256"), str)
            and path.is_file()
            and path.stat().st_size > 0
        )

    def _supplement_config(self, metadata):
        del metadata
        try:
            return self.bundled_manifest()["sources"].get(SUPPLEMENT_SOURCE_ID)
        except TagAutocompleteError:
            return None

    def _validate_with_bundled_supplement(self, payload, bundled):
        if not isinstance(payload, dict):
            return validate_manifest(payload)
        sources = payload.get("sources")
        if not isinstance(sources, dict):
            return validate_manifest(payload)
        pinned_payload = {
            **payload,
            "sources": dict(sources),
        }
        bundled_source = bundled["sources"].get(SUPPLEMENT_SOURCE_ID)
        if bundled_source is None:
            pinned_payload["sources"].pop(SUPPLEMENT_SOURCE_ID, None)
        else:
            pinned_payload["sources"][SUPPLEMENT_SOURCE_ID] = bundled_source
        return validate_manifest(pinned_payload)

    def status(self, locale="en"):
        normalized_locale = normalize_locale(locale)
        try:
            metadata = self._read_metadata()
        except TagAutocompleteError as error:
            metadata = {"schema_version": METADATA_SCHEMA_VERSION, "sources": {}}
            self._last_error = str(error)
        base_available = self._source_is_available(metadata, "base")
        translation_required = normalized_locale == "zh-CN"
        primary_translation_available = self._source_is_available(metadata, "zh-CN")
        supplement_config = self._supplement_config(metadata)
        supplement_enabled = bool(supplement_config and supplement_config.get("enabled"))
        active_supplement = self._active_supplement(metadata)
        supplement_available = active_supplement["available"]
        local_supplement = active_supplement["local"]
        translation_available = primary_translation_available or (
            supplement_enabled and supplement_available
        )
        supplement_metadata = metadata.get("sources", {}).get(SUPPLEMENT_SOURCE_ID)
        if not isinstance(supplement_metadata, dict):
            supplement_metadata = {}
        coverage = {
            "primary_translation_count": 0,
            "translated_tag_count": 0,
            "translation_coverage_percent": 0.0,
        }
        if base_available:
            try:
                coverage = self._translation_coverage_metrics()
            except TagAutocompleteError as error:
                self._last_error = str(error)
        row_count = 0
        source_metadata = metadata.get("sources", {}).get("base")
        if isinstance(source_metadata, dict) and isinstance(source_metadata.get("rows"), int):
            row_count = source_metadata["rows"]
        supplement_translation_count = (
            max(
                0,
                coverage["translated_tag_count"]
                - coverage["primary_translation_count"],
            )
            if supplement_available else 0
        )
        if active_supplement["origin"] == "local":
            supplement_file_sha256 = local_supplement["sha256"]
            supplement_row_count = local_supplement["rows"]
            supplement_file_modified_at = local_supplement["modified_at"]
            supplement_last_updated_at = local_supplement["modified_at"]
        else:
            supplement_file_sha256 = str(supplement_metadata.get("sha256") or "")
            supplement_row_count = supplement_metadata.get("rows", 0)
            supplement_file_modified_at = str(
                supplement_metadata.get("downloaded_at") or ""
            )
            supplement_last_updated_at = str(
                supplement_metadata.get("downloaded_at") or ""
            )
        effective_supplement_error = (
            "" if active_supplement["origin"] == "local"
            else self._last_supplement_error
        )
        return {
            "available": base_available,
            "ready": base_available and (not translation_required or translation_available),
            "needs_download": not base_available or (translation_required and not translation_available),
            "translation_available": translation_available,
            "primary_translation_available": primary_translation_available,
            "locale": normalized_locale,
            "version": metadata.get("manifest_version") or "",
            "row_count": row_count,
            "last_checked_at": metadata.get("last_checked_at") or "",
            "last_updated_at": metadata.get("last_updated_at") or "",
            "updating": bool(self._update_task and not self._update_task.done()),
            "error": self._last_error or effective_supplement_error,
            "content_scope": "full",
            "supplement_enabled": supplement_enabled,
            "supplement_available": supplement_available,
            "supplement_translation_count": supplement_translation_count,
            "supplement_blob_sha": (
                supplement_metadata.get("blob_sha") or ""
                if active_supplement["origin"] == "downloaded" else ""
            ),
            "supplement_last_updated_at": supplement_last_updated_at,
            "supplement_error": effective_supplement_error,
            "supplement_origin": active_supplement["origin"],
            "supplement_drop_in_path": LOCAL_SUPPLEMENT_DROP_IN_PATH,
            "supplement_local_error": local_supplement["error"],
            "supplement_file_sha256": supplement_file_sha256,
            "supplement_row_count": supplement_row_count,
            "supplement_file_modified_at": supplement_file_modified_at,
            "supplement_importing": self._local_import_lock.locked(),
            "supplement_license_status": (
                str(supplement_config.get("license_status") or "")
                if supplement_config else ""
            ),
            "supplement_source_page": (
                str(supplement_config.get("source_page") or "")
                if supplement_config else ""
            ),
            **coverage,
        }

    def start_update(self, locale="en", *, force=True):
        if self._update_task and not self._update_task.done():
            return self._update_task
        if self._local_import_lock.locked():
            raise TagAutocompleteUnavailableError(
                "a local supplement import is already running"
            )
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
                        self._validate_with_bundled_supplement(
                            installed_manifest,
                            bundled,
                        ),
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
            manifest = self._validate_with_bundled_supplement(
                remote_payload,
                bundled,
            )
            installed_version = str(metadata.get("manifest_version") or "")
            if installed_version and manifest["version"] < installed_version:
                installed_manifest = metadata.get("manifest")
                if installed_manifest:
                    return (
                        self._validate_with_bundled_supplement(
                            installed_manifest,
                            bundled,
                        ),
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

    async def _update_supplement_source(self, source, installed, now):
        target_path = self._source_path(SUPPLEMENT_SOURCE_ID)
        same_source = (
            isinstance(installed, dict)
            and installed.get("repository") == source["repository"]
            and installed.get("ref") == source["ref"]
            and installed.get("path") == source["path"]
        )
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if same_source and installed.get("etag"):
            headers["If-None-Match"] = installed["etag"]
        status, payload, response_headers = await self.fetcher(
            source["api_url"],
            headers=headers,
            maximum_bytes=MAX_MANIFEST_BYTES,
        )
        if status == 304:
            if (
                target_path.is_file()
                and isinstance(installed, dict)
                and isinstance(installed.get("size_bytes"), int)
                and target_path.stat().st_size == installed["size_bytes"]
            ):
                return False, {
                    **installed,
                    "checked_at": _iso_timestamp(now),
                }
            status, payload, response_headers = await self.fetcher(
                source["api_url"],
                headers={
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                maximum_bytes=MAX_MANIFEST_BYTES,
            )
        if status != 200:
            raise TagAutocompleteUnavailableError(
                f"supplement metadata download failed with HTTP {status}"
            )
        try:
            remote_payload = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise TagAutocompleteValidationError(
                f"supplement source metadata is invalid JSON: {error}"
            ) from error
        remote = _validate_github_file_metadata(remote_payload, source)
        if (
            same_source
            and installed.get("blob_sha") == remote["blob_sha"]
            and target_path.is_file()
            and target_path.stat().st_size == remote["size_bytes"]
        ):
            return False, {
                **installed,
                "etag": _header_value(response_headers, "etag"),
                "checked_at": _iso_timestamp(now),
            }

        self.root.mkdir(parents=True, exist_ok=True)
        file_descriptor, temporary_path = tempfile.mkstemp(
            prefix=f".{target_path.name}.",
            suffix=".tmp",
            dir=str(self.root),
        )
        os.close(file_descriptor)
        temporary_path = Path(temporary_path)
        try:
            download_status, download, download_headers = await self.file_fetcher(
                remote["download_url"],
                temporary_path,
                headers={},
                maximum_bytes=min(source["max_size_bytes"], remote["size_bytes"] + 1),
            )
            if download_status != 200:
                raise TagAutocompleteUnavailableError(
                    f"supplement source download failed with HTTP {download_status}"
                )
            if download.get("size_bytes") != remote["size_bytes"]:
                raise TagAutocompleteValidationError(
                    "supplement source download size does not match GitHub metadata"
                )
            digest = download.get("sha256")
            if (
                not isinstance(digest, str)
                or len(digest) != 64
                or any(character not in "0123456789abcdefABCDEF" for character in digest)
            ):
                raise TagAutocompleteValidationError(
                    "supplement source download SHA-256 is invalid"
                )
            row_count = _validate_sqlite_dataset(temporary_path, source)
            os.replace(temporary_path, target_path)
            return True, {
                "sha256": digest.lower(),
                "blob_sha": remote["blob_sha"],
                "size_bytes": remote["size_bytes"],
                "rows": row_count,
                "translations": 0,
                "etag": _header_value(response_headers, "etag"),
                "download_etag": _header_value(download_headers, "etag"),
                "checked_at": _iso_timestamp(now),
                "downloaded_at": _iso_timestamp(now),
                "license": source["license"],
                "license_status": source["license_status"],
                "attribution": source["attribution"],
                "source_page": source["source_page"],
                "repository": source["repository"],
                "ref": source["ref"],
                "path": source["path"],
            }
        finally:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass

    async def update(self, locale="en", *, force=True):
        del force  # Every update is an explicit user-requested remote check.
        normalized_locale = normalize_locale(locale)
        async with self._update_lock:
            self._last_error = ""
            self._last_supplement_error = ""
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
                supplement_source = manifest["sources"].get(SUPPLEMENT_SOURCE_ID)
                if (
                    normalized_locale == "zh-CN"
                    and supplement_source
                    and supplement_source.get("enabled")
                ):
                    local_supplement = self._local_supplement_state()
                    if not local_supplement["valid"]:
                        try:
                            supplement_changed, supplement_metadata = (
                                await self._update_supplement_source(
                                    supplement_source,
                                    next_sources.get(SUPPLEMENT_SOURCE_ID),
                                    now,
                                )
                            )
                            next_sources[SUPPLEMENT_SOURCE_ID] = supplement_metadata
                            changed = changed or supplement_changed
                            supplement_metadata["translations"] = (
                                self._count_supplement_translations()
                            )
                        except Exception as error:
                            self._last_supplement_error = str(error)

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
                    self._reset_data_caches()
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

    def _supplement_enabled(self):
        try:
            metadata = self._read_metadata()
        except TagAutocompleteError:
            metadata = {}
        source = self._supplement_config(metadata)
        return bool(source and source.get("enabled"))

    def _cache_key(self, locale):
        supplement_enabled = locale == "zh-CN" and self._supplement_enabled()
        paths = [self._source_path("base")]
        if locale == "zh-CN":
            paths.append(self._source_path("zh-CN"))
        if supplement_enabled:
            active_supplement = self._active_supplement()
            if active_supplement["path"] is not None:
                paths.append(active_supplement["path"])
        result = [locale, supplement_enabled]
        for path in paths:
            if path.is_file():
                stat = path.stat()
                result.extend((str(path), stat.st_mtime_ns, stat.st_size))
            else:
                result.extend((str(path), 0, 0))
        return tuple(result)

    def _read_primary_translations(self):
        translations = {}
        translation_path = self._source_path("zh-CN")
        if not translation_path.is_file():
            return translations
        try:
            with translation_path.open("r", encoding="utf-8-sig", newline="") as handle:
                for row in csv.reader(handle):
                    if len(row) == 2 and row[0].strip() and row[1].strip():
                        translations[_canonical_search_text(row[0])] = row[1].strip()
        except (OSError, UnicodeError, csv.Error) as error:
            raise TagAutocompleteValidationError(
                f"could not read Chinese tag translations: {error}"
            ) from error
        return translations

    def _read_base_entries(self):
        base_path = self._source_path("base")
        if not base_path.is_file():
            raise TagAutocompleteUnavailableError("Danbooru tag dictionary has not been downloaded")
        entries = []
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
                    entries.append({
                        "tag": tag,
                        "category": category,
                        "post_count": post_count,
                        "_canonical": canonical,
                        "_aliases": tuple(dict.fromkeys(ascii_aliases)),
                        "_fuzzy_canonical": _compact_fuzzy_text(canonical),
                        "_fuzzy_aliases": tuple(
                            _compact_fuzzy_text(alias)
                            for alias in dict.fromkeys(ascii_aliases)
                        ),
                        "_index": index,
                    })
        except (OSError, UnicodeError, csv.Error) as error:
            raise TagAutocompleteValidationError(f"could not read base tag dictionary: {error}") from error
        return entries

    def _query_supplement_translations(self, tags):
        if not tags:
            return {}
        active_supplement = self._active_supplement()
        path = active_supplement["path"]
        if path is None or not path.is_file():
            return {}
        try:
            connection = sqlite3.connect(
                f"{path.resolve().as_uri()}?mode=ro&immutable=1",
                uri=True,
                timeout=5,
            )
            try:
                connection.execute("PRAGMA query_only = ON")
                translations = {}
                for offset in range(0, len(tags), SUPPLEMENT_QUERY_BATCH_SIZE):
                    batch = tags[offset:offset + SUPPLEMENT_QUERY_BATCH_SIZE]
                    placeholders = ",".join("?" for _value in batch)
                    rows = connection.execute(
                        f"SELECT name, cn_name FROM tags WHERE name IN ({placeholders})",
                        batch,
                    )
                    for name, translation in rows:
                        if name and translation and str(translation).strip():
                            translations[_canonical_search_text(name)] = str(translation).strip()
                return translations
            finally:
                connection.close()
        except (OSError, sqlite3.Error) as error:
            raise TagAutocompleteValidationError(
                f"could not read Chinese translation supplement: {error}"
            ) from error

    def _count_supplement_translations(self):
        primary = self._read_primary_translations()
        entries = self._read_base_entries()
        missing_tags = [
            entry["tag"]
            for entry in entries
            if entry["_canonical"] not in primary
        ]
        supplemental = self._query_supplement_translations(missing_tags)
        return sum(
            _canonical_search_text(tag) in supplemental
            for tag in missing_tags
        )

    def _translation_coverage_metrics(self):
        cache_key = self._cache_key("zh-CN")
        with self._cache_lock:
            if cache_key == self._coverage_cache_key:
                return dict(self._coverage_metrics)

            entries = self._read_base_entries()
            primary = self._read_primary_translations()
            base_keys = {entry["_canonical"] for entry in entries}
            primary_keys = base_keys.intersection(primary)
            translated_keys = set(primary_keys)

            if self._supplement_enabled():
                missing_tags = [
                    entry["tag"]
                    for entry in entries
                    if entry["_canonical"] not in primary_keys
                ]
                try:
                    supplemental = self._query_supplement_translations(missing_tags)
                    translated_keys.update(base_keys.intersection(supplemental))
                except TagAutocompleteError as error:
                    self._last_supplement_error = str(error)

            row_count = len(entries)
            metrics = {
                "primary_translation_count": len(primary_keys),
                "translated_tag_count": len(translated_keys),
                "translation_coverage_percent": round(
                    len(translated_keys) * 100 / row_count,
                    2,
                ) if row_count else 0.0,
            }
            self._coverage_cache_key = cache_key
            self._coverage_metrics = metrics
            return dict(metrics)

    def _load_records(self, locale):
        entries = self._read_base_entries()
        translations = self._read_primary_translations() if locale == "zh-CN" else {}
        if locale == "zh-CN" and self._supplement_enabled():
            missing = [
                entry["tag"]
                for entry in entries
                if entry["_canonical"] not in translations
            ]
            try:
                translations.update(self._query_supplement_translations(missing))
            except TagAutocompleteError as error:
                self._last_supplement_error = str(error)

        records = []
        for entry in entries:
            translation = translations.get(entry["_canonical"], "")
            records.append({
                **entry,
                "insert_text": entry["tag"].replace("_", " "),
                "translation": translation,
                "source": "danbooru",
                "_translation": _normalize_search_text(translation),
                "_fuzzy_translation": _compact_fuzzy_text(translation),
            })
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
