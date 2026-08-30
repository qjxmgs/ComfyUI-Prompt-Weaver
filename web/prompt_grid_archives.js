import { t } from "./prompt_weaver_i18n.js";

export const ARCHIVE_EXPORT_FORMAT = "prompt-weaver-prompt-grid-archives";
export const ARCHIVE_FORMAT_VERSION = 1;
export const DEFAULT_ARCHIVE_ID = "00000000-0000-4000-8000-000000000000";
export const DEFAULT_ARCHIVE_NAME = "默认存档";
export const DEFAULT_ARCHIVE_NODE_SIZE = Object.freeze({ width: 600, height: 420 });
export const PROMPT_GRID_ITEM_COLORS = Object.freeze({
    red: Object.freeze({ label: "Red", hex: "#ef5350" }),
    orange: Object.freeze({ label: "Orange", hex: "#fb8c00" }),
    yellow: Object.freeze({ label: "Yellow", hex: "#fdd835" }),
    green: Object.freeze({ label: "Green", hex: "#43a047" }),
    cyan: Object.freeze({ label: "Cyan", hex: "#26c6da" }),
    blue: Object.freeze({ label: "Blue", hex: "#42a5f5" }),
    purple: Object.freeze({ label: "Purple", hex: "#ab47bc" }),
    pink: Object.freeze({ label: "Pink", hex: "#ec407a" }),
    gray: Object.freeze({ label: "Gray", hex: "#78909c" }),
    white: Object.freeze({ label: "White", hex: "#f5f5f5" }),
    black: Object.freeze({ label: "Black", hex: "#212121" }),
});
const MIN_ARCHIVE_NODE_WIDTH = 600;
const MIN_ARCHIVE_NODE_HEIGHT = 254;
const MAX_ARCHIVE_NODE_SIZE = 10_000;
const FAVORITE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizePromptGridItemColor(value) {
    return typeof value === "string"
        && Object.prototype.hasOwnProperty.call(PROMPT_GRID_ITEM_COLORS, value)
        ? value
        : null;
}

export function normalizePromptCardFavoriteId(value) {
    return typeof value === "string" && FAVORITE_ID_PATTERN.test(value.trim())
        ? value.trim().toLowerCase()
        : null;
}

function archiveItem(item) {
    const color = normalizePromptGridItemColor(item?.color);
    const favoriteId = normalizePromptCardFavoriteId(item?.favorite_id);
    const retainUnselected = item?.retain_unselected !== false;
    const promptTokens = retainUnselected && Array.isArray(item?.prompt_tokens)
        ? item.prompt_tokens
            .filter((entry) => (
                entry
                && typeof entry.text === "string"
                && entry.text.trim()
                && typeof entry.selected === "boolean"
            ))
            .map((entry) => ({ text: entry.text.trim(), selected: entry.selected }))
        : [];
    const hasInactiveTokens = promptTokens.some((entry) => !entry.selected);
    return {
        id: item.id,
        enabled: item.enabled,
        title: item.title,
        prompt: item.prompt,
        ...(color ? { color } : {}),
        ...(favoriteId ? { favorite_id: favoriteId } : {}),
        ...(!retainUnselected ? { retain_unselected: false } : {}),
        ...(hasInactiveTokens ? { prompt_tokens: promptTokens } : {}),
    };
}

export function normalizeArchiveNodeSize(value) {
    // LiteGraph/Nodes 2.0 may expose size as an Array, Float32Array, or
    // another array-like vector. Prefer numeric indexes before the persisted
    // {width, height} archive representation.
    const rawWidth = Number.isFinite(value?.[0]) ? value[0] : value?.width;
    const rawHeight = Number.isFinite(value?.[1]) ? value[1] : value?.height;
    const normalizeDimension = (dimension, fallback, minimum) => {
        if (!Number.isFinite(dimension)) return fallback;
        return Math.min(MAX_ARCHIVE_NODE_SIZE, Math.max(minimum, Math.round(dimension)));
    };
    return {
        width: normalizeDimension(rawWidth, DEFAULT_ARCHIVE_NODE_SIZE.width, MIN_ARCHIVE_NODE_WIDTH),
        height: normalizeDimension(rawHeight, DEFAULT_ARCHIVE_NODE_SIZE.height, MIN_ARCHIVE_NODE_HEIGHT),
    };
}

export function snapshotFromState(state, nodeSize = DEFAULT_ARCHIVE_NODE_SIZE) {
    return {
        version: 1,
        columns: state.columns,
        node_size: normalizeArchiveNodeSize(nodeSize),
        items: state.items.map(archiveItem),
    };
}

export function configFromArchiveSnapshot(snapshot) {
    return {
        version: 1,
        columns: snapshot.columns,
        items: snapshot.items.map(archiveItem),
    };
}

export function isPristineDefaultSnapshot(snapshot) {
    const size = normalizeArchiveNodeSize(snapshot?.node_size);
    return snapshot?.version === 1
        && snapshot?.columns === 2
        && size.width === DEFAULT_ARCHIVE_NODE_SIZE.width
        && size.height === DEFAULT_ARCHIVE_NODE_SIZE.height
        && Array.isArray(snapshot?.items)
        && snapshot.items.length === 4
        && snapshot.items.every((item, index) => {
            const number = index + 1;
            return item?.id === `prompt-${number}`
                && item.enabled === true
                && item.prompt === ""
                && item.retain_unselected !== false
                && !Array.isArray(item.prompt_tokens)
                && !normalizePromptGridItemColor(item.color)
                && (
                    item.title === `Card ${String(number).padStart(2, "0")}`
                    || item.title === `\u5361\u7247 ${String(number).padStart(2, "0")}`
                    || item.title === `Prompt ${number}`
                    || item.title === `提示词 ${number}`
                );
        });
}

export function localizePristineDefaultSnapshot(snapshot, titleFactory) {
    if (!isPristineDefaultSnapshot(snapshot) || typeof titleFactory !== "function") return snapshot;
    return {
        ...snapshot,
        items: snapshot.items.map((item, index) => ({
            ...item,
            title: titleFactory(index + 1),
        })),
    };
}

function gridSemantics(snapshot) {
    const pristineDefault = isPristineDefaultSnapshot(snapshot);
    return {
        columns: snapshot.columns,
        items: snapshot.items.map((item, index) => {
            const color = normalizePromptGridItemColor(item?.color);
            const favoriteId = normalizePromptCardFavoriteId(item?.favorite_id);
            return {
                enabled: item.enabled,
                title: pristineDefault ? `__prompt_weaver_default_${index + 1}__` : item.title,
                prompt: item.prompt,
                ...(color ? { color } : {}),
                ...(favoriteId ? { favorite_id: favoriteId } : {}),
                ...(item.retain_unselected === false ? { retain_unselected: false } : {}),
                ...(Array.isArray(item.prompt_tokens) && item.prompt_tokens.some((entry) => !entry.selected)
                    ? {
                        prompt_tokens: item.prompt_tokens.map((entry) => ({
                            text: entry.text,
                            selected: entry.selected,
                        })),
                    }
                    : {}),
            };
        }),
    };
}

function gridFingerprint(snapshot) {
    return JSON.stringify(gridSemantics(snapshot));
}

export function semanticFingerprint(snapshot) {
    return JSON.stringify({
        grid: gridSemantics(snapshot),
        node_size: normalizeArchiveNodeSize(snapshot.node_size),
    });
}

export function findMatchingArchive(archives, snapshot) {
    const fingerprint = gridFingerprint(snapshot);
    return archives.find((archive) => gridFingerprint(archive.snapshot) === fingerprint) ?? null;
}

export function resolveArchiveInitialization(
    archives,
    snapshot,
    { persistedArchiveId = null, lastSelectedArchiveId = DEFAULT_ARCHIVE_ID, isNewNode = false } = {},
) {
    const defaultArchive = archives.find((archive) => archive.id === DEFAULT_ARCHIVE_ID) ?? null;
    if (persistedArchiveId) {
        const persisted = archives.find((archive) => archive.id === persistedArchiveId) ?? null;
        return {
            activeArchiveId: persisted?.id ?? defaultArchive?.id ?? DEFAULT_ARCHIVE_ID,
            loadSnapshot: false,
        };
    }
    if (isNewNode) {
        const globalArchive = archives.find((archive) => archive.id === lastSelectedArchiveId) ?? null;
        return {
            activeArchiveId: globalArchive?.id ?? defaultArchive?.id ?? DEFAULT_ARCHIVE_ID,
            loadSnapshot: Boolean(globalArchive ?? defaultArchive),
        };
    }
    const match = findMatchingArchive(archives, snapshot);
    return {
        activeArchiveId: match?.id ?? defaultArchive?.id ?? DEFAULT_ARCHIVE_ID,
        loadSnapshot: false,
    };
}

export function resolveArchiveStatus(archives, snapshot, activeArchiveId) {
    const activeArchive = archives.find((archive) => archive.id === activeArchiveId) ?? null;
    if (activeArchive) {
        return {
            activeArchiveId: activeArchive.id,
            dirty: semanticFingerprint(activeArchive.snapshot) !== semanticFingerprint(snapshot),
        };
    }

    const defaultArchive = archives.find((archive) => archive.id === DEFAULT_ARCHIVE_ID) ?? null;
    return {
        activeArchiveId: defaultArchive?.id ?? DEFAULT_ARCHIVE_ID,
        dirty: !defaultArchive
            || semanticFingerprint(defaultArchive.snapshot) !== semanticFingerprint(snapshot),
    };
}

export function formatArchiveOptionLabel(label, marked = false) {
    return `${marked ? "* " : "\u00A0\u00A0"}${label}`;
}

export function reorderArchiveIds(archiveIds, draggedId, beforeId = null) {
    const sourceIndex = archiveIds.indexOf(draggedId);
    if (sourceIndex < 0 || beforeId === draggedId) return [...archiveIds];
    const reordered = archiveIds.filter((archiveId) => archiveId !== draggedId);
    if (beforeId === null) {
        reordered.push(draggedId);
        return reordered;
    }
    const targetIndex = reordered.indexOf(beforeId);
    if (targetIndex < 0) return [...archiveIds];
    reordered.splice(targetIndex, 0, draggedId);
    return reordered;
}

export function normalizeArchiveManagerSelection(archives, selectedArchiveIds) {
    const candidates = Array.isArray(archives) ? archives : [];
    const selected = selectedArchiveIds instanceof Set
        ? selectedArchiveIds
        : new Set(Array.isArray(selectedArchiveIds) ? selectedArchiveIds : []);
    return candidates
        .filter((archive) => selected.has(archive.id))
        .map((archive) => archive.id);
}

export function applyArchiveManagerSelectionGesture(
    archiveIds,
    selectedArchiveIds,
    archiveId,
    anchorId = null,
    { additive = false, range = false } = {},
) {
    const orderedIds = Array.isArray(archiveIds) ? [...archiveIds] : [];
    const current = new Set(
        selectedArchiveIds instanceof Set
            ? selectedArchiveIds
            : (Array.isArray(selectedArchiveIds) ? selectedArchiveIds : []),
    );
    const normalize = (values) => orderedIds.filter((id) => values.has(id));
    const targetIndex = orderedIds.indexOf(archiveId);
    if (targetIndex < 0) {
        return {
            selectedIds: normalize(current),
            anchorId: orderedIds.includes(anchorId) ? anchorId : null,
        };
    }

    if (range) {
        const anchorIndex = orderedIds.indexOf(anchorId);
        if (anchorIndex >= 0) {
            const start = Math.min(anchorIndex, targetIndex);
            const end = Math.max(anchorIndex, targetIndex);
            const next = additive ? new Set(current) : new Set();
            for (const id of orderedIds.slice(start, end + 1)) next.add(id);
            return { selectedIds: normalize(next), anchorId };
        }
        const next = additive ? new Set(current) : new Set();
        next.add(archiveId);
        return { selectedIds: normalize(next), anchorId: archiveId };
    }

    if (additive) {
        if (current.has(archiveId)) current.delete(archiveId);
        else current.add(archiveId);
        return { selectedIds: normalize(current), anchorId: archiveId };
    }

    return { selectedIds: [archiveId], anchorId: archiveId };
}

export function archiveManagerSelectionAvailability(
    selectedArchives,
    {
        busy = false,
        dragging = false,
        renaming = false,
        hasState = true,
        loadable = true,
    } = {},
) {
    const selection = Array.isArray(selectedArchives) ? selectedArchives : [];
    const locked = busy || dragging || renaming || selection.length === 0;
    const single = selection.length === 1;
    const includesDefault = selection.some(
        (archive) => archive?.is_default || archive?.id === DEFAULT_ARCHIVE_ID,
    );
    return {
        save: !locked && single && hasState,
        load: !locked && single && loadable,
        rename: !locked && single && !includesDefault,
        export: !locked,
        delete: !locked && !includesDefault,
    };
}

function canUseDirtyArchive(
    archive,
    { dirty = false, hasState = true, loading = false, saving = false } = {},
) {
    return Boolean(archive && dirty && hasState && !loading && !saving);
}

export function canQuickSaveArchive(archive, status = {}) {
    return canUseDirtyArchive(archive, status);
}

export function canRestoreArchive(archive, status = {}) {
    return canUseDirtyArchive(archive, status);
}

export function buildArchiveExportBundle(archives, exportedAt = new Date().toISOString()) {
    return {
        format: ARCHIVE_EXPORT_FORMAT,
        format_version: ARCHIVE_FORMAT_VERSION,
        exported_at: exportedAt,
        archives: archives.map((archive) => structuredClone(archive)),
    };
}

export function validateImportBundlePreview(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(t("The top level of the import file must be an object"));
    }
    if (value.format !== ARCHIVE_EXPORT_FORMAT || value.format_version !== ARCHIVE_FORMAT_VERSION) {
        throw new Error(t("Unsupported archive file format"));
    }
    if (!Array.isArray(value.archives) || !value.archives.length) {
        throw new Error(t("The import file does not contain any archives"));
    }
    return {
        bundle: value,
        archiveCount: value.archives.length,
        itemCount: value.archives.reduce(
            (total, archive) => total + (Array.isArray(archive?.snapshot?.items) ? archive.snapshot.items.length : 0),
            0,
        ),
    };
}

export function defaultArchiveName(date = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    const timestamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
    return t("Archive {timestamp}", { timestamp });
}

export class PromptGridArchiveClient {
    constructor(api) {
        this.api = api;
        this.basePath = "/prompt-weaver/prompt-grid-archives";
    }

    async request(path = "", options = {}) {
        const response = await this.api.fetchApi(`${this.basePath}${path}`, options);
        let payload = null;
        try {
            payload = await response.json();
        } catch {
            // Preserve the HTTP status when the server returns a non-JSON error.
        }
        if (!response.ok) {
            const error = new Error(
                payload?.error || t("Archive request failed (HTTP {status})", { status: response.status }),
            );
            error.status = response.status;
            error.serverMessage = payload?.error ?? null;
            throw error;
        }
        return payload;
    }

    list() {
        return this.request();
    }

    create(name, snapshot) {
        return this.request("", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, snapshot }),
        });
    }

    update(id, changes) {
        return this.request(`/${encodeURIComponent(id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(changes),
        });
    }

    delete(id) {
        return this.request(`/${encodeURIComponent(id)}`, { method: "DELETE" });
    }

    deleteMany(archiveIds) {
        return this.request("", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ archive_ids: archiveIds }),
        });
    }

    select(id) {
        return this.request("/selection", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ archive_id: id }),
        });
    }

    reorder(archiveIds) {
        return this.request("/order", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ archive_ids: archiveIds }),
        });
    }

    import(bundle, conflictPolicy) {
        return this.request("/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bundle, conflict_policy: conflictPolicy }),
        });
    }
}
