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
    assert.match(uiSource, /cpw-prompt-editor__action", "全开"/);
    assert.match(uiSource, /cpw-prompt-editor__action", "全关"/);
    assert.doesNotMatch(uiSource, /resetSelectionButton/);
    assert.match(uiSource, /tokenList\.setPointerCapture\(event\.pointerId\)/);
    assert.match(uiSource, /tokenList\.addEventListener\("pointermove", movePromptTokenToggleGesture\)/);
    assert.match(uiSource, /suppressTokenClick = true/);
    assert.match(styleSource, /\.cpw-prompt-editor__tokens--toggling/);
});
