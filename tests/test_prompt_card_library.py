import json
import os
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock


PLUGIN_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_DIR))

import prompt_card_library as library_module  # noqa: E402
from prompt_card_library import (  # noqa: E402
    PromptCardLibraryCapacityError,
    PromptCardLibraryConflictError,
    PromptCardLibraryCorruptError,
    PromptCardLibraryNotFoundError,
    PromptCardLibraryStore,
    PromptCardLibraryValidationError,
)


def snapshot(label="one"):
    return {
        "title": f"卡片 {label}",
        "prompt": f"prompt {label}",
        "color": "purple",
        "prompt_tokens": [
            {"text": f"prompt {label}", "selected": True},
            {"text": f"inactive {label}", "selected": False},
        ],
    }


class PromptCardLibraryStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.temporary.name, "nested", "prompt-card-library.json")
        self.store = PromptCardLibraryStore(self.path)

    def tearDown(self):
        self.temporary.cleanup()

    def create_branch(self, primary_name="人物", secondary_name="角色"):
        primary, _revision = self.store.create_category(primary_name)
        secondary, _revision = self.store.create_category(secondary_name, primary["id"])
        return primary, secondary

    def test_first_read_creates_user_store_and_crud_uses_secondary_categories(self):
        empty = self.store.list_library()
        self.assertEqual(empty["format_version"], 1)
        self.assertEqual(empty["revision"], 0)
        self.assertTrue(Path(self.path).is_file())

        primary, secondary = self.create_branch()
        with self.assertRaises(PromptCardLibraryValidationError):
            self.store.create_card(primary["id"], snapshot())

        card, revision = self.store.create_card(secondary["id"], snapshot())
        self.assertEqual(card["category_id"], secondary["id"])
        self.assertEqual(card["prompt_tokens"][1]["selected"], False)
        self.assertEqual(revision, 3)

        renamed, _revision = self.store.update_category(secondary["id"], "  主角  ")
        self.assertEqual(renamed["name"], "主角")
        updated, _revision = self.store.update_card(card["id"], snapshot=snapshot("updated"))
        self.assertEqual(updated["prompt"], "prompt updated")
        removed, _revision = self.store.delete_card(card["id"])
        self.assertEqual(removed["id"], card["id"])
        with self.assertRaises(PromptCardLibraryNotFoundError):
            self.store.delete_card(card["id"])

    def test_sibling_names_are_case_insensitive_but_other_parents_may_reuse_names(self):
        first, first_child = self.create_branch("First", "People")
        second, _revision = self.store.create_category("Second")
        with self.assertRaises(PromptCardLibraryConflictError):
            self.store.create_category("first")
        with self.assertRaises(PromptCardLibraryConflictError):
            self.store.create_category("people", first["id"])
        reused, _revision = self.store.create_category("People", second["id"])
        self.assertEqual(reused["name"], first_child["name"])

    def test_category_position_reorders_primary_and_secondary_siblings(self):
        first, first_child = self.create_branch("First", "One")
        second, second_child = self.create_branch("Second", "Two")
        third, before_revision = self.store.create_category("Third")
        extra, before_secondary_revision = self.store.create_category("Three", second["id"])

        changed, positioned, revision = self.store.position_category(third["id"], None, 0)
        self.assertTrue(changed)
        self.assertEqual(positioned["id"], third["id"])
        self.assertEqual(revision, before_secondary_revision + 1)
        self.assertEqual(
            [item["id"] for item in self.store.list_library()["categories"] if item["parent_id"] is None],
            [third["id"], first["id"], second["id"]],
        )

        changed, positioned, revision = self.store.position_category(extra["id"], second["id"], 0)
        self.assertTrue(changed)
        self.assertEqual(positioned["parent_id"], second["id"])
        self.assertEqual(
            [
                item["id"]
                for item in self.store.list_library()["categories"]
                if item["parent_id"] == second["id"]
            ],
            [extra["id"], second_child["id"]],
        )
        self.assertNotEqual(first_child["id"], second_child["id"])

    def test_category_position_reparents_secondary_and_rejects_invalid_moves(self):
        first, moving = self.create_branch("First", "Shared")
        second, target_first = self.create_branch("Second", "Existing")
        target_second, revision = self.store.create_category("Tail", second["id"])

        changed, positioned, moved_revision = self.store.position_category(
            moving["id"], second["id"], 1
        )
        self.assertTrue(changed)
        self.assertEqual(moved_revision, revision + 1)
        self.assertEqual(positioned["parent_id"], second["id"])
        self.assertEqual(
            [
                item["id"]
                for item in self.store.list_library()["categories"]
                if item["parent_id"] == second["id"]
            ],
            [target_first["id"], moving["id"], target_second["id"]],
        )
        unchanged, _category, same_revision = self.store.position_category(
            moving["id"], second["id"], 1
        )
        self.assertFalse(unchanged)
        self.assertEqual(same_revision, moved_revision)

        before = Path(self.path).read_bytes()
        for category_id, parent_id, index in (
            (first["id"], second["id"], 0),
            (moving["id"], None, 0),
            (moving["id"], target_first["id"], 0),
            (moving["id"], second["id"], -1),
            (moving["id"], second["id"], 4),
            (moving["id"], second["id"], True),
        ):
            with self.subTest(category_id=category_id, parent_id=parent_id, index=index):
                with self.assertRaises(PromptCardLibraryValidationError):
                    self.store.position_category(category_id, parent_id, index)
                self.assertEqual(Path(self.path).read_bytes(), before)

    def test_category_reparent_rejects_duplicate_target_name(self):
        _first, moving = self.create_branch("First", "Shared")
        second, _existing = self.create_branch("Second", "Shared")
        before = Path(self.path).read_bytes()
        with self.assertRaises(PromptCardLibraryConflictError):
            self.store.position_category(moving["id"], second["id"], 1)
        self.assertEqual(Path(self.path).read_bytes(), before)

    def test_nonempty_secondary_delete_requires_and_applies_migration(self):
        _first, source = self.create_branch("人物", "角色")
        _second, target = self.create_branch("场景", "室内")
        card, _revision = self.store.create_card(source["id"], snapshot())
        before = Path(self.path).read_bytes()
        with self.assertRaises(PromptCardLibraryValidationError):
            self.store.delete_category(source["id"])
        self.assertEqual(Path(self.path).read_bytes(), before)

        result = self.store.delete_category(source["id"], target["id"])
        self.assertEqual(result["moved_cards"], 1)
        library = self.store.list_library()
        self.assertNotIn(source["id"], {entry["id"] for entry in library["categories"]})
        moved = next(entry for entry in library["cards"] if entry["id"] == card["id"])
        self.assertEqual(moved["category_id"], target["id"])

    def test_primary_delete_migrates_descendant_cards_and_removes_children(self):
        primary, child = self.create_branch("人物", "角色")
        sibling, _revision = self.store.create_category("服装", primary["id"])
        _target_primary, target = self.create_branch("归档", "保留")
        self.store.create_card(child["id"], snapshot("one"))
        self.store.create_card(sibling["id"], snapshot("two"))

        with self.assertRaises(PromptCardLibraryValidationError):
            self.store.delete_category(primary["id"], child["id"])
        result = self.store.delete_category(primary["id"], target["id"])
        self.assertEqual(result["moved_cards"], 2)
        self.assertEqual(set(result["deleted_category_ids"]), {primary["id"], child["id"], sibling["id"]})
        self.assertTrue(all(
            card["category_id"] == target["id"]
            for card in self.store.list_library()["cards"]
        ))

    def test_card_move_does_not_update_independent_snapshot(self):
        _first, source = self.create_branch("人物", "角色")
        _second, target = self.create_branch("场景", "室内")
        existing, _revision = self.store.create_card(target["id"], snapshot("existing"))
        card, _revision = self.store.create_card(source["id"], snapshot())
        moved, _revision = self.store.update_card(card["id"], category_id=target["id"])
        self.assertEqual(moved["category_id"], target["id"])
        self.assertEqual(moved["prompt"], card["prompt"])
        self.assertEqual(moved["title"], card["title"])
        self.assertEqual(
            [entry["id"] for entry in self.store.list_library()["cards"] if entry["category_id"] == target["id"]],
            [existing["id"], card["id"]],
        )

    def test_card_reorder_is_persistent_atomic_and_keeps_other_categories_stable(self):
        _primary, category = self.create_branch("人物", "角色")
        _other_primary, other_category = self.create_branch("场景", "室内")
        first, _revision = self.store.create_card(category["id"], snapshot("one"))
        other, _revision = self.store.create_card(other_category["id"], snapshot("other"))
        second, _revision = self.store.create_card(category["id"], snapshot("two"))
        third, before_revision = self.store.create_card(category["id"], snapshot("three"))

        changed, revision = self.store.reorder_cards(
            category["id"],
            [third["id"], first["id"], second["id"]],
        )
        self.assertTrue(changed)
        self.assertEqual(revision, before_revision + 1)
        library = self.store.list_library()
        self.assertEqual(
            [entry["id"] for entry in library["cards"] if entry["category_id"] == category["id"]],
            [third["id"], first["id"], second["id"]],
        )
        self.assertEqual(
            [entry["id"] for entry in library["cards"] if entry["category_id"] == other_category["id"]],
            [other["id"]],
        )
        unchanged, same_revision = self.store.reorder_cards(
            category["id"],
            [third["id"], first["id"], second["id"]],
        )
        self.assertFalse(unchanged)
        self.assertEqual(same_revision, revision)

    def test_card_reorder_rejects_incomplete_duplicate_and_cross_category_ids(self):
        _primary, category = self.create_branch("人物", "角色")
        _other_primary, other_category = self.create_branch("场景", "室内")
        first, _revision = self.store.create_card(category["id"], snapshot("one"))
        second, _revision = self.store.create_card(category["id"], snapshot("two"))
        other, _revision = self.store.create_card(other_category["id"], snapshot("other"))
        before = Path(self.path).read_bytes()

        for invalid in (
            [first["id"]],
            [first["id"], first["id"]],
            [first["id"], other["id"]],
            "not-an-array",
        ):
            with self.subTest(invalid=invalid):
                with self.assertRaises(PromptCardLibraryValidationError):
                    self.store.reorder_cards(category["id"], invalid)
                self.assertEqual(Path(self.path).read_bytes(), before)

    def test_card_position_moves_between_categories_at_exact_target_index(self):
        _primary, source = self.create_branch("人物", "角色")
        _other_primary, target = self.create_branch("服装", "上衣")
        moving, _revision = self.store.create_card(source["id"], snapshot("moving"))
        first, _revision = self.store.create_card(target["id"], snapshot("first"))
        second, before_revision = self.store.create_card(target["id"], snapshot("second"))

        changed, positioned, revision = self.store.position_card(
            moving["id"], target["id"], 1
        )
        self.assertTrue(changed)
        self.assertEqual(revision, before_revision + 1)
        self.assertEqual(positioned["category_id"], target["id"])
        self.assertEqual(
            [
                entry["id"]
                for entry in self.store.list_library()["cards"]
                if entry["category_id"] == target["id"]
            ],
            [first["id"], moving["id"], second["id"]],
        )
        self.assertEqual(
            [
                entry["id"]
                for entry in self.store.list_library()["cards"]
                if entry["category_id"] == source["id"]
            ],
            [],
        )

    def test_card_position_supports_same_category_noop_and_validates_index(self):
        _primary, category = self.create_branch("人物", "角色")
        first, _revision = self.store.create_card(category["id"], snapshot("first"))
        second, revision = self.store.create_card(category["id"], snapshot("second"))
        before = Path(self.path).read_bytes()

        changed, positioned, same_revision = self.store.position_card(
            second["id"], category["id"], 1
        )
        self.assertFalse(changed)
        self.assertEqual(positioned["id"], second["id"])
        self.assertEqual(same_revision, revision)
        self.assertEqual(Path(self.path).read_bytes(), before)

        for invalid in (-1, 3, 1.5, True):
            with self.subTest(index=invalid):
                with self.assertRaises(PromptCardLibraryValidationError):
                    self.store.position_card(first["id"], category["id"], invalid)
                self.assertEqual(Path(self.path).read_bytes(), before)

    def test_corrupt_store_is_not_replaced(self):
        Path(self.path).parent.mkdir(parents=True)
        Path(self.path).write_text("{not-json", encoding="utf-8")
        before = Path(self.path).read_bytes()
        with self.assertRaises(PromptCardLibraryCorruptError):
            self.store.list_library()
        self.assertEqual(Path(self.path).read_bytes(), before)

    def test_concurrent_creates_are_serialized_and_leave_no_temporary_files(self):
        _primary, secondary = self.create_branch()
        with ThreadPoolExecutor(max_workers=8) as executor:
            cards = list(executor.map(
                lambda index: self.store.create_card(secondary["id"], snapshot(str(index)))[0],
                range(40),
            ))
        library = self.store.list_library()
        self.assertEqual(len(cards), 40)
        self.assertEqual(len(library["cards"]), 40)
        self.assertEqual(len({card["id"] for card in library["cards"]}), 40)
        self.assertEqual(
            [path.name for path in Path(self.path).parent.iterdir()],
            [Path(self.path).name],
        )

    def test_capacity_failures_do_not_modify_the_store(self):
        self.store.create_category("first")
        before = Path(self.path).read_bytes()
        with mock.patch.object(library_module, "MAX_PRIMARY_CATEGORIES", 1):
            with self.assertRaises(PromptCardLibraryCapacityError):
                self.store.create_category("second")
        self.assertEqual(Path(self.path).read_bytes(), before)

    def test_normalization_rejects_invalid_depth_and_card_category(self):
        primary, child = self.create_branch()
        raw = self.store.list_library()
        raw["categories"].append({
            "id": "10000000-0000-4000-8000-000000000001",
            "parent_id": child["id"],
            "name": "third level",
            "created_at": raw["categories"][0]["created_at"],
            "updated_at": raw["categories"][0]["updated_at"],
        })
        Path(self.path).write_text(json.dumps(raw), encoding="utf-8")
        with self.assertRaises(PromptCardLibraryCorruptError):
            self.store.list_library()


if __name__ == "__main__":
    unittest.main()
