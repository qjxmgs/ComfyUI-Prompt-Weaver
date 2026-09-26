import assert from "node:assert/strict";
import test from "node:test";

import * as messages from "../web/prompt_weaver_i18n.js";

const resources = {
    en: {
        promptWeaver: {
            ui: {
                "Card {index}": "Card {index}",
                "Text Mode": "Text Mode",
                "New Variable": "New Variable",
                "Variable List ({count})": "Variable List ({count})",
                "Actions": "Actions",
                "{count} column": "{count} column",
                "{count} columns": "{count} columns",
            },
        },
    },
    zh: {
        promptWeaver: {
            ui: {
                "Card {index}": "卡片 {index}",
                "Text Mode": "文本模式",
                "New Variable": "新建变量",
                "Variable List ({count})": "变量列表（{count}）",
                "Actions": "操作",
                "{count} column": "{count} 列",
                "{count} columns": "{count} 列",
            },
        },
    },
};

function mockApp(initialLocale = "en") {
    let locale = initialLocale;
    const listeners = new Map();
    return {
        extensionManager: {
            setting: {
                get(id) {
                    return id === "Comfy.Locale" ? locale : undefined;
                },
            },
        },
        ui: {
            settings: {
                addEventListener(name, listener) {
                    listeners.set(name, listener);
                },
                removeEventListener(name) {
                    listeners.delete(name);
                },
            },
        },
        changeLocale(value) {
            locale = value;
            listeners.get("Comfy.Locale.change")?.({ detail: { value } });
        },
    };
}

test("the runtime helper keeps English source strings as the final fallback", () => {
    messages.setPromptWeaverLocale("en");
    assert.equal(messages.t("Card {index}", { index: "03" }), "Card 03");
    assert.equal(messages.t("Text Mode"), "Text Mode");
    assert.equal(messages.t("Unregistered fallback"), "Unregistered fallback");
    assert.equal(messages.t(null), "");
});

test("official ComfyUI locale resources load once and follow live locale changes", async () => {
    const app = mockApp("zh");
    let requests = 0;
    const seenLocales = [];
    const unsubscribe = messages.subscribePromptWeaverLocale((locale) => seenLocales.push(locale));
    await messages.connectPromptWeaverI18n(app, {
        async getCustomNodesI18n() {
            requests += 1;
            return resources;
        },
    });

    assert.equal(requests, 1);
    assert.equal(messages.getPromptWeaverLocale(), "zh");
    assert.equal(messages.t("Text Mode"), "文本模式");
    assert.equal(messages.t("Card {index}", { index: 2 }), "卡片 2");
    assert.equal(messages.t("New Variable"), "新建变量");
    assert.equal(messages.t("Variable List ({count})", { count: 4 }), "变量列表（4）");
    assert.equal(messages.t("Actions"), "操作");

    app.changeLocale("en");
    assert.equal(messages.getPromptWeaverLocale(), "en");
    assert.equal(messages.t("Text Mode"), "Text Mode");
    assert.equal(messages.t("New Variable"), "New Variable");
    assert.ok(seenLocales.includes("zh"));
    assert.ok(seenLocales.includes("en"));
    unsubscribe();
});

test("locale normalization does not substitute Simplified Chinese for Traditional Chinese", () => {
    assert.equal(messages.normalizePromptWeaverLocale("zh-CN"), "zh");
    assert.equal(messages.normalizePromptWeaverLocale("zh_Hans"), "zh");
    assert.equal(messages.normalizePromptWeaverLocale("zh-TW"), "en");
    assert.equal(messages.normalizePromptWeaverLocale("ja"), "en");
});

test("plural, number, date and list formatting follow the active locale", () => {
    messages.setPromptWeaverLocale("en");
    assert.equal(messages.tp("{count} column", "{count} columns", 1), "1 column");
    assert.equal(messages.tp("{count} column", "{count} columns", 6), "6 columns");
    assert.equal(messages.formatNumber(12345.6), "12,345.6");
    assert.equal(messages.formatNumber("invalid"), "invalid");
    assert.equal(messages.formatList(["one", "two"]), "one and two");
    assert.match(messages.formatDateTime("2026-08-12T12:34:56Z"), /2026/);
    assert.equal(messages.formatDateTime("invalid"), "invalid");

    messages.setPromptWeaverLocale("zh");
    assert.equal(messages.tp("{count} column", "{count} columns", 6), "6 列");
    assert.equal(messages.formatList(["一", "二"]), "一和二");
    assert.match(messages.formatDateTime("2026-08-12T12:34:56Z"), /2026/);
    messages.setPromptWeaverLocale("en");
});
