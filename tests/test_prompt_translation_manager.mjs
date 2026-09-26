import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    TRANSLATION_STATUS_POLL_MS,
    TRANSLATION_UPDATE_TIMEOUT_MS,
    shortBlobSha,
    translationManagerState,
} from "../web/prompt_translation_manager.js";

test("one SQLite exposes selected source, fingerprint and total rows", () => {
    const state = translationManagerState({
        available: true, total_count: 316314, selected_source: "local",
        file_sha256: "a".repeat(64), version: "b".repeat(40),
        local_path: "ComfyUI-Prompt-Weaver/tag-autocomplete/tag.sqlite",
        sources: { downloaded: { available: true } },
    });
    assert.equal(state.summary, "ready");
    assert.equal(state.action, "update");
    assert.equal(state.selectedSource, "local");
    assert.equal(state.rowCount, 316314);
    assert.equal(state.coveragePercent, 100);
    assert.equal(shortBlobSha(state.fileSha256), "aaaaaaaaaaaa");
    assert.match(state.localPath, /tag.sqlite$/);
});

test("missing, failed, preserved-data warning and busy states are distinct", () => {
    assert.equal(translationManagerState().summary, "not-installed");
    assert.equal(translationManagerState().action, "download");
    assert.equal(translationManagerState({ error: "invalid" }).summary, "failed");
    assert.equal(translationManagerState({ available: true, error: "offline" }).summary, "warning");
    assert.equal(translationManagerState({ updating: true }).summary, "updating");
    assert.equal(translationManagerState({ importing: true }).importing, true);
});

test("both settings surfaces use the shared filter and official locale strings", async () => {
    const source = await readFile(new URL("../web/prompt_translation_settings.js", import.meta.url), "utf8");
    assert.match(source, /type: createMinPostCountControl/);
    assert.match(source, /manager.filterControl = createMinPostCountControl\(\)/);
    assert.match(source, /\/prompt-weaver\/tag-autocomplete\/source/);
    assert.doesNotMatch(source, /English base dictionary|Missing-translation supplement/);
    assert.match(source, /aria-live/);
    assert.match(source, /manager.content.scrollTop = scrollTop/);
});

test("manager polling is bounded at five minutes", () => {
    assert.equal(TRANSLATION_STATUS_POLL_MS, 500);
    assert.equal(TRANSLATION_UPDATE_TIMEOUT_MS, 300_000);
});

test("threshold card fills the settings row without a duplicate label", async () => {
    const css = await readFile(new URL("../web/prompt_toggle_grid.css", import.meta.url), "utf8");
    const setting = '.setting-item[data-setting-id="PromptWeaver.Autocomplete.MinPostCount"]';
    const declarations = (selector) => {
        const start = css.indexOf(selector);
        assert.notEqual(start, -1, `Missing scoped selector: ${selector}`);
        const block = css.indexOf("{", start);
        return css.slice(block + 1, css.indexOf("}", block));
    };
    assert.match(declarations(`${setting} .form-label`), /display:\s*none/);
    for (const suffix of [" > div", " .form-input,", " .form-input > div"]) {
        const rule = declarations(`${setting}${suffix}`);
        assert.match(rule, /width:\s*100%/);
        assert.match(rule, /display:\s*block/);
    }
    assert.match(declarations(".cpw-tag-filter__row,"), /flex-wrap:\s*wrap/);
});

test("both threshold surfaces offer all eight ordered quick values and keep the warning", async () => {
    const source = await readFile(new URL("../web/prompt_translation_settings.js", import.meta.url), "utf8");
    const presetValues = source.match(/const presets = (\[[\d, ]+\])\.map/);
    assert.ok(presetValues);
    assert.deepEqual(JSON.parse(presetValues[1]), [10, 50, 100, 200, 300, 400, 500, 1000]);
    assert.match(source, /tagFilter\.input\(value\)/);
    assert.match(source, /label\.htmlFor = input\.id/);
    assert.match(source, /hint\.textContent = t\("Lower values load more tags and use more resources\."\)/);
});

test("settings button and legacy command open the same singleton manager", async () => {
    const source = await readFile(
        new URL("../web/prompt_translation_settings.js", import.meta.url),
        "utf8",
    );
    const css = await readFile(
        new URL("../web/prompt_toggle_grid.css", import.meta.url),
        "utf8",
    );

    assert.match(source, /id:\s*TRANSLATION_MANAGER_SETTING_ID/);
    assert.match(source, /type:\s*createTranslationManagerSettingButton/);
    assert.match(source, /PromptWeaver\.Autocomplete\.UpdateDictionary/);
    assert.match(source, /function:\s*\(\)\s*=>\s*openPromptTranslationManager/);
    assert.match(source, /if \(activeTranslationManager\)/);
    assert.match(source, /translationProvider\.status\("zh-CN"/);
    assert.match(source, /translationProvider\.update\("zh-CN"\)/);
    assert.match(source, /\/prompt-weaver\/tag-autocomplete\/supplement\/import/);
    assert.match(source, /\/prompt-weaver\/tag-autocomplete\/supplement\/rescan/);
    assert.match(source, /fileInput\.accept = "\.sqlite,application\/vnd\.sqlite3,application\/octet-stream"/);
    assert.match(source, /Choose local tag\.sqlite…/);
    assert.match(source, /Rescan local file/);
    assert.match(source, /Copy path/);
    assert.match(source, /activeSupplementOperation/);
    assert.match(source, /translationProvider\.importSupplement\(file\)/);
    assert.match(source, /translationProvider\.rescanSupplement\("zh-CN"\)/);
    assert.match(source, /prompt_translation_manager\.js\?v=20260923-sqlite-filter-v1/);
    assert.match(source, /prompt_toggle_grid\.css\?v=20260926-variable-token-preview-v1/);
    assert.match(source, /name:\s*"ComfyUIPromptWeaver\.TranslationSettings"/);
    assert.match(source, /void connectPromptWeaverI18n\(app, api\)/);
    assert.match(source, /subscribePromptWeaverLocale\(\(\) => \{/);
    assert.match(source, /if \(activeTranslationManager\) refreshPromptTranslationManagerLocale\(activeTranslationManager\)/);
    assert.match(source, /document\.querySelectorAll\("\[data-cpw-autocomplete-source-control\]"\)/);
    assert.match(source, /manager\.controller\.abort\(\)/);
    assert.doesNotMatch(source, /translationProvider\.update\("zh-CN",\s*\{\s*signal/);
    assert.match(source, /activeUpdateOperation/);
    assert.match(css, /\.cpw-translation-manager__overlay/);
    assert.match(css, /\.cpw-translation-manager__summary--warning/);
    assert.match(css, /\.cpw-translation-manager__source-actions/);
    assert.match(css, /@media \(max-width: 680px\)/);
});

test("threshold heading offers an accessible localized help tooltip without changing the input label", async () => {
    const source = await readFile(new URL("../web/prompt_translation_settings.js", import.meta.url), "utf8");
    const css = await readFile(new URL("../web/prompt_toggle_grid.css", import.meta.url), "utf8");
    assert.match(source, /element\("span", "cpw-tag-filter__help", "!"\)/);
    assert.match(source, /heading\.append\(label, help, helpTooltip\)/);
    assert.match(source, /control\.append\(heading, row, count, hint\)/);
    assert.match(source, /help\.tabIndex = 0/);
    assert.match(source, /helpTooltip\.setAttribute\("role", "tooltip"\)/);
    assert.match(source, /help\.setAttribute\("aria-describedby", helpTooltip\.id\)/);
    assert.match(source, /input\.setAttribute\("aria-describedby", `\$\{helpTooltip\.id\} \$\{hint\.id\}`\)/);
    assert.match(source, /helpTooltip\.textContent = t\("Only load tags used in at least this many Danbooru posts\."\)/);
    for (const event of ["pointerenter", "focus", "blur", "keydown"]) {
        assert.ok(source.includes(`help.addEventListener("${event}"`));
    }
    assert.match(source, /if \(event\.key !== "Escape"\) return/);
    assert.match(source, /dialog\.querySelector\("\.cpw-tag-filter__tooltip:not\(\[hidden\]\)"\)/);
    assert.match(css, /\.cpw-tag-filter__help:focus-visible\s*\{/);
    assert.match(css, /max-width: min\(360px, 100%\)/);
    assert.match(css, /\.cpw-tag-filter__tooltip\[hidden\] \{ display: none; \}/);
});
