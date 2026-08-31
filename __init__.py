import asyncio
import json
import os
import tempfile
import time
import uuid
from pathlib import Path

from aiohttp import web
from server import PromptServer

from .archive_store import (
    MAX_IMPORT_BYTES,
    MAX_SNAPSHOT_BYTES,
    ArchiveCapacityError,
    ArchiveConflictError,
    ArchiveCorruptError,
    ArchiveNotFoundError,
    ArchiveStore,
    ArchiveValidationError,
)
from .nodes import PromptWeaverPromptToggleGrid
from .prompt_card_library import (
    MAX_REQUEST_BYTES as MAX_PROMPT_CARD_LIBRARY_REQUEST_BYTES,
    PromptCardLibraryCapacityError,
    PromptCardLibraryConflictError,
    PromptCardLibraryCorruptError,
    PromptCardLibraryNotFoundError,
    PromptCardLibraryStore,
    PromptCardLibraryValidationError,
)
from .tag_autocomplete import (
    DEFAULT_RESULT_LIMIT,
    MAX_QUERY_LENGTH,
    MAX_RESOLVE_TAGS,
    MAX_SQLITE_DATASET_BYTES,
    TagAutocompleteCapacityError,
    TagAutocompleteError,
    TagAutocompleteStore,
    TagAutocompleteUnavailableError,
    TagAutocompleteValidationError,
)


WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {
    "PromptWeaverPromptToggleGrid": PromptWeaverPromptToggleGrid,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptWeaverPromptToggleGrid": "Prompt Card Grid",
}

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]

_pending_workflows = {}
_frontend_heartbeats = {}
_archive_stores = {}
_prompt_card_library_stores = {}
_tag_autocomplete_stores = {}
_tag_source_manifest_path = Path(__file__).resolve().parent / "data" / "tag_sources.json"


def _archive_store(request):
    path = PromptServer.instance.user_manager.get_request_user_filepath(
        request,
        "ComfyUI-Prompt-Weaver/prompt-grid-archives.json",
    )
    if not path:
        raise ArchiveValidationError("unable to resolve the ComfyUI user data directory")
    store = _archive_stores.get(path)
    if store is None:
        store = ArchiveStore(path)
        _archive_stores[path] = store
    return store


def _prompt_card_library_store(request):
    path = PromptServer.instance.user_manager.get_request_user_filepath(
        request,
        "ComfyUI-Prompt-Weaver/prompt-card-library.json",
    )
    if not path:
        raise PromptCardLibraryValidationError(
            "unable to resolve the ComfyUI user data directory"
        )
    store = _prompt_card_library_stores.get(path)
    if store is None:
        store = PromptCardLibraryStore(path)
        _prompt_card_library_stores[path] = store
    return store


def _tag_autocomplete_store(request):
    path = PromptServer.instance.user_manager.get_request_user_filepath(
        request,
        "ComfyUI-Prompt-Weaver/tag-autocomplete/metadata.json",
    )
    if not path:
        raise TagAutocompleteValidationError(
            "unable to resolve the ComfyUI user data directory"
        )
    store = _tag_autocomplete_stores.get(path)
    if store is None:
        store = TagAutocompleteStore(path, _tag_source_manifest_path)
        _tag_autocomplete_stores[path] = store
    return store


async def _request_json(
    request,
    maximum_bytes,
    capacity_error=ArchiveCapacityError,
    validation_error=ArchiveValidationError,
):
    if request.content_length is not None and request.content_length > maximum_bytes:
        raise capacity_error("request body is too large")
    raw = await request.read()
    if len(raw) > maximum_bytes:
        raise capacity_error("request body is too large")
    try:
        payload = json.loads(
            raw.decode("utf-8"),
            parse_constant=lambda value: (_ for _ in ()).throw(
                validation_error(f"invalid JSON constant {value!r}")
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise validation_error(f"invalid JSON: {error}") from error
    if not isinstance(payload, dict):
        raise validation_error("request JSON must be an object")
    return payload


def _archive_error_response(error):
    if isinstance(error, ArchiveNotFoundError):
        status = 404
    elif isinstance(error, ArchiveConflictError):
        status = 409
    elif isinstance(error, ArchiveCapacityError):
        status = 413
    elif isinstance(error, ArchiveCorruptError):
        status = 500
    else:
        status = 400
    return web.json_response({"error": str(error)}, status=status)


def _prompt_card_library_error_response(error):
    if isinstance(error, PromptCardLibraryNotFoundError):
        status = 404
    elif isinstance(error, PromptCardLibraryConflictError):
        status = 409
    elif isinstance(error, PromptCardLibraryCapacityError):
        status = 413
    elif isinstance(error, PromptCardLibraryCorruptError):
        status = 500
    else:
        status = 400
    return web.json_response({"error": str(error)}, status=status)


def _tag_autocomplete_error_response(error):
    if isinstance(error, TagAutocompleteCapacityError):
        status = 413
    elif isinstance(error, TagAutocompleteUnavailableError):
        status = 409
    else:
        status = 400
    return web.json_response({"error": str(error)}, status=status)


async def _stream_request_to_temporary_file(request, directory, maximum_bytes):
    if request.content_length is not None and request.content_length > maximum_bytes:
        raise TagAutocompleteCapacityError(
            "local supplement upload exceeds the size limit"
        )
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_path = tempfile.mkstemp(
        prefix=".tag.sqlite.upload.",
        suffix=".tmp",
        dir=str(directory),
    )
    total = 0
    try:
        with os.fdopen(file_descriptor, "wb") as handle:
            async for chunk in request.content.iter_chunked(64 * 1024):
                total += len(chunk)
                if total > maximum_bytes:
                    raise TagAutocompleteCapacityError(
                        "local supplement upload exceeds the size limit"
                    )
                handle.write(chunk)
            handle.flush()
            os.fsync(handle.fileno())
        if total <= 0:
            raise TagAutocompleteValidationError(
                "local supplement upload is empty"
            )
        return Path(temporary_path)
    except Exception:
        try:
            os.unlink(temporary_path)
        except FileNotFoundError:
            pass
        raise


def _consume_background_task(task):
    if task.cancelled():
        return
    try:
        task.exception()
    except Exception:
        pass


@PromptServer.instance.routes.post("/prompt-weaver/frontend-ready")
async def frontend_ready(request):
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)

    client_id = payload.get("client_id")
    if not isinstance(client_id, str) or not client_id:
        return web.json_response({"error": "missing client id"}, status=400)
    _frontend_heartbeats[client_id] = time.monotonic()
    return web.json_response({"ok": True})


@PromptServer.instance.routes.post("/prompt-weaver/open-workflow")
async def open_workflow(request):
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)

    has_workflow = "workflow" in payload
    has_api_prompt = "api_prompt" in payload
    if has_workflow == has_api_prompt:
        return web.json_response(
            {"error": "provide exactly one of workflow or api_prompt"},
            status=400,
        )

    if has_workflow:
        graph_field = "workflow"
        graph = payload.get(graph_field)
        if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), list):
            return web.json_response({"error": "invalid UI workflow"}, status=400)
        default_name = "Prompt Weaver Workflow"
    else:
        graph_field = "api_prompt"
        graph = payload.get(graph_field)
        if not isinstance(graph, dict) or not graph or any(
            not isinstance(node, dict)
            or not isinstance(node.get("class_type"), str)
            or not node["class_type"].strip()
            or not isinstance(node.get("inputs"), dict)
            for node in graph.values()
        ):
            return web.json_response({"error": "invalid API prompt"}, status=400)
        default_name = "Prompt Weaver API Prompt"

    token = uuid.uuid4().hex
    data = {
        "token": token,
        "name": str(payload.get("name") or default_name),
        graph_field: graph,
    }
    _pending_workflows[token] = data
    while len(_pending_workflows) > 16:
        _pending_workflows.pop(next(iter(_pending_workflows)))

    now = time.monotonic()
    expired = [client_id for client_id, seen in _frontend_heartbeats.items()
               if now - seen > 30]
    for client_id in expired:
        _frontend_heartbeats.pop(client_id, None)

    delivered = False
    if _frontend_heartbeats:
        client_id = max(_frontend_heartbeats, key=_frontend_heartbeats.get)
        PromptServer.instance.send_sync("prompt-weaver-open-workflow", data, client_id)
        delivered = True
        _pending_workflows.pop(token, None)

    return web.json_response({"ok": True, "token": token, "delivered": delivered})


@PromptServer.instance.routes.get("/prompt-weaver/workflow/{token}")
async def take_workflow(request):
    data = _pending_workflows.pop(request.match_info["token"], None)
    if data is None:
        return web.json_response({"error": "workflow expired"}, status=404)
    return web.json_response(data)


@PromptServer.instance.routes.get("/prompt-weaver/tag-autocomplete/status")
async def get_tag_autocomplete_status(request):
    try:
        locale = request.query.get("locale", "en")
        status = await asyncio.to_thread(
            _tag_autocomplete_store(request).status,
            locale,
        )
        return web.json_response(status)
    except TagAutocompleteError as error:
        return _tag_autocomplete_error_response(error)


@PromptServer.instance.routes.post("/prompt-weaver/tag-autocomplete/update")
async def update_tag_autocomplete(request):
    try:
        payload = await _request_json(request, 4096)
        locale = payload.get("locale", "en")
        task = _tag_autocomplete_store(request).start_update(locale, force=True)
        task.add_done_callback(_consume_background_task)
        return web.json_response(
            _tag_autocomplete_store(request).status(locale),
            status=202,
        )
    except (
        ArchiveValidationError,
        ArchiveCapacityError,
        TagAutocompleteValidationError,
        TagAutocompleteUnavailableError,
    ) as error:
        return _tag_autocomplete_error_response(error)


@PromptServer.instance.routes.post(
    "/prompt-weaver/tag-autocomplete/supplement/import"
)
async def import_tag_autocomplete_supplement(request):
    store = _tag_autocomplete_store(request)
    temporary_path = None
    import_started = False
    try:
        store.begin_local_import()
        import_started = True
        temporary_path = await _stream_request_to_temporary_file(
            request,
            store.root,
            MAX_SQLITE_DATASET_BYTES,
        )
        await asyncio.to_thread(
            store.install_local_supplement,
            temporary_path,
        )
        temporary_path = None
        store.finish_local_import()
        import_started = False
        status = await asyncio.to_thread(store.status, "zh-CN")
        return web.json_response(status)
    except TagAutocompleteError as error:
        return _tag_autocomplete_error_response(error)
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass
        if import_started:
            store.finish_local_import()


@PromptServer.instance.routes.post(
    "/prompt-weaver/tag-autocomplete/supplement/rescan"
)
async def rescan_tag_autocomplete_supplement(request):
    try:
        payload = await _request_json(request, 4096)
        locale = payload.get("locale", "zh-CN")
        store = _tag_autocomplete_store(request)
        await asyncio.to_thread(store.rescan_local_supplement)
        status = await asyncio.to_thread(store.status, locale)
        return web.json_response(status)
    except (
        ArchiveValidationError,
        ArchiveCapacityError,
        TagAutocompleteError,
    ) as error:
        if isinstance(error, TagAutocompleteError):
            return _tag_autocomplete_error_response(error)
        return _archive_error_response(error)


@PromptServer.instance.routes.get("/prompt-weaver/tag-autocomplete/search")
async def search_tag_autocomplete(request):
    query = request.query.get("q", "")
    locale = request.query.get("locale", "en")
    limit = request.query.get("limit", str(DEFAULT_RESULT_LIMIT))
    if len(query) > MAX_QUERY_LENGTH:
        return _tag_autocomplete_error_response(
            TagAutocompleteValidationError("tag autocomplete query is too long")
        )
    try:
        results = await asyncio.to_thread(
            _tag_autocomplete_store(request).search,
            query,
            locale,
            limit,
        )
        return web.json_response({"results": results})
    except TagAutocompleteError as error:
        return _tag_autocomplete_error_response(error)


@PromptServer.instance.routes.post("/prompt-weaver/tag-autocomplete/resolve")
async def resolve_tag_autocomplete(request):
    try:
        payload = await _request_json(request, 64 * 1024)
        tags = payload.get("tags")
        if isinstance(tags, list) and len(tags) > MAX_RESOLVE_TAGS:
            raise TagAutocompleteValidationError("too many tags to resolve")
        results = await asyncio.to_thread(
            _tag_autocomplete_store(request).resolve,
            tags,
            payload.get("locale", "zh-CN"),
        )
        return web.json_response({"results": results})
    except (ArchiveValidationError, ArchiveCapacityError) as error:
        return _archive_error_response(error)
    except TagAutocompleteError as error:
        return _tag_autocomplete_error_response(error)


@PromptServer.instance.routes.get("/prompt-weaver/prompt-grid-archives")
async def list_prompt_grid_archives(request):
    try:
        return web.json_response(_archive_store(request).list_archives())
    except Exception as error:
        if isinstance(error, (ArchiveValidationError, ArchiveCorruptError)):
            return _archive_error_response(error)
        raise


@PromptServer.instance.routes.post("/prompt-weaver/prompt-grid-archives")
async def create_prompt_grid_archive(request):
    try:
        payload = await _request_json(request, MAX_SNAPSHOT_BYTES + 4096)
        archive = _archive_store(request).create(payload.get("name"), payload.get("snapshot"))
        return web.json_response({"archive": archive}, status=201)
    except (ArchiveValidationError, ArchiveConflictError, ArchiveCapacityError, ArchiveCorruptError) as error:
        return _archive_error_response(error)


@PromptServer.instance.routes.patch("/prompt-weaver/prompt-grid-archives/selection")
async def select_prompt_grid_archive(request):
    try:
        payload = await _request_json(request, 4096)
        archive_id = _archive_store(request).set_last_selected(payload.get("archive_id"))
        return web.json_response({"last_selected_archive_id": archive_id})
    except (
        ArchiveValidationError,
        ArchiveNotFoundError,
        ArchiveCorruptError,
    ) as error:
        return _archive_error_response(error)


@PromptServer.instance.routes.patch("/prompt-weaver/prompt-grid-archives/order")
async def reorder_prompt_grid_archives(request):
    try:
        payload = await _request_json(request, 16 * 1024)
        return web.json_response(
            _archive_store(request).reorder(payload.get("archive_ids"))
        )
    except (ArchiveValidationError, ArchiveCorruptError) as error:
        return _archive_error_response(error)


@PromptServer.instance.routes.delete("/prompt-weaver/prompt-grid-archives")
async def delete_prompt_grid_archives(request):
    try:
        payload = await _request_json(request, 16 * 1024)
        return web.json_response(
            _archive_store(request).delete_many(payload.get("archive_ids"))
        )
    except (
        ArchiveValidationError,
        ArchiveNotFoundError,
        ArchiveCorruptError,
    ) as error:
        return _archive_error_response(error)


@PromptServer.instance.routes.patch("/prompt-weaver/prompt-grid-archives/{archive_id}")
async def update_prompt_grid_archive(request):
    try:
        payload = await _request_json(request, MAX_SNAPSHOT_BYTES + 4096)
        archive = _archive_store(request).update(
            request.match_info["archive_id"],
            name=payload.get("name"),
            snapshot=payload.get("snapshot"),
        )
        return web.json_response({"archive": archive})
    except (
        ArchiveValidationError,
        ArchiveConflictError,
        ArchiveNotFoundError,
        ArchiveCapacityError,
        ArchiveCorruptError,
    ) as error:
        return _archive_error_response(error)


@PromptServer.instance.routes.delete("/prompt-weaver/prompt-grid-archives/{archive_id}")
async def delete_prompt_grid_archive(request):
    try:
        archive = _archive_store(request).delete(request.match_info["archive_id"])
        return web.json_response({"archive": archive})
    except (ArchiveValidationError, ArchiveNotFoundError, ArchiveCorruptError) as error:
        return _archive_error_response(error)


@PromptServer.instance.routes.post("/prompt-weaver/prompt-grid-archives/import")
async def import_prompt_grid_archives(request):
    try:
        payload = await _request_json(request, MAX_IMPORT_BYTES + 4096)
        result = _archive_store(request).import_bundle(
            payload.get("bundle"),
            payload.get("conflict_policy", "skip"),
        )
        return web.json_response(result)
    except (
        ArchiveValidationError,
        ArchiveConflictError,
        ArchiveCapacityError,
        ArchiveCorruptError,
    ) as error:
        return _archive_error_response(error)


@PromptServer.instance.routes.get("/prompt-weaver/prompt-card-library")
async def list_prompt_card_library(request):
    try:
        return web.json_response(_prompt_card_library_store(request).list_library())
    except (PromptCardLibraryValidationError, PromptCardLibraryCorruptError) as error:
        return _prompt_card_library_error_response(error)


@PromptServer.instance.routes.post("/prompt-weaver/prompt-card-library/categories")
async def create_prompt_card_library_category(request):
    try:
        payload = await _request_json(
            request,
            16 * 1024,
            PromptCardLibraryCapacityError,
            PromptCardLibraryValidationError,
        )
        store = _prompt_card_library_store(request)
        category, revision = store.create_category(
            payload.get("name"),
            payload.get("parent_id"),
        )
        return web.json_response(
            {"category": category, "revision": revision, "library": store.list_library()},
            status=201,
        )
    except (
        PromptCardLibraryValidationError,
        PromptCardLibraryConflictError,
        PromptCardLibraryNotFoundError,
        PromptCardLibraryCapacityError,
        PromptCardLibraryCorruptError,
    ) as error:
        return _prompt_card_library_error_response(error)


@PromptServer.instance.routes.patch("/prompt-weaver/prompt-card-library/categories/{category_id}")
async def update_prompt_card_library_category(request):
    try:
        payload = await _request_json(
            request,
            16 * 1024,
            PromptCardLibraryCapacityError,
            PromptCardLibraryValidationError,
        )
        store = _prompt_card_library_store(request)
        category, revision = store.update_category(
            request.match_info["category_id"],
            payload.get("name"),
        )
        return web.json_response(
            {"category": category, "revision": revision, "library": store.list_library()}
        )
    except (
        PromptCardLibraryValidationError,
        PromptCardLibraryConflictError,
        PromptCardLibraryNotFoundError,
        PromptCardLibraryCapacityError,
        PromptCardLibraryCorruptError,
    ) as error:
        return _prompt_card_library_error_response(error)


@PromptServer.instance.routes.delete("/prompt-weaver/prompt-card-library/categories/{category_id}")
async def delete_prompt_card_library_category(request):
    try:
        payload = await _request_json(
            request,
            16 * 1024,
            PromptCardLibraryCapacityError,
            PromptCardLibraryValidationError,
        )
        store = _prompt_card_library_store(request)
        result = store.delete_category(
            request.match_info["category_id"],
            payload.get("target_category_id"),
        )
        result["library"] = store.list_library()
        return web.json_response(result)
    except (
        PromptCardLibraryValidationError,
        PromptCardLibraryConflictError,
        PromptCardLibraryNotFoundError,
        PromptCardLibraryCapacityError,
        PromptCardLibraryCorruptError,
    ) as error:
        return _prompt_card_library_error_response(error)


@PromptServer.instance.routes.post("/prompt-weaver/prompt-card-library/cards")
async def create_prompt_card_library_card(request):
    try:
        payload = await _request_json(
            request,
            MAX_PROMPT_CARD_LIBRARY_REQUEST_BYTES,
            PromptCardLibraryCapacityError,
            PromptCardLibraryValidationError,
        )
        store = _prompt_card_library_store(request)
        card, revision = store.create_card(
            payload.get("category_id"),
            payload.get("snapshot"),
        )
        return web.json_response(
            {"card": card, "revision": revision, "library": store.list_library()},
            status=201,
        )
    except (
        PromptCardLibraryValidationError,
        PromptCardLibraryConflictError,
        PromptCardLibraryNotFoundError,
        PromptCardLibraryCapacityError,
        PromptCardLibraryCorruptError,
    ) as error:
        return _prompt_card_library_error_response(error)


@PromptServer.instance.routes.patch("/prompt-weaver/prompt-card-library/cards/order")
async def reorder_prompt_card_library_cards(request):
    try:
        payload = await _request_json(
            request,
            MAX_PROMPT_CARD_LIBRARY_REQUEST_BYTES,
            PromptCardLibraryCapacityError,
            PromptCardLibraryValidationError,
        )
        store = _prompt_card_library_store(request)
        changed, revision = store.reorder_cards(
            payload.get("category_id"),
            payload.get("card_ids"),
        )
        return web.json_response({
            "changed": changed,
            "revision": revision,
            "library": store.list_library(),
        })
    except (
        PromptCardLibraryValidationError,
        PromptCardLibraryNotFoundError,
        PromptCardLibraryCapacityError,
        PromptCardLibraryCorruptError,
    ) as error:
        return _prompt_card_library_error_response(error)


@PromptServer.instance.routes.patch("/prompt-weaver/prompt-card-library/cards/{card_id}")
async def update_prompt_card_library_card(request):
    try:
        payload = await _request_json(
            request,
            MAX_PROMPT_CARD_LIBRARY_REQUEST_BYTES,
            PromptCardLibraryCapacityError,
            PromptCardLibraryValidationError,
        )
        store = _prompt_card_library_store(request)
        card, revision = store.update_card(
            request.match_info["card_id"],
            category_id=payload.get("category_id"),
            snapshot=payload.get("snapshot"),
        )
        return web.json_response(
            {"card": card, "revision": revision, "library": store.list_library()}
        )
    except (
        PromptCardLibraryValidationError,
        PromptCardLibraryConflictError,
        PromptCardLibraryNotFoundError,
        PromptCardLibraryCapacityError,
        PromptCardLibraryCorruptError,
    ) as error:
        return _prompt_card_library_error_response(error)


@PromptServer.instance.routes.patch("/prompt-weaver/prompt-card-library/cards/{card_id}/position")
async def position_prompt_card_library_card(request):
    try:
        payload = await _request_json(
            request,
            MAX_PROMPT_CARD_LIBRARY_REQUEST_BYTES,
            PromptCardLibraryCapacityError,
            PromptCardLibraryValidationError,
        )
        store = _prompt_card_library_store(request)
        changed, card, revision = store.position_card(
            request.match_info["card_id"],
            payload.get("category_id"),
            payload.get("index"),
        )
        return web.json_response({
            "changed": changed,
            "card": card,
            "revision": revision,
            "library": store.list_library(),
        })
    except (
        PromptCardLibraryValidationError,
        PromptCardLibraryNotFoundError,
        PromptCardLibraryCapacityError,
        PromptCardLibraryCorruptError,
    ) as error:
        return _prompt_card_library_error_response(error)


@PromptServer.instance.routes.delete("/prompt-weaver/prompt-card-library/cards/{card_id}")
async def delete_prompt_card_library_card(request):
    try:
        store = _prompt_card_library_store(request)
        card, revision = store.delete_card(
            request.match_info["card_id"]
        )
        return web.json_response(
            {"card": card, "revision": revision, "library": store.list_library()}
        )
    except (
        PromptCardLibraryValidationError,
        PromptCardLibraryNotFoundError,
        PromptCardLibraryCorruptError,
    ) as error:
        return _prompt_card_library_error_response(error)
