const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_RESULT_LIMIT = 12;
const EXTENSION_MODULE_PATTERN = /^\/extensions\/([^/]+)\/modules\/tag\.js$/i;
const PROMPT_ASSISTANT_FOLDER_PATTERN = /prompt[-_]?assistant/i;
const HAN_CHARACTER_PATTERN = /\p{Script=Han}/u;

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function responseIsOk(response) {
    return Boolean(response) && response.ok !== false && typeof response.json === "function";
}

async function readJsonResponse(response, label) {
    if (!responseIsOk(response)) throw new Error(`${label} 请求失败。`);
    try {
        return await response.json();
    } catch (_error) {
        throw new Error(`${label} 返回了无效 JSON。`);
    }
}

export function normalizePromptAssistantSearchText(value) {
    const text = typeof value === "string" ? value : "";
    try {
        return text.normalize("NFKC").trim().toLowerCase();
    } catch (_error) {
        return text.trim().toLowerCase();
    }
}

export function promptAssistantQueryIsEligible(value) {
    const query = normalizePromptAssistantSearchText(value);
    if (!query) return false;
    return HAN_CHARACTER_PATTERN.test(query) || [...query].length >= 2;
}

export function findPromptAssistantApiBases(extensionEntries) {
    const bases = [];
    const seen = new Set();
    for (const entry of Array.isArray(extensionEntries) ? extensionEntries : []) {
        if (typeof entry !== "string") continue;
        let pathname;
        try {
            pathname = new URL(entry, "http://prompt-weaver.local").pathname;
        } catch (_error) {
            continue;
        }
        const match = pathname.match(EXTENSION_MODULE_PATTERN);
        if (!match || !PROMPT_ASSISTANT_FOLDER_PATTERN.test(match[1])) continue;
        const base = `/${match[1]}/api`;
        if (!seen.has(base)) {
            seen.add(base);
            bases.push(base);
        }
    }
    return bases;
}

export function validatePromptAssistantTagFiles(payload) {
    if (!isPlainObject(payload) || payload.success !== true || !Array.isArray(payload.files)) {
        throw new Error("Prompt Assistant 标签文件列表格式无效。");
    }
    const files = [];
    const seen = new Set();
    for (const file of payload.files) {
        if (
            typeof file !== "string"
            || !file.toLowerCase().endsWith(".csv")
            || file.includes("/")
            || file.includes("\\")
            || file.includes("\0")
        ) {
            throw new Error("Prompt Assistant 返回了无效标签文件名。");
        }
        if (!seen.has(file)) {
            seen.add(file);
            files.push(file);
        }
    }
    return files;
}

export function flattenPromptAssistantTagData(data, sourceFile = "") {
    if (!isPlainObject(data)) throw new Error("Prompt Assistant 标签数据必须是对象。");
    const records = [];

    const visit = (value, path) => {
        if (typeof value === "string") {
            if (!path.length) throw new Error("Prompt Assistant 标签名称缺失。");
            const name = path[path.length - 1].trim();
            const promptValue = value.trim();
            if (name && promptValue) {
                records.push({
                    name,
                    value: promptValue,
                    aliases: [name],
                    categoryPath: path.slice(0, -1),
                    sourceFile,
                });
            }
            return;
        }
        if (!isPlainObject(value)) {
            throw new Error("Prompt Assistant 标签数据包含非对象分组或非字符串标签。");
        }
        for (const [key, child] of Object.entries(value)) {
            if (typeof key !== "string" || !key.trim()) {
                throw new Error("Prompt Assistant 标签数据包含无效名称。");
            }
            visit(child, [...path, key]);
        }
    };

    visit(data, []);
    return records;
}

export function mergePromptAssistantTagRecords(records) {
    const merged = [];
    const recordByValue = new Map();
    for (const record of Array.isArray(records) ? records : []) {
        if (!record || typeof record.name !== "string" || typeof record.value !== "string") continue;
        const key = normalizePromptAssistantSearchText(record.value);
        if (!key) continue;
        const existing = recordByValue.get(key);
        if (!existing) {
            const aliases = [];
            const aliasKeys = new Set();
            for (const alias of [record.name, ...(Array.isArray(record.aliases) ? record.aliases : [])]) {
                const normalizedAlias = normalizePromptAssistantSearchText(alias);
                if (!normalizedAlias || aliasKeys.has(normalizedAlias)) continue;
                aliasKeys.add(normalizedAlias);
                aliases.push(alias.trim());
            }
            const next = {
                name: record.name.trim(),
                value: record.value.trim(),
                aliases,
                categoryPath: Array.isArray(record.categoryPath) ? [...record.categoryPath] : [],
                sourceFile: typeof record.sourceFile === "string" ? record.sourceFile : "",
            };
            recordByValue.set(key, { record: next, aliasKeys });
            merged.push(next);
            continue;
        }
        for (const alias of [record.name, ...(Array.isArray(record.aliases) ? record.aliases : [])]) {
            const normalizedAlias = normalizePromptAssistantSearchText(alias);
            if (!normalizedAlias || existing.aliasKeys.has(normalizedAlias)) continue;
            existing.aliasKeys.add(normalizedAlias);
            existing.record.aliases.push(alias.trim());
        }
    }
    return merged;
}

function matchRank(field, query) {
    if (field === query) return 0;
    if (field.startsWith(query)) return 1;
    if (field.includes(query)) return 2;
    return Number.POSITIVE_INFINITY;
}

export function searchPromptAssistantTags(records, queryValue, limit = DEFAULT_RESULT_LIMIT) {
    const query = normalizePromptAssistantSearchText(queryValue);
    if (!promptAssistantQueryIsEligible(query)) return [];
    const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_RESULT_LIMIT;
    const matches = [];

    for (let index = 0; index < (Array.isArray(records) ? records.length : 0); index += 1) {
        const record = records[index];
        if (!record || typeof record.value !== "string") continue;
        const fields = [record.value, ...(Array.isArray(record.aliases) ? record.aliases : [record.name])]
            .map(normalizePromptAssistantSearchText)
            .filter(Boolean);
        let rank = Number.POSITIVE_INFINITY;
        for (const field of fields) rank = Math.min(rank, matchRank(field, query));
        if (Number.isFinite(rank)) matches.push({ record, rank, index });
    }

    matches.sort((left, right) => left.rank - right.rank || left.index - right.index);
    return matches.slice(0, safeLimit).map(({ record }) => record);
}

export function formatPromptAssistantTagOption(record) {
    const name = typeof record?.name === "string" ? record.name.trim() : "";
    const value = typeof record?.value === "string" ? record.value.trim() : "";
    if (!name) return value;
    if (!value || normalizePromptAssistantSearchText(name) === normalizePromptAssistantSearchText(value)) {
        return name;
    }
    return `${name}（${value}）`;
}

export function movePromptAssistantSuggestionIndex(currentIndex, resultCount, direction) {
    if (!Number.isInteger(resultCount) || resultCount <= 0) return -1;
    if (direction > 0) return currentIndex < 0 ? 0 : (currentIndex + 1) % resultCount;
    if (direction < 0) return currentIndex < 0 ? resultCount - 1 : (currentIndex - 1 + resultCount) % resultCount;
    return currentIndex >= 0 && currentIndex < resultCount ? currentIndex : -1;
}

export class PromptAssistantTagCatalog {
    constructor(api, { cacheTtlMs = DEFAULT_CACHE_TTL_MS, now = () => Date.now(), onDiagnostic } = {}) {
        this.api = api;
        this.cacheTtlMs = cacheTtlMs;
        this.now = now;
        this.onDiagnostic = typeof onDiagnostic === "function" ? onDiagnostic : null;
        this.cachedRecords = [];
        this.cacheExpiresAt = 0;
        this.pendingLoad = null;
        this.warnedMessages = new Set();
    }

    diagnoseOnce(message, error = null) {
        if (this.warnedMessages.has(message)) return;
        this.warnedMessages.add(message);
        this.onDiagnostic?.(message, error);
    }

    async fetchJson(path, label) {
        if (!this.api || typeof this.api.fetchApi !== "function") {
            throw new Error("ComfyUI API 客户端不可用。");
        }
        return readJsonResponse(await this.api.fetchApi(path), label);
    }

    async discover() {
        const entries = await this.fetchJson("/extensions", "ComfyUI 扩展列表");
        for (const apiBase of findPromptAssistantApiBases(entries)) {
            try {
                const payload = await this.fetchJson(
                    `${apiBase}/config/tags_files`,
                    "Prompt Assistant 标签文件列表",
                );
                return { apiBase, files: validatePromptAssistantTagFiles(payload) };
            } catch (error) {
                this.diagnoseOnce(`无法使用 Prompt Assistant 标签接口：${apiBase}`, error);
            }
        }
        return null;
    }

    async loadUncached() {
        let discovered;
        try {
            discovered = await this.discover();
        } catch (error) {
            this.diagnoseOnce("无法读取 ComfyUI 扩展列表，标签自动补全已隐藏。", error);
            return [];
        }
        if (!discovered || !discovered.files.length) return [];

        const settled = await Promise.allSettled(discovered.files.map(async (file) => {
            const payload = await this.fetchJson(
                `${discovered.apiBase}/config/tags_csv/${encodeURIComponent(file)}`,
                `Prompt Assistant 标签文件 ${file}`,
            );
            if (!isPlainObject(payload) || payload.success !== true || !isPlainObject(payload.data)) {
                throw new Error(`Prompt Assistant 标签文件 ${file} 格式无效。`);
            }
            return flattenPromptAssistantTagData(payload.data, file);
        }));

        const records = [];
        for (let index = 0; index < settled.length; index += 1) {
            const result = settled[index];
            if (result.status === "fulfilled") records.push(...result.value);
            else this.diagnoseOnce(`无法加载 Prompt Assistant 标签文件：${discovered.files[index]}`, result.reason);
        }
        return mergePromptAssistantTagRecords(records);
    }

    async load({ force = false } = {}) {
        const currentTime = this.now();
        if (!force && currentTime < this.cacheExpiresAt) return this.cachedRecords;
        if (this.pendingLoad) return this.pendingLoad;
        this.pendingLoad = this.loadUncached()
            .then((records) => {
                this.cachedRecords = records;
                this.cacheExpiresAt = this.now() + this.cacheTtlMs;
                return records;
            })
            .finally(() => {
                this.pendingLoad = null;
            });
        return this.pendingLoad;
    }
}
