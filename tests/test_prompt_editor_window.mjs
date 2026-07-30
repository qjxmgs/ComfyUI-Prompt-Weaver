import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const moduleSource = await readFile(
    new URL("../web/prompt_editor_window.js", import.meta.url),
    "utf8",
);
const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`;
const {
    clampPromptEditorPosition,
    countActivePromptTokens,
    normalizePromptEditorSize,
} = await import(moduleUrl);

test("counts only explicitly active prompt tokens", () => {
    assert.equal(countActivePromptTokens([true, false, true, true]), 3);
    assert.equal(countActivePromptTokens([1, true, null, "true"]), 1);
    assert.equal(countActivePromptTokens(null), 0);
});

test("normalizes stored editor size to minimum and viewport bounds", () => {
    const viewport = { viewportWidth: 1280, viewportHeight: 720 };
    assert.deepEqual(normalizePromptEditorSize({ width: 640.4, height: 480.6 }, viewport), {
        width: 640,
        height: 481,
    });
    assert.deepEqual(normalizePromptEditorSize({ width: 10, height: 20 }, viewport), {
        width: 360,
        height: 240,
    });
    assert.deepEqual(normalizePromptEditorSize({ width: 5000, height: 5000 }, viewport), {
        width: 1248,
        height: 688,
    });
    assert.equal(normalizePromptEditorSize({ width: "bad", height: 400 }, viewport), null);
});

test("keeps the draggable editor inside the visible viewport", () => {
    const viewport = { viewportWidth: 1000, viewportHeight: 700 };
    assert.deepEqual(clampPromptEditorPosition({
        left: -100,
        top: 900,
        width: 560,
        height: 400,
    }, viewport), {
        left: 16,
        top: 284,
    });
});

test("prompt editor UI wires active count, drag, resize, and size persistence", async () => {
    const uiSource = await readFile(
        new URL("../web/prompt_toggle_grid.js", import.meta.url),
        "utf8",
    );
    const styleSource = await readFile(
        new URL("../web/prompt_toggle_grid.css", import.meta.url),
        "utf8",
    );
    assert.match(uiSource, /title\.append\("编辑提示词（", activeCount, "）"\)/);
    assert.match(uiSource, /header\.addEventListener\("pointerdown", beginPromptEditorDrag\)/);
    assert.match(uiSource, /resizeHandle\.addEventListener\("pointerdown", beginPromptEditorResize\)/);
    assert.match(uiSource, /localStorage\?\.setItem\([\s\S]*?PROMPT_EDITOR_SIZE_STORAGE_KEY/);
    assert.match(styleSource, /\.cpw-prompt-editor__active-count\s*\{/);
    assert.match(styleSource, /\.cpw-prompt-editor__resize-handle\s*\{/);
});
