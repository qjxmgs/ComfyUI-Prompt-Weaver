import json
import time
import uuid

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


WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {
    "PromptWeaverPromptToggleGrid": PromptWeaverPromptToggleGrid,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptWeaverPromptToggleGrid": "Prompt Toggle Grid",
}

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]

_pending_workflows = {}
_frontend_heartbeats = {}
_archive_stores = {}


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


async def _request_json(request, maximum_bytes):
    if request.content_length is not None and request.content_length > maximum_bytes:
        raise ArchiveCapacityError("request body is too large")
    raw = await request.read()
    if len(raw) > maximum_bytes:
        raise ArchiveCapacityError("request body is too large")
    try:
        payload = json.loads(
            raw.decode("utf-8"),
            parse_constant=lambda value: (_ for _ in ()).throw(
                ArchiveValidationError(f"invalid JSON constant {value!r}")
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ArchiveValidationError(f"invalid JSON: {error}") from error
    if not isinstance(payload, dict):
        raise ArchiveValidationError("request JSON must be an object")
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

    workflow = payload.get("workflow")
    if not isinstance(workflow, dict) or not isinstance(workflow.get("nodes"), list):
        return web.json_response({"error": "invalid UI workflow"}, status=400)

    token = uuid.uuid4().hex
    data = {
        "token": token,
        "name": str(payload.get("name") or "Prompt Weaver Workflow"),
        "workflow": workflow,
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
