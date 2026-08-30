import { getLocale, t } from "./prompt_weaver_i18n.js";
import {
    PromptAssistantTagCatalog,
    findPromptAssistantMatchField,
    matchPromptAssistantFields,
    normalizePromptAssistantSearchText,
    promptAssistantQueryIsEligible,
    searchPromptAssistantTags,
} from "./prompt_assistant_tags.js?v=20260825-matched-alias-v1";


export const DANBOORU_SETTING_ID = "PromptWeaver.Autocomplete.Danbooru";
export const PROMPT_ASSISTANT_SETTING_ID = "PromptWeaver.Autocomplete.PromptAssistant";
export const AUTOCOMPLETE_LIMIT_SETTING_ID = "PromptWeaver.Autocomplete.MaxResults";
export const AUTOCOMPLETE_SOURCE_ORDER_SETTING_ID = "PromptWeaver.Autocomplete.SourceOrder";
export const AUTOCOMPLETE_SETTINGS_EVENT = "cpw-prompt-autocomplete-settings-changed";
export const AUTOCOMPLETE_SOURCE_IDS = Object.freeze(["prompt-assistant", "danbooru"]);
export const DEFAULT_AUTOCOMPLETE_SOURCE_ORDER = AUTOCOMPLETE_SOURCE_IDS;
export const DEFAULT_AUTOCOMPLETE_LIMIT = 30;
export const MIN_AUTOCOMPLETE_LIMIT = 1;
export const MAX_AUTOCOMPLETE_LIMIT = 100;
export const AUTOCOMPLETE_POPUP_HEIGHT_STORAGE_KEY = "cpw-prompt-autocomplete-height-v1";
export const DEFAULT_AUTOCOMPLETE_POPUP_HEIGHT = 320;
export const MIN_AUTOCOMPLETE_POPUP_HEIGHT = 120;
export const MAX_AUTOCOMPLETE_POPUP_HEIGHT = 720;
export const DEFAULT_AUTOCOMPLETE_DEBOUNCE_MS = 120;
export const DANBOORU_UPDATE_POLL_MS = 500;
export const DANBOORU_UPDATE_TIMEOUT_MS = 5 * 60 * 1000;
const RESOLVE_BATCH_SIZE = 256;

const TOP_LEVEL_SEPARATORS = new Set([",", "，", "\n", "\r"]);
const OPENING_BRACKETS = new Map([["(", ")"], ["[", "]"], ["{", "}"]]);
const CLOSING_BRACKETS = new Set(OPENING_BRACKETS.values());
const WEIGHT_SUFFIX_PATTERN = /:\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*$/u;
const HAN_CHARACTER_PATTERN = /\p{Script=Han}/u;
const AUTOCOMPLETE_HIGHLIGHT_SEPARATOR_PATTERN = /[\s_-]/u;
const CATEGORY_NAMES = Object.freeze({
    0: "General",
    1: "Artist",
    3: "Copyright",
    4: "Character",
    5: "Meta",
});


function responseIsOk(response) {
    return Boolean(response) && response.ok !== false && typeof response.json === "function";
}


async function readJsonResponse(response, label) {
    if (!responseIsOk(response)) {
        let detail = "";
        try {
            detail = (await response?.json?.())?.error || "";
        } catch (_error) {
            detail = "";
        }
        throw new Error(detail || t("{label} request failed.", { label }));
    }
    try {
        return await response.json();
    } catch (_error) {
        throw new Error(t("{label} returned invalid JSON.", { label }));
    }
}


function abortError() {
    try {
        return new DOMException("Aborted", "AbortError");
    } catch (_error) {
        const error = new Error("Aborted");
        error.name = "AbortError";
        return error;
    }
}


function ensureNotAborted(signal) {
    if (signal?.aborted) throw abortError();
}


function delay(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        ensureNotAborted(signal);
        const timer = setTimeout(resolve, milliseconds);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(abortError());
        }, { once: true });
    });
}


export function normalizeAutocompleteText(value) {
    return normalizePromptAssistantSearchText(value);
}


export function autocompleteQueryIsEligible(value) {
    return promptAssistantQueryIsEligible(value);
}

export function autocompleteInputOwnsFocus(
    input,
    activeElement = globalThis.document?.activeElement,
) {
    return Boolean(input && activeElement === input);
}


export function normalizeAutocompleteLimit(value, fallback = DEFAULT_AUTOCOMPLETE_LIMIT) {
    const fallbackNumber = Number(fallback);
    const safeFallback = Number.isFinite(fallbackNumber)
        ? Math.min(MAX_AUTOCOMPLETE_LIMIT, Math.max(MIN_AUTOCOMPLETE_LIMIT, Math.round(fallbackNumber)))
        : DEFAULT_AUTOCOMPLETE_LIMIT;
    if (value === undefined || value === null || value === "") return safeFallback;
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return safeFallback;
    return Math.min(
        MAX_AUTOCOMPLETE_LIMIT,
        Math.max(MIN_AUTOCOMPLETE_LIMIT, Math.round(numericValue)),
    );
}


export function normalizeAutocompleteSourceOrder(value) {
    const normalized = [];
    for (const source of Array.isArray(value) ? value : []) {
        if (AUTOCOMPLETE_SOURCE_IDS.includes(source) && !normalized.includes(source)) {
            normalized.push(source);
        }
    }
    for (const source of DEFAULT_AUTOCOMPLETE_SOURCE_ORDER) {
        if (!normalized.includes(source)) normalized.push(source);
    }
    return normalized;
}


export function normalizeAutocompletePopupHeight(
    value,
    fallback = DEFAULT_AUTOCOMPLETE_POPUP_HEIGHT,
) {
    const fallbackNumber = Number(fallback);
    const safeFallback = Number.isFinite(fallbackNumber)
        ? Math.min(
            MAX_AUTOCOMPLETE_POPUP_HEIGHT,
            Math.max(MIN_AUTOCOMPLETE_POPUP_HEIGHT, Math.round(fallbackNumber)),
        )
        : DEFAULT_AUTOCOMPLETE_POPUP_HEIGHT;
    if (value === undefined || value === null || value === "") return safeFallback;
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return safeFallback;
    return Math.min(
        MAX_AUTOCOMPLETE_POPUP_HEIGHT,
        Math.max(MIN_AUTOCOMPLETE_POPUP_HEIGHT, Math.round(numericValue)),
    );
}


export function readAutocompletePopupHeight(
    storage = undefined,
    fallback = DEFAULT_AUTOCOMPLETE_POPUP_HEIGHT,
) {
    try {
        const resolvedStorage = storage === undefined ? globalThis.localStorage : storage;
        const storedValue = resolvedStorage?.getItem?.(AUTOCOMPLETE_POPUP_HEIGHT_STORAGE_KEY);
        return storedValue === undefined || storedValue === null
            ? normalizeAutocompletePopupHeight(fallback)
            : normalizeAutocompletePopupHeight(storedValue, fallback);
    } catch (_error) {
        return normalizeAutocompletePopupHeight(fallback);
    }
}


export function persistAutocompletePopupHeight(value, storage = undefined) {
    const normalized = normalizeAutocompletePopupHeight(value);
    try {
        const resolvedStorage = storage === undefined ? globalThis.localStorage : storage;
        resolvedStorage?.setItem?.(AUTOCOMPLETE_POPUP_HEIGHT_STORAGE_KEY, String(normalized));
    } catch (_error) {
        // Storage may be disabled; the active controller still keeps the value for this session.
    }
    return normalized;
}


export function resizedAutocompletePopupHeight({ startHeight, deltaY, openAbove }) {
    const signedDelta = (openAbove ? -1 : 1) * (Number(deltaY) || 0);
    return normalizeAutocompletePopupHeight(Number(startHeight) + signedDelta);
}


function autocompleteMatchScore(value) {
    if (!value || typeof value !== "object") return null;
    const start = Number(value.start);
    const gaps = Number(value.gaps);
    const length = Number(value.length);
    if (![start, gaps, length].every(Number.isInteger) || start < 0 || gaps < 0 || length < 0) return null;
    return { start, gaps, length };
}

function compareAutocompleteMatchScore(left, right) {
    const fallback = { start: Number.MAX_SAFE_INTEGER, gaps: Number.MAX_SAFE_INTEGER, length: Number.MAX_SAFE_INTEGER };
    const leftScore = left || fallback;
    const rightScore = right || fallback;
    return leftScore.start - rightScore.start
        || leftScore.gaps - rightScore.gaps
        || leftScore.length - rightScore.length;
}


export function normalizeAutocompleteInsertionKey(value) {
    return normalizeAutocompleteText(value)
        .replaceAll("_", " ")
        .replace(/\s+/gu, " ")
        .trim();
}


function topLevelSegmentBounds(value, cursorPosition) {
    const text = typeof value === "string" ? value : "";
    const cursor = Math.max(0, Math.min(text.length, Number(cursorPosition) || 0));
    const separators = [];
    const bracketStack = [];
    let quote = "";
    let escaped = false;

    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (character === "\\") {
            escaped = true;
            continue;
        }
        if (quote) {
            if (character === quote) quote = "";
            continue;
        }
        const startsSingleQuotedValue = character === "'" && (
            index === 0 || /[\s,，([{]/u.test(text[index - 1])
        );
        if (character === '"' || startsSingleQuotedValue) {
            quote = character;
            continue;
        }
        if (OPENING_BRACKETS.has(character)) {
            bracketStack.push(OPENING_BRACKETS.get(character));
            continue;
        }
        if (CLOSING_BRACKETS.has(character)) {
            if (bracketStack.at(-1) === character) bracketStack.pop();
            continue;
        }
        if (!bracketStack.length && TOP_LEVEL_SEPARATORS.has(character)) separators.push(index);
    }

    let start = 0;
    let end = text.length;
    for (const separator of separators) {
        if (separator < cursor) start = separator + 1;
        else {
            end = separator;
            break;
        }
    }
    return { start, end };
}


function trimCompletionRange(value, start, end) {
    let rangeStart = start;
    let rangeEnd = end;
    while (rangeStart < rangeEnd && /\s/u.test(value[rangeStart])) rangeStart += 1;
    while (rangeEnd > rangeStart && /\s/u.test(value[rangeEnd - 1])) rangeEnd -= 1;

    const expectedClosings = [];
    while (rangeStart < rangeEnd && OPENING_BRACKETS.has(value[rangeStart])) {
        expectedClosings.unshift(OPENING_BRACKETS.get(value[rangeStart]));
        rangeStart += 1;
        while (rangeStart < rangeEnd && /\s/u.test(value[rangeStart])) rangeStart += 1;
    }
    for (const closing of expectedClosings) {
        while (rangeEnd > rangeStart && /\s/u.test(value[rangeEnd - 1])) rangeEnd -= 1;
        if (value[rangeEnd - 1] === closing) rangeEnd -= 1;
    }

    if (
        rangeEnd - rangeStart >= 2
        && (value[rangeStart] === '"' || value[rangeStart] === "'")
        && value[rangeEnd - 1] === value[rangeStart]
    ) {
        rangeStart += 1;
        rangeEnd -= 1;
    }

    const candidate = value.slice(rangeStart, rangeEnd);
    const suffix = candidate.match(WEIGHT_SUFFIX_PATTERN);
    if (suffix?.index > 0) rangeEnd = rangeStart + suffix.index;
    while (rangeEnd > rangeStart && /\s/u.test(value[rangeEnd - 1])) rangeEnd -= 1;
    return { start: rangeStart, end: rangeEnd };
}


export function resolvePromptCompletionContext(value, selectionStart, selectionEnd = selectionStart) {
    const text = typeof value === "string" ? value : "";
    let start = Math.max(0, Math.min(text.length, Number(selectionStart) || 0));
    let end = Math.max(start, Math.min(text.length, Number(selectionEnd) || start));
    if (end === start) {
        const segment = topLevelSegmentBounds(text, start);
        ({ start, end } = trimCompletionRange(text, segment.start, segment.end));
    } else {
        ({ start, end } = trimCompletionRange(text, start, end));
    }
    return {
        start,
        end,
        query: text.slice(start, end),
    };
}


export function promptTokenLookupText(value) {
    const text = typeof value === "string" ? value : "";
    if (!text) return "";
    return resolvePromptCompletionContext(text, 0, text.length).query.trim();
}


export function promptTokenHasHanText(value) {
    return HAN_CHARACTER_PATTERN.test(String(value || ""));
}


export function applyPromptCompletion(value, context, insertion) {
    const text = typeof value === "string" ? value : "";
    const replacement = typeof insertion === "string" ? insertion : "";
    const start = Math.max(0, Math.min(text.length, Number(context?.start) || 0));
    const end = Math.max(start, Math.min(text.length, Number(context?.end) || start));
    return {
        value: `${text.slice(0, start)}${replacement}${text.slice(end)}`,
        cursor: start + replacement.length,
    };
}


export function applyPromptCompletionWithSeparator(value, context, insertion, separator = ", ") {
    const result = applyPromptCompletion(value, context, insertion);
    const normalizedSeparator = typeof separator === "string" ? separator : "";
    if (!normalizedSeparator) return result;

    const segment = topLevelSegmentBounds(result.value, result.cursor);
    const followingSeparator = result.value.slice(segment.end).match(/^(?:[,，][\t ]*|\r?\n[\t ]*)/u);
    if (followingSeparator) {
        return {
            value: result.value,
            cursor: segment.end + followingSeparator[0].length,
        };
    }

    let insertionPoint = segment.end;
    while (insertionPoint > segment.start && /[\t ]/u.test(result.value[insertionPoint - 1])) {
        insertionPoint -= 1;
    }
    return {
        value: `${result.value.slice(0, insertionPoint)}${normalizedSeparator}${result.value.slice(segment.end)}`,
        cursor: insertionPoint + normalizedSeparator.length,
    };
}


export function promptPresenceKeys(value) {
    const text = typeof value === "string" ? value : "";
    const keys = new Set();
    let cursor = 0;
    while (cursor <= text.length) {
        const bounds = topLevelSegmentBounds(text, cursor);
        const range = trimCompletionRange(text, bounds.start, bounds.end);
        const key = normalizeAutocompleteInsertionKey(text.slice(range.start, range.end));
        if (key) keys.add(key);
        if (bounds.end >= text.length) break;
        cursor = bounds.end + 1;
    }
    return keys;
}


export class DanbooruTagProvider {
    constructor(api, { statusTtlMs = 30_000, now = () => Date.now() } = {}) {
        this.api = api;
        this.statusTtlMs = statusTtlMs;
        this.now = now;
        this.cachedStatus = new Map();
    }

    async fetchJson(path, options, label) {
        if (!this.api || typeof this.api.fetchApi !== "function") {
            throw new Error(t("The ComfyUI API client is unavailable."));
        }
        return readJsonResponse(await this.api.fetchApi(path, options), label);
    }

    invalidateStatus(locale = null) {
        if (locale) this.cachedStatus.delete(locale);
        else this.cachedStatus.clear();
    }

    async status(locale = getLocale(), { signal, force = false } = {}) {
        const normalizedLocale = locale === "zh" ? "zh-CN" : locale;
        const cached = this.cachedStatus.get(normalizedLocale);
        if (!force && cached && cached.expiresAt > this.now()) return cached.value;
        ensureNotAborted(signal);
        const value = await this.fetchJson(
            `/prompt-weaver/tag-autocomplete/status?locale=${encodeURIComponent(normalizedLocale)}`,
            { signal },
            t("Danbooru dictionary status"),
        );
        ensureNotAborted(signal);
        this.cachedStatus.set(normalizedLocale, {
            value,
            expiresAt: this.now() + this.statusTtlMs,
        });
        return value;
    }

    async search(query, locale = getLocale(), limit = DEFAULT_AUTOCOMPLETE_LIMIT, { signal } = {}) {
        const normalizedLocale = promptTokenHasHanText(query)
            ? "zh-CN"
            : (locale === "zh" ? "zh-CN" : locale);
        const status = await this.status(normalizedLocale, { signal });
        if (!status?.available) return { results: [], status };
        ensureNotAborted(signal);
        const payload = await this.fetchJson(
            "/prompt-weaver/tag-autocomplete/search"
                + `?q=${encodeURIComponent(query)}`
                + `&locale=${encodeURIComponent(normalizedLocale)}`
                + `&limit=${encodeURIComponent(limit)}`,
            { signal },
            t("Danbooru tag search"),
        );
        ensureNotAborted(signal);
        const results = Array.isArray(payload?.results) ? payload.results : [];
        return {
            status,
            results: results.map((record) => ({
                source: "danbooru",
                tag: String(record?.tag || ""),
                insertText: String(record?.insert_text || ""),
                translation: String(record?.translation || ""),
                category: Number(record?.category),
                categoryPath: [],
                postCount: Number(record?.post_count) || 0,
                matchRank: Number.isInteger(record?.match_rank) ? record.match_rank : 2,
                matchScore: autocompleteMatchScore(record?.match_score),
            })).filter((record) => record.tag && record.insertText),
        };
    }

    async resolve(tags, locale = "zh-CN", { signal } = {}) {
        const status = await this.status(locale, { signal });
        if (!status?.available) return { results: tags.map(() => null), status };
        ensureNotAborted(signal);
        const payload = await this.fetchJson(
            "/prompt-weaver/tag-autocomplete/resolve",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tags, locale: "zh-CN" }),
                signal,
            },
            t("Danbooru tag resolution"),
        );
        ensureNotAborted(signal);
        const rows = Array.isArray(payload?.results) ? payload.results : [];
        return {
            status,
            results: tags.map((_tag, index) => {
                const record = rows[index];
                if (!record) return null;
                return {
                    source: "danbooru",
                    tag: String(record.tag || ""),
                    insertText: String(record.insert_text || ""),
                    translation: String(record.translation || ""),
                    category: Number(record.category),
                    categoryPath: [],
                    postCount: Number(record.post_count) || 0,
                    matchRank: 0,
                };
            }),
        };
    }

    async update(locale = getLocale(), { signal } = {}) {
        const normalizedLocale = locale === "zh" ? "zh-CN" : locale;
        await this.fetchJson(
            "/prompt-weaver/tag-autocomplete/update",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ locale: normalizedLocale }),
                signal,
            },
            t("Danbooru dictionary update"),
        );
        this.invalidateStatus(normalizedLocale);
        const attempts = Math.ceil(DANBOORU_UPDATE_TIMEOUT_MS / DANBOORU_UPDATE_POLL_MS);
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            await delay(DANBOORU_UPDATE_POLL_MS, signal);
            const status = await this.status(normalizedLocale, { signal, force: true });
            if (!status.updating) {
                if (status.error && !status.available) throw new Error(status.error);
                return status;
            }
        }
        throw new Error(t("Danbooru dictionary update timed out."));
    }
}


export class PromptAssistantTagProvider {
    constructor(api, options = {}) {
        this.catalog = options.catalog || new PromptAssistantTagCatalog(api, options);
    }

    async search(query, limit = DEFAULT_AUTOCOMPLETE_LIMIT, { signal } = {}) {
        ensureNotAborted(signal);
        const records = await this.catalog.load();
        ensureNotAborted(signal);
        return searchPromptAssistantTags(records, query, limit).map((record) => {
            const match = matchPromptAssistantFields(
                [record.value, ...(record.aliases || [])],
                query,
            );
            const matchingTranslation = promptTokenHasHanText(query)
                ? findPromptAssistantMatchField([record.name, ...(record.aliases || [])], query)
                : null;
            return {
                source: "prompt-assistant",
                tag: String(record.value || ""),
                insertText: String(record.value || ""),
                translation: String(
                    matchingTranslation && matchingTranslation.rank === match?.rank
                        ? matchingTranslation.value
                        : record.name || "",
                ),
                category: null,
                categoryPath: Array.isArray(record.categoryPath) ? record.categoryPath : [],
                postCount: 0,
                matchRank: match?.rank ?? 2,
                matchScore: match?.score || null,
            };
        }).filter((record) => record.tag && record.insertText);
    }

    async resolve(tags, { signal } = {}) {
        ensureNotAborted(signal);
        const records = await this.catalog.load();
        ensureNotAborted(signal);
        const exact = new Map();
        for (const record of records) {
            const mapped = {
                source: "prompt-assistant",
                tag: String(record.value || ""),
                insertText: String(record.value || ""),
                translation: String(record.name || ""),
                category: null,
                categoryPath: Array.isArray(record.categoryPath) ? record.categoryPath : [],
                postCount: 0,
                matchRank: 0,
            };
            for (const value of [record.value, ...(record.aliases || [])]) {
                const key = normalizeAutocompleteInsertionKey(value);
                if (key) exact.set(key, mapped);
            }
        }
        return tags.map((tag) => exact.get(normalizeAutocompleteInsertionKey(tag)) || null);
    }
}


export function mergeAutocompleteResults(
    resultGroups,
    limit = DEFAULT_AUTOCOMPLETE_LIMIT,
    sourceOrder = DEFAULT_AUTOCOMPLETE_SOURCE_ORDER,
) {
    const normalizedSourceOrder = normalizeAutocompleteSourceOrder(sourceOrder);
    const sourcePriorities = new Map(normalizedSourceOrder.map((source, index) => [source, index]));
    const candidates = [];
    let sequence = 0;
    for (const group of Array.isArray(resultGroups) ? resultGroups : []) {
        for (const record of Array.isArray(group) ? group : []) {
            const sourcePriority = sourcePriorities.get(record?.source) ?? normalizedSourceOrder.length;
            candidates.push({
                record,
                rank: Number.isFinite(record?.matchRank) ? record.matchRank : 2,
                matchScore: autocompleteMatchScore(record?.matchScore),
                sourcePriority,
                postCount: Number(record?.postCount) || 0,
                sequence: sequence++,
            });
        }
    }
    candidates.sort((left, right) => (
        left.rank - right.rank
        || (left.rank === 3 ? compareAutocompleteMatchScore(left.matchScore, right.matchScore) : 0)
        || left.sourcePriority - right.sourcePriority
        || right.postCount - left.postCount
        || left.sequence - right.sequence
    ));
    const merged = [];
    const seen = new Set();
    for (const candidate of candidates) {
        const key = normalizeAutocompleteInsertionKey(candidate.record?.insertText);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(candidate.record);
        if (merged.length >= limit) break;
    }
    return merged;
}


export class PromptTagAutocompleteProvider {
    constructor(api, {
        danbooruEnabled = () => true,
        promptAssistantEnabled = () => true,
        sourceOrder = () => DEFAULT_AUTOCOMPLETE_SOURCE_ORDER,
        onDiagnostic,
    } = {}) {
        this.danbooruEnabled = danbooruEnabled;
        this.promptAssistantEnabled = promptAssistantEnabled;
        this.sourceOrder = typeof sourceOrder === "function"
            ? sourceOrder
            : () => DEFAULT_AUTOCOMPLETE_SOURCE_ORDER;
        this.onDiagnostic = typeof onDiagnostic === "function" ? onDiagnostic : null;
        this.danbooru = new DanbooruTagProvider(api);
        this.promptAssistant = new PromptAssistantTagProvider(api, { onDiagnostic });
        this.translationCache = new Map();
    }

    async search(query, locale = getLocale(), limit = DEFAULT_AUTOCOMPLETE_LIMIT, { signal } = {}) {
        if (!autocompleteQueryIsEligible(query)) {
            return { results: [], danbooruStatus: null, danbooruEnabled: this.danbooruEnabled() };
        }
        const groups = [];
        const sourceOrder = normalizeAutocompleteSourceOrder(this.sourceOrder());
        let danbooruStatus = null;
        const tasks = [];
        if (this.promptAssistantEnabled()) {
            tasks.push(this.promptAssistant.search(query, limit, { signal })
                .then((records) => groups.push(records))
                .catch((error) => {
                    if (error?.name !== "AbortError") this.onDiagnostic?.(error.message, error);
                }));
        }
        const danbooruEnabled = this.danbooruEnabled();
        if (danbooruEnabled) {
            tasks.push(this.danbooru.search(query, locale, limit, { signal })
                .then(({ results, status }) => {
                    groups.push(results);
                    danbooruStatus = status;
                })
                .catch((error) => {
                    if (error?.name !== "AbortError") this.onDiagnostic?.(error.message, error);
                }));
        }
        await Promise.all(tasks);
        ensureNotAborted(signal);
        return {
            results: mergeAutocompleteResults(groups, limit, sourceOrder),
            danbooruStatus,
            danbooruEnabled,
        };
    }

    async updateDanbooru(locale = getLocale(), options = {}) {
        const status = await this.danbooru.update(locale, options);
        this.translationCache.clear();
        return status;
    }

    async resolveTagTranslations(values, locale = "zh-CN", { signal } = {}) {
        ensureNotAborted(signal);
        const danbooruEnabled = this.danbooruEnabled();
        const promptAssistantEnabled = this.promptAssistantEnabled();
        const sourceOrder = normalizeAutocompleteSourceOrder(this.sourceOrder());
        const sourceKey = `${promptAssistantEnabled ? 1 : 0}:${danbooruEnabled ? 1 : 0}:${sourceOrder.join(",")}`;
        const inputKeys = values.map(normalizeAutocompleteInsertionKey);
        const missing = [];
        const seen = new Set();
        for (const key of inputKeys) {
            const cacheKey = `${sourceKey}:${key}`;
            if (!key || this.translationCache.has(cacheKey) || seen.has(key)) continue;
            seen.add(key);
            missing.push(key);
        }

        for (let offset = 0; offset < missing.length; offset += RESOLVE_BATCH_SIZE) {
            const batch = missing.slice(offset, offset + RESOLVE_BATCH_SIZE);
            let danbooruResults = batch.map(() => null);
            let promptAssistantResults = batch.map(() => null);
            const tasks = [];
            if (danbooruEnabled) {
                tasks.push(this.danbooru.resolve(batch, "zh-CN", { signal })
                    .then(({ results }) => { danbooruResults = results; })
                    .catch((error) => {
                        if (error?.name === "AbortError") throw error;
                        this.onDiagnostic?.(error.message, error);
                    }));
            }
            if (promptAssistantEnabled) {
                tasks.push(this.promptAssistant.resolve(batch, { signal })
                    .then((results) => { promptAssistantResults = results; })
                    .catch((error) => {
                        if (error?.name === "AbortError") throw error;
                        this.onDiagnostic?.(error.message, error);
                    }));
            }
            await Promise.all(tasks);
            ensureNotAborted(signal);
            for (let index = 0; index < batch.length; index += 1) {
                const resultsBySource = {
                    "prompt-assistant": promptAssistantResults[index],
                    danbooru: danbooruResults[index],
                };
                this.translationCache.set(
                    `${sourceKey}:${batch[index]}`,
                    sourceOrder.map((source) => resultsBySource[source]).find(Boolean) || null,
                );
            }
        }

        return inputKeys.map((key) => (
            key ? this.translationCache.get(`${sourceKey}:${key}`) || null : null
        ));
    }
}


function createElement(tagName, className = "", text = "") {
    const result = document.createElement(tagName);
    if (className) result.className = className;
    if (text) result.textContent = text;
    return result;
}


function categoryLabel(record) {
    if (record.source === "prompt-assistant") {
        return record.categoryPath?.length ? record.categoryPath.join(" / ") : t("Custom");
    }
    return t(CATEGORY_NAMES[record.category] || "Other");
}


function sourceLabel(record) {
    return record.source === "prompt-assistant" ? "Prompt Assistant" : "Danbooru";
}


export function formatAutocompleteCount(value, locale = getLocale()) {
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value ?? "");
    return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US", {
        notation: "compact",
        maximumFractionDigits: 1,
    }).format(number);
}


export function autocompleteTranslationText(record) {
    const tag = String(record?.tag || "").trim();
    const translation = String(record?.translation || "").trim();
    if (
        translation
        && normalizeAutocompleteText(translation) !== normalizeAutocompleteText(tag)
    ) {
        return translation;
    }
    return "—";
}


function normalizeAutocompleteHighlightCharacter(value) {
    try {
        return value.normalize("NFKC").toLowerCase();
    } catch (_error) {
        return value.toLowerCase();
    }
}


function autocompleteHighlightUnits(value, { compact = false } = {}) {
    const units = [];
    let offset = 0;
    for (const originalCharacter of Array.from(String(value || ""))) {
        const start = offset;
        offset += originalCharacter.length;
        for (const normalizedCharacter of Array.from(
            normalizeAutocompleteHighlightCharacter(originalCharacter),
        )) {
            if (compact && AUTOCOMPLETE_HIGHLIGHT_SEPARATOR_PATTERN.test(normalizedCharacter)) {
                continue;
            }
            units.push({ character: normalizedCharacter, start, end: offset });
        }
    }
    return units;
}


function contiguousAutocompleteHighlightIndexes(units, queryCharacters) {
    if (!queryCharacters.length || queryCharacters.length > units.length) return null;
    const lastStart = units.length - queryCharacters.length;
    for (let start = 0; start <= lastStart; start += 1) {
        let matched = true;
        for (let index = 0; index < queryCharacters.length; index += 1) {
            if (units[start + index].character !== queryCharacters[index]) {
                matched = false;
                break;
            }
        }
        if (matched) {
            return Array.from({ length: queryCharacters.length }, (_value, index) => start + index);
        }
    }
    return null;
}


function orderedAutocompleteHighlightIndexes(units, queryCharacters) {
    if (!queryCharacters.length || queryCharacters.length > units.length) return null;
    const indexes = [];
    let queryIndex = 0;
    for (let index = 0; index < units.length && queryIndex < queryCharacters.length; index += 1) {
        if (units[index].character !== queryCharacters[queryIndex]) continue;
        indexes.push(index);
        queryIndex += 1;
    }
    return queryIndex === queryCharacters.length ? indexes : null;
}


function autocompleteHighlightRangesFromIndexes(units, indexes) {
    if (!indexes?.length) return [];
    const sourceRanges = indexes
        .map((index) => units[index])
        .filter(Boolean)
        .map(({ start, end }) => ({ start, end }))
        .sort((left, right) => left.start - right.start || left.end - right.end);
    const ranges = [];
    for (const range of sourceRanges) {
        const previous = ranges.at(-1);
        if (previous && range.start <= previous.end) {
            previous.end = Math.max(previous.end, range.end);
        } else {
            ranges.push(range);
        }
    }
    return ranges;
}


export function autocompleteHighlightRanges(value, queryValue) {
    const text = String(value || "");
    const normalizedQuery = normalizeAutocompleteText(queryValue);
    if (!text || !normalizedQuery) return [];

    const queryCharacters = Array.from(normalizedQuery);
    const directUnits = autocompleteHighlightUnits(text);
    const directIndexes = contiguousAutocompleteHighlightIndexes(directUnits, queryCharacters);
    if (directIndexes) return autocompleteHighlightRangesFromIndexes(directUnits, directIndexes);

    const compactQueryCharacters = queryCharacters.filter(
        (character) => !AUTOCOMPLETE_HIGHLIGHT_SEPARATOR_PATTERN.test(character),
    );
    const compactUnits = autocompleteHighlightUnits(text, { compact: true });
    const compactIndexes = contiguousAutocompleteHighlightIndexes(
        compactUnits,
        compactQueryCharacters,
    );
    if (compactIndexes) {
        return autocompleteHighlightRangesFromIndexes(compactUnits, compactIndexes);
    }

    const compactQuery = compactQueryCharacters.join("");
    const fuzzyEligible = Boolean(compactQuery) && (
        HAN_CHARACTER_PATTERN.test(compactQuery)
            ? compactQueryCharacters.length >= 2
            : compactQueryCharacters.length >= 3
    );
    if (!fuzzyEligible) return [];
    return autocompleteHighlightRangesFromIndexes(
        compactUnits,
        orderedAutocompleteHighlightIndexes(compactUnits, compactQueryCharacters),
    );
}


export function appendAutocompleteHighlightedText(element, value, queryValue) {
    const text = String(value || "");
    const ranges = autocompleteHighlightRanges(text, queryValue);
    element.replaceChildren();
    if (!ranges.length) {
        element.textContent = text;
        return element;
    }
    const ownerDocument = element.ownerDocument || document;
    let offset = 0;
    for (const range of ranges) {
        if (range.start > offset) {
            element.append(ownerDocument.createTextNode(text.slice(offset, range.start)));
        }
        const highlight = ownerDocument.createElement("mark");
        highlight.className = "cpw-tag-autocomplete__match";
        highlight.textContent = text.slice(range.start, range.end);
        element.append(highlight);
        offset = range.end;
    }
    if (offset < text.length) element.append(ownerDocument.createTextNode(text.slice(offset)));
    return element;
}


export function textareaCaretClientRect(textarea) {
    if (!textarea?.isConnected || typeof document === "undefined") return null;
    const inputRect = textarea.getBoundingClientRect();
    const computed = globalThis.getComputedStyle?.(textarea);
    if (!computed) return null;

    const mirror = document.createElement("div");
    const properties = [
        "boxSizing",
        "borderTopWidth",
        "borderRightWidth",
        "borderBottomWidth",
        "borderLeftWidth",
        "paddingTop",
        "paddingRight",
        "paddingBottom",
        "paddingLeft",
        "fontFamily",
        "fontSize",
        "fontStyle",
        "fontVariant",
        "fontWeight",
        "fontStretch",
        "lineHeight",
        "letterSpacing",
        "textAlign",
        "textIndent",
        "textTransform",
        "tabSize",
        "wordSpacing",
    ];
    for (const property of properties) mirror.style[property] = computed[property];
    const borderWidth = (Number.parseFloat(computed.borderLeftWidth) || 0)
        + (Number.parseFloat(computed.borderRightWidth) || 0);
    mirror.style.position = "fixed";
    mirror.style.left = `${inputRect.left}px`;
    mirror.style.top = `${inputRect.top}px`;
    mirror.style.width = `${textarea.clientWidth + borderWidth}px`;
    mirror.style.height = "auto";
    mirror.style.minHeight = "0";
    mirror.style.overflow = "hidden";
    mirror.style.visibility = "hidden";
    mirror.style.pointerEvents = "none";
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.overflowWrap = "break-word";
    mirror.style.wordWrap = "break-word";

    const caret = document.createElement("span");
    const cursor = Math.max(0, Math.min(textarea.value.length, textarea.selectionStart ?? 0));
    mirror.append(document.createTextNode(textarea.value.slice(0, cursor)), caret);
    caret.textContent = textarea.value.slice(cursor, cursor + 1) || "\u200b";
    document.body.append(mirror);
    const caretRect = caret.getBoundingClientRect();
    mirror.remove();

    const lineHeight = Number.parseFloat(computed.lineHeight)
        || (Number.parseFloat(computed.fontSize) || 16) * 1.2;
    const horizontalInset = Number.parseFloat(computed.borderLeftWidth) || 0;
    const verticalInset = Number.parseFloat(computed.borderTopWidth) || 0;
    const left = Math.min(
        Math.max(caretRect.left - textarea.scrollLeft, inputRect.left + horizontalInset),
        inputRect.right - horizontalInset,
    );
    const top = Math.min(
        Math.max(caretRect.top - textarea.scrollTop, inputRect.top + verticalInset),
        inputRect.bottom - verticalInset - lineHeight,
    );
    return {
        left,
        right: left,
        top,
        bottom: top + lineHeight,
        width: 0,
        height: lineHeight,
    };
}


export function resolveAutocompletePopupPosition({
    inputRect,
    anchorRect = inputRect,
    viewportWidth,
    viewportHeight,
    popupScrollHeight = 240,
    preferredMaxHeight = DEFAULT_AUTOCOMPLETE_POPUP_HEIGHT,
    forceOpenAbove = null,
    horizontalInset = 0,
    margin = 8,
    gap = 4,
}) {
    const safeHorizontalInset = Math.max(0, Number(horizontalInset) || 0);
    const inputWidth = Math.max(0, inputRect.width - safeHorizontalInset * 2);
    const width = Math.max(
        0,
        Math.min(Math.max(inputWidth, 420), viewportWidth - margin * 2),
    );
    const left = Math.min(
        Math.max(margin, inputRect.left + safeHorizontalInset),
        Math.max(margin, viewportWidth - margin - width),
    );
    const normalizedPreferredHeight = normalizeAutocompletePopupHeight(preferredMaxHeight);
    const contentHeight = Math.max(0, Number(popupScrollHeight) || 0);
    const desiredHeight = Math.min(
        normalizedPreferredHeight,
        contentHeight || normalizedPreferredHeight,
    );
    const below = viewportHeight - anchorRect.bottom - margin - gap;
    const above = anchorRect.top - margin - gap;
    const openAbove = typeof forceOpenAbove === "boolean"
        ? forceOpenAbove
        : below < desiredHeight && above > below;
    const available = Math.max(64, openAbove ? above : below);
    return {
        width: Math.round(width),
        left: Math.round(left),
        maxHeight: Math.round(Math.min(normalizedPreferredHeight, available)),
        top: openAbove ? null : Math.round(anchorRect.bottom + gap),
        bottom: openAbove ? Math.round(viewportHeight - anchorRect.top + gap) : null,
        openAbove,
    };
}


export class PromptAutocompleteController {
    constructor(input, provider, {
        getLocale: localeGetter = getLocale,
        getContext,
        getAnchorRect,
        getExistingPrompt = () => input.value,
        onSelect,
        debounceMs = DEFAULT_AUTOCOMPLETE_DEBOUNCE_MS,
        limit = DEFAULT_AUTOCOMPLETE_LIMIT,
        getLimit,
        popupParent = document.body,
        popupHorizontalInset = 0,
        suppressInitialFocusSearch = false,
        completionSeparator = "",
    } = {}) {
        this.input = input;
        this.provider = provider;
        this.getLocale = localeGetter;
        this.getContext = getContext || (() => resolvePromptCompletionContext(
            input.value,
            input.selectionStart,
            input.selectionEnd,
        ));
        this.getAnchorRect = typeof getAnchorRect === "function" ? getAnchorRect : null;
        this.getExistingPrompt = getExistingPrompt;
        this.onSelect = typeof onSelect === "function" ? onSelect : null;
        this.debounceMs = debounceMs;
        this.limit = normalizeAutocompleteLimit(limit);
        this.getLimit = typeof getLimit === "function" ? getLimit : () => this.limit;
        this.popupParent = popupParent;
        this.popupHorizontalInset = Math.max(0, Number(popupHorizontalInset) || 0);
        this.suppressNextFocusSearch = Boolean(suppressInitialFocusSearch);
        this.completionSeparator = typeof completionSeparator === "string" ? completionSeparator : "";
        this.popup = createElement("div", "cpw-tag-autocomplete");
        this.popup.id = `cpw-tag-autocomplete-${Math.random().toString(36).slice(2)}`;
        this.header = createElement("div", "cpw-tag-autocomplete__header");
        this.heading = createElement("div", "cpw-tag-autocomplete__heading");
        this.title = createElement("span", "cpw-tag-autocomplete__title", t("Prompt autocomplete"));
        this.resultCount = createElement("span", "cpw-tag-autocomplete__result-count", "0");
        this.heading.append(this.title, this.resultCount);
        this.resultsContainer = createElement("div", "cpw-tag-autocomplete__results");
        this.resultsContainer.id = `${this.popup.id}-results`;
        this.resultsContainer.setAttribute("role", "listbox");
        this.resultsContainer.setAttribute("aria-label", t("Prompt tag matches"));
        this.closeButton = createElement("button", "cpw-tag-autocomplete__close", "×");
        this.closeButton.type = "button";
        this.closeButton.title = t("Close");
        this.closeButton.setAttribute("aria-label", t("Close"));
        this.header.append(this.heading, this.closeButton);
        this.resizeHandle = createElement("div", "cpw-tag-autocomplete__resize-handle");
        this.resizeHandle.tabIndex = 0;
        this.resizeHandle.setAttribute("role", "separator");
        this.resizeHandle.setAttribute("aria-orientation", "horizontal");
        this.resizeHandle.setAttribute("aria-valuemin", String(MIN_AUTOCOMPLETE_POPUP_HEIGHT));
        this.resizeHandle.setAttribute("aria-valuemax", String(MAX_AUTOCOMPLETE_POPUP_HEIGHT));
        this.resizeHandle.title = t("Drag to resize; double-click to reset");
        this.resizeHandle.setAttribute("aria-label", t("Resize prompt autocomplete"));
        this.popup.hidden = true;
        this.popup.append(this.header, this.resultsContainer, this.resizeHandle);
        this.popupParent.append(this.popup);
        this.results = [];
        this.resultButtons = [];
        this.activeIndex = -1;
        this.context = null;
        this.status = null;
        this.timer = 0;
        this.sequence = 0;
        this.abortController = null;
        this.composing = false;
        this.destroyed = false;
        this.blurTimer = 0;
        this.applyingCompletion = false;
        this.preferredPopupHeight = readAutocompletePopupHeight();
        this.lastOpenAbove = false;
        this.resizeSession = null;
        this.syncResizeAccessibility();

        input.setAttribute("role", "combobox");
        input.setAttribute("aria-autocomplete", "list");
        input.setAttribute("aria-controls", this.resultsContainer.id);
        input.setAttribute("aria-expanded", "false");

        this.handleInput = () => {
            if (!this.applyingCompletion) this.schedule();
        };
        this.handleKeyDown = (event) => this.onKeyDown(event);
        this.handleCompositionStart = () => {
            this.composing = true;
            this.cancelPending();
            this.close();
        };
        this.handleCompositionEnd = () => {
            this.composing = false;
            this.schedule();
        };
        this.handleBlur = (event) => {
            this.cancelPending();
            clearTimeout(this.blurTimer);
            if (event.relatedTarget && this.popup.contains(event.relatedTarget)) return;
            this.blurTimer = setTimeout(() => this.close(), 100);
        };
        this.handleFocus = () => {
            if (this.suppressNextFocusSearch) {
                this.suppressNextFocusSearch = false;
                this.close();
                return;
            }
            this.schedule();
        };
        this.handleCaretMove = () => this.position();
        this.handleViewport = () => this.position();
        this.handleSettings = () => this.refreshForExternalChange();
        this.handlePopupWheel = (event) => event.stopPropagation();
        this.handleClosePointerDown = (event) => {
            event.preventDefault();
            event.stopPropagation();
        };
        this.handleCloseClick = (event) => {
            this.handleClosePointerDown(event);
            const restoreInputFocus = this.popup.contains(document.activeElement);
            this.cancelPending();
            this.sequence += 1;
            this.close();
            if (restoreInputFocus && !this.destroyed) {
                this.suppressNextFocusSearch = true;
                this.input.focus({ preventScroll: true });
            }
        };
        this.handleGlobalKeyDown = (event) => {
            if (
                event.key !== "Escape"
                || this.popup.hidden
                || (
                    document.activeElement !== this.input
                    && !this.popup.contains(document.activeElement)
                )
            ) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            this.handleCloseClick(event);
        };
        this.handleResizePointerDown = (event) => {
            if (event.button !== 0 || this.resizeSession || this.popup.hidden) return;
            const rect = this.popup.getBoundingClientRect();
            this.resizeSession = {
                pointerId: event.pointerId,
                startY: event.clientY,
                startHeight: rect.height,
                openAbove: this.lastOpenAbove,
            };
            this.popup.classList.add("cpw-tag-autocomplete--resizing");
            event.preventDefault();
            event.stopPropagation();
            this.resizeHandle.setPointerCapture(event.pointerId);
        };
        this.handleResizePointerMove = (event) => {
            if (!this.resizeSession || event.pointerId !== this.resizeSession.pointerId) return;
            this.setPreferredPopupHeight(resizedAutocompletePopupHeight({
                startHeight: this.resizeSession.startHeight,
                deltaY: event.clientY - this.resizeSession.startY,
                openAbove: this.resizeSession.openAbove,
            }), { persist: false });
            this.position({ forceOpenAbove: this.resizeSession.openAbove });
            event.preventDefault();
            event.stopPropagation();
        };
        this.handleResizePointerEnd = (event) => {
            if (!this.resizeSession || event.pointerId !== this.resizeSession.pointerId) return;
            this.finishResize();
            event.preventDefault();
            event.stopPropagation();
        };
        this.handleResizeDoubleClick = (event) => {
            this.finishResize({ persist: false });
            this.setPreferredPopupHeight(DEFAULT_AUTOCOMPLETE_POPUP_HEIGHT);
            this.position({ forceOpenAbove: this.lastOpenAbove });
            event.preventDefault();
            event.stopPropagation();
        };
        this.handleResizeKeyDown = (event) => {
            const step = event.shiftKey ? 48 : 16;
            let nextHeight = null;
            if (event.key === "Home") {
                nextHeight = MIN_AUTOCOMPLETE_POPUP_HEIGHT;
            } else if (event.key === "End") {
                nextHeight = MAX_AUTOCOMPLETE_POPUP_HEIGHT;
            } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                const movingTowardTop = event.key === "ArrowUp";
                const expands = this.lastOpenAbove ? movingTowardTop : !movingTowardTop;
                nextHeight = this.preferredPopupHeight + (expands ? step : -step);
            }
            if (nextHeight === null) return;
            this.setPreferredPopupHeight(nextHeight);
            this.position({ forceOpenAbove: this.lastOpenAbove });
            event.preventDefault();
            event.stopPropagation();
        };

        input.addEventListener("input", this.handleInput);
        input.addEventListener("keydown", this.handleKeyDown);
        input.addEventListener("compositionstart", this.handleCompositionStart);
        input.addEventListener("compositionend", this.handleCompositionEnd);
        input.addEventListener("blur", this.handleBlur);
        input.addEventListener("focus", this.handleFocus);
        input.addEventListener("click", this.handleCaretMove);
        input.addEventListener("select", this.handleCaretMove);
        input.addEventListener("scroll", this.handleCaretMove, { passive: true });
        globalThis.addEventListener("keydown", this.handleGlobalKeyDown, true);
        globalThis.addEventListener("resize", this.handleViewport);
        document.addEventListener("scroll", this.handleViewport, true);
        globalThis.addEventListener(AUTOCOMPLETE_SETTINGS_EVENT, this.handleSettings);
        this.popup.addEventListener("wheel", this.handlePopupWheel, { passive: true });
        this.closeButton.addEventListener("pointerdown", this.handleClosePointerDown);
        this.closeButton.addEventListener("mousedown", this.handleClosePointerDown);
        this.closeButton.addEventListener("click", this.handleCloseClick);
        this.resizeHandle.addEventListener("pointerdown", this.handleResizePointerDown);
        this.resizeHandle.addEventListener("pointermove", this.handleResizePointerMove);
        this.resizeHandle.addEventListener("pointerup", this.handleResizePointerEnd);
        this.resizeHandle.addEventListener("pointercancel", this.handleResizePointerEnd);
        this.resizeHandle.addEventListener("lostpointercapture", this.handleResizePointerEnd);
        this.resizeHandle.addEventListener("dblclick", this.handleResizeDoubleClick);
        this.resizeHandle.addEventListener("keydown", this.handleResizeKeyDown);
    }

    syncResizeAccessibility() {
        const value = normalizeAutocompletePopupHeight(this.preferredPopupHeight);
        this.resizeHandle.setAttribute("aria-valuenow", String(value));
        this.resizeHandle.setAttribute("aria-valuetext", t("{size} pixels", { size: value }));
    }

    setPreferredPopupHeight(value, { persist = true } = {}) {
        this.preferredPopupHeight = persist
            ? persistAutocompletePopupHeight(value)
            : normalizeAutocompletePopupHeight(value);
        this.syncResizeAccessibility();
        return this.preferredPopupHeight;
    }

    finishResize({ persist = true } = {}) {
        const session = this.resizeSession;
        if (!session) return;
        this.resizeSession = null;
        this.popup.classList.remove("cpw-tag-autocomplete--resizing");
        if (persist) this.setPreferredPopupHeight(this.preferredPopupHeight);
        if (this.resizeHandle.hasPointerCapture?.(session.pointerId)) {
            this.resizeHandle.releasePointerCapture(session.pointerId);
        }
    }

    cancelPending() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = 0;
        this.abortController?.abort();
        this.abortController = null;
    }

    schedule({ immediate = false } = {}) {
        if (this.destroyed || this.composing || !this.input.isConnected) return;
        this.cancelPending();
        if (!autocompleteInputOwnsFocus(this.input)) {
            this.close();
            return;
        }
        this.timer = setTimeout(() => {
            this.timer = 0;
            void this.search();
        }, immediate ? 0 : this.debounceMs);
    }

    refreshForExternalChange() {
        if (this.destroyed) return false;
        this.cancelPending();
        if (!autocompleteInputOwnsFocus(this.input)) {
            this.close();
            return false;
        }
        this.schedule({ immediate: true });
        return true;
    }

    refreshLocale() {
        if (this.destroyed) return;
        this.title.textContent = t("Prompt autocomplete");
        this.resultCount.setAttribute("aria-label", t("{count} suggestions", {
            count: this.results.length,
        }));
        this.resultsContainer.setAttribute("aria-label", t("Prompt tag matches"));
        this.closeButton.title = t("Close");
        this.closeButton.setAttribute("aria-label", t("Close"));
        this.resizeHandle.title = t("Drag to resize; double-click to reset");
        this.resizeHandle.setAttribute("aria-label", t("Resize prompt autocomplete"));
        this.syncResizeAccessibility();
        this.refreshForExternalChange();
    }

    async search() {
        if (
            this.destroyed
            || this.composing
            || !autocompleteInputOwnsFocus(this.input)
        ) {
            this.close();
            return;
        }
        this.context = this.getContext();
        const query = this.context?.query || "";
        if (!autocompleteQueryIsEligible(query)) {
            this.close();
            return;
        }
        const sequence = ++this.sequence;
        const abortController = new AbortController();
        this.abortController = abortController;
        try {
            const response = await this.provider.search(
                query,
                this.getLocale(),
                normalizeAutocompleteLimit(this.getLimit(), this.limit),
                { signal: abortController.signal },
            );
            if (
                this.destroyed
                || sequence !== this.sequence
                || abortController.signal.aborted
                || !autocompleteInputOwnsFocus(this.input)
            ) {
                this.close();
                return;
            }
            this.results = response.results || [];
            this.status = response;
            this.activeIndex = -1;
            this.render();
        } catch (error) {
            if (error?.name !== "AbortError") this.close();
        } finally {
            if (this.abortController === abortController) this.abortController = null;
        }
    }

    render() {
        this.preferredPopupHeight = readAutocompletePopupHeight(undefined, this.preferredPopupHeight);
        this.syncResizeAccessibility();
        this.resultsContainer.replaceChildren();
        this.resultButtons = [];
        const existing = promptPresenceKeys(this.getExistingPrompt());
        const highlightQuery = this.context?.query || "";
        this.results.forEach((record, index) => {
            const option = createElement(
                "button",
                `cpw-tag-autocomplete__option cpw-tag-autocomplete__option--category-${record.category ?? "custom"}`,
            );
            option.type = "button";
            option.id = `${this.popup.id}-option-${index}`;
            option.tabIndex = -1;
            option.setAttribute("role", "option");
            option.setAttribute("aria-selected", "false");
            const present = existing.has(normalizeAutocompleteInsertionKey(record.insertText));
            option.classList.toggle("cpw-tag-autocomplete__option--present", present);
            option.disabled = present;

            const category = createElement("span", "cpw-tag-autocomplete__category", categoryLabel(record));
            const main = createElement("span", "cpw-tag-autocomplete__main");
            const tag = createElement("span", "cpw-tag-autocomplete__tag");
            const translation = createElement("span", "cpw-tag-autocomplete__translation");
            appendAutocompleteHighlightedText(tag, record.tag, highlightQuery);
            appendAutocompleteHighlightedText(
                translation,
                autocompleteTranslationText(record),
                highlightQuery,
            );
            main.append(tag, translation);
            const source = createElement("span", "cpw-tag-autocomplete__source", sourceLabel(record));
            const countText = record.source === "danbooru" && record.postCount > 0
                ? formatAutocompleteCount(record.postCount)
                : "";
            const count = createElement("span", "cpw-tag-autocomplete__count", countText);
            option.append(main, category, source, count);
            const keepInputFocused = (event) => {
                event.preventDefault();
                event.stopPropagation();
            };
            option.addEventListener("pointerdown", keepInputFocused);
            option.addEventListener("mousedown", keepInputFocused);
            option.addEventListener("click", (event) => {
                keepInputFocused(event);
                this.select(index);
            });
            this.resultsContainer.append(option);
            this.resultButtons.push(option);
        });

        if (this.status?.danbooruEnabled && this.status?.danbooruStatus?.needs_download) {
            const action = createElement("button", "cpw-tag-autocomplete__download");
            action.type = "button";
            action.textContent = this.status.danbooruStatus.available
                ? t("Download Chinese Danbooru translations")
                : t("Download Danbooru dictionary");
            action.addEventListener("pointerdown", (event) => event.preventDefault());
            action.addEventListener("click", async (event) => {
                event.preventDefault();
                event.stopPropagation();
                action.disabled = true;
                action.textContent = t("Updating Danbooru dictionary…");
                try {
                    await this.provider.updateDanbooru(this.getLocale());
                    this.schedule({ immediate: true });
                } catch (error) {
                    action.disabled = false;
                    action.textContent = t("Update failed: {message}", {
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            });
            this.resultsContainer.append(action);
        }

        this.resultCount.textContent = String(this.results.length);
        this.resultCount.setAttribute("aria-label", t("{count} suggestions", {
            count: this.results.length,
        }));
        const visible = this.resultsContainer.childElementCount > 0;
        this.popup.hidden = !visible;
        this.input.setAttribute("aria-expanded", String(visible));
        this.input.removeAttribute("aria-activedescendant");
        if (visible) this.position();
    }

    position({ forceOpenAbove = null } = {}) {
        if (this.destroyed || this.popup.hidden || !this.input.isConnected) return;
        const inputRect = this.input.getBoundingClientRect();
        const anchorRect = this.getAnchorRect?.() || inputRect;
        const viewportWidth = document.documentElement.clientWidth || globalThis.innerWidth;
        const viewportHeight = document.documentElement.clientHeight || globalThis.innerHeight;
        const position = resolveAutocompletePopupPosition({
            inputRect,
            anchorRect,
            viewportWidth,
            viewportHeight,
            popupScrollHeight: this.header.offsetHeight + this.resultsContainer.scrollHeight + 10,
            preferredMaxHeight: this.preferredPopupHeight,
            forceOpenAbove,
            horizontalInset: this.popupHorizontalInset,
        });
        this.lastOpenAbove = position.openAbove;
        this.popup.classList.toggle("cpw-tag-autocomplete--above", position.openAbove);
        this.popup.classList.toggle("cpw-tag-autocomplete--below", !position.openAbove);
        this.popup.style.width = `${position.width}px`;
        this.popup.style.left = `${position.left}px`;
        this.popup.style.maxHeight = `${position.maxHeight}px`;
        if (position.openAbove) {
            this.popup.style.top = "auto";
            this.popup.style.bottom = `${position.bottom}px`;
        } else {
            this.popup.style.top = `${position.top}px`;
            this.popup.style.bottom = "auto";
        }
    }

    syncActive() {
        this.resultButtons.forEach((button, index) => {
            const active = index === this.activeIndex;
            button.classList.toggle("cpw-tag-autocomplete__option--active", active);
            button.setAttribute("aria-selected", String(active));
        });
        const activeButton = this.resultButtons[this.activeIndex];
        if (activeButton) {
            this.input.setAttribute("aria-activedescendant", activeButton.id);
            activeButton.scrollIntoView({ block: "nearest" });
        } else {
            this.input.removeAttribute("aria-activedescendant");
        }
    }

    moveActive(direction) {
        if (!this.resultButtons.some((button) => !button.disabled)) return false;
        let index = this.activeIndex;
        for (let attempt = 0; attempt < this.resultButtons.length; attempt += 1) {
            index = direction > 0
                ? (index + 1 + this.resultButtons.length) % this.resultButtons.length
                : (index - 1 + this.resultButtons.length) % this.resultButtons.length;
            if (!this.resultButtons[index].disabled) {
                this.activeIndex = index;
                this.syncActive();
                return true;
            }
        }
        return false;
    }

    onKeyDown(event) {
        if (this.composing || event.isComposing) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (this.popup.hidden || !this.results.length) return;
            if (this.moveActive(event.key === "ArrowDown" ? 1 : -1)) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
            return;
        }
        if ((event.key === "Enter" || (event.key === "Tab" && !event.shiftKey))
            && this.activeIndex >= 0) {
            event.preventDefault();
            event.stopImmediatePropagation();
            this.select(this.activeIndex);
            return;
        }
        if (event.key === "Escape" && !this.popup.hidden) {
            event.preventDefault();
            event.stopImmediatePropagation();
            this.cancelPending();
            this.sequence += 1;
            this.close();
        }
    }

    select(index) {
        const record = this.results[index];
        if (!record || this.resultButtons[index]?.disabled) return false;
        clearTimeout(this.blurTimer);
        if (this.onSelect) {
            this.onSelect(record, this.context);
        } else {
            const result = this.completionSeparator
                ? applyPromptCompletionWithSeparator(
                    this.input.value,
                    this.context,
                    record.insertText,
                    this.completionSeparator,
                )
                : applyPromptCompletion(this.input.value, this.context, record.insertText);
            this.input.value = result.value;
            this.input.setSelectionRange?.(result.cursor, result.cursor);
            this.applyingCompletion = true;
            try {
                this.input.dispatchEvent(new Event("input", { bubbles: true }));
            } finally {
                this.applyingCompletion = false;
            }
        }
        if (!this.destroyed) {
            this.close();
            this.input.focus({ preventScroll: true });
        }
        return true;
    }

    close() {
        this.finishResize();
        this.results = [];
        this.resultButtons = [];
        this.activeIndex = -1;
        this.popup.hidden = true;
        this.resultsContainer.replaceChildren();
        this.input.setAttribute("aria-expanded", "false");
        this.input.removeAttribute("aria-activedescendant");
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.finishResize();
        this.cancelPending();
        clearTimeout(this.blurTimer);
        this.input.removeEventListener("input", this.handleInput);
        this.input.removeEventListener("keydown", this.handleKeyDown);
        this.input.removeEventListener("compositionstart", this.handleCompositionStart);
        this.input.removeEventListener("compositionend", this.handleCompositionEnd);
        this.input.removeEventListener("blur", this.handleBlur);
        this.input.removeEventListener("focus", this.handleFocus);
        this.input.removeEventListener("click", this.handleCaretMove);
        this.input.removeEventListener("select", this.handleCaretMove);
        this.input.removeEventListener("scroll", this.handleCaretMove);
        globalThis.removeEventListener("keydown", this.handleGlobalKeyDown, true);
        globalThis.removeEventListener("resize", this.handleViewport);
        document.removeEventListener("scroll", this.handleViewport, true);
        globalThis.removeEventListener(AUTOCOMPLETE_SETTINGS_EVENT, this.handleSettings);
        this.popup.removeEventListener("wheel", this.handlePopupWheel);
        this.closeButton.removeEventListener("pointerdown", this.handleClosePointerDown);
        this.closeButton.removeEventListener("mousedown", this.handleClosePointerDown);
        this.closeButton.removeEventListener("click", this.handleCloseClick);
        this.resizeHandle.removeEventListener("pointerdown", this.handleResizePointerDown);
        this.resizeHandle.removeEventListener("pointermove", this.handleResizePointerMove);
        this.resizeHandle.removeEventListener("pointerup", this.handleResizePointerEnd);
        this.resizeHandle.removeEventListener("pointercancel", this.handleResizePointerEnd);
        this.resizeHandle.removeEventListener("lostpointercapture", this.handleResizePointerEnd);
        this.resizeHandle.removeEventListener("dblclick", this.handleResizeDoubleClick);
        this.resizeHandle.removeEventListener("keydown", this.handleResizeKeyDown);
        this.popup.remove();
    }
}
