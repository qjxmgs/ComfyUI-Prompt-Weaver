import json
import os
import sys
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


PLUGIN_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_DIR))

from archive_store import (  # noqa: E402
    DEFAULT_ARCHIVE_ID,
    DEFAULT_ARCHIVE_NAME,
    EXPORT_FORMAT,
    FORMAT_VERSION,
    ArchiveCapacityError,
    ArchiveConflictError,
    ArchiveCorruptError,
    ArchiveNotFoundError,
    ArchiveStore,
    ArchiveValidationError,
    validate_snapshot,
)


def snapshot(label="one", columns=2, width=600, height=420):
    return {
        "version": 1,
        "columns": columns,
        "node_size": {"width": width, "height": height},
        "items": [
            {
                "id": f"id-{label}",
                "enabled": True,
                "title": f"标题 {label}",
                "prompt": f"prompt {label}",
            }
        ],
    }


class ArchiveStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.temporary.name, "nested", "archives.json")
        self.store = ArchiveStore(self.path)

    def tearDown(self):
        self.temporary.cleanup()

    def test_crud_and_case_insensitive_unique_names(self):
        created = self.store.create("  人物  ", snapshot())
        self.assertEqual(created["name"], "人物")
        archives = self.store.list_archives()["archives"]
        self.assertEqual(archives[0]["id"], DEFAULT_ARCHIVE_ID)
        self.assertEqual(archives[1]["snapshot"], snapshot())
        with self.assertRaises(ArchiveConflictError):
            self.store.create("人物", snapshot("two"))

        updated = self.store.update(created["id"], name="夜景", snapshot=snapshot("night", 4))
        self.assertEqual(updated["name"], "夜景")
        self.assertEqual(updated["snapshot"]["columns"], 4)
        removed = self.store.delete(created["id"])
        self.assertEqual(removed["name"], "夜景")
        self.assertEqual(
            [item["id"] for item in self.store.list_archives()["archives"]],
            [DEFAULT_ARCHIVE_ID],
        )
        with self.assertRaises(ArchiveNotFoundError):
            self.store.delete(created["id"])

    def test_creation_order_is_stable_and_manual_order_is_persisted(self):
        first = self.store.create("最早", snapshot("first"))
        second = self.store.create("中间", snapshot("second"))
        third = self.store.create("最新", snapshot("third"))
        self.store.update(first["id"], name="最早（已修改）", snapshot=snapshot("updated"))

        self.assertEqual(
            [archive["id"] for archive in self.store.list_archives()["archives"]],
            [DEFAULT_ARCHIVE_ID, first["id"], second["id"], third["id"]],
        )

        reordered = self.store.reorder([third["id"], first["id"], second["id"]])
        expected = [DEFAULT_ARCHIVE_ID, third["id"], first["id"], second["id"]]
        self.assertEqual([archive["id"] for archive in reordered["archives"]], expected)
        self.assertEqual(
            [archive["id"] for archive in self.store.list_archives()["archives"]],
            expected,
        )

        before = Path(self.path).read_bytes()
        invalid_orders = [
            "not-an-array",
            [DEFAULT_ARCHIVE_ID, third["id"], first["id"], second["id"]],
            [third["id"], third["id"], second["id"]],
            [third["id"], first["id"]],
            [third["id"], first["id"], str(uuid.uuid4())],
        ]
        for invalid in invalid_orders:
            with self.subTest(invalid=invalid), self.assertRaises(ArchiveValidationError):
                self.store.reorder(invalid)
            self.assertEqual(Path(self.path).read_bytes(), before)

    def test_bulk_delete_is_atomic_and_resets_last_selection(self):
        first = self.store.create("第一项", snapshot("first"))
        second = self.store.create("第二项", snapshot("second"))
        third = self.store.create("第三项", snapshot("third"))
        self.store.set_last_selected(second["id"])

        result = self.store.delete_many([second["id"], first["id"]])
        self.assertEqual(
            [archive["id"] for archive in result["deleted_archives"]],
            [first["id"], second["id"]],
        )
        self.assertEqual(
            [archive["id"] for archive in result["archives"]],
            [DEFAULT_ARCHIVE_ID, third["id"]],
        )
        self.assertEqual(result["last_selected_archive_id"], DEFAULT_ARCHIVE_ID)

        before = Path(self.path).read_bytes()
        invalid_batches = [
            ([], ArchiveValidationError),
            ("not-an-array", ArchiveValidationError),
            ([DEFAULT_ARCHIVE_ID], ArchiveValidationError),
            ([third["id"], third["id"]], ArchiveValidationError),
            ([third["id"], str(uuid.uuid4())], ArchiveNotFoundError),
        ]
        for invalid, expected_error in invalid_batches:
            with self.subTest(invalid=invalid), self.assertRaises(expected_error):
                self.store.delete_many(invalid)
            self.assertEqual(Path(self.path).read_bytes(), before)

    def test_snapshot_validation_is_strict_and_canonical(self):
        value = snapshot()
        value["ignored"] = "value"
        value["items"][0]["ignored"] = "value"
        self.assertEqual(validate_snapshot(value), snapshot())
        legacy_value = snapshot("legacy")
        legacy_value.pop("node_size")
        self.assertEqual(validate_snapshot(legacy_value), snapshot("legacy"))
        colored_value = snapshot("colored")
        colored_value["items"][0]["color"] = "pink"
        self.assertEqual(validate_snapshot(colored_value), colored_value)
        retained_value = snapshot("retained")
        retained_value["items"][0]["prompt_tokens"] = [
            {"text": "prompt retained", "selected": True},
            {"text": "blue eyes", "selected": False},
        ]
        self.assertEqual(validate_snapshot(retained_value), retained_value)
        disabled_retention = snapshot("disabled-retention")
        disabled_retention["items"][0]["retain_unselected"] = False
        disabled_retention["items"][0]["prompt_tokens"] = [
            {"text": "ignored retained token", "selected": False},
        ]
        expected_disabled = snapshot("disabled-retention")
        expected_disabled["items"][0]["retain_unselected"] = False
        self.assertEqual(validate_snapshot(disabled_retention), expected_disabled)
        invalid_values = [
            {"version": 2, "columns": 2, "items": []},
            {"version": 1, "columns": 0, "items": []},
            {"version": 1, "columns": 2, "node_size": [], "items": []},
            {
                "version": 1,
                "columns": 2,
                "node_size": {"width": 99, "height": 420},
                "items": [],
            },
            {
                "version": 1,
                "columns": 2,
                "node_size": {"width": 600.5, "height": 420},
                "items": [],
            },
            {"version": 1, "columns": 2, "items": [{"id": "x", "enabled": 1, "title": "", "prompt": ""}]},
            {
                "version": 1,
                "columns": 2,
                "items": [
                    {"id": "x", "enabled": True, "title": "", "prompt": "", "color": "magenta"},
                ],
            },
            {
                "version": 1,
                "columns": 2,
                "items": [
                    {"id": "x", "enabled": True, "title": "", "prompt": "", "color": None},
                ],
            },
            {
                "version": 1,
                "columns": 2,
                "items": [
                    {
                        "id": "x",
                        "enabled": True,
                        "title": "",
                        "prompt": "",
                        "retain_unselected": "yes",
                    },
                ],
            },
            {
                "version": 1,
                "columns": 2,
                "items": [
                    {
                        "id": "x",
                        "enabled": True,
                        "title": "",
                        "prompt": "",
                        "prompt_tokens": [{"text": "", "selected": False}],
                    },
                ],
            },
            {
                "version": 1,
                "columns": 2,
                "items": [
                    {"id": "x", "enabled": True, "title": "", "prompt": ""},
                    {"id": "x", "enabled": False, "title": "", "prompt": ""},
                ],
            },
        ]
        for value in invalid_values:
            with self.subTest(value=value), self.assertRaises(ArchiveValidationError):
                validate_snapshot(value)

    def test_corrupt_file_is_not_silently_replaced(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        original = b"{broken"
        with open(self.path, "wb") as handle:
            handle.write(original)
        with self.assertRaises(ArchiveCorruptError):
            self.store.list_archives()
        with self.assertRaises(ArchiveCorruptError):
            self.store.create("new", snapshot())
        with open(self.path, "rb") as handle:
            self.assertEqual(handle.read(), original)

    def test_default_archive_migrates_is_protected_and_tracks_selection(self):
        legacy_snapshot = snapshot("legacy-default")
        legacy_snapshot.pop("node_size")
        legacy = {
            "format_version": FORMAT_VERSION,
            "archives": [
                {
                    "id": str(uuid.uuid4()),
                    "name": DEFAULT_ARCHIVE_NAME,
                    "created_at": "2026-08-10T00:00:00Z",
                    "updated_at": "2026-08-10T00:00:00Z",
                    "snapshot": legacy_snapshot,
                }
            ],
        }
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        Path(self.path).write_text(json.dumps(legacy, ensure_ascii=False), encoding="utf-8")

        data = self.store.list_archives()
        self.assertEqual(data["last_selected_archive_id"], DEFAULT_ARCHIVE_ID)
        self.assertEqual(data["archives"][0]["id"], DEFAULT_ARCHIVE_ID)
        self.assertTrue(data["archives"][0]["is_default"])
        self.assertEqual(data["archives"][0]["snapshot"], snapshot("legacy-default"))

        updated = self.store.update(DEFAULT_ARCHIVE_ID, snapshot=snapshot("custom-default"))
        self.assertEqual(updated["snapshot"], snapshot("custom-default"))
        with self.assertRaises(ArchiveValidationError):
            self.store.update(DEFAULT_ARCHIVE_ID, name="其他名称")
        with self.assertRaises(ArchiveValidationError):
            self.store.delete(DEFAULT_ARCHIVE_ID)

        regular = self.store.create("人物", snapshot("person"))
        self.assertEqual(self.store.set_last_selected(regular["id"]), regular["id"])
        self.assertEqual(self.store.list_archives()["last_selected_archive_id"], regular["id"])
        self.store.delete(regular["id"])
        self.assertEqual(self.store.list_archives()["last_selected_archive_id"], DEFAULT_ARCHIVE_ID)
        with self.assertRaises(ArchiveNotFoundError):
            self.store.set_last_selected(str(uuid.uuid4()))

    def test_existing_store_atomically_persists_missing_node_size(self):
        legacy_snapshot = snapshot("legacy-size")
        legacy_snapshot.pop("node_size")
        legacy = {
            "format_version": FORMAT_VERSION,
            "last_selected_archive_id": DEFAULT_ARCHIVE_ID,
            "archives": [
                {
                    "id": DEFAULT_ARCHIVE_ID,
                    "name": DEFAULT_ARCHIVE_NAME,
                    "created_at": "2026-08-10T00:00:00.000Z",
                    "updated_at": "2026-08-10T00:00:00.000Z",
                    "snapshot": legacy_snapshot,
                }
            ],
        }
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        Path(self.path).write_text(json.dumps(legacy, ensure_ascii=False), encoding="utf-8")

        loaded = self.store.list_archives()
        self.assertEqual(loaded["archives"][0]["snapshot"], snapshot("legacy-size"))
        persisted = json.loads(Path(self.path).read_text(encoding="utf-8"))
        self.assertEqual(
            persisted["archives"][0]["snapshot"]["node_size"],
            {"width": 600, "height": 420},
        )

    def test_import_skip_overwrite_and_rename_are_atomic(self):
        local = self.store.create("人物", snapshot("local"))
        exported = {
            "format": EXPORT_FORMAT,
            "format_version": FORMAT_VERSION,
            "exported_at": "2026-08-10T00:00:00Z",
            "archives": [
                {
                    "id": local["id"],
                    "name": "人物",
                    "created_at": "2026-08-10T00:00:00Z",
                    "updated_at": "2026-08-10T00:00:00Z",
                    "snapshot": snapshot("imported"),
                }
            ],
        }
        result = self.store.import_bundle(exported, "skip")
        self.assertEqual(result["skipped"], 1)
        stored = next(
            item for item in self.store.list_archives()["archives"] if item["id"] == local["id"]
        )
        self.assertEqual(stored["snapshot"], snapshot("local"))

        result = self.store.import_bundle(exported, "overwrite")
        self.assertEqual(result["overwritten"], 1)
        archives = self.store.list_archives()["archives"]
        imported = next(item for item in archives if item["id"] == local["id"])
        self.assertEqual(imported["snapshot"], snapshot("imported"))

        result = self.store.import_bundle(exported, "rename")
        self.assertEqual(result["renamed"], 1)
        archives = self.store.list_archives()["archives"]
        self.assertEqual(len(archives), 3)
        self.assertEqual(
            [archive["name"] for archive in archives],
            [DEFAULT_ARCHIVE_NAME, "人物", "人物 (2)"],
        )

        before = Path(self.path).read_bytes()
        invalid = json.loads(json.dumps(exported, ensure_ascii=False))
        invalid["archives"][0]["snapshot"]["columns"] = 99
        with self.assertRaises(ArchiveValidationError):
            self.store.import_bundle(invalid, "overwrite")
        self.assertEqual(Path(self.path).read_bytes(), before)

    def test_default_archive_participates_in_all_import_policies(self):
        default_archive = self.store.list_archives()["archives"][0]
        exported = {
            "format": EXPORT_FORMAT,
            "format_version": FORMAT_VERSION,
            "exported_at": "2026-08-10T00:00:00Z",
            "archives": [{**default_archive, "snapshot": snapshot("imported-default")}],
        }

        skipped = self.store.import_bundle(exported, "skip")
        self.assertEqual(skipped["skipped"], 1)
        self.assertNotEqual(
            self.store.list_archives()["archives"][0]["snapshot"],
            snapshot("imported-default"),
        )

        overwritten = self.store.import_bundle(exported, "overwrite")
        self.assertEqual(overwritten["overwritten"], 1)
        self.assertEqual(
            self.store.list_archives()["archives"][0]["snapshot"],
            snapshot("imported-default"),
        )

        renamed = self.store.import_bundle(exported, "rename")
        self.assertEqual(renamed["renamed"], 1)
        self.assertEqual(
            [archive["name"] for archive in renamed["archives"]],
            [DEFAULT_ARCHIVE_NAME, f"{DEFAULT_ARCHIVE_NAME} (2)"],
        )

    def test_concurrent_creates_do_not_lose_updates(self):
        with ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(lambda index: self.store.create(f"存档 {index}", snapshot(str(index))), range(20)))
        archives = self.store.list_archives()["archives"]
        self.assertEqual(len(archives), 21)
        self.assertEqual(len({archive["name"] for archive in archives}), 21)
        leftovers = [name for name in os.listdir(os.path.dirname(self.path)) if name != "archives.json"]
        self.assertEqual(leftovers, [])

    def test_name_count_snapshot_and_import_size_limits(self):
        with self.assertRaises(ArchiveValidationError):
            self.store.create("x" * 81, snapshot())

        oversized_snapshot = {
            "version": 1,
            "columns": 2,
            "items": [
                {
                    "id": f"large-{index}",
                    "enabled": True,
                    "title": "large",
                    "prompt": "x" * 100_000,
                }
                for index in range(6)
            ],
        }
        with self.assertRaises(ArchiveValidationError):
            validate_snapshot(oversized_snapshot)

        many_archives = {
            "format": EXPORT_FORMAT,
            "format_version": FORMAT_VERSION,
            "exported_at": "2026-08-10T00:00:00Z",
            "archives": [
                {
                    "id": f"00000000-0000-4000-8000-{index:012d}",
                    "name": f"large {index}",
                    "created_at": "2026-08-10T00:00:00Z",
                    "updated_at": "2026-08-10T00:00:00Z",
                    "snapshot": {
                        "version": 1,
                        "columns": 2,
                        "items": [
                            {
                                "id": f"item-{index}",
                                "enabled": True,
                                "title": "large",
                                "prompt": "x" * 90_000,
                            }
                        ],
                    },
                }
                for index in range(24)
            ],
        }
        with self.assertRaises(ArchiveCapacityError):
            self.store.import_bundle(many_archives)

        for index in range(100):
            self.store.create(f"count {index}", snapshot(str(index)))
        with self.assertRaises(ArchiveCapacityError):
            self.store.create("count overflow", snapshot("overflow"))


if __name__ == "__main__":
    unittest.main()
