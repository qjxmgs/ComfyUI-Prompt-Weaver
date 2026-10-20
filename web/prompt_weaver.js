import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { loadPromptWeaverGraph } from "./prompt_weaver_load.js";
import {
    connectPromptWeaverI18n,
    PROMPT_WEAVER_LOCAL_ONLY_CODE,
    promptWeaverHttpError,
    t,
} from "./prompt_weaver_i18n.js?v=20261020-loopback-help-v1";

let bridgeLocalOnlyWarningShown = false;

async function bridgeResponseError(response) {
    let payload = null;
    try {
        payload = await response.json();
    } catch (_error) {
        // Preserve the HTTP status when an upstream error is not JSON.
    }
    return promptWeaverHttpError(response, payload, `HTTP ${response.status}`);
}

function reportBridgeError(error) {
    if (error?.code !== PROMPT_WEAVER_LOCAL_ONLY_CODE || bridgeLocalOnlyWarningShown) return;
    bridgeLocalOnlyWarningShown = true;
    const toast = app?.extensionManager?.toast;
    if (typeof toast?.add === "function") {
        toast.add({
            severity: "error",
            summary: t("Restart ComfyUI with --listen 127.0.0.1"),
            detail: error.message,
            life: 16000,
        });
    } else {
        console.warn("[Prompt Weaver]", error.message);
    }
}

async function loadWorkflow(payload) {
    await loadPromptWeaverGraph(app, payload);
    window.focus();
}

async function announceFrontend() {
    if (!api.clientId) return;
    try {
        const response = await api.fetchApi("/prompt-weaver/frontend-ready", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: api.clientId }),
        });
        if (!response.ok) throw await bridgeResponseError(response);
    } catch (error) {
        reportBridgeError(error);
        console.debug("[Prompt Weaver] Frontend heartbeat failed", error);
    }
}

app.registerExtension({
    name: "ComfyUIPromptWeaver.OpenWorkflow",
    async setup() {
        await connectPromptWeaverI18n(app, api);
        api.addEventListener("status", announceFrontend);
        window.addEventListener("focus", announceFrontend);
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") announceFrontend();
        });
        await announceFrontend();
        window.setInterval(announceFrontend, 10000);

        api.addEventListener("prompt-weaver-open-workflow", async (event) => {
            try {
                await loadWorkflow(event.detail);
            } catch (error) {
                console.error("[Prompt Weaver] Failed to open workflow", error);
            }
        });

        const url = new URL(window.location.href);
        const token = url.searchParams.get("prompt_weaver");
        if (!token) return;

        url.searchParams.delete("prompt_weaver");
        window.history.replaceState({}, "", url);
        try {
            const response = await api.fetchApi(
                `/prompt-weaver/workflow/${encodeURIComponent(token)}`
            );
            if (!response.ok) throw await bridgeResponseError(response);
            await loadWorkflow(await response.json());
        } catch (error) {
            reportBridgeError(error);
            console.error("[Prompt Weaver] Failed to fetch workflow", error);
        }
    },
});
