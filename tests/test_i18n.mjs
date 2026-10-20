import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
                "Prompt Weaver blocked this operation because ComfyUI is not listening only on loopback. Remove --listen or start ComfyUI with --listen 127.0.0.1, then restart it. Apps on this computer can use 127.0.0.1; other devices need an SSH tunnel. Changing only the browser URL will not fix the listener.": "Prompt Weaver blocked this operation because ComfyUI is not listening only on loopback. Remove --listen or start ComfyUI with --listen 127.0.0.1, then restart it. Apps on this computer can use 127.0.0.1; other devices need an SSH tunnel. Changing only the browser URL will not fix the listener.",
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
                "Prompt Weaver blocked this operation because ComfyUI is not listening only on loopback. Remove --listen or start ComfyUI with --listen 127.0.0.1, then restart it. Apps on this computer can use 127.0.0.1; other devices need an SSH tunnel. Changing only the browser URL will not fix the listener.": "操作被阻止：ComfyUI 没有仅监听回环地址。请移除启动参数 --listen，或改用 --listen 127.0.0.1，然后重启 ComfyUI。同机应用可连接 127.0.0.1；其他设备请使用 SSH 隧道。只修改浏览器地址无法解决。",
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

test("only the plugin's coded 403 receives actionable localized guidance", () => {
    const coded = { code: messages.PROMPT_WEAVER_LOCAL_ONLY_CODE, error: "server English" };
    messages.setPromptWeaverLocale("zh");
    const localized = messages.promptWeaverHttpError({ status: 403 }, coded, "fallback");
    assert.match(localized.message, /SSH 隧道/);
    assert.match(localized.message, /重启 ComfyUI/);
    assert.match(localized.message, /只修改浏览器地址无法解决/);
    assert.equal(localized.status, 403);
    assert.equal(localized.code, messages.PROMPT_WEAVER_LOCAL_ONLY_CODE);
    assert.equal(localized.serverMessage, "server English");
    assert.equal(messages.promptWeaverHttpError({ status: 403 }, { error: "proxy denied" }, "fallback").message, "proxy denied");
    assert.equal(messages.promptWeaverHttpError({ status: 403 }, null, "HTTP 403").message, "HTTP 403");
    assert.equal(messages.promptWeaverHttpError({ status: 409 }, coded, "fallback").message, "server English");
    messages.setPromptWeaverLocale("en");
    assert.match(messages.promptWeaverHttpError({ status: 403 }, coded, "fallback").message, /--listen 127\.0\.0\.1/);
});

test("workflow bridge shows a guarded failure once instead of repeating heartbeat toasts", async () => {
    const source = await readFile(new URL("../web/prompt_weaver.js", import.meta.url), "utf8");
    assert.match(source, /await connectPromptWeaverI18n\(app, api\)/);
    assert.match(source, /if \(!response\.ok\) throw await bridgeResponseError\(response\)/);
    assert.match(source, /bridgeLocalOnlyWarningShown = true/);
    assert.match(source, /error\?\.code !== PROMPT_WEAVER_LOCAL_ONLY_CODE/);
    assert.match(source, /summary: t\("Restart ComfyUI with --listen 127\.0\.0\.1"\)/);
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
