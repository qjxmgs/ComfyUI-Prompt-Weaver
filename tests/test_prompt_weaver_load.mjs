import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const moduleSource = await readFile(
    new URL("../web/prompt_weaver_load.js", import.meta.url),
    "utf8",
);
const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`;
const { loadPromptWeaverGraph } = await import(moduleUrl);

test("legacy UI workflows use loadGraphData with the existing arguments", async () => {
    const calls = [];
    const app = {
        async loadGraphData(...args) {
            calls.push(args);
        },
        async loadApiJson() {
            assert.fail("loadApiJson should not be called");
        },
    };
    const workflow = { nodes: [{ id: 1 }] };

    const kind = await loadPromptWeaverGraph(app, { name: "legacy", workflow });

    assert.equal(kind, "workflow");
    assert.deepEqual(calls, [[workflow, true, true, "legacy"]]);
});

test("API prompts use and await loadApiJson", async () => {
    const calls = [];
    let completed = false;
    const app = {
        async loadGraphData() {
            assert.fail("loadGraphData should not be called");
        },
        async loadApiJson(...args) {
            calls.push(args);
            await Promise.resolve();
            completed = true;
        },
    };
    const apiPrompt = { "3": { class_type: "KSampler", inputs: {} } };

    const kind = await loadPromptWeaverGraph(app, { name: "api graph", api_prompt: apiPrompt });

    assert.equal(kind, "api_prompt");
    assert.equal(completed, true);
    assert.deepEqual(calls, [[apiPrompt, "api graph"]]);
});

test("ambiguous and missing graph payloads are rejected", async () => {
    const app = {};
    await assert.rejects(loadPromptWeaverGraph(app, {}), /exactly one/);
    await assert.rejects(loadPromptWeaverGraph(app, {
        workflow: { nodes: [] },
        api_prompt: { "1": { class_type: "KSampler", inputs: {} } },
    }), /exactly one/);
});

test("ComfyUI loader failures propagate to the caller", async () => {
    const app = {
        async loadApiJson() {
            throw new Error("load failed");
        },
    };
    await assert.rejects(loadPromptWeaverGraph(app, {
        api_prompt: { "1": { class_type: "KSampler", inputs: {} } },
    }), /load failed/);
});
