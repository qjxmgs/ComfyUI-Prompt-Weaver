import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    TRANSLATION_STATUS_POLL_MS,
    TRANSLATION_UPDATE_TIMEOUT_MS,
    shortBlobSha,
    translationManagerState,
} from "../web/prompt_translation_manager.js";

test("translation manager reports ready coverage and enabled supplement details", () => {
    const state = translationManagerState({
        available: true,
        ready: true,
        row_count: 32_259,
        primary_translation_available: true,
        primary_translation_count: 7_831,
        translated_tag_count: 31_657,
        translation_coverage_percent: 98.13,
        supplement_enabled: true,
        supplement_available: true,
        supplement_translation_count: 23_826,
        supplement_license_status: "cleared",
        supplement_blob_sha: "1234567890abcdef",
    });

    assert.equal(state.summary, "ready");
    assert.equal(state.tone, "success");
    assert.equal(state.action, "update");
    assert.equal(state.translatedTagCount, 31_657);
    assert.equal(state.coveragePercent, 98.13);
    assert.equal(state.supplementState, "available");
    assert.equal(shortBlobSha(state.supplementBlobSha), "1234567890ab");
});

test("license-pending supplement stays disabled without turning the main dictionary into an error", () => {
    const state = translationManagerState({
        available: true,
        ready: true,
        primary_translation_available: true,
        supplement_enabled: false,
        supplement_available: false,
        supplement_license_status: "pending",
    });

    assert.equal(state.summary, "ready");
    assert.equal(state.tone, "success");
    assert.equal(state.supplementState, "license-pending");
    assert.equal(state.supplementTone, "warning");
});

test("user-directed supplement is enabled for local download without claiming a license", () => {
    const pending = translationManagerState({
        available: true,
        ready: true,
        primary_translation_available: true,
        supplement_enabled: true,
        supplement_available: false,
        supplement_license_status: "user-directed",
    });
    assert.equal(pending.supplementState, "not-installed-local-use");

    const installed = translationManagerState({
        available: true,
        ready: true,
        primary_translation_available: true,
        supplement_enabled: true,
        supplement_available: true,
        supplement_license_status: "user-directed",
    });
    assert.equal(installed.supplementState, "available-local-use");
    assert.equal(installed.supplementTone, "warning");
});

test("local supplement state exposes origin, validation details, and fallback warnings", () => {
    const local = translationManagerState({
        available: true,
        ready: true,
        primary_translation_available: true,
        supplement_enabled: true,
        supplement_available: true,
        supplement_license_status: "user-directed",
        supplement_origin: "local",
        supplement_drop_in_path: "ComfyUI-Prompt-Weaver/tag-autocomplete/tag.sqlite",
        supplement_file_sha256: "a".repeat(64),
        supplement_row_count: 323_130,
        supplement_file_modified_at: "2026-08-19T12:00:00Z",
    });
    assert.equal(local.supplementState, "available-local-file");
    assert.equal(local.supplementOrigin, "local");
    assert.equal(local.supplementRowCount, 323_130);
    assert.equal(local.supplementFileSha256, "a".repeat(64));
    assert.match(local.supplementDropInPath, /tag\.sqlite$/);

    const fallback = translationManagerState({
        available: true,
        ready: true,
        primary_translation_available: true,
        supplement_enabled: true,
        supplement_available: true,
        supplement_origin: "downloaded",
        supplement_local_error: "invalid SQLite",
    });
    assert.equal(fallback.summary, "warning");
    assert.equal(fallback.supplementState, "available");
    assert.equal(fallback.supplementTone, "warning");
    assert.equal(fallback.supplementLocalError, "invalid SQLite");
});

test("missing, partial failure, fatal failure, and updating states select the right actions", () => {
    assert.deepEqual(
        translationManagerState({}).summary,
        "not-installed",
    );
    assert.equal(translationManagerState({}).action, "download");

    const warning = translationManagerState({ available: true, error: "network failed" });
    assert.equal(warning.summary, "warning");
    assert.equal(warning.tone, "warning");
    assert.equal(warning.action, "update");

    const failed = translationManagerState({ error: "network failed" });
    assert.equal(failed.summary, "failed");
    assert.equal(failed.tone, "error");

    const updating = translationManagerState({ available: true, updating: true });
    assert.equal(updating.summary, "updating");
    assert.equal(updating.tone, "info");
});

test("manager polling is bounded at five minutes", () => {
    assert.equal(TRANSLATION_STATUS_POLL_MS, 500);
    assert.equal(TRANSLATION_UPDATE_TIMEOUT_MS, 300_000);
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
    assert.match(source, /prompt_translation_manager\.js\?v=20260819-local-sqlite-v1/);
    assert.match(source, /prompt_toggle_grid\.css\?v=20260830-editor-header-v11/);
    assert.match(source, /name:\s*"ComfyUIPromptWeaver\.TranslationSettings"/);
    assert.match(source, /manager\.controller\.abort\(\)/);
    assert.doesNotMatch(source, /translationProvider\.update\("zh-CN",\s*\{\s*signal/);
    assert.match(source, /activeUpdateOperation/);
    assert.match(css, /\.cpw-translation-manager__overlay/);
    assert.match(css, /\.cpw-translation-manager__summary--warning/);
    assert.match(css, /\.cpw-translation-manager__source-actions/);
    assert.match(css, /@media \(max-width: 680px\)/);
});
