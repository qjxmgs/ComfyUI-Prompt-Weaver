import json
import os
import tempfile
import threading
import uuid
from datetime import datetime, timezone


FORMAT_VERSION = 1
EXPORT_FORMAT = "prompt-weaver-prompt-grid-archives"
MAX_ARCHIVES = 100
MAX_NAME_LENGTH = 80
MAX_ITEMS = 500
MAX_TITLE_LENGTH = 200
MAX_PROMPT_LENGTH = 100_000
MAX_SNAPSHOT_BYTES = 512 * 1024
MAX_IMPORT_BYTES = 2 * 1024 * 1024
MAX_STORE_BYTES = 10 * 1024 * 1024


class ArchiveError(Exception):
    pass


class ArchiveValidationError(ArchiveError):
    pass


class ArchiveConflictError(ArchiveError):
    pass


class ArchiveNotFoundError(ArchiveError):
    pass


class ArchiveCapacityError(ArchiveError):
    pass


class ArchiveCorruptError(ArchiveError):
    pass


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _reject_json_constant(value):
    raise ArchiveValidationError(f"invalid JSON constant {value!r}")


def _json_size(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def normalize_name(value):
    if not isinstance(value, str):
        raise ArchiveValidationError("archive name must be a string")
    name = value.strip()
    if not name:
        raise ArchiveValidationError("archive name must not be empty")
    if len(name) > MAX_NAME_LENGTH:
        raise ArchiveValidationError(f"archive name must not exceed {MAX_NAME_LENGTH} characters")
    return name


def _normalize_timestamp(value, field):
    if not isinstance(value, str) or not value or len(value) > 64:
        raise ArchiveValidationError(f"{field} must be an ISO timestamp")
    try:
        timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ArchiveValidationError(f"{field} must be an ISO timestamp") from error
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)
    return timestamp.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _normalize_archive_id(value):
    if not isinstance(value, str):
        raise ArchiveValidationError("archive id must be a UUID string")
    try:
        return str(uuid.UUID(value))
    except ValueError as error:
        raise ArchiveValidationError("archive id must be a UUID string") from error


def validate_snapshot(value):
    if not isinstance(value, dict):
        raise ArchiveValidationError("snapshot must be an object")
    version = value.get("version", FORMAT_VERSION)
    if isinstance(version, bool) or not isinstance(version, (int, float)) or version != FORMAT_VERSION:
        raise ArchiveValidationError(f"snapshot version must be {FORMAT_VERSION}")
    columns = value.get("columns")
    if isinstance(columns, bool) or not isinstance(columns, int) or not 1 <= columns <= 6:
        raise ArchiveValidationError("snapshot columns must be an integer from 1 to 6")
    items = value.get("items")
    if not isinstance(items, list):
        raise ArchiveValidationError("snapshot items must be an array")
    if len(items) > MAX_ITEMS:
        raise ArchiveValidationError(f"snapshot must not exceed {MAX_ITEMS} items")

    ids = set()
    normalized_items = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise ArchiveValidationError(f"snapshot items[{index}] must be an object")
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id.strip() or len(item_id) > 128:
            raise ArchiveValidationError(f"snapshot items[{index}].id must be a non-empty string")
        if item_id in ids:
            raise ArchiveValidationError(f"snapshot items[{index}].id is duplicated")
        ids.add(item_id)
        enabled = item.get("enabled")
        title = item.get("title")
        prompt = item.get("prompt")
        if not isinstance(enabled, bool):
            raise ArchiveValidationError(f"snapshot items[{index}].enabled must be a boolean")
        if not isinstance(title, str) or len(title) > MAX_TITLE_LENGTH:
            raise ArchiveValidationError(
                f"snapshot items[{index}].title must be a string up to {MAX_TITLE_LENGTH} characters"
            )
        if not isinstance(prompt, str) or len(prompt) > MAX_PROMPT_LENGTH:
            raise ArchiveValidationError(
                f"snapshot items[{index}].prompt must be a string up to {MAX_PROMPT_LENGTH} characters"
            )
        normalized_items.append(
            {"id": item_id, "enabled": enabled, "title": title, "prompt": prompt}
        )

    snapshot = {"version": FORMAT_VERSION, "columns": columns, "items": normalized_items}
    if _json_size(snapshot) > MAX_SNAPSHOT_BYTES:
        raise ArchiveValidationError("snapshot is too large")
    return snapshot


def _normalize_export_archive(value):
    if not isinstance(value, dict):
        raise ArchiveValidationError("each imported archive must be an object")
    return {
        "id": _normalize_archive_id(value.get("id")),
        "name": normalize_name(value.get("name")),
        "created_at": _normalize_timestamp(value.get("created_at"), "created_at"),
        "updated_at": _normalize_timestamp(value.get("updated_at"), "updated_at"),
        "snapshot": validate_snapshot(value.get("snapshot")),
    }


class ArchiveStore:
    def __init__(self, path):
        self.path = os.path.abspath(path)
        self._lock = threading.RLock()

    def _empty(self):
        return {"format_version": FORMAT_VERSION, "archives": []}

    def _read_unlocked(self):
        if not os.path.exists(self.path):
            return self._empty()
        if os.path.getsize(self.path) > MAX_STORE_BYTES:
            raise ArchiveCorruptError("archive store is too large")
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                data = json.load(handle, parse_constant=_reject_json_constant)
        except (OSError, json.JSONDecodeError, UnicodeDecodeError, ArchiveValidationError) as error:
            raise ArchiveCorruptError(f"archive store cannot be read: {error}") from error
        try:
            if not isinstance(data, dict) or data.get("format_version") != FORMAT_VERSION:
                raise ArchiveValidationError("unsupported archive store format")
            archives = data.get("archives")
            if not isinstance(archives, list) or len(archives) > MAX_ARCHIVES:
                raise ArchiveValidationError("archive store has an invalid archive list")
            normalized = [_normalize_export_archive(archive) for archive in archives]
            ids = [archive["id"] for archive in normalized]
            names = [archive["name"].casefold() for archive in normalized]
            if len(ids) != len(set(ids)) or len(names) != len(set(names)):
                raise ArchiveValidationError("archive store contains duplicate ids or names")
            return {"format_version": FORMAT_VERSION, "archives": normalized}
        except ArchiveValidationError as error:
            raise ArchiveCorruptError(f"archive store is invalid: {error}") from error

    def _write_unlocked(self, data):
        encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MAX_STORE_BYTES:
            raise ArchiveCapacityError("archive store size limit exceeded")
        directory = os.path.dirname(self.path)
        os.makedirs(directory, exist_ok=True)
        temporary_path = None
        try:
            with tempfile.NamedTemporaryFile("wb", dir=directory, delete=False) as handle:
                temporary_path = handle.name
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, self.path)
        finally:
            if temporary_path and os.path.exists(temporary_path):
                os.unlink(temporary_path)

    @staticmethod
    def _sorted(archives):
        return sorted(archives, key=lambda archive: archive["updated_at"], reverse=True)

    def list_archives(self):
        with self._lock:
            data = self._read_unlocked()
            data["archives"] = self._sorted(data["archives"])
            return data

    def create(self, name, snapshot):
        name = normalize_name(name)
        snapshot = validate_snapshot(snapshot)
        with self._lock:
            data = self._read_unlocked()
            if len(data["archives"]) >= MAX_ARCHIVES:
                raise ArchiveCapacityError(f"at most {MAX_ARCHIVES} archives are allowed")
            if any(archive["name"].casefold() == name.casefold() for archive in data["archives"]):
                raise ArchiveConflictError("an archive with this name already exists")
            timestamp = _now()
            archive = {
                "id": str(uuid.uuid4()),
                "name": name,
                "created_at": timestamp,
                "updated_at": timestamp,
                "snapshot": snapshot,
            }
            data["archives"].append(archive)
            self._write_unlocked(data)
            return archive

    def update(self, archive_id, name=None, snapshot=None):
        archive_id = _normalize_archive_id(archive_id)
        if name is None and snapshot is None:
            raise ArchiveValidationError("name or snapshot is required")
        normalized_name = normalize_name(name) if name is not None else None
        normalized_snapshot = validate_snapshot(snapshot) if snapshot is not None else None
        with self._lock:
            data = self._read_unlocked()
            archive = next((item for item in data["archives"] if item["id"] == archive_id), None)
            if archive is None:
                raise ArchiveNotFoundError("archive not found")
            if normalized_name is not None and any(
                item["id"] != archive_id and item["name"].casefold() == normalized_name.casefold()
                for item in data["archives"]
            ):
                raise ArchiveConflictError("an archive with this name already exists")
            if normalized_name is not None:
                archive["name"] = normalized_name
            if normalized_snapshot is not None:
                archive["snapshot"] = normalized_snapshot
            archive["updated_at"] = _now()
            self._write_unlocked(data)
            return archive

    def delete(self, archive_id):
        archive_id = _normalize_archive_id(archive_id)
        with self._lock:
            data = self._read_unlocked()
            index = next(
                (index for index, item in enumerate(data["archives"]) if item["id"] == archive_id),
                None,
            )
            if index is None:
                raise ArchiveNotFoundError("archive not found")
            removed = data["archives"].pop(index)
            self._write_unlocked(data)
            return removed

    def import_bundle(self, bundle, conflict_policy="skip"):
        if not isinstance(bundle, dict):
            raise ArchiveValidationError("import bundle must be an object")
        if _json_size(bundle) > MAX_IMPORT_BYTES:
            raise ArchiveCapacityError("import bundle is too large")
        if bundle.get("format") != EXPORT_FORMAT or bundle.get("format_version") != FORMAT_VERSION:
            raise ArchiveValidationError("unsupported import bundle format")
        incoming_values = bundle.get("archives")
        if not isinstance(incoming_values, list) or not incoming_values:
            raise ArchiveValidationError("import bundle must contain archives")
        if len(incoming_values) > MAX_ARCHIVES:
            raise ArchiveValidationError(f"import bundle must not exceed {MAX_ARCHIVES} archives")
        if conflict_policy not in {"skip", "overwrite", "rename"}:
            raise ArchiveValidationError("conflict_policy must be skip, overwrite, or rename")
        incoming = [_normalize_export_archive(value) for value in incoming_values]
        incoming_ids = [archive["id"] for archive in incoming]
        incoming_names = [archive["name"].casefold() for archive in incoming]
        if len(incoming_ids) != len(set(incoming_ids)) or len(incoming_names) != len(set(incoming_names)):
            raise ArchiveValidationError("import bundle contains duplicate ids or names")

        with self._lock:
            data = self._read_unlocked()
            archives = data["archives"]
            result = {"imported": 0, "overwritten": 0, "skipped": 0, "renamed": 0}
            for candidate in incoming:
                by_id = next((item for item in archives if item["id"] == candidate["id"]), None)
                by_name = next(
                    (item for item in archives if item["name"].casefold() == candidate["name"].casefold()),
                    None,
                )
                if by_id is not None and by_name is not None and by_id is not by_name:
                    raise ArchiveConflictError("import archive id and name match different local archives")
                conflict = by_id or by_name
                if conflict is not None and conflict_policy == "skip":
                    result["skipped"] += 1
                    continue
                if conflict is not None and conflict_policy == "overwrite":
                    conflict["name"] = candidate["name"]
                    conflict["snapshot"] = candidate["snapshot"]
                    conflict["updated_at"] = _now()
                    result["overwritten"] += 1
                    continue

                new_archive = dict(candidate)
                if conflict is not None or any(item["id"] == new_archive["id"] for item in archives):
                    new_archive["id"] = str(uuid.uuid4())
                if conflict is not None and conflict_policy == "rename":
                    base_name = candidate["name"]
                    suffix = 2
                    used_names = {item["name"].casefold() for item in archives}
                    suffix_text = f" ({suffix})"
                    next_name = f"{base_name[:MAX_NAME_LENGTH - len(suffix_text)].rstrip()}{suffix_text}"
                    while next_name.casefold() in used_names:
                        suffix += 1
                        suffix_text = f" ({suffix})"
                        next_name = f"{base_name[:MAX_NAME_LENGTH - len(suffix_text)].rstrip()}{suffix_text}"
                    new_archive["name"] = next_name
                    new_archive["id"] = str(uuid.uuid4())
                    new_archive["created_at"] = _now()
                    new_archive["updated_at"] = new_archive["created_at"]
                    result["renamed"] += 1
                archives.append(new_archive)
                result["imported"] += 1
                if len(archives) > MAX_ARCHIVES:
                    raise ArchiveCapacityError(f"at most {MAX_ARCHIVES} archives are allowed")
            self._write_unlocked(data)
            result["archives"] = self._sorted(archives)
            return result
