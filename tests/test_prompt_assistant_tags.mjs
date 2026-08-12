import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const i18nSource = await readFile(
    new URL("../web/prompt_weaver_i18n.js", import.meta.url),
    "utf8",
);
const i18nUrl = `data:text/javascript;base64,${Buffer.from(i18nSource).toString("base64")}`;
const moduleSource = (await readFile(
    new URL("../web/prompt_assistant_tags.js", import.meta.url),
    "utf8",
)).replace("./prompt_weaver_i18n.js", i18nUrl);
const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`;
const {
    PromptAssistantTagCatalog,
    findPromptAssistantApiBases,
    flattenPromptAssistantTagData,
    formatPromptAssistantTagOption,
    mergePromptAssistantTagRecords,
    movePromptAssistantSuggestionIndex,
    normalizePromptAssistantSearchText,
    promptAssistantQueryIsEligible,
    searchPromptAssistantTags,
    validatePromptAssistantTagFiles,
} = await import(moduleUrl);

function jsonResponse(payload, ok = true) {
    return {
        ok,
        async json() {
            return payload;
        },
    };
}

test("discovers canonical and renamed Prompt Assistant extension directories", () => {
    assert.deepEqual(
        findPromptAssistantApiBases([
            "/extensions/Unrelated/modules/tag.js",
            "/extensions/ComfyUI-Prompt-Assistant/modules/tag.js",
            "http://localhost:8188/extensions/prompt-assistant/modules/tag.js",
            "/extensions/comfyui_prompt_assistant/modules/tag.js",
            "/extensions/ComfyUI-Prompt-Assistant/modules/tag.js",
            "/extensions/ComfyUI-Prompt-Assistant/index.js",
        ]),
        [
            "/ComfyUI-Prompt-Assistant/api",
            "/prompt-assistant/api",
            "/comfyui_prompt_assistant/api",
        ],
    );
});

test("validates and deduplicates safe CSV file names", () => {
    assert.deepEqual(
        validatePromptAssistantTagFiles({ success: true, files: ["默认标签.csv", "额外.csv", "默认标签.csv"] }),
        ["默认标签.csv", "额外.csv"],
    );
    assert.throws(
        () => validatePromptAssistantTagFiles({ success: true, files: ["../标签.csv"] }),
        /invalid tag file name/,
    );
    assert.throws(() => validatePromptAssistantTagFiles({ files: [] }), /file list is invalid/);
});

test("flattens nested CSV data while preserving source order and category paths", () => {
    assert.deepEqual(
        flattenPromptAssistantTagData({
            常规标签: {
                画质: {
                    杰作: "masterpiece",
                    提高质量: " HDR,UHD,8K ",
                },
            },
            人物类: {
                眼睛: {
                    蓝眼睛: "blue eyes",
                },
            },
        }, "默认标签.csv"),
        [
            {
                name: "杰作",
                value: "masterpiece",
                aliases: ["杰作"],
                categoryPath: ["常规标签", "画质"],
                sourceFile: "默认标签.csv",
            },
            {
                name: "提高质量",
                value: "HDR,UHD,8K",
                aliases: ["提高质量"],
                categoryPath: ["常规标签", "画质"],
                sourceFile: "默认标签.csv",
            },
            {
                name: "蓝眼睛",
                value: "blue eyes",
                aliases: ["蓝眼睛"],
                categoryPath: ["人物类", "眼睛"],
                sourceFile: "默认标签.csv",
            },
        ],
    );
    assert.throws(
        () => flattenPromptAssistantTagData({ 分类: ["invalid"] }, "错误.csv"),
        /non-object group or non-string tag/,
    );
});

test("merges duplicate English values but keeps every Chinese alias searchable", () => {
    const records = mergePromptAssistantTagRecords([
        { name: "杰作", value: "masterpiece", aliases: ["杰作"], sourceFile: "a.csv" },
        { name: "大师作品", value: "MasterPiece", aliases: ["大师作品"], sourceFile: "b.csv" },
        { name: "蓝眼睛", value: "blue eyes", aliases: ["蓝眼睛"], sourceFile: "b.csv" },
    ]);
    assert.equal(records.length, 2);
    assert.deepEqual(records[0].aliases, ["杰作", "大师作品"]);
    assert.equal(searchPromptAssistantTags(records, "大师")[0], records[0]);
    assert.equal(formatPromptAssistantTagOption(records[0]), "masterpiece (杰作)");
});

test("matches Chinese from one character and English from two characters", () => {
    const records = mergePromptAssistantTagRecords([
        { name: "杰作", value: "masterpiece", aliases: ["杰作"] },
        { name: "超高分辨率", value: "ultra-highres", aliases: ["超高分辨率"] },
    ]);
    assert.equal(promptAssistantQueryIsEligible("杰"), true);
    assert.equal(promptAssistantQueryIsEligible("m"), false);
    assert.equal(promptAssistantQueryIsEligible("ma"), true);
    assert.equal(searchPromptAssistantTags(records, "杰")[0].value, "masterpiece");
    assert.equal(searchPromptAssistantTags(records, "MAST")[0].name, "杰作");
    assert.deepEqual(searchPromptAssistantTags(records, "m"), []);
    assert.equal(normalizePromptAssistantSearchText(" ＭＡＳＴ "), "mast");
});

test("ranks exact before prefix before substring and applies a stable result limit", () => {
    const records = mergePromptAssistantTagRecords([
        { name: "超级杰作", value: "super masterpiece", aliases: ["超级杰作"] },
        { name: "杰作风格", value: "masterpiece style", aliases: ["杰作风格"] },
        { name: "杰作", value: "masterpiece", aliases: ["杰作"] },
        ...Array.from({ length: 20 }, (_value, index) => ({
            name: `测试标签 ${index}`,
            value: `test tag ${index}`,
            aliases: [`测试标签 ${index}`],
        })),
    ]);
    assert.deepEqual(
        searchPromptAssistantTags(records, "杰作").map((record) => record.name),
        ["杰作", "杰作风格", "超级杰作"],
    );
    const limited = searchPromptAssistantTags(records, "test");
    assert.equal(limited.length, 20);
    assert.equal(limited[0].value, "test tag 0");
    assert.equal(limited[19].value, "test tag 19");
});

test("keyboard suggestion navigation starts unselected and wraps", () => {
    assert.equal(movePromptAssistantSuggestionIndex(-1, 3, 1), 0);
    assert.equal(movePromptAssistantSuggestionIndex(-1, 3, -1), 2);
    assert.equal(movePromptAssistantSuggestionIndex(2, 3, 1), 0);
    assert.equal(movePromptAssistantSuggestionIndex(0, 3, -1), 2);
    assert.equal(movePromptAssistantSuggestionIndex(0, 0, 1), -1);
});

test("catalog client loads every CSV, URL-encodes names, merges aliases, and caches", async () => {
    const calls = [];
    let now = 1_000;
    const api = {
        async fetchApi(path) {
            calls.push(path);
            if (path === "/extensions") {
                return jsonResponse(["/extensions/prompt-assistant/modules/tag.js"]);
            }
            if (path === "/prompt-assistant/api/config/tags_files") {
                return jsonResponse({ success: true, files: ["默认 标签.csv", "人物.csv"] });
            }
            if (path.endsWith("/%E9%BB%98%E8%AE%A4%20%E6%A0%87%E7%AD%BE.csv")) {
                return jsonResponse({ success: true, data: { 常规: { 画质: { 杰作: "masterpiece" } } } });
            }
            if (path.endsWith("/%E4%BA%BA%E7%89%A9.csv")) {
                return jsonResponse({
                    success: true,
                    data: { 人物: { 常用: { 大师作品: "MasterPiece", 蓝眼睛: "blue eyes" } } },
                });
            }
            throw new Error(`Unexpected request: ${path}`);
        },
    };
    const catalog = new PromptAssistantTagCatalog(api, {
        cacheTtlMs: 100,
        now: () => now,
    });

    const first = await catalog.load();
    assert.equal(first.length, 2);
    assert.deepEqual(first[0].aliases, ["杰作", "大师作品"]);
    assert.equal(calls.length, 4);
    assert.equal(await catalog.load(), first);
    assert.equal(calls.length, 4);

    now = 1_101;
    await catalog.load();
    assert.equal(calls.length, 8);
});

test("catalog client hides integration when extension or valid tag data is unavailable", async () => {
    const missingCalls = [];
    const missing = new PromptAssistantTagCatalog({
        async fetchApi(path) {
            missingCalls.push(path);
            return jsonResponse(["/extensions/unrelated/index.js"]);
        },
    });
    assert.deepEqual(await missing.load(), []);
    assert.deepEqual(missingCalls, ["/extensions"]);

    const diagnostics = [];
    const invalid = new PromptAssistantTagCatalog({
        async fetchApi(path) {
            if (path === "/extensions") {
                return jsonResponse(["/extensions/prompt-assistant/modules/tag.js"]);
            }
            return jsonResponse({ success: true, files: ["not-a-csv.txt"] });
        },
    }, {
        onDiagnostic(message) {
            diagnostics.push(message);
        },
    });
    assert.deepEqual(await invalid.load(), []);
    assert.equal(diagnostics.length, 1);
});
