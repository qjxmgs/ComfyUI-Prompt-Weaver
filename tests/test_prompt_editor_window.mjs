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
    normalizePromptEditorFontSize,
    normalizePromptEditorSize,
} = await import(moduleUrl);

test("counts only explicitly active prompt tokens", () => {
    assert.equal(countActivePromptTokens([true, false, true, true]), 3);
    assert.equal(countActivePromptTokens([1, true, null, "true"]), 1);
    assert.equal(countActivePromptTokens(null), 0);
});

test("normalizes prompt editor font size to 12-30 integer limits with a 15px fallback", () => {
    assert.equal(normalizePromptEditorFontSize(undefined), 15);
    assert.equal(normalizePromptEditorFontSize("invalid"), 15);
    assert.equal(normalizePromptEditorFontSize(12), 12);
    assert.equal(normalizePromptEditorFontSize(15), 15);
    assert.equal(normalizePromptEditorFontSize(30), 30);
    assert.equal(normalizePromptEditorFontSize(8), 12);
    assert.equal(normalizePromptEditorFontSize(80), 30);
    assert.equal(normalizePromptEditorFontSize(24.6), 25);
});

test("normalizes stored editor size to minimum and viewport bounds", () => {
    const viewport = { viewportWidth: 1280, viewportHeight: 720 };
    assert.deepEqual(normalizePromptEditorSize({ width: 640.4, height: 480.6 }, viewport), {
        width: 640,
        height: 481,
    });
    assert.deepEqual(normalizePromptEditorSize({ width: 10, height: 20 }, viewport), {
        width: 600,
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
    assert.match(uiSource, /title\.append\(t\("Edit Prompts \("\), activeCount, t\("\)"\)\)/);
    assert.match(uiSource, /header\.addEventListener\("pointerdown", beginPromptEditorDrag\)/);
    assert.match(uiSource, /resizeHandle\.addEventListener\("pointerdown", beginPromptEditorResize\)/);
    assert.match(uiSource, /localStorage\?\.setItem\([\s\S]*?PROMPT_EDITOR_SIZE_STORAGE_KEY/);
    assert.match(uiSource, /PROMPT_EDITOR_FONT_SIZE_STORAGE_KEY/);
    assert.match(uiSource, /fontSizeInput\.type = "range"/);
    assert.match(uiSource, /fontSizeInput\.min = String\(PROMPT_EDITOR_MIN_FONT_SIZE\)/);
    assert.match(uiSource, /fontSizeInput\.max = String\(PROMPT_EDITOR_MAX_FONT_SIZE\)/);
    assert.match(uiSource, /fontSizeInput\.step = "1"/);
    assert.match(uiSource, /cpw-prompt-editor__font-size-label/);
    assert.match(uiSource, /t\("Font Size"\)/);
    assert.match(uiSource, /fontSizeLabel\.textContent = t\("Font Size"\)/);
    assert.match(uiSource, /headerMain\.append\(title, freeModeLabel, retainUnselectedLabel\)/);
    assert.match(uiSource, /headerActions\.append\(fontSizeControl, closeButton\)/);
    assert.match(uiSource, /PROMPT_EDITOR_MIN_FONT_SIZE = 12/);
    assert.match(uiSource, /PROMPT_EDITOR_MAX_FONT_SIZE = 30/);
    assert.match(uiSource, /persistPromptEditorFontSize\(promptFontSize\)/);
    assert.match(uiSource, /--cpw-prompt-editor-font-size/);
    assert.match(uiSource, /\.cpw-prompt-editor__font-size-control, button/);
    assert.match(styleSource, /\.cpw-prompt-editor__active-count\s*\{/);
    assert.match(styleSource, /\.cpw-prompt-editor__resize-handle\s*\{/);
    assert.match(styleSource, /\.cpw-prompt-editor__font-size-control\s*\{/);
    assert.match(styleSource, /\.cpw-prompt-editor__header-actions\s*\{/);
    assert.match(styleSource, /\.cpw-prompt-editor__font-size-label\s*\{/);
    assert.match(
        styleSource,
        /\.cpw-prompt-editor__close,\s*\.cpw-archive-manager__close\s*\{[\s\S]*background:\s*#e53935;/,
    );
    assert.match(
        styleSource,
        /\.cpw-prompt-editor__close::before,[\s\S]*\.cpw-archive-manager__close::after/,
    );
    assert.match(
        styleSource,
        /\.cpw-prompt-editor__close:active,\s*\.cpw-archive-manager__close:active\s*\{[\s\S]*background:\s*#c62828;/,
    );
    assert.match(styleSource, /font-size: var\(--cpw-prompt-editor-font-size, 15px\)/);
    assert.match(uiSource, /PROMPT_EDITOR_MIN_WIDTH = 600/);
    assert.match(styleSource, /min-width: min\(600px, calc\(100vw - 32px\)\)/);
    assert.match(uiSource, /getAnchorRect: \(\) => textareaCaretClientRect\(freeTextArea\)/);
});
