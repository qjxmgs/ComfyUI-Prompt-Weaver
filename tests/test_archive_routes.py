import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock
import uuid


PLUGIN_ROOT = Path(__file__).resolve().parents[1]


class _Response:
    def __init__(self, payload, status=200):
        self.payload = payload
        self.status = status


class _Routes:
    def _decorator(self, _method, _path):
        return lambda function: function

    def get(self, path):
        return self._decorator("GET", path)

    def post(self, path):
        return self._decorator("POST", path)

    def patch(self, path):
        return self._decorator("PATCH", path)

    def delete(self, path):
        return self._decorator("DELETE", path)


class _UserManager:
    def __init__(self, root):
        self.root = Path(root)

    def get_request_user_filepath(self, request, relative_path):
        return str(self.root / request.user / relative_path)


class _Request:
    def __init__(self, payload=None, *, user="alice", match_info=None, raw=None):
        self.user = user
        self.match_info = match_info or {}
        self._raw = raw if raw is not None else json.dumps(payload).encode("utf-8")
        self.content_length = len(self._raw)

    async def read(self):
        return self._raw


def _snapshot(prompt="masterpiece"):
    return {
        "version": 1,
        "columns": 2,
        "items": [
            {
                "id": "prompt-1",
                "enabled": True,
                "title": "画质",
                "prompt": prompt,
            }
        ],
    }


def _load_plugin(root):
    routes = _Routes()
    prompt_server = types.SimpleNamespace(
        instance=types.SimpleNamespace(
            routes=routes,
            user_manager=_UserManager(root),
            send_sync=lambda *_args, **_kwargs: None,
        )
    )
    server_module = types.ModuleType("server")
    server_module.PromptServer = prompt_server
    aiohttp_module = types.ModuleType("aiohttp")
    aiohttp_module.web = types.SimpleNamespace(
        json_response=lambda payload, status=200: _Response(payload, status)
    )
    module_name = f"comfyui_prompt_weaver_routes_{uuid.uuid4().hex}"
    spec = importlib.util.spec_from_file_location(
        module_name,
        PLUGIN_ROOT / "__init__.py",
        submodule_search_locations=[str(PLUGIN_ROOT)],
    )
    module = importlib.util.module_from_spec(spec)
    with mock.patch.dict(
        sys.modules,
        {module_name: module, "server": server_module, "aiohttp": aiohttp_module},
    ):
        spec.loader.exec_module(module)
    return module


class ArchiveRouteTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.module = _load_plugin(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def run_async(self, awaitable):
        return asyncio.run(awaitable)

    def test_crud_status_codes_and_user_isolation(self):
        created = self.run_async(
            self.module.create_prompt_grid_archive(
                _Request({"name": "人物", "snapshot": _snapshot()})
            )
        )
        self.assertEqual(created.status, 201)
        archive_id = created.payload["archive"]["id"]

        conflict = self.run_async(
            self.module.create_prompt_grid_archive(
                _Request({"name": " 人物 ", "snapshot": _snapshot("other")})
            )
        )
        self.assertEqual(conflict.status, 409)

        alice = self.run_async(self.module.list_prompt_grid_archives(_Request()))
        bob = self.run_async(self.module.list_prompt_grid_archives(_Request(user="bob")))
        self.assertEqual([item["name"] for item in alice.payload["archives"]], ["人物"])
        self.assertEqual(bob.payload["archives"], [])

        renamed = self.run_async(
            self.module.update_prompt_grid_archive(
                _Request(
                    {"name": "夜景"},
                    match_info={"archive_id": archive_id},
                )
            )
        )
        self.assertEqual(renamed.status, 200)
        self.assertEqual(renamed.payload["archive"]["name"], "夜景")

        missing = self.run_async(
            self.module.delete_prompt_grid_archive(
                _Request(match_info={"archive_id": str(uuid.uuid4())})
            )
        )
        self.assertEqual(missing.status, 404)

        removed = self.run_async(
            self.module.delete_prompt_grid_archive(
                _Request(match_info={"archive_id": archive_id})
            )
        )
        self.assertEqual(removed.status, 200)

    def test_invalid_json_and_all_import_conflict_policies(self):
        invalid = self.run_async(
            self.module.create_prompt_grid_archive(_Request(raw=b"{not json"))
        )
        self.assertEqual(invalid.status, 400)

        imported_id = str(uuid.uuid4())
        archive = {
            "id": imported_id,
            "name": "通用画质",
            "created_at": "2026-08-10T00:00:00Z",
            "updated_at": "2026-08-10T00:00:00Z",
            "snapshot": _snapshot(),
        }
        bundle = {
            "format": "prompt-weaver-prompt-grid-archives",
            "format_version": 1,
            "exported_at": "2026-08-10T00:00:00Z",
            "archives": [archive],
        }

        first = self.run_async(
            self.module.import_prompt_grid_archives(
                _Request({"bundle": bundle, "conflict_policy": "skip"})
            )
        )
        self.assertEqual(first.payload["imported"], 1)

        skipped = self.run_async(
            self.module.import_prompt_grid_archives(
                _Request({"bundle": bundle, "conflict_policy": "skip"})
            )
        )
        self.assertEqual(skipped.payload["skipped"], 1)

        overwrite_bundle = json.loads(json.dumps(bundle))
        overwrite_bundle["archives"][0]["snapshot"] = _snapshot("updated")
        overwritten = self.run_async(
            self.module.import_prompt_grid_archives(
                _Request({"bundle": overwrite_bundle, "conflict_policy": "overwrite"})
            )
        )
        self.assertEqual(overwritten.payload["overwritten"], 1)

        renamed = self.run_async(
            self.module.import_prompt_grid_archives(
                _Request({"bundle": bundle, "conflict_policy": "rename"})
            )
        )
        self.assertEqual(renamed.payload["renamed"], 1)
        names = [item["name"] for item in renamed.payload["archives"]]
        self.assertCountEqual(names, ["通用画质 (2)", "通用画质"])


if __name__ == "__main__":
    unittest.main()
