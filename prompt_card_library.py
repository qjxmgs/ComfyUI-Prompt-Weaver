import json
import os
import tempfile
import threading
import uuid
from datetime import datetime, timezone


FORMAT_VERSION = 1
MAX_PRIMARY_CATEGORIES = 100
MAX_SECONDARY_CATEGORIES = 500
MAX_CARDS = 2_000
MAX_CATEGORY_NAME_LENGTH = 80
MAX_TITLE_LENGTH = 200
MAX_PROMPT_LENGTH = 100_000
MAX_REQUEST_BYTES = 512 * 1024
MAX_STORE_BYTES = 20 * 1024 * 1024
ITEM_COLORS = frozenset(
    {"red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "gray", "white", "black"}
)


class PromptCardLibraryError(Exception):
    pass


class PromptCardLibraryValidationError(PromptCardLibraryError):
    pass


class PromptCardLibraryConflictError(PromptCardLibraryError):
    pass


class PromptCardLibraryNotFoundError(PromptCardLibraryError):
    pass


class PromptCardLibraryCapacityError(PromptCardLibraryError):
    pass


class PromptCardLibraryCorruptError(PromptCardLibraryError):
    pass


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _reject_json_constant(value):
    raise PromptCardLibraryValidationError(f"invalid JSON constant {value!r}")


def _normalize_uuid(value, field):
    if not isinstance(value, str):
        raise PromptCardLibraryValidationError(f"{field} must be a UUID string")
    try:
        return str(uuid.UUID(value))
    except ValueError as error:
        raise PromptCardLibraryValidationError(f"{field} must be a UUID string") from error


def _normalize_timestamp(value, field):
    if not isinstance(value, str) or not value or len(value) > 64:
        raise PromptCardLibraryValidationError(f"{field} must be an ISO timestamp")
    try:
        timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise PromptCardLibraryValidationError(f"{field} must be an ISO timestamp") from error
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)
    return timestamp.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def normalize_category_name(value):
    if not isinstance(value, str):
        raise PromptCardLibraryValidationError("category name must be a string")
    name = value.strip()
    if not name:
        raise PromptCardLibraryValidationError("category name must not be empty")
    if len(name) > MAX_CATEGORY_NAME_LENGTH:
        raise PromptCardLibraryValidationError(
            f"category name must not exceed {MAX_CATEGORY_NAME_LENGTH} characters"
        )
    return name


def _normalize_prompt_tokens(value):
    if not isinstance(value, list):
        raise PromptCardLibraryValidationError("prompt_tokens must be an array")
    normalized = []
    total_length = 0
    for index, token in enumerate(value):
        if not isinstance(token, dict):
            raise PromptCardLibraryValidationError(f"prompt_tokens[{index}] must be an object")
        text = token.get("text")
        selected = token.get("selected")
        if not isinstance(text, str) or not text.strip():
            raise PromptCardLibraryValidationError(
                f"prompt_tokens[{index}].text must be a non-empty string"
            )
        total_length += len(text)
        if total_length > MAX_PROMPT_LENGTH:
            raise PromptCardLibraryCapacityError("prompt token text is too large")
        if not isinstance(selected, bool):
            raise PromptCardLibraryValidationError(
                f"prompt_tokens[{index}].selected must be a boolean"
            )
        normalized.append({"text": text.strip(), "selected": selected})
    return normalized


def normalize_card_snapshot(value):
    if not isinstance(value, dict):
        raise PromptCardLibraryValidationError("card snapshot must be an object")
    title = value.get("title", "")
    prompt = value.get("prompt")
    if not isinstance(title, str) or len(title) > MAX_TITLE_LENGTH:
        raise PromptCardLibraryValidationError(
            f"card title must be a string up to {MAX_TITLE_LENGTH} characters"
        )
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > MAX_PROMPT_LENGTH:
        raise PromptCardLibraryValidationError(
            f"card prompt must be a non-empty string up to {MAX_PROMPT_LENGTH} characters"
        )
    normalized = {"title": title, "prompt": prompt}
    if "color" in value:
        color = value.get("color")
        if not isinstance(color, str) or color not in ITEM_COLORS:
            raise PromptCardLibraryValidationError("card color must be a supported color")
        normalized["color"] = color
    retain_unselected = value.get("retain_unselected", True)
    if not isinstance(retain_unselected, bool):
        raise PromptCardLibraryValidationError("retain_unselected must be a boolean")
    if retain_unselected is False:
        normalized["retain_unselected"] = False
    elif "prompt_tokens" in value:
        prompt_tokens = _normalize_prompt_tokens(value.get("prompt_tokens"))
        if any(not token["selected"] for token in prompt_tokens):
            normalized["prompt_tokens"] = prompt_tokens
    return normalized


def _normalize_category(value):
    if not isinstance(value, dict):
        raise PromptCardLibraryValidationError("each category must be an object")
    parent_id = value.get("parent_id")
    return {
        "id": _normalize_uuid(value.get("id"), "category id"),
        "parent_id": None if parent_id is None else _normalize_uuid(parent_id, "category parent_id"),
        "name": normalize_category_name(value.get("name")),
        "created_at": _normalize_timestamp(value.get("created_at"), "category created_at"),
        "updated_at": _normalize_timestamp(value.get("updated_at"), "category updated_at"),
    }


def _normalize_card(value):
    if not isinstance(value, dict):
        raise PromptCardLibraryValidationError("each favorite card must be an object")
    normalized = {
        "id": _normalize_uuid(value.get("id"), "favorite card id"),
        "category_id": _normalize_uuid(value.get("category_id"), "favorite card category_id"),
        **normalize_card_snapshot(value),
        "created_at": _normalize_timestamp(value.get("created_at"), "favorite card created_at"),
        "updated_at": _normalize_timestamp(value.get("updated_at"), "favorite card updated_at"),
    }
    return normalized


class PromptCardLibraryStore:
    def __init__(self, path):
        self.path = os.path.abspath(path)
        self._lock = threading.RLock()

    @staticmethod
    def _empty():
        return {"format_version": FORMAT_VERSION, "revision": 0, "categories": [], "cards": []}

    def _normalize_data(self, value):
        if not isinstance(value, dict) or value.get("format_version") != FORMAT_VERSION:
            raise PromptCardLibraryValidationError("unsupported prompt card library format")
        revision = value.get("revision", 0)
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
            raise PromptCardLibraryValidationError("library revision must be a non-negative integer")
        raw_categories = value.get("categories")
        raw_cards = value.get("cards")
        if not isinstance(raw_categories, list) or not isinstance(raw_cards, list):
            raise PromptCardLibraryValidationError("library categories and cards must be arrays")
        categories = [_normalize_category(category) for category in raw_categories]
        cards = [_normalize_card(card) for card in raw_cards]
        category_by_id = {category["id"]: category for category in categories}
        if len(category_by_id) != len(categories):
            raise PromptCardLibraryValidationError("library contains duplicate category ids")
        card_ids = {card["id"] for card in cards}
        if len(card_ids) != len(cards):
            raise PromptCardLibraryValidationError("library contains duplicate favorite card ids")

        primary_count = 0
        secondary_count = 0
        sibling_names = set()
        for category in categories:
            parent_id = category["parent_id"]
            if parent_id is None:
                primary_count += 1
            else:
                parent = category_by_id.get(parent_id)
                if parent is None or parent["parent_id"] is not None:
                    raise PromptCardLibraryValidationError(
                        "secondary categories must reference an existing primary category"
                    )
                secondary_count += 1
            sibling_key = (parent_id, category["name"].casefold())
            if sibling_key in sibling_names:
                raise PromptCardLibraryValidationError("library contains duplicate sibling category names")
            sibling_names.add(sibling_key)
        if primary_count > MAX_PRIMARY_CATEGORIES:
            raise PromptCardLibraryCapacityError("library has too many primary categories")
        if secondary_count > MAX_SECONDARY_CATEGORIES:
            raise PromptCardLibraryCapacityError("library has too many secondary categories")
        if len(cards) > MAX_CARDS:
            raise PromptCardLibraryCapacityError("library has too many favorite cards")
        for card in cards:
            category = category_by_id.get(card["category_id"])
            if category is None or category["parent_id"] is None:
                raise PromptCardLibraryValidationError(
                    "favorite cards must reference an existing secondary category"
                )
        return {
            "format_version": FORMAT_VERSION,
            "revision": revision,
            "categories": categories,
            "cards": cards,
        }

    def _read_unlocked(self):
        if not os.path.exists(self.path):
            data = self._empty()
            self._write_unlocked(data)
            return data
        if os.path.getsize(self.path) > MAX_STORE_BYTES:
            raise PromptCardLibraryCorruptError("prompt card library is too large")
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                raw = json.load(handle, parse_constant=_reject_json_constant)
            data = self._normalize_data(raw)
        except PromptCardLibraryCapacityError as error:
            raise PromptCardLibraryCorruptError(f"prompt card library is invalid: {error}") from error
        except (
            OSError,
            json.JSONDecodeError,
            UnicodeDecodeError,
            PromptCardLibraryValidationError,
        ) as error:
            raise PromptCardLibraryCorruptError(f"prompt card library cannot be read: {error}") from error
        if data != raw:
            self._write_unlocked(data)
        return data

    def _write_unlocked(self, data):
        encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MAX_STORE_BYTES:
            raise PromptCardLibraryCapacityError("prompt card library size limit exceeded")
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
    def _category(data, category_id):
        return next((item for item in data["categories"] if item["id"] == category_id), None)

    @classmethod
    def _secondary_category(cls, data, category_id):
        category = cls._category(data, category_id)
        if category is None:
            raise PromptCardLibraryNotFoundError("category not found")
        if category["parent_id"] is None:
            raise PromptCardLibraryValidationError("favorite cards must use a secondary category")
        return category

    @staticmethod
    def _card(data, card_id):
        return next((item for item in data["cards"] if item["id"] == card_id), None)

    @staticmethod
    def _increment_revision(data):
        data["revision"] += 1

    def list_library(self):
        with self._lock:
            return self._read_unlocked()

    def create_category(self, name, parent_id=None):
        name = normalize_category_name(name)
        normalized_parent = None if parent_id is None else _normalize_uuid(parent_id, "parent_id")
        with self._lock:
            data = self._read_unlocked()
            if normalized_parent is None:
                if sum(item["parent_id"] is None for item in data["categories"]) >= MAX_PRIMARY_CATEGORIES:
                    raise PromptCardLibraryCapacityError("primary category limit reached")
            else:
                parent = self._category(data, normalized_parent)
                if parent is None:
                    raise PromptCardLibraryNotFoundError("parent category not found")
                if parent["parent_id"] is not None:
                    raise PromptCardLibraryValidationError("categories support exactly two levels")
                if sum(item["parent_id"] is not None for item in data["categories"]) >= MAX_SECONDARY_CATEGORIES:
                    raise PromptCardLibraryCapacityError("secondary category limit reached")
            if any(
                item["parent_id"] == normalized_parent and item["name"].casefold() == name.casefold()
                for item in data["categories"]
            ):
                raise PromptCardLibraryConflictError("a sibling category with the same name already exists")
            timestamp = _now()
            category = {
                "id": str(uuid.uuid4()),
                "parent_id": normalized_parent,
                "name": name,
                "created_at": timestamp,
                "updated_at": timestamp,
            }
            data["categories"].append(category)
            self._increment_revision(data)
            self._write_unlocked(data)
            return category, data["revision"]

    def update_category(self, category_id, name):
        category_id = _normalize_uuid(category_id, "category id")
        name = normalize_category_name(name)
        with self._lock:
            data = self._read_unlocked()
            category = self._category(data, category_id)
            if category is None:
                raise PromptCardLibraryNotFoundError("category not found")
            if any(
                item["id"] != category_id
                and item["parent_id"] == category["parent_id"]
                and item["name"].casefold() == name.casefold()
                for item in data["categories"]
            ):
                raise PromptCardLibraryConflictError("a sibling category with the same name already exists")
            category["name"] = name
            category["updated_at"] = _now()
            self._increment_revision(data)
            self._write_unlocked(data)
            return category, data["revision"]

    def delete_category(self, category_id, target_category_id=None):
        category_id = _normalize_uuid(category_id, "category id")
        normalized_target = (
            None if target_category_id is None else _normalize_uuid(target_category_id, "target_category_id")
        )
        with self._lock:
            data = self._read_unlocked()
            category = self._category(data, category_id)
            if category is None:
                raise PromptCardLibraryNotFoundError("category not found")
            removed_ids = {category_id}
            if category["parent_id"] is None:
                removed_ids.update(
                    item["id"] for item in data["categories"] if item["parent_id"] == category_id
                )
            affected_cards = [card for card in data["cards"] if card["category_id"] in removed_ids]
            if affected_cards:
                if normalized_target is None:
                    raise PromptCardLibraryValidationError(
                        "target_category_id is required when deleting a non-empty category"
                    )
                if normalized_target in removed_ids:
                    raise PromptCardLibraryValidationError("migration target cannot be deleted")
                self._secondary_category(data, normalized_target)
                timestamp = _now()
                for card in affected_cards:
                    card["category_id"] = normalized_target
                    card["updated_at"] = timestamp
            data["categories"] = [
                item for item in data["categories"] if item["id"] not in removed_ids
            ]
            self._increment_revision(data)
            self._write_unlocked(data)
            return {
                "deleted_category_ids": list(removed_ids),
                "moved_cards": len(affected_cards),
                "revision": data["revision"],
            }

    def create_card(self, category_id, snapshot):
        category_id = _normalize_uuid(category_id, "category_id")
        snapshot = normalize_card_snapshot(snapshot)
        with self._lock:
            data = self._read_unlocked()
            self._secondary_category(data, category_id)
            if len(data["cards"]) >= MAX_CARDS:
                raise PromptCardLibraryCapacityError("favorite card limit reached")
            timestamp = _now()
            card = {
                "id": str(uuid.uuid4()),
                "category_id": category_id,
                **snapshot,
                "created_at": timestamp,
                "updated_at": timestamp,
            }
            data["cards"].append(card)
            self._increment_revision(data)
            self._write_unlocked(data)
            return card, data["revision"]

    def update_card(self, card_id, category_id=None, snapshot=None):
        card_id = _normalize_uuid(card_id, "favorite card id")
        if category_id is None and snapshot is None:
            raise PromptCardLibraryValidationError("category_id or snapshot is required")
        normalized_category = None if category_id is None else _normalize_uuid(category_id, "category_id")
        normalized_snapshot = None if snapshot is None else normalize_card_snapshot(snapshot)
        with self._lock:
            data = self._read_unlocked()
            card = self._card(data, card_id)
            if card is None:
                raise PromptCardLibraryNotFoundError("favorite card not found")
            if normalized_category is not None:
                self._secondary_category(data, normalized_category)
                card["category_id"] = normalized_category
            if normalized_snapshot is not None:
                for field in ("title", "prompt", "color", "retain_unselected", "prompt_tokens"):
                    card.pop(field, None)
                card.update(normalized_snapshot)
            card["updated_at"] = _now()
            self._increment_revision(data)
            self._write_unlocked(data)
            return card, data["revision"]

    def delete_card(self, card_id):
        card_id = _normalize_uuid(card_id, "favorite card id")
        with self._lock:
            data = self._read_unlocked()
            index = next(
                (index for index, card in enumerate(data["cards"]) if card["id"] == card_id),
                None,
            )
            if index is None:
                raise PromptCardLibraryNotFoundError("favorite card not found")
            card = data["cards"].pop(index)
            self._increment_revision(data)
            self._write_unlocked(data)
            return card, data["revision"]
