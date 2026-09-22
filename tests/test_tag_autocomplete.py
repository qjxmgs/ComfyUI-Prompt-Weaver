import asyncio
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from contextlib import closing
from unittest.mock import patch

from tag_autocomplete import (
    TagAutocompleteStore, TagAutocompleteValidationError, TagAutocompleteUnavailableError,
    TagAutocompleteCapacityError, SUPPLEMENT_SOURCE_ID, validate_min_post_count,
    _validate_sqlite_dataset, validate_manifest, normalize_locale,
)

ROOT = Path(__file__).resolve().parents[1]


def database(path, rows):
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("CREATE TABLE tags (name TEXT PRIMARY KEY, category INTEGER, cn_name TEXT, post_count INTEGER)")
        connection.executemany("INSERT INTO tags VALUES (?, ?, ?, ?)", rows)
        connection.commit()


class TagAutocompleteStoreTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.manifest = json.loads((ROOT / "data/tag_sources.json").read_text())
        self.manifest["sources"][SUPPLEMENT_SOURCE_ID]["min_rows"] = 1
        self.manifest_path = self.root / "manifest.json"
        self.manifest_path.write_text(json.dumps(self.manifest))
        self.store = TagAutocompleteStore(self.root / "user/metadata.json", self.manifest_path)
        self.store.root.mkdir()
        self.rows = [
            ("blue_eyes", 0, "蓝眼", 1000),
            ("blue_hair", 0, "蓝发", 100),
            ("blue_sky", 0, "蓝天", 99),
            ("rare_tag", 0, "罕见", 10),
            ("char_(series)", 4, "角色", 500),
            ("Mixed Case", 0, "大小写", 200),
        ]
        database(self.store._path("downloaded"), self.rows)

    def local(self, rows=None):
        database(self.store._path("local"), rows or [("local_tag", 0, "本地", 100)])

    def test_counts_inclusive_default_minimum_and_empty(self):
        for value, count in [(10, 6), (99, 5), (100, 4), (500, 2), (1000, 1), (1001, 0)]:
            status = self.store.status("zh", value)
            self.assertEqual((status["active_count"], status["total_count"], status["min_post_count"]), (count, 6, value))
        self.assertEqual(self.store.status()["active_count"], 4)
        self.assertEqual(self.store._candidates, {})

    def test_invalid_thresholds(self):
        for value in [None, "", 9, -1, True, 100.5, "1e2", "100.0", {}, 2**53]:
            with self.subTest(value=value), self.assertRaises(TagAutocompleteValidationError):
                self.store.status(min_post_count=value)
            with self.assertRaises(TagAutocompleteValidationError):
                self.store.search("blue", min_post_count=value)
        self.assertEqual(validate_min_post_count("10"), 10)

    def test_threshold_search_and_low_frequency_resolution(self):
        self.assertEqual([r["tag"] for r in self.store.search("blue", "zh", 2)], ["blue_eyes", "blue_hair"])
        self.assertNotIn("blue_sky", [r["tag"] for r in self.store.search("blue", "zh")])
        self.assertIn("blue_sky", [r["tag"] for r in self.store.search("blue", "zh", min_post_count=10)])
        self.assertEqual(self.store.resolve(["rare tag"])[0]["translation"], "罕见")
        self.assertIsNone(self.store.resolve(["not_installed"])[0])

    def test_normalization_chinese_fuzzy_and_order(self):
        self.assertEqual(self.store.search("BLUE EYES")[0]["tag"], "blue_eyes")
        self.assertEqual(self.store.search("蓝发", "zh")[0]["tag"], "blue_hair")
        self.assertEqual(self.store.resolve(["char \\(series\\)", "mixed_case"])[0]["tag"], "char_(series)")
        self.assertEqual(self.store.resolve(["mixed_case"])[0]["tag"], "Mixed Case")
        self.assertEqual(self.store.search("bleys", "zh")[0]["match_rank"], 3)
        self.assertEqual(self.store.search("blue", "en")[0]["translation"], "")
        self.assertEqual(normalize_locale("zh-TW"), "en")

    def test_fuzzy_only_if_direct_results_insufficient(self):
        with patch("tag_autocomplete._ordered_subsequence_score_compact", side_effect=AssertionError("not needed")):
            self.assertEqual(len(self.store.search("blue", limit=2)), 2)

    def test_lru_two_candidate_sets_status_does_not_build(self):
        for threshold in [10, 100, 500]:
            self.store.search("blue", min_post_count=threshold)
        self.assertEqual([key[1] for key in self.store._candidates], [100, 500])
        before = list(self.store._candidates.values())
        for threshold in [10, 100, 999]:
            self.store.status(min_post_count=threshold)
        self.assertEqual(list(self.store._candidates.values()), before)

    def test_read_only_migration_prefers_local_and_ignores_csv(self):
        self.local()
        (self.store.root / "danbooru.base.csv").write_text("invalid")
        before = sorted(path.name for path in self.store.root.iterdir())
        self.assertEqual(self.store.status()["selected_source"], "local")
        self.assertEqual(self.store.search("local")[0]["tag"], "local_tag")
        self.assertEqual(sorted(path.name for path in self.store.root.iterdir()), before)
        self.assertFalse(self.store.metadata_path.exists())

    def test_invalid_legacy_local_uses_existing_download(self):
        self.store._path("local").write_bytes(b"broken")
        self.assertEqual(self.store.status()["selected_source"], "downloaded")
        self.assertTrue(self.store.status()["sources"]["local"]["error"])

    def test_explicit_source_no_fallback_and_persists(self):
        self.local()
        self.store.select_source("downloaded")
        self.assertEqual(self.store.status()["selected_source"], "downloaded")
        self.store.select_source("local")
        self.store._path("local").write_bytes(b"broken")
        self.assertFalse(self.store.status()["available"])
        self.assertEqual(self.store.status()["selected_source"], "local")
        with self.assertRaises(TagAutocompleteUnavailableError):
            self.store.search("blue")
        with self.assertRaises(TagAutocompleteValidationError):
            self.store.select_source("base")

    def test_switch_failure_preserves_selection(self):
        self.store.select_source("downloaded")
        with self.assertRaises(TagAutocompleteUnavailableError):
            self.store.select_source("local")
        self.assertEqual(self.store.status()["selected_source"], "downloaded")

    def test_import_small_library_and_source_invalidation(self):
        self.store.search("blue")
        incoming = self.root / "upload"
        database(incoming, [("only_tag", 0, "唯一", 10)])
        self.store.begin_local_import()
        try:
            self.store.install_local_supplement(incoming)
        finally:
            self.store.finish_local_import()
        self.assertEqual(self.store.status()["selected_source"], "local")
        self.assertEqual(self.store.status()["active_count"], 0)
        self.assertEqual(self.store.resolve(["only_tag"])[0]["translation"], "唯一")
        self.assertEqual(len(self.store._candidates), 0)

    def test_bad_import_preserves_bytes_and_metadata(self):
        self.local()
        self.store.select_source("local")
        before = self.store._path("local").read_bytes(), self.store.metadata_path.read_bytes()
        for content in [b"", b"broken"]:
            incoming = self.root / "upload"
            incoming.write_bytes(content)
            with self.assertRaises((TagAutocompleteValidationError, TagAutocompleteCapacityError)):
                self.store.install_local_supplement(incoming)
            self.assertEqual((self.store._path("local").read_bytes(), self.store.metadata_path.read_bytes()), before)

    def test_metadata_write_failure_rolls_back_file(self):
        self.local()
        self.store.select_source("local")
        before = self.store._path("local").read_bytes(), self.store.metadata_path.read_bytes()
        incoming = self.root / "upload"
        database(incoming, [("new_tag", 0, "新的", 100)])
        with patch.object(self.store, "_write_metadata", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.store.install_local_supplement(incoming)
        self.assertEqual((self.store._path("local").read_bytes(), self.store.metadata_path.read_bytes()), before)

    def test_size_limit_and_invalid_rows(self):
        incoming = self.root / "upload"
        incoming.write_bytes(b"x" * 20)
        with patch("tag_autocomplete.MAX_SQLITE_DATASET_BYTES", 10):
            with self.assertRaises(TagAutocompleteCapacityError):
                self.store.install_local_supplement(incoming)
        for count in [9, 10.5]:
            incoming.unlink()
            database(incoming, [("bad", 0, "无效", count)])
            with self.assertRaises(TagAutocompleteValidationError):
                _validate_sqlite_dataset(incoming, {"min_rows": 1})

    def test_rescan_invalidates_same_source(self):
        self.local()
        self.store.select_source("local")
        revision = self.store.status()["source_revision"]
        self.store.search("local")
        with closing(sqlite3.connect(self.store._path("local"))) as connection:
            connection.execute("INSERT INTO tags VALUES ('second', 0, '第二', 500)")
            connection.commit()
        self.store.rescan_local_supplement()
        self.assertEqual(self.store.status()["active_count"], 2)
        self.assertNotEqual(self.store.status()["source_revision"], revision)

    def test_user_isolation_and_cancelled_search(self):
        other = TagAutocompleteStore(self.root / "other/metadata.json", self.manifest_path)
        self.assertFalse(other.status()["available"])
        self.assertFalse(other.root.exists())
        self.assertEqual(self.store.search("blue", cancelled=lambda: True), [])
        self.assertEqual(self.store._candidates, {})

    def test_busy_operation_rejects_switch(self):
        self.store.begin_local_import()
        try:
            with self.assertRaises(TagAutocompleteUnavailableError):
                self.store.select_source("downloaded")
        finally:
            self.store.finish_local_import()

    def test_invalid_resolution_and_limits(self):
        for tags in [None, ["x"] * 257, [True], ["x" * 129]]:
            with self.assertRaises(TagAutocompleteValidationError):
                self.store.resolve(tags)
        for limit in [0, 101, True, "x"]:
            with self.assertRaises(TagAutocompleteValidationError):
                self.store.search("blue", limit=limit)

    def mock_remote(self, *, corrupt=False, fail=False):
        content = self.store._path("downloaded").read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        blob = hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest()
        async def fetch(url, **kwargs):
            self.assertIn("api.github.com/repos/ffdkj/", url)
            return 200, json.dumps({"type": "file", "path": "tag.sqlite", "size": len(content),
                "sha": blob, "download_url": f"https://raw.githubusercontent.com/{self.manifest['sources'][SUPPLEMENT_SOURCE_ID]['repository']}/main/tag.sqlite"}).encode(), {"ETag": "fixture"}
        async def fetch_file(url, path, **kwargs):
            if fail:
                raise TagAutocompleteUnavailableError("offline")
            Path(path).write_bytes(b"x" * len(content) if corrupt else content)
            return 200, {"sha256": digest}, {}
        self.store.fetcher = fetch
        self.store.file_fetcher = fetch_file

    async def test_download_hash_metadata_and_local_selection_preserved(self):
        self.local()
        self.mock_remote()
        await self.store.update()
        self.assertEqual(self.store.status()["selected_source"], "local")
        metadata = json.loads(self.store.metadata_path.read_text())
        self.assertEqual(metadata["sources"][SUPPLEMENT_SOURCE_ID]["license"], "MIT")
        self.assertEqual(len(metadata["sources"][SUPPLEMENT_SOURCE_ID]["sha256"]), 64)

    async def test_failed_download_and_hash_keep_previous(self):
        for kwargs in [{"corrupt": True}, {"fail": True}]:
            self.mock_remote(**kwargs)
            before = self.store._path("downloaded").read_bytes()
            with self.assertRaises((TagAutocompleteValidationError, TagAutocompleteUnavailableError)):
                await self.store.update()
            self.assertEqual(self.store._path("downloaded").read_bytes(), before)
            self.assertFalse(self.store._local_import_lock.locked())

    async def test_remote_requires_full_row_policy_but_local_accepts_one(self):
        self.manifest["sources"][SUPPLEMENT_SOURCE_ID]["min_rows"] = 300000
        self.manifest_path.write_text(json.dumps(self.manifest))
        self.mock_remote()
        with self.assertRaises(TagAutocompleteValidationError):
            await self.store.update()
        incoming = self.root / "upload"
        database(incoming, [("one", 0, "一", 100)])
        self.store.install_local_supplement(incoming)
        self.assertEqual(self.store.status()["total_count"], 1)

    async def test_unchanged_download_uses_etag_without_file_fetch(self):
        self.mock_remote()
        await self.store.update()
        async def unchanged(url, **kwargs):
            self.assertEqual(kwargs["headers"]["If-None-Match"], "fixture")
            return 304, b"", {}
        self.store.fetcher = unchanged
        async def forbidden(*args, **kwargs):
            self.fail("unchanged dictionary should not download")
        self.store.file_fetcher = forbidden
        await self.store.update()
        self.assertTrue(self.store.status()["available"])

    def test_manifest_single_licensed_sqlite(self):
        manifest = validate_manifest(json.loads((ROOT / "data/tag_sources.json").read_text()))
        self.assertEqual(list(manifest["sources"]), [SUPPLEMENT_SOURCE_ID])
        self.assertEqual(manifest["sources"][SUPPLEMENT_SOURCE_ID]["license"], "MIT")

    def test_status_reuses_histogram_without_reopening_sqlite(self):
        self.store.status()
        with patch("tag_autocomplete._connect", side_effect=AssertionError("cached counts must not query SQLite")):
            self.assertEqual(self.store.status(min_post_count=100)["active_count"], 4)
            self.assertEqual(self.store.status(min_post_count=10)["active_count"], 6)

    def test_source_change_during_search_discards_old_results(self):
        self.local()
        self.store.select_source("downloaded")
        calls = 0
        def switch_during_scan():
            nonlocal calls
            calls += 1
            if calls == 3:
                self.store.select_source("local")
            return False
        self.assertEqual(self.store.search("blue", cancelled=switch_during_scan), [])
        self.assertEqual(self.store.status()["selected_source"], "local")

    def test_precancelled_and_midscan_cancelled_work_never_returns_results(self):
        calls = 0
        def cancel():
            nonlocal calls
            calls += 1
            return calls >= 3
        self.assertEqual(self.store.search("blue", cancelled=cancel), [])

    def test_unicode_and_escaped_names_resolve_without_loading_candidates(self):
        self.local([("Éclair", 0, "甜点", 10), ("Ｆｕｌｌ", 0, "全角", 10)])
        self.assertEqual([row["translation"] for row in self.store.resolve(["éclair", "full"])], ["甜点", "全角"])
        self.assertEqual(self.store._candidates, {})

    def test_invalid_schema_blob_and_empty_dictionary_are_rejected(self):
        incoming = self.root / "bad.sqlite"
        for rows in [[], [("blob", 0, b"not text", 100)], [("bad_category", 99, "无效", 100)]]:
            database(incoming, rows)
            with self.assertRaises(TagAutocompleteValidationError):
                self.store.install_local_supplement(incoming)
            incoming.unlink()
        with closing(sqlite3.connect(incoming)) as connection:
            connection.execute("CREATE TABLE tags(name TEXT, cn_name TEXT)")
            connection.commit()
        with self.assertRaises(TagAutocompleteValidationError):
            self.store.install_local_supplement(incoming)


if __name__ == "__main__":
    unittest.main()
