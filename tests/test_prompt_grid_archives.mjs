import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    promptGridMasterToggleState,
    toggleAllPromptGridItems,
} from "../web/prompt_grid_controls.js";

const i18nSource = await readFile(
    new URL("../web/prompt_weaver_i18n.js", import.meta.url),
    "utf8",
);
const i18nUrl = `data:text/javascript;base64,${Buffer.from(i18nSource).toString("base64")}`;
const moduleSource = (await readFile(
    new URL("../web/prompt_grid_archives.js", import.meta.url),
    "utf8",
)).replace("./prompt_weaver_i18n.js?v=20260901-grid-column-align-v1", i18nUrl);
const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`;
const {
    DEFAULT_ARCHIVE_ID,
    PROMPT_GRID_ITEM_COLORS,
    PromptGridArchiveClient,
    applyArchiveManagerSelectionGesture,
    archiveManagerSelectionAvailability,
    buildArchiveExportBundle,
    canQuickSaveArchive,
    canRestoreArchive,
    configFromArchiveSnapshot,
    defaultArchiveName,
    findMatchingArchive,
    formatArchiveOptionLabel,
    isPristineDefaultSnapshot,
    localizePristineDefaultSnapshot,
    normalizeArchiveNodeSize,
    normalizeArchiveManagerSelection,
    normalizePromptGridItemColor,
    reorderArchiveIds,
    resolveArchiveInitialization,
    resolveArchiveStatus,
    semanticFingerprint,
    snapshotFromState,
    validateImportBundlePreview,
} = await import(moduleUrl);

const state = {
    version: 1,
    columns: 2,
    items: [{ id: "one", enabled: true, title: "画质", prompt: "masterpiece" }],
    ignored: "value",
};

test("prompt grid master toggle reports empty, off, mixed, and on states", () => {
    assert.equal(promptGridMasterToggleState([]), "empty");
    assert.equal(promptGridMasterToggleState([{ enabled: false }, { enabled: false }]), "off");
    assert.equal(promptGridMasterToggleState([{ enabled: true }, { enabled: false }]), "mixed");
    assert.equal(promptGridMasterToggleState([{ enabled: true }, { enabled: true }]), "on");
});

test("prompt grid master toggle enables mixed grids and disables fully enabled grids", () => {
    const mixed = [
        { id: "one", enabled: true, title: "One", prompt: "first", color: "red" },
        { id: "two", enabled: false, title: "Two", prompt: "second", favorite_id: "favorite" },
    ];
    const enabled = toggleAllPromptGridItems(mixed);
    assert.deepEqual(enabled, [
        mixed[0],
        { ...mixed[1], enabled: true },
    ]);
    assert.strictEqual(enabled[0], mixed[0]);
    assert.deepEqual(toggleAllPromptGridItems(enabled), [
        { ...mixed[0], enabled: false },
        { ...mixed[1], enabled: false },
    ]);
    const empty = [];
    assert.strictEqual(toggleAllPromptGridItems(empty), empty);
});

test("snapshot extraction keeps only execution state", () => {
    assert.deepEqual(snapshotFromState(state), {
        version: 1,
        columns: 2,
        node_size: { width: 600, height: 420 },
        items: [{ id: "one", enabled: true, title: "画质", prompt: "masterpiece" }],
    });
});

test("item colors survive archive round trips and participate in dirty state", () => {
    const coloredState = structuredClone(state);
    coloredState.items[0].color = "blue";
    const saved = snapshotFromState(coloredState);
    assert.equal(saved.items[0].color, "blue");
    assert.equal(configFromArchiveSnapshot(saved).items[0].color, "blue");
    assert.notEqual(semanticFingerprint(saved), semanticFingerprint(snapshotFromState(state)));

    coloredState.items[0].color = "unknown";
    assert.equal(snapshotFromState(coloredState).items[0].color, undefined);
    assert.equal(normalizePromptGridItemColor("unknown"), null);
    assert.equal(normalizePromptGridItemColor("red"), "red");
    assert.deepEqual(Object.fromEntries(
        Object.entries(PROMPT_GRID_ITEM_COLORS).map(([key, definition]) => [key, definition.hex]),
    ), {
        red: "#ef5350",
        orange: "#fb8c00",
        yellow: "#fdd835",
        green: "#43a047",
        cyan: "#26c6da",
        blue: "#42a5f5",
        purple: "#ab47bc",
        pink: "#ec407a",
        gray: "#78909c",
        white: "#f5f5f5",
        black: "#212121",
    });
});

test("favorite links survive archive round trips and participate in dirty state", () => {
    const favoriteId = "33333333-3333-4333-8333-333333333333";
    const linkedState = structuredClone(state);
    linkedState.items[0].favorite_id = favoriteId.toUpperCase();
    const saved = snapshotFromState(linkedState);
    assert.equal(saved.items[0].favorite_id, favoriteId);
    assert.equal(configFromArchiveSnapshot(saved).items[0].favorite_id, favoriteId);
    assert.notEqual(semanticFingerprint(saved), semanticFingerprint(snapshotFromState(state)));

    linkedState.items[0].favorite_id = "not-a-uuid";
    assert.equal(snapshotFromState(linkedState).items[0].favorite_id, undefined);
});

test("semantic fingerprints ignore internal ids but preserve visible order and state", () => {
    const left = snapshotFromState(state);
    const right = structuredClone(left);
    right.items[0].id = "different";
    assert.equal(semanticFingerprint(left), semanticFingerprint(right));
    assert.equal(findMatchingArchive([{ id: "archive", snapshot: right }], left)?.id, "archive");
    right.node_size = { width: 900, height: 700 };
    assert.notEqual(semanticFingerprint(left), semanticFingerprint(right));
    assert.equal(findMatchingArchive([{ id: "archive", snapshot: right }], left)?.id, "archive");
    right.items[0].enabled = false;
    assert.notEqual(semanticFingerprint(left), semanticFingerprint(right));
});

test("node size is canonical archive metadata and never enters execution config", () => {
    const saved = snapshotFromState(state, [812.6, 537.4]);
    assert.deepEqual(saved.node_size, { width: 813, height: 537 });
    assert.deepEqual(snapshotFromState(state, new Float32Array([900, 700])).node_size, {
        width: 900,
        height: 700,
    });
    assert.deepEqual(normalizeArchiveNodeSize({ width: 20, height: 20_000 }), {
        width: 600,
        height: 10_000,
    });
    assert.deepEqual(normalizeArchiveNodeSize({ width: 20, height: 20 }), {
        width: 600,
        height: 254,
    });
    assert.deepEqual(configFromArchiveSnapshot(saved), {
        version: 1,
        columns: 2,
        items: [{ id: "one", enabled: true, title: "画质", prompt: "masterpiece" }],
    });
});

test("dirty state keeps the current archive identity", () => {
    const saved = snapshotFromState(state);
    const changed = structuredClone(saved);
    changed.items[0].prompt = "masterpiece, best quality";
    const archives = [{ id: "common", name: "常用", snapshot: saved }];

    assert.deepEqual(resolveArchiveStatus(archives, changed, "common"), {
        activeArchiveId: "common",
        dirty: true,
    });
    assert.deepEqual(resolveArchiveStatus(archives, saved, "common"), {
        activeArchiveId: "common",
        dirty: false,
    });
    const resized = structuredClone(saved);
    resized.node_size.height += 100;
    assert.deepEqual(resolveArchiveStatus(archives, resized, "common"), {
        activeArchiveId: "common",
        dirty: true,
    });
});

test("archive initialization distinguishes persisted, legacy, and new nodes", () => {
    const saved = snapshotFromState(state);
    const changed = structuredClone(saved);
    changed.columns = 3;
    const defaults = structuredClone(saved);
    defaults.items = [];
    const archives = [
        { id: DEFAULT_ARCHIVE_ID, name: "默认存档", snapshot: defaults, is_default: true },
        { id: "common", name: "常用", snapshot: saved },
    ];

    assert.deepEqual(resolveArchiveInitialization(archives, changed, {
        persistedArchiveId: "common",
        lastSelectedArchiveId: DEFAULT_ARCHIVE_ID,
        isNewNode: false,
    }), {
        activeArchiveId: "common",
        loadSnapshot: false,
    });
    assert.deepEqual(resolveArchiveInitialization(archives, saved, {
        isNewNode: false,
    }), {
        activeArchiveId: "common",
        loadSnapshot: false,
    });
    assert.deepEqual(resolveArchiveInitialization(archives, defaults, {
        lastSelectedArchiveId: "common",
        isNewNode: true,
    }), {
        activeArchiveId: "common",
        loadSnapshot: true,
    });
    assert.deepEqual(resolveArchiveInitialization(archives, changed, {
        persistedArchiveId: "deleted",
    }), {
        activeArchiveId: DEFAULT_ARCHIVE_ID,
        loadSnapshot: false,
    });
    assert.deepEqual(resolveArchiveStatus(archives, changed, "deleted"), {
        activeArchiveId: DEFAULT_ARCHIVE_ID,
        dirty: true,
    });
});

test("archive labels always reserve the two-character dirty marker gutter", () => {
    const clean = formatArchiveOptionLabel("常用");
    const dirty = formatArchiveOptionLabel("常用", true);
    assert.equal(clean, "\u00A0\u00A0常用");
    assert.equal(dirty, "* 常用");
    assert.equal([...clean].length, [...dirty].length);
});

test("archive id reorder is stable and supports before or append semantics", () => {
    assert.deepEqual(reorderArchiveIds(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
    assert.deepEqual(reorderArchiveIds(["a", "b", "c"], "a", null), ["b", "c", "a"]);
    assert.deepEqual(reorderArchiveIds(["a", "b", "c"], "b", "b"), ["a", "b", "c"]);
    assert.deepEqual(reorderArchiveIds(["a", "b", "c"], "missing", "a"), ["a", "b", "c"]);
    assert.deepEqual(reorderArchiveIds(["a", "b", "c"], "a", "missing"), ["a", "b", "c"]);
});

test("archive manager multi-selection preserves archive order and removes stale ids", () => {
    const archives = [
        { id: DEFAULT_ARCHIVE_ID, is_default: true },
        { id: "common" },
        { id: "portrait" },
    ];
    assert.deepEqual(
        normalizeArchiveManagerSelection(archives, new Set(["portrait", "deleted", "common"])),
        ["common", "portrait"],
    );
    assert.deepEqual(normalizeArchiveManagerSelection(archives, []), []);
    assert.deepEqual(normalizeArchiveManagerSelection([], ["common"]), []);
});

test("archive manager selection gestures support plain, Ctrl, Shift, and Ctrl+Shift", () => {
    const ids = ["default", "a", "b", "c", "d"];
    assert.deepEqual(
        applyArchiveManagerSelectionGesture(ids, ["a", "c"], "b", "a"),
        { selectedIds: ["b"], anchorId: "b" },
    );
    assert.deepEqual(
        applyArchiveManagerSelectionGesture(ids, ["a"], "c", "a", { additive: true }),
        { selectedIds: ["a", "c"], anchorId: "c" },
    );
    assert.deepEqual(
        applyArchiveManagerSelectionGesture(ids, ["a", "c"], "c", "a", { additive: true }),
        { selectedIds: ["a"], anchorId: "c" },
    );
    assert.deepEqual(
        applyArchiveManagerSelectionGesture(ids, ["default", "d"], "d", "a", { range: true }),
        { selectedIds: ["a", "b", "c", "d"], anchorId: "a" },
    );
    assert.deepEqual(
        applyArchiveManagerSelectionGesture(ids, ["default"], "c", "a", {
            additive: true,
            range: true,
        }),
        { selectedIds: ["default", "a", "b", "c"], anchorId: "a" },
    );
    assert.deepEqual(
        applyArchiveManagerSelectionGesture(ids, ["a"], "d", "missing", { range: true }),
        { selectedIds: ["d"], anchorId: "d" },
    );
});

test("archive manager actions implement zero, single, and multi-selection rules", () => {
    const regular = { id: "common" };
    const second = { id: "portrait" };
    const defaults = { id: DEFAULT_ARCHIVE_ID, is_default: true };
    assert.deepEqual(archiveManagerSelectionAvailability([]), {
        save: false,
        load: false,
        rename: false,
        export: false,
        delete: false,
    });
    assert.deepEqual(archiveManagerSelectionAvailability([regular]), {
        save: true,
        load: true,
        rename: true,
        export: true,
        delete: true,
    });
    assert.deepEqual(archiveManagerSelectionAvailability([defaults]), {
        save: true,
        load: true,
        rename: false,
        export: true,
        delete: false,
    });
    assert.deepEqual(archiveManagerSelectionAvailability([regular, second]), {
        save: false,
        load: false,
        rename: false,
        export: true,
        delete: true,
    });
    assert.deepEqual(archiveManagerSelectionAvailability([regular, defaults]), {
        save: false,
        load: false,
        rename: false,
        export: true,
        delete: false,
    });
    assert.deepEqual(archiveManagerSelectionAvailability([regular], { dragging: true }), {
        save: false,
        load: false,
        rename: false,
        export: false,
        delete: false,
    });
    assert.deepEqual(archiveManagerSelectionAvailability([regular], { hasState: false }), {
        save: false,
        load: true,
        rename: true,
        export: true,
        delete: true,
    });
    assert.deepEqual(archiveManagerSelectionAvailability([regular], { renaming: true }), {
        save: false,
        load: false,
        rename: false,
        export: false,
        delete: false,
    });
    assert.deepEqual(archiveManagerSelectionAvailability([regular], { busy: true }), {
        save: false,
        load: false,
        rename: false,
        export: false,
        delete: false,
    });
    assert.deepEqual(archiveManagerSelectionAvailability([regular], { loadable: false }), {
        save: true,
        load: false,
        rename: true,
        export: true,
        delete: true,
    });
});

test("quick archive save is enabled only for an available dirty snapshot", () => {
    const archive = { id: "common" };
    assert.equal(canQuickSaveArchive(archive, { dirty: true }), true);
    assert.equal(canQuickSaveArchive(archive, { dirty: false }), false);
    assert.equal(canQuickSaveArchive(null, { dirty: true }), false);
    assert.equal(canQuickSaveArchive(archive, { dirty: true, hasState: false }), false);
    assert.equal(canQuickSaveArchive(archive, { dirty: true, loading: true }), false);
    assert.equal(canQuickSaveArchive(archive, { dirty: true, saving: true }), false);
});

test("quick archive restore is enabled only for an available dirty snapshot", () => {
    const archive = { id: "common" };
    assert.equal(canRestoreArchive(archive, { dirty: true }), true);
    assert.equal(canRestoreArchive(archive, { dirty: false }), false);
    assert.equal(canRestoreArchive(null, { dirty: true }), false);
    assert.equal(canRestoreArchive(archive, { dirty: true, hasState: false }), false);
    assert.equal(canRestoreArchive(archive, { dirty: true, loading: true }), false);
    assert.equal(canRestoreArchive(archive, { dirty: true, saving: true }), false);
});

test("archive toolbar keeps icon actions ordered and the archive group on one line", async () => {
    const toolbarSource = await readFile(
        new URL("../web/prompt_toggle_grid.js", import.meta.url),
        "utf8",
    );
    const styleSource = await readFile(
        new URL("../web/prompt_toggle_grid.css", import.meta.url),
        "utf8",
    );
    assert.match(
        toolbarSource,
        /archiveGroup\.append\(\s*archiveSelect,\s*quickSaveArchiveButton,\s*restoreArchiveButton,\s*manageArchivesButton,/,
    );
    assert.match(
        styleSource,
        /\.cpw-prompt-grid__archive-select\s*\{[^}]*max-width:\s*180px;/s,
    );
    assert.match(
        toolbarSource,
        /cpw-prompt-grid__archive-action-icon--save[\s\S]*cpw-prompt-grid__archive-action-icon--restore[\s\S]*cpw-prompt-grid__archive-action-icon--manage/,
    );
    assert.match(toolbarSource, /button\.dataset\.tooltip = label/);
    assert.match(toolbarSource, /button\.setAttribute\("aria-label", label\)/);
    assert.match(toolbarSource, /setAttribute\("aria-description"/);
    assert.doesNotMatch(toolbarSource, /quickSaveArchiveButton\.textContent/);
    assert.doesNotMatch(toolbarSource, /restoreArchiveButton\.textContent/);
    assert.doesNotMatch(toolbarSource, /manageArchivesButton\.textContent/);
    assert.match(
        styleSource,
        /\.cpw-prompt-grid__archives\s*\{[^}]*flex-wrap:\s*nowrap;/s,
    );
    assert.match(
        styleSource,
        /\.cpw-prompt-grid__button\.cpw-prompt-grid__archive-action\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;/s,
    );
    assert.match(
        styleSource,
        /\.cpw-prompt-grid__archive-action-icon\s*\{[^}]*width:\s*18px;[^}]*height:\s*18px;[^}]*mask:/s,
    );
    assert.match(styleSource, /url\("\.\/assets\/icons\/ic_save\.png"\)/);
    assert.match(styleSource, /url\("\.\/assets\/icons\/ic_restore\.png"\)/);
    assert.match(styleSource, /url\("\.\/assets\/icons\/ic_manage\.png"\)/);
    assert.match(
        styleSource,
        /\.cpw-prompt-grid__archive-action::after\s*\{[^}]*top:\s*calc\(100% \+ 4px\);[^}]*content:\s*attr\(data-tooltip\);/s,
    );
    assert.match(
        styleSource,
        /\.cpw-prompt-grid__archive-action:hover::after,[\s\S]*\.cpw-prompt-grid__archive-action:focus-visible::after/,
    );
});

test("prompt grid toolbar uses one accessible three-state master toggle", async () => {
    const toolbarSource = await readFile(
        new URL("../web/prompt_toggle_grid.js", import.meta.url),
        "utf8",
    );
    const styleSource = await readFile(
        new URL("../web/prompt_toggle_grid.css", import.meta.url),
        "utf8",
    );
    assert.match(toolbarSource, /const masterToggle = element\("button", "cpw-prompt-grid__master-toggle"\)/);
    assert.match(toolbarSource, /masterToggle\.setAttribute\("role", "checkbox"\)/);
    assert.match(toolbarSource, /leadingControls\.append\(masterToggle, columnGroup\)/);
    assert.doesNotMatch(toolbarSource, /const columnLabel =/);
    assert.match(toolbarSource, /createCustomSelect\("cpw-prompt-grid__column-select", t\("Grid columns"\)\)/);
    assert.match(toolbarSource, /label: tp\("\{count\} column", "\{count\} columns", columns\)/);
    assert.match(toolbarSource, /function refreshLocale\(\)[\s\S]*refreshColumnOptions\(\);[\s\S]*aria-label", t\("Grid columns"\)/);
    assert.match(toolbarSource, /actions\.append\(addButton\)/);
    assert.match(toolbarSource, /toolbar\.append\(leadingControls, archiveGroup, actions\)/);
    assert.doesNotMatch(toolbarSource, /actions\.append\(addButton, enableAllButton, disableAllButton\)/);
    assert.match(toolbarSource, /toggleState === "mixed" \? "mixed" : String\(toggleState === "on"\)/);
    assert.match(toolbarSource, /masterToggle\.disabled = toggleState === "empty"/);
    assert.match(toolbarSource, /masterToggle\.dataset\.tooltip = label/);
    assert.match(toolbarSource, /masterToggle\.setAttribute\("aria-label", label\)/);
    assert.match(
        toolbarSource,
        /masterToggle\.addEventListener\("click",[\s\S]*state\.items = toggleAllPromptGridItems\(state\.items\);[\s\S]*commit\(true\);/,
    );
    assert.match(styleSource, /\.cpw-prompt-grid__master-toggle\s*\{[^}]*width:\s*34px;[^}]*height:\s*28px;/s);
    assert.match(styleSource, /\.cpw-prompt-grid__master-toggle\s*\{[^}]*appearance:\s*none;[^}]*border:\s*0;[^}]*background:\s*transparent;/s);
    assert.match(styleSource, /\.cpw-prompt-grid__leading-controls\s*\{[^}]*flex:\s*0 0 auto;[^}]*gap:\s*4px;/s);
    assert.match(styleSource, /\.cpw-prompt-grid__column-select > \.cpw-prompt-grid__select\s*\{[^}]*width:\s*auto;[^}]*min-width:\s*62px;/s);
    assert.match(styleSource, /\.cpw-prompt-grid__master-toggle-track\s*\{[^}]*width:\s*30px;[^}]*height:\s*18px;/s);
    assert.match(styleSource, /\.cpw-prompt-grid__master-toggle\[data-state="on"\][\s\S]*translateX\(12px\)/);
    assert.match(styleSource, /\.cpw-prompt-grid__master-toggle\[data-state="mixed"\][\s\S]*translateX\(6px\)/);
    assert.match(styleSource, /\.cpw-prompt-grid__master-toggle:focus-visible \.cpw-prompt-grid__master-toggle-track/);
    assert.match(
        styleSource,
        /\.cpw-prompt-grid__master-toggle::after\s*\{[^}]*top:\s*calc\(100% \+ 6px\);[^}]*left:\s*0;[^}]*z-index:\s*100;[^}]*content:\s*attr\(data-tooltip\);/s,
    );
    assert.match(
        styleSource,
        /\.cpw-prompt-grid__master-toggle:hover::after,[\s\S]*\.cpw-prompt-grid__master-toggle:focus-visible::after/,
    );
});

test("archive toolbar icon assets are valid 64px PNG files", async () => {
    for (const fileName of ["ic_save.png", "ic_restore.png", "ic_manage.png"]) {
        const png = await readFile(
            new URL(`../web/assets/icons/${fileName}`, import.meta.url),
        );
        assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        assert.equal(png.readUInt32BE(16), 64);
        assert.equal(png.readUInt32BE(20), 64);
    }
});

test("archive manager places load between save and rename and supports row double-click", async () => {
    const managerSource = await readFile(
        new URL("../web/prompt_toggle_grid.js", import.meta.url),
        "utf8",
    );
    assert.match(
        managerSource,
        /\[t\("Save"\),[^\n]+saveSelectedArchive\],\s*\[t\("Load"\),[^\n]+loadSelectedArchive\],\s*\[\s*t\("Rename"\),/s,
    );
    assert.match(managerSource, /row\.addEventListener\("dblclick",/);
    assert.match(managerSource, /async function loadSelectedArchive\(\)[\s\S]*?return requestArchiveLoad\(archive\);/);
});

test("prompt grid cards expose the item context menu while text inputs keep native menus", async () => {
    const widgetSource = await readFile(
        new URL("../web/prompt_toggle_grid.js", import.meta.url),
        "utf8",
    );
    const styleSource = await readFile(
        new URL("../web/prompt_toggle_grid.css", import.meta.url),
        "utf8",
    );
    assert.match(widgetSource, /card\.addEventListener\("contextmenu",/);
    assert.match(widgetSource, /input\[type="text"\], textarea, \[contenteditable="true"\]/);
    assert.match(widgetSource, /makeAction\(t\("Move to Top"\)/);
    assert.match(widgetSource, /t\("Move to Bottom"\),/);
    assert.match(widgetSource, /makeAction\(t\("Delete"\), false, renderDeleteConfirmation\)/);
    assert.match(widgetSource, /cpw-prompt-grid__item-menu-delete-question", t\("Confirm\?"\)/);
    assert.match(widgetSource, /confirmation\.append\(question, confirm, cancel\)/);
    assert.match(widgetSource, /queueMicrotask\(\(\) => cancel\.focus\(\)\)/);
    assert.match(widgetSource, /if \(deleteConfirming\) \{\s*renderDeleteAction\(\{ restoreFocus: true \}\);/s);
    assert.match(widgetSource, /function deleteItem\(itemId\)[\s\S]*state\.items = nextItems;[\s\S]*commit\(true\);/);
    assert.match(widgetSource, /card\.addEventListener\("pointerdown",[\s\S]*event\.target\?\.closest\?\.\([\s\S]*button, input, textarea, select, option, label, a,[\s\S]*beginPointerDrag\(event, item\.id, card, card\);/);
    assert.doesNotMatch(widgetSource, /element\("button", "cpw-prompt-grid__drag"/);
    assert.doesNotMatch(widgetSource, /element\("button", "cpw-prompt-grid__delete"/);
    assert.doesNotMatch(widgetSource, /cpw-prompt-grid__card-actions/);
    assert.match(widgetSource, /document\.addEventListener\("pointerdown", onDocumentPointerDown, true\)/);
    assert.match(widgetSource, /document\.addEventListener\("scroll", onViewportChange, true\)/);
    assert.match(widgetSource, /window\.addEventListener\("resize", onViewportChange\)/);
    assert.match(widgetSource, /keyEvent\.key === "Escape"/);
    assert.match(styleSource, /\.cpw-prompt-grid__card--colored\s*\{/);
    assert.match(styleSource, /\.cpw-prompt-grid__item-menu\s*\{/);
    assert.match(styleSource, /\.cpw-prompt-grid__item-color\s*\{/);
    assert.match(styleSource, /\.cpw-prompt-grid__card\s*\{[^}]*cursor:\s*grab;/s);
    assert.match(styleSource, /\.cpw-prompt-grid__card--dragging\s*\{[^}]*cursor:\s*grabbing;/s);
    assert.match(styleSource, /\.cpw-prompt-grid__item-menu-delete-confirm\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto auto;/s);
    assert.match(styleSource, /\.cpw-prompt-grid__item-menu-action--danger/);
    assert.doesNotMatch(styleSource, /\.cpw-prompt-grid__card-actions/);
    assert.doesNotMatch(styleSource, /\.cpw-prompt-grid__delete--confirm/);
});

test("export bundle and preview use the stable portable format", () => {
    const archive = { id: "a", name: "人物", snapshot: snapshotFromState(state) };
    const bundle = buildArchiveExportBundle([archive], "2026-08-10T00:00:00.000Z");
    assert.equal(bundle.format, "prompt-weaver-prompt-grid-archives");
    assert.deepEqual(validateImportBundlePreview(bundle), {
        bundle,
        archiveCount: 1,
        itemCount: 1,
    });
    assert.throws(() => validateImportBundlePreview({ format: "bad", archives: [] }));
});

test("default names are deterministic and filesystem friendly", () => {
    assert.equal(defaultArchiveName(new Date(2026, 7, 10, 9, 8, 7)), "Archive 2026-08-10 09-08-07");
});

test("retained prompt token state survives archive round trips and participates in dirty state", () => {
    const retainedState = structuredClone(state);
    retainedState.items[0].prompt = "masterpiece";
    retainedState.items[0].prompt_tokens = [
        { text: "masterpiece", selected: true },
        { text: "blue eyes", selected: false },
    ];
    const saved = snapshotFromState(retainedState);
    assert.deepEqual(saved.items[0].prompt_tokens, retainedState.items[0].prompt_tokens);
    assert.deepEqual(configFromArchiveSnapshot(saved).items[0].prompt_tokens, [
        { text: "masterpiece", selected: true },
        { text: "blue eyes", selected: false },
    ]);
    assert.notEqual(semanticFingerprint(saved), semanticFingerprint(snapshotFromState(state)));

    retainedState.items[0].retain_unselected = false;
    const disabled = snapshotFromState(retainedState);
    assert.equal(disabled.items[0].retain_unselected, false);
    assert.equal(disabled.items[0].prompt_tokens, undefined);
});

test("new and legacy pristine default snapshots localize without becoming dirty", () => {
    const english = {
        version: 1,
        columns: 2,
        node_size: { width: 600, height: 420 },
        items: Array.from({ length: 4 }, (_, index) => ({
            id: `prompt-${index + 1}`,
            enabled: true,
            title: `Prompt ${index + 1}`,
            prompt: "",
        })),
    };
    const chinese = localizePristineDefaultSnapshot(
        english,
        (index) => `卡片 ${String(index).padStart(2, "0")}`,
    );
    assert.equal(isPristineDefaultSnapshot(english), true);
    assert.equal(isPristineDefaultSnapshot(chinese), true);
    assert.equal(semanticFingerprint(english), semanticFingerprint(chinese));
    assert.equal(resolveArchiveStatus([
        { id: DEFAULT_ARCHIVE_ID, snapshot: english },
    ], chinese, DEFAULT_ARCHIVE_ID).dirty, false);

    const newEnglish = localizePristineDefaultSnapshot(
        english,
        (index) => `Card ${String(index).padStart(2, "0")}`,
    );
    assert.equal(isPristineDefaultSnapshot(newEnglish), true);
    assert.equal(semanticFingerprint(english), semanticFingerprint(newEnglish));

    const edited = structuredClone(chinese);
    edited.items[0].prompt = "masterpiece";
    assert.equal(isPristineDefaultSnapshot(edited), false);
    assert.notEqual(semanticFingerprint(english), semanticFingerprint(edited));
    const retentionDisabled = structuredClone(english);
    retentionDisabled.items[0].retain_unselected = false;
    assert.equal(isPristineDefaultSnapshot(retentionDisabled), false);
    assert.notEqual(semanticFingerprint(english), semanticFingerprint(retentionDisabled));
});

test("API client preserves paths, methods, payloads, and server errors", async () => {
    const requests = [];
    const api = {
        async fetchApi(path, options = {}) {
            requests.push({ path, options });
            return { ok: true, status: 200, async json() { return { archives: [] }; } };
        },
    };
    const client = new PromptGridArchiveClient(api);
    await client.list();
    await client.create("人物", snapshotFromState(state));
    await client.update("id with space", { name: "夜景" });
    await client.delete("id with space");
    await client.deleteMany(["first", "second"]);
    await client.select("id with space");
    await client.reorder(["second", "first"]);
    assert.equal(requests[0].path, "/prompt-weaver/prompt-grid-archives");
    assert.equal(requests[1].options.method, "POST");
    assert.equal(requests[2].path, "/prompt-weaver/prompt-grid-archives/id%20with%20space");
    assert.equal(requests[3].options.method, "DELETE");
    assert.equal(requests[4].path, "/prompt-weaver/prompt-grid-archives");
    assert.equal(requests[4].options.method, "DELETE");
    assert.deepEqual(JSON.parse(requests[4].options.body), {
        archive_ids: ["first", "second"],
    });
    assert.equal(requests[5].path, "/prompt-weaver/prompt-grid-archives/selection");
    assert.equal(requests[5].options.method, "PATCH");
    assert.equal(requests[6].path, "/prompt-weaver/prompt-grid-archives/order");
    assert.equal(requests[6].options.method, "PATCH");
    assert.deepEqual(JSON.parse(requests[6].options.body), {
        archive_ids: ["second", "first"],
    });

    const failing = new PromptGridArchiveClient({
        async fetchApi() {
            return { ok: false, status: 409, async json() { return { error: "duplicate" }; } };
        },
    });
    await assert.rejects(
        () => failing.list(),
        (error) => error.message === "duplicate" && error.status === 409 && error.serverMessage === "duplicate",
    );
});
