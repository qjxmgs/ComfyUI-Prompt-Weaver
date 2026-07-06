export const ARCHIVE_EXPORT_FORMAT = "prompt-weaver-prompt-grid-archives";
export const ARCHIVE_FORMAT_VERSION = 1;
export const DEFAULT_ARCHIVE_ID = "00000000-0000-4000-8000-000000000000";
export const DEFAULT_ARCHIVE_NAME = "默认存档";

export function snapshotFromState(state) {
    return {
        version: 1,
        columns: state.columns,
        items: state.items.map((item) => ({
            id: item.id,
            enabled: item.enabled,
            title: item.title,
            prompt: item.prompt,
        })),
    };
}

export function semanticFingerprint(snapshot) {
    return JSON.stringify({
        columns: snapshot.columns,
        items: snapshot.items.map((item) => ({
            enabled: item.enabled,
            title: item.title,
            prompt: item.prompt,
        })),
    });
}

export function findMatchingArchive(archives, snapshot) {
    const fingerprint = semanticFingerprint(snapshot);
    return archives.find((archive) => semanticFingerprint(archive.snapshot) === fingerprint) ?? null;
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
        throw new Error("导入文件顶层必须是对象");
    }
    if (value.format !== ARCHIVE_EXPORT_FORMAT || value.format_version !== ARCHIVE_FORMAT_VERSION) {
        throw new Error("不支持的存档文件格式");
    }
    if (!Array.isArray(value.archives) || !value.archives.length) {
        throw new Error("导入文件不包含存档");
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
    return `存档 ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
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
            throw new Error(payload?.error || `存档请求失败（HTTP ${response.status}）`);
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

    select(id) {
        return this.request("/selection", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ archive_id: id }),
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
