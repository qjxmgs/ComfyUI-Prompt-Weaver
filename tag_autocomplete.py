import asyncio
import hashlib
import bisect
from collections import OrderedDict
from contextlib import closing
import heapq
import shutil
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
DEFAULT_RESULT_LIMIT = 30
MAX_RESULT_LIMIT = 100
MANIFEST_SCHEMA_VERSION = 1
METADATA_SCHEMA_VERSION = 1
ALLOWED_DOWNLOAD_HOSTS = frozenset({
    "api.github.com",
    "raw.githubusercontent.com",
})
EXPECTED_SOURCE_FILES = {"zh-CN-supplement": "danbooru.zh-CN.supplement.sqlite"}
EXPECTED_SOURCE_FORMATS = {"zh-CN-supplement": "tag_translation_sqlite_v1"}
DEFAULT_MIN_POST_COUNT = 100
MIN_POST_COUNT = 10
MAX_MIN_POST_COUNT = 2**53 - 1
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
    if not isinstance(sources, dict) or SUPPLEMENT_SOURCE_ID not in sources:
        raise TagAutocompleteValidationError("tag source manifest has no SQLite source")

    normalized_sources = {}
    for source_id in EXPECTED_SOURCE_FILES:
        source = sources.get(source_id)
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
        normalized_sources[source_id] = _validate_supplement_source(source_id, source)

    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "version": version.strip(),
        "published_at": str(payload.get("published_at") or ""),
        "content_scope": "full",
        "sources": normalized_sources,
    }


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
                    SUM(CASE WHEN typeof(name) != 'text' OR trim(name) = '' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN typeof(cn_name) != 'text' OR trim(cn_name) = '' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN typeof(category) != 'integer' OR category NOT IN (0, 1, 3, 4, 5) THEN 1 ELSE 0 END),
                    SUM(CASE WHEN typeof(post_count) != 'integer' OR post_count < 10 THEN 1 ELSE 0 END),
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



def validate_min_post_count(value=DEFAULT_MIN_POST_COUNT):
    if isinstance(value, bool) or not re.fullmatch(r"[0-9]{1,16}", str(value)):
        raise TagAutocompleteValidationError("minimum post count must be an integer")
    number = int(value)
    if not MIN_POST_COUNT <= number <= MAX_MIN_POST_COUNT:
        raise TagAutocompleteValidationError("minimum post count must be at least 10")
    return number


def _connect(path):
    connection = sqlite3.connect(
        f"{Path(path).resolve().as_uri()}?mode=ro&immutable=1", uri=True, timeout=5,
    )
    connection.execute("PRAGMA query_only = ON")
    return connection


class TagAutocompleteStore:
    """One selected SQLite per user; legacy filenames remain migration-compatible."""

    def __init__(self, metadata_path, manifest_path, *, remote_manifest_url=None,
                 fetcher=None, file_fetcher=None, now=None):
        self.metadata_path = Path(metadata_path)
        self.root = self.metadata_path.parent
        self.manifest_path = Path(manifest_path)
        self.fetcher = fetcher or _default_fetch
        self.file_fetcher = file_fetcher or _default_fetch_to_file
        self.now = now or time.time
        self._update_task = None
        self._update_lock = asyncio.Lock()
        self._local_import_lock = threading.Lock()
        self._cache_lock = threading.RLock()
        self._file_states = {}
        self._candidates = OrderedDict()
        self._last_error = ""

    def bundled_manifest(self):
        return validate_manifest(_read_json_file(self.manifest_path, "bundled tag source manifest"))

    def _read_metadata(self):
        if not self.metadata_path.exists():
            return {"schema_version": METADATA_SCHEMA_VERSION, "sources": {}}
        payload = _read_json_file(self.metadata_path, "tag autocomplete metadata")
        if payload.get("schema_version") != METADATA_SCHEMA_VERSION or not isinstance(payload.get("sources"), dict):
            raise TagAutocompleteValidationError("unsupported tag autocomplete metadata")
        return payload

    def _write_metadata(self, metadata):
        _atomic_write_json(self.metadata_path, {
            **metadata, "schema_version": METADATA_SCHEMA_VERSION,
            "sources": dict(metadata.get("sources") or {}),
        })

    def _source_path(self, source_id):
        return self.root / EXPECTED_SOURCE_FILES[source_id]

    def _local_supplement_path(self):
        return self.root / LOCAL_SUPPLEMENT_FILENAME

    def _path(self, source):
        return self._local_supplement_path() if source == "local" else self._source_path(SUPPLEMENT_SOURCE_ID)

    def _reset_data_caches(self):
        with self._cache_lock:
            self._file_states.clear()
            self._candidates.clear()

    def _file_state(self, source, *, force=False):
        # Called under _cache_lock. A read never creates files or writes migration state.
        path = self._path(source)
        try:
            stat = path.stat()
            key = (stat.st_mtime_ns, stat.st_size, stat.st_ctime_ns)
        except OSError as error:
            return {"available": False, "error": "" if isinstance(error, FileNotFoundError) else str(error),
                    "rows": 0, "sha256": "", "counts": (), "revision": "", "modified_at": ""}
        cached = self._file_states.get(source)
        if not force and cached and cached[0] == key:
            return cached[1]
        state = {"available": False, "error": "", "rows": 0, "sha256": "", "counts": (),
                 "revision": "", "modified_at": _iso_timestamp(stat.st_mtime)}
        try:
            if not 0 < stat.st_size <= MAX_SQLITE_DATASET_BYTES:
                raise TagAutocompleteCapacityError("SQLite file is empty or exceeds 64 MiB")
            policy = {**self.bundled_manifest()["sources"][SUPPLEMENT_SOURCE_ID], "min_rows": 1}
            state["rows"] = _validate_sqlite_dataset(path, policy)
            with closing(_connect(path)) as connection:
                # Cache only the small frequency distribution, never all tag strings for status.
                histogram = connection.execute(
                    "SELECT post_count, COUNT(*) FROM tags GROUP BY post_count ORDER BY post_count"
                ).fetchall()
                # Indexed exact resolution preserves normalized names without retaining every tag.
                noncanonical = connection.execute(
                    "SELECT name FROM tags WHERE name != lower(name) OR instr(name, ' ') > 0 "
                    "OR name GLOB '*[^ -~]*' OR instr(name, char(92)) > 0"
                ).fetchall()
            canonical_aliases = {}
            for (name,) in noncanonical:
                canonical_aliases.setdefault(_canonical_search_text(name), name)
            state["canonical_aliases"] = canonical_aliases
            state["counts"] = tuple(row[0] for row in histogram)
            cumulative = [0]
            for _count, frequency in histogram:
                cumulative.append(cumulative[-1] + frequency)
            state["cumulative"] = tuple(cumulative)
            state["sha256"] = _sha256_file(path)
            state["revision"] = f"{source}:{state['sha256']}"
            state["available"] = True
        except (TagAutocompleteError, OSError, sqlite3.Error) as error:
            state["error"] = str(error)
        self._file_states[source] = (key, state)
        # Old revisions can no longer populate the cache after an atomic replacement.
        for cache_key in list(self._candidates):
            if cache_key[0].startswith(source + ":") and cache_key[0] != state["revision"]:
                del self._candidates[cache_key]
        return state

    def _selected_source(self, metadata):
        explicit = metadata.get("selected_source")
        if explicit in ("local", "downloaded"):
            return explicit
        return "local" if self._file_state("local")["available"] else "downloaded"

    def _selection(self):
        metadata = self._read_metadata()
        source = self._selected_source(metadata)
        return metadata, source, self._file_state(source)

    def status(self, locale="en", min_post_count=DEFAULT_MIN_POST_COUNT):
        threshold = validate_min_post_count(min_post_count)
        with self._cache_lock:
            metadata, source, state = self._selection()
            states = {name: self._file_state(name) for name in ("downloaded", "local")}
            active_count = 0
            if state["available"]:
                index = bisect.bisect_left(state["counts"], threshold)
                active_count = state["rows"] - state["cumulative"][index]
            downloaded = metadata.get("sources", {}).get(SUPPLEMENT_SOURCE_ID, {})
            return {
                "available": state["available"], "ready": state["available"],
                "needs_download": not state["available"] and source == "downloaded",
                "locale": normalize_locale(locale), "selected_source": source,
                "source_revision": state["revision"], "min_post_count": threshold,
                "row_count": state["rows"], "total_count": state["rows"],
                "active_count": active_count, "translated_tag_count": state["rows"],
                "translation_available": state["available"],
                "translation_coverage_percent": 100.0 if state["available"] else 0.0,
                "sources": {name: {key: value for key, value in entry.items()
                            if key not in ("counts", "cumulative", "canonical_aliases")}
                            for name, entry in states.items()},
                "version": (downloaded.get("blob_sha") or state["sha256"]) if source == "downloaded" else state["sha256"],
                "file_sha256": state["sha256"], "file_modified_at": state["modified_at"],
                "source_page": f"https://github.com/{SUPPLEMENT_REPOSITORY}",
                "local_path": LOCAL_SUPPLEMENT_DROP_IN_PATH,
                "last_checked_at": metadata.get("last_checked_at", ""),
                "last_updated_at": metadata.get("last_updated_at", ""),
                "updating": bool(self._update_task and not self._update_task.done()),
                "importing": self._local_import_lock.locked(),
                "error": self._last_error or state["error"],
            }

    def begin_local_import(self):
        if self._update_lock.locked() or (self._update_task and not self._update_task.done()):
            raise TagAutocompleteUnavailableError("a dictionary update is already running")
        if not self._local_import_lock.acquire(blocking=False):
            raise TagAutocompleteUnavailableError("a dictionary operation is already running")

    def finish_local_import(self):
        if self._local_import_lock.locked():
            self._local_import_lock.release()

    def select_source(self, source):
        if source not in ("downloaded", "local"):
            raise TagAutocompleteValidationError("source must be downloaded or local")
        self.begin_local_import()
        try:
            with self._cache_lock:
                state = self._file_state(source, force=True)
                if not state["available"]:
                    raise TagAutocompleteUnavailableError(state["error"] or "The selected SQLite dictionary is not installed.")
                metadata = self._read_metadata()
                self._write_metadata({**metadata, "selected_source": source})
                self._candidates.clear()
                self._last_error = ""
        finally:
            self.finish_local_import()
        return self.status()

    def _install(self, temporary_path, source, metadata):
        """Serialize publication with readers; roll back the data file if metadata fails."""
        target = self._path(source)
        self.root.mkdir(parents=True, exist_ok=True)
        with self._cache_lock:
            backup = None
            try:
                if target.exists():
                    descriptor, name = tempfile.mkstemp(prefix=".dictionary-backup.", dir=self.root)
                    os.close(descriptor)
                    backup = Path(name)
                    shutil.copyfile(target, backup)
                os.replace(temporary_path, target)
                try:
                    self._write_metadata(metadata)
                except Exception:
                    if backup is not None:
                        os.replace(backup, target)
                    else:
                        target.unlink(missing_ok=True)
                    raise
                self._reset_data_caches()
            finally:
                if backup is not None:
                    backup.unlink(missing_ok=True)

    def install_local_supplement(self, temporary_path):
        temporary_path = Path(temporary_path)
        if not 0 < temporary_path.stat().st_size <= MAX_SQLITE_DATASET_BYTES:
            raise TagAutocompleteCapacityError("local SQLite upload is empty or exceeds 64 MiB")
        policy = {**self.bundled_manifest()["sources"][SUPPLEMENT_SOURCE_ID], "min_rows": 1}
        _validate_sqlite_dataset(temporary_path, policy)
        metadata = self._read_metadata()
        self._install(temporary_path, "local", {
            **metadata, "selected_source": "local", "last_updated_at": _iso_timestamp(self.now()),
        })
        self._last_error = ""
        return self.status()

    def rescan_local_supplement(self):
        self.begin_local_import()
        try:
            with self._cache_lock:
                self._reset_data_caches()
                state = self._file_state("local", force=True)
                if not state["available"]:
                    raise TagAutocompleteUnavailableError(state["error"] or "No local SQLite dictionary is installed.")
                self._last_error = ""
        finally:
            self.finish_local_import()
        return self.status()

    def start_update(self, locale="en", *, force=True):
        if self._update_task and not self._update_task.done():
            return self._update_task
        if self._local_import_lock.locked():
            raise TagAutocompleteUnavailableError("a dictionary operation is already running")
        self._update_task = asyncio.create_task(self.update(locale, force=force))
        return self._update_task

    async def update(self, locale="en", *, force=True):
        del force
        async with self._update_lock:
            if not self._local_import_lock.acquire(blocking=False):
                raise TagAutocompleteUnavailableError("a dictionary operation is already running")
            temporary = None
            try:
                self._last_error = ""
                metadata = self._read_metadata()
                source = self.bundled_manifest()["sources"][SUPPLEMENT_SOURCE_ID]
                installed = metadata.get("sources", {}).get(SUPPLEMENT_SOURCE_ID, {})
                now = _iso_timestamp(self.now())
                headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
                snapshot = await asyncio.to_thread(self.status, locale)
                valid_download = snapshot["sources"]["downloaded"]["available"]
                if installed.get("etag") and valid_download:
                    headers["If-None-Match"] = installed["etag"]
                code, body, response_headers = await self.fetcher(
                    source["api_url"], headers=headers, maximum_bytes=MAX_MANIFEST_BYTES,
                )
                if code == 304 and valid_download:
                    self._write_metadata({**metadata, "last_checked_at": now})
                    return await asyncio.to_thread(self.status, locale)
                if code != 200:
                    raise TagAutocompleteUnavailableError(f"GitHub metadata request failed (HTTP {code})")
                remote = _validate_github_file_metadata(json.loads(body.decode("utf-8")), source)
                if valid_download and installed.get("blob_sha") == remote["blob_sha"]:
                    self._write_metadata({**metadata, "last_checked_at": now})
                    return await asyncio.to_thread(self.status, locale)
                self.root.mkdir(parents=True, exist_ok=True)
                descriptor, name = tempfile.mkstemp(prefix=".dictionary.", suffix=".tmp", dir=self.root)
                os.close(descriptor)
                temporary = Path(name)
                # Verify the advertised Git blob below to detect a moving-main download race.
                url = f"https://raw.githubusercontent.com/{SUPPLEMENT_REPOSITORY}/{SUPPLEMENT_REF}/{SUPPLEMENT_REMOTE_PATH}"
                code, downloaded, _headers = await self.file_fetcher(
                    url, temporary, headers={}, maximum_bytes=source["max_size_bytes"],
                )
                if code != 200 or temporary.stat().st_size != remote["size_bytes"]:
                    raise TagAutocompleteValidationError("SQLite download size does not match GitHub metadata")
                digest, blob_digest = await asyncio.to_thread(self._download_hashes, temporary)
                if digest != downloaded.get("sha256") or blob_digest != remote["blob_sha"]:
                    raise TagAutocompleteValidationError("SQLite download failed hash validation")
                rows = await asyncio.to_thread(_validate_sqlite_dataset, temporary, source)
                entry = {
                    "sha256": digest, "blob_sha": remote["blob_sha"], "rows": rows,
                    "size_bytes": remote["size_bytes"], "etag": _header_value(response_headers, "etag"),
                    "downloaded_at": now, "repository": SUPPLEMENT_REPOSITORY,
                    "ref": SUPPLEMENT_REF, "path": SUPPLEMENT_REMOTE_PATH,
                    "license": "MIT", "source_page": source["source_page"],
                }
                selected = snapshot["selected_source"]
                await asyncio.to_thread(self._install, temporary, "downloaded", {
                    **metadata, "selected_source": selected,
                    "sources": {**metadata.get("sources", {}), SUPPLEMENT_SOURCE_ID: entry},
                    "last_checked_at": now, "last_updated_at": now,
                })
                return await asyncio.to_thread(self.status, locale)
            except Exception as error:
                self._last_error = str(error)
                raise
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
                self._local_import_lock.release()

    @staticmethod
    def _download_hashes(path):
        sha256 = hashlib.sha256()
        blob = hashlib.sha1(f"blob {path.stat().st_size}\0".encode("ascii"))
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                sha256.update(chunk)
                blob.update(chunk)
        return sha256.hexdigest(), blob.hexdigest()

    @staticmethod
    def _record(row, index=0):
        name, category, translation, count = row
        canonical = _canonical_search_text(name)
        normalized_translation = _normalize_search_text(translation)
        return {
            "tag": name, "insert_text": name.replace("_", " "), "translation": translation,
            "category": category, "post_count": count, "source": "danbooru",
            "_canonical": canonical, "_translation": normalized_translation,
            "_fuzzy_canonical": _compact_fuzzy_text(canonical),
            "_fuzzy_translation": _compact_fuzzy_text(normalized_translation), "_index": index,
        }

    def _records(self, source, state, threshold):
        key = (state["revision"], threshold)
        if key not in self._candidates:
            with closing(_connect(self._path(source))) as connection:
                rows = connection.execute(
                    "SELECT name, category, cn_name, post_count FROM tags WHERE post_count >= ? ORDER BY name",
                    (threshold,),
                )
                self._candidates[key] = tuple(self._record(row, index) for index, row in enumerate(rows))
            while len(self._candidates) > 2:
                self._candidates.popitem(last=False)
        self._candidates.move_to_end(key)
        return self._candidates[key]

    @staticmethod
    def _public_record(record, locale):
        return {key: (value if locale == "zh-CN" else "") if key == "translation" else value
                for key, value in record.items() if not key.startswith("_")}

    def resolve(self, tags, locale="zh-CN"):
        if not isinstance(tags, list):
            raise TagAutocompleteValidationError("tag autocomplete resolve tags must be an array")
        if len(tags) > MAX_RESOLVE_TAGS:
            raise TagAutocompleteValidationError("too many tags to resolve")
        if any(not isinstance(tag, str) for tag in tags):
            raise TagAutocompleteValidationError("tag autocomplete resolve values must be strings")
        keys = [_canonical_search_text(tag) for tag in tags]
        if any(len(key) > MAX_QUERY_LENGTH for key in keys):
            raise TagAutocompleteValidationError("tag autocomplete resolve value is too long")
        if not keys:
            return []
        with self._cache_lock:
            _metadata, source, state = self._selection()
            if not state["available"]:
                raise TagAutocompleteUnavailableError(state["error"] or "Danbooru dictionary is not installed")
            names = [state["canonical_aliases"].get(key, key) for key in keys]
            placeholders = ",".join("?" for _ in names)
            with closing(_connect(self._path(source))) as connection:
                records = { _canonical_search_text(row[0]): self._record(row)
                    for row in connection.execute(
                        f"SELECT name, category, cn_name, post_count FROM tags WHERE name IN ({placeholders})",
                        names,
                    )}
            return [self._public_record(records[key], normalize_locale(locale)) if key in records else None for key in keys]

    def search(self, query, locale="en", limit=DEFAULT_RESULT_LIMIT,
               min_post_count=DEFAULT_MIN_POST_COUNT, *, cancelled=lambda: False):
        threshold = validate_min_post_count(min_post_count)
        if isinstance(limit, bool) or not re.fullmatch(r"[0-9]+", str(limit)) or not 1 <= int(limit) <= MAX_RESULT_LIMIT:
            raise TagAutocompleteValidationError("tag autocomplete limit is out of range")
        limit = int(limit)
        query = _normalize_search_text(query)
        if len(query) > MAX_QUERY_LENGTH:
            raise TagAutocompleteValidationError("tag autocomplete query is too long")
        if not query or cancelled():
            return []
        with self._cache_lock:
            if cancelled():
                return []
            _metadata, source, state = self._selection()
            if not state["available"]:
                raise TagAutocompleteUnavailableError(state["error"] or "Danbooru dictionary is not installed")
            records = self._records(source, state, threshold)
        locale = normalize_locale(locale)
        canonical = query.replace(" ", "_")
        direct = []
        for index, record in enumerate(records):
            if index % 512 == 0 and cancelled():
                return []
            rank = 4
            for field, needle in ((record["_canonical"], canonical),
                                  (record["_translation"] if locale == "zh-CN" else "", query)):
                if not field:
                    continue
                score = 0 if field == needle else 1 if field.startswith(needle) else 2 if needle in field else 4
                rank = min(rank, score)
            if rank < 4:
                direct.append((rank, (0, 0, 0), -record["post_count"], record["_index"], record))
        if len(direct) < limit and _fuzzy_query_is_eligible(query):
            existing = {match[3] for match in direct}
            fuzzy = _compact_fuzzy_text(query)
            for index, record in enumerate(records):
                if index % 512 == 0 and cancelled():
                    return []
                if record["_index"] in existing:
                    continue
                scores = [_ordered_subsequence_score_compact(field, fuzzy) for field in (
                    record["_fuzzy_canonical"], record["_fuzzy_translation"] if locale == "zh-CN" else "",
                )]
                scores = [score for score in scores if score is not None]
                if scores:
                    direct.append((3, min(scores), -record["post_count"], record["_index"], record))
        results = []
        for rank, score, _count, _index, record in heapq.nsmallest(limit, direct, key=lambda item: item[:4]):
            result = self._public_record(record, locale)
            result["match_rank"] = rank
            if rank == 3:
                result["match_score"] = dict(zip(("start", "gaps", "length"), score))
            results.append(result)
        with self._cache_lock:
            _metadata, current_source, current_state = self._selection()
            if current_source != source or current_state["revision"] != state["revision"]:
                return []
        return results
