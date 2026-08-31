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
)).replace("./prompt_weaver_i18n.js?v=20260901-card-context-actions-v1", i18nUrl);
const assistantUrl = `data:text/javascript;base64,${Buffer.from(assistantSource).toString("base64")}`;
const moduleSource = (await readFile(
    new URL("../web/prompt_tag_autocomplete.js", import.meta.url),
    "utf8",
))
    .replace("./prompt_weaver_i18n.js?v=20260901-card-context-actions-v1", i18nUrl)
    .replace("./prompt_assistant_tags.js?v=20260825-matched-alias-v1", assistantUrl);
const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`;
const {
    AUTOCOMPLETE_LIMIT_SETTING_ID,
    AUTOCOMPLETE_SOURCE_ORDER_SETTING_ID,
    AUTOCOMPLETE_POPUP_HEIGHT_STORAGE_KEY,
    DANBOORU_UPDATE_POLL_MS,
    DANBOORU_UPDATE_TIMEOUT_MS,
    DEFAULT_AUTOCOMPLETE_LIMIT,
    DEFAULT_AUTOCOMPLETE_SOURCE_ORDER,
    DEFAULT_AUTOCOMPLETE_POPUP_HEIGHT,
    MAX_AUTOCOMPLETE_LIMIT,
    MAX_AUTOCOMPLETE_POPUP_HEIGHT,
    MIN_AUTOCOMPLETE_LIMIT,
    MIN_AUTOCOMPLETE_POPUP_HEIGHT,
    DanbooruTagProvider,
    PromptAssistantTagProvider,
    PromptTagAutocompleteProvider,
    applyPromptCompletion,
    applyPromptCompletionWithSeparator,
    autocompleteHighlightRanges,
    autocompleteInputOwnsFocus,
    autocompleteQueryIsEligible,
    autocompleteTranslationText,
    formatAutocompleteCount,
    mergeAutocompleteResults,
    normalizeAutocompleteLimit,
    normalizeAutocompletePopupHeight,
    normalizeAutocompleteSourceOrder,
    normalizeAutocompleteInsertionKey,
    persistAutocompletePopupHeight,
    promptTokenHasHanText,
    promptTokenLookupText,
    promptPresenceKeys,
    readAutocompletePopupHeight,
    resizedAutocompletePopupHeight,
    resolveAutocompletePopupPosition,
    resolvePromptCompletionContext,
} = await import(moduleUrl);

test("manual Danbooru updates poll for up to five minutes", () => {
    assert.equal(DANBOORU_UPDATE_POLL_MS, 500);
    assert.equal(DANBOORU_UPDATE_TIMEOUT_MS, 300_000);
});

test("external autocomplete refresh only targets the focused input", async () => {
    const input = {};
    assert.equal(autocompleteInputOwnsFocus(input, input), true);
    assert.equal(autocompleteInputOwnsFocus(input, {}), false);
    assert.equal(autocompleteInputOwnsFocus(null, input), false);

    const source = await readFile(
        new URL("../web/prompt_tag_autocomplete.js", import.meta.url),
        "utf8",
    );
    assert.match(source, /this\.handleSettings = \(\) => this\.refreshForExternalChange\(\)/);
    assert.match(source, /if \(!autocompleteInputOwnsFocus\(this\.input\)\) \{[\s\S]*this\.close\(\)/);
    assert.match(source, /refreshLocale\(\) \{[\s\S]*this\.refreshForExternalChange\(\)/);
    assert.match(source, /this\.handleBlur = \(event\) => \{\s*this\.cancelPending\(\)/);
    assert.match(source, /schedule\(\{ immediate = false \} = \{\}\) \{[\s\S]*autocompleteInputOwnsFocus\(this\.input\)/);
    assert.match(source, /abortController\.signal\.aborted[\s\S]*!autocompleteInputOwnsFocus\(this\.input\)/);
});

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

test("grid completion appends a top-level comma separator", () => {
    const plain = "masterpiece, blue ey";
    assert.deepEqual(applyPromptCompletionWithSeparator(
        plain,
        resolvePromptCompletionContext(plain, plain.length),
        "blue eyes",
    ), {
        value: "masterpiece, blue eyes, ",
        cursor: 24,
    });

    const weighted = "masterpiece, ((blue_ey:1.25))";
    assert.deepEqual(applyPromptCompletionWithSeparator(
        weighted,
        resolvePromptCompletionContext(weighted, weighted.indexOf(":1.25")),
        "blue eyes",
    ), {
        value: "masterpiece, ((blue eyes:1.25)), ",
        cursor: 33,
    });

    const middle = "masterpiece, blue ey, smile";
    assert.deepEqual(applyPromptCompletionWithSeparator(
        middle,
        resolvePromptCompletionContext(middle, middle.indexOf("blue ey") + 7),
        "blue eyes",
    ), {
        value: "masterpiece, blue eyes, smile",
        cursor: 24,
    });

    const trailingSpaces = "blue ey   ";
    assert.deepEqual(applyPromptCompletionWithSeparator(
        trailingSpaces,
        resolvePromptCompletionContext(trailingSpaces, 7),
        "blue eyes",
    ), {
        value: "blue eyes, ",
        cursor: 11,
    });

    const chineseSeparator = "blue ey，smile";
    assert.deepEqual(applyPromptCompletionWithSeparator(
        chineseSeparator,
        resolvePromptCompletionContext(chineseSeparator, 7),
        "blue eyes",
    ), {
        value: "blue eyes，smile",
        cursor: 10,
    });
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

test("escaped literal parentheses use the same lookup key as Danbooru tags", () => {
    const escaped = String.raw`karin \(blue archive\)`;
    assert.equal(normalizeAutocompleteInsertionKey(escaped), "karin (blue archive)");
    assert.equal(promptPresenceKeys(escaped).has("karin (blue archive)"), true);
    assert.equal(
        promptTokenLookupText(escaped),
        escaped,
    );
});

test("Chinese queries start at one character and Latin queries at two", () => {
    assert.equal(autocompleteQueryIsEligible("蓝"), true);
    assert.equal(autocompleteQueryIsEligible("b"), false);
    assert.equal(autocompleteQueryIsEligible("bl"), true);
});

test("autocomplete source order normalizes missing, duplicate, unknown, and damaged values", () => {
    assert.equal(AUTOCOMPLETE_SOURCE_ORDER_SETTING_ID, "PromptWeaver.Autocomplete.SourceOrder");
    assert.deepEqual(DEFAULT_AUTOCOMPLETE_SOURCE_ORDER, ["prompt-assistant", "danbooru"]);
    assert.deepEqual(normalizeAutocompleteSourceOrder(undefined), ["prompt-assistant", "danbooru"]);
    assert.deepEqual(normalizeAutocompleteSourceOrder("danbooru"), ["prompt-assistant", "danbooru"]);
    assert.deepEqual(
        normalizeAutocompleteSourceOrder(["danbooru", "unknown", "danbooru"]),
        ["danbooru", "prompt-assistant"],
    );
    assert.deepEqual(normalizeAutocompleteSourceOrder(["prompt-assistant"]), ["prompt-assistant", "danbooru"]);
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

test("source order breaks equal-quality ties without overriding match quality", () => {
    const groups = [[{
        source: "danbooru",
        tag: "blue_eyes",
        insertText: "blue eyes",
        matchRank: 1,
        postCount: 1_400_000,
    }, {
        source: "danbooru",
        tag: "blue_eyeshadow",
        insertText: "blue eyeshadow",
        matchRank: 1,
        postCount: 200_000,
    }], [{
        source: "prompt-assistant",
        tag: "blue eyes custom",
        insertText: "blue eyes",
        matchRank: 1,
        postCount: 0,
    }, {
        source: "prompt-assistant",
        tag: "blue",
        insertText: "blue",
        matchRank: 0,
        postCount: 0,
    }]];
    const danbooruFirst = mergeAutocompleteResults(groups, 30, ["danbooru", "prompt-assistant"]);
    assert.deepEqual(
        danbooruFirst.map((record) => record.tag),
        ["blue", "blue_eyes", "blue_eyeshadow"],
    );
    const assistantFirst = mergeAutocompleteResults(groups, 30, ["prompt-assistant", "danbooru"]);
    assert.deepEqual(
        assistantFirst.map((record) => record.tag),
        ["blue", "blue eyes custom", "blue_eyeshadow"],
    );
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

test("Prompt Assistant displays the Chinese alias that caused a Chinese match", async () => {
    const provider = new PromptAssistantTagProvider(null, {
        catalog: {
            async load() {
                return [{
                    name: "打底裤",
                    value: "leggings",
                    aliases: ["打底裤", "紧身裤"],
                    categoryPath: ["人物", "服饰"],
                }];
            },
        },
    });
    const [record] = await provider.search("紧");
    assert.equal(record.tag, "leggings");
    assert.equal(record.translation, "紧身裤");
    assert.equal(record.insertText, "leggings");
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

test("visible autocomplete text highlights direct, separator-normalized, and fuzzy matches", () => {
    assert.deepEqual(autocompleteHighlightRanges("紧张的双手", "紧"), [
        { start: 0, end: 1 },
    ]);
    assert.deepEqual(autocompleteHighlightRanges("blue_eyes", "blue eyes"), [
        { start: 0, end: 4 },
        { start: 5, end: 9 },
    ]);
    assert.deepEqual(autocompleteHighlightRanges("blue_eyes", "bleyes"), [
        { start: 0, end: 2 },
        { start: 3, end: 4 },
        { start: 6, end: 9 },
    ]);
    assert.deepEqual(autocompleteHighlightRanges("蓝眼睛", "蓝睛"), [
        { start: 0, end: 1 },
        { start: 2, end: 3 },
    ]);
    assert.deepEqual(autocompleteHighlightRanges("ＭＡＳＴＥＲ", "mast"), [
        { start: 0, end: 4 },
    ]);
    assert.deepEqual(autocompleteHighlightRanges("blue eyes", "be"), []);
});

test("free-mode popup placement uses the caret line instead of the textarea bottom", () => {
    const position = resolveAutocompletePopupPosition({
        inputRect: { left: 20, top: 60, right: 620, bottom: 500, width: 600, height: 440 },
        anchorRect: { left: 300, top: 150, right: 300, bottom: 174, width: 0, height: 24 },
        viewportWidth: 1280,
        viewportHeight: 720,
        popupScrollHeight: 240,
        horizontalInset: 10,
    });
    assert.equal(position.openAbove, false);
    assert.equal(position.top, 178);
    assert.equal(position.left, 30);
    assert.equal(position.width, 580);
    assert.equal(position.maxHeight, 320);
});

test("popup height is normalized, persisted, and resized away from its anchor", () => {
    const values = new Map();
    const storage = {
        getItem(key) {
            return values.has(key) ? values.get(key) : null;
        },
        setItem(key, value) {
            values.set(key, value);
        },
    };
    assert.equal(AUTOCOMPLETE_POPUP_HEIGHT_STORAGE_KEY, "cpw-prompt-autocomplete-height-v1");
    assert.equal(DEFAULT_AUTOCOMPLETE_POPUP_HEIGHT, 320);
    assert.equal(MIN_AUTOCOMPLETE_POPUP_HEIGHT, 120);
    assert.equal(MAX_AUTOCOMPLETE_POPUP_HEIGHT, 720);
    assert.equal(normalizeAutocompletePopupHeight(undefined), 320);
    assert.equal(normalizeAutocompletePopupHeight(0), 120);
    assert.equal(normalizeAutocompletePopupHeight(900), 720);
    assert.equal(normalizeAutocompletePopupHeight("invalid"), 320);
    assert.equal(persistAutocompletePopupHeight(540, storage), 540);
    assert.equal(values.get(AUTOCOMPLETE_POPUP_HEIGHT_STORAGE_KEY), "540");
    assert.equal(readAutocompletePopupHeight(storage), 540);
    values.set(AUTOCOMPLETE_POPUP_HEIGHT_STORAGE_KEY, "broken");
    assert.equal(readAutocompletePopupHeight(storage), 320);
    assert.equal(resizedAutocompletePopupHeight({
        startHeight: 320,
        deltaY: 80,
        openAbove: false,
    }), 400);
    assert.equal(resizedAutocompletePopupHeight({
        startHeight: 320,
        deltaY: -80,
        openAbove: true,
    }), 400);
});

test("popup placement honors preferred height and a locked expansion direction", () => {
    const common = {
        inputRect: { left: 20, top: 560, right: 620, bottom: 600, width: 600, height: 40 },
        anchorRect: { left: 300, top: 560, right: 300, bottom: 584, width: 0, height: 24 },
        viewportWidth: 1280,
        viewportHeight: 720,
        popupScrollHeight: 900,
        preferredMaxHeight: 540,
    };
    const automatic = resolveAutocompletePopupPosition(common);
    assert.equal(automatic.openAbove, true);
    assert.equal(automatic.maxHeight, 540);
    assert.equal(automatic.bottom, 164);

    const lockedBelow = resolveAutocompletePopupPosition({
        ...common,
        forceOpenAbove: false,
    });
    assert.equal(lockedBelow.openAbove, false);
    assert.equal(lockedBelow.top, 588);
    assert.equal(lockedBelow.maxHeight, 124);
});

test("free mode suppresses initial search and autocomplete exposes header, close, and resize controls", async () => {
    const controllerSource = await readFile(
        new URL("../web/prompt_tag_autocomplete.js", import.meta.url),
        "utf8",
    );
    const gridSource = await readFile(
        new URL("../web/prompt_toggle_grid.js", import.meta.url),
        "utf8",
    );
    const styleSource = await readFile(
        new URL("../web/prompt_toggle_grid.css", import.meta.url),
        "utf8",
    );
    assert.match(gridSource, /popupHorizontalInset: 10/);
    assert.match(gridSource, /suppressInitialFocusSearch: true/);
    assert.match(controllerSource, /if \(this\.suppressNextFocusSearch\) \{[\s\S]*this\.close\(\)/);
    assert.match(controllerSource, /cpw-tag-autocomplete__header/);
    assert.match(controllerSource, /cpw-tag-autocomplete__result-count/);
    assert.match(controllerSource, /cpw-tag-autocomplete__close/);
    assert.match(controllerSource, /this\.closeButton\.addEventListener\("click", this\.handleCloseClick\)/);
    assert.match(controllerSource, /cpw-tag-autocomplete__resize-handle/);
    assert.match(controllerSource, /this\.resizeHandle\.addEventListener\("pointerdown", this\.handleResizePointerDown\)/);
    assert.match(controllerSource, /event\.relatedTarget && this\.popup\.contains\(event\.relatedTarget\)/);
    assert.match(styleSource, /\.cpw-tag-autocomplete__header\s*\{/);
    assert.match(styleSource, /\.cpw-tag-autocomplete__close\s*\{[\s\S]*position: relative;/);
    assert.match(styleSource, /\.cpw-tag-autocomplete__close::before,[\s\S]*top: 50%;[\s\S]*left: 50%;/);
    assert.match(styleSource, /translate\(-50%, -50%\) rotate\(45deg\)/);
    assert.match(styleSource, /cpw-tag-autocomplete-border-flow 6s linear infinite/);
    assert.match(styleSource, /\.cpw-tag-autocomplete--below \.cpw-tag-autocomplete__resize-handle/);
    assert.match(styleSource, /\.cpw-tag-autocomplete--above \.cpw-tag-autocomplete__resize-handle/);
    assert.match(styleSource, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.cpw-tag-autocomplete\s*\{[\s\S]*animation: none;/);
});

test("autocomplete defaults to thirty results and normalizes configured limits", () => {
    const records = Array.from({ length: 35 }, (_value, index) => ({
        source: "danbooru",
        tag: `test_${index}`,
        insertText: `test ${index}`,
        matchRank: 1,
        postCount: 25 - index,
    }));
    assert.equal(AUTOCOMPLETE_LIMIT_SETTING_ID, "PromptWeaver.Autocomplete.MaxResults");
    assert.equal(DEFAULT_AUTOCOMPLETE_LIMIT, 30);
    assert.equal(MIN_AUTOCOMPLETE_LIMIT, 1);
    assert.equal(MAX_AUTOCOMPLETE_LIMIT, 100);
    assert.equal(normalizeAutocompleteLimit(undefined), 30);
    assert.equal(normalizeAutocompleteLimit("12"), 12);
    assert.equal(normalizeAutocompleteLimit(0), 1);
    assert.equal(normalizeAutocompleteLimit(101), 100);
    assert.equal(normalizeAutocompleteLimit("invalid"), 30);
    assert.equal(mergeAutocompleteResults([records]).length, 30);
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
                        match_score: null,
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
    const result = await provider.search("蓝", "en", 12);
    assert.equal(result.results[0].insertText, "blue eyes");
    assert.equal(result.results[0].translation, "蓝眼睛");
    assert.equal(result.results[0].matchScore, null);
    assert.match(calls[1][0], /q=%E8%93%9D/);
    assert.match(calls[0][0], /locale=zh-CN/);
    assert.match(calls[1][0], /locale=zh-CN/);
    const resolved = await provider.resolve(["blue eyes"], "zh-CN");
    assert.equal(resolved.results[0].translation, "蓝眼睛");
    assert.equal(JSON.parse(calls.at(-1)[1].body).locale, "zh-CN");
    assert.equal(formatAutocompleteCount(2_535_113, "en"), "2.5M");
});

test("dual-source merge compares fuzzy quality before source and count ties", () => {
    const merged = mergeAutocompleteResults([
        [{
            source: "danbooru",
            tag: "blue_eyes",
            insertText: "blue eyes",
            matchRank: 3,
            matchScore: { start: 0, gaps: 2, length: 8 },
            postCount: 1_400_000,
        }, {
            source: "danbooru",
            tag: "black_eyes",
            insertText: "black eyes",
            matchRank: 3,
            matchScore: { start: 0, gaps: 3, length: 9 },
            postCount: 2_000_000,
        }],
        [{
            source: "prompt-assistant",
            tag: "custom blue eyes",
            insertText: "custom blue eyes",
            matchRank: 3,
            matchScore: { start: 0, gaps: 2, length: 8 },
            postCount: 0,
        }],
    ]);
    assert.deepEqual(
        merged.map((record) => record.insertText),
        ["custom blue eyes", "blue eyes", "black eyes"],
    );
});

test("translation resolution prefers Prompt Assistant, follows source toggles, and caches", async () => {
    let promptAssistantEnabled = true;
    let sourceOrder = ["prompt-assistant", "danbooru"];
    let assistantCalls = 0;
    let danbooruCalls = 0;
    const provider = new PromptTagAutocompleteProvider(null, {
        danbooruEnabled: () => true,
        promptAssistantEnabled: () => promptAssistantEnabled,
        sourceOrder: () => sourceOrder,
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

    sourceOrder = ["danbooru", "prompt-assistant"];
    assert.equal((await provider.resolveTagTranslations(["blue eyes"]))[0].translation, "丹博鲁翻译");
    assert.equal(assistantCalls, 2);
    assert.equal(danbooruCalls, 2);

    promptAssistantEnabled = false;
    assert.equal((await provider.resolveTagTranslations(["blue eyes"]))[0].translation, "丹博鲁翻译");
    assert.equal(assistantCalls, 2);
    assert.equal(danbooruCalls, 3);
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
    const settingsSource = await readFile(
        new URL("../web/prompt_translation_settings.js", import.meta.url),
        "utf8",
    );
    assert.match(source, /new PromptAutocompleteController\(\s*prompt,/);
    assert.match(source, /new PromptAutocompleteController\(\s*addInput,/);
    assert.match(source, /new PromptAutocompleteController\(\s*freeTextArea,/);
    assert.match(settingsSource, /settingId:\s*DANBOORU_SETTING_ID/);
    assert.match(settingsSource, /settingId:\s*PROMPT_ASSISTANT_SETTING_ID/);
    assert.match(settingsSource, /id:\s*AUTOCOMPLETE_SOURCE_ORDER_SETTING_ID/);
    assert.match(settingsSource, /type:\s*createAutocompleteSourceOrderControl/);
    assert.match(settingsSource, /defaultValue:\s*\[\.\.\.DEFAULT_AUTOCOMPLETE_SOURCE_ORDER\]/);
    assert.match(settingsSource, /addEventListener\("pointerdown"/);
    assert.match(settingsSource, /event\.key === "ArrowUp" \|\| event\.key === "ArrowDown"/);
    assert.doesNotMatch(settingsSource, /autocomplete-sources__move-(?:up|down)/);
    assert.match(settingsSource, /id:\s*AUTOCOMPLETE_LIMIT_SETTING_ID/);
    assert.match(settingsSource, /type:\s*"number"/);
    assert.match(settingsSource, /defaultValue:\s*30/);
    assert.match(settingsSource, /min:\s*1,[\s\S]*max:\s*100,[\s\S]*step:\s*1/);
    assert.match(settingsSource, /id:\s*TRANSLATION_MANAGER_SETTING_ID/);
    assert.match(settingsSource, /PromptWeaver\.Autocomplete\.UpdateDictionary/);
    assert.match(settingsSource, /ComfyUIPromptWeaver\.TranslationSettings/);
    assert.match(source, /prompt_tag_autocomplete\.js\?v=20260825-source-order-v1/);
    assert.match(source, /sourceOrder:\s*readAutocompleteSourceOrder/);
    assert.match(source, /new PromptAutocompleteController\(\s*prompt,[\s\S]*completionSeparator: ", "/);
    assert.equal((source.match(/completionSeparator: ", "/g) || []).length, 1);
    assert.equal((source.match(/getLimit: readAutocompleteLimit/g) || []).length, 3);
    assert.match(source, /prompt_toggle_grid\.css\?v=20260901-card-context-actions-v1/);
    const cssSource = await readFile(new URL("../web/prompt_toggle_grid.css", import.meta.url), "utf8");
    assert.match(cssSource, /PromptWeaver\.Autocomplete\.SourceOrder/);
    assert.match(cssSource, /\.cpw-autocomplete-sources\s*\{[\s\S]*border-radius:\s*10px/);
    assert.match(cssSource, /\.cpw-autocomplete-sources__placeholder/);
    assert.match(cssSource, /\.cpw-autocomplete-sources__row--dragging/);
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
    assert.match(autocompleteSource, /appendAutocompleteHighlightedText\(tag, record\.tag, highlightQuery\)/);
    assert.match(autocompleteSource, /ownerDocument\.createElement\("mark"\)/);
    assert.doesNotMatch(autocompleteSource, /\.innerHTML\s*=/);
    assert.match(cssSource, /\.cpw-tag-autocomplete__match\s*\{[\s\S]*#ff3b30[\s\S]*font-weight:\s*750/);
});

test("handled keys stay inside autocomplete and inserted text does not reopen results", async () => {
    const source = await readFile(
        new URL("../web/prompt_tag_autocomplete.js", import.meta.url),
        "utf8",
    );
    assert.match(source, /event\.stopImmediatePropagation\(\)/);
    assert.match(source, /event\.key === "Tab" && !event\.shiftKey/);
    assert.match(source, /if \(!this\.applyingCompletion\) this\.schedule\(\)/);
    assert.match(source, /this\.applyingCompletion = true;[\s\S]*dispatchEvent[\s\S]*finally/);
});
