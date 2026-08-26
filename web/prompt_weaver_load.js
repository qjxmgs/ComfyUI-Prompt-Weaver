export async function loadPromptWeaverGraph(app, payload) {
    const hasWorkflow = payload?.workflow != null;
    const hasApiPrompt = payload?.api_prompt != null;
    if (hasWorkflow === hasApiPrompt) {
        throw new Error("Expected exactly one of workflow or api_prompt");
    }

    if (hasWorkflow) {
        await app.loadGraphData(
            payload.workflow,
            true,
            true,
            payload.name || "Prompt Weaver Workflow",
        );
        return "workflow";
    }

    await app.loadApiJson(
        payload.api_prompt,
        payload.name || "Prompt Weaver API Prompt",
    );
    return "api_prompt";
}
