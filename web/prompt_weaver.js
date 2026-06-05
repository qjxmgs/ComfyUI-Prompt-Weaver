import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

async function loadWorkflow(payload) {
    if (!payload?.workflow) return;
    await app.loadGraphData(
        payload.workflow,
        true,
        true,
        payload.name || "Prompt Weaver Workflow"
    );
    window.focus();
}

async function announceFrontend() {
    if (!api.clientId) return;
    try {
        await api.fetchApi("/prompt-weaver/frontend-ready", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: api.clientId }),
        });
    } catch (error) {
        console.debug("[Prompt Weaver] Frontend heartbeat failed", error);
    }
}

app.registerExtension({
    name: "ComfyUIPromptWeaver.OpenWorkflow",
    async setup() {
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
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            await loadWorkflow(await response.json());
        } catch (error) {
            console.error("[Prompt Weaver] Failed to fetch workflow", error);
        }
    },
});
