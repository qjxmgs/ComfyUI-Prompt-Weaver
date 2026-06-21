import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const moduleSource = await readFile(
    new URL("../web/prompt_editor_tokens.js", import.meta.url),
    "utf8",
);
const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`;
const { buildPromptFromSelection, splitPromptTokens } = await import(moduleUrl);

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
