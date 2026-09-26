import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../web/prompt_variables.js", import.meta.url), "utf8");
const {
    normalizeVariables,
    variableSuggestionContext,
    completeVariableReference,
    replaceVariableReferences,
    renameVariableReferences,
    variableReferenceCount,
} = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

test("variables validate NFC Unicode names, uniqueness and optional empty values", () => {
    assert.deepEqual(normalizeVariables([{ id: "1", name: "颜色_2", value: "red" }]), [
        { id: "1", name: "颜色_2", value: "red" },
    ]);
    assert.throws(() => normalizeVariables([{ id: "1", name: "1color", value: "red" }]));
    assert.throws(() => normalizeVariables([{ id: "1", name: "e\u0301", value: "red" }]));
    assert.deepEqual(normalizeVariables([{ id: "1", name: "x", value: "" }]), [
        { id: "1", name: "x", value: "" },
    ]);
    assert.deepEqual(normalizeVariables([{ id: "1", name: "x", value: " " }]), [
        { id: "1", name: "x", value: " " },
    ]);
    assert.throws(() => normalizeVariables([{ id: "1", name: "x", value: null }]));
    assert.throws(() => normalizeVariables([{ id: "1", name: "x", value: "x".repeat(10_001) }]));
    assert.throws(() => normalizeVariables([
        { id: "1", name: "x", value: "a" }, { id: "2", name: "x", value: "b" },
    ]));
    assert.throws(() => normalizeVariables(null));
});

test("variable completion replaces a partial reference at the caret without duplicating braces", () => {
    const text = "before {co|lor} after".replace("|", "");
    const cursor = "before {co".length;
    const context = variableSuggestionContext(text, cursor);
    assert.equal(context.query, "co");
    assert.deepEqual(completeVariableReference(text, context, "color"), {
        value: "before {color} after", cursor: "before {color}".length,
    });
    assert.equal(variableSuggestionContext("\\{co", 4), null);
    assert.equal(variableSuggestionContext("{1", 2), null);
    assert.equal(variableSuggestionContext("{颜", 2)?.query, "颜");
});

test("renaming updates only unescaped references in cards and retained tokens", () => {
    const items = [{
        id: "card", prompt: String.raw`{color}, \{color}, {other}`,
        prompt_tokens: [
            { text: "{color}", selected: true },
            { text: String.raw`\{color}`, selected: false },
        ],
    }];
    assert.equal(variableReferenceCount(items, "color"), 1);
    const renamed = renameVariableReferences(items, "color", "颜色");
    assert.equal(renamed[0].prompt, String.raw`{颜色}, \{color}, {other}`);
    assert.deepEqual(renamed[0].prompt_tokens.map((token) => token.text), [
        "{颜色}", String.raw`\{color}`,
    ]);
    assert.equal(replaceVariableReferences("{color}", "color", "blue"), "{blue}");
    assert.equal(items[0].prompt, String.raw`{color}, \{color}, {other}`);
});

test("grid integrates variable storage, history, editor completion and locale resources", async () => {
    const grid = await readFile(new URL("../web/prompt_toggle_grid.js", import.meta.url), "utf8");
    const css = await readFile(new URL("../web/prompt_toggle_grid.css", import.meta.url), "utf8");
    const en = JSON.parse(await readFile(new URL("../locales/en/main.json", import.meta.url), "utf8"));
    const zh = JSON.parse(await readFile(new URL("../locales/zh/main.json", import.meta.url), "utf8"));
    assert.match(grid, /manageFavoritesButton,\s*manageVariablesButton,/);
    assert.match(grid, /variables: state\?\.variables \?\? \[\]/);
    assert.match(grid, /state\.items = renameVariableReferences\(/);
    assert.match(grid, /graph\?\.beforeChange\?\.\(node\)/);
    assert.match(grid, /graph\?\.afterChange\?\.\(node\)/);
    assert.match(grid, /new VariableSuggestionController\(freeTextArea/);
    assert.match(grid, /new VariableSuggestionController\(addInput/);
    assert.match(css, /assets\/icons\/ic_var\.png/);
    const enUi = en.promptWeaver.ui;
    const zhUi = zh.promptWeaver.ui;
    assert.deepEqual(Object.keys(enUi).sort(), Object.keys(zhUi).sort());
    assert.equal(enUi["Variable Manager"], "Variable Manager");
    assert.equal(zhUi["Variable Manager"], "变量管理");
});

test("variable manager matches the compact favorite-window chrome without changing manual order", async () => {
    const ui = await readFile(new URL("../web/prompt_variable_ui.js", import.meta.url), "utf8");
    const css = await readFile(new URL("../web/prompt_toggle_grid.css", import.meta.url), "utf8");
    const en = JSON.parse(await readFile(new URL("../locales/en/main.json", import.meta.url), "utf8")).promptWeaver.ui;
    const zh = JSON.parse(await readFile(new URL("../locales/zh/main.json", import.meta.url), "utf8")).promptWeaver.ui;
    assert.match(ui, /header\.append\(heading, closeButton\)/);
    assert.match(ui, /dialog\.append\(header, main\)/);
    assert.match(ui, /listHeader\.append\(listTitle, message, addButton\)/);
    assert.match(ui, /listSection\.append\(listHeader, columnHeader, list\)/);
    assert.match(ui, /setMessage\("Variable added\."[^\n]*dismissAfterMs: 3000/);
    assert.match(ui, /clearTimeout\(messageTimer\);[\s\S]*messageTimer = setTimeout\(\(\) => setMessage\(""\), dismissAfterMs\)/);
    assert.match(ui, /closed = true;[\s\S]*clearTimeout\(messageTimer\)/);
    assert.match(ui, /main\.append\(listSection\)/);
    assert.doesNotMatch(ui, /addPanel|addName|addValue/);
    assert.match(ui, /const row = element\("div", "cpw-variable-manager__row cpw-variable-manager__row--draft"\)/);
    assert.match(ui, /const id = onAdd\(draft\.name, draft\.value\)/);
    assert.match(ui, /else if \(draft\) cancelDraft\(\)/);
    assert.match(ui, /onReorder\(draggedId, variable\.id, after\)/);
    assert.match(ui, /event\.key === "ArrowUp"/);
    assert.match(ui, /prompt-weaver-variable-manager-geometry-v2/);
    assert.match(ui, /prompt-weaver-variable-manager-geometry-v1/);
    assert.match(css, /\.cpw-variable-manager__main\s*\{[^}]*overflow-y:\s*auto/s);
    assert.match(css, /\.cpw-variable-manager__list\s*\{[^}]*overflow:\s*auto/s);
    assert.match(css, /@container \(max-width: 720px\)/);
    assert.match(css, /\.cpw-variable-manager__list-header\s*\{[^}]*justify-content:\s*space-between/s);
    assert.match(css, /\.cpw-variable-manager__message\s*\{[^}]*flex:\s*1 1 auto/s);
    assert.match(css, /\.cpw-variable-manager__message--success\s*\{[^}]*color:\s*color-mix\(in srgb, #45b978 65%, var\(--cpw-vm-text\)\)/s);
    assert.match(css, /\.cpw-variable-manager__header\s*\{[^}]*height:\s*38px/s);
    assert.match(css, /\.cpw-variable-manager__title\s*\{[^}]*font:\s*700 13px/s);
    assert.match(css, /\.cpw-variable-manager__close\s*\{[^}]*width:\s*26px/s);
    assert.match(css, /\.cpw-variable-manager\s*\{[^}]*font:\s*12px/s);
    assert.match(css, /\.cpw-variable-manager__button--primary\s*\{[^}]*#286ad9/s);
    for (const key of [
        "New Variable", "Cancel new variable", "Variable List ({count})", "Actions",
        "Enter variable name", "Enter variable value", "Clear variable value",
    ]) {
        assert.equal(en[key], key);
        assert.ok(zh[key]);
    }
    for (const key of ["New Variable", "Variable List ({count})", "Actions", "Clear variable value"]) {
        assert.notEqual(zh[key], key);
    }
    assert.match(ui, /const valueCell = element\("div", "cpw-variable-manager__value-cell"\)/);
    assert.match(ui, /clearValue\.addEventListener\("click",/);
    assert.match(ui, /onUpdate\(variable\.id, "value", ""\)/);
    assert.match(ui, /clearValue\.disabled = true;[\s\S]*value\.focus\(\)/);
    assert.match(ui, /clearValue\.setAttribute\("aria-label", t\("Clear variable value"\)\)/);
    assert.match(css, /\.cpw-variable-manager__input\s*\{[^}]*resize:\s*none/s);
    assert.match(css, /\.cpw-variable-manager__value-cell\s*\{[^}]*border:\s*1px/);
    assert.match(css, /\.cpw-variable-manager__value-cell \.cpw-variable-manager__value\s*\{[^}]*border:\s*0/s);
    assert.match(css, /\.cpw-variable-manager__clear-value\s*\{[^}]*margin-right:\s*4px/s);
    assert.doesNotMatch(css, /\.cpw-variable-manager__add-panel/);
    assert.match(css, /\.cpw-variable-manager__remove\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px/s);
    assert.doesNotMatch(ui, /headerIcon|subtitle|footerText|footerIcon/);
    assert.doesNotMatch(css, /\.cpw-variable-manager__(?:header-icon|subtitle|footer)/);
    assert.equal(en["Manage variables for this grid node. Add, edit, and drag to reorder."], undefined);
    assert.equal(zh["Drag the left handle to reorder. Changes are saved automatically."], undefined);
    assert.doesNotMatch(ui, /sortBy|createdAt|sortOrder/);
});
