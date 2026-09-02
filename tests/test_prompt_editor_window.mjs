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
    assert.match(uiSource, /title\.append\(t\("Edit Card \("\), activeCount, t\("\)"\)\)/);
    assert.match(uiSource, /const cardTitleInput = element\("input", "cpw-prompt-editor__card-title"\)/);
    assert.match(uiSource, /cardTitleInput\.value = currentItem\?\.title \?\? ""/);
    assert.match(uiSource, /cardTitleInput\.placeholder = t\("Card title"\)/);
    assert.doesNotMatch(uiSource, /t\("Prompt title"\)/);
    assert.match(uiSource, /titleBar\.append\(title, closeButton\)/);
    assert.match(uiSource, /titleControls\.append\(cardTitleInput, bulkSelectionButton\)/);
    assert.match(uiSource, /toolbar\.append\(titleControls, historyActions, fontSizeControl\)/);
    assert.match(uiSource, /modeActions\.append\(retainUnselectedLabel, freeModeLabel\)/);
    assert.match(uiSource, /header\.append\(titleBar, toolbar\)/);
    assert.match(uiSource, /title: cardTitleInput\.value,[\s\S]*prompt: currentPromptDraft\(\)/);
    assert.match(uiSource, /const nextTitle = cardTitleInput\.value/);
    assert.match(uiSource, /updatePromptEditorItem\(itemId, \{[\s\S]*title: nextTitle,[\s\S]*prompt: nextPrompt/);
    assert.match(uiSource, /titleBar\.addEventListener\("pointerdown", beginPromptEditorDrag\)/);
    assert.match(uiSource, /titleBar\.setPointerCapture\(event\.pointerId\)/);
    assert.doesNotMatch(uiSource, /header\.addEventListener\("pointerdown", beginPromptEditorDrag\)/);
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
    assert.match(
        uiSource,
        /toolbar\.append\(titleControls, historyActions, fontSizeControl\)/,
    );
    assert.match(uiSource, /historyActions\.append\(undoButton, redoButton\)/);
    assert.match(uiSource, /cpw-prompt-editor__history-action--undo/);
    assert.match(uiSource, /cpw-prompt-editor__history-action--redo/);
    assert.match(
        uiSource,
        /undoButton\.disabled = !editorHistory\.canUndo && !hasPendingTextEdit/,
    );
    assert.match(
        uiSource,
        /redoButton\.disabled = !editorHistory\.canRedo \|\| hasPendingTextEdit/,
    );
    assert.match(uiSource, /undoButton\.dataset\.tooltip = undoLabel/);
    assert.match(uiSource, /redoButton\.dataset\.tooltip = redoLabel/);
    assert.match(uiSource, /titleBar\.append\(title, closeButton\)/);
    assert.match(uiSource, /PROMPT_EDITOR_MIN_FONT_SIZE = 12/);
    assert.match(uiSource, /PROMPT_EDITOR_MAX_FONT_SIZE = 30/);
    assert.match(uiSource, /persistPromptEditorFontSize\(promptFontSize\)/);
    assert.match(uiSource, /--cpw-prompt-editor-font-size/);
    assert.match(uiSource, /\.cpw-prompt-editor__font-size-control, button/);
    assert.match(styleSource, /\.cpw-prompt-editor__active-count\s*\{/);
    assert.match(styleSource, /\.cpw-prompt-editor__resize-handle\s*\{/);
    assert.match(styleSource, /\.cpw-prompt-editor__font-size-control\s*\{/);
    assert.match(styleSource, /\.cpw-prompt-editor__titlebar\s*\{[\s\S]*justify-content:\s*space-between;/);
    assert.match(styleSource, /\.cpw-prompt-editor__toolbar\s*\{[\s\S]*flex-wrap:\s*wrap;/);
    assert.doesNotMatch(styleSource, /\.cpw-prompt-editor__header-actions\s*\{/);
    assert.match(styleSource, /\.cpw-prompt-editor__card-title\s*\{[\s\S]*cursor:\s*text;[\s\S]*user-select:\s*text;/);
    assert.match(styleSource, /\.cpw-prompt-editor__font-size-label\s*\{/);
    assert.match(
        styleSource,
        /\.cpw-prompt-editor__history-action\s*\{[\s\S]*width:\s*28px;[\s\S]*height:\s*28px;/,
    );
    assert.match(
        styleSource,
        /\.cpw-prompt-editor__history-icon\s*\{[\s\S]*width:\s*18px;[\s\S]*height:\s*18px;[\s\S]*mask:/,
    );
    assert.match(styleSource, /url\("\.\/assets\/icons\/ic_undo\.png"\)/);
    assert.match(styleSource, /url\("\.\/assets\/icons\/ic_redo\.png"\)/);
    assert.match(styleSource, /\.cpw-prompt-editor__history-action:disabled/);
    assert.match(
        styleSource,
        /\.cpw-prompt-editor__history-action::after\s*\{[\s\S]*content:\s*attr\(data-tooltip\);/,
    );
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

test("prompt editor history icons are valid 64px PNG files", async () => {
    for (const fileName of ["ic_undo.png", "ic_redo.png"]) {
        const png = await readFile(
            new URL(`../web/assets/icons/${fileName}`, import.meta.url),
        );
        assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        assert.equal(png.readUInt32BE(16), 64);
        assert.equal(png.readUInt32BE(20), 64);
    }
});
