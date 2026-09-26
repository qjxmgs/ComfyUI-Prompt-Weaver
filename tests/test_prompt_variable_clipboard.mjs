import assert from "node:assert/strict";
import test from "node:test";
import {
    normalizeVariables, serializeVariableClipboard, parseVariableClipboard,
    mergeVariableClipboard, MAX_VARIABLE_CLIPBOARD_LENGTH,
} from "../web/prompt_variables.js";

const node = [{ id: "old", name: "color", value: "red" }];
test("copy exports ordered names and values with a distinct format and no IDs", () => {
    const source = [...node, { id: "two", name: "颜色", value: "", library_id: "old-link" }];
    const text = serializeVariableClipboard(source);
    const payload = JSON.parse(text);
    assert.equal(payload.format, "prompt-weaver-variables");
    assert.equal(payload.version, 1);
    assert.deepEqual(payload.variables, [{ name: "color", value: "red" }, { name: "颜色", value: "" }]);
    assert.deepEqual(parseVariableClipboard(text), payload.variables);
    assert.equal(text.includes("library_id"), false);
});

test("clipboard rejects plain text, wrong formats, empty/invalid/oversized payloads", () => {
    for (const value of ["hello", "", "{}", "[]", null, "x".repeat(MAX_VARIABLE_CLIPBOARD_LENGTH + 1)]) {
        assert.throws(() => parseVariableClipboard(value));
    }
    const encode = (variables, extra = {}) => JSON.stringify({ format: "prompt-weaver-variables", version: 1, variables, ...extra });
    for (const variables of [
        [], [{ name: "1invalid", value: "x" }], [{ name: "e\u0301", value: "x" }],
        [{ name: "color", value: "red" }, { name: "color", value: "blue" }],
        [{ name: "color", value: null }], [{ name: "color", value: "x".repeat(10001) }],
        Array.from({ length: 101 }, (_, i) => ({ name: "v" + i, value: "" })),
    ]) assert.throws(() => parseVariableClipboard(encode(variables)));
    assert.throws(() => parseVariableClipboard(encode([{ name: "x", value: "" }], { version: 2 })));
    assert.throws(() => parseVariableClipboard(encode([{ name: "x", value: "" }], { format: "other" })));
});

test("paste merges by case-sensitive name and preserves destination IDs and other values", () => {
    let counter = 0;
    const original = [...node, { id: "keep", name: "size", value: "large" }];
    const values = [{ name: "color", value: "" }, { name: "Color", value: "blue" }];
    assert.deepEqual(mergeVariableClipboard(original, values, () => "new-" + (++counter)), [
        { id: "old", name: "color", value: "" }, { id: "keep", name: "size", value: "large" },
        { id: "new-1", name: "Color", value: "blue" },
    ]);
    assert.equal(original[0].value, "red");
    assert.deepEqual(values[0], { name: "color", value: "" });
});

test("failed whole-list validation never mutates the destination", () => {
    const original = Array.from({ length: 100 }, (_, i) => ({ id: "" + i, name: "v" + i, value: "" }));
    const before = structuredClone(original);
    assert.throws(() => mergeVariableClipboard(original, [{ name: "extra", value: "x" }], () => "extra"));
    assert.deepEqual(original, before);
    assert.throws(() => mergeVariableClipboard(node, [{ name: "color", value: "blue" }, { name: "bad name", value: "x" }], () => "new"));
    assert.equal(node[0].value, "red");
});

test("normalization drops obsolete shared links without changing workflow values", () => {
    assert.deepEqual(normalizeVariables([{ ...node[0], library_id: "legacy-shared-link" }]), node);
});
