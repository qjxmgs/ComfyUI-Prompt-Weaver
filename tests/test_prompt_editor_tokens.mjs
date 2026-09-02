import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const moduleSource = await readFile(
    new URL("../web/prompt_editor_tokens.js", import.meta.url),
    "utf8",
);
const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`;
const {
    buildPromptFromSelection,
    confirmPromptEditorDraft,
    dedupePromptTokens,
    mergePromptTokenInput,
    normalizePromptTokenStates,
    promptSelectionFromFreeText,
    promptTokenStatesForStorage,
    reconcilePromptTokenStates,
    removePromptToken,
    setAllPromptTokenSelection,
    splitPromptTokens,
    togglePromptTokenOnce,
} = await import(moduleUrl);

test("splits English and Chinese commas plus newlines at top level", () => {
    assert.deepEqual(
        splitPromptTokens("masterpiece, best quality，蓝眼睛\r\nlong hair"),
        ["masterpiece", "best quality", "蓝眼睛", "long hair"],
    );
});

test("preserves separators inside brackets and weighted syntax", () => {
    assert.deepEqual(
        splitPromptTokens("(red, blue:1.2), [soft, light], {one，two}, final"),
        ["(red, blue:1.2)", "[soft, light]", "{one，two}", "final"],
    );
});

test("preserves quoted and escaped separators without treating apostrophes as quotes", () => {
    assert.deepEqual(
        splitPromptTokens('"red, blue", artist\'s style, escaped\\, comma, “中文，短语”'),
        ['"red, blue"', "artist's style", "escaped\\, comma", "“中文，短语”"],
    );
    assert.deepEqual(
        splitPromptTokens("'artist's red, blue style', final"),
        ["'artist's red, blue style'", "final"],
    );
});

test("skips empty items while retaining duplicates, Unicode, and order", () => {
    assert.deepEqual(
        splitPromptTokens(" , 夜景, masterpiece, masterpiece，，冰湖, "),
        ["夜景", "masterpiece", "masterpiece", "冰湖"],
    );
});

test("deduplicates all editor tokens case-insensitively and preserves the first spelling", () => {
    assert.deepEqual(
        dedupePromptTokens(["masterpiece", "MasterPiece", " BLUE EYES ", "blue eyes", "夜景", "夜景"]),
        ["masterpiece", "BLUE EYES", "夜景"],
    );
});

test("parses free text into unique enabled tokens without breaking protected syntax", () => {
    assert.deepEqual(
        promptSelectionFromFreeText(
            'one, (red, blue:1.2)，ONE\n"quoted, value", escaped\\, comma, 新标签',
        ),
        {
            tokens: ["one", "(red, blue:1.2)", '"quoted, value"', "escaped\\, comma", "新标签"],
            selected: [true, true, true, true, true],
        },
    );
    assert.deepEqual(promptSelectionFromFreeText(" ,，\r\n "), { tokens: [], selected: [] });
});

test("merges split input, appends unique tokens, and reactivates inactive duplicates", () => {
    assert.deepEqual(
        mergePromptTokenInput(
            ["masterpiece", "blue eyes"],
            [false, true],
            "MasterPiece, red hair，RED HAIR\n(best, quality:1.2)",
        ),
        {
            tokens: ["masterpiece", "blue eyes", "red hair", "(best, quality:1.2)"],
            selected: [true, true, true, true],
            addedCount: 2,
            mergedCount: 2,
            reactivatedCount: 1,
        },
    );
});

test("empty token input is a no-op", () => {
    assert.deepEqual(
        mergePromptTokenInput(["masterpiece"], [true], " ,，\n "),
        {
            tokens: ["masterpiece"],
            selected: [true],
            addedCount: 0,
            mergedCount: 0,
            reactivatedCount: 0,
        },
    );
});

test("unchanged selection preserves the exact original prompt", () => {
    const original = " masterpiece,\n(best, quality:1.2) ";
    const tokens = splitPromptTokens(original);
    assert.equal(buildPromptFromSelection(original, tokens, [true, true], [true, true]), original);
});

test("changed selection joins selected raw tokens or returns an empty prompt", () => {
    const tokens = ["masterpiece", "(best, quality:1.2)", "蓝眼睛"];
    const initial = [true, true, true];
    assert.equal(
        buildPromptFromSelection("ignored", tokens, [true, false, true], initial),
        "masterpiece, 蓝眼睛",
    );
    assert.equal(buildPromptFromSelection("ignored", tokens, [false, false, false], initial), "");
});

test("forced rebuild writes a deduplicated token list even when selection is unchanged", () => {
    assert.equal(
        buildPromptFromSelection(
            "masterpiece, MasterPiece, blue eyes",
            ["masterpiece", "blue eyes"],
            [true, true],
            [true, true],
            { forceRebuild: true },
        ),
        "masterpiece, blue eyes",
    );
});

test("forced rebuild preserves an equal-count free-text replacement", () => {
    assert.equal(
        buildPromptFromSelection(
            "one, two",
            ["one", "three"],
            [true, true],
            [true, true],
            { forceRebuild: true },
        ),
        "one, three",
    );
});

test("confirmation commits pending input without requiring Enter or blur", () => {
    assert.equal(
        confirmPromptEditorDraft("", [], [], [], "one, two, ONE"),
        "one, two",
    );
    assert.equal(
        confirmPromptEditorDraft(
            "masterpiece, blue eyes",
            ["masterpiece", "blue eyes"],
            [true, false],
            [true, true],
            "BLUE EYES, red hair",
        ),
        "masterpiece, blue eyes, red hair",
    );
});

test("bulk selection enables or disables every current prompt token", () => {
    assert.deepEqual(setAllPromptTokenSelection([true, false, true], true), [true, true, true]);
    assert.deepEqual(setAllPromptTokenSelection([true, false, true], false), [false, false, false]);
    assert.deepEqual(setAllPromptTokenSelection([], true), []);
    assert.deepEqual(setAllPromptTokenSelection(null, false), []);
});

test("toggle gestures invert each valid token at most once", () => {
    const selected = [true, false, true];
    const visitedIndexes = new Set();
    assert.equal(togglePromptTokenOnce(selected, 0, visitedIndexes), true);
    assert.deepEqual(selected, [false, false, true]);
    assert.equal(togglePromptTokenOnce(selected, 1, visitedIndexes), true);
    assert.deepEqual(selected, [false, true, true]);
    assert.equal(togglePromptTokenOnce(selected, 0, visitedIndexes), false);
    assert.deepEqual(selected, [false, true, true]);
    assert.equal(togglePromptTokenOnce(selected, -1, visitedIndexes), false);
    assert.equal(togglePromptTokenOnce(selected, 3, visitedIndexes), false);
});

test("prompt editor UI exposes bulk controls and pointer toggle painting", async () => {
    const uiSource = await readFile(
        new URL("../web/prompt_toggle_grid.js", import.meta.url),
        "utf8",
    );
    const styleSource = await readFile(
        new URL("../web/prompt_toggle_grid.css", import.meta.url),
        "utf8",
    );
    assert.match(uiSource, /cpw-prompt-editor__action", t\("Enable All"\)/);
    assert.match(uiSource, /cpw-prompt-editor__action", t\("Disable All"\)/);
    assert.doesNotMatch(uiSource, /resetSelectionButton/);
    assert.match(uiSource, /tokenList\.setPointerCapture\(event\.pointerId\)/);
    assert.match(uiSource, /tokenList\.addEventListener\("pointermove", movePromptTokenToggleGesture\)/);
    assert.match(uiSource, /suppressTokenClick = true/);
    assert.match(styleSource, /\.cpw-prompt-editor__tokens--toggling/);
});

test("prompt editor UI exposes non-persistent text mode with raw confirmation", async () => {
    const uiSource = await readFile(
        new URL("../web/prompt_toggle_grid.js", import.meta.url),
        "utf8",
    );
    const styleSource = await readFile(
        new URL("../web/prompt_toggle_grid.css", import.meta.url),
        "utf8",
    );
    assert.match(uiSource, /freeModeInput\.checked = false/);
    assert.match(uiSource, /cpw-prompt-editor__free-mode-text", t\("Text Mode"\)/);
    assert.match(uiSource, /cpw-prompt-editor__free-text/);
    assert.match(uiSource, /enableAllButton\.disabled = freeMode/);
    assert.match(uiSource, /disableAllButton\.disabled = freeMode/);
    assert.match(uiSource, /freeModeInput\.addEventListener\("change"/);
    assert.match(uiSource, /const currentPromptDraft = \(\) => \(\s*freeMode\s*\? \(freeTextArea\?\.value \?\? freePromptText\)/);
    assert.match(uiSource, /const nextPrompt = currentPromptDraft\(\)/);
    assert.match(uiSource, /promptRequiresRebuild = true/);
    assert.match(
        uiSource,
        /\.cpw-prompt-editor__free-mode, \.cpw-prompt-editor__font-size-control, button, input, textarea, select/,
    );
    assert.doesNotMatch(uiSource, /event\.target === overlay\) closePromptEditor/);
    assert.match(styleSource, /\.cpw-prompt-editor__free-mode-input:checked/);
    assert.match(styleSource, /\.cpw-prompt-editor__tokens--free/);
    assert.match(styleSource, /\.cpw-prompt-editor__free-text/);
    assert.match(styleSource, /\.cpw-prompt-editor__action:disabled/);
});

test("text mode and retention expose stateful hints with Tab mode switching", async () => {
    const uiSource = await readFile(
        new URL("../web/prompt_toggle_grid.js", import.meta.url),
        "utf8",
    );
    assert.match(uiSource, /const refreshModeControlHints = \(\) =>/);
    assert.match(uiSource, /freeModeLabel\.title = textModeHint/);
    assert.match(uiSource, /freeModeInput\.setAttribute\("aria-description", textModeHint\)/);
    assert.match(uiSource, /retainUnselectedLabel\.title = retainUnselectedHint/);
    assert.match(
        uiSource,
        /retainUnselectedInput\.setAttribute\("aria-description", retainUnselectedHint\)/,
    );
    assert.match(uiSource, /"Press Tab to switch to Tag Mode"/);
    assert.match(uiSource, /"Press Tab to switch to Text Mode"/);
    assert.match(uiSource, /"Unselected prompts will be retained"/);
    assert.match(uiSource, /"Unselected prompts will be removed"/);
    assert.match(
        uiSource,
        /event\.key === "Tab"[\s\S]*!event\.isComposing[\s\S]*event\.preventDefault\(\);[\s\S]*event\.stopImmediatePropagation\(\);[\s\S]*setFreeModeEnabled\(!freeMode\)/,
    );
    assert.doesNotMatch(uiSource, /const focusable = \[\.\.\.dialog\.querySelectorAll/);
    assert.match(uiSource, /window\.addEventListener\("keydown", handlePromptEditorKeyDown, true\)/);
    assert.match(uiSource, /window\.removeEventListener\("keydown", handlePromptEditorKeyDown, true\)/);
    assert.match(uiSource, /renderTokens\(\{ focusFreeText: true \}\)/);
    assert.match(uiSource, /renderTokens\(\{ focusTagMode: true \}\)/);
    assert.match(
        uiSource,
        /if \(focusTagMode\)[\s\S]*addButton[\s\S]*\?\? tokenList\.querySelector\("\.cpw-prompt-editor__token"\)[\s\S]*\?\? confirmButton/,
    );
});

test("Escape cancels one prompt editor interaction layer before closing", async () => {
    const uiSource = await readFile(
        new URL("../web/prompt_toggle_grid.js", import.meta.url),
        "utf8",
    );
    assert.match(uiSource, /const cancelPromptEditorTransientAction = \(\) => \{/);
    assert.match(
        uiSource,
        /activePromptCardLibraryMenu[\s\S]*editorAutocompleteController\?\.dismiss\?\.\(\)[\s\S]*cancelPromptEditorResize\(\)[\s\S]*cancelPromptEditorDrag\(\)[\s\S]*cleanupPromptTokenToggleGesture\(\)[\s\S]*if \(adding\)/,
    );
    assert.match(
        uiSource,
        /event\.key === "Escape"[\s\S]*if \(!cancelPromptEditorTransientAction\(\)\) closePromptEditor\(\)/,
    );
    assert.match(uiSource, /applyPromptEditorPosition\(\{ left: session\.startLeft, top: session\.startTop \}\)/);
    assert.match(uiSource, /width: session\.startWidth,[\s\S]*height: session\.startHeight/);
    assert.match(
        uiSource,
        /activePromptCardLibraryMenu\?\.root\?\.contains\?\.\(event\.target\)\) return;/,
    );
    assert.doesNotMatch(uiSource, /dialog\.addEventListener\("keydown"/);
});

test("prompt editor records content-only session history and standard shortcuts", async () => {
    const uiSource = await readFile(
        new URL("../web/prompt_toggle_grid.js", import.meta.url),
        "utf8",
    );
    assert.match(uiSource, /new PromptEditorHistory\(\)/);
    assert.match(
        uiSource,
        /const capturePromptContentSnapshot = \(\) => \{[\s\S]*tokens:[\s\S]*selected:[\s\S]*activePrompt,[\s\S]*promptRequiresRebuild:/,
    );
    assert.doesNotMatch(
        uiSource,
        /const capturePromptContentSnapshot = \(\) => \{[\s\S]*?return \{[\s\S]*?freeMode[\s\S]*?\};\s*\};/,
    );
    assert.match(uiSource, /freeTextArea\.addEventListener\("focus"[\s\S]*beginTextHistory/);
    assert.match(uiSource, /freeTextArea\.addEventListener\("beforeinput"[\s\S]*beginTextHistory/);
    assert.match(uiSource, /freeTextArea\.addEventListener\("blur"[\s\S]*finishTextHistory/);
    assert.match(uiSource, /addInput\.addEventListener\("focus"[\s\S]*beginTextHistory/);
    assert.match(uiSource, /addInput\.addEventListener\("beforeinput"[\s\S]*beginTextHistory/);
    assert.match(uiSource, /markTextHistoryDirty\(event\.currentTarget\)/);
    assert.match(
        uiSource,
        /pendingTextHistory\.dirty = true;\s*syncHistoryActions\(\)/,
    );
    assert.match(uiSource, /takeTextHistorySnapshot\(addInput\)/);
    assert.match(uiSource, /applyPromptCompletion\([\s\S]*record\.insertText/);
    assert.doesNotMatch(
        uiSource,
        /recordPromptContentChange\(historySnapshot\);\s*beginTextHistory\(freeTextArea\)/,
    );
    assert.match(
        uiSource,
        /const historySnapshot = capturePromptContentSnapshot\(\);[\s\S]*tokenToggleGesture = \{[\s\S]*historySnapshot/,
    );
    assert.match(uiSource, /recordPromptContentChange\(gesture\?\.historySnapshot\)/);
    assert.match(uiSource, /editorHistory\.clear\(\);[\s\S]*syncHistoryActions\(\)/);
    assert.match(uiSource, /shortcutModifier = event\.ctrlKey \|\| event\.metaKey/);
    assert.match(uiSource, /event\.shiftKey && shortcutKey === "z"/);
    assert.match(uiSource, /!event\.metaKey && !event\.shiftKey && shortcutKey === "y"/);
    assert.match(uiSource, /pendingTextHistory\?\.dirty === true/);
    assert.match(uiSource, /if \(nativeTextHistory\) return/);
    assert.match(uiSource, /if \(redoShortcut\) redoPromptContent\(\{ focusContent: true \}\)/);
    assert.match(uiSource, /else undoPromptContent\(\{ focusContent: true \}\)/);
});

test("removing a retained inactive token preserves the exact active prompt", () => {
    const original = " masterpiece,\n(best, quality:1.2) ";
    assert.equal(
        buildPromptFromSelection(
            original,
            ["masterpiece", "(best, quality:1.2)"],
            [true, true],
            [true, false, true],
        ),
        original,
    );
});

test("normalizes persisted token states and lets an active duplicate win", () => {
    assert.deepEqual(normalizePromptTokenStates([
        { text: " blue eyes ", selected: false },
        { text: "BLUE EYES", selected: true },
        { text: "red hair", selected: false },
        { text: "", selected: false },
        { text: "ignored" },
    ]), [
        { text: "BLUE EYES", selected: true },
        { text: "red hair", selected: false },
    ]);
});

test("reconciles edited active text through selected slots while retaining inactive anchors", () => {
    assert.deepEqual(reconcilePromptTokenStates("third, first, new", [
        { text: "first", selected: true },
        { text: "retained one", selected: false },
        { text: "third", selected: true },
        { text: "retained two", selected: false },
    ]), {
        tokens: ["third", "retained one", "first", "retained two", "new"],
        selected: [true, false, true, false, true],
    });
    assert.deepEqual(reconcilePromptTokenStates("RETAINED ONE, active", [
        { text: "old", selected: true },
        { text: "retained one", selected: false },
    ]), {
        tokens: ["RETAINED ONE", "active"],
        selected: [true, true],
    });
});

test("serializes token states only when inactive entries exist and removes one draft token", () => {
    assert.equal(promptTokenStatesForStorage(["one", "two"], [true, true]), null);
    assert.deepEqual(promptTokenStatesForStorage(["one", "two"], [true, false]), [
        { text: "one", selected: true },
        { text: "two", selected: false },
    ]);
    assert.deepEqual(removePromptToken(["one", "two"], [true, false], 1), {
        tokens: ["one"],
        selected: [true],
        removed: true,
    });
    assert.deepEqual(removePromptToken(["one"], [true], 5), {
        tokens: ["one"],
        selected: [true],
        removed: false,
    });
});

test("prompt editor copies the current draft without confirming or closing", async () => {
    const uiSource = await readFile(
        new URL("../web/prompt_toggle_grid.js", import.meta.url),
        "utf8",
    );
    const styleSource = await readFile(
        new URL("../web/prompt_toggle_grid.css", import.meta.url),
        "utf8",
    );
    assert.match(uiSource, /cpw-prompt-editor__action cpw-prompt-editor__action--copy/);
    assert.match(uiSource, /commitActions\.append\(copyButton, confirmButton\)/);
    assert.match(uiSource, /await copyTextToClipboard\(currentPromptDraft\(\)\)/);
    assert.match(uiSource, /globalThis\.navigator\?\.clipboard\?\.writeText/);
    assert.match(uiSource, /document\.execCommand\?\.\("copy"\)/);
    assert.match(uiSource, /showCopyFeedback\("Copied"\)/);
    assert.match(uiSource, /showCopyFeedback\("Copy failed"\)/);
    assert.doesNotMatch(
        uiSource,
        /copyButton\.addEventListener\("click"[\s\S]*?closePromptEditor\(\)[\s\S]*?\}\);\s*confirmButton/,
    );
    assert.match(styleSource, /\.cpw-prompt-editor__commit-actions/);
    assert.match(styleSource, /\.cpw-prompt-editor__action--copy-success/);
    assert.match(styleSource, /\.cpw-prompt-editor__action--copy-error/);
});

test("prompt editor retains inactive tokens with per-card controls and removable dim free-mode tags", async () => {
    const uiSource = await readFile(
        new URL("../web/prompt_toggle_grid.js", import.meta.url),
        "utf8",
    );
    const styleSource = await readFile(
        new URL("../web/prompt_toggle_grid.css", import.meta.url),
        "utf8",
    );
    assert.match(uiSource, /currentItem\?\.retain_unselected !== false/);
    assert.match(uiSource, /cpw-prompt-editor__retain-unselected/);
    assert.match(uiSource, /t\("Retain Unselected"\)/);
    assert.match(uiSource, /reconcilePromptTokenStates\(\s*freePromptText,\s*currentPromptTokenStates\(\)/);
    assert.match(uiSource, /promptTokenStatesForStorage\(storedDraft\.tokens, storedDraft\.selected\)/);
    assert.match(uiSource, /updatePromptEditorItem\(itemId/);
    assert.match(uiSource, /cpw-prompt-editor__token-shell/);
    assert.match(uiSource, /cpw-prompt-editor__token-remove/);
    assert.match(uiSource, /removeButton\.addEventListener\("pointerdown"/);
    assert.match(uiSource, /event\.stopPropagation\(\)/);
    assert.match(uiSource, /cpw-prompt-editor__retained-section/);
    assert.match(uiSource, /cpw-prompt-editor__retained-token/);
    assert.match(uiSource, /currentPromptDraft\(\)/);
    assert.match(styleSource, /\.cpw-prompt-editor__token-shell/);
    assert.doesNotMatch(styleSource, /\.cpw-prompt-editor__token-shell:has\(> \.cpw-prompt-editor__token-remove/);
    assert.match(styleSource, /\.cpw-prompt-editor__token-remove\s*\{/);
    assert.match(styleSource, /\.cpw-prompt-editor__token-remove\s*\{[\s\S]*top:\s*0;[\s\S]*right:\s*2px;[\s\S]*width:\s*18px;[\s\S]*height:\s*18px;[\s\S]*place-items:\s*start end;[\s\S]*font:\s*700 14px\/1[\s\S]*transform-origin:\s*top right;/);
    assert.match(styleSource, /\.cpw-prompt-editor__token-remove:hover\s*\{[\s\S]*background:\s*transparent;/);
    assert.match(styleSource, /\.cpw-prompt-editor__token-remove:active\s*\{[\s\S]*background:\s*transparent;/);
    assert.match(styleSource, /\.cpw-prompt-editor__retained-section/);
    assert.match(styleSource, /\.cpw-prompt-editor__retained-token\s*\{/);
    assert.match(styleSource, /\.cpw-prompt-editor__token-remove:focus-visible/);
});
