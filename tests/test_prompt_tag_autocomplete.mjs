import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const i18nSource = await readFile(
    new URL("../web/prompt_weaver_i18n.js", import.meta.url),
    "utf8",
);
const i18nUrl = `data:text/javascript;base64,${Buffer.from(i18nSource).toString("base64")}`;
const assistantSource = (await readFile(
    new URL("../web/prompt_assistant_tags.js", import.meta.url),
    "utf8",
)).replace("./prompt_weaver_i18n.js", i18nUrl);
const assistantUrl = `data:text/javascript;base64,${Buffer.from(assistantSource).toString("base64")}`;
const moduleSource = (await readFile(
    new URL("../web/prompt_tag_autocomplete.js", import.meta.url),
    "utf8",
))
    .replace("./prompt_weaver_i18n.js", i18nUrl)
    .replace("./prompt_assistant_tags.js", assistantUrl);
const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`;
const {
    DEFAULT_AUTOCOMPLETE_LIMIT,
    DanbooruTagProvider,
    PromptAssistantTagProvider,
    PromptTagAutocompleteProvider,
    applyPromptCompletion,
    autocompleteQueryIsEligible,
    autocompleteTranslationText,
    formatAutocompleteCount,
    mergeAutocompleteResults,
    normalizeAutocompleteInsertionKey,
    promptTokenHasHanText,
    promptTokenLookupText,
    promptPresenceKeys,
    resolveAutocompletePopupPosition,
    resolvePromptCompletionContext,
} = await import(moduleUrl);

function jsonResponse(payload, ok = true, status = 200) {
    return {
        ok,
        status,
        async json() {
            return payload;
        },
    };
}

test("completion context preserves separators, wrappers, weights, and apostrophes", () => {
    const plain = "masterpiece, blue ey, smile";
    assert.deepEqual(resolvePromptCompletionContext(plain, 20), {
        start: 13,
        end: 20,
        query: "blue ey",
    });
    assert.deepEqual(applyPromptCompletion(
        plain,
        resolvePromptCompletionContext(plain, 20),
        "blue eyes",
    ), {
        value: "masterpiece, blue eyes, smile",
        cursor: 22,
    });

    const weighted = "masterpiece, ((blue_ey:1.25)), smile";
    const weightedContext = resolvePromptCompletionContext(weighted, weighted.indexOf(":1.25"));
    assert.equal(weightedContext.query, "blue_ey");
    assert.equal(
        applyPromptCompletion(weighted, weightedContext, "blue eyes").value,
        "masterpiece, ((blue eyes:1.25)), smile",
    );

    const quoted = 'portrait, "blue_ey", smile';
    const quotedContext = resolvePromptCompletionContext(quoted, quoted.indexOf("blue_ey") + 7);
    assert.equal(quotedContext.query, "blue_ey");
    assert.equal(applyPromptCompletion(quoted, quotedContext, "blue eyes").value, 'portrait, "blue eyes", smile');

    const apostrophe = "artist's_style, blue_ey";
    assert.equal(resolvePromptCompletionContext(apostrophe, 6).query, "artist's_style");
});

test("editor token lookup strips wrappers and weights and detects Chinese tokens", () => {
    assert.equal(promptTokenLookupText("((blue_eyes:1.25))"), "blue_eyes");
    assert.equal(promptTokenLookupText('"blue eyes"'), "blue eyes");
    assert.equal(promptTokenHasHanText("blue eyes"), false);
    assert.equal(promptTokenHasHanText("蓝眼睛"), true);
    assert.equal(promptTokenHasHanText("blue 蓝"), true);
});

test("presence keys normalize underscores and spaces without touching protected commas", () => {
    const keys = promptPresenceKeys("blue_eyes, (red_hair:1.2), 'artist, name'");
    assert.equal(keys.has("blue eyes"), true);
    assert.equal(keys.has("red hair"), true);
    assert.equal(keys.has("artist, name"), true);
    assert.equal(normalizeAutocompleteInsertionKey(" BLUE__EYES "), "blue eyes");
});

test("Chinese queries start at one character and Latin queries at two", () => {
    assert.equal(autocompleteQueryIsEligible("蓝"), true);
    assert.equal(autocompleteQueryIsEligible("b"), false);
    assert.equal(autocompleteQueryIsEligible("bl"), true);
});

test("dual-source merge ranks matches, prefers Prompt Assistant, and deduplicates insertions", () => {
    const merged = mergeAutocompleteResults([
        [
            {
                source: "danbooru",
                tag: "blue_eyes",
                insertText: "blue eyes",
                matchRank: 1,
                postCount: 1_400_000,
            },
            {
                source: "danbooru",
                tag: "blush",
                insertText: "blush",
                matchRank: 1,
                postCount: 2_500_000,
            },
        ],
        [
            {
                source: "prompt-assistant",
                tag: "蓝眼睛",
                insertText: "blue_eyes",
                matchRank: 1,
                postCount: 0,
            },
            {
                source: "prompt-assistant",
                tag: "杰作",
                insertText: "masterpiece",
                matchRank: 0,
                postCount: 0,
            },
        ],
    ]);
    assert.deepEqual(merged.map((record) => record.tag), ["杰作", "蓝眼睛", "blush"]);
});

test("Prompt Assistant maps English above Chinese while preserving English insertion and category", async () => {
    const provider = new PromptAssistantTagProvider(null, {
        catalog: {
            async load() {
                return [{
                    name: "蓝眼睛",
                    value: "blue eyes",
                    aliases: ["蓝眼睛"],
                    categoryPath: ["人物", "眼睛"],
                }];
            },
        },
    });
    const [record] = await provider.search("蓝");
    assert.equal(record.tag, "blue eyes");
    assert.equal(record.translation, "蓝眼睛");
    assert.equal(record.insertText, "blue eyes");
    assert.deepEqual(record.categoryPath, ["人物", "眼睛"]);
    assert.equal(record.postCount, 0);
});

test("Prompt Assistant batch resolution is exact and preserves missing entries", async () => {
    const provider = new PromptAssistantTagProvider(null, {
        catalog: {
            async load() {
                return [{ name: "蓝眼睛", value: "blue eyes", aliases: ["蓝眼睛"] }];
            },
        },
    });
    const results = await provider.resolve(["blue_eyes", "blue"]);
    assert.equal(results[0].translation, "蓝眼睛");
    assert.equal(results[0].insertText, "blue eyes");
    assert.equal(results[1], null);
});

test("translation display uses an em dash when Chinese text is unavailable", () => {
    assert.equal(autocompleteTranslationText({ tag: "blue_eyes", translation: "蓝眼睛" }), "蓝眼睛");
    assert.equal(autocompleteTranslationText({ tag: "blue_eyes", translation: "" }), "—");
    assert.equal(autocompleteTranslationText({ tag: "blue eyes", translation: "blue eyes" }), "—");
});

test("free-mode popup placement uses the caret line instead of the textarea bottom", () => {
    const position = resolveAutocompletePopupPosition({
        inputRect: { left: 20, top: 60, right: 620, bottom: 500, width: 600, height: 440 },
        anchorRect: { left: 300, top: 150, right: 300, bottom: 174, width: 0, height: 24 },
        viewportWidth: 1280,
        viewportHeight: 720,
        popupScrollHeight: 240,
    });
    assert.equal(position.openAbove, false);
    assert.equal(position.top, 178);
    assert.equal(position.left, 20);
    assert.equal(position.width, 600);
});

test("autocomplete defaults to twenty results", () => {
    const records = Array.from({ length: 25 }, (_value, index) => ({
        source: "danbooru",
        tag: `test_${index}`,
        insertText: `test ${index}`,
        matchRank: 1,
        postCount: 25 - index,
    }));
    assert.equal(DEFAULT_AUTOCOMPLETE_LIMIT, 20);
    assert.equal(mergeAutocompleteResults([records]).length, 20);
});

test("Danbooru provider keeps status local, maps rows, and starts updates", async () => {
    const calls = [];
    const api = {
        async fetchApi(path, options = {}) {
            calls.push([path, options]);
            if (path.startsWith("/prompt-weaver/tag-autocomplete/status")) {
                return jsonResponse({ available: true, updating: false, row_count: 32259 });
            }
            if (path.startsWith("/prompt-weaver/tag-autocomplete/search")) {
                return jsonResponse({
                    results: [{
                        tag: "blue_eyes",
                        insert_text: "blue eyes",
                        translation: "蓝眼睛",
                        category: 0,
                        post_count: 1_409_152,
                        match_rank: 1,
                    }],
                });
            }
            if (path === "/prompt-weaver/tag-autocomplete/resolve") {
                return jsonResponse({
                    results: [{
                        tag: "blue_eyes",
                        insert_text: "blue eyes",
                        translation: "蓝眼睛",
                        category: 0,
                        post_count: 1_409_152,
                    }],
                });
            }
            if (path === "/prompt-weaver/tag-autocomplete/update") {
                return jsonResponse({ updating: true }, true, 202);
            }
            throw new Error(`unexpected path ${path}`);
        },
    };
    const provider = new DanbooruTagProvider(api, { statusTtlMs: 60_000 });
    const result = await provider.search("蓝", "zh", 12);
    assert.equal(result.results[0].insertText, "blue eyes");
    assert.equal(result.results[0].translation, "蓝眼睛");
    assert.match(calls[1][0], /q=%E8%93%9D/);
    const resolved = await provider.resolve(["blue eyes"], "zh-CN");
    assert.equal(resolved.results[0].translation, "蓝眼睛");
    assert.equal(JSON.parse(calls.at(-1)[1].body).locale, "zh-CN");
    assert.equal(formatAutocompleteCount(2_535_113, "en"), "2.5M");
});

test("translation resolution prefers Prompt Assistant, follows source toggles, and caches", async () => {
    let promptAssistantEnabled = true;
    let assistantCalls = 0;
    let danbooruCalls = 0;
    const provider = new PromptTagAutocompleteProvider(null, {
        danbooruEnabled: () => true,
        promptAssistantEnabled: () => promptAssistantEnabled,
    });
    provider.danbooru = {
        async resolve(tags) {
            danbooruCalls += 1;
            return {
                results: tags.map(() => ({
                    source: "danbooru",
                    tag: "blue_eyes",
                    insertText: "blue eyes",
                    translation: "丹博鲁翻译",
                })),
            };
        },
    };
    provider.promptAssistant = {
        async resolve(tags) {
            assistantCalls += 1;
            return tags.map(() => ({
                source: "prompt-assistant",
                tag: "blue eyes",
                insertText: "blue eyes",
                translation: "自定义翻译",
            }));
        },
    };
    assert.equal((await provider.resolveTagTranslations(["blue eyes"]))[0].translation, "自定义翻译");
    assert.equal((await provider.resolveTagTranslations(["blue_eyes"]))[0].translation, "自定义翻译");
    assert.equal(assistantCalls, 1);
    assert.equal(danbooruCalls, 1);

    promptAssistantEnabled = false;
    assert.equal((await provider.resolveTagTranslations(["blue eyes"]))[0].translation, "丹博鲁翻译");
    assert.equal(assistantCalls, 1);
    assert.equal(danbooruCalls, 2);
});

test("translation resolution honors cancellation before starting provider work", async () => {
    const provider = new PromptTagAutocompleteProvider(null);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        provider.resolveTagTranslations(["blue eyes"], "zh-CN", { signal: controller.signal }),
        (error) => error?.name === "AbortError",
    );
});

test("provider toggles let either source work independently", async () => {
    const provider = new PromptTagAutocompleteProvider(null, {
        danbooruEnabled: () => true,
        promptAssistantEnabled: () => false,
    });
    provider.danbooru = {
        async search() {
            return {
                status: { available: true },
                results: [{
                    source: "danbooru",
                    tag: "blush",
                    insertText: "blush",
                    matchRank: 1,
                    postCount: 2_535_113,
                }],
            };
        },
    };
    assert.deepEqual(
        (await provider.search("bl", "en")).results.map((record) => record.tag),
        ["blush"],
    );
});

test("prompt grid source wires autocomplete into all three requested input surfaces", async () => {
    const source = await readFile(new URL("../web/prompt_toggle_grid.js", import.meta.url), "utf8");
    assert.match(source, /new PromptAutocompleteController\(\s*prompt,/);
    assert.match(source, /new PromptAutocompleteController\(\s*addInput,/);
    assert.match(source, /new PromptAutocompleteController\(\s*freeTextArea,/);
    assert.match(source, /id:\s*DANBOORU_SETTING_ID/);
    assert.match(source, /id:\s*PROMPT_ASSISTANT_SETTING_ID/);
    assert.match(source, /PromptWeaver\.Autocomplete\.UpdateDictionary/);
    assert.match(source, /prompt_tag_autocomplete\.js\?v=20260814-bilingual-tokens-v2/);
});

test("non-free editor renders every token as two rows and keeps add button square", async () => {
    const source = await readFile(new URL("../web/prompt_toggle_grid.js", import.meta.url), "utf8");
    const cssSource = await readFile(new URL("../web/prompt_toggle_grid.css", import.meta.url), "utf8");
    assert.match(source, /cpw-prompt-editor__token-prompt/);
    assert.match(source, /cpw-prompt-editor__token-translation/);
    assert.match(source, /"cpw-prompt-editor__token-translation",\s*"—"/);
    assert.match(source, /resolveTagTranslations/);
    assert.match(source, /generation !== tokenTranslationGeneration/);
    assert.match(cssSource, /\.cpw-prompt-editor__token\s*\{[\s\S]*flex-direction:\s*column/);
    assert.match(cssSource, /\.cpw-prompt-editor__token-translation/);
    assert.match(
        cssSource,
        /\.cpw-prompt-editor__add\s*\{[\s\S]*width:\s*44px;[\s\S]*height:\s*44px;[\s\S]*aspect-ratio:\s*1;/,
    );
});

test("result DOM and CSS use prompt, category, source, and count columns", async () => {
    const autocompleteSource = await readFile(
        new URL("../web/prompt_tag_autocomplete.js", import.meta.url),
        "utf8",
    );
    const cssSource = await readFile(new URL("../web/prompt_toggle_grid.css", import.meta.url), "utf8");
    assert.match(autocompleteSource, /option\.append\(main, category, source, count\)/);
    assert.match(
        cssSource,
        /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(72px, auto\) auto minmax\(54px, auto\)/,
    );
});

test("handled keys stay inside autocomplete and inserted text does not reopen results", async () => {
    const source = await readFile(
        new URL("../web/prompt_tag_autocomplete.js", import.meta.url),
        "utf8",
    );
    assert.match(source, /event\.stopImmediatePropagation\(\)/);
    assert.match(source, /if \(!this\.applyingCompletion\) this\.schedule\(\)/);
    assert.match(source, /this\.applyingCompletion = true;[\s\S]*dispatchEvent[\s\S]*finally/);
});
