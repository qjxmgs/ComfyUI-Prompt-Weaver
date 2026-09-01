import { t } from "./prompt_weaver_i18n.js?v=20260901-favorite-category-order-v1";

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_RESULT_LIMIT = 30;
const EXTENSION_MODULE_PATTERN = /^\/extensions\/([^/]+)\/modules\/tag\.js$/i;
const PROMPT_ASSISTANT_FOLDER_PATTERN = /prompt[-_]?assistant/i;
const HAN_CHARACTER_PATTERN = /\p{Script=Han}/u;
const FUZZY_SEPARATOR_PATTERN = /[\s_-]+/gu;

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function responseIsOk(response) {
    return Boolean(response) && response.ok !== false && typeof response.json === "function";
}

async function readJsonResponse(response, label) {
    if (!responseIsOk(response)) throw new Error(t("{label} request failed.", { label }));
    try {
        return await response.json();
    } catch (_error) {
        throw new Error(t("{label} returned invalid JSON.", { label }));
    }
}

export function normalizePromptAssistantSearchText(value) {
    const text = typeof value === "string" ? value : "";
    try {
        return text.normalize("NFKC").trim().toLowerCase().replace(/\\([()\[\]{}])/gu, "$1");
    } catch (_error) {
        return text.trim().toLowerCase().replace(/\\([()\[\]{}])/gu, "$1");
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
        throw new Error(t("The Prompt Assistant tag file list is invalid."));
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
            throw new Error(t("Prompt Assistant returned an invalid tag file name."));
        }
        if (!seen.has(file)) {
            seen.add(file);
            files.push(file);
        }
    }
    return files;
}

export function flattenPromptAssistantTagData(data, sourceFile = "") {
    if (!isPlainObject(data)) throw new Error(t("Prompt Assistant tag data must be an object."));
    const records = [];

    const visit = (value, path) => {
        if (typeof value === "string") {
            if (!path.length) throw new Error(t("A Prompt Assistant tag name is missing."));
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
            throw new Error(t("Prompt Assistant tag data contains a non-object group or non-string tag."));
        }
        for (const [key, child] of Object.entries(value)) {
            if (typeof key !== "string" || !key.trim()) {
                throw new Error(t("Prompt Assistant tag data contains an invalid name."));
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

function compactFuzzyText(value) {
    return normalizePromptAssistantSearchText(value).replace(FUZZY_SEPARATOR_PATTERN, "");
}

function promptAssistantMatchContext(value) {
    const query = normalizePromptAssistantSearchText(value);
    const compact = compactFuzzyText(query);
    const compactCharacters = [...compact];
    const fuzzyEligible = Boolean(compact) && (
        HAN_CHARACTER_PATTERN.test(compact)
            ? compactCharacters.length >= 2
            : compactCharacters.length >= 3
    );
    return { query, compactCharacters, fuzzyEligible };
}

export function fuzzyPromptAssistantQueryIsEligible(value) {
    return promptAssistantMatchContext(value).fuzzyEligible;
}

function orderedSubsequenceScoreWithContext(fieldValue, context) {
    if (!context.fuzzyEligible) return null;
    const field = [...compactFuzzyText(fieldValue)];
    const query = context.compactCharacters;
    if (!field.length || query.length > field.length) return null;

    let queryIndex = 0;
    let first = -1;
    let last = -1;
    for (let index = 0; index < field.length && queryIndex < query.length; index += 1) {
        if (field[index] !== query[queryIndex]) continue;
        if (first < 0) first = index;
        last = index;
        queryIndex += 1;
    }
    if (queryIndex !== query.length) return null;
    return {
        start: first,
        gaps: last - first + 1 - query.length,
        length: field.length,
    };
}

export function orderedSubsequenceMatchScore(fieldValue, queryValue) {
    return orderedSubsequenceScoreWithContext(
        fieldValue,
        promptAssistantMatchContext(queryValue),
    );
}

function compareMatchScore(left, right) {
    return left.start - right.start || left.gaps - right.gaps || left.length - right.length;
}

function matchFieldsWithContext(fields, context) {
    const { query } = context;
    if (!query) return null;
    let best = null;
    for (const value of Array.isArray(fields) ? fields : []) {
        const field = normalizePromptAssistantSearchText(value);
        if (!field) continue;
        let match = null;
        if (field === query) match = { rank: 0, score: null, value };
        else if (field.startsWith(query)) match = { rank: 1, score: null, value };
        else if (field.includes(query)) match = { rank: 2, score: null, value };
        else {
            const score = orderedSubsequenceScoreWithContext(field, context);
            if (score) match = { rank: 3, score, value };
        }
        if (!match) continue;
        if (
            !best
            || match.rank < best.rank
            || (match.rank === best.rank && match.rank === 3 && compareMatchScore(match.score, best.score) < 0)
        ) {
            best = match;
        }
    }
    return best;
}

export function matchPromptAssistantFields(fields, queryValue) {
    const match = matchFieldsWithContext(fields, promptAssistantMatchContext(queryValue));
    return match ? { rank: match.rank, score: match.score } : null;
}


export function findPromptAssistantMatchField(fields, queryValue) {
    const match = matchFieldsWithContext(fields, promptAssistantMatchContext(queryValue));
    return match ? { value: match.value, rank: match.rank, score: match.score } : null;
}

export function searchPromptAssistantTags(records, queryValue, limit = DEFAULT_RESULT_LIMIT) {
    const context = promptAssistantMatchContext(queryValue);
    if (!promptAssistantQueryIsEligible(context.query)) return [];
    const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_RESULT_LIMIT;
    const matches = [];

    for (let index = 0; index < (Array.isArray(records) ? records.length : 0); index += 1) {
        const record = records[index];
        if (!record || typeof record.value !== "string") continue;
        const fields = [record.value, ...(Array.isArray(record.aliases) ? record.aliases : [record.name])];
        const match = matchFieldsWithContext(fields, context);
        if (match) matches.push({ record, ...match, index });
    }

    matches.sort((left, right) => (
        left.rank - right.rank
        || (left.rank === 3 ? compareMatchScore(left.score, right.score) : 0)
        || left.index - right.index
    ));
    return matches.slice(0, safeLimit).map(({ record }) => record);
}

export function formatPromptAssistantTagOption(record) {
    const name = typeof record?.name === "string" ? record.name.trim() : "";
    const value = typeof record?.value === "string" ? record.value.trim() : "";
    if (!name) return value;
    if (!value || normalizePromptAssistantSearchText(name) === normalizePromptAssistantSearchText(value)) {
        return name;
    }
    return t("{value} ({name})", { value, name });
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
            throw new Error(t("The ComfyUI API client is unavailable."));
        }
        return readJsonResponse(await this.api.fetchApi(path), label);
    }

    async discover() {
        const entries = await this.fetchJson("/extensions", t("ComfyUI extension list"));
        for (const apiBase of findPromptAssistantApiBases(entries)) {
            try {
                const payload = await this.fetchJson(
                    `${apiBase}/config/tags_files`,
                    t("Prompt Assistant tag file list"),
                );
                return { apiBase, files: validatePromptAssistantTagFiles(payload) };
            } catch (error) {
                this.diagnoseOnce(t("Could not use the Prompt Assistant tag API: {base}", { base: apiBase }), error);
            }
        }
        return null;
    }

    async loadUncached() {
        let discovered;
        try {
            discovered = await this.discover();
        } catch (error) {
            this.diagnoseOnce(t("Could not read the ComfyUI extension list; tag autocomplete is hidden."), error);
            return [];
        }
        if (!discovered || !discovered.files.length) return [];

        const settled = await Promise.allSettled(discovered.files.map(async (file) => {
            const payload = await this.fetchJson(
                `${discovered.apiBase}/config/tags_csv/${encodeURIComponent(file)}`,
                t("Prompt Assistant tag file {file}", { file }),
            );
            if (!isPlainObject(payload) || payload.success !== true || !isPlainObject(payload.data)) {
                throw new Error(t("Prompt Assistant tag file {file} is invalid.", { file }));
            }
            return flattenPromptAssistantTagData(payload.data, file);
        }));

        const records = [];
        for (let index = 0; index < settled.length; index += 1) {
            const result = settled[index];
            if (result.status === "fulfilled") records.push(...result.value);
            else this.diagnoseOnce(t("Could not load Prompt Assistant tag file: {file}", {
                file: discovered.files[index],
            }), result.reason);
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
