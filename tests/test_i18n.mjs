import assert from "node:assert/strict";
import test from "node:test";

import * as messages from "../web/prompt_weaver_i18n.js";

test("the runtime message helper exposes English-only formatting", () => {
    assert.deepEqual(
        Object.keys(messages).sort(),
        ["formatDateTime", "formatList", "formatNumber", "t", "tp"].sort(),
    );
    assert.equal(messages.t("Card {index}", { index: "03" }), "Card 03");
    assert.equal(messages.t("Text Mode"), "Text Mode");
    assert.equal(messages.t("Unregistered fallback"), "Unregistered fallback");
    assert.equal(messages.t(null), "");
});

test("English plural, number, date and list formatting remains stable", () => {
    assert.equal(messages.tp("{count} column", "{count} columns", 1), "1 column");
    assert.equal(messages.tp("{count} column", "{count} columns", 6), "6 columns");
    assert.equal(messages.formatNumber(12345.6), "12,345.6");
    assert.equal(messages.formatNumber("invalid"), "invalid");
    assert.equal(messages.formatList(["one", "two"]), "one and two");
    assert.match(messages.formatDateTime("2026-08-12T12:34:56Z"), /2026/);
    assert.equal(messages.formatDateTime("invalid"), "invalid");
});
