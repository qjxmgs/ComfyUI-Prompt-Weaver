import asyncio
import csv
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from tag_autocomplete import (
    LOCAL_SUPPLEMENT_DROP_IN_PATH,
    SUPPLEMENT_REPOSITORY,
    SUPPLEMENT_REF,
    SUPPLEMENT_REMOTE_PATH,
    TagAutocompleteStore,
    TagAutocompleteCapacityError,
    TagAutocompleteUnavailableError,
    TagAutocompleteValidationError,
    _validate_sqlite_dataset,
    normalize_locale,
    validate_manifest,
)


def base_csv(rows):
    output = ["tag,category,count,alias\n"]
    for tag, category, count, aliases in rows:
        escaped_aliases = aliases.replace('"', '""')
        output.append(f'{tag},{category},{count},"{escaped_aliases}"\n')
    return "".join(output).encode("utf-8")


def translation_csv(rows):
    from io import StringIO

    buffer = StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerows(rows)
    return buffer.getvalue().encode("utf-8")


def supplement_sqlite(rows, *, invalid_schema=False):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "tag.sqlite"
        connection = sqlite3.connect(path)
        try:
            if invalid_schema:
                connection.execute("CREATE TABLE tags (name TEXT PRIMARY KEY, cn_name TEXT)")
                connection.executemany(
                    "INSERT INTO tags (name, cn_name) VALUES (?, ?)",
                    [(name, translation) for name, _category, translation, _count in rows],
                )
            else:
                connection.execute(
                    """
                    CREATE TABLE tags (
                        name TEXT PRIMARY KEY,
                        category INTEGER,
                        cn_name TEXT,
                        post_count INTEGER
                    )
                    """
                )
                connection.executemany(
                    "INSERT INTO tags (name, category, cn_name, post_count) VALUES (?, ?, ?, ?)",
                    rows,
                )
            connection.commit()
        finally:
            connection.close()
        return path.read_bytes()


def source(filename, source_format, payload, minimum_rows=1):
    return {
        "filename": filename,
        "format": source_format,
        "url": f"https://raw.githubusercontent.com/example/project/commit/{filename}",
        "sha256": hashlib.sha256(payload).hexdigest(),
        "size_bytes": len(payload),
        "min_rows": minimum_rows,
        "license": "MIT",
        "attribution": "example/project",
        "source_page": "https://github.com/example/project",
    }


def supplement_source(payload, *, enabled=True, license_status="cleared", minimum_rows=1):
    return {
        "filename": "danbooru.zh-CN.supplement.sqlite",
        "format": "tag_translation_sqlite_v1",
        "enabled": enabled,
        "license_status": license_status,
        "repository": SUPPLEMENT_REPOSITORY,
        "ref": SUPPLEMENT_REF,
        "path": SUPPLEMENT_REMOTE_PATH,
        "api_url": (
            "https://api.github.com/repos/"
            f"{SUPPLEMENT_REPOSITORY}/contents/{SUPPLEMENT_REMOTE_PATH}?ref={SUPPLEMENT_REF}"
        ),
        "max_size_bytes": max(len(payload) + 1, 1024),
        "min_rows": minimum_rows,
        "license": "Test license",
        "attribution": "test supplement",
        "source_page": f"https://github.com/{SUPPLEMENT_REPOSITORY}",
    }


def manifest(base_payload, zh_payload, version="test-1", supplement_payload=None):
    payload = {
        "schema_version": 1,
        "version": version,
        "published_at": "2026-08-13T00:00:00Z",
        "content_scope": "full",
        "sources": {
            "base": source("danbooru.base.csv", "danbooru_tag_csv_v1", base_payload),
            "zh-CN": source("danbooru.zh-CN.csv", "tag_translation_csv_v1", zh_payload),
        },
    }
    if supplement_payload is not None:
        payload["sources"]["zh-CN-supplement"] = supplement_source(supplement_payload)
    return payload


class TagAutocompleteStoreTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.base_payload = base_csv([
            ("blue_eyes", 0, 1409152, "azure_eyes"),
            ("blue_hair", 0, 676176, ""),
            ("blush", 0, 2535113, "red_face"),
            ("blue_archive", 3, 267200, "BA"),
        ])
        self.zh_payload = translation_csv([
            ("blue_eyes", "蓝眼睛"),
            ("blue_hair", "蓝发"),
            ("blush", "脸红"),
        ])
        self.manifest = manifest(self.base_payload, self.zh_payload)
        self.manifest_path = self.root / "tag_sources.json"
        self.manifest_path.write_text(
            json.dumps(self.manifest, ensure_ascii=False),
            encoding="utf-8",
        )
        self.calls = []
        self.file_calls = []
        self.supplement_payload = None
        self.supplement_blob_sha = "a" * 40
        self.supplement_api_not_modified = False

        async def fetcher(url, *, headers=None, maximum_bytes=None):
            self.calls.append((url, dict(headers or {}), maximum_bytes))
            if url == "https://manifest.example/tag_sources.json":
                return 200, json.dumps(self.manifest).encode("utf-8"), {"ETag": '"manifest"'}
            for source_id, payload in (("base", self.base_payload), ("zh-CN", self.zh_payload)):
                if url == self.manifest["sources"][source_id]["url"]:
                    return 200, payload, {"ETag": f'"{source_id}"'}
            supplement_api_url = (
                "https://api.github.com/repos/"
                f"{SUPPLEMENT_REPOSITORY}/contents/{SUPPLEMENT_REMOTE_PATH}?ref={SUPPLEMENT_REF}"
            )
            if self.supplement_payload is not None and url == supplement_api_url:
                if self.supplement_api_not_modified and headers and headers.get("If-None-Match"):
                    return 304, b"", {"ETag": '"supplement"'}
                metadata = {
                    "type": "file",
                    "name": SUPPLEMENT_REMOTE_PATH,
                    "path": SUPPLEMENT_REMOTE_PATH,
                    "sha": self.supplement_blob_sha,
                    "size": len(self.supplement_payload),
                    "download_url": (
                        "https://raw.githubusercontent.com/"
                        f"{SUPPLEMENT_REPOSITORY}/{SUPPLEMENT_REF}/{SUPPLEMENT_REMOTE_PATH}"
                    ),
                }
                return 200, json.dumps(metadata).encode("utf-8"), {"ETag": '"supplement"'}
            raise AssertionError(f"unexpected URL {url}")

        async def file_fetcher(url, destination, *, headers=None, maximum_bytes=None):
            self.file_calls.append((url, dict(headers or {}), maximum_bytes))
            if len(self.supplement_payload) > maximum_bytes:
                raise TagAutocompleteValidationError("download is too large")
            Path(destination).write_bytes(self.supplement_payload)
            return 200, {
                "size_bytes": len(self.supplement_payload),
                "sha256": hashlib.sha256(self.supplement_payload).hexdigest(),
            }, {"ETag": '"sqlite"'}

        self.fetcher = fetcher
        self.file_fetcher = file_fetcher
        self.store = TagAutocompleteStore(
            self.root / "user" / "metadata.json",
            self.manifest_path,
            remote_manifest_url="https://manifest.example/tag_sources.json",
            fetcher=fetcher,
            file_fetcher=file_fetcher,
            now=lambda: 1_700_000_000,
        )

    def set_supplement_manifest(self, payload):
        self.manifest = payload
        self.manifest_path.write_text(
            json.dumps(payload, ensure_ascii=False),
            encoding="utf-8",
        )

    def tearDown(self):
        self.temporary.cleanup()

    async def test_first_download_installs_both_sources_and_searches_chinese(self):
        self.assertTrue(self.store.status("zh-CN")["needs_download"])
        status = await self.store.update("zh-CN")
        self.assertTrue(status["ready"])
        self.assertTrue(status["primary_translation_available"])
        self.assertEqual(status["row_count"], 4)
        self.assertEqual(status["primary_translation_count"], 3)
        self.assertEqual(status["translated_tag_count"], 3)
        self.assertEqual(status["translation_coverage_percent"], 75.0)
        self.assertTrue((self.root / "user" / "danbooru.base.csv").is_file())
        self.assertTrue((self.root / "user" / "danbooru.zh-CN.csv").is_file())

        english = self.store.search("bl", "en", 12)
        self.assertEqual(
            [record["tag"] for record in english],
            ["blush", "blue_eyes", "blue_hair", "blue_archive"],
        )
        self.assertEqual(english[1]["insert_text"], "blue eyes")
        self.assertNotEqual(english[0]["tag"], "blue_archive")
        chinese = self.store.search("蓝", "zh-CN", 12)
        self.assertEqual([record["tag"] for record in chinese], ["blue_eyes", "blue_hair"])
        self.assertEqual(chinese[0]["translation"], "蓝眼睛")

        resolved = self.store.resolve(
            ["blue eyes", "blue_eyes", "azure eyes", "blue", "blue archive"],
            "zh-CN",
        )
        self.assertEqual([record["tag"] for record in resolved[:3]], ["blue_eyes"] * 3)
        self.assertEqual(resolved[0]["translation"], "蓝眼睛")
        self.assertIsNone(resolved[3])
        self.assertEqual(resolved[4]["translation"], "")

    async def test_exact_resolve_preserves_input_order_and_rejects_invalid_values(self):
        await self.store.update("zh-CN")
        resolved = self.store.resolve(["blush", "missing", "red face"], "zh-CN")
        self.assertEqual(resolved[0]["tag"], "blush")
        self.assertIsNone(resolved[1])
        self.assertEqual(resolved[2]["tag"], "blush")
        with self.assertRaisesRegex(TagAutocompleteValidationError, "must be an array"):
            self.store.resolve("blush", "zh-CN")
        with self.assertRaisesRegex(TagAutocompleteValidationError, "must be strings"):
            self.store.resolve([123], "zh-CN")

    async def test_escaped_parentheses_match_danbooru_character_tags(self):
        self.base_payload = base_csv([
            ("karin_(blue_archive)", 4, 159, ""),
            ("karin_(bunny)_(blue_archive)", 4, 115, ""),
        ])
        self.zh_payload = translation_csv([
            ("karin_(blue_archive)", "卡琳（蔚蓝档案）"),
            ("karin_(bunny)_(blue_archive)", "卡琳（兔女郎）（蔚蓝档案）"),
        ])
        self.manifest = manifest(self.base_payload, self.zh_payload, version="test-escaped-parentheses")
        await self.store.update("zh-CN")

        escaped_query = r"karin \(blue archive\)"
        results = self.store.search(escaped_query, "zh-CN", 20)
        self.assertEqual(results[0]["tag"], "karin_(blue_archive)")
        self.assertEqual(results[0]["match_rank"], 0)

        resolved = self.store.resolve([
            r"karin \(blue archive\)",
            r"karin \(bunny\) \(blue archive\)",
        ], "zh-CN")
        self.assertEqual(
            [record["translation"] for record in resolved],
            ["卡琳（蔚蓝档案）", "卡琳（兔女郎）（蔚蓝档案）"],
        )

    async def test_search_defaults_to_thirty_results(self):
        self.base_payload = base_csv([
            (f"test_tag_{index:02d}", 0, 10_000 - index, "")
            for index in range(35)
        ])
        self.manifest = manifest(self.base_payload, self.zh_payload, version="test-30-limit")
        await self.store.update("en")

        results = self.store.search("test", "en")
        self.assertEqual(len(results), 30)
        self.assertEqual(results[0]["tag"], "test_tag_00")
        self.assertEqual(results[-1]["tag"], "test_tag_29")
        self.assertEqual(len(self.store.search("test", "en", 100)), 35)
        with self.assertRaises(TagAutocompleteValidationError):
            self.store.search("test", "en", 101)

    async def test_character_skip_fuzzy_matching_ranks_after_contiguous_matches(self):
        self.base_payload = base_csv([
            ("bleyes", 0, 1, ""),
            ("bleyes_style", 0, 2, ""),
            ("super_bleyes_tag", 0, 3, ""),
            ("blue_eyes", 0, 9_000_000, ""),
            ("black_eyes", 0, 8_000_000, ""),
            ("black_pantyhose", 0, 7_000_000, ""),
            ("yaoi", 0, 99_000_000, "bl"),
        ])
        self.zh_payload = translation_csv([
            ("blue_eyes", "蓝眼睛"),
            ("black_eyes", "黑眼睛"),
            ("black_pantyhose", "黑色连裤袜"),
        ])
        self.manifest = manifest(self.base_payload, self.zh_payload, version="test-fuzzy")
        await self.store.update("zh-CN")

        english = self.store.search("bleyes", "zh-CN", 20)
        self.assertEqual(
            [record["tag"] for record in english[:5]],
            ["bleyes", "bleyes_style", "super_bleyes_tag", "blue_eyes", "black_eyes"],
        )
        self.assertNotIn("match_score", english[0])
        self.assertEqual(english[3]["match_rank"], 3)
        self.assertEqual(
            english[3]["match_score"],
            {"start": 0, "gaps": 2, "length": 8},
        )
        self.assertEqual(self.store.search("blkpnths", "zh-CN", 20)[0]["tag"], "black_pantyhose")
        self.assertEqual(self.store.search("蓝睛", "zh-CN", 20)[0]["tag"], "blue_eyes")
        self.assertEqual(self.store.search("be", "zh-CN", 20), [])
        prefix_results = self.store.search("bl", "zh-CN", 20)
        self.assertNotEqual(prefix_results[0]["tag"], "yaoi")
        yaoi_index = next(
            index for index, record in enumerate(prefix_results) if record["tag"] == "yaoi"
        )
        self.assertTrue(all(
            record["match_rank"] == 1
            for record in prefix_results[:yaoi_index]
        ))

    async def test_failed_refresh_keeps_last_good_files_and_reports_error(self):
        await self.store.update("zh-CN")
        original = (self.root / "user" / "danbooru.base.csv").read_bytes()
        newer = manifest(self.base_payload + b"broken", self.zh_payload, version="test-2")
        self.manifest = newer
        with self.assertRaises(TagAutocompleteValidationError):
            await self.store.update("zh-CN")
        self.assertEqual((self.root / "user" / "danbooru.base.csv").read_bytes(), original)
        self.assertTrue(self.store.status("zh-CN")["available"])
        self.assertTrue(self.store.status("zh-CN")["error"])

    async def test_parallel_update_requests_share_one_task(self):
        first = self.store.start_update("zh-CN")
        second = self.store.start_update("zh-CN")
        self.assertIs(first, second)
        await first
        self.assertEqual(sum(url.endswith("tag_sources.json") for url, _headers, _limit in self.calls), 1)

    async def test_status_is_local_and_never_starts_an_update(self):
        await self.store.update("en")
        self.calls.clear()
        self.file_calls.clear()
        self.assertIsNone(self.store._update_task)
        status = self.store.status("zh-CN")
        self.assertIsNone(self.store._update_task)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.file_calls, [])
        self.assertTrue(status["available"])

    async def test_supplement_only_fills_missing_primary_translations(self):
        self.supplement_payload = supplement_sqlite([
            ("blue_eyes", 0, "碧蓝眼眸", 1_500_000),
            ("blue_archive", 3, "蔚蓝档案", 300_000),
            ("outside_dictionary", 0, "库外标签", 100),
        ])
        self.set_supplement_manifest(manifest(
            self.base_payload,
            self.zh_payload,
            version="test-supplement-1",
            supplement_payload=self.supplement_payload,
        ))

        status = await self.store.update("zh-CN")

        self.assertTrue(status["ready"])
        self.assertTrue(status["supplement_enabled"])
        self.assertTrue(status["supplement_available"])
        self.assertEqual(status["supplement_translation_count"], 1)
        self.assertEqual(status["primary_translation_count"], 3)
        self.assertEqual(status["translated_tag_count"], 4)
        self.assertEqual(status["translation_coverage_percent"], 100.0)
        self.assertEqual(status["supplement_blob_sha"], "a" * 40)
        self.assertEqual(status["supplement_license_status"], "cleared")
        self.assertEqual(
            status["supplement_source_page"],
            f"https://github.com/{SUPPLEMENT_REPOSITORY}",
        )
        self.assertTrue(
            (self.root / "user" / "danbooru.zh-CN.supplement.sqlite").is_file()
        )
        self.assertEqual(
            self.store.resolve(["blue eyes"], "zh-CN")[0]["translation"],
            "蓝眼睛",
        )
        self.assertEqual(
            self.store.search("蔚蓝", "zh-CN", 20)[0]["tag"],
            "blue_archive",
        )
        self.assertEqual(self.store.search("库外", "zh-CN", 20), [])
        self.assertEqual(len(self.file_calls), 1)

        self.supplement_api_not_modified = True
        unchanged = await self.store.update("zh-CN")
        self.assertEqual(len(self.file_calls), 1)
        self.assertEqual(unchanged["supplement_translation_count"], 1)

    async def test_drop_in_sqlite_is_auto_detected_preferred_and_skips_remote_download(self):
        self.supplement_payload = supplement_sqlite([
            ("blue_eyes", 0, "不应覆盖主翻译", 1_500_000),
            ("blue_archive", 3, "蔚蓝档案", 300_000),
            ("outside_dictionary", 0, "库外标签", 100),
        ])
        self.set_supplement_manifest(manifest(
            self.base_payload,
            self.zh_payload,
            version="test-local-drop-in",
            supplement_payload=self.supplement_payload,
        ))
        local_path = self.root / "user" / "tag.sqlite"
        local_path.parent.mkdir(parents=True, exist_ok=True)
        local_path.write_bytes(self.supplement_payload)

        status = await self.store.update("zh-CN")

        self.assertEqual(status["supplement_origin"], "local")
        self.assertEqual(
            status["supplement_drop_in_path"],
            LOCAL_SUPPLEMENT_DROP_IN_PATH,
        )
        self.assertEqual(status["supplement_row_count"], 3)
        self.assertEqual(len(status["supplement_file_sha256"]), 64)
        self.assertTrue(status["supplement_file_modified_at"])
        self.assertEqual(status["supplement_translation_count"], 1)
        self.assertEqual(status["primary_translation_count"], 3)
        self.assertEqual(status["translated_tag_count"], 4)
        self.assertEqual(self.file_calls, [])
        self.assertFalse(any(
            url == self.manifest["sources"]["zh-CN-supplement"]["api_url"]
            for url, _headers, _limit in self.calls
        ))
        self.assertEqual(
            self.store.resolve(["blue eyes"], "zh-CN")[0]["translation"],
            "蓝眼睛",
        )
        self.assertEqual(
            self.store.resolve(["blue archive"], "zh-CN")[0]["translation"],
            "蔚蓝档案",
        )
        self.assertEqual(self.store.search("库外", "zh-CN", 20), [])

    async def test_invalid_drop_in_file_warns_and_falls_back_to_downloaded_supplement(self):
        self.supplement_payload = supplement_sqlite([
            ("blue_archive", 3, "远程补充翻译", 300_000),
        ])
        self.set_supplement_manifest(manifest(
            self.base_payload,
            self.zh_payload,
            version="test-local-fallback",
            supplement_payload=self.supplement_payload,
        ))
        await self.store.update("zh-CN")
        (self.root / "user" / "tag.sqlite").write_bytes(b"broken")

        status = self.store.status("zh-CN")

        self.assertEqual(status["supplement_origin"], "downloaded")
        self.assertTrue(status["supplement_available"])
        self.assertIn("not a SQLite", status["supplement_local_error"])
        self.assertEqual(
            self.store.resolve(["blue archive"], "zh-CN")[0]["translation"],
            "远程补充翻译",
        )

    async def test_replacing_or_removing_drop_in_file_refreshes_active_cache(self):
        first_payload = supplement_sqlite([
            ("blue_archive", 3, "本地翻译一", 300_000),
        ])
        second_payload = supplement_sqlite([
            ("blue_archive", 3, "本地翻译二（更新）", 300_000),
        ])
        self.supplement_payload = first_payload
        self.set_supplement_manifest(manifest(
            self.base_payload,
            self.zh_payload,
            version="test-local-refresh",
            supplement_payload=first_payload,
        ))
        local_path = self.root / "user" / "tag.sqlite"
        local_path.parent.mkdir(parents=True, exist_ok=True)
        local_path.write_bytes(first_payload)
        await self.store.update("zh-CN")
        self.assertEqual(
            self.store.resolve(["blue archive"], "zh-CN")[0]["translation"],
            "本地翻译一",
        )

        local_path.write_bytes(second_payload)
        self.assertEqual(
            self.store.resolve(["blue archive"], "zh-CN")[0]["translation"],
            "本地翻译二（更新）",
        )
        local_path.unlink()
        status = self.store.status("zh-CN")
        self.assertEqual(status["supplement_origin"], "")
        self.assertEqual(
            self.store.resolve(["blue archive"], "zh-CN")[0]["translation"],
            "",
        )

    async def test_local_import_is_atomic_validated_and_blocks_remote_update(self):
        local_path = self.root / "user" / "tag.sqlite"
        local_path.parent.mkdir(parents=True, exist_ok=True)
        original = supplement_sqlite([
            ("blue_archive", 3, "原本地翻译", 300_000),
        ])
        self.set_supplement_manifest(manifest(
            self.base_payload,
            self.zh_payload,
            version="test-local-import",
            supplement_payload=original,
        ))
        local_path.write_bytes(original)
        valid_upload = self.root / "user" / ".valid-upload.tmp"
        valid_upload.write_bytes(supplement_sqlite([
            ("blue_archive", 3, "新本地翻译", 300_000),
        ]))
        self.store.begin_local_import()
        try:
            self.store.install_local_supplement(valid_upload)
        finally:
            self.store.finish_local_import()
        self.assertFalse(valid_upload.exists())
        self.assertEqual(self.store.status("zh-CN")["supplement_origin"], "local")

        invalid_upload = self.root / "user" / ".invalid-upload.tmp"
        invalid_upload.write_bytes(b"broken")
        self.store.begin_local_import()
        try:
            with self.assertRaisesRegex(TagAutocompleteValidationError, "not a SQLite"):
                self.store.install_local_supplement(invalid_upload)
        finally:
            self.store.finish_local_import()
        self.assertNotEqual(local_path.read_bytes(), b"broken")
        invalid_upload.unlink()

        self.store.begin_local_import()
        try:
            with self.assertRaisesRegex(
                TagAutocompleteUnavailableError,
                "import is already running",
            ):
                self.store.start_update("zh-CN")
        finally:
            self.store.finish_local_import()

    async def test_local_import_rejects_oversized_file_before_replacement(self):
        local_path = self.root / "user" / "tag.sqlite"
        local_path.parent.mkdir(parents=True, exist_ok=True)
        original = supplement_sqlite([
            ("blue_archive", 3, "原本地翻译", 300_000),
        ])
        self.set_supplement_manifest(manifest(
            self.base_payload,
            self.zh_payload,
            version="test-local-import-size",
            supplement_payload=original,
        ))
        local_path.write_bytes(original)
        oversized = self.root / "user" / ".oversized-upload.tmp"
        with oversized.open("wb") as handle:
            handle.truncate(64 * 1024 * 1024 + 1)
        with self.assertRaises(TagAutocompleteCapacityError):
            self.store.install_local_supplement(oversized)
        self.assertEqual(local_path.read_bytes(), original)
        oversized.unlink()

    async def test_failed_supplement_refresh_keeps_primary_and_last_good_database(self):
        self.supplement_payload = supplement_sqlite([
            ("blue_archive", 3, "蔚蓝档案", 300_000),
        ])
        self.set_supplement_manifest(manifest(
            self.base_payload,
            self.zh_payload,
            version="test-supplement-good",
            supplement_payload=self.supplement_payload,
        ))
        await self.store.update("zh-CN")
        supplement_path = self.root / "user" / "danbooru.zh-CN.supplement.sqlite"
        original = supplement_path.read_bytes()

        self.supplement_payload = b"not a sqlite database"
        self.supplement_blob_sha = "b" * 40
        self.set_supplement_manifest(manifest(
            self.base_payload,
            self.zh_payload,
            version="test-supplement-broken",
            supplement_payload=self.supplement_payload,
        ))
        status = await self.store.update("zh-CN")

        self.assertTrue(status["ready"])
        self.assertTrue(status["supplement_available"])
        self.assertTrue(status["supplement_error"])
        self.assertEqual(supplement_path.read_bytes(), original)
        self.assertEqual(
            self.store.resolve(["blue archive"], "zh-CN")[0]["translation"],
            "蔚蓝档案",
        )
        self.assertEqual(
            self.store.resolve(["blue eyes"], "zh-CN")[0]["translation"],
            "蓝眼睛",
        )

    async def test_broken_installed_supplement_reports_local_warning_and_keeps_primary_coverage(self):
        self.supplement_payload = supplement_sqlite([
            ("blue_archive", 3, "蔚蓝档案", 300_000),
        ])
        self.set_supplement_manifest(manifest(
            self.base_payload,
            self.zh_payload,
            version="test-supplement-broken-local",
            supplement_payload=self.supplement_payload,
        ))
        await self.store.update("zh-CN")
        supplement_path = self.root / "user" / "danbooru.zh-CN.supplement.sqlite"
        supplement_path.write_bytes(b"not sqlite")
        self.store._coverage_cache_key = None

        status = self.store.status("zh-CN")

        self.assertTrue(status["available"])
        self.assertEqual(status["primary_translation_count"], 3)
        self.assertEqual(status["translated_tag_count"], 3)
        self.assertEqual(status["translation_coverage_percent"], 75.0)
        self.assertIn("could not read Chinese translation supplement", status["supplement_error"])

    async def test_not_modified_metadata_redownloads_a_missing_local_database(self):
        self.supplement_payload = supplement_sqlite([
            ("blue_archive", 3, "蔚蓝档案", 300_000),
        ])
        self.set_supplement_manifest(manifest(
            self.base_payload,
            self.zh_payload,
            version="test-supplement-redownload",
            supplement_payload=self.supplement_payload,
        ))
        await self.store.update("zh-CN")
        supplement_path = self.root / "user" / "danbooru.zh-CN.supplement.sqlite"
        supplement_path.unlink()
        self.supplement_api_not_modified = True

        status = await self.store.update("zh-CN")

        self.assertTrue(status["supplement_available"])
        self.assertTrue(supplement_path.is_file())
        self.assertEqual(len(self.file_calls), 2)

    async def test_repository_change_forces_local_sqlite_replacement(self):
        self.supplement_payload = supplement_sqlite([
            ("blue_archive", 3, "蔚蓝档案", 300_000),
        ])
        self.set_supplement_manifest(manifest(
            self.base_payload,
            self.zh_payload,
            version="test-source-migration",
            supplement_payload=self.supplement_payload,
        ))
        await self.store.update("zh-CN")

        metadata = json.loads(self.store.metadata_path.read_text(encoding="utf-8"))
        installed = metadata["sources"]["zh-CN-supplement"]
        installed["repository"] = "qjxmgs/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table"
        installed["source_page"] = f"https://github.com/{installed['repository']}"
        self.store.metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
        self.file_calls.clear()

        status = await self.store.update("zh-CN")

        self.assertEqual(len(self.file_calls), 1)
        self.assertEqual(status["supplement_license_status"], "cleared")
        refreshed = json.loads(self.store.metadata_path.read_text(encoding="utf-8"))
        self.assertEqual(
            refreshed["sources"]["zh-CN-supplement"]["repository"],
            SUPPLEMENT_REPOSITORY,
        )

    async def test_bundled_supplement_policy_overrides_remote_manifest(self):
        self.supplement_payload = supplement_sqlite([
            ("blue_archive", 3, "蔚蓝档案", 300_000),
        ])
        bundled = manifest(
            self.base_payload,
            self.zh_payload,
            version="test-bundled-policy",
            supplement_payload=self.supplement_payload,
        )
        bundled["sources"]["zh-CN-supplement"]["license_status"] = "user-directed"
        self.manifest_path.write_text(json.dumps(bundled), encoding="utf-8")
        stale_remote_source = supplement_source(self.supplement_payload)
        stale_remote_source["repository"] = (
            "qjxmgs/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table"
        )
        stale_remote_source["api_url"] = (
            "https://api.github.com/repos/"
            f"{stale_remote_source['repository']}/contents/{SUPPLEMENT_REMOTE_PATH}?ref=main"
        )
        self.manifest["sources"]["zh-CN-supplement"] = stale_remote_source

        status = await self.store.update("zh-CN")

        self.assertTrue(status["supplement_enabled"])
        self.assertTrue(status["supplement_available"])
        self.assertEqual(status["supplement_license_status"], "user-directed")
        self.assertEqual(len(self.file_calls), 1)

    async def test_disabled_pending_supplement_is_not_downloaded(self):
        self.supplement_payload = supplement_sqlite([
            ("blue_archive", 3, "蔚蓝档案", 300_000),
        ])
        self.manifest = manifest(self.base_payload, self.zh_payload, version="test-disabled")
        source_payload = supplement_source(
            self.supplement_payload,
            enabled=False,
            license_status="pending",
        )
        self.manifest["sources"]["zh-CN-supplement"] = source_payload
        self.manifest_path.write_text(
            json.dumps(self.manifest, ensure_ascii=False),
            encoding="utf-8",
        )

        status = await self.store.update("zh-CN")

        self.assertFalse(status["supplement_enabled"])
        self.assertFalse(status["supplement_available"])
        self.assertEqual(status["supplement_license_status"], "pending")
        self.assertEqual(status["translated_tag_count"], 3)
        self.assertEqual(status["translation_coverage_percent"], 75.0)
        self.assertEqual(self.file_calls, [])
        self.assertFalse(any(url == source_payload["api_url"] for url, _headers, _limit in self.calls))
        self.assertEqual(self.store.resolve(["blue archive"], "zh-CN")[0]["translation"], "")


class TagAutocompleteValidationTests(unittest.TestCase):
    def test_locale_normalization(self):
        self.assertEqual(normalize_locale("zh_Hans"), "zh-CN")
        self.assertEqual(normalize_locale("zh-CN"), "zh-CN")
        self.assertEqual(normalize_locale("ja"), "en")

    def test_manifest_rejects_untrusted_urls_and_bad_hashes(self):
        base = base_csv([("test", 0, 1, "")])
        zh = translation_csv([("test", "测试")])
        payload = manifest(base, zh)
        payload["sources"]["base"]["url"] = "http://example.com/tags.csv"
        with self.assertRaisesRegex(TagAutocompleteValidationError, "allowed HTTPS"):
            validate_manifest(payload)
        payload = manifest(base, zh)
        payload["sources"]["base"]["sha256"] = "bad"
        with self.assertRaisesRegex(TagAutocompleteValidationError, "SHA-256"):
            validate_manifest(payload)

    def test_manifest_accepts_user_directed_local_use_but_rejects_pending_enablement(self):
        base = base_csv([("test", 0, 1, "")])
        zh = translation_csv([("test", "测试")])
        sqlite_payload = supplement_sqlite([("test", 0, "测试", 10)])
        payload = manifest(base, zh)
        payload["sources"]["zh-CN-supplement"] = supplement_source(
            sqlite_payload,
            enabled=True,
            license_status="user-directed",
        )
        validated = validate_manifest(payload)
        self.assertEqual(
            validated["sources"]["zh-CN-supplement"]["license_status"],
            "user-directed",
        )

        payload["sources"]["zh-CN-supplement"] = supplement_source(
            sqlite_payload,
            enabled=True,
            license_status="pending",
        )
        with self.assertRaisesRegex(TagAutocompleteValidationError, "user-directed use"):
            validate_manifest(payload)

    def test_sqlite_validation_rejects_corruption_schema_and_invalid_rows(self):
        cases = {
            "not a SQLite": b"broken",
            "column is invalid": supplement_sqlite(
                [("test", 0, "测试", 10)],
                invalid_schema=True,
            ),
            "only 1 rows": supplement_sqlite([("test", 0, "测试", 10)]),
            "invalid tag rows": supplement_sqlite([("test", 2, "", 9)]),
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tag.sqlite"
            for expected, sqlite_payload in cases.items():
                with self.subTest(expected=expected):
                    path.write_bytes(sqlite_payload)
                    source_payload = supplement_source(
                        sqlite_payload,
                        minimum_rows=2 if expected == "only 1 rows" else 1,
                    )
                    with self.assertRaisesRegex(TagAutocompleteValidationError, expected):
                        _validate_sqlite_dataset(path, source_payload)


if __name__ == "__main__":
    unittest.main()
