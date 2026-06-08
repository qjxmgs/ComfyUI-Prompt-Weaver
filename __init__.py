import time
import uuid

from aiohttp import web
from server import PromptServer

from .nodes import PromptWeaverPromptToggleGrid


WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {
    "PromptWeaverPromptToggleGrid": PromptWeaverPromptToggleGrid,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptWeaverPromptToggleGrid": "提示词开关网格",
}

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]

_pending_workflows = {}
_frontend_heartbeats = {}


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
