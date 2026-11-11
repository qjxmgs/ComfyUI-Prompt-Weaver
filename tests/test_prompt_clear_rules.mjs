import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { clearPromptKeys, createFilteredPromptEdit, filteredCardPrompt } from "../web/prompt_clear_rules.js";
import { splitPromptTokens } from "../web/prompt_editor_tokens.js";

const cases = JSON.parse(readFileSync(new URL("./clear_prompt_cases.json", import.meta.url), "utf8"));
for (const fixture of cases) {
    test(fixture.name, () => {
        const variables = fixture.variables ?? [];
        const keys = clearPromptKeys(fixture.clear_prompts?.prompt, variables);
        for (const { prompt, marked } of fixture.cards) {
            const markedTags = splitPromptTokens(prompt).filter((tag) => filteredCardPrompt(tag, variables, keys) !== null);
            assert.deepEqual(markedTags, marked);
        }
    });
}

test("undefined variables do not preview a misleading match", () => {
    assert.equal(clearPromptKeys("{missing}, blue eyes", []).size, 0);
    assert.equal(filteredCardPrompt("{missing}, blue eyes", [], new Set(["blue eyes"])), null);
});

test("card preview keeps surviving variable tokens and distinguishes an empty result", () => {
    const keys = clearPromptKeys("censored", []);
    const variables = [{ name: "tags", value: "censored, smile" }];
    assert.equal(filteredCardPrompt("CENSORED, {tags}, (censored:1.25), uncensored", variables, keys), "smile, uncensored");
    assert.equal(filteredCardPrompt("censored", variables, keys), "");
    assert.equal(filteredCardPrompt("uncensored， bright sunlight", variables, keys), null);
});

test("editing an empty filtered preview preserves original hidden tags on every keystroke", () => {
    const keys = clearPromptKeys("censored", []);
    const edit = createFilteredPromptEdit("censored, (CENSORED:1.25)", [], keys);
    assert.equal(edit("s"), "censored, (CENSORED:1.25), s");
    assert.equal(edit("smile"), "censored, (CENSORED:1.25), smile");
    assert.equal(edit(""), "censored, (CENSORED:1.25)");
});

test("edits preserve untouched variable references and the hidden part of a touched expansion", () => {
    const keys = clearPromptKeys("censored", []);
    const variables = [
        { name: "tags", value: "censored, smile, {literal}" },
        { name: "light", value: "sunlight" },
    ];
    const edit = createFilteredPromptEdit("warm, {tags}, {light}", variables, keys);
    assert.equal(edit("warm, smile, {literal}, moonlight"), "warm, {tags}, moonlight");
    assert.equal(edit("warm, happy, {literal}, sunlight"), "warm, censored, happy, \\{literal}, {light}");
    assert.equal(edit("warm, smile, gentle, {literal}, sunlight"), "warm, censored, smile, gentle, \\{literal}, {light}");
    assert.equal(edit("warm, sunlight"), "warm, censored, {light}");
});

test("editing text outside a visible variable keeps that variable when a hidden variable precedes it", () => {
    const keys = clearPromptKeys("censored", []);
    const variables = [{ name: "hide", value: "censored" }, { name: "show", value: "smile" }];
    const edit = createFilteredPromptEdit("{hide}, {show}", variables, keys);
    assert.equal(edit("bright, smile, calm"), "{hide}, bright, smile, calm");
    assert.equal(edit("smile, calm"), "{hide}, {show}, calm");
    assert.equal(edit(""), "{hide}");
});
