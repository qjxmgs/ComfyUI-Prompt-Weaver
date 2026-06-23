import json
import os
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


PLUGIN_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_DIR))

from archive_store import (  # noqa: E402
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


def snapshot(label="one", columns=2):
    return {
        "version": 1,
        "columns": columns,
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
        self.assertEqual(self.store.list_archives()["archives"][0]["snapshot"], snapshot())
        with self.assertRaises(ArchiveConflictError):
            self.store.create("人物", snapshot("two"))

        updated = self.store.update(created["id"], name="夜景", snapshot=snapshot("night", 4))
        self.assertEqual(updated["name"], "夜景")
        self.assertEqual(updated["snapshot"]["columns"], 4)
        removed = self.store.delete(created["id"])
        self.assertEqual(removed["name"], "夜景")
        self.assertEqual(self.store.list_archives()["archives"], [])
        with self.assertRaises(ArchiveNotFoundError):
            self.store.delete(created["id"])

    def test_snapshot_validation_is_strict_and_canonical(self):
        value = snapshot()
        value["ignored"] = "value"
        value["items"][0]["ignored"] = "value"
        self.assertEqual(validate_snapshot(value), snapshot())
        invalid_values = [
            {"version": 2, "columns": 2, "items": []},
            {"version": 1, "columns": 0, "items": []},
            {"version": 1, "columns": 2, "items": [{"id": "x", "enabled": 1, "title": "", "prompt": ""}]},
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
        self.assertEqual(self.store.list_archives()["archives"][0]["snapshot"], snapshot("local"))

        result = self.store.import_bundle(exported, "overwrite")
        self.assertEqual(result["overwritten"], 1)
        archives = self.store.list_archives()["archives"]
        self.assertEqual(archives[0]["id"], local["id"])
        self.assertEqual(archives[0]["snapshot"], snapshot("imported"))

        result = self.store.import_bundle(exported, "rename")
        self.assertEqual(result["renamed"], 1)
        archives = self.store.list_archives()["archives"]
        self.assertEqual(len(archives), 2)
        self.assertEqual({archive["name"] for archive in archives}, {"人物", "人物 (2)"})

        before = Path(self.path).read_bytes()
        invalid = json.loads(json.dumps(exported, ensure_ascii=False))
        invalid["archives"][0]["snapshot"]["columns"] = 99
        with self.assertRaises(ArchiveValidationError):
            self.store.import_bundle(invalid, "overwrite")
        self.assertEqual(Path(self.path).read_bytes(), before)

    def test_concurrent_creates_do_not_lose_updates(self):
        with ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(lambda index: self.store.create(f"存档 {index}", snapshot(str(index))), range(20)))
        archives = self.store.list_archives()["archives"]
        self.assertEqual(len(archives), 20)
        self.assertEqual(len({archive["name"] for archive in archives}), 20)
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
