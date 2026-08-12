import asyncio
import csv
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from tag_autocomplete import (
    CHECK_INTERVAL_SECONDS,
    TagAutocompleteStore,
    TagAutocompleteValidationError,
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


def manifest(base_payload, zh_payload, version="test-1"):
    return {
        "schema_version": 1,
        "version": version,
        "published_at": "2026-08-13T00:00:00Z",
        "content_scope": "full",
        "sources": {
            "base": source("danbooru.base.csv", "danbooru_tag_csv_v1", base_payload),
            "zh-CN": source("danbooru.zh-CN.csv", "tag_translation_csv_v1", zh_payload),
        },
    }


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

        async def fetcher(url, *, headers=None, maximum_bytes=None):
            self.calls.append((url, dict(headers or {}), maximum_bytes))
            if url == "https://manifest.example/tag_sources.json":
                return 200, json.dumps(self.manifest).encode("utf-8"), {"ETag": '"manifest"'}
            for source_id, payload in (("base", self.base_payload), ("zh-CN", self.zh_payload)):
                if url == self.manifest["sources"][source_id]["url"]:
                    return 200, payload, {"ETag": f'"{source_id}"'}
            raise AssertionError(f"unexpected URL {url}")

        self.fetcher = fetcher
        self.store = TagAutocompleteStore(
            self.root / "user" / "metadata.json",
            self.manifest_path,
            remote_manifest_url="https://manifest.example/tag_sources.json",
            fetcher=fetcher,
            now=lambda: 1_700_000_000,
        )

    def tearDown(self):
        self.temporary.cleanup()

    async def test_first_download_installs_both_sources_and_searches_chinese(self):
        self.assertTrue(self.store.status("zh-CN")["needs_download"])
        status = await self.store.update("zh-CN")
        self.assertTrue(status["ready"])
        self.assertEqual(status["row_count"], 4)
        self.assertTrue((self.root / "user" / "danbooru.base.csv").is_file())
        self.assertTrue((self.root / "user" / "danbooru.zh-CN.csv").is_file())

        english = self.store.search("bl", "en", 12)
        self.assertEqual(
            [record["tag"] for record in english],
            ["blush", "blue_eyes", "blue_hair", "blue_archive"],
        )
        self.assertEqual(english[1]["insert_text"], "blue eyes")
        chinese = self.store.search("蓝", "zh-CN", 12)
        self.assertEqual([record["tag"] for record in chinese], ["blue_eyes", "blue_hair"])
        self.assertEqual(chinese[0]["translation"], "蓝眼睛")

    async def test_search_defaults_to_twenty_results(self):
        self.base_payload = base_csv([
            (f"test_tag_{index:02d}", 0, 10_000 - index, "")
            for index in range(25)
        ])
        self.manifest = manifest(self.base_payload, self.zh_payload, version="test-20-limit")
        await self.store.update("en")

        results = self.store.search("test", "en")
        self.assertEqual(len(results), 20)
        self.assertEqual(results[0]["tag"], "test_tag_00")
        self.assertEqual(results[-1]["tag"], "test_tag_19")

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

    async def test_weekly_check_starts_only_when_ready_and_due(self):
        await self.store.update("en")
        self.store.now = lambda: 1_700_000_000 + CHECK_INTERVAL_SECONDS - 1
        self.assertIsNone(self.store._update_task)
        self.store.maybe_start_weekly_check("en")
        self.assertIsNone(self.store._update_task)

        self.store.now = lambda: 1_700_000_000 + CHECK_INTERVAL_SECONDS + 1
        state = self.store.maybe_start_weekly_check("en")
        self.assertTrue(state["updating"])
        await self.store._update_task


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


if __name__ == "__main__":
    unittest.main()
