import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const moduleSource = await readFile(
    new URL("../web/prompt_grid_archives.js", import.meta.url),
    "utf8",
);
const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`;
const {
    PromptGridArchiveClient,
    buildArchiveExportBundle,
    defaultArchiveName,
    findMatchingArchive,
    isDefaultSnapshot,
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
        items: [{ id: "one", enabled: true, title: "画质", prompt: "masterpiece" }],
    });
});

test("semantic fingerprints ignore internal ids but preserve visible order and state", () => {
    const left = snapshotFromState(state);
    const right = structuredClone(left);
    right.items[0].id = "different";
    assert.equal(semanticFingerprint(left), semanticFingerprint(right));
    assert.equal(findMatchingArchive([{ id: "archive", snapshot: right }], left)?.id, "archive");
    right.items[0].enabled = false;
    assert.notEqual(semanticFingerprint(left), semanticFingerprint(right));
});

test("default detection compares semantic state", () => {
    const current = snapshotFromState(state);
    const defaults = structuredClone(current);
    defaults.items[0].id = "new-id";
    assert.equal(isDefaultSnapshot(current, defaults), true);
    defaults.columns = 3;
    assert.equal(isDefaultSnapshot(current, defaults), false);
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
    assert.equal(requests[0].path, "/prompt-weaver/prompt-grid-archives");
    assert.equal(requests[1].options.method, "POST");
    assert.equal(requests[2].path, "/prompt-weaver/prompt-grid-archives/id%20with%20space");
    assert.equal(requests[3].options.method, "DELETE");

    const failing = new PromptGridArchiveClient({
        async fetchApi() {
            return { ok: false, status: 409, async json() { return { error: "duplicate" }; } };
        },
    });
    await assert.rejects(() => failing.list(), /duplicate/);
});
