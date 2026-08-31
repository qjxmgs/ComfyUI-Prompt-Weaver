import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const asDataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const i18nSource = await readFile(
    new URL("../web/prompt_weaver_i18n.js", import.meta.url),
    "utf8",
);
const i18nUrl = asDataUrl(i18nSource);
const tokenSource = await readFile(
    new URL("../web/prompt_editor_tokens.js", import.meta.url),
    "utf8",
);
const tokenUrl = asDataUrl(tokenSource);
const archiveSource = (await readFile(
    new URL("../web/prompt_grid_archives.js", import.meta.url),
    "utf8",
)).replace("./prompt_weaver_i18n.js?v=20260831-editor-favorites-three-column-v1", i18nUrl);
const archiveUrl = asDataUrl(archiveSource);
const favoriteSource = (await readFile(
    new URL("../web/prompt_card_library.js", import.meta.url),
    "utf8",
))
    .replace("./prompt_grid_archives.js?v=20260830-prompt-card-library-v1", archiveUrl)
    .replace("./prompt_editor_tokens.js?v=20260830-retain-unselected-v1", tokenUrl)
    .replace("./prompt_weaver_i18n.js?v=20260831-editor-favorites-three-column-v1", i18nUrl);
const favoriteUrl = asDataUrl(favoriteSource);
const {
    PromptCardLibraryClient,
    clampPromptCardContextMenuPosition,
    favoriteCardBilingualPrompt,
    favoriteCardPromptCount,
    normalizePromptCardLibrary,
    promptCardCascadePanelPosition,
    promptCardCascadeTooltipPosition,
    promptCardFavoriteFingerprint,
    promptCardFavoriteMoveTarget,
    promptCardFavoritePath,
    promptCardFavoriteSnapshot,
    replacePromptGridItemWithFavorite,
    setPromptCardLibraryControlsBusy,
} = await import(favoriteUrl);

const PRIMARY_ID = "11111111-1111-4111-8111-111111111111";
const SECONDARY_ID = "22222222-2222-4222-8222-222222222222";
const CARD_ID = "33333333-3333-4333-8333-333333333333";
const CREATED_AT = "2026-08-30T00:00:00.000Z";

function libraryPayload() {
    return {
        format_version: 1,
        revision: 3,
        categories: [
            {
                id: PRIMARY_ID,
                parent_id: null,
                name: "人物",
                created_at: CREATED_AT,
                updated_at: CREATED_AT,
            },
            {
                id: SECONDARY_ID,
                parent_id: PRIMARY_ID,
                name: "角色",
                created_at: CREATED_AT,
                updated_at: CREATED_AT,
            },
        ],
        cards: [
            {
                id: CARD_ID,
                category_id: SECONDARY_ID,
                title: "主角",
                prompt: "1girl",
                prompt_tokens: [
                    { text: "1girl", selected: true },
                    { text: "blue eyes", selected: false },
                ],
                created_at: CREATED_AT,
                updated_at: CREATED_AT,
            },
        ],
    };
}

test("library normalization enforces two levels and secondary card ownership", () => {
    const normalized = normalizePromptCardLibrary(libraryPayload());
    assert.equal(normalized.categories[1].parent_id, PRIMARY_ID);
    assert.equal(normalized.cards[0].category_id, SECONDARY_ID);
    assert.equal(promptCardFavoritePath(normalized, CARD_ID), "人物 / 角色");

    const thirdLevel = structuredClone(libraryPayload());
    thirdLevel.categories.push({
        id: "44444444-4444-4444-8444-444444444444",
        parent_id: SECONDARY_ID,
        name: "非法三级",
        created_at: CREATED_AT,
        updated_at: CREATED_AT,
    });
    assert.throws(() => normalizePromptCardLibrary(thirdLevel));

    const primaryOwned = structuredClone(libraryPayload());
    primaryOwned.cards[0].category_id = PRIMARY_ID;
    assert.throws(() => normalizePromptCardLibrary(primaryOwned));
});

test("favorite prompt counts use top-level output tokens and ignore retained inactive metadata", () => {
    assert.equal(favoriteCardPromptCount({
        prompt: '1girl, (blue eyes, detailed:1.2), "red, blue", artist\\,name, [solo, portrait]',
        prompt_tokens: [
            { text: "1girl", selected: true },
            { text: "inactive extra", selected: false },
        ],
    }), 5);
    assert.equal(favoriteCardPromptCount({ prompt: "  \n， " }), 0);
});

test("favorite bilingual prompt tips preserve output order and fall back to English", () => {
    assert.deepEqual(favoriteCardBilingualPrompt({
        prompt: '1girl, ((blue_eyes:1.25)), "red, blue", artist\\,name, 中文标签',
        prompt_tokens: [
            { text: "inactive extra", selected: false },
        ],
    }, ["一个女孩", "蓝眼睛", "—", "", "中文标签"]), {
        english: '1girl, ((blue_eyes:1.25)), "red, blue", artist\\,name, 中文标签',
        chinese: '一个女孩，蓝眼睛，"red, blue"，artist\\,name，中文标签',
    });
    assert.deepEqual(favoriteCardBilingualPrompt({ prompt: "  \n， " }), {
        english: "",
        chinese: "",
    });
});

test("favorite snapshots are independent from ids and timestamps", () => {
    const card = libraryPayload().cards[0];
    const snapshot = promptCardFavoriteSnapshot({
        ...card,
        color: "purple",
        favorite_id: CARD_ID,
    });
    assert.deepEqual(snapshot, {
        title: "主角",
        prompt: "1girl",
        color: "purple",
        prompt_tokens: [
            { text: "1girl", selected: true },
            { text: "blue eyes", selected: false },
        ],
    });
    assert.equal(promptCardFavoriteFingerprint(snapshot), promptCardFavoriteFingerprint({
        ...snapshot,
        id: "different",
        updated_at: "different",
    }));
    assert.notEqual(promptCardFavoriteFingerprint(snapshot), promptCardFavoriteFingerprint({
        ...snapshot,
        prompt: "1girl, solo",
    }));
});

test("favorite switching replaces snapshot fields while preserving grid identity and state", () => {
    const current = {
        id: "grid-card-1",
        enabled: false,
        title: "旧卡片",
        prompt: "old prompt",
        color: "red",
        retain_unselected: false,
        favorite_id: "44444444-4444-4444-8444-444444444444",
        custom_editor_state: "preserved",
    };
    const favorite = libraryPayload().cards[0];
    const switched = replacePromptGridItemWithFavorite(current, favorite);
    assert.deepEqual(switched, {
        id: "grid-card-1",
        enabled: false,
        custom_editor_state: "preserved",
        title: "主角",
        prompt: "1girl",
        prompt_tokens: [
            { text: "1girl", selected: true },
            { text: "blue eyes", selected: false },
        ],
        favorite_id: CARD_ID,
    });
    assert.equal(promptCardFavoriteFingerprint(switched), promptCardFavoriteFingerprint(favorite));
});

test("favorite moves accept only changed secondary-category targets", () => {
    const library = normalizePromptCardLibrary(libraryPayload());
    assert.deepEqual(promptCardFavoriteMoveTarget(library, CARD_ID, PRIMARY_ID), {
        allowed: false,
        changed: false,
        changes: null,
    });
    assert.deepEqual(promptCardFavoriteMoveTarget(library, CARD_ID, SECONDARY_ID), {
        allowed: true,
        changed: false,
        changes: null,
    });
    const targetId = "44444444-4444-4444-8444-444444444444";
    library.categories.push({
        id: targetId,
        parent_id: PRIMARY_ID,
        name: "服装",
        created_at: CREATED_AT,
        updated_at: CREATED_AT,
    });
    assert.deepEqual(promptCardFavoriteMoveTarget(library, CARD_ID, targetId), {
        allowed: true,
        changed: true,
        changes: { category_id: targetId },
    });
});

test("API client preserves collection paths, methods, and request bodies", async () => {
    const requests = [];
    const api = {
        async fetchApi(path, options = {}) {
            requests.push({ path, options });
            return { ok: true, status: 200, async json() { return libraryPayload(); } };
        },
    };
    const client = new PromptCardLibraryClient(api);
    await client.list();
    await client.createCategory("人物");
    await client.updateCategory("id with space", "角色");
    await client.deleteCategory("id with space", SECONDARY_ID);
    await client.createCard(SECONDARY_ID, { title: "主角", prompt: "1girl" });
    await client.updateCard("id with space", { category_id: SECONDARY_ID });
    await client.deleteCard("id with space");

    assert.equal(requests[0].path, "/prompt-weaver/prompt-card-library");
    assert.equal(requests[1].options.method, "POST");
    assert.equal(requests[2].path, "/prompt-weaver/prompt-card-library/categories/id%20with%20space");
    assert.equal(requests[2].options.method, "PATCH");
    assert.deepEqual(JSON.parse(requests[3].options.body), { target_category_id: SECONDARY_ID });
    assert.equal(requests[4].path, "/prompt-weaver/prompt-card-library/cards");
    assert.equal(requests[5].options.method, "PATCH");
    assert.equal(requests[6].options.method, "DELETE");
});

test("nested busy renders preserve each control's original disabled state", () => {
    const closeButton = { disabled: false, dataset: {} };
    const permanentlyDisabledButton = { disabled: true, dataset: {} };
    const root = {
        querySelectorAll() {
            return [closeButton, permanentlyDisabledButton];
        },
    };

    setPromptCardLibraryControlsBusy(root, true);
    assert.equal(closeButton.disabled, true);
    assert.equal(closeButton.dataset.libraryDisabledBeforeBusy, "false");
    assert.equal(permanentlyDisabledButton.dataset.libraryDisabledBeforeBusy, "true");

    setPromptCardLibraryControlsBusy(root, true);
    assert.equal(closeButton.dataset.libraryDisabledBeforeBusy, "false");
    assert.equal(permanentlyDisabledButton.dataset.libraryDisabledBeforeBusy, "true");

    setPromptCardLibraryControlsBusy(root, false);
    assert.equal(closeButton.disabled, false);
    assert.equal(permanentlyDisabledButton.disabled, true);
    assert.equal("libraryDisabledBeforeBusy" in closeButton.dataset, false);
    assert.equal("libraryDisabledBeforeBusy" in permanentlyDisabledButton.dataset, false);
});

test("context menu position stays inside the viewport", () => {
    assert.deepEqual(clampPromptCardContextMenuPosition({
        x: 295,
        y: 190,
        width: 80,
        height: 60,
        viewportWidth: 300,
        viewportHeight: 200,
    }), { x: 214, y: 134 });
    assert.deepEqual(clampPromptCardContextMenuPosition({
        x: -20,
        y: -10,
        width: 80,
        height: 60,
        viewportWidth: 300,
        viewportHeight: 200,
    }), { x: 6, y: 6 });
});

test("cascade panels open below the title and flip submenus at the viewport edge", () => {
    assert.deepEqual(promptCardCascadePanelPosition({
        anchorRect: { left: 100, right: 126, top: 20, bottom: 46 },
        width: 196,
        height: 160,
        viewportWidth: 500,
        viewportHeight: 400,
    }), { x: 6, y: 50 });
    assert.deepEqual(promptCardCascadePanelPosition({
        anchorRect: { left: 300, right: 490, top: 40, bottom: 71 },
        width: 196,
        height: 180,
        viewportWidth: 500,
        viewportHeight: 400,
        submenu: true,
    }), { x: 100, y: 40 });
});

test("cascade prompt tips prefer available space and stay inside the viewport", () => {
    assert.deepEqual(promptCardCascadeTooltipPosition({
        anchorRect: { left: 300, right: 490, top: 40, bottom: 88 },
        panelRect: { left: 294, right: 490, top: 20, bottom: 220 },
        width: 180,
        height: 100,
        viewportWidth: 800,
        viewportHeight: 400,
    }), { x: 496, y: 40 });
    assert.deepEqual(promptCardCascadeTooltipPosition({
        anchorRect: { left: 300, right: 490, top: 360, bottom: 408 },
        panelRect: { left: 294, right: 490, top: 220, bottom: 400 },
        width: 260,
        height: 120,
        viewportWidth: 520,
        viewportHeight: 400,
    }), { x: 28, y: 272 });
});

test("frontend integrates compact card and editor actions with responsive cascade styling", async () => {
    const gridSource = await readFile(
        new URL("../web/prompt_toggle_grid.js", import.meta.url),
        "utf8",
    );
    const cssSource = await readFile(
        new URL("../web/prompt_toggle_grid.css", import.meta.url),
        "utf8",
    );
    assert.match(gridSource, /titleShell\.append\(title, favoriteSwitchButton\)/);
    assert.match(gridSource, /header\.append\(toggleLabel, titleShell, cardActions\)/);
    assert.match(gridSource, /openPromptCardFavoriteCascade\(\{/);
    assert.match(gridSource, /prompt_card_library\.js\?v=20260831-editor-favorite-hover-overwrite-v1/);
    assert.match(gridSource, /prompt_toggle_grid\.css\?v=20260831-editor-favorite-hover-overwrite-v1/);
    assert.doesNotMatch(gridSource, /const favoriteButton = element\("button", "cpw-prompt-grid__favorite"\)/);
    assert.match(gridSource, /sameFavorite && sameSnapshot[\s\S]*playFavoriteRefreshAnimation\(itemId\)/);
    assert.match(gridSource, /pendingFavoriteRefreshItems\.add\(itemId\)[\s\S]*commit\(true, true\)/);
    assert.match(gridSource, /footer\.append\(selectionActions, favoriteActions, commitActions\)/);
    assert.match(gridSource, /const currentEditorFavoriteSnapshot = \(\) => \{/);
    assert.match(gridSource, /mode: "assign",[\s\S]*getSnapshot: currentEditorFavoriteSnapshot,[\s\S]*resolvePromptTip: resolveFavoriteCardPromptTip/);
    assert.doesNotMatch(gridSource, /const appendFavoriteCard = \(favorite\) =>/);
    assert.match(favoriteSource, /new BroadcastChannel|PROMPT_CARD_LIBRARY_SYNC_EVENT/);
    assert.match(favoriteSource, /export function openPromptCardFavoriteCascade/);
    assert.match(favoriteSource, /splitPromptTokens\(value\?\.prompt\)\.length/);
    assert.match(favoriteSource, /cpw-prompt-card-cascade__item--selected/);
    assert.match(favoriteSource, /button\.setAttribute\("aria-expanded", String\(expanded\)\)/);
    assert.match(favoriteSource, /cpw-prompt-card-cascade__favorite-count/);
    assert.match(favoriteSource, /FAVORITE_DELETE_CONFIRM_MS = 3_000/);
    assert.match(favoriteSource, /cpw-prompt-card-cascade__favorite-delete/);
    assert.match(favoriteSource, /resolvePromptTip\(card, \{ signal: controller\.signal \}\)/);
    assert.match(favoriteSource, /aria-describedby/);
    assert.match(favoriteSource, /hideFavoriteTooltip\(\)/);
    assert.doesNotMatch(favoriteSource, /branchCloseTimer|scheduleBranchClose/);
    assert.match(favoriteSource, /chooseButton\.addEventListener\("pointerleave"[\s\S]*document\.activeElement !== chooseButton[\s\S]*hideFavoriteTooltip\(\)/);
    assert.match(favoriteSource, /chooseButton\.addEventListener\("blur"[\s\S]*!chooseButton\.matches\(":hover"\)[\s\S]*hideFavoriteTooltip\(\)/);
    assert.match(favoriteSource, /panel\.addEventListener\("pointerenter", \(\) => \{\s*if \(level < 2\) hideFavoriteTooltip\(\);/s);
    assert.match(favoriteSource, /armedDeleteCardId !== card\.id/);
    assert.match(favoriteSource, /service\.mutate\(\(client\) => client\.deleteCard\(card\.id\)\)/);
    assert.match(favoriteSource, /event\.stopPropagation\(\)/);
    assert.match(favoriteSource, /renderOpenBranch\(\)/);
    assert.match(favoriteSource, /root\.setAttribute\("aria-label", t\("Favorite Cards"\)\)/);
    assert.match(favoriteSource, /__heading", t\("Favorite Cards"\)\)/);
    assert.match(favoriteSource, /t\("Close favorite cards"\)/);
    assert.match(favoriteSource, /t\("Favorite card library data is invalid\."\)/);
    assert.match(favoriteSource, /t\("Favorite card library request failed \(HTTP \{status\}\)"/);
    assert.doesNotMatch(favoriteSource, /Prompt Card Favorites|prompt card favorites/);
    assert.match(favoriteSource, /const visible = Boolean\(message\) && Boolean\(error\);/);
    assert.match(favoriteSource, /panelHeader\(t\("Primary Categories"\), \{ createLevel: "primary" \}\)/);
    assert.match(favoriteSource, /panelHeader\(t\("Secondary Categories"\), \{/);
    assert.match(favoriteSource, /panelHeader\(t\("My Favorites"\), \{[\s\S]*backLevel: 1,[\s\S]*action: mode === "assign"/);
    assert.match(favoriteSource, /cpw-prompt-card-library__panel-add/);
    assert.match(favoriteSource, /panels\.replaceChildren\(primaryPanel, secondaryPanel, cardPanel\)/);
    assert.doesNotMatch(favoriteSource, /renderAssignActions|cpw-prompt-card-library__assign-actions|cpw-prompt-card-library__current-path/);
    assert.match(favoriteSource, /label: t\("Add current draft to favorites"\)/);
    assert.match(favoriteSource, /client\.createCard\(selectedSecondaryId, snapshot\)/);
    assert.match(favoriteSource, /title: t\("Overwrite favorite card\?"\)/);
    assert.match(favoriteSource, /client\.updateCard\(card\.id, \{ snapshot \}\)/);
    assert.match(favoriteSource, /event\.target\?\.closest\?\.\("\.cpw-prompt-card-confirm__overlay"\)/);
    assert.match(favoriteSource, /button\.addEventListener\("pointerenter"[\s\S]*selectedSecondaryId = category\.id;[\s\S]*mobileLevel = 2;[\s\S]*render\(\);/);
    assert.match(favoriteSource, /mode === "assign" \? "div" : "button"/);
    assert.match(favoriteSource, /if \(mode !== "assign"\) \{\s*choose\.addEventListener\("click"/s);
    assert.match(favoriteSource, /cpw-prompt-card-library__favorite-overwrite", t\("Overwrite"\)/);
    assert.match(favoriteSource, /overwriteButton\.addEventListener\("click"[\s\S]*overwriteFavoriteFromDraft\(card\)/);
    assert.match(favoriteSource, /cpw-prompt-card-library__favorite-count/);
    assert.match(favoriteSource, /cpw-prompt-card-library__favorite-delete/);
    assert.match(favoriteSource, /row\.draggable = mode === "assign"/);
    assert.match(favoriteSource, /application\/x-prompt-weaver-favorite-id/);
    assert.match(favoriteSource, /level === 0[\s\S]*selectedPrimaryId = category\.id[\s\S]*selectedSecondaryId = null/);
    assert.match(favoriteSource, /renderPrimaryDragPreview\?\.\(category\)/);
    assert.match(favoriteSource, /level !== 1[\s\S]*moveFavoriteToCategory\(cardId, category\)/);
    assert.doesNotMatch(favoriteSource, /cpw-prompt-card-library__create/);
    assert.doesNotMatch(favoriteSource, /cpw-prompt-card-library__more/);
    assert.doesNotMatch(favoriteSource, /cpw-prompt-card-library__row-actions/);
    assert.match(favoriteSource, /addEventListener\("contextmenu"/);
    assert.match(favoriteSource, /event\.clientX, y: event\.clientY/);
    assert.match(favoriteSource, /event\.key !== "ContextMenu"[\s\S]*event\.shiftKey && event\.key === "F10"/);
    assert.match(cssSource, /\.cpw-prompt-grid__title-shell\s*\{[^}]*position:\s*relative;[^}]*flex:\s*1 1 auto;/s);
    assert.match(cssSource, /\.cpw-prompt-grid__favorite-switch\s*\{[^}]*position:\s*absolute;[^}]*right:\s*1px;/s);
    assert.match(cssSource, /\.cpw-prompt-card-cascade__panel\s*\{[^}]*position:\s*fixed;[^}]*width:\s*min\(196px,/s);
    assert.match(cssSource, /\.cpw-prompt-card-cascade__item--selected/);
    assert.match(cssSource, /\.cpw-prompt-card-cascade__favorite-row\s*\{[^}]*position:\s*relative;/s);
    assert.match(cssSource, /\.cpw-prompt-card-cascade__favorite-delete\s*\{[^}]*position:\s*absolute;[^}]*color:\s*var\(--error-text,/s);
    assert.match(cssSource, /\.cpw-prompt-card-cascade__favorite-delete--armed/);
    assert.match(cssSource, /\.cpw-prompt-card-cascade__tooltip\s*\{[^}]*position:\s*fixed;[^}]*max-width:\s*min\(420px,[^}]*pointer-events:\s*none;/s);
    assert.match(cssSource, /\.cpw-prompt-card-cascade__tooltip\s*\{[^}]*border:[^}]*48%[^}]*background:[^}]*82%[^}]*box-shadow:[^}]*24%[^}]*font-size:\s*11px;/s);
    assert.match(cssSource, /\.cpw-prompt-card-cascade__tooltip-line\s*\{[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere;/s);
    assert.match(cssSource, /\.cpw-prompt-card-cascade__tooltip-line--zh\s*\{[^}]*border-top:[^}]*36%[^}]*color:[^}]*84%/s);
    assert.match(cssSource, /@keyframes cpw-prompt-grid-favorite-shine/);
    assert.match(cssSource, /\.cpw-prompt-grid__card--favorite-refreshed \.cpw-prompt-grid__title-shell::after/);
    assert.match(cssSource, /\.cpw-prompt-grid__card--favorite-refreshed \.cpw-prompt-grid__prompt-row::after/);
    assert.match(cssSource, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation:\s*none;/s);
    assert.match(cssSource, /\.cpw-prompt-card-library__panels\s*\{[^}]*grid-template-columns:\s*190px\s+190px\s+minmax\(240px,\s*1fr\);/s);
    assert.doesNotMatch(cssSource, /\.cpw-prompt-card-library--assign \.cpw-prompt-card-library__panels\s*\{[^}]*grid-template-columns:\s*1fr\s+1fr;/s);
    assert.match(cssSource, /\.cpw-prompt-card-library__panel-header\s*\{[^}]*height:\s*32px;[^}]*min-height:\s*32px;[^}]*flex:\s*0 0 32px;/s);
    assert.match(cssSource, /\.cpw-prompt-card-library__panel-add\s*\{[^}]*width:\s*22px;[^}]*height:\s*22px;/s);
    assert.match(cssSource, /\.cpw-prompt-card-library__favorite-delete\s*\{[^}]*position:\s*absolute;[^}]*color:\s*var\(--error-text,/s);
    assert.match(cssSource, /\.cpw-prompt-card-library__favorite-overwrite\s*\{[^}]*position:\s*absolute;[^}]*border-radius:\s*5px;/s);
    assert.match(cssSource, /\.cpw-prompt-card-library__tooltip\s*\{[^}]*z-index:\s*2147483630;/s);
    assert.match(cssSource, /\.cpw-prompt-card-library__row-main--drop-target/);
    assert.doesNotMatch(cssSource, /\.cpw-prompt-card-library__more/);
    assert.match(cssSource, /\.cpw-prompt-card-library__context-menu\s*\{[^}]*position:\s*fixed;[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
    assert.match(cssSource, /@media \(max-width:\s*679px\)[\s\S]*\.cpw-prompt-card-library\[data-mobile-level=/s);
    assert.doesNotMatch(cssSource, /\.cpw-prompt-grid__favorite--dirty::after/);
});
