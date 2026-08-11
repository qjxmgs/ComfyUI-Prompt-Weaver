import assert from "node:assert/strict";
import test from "node:test";

import {
    MESSAGES,
    connectLocale,
    formatDateTime,
    formatList,
    formatNumber,
    getLocale,
    normalizeLocale,
    setLocale,
    subscribeLocale,
    syncLocale,
    t,
    tp,
} from "../web/prompt_weaver_i18n.js";

test("English and Simplified Chinese dictionaries have identical keys", () => {
    assert.deepEqual(Object.keys(MESSAGES.en).sort(), Object.keys(MESSAGES.zh).sort());
    assert.ok(Object.keys(MESSAGES.en).length > 100);
});

test("locale normalization supports Simplified Chinese and falls back to English", () => {
    for (const locale of ["zh", "zh-CN", "zh_CN", "zh-Hans", "zh-Hans-CN"]) {
        assert.equal(normalizeLocale(locale), "zh");
    }
    for (const locale of ["en", "en-US", "zh-TW", "ja", "", null]) {
        assert.equal(normalizeLocale(locale), "en");
    }
});

test("translations interpolate values, format quantities and dates, and preserve fallbacks", () => {
    setLocale("en");
    assert.equal(t("Prompt {index}", { index: 3 }), "Prompt 3");
    assert.equal(tp("{count} prompt active", "{count} prompts active", 1), "1 prompt active");
    assert.equal(tp("{count} prompt active", "{count} prompts active", 2), "2 prompts active");
    assert.equal(formatNumber(12345.6), "12,345.6");
    assert.equal(t("Unregistered fallback"), "Unregistered fallback");
    assert.equal(formatList(["one", "two"]), "one and two");
    assert.match(formatDateTime("2026-08-12T12:34:56Z"), /2026/);

    setLocale("zh-CN");
    assert.equal(t("Prompt {index}", { index: 3 }), "提示词 3");
    assert.equal(tp("{count} prompt active", "{count} prompts active", 2), "当前激活 2 个提示词");
    assert.equal(formatNumber(12345.6), "12,345.6");
    assert.equal(formatList(["一", "二"]), "一和二");
    assert.match(formatDateTime("2026-08-12T12:34:56Z"), /2026/);
    setLocale("en");
});

test("Comfy.Locale synchronization notifies subscribers and removes its listener cleanly", () => {
    const settings = new EventTarget();
    let settingValue = "zh-CN";
    const app = {
        extensionManager: { setting: { get: () => settingValue } },
        ui: { settings },
    };
    const observed = [];
    const unsubscribe = subscribeLocale((locale) => observed.push(locale));
    const disconnect = connectLocale(app);
    assert.equal(getLocale(), "zh");

    settingValue = "en-US";
    settings.dispatchEvent(new CustomEvent("Comfy.Locale.change", {
        detail: { value: settingValue },
    }));
    assert.equal(getLocale(), "en");
    assert.deepEqual(observed, ["zh", "en"]);

    disconnect();
    settings.dispatchEvent(new CustomEvent("Comfy.Locale.change", {
        detail: { value: "zh" },
    }));
    assert.equal(getLocale(), "en");
    unsubscribe();
    assert.equal(syncLocale(app), "en");
});
