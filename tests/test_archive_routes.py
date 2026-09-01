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
DEFAULT_ARCHIVE_ID = "00000000-0000-4000-8000-000000000000"


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


class _Content:
    def __init__(self, raw):
        self.raw = raw

    async def iter_chunked(self, size):
        for offset in range(0, len(self.raw), size):
            yield self.raw[offset:offset + size]


class _Request:
    def __init__(self, payload=None, *, user="alice", match_info=None, query=None, raw=None):
        self.user = user
        self.match_info = match_info or {}
        self.query = query or {}
        self._raw = raw if raw is not None else json.dumps(payload).encode("utf-8")
        self.content_length = len(self._raw)
        self.content = _Content(self._raw)

    async def read(self):
        return self._raw

    async def json(self):
        return json.loads(self._raw.decode("utf-8"))


def _snapshot(prompt="masterpiece"):
    return {
        "version": 1,
        "columns": 2,
        "node_size": {"width": 600, "height": 420},
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

    def test_open_workflow_keeps_legacy_ui_workflow_payload(self):
        workflow = {"nodes": [{"id": 1, "type": "KSampler"}]}
        response = self.run_async(self.module.open_workflow(_Request({
            "name": "legacy",
            "workflow": workflow,
        })))

        self.assertEqual(response.status, 200)
        self.assertFalse(response.payload["delivered"])
        taken = self.run_async(self.module.take_workflow(_Request(
            match_info={"token": response.payload["token"]},
        )))
        self.assertEqual(taken.payload["name"], "legacy")
        self.assertEqual(taken.payload["workflow"], workflow)
        self.assertNotIn("api_prompt", taken.payload)

    def test_open_workflow_accepts_api_prompt_and_delivers_to_frontend(self):
        events = []
        self.module.PromptServer.instance.send_sync = lambda *args: events.append(args)
        self.module._frontend_heartbeats["client-1"] = self.module.time.monotonic()
        api_prompt = {"3": {"class_type": "KSampler", "inputs": {"seed": 7}}}

        response = self.run_async(self.module.open_workflow(_Request({
            "name": "api graph",
            "api_prompt": api_prompt,
        })))

        self.assertEqual(response.status, 200)
        self.assertTrue(response.payload["delivered"])
        self.assertEqual(len(events), 1)
        event_name, data, client_id = events[0]
        self.assertEqual(event_name, "prompt-weaver-open-workflow")
        self.assertEqual(client_id, "client-1")
        self.assertEqual(data["api_prompt"], api_prompt)
        self.assertNotIn("workflow", data)
        self.assertNotIn(response.payload["token"], self.module._pending_workflows)

    def test_open_workflow_rejects_ambiguous_or_invalid_graphs(self):
        workflow = {"nodes": []}
        api_prompt = {"1": {"class_type": "KSampler", "inputs": {}}}
        cases = [
            ({}, "provide exactly one"),
            ({"workflow": workflow, "api_prompt": api_prompt}, "provide exactly one"),
            ({"workflow": {"nodes": "invalid"}}, "invalid UI workflow"),
            ({"api_prompt": {}}, "invalid API prompt"),
            ({"api_prompt": {"1": {"class_type": "KSampler"}}}, "invalid API prompt"),
        ]

        for payload, message in cases:
            with self.subTest(payload=payload):
                response = self.run_async(self.module.open_workflow(_Request(payload)))
                self.assertEqual(response.status, 400)
                self.assertIn(message, response.payload["error"])

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
        self.assertEqual([item["name"] for item in alice.payload["archives"]], ["默认存档", "人物"])
        self.assertEqual([item["name"] for item in bob.payload["archives"]], ["默认存档"])
        self.assertEqual(alice.payload["last_selected_archive_id"], DEFAULT_ARCHIVE_ID)

        selected = self.run_async(
            self.module.select_prompt_grid_archive(
                _Request({"archive_id": archive_id})
            )
        )
        self.assertEqual(selected.status, 200)
        self.assertEqual(selected.payload["last_selected_archive_id"], archive_id)

        missing_selection = self.run_async(
            self.module.select_prompt_grid_archive(
                _Request({"archive_id": str(uuid.uuid4())})
            )
        )
        self.assertEqual(missing_selection.status, 404)

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

        second = self.run_async(
            self.module.create_prompt_grid_archive(
                _Request({"name": "人物补充", "snapshot": _snapshot("second")})
            )
        )
        second_id = second.payload["archive"]["id"]
        reordered = self.run_async(
            self.module.reorder_prompt_grid_archives(
                _Request({"archive_ids": [second_id, archive_id]})
            )
        )
        self.assertEqual(reordered.status, 200)
        self.assertEqual(
            [item["id"] for item in reordered.payload["archives"]],
            [DEFAULT_ARCHIVE_ID, second_id, archive_id],
        )
        stale_order = self.run_async(
            self.module.reorder_prompt_grid_archives(
                _Request({"archive_ids": [archive_id]})
            )
        )
        self.assertEqual(stale_order.status, 400)

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
        self.run_async(
            self.module.delete_prompt_grid_archive(
                _Request(match_info={"archive_id": second_id})
            )
        )
        after_delete = self.run_async(self.module.list_prompt_grid_archives(_Request()))
        self.assertEqual(after_delete.payload["last_selected_archive_id"], DEFAULT_ARCHIVE_ID)

        protected = self.run_async(
            self.module.delete_prompt_grid_archive(
                _Request(match_info={"archive_id": DEFAULT_ARCHIVE_ID})
            )
        )
        self.assertEqual(protected.status, 400)

    def test_bulk_delete_is_atomic_and_user_isolated(self):
        first = self.run_async(
            self.module.create_prompt_grid_archive(
                _Request({"name": "第一项", "snapshot": _snapshot("first")})
            )
        ).payload["archive"]
        second = self.run_async(
            self.module.create_prompt_grid_archive(
                _Request({"name": "第二项", "snapshot": _snapshot("second")})
            )
        ).payload["archive"]
        self.run_async(
            self.module.select_prompt_grid_archive(
                _Request({"archive_id": second["id"]})
            )
        )

        stale = self.run_async(
            self.module.delete_prompt_grid_archives(
                _Request({"archive_ids": [first["id"], str(uuid.uuid4())]})
            )
        )
        self.assertEqual(stale.status, 404)
        unchanged = self.run_async(self.module.list_prompt_grid_archives(_Request()))
        self.assertEqual(
            [archive["id"] for archive in unchanged.payload["archives"]],
            [DEFAULT_ARCHIVE_ID, first["id"], second["id"]],
        )

        protected = self.run_async(
            self.module.delete_prompt_grid_archives(
                _Request({"archive_ids": [DEFAULT_ARCHIVE_ID, first["id"]]})
            )
        )
        self.assertEqual(protected.status, 400)

        deleted = self.run_async(
            self.module.delete_prompt_grid_archives(
                _Request({"archive_ids": [second["id"], first["id"]]})
            )
        )
        self.assertEqual(deleted.status, 200)
        self.assertEqual(
            [archive["id"] for archive in deleted.payload["deleted_archives"]],
            [first["id"], second["id"]],
        )
        self.assertEqual(deleted.payload["last_selected_archive_id"], DEFAULT_ARCHIVE_ID)
        self.assertEqual(
            [archive["id"] for archive in deleted.payload["archives"]],
            [DEFAULT_ARCHIVE_ID],
        )
        bob = self.run_async(self.module.list_prompt_grid_archives(_Request(user="bob")))
        self.assertEqual([archive["id"] for archive in bob.payload["archives"]], [DEFAULT_ARCHIVE_ID])

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
        self.assertCountEqual(names, ["默认存档", "通用画质 (2)", "通用画质"])

    def test_tag_autocomplete_routes_are_user_isolated_and_report_missing_data(self):
        alice_store = self.module._tag_autocomplete_store(_Request(user="alice"))
        bob_store = self.module._tag_autocomplete_store(_Request(user="bob"))
        self.assertIsNot(alice_store, bob_store)
        self.assertIn("alice", str(alice_store.metadata_path))
        self.assertIn("bob", str(bob_store.metadata_path))

        status = self.run_async(self.module.get_tag_autocomplete_status(
            _Request(user="alice", query={"locale": "zh-CN"})
        ))
        self.assertEqual(status.status, 200)
        self.assertTrue(status.payload["needs_download"])
        self.assertEqual(status.payload["locale"], "zh-CN")

        missing = self.run_async(self.module.search_tag_autocomplete(
            _Request(user="alice", query={"q": "bl", "locale": "en", "limit": "12"})
        ))
        self.assertEqual(missing.status, 409)

    def test_tag_autocomplete_update_route_starts_one_background_job(self):
        class _FakeStore:
            def __init__(self):
                self.calls = []

            def start_update(self, locale, force=True):
                self.calls.append((locale, force))
                return asyncio.create_task(asyncio.sleep(0))

            def status(self, locale):
                return {"updating": True, "locale": locale}

        store = _FakeStore()
        with mock.patch.object(self.module, "_tag_autocomplete_store", return_value=store):
            response = self.run_async(self.module.update_tag_autocomplete(
                _Request({"locale": "zh-CN"})
            ))
        self.assertEqual(response.status, 202)
        self.assertEqual(response.payload, {"updating": True, "locale": "zh-CN"})
        self.assertEqual(store.calls, [("zh-CN", True)])

    def test_tag_autocomplete_status_route_is_read_only(self):
        class _FakeStore:
            def __init__(self):
                self.calls = []

            def status(self, locale):
                self.calls.append(locale)
                return {"available": True, "locale": locale, "updating": False}

            def maybe_start_weekly_check(self, _locale):
                raise AssertionError("status must not schedule a remote update")

        store = _FakeStore()
        with mock.patch.object(self.module, "_tag_autocomplete_store", return_value=store):
            response = self.run_async(self.module.get_tag_autocomplete_status(
                _Request(query={"locale": "zh-CN"})
            ))
        self.assertEqual(response.status, 200)
        self.assertEqual(response.payload["locale"], "zh-CN")
        self.assertEqual(store.calls, ["zh-CN"])

    def test_tag_autocomplete_search_route_defaults_to_thirty_results(self):
        class _FakeStore:
            def __init__(self):
                self.calls = []

            def search(self, query, locale, limit):
                self.calls.append((query, locale, limit))
                return []

        store = _FakeStore()
        with mock.patch.object(self.module, "_tag_autocomplete_store", return_value=store):
            response = self.run_async(self.module.search_tag_autocomplete(
                _Request(user="alice", query={"q": "bl"})
            ))
        self.assertEqual(response.status, 200)
        self.assertEqual(response.payload, {"results": []})
        self.assertEqual(store.calls, [("bl", "en", "30")])

    def test_tag_autocomplete_resolve_route_preserves_batch_and_locale(self):
        class _FakeStore:
            def __init__(self):
                self.calls = []

            def resolve(self, tags, locale):
                self.calls.append((tags, locale))
                return [{"tag": "blue_eyes", "translation": "蓝眼睛"}, None]

        store = _FakeStore()
        with mock.patch.object(self.module, "_tag_autocomplete_store", return_value=store):
            response = self.run_async(self.module.resolve_tag_autocomplete(
                _Request({"tags": ["blue eyes", "blue"], "locale": "zh-CN"})
            ))
        self.assertEqual(response.status, 200)
        self.assertEqual(response.payload["results"][0]["tag"], "blue_eyes")
        self.assertIsNone(response.payload["results"][1])
        self.assertEqual(store.calls, [(["blue eyes", "blue"], "zh-CN")])

    def test_local_supplement_import_streams_to_the_current_user_store(self):
        class _FakeStore:
            def __init__(self, root):
                self.root = Path(root)
                self.calls = []
                self.importing = False

            def begin_local_import(self):
                self.importing = True
                self.calls.append("begin")

            def install_local_supplement(self, path):
                self.calls.append(("install", Path(path).read_bytes()))
                Path(path).unlink()

            def finish_local_import(self):
                self.importing = False
                self.calls.append("finish")

            def status(self, locale):
                return {
                    "locale": locale,
                    "supplement_origin": "local",
                    "supplement_importing": self.importing,
                }

        store = _FakeStore(Path(self.temporary.name) / "alice" / "tag-autocomplete")
        with mock.patch.object(self.module, "_tag_autocomplete_store", return_value=store):
            response = self.run_async(
                self.module.import_tag_autocomplete_supplement(
                    _Request(raw=b"SQLite test payload", user="alice")
                )
            )
        self.assertEqual(response.status, 200)
        self.assertEqual(response.payload["supplement_origin"], "local")
        self.assertFalse(response.payload["supplement_importing"])
        self.assertEqual(store.calls[0], "begin")
        self.assertEqual(store.calls[1], ("install", b"SQLite test payload"))
        self.assertEqual(store.calls[2], "finish")
        self.assertEqual(list(store.root.glob("*.tmp")), [])

    def test_local_supplement_import_reports_capacity_and_busy_conflicts(self):
        class _CapacityStore:
            def __init__(self, root):
                self.root = Path(root)
                self.finished = False

            def begin_local_import(self):
                pass

            def finish_local_import(self):
                self.finished = True

        capacity_store = _CapacityStore(Path(self.temporary.name) / "capacity")
        request = _Request(raw=b"x")
        request.content_length = self.module.MAX_SQLITE_DATASET_BYTES + 1
        with mock.patch.object(
            self.module,
            "_tag_autocomplete_store",
            return_value=capacity_store,
        ):
            response = self.run_async(
                self.module.import_tag_autocomplete_supplement(request)
            )
        self.assertEqual(response.status, 413)
        self.assertTrue(capacity_store.finished)

        unavailable_error = self.module.TagAutocompleteUnavailableError
        busy_root = Path(self.temporary.name) / "busy"

        class _BusyStore:
            root = busy_root

            def begin_local_import(self):
                raise unavailable_error("busy")

            def finish_local_import(self):
                raise AssertionError("an import that did not start must not be finished")

        with mock.patch.object(
            self.module,
            "_tag_autocomplete_store",
            return_value=_BusyStore(),
        ):
            response = self.run_async(
                self.module.import_tag_autocomplete_supplement(_Request(raw=b"x"))
            )
        self.assertEqual(response.status, 409)

    def test_local_supplement_rescan_is_local_and_returns_status(self):
        class _FakeStore:
            def __init__(self):
                self.calls = []

            def rescan_local_supplement(self):
                self.calls.append("rescan")

            def status(self, locale):
                self.calls.append(("status", locale))
                return {"locale": locale, "supplement_origin": "local"}

        store = _FakeStore()
        with mock.patch.object(self.module, "_tag_autocomplete_store", return_value=store):
            response = self.run_async(
                self.module.rescan_tag_autocomplete_supplement(
                    _Request({"locale": "zh-CN"})
                )
            )
        self.assertEqual(response.status, 200)
        self.assertEqual(response.payload["supplement_origin"], "local")
        self.assertEqual(store.calls, ["rescan", ("status", "zh-CN")])

    def test_prompt_card_library_routes_are_user_isolated_and_preserve_snapshots(self):
        primary = self.run_async(self.module.create_prompt_card_library_category(
            _Request({"name": "人物", "parent_id": None})
        ))
        self.assertEqual(primary.status, 201)
        secondary = self.run_async(self.module.create_prompt_card_library_category(
            _Request({"name": "角色", "parent_id": primary.payload["category"]["id"]})
        ))
        self.assertEqual(secondary.status, 201)
        category_id = secondary.payload["category"]["id"]
        snapshot = {
            "title": "主角",
            "prompt": "1girl, blue eyes",
            "color": "purple",
            "prompt_tokens": [
                {"text": "1girl", "selected": True},
                {"text": "blue eyes", "selected": False},
            ],
        }
        created = self.run_async(self.module.create_prompt_card_library_card(
            _Request({"category_id": category_id, "snapshot": snapshot})
        ))
        self.assertEqual(created.status, 201)
        self.assertEqual(created.payload["card"]["prompt_tokens"], snapshot["prompt_tokens"])
        self.assertEqual(len(created.payload["library"]["cards"]), 1)

        alice = self.run_async(self.module.list_prompt_card_library(_Request()))
        bob = self.run_async(self.module.list_prompt_card_library(_Request(user="bob")))
        self.assertEqual(len(alice.payload["cards"]), 1)
        self.assertEqual(bob.payload["categories"], [])
        self.assertEqual(bob.payload["cards"], [])
        self.assertTrue((
            Path(self.temporary.name)
            / "alice"
            / "ComfyUI-Prompt-Weaver"
            / "prompt-card-library.json"
        ).is_file())

    def test_prompt_card_library_routes_move_update_and_migrate_before_delete(self):
        def create_branch(primary_name, secondary_name):
            primary = self.run_async(self.module.create_prompt_card_library_category(
                _Request({"name": primary_name, "parent_id": None})
            )).payload["category"]
            secondary = self.run_async(self.module.create_prompt_card_library_category(
                _Request({"name": secondary_name, "parent_id": primary["id"]})
            )).payload["category"]
            return primary, secondary

        _source_primary, source = create_branch("人物", "角色")
        _target_primary, target = create_branch("场景", "室内")
        snapshot = {"title": "主角", "prompt": "1girl"}
        card = self.run_async(self.module.create_prompt_card_library_card(
            _Request({"category_id": source["id"], "snapshot": snapshot})
        )).payload["card"]

        missing_target = self.run_async(self.module.delete_prompt_card_library_category(
            _Request({}, match_info={"category_id": source["id"]})
        ))
        self.assertEqual(missing_target.status, 400)
        migrated = self.run_async(self.module.delete_prompt_card_library_category(
            _Request(
                {"target_category_id": target["id"]},
                match_info={"category_id": source["id"]},
            )
        ))
        self.assertEqual(migrated.status, 200)
        self.assertEqual(migrated.payload["moved_cards"], 1)

        updated_snapshot = {"title": "更新后的主角", "prompt": "1girl, solo"}
        updated = self.run_async(self.module.update_prompt_card_library_card(
            _Request(
                {"snapshot": updated_snapshot},
                match_info={"card_id": card["id"]},
            )
        ))
        self.assertEqual(updated.status, 200)
        self.assertEqual(updated.payload["card"]["category_id"], target["id"])
        self.assertEqual(updated.payload["card"]["prompt"], "1girl, solo")
        removed = self.run_async(self.module.delete_prompt_card_library_card(
            _Request(match_info={"card_id": card["id"]})
        ))
        self.assertEqual(removed.status, 200)

    def test_prompt_card_library_reorder_route_persists_exact_category_order(self):
        primary = self.run_async(self.module.create_prompt_card_library_category(
            _Request({"name": "人物", "parent_id": None})
        )).payload["category"]
        secondary = self.run_async(self.module.create_prompt_card_library_category(
            _Request({"name": "角色", "parent_id": primary["id"]})
        )).payload["category"]
        cards = [
            self.run_async(self.module.create_prompt_card_library_card(_Request({
                "category_id": secondary["id"],
                "snapshot": {"title": label, "prompt": f"prompt {label}"},
            }))).payload["card"]
            for label in ("one", "two", "three")
        ]
        requested_ids = [cards[2]["id"], cards[0]["id"], cards[1]["id"]]
        reordered = self.run_async(self.module.reorder_prompt_card_library_cards(
            _Request({"category_id": secondary["id"], "card_ids": requested_ids})
        ))
        self.assertEqual(reordered.status, 200)
        self.assertTrue(reordered.payload["changed"])
        self.assertEqual(
            [card["id"] for card in reordered.payload["library"]["cards"]],
            requested_ids,
        )

        invalid = self.run_async(self.module.reorder_prompt_card_library_cards(
            _Request({"category_id": secondary["id"], "card_ids": requested_ids[:2]})
        ))
        self.assertEqual(invalid.status, 400)

    def test_prompt_card_library_category_position_route_reorders_and_reparents(self):
        first = self.run_async(self.module.create_prompt_card_library_category(
            _Request({"name": "人物", "parent_id": None})
        )).payload["category"]
        second = self.run_async(self.module.create_prompt_card_library_category(
            _Request({"name": "服装", "parent_id": None})
        )).payload["category"]
        moving = self.run_async(self.module.create_prompt_card_library_category(
            _Request({"name": "角色", "parent_id": first["id"]})
        )).payload["category"]
        target = self.run_async(self.module.create_prompt_card_library_category(
            _Request({"name": "上衣", "parent_id": second["id"]})
        )).payload["category"]

        reordered = self.run_async(self.module.position_prompt_card_library_category(
            _Request(
                {"parent_id": None, "index": 0},
                match_info={"category_id": second["id"]},
            )
        ))
        self.assertEqual(reordered.status, 200)
        self.assertTrue(reordered.payload["changed"])
        self.assertEqual(
            [
                item["id"]
                for item in reordered.payload["library"]["categories"]
                if item["parent_id"] is None
            ],
            [second["id"], first["id"]],
        )

        moved = self.run_async(self.module.position_prompt_card_library_category(
            _Request(
                {"parent_id": second["id"], "index": 0},
                match_info={"category_id": moving["id"]},
            )
        ))
        self.assertEqual(moved.status, 200)
        self.assertTrue(moved.payload["changed"])
        self.assertEqual(moved.payload["category"]["parent_id"], second["id"])
        self.assertEqual(
            [
                item["id"]
                for item in moved.payload["library"]["categories"]
                if item["parent_id"] == second["id"]
            ],
            [moving["id"], target["id"]],
        )

    def test_prompt_card_library_position_route_moves_card_into_target_order(self):
        primary = self.run_async(self.module.create_prompt_card_library_category(
            _Request({"name": "人物", "parent_id": None})
        )).payload["category"]
        source = self.run_async(self.module.create_prompt_card_library_category(
            _Request({"name": "角色", "parent_id": primary["id"]})
        )).payload["category"]
        target = self.run_async(self.module.create_prompt_card_library_category(
            _Request({"name": "服装", "parent_id": primary["id"]})
        )).payload["category"]
        moving = self.run_async(self.module.create_prompt_card_library_card(_Request({
            "category_id": source["id"],
            "snapshot": {"title": "moving", "prompt": "moving"},
        }))).payload["card"]
        target_cards = [
            self.run_async(self.module.create_prompt_card_library_card(_Request({
                "category_id": target["id"],
                "snapshot": {"title": label, "prompt": label},
            }))).payload["card"]
            for label in ("one", "two")
        ]

        positioned = self.run_async(self.module.position_prompt_card_library_card(
            _Request(
                {"category_id": target["id"], "index": 1},
                match_info={"card_id": moving["id"]},
            )
        ))
        self.assertEqual(positioned.status, 200)
        self.assertTrue(positioned.payload["changed"])
        self.assertEqual(
            [
                card["id"]
                for card in positioned.payload["library"]["cards"]
                if card["category_id"] == target["id"]
            ],
            [target_cards[0]["id"], moving["id"], target_cards[1]["id"]],
        )

    def test_prompt_card_library_routes_return_conflict_not_found_and_capacity_statuses(self):
        primary = self.run_async(self.module.create_prompt_card_library_category(
            _Request({"name": "人物", "parent_id": None})
        )).payload["category"]
        conflict = self.run_async(self.module.create_prompt_card_library_category(
            _Request({"name": " 人物 ", "parent_id": None})
        ))
        self.assertEqual(conflict.status, 409)
        invalid_depth = self.run_async(self.module.create_prompt_card_library_category(
            _Request({"name": "非法", "parent_id": primary["id"]})
        )).payload["category"]
        third_level = self.run_async(self.module.create_prompt_card_library_category(
            _Request({"name": "三级", "parent_id": invalid_depth["id"]})
        ))
        self.assertEqual(third_level.status, 400)
        missing = self.run_async(self.module.delete_prompt_card_library_card(
            _Request(match_info={"card_id": str(uuid.uuid4())})
        ))
        self.assertEqual(missing.status, 404)

        request = _Request({"name": "oversized", "parent_id": None})
        request.content_length = self.module.MAX_PROMPT_CARD_LIBRARY_REQUEST_BYTES + 1
        capacity = self.run_async(self.module.create_prompt_card_library_category(request))
        self.assertEqual(capacity.status, 413)


if __name__ == "__main__":
    unittest.main()
