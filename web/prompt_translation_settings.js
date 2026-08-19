import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
    connectLocale,
    formatDateTime,
    getLocale,
    subscribeLocale,
    t,
} from "./prompt_weaver_i18n.js";
import {
    TRANSLATION_STATUS_POLL_MS,
    TRANSLATION_UPDATE_TIMEOUT_MS,
    shortBlobSha,
    translationManagerState,
} from "./prompt_translation_manager.js?v=20260817-settings-v2";

const TRANSLATION_MANAGER_SETTING_ID = "PromptWeaver.Autocomplete.TranslationManager";
const TRANSLATION_MANAGER_COMMAND_ID = "PromptWeaver.Autocomplete.UpdateDictionary";
const DANBOORU_SETTING_ID = "PromptWeaver.Autocomplete.Danbooru";
const PROMPT_ASSISTANT_SETTING_ID = "PromptWeaver.Autocomplete.PromptAssistant";
const AUTOCOMPLETE_SETTINGS_EVENT = "cpw-prompt-autocomplete-settings-changed";
const BASE_TAG_SOURCE_PAGE = "https://huggingface.co/datasets/newtextdoc1111/danbooru-tag-csv";
const PRIMARY_TRANSLATION_SOURCE_PAGE = "https://github.com/Aaalice233/ComfyUI-Danbooru-Gallery";

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

    status(locale = "zh-CN", { signal } = {}) {
        return this.fetchJson(
            `/prompt-weaver/tag-autocomplete/status?locale=${encodeURIComponent(locale)}`,
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
}

const translationProvider = new TranslationApiClient(api);

let activeTranslationManager = null;
let activeUpdateOperation = null;
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
        "./prompt_toggle_grid.css?v=20260817-translation-manager-v2",
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

function formatNumber(value) {
    return new Intl.NumberFormat(getLocale()).format(Number(value) || 0);
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
        warning: state.error || state.supplementError
            || t("The local dictionary remains usable, but part of the translation data needs attention."),
        ready: t("Local prompt translations are ready. Prompt text stays on this device."),
    };
    return { label: labels[state.summary], description: descriptions[state.summary] };
}

function renderPromptTranslationManager(manager) {
    if (!manager || manager !== activeTranslationManager) return;
    const state = translationManagerState(manager.status);
    manager.content.replaceChildren();

    const summary = translationManagerSummary(state);
    const summaryCard = element(
        "section",
        `cpw-translation-manager__summary cpw-translation-manager__summary--${state.tone}`,
    );
    const summaryHeader = element("div", "cpw-translation-manager__summary-header");
    const heading = element("div", "cpw-translation-manager__summary-heading");
    if (state.updating || manager.busy || activeUpdateOperation) {
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
    manager.content.append(summaryCard);

    const sources = element("section", "cpw-translation-manager__sources");
    sources.append(
        translationManagerSourceCard({
            title: t("English base dictionary"),
            description: t("Canonical Danbooru tags, categories, aliases, and usage counts."),
            statusText: state.available ? t("Installed") : t("Not installed"),
            tone: state.available ? "success" : "neutral",
            details: [
                [t("Tags"), formatNumber(state.rowCount)],
                [t("Version"), state.version || "—"],
                [t("License"), "MIT"],
            ],
            sourcePage: BASE_TAG_SOURCE_PAGE,
        }),
        translationManagerSourceCard({
            title: t("Primary Chinese translations"),
            description: t("The primary Simplified Chinese display and search translation layer."),
            statusText: state.primaryTranslationAvailable ? t("Installed") : t("Not installed"),
            tone: state.primaryTranslationAvailable ? "success" : "neutral",
            details: [
                [t("Translated tags"), formatNumber(state.primaryTranslationCount)],
                [t("License"), "MIT"],
            ],
            sourcePage: PRIMARY_TRANSLATION_SOURCE_PAGE,
        }),
    );

    const supplementLabels = {
        "license-pending": t("Awaiting license"),
        failed: t("Update failed"),
        available: t("Installed"),
        "available-local-use": t("Installed for local use"),
        "not-installed": t("Not installed"),
        "not-installed-local-use": t("Ready for local download"),
        disabled: t("Disabled"),
    };
    const supplementDescriptions = {
        "license-pending": t("This source has not declared a data license, so it is shown for transparency but cannot be enabled or downloaded."),
        failed: state.supplementError,
        available: t("Only fills base-dictionary tags still missing from the primary translation layer."),
        "available-local-use": t("Downloaded from the user-selected source for local missing-translation completion; the source has not declared a data license."),
        "not-installed": t("This approved supplement will be downloaded during the next manual update."),
        "not-installed-local-use": t("The next manual update downloads tag.sqlite from the user-selected source and applies it only to missing local translations."),
        disabled: t("The optional missing-translation supplement is disabled by the source manifest."),
    };
    sources.append(translationManagerSourceCard({
        title: t("Missing-translation supplement"),
        description: supplementDescriptions[state.supplementState],
        statusText: supplementLabels[state.supplementState],
        tone: state.supplementTone,
        details: [
            [t("Added translations"), formatNumber(state.supplementTranslationCount)],
            [t("Blob SHA"), shortBlobSha(state.supplementBlobSha) || "—"],
            [t("Updated"), translationManagerDate(state.supplementLastUpdatedAt)],
        ],
        sourcePage: state.supplementSourcePage,
    }));
    manager.content.append(sources);

    if (manager.notice?.text) {
        manager.content.append(element(
            "div",
            `cpw-translation-manager__notice cpw-translation-manager__notice--${manager.notice.tone || "info"}`,
            manager.notice.text,
        ));
    }

    const updateInProgress = state.updating || manager.busy || Boolean(activeUpdateOperation);
    manager.updateButton.disabled = updateInProgress;
    manager.updateButton.textContent = updateInProgress
        ? t("Updating…")
        : (state.action === "download"
            ? t("Download dictionary and translations")
            : t("Check and update"));
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
    translationProvider.invalidateStatus("zh-CN");
    activeUpdateOperation = translationProvider.update("zh-CN")
        .then((status) => {
            dispatchAutocompleteSettingsChanged();
            const state = translationManagerState(status);
            if (state.error || state.supplementError) {
                showAutocompleteToast(
                    "warn",
                    t("Prompt translations updated with warnings"),
                    state.error || state.supplementError,
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

async function updatePromptTranslations(manager) {
    if (!manager || manager.busy || manager.status?.updating || activeUpdateOperation) return;
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
        "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])",
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
    footer.append(closeButton, updateButton);
    dialog.append(header, content, footer);
    overlay.append(dialog);

    const manager = {
        overlay,
        dialog,
        title,
        closeIcon,
        content,
        closeButton,
        updateButton,
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
            closePromptTranslationManager();
            return;
        }
        trapPromptTranslationFocus(manager, event);
    };
    closeIcon.addEventListener("click", closePromptTranslationManager);
    closeButton.addEventListener("click", closePromptTranslationManager);
    updateButton.addEventListener("click", () => void updatePromptTranslations(manager));
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

connectLocale(app);
subscribeLocale(() => {
    for (const button of document.querySelectorAll("[data-cpw-translation-manager-button]")) {
        button.textContent = t("Manage prompt translations…");
    }
    if (activeTranslationManager) refreshPromptTranslationManagerLocale(activeTranslationManager);
});

app.registerExtension({
    name: "ComfyUIPromptWeaver.TranslationSettings",
    settings: [
        {
            id: DANBOORU_SETTING_ID,
            name: t("Enable Danbooru tag autocomplete"),
            tooltip: t("Uses the Prompt-Weaver local Danbooru CSV dictionary. Typing stays local."),
            category: ["Prompt Weaver", "Autocomplete", "Danbooru"],
            type: "boolean",
            defaultValue: true,
            onChange: dispatchAutocompleteSettingsChanged,
        },
        {
            id: PROMPT_ASSISTANT_SETTING_ID,
            name: t("Enable Prompt Assistant autocomplete"),
            tooltip: t("Uses tag CSV files exposed by an installed ComfyUI-Prompt-Assistant plugin."),
            category: ["Prompt Weaver", "Autocomplete", "Prompt Assistant"],
            type: "boolean",
            defaultValue: true,
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
