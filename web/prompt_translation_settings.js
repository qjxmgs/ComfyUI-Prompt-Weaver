import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
    connectPromptWeaverI18n,
    formatDateTime,
    formatNumber,
    subscribePromptWeaverLocale,
    t,
} from "./prompt_weaver_i18n.js?v=20260923-sqlite-filter-v1";
import {
    TRANSLATION_STATUS_POLL_MS,
    TRANSLATION_UPDATE_TIMEOUT_MS,
    shortBlobSha,
    translationManagerState,
} from "./prompt_translation_manager.js?v=20260923-sqlite-filter-v1";
import {
    AUTOCOMPLETE_LIMIT_SETTING_ID,
    AUTOCOMPLETE_SETTINGS_EVENT,
    AUTOCOMPLETE_SOURCE_ORDER_SETTING_ID,
    DANBOORU_SETTING_ID,
    DEFAULT_AUTOCOMPLETE_SOURCE_ORDER,
    PROMPT_ASSISTANT_SETTING_ID,
    normalizeAutocompleteSourceOrder,
} from "./prompt_tag_autocomplete.js?v=20260923-sqlite-filter-v1";

import { MIN_POST_COUNT_SETTING_ID, DEFAULT_MIN_POST_COUNT, DanbooruFilterState } from "./prompt_tag_filter.js?v=20260923-sqlite-filter-v1";

const TRANSLATION_MANAGER_SETTING_ID = "PromptWeaver.Autocomplete.TranslationManager";
const TRANSLATION_MANAGER_COMMAND_ID = "PromptWeaver.Autocomplete.UpdateDictionary";
const MAX_LOCAL_SUPPLEMENT_BYTES = 64 * 1024 * 1024;

class TranslationApiClient {
    constructor(apiClient) {
        this.api = apiClient;
    }

    async fetchJson(path, options, label) {
        if (!this.api || typeof this.api.fetchApi !== "function") {
            throw new Error(t("The ComfyUI API client is unavailable."));
        }
        const response = await this.api.fetchApi(path, options);
        let payload = null;
        try {
            payload = await response?.json?.();
        } catch (_error) {
            throw new Error(t("{label} returned invalid JSON.", { label }));
        }
        if (!response || response.ok === false) {
            throw new Error(payload?.error || t("{label} request failed.", { label }));
        }
        return payload;
    }

    invalidateStatus() {}

    status(locale = "zh-CN", { signal, minPostCount = readMinPostCount() } = {}) {
        return this.fetchJson(
            `/prompt-weaver/tag-autocomplete/status?locale=${encodeURIComponent(locale)}&min_post_count=${minPostCount}`,
            { signal },
            t("Danbooru dictionary status"),
        );
    }

    async update(locale = "zh-CN") {
        await this.fetchJson(
            "/prompt-weaver/tag-autocomplete/update",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ locale }),
            },
            t("Danbooru dictionary update"),
        );
        const attempts = Math.ceil(TRANSLATION_UPDATE_TIMEOUT_MS / TRANSLATION_STATUS_POLL_MS);
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, TRANSLATION_STATUS_POLL_MS));
            const status = await this.status(locale);
            if (!status?.updating) {
                if (status?.error && !status?.available) throw new Error(status.error);
                return status;
            }
        }
        throw new Error(t("Danbooru dictionary update timed out."));
    }

    selectSource(source) {
        return this.fetchJson("/prompt-weaver/tag-autocomplete/source", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source }),
        }, t("Danbooru dictionary source"));
    }

    importSupplement(file) {
        return this.fetchJson(
            "/prompt-weaver/tag-autocomplete/supplement/import",
            {
                method: "POST",
                headers: { "Content-Type": "application/octet-stream" },
                body: file,
            },
            t("Local tag.sqlite import"),
        );
    }

    rescanSupplement(locale = "zh-CN") {
        return this.fetchJson(
            "/prompt-weaver/tag-autocomplete/supplement/rescan",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ locale }),
            },
            t("Local tag.sqlite rescan"),
        );
    }
}

const translationProvider = new TranslationApiClient(api);

function readMinPostCount() {
    const value = Number(app?.extensionManager?.setting?.get?.(MIN_POST_COUNT_SETTING_ID));
    return Number.isSafeInteger(value) && value >= 10 ? value : DEFAULT_MIN_POST_COUNT;
}

const tagFilter = new DanbooruFilterState({
    value: readMinPostCount(),
    save: (value) => writeAutocompleteSetting(MIN_POST_COUNT_SETTING_ID, value),
    status: (value, signal) => translationProvider.status("zh-CN", { signal, minPostCount: value }),
    changed: () => {
        for (const control of document.querySelectorAll("[data-cpw-tag-filter]")) control.refresh();
    },
});

function createMinPostCountControl() {
    ensureTranslationStylesheet();
    const control = element("section", "cpw-tag-filter");
    control.dataset.cpwTagFilter = "true";
    const heading = element("div", "cpw-tag-filter__heading");
    const label = element("label", "cpw-tag-filter__label");
    const help = element("span", "cpw-tag-filter__help", "!");
    help.tabIndex = 0;
    help.setAttribute("role", "img");
    const helpTooltip = element("span", "cpw-tag-filter__tooltip");
    helpTooltip.setAttribute("role", "tooltip");
    helpTooltip.hidden = true;
    const input = element("input", "cpw-tag-filter__input");
    input.type = "number";
    input.min = "10";
    input.max = String(Number.MAX_SAFE_INTEGER);
    input.step = "1";
    input.id = `cpw-tag-filter-${createId()}`;
    label.htmlFor = input.id;
    helpTooltip.id = `${input.id}-help`;
    help.setAttribute("aria-describedby", helpTooltip.id);
    heading.append(label, help, helpTooltip);
    help.addEventListener("pointerenter", () => { helpTooltip.hidden = false; });
    help.addEventListener("focus", () => { helpTooltip.hidden = false; });
    heading.addEventListener("pointerleave", () => {
        if (document.activeElement !== help) helpTooltip.hidden = true;
    });
    help.addEventListener("blur", () => { helpTooltip.hidden = true; });
    help.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        helpTooltip.hidden = true;
    });
    const row = element("div", "cpw-tag-filter__row");
    row.append(input);
    const presets = [10, 50, 100, 200, 300, 400, 500, 1000].map((value) => {
        const button = translationManagerActionButton(String(value), () => tagFilter.input(value));
        row.append(button);
        return [button, value];
    });
    const count = element("div", "cpw-tag-filter__count");
    count.setAttribute("role", "status");
    count.setAttribute("aria-live", "polite");
    const hint = element("p", "cpw-tag-filter__hint");
    hint.id = `${input.id}-hint`;
    input.setAttribute("aria-describedby", `${helpTooltip.id} ${hint.id}`);
    control.append(heading, row, count, hint);
    input.addEventListener("input", () => tagFilter.input(input.value));
    input.addEventListener("keydown", (event) => event.stopPropagation());
    control.refresh = () => {
        label.textContent = t("Minimum Danbooru post count");
        help.setAttribute("aria-label", label.textContent);
        helpTooltip.textContent = t("Only load tags used in at least this many Danbooru posts.");
        input.setAttribute("aria-label", label.textContent);
        input.setAttribute("aria-invalid", String(tagFilter.invalid));
        if (input.value !== tagFilter.draft) input.value = tagFilter.draft;
        hint.textContent = t("Lower values load more tags and use more resources.");
        for (const [button, value] of presets) {
            button.setAttribute("aria-pressed", String(Number(tagFilter.draft) === value));
            button.title = t("Set minimum post count to {count}", { count: value });
            button.setAttribute("aria-label", button.title);
        }
        count.textContent = tagFilter.invalid
            ? t("Enter an integer of at least 10.")
            : tagFilter.pending ? t("Counting…")
            : tagFilter.error || (!tagFilter.status?.available ? t("No valid Danbooru dictionary installed.")
                : t(readBooleanAutocompleteSetting(DANBOORU_SETTING_ID)
                    ? "Active Danbooru tags: {active} / {total} total"
                    : "Danbooru disabled — available tags: {active} / {total} total", {
                    active: formatNumber(tagFilter.status.active_count),
                    total: formatNumber(tagFilter.status.total_count),
                }));
        count.classList.toggle("cpw-tag-filter__count--error", tagFilter.invalid || Boolean(tagFilter.error));
    };
    control.refresh();
    if (!tagFilter.pending && !tagFilter.status) void tagFilter.refresh(readMinPostCount());
    return control;
}

globalThis.addEventListener(AUTOCOMPLETE_SETTINGS_EVENT, () => {
    void tagFilter.refresh(readMinPostCount());
});

let activeTranslationManager = null;
let activeUpdateOperation = null;
let activeSupplementOperation = null;
let fallbackId = 0;

function element(tagName, className, text) {
    const result = document.createElement(tagName);
    if (className) result.className = className;
    if (text != null) result.textContent = text;
    return result;
}

function createId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    fallbackId += 1;
    return `translation-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
}

function ensureTranslationStylesheet() {
    const id = "cpw-prompt-toggle-grid-styles";
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = new URL(
        "./prompt_toggle_grid.css?v=20260923-sqlite-filter-v3",
        import.meta.url,
    ).href;
    document.head.append(link);
}

function dispatchAutocompleteSettingsChanged() {
    globalThis.dispatchEvent(new CustomEvent(AUTOCOMPLETE_SETTINGS_EVENT));
}

function showAutocompleteToast(severity, summary, detail) {
    const toast = app?.extensionManager?.toast;
    if (typeof toast?.add === "function") {
        toast.add({ severity, summary, detail, life: severity === "error" ? 8000 : 5000 });
    } else if (severity === "error") {
        console.error(`[Prompt Weaver] ${summary}: ${detail}`);
    } else {
        console.info(`[Prompt Weaver] ${summary}: ${detail}`);
    }
}

function translationManagerDate(value) {
    return value ? formatDateTime(value) : t("Never");
}

function translationManagerBadge(text, tone = "neutral") {
    return element(
        "span",
        `cpw-translation-manager__badge cpw-translation-manager__badge--${tone}`,
        text,
    );
}

function translationManagerSourceCard({
    title,
    description,
    statusText,
    tone,
    details,
    sourcePage,
    actions = [],
}) {
    const card = element("article", "cpw-translation-manager__source");
    const header = element("div", "cpw-translation-manager__source-header");
    header.append(
        element("h3", "cpw-translation-manager__source-title", title),
        translationManagerBadge(statusText, tone),
    );
    card.append(header, element("p", "cpw-translation-manager__source-description", description));

    const detailList = element("dl", "cpw-translation-manager__source-details");
    for (const [label, value] of details) {
        if (value === "" || value === null || value === undefined) continue;
        detailList.append(
            element("dt", "cpw-translation-manager__source-label", label),
            element("dd", "cpw-translation-manager__source-value", value),
        );
    }
    card.append(detailList);
    if (sourcePage) {
        const link = element("a", "cpw-translation-manager__source-link", t("View source"));
        link.href = sourcePage;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        card.append(link);
    }
    if (actions.length) {
        const actionRow = element("div", "cpw-translation-manager__source-actions");
        actionRow.append(...actions);
        card.append(actionRow);
    }
    return card;
}

function translationManagerSummary(state) {
    const labels = {
        "not-installed": t("Not installed"),
        updating: t("Updating…"),
        failed: t("Update failed"),
        warning: t("Attention needed"),
        ready: t("Ready"),
    };
    const descriptions = {
        "not-installed": t("Download the local dictionary and Simplified Chinese translations to get started."),
        updating: t("Downloading and validating prompt translation data…"),
        failed: state.error || t("Prompt translation data could not be installed."),
        warning: state.error
            || t("The local dictionary remains usable, but part of the translation data needs attention."),
        ready: t("Local prompt translations are ready. Prompt text stays on this device."),
    };
    return { label: labels[state.summary], description: descriptions[state.summary] };
}

function translationManagerActionButton(text, onClick, { disabled = false } = {}) {
    const button = element(
        "button",
        "cpw-translation-manager__button cpw-translation-manager__button--compact",
        text,
    );
    button.type = "button";
    button.disabled = disabled;
    button.addEventListener("click", onClick);
    return button;
}

async function copyLocalSupplementPath(manager, path) {
    if (!path) return;
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(path);
        } else {
            const temporary = element("textarea");
            temporary.value = path;
            temporary.style.position = "fixed";
            temporary.style.opacity = "0";
            document.body.append(temporary);
            temporary.select();
            document.execCommand("copy");
            temporary.remove();
        }
        if (manager === activeTranslationManager) {
            manager.notice = { tone: "info", text: t("Local database path copied.") };
            renderPromptTranslationManager(manager);
        }
    } catch (error) {
        if (manager === activeTranslationManager) {
            manager.notice = {
                tone: "warning",
                text: error instanceof Error ? error.message : String(error),
            };
            renderPromptTranslationManager(manager);
        }
    }
}

function renderPromptTranslationManager(manager) {
    if (!manager || manager !== activeTranslationManager) return;
    const state = translationManagerState(manager.status);
    const scrollTop = manager.content.scrollTop;
    const focusKey = document.activeElement?.dataset?.focusKey;
    if (!manager.filterControl) manager.filterControl = createMinPostCountControl();
    if (!manager.body) {
        manager.body = element("div", "cpw-translation-manager__body");
        manager.content.replaceChildren(manager.filterControl, manager.body);
    }
    const content = manager.body;
    content.replaceChildren();

    const summary = translationManagerSummary(state);
    const summaryCard = element(
        "section",
        `cpw-translation-manager__summary cpw-translation-manager__summary--${state.tone}`,
    );
    const summaryHeader = element("div", "cpw-translation-manager__summary-header");
    const heading = element("div", "cpw-translation-manager__summary-heading");
    const operationInProgress = Boolean(
        state.updating
        || state.importing
        || manager.busy
        || activeUpdateOperation
        || activeSupplementOperation
    );
    if (operationInProgress) {
        heading.append(element("span", "cpw-translation-manager__spinner"));
    }
    heading.append(element("strong", "cpw-translation-manager__summary-title", summary.label));
    summaryHeader.append(
        heading,
        translationManagerBadge(
            state.ready ? t("Available") : (state.available ? t("Partially available") : t("Unavailable")),
            state.tone,
        ),
    );
    summaryCard.append(
        summaryHeader,
        element("p", "cpw-translation-manager__summary-description", summary.description),
    );

    const metrics = element("div", "cpw-translation-manager__metrics");
    for (const [label, value] of [
        [t("Local tags"), formatNumber(state.rowCount)],
        [t("Translated tags"), formatNumber(state.translatedTagCount)],
        [t("Translation coverage"), `${formatNumber(state.coveragePercent)}%`],
    ]) {
        const metric = element("div", "cpw-translation-manager__metric");
        metric.append(
            element("span", "cpw-translation-manager__metric-value", value),
            element("span", "cpw-translation-manager__metric-label", label),
        );
        metrics.append(metric);
    }
    summaryCard.append(metrics);

    const dates = element("div", "cpw-translation-manager__dates");
    dates.append(
        element("span", "", t("Last manual check: {date}", {
            date: translationManagerDate(state.lastCheckedAt),
        })),
        element("span", "", t("Last data update: {date}", {
            date: translationManagerDate(state.lastUpdatedAt),
        })),
    );
    summaryCard.append(dates);
    content.append(summaryCard);

    const sourceRow = element("div", "cpw-translation-manager__source-picker");
    const sourceLabel = element("label", "", t("Danbooru dictionary source"));
    const sourceSelect = element("select", "cpw-tag-filter__input");
    sourceSelect.id = "cpw-dictionary-source";
    sourceSelect.dataset.focusKey = "source";
    sourceLabel.htmlFor = sourceSelect.id;
    for (const [value, name] of [["downloaded", t("GitHub dictionary")], ["local", t("Imported local dictionary")]]) {
        const option = element("option", "", name);
        option.value = value;
        option.disabled = !manager.status?.sources?.[value]?.available && value !== state.selectedSource;
        sourceSelect.append(option);
    }
    sourceSelect.value = state.selectedSource;
    sourceSelect.disabled = operationInProgress;
    sourceSelect.addEventListener("change", async () => {
        const next = sourceSelect.value;
        manager.busy = true;
        renderPromptTranslationManager(manager);
        try {
            manager.status = await beginLocalSupplementOperation(
                () => translationProvider.selectSource(next), t("Dictionary source changed"),
            );
            manager.notice = null;
        } catch (error) {
            manager.notice = { tone: "error", text: String(error?.message || error) };
        } finally {
            manager.busy = false;
            renderPromptTranslationManager(manager);
        }
    });
    sourceRow.append(sourceLabel, sourceSelect);
    content.append(sourceRow);
    const chooseLocalButton = translationManagerActionButton(
        t("Choose local tag.sqlite…"), () => manager.fileInput.click(), { disabled: operationInProgress },
    );
    const rescanLocalButton = translationManagerActionButton(
        t("Rescan local file"), () => void rescanLocalSupplement(manager), { disabled: operationInProgress },
    );
    const copyPathButton = translationManagerActionButton(
        t("Copy path"), () => void copyLocalSupplementPath(manager, state.localPath),
    );
    [chooseLocalButton, rescanLocalButton, copyPathButton].forEach((button, index) => {
        button.dataset.focusKey = `source-action-${index}`;
    });
    content.append(translationManagerSourceCard({
        title: t("Danbooru SQLite dictionary"),
        description: t("One active SQLite provides tag names, Chinese translations, categories and post counts. Import a new copy to update a local file."),
        statusText: state.available ? t("Installed") : t("Not installed"),
        tone: state.available ? "success" : "neutral",
        details: [
            [t("Database rows"), formatNumber(state.rowCount)],
            [t("File SHA-256"), shortBlobSha(state.fileSha256) || "—"],
            [t("Version"), shortBlobSha(state.version) || "—"],
            [t("File modified"), translationManagerDate(state.fileModifiedAt)],
            [t("Local copy path"), state.localPath || "—"],
            ...(state.selectedSource === "downloaded" ? [[t("License"), "MIT"]] : []),
        ],
        sourcePage: state.sourcePage,
        actions: [chooseLocalButton, rescanLocalButton, copyPathButton],
    }));

    if (manager.notice?.text) {
        content.append(element(
            "div",
            `cpw-translation-manager__notice cpw-translation-manager__notice--${manager.notice.tone || "info"}`,
            manager.notice.text,
        ));
    }

    const updateInProgress = operationInProgress;
    manager.updateButton.disabled = updateInProgress;
    manager.updateButton.textContent = updateInProgress
        ? t("Updating…")
        : (state.action === "download"
            ? t("Download dictionary and translations")
            : t("Check and update"));
    manager.content.scrollTop = scrollTop;
    manager.filterControl.refresh();
    if (focusKey) content.querySelector(`[data-focus-key="${focusKey}"]`)?.focus({ preventScroll: true });
    manager.closeButton.textContent = t("Close");
    manager.closeIcon.setAttribute("aria-label", t("Close prompt translation manager"));
}

function promptTranslationPollDelay(signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            const error = new Error("Aborted");
            error.name = "AbortError";
            reject(error);
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            const error = new Error("Aborted");
            error.name = "AbortError";
            reject(error);
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, TRANSLATION_STATUS_POLL_MS);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

async function monitorPromptTranslationUpdate(manager) {
    if (!manager || manager.monitoring || manager !== activeTranslationManager) return;
    manager.monitoring = true;
    const deadline = Date.now() + TRANSLATION_UPDATE_TIMEOUT_MS;
    try {
        while (Date.now() < deadline && manager === activeTranslationManager) {
            await promptTranslationPollDelay(manager.controller.signal);
            const status = await translationProvider.status("zh-CN", {
                signal: manager.controller.signal,
                force: true,
            });
            if (manager !== activeTranslationManager) return;
            manager.status = status;
            renderPromptTranslationManager(manager);
            if (!status?.updating) {
                dispatchAutocompleteSettingsChanged();
                return;
            }
        }
        if (manager === activeTranslationManager && manager.status?.updating) {
            manager.notice = {
                tone: "info",
                text: t("The update is still running in the background. Close this panel and check again later."),
            };
            renderPromptTranslationManager(manager);
        }
    } catch (error) {
        if (error?.name !== "AbortError" && manager === activeTranslationManager) {
            manager.notice = {
                tone: manager.status?.available ? "warning" : "error",
                text: error instanceof Error ? error.message : String(error),
            };
            renderPromptTranslationManager(manager);
        }
    } finally {
        manager.monitoring = false;
    }
}

async function loadPromptTranslationManagerStatus(manager) {
    try {
        const status = await translationProvider.status("zh-CN", {
            signal: manager.controller.signal,
            force: true,
        });
        if (manager !== activeTranslationManager) return;
        manager.status = status;
        renderPromptTranslationManager(manager);
        if (status?.updating || activeUpdateOperation) void monitorPromptTranslationUpdate(manager);
    } catch (error) {
        if (error?.name === "AbortError" || manager !== activeTranslationManager) return;
        manager.status = { available: false, ready: false, error: String(error?.message || error) };
        renderPromptTranslationManager(manager);
    }
}

function beginPromptTranslationUpdate() {
    if (activeUpdateOperation) return activeUpdateOperation;
    if (activeSupplementOperation) {
        return Promise.reject(new Error(t("A local database operation is already running.")));
    }
    translationProvider.invalidateStatus("zh-CN");
    activeUpdateOperation = translationProvider.update("zh-CN")
        .then((status) => {
            dispatchAutocompleteSettingsChanged();
            const state = translationManagerState(status);
            if (state.error) {
                showAutocompleteToast(
                    "warn",
                    t("Prompt translations updated with warnings"),
                    state.error,
                );
            } else {
                showAutocompleteToast(
                    "success",
                    t("Prompt translations updated"),
                    t("{translated} of {total} local tags have Chinese translations.", {
                        translated: formatNumber(state.translatedTagCount),
                        total: formatNumber(state.rowCount),
                    }),
                );
            }
            return status;
        })
        .catch(async (error) => {
            let fallbackStatus = null;
            try {
                fallbackStatus = await translationProvider.status("zh-CN", { force: true });
            } catch (_statusError) {
                // The original update error is more useful than a secondary status error.
            }
            if (error && typeof error === "object") {
                try {
                    error.fallbackStatus = fallbackStatus;
                } catch (_assignmentError) {
                    // Some browser error objects are non-extensible.
                }
            }
            showAutocompleteToast(
                fallbackStatus?.available ? "warn" : "error",
                t("Prompt translation update failed"),
                error instanceof Error ? error.message : String(error),
            );
            throw error;
        })
        .finally(() => {
            activeUpdateOperation = null;
        });
    return activeUpdateOperation;
}

function beginLocalSupplementOperation(operation, successTitle) {
    if (activeSupplementOperation) return activeSupplementOperation;
    if (activeUpdateOperation) {
        return Promise.reject(new Error(t("A prompt translation update is already running.")));
    }
    activeSupplementOperation = Promise.resolve()
        .then(operation)
        .then((status) => {
            dispatchAutocompleteSettingsChanged();
            showAutocompleteToast(
                "success",
                successTitle,
                t("{translated} of {total} local tags have Chinese translations.", {
                    translated: formatNumber(status?.translated_tag_count),
                    total: formatNumber(status?.row_count),
                }),
            );
            return status;
        })
        .catch((error) => {
            showAutocompleteToast(
                "error",
                t("Local tag.sqlite operation failed"),
                error instanceof Error ? error.message : String(error),
            );
            throw error;
        })
        .finally(() => {
            activeSupplementOperation = null;
            if (activeTranslationManager) {
                void loadPromptTranslationManagerStatus(activeTranslationManager);
            }
        });
    return activeSupplementOperation;
}

async function importLocalSupplement(manager, file) {
    if (!manager || !file || manager.busy || activeUpdateOperation || activeSupplementOperation) return;
    if (file.size <= 0 || file.size > MAX_LOCAL_SUPPLEMENT_BYTES) {
        manager.notice = {
            tone: "error",
            text: t("tag.sqlite must be larger than 0 bytes and no larger than 64 MiB."),
        };
        renderPromptTranslationManager(manager);
        return;
    }
    manager.busy = true;
    manager.notice = {
        tone: "info",
        text: t("Uploading and validating local tag.sqlite…"),
    };
    renderPromptTranslationManager(manager);
    try {
        const status = await beginLocalSupplementOperation(
            () => translationProvider.importSupplement(file),
            t("Local tag.sqlite imported"),
        );
        if (manager !== activeTranslationManager) return;
        manager.status = status;
        manager.notice = {
            tone: "info",
            text: t("The validated local database is now the active dictionary."),
        };
    } catch (error) {
        if (manager !== activeTranslationManager) return;
        manager.notice = {
            tone: "error",
            text: error instanceof Error ? error.message : String(error),
        };
    } finally {
        if (manager === activeTranslationManager) {
            manager.busy = false;
            renderPromptTranslationManager(manager);
        }
    }
}

async function rescanLocalSupplement(manager) {
    if (!manager || manager.busy || activeUpdateOperation || activeSupplementOperation) return;
    manager.busy = true;
    manager.notice = { tone: "info", text: t("Rescanning local tag.sqlite…") };
    renderPromptTranslationManager(manager);
    try {
        const status = await beginLocalSupplementOperation(
            () => translationProvider.rescanSupplement("zh-CN"),
            t("Local tag.sqlite rescanned"),
        );
        if (manager !== activeTranslationManager) return;
        manager.status = status;
        manager.notice = null;
    } catch (error) {
        if (manager !== activeTranslationManager) return;
        manager.notice = {
            tone: "error",
            text: error instanceof Error ? error.message : String(error),
        };
    } finally {
        if (manager === activeTranslationManager) {
            manager.busy = false;
            renderPromptTranslationManager(manager);
        }
    }
}

async function updatePromptTranslations(manager) {
    if (
        !manager
        || manager.busy
        || manager.status?.updating
        || activeUpdateOperation
        || activeSupplementOperation
    ) return;
    manager.busy = true;
    manager.notice = null;
    manager.status = { ...manager.status, updating: true };
    renderPromptTranslationManager(manager);
    try {
        const status = await beginPromptTranslationUpdate();
        if (manager !== activeTranslationManager) return;
        manager.status = status;
        manager.busy = false;
        renderPromptTranslationManager(manager);
    } catch (error) {
        if (manager !== activeTranslationManager) return;
        manager.busy = false;
        if (error?.fallbackStatus) {
            manager.status = error.fallbackStatus;
        } else {
            try {
                manager.status = await translationProvider.status("zh-CN", {
                    signal: manager.controller.signal,
                    force: true,
                });
            } catch (_statusError) {
                manager.status = {
                    ...manager.status,
                    updating: false,
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        }
        manager.notice = {
            tone: manager.status?.available ? "warning" : "error",
            text: manager.status?.updating
                ? t("The update is still running in the background. Close this panel and check again later.")
                : (error instanceof Error ? error.message : String(error)),
        };
        renderPromptTranslationManager(manager);
    }
}

function closePromptTranslationManager() {
    const manager = activeTranslationManager;
    if (!manager) return;
    activeTranslationManager = null;
    manager.controller.abort();
    window.removeEventListener("keydown", manager.onKeyDown, true);
    manager.overlay.remove();
    if (manager.opener?.isConnected) {
        requestAnimationFrame(() => manager.opener.focus({ preventScroll: true }));
    }
}

function refreshPromptTranslationManagerLocale(manager) {
    if (!manager || manager !== activeTranslationManager) return;
    manager.title.textContent = t("Prompt translations");
    renderPromptTranslationManager(manager);
}

function trapPromptTranslationFocus(manager, event) {
    if (event.key !== "Tab") return;
    const focusable = [...manager.dialog.querySelectorAll(
        "a[href], input:not([disabled]):not([hidden]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex='-1'])",
    )].filter((item) => !item.hidden && item.getClientRects().length > 0);
    if (!focusable.length) {
        event.preventDefault();
        manager.dialog.focus({ preventScroll: true });
        return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
    }
}

export function openPromptTranslationManager(opener = document.activeElement) {
    ensureTranslationStylesheet();
    if (activeTranslationManager) {
        activeTranslationManager.dialog.focus({ preventScroll: true });
        return activeTranslationManager;
    }

    const overlay = element("div", "cpw-translation-manager__overlay");
    const dialog = element("section", "cpw-translation-manager");
    dialog.tabIndex = -1;
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const header = element("header", "cpw-translation-manager__header");
    const title = element("h2", "cpw-translation-manager__title", t("Prompt translations"));
    title.id = `cpw-translation-manager-${createId()}`;
    dialog.setAttribute("aria-labelledby", title.id);
    const closeIcon = element("button", "cpw-translation-manager__close", "×");
    closeIcon.type = "button";
    closeIcon.setAttribute("aria-label", t("Close prompt translation manager"));
    header.append(title, closeIcon);

    const content = element("div", "cpw-translation-manager__content");
    content.append(element("div", "cpw-translation-manager__loading", t("Reading local translation status…")));
    const footer = element("footer", "cpw-translation-manager__footer");
    const closeButton = element("button", "cpw-translation-manager__button", t("Close"));
    const updateButton = element(
        "button",
        "cpw-translation-manager__button cpw-translation-manager__button--primary",
        t("Check and update"),
    );
    closeButton.type = "button";
    updateButton.type = "button";
    const fileInput = element("input", "cpw-translation-manager__file-input");
    fileInput.type = "file";
    fileInput.accept = ".sqlite,application/vnd.sqlite3,application/octet-stream";
    fileInput.hidden = true;
    footer.append(closeButton, updateButton);
    dialog.append(header, content, footer, fileInput);
    overlay.append(dialog);

    const manager = {
        overlay,
        dialog,
        title,
        closeIcon,
        content,
        closeButton,
        updateButton,
        fileInput,
        opener: opener?.focus ? opener : null,
        controller: new AbortController(),
        status: {},
        busy: false,
        monitoring: false,
        notice: null,
        onKeyDown: null,
    };
    manager.onKeyDown = (event) => {
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            const helpTooltip = dialog.querySelector(".cpw-tag-filter__tooltip:not([hidden])");
            if (helpTooltip) helpTooltip.hidden = true;
            else closePromptTranslationManager();
            return;
        }
        trapPromptTranslationFocus(manager, event);
    };
    closeIcon.addEventListener("click", closePromptTranslationManager);
    closeButton.addEventListener("click", closePromptTranslationManager);
    updateButton.addEventListener("click", () => void updatePromptTranslations(manager));
    fileInput.addEventListener("change", () => {
        const [file] = fileInput.files || [];
        fileInput.value = "";
        if (file) void importLocalSupplement(manager, file);
    });
    overlay.addEventListener("pointerdown", (event) => {
        if (event.target === overlay) closePromptTranslationManager();
    });
    for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu"]) {
        dialog.addEventListener(eventName, (event) => event.stopPropagation());
    }
    window.addEventListener("keydown", manager.onKeyDown, true);
    document.body.append(overlay);
    activeTranslationManager = manager;
    dialog.focus({ preventScroll: true });
    void loadPromptTranslationManagerStatus(manager);
    return manager;
}

function createTranslationManagerSettingButton() {
    ensureTranslationStylesheet();
    const button = element(
        "button",
        "cpw-translation-manager-setting-button",
        t("Manage prompt translations…"),
    );
    button.type = "button";
    button.dataset.cpwTranslationManagerButton = "true";
    button.addEventListener("click", () => openPromptTranslationManager(button));
    return button;
}

const AUTOCOMPLETE_SOURCE_DEFINITIONS = Object.freeze({
    "prompt-assistant": Object.freeze({
        settingId: PROMPT_ASSISTANT_SETTING_ID,
        label: "Prompt Assistant",
        description: "Uses tag CSV files exposed by an installed ComfyUI-Prompt-Assistant plugin.",
    }),
    danbooru: Object.freeze({
        settingId: DANBOORU_SETTING_ID,
        label: "Danbooru",
        description: "Uses the selected Danbooru SQLite dictionary. Typing stays local.",
    }),
});

function readBooleanAutocompleteSetting(settingId) {
    try {
        const value = app?.extensionManager?.setting?.get?.(settingId);
        return value === undefined || value === null ? true : Boolean(value);
    } catch (_error) {
        return true;
    }
}

async function writeAutocompleteSetting(settingId, value) {
    const currentSettings = app?.extensionManager?.setting;
    if (typeof currentSettings?.set === "function") {
        await currentSettings.set(settingId, value);
        return;
    }
    if (typeof app?.ui?.settings?.setSettingValue === "function") {
        await app.ui.settings.setSettingValue(settingId, value);
        return;
    }
    if (typeof api?.storeSetting === "function") {
        await api.storeSetting(settingId, value);
        return;
    }
    throw new Error(t("The ComfyUI settings service is unavailable."));
}

function sourceOrderFromControl(control) {
    return normalizeAutocompleteSourceOrder(
        [...control.querySelectorAll(".cpw-autocomplete-sources__row[data-source]")]
            .map((row) => row.dataset.source),
    );
}

function refreshAutocompleteSourceControlLocale(control) {
    control.setAttribute("aria-label", t("Prompt library sources"));
    for (const node of control.querySelectorAll("[data-cpw-i18n]")) {
        node.textContent = t(node.dataset.cpwI18n);
    }
    for (const handle of control.querySelectorAll(".cpw-autocomplete-sources__handle")) {
        const source = AUTOCOMPLETE_SOURCE_DEFINITIONS[handle.closest("[data-source]")?.dataset.source];
        if (!source) continue;
        handle.title = t("Drag to change the priority of {source}", { source: source.label });
        handle.setAttribute("aria-label", handle.title);
    }
    for (const input of control.querySelectorAll(".cpw-autocomplete-sources__switch-input[data-source]")) {
        const source = AUTOCOMPLETE_SOURCE_DEFINITIONS[input.dataset.source];
        if (source) input.setAttribute("aria-label", t("Enable {source} autocomplete", { source: source.label }));
    }
}

function createAutocompleteSourceOrderControl(_name, setter, storedValue) {
    ensureTranslationStylesheet();
    const initialOrder = normalizeAutocompleteSourceOrder(storedValue);
    const control = element("div", "cpw-autocomplete-sources");
    control.dataset.cpwAutocompleteSourceControl = "true";
    control.setAttribute("role", "list");
    control.setAttribute("aria-label", t("Prompt library sources"));
    const liveRegion = element("span", "cpw-autocomplete-sources__live");
    liveRegion.setAttribute("aria-live", "polite");
    control.append(liveRegion);

    const rows = new Map();
    let keyboardSession = null;
    let pointerSession = null;

    const announce = (message, values = {}) => {
        liveRegion.textContent = "";
        requestAnimationFrame(() => { liveRegion.textContent = t(message, values); });
    };

    const persistCurrentOrder = () => {
        const order = sourceOrderFromControl(control);
        setter(order);
        announce("Source priority updated. {source} is first.", {
            source: AUTOCOMPLETE_SOURCE_DEFINITIONS[order[0]]?.label || order[0],
        });
    };

    const clearKeyboardSession = ({ cancel = false } = {}) => {
        if (!keyboardSession) return;
        const { row, handle, originalOrder } = keyboardSession;
        if (cancel) {
            for (const source of originalOrder) control.append(rows.get(source));
        }
        row.classList.remove("cpw-autocomplete-sources__row--dragging");
        handle.setAttribute("aria-grabbed", "false");
        control.classList.remove("cpw-autocomplete-sources--dragging");
        keyboardSession = null;
        if (cancel) announce("Source priority change cancelled.");
        else persistCurrentOrder();
    };

    const beginKeyboardDrag = (row, handle) => {
        if (pointerSession) return;
        keyboardSession = {
            row,
            handle,
            originalOrder: sourceOrderFromControl(control),
        };
        row.classList.add("cpw-autocomplete-sources__row--dragging");
        handle.setAttribute("aria-grabbed", "true");
        control.classList.add("cpw-autocomplete-sources--dragging");
        announce("Picked up {source}. Use the arrow keys to change priority.", {
            source: AUTOCOMPLETE_SOURCE_DEFINITIONS[row.dataset.source]?.label || row.dataset.source,
        });
    };

    const moveKeyboardRow = (direction) => {
        if (!keyboardSession) return;
        const order = sourceOrderFromControl(control);
        const source = keyboardSession.row.dataset.source;
        const index = order.indexOf(source);
        const nextIndex = Math.max(0, Math.min(order.length - 1, index + direction));
        if (nextIndex === index) return;
        const other = rows.get(order[nextIndex]);
        if (direction < 0) control.insertBefore(keyboardSession.row, other);
        else control.insertBefore(keyboardSession.row, other.nextSibling);
        announce("{source} moved to priority {position}.", {
            source: AUTOCOMPLETE_SOURCE_DEFINITIONS[source]?.label || source,
            position: nextIndex + 1,
        });
    };

    const finishPointerDrag = (cancel = false) => {
        if (!pointerSession) return;
        const session = pointerSession;
        pointerSession = null;
        session.abort.abort();
        session.placeholder.replaceWith(session.row);
        if (cancel) {
            for (const source of session.originalOrder) control.append(rows.get(source));
        }
        session.row.classList.remove("cpw-autocomplete-sources__row--dragging");
        session.handle.setAttribute("aria-grabbed", "false");
        for (const property of ["position", "zIndex", "left", "top", "width", "height", "pointerEvents"]) {
            session.row.style[property] = "";
        }
        control.classList.remove("cpw-autocomplete-sources--dragging");
        if (cancel) announce("Source priority change cancelled.");
        else persistCurrentOrder();
    };

    const beginPointerDrag = (event, row, handle) => {
        if (event.button !== 0 || pointerSession) return;
        clearKeyboardSession({ cancel: true });
        event.preventDefault();
        const originalOrder = sourceOrderFromControl(control);
        const rect = row.getBoundingClientRect();
        const placeholder = element("div", "cpw-autocomplete-sources__placeholder");
        placeholder.style.height = `${rect.height}px`;
        placeholder.setAttribute("aria-hidden", "true");
        row.after(placeholder);
        document.body.append(row);
        row.classList.add("cpw-autocomplete-sources__row--dragging");
        control.classList.add("cpw-autocomplete-sources--dragging");
        handle.setAttribute("aria-grabbed", "true");
        Object.assign(row.style, {
            position: "fixed",
            zIndex: "100000",
            left: `${rect.left}px`,
            top: `${rect.top}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            pointerEvents: "none",
        });
        const abort = new AbortController();
        pointerSession = {
            row,
            handle,
            placeholder,
            originalOrder,
            pointerId: event.pointerId,
            grabOffsetY: event.clientY - rect.top,
            abort,
        };
        announce("Picked up {source}. Drag it above or below the other source.", {
            source: AUTOCOMPLETE_SOURCE_DEFINITIONS[row.dataset.source]?.label || row.dataset.source,
        });

        window.addEventListener("pointermove", (moveEvent) => {
            if (!pointerSession || moveEvent.pointerId !== pointerSession.pointerId) return;
            row.style.top = `${moveEvent.clientY - pointerSession.grabOffsetY}px`;
            const other = [...control.querySelectorAll(".cpw-autocomplete-sources__row[data-source]")][0];
            if (!other) return;
            const midpoint = other.getBoundingClientRect().top + other.getBoundingClientRect().height / 2;
            if (moveEvent.clientY < midpoint) control.insertBefore(placeholder, other);
            else control.insertBefore(placeholder, other.nextSibling);
        }, { signal: abort.signal });
        window.addEventListener("pointerup", (upEvent) => {
            if (pointerSession && upEvent.pointerId === pointerSession.pointerId) finishPointerDrag(false);
        }, {
            signal: abort.signal,
        });
        window.addEventListener("pointercancel", (cancelEvent) => {
            if (pointerSession && cancelEvent.pointerId === pointerSession.pointerId) finishPointerDrag(true);
        }, {
            signal: abort.signal,
        });
        window.addEventListener("blur", () => finishPointerDrag(true), {
            once: true,
            signal: abort.signal,
        });
    };

    for (const sourceId of initialOrder) {
        const source = AUTOCOMPLETE_SOURCE_DEFINITIONS[sourceId];
        const row = element("div", "cpw-autocomplete-sources__row");
        row.dataset.source = sourceId;
        row.setAttribute("role", "listitem");
        const handle = element("button", "cpw-autocomplete-sources__handle");
        handle.type = "button";
        handle.setAttribute("aria-grabbed", "false");
        handle.append(
            element("span", "cpw-autocomplete-sources__grip-dot"),
            element("span", "cpw-autocomplete-sources__grip-dot"),
            element("span", "cpw-autocomplete-sources__grip-dot"),
            element("span", "cpw-autocomplete-sources__grip-dot"),
            element("span", "cpw-autocomplete-sources__grip-dot"),
            element("span", "cpw-autocomplete-sources__grip-dot"),
        );
        handle.addEventListener("pointerdown", (event) => beginPointerDrag(event, row, handle));
        handle.addEventListener("keydown", (event) => {
            if (event.key === " " || event.key === "Enter") {
                event.preventDefault();
                if (keyboardSession?.row === row) clearKeyboardSession();
                else {
                    clearKeyboardSession({ cancel: true });
                    beginKeyboardDrag(row, handle);
                }
                return;
            }
            if (event.key === "Escape" && keyboardSession?.row === row) {
                event.preventDefault();
                clearKeyboardSession({ cancel: true });
                return;
            }
            if (keyboardSession?.row === row && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                event.preventDefault();
                moveKeyboardRow(event.key === "ArrowUp" ? -1 : 1);
            }
        });

        const copy = element("div", "cpw-autocomplete-sources__copy");
        const label = element("strong", "cpw-autocomplete-sources__label", source.label);
        const description = element("span", "cpw-autocomplete-sources__description");
        description.dataset.cpwI18n = source.description;
        copy.append(label, description);

        const switchLabel = element("label", "cpw-autocomplete-sources__switch");
        const switchInput = element("input", "cpw-autocomplete-sources__switch-input");
        switchInput.type = "checkbox";
        switchInput.dataset.source = sourceId;
        switchInput.checked = readBooleanAutocompleteSetting(source.settingId);
        switchInput.setAttribute("role", "switch");
        switchInput.setAttribute("aria-label", t("Enable {source} autocomplete", { source: source.label }));
        const switchTrack = element("span", "cpw-autocomplete-sources__switch-track");
        switchTrack.setAttribute("aria-hidden", "true");
        switchLabel.append(switchInput, switchTrack);
        row.classList.toggle("cpw-autocomplete-sources__row--disabled", !switchInput.checked);
        switchInput.addEventListener("change", async () => {
            const nextValue = switchInput.checked;
            switchInput.disabled = true;
            row.classList.toggle("cpw-autocomplete-sources__row--disabled", !nextValue);
            try {
                await writeAutocompleteSetting(source.settingId, nextValue);
                dispatchAutocompleteSettingsChanged();
            } catch (error) {
                switchInput.checked = !nextValue;
                row.classList.toggle("cpw-autocomplete-sources__row--disabled", nextValue);
                showAutocompleteToast(
                    "error",
                    t("Could not save autocomplete settings"),
                    error?.message || String(error),
                );
            } finally {
                switchInput.disabled = false;
            }
        });
        row.append(handle, copy, switchLabel);
        rows.set(sourceId, row);
        control.append(row);
    }

    refreshAutocompleteSourceControlLocale(control);
    if (JSON.stringify(storedValue) !== JSON.stringify(initialOrder)) {
        queueMicrotask(() => setter([...initialOrder]));
    }
    return control;
}

void connectPromptWeaverI18n(app, api);
subscribePromptWeaverLocale(() => {
    for (const button of document.querySelectorAll("[data-cpw-translation-manager-button]")) {
        button.textContent = t("Manage prompt translations…");
    }
    for (const control of document.querySelectorAll("[data-cpw-tag-filter]")) control.refresh();
    if (activeTranslationManager) refreshPromptTranslationManagerLocale(activeTranslationManager);
    for (const control of document.querySelectorAll("[data-cpw-autocomplete-source-control]")) {
        refreshAutocompleteSourceControlLocale(control);
    }
});

app.registerExtension({
    name: "ComfyUIPromptWeaver.TranslationSettings",
    settings: [
        {
            id: MIN_POST_COUNT_SETTING_ID,
            name: t("Minimum Danbooru post count"),
            tooltip: t("Lower values load more tags and use more resources."),
            category: ["Prompt Weaver", "Autocomplete", "Minimum Danbooru post count"],
            type: createMinPostCountControl,
            defaultValue: DEFAULT_MIN_POST_COUNT,
            onChange: dispatchAutocompleteSettingsChanged,
        },
        {
            id: AUTOCOMPLETE_SOURCE_ORDER_SETTING_ID,
            name: t("Prompt library sources"),
            tooltip: t("Drag sources to change their priority. Higher sources win equal-quality matches."),
            category: ["Prompt Weaver", "Autocomplete", "Prompt library sources"],
            type: createAutocompleteSourceOrderControl,
            defaultValue: [...DEFAULT_AUTOCOMPLETE_SOURCE_ORDER],
            onChange: dispatchAutocompleteSettingsChanged,
        },
        {
            id: AUTOCOMPLETE_LIMIT_SETTING_ID,
            name: t("Maximum autocomplete suggestions"),
            tooltip: t("Choose how many prompt suggestions can be shown (1–100)."),
            category: ["Prompt Weaver", "Autocomplete", "Maximum autocomplete suggestions"],
            type: "number",
            defaultValue: 30,
            attrs: {
                min: 1,
                max: 100,
                step: 1,
                showButtons: true,
                useGrouping: false,
            },
            onChange: dispatchAutocompleteSettingsChanged,
        },
        {
            id: TRANSLATION_MANAGER_SETTING_ID,
            name: t("Prompt translations"),
            tooltip: t("View local translation coverage and manually update the prompt dictionary."),
            category: ["Prompt Weaver", "Autocomplete", "Prompt translations"],
            type: createTranslationManagerSettingButton,
            defaultValue: "",
        },
    ],
    commands: [
        {
            id: TRANSLATION_MANAGER_COMMAND_ID,
            label: t("Manage prompt translations…"),
            function: () => openPromptTranslationManager(document.activeElement),
        },
    ],
    menuCommands: [
        {
            path: ["Prompt Weaver"],
            commands: [TRANSLATION_MANAGER_COMMAND_ID],
        },
    ],
});
