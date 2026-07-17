import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const moduleSource = await readFile(
    new URL("../web/prompt_grid_archives.js", import.meta.url),
    "utf8",
);
const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`;
const {
    DEFAULT_ARCHIVE_ID,
    PromptGridArchiveClient,
    applyArchiveManagerSelectionGesture,
    archiveManagerSelectionAvailability,
    buildArchiveExportBundle,
    canQuickSaveArchive,
    configFromArchiveSnapshot,
    defaultArchiveName,
    findMatchingArchive,
    formatArchiveOptionLabel,
    normalizeArchiveNodeSize,
    normalizeArchiveManagerSelection,
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

test("snapshot extraction keeps only execution state", () => {
    assert.deepEqual(snapshotFromState(state), {
        version: 1,
        columns: 2,
        node_size: { width: 600, height: 420 },
        items: [{ id: "one", enabled: true, title: "画质", prompt: "masterpiece" }],
    });
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
        rename: false,
        export: false,
        delete: false,
    });
    assert.deepEqual(archiveManagerSelectionAvailability([regular]), {
        save: true,
        rename: true,
        export: true,
        delete: true,
    });
    assert.deepEqual(archiveManagerSelectionAvailability([defaults]), {
        save: true,
        rename: false,
        export: true,
        delete: false,
    });
    assert.deepEqual(archiveManagerSelectionAvailability([regular, second]), {
        save: false,
        rename: false,
        export: true,
        delete: true,
    });
    assert.deepEqual(archiveManagerSelectionAvailability([regular, defaults]), {
        save: false,
        rename: false,
        export: true,
        delete: false,
    });
    assert.deepEqual(archiveManagerSelectionAvailability([regular], { dragging: true }), {
        save: false,
        rename: false,
        export: false,
        delete: false,
    });
    assert.deepEqual(archiveManagerSelectionAvailability([regular], { hasState: false }), {
        save: false,
        rename: true,
        export: true,
        delete: true,
    });
    assert.deepEqual(archiveManagerSelectionAvailability([regular], { renaming: true }), {
        save: false,
        rename: false,
        export: false,
        delete: false,
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
    assert.equal(defaultArchiveName(new Date(2026, 7, 10, 9, 8, 7)), "存档 2026-08-10 09-08-07");
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
    await assert.rejects(() => failing.list(), /duplicate/);
});
