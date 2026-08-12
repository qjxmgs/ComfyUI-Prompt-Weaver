import { getLocale, t } from "./prompt_weaver_i18n.js";
import {
    PromptAssistantTagCatalog,
    normalizePromptAssistantSearchText,
    promptAssistantQueryIsEligible,
    searchPromptAssistantTags,
} from "./prompt_assistant_tags.js";


export const DANBOORU_SETTING_ID = "PromptWeaver.Autocomplete.Danbooru";
export const PROMPT_ASSISTANT_SETTING_ID = "PromptWeaver.Autocomplete.PromptAssistant";
export const AUTOCOMPLETE_SETTINGS_EVENT = "cpw-prompt-autocomplete-settings-changed";
export const DEFAULT_AUTOCOMPLETE_LIMIT = 20;
export const DEFAULT_AUTOCOMPLETE_DEBOUNCE_MS = 120;

const TOP_LEVEL_SEPARATORS = new Set([",", "，", "\n", "\r"]);
const OPENING_BRACKETS = new Map([["(", ")"], ["[", "]"], ["{", "}"]]);
const CLOSING_BRACKETS = new Set(OPENING_BRACKETS.values());
const WEIGHT_SUFFIX_PATTERN = /:\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*$/u;
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


function matchingRank(fields, queryValue) {
    const query = normalizeAutocompleteText(queryValue);
    let rank = Number.POSITIVE_INFINITY;
    for (const value of fields) {
        const field = normalizeAutocompleteText(value);
        if (!field) continue;
        if (field === query) rank = Math.min(rank, 0);
        else if (field.startsWith(query)) rank = Math.min(rank, 1);
        else if (field.includes(query)) rank = Math.min(rank, 2);
    }
    return rank;
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
        const status = await this.status(locale, { signal });
        if (!status?.available) return { results: [], status };
        ensureNotAborted(signal);
        const normalizedLocale = locale === "zh" ? "zh-CN" : locale;
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
            })).filter((record) => record.tag && record.insertText),
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
        for (let attempt = 0; attempt < 240; attempt += 1) {
            await delay(250, signal);
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
        return searchPromptAssistantTags(records, query, limit).map((record) => ({
            source: "prompt-assistant",
            tag: String(record.value || ""),
            insertText: String(record.value || ""),
            translation: String(record.name || ""),
            category: null,
            categoryPath: Array.isArray(record.categoryPath) ? record.categoryPath : [],
            postCount: 0,
            matchRank: matchingRank([record.value, ...(record.aliases || [])], query),
        })).filter((record) => record.tag && record.insertText);
    }
}


export function mergeAutocompleteResults(resultGroups, limit = DEFAULT_AUTOCOMPLETE_LIMIT) {
    const candidates = [];
    let sequence = 0;
    for (const group of Array.isArray(resultGroups) ? resultGroups : []) {
        for (const record of Array.isArray(group) ? group : []) {
            const sourcePriority = record?.source === "prompt-assistant" ? 0 : 1;
            candidates.push({
                record,
                rank: Number.isFinite(record?.matchRank) ? record.matchRank : 2,
                sourcePriority,
                postCount: Number(record?.postCount) || 0,
                sequence: sequence++,
            });
        }
    }
    candidates.sort((left, right) => (
        left.rank - right.rank
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
        onDiagnostic,
    } = {}) {
        this.danbooruEnabled = danbooruEnabled;
        this.promptAssistantEnabled = promptAssistantEnabled;
        this.onDiagnostic = typeof onDiagnostic === "function" ? onDiagnostic : null;
        this.danbooru = new DanbooruTagProvider(api);
        this.promptAssistant = new PromptAssistantTagProvider(api, { onDiagnostic });
    }

    async search(query, locale = getLocale(), limit = DEFAULT_AUTOCOMPLETE_LIMIT, { signal } = {}) {
        if (!autocompleteQueryIsEligible(query)) {
            return { results: [], danbooruStatus: null, danbooruEnabled: this.danbooruEnabled() };
        }
        const groups = [];
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
            results: mergeAutocompleteResults(groups, limit),
            danbooruStatus,
            danbooruEnabled,
        };
    }

    async updateDanbooru(locale = getLocale(), options = {}) {
        return this.danbooru.update(locale, options);
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


export class PromptAutocompleteController {
    constructor(input, provider, {
        getLocale: localeGetter = getLocale,
        getContext,
        getExistingPrompt = () => input.value,
        onSelect,
        debounceMs = DEFAULT_AUTOCOMPLETE_DEBOUNCE_MS,
        limit = DEFAULT_AUTOCOMPLETE_LIMIT,
        popupParent = document.body,
    } = {}) {
        this.input = input;
        this.provider = provider;
        this.getLocale = localeGetter;
        this.getContext = getContext || (() => resolvePromptCompletionContext(
            input.value,
            input.selectionStart,
            input.selectionEnd,
        ));
        this.getExistingPrompt = getExistingPrompt;
        this.onSelect = typeof onSelect === "function" ? onSelect : null;
        this.debounceMs = debounceMs;
        this.limit = limit;
        this.popupParent = popupParent;
        this.popup = createElement("div", "cpw-tag-autocomplete");
        this.popup.id = `cpw-tag-autocomplete-${Math.random().toString(36).slice(2)}`;
        this.popup.setAttribute("role", "listbox");
        this.popup.setAttribute("aria-label", t("Prompt tag matches"));
        this.popup.hidden = true;
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

        input.setAttribute("role", "combobox");
        input.setAttribute("aria-autocomplete", "list");
        input.setAttribute("aria-controls", this.popup.id);
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
        this.handleBlur = () => {
            clearTimeout(this.blurTimer);
            this.blurTimer = setTimeout(() => this.close(), 100);
        };
        this.handleFocus = () => this.schedule();
        this.handleViewport = () => this.position();
        this.handleSettings = () => this.schedule({ immediate: true });
        this.handlePopupWheel = (event) => event.stopPropagation();
        this.handleGlobalKeyDown = (event) => {
            if (
                event.key !== "Escape"
                || this.popup.hidden
                || document.activeElement !== this.input
            ) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            this.close();
        };

        input.addEventListener("input", this.handleInput);
        input.addEventListener("keydown", this.handleKeyDown);
        input.addEventListener("compositionstart", this.handleCompositionStart);
        input.addEventListener("compositionend", this.handleCompositionEnd);
        input.addEventListener("blur", this.handleBlur);
        input.addEventListener("focus", this.handleFocus);
        globalThis.addEventListener("keydown", this.handleGlobalKeyDown, true);
        globalThis.addEventListener("resize", this.handleViewport);
        document.addEventListener("scroll", this.handleViewport, true);
        globalThis.addEventListener(AUTOCOMPLETE_SETTINGS_EVENT, this.handleSettings);
        this.popup.addEventListener("wheel", this.handlePopupWheel, { passive: true });
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
        this.timer = setTimeout(() => {
            this.timer = 0;
            void this.search();
        }, immediate ? 0 : this.debounceMs);
    }

    refreshLocale() {
        if (this.destroyed) return;
        this.popup.setAttribute("aria-label", t("Prompt tag matches"));
        this.schedule({ immediate: true });
    }

    async search() {
        if (this.destroyed || this.composing) return;
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
                this.limit,
                { signal: abortController.signal },
            );
            if (this.destroyed || sequence !== this.sequence || abortController.signal.aborted) return;
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
        this.popup.replaceChildren();
        this.resultButtons = [];
        const existing = promptPresenceKeys(this.getExistingPrompt());
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
            main.append(createElement("span", "cpw-tag-autocomplete__tag", record.tag));
            main.append(createElement(
                "span",
                "cpw-tag-autocomplete__translation",
                autocompleteTranslationText(record),
            ));
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
            this.popup.append(option);
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
            this.popup.append(action);
        }

        const visible = this.popup.childElementCount > 0;
        this.popup.hidden = !visible;
        this.input.setAttribute("aria-expanded", String(visible));
        this.input.removeAttribute("aria-activedescendant");
        if (visible) this.position();
    }

    position() {
        if (this.destroyed || this.popup.hidden || !this.input.isConnected) return;
        const rect = this.input.getBoundingClientRect();
        const viewportWidth = document.documentElement.clientWidth || globalThis.innerWidth;
        const viewportHeight = document.documentElement.clientHeight || globalThis.innerHeight;
        const margin = 8;
        const gap = 4;
        const width = Math.max(
            0,
            Math.min(Math.max(rect.width, 420), viewportWidth - margin * 2),
        );
        const left = Math.min(
            Math.max(margin, rect.left),
            Math.max(margin, viewportWidth - margin - width),
        );
        const preferredHeight = Math.min(320, this.popup.scrollHeight || 240);
        const below = viewportHeight - rect.bottom - margin - gap;
        const above = rect.top - margin - gap;
        const openAbove = below < preferredHeight && above > below;
        const available = Math.max(64, openAbove ? above : below);
        this.popup.style.width = `${Math.round(width)}px`;
        this.popup.style.left = `${Math.round(left)}px`;
        this.popup.style.maxHeight = `${Math.round(Math.min(320, available))}px`;
        if (openAbove) {
            this.popup.style.top = "auto";
            this.popup.style.bottom = `${Math.round(viewportHeight - rect.top + gap)}px`;
        } else {
            this.popup.style.top = `${Math.round(rect.bottom + gap)}px`;
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
        if ((event.key === "Enter" || event.key === "Tab") && this.activeIndex >= 0) {
            event.preventDefault();
            event.stopImmediatePropagation();
            this.select(this.activeIndex);
            return;
        }
        if (event.key === "Escape" && !this.popup.hidden) {
            event.preventDefault();
            event.stopImmediatePropagation();
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
            const result = applyPromptCompletion(this.input.value, this.context, record.insertText);
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
        this.results = [];
        this.resultButtons = [];
        this.activeIndex = -1;
        this.popup.hidden = true;
        this.popup.replaceChildren();
        this.input.setAttribute("aria-expanded", "false");
        this.input.removeAttribute("aria-activedescendant");
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.cancelPending();
        clearTimeout(this.blurTimer);
        this.input.removeEventListener("input", this.handleInput);
        this.input.removeEventListener("keydown", this.handleKeyDown);
        this.input.removeEventListener("compositionstart", this.handleCompositionStart);
        this.input.removeEventListener("compositionend", this.handleCompositionEnd);
        this.input.removeEventListener("blur", this.handleBlur);
        this.input.removeEventListener("focus", this.handleFocus);
        globalThis.removeEventListener("keydown", this.handleGlobalKeyDown, true);
        globalThis.removeEventListener("resize", this.handleViewport);
        document.removeEventListener("scroll", this.handleViewport, true);
        globalThis.removeEventListener(AUTOCOMPLETE_SETTINGS_EVENT, this.handleSettings);
        this.popup.removeEventListener("wheel", this.handlePopupWheel);
        this.popup.remove();
    }
}
