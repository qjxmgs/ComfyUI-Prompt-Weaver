import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
    DEFAULT_ARCHIVE_ID,
    DEFAULT_ARCHIVE_NAME,
    PROMPT_GRID_ITEM_COLORS,
    PromptGridArchiveClient,
    applyArchiveManagerSelectionGesture,
    archiveManagerSelectionAvailability,
    buildArchiveExportBundle,
    canQuickSaveArchive,
    canRestoreArchive,
    configFromArchiveSnapshot,
    defaultArchiveName,
    formatArchiveOptionLabel,
    localizePristineDefaultSnapshot,
    normalizeArchiveNodeSize,
    normalizeArchiveManagerSelection,
    normalizePromptCardFavoriteId,
    normalizePromptGridItemColor,
    resolveArchiveInitialization,
    resolveArchiveStatus,
    snapshotFromState,
    validateImportBundlePreview,
} from "./prompt_grid_archives.js?v=20260830-prompt-card-library-v1";
import {
    getPromptCardLibraryService,
    favoriteCardBilingualPrompt,
    openPromptCardFavoriteCascade,
    openPromptCardLibraryMenu,
    promptCardFavoriteSnapshot,
    replacePromptGridItemWithFavorite,
} from "./prompt_card_library.js?v=20260901-card-context-actions-v1";
import {
    connectLocale,
    formatDateTime,
    formatList,
    getLocale,
    subscribeLocale,
    syncLocale,
    t,
    tp,
} from "./prompt_weaver_i18n.js?v=20260901-card-context-actions-v1";
import {
    confirmPromptEditorDraft,
    dedupePromptTokens,
    mergePromptTokenInput,
    promptSelectionFromFreeText,
    promptTokenStatesForStorage,
    reconcilePromptTokenStates,
    removePromptToken,
    setAllPromptTokenSelection,
    splitPromptTokens,
    togglePromptTokenOnce,
} from "./prompt_editor_tokens.js?v=20260830-retain-unselected-v1";
import {
    clampPromptEditorPosition,
    countActivePromptTokens,
    normalizePromptEditorFontSize,
    normalizePromptEditorSize,
} from "./prompt_editor_window.js?v=20260814-min-width-600";
import { PromptEditorHistory } from "./prompt_editor_history.js?v=20260830-editor-history-v1";
import {
    AUTOCOMPLETE_LIMIT_SETTING_ID,
    AUTOCOMPLETE_SOURCE_ORDER_SETTING_ID,
    AUTOCOMPLETE_SETTINGS_EVENT,
    DEFAULT_AUTOCOMPLETE_LIMIT,
    DANBOORU_SETTING_ID,
    PROMPT_ASSISTANT_SETTING_ID,
    PromptAutocompleteController,
    PromptTagAutocompleteProvider,
    applyPromptCompletion,
    autocompleteTranslationText,
    normalizeAutocompleteLimit,
    normalizeAutocompleteSourceOrder,
    promptTokenHasHanText,
    promptTokenLookupText,
    textareaCaretClientRect,
} from "./prompt_tag_autocomplete.js?v=20260825-source-order-v1";
import {
    calculateFittedNodeHeight,
    clientPointToContent,
    clientRectToContent,
    computeInsertionIndex,
    edgeScrollVelocity,
    findDropTarget,
    movePromptGridItemToEdge,
    resolveImmediateInsertionSide,
} from "./prompt_grid_reorder.js?v=20260812-item-context-menu";

const WIDGET_TYPE = "PROMPT_WEAVER_PROMPT_GRID";
const CONFIG_VERSION = 1;
const DEFAULT_COLUMNS = 2;
const DEFAULT_CARD_COUNT = 4;
const MIN_COLUMNS = 1;
const MAX_COLUMNS = 6;
const DEFAULT_NODE_SIZE = [600, 420];
const NODE_CHROME_HEIGHT = 94;
const MIN_WIDGET_HEIGHT = 160;
const MIN_NODE_HEIGHT = MIN_WIDGET_HEIGHT + NODE_CHROME_HEIGHT;
const HEIGHT_FIT_TOLERANCE = 2;
const GRID_GAP = 8;
const EDGE_SCROLL_ZONE = 24;
const EDGE_SCROLL_MAX_SPEED = 12;
const REORDER_ANIMATION_DURATION = 120;
const ARCHIVE_ROW_GAP = 7;
const ARCHIVE_EDGE_SCROLL_ZONE = 32;
const ARCHIVE_EDGE_SCROLL_MAX_SPEED = 12;
const ARCHIVE_SYNC_EVENT = "cpw-prompt-grid-archives-changed";
const ARCHIVE_CHANNEL_NAME = "prompt-weaver-prompt-grid-archives";
const MAX_ARCHIVE_IMPORT_BYTES = 2 * 1024 * 1024;
const ARCHIVE_PROPERTY_KEY = "prompt_weaver_archive_id";
const PROMPT_EDITOR_SIZE_STORAGE_KEY = "prompt-weaver-prompt-editor-size-v1";
const PROMPT_EDITOR_FONT_SIZE_STORAGE_KEY = "prompt-weaver-prompt-editor-font-size-v1";
const PROMPT_EDITOR_VIEWPORT_MARGIN = 16;
const PROMPT_EDITOR_MIN_WIDTH = 600;
const PROMPT_EDITOR_MIN_HEIGHT = 240;
const PROMPT_EDITOR_DEFAULT_FONT_SIZE = 15;
const PROMPT_EDITOR_MIN_FONT_SIZE = 12;
const PROMPT_EDITOR_MAX_FONT_SIZE = 30;
const PROMPT_TOKEN_GESTURE_SAMPLE_STEP = 6;

async function copyTextToClipboard(value) {
    const text = typeof value === "string" ? value : String(value ?? "");
    let clipboardError = null;
    try {
        if (globalThis.navigator?.clipboard?.writeText) {
            await globalThis.navigator.clipboard.writeText(text);
            return;
        }
    } catch (error) {
        clipboardError = error;
    }

    const temporary = document.createElement("textarea");
    temporary.value = text;
    temporary.setAttribute("readonly", "");
    temporary.style.position = "fixed";
    temporary.style.left = "-9999px";
    temporary.style.opacity = "0";
    document.body.append(temporary);
    temporary.select();
    temporary.setSelectionRange(0, temporary.value.length);
    const copied = document.execCommand?.("copy") === true;
    temporary.remove();
    if (!copied) {
        throw clipboardError ?? new Error("Clipboard copy is unavailable");
    }
}

const archiveClient = new PromptGridArchiveClient(api);
const readAutocompleteSettingValue = (settingId) => {
    try {
        return app?.extensionManager?.setting?.get?.(settingId);
    } catch (_error) {
        return undefined;
    }
};
const readAutocompleteSetting = (settingId) => {
    const value = readAutocompleteSettingValue(settingId);
    return value === undefined || value === null ? true : Boolean(value);
};
const readAutocompleteLimit = () => normalizeAutocompleteLimit(
    readAutocompleteSettingValue(AUTOCOMPLETE_LIMIT_SETTING_ID),
    DEFAULT_AUTOCOMPLETE_LIMIT,
);
const readAutocompleteSourceOrder = () => normalizeAutocompleteSourceOrder(
    readAutocompleteSettingValue(AUTOCOMPLETE_SOURCE_ORDER_SETTING_ID),
);
const promptTagAutocompleteProvider = new PromptTagAutocompleteProvider(api, {
    danbooruEnabled: () => readAutocompleteSetting(DANBOORU_SETTING_ID),
    promptAssistantEnabled: () => readAutocompleteSetting(PROMPT_ASSISTANT_SETTING_ID),
    sourceOrder: readAutocompleteSourceOrder,
    onDiagnostic(message, error) {
        console.warn(`[Prompt Weaver] ${message}`, error || "");
    },
});
const loadedPromptGridNodes = new WeakSet();
const promptGridArchiveControllers = new WeakMap();
const promptGridLocaleControllers = new Set();
const archiveChannel = typeof BroadcastChannel === "function"
    ? new BroadcastChannel(ARCHIVE_CHANNEL_NAME)
    : null;

function dispatchAutocompleteSettingsChanged() {
    globalThis.dispatchEvent(new CustomEvent(AUTOCOMPLETE_SETTINGS_EVENT));
}

globalThis.addEventListener(AUTOCOMPLETE_SETTINGS_EVENT, () => {
    promptTagAutocompleteProvider.danbooru.invalidateStatus();
    promptTagAutocompleteProvider.translationCache.clear();
});

function dispatchArchiveSync() {
    window.dispatchEvent(new CustomEvent(ARCHIVE_SYNC_EVENT));
}

function publishArchiveSync() {
    dispatchArchiveSync();
    archiveChannel?.postMessage({ type: "archives-changed" });
}

if (archiveChannel) {
    archiveChannel.addEventListener("message", (event) => {
        if (event.data?.type === "archives-changed") dispatchArchiveSync();
    });
}

let fallbackId = 0;

connectLocale(app);
subscribeLocale(() => {
    for (const controller of [...promptGridLocaleControllers]) controller.refreshLocale?.();
});

function createId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    fallbackId += 1;
    return `prompt-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
}

async function resolveFavoriteCardPromptTip(card, { signal } = {}) {
    const tokens = splitPromptTokens(card?.prompt);
    const translations = tokens.slice();
    const pending = [];
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (promptTokenHasHanText(token)) continue;
        const lookupText = promptTokenLookupText(token);
        if (lookupText) pending.push({ index, lookupText });
    }
    if (pending.length) {
        const records = await promptTagAutocompleteProvider.resolveTagTranslations(
            pending.map((entry) => entry.lookupText),
            "zh-CN",
            { signal },
        );
        for (let resultIndex = 0; resultIndex < pending.length; resultIndex += 1) {
            const translation = autocompleteTranslationText(records[resultIndex]);
            if (translation !== "—") translations[pending[resultIndex].index] = translation;
        }
    }
    return favoriteCardBilingualPrompt(card, translations);
}

function cardTitle(index) {
    return t("Card {index}", { index: String(index).padStart(2, "0") });
}

function createDefaultConfig() {
    return {
        version: CONFIG_VERSION,
        columns: DEFAULT_COLUMNS,
        items: Array.from({ length: DEFAULT_CARD_COUNT }, (_, index) => ({
            id: `prompt-${index + 1}`,
            enabled: true,
            title: cardTitle(index + 1),
            prompt: "",
        })),
    };
}

function configError(message) {
    return new Error(t("Prompt grid configuration error: {message}", { message }));
}

function normalizeConfigValue(value) {
    if (value === undefined) {
        const state = createDefaultConfig();
        return { state, serialized: JSON.stringify(state) };
    }
    if (typeof value === "string" && !value.trim()) {
        return {
            state: { version: CONFIG_VERSION, columns: DEFAULT_COLUMNS, items: [] },
            serialized: value,
        };
    }

    let raw = value;
    if (typeof raw === "string") {
        try {
            raw = JSON.parse(raw);
        } catch (error) {
            throw configError(t("JSON could not be parsed ({message})", { message: error.message }));
        }
    }

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw configError(t("The top-level value must be an object"));
    }

    const hasVersion = Object.prototype.hasOwnProperty.call(raw, "version");
    const version = hasVersion ? raw.version : CONFIG_VERSION;
    if (typeof version !== "number" || !Number.isFinite(version) || version !== CONFIG_VERSION) {
        throw configError(t("Unsupported version {version}", { version: String(version) }));
    }
    if (!Array.isArray(raw.items)) throw configError(t("items must be an array"));

    const columns = Number.isInteger(raw.columns)
        && raw.columns >= MIN_COLUMNS
        && raw.columns <= MAX_COLUMNS
        ? raw.columns
        : DEFAULT_COLUMNS;
    let normalized = columns !== raw.columns;
    const usedIds = new Set();
    const items = raw.items.map((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw configError(t("items[{index}] must be an object", { index }));
        }
        const hasEnabled = Object.prototype.hasOwnProperty.call(item, "enabled");
        if (hasEnabled && typeof item.enabled !== "boolean") {
            throw configError(t("items[{index}].enabled must be a boolean", { index }));
        }
        const hasPrompt = Object.prototype.hasOwnProperty.call(item, "prompt");
        if (hasPrompt && typeof item.prompt !== "string") {
            throw configError(t("items[{index}].prompt must be a string", { index }));
        }
        const hasRetainUnselected = Object.prototype.hasOwnProperty.call(item, "retain_unselected");
        if (hasRetainUnselected && typeof item.retain_unselected !== "boolean") {
            throw configError(t("items[{index}].retain_unselected must be a boolean", { index }));
        }
        const hasPromptTokens = Object.prototype.hasOwnProperty.call(item, "prompt_tokens");
        if (hasPromptTokens && !Array.isArray(item.prompt_tokens)) {
            throw configError(t("items[{index}].prompt_tokens must be an array", { index }));
        }
        if (hasPromptTokens) {
            for (let tokenIndex = 0; tokenIndex < item.prompt_tokens.length; tokenIndex += 1) {
                const entry = item.prompt_tokens[tokenIndex];
                if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                    throw configError(t(
                        "items[{index}].prompt_tokens[{tokenIndex}] must be an object",
                        { index, tokenIndex },
                    ));
                }
                if (typeof entry.text !== "string" || !entry.text.trim()) {
                    throw configError(t(
                        "items[{index}].prompt_tokens[{tokenIndex}].text must be a non-empty string",
                        { index, tokenIndex },
                    ));
                }
                if (typeof entry.selected !== "boolean") {
                    throw configError(t(
                        "items[{index}].prompt_tokens[{tokenIndex}].selected must be a boolean",
                        { index, tokenIndex },
                    ));
                }
            }
        }

        if (Object.prototype.hasOwnProperty.call(item, "id") && typeof item.id !== "string") {
            throw configError(t("items[{index}].id must be a string", { index }));
        }
        if (Object.prototype.hasOwnProperty.call(item, "title") && typeof item.title !== "string") {
            throw configError(t("items[{index}].title must be a string", { index }));
        }
        const hasFavoriteId = Object.prototype.hasOwnProperty.call(item, "favorite_id");
        const favoriteId = normalizePromptCardFavoriteId(item.favorite_id);
        if (hasFavoriteId && !favoriteId) {
            throw configError(t("items[{index}].favorite_id must be a UUID string", { index }));
        }
        if (hasFavoriteId && favoriteId !== item.favorite_id) normalized = true;

        let id = typeof item.id === "string" && item.id.trim() ? item.id : createId();
        if (usedIds.has(id)) throw configError(t("items[{index}].id duplicates another card", { index }));
        if (id !== item.id) normalized = true;
        usedIds.add(id);
        const hasColor = Object.prototype.hasOwnProperty.call(item, "color");
        const color = normalizePromptGridItemColor(item.color);
        if (hasColor && !color) normalized = true;
        const {
            color: _discardedColor,
            favorite_id: _discardedFavoriteId,
            retain_unselected: _discardedRetainUnselected,
            prompt_tokens: _discardedPromptTokens,
            ...itemWithoutEditorState
        } = item;
        const prompt = hasPrompt ? item.prompt : "";
        const retainUnselected = hasRetainUnselected ? item.retain_unselected : true;
        const reconciledTokenState = hasPromptTokens
            ? reconcilePromptTokenStates(prompt, item.prompt_tokens)
            : null;
        const normalizedTokenStates = reconciledTokenState
            ? promptTokenStatesForStorage(
                reconciledTokenState.tokens,
                reconciledTokenState.selected,
            )
            : null;
        if (
            hasPromptTokens
            && JSON.stringify(normalizedTokenStates ?? []) !== JSON.stringify(item.prompt_tokens)
        ) normalized = true;
        if (hasRetainUnselected && retainUnselected) normalized = true;
        if (!retainUnselected && normalizedTokenStates) normalized = true;
        return {
            ...itemWithoutEditorState,
            id,
            enabled: hasEnabled ? item.enabled : false,
            title: typeof item.title === "string"
                ? item.title
                : cardTitle(index + 1),
            prompt,
            ...(color ? { color } : {}),
            ...(favoriteId ? { favorite_id: favoriteId } : {}),
            ...(!retainUnselected ? { retain_unselected: false } : {}),
            ...(retainUnselected && normalizedTokenStates
                ? { prompt_tokens: normalizedTokenStates }
                : {}),
        };
    });
    const state = { ...raw, version: CONFIG_VERSION, columns, items };
    const serialized = typeof value === "string" && !normalized
        ? value
        : JSON.stringify(state);
    return { state, serialized };
}

function element(tagName, className, text) {
    const result = document.createElement(tagName);
    if (className) result.className = className;
    if (text != null) result.textContent = text;
    return result;
}

function promptEditorViewportMetrics() {
    return {
        viewportWidth: document.documentElement.clientWidth || window.innerWidth,
        viewportHeight: document.documentElement.clientHeight || window.innerHeight,
        margin: PROMPT_EDITOR_VIEWPORT_MARGIN,
        minWidth: PROMPT_EDITOR_MIN_WIDTH,
        minHeight: PROMPT_EDITOR_MIN_HEIGHT,
    };
}

function readPromptEditorSize() {
    try {
        const value = globalThis.localStorage?.getItem(PROMPT_EDITOR_SIZE_STORAGE_KEY);
        return value ? JSON.parse(value) : null;
    } catch {
        return null;
    }
}

function persistPromptEditorSize(value) {
    try {
        globalThis.localStorage?.setItem(
            PROMPT_EDITOR_SIZE_STORAGE_KEY,
            JSON.stringify({
                width: Math.round(value.width),
                height: Math.round(value.height),
            }),
        );
    } catch {
        // The editor remains usable when browser storage is unavailable.
    }
}

function normalizeStoredPromptEditorFontSize(value) {
    return normalizePromptEditorFontSize(value, {
        minimum: PROMPT_EDITOR_MIN_FONT_SIZE,
        maximum: PROMPT_EDITOR_MAX_FONT_SIZE,
        fallback: PROMPT_EDITOR_DEFAULT_FONT_SIZE,
    });
}

function readPromptEditorFontSize() {
    try {
        return normalizeStoredPromptEditorFontSize(
            globalThis.localStorage?.getItem(PROMPT_EDITOR_FONT_SIZE_STORAGE_KEY),
        );
    } catch {
        return PROMPT_EDITOR_DEFAULT_FONT_SIZE;
    }
}

function persistPromptEditorFontSize(value) {
    try {
        globalThis.localStorage?.setItem(
            PROMPT_EDITOR_FONT_SIZE_STORAGE_KEY,
            String(normalizeStoredPromptEditorFontSize(value)),
        );
    } catch {
        // The editor remains usable when browser storage is unavailable.
    }
}

let activePromptGridSelect = null;

function createCustomSelect(extraClass, ariaLabel) {
    const control = element(
        "div",
        `cpw-prompt-grid__select-control${extraClass ? ` ${extraClass}` : ""}`,
    );
    const trigger = element("button", "cpw-prompt-grid__select");
    trigger.type = "button";
    trigger.setAttribute("role", "combobox");
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-label", ariaLabel);
    const valueLabel = element("span", "cpw-prompt-grid__select-value");
    const chevron = element("span", "cpw-prompt-grid__select-chevron");
    chevron.setAttribute("aria-hidden", "true");
    trigger.append(valueLabel, chevron);
    control.append(trigger);

    const menu = element("div", "cpw-prompt-grid__select-menu");
    const menuId = `cpw-prompt-grid-select-${createId()}`;
    menu.id = menuId;
    menu.setAttribute("role", "listbox");
    trigger.setAttribute("aria-controls", menuId);

    let options = [];
    let currentValue = "";
    let disabled = false;
    let opened = false;
    let destroyed = false;

    function selectedIndex() {
        return options.findIndex((option) => option.value === currentValue);
    }

    function syncSelection() {
        const selected = options[selectedIndex()];
        valueLabel.textContent = selected?.label ?? "";
        trigger.title = selected?.label ?? ariaLabel;
        for (const optionButton of menu.children) {
            const isSelected = optionButton.dataset.value === currentValue;
            optionButton.classList.toggle("cpw-prompt-grid__select-option--selected", isSelected);
            optionButton.setAttribute("aria-selected", String(isSelected));
        }
    }

    function positionMenu() {
        if (!opened || !trigger.isConnected) return;
        const rect = trigger.getBoundingClientRect();
        const width = Math.max(rect.width, 64);
        menu.style.width = `${width}px`;
        const left = Math.min(Math.max(4, rect.left), Math.max(4, window.innerWidth - width - 4));
        menu.style.left = `${left}px`;
        const menuHeight = menu.offsetHeight;
        const below = window.innerHeight - rect.bottom;
        const top = below >= Math.min(menuHeight, 240) || rect.top < below
            ? rect.bottom + 2
            : Math.max(4, rect.top - menuHeight - 2);
        menu.style.top = `${top}px`;
    }

    function close({ restoreFocus = false } = {}) {
        if (!opened) return;
        opened = false;
        if (activePromptGridSelect === api) activePromptGridSelect = null;
        trigger.setAttribute("aria-expanded", "false");
        control.classList.remove("cpw-prompt-grid__select-control--open");
        menu.remove();
        document.removeEventListener("pointerdown", onDocumentPointerDown, true);
        document.removeEventListener("keydown", onDocumentKeyDown, true);
        window.removeEventListener("resize", positionMenu);
        window.removeEventListener("scroll", positionMenu, true);
        if (restoreFocus && trigger.isConnected) trigger.focus();
    }

    function focusOption(index) {
        const buttons = [...menu.querySelectorAll(".cpw-prompt-grid__select-option")];
        if (!buttons.length) return;
        buttons[Math.min(buttons.length - 1, Math.max(0, index))].focus();
    }

    function onDocumentPointerDown(event) {
        if (!control.contains(event.target) && !menu.contains(event.target)) close();
    }

    function onDocumentKeyDown(event) {
        if (!opened) return;
        if (event.key === "Escape") {
            event.preventDefault();
            close({ restoreFocus: true });
            return;
        }
        if (event.key === "Tab") {
            close();
            return;
        }
        const buttons = [...menu.querySelectorAll(".cpw-prompt-grid__select-option")];
        const focusedIndex = buttons.indexOf(document.activeElement);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const direction = event.key === "ArrowDown" ? 1 : -1;
            const fallback = selectedIndex() >= 0 ? selectedIndex() : 0;
            const next = focusedIndex >= 0 ? focusedIndex + direction : fallback;
            focusOption(next);
        } else if (event.key === "Home") {
            event.preventDefault();
            focusOption(0);
        } else if (event.key === "End") {
            event.preventDefault();
            focusOption(buttons.length - 1);
        }
    }

    function choose(value) {
        const changed = currentValue !== value;
        currentValue = value;
        syncSelection();
        close();
        if (changed) control.dispatchEvent(new Event("change"));
        trigger.focus();
    }

    function renderOptions() {
        const optionButtons = options.map((option) => {
            const button = element("button", "cpw-prompt-grid__select-option", option.label);
            button.type = "button";
            button.dataset.value = option.value;
            button.setAttribute("role", "option");
            button.addEventListener("click", () => choose(option.value));
            return button;
        });
        menu.replaceChildren(...optionButtons);
        syncSelection();
    }

    function open() {
        if (destroyed || disabled || !options.length || opened) return;
        activePromptGridSelect?.close();
        activePromptGridSelect = api;
        opened = true;
        trigger.setAttribute("aria-expanded", "true");
        control.classList.add("cpw-prompt-grid__select-control--open");
        renderOptions();
        document.body.append(menu);
        positionMenu();
        document.addEventListener("pointerdown", onDocumentPointerDown, true);
        document.addEventListener("keydown", onDocumentKeyDown, true);
        window.addEventListener("resize", positionMenu);
        window.addEventListener("scroll", positionMenu, true);
        queueMicrotask(() => focusOption(selectedIndex() >= 0 ? selectedIndex() : 0));
    }

    trigger.addEventListener("click", () => {
        if (opened) close({ restoreFocus: true });
        else open();
    });
    trigger.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        open();
    });
    for (const eventName of ["pointerdown", "pointerup", "click", "keydown", "keyup"]) {
        menu.addEventListener(eventName, (event) => event.stopPropagation());
    }
    menu.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });

    const api = {
        root: control,
        close,
        destroy() {
            destroyed = true;
            close();
            menu.remove();
        },
        setOptions(nextOptions) {
            options = nextOptions.map((option) => ({
                value: String(option.value),
                label: String(option.label),
            }));
            if (!options.some((option) => option.value === currentValue)) {
                currentValue = options.find((option) => option.value === "")?.value ?? options[0]?.value ?? "";
            }
            renderOptions();
            if (opened) positionMenu();
        },
    };
    Object.defineProperties(control, {
        value: {
            get: () => currentValue,
            set: (value) => {
                const requested = String(value ?? "");
                currentValue = options.some((option) => option.value === requested)
                    ? requested
                    : options.find((option) => option.value === "")?.value ?? "";
                syncSelection();
            },
        },
        disabled: {
            get: () => disabled,
            set: (value) => {
                disabled = Boolean(value);
                trigger.disabled = disabled;
                control.classList.toggle("cpw-prompt-grid__select-control--disabled", disabled);
                if (disabled) close();
            },
        },
    });
    control.customSelect = api;
    return control;
}

function ensureStylesheet() {
    const id = "cpw-prompt-toggle-grid-styles";
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = new URL("./prompt_toggle_grid.css?v=20260901-card-context-actions-v1", import.meta.url).href;
    document.head.append(link);
}

function captureCanvasState() {
    app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.captureCanvasState?.();
}

function notifyWidgetChanged(node, widget, inputName, nextValue, previousValue, captureHistory) {
    widget?.callback?.(nextValue);
    node.onWidgetChanged?.(inputName, nextValue, previousValue, widget);
    const graph = node.graph ?? app.graph;
    graph?.incrementVersion?.();
    graph?.change?.();
    app.canvas?.setDirty?.(true, true);
    if (captureHistory) captureCanvasState();
}

function archiveDisplayName(archive) {
    if (archive?.is_default || archive?.id === DEFAULT_ARCHIVE_ID) return t("Default Archive");
    return archive?.name || t("Current Archive");
}

function archiveErrorMessage(error) {
    const messages = {
        400: "Archive data is invalid.",
        404: "The requested archive was not found.",
        409: "An archive with the same name already exists.",
        413: "The archive request is too large.",
        500: "The archive store could not be read.",
    };
    if (error?.status >= 500 && error?.serverMessage) {
        console.warn("[Prompt Weaver] Archive server error:", error.serverMessage);
    }
    return messages[error?.status]
        ? t(messages[error.status])
        : (error instanceof Error ? error.message : String(error));
}

function createPromptGridWidget(node, inputName, inputData) {
    syncLocale(app);
    ensureStylesheet();
    const promptCardLibraryService = getPromptCardLibraryService(api);

    const root = element("div", "cpw-prompt-grid");
    const toolbar = element("div", "cpw-prompt-grid__toolbar");
    const columnGroup = element("div", "cpw-prompt-grid__columns");
    const columnLabel = element("span", "", t("Columns"));
    columnGroup.append(columnLabel);
    const columnSelect = createCustomSelect("", t("Grid columns"));
    columnSelect.customSelect.setOptions(
        Array.from({ length: MAX_COLUMNS - MIN_COLUMNS + 1 }, (_, index) => {
            const columns = MIN_COLUMNS + index;
            return { value: String(columns), label: String(columns) };
        }),
    );
    columnGroup.append(columnSelect);

    const archiveGroup = element("div", "cpw-prompt-grid__archives");
    const archiveSelect = createCustomSelect(
        "cpw-prompt-grid__archive-select",
        t("Quickly switch prompt archives"),
    );
    const quickSaveArchiveButton = element(
        "button",
        "cpw-prompt-grid__button cpw-prompt-grid__archive-action cpw-prompt-grid__archive-save",
    );
    quickSaveArchiveButton.append(element(
        "span",
        "cpw-prompt-grid__archive-action-icon cpw-prompt-grid__archive-action-icon--save",
    ));
    const restoreArchiveButton = element(
        "button",
        "cpw-prompt-grid__button cpw-prompt-grid__archive-action cpw-prompt-grid__archive-restore",
    );
    restoreArchiveButton.append(element(
        "span",
        "cpw-prompt-grid__archive-action-icon cpw-prompt-grid__archive-action-icon--restore",
    ));
    const manageArchivesButton = element(
        "button",
        "cpw-prompt-grid__button cpw-prompt-grid__archive-action cpw-prompt-grid__archive-manage",
    );
    manageArchivesButton.append(element(
        "span",
        "cpw-prompt-grid__archive-action-icon cpw-prompt-grid__archive-action-icon--manage",
    ));
    quickSaveArchiveButton.type = "button";
    restoreArchiveButton.type = "button";
    manageArchivesButton.type = "button";
    const setArchiveActionLabel = (button, label) => {
        button.dataset.tooltip = label;
        button.setAttribute("aria-label", label);
    };
    setArchiveActionLabel(quickSaveArchiveButton, t("Save"));
    setArchiveActionLabel(restoreArchiveButton, t("Restore"));
    setArchiveActionLabel(manageArchivesButton, t("Archive Manager"));
    archiveGroup.append(
        archiveSelect,
        quickSaveArchiveButton,
        restoreArchiveButton,
        manageArchivesButton,
    );

    const actions = element("div", "cpw-prompt-grid__actions");
    const addButton = element(
        "button",
        "cpw-prompt-grid__button cpw-prompt-grid__button--primary",
        t("+ Add Card"),
    );
    const enableAllButton = element("button", "cpw-prompt-grid__button", t("Enable All"));
    const disableAllButton = element("button", "cpw-prompt-grid__button", t("Disable All"));
    for (const button of [addButton, enableAllButton, disableAllButton]) button.type = "button";
    actions.append(addButton, enableAllButton, disableAllButton);
    toolbar.append(columnGroup, archiveGroup, actions);

    const errorPanel = element("div", "cpw-prompt-grid__error");
    errorPanel.hidden = true;
    const errorTitle = element("strong", "", t("Configuration could not be read"));
    const errorMessage = element("div", "cpw-prompt-grid__error-message");
    const resetButton = element("button", "cpw-prompt-grid__button", t("Reset to Default"));
    resetButton.type = "button";
    errorPanel.append(errorTitle, errorMessage, resetButton);

    const scroll = element("div", "cpw-prompt-grid__scroll");
    const grid = element("div", "cpw-prompt-grid__cards");
    scroll.append(grid);
    root.append(toolbar, errorPanel, scroll);

    let state;
    let serializedValue = "";
    let parseError = null;
    let dragSession = null;
    let dragFrame = 0;
    let activePromptEditor = null;
    let activePromptCardLibraryMenu = null;
    let activeItemContextMenu = null;
    let activeArchiveManager = null;
    let activeArchiveConfirmation = null;
    let archives = [];
    let activeArchiveId = DEFAULT_ARCHIVE_ID;
    let archiveDirty = false;
    let lastSelectedArchiveId = DEFAULT_ARCHIVE_ID;
    let archiveAssociationInitialized = false;
    let receivedExternalValue = false;
    let editedBeforeArchiveInitialization = false;
    let loadedAssociationReconciled = false;
    let archivesLoading = false;
    let archiveQuickSaveBusy = false;
    let archivesRefreshPending = false;
    let heightFitFrame = 0;
    let sizeReconcileFrame = 0;
    let disposed = false;
    let widget;
    const cardElements = new Map();
    const cardAutocompleteControllers = new Set();
    const reorderAnimations = new WeakMap();
    const archiveReorderAnimations = new WeakMap();
    const pendingFavoriteRefreshItems = new Set();
    const favoriteRefreshTimers = new Map();
    promptCardLibraryService.refresh().catch((error) => {
        console.warn("[Prompt Weaver] Could not load favorite cards", error);
    });

    function refreshLocale() {
        if (disposed) return;
        syncLocale(app);
        columnLabel.textContent = t("Columns");
        columnSelect.querySelector("button")?.setAttribute("aria-label", t("Grid columns"));
        archiveSelect.querySelector("button")?.setAttribute(
            "aria-label",
            t("Quickly switch prompt archives"),
        );
        setArchiveActionLabel(quickSaveArchiveButton, t("Save"));
        setArchiveActionLabel(restoreArchiveButton, t("Restore"));
        setArchiveActionLabel(manageArchivesButton, t("Archive Manager"));
        addButton.textContent = t("+ Add Card");
        enableAllButton.textContent = t("Enable All");
        disableAllButton.textContent = t("Disable All");
        errorTitle.textContent = t("Configuration could not be read");
        resetButton.textContent = t("Reset to Default");
        for (const card of root.querySelectorAll(".cpw-prompt-grid__card")) {
            card.querySelector(".cpw-prompt-grid__switch input")?.setAttribute(
                "aria-label",
                t("Enable this prompt"),
            );
            const titleInput = card.querySelector(".cpw-prompt-grid__title");
            if (titleInput) {
                titleInput.placeholder = t("Prompt title");
                titleInput.setAttribute("aria-label", t("Prompt title"));
            }
            const promptInput = card.querySelector(".cpw-prompt-grid__prompt");
            if (promptInput) {
                promptInput.placeholder = t("Enter a prompt…");
                promptInput.setAttribute("aria-label", t("Prompt content"));
            }
            const editButton = card.querySelector(".cpw-prompt-grid__prompt-edit");
            if (editButton) {
                editButton.title = t("Split and select prompts");
                editButton.setAttribute("aria-label", t("Open the prompt tag editor"));
            }
        }
        for (const button of root.querySelectorAll(".cpw-prompt-grid__favorite-switch")) {
            const label = t("Switch this card to a favorite");
            button.title = label;
            button.setAttribute("aria-label", label);
        }
        activePromptEditor?.refreshLocale?.();
        renderArchiveSelect();
        activeArchiveManager?.refreshLocale?.();
        if (!activePromptEditor && !activeArchiveManager && !activeArchiveConfirmation) render();
    }

    function readValue(value) {
        try {
            const normalized = normalizeConfigValue(value);
            state = normalized.state;
            serializedValue = normalized.serialized;
            parseError = null;
        } catch (error) {
            state = null;
            serializedValue = typeof value === "string" ? value : JSON.stringify(value);
            parseError = error instanceof Error ? error.message : String(error);
        }
    }

    function commit(renderAfter = false, captureHistory = true) {
        if (!state || disposed) return;
        if (!archiveAssociationInitialized) editedBeforeArchiveInitialization = true;
        const previousValue = serializedValue;
        serializedValue = JSON.stringify(state);
        parseError = null;
        if (renderAfter) render();
        notifyWidgetChanged(node, widget, inputName, serializedValue, previousValue, captureHistory);
        reconcileArchiveSelection();
    }

    function currentSnapshot() {
        return state ? snapshotFromState(state, node.size) : null;
    }

    function persistedArchiveId() {
        const value = node.properties?.[ARCHIVE_PROPERTY_KEY];
        return typeof value === "string" && value ? value : null;
    }

    function persistNodeArchiveId(archiveId) {
        node.properties ??= {};
        node.properties[ARCHIVE_PROPERTY_KEY] = archiveId;
    }

    function notifyArchiveAssociationChanged(captureHistory = false) {
        const graph = node.graph ?? app.graph;
        graph?.incrementVersion?.();
        graph?.change?.();
        app.canvas?.setDirty?.(true, true);
        if (captureHistory) captureCanvasState();
    }

    async function persistGlobalArchiveId(archiveId) {
        lastSelectedArchiveId = archiveId;
        try {
            await archiveClient.select(archiveId);
            publishArchiveSync();
        } catch (error) {
            console.warn(`[Prompt Weaver] ${t("Could not save the last selected archive")}`, error);
            setArchiveManagerMessage(archiveErrorMessage(error), true);
        }
    }

    function setActiveArchive(
        archiveId,
        { persistGlobal = false, notifyGraph = false, captureHistory = false } = {},
    ) {
        const nextArchiveId = archiveId || DEFAULT_ARCHIVE_ID;
        const changed = activeArchiveId !== nextArchiveId
            || persistedArchiveId() !== nextArchiveId;
        activeArchiveId = nextArchiveId;
        persistNodeArchiveId(activeArchiveId);
        if (changed && notifyGraph) notifyArchiveAssociationChanged(captureHistory);
        if (persistGlobal) void persistGlobalArchiveId(activeArchiveId);
    }

    function scheduleNodeHeightFit() {
        if (disposed || parseError || !state) return;
        if (heightFitFrame) cancelAnimationFrame(heightFitFrame);
        heightFitFrame = requestAnimationFrame(() => {
            heightFitFrame = 0;
            if (disposed || parseError || !state || dragSession || !scroll.isConnected) return;
            const styles = getComputedStyle(scroll);
            const paddingTop = Number.parseFloat(styles.paddingTop) || 0;
            const paddingBottom = Number.parseFloat(styles.paddingBottom) || 0;
            const currentHeight = node.size?.[1] ?? DEFAULT_NODE_SIZE[1];
            const nextHeight = calculateFittedNodeHeight(
                currentHeight,
                scroll.clientHeight,
                grid.offsetHeight,
                paddingTop,
                paddingBottom,
                MIN_NODE_HEIGHT,
                HEIGHT_FIT_TOLERANCE,
            );
            if (currentHeight - nextHeight <= HEIGHT_FIT_TOLERANCE) return;
            node.setSize([node.size?.[0] ?? DEFAULT_NODE_SIZE[0], nextHeight]);
            app.canvas?.setDirty?.(true, true);
        });
    }

    function scheduleArchiveSizeReconcile() {
        if (disposed || !archiveAssociationInitialized || !state) return;
        if (sizeReconcileFrame) cancelAnimationFrame(sizeReconcileFrame);
        sizeReconcileFrame = requestAnimationFrame(() => {
            sizeReconcileFrame = 0;
            if (!disposed && archiveAssociationInitialized && state) reconcileArchiveSelection();
        });
    }

    function applyArchiveNodeSize(snapshot) {
        const size = normalizeArchiveNodeSize(snapshot?.node_size);
        const currentWidth = Math.round(node.size?.[0] ?? DEFAULT_NODE_SIZE[0]);
        const currentHeight = Math.round(node.size?.[1] ?? DEFAULT_NODE_SIZE[1]);
        if (heightFitFrame) {
            cancelAnimationFrame(heightFitFrame);
            heightFitFrame = 0;
        }
        if (currentWidth === size.width && currentHeight === size.height) return;
        node.setSize([size.width, size.height]);
        app.canvas?.setDirty?.(true, true);
    }

    function showArchiveToast(severity, summary, detail) {
        const toast = app.extensionManager?.toast;
        if (typeof toast?.add !== "function") return;
        toast.add({ severity, summary, detail, life: 3000 });
    }

    function renderQuickArchiveSaveButton() {
        const archive = archives.find((candidate) => candidate.id === activeArchiveId) ?? null;
        const archiveName = archiveDisplayName(archive);
        const enabled = canQuickSaveArchive(archive, {
            dirty: archiveDirty,
            hasState: Boolean(state),
            loading: archivesLoading,
            saving: archiveQuickSaveBusy,
        });
        quickSaveArchiveButton.disabled = !enabled;
        quickSaveArchiveButton.classList.toggle("cpw-prompt-grid__archive-save--ready", enabled);
        quickSaveArchiveButton.setAttribute("aria-busy", String(archiveQuickSaveBusy));
        if (archiveQuickSaveBusy) {
            quickSaveArchiveButton.setAttribute("aria-description", t("Saving \"{name}\"…", { name: archiveName }));
        } else if (!archive) {
            quickSaveArchiveButton.setAttribute("aria-description", t("There is no associated archive to save"));
        } else if (!archiveDirty) {
            quickSaveArchiveButton.setAttribute("aria-description", t("\"{name}\" has no changes to save", { name: archiveName }));
        } else {
            quickSaveArchiveButton.setAttribute("aria-description", t("Save current changes to \"{name}\"", { name: archiveName }));
        }
    }

    function renderRestoreArchiveButton() {
        const archive = archives.find((candidate) => candidate.id === activeArchiveId) ?? null;
        const archiveName = archiveDisplayName(archive);
        const enabled = canRestoreArchive(archive, {
            dirty: archiveDirty,
            hasState: Boolean(state),
            loading: archivesLoading,
            saving: archiveQuickSaveBusy,
        });
        restoreArchiveButton.disabled = !enabled;
        if (archiveQuickSaveBusy) {
            restoreArchiveButton.setAttribute("aria-description", t("Finish saving before restoring an archive"));
        } else if (!archive) {
            restoreArchiveButton.setAttribute("aria-description", t("There is no associated archive to restore"));
        } else if (!archiveDirty) {
            restoreArchiveButton.setAttribute("aria-description", t("\"{name}\" has no changes to restore", { name: archiveName }));
        } else {
            restoreArchiveButton.setAttribute("aria-description", t("Discard current changes and restore \"{name}\"", {
                name: archiveName,
            }));
        }
    }

    function renderArchiveSelect() {
        const visibleArchives = archives.length
            ? archives
            : [{
                id: DEFAULT_ARCHIVE_ID,
                name: DEFAULT_ARCHIVE_NAME,
                snapshot: snapshotFromState(createDefaultConfig(), DEFAULT_NODE_SIZE),
                is_default: true,
            }];
        archiveSelect.customSelect.setOptions(
            visibleArchives.map((archive) => ({
                value: archive.id,
                label: formatArchiveOptionLabel(
                    archiveDisplayName(archive),
                    archive.id === activeArchiveId && archiveDirty,
                ),
            })),
        );
        archiveSelect.value = activeArchiveId || DEFAULT_ARCHIVE_ID;
        archiveSelect.disabled = !state || archiveQuickSaveBusy;
        manageArchivesButton.disabled = archiveQuickSaveBusy;
        renderQuickArchiveSaveButton();
        renderRestoreArchiveButton();
    }

    async function quickSaveActiveArchive() {
        const archive = archives.find((candidate) => candidate.id === activeArchiveId) ?? null;
        if (!canQuickSaveArchive(archive, {
            dirty: archiveDirty,
            hasState: Boolean(state),
            loading: archivesLoading,
            saving: archiveQuickSaveBusy,
        })) return;

        const snapshot = currentSnapshot();
        archiveQuickSaveBusy = true;
        renderArchiveSelect();
        try {
            const result = await archiveClient.update(archive.id, { snapshot });
            const savedArchive = result?.archive;
            if (savedArchive) {
                archives = archives.map((candidate) => (
                    candidate.id === savedArchive.id ? savedArchive : candidate
                ));
            } else {
                await refreshArchives();
            }
            reconcileArchiveSelection();
            renderArchiveManagerList();
            publishArchiveSync();
            showArchiveToast(
                "success",
                t("Archive Saved"),
                t("Saved to \"{name}\".", { name: archiveDisplayName(archive) }),
            );
        } catch (error) {
            const message = archiveErrorMessage(error);
            console.error(`[Prompt Weaver] ${t("Quick archive save failed")}`, error);
            showArchiveToast("error", t("Archive Save Failed"), message);
            quickSaveArchiveButton.setAttribute("aria-description", t("Save failed: {message}", { message }));
        } finally {
            archiveQuickSaveBusy = false;
            reconcileArchiveSelection();
        }
    }

    function reconcileArchiveSelection() {
        if (!state) {
            archiveDirty = false;
            renderArchiveSelect();
            return;
        }
        const statusArchives = archives.length
            ? archives
            : [{
                id: DEFAULT_ARCHIVE_ID,
                snapshot: snapshotFromState(createDefaultConfig(), DEFAULT_NODE_SIZE),
            }];
        const previousArchiveId = activeArchiveId;
        const status = resolveArchiveStatus(statusArchives, currentSnapshot(), activeArchiveId);
        activeArchiveId = status.activeArchiveId;
        archiveDirty = status.dirty;
        if (archiveAssociationInitialized) {
            persistNodeArchiveId(activeArchiveId);
            if (previousArchiveId !== activeArchiveId) notifyArchiveAssociationChanged(false);
        }
        renderArchiveSelect();
    }

    function initializeArchiveAssociation() {
        if (archiveAssociationInitialized || !state || !archives.length) return;
        const savedArchiveId = persistedArchiveId();
        const isNewNode = !savedArchiveId
            && !receivedExternalValue
            && !loadedPromptGridNodes.has(node)
            && !editedBeforeArchiveInitialization;
        const initialization = resolveArchiveInitialization(
            archives,
            currentSnapshot(),
            {
                persistedArchiveId: savedArchiveId,
                lastSelectedArchiveId,
                isNewNode,
            },
        );
        archiveAssociationInitialized = true;
        setActiveArchive(initialization.activeArchiveId);
        const target = archives.find((archive) => archive.id === initialization.activeArchiveId);
        if (initialization.loadSnapshot && target && !editedBeforeArchiveInitialization) {
            loadArchive(target, { captureHistory: false, persistGlobal: false });
        } else {
            reconcileArchiveSelection();
        }
    }

    function reconcileLoadedArchiveAssociation() {
        if (loadedAssociationReconciled
            || !receivedExternalValue
            || !archiveAssociationInitialized
            || !state
            || !archives.length) return;
        archiveAssociationInitialized = false;
        initializeArchiveAssociation();
        loadedAssociationReconciled = true;
    }

    function setArchiveManagerMessage(message, error = false) {
        if (!activeArchiveManager) return;
        activeArchiveManager.message.textContent = message || "";
        activeArchiveManager.message.classList.toggle("cpw-archive-manager__message--error", error);
        activeArchiveManager.message.hidden = !message;
    }

    async function refreshArchives({ reportError = false } = {}) {
        if (disposed) return false;
        if (activeArchiveManager?.dragSession) {
            archivesRefreshPending = true;
            return false;
        }
        if (archivesLoading) {
            archivesRefreshPending = true;
            return false;
        }
        archivesLoading = true;
        renderArchiveSelect();
        try {
            const payload = await archiveClient.list();
            if (disposed) return false;
            archives = [...(payload?.archives ?? [])];
            lastSelectedArchiveId = typeof payload?.last_selected_archive_id === "string"
                ? payload.last_selected_archive_id
                : DEFAULT_ARCHIVE_ID;
            initializeArchiveAssociation();
            if (archiveAssociationInitialized) reconcileArchiveSelection();
            renderArchiveManagerList();
            return true;
        } catch (error) {
            if (reportError) setArchiveManagerMessage(archiveErrorMessage(error), true);
            return false;
        } finally {
            archivesLoading = false;
            if (!disposed) renderArchiveSelect();
            if (!disposed && archivesRefreshPending) {
                archivesRefreshPending = false;
                queueMicrotask(() => refreshArchives({ reportError }));
            }
        }
    }

    function closeArchiveConfirmation(result = false) {
        if (!activeArchiveConfirmation) return;
        const confirmation = activeArchiveConfirmation;
        activeArchiveConfirmation = null;
        document.removeEventListener("keydown", confirmation.onKeyDown, true);
        confirmation.overlay.remove();
        confirmation.resolve(result);
    }

    function askArchiveConfirmation({ title, message, confirmText = t("Confirm"), danger = false }) {
        if (activeArchiveConfirmation) closeArchiveConfirmation(false);
        return new Promise((resolve) => {
            const overlay = element("div", "cpw-archive-confirm__overlay");
            const dialog = element("section", "cpw-archive-confirm");
            dialog.setAttribute("role", "alertdialog");
            dialog.setAttribute("aria-modal", "true");
            const heading = element("h3", "cpw-archive-confirm__title", title);
            const body = element("p", "cpw-archive-confirm__message", message);
            const actionsRow = element("div", "cpw-archive-confirm__actions");
            const cancelButton = element("button", "cpw-archive-manager__button", t("Cancel"));
            const confirmButton = element(
                "button",
                `cpw-archive-manager__button ${danger ? "cpw-archive-manager__button--danger" : "cpw-archive-manager__button--primary"}`,
                confirmText,
            );
            cancelButton.type = "button";
            confirmButton.type = "button";
            actionsRow.append(cancelButton, confirmButton);
            dialog.append(heading, body, actionsRow);
            overlay.append(dialog);
            const onKeyDown = (event) => {
                if (event.key === "Escape") {
                    event.preventDefault();
                    closeArchiveConfirmation(false);
                }
            };
            activeArchiveConfirmation = { overlay, onKeyDown, resolve };
            overlay.addEventListener("pointerdown", (event) => {
                if (event.target === overlay) closeArchiveConfirmation(false);
            });
            cancelButton.addEventListener("click", () => closeArchiveConfirmation(false));
            confirmButton.addEventListener("click", () => closeArchiveConfirmation(true));
            document.addEventListener("keydown", onKeyDown, true);
            document.body.append(overlay);
            queueMicrotask(() => confirmButton.focus());
        });
    }

    function closeArchiveManager() {
        if (!activeArchiveManager) return;
        if (activeArchiveManager.dragSession) cancelArchiveReorder();
        const manager = activeArchiveManager;
        activeArchiveManager = null;
        document.removeEventListener("keydown", manager.onKeyDown, true);
        manager.overlay.remove();
        manageArchivesButton.focus();
    }

    function loadArchive(archive, { captureHistory = true, persistGlobal = true } = {}) {
        if (!archive || disposed) return;
        const snapshot = archive.id === DEFAULT_ARCHIVE_ID || archive.is_default
            ? localizePristineDefaultSnapshot(
                archive.snapshot,
                (index) => cardTitle(index),
            )
            : archive.snapshot;
        const normalized = normalizeConfigValue(JSON.stringify(configFromArchiveSnapshot(snapshot)));
        state = normalized.state;
        parseError = null;
        setActiveArchive(archive.id, { persistGlobal });
        commit(true, false);
        applyArchiveNodeSize(archive.snapshot);
        reconcileArchiveSelection();
        if (captureHistory) captureCanvasState();
    }

    function restoreActiveArchive() {
        const archive = archives.find((candidate) => candidate.id === activeArchiveId) ?? null;
        if (!canRestoreArchive(archive, {
            dirty: archiveDirty,
            hasState: Boolean(state),
            loading: archivesLoading,
            saving: archiveQuickSaveBusy,
        })) return;
        loadArchive(archive);
        showArchiveToast(
            "success",
            t("Archive Restored"),
            t("Restored \"{name}\".", { name: archiveDisplayName(archive) }),
        );
    }

    async function requestArchiveLoad(archive) {
        if (!archive || (archive.id === activeArchiveId && !archiveDirty)) return false;
        if (archiveDirty) {
            const proceed = await askArchiveConfirmation({
                title: t("Discard current changes?"),
                message: t("Loading \"{name}\" will completely replace the current grid state.", {
                    name: archiveDisplayName(archive),
                }),
                confirmText: t("Discard and Load"),
                danger: true,
            });
            if (!proceed) {
                renderArchiveSelect();
                return false;
            }
        }
        closeArchiveManager();
        loadArchive(archive);
        return true;
    }

    function formatArchiveTime(value) {
        return formatDateTime(value);
    }

    function downloadArchiveBundle(selectedArchives, filename) {
        const bundle = buildArchiveExportBundle(selectedArchives);
        const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const anchor = element("a", "");
        anchor.href = url;
        anchor.download = filename.replace(/[\\/:*?"<>|]+/g, "-");
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    async function importArchiveFile(file) {
        if (!file) return;
        if (file.size > MAX_ARCHIVE_IMPORT_BYTES) {
            setArchiveManagerMessage(t("The import file cannot exceed 2 MB."), true);
            return;
        }
        try {
            const bundle = JSON.parse(await file.text());
            const preview = validateImportBundlePreview(bundle);
            const policy = await askImportPolicy(preview);
            if (!policy) return;
            setArchiveManagerMessage(t("Importing…"));
            const result = await archiveClient.import(bundle, policy);
            await refreshArchives({ reportError: true });
            publishArchiveSync();
            setArchiveManagerMessage(
                t("Import complete: {imported} added, {overwritten} overwritten, {skipped} skipped, {renamed} automatically renamed.", {
                    imported: result.imported ?? 0,
                    overwritten: result.overwritten ?? 0,
                    skipped: result.skipped ?? 0,
                    renamed: result.renamed ?? 0,
                }),
            );
        } catch (error) {
            setArchiveManagerMessage(archiveErrorMessage(error), true);
        }
    }

    function askImportPolicy(preview) {
        if (activeArchiveConfirmation) closeArchiveConfirmation(false);
        return new Promise((resolve) => {
            const overlay = element("div", "cpw-archive-confirm__overlay");
            const dialog = element("section", "cpw-archive-confirm");
            dialog.setAttribute("role", "dialog");
            dialog.setAttribute("aria-modal", "true");
            const heading = element("h3", "cpw-archive-confirm__title", t("Import Archives"));
            const summary = element(
                "p",
                "cpw-archive-confirm__message",
                t("The file contains {archives} archives and {items} prompt cards. Choose how to handle name conflicts.", {
                    archives: preview.archiveCount,
                    items: preview.itemCount,
                }),
            );
            const policy = element("select", "cpw-archive-manager__input");
            for (const [value, label] of [
                ["skip", t("Skip (Recommended)")],
                ["overwrite", t("Overwrite Local Archives")],
                ["rename", t("Automatically Rename")],
            ]) {
                const option = element("option", "", label);
                option.value = value;
                policy.append(option);
            }
            const actionsRow = element("div", "cpw-archive-confirm__actions");
            const cancelButton = element("button", "cpw-archive-manager__button", t("Cancel"));
            const confirmButton = element(
                "button",
                "cpw-archive-manager__button cpw-archive-manager__button--primary",
                t("Start Import"),
            );
            actionsRow.append(cancelButton, confirmButton);
            dialog.append(heading, summary, policy, actionsRow);
            overlay.append(dialog);
            const onKeyDown = (event) => {
                if (event.key === "Escape") {
                    event.preventDefault();
                    closeArchiveConfirmation(null);
                }
            };
            activeArchiveConfirmation = {
                overlay,
                onKeyDown,
                resolve: (result) => resolve(typeof result === "string" ? result : null),
            };
            overlay.addEventListener("pointerdown", (event) => {
                if (event.target === overlay) closeArchiveConfirmation(null);
            });
            cancelButton.addEventListener("click", () => closeArchiveConfirmation(null));
            confirmButton.addEventListener("click", () => closeArchiveConfirmation(policy.value));
            document.addEventListener("keydown", onKeyDown, true);
            document.body.append(overlay);
            queueMicrotask(() => policy.focus());
        });
    }

    function setArchiveManagerBusy(busy) {
        if (!activeArchiveManager) return;
        activeArchiveManager.busy = busy;
        for (const control of activeArchiveManager.dialog.querySelectorAll("button, input, select")) {
            control.disabled = busy;
        }
        renderArchiveManagerActions();
    }

    async function runArchiveMutation(operation, successMessage) {
        if (!activeArchiveManager || activeArchiveManager.busy) return null;
        setArchiveManagerBusy(true);
        setArchiveManagerMessage(t("Saving…"));
        try {
            const result = await operation();
            await refreshArchives({ reportError: true });
            publishArchiveSync();
            setArchiveManagerMessage(successMessage);
            return result;
        } catch (error) {
            setArchiveManagerMessage(archiveErrorMessage(error), true);
            return null;
        } finally {
            setArchiveManagerBusy(false);
            renderArchiveManagerList();
        }
    }

    async function saveCurrentArchive() {
        if (!state || !activeArchiveManager) return;
        const name = activeArchiveManager.nameInput.value.trim();
        if (!name) {
            setArchiveManagerMessage(t("Enter an archive name."), true);
            activeArchiveManager.nameInput.focus();
            return;
        }
        const existing = archives.find((archive) => archive.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase());
        let result;
        if (existing) {
            const overwrite = await askArchiveConfirmation({
                title: t("Save to an archive with the same name?"),
                message: t("\"{name}\" already exists. Save the current grid state to it and replace its contents?", {
                    name: archiveDisplayName(existing),
                }),
                confirmText: t("Save"),
                danger: true,
            });
            if (!overwrite) return;
            result = await runArchiveMutation(
                () => archiveClient.update(existing.id, { snapshot: currentSnapshot() }),
                t("Saved to \"{name}\".", { name: archiveDisplayName(existing) }),
            );
        } else {
            result = await runArchiveMutation(
                () => archiveClient.create(name, currentSnapshot()),
                t("Saved \"{name}\".", { name }),
            );
        }
        const saved = result?.archive;
        if (saved) {
            if (activeArchiveManager) {
                activeArchiveManager.selectedArchiveIds = new Set([saved.id]);
                activeArchiveManager.selectionAnchorId = saved.id;
            }
            setActiveArchive(saved.id, {
                persistGlobal: true,
                notifyGraph: true,
                captureHistory: true,
            });
            reconcileArchiveSelection();
            if (activeArchiveManager) {
                activeArchiveManager.nameInput.value = defaultArchiveName();
                renderArchiveManagerList();
            }
        }
    }

    function regularArchiveIds() {
        return archives
            .filter((archive) => !archive.is_default && archive.id !== DEFAULT_ARCHIVE_ID)
            .map((archive) => archive.id);
    }

    function applyRegularArchiveOrder(archiveIds) {
        const defaults = archives.filter(
            (archive) => archive.is_default || archive.id === DEFAULT_ARCHIVE_ID,
        );
        const regularById = new Map(
            archives
                .filter((archive) => !archive.is_default && archive.id !== DEFAULT_ARCHIVE_ID)
                .map((archive) => [archive.id, archive]),
        );
        archives = [
            ...defaults,
            ...archiveIds.map((archiveId) => regularById.get(archiveId)).filter(Boolean),
        ];
        renderArchiveSelect();
    }

    function archiveManagerRows(manager) {
        const rowsById = new Map(
            [...manager.list.querySelectorAll(".cpw-archive-manager__row[data-archive-id]")]
                .map((row) => [row.dataset.archiveId, row]),
        );
        return archives.map((archive) => rowsById.get(archive.id)).filter(Boolean);
    }

    function applyArchiveVisualOrder(manager) {
        const rows = archiveManagerRows(manager);
        // Keep the captured handle connected to the DOM. Moving the row with
        // insertBefore/append would fire lostpointercapture and cancel sorting.
        for (let index = 0; index < rows.length; index += 1) {
            rows[index].style.order = String(index);
        }
    }

    function cacheArchiveLayoutRects(manager, session, clientRects = null) {
        const viewportRect = manager.list.getBoundingClientRect();
        const layoutRects = new Map();
        for (const row of archiveManagerRows(manager)) {
            const rect = clientRects?.get(row) ?? row.getBoundingClientRect();
            layoutRects.set(row.dataset.archiveId, clientRectToContent(
                rect,
                viewportRect,
                1,
                1,
                manager.list.scrollLeft,
                manager.list.scrollTop,
            ));
        }
        session.layoutRects = layoutRects;
    }

    function cloneArchiveRowForDrag(row) {
        const clone = row.cloneNode(true);
        clone.classList.remove(
            "cpw-archive-manager__row--drag-source",
            "cpw-archive-manager__row--drop-target",
            "cpw-archive-manager__row--insert-before",
            "cpw-archive-manager__row--insert-after",
        );
        clone.classList.add("cpw-archive-manager__drag-ghost");
        clone.removeAttribute("data-archive-id");
        clone.removeAttribute("data-archive-default");
        clone.setAttribute("aria-hidden", "true");
        return clone;
    }

    function updateArchiveDragGhost(session) {
        const left = session.clientX - session.pointerOffsetX;
        const top = session.clientY - session.pointerOffsetY;
        session.ghost.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    }

    function clearArchiveDropIndicators(manager) {
        for (const row of archiveManagerRows(manager)) {
            row.classList.remove(
                "cpw-archive-manager__row--drop-target",
                "cpw-archive-manager__row--insert-before",
                "cpw-archive-manager__row--insert-after",
            );
        }
        if (manager.dragSession) {
            manager.dragSession.renderedTargetId = null;
            manager.dragSession.renderedSide = null;
        }
    }

    function renderArchiveDropIndicator(manager, targetId, side) {
        const session = manager.dragSession;
        if (session?.renderedTargetId === targetId && session?.renderedSide === side) return;
        clearArchiveDropIndicators(manager);
        if (!targetId || !side) return;
        const targetRow = archiveManagerRows(manager).find(
            (row) => row.dataset.archiveId === targetId,
        );
        if (!targetRow) return;
        targetRow.classList.add(
            "cpw-archive-manager__row--drop-target",
            side === "before"
                ? "cpw-archive-manager__row--insert-before"
                : "cpw-archive-manager__row--insert-after",
        );
        if (session) {
            session.renderedTargetId = targetId;
            session.renderedSide = side;
        }
    }

    function animateArchiveRowMoves(previousRects, finalRects, sourceRow) {
        if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
        for (const [row, previousRect] of previousRects) {
            if (row === sourceRow || !row.isConnected || typeof row.animate !== "function") continue;
            const nextRect = finalRects.get(row);
            if (!nextRect) continue;
            const deltaY = previousRect.top - nextRect.top;
            if (Math.abs(deltaY) < 0.5) continue;
            archiveReorderAnimations.get(row)?.cancel();
            const animation = row.animate(
                [
                    { transform: `translateY(${deltaY}px)` },
                    { transform: "translateY(0)" },
                ],
                { duration: 120, easing: "cubic-bezier(0.2, 0, 0, 1)" },
            );
            archiveReorderAnimations.set(row, animation);
            const forgetAnimation = () => {
                if (archiveReorderAnimations.get(row) === animation) {
                    archiveReorderAnimations.delete(row);
                }
            };
            animation.addEventListener("finish", forgetAnimation, { once: true });
            animation.addEventListener("cancel", forgetAnimation, { once: true });
        }
    }

    function scheduleArchiveReorderFrame(manager) {
        const session = manager.dragSession;
        if (!session || session.frame) return;
        session.frame = requestAnimationFrame(() => processArchiveReorderFrame(manager));
    }

    function processArchiveReorderFrame(manager) {
        const session = manager.dragSession;
        if (!session) return;
        session.frame = 0;
        updateArchiveDragGhost(session);

        const listRect = manager.list.getBoundingClientRect();
        const velocityY = edgeScrollVelocity(
            session.clientY,
            listRect.top,
            listRect.bottom,
            ARCHIVE_EDGE_SCROLL_ZONE,
            ARCHIVE_EDGE_SCROLL_MAX_SPEED,
        );
        const previousScrollTop = manager.list.scrollTop;
        if (velocityY) manager.list.scrollTop += velocityY;
        const scrolled = manager.list.scrollTop !== previousScrollTop;

        const point = clientPointToContent(
            session.clientX,
            session.clientY,
            listRect,
            1,
            1,
            manager.list.scrollLeft,
            manager.list.scrollTop,
        );
        const currentIds = regularArchiveIds();
        const slots = currentIds.flatMap((archiveId) => {
            const rect = session.layoutRects.get(archiveId);
            return rect ? [{ id: archiveId, rect }] : [];
        });
        const target = findDropTarget(
            slots,
            point,
            session.archiveId,
            0,
            ARCHIVE_ROW_GAP,
        );
        if (!target) {
            session.lastInsertionIndex = null;
            renderArchiveDropIndicator(manager, null, null);
        } else {
            const sourceIndex = currentIds.indexOf(session.archiveId);
            const targetIndex = currentIds.indexOf(target.id);
            const side = resolveImmediateInsertionSide(sourceIndex, targetIndex);
            renderArchiveDropIndicator(manager, target.id, side);
            const insertionIndex = computeInsertionIndex(
                sourceIndex,
                targetIndex,
                side,
                currentIds.length,
            );
            if (insertionIndex !== sourceIndex && insertionIndex !== session.lastInsertionIndex) {
                for (const row of archiveManagerRows(manager)) {
                    archiveReorderAnimations.get(row)?.cancel();
                }
                const previousRects = new Map(
                    archiveManagerRows(manager).map((row) => [row, row.getBoundingClientRect()]),
                );
                const nextIds = [...currentIds];
                const [movedId] = nextIds.splice(sourceIndex, 1);
                nextIds.splice(insertionIndex, 0, movedId);
                const scrollTop = manager.list.scrollTop;
                applyRegularArchiveOrder(nextIds);
                applyArchiveVisualOrder(manager);
                manager.list.scrollTop = scrollTop;
                const finalRects = new Map(
                    archiveManagerRows(manager).map((row) => [row, row.getBoundingClientRect()]),
                );
                cacheArchiveLayoutRects(manager, session, finalRects);
                animateArchiveRowMoves(previousRects, finalRects, session.row);
                session.lastInsertionIndex = insertionIndex;
                session.changed = nextIds.some(
                    (archiveId, index) => archiveId !== session.originalIds[index],
                );
            } else {
                session.lastInsertionIndex = insertionIndex;
            }
        }

        if (scrolled) scheduleArchiveReorderFrame(manager);
    }

    function cleanupArchiveReorder(manager, session) {
        if (session.frame) cancelAnimationFrame(session.frame);
        clearArchiveDropIndicators(manager);
        manager.dragSession = null;
        try {
            if (session.handle.hasPointerCapture?.(session.pointerId)) {
                session.handle.releasePointerCapture(session.pointerId);
            }
        } catch {
            // The browser may already have released capture during cancellation.
        }
        session.handle.removeAttribute("aria-grabbed");
        session.row.classList.remove("cpw-archive-manager__row--drag-source");
        manager.list.classList.remove("cpw-archive-manager__list--dragging");
        session.ghost.remove();
        renderArchiveManagerActions();
    }

    function drainPendingArchiveRefresh() {
        if (!archivesRefreshPending || disposed) return;
        archivesRefreshPending = false;
        queueMicrotask(() => refreshArchives());
    }

    async function persistArchiveOrder(manager, session, archiveIds) {
        if (activeArchiveManager === manager) {
            setArchiveManagerBusy(true);
            setArchiveManagerMessage(t("Saving archive order…"));
        }
        try {
            const payload = await archiveClient.reorder(archiveIds);
            archives = [...(payload?.archives ?? archives)];
            lastSelectedArchiveId = typeof payload?.last_selected_archive_id === "string"
                ? payload.last_selected_archive_id
                : lastSelectedArchiveId;
            renderArchiveSelect();
            renderArchiveManagerList();
            publishArchiveSync();
            setArchiveManagerMessage(t("Archive order saved."));
        } catch (error) {
            archives = session.originalArchives;
            renderArchiveSelect();
            renderArchiveManagerList();
            await refreshArchives();
            setArchiveManagerMessage(t("Could not save archive order: {message}", {
                message: archiveErrorMessage(error),
            }), true);
        } finally {
            if (activeArchiveManager === manager) {
                setArchiveManagerBusy(false);
                renderArchiveManagerList();
            }
            drainPendingArchiveRefresh();
        }
    }

    function finishArchiveReorder(cancelled = false) {
        const manager = activeArchiveManager;
        const session = manager?.dragSession;
        if (!manager || !session) return;
        cleanupArchiveReorder(manager, session);

        if (cancelled) {
            archives = session.originalArchives;
            renderArchiveSelect();
            renderArchiveManagerList();
            drainPendingArchiveRefresh();
            return;
        }
        const archiveIds = regularArchiveIds();
        renderArchiveManagerList();
        if (!session.changed) {
            drainPendingArchiveRefresh();
            return;
        }
        void persistArchiveOrder(manager, session, archiveIds);
    }

    function cancelArchiveReorder() {
        finishArchiveReorder(true);
    }

    function moveArchiveReorder(event) {
        const manager = activeArchiveManager;
        const session = manager?.dragSession;
        if (!manager || !session || event.pointerId !== session.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        const coalesced = event.getCoalescedEvents?.();
        const latest = coalesced?.length ? coalesced[coalesced.length - 1] : event;
        session.clientX = latest.clientX;
        session.clientY = latest.clientY;
        scheduleArchiveReorderFrame(manager);
    }

    function finishArchiveReorderPointer(event) {
        const manager = activeArchiveManager;
        const session = manager?.dragSession;
        if (!manager || !session || event.pointerId !== session.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        session.clientX = event.clientX;
        session.clientY = event.clientY;
        if (session.frame) {
            cancelAnimationFrame(session.frame);
            session.frame = 0;
        }
        processArchiveReorderFrame(manager);
        finishArchiveReorder(false);
    }

    function cancelArchiveReorderPointer(event) {
        const session = activeArchiveManager?.dragSession;
        if (!session || event.pointerId !== session.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        cancelArchiveReorder();
    }

    function loseArchiveReorderPointerCapture(event) {
        const session = activeArchiveManager?.dragSession;
        if (!session || event.pointerId !== session.pointerId) return;
        cancelArchiveReorder();
    }

    function beginArchiveReorder(event, archive, row, handle) {
        const manager = activeArchiveManager;
        if (!manager || manager.busy || manager.dragSession || manager.renameId || archive.is_default) return;
        if (event.button !== 0 || event.isPrimary === false) return;
        event.preventDefault();
        event.stopPropagation();

        for (const candidate of archiveManagerRows(manager)) {
            archiveReorderAnimations.get(candidate)?.cancel();
        }
        const rowRect = row.getBoundingClientRect();
        const ghost = cloneArchiveRowForDrag(row);
        ghost.style.width = `${rowRect.width}px`;
        ghost.style.height = `${rowRect.height}px`;
        document.body.append(ghost);

        const session = {
            archiveId: archive.id,
            clientX: event.clientX,
            clientY: event.clientY,
            pointerId: event.pointerId,
            row,
            handle,
            ghost,
            pointerOffsetX: event.clientX - rowRect.left,
            pointerOffsetY: event.clientY - rowRect.top,
            originalArchives: [...archives],
            originalIds: regularArchiveIds(),
            layoutRects: new Map(),
            lastInsertionIndex: null,
            renderedTargetId: null,
            renderedSide: null,
            changed: false,
            frame: 0,
        };
        manager.dragSession = session;
        row.classList.add("cpw-archive-manager__row--drag-source");
        manager.list.classList.add("cpw-archive-manager__list--dragging");
        handle.setAttribute("aria-grabbed", "true");
        cacheArchiveLayoutRects(manager, session);
        updateArchiveDragGhost(session);
        renderArchiveManagerActions();
        try {
            handle.setPointerCapture(event.pointerId);
            scheduleArchiveReorderFrame(manager);
        } catch {
            cancelArchiveReorder();
        }
    }

    function selectedArchivesForManager(manager = activeArchiveManager) {
        if (!manager) return [];
        const selectedIds = normalizeArchiveManagerSelection(archives, manager.selectedArchiveIds);
        manager.selectedArchiveIds = new Set(selectedIds);
        if (!archives.some((archive) => archive.id === manager.selectionAnchorId)) {
            manager.selectionAnchorId = selectedIds.at(-1) ?? null;
        }
        const selectedArchives = archives.filter((archive) => manager.selectedArchiveIds.has(archive.id));
        if (manager.renameId
            && (selectedArchives.length !== 1 || selectedArchives[0].id !== manager.renameId)) {
            manager.renameId = null;
            manager.renameInput = null;
        }
        return selectedArchives;
    }

    function singleSelectedArchiveForManager(manager = activeArchiveManager) {
        const selectedArchives = selectedArchivesForManager(manager);
        return selectedArchives.length === 1 ? selectedArchives[0] : null;
    }

    function updateArchiveManagerSelectionStyles(manager = activeArchiveManager) {
        if (!manager) return;
        for (const row of archiveManagerRows(manager)) {
            const selected = manager.selectedArchiveIds.has(row.dataset.archiveId);
            row.classList.toggle("cpw-archive-manager__row--selected", selected);
            row.setAttribute("aria-selected", String(selected));
        }
    }

    function selectArchiveManagerArchive(
        archiveId,
        { additive = false, range = false, focus = false } = {},
    ) {
        const manager = activeArchiveManager;
        if (!manager || manager.busy || manager.dragSession || manager.renameId) return false;
        if (!archives.some((archive) => archive.id === archiveId)) return false;
        const selection = applyArchiveManagerSelectionGesture(
            archives.map((archive) => archive.id),
            manager.selectedArchiveIds,
            archiveId,
            manager.selectionAnchorId,
            { additive, range },
        );
        manager.selectedArchiveIds = new Set(selection.selectedIds);
        manager.selectionAnchorId = selection.anchorId;
        updateArchiveManagerSelectionStyles(manager);
        renderArchiveManagerActions();
        if (focus) {
            archiveManagerRows(manager).find((row) => row.dataset.archiveId === archiveId)?.focus();
        }
        return true;
    }

    function cancelArchiveRename() {
        const manager = activeArchiveManager;
        if (!manager || manager.busy) return;
        manager.renameId = null;
        manager.renameInput = null;
        renderArchiveManagerList();
    }

    async function saveArchiveRename() {
        const manager = activeArchiveManager;
        const archive = singleSelectedArchiveForManager(manager);
        if (!manager || !archive || manager.renameId !== archive.id || manager.busy) return;
        const nextName = manager.renameInput?.value.trim() ?? "";
        if (!nextName) {
            setArchiveManagerMessage(t("Archive name cannot be empty."), true);
            manager.renameInput?.focus();
            return;
        }
        const result = await runArchiveMutation(
            () => archiveClient.update(archive.id, { name: nextName }),
            t("Renamed to \"{name}\".", { name: nextName }),
        );
        if (result && activeArchiveManager) {
            activeArchiveManager.renameId = null;
            activeArchiveManager.renameInput = null;
            renderArchiveManagerList();
        }
    }

    async function saveSelectedArchive() {
        const manager = activeArchiveManager;
        const archive = singleSelectedArchiveForManager(manager);
        if (!manager || !archive || manager.busy || manager.dragSession || !state) return;
        const save = await askArchiveConfirmation({
            title: archive.is_default ? t("Save the default archive?") : t("Save the archive?"),
            message: t("Save the current grid state and window size to \"{name}\" and replace its contents?", {
                name: archiveDisplayName(archive),
            }),
            confirmText: t("Save"),
            danger: true,
        });
        if (!save) return;
        const result = await runArchiveMutation(
            () => archiveClient.update(archive.id, { snapshot: currentSnapshot() }),
            t("Saved to \"{name}\".", { name: archiveDisplayName(archive) }),
        );
        if (!result) return;
        if (activeArchiveManager) {
            activeArchiveManager.selectedArchiveIds = new Set([archive.id]);
            activeArchiveManager.selectionAnchorId = archive.id;
        }
        setActiveArchive(archive.id, {
            persistGlobal: true,
            notifyGraph: true,
            captureHistory: true,
        });
        reconcileArchiveSelection();
        renderArchiveManagerList();
    }

    async function loadSelectedArchive() {
        const manager = activeArchiveManager;
        const archive = singleSelectedArchiveForManager(manager);
        if (!manager || !archive || manager.busy || manager.dragSession || manager.renameId) return false;
        if (archive.id === activeArchiveId && !archiveDirty) return false;
        return requestArchiveLoad(archive);
    }

    function beginArchiveRename() {
        const manager = activeArchiveManager;
        const archive = singleSelectedArchiveForManager(manager);
        if (!manager || !archive || archive.is_default || manager.busy || manager.dragSession) return;
        manager.renameId = archive.id;
        renderArchiveManagerList();
    }

    function exportSelectedArchives() {
        const selectedArchives = selectedArchivesForManager();
        if (!selectedArchives.length) return;
        if (selectedArchives.length === 1) {
            const [archive] = selectedArchives;
            downloadArchiveBundle(
                [archive],
                `${archiveDisplayName(archive)}.prompt-grid-archives.json`,
            );
            setArchiveManagerMessage(t("Exported \"{name}\".", { name: archiveDisplayName(archive) }));
            return;
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        downloadArchiveBundle(
            selectedArchives,
            `prompt-grid-archives-selection-${timestamp}.json`,
        );
        setArchiveManagerMessage(t("Exported {count} selected archives.", {
            count: selectedArchives.length,
        }));
    }

    async function deleteSelectedArchives() {
        const manager = activeArchiveManager;
        const selectedArchives = selectedArchivesForManager(manager);
        if (!manager || !selectedArchives.length || manager.busy || manager.dragSession) return;
        if (selectedArchives.some((archive) => archive.is_default || archive.id === DEFAULT_ARCHIVE_ID)) {
            setArchiveManagerMessage(t("The default archive cannot be deleted."), true);
            return;
        }
        const nameSummary = formatList(
            selectedArchives.slice(0, 5).map((archive) => archiveDisplayName(archive)),
        );
        const extraCount = Math.max(0, selectedArchives.length - 5);
        const remove = await askArchiveConfirmation({
            title: selectedArchives.length === 1
                ? t("Delete archive?")
                : t("Delete {count} archives?", { count: selectedArchives.length }),
            message: extraCount
                ? t("{names} and {count} archives in total cannot be recovered after deletion. The current node state will not change.", {
                    names: nameSummary,
                    count: selectedArchives.length,
                })
                : t("{names} cannot be recovered after deletion. The current node state will not change.", {
                    names: nameSummary,
                }),
            confirmText: t("Delete"),
            danger: true,
        });
        if (!remove) return;
        const selectedIds = selectedArchives.map((archive) => archive.id);
        const originalSelection = new Set(manager.selectedArchiveIds);
        const originalAnchorId = manager.selectionAnchorId;
        const result = await runArchiveMutation(
            () => selectedIds.length === 1
                ? archiveClient.delete(selectedIds[0])
                : archiveClient.deleteMany(selectedIds),
            selectedIds.length === 1
                ? t("Deleted \"{name}\".", { name: archiveDisplayName(selectedArchives[0]) })
                : t("Deleted {count} archives.", { count: selectedIds.length }),
        );
        if (!result) {
            if (activeArchiveManager) {
                activeArchiveManager.selectedArchiveIds = originalSelection;
                activeArchiveManager.selectionAnchorId = originalAnchorId;
                await refreshArchives({ reportError: true });
                renderArchiveManagerList();
            }
            return;
        }
        if (activeArchiveManager) {
            activeArchiveManager.selectedArchiveIds = new Set();
            activeArchiveManager.selectionAnchorId = null;
        }
        reconcileArchiveSelection();
        renderArchiveManagerList();
    }

    function renderArchiveManagerActions() {
        const manager = activeArchiveManager;
        if (!manager?.selectedActions) return;
        const actions = manager.selectedActions;
        actions.replaceChildren();
        const selectedArchives = selectedArchivesForManager(manager);
        const archive = selectedArchives.length === 1 ? selectedArchives[0] : null;

        if (manager.renameId && archive?.id === manager.renameId) {
            const cancelButton = element("button", "cpw-archive-manager__button", t("Cancel"));
            const saveNameButton = element(
                "button",
                "cpw-archive-manager__button cpw-archive-manager__button--primary",
                t("Save Name"),
            );
            cancelButton.type = "button";
            saveNameButton.type = "button";
            cancelButton.disabled = manager.busy;
            saveNameButton.disabled = manager.busy;
            cancelButton.addEventListener("click", cancelArchiveRename);
            saveNameButton.addEventListener("click", saveArchiveRename);
            actions.append(cancelButton, saveNameButton);
            return;
        }

        const availability = archiveManagerSelectionAvailability(selectedArchives, {
            busy: manager.busy,
            dragging: Boolean(manager.dragSession),
            renaming: Boolean(manager.renameId),
            hasState: Boolean(state),
            loadable: Boolean(archive) && (archive.id !== activeArchiveId || archiveDirty),
        });
        const definitions = [
            [t("Save"), t("Save the current grid state to the selected archive"), availability.save, saveSelectedArchive],
            [t("Load"), t("Load the selected archive"), availability.load, loadSelectedArchive],
            [
                t("Rename"),
                archive?.is_default
                    ? t("The default archive cannot be renamed")
                    : t("Rename the selected archive"),
                availability.rename,
                beginArchiveRename,
            ],
            [t("Export"), t("Export the selected archives"), availability.export, exportSelectedArchives],
            [
                t("Delete"),
                selectedArchives.some((item) => item.is_default || item.id === DEFAULT_ARCHIVE_ID)
                    ? t("The default archive cannot be deleted.")
                    : t("Delete the selected archives"),
                availability.delete,
                deleteSelectedArchives,
                true,
            ],
        ];
        for (const [label, title, enabled, handler, danger = false] of definitions) {
            const button = element(
                "button",
                `cpw-archive-manager__button${danger ? " cpw-archive-manager__button--danger-text" : ""}`,
                label,
            );
            button.type = "button";
            button.title = selectedArchives.length ? title : t("Select an archive first");
            button.disabled = !enabled;
            button.addEventListener("click", handler);
            actions.append(button);
        }
    }

    function renderArchiveManagerList() {
        if (!activeArchiveManager) return;
        const manager = activeArchiveManager;
        manager.list.replaceChildren();
        manager.renameInput = null;
        if (!archives.length) {
            manager.list.append(element(
                "div",
                "cpw-archive-manager__empty",
                t("There are no archives yet. Create one above."),
            ));
            renderArchiveManagerActions();
            return;
        }
        if (manager.selectionNeedsInitialization) {
            manager.selectedArchiveIds = new Set(
                archives.some((archive) => archive.id === activeArchiveId) ? [activeArchiveId] : [],
            );
            manager.selectionAnchorId = manager.selectedArchiveIds.has(activeArchiveId)
                ? activeArchiveId
                : null;
            manager.selectionNeedsInitialization = false;
        }
        selectedArchivesForManager(manager);
        for (const archive of archives) {
            const displayName = archiveDisplayName(archive);
            const row = element("article", "cpw-archive-manager__row");
            row.dataset.archiveId = archive.id;
            row.dataset.archiveDefault = String(Boolean(archive.is_default));
            row.tabIndex = 0;
            row.setAttribute("role", "option");
            row.setAttribute("aria-label", t("{name} archive", { name: displayName }));
            if (manager.selectedArchiveIds.has(archive.id)) {
                row.classList.add("cpw-archive-manager__row--selected");
                row.setAttribute("aria-selected", "true");
            } else {
                row.setAttribute("aria-selected", "false");
            }
            const dragControl = archive.is_default
                ? element("span", "cpw-archive-manager__drag-placeholder")
                : element("button", "cpw-archive-manager__drag", "⠿");
            if (!archive.is_default) {
                dragControl.type = "button";
                dragControl.title = t("Drag to reorder archives");
                dragControl.setAttribute("aria-label", t("Drag \"{name}\" to reorder it", {
                    name: displayName,
                }));
                dragControl.setAttribute("aria-grabbed", "false");
                dragControl.addEventListener("pointerdown", (event) => {
                    beginArchiveReorder(event, archive, row, dragControl);
                });
                dragControl.addEventListener("pointermove", moveArchiveReorder);
                dragControl.addEventListener("pointerup", finishArchiveReorderPointer);
                dragControl.addEventListener("pointercancel", cancelArchiveReorderPointer);
                dragControl.addEventListener("lostpointercapture", loseArchiveReorderPointerCapture);
            } else {
                dragControl.setAttribute("aria-hidden", "true");
            }
            dragControl.disabled = manager.busy || Boolean(manager.renameId);
            const main = element("div", "cpw-archive-manager__row-main");
            const name = element("strong", "cpw-archive-manager__row-name", displayName);
            const nameRow = element("div", "cpw-archive-manager__row-name-line");
            nameRow.append(name);
            if (archive.is_default) {
                nameRow.append(element("span", "cpw-archive-manager__default-badge", t("Default")));
            }
            if (archive.id === activeArchiveId) {
                nameRow.append(element("span", "cpw-archive-manager__current-badge", t("Current")));
            }
            const enabledCount = archive.snapshot.items.filter((item) => item.enabled).length;
            const meta = element(
                "span",
                "cpw-archive-manager__row-meta",
                t("{columns} columns · {cards} cards · {enabled} enabled · {width}×{height} · {time}", {
                    columns: archive.snapshot.columns,
                    cards: archive.snapshot.items.length,
                    enabled: enabledCount,
                    width: archive.snapshot.node_size.width,
                    height: archive.snapshot.node_size.height,
                    time: formatArchiveTime(archive.updated_at),
                }),
            );
            main.append(nameRow, meta);

            if (!archive.is_default && manager.renameId === archive.id) {
                const renameInput = element("input", "cpw-archive-manager__input cpw-archive-manager__rename-input");
                renameInput.type = "text";
                renameInput.maxLength = 80;
                renameInput.value = archive.name;
                renameInput.setAttribute("aria-label", t("New archive name"));
                renameInput.addEventListener("keydown", (event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        void saveArchiveRename();
                    }
                });
                manager.renameInput = renameInput;
                main.replaceChildren(renameInput, meta);
                queueMicrotask(() => {
                    if (activeArchiveManager === manager && manager.renameInput === renameInput) {
                        renameInput.focus();
                        renameInput.select();
                    }
                });
            }

            row.addEventListener("click", (event) => {
                if (event.target.closest?.(".cpw-archive-manager__drag, input, button")) return;
                selectArchiveManagerArchive(archive.id, {
                    additive: event.ctrlKey || event.metaKey,
                    range: event.shiftKey,
                });
            });
            row.addEventListener("dblclick", (event) => {
                if (
                    event.button !== 0
                    || event.ctrlKey
                    || event.metaKey
                    || event.shiftKey
                    || event.target.closest?.(".cpw-archive-manager__drag, input, button")
                    || manager.busy
                    || manager.dragSession
                    || manager.renameId
                ) return;
                event.preventDefault();
                if (!selectArchiveManagerArchive(archive.id, { focus: true })) return;
                void loadSelectedArchive();
            });
            row.addEventListener("selectstart", (event) => {
                if (event.target.closest?.("input, textarea")) return;
                event.preventDefault();
            });
            row.addEventListener("keydown", (event) => {
                if (event.target !== row || !["Enter", " "].includes(event.key)) return;
                event.preventDefault();
                selectArchiveManagerArchive(archive.id, {
                    additive: event.ctrlKey || event.metaKey,
                    range: event.shiftKey,
                    focus: true,
                });
            });
            row.append(dragControl, main);
            manager.list.append(row);
        }
        renderArchiveManagerActions();
    }

    function openArchiveManager() {
        if (activeArchiveManager || disposed) return;
        const overlay = element("div", "cpw-archive-manager__overlay");
        const dialog = element("section", "cpw-archive-manager");
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
        dialog.setAttribute("aria-label", t("Prompt Grid Archive Manager"));

        const header = element("header", "cpw-archive-manager__header");
        const title = element("h2", "cpw-archive-manager__title", t("Prompt Grid Archives"));
        const closeButton = element("button", "cpw-archive-manager__close", "×");
        closeButton.type = "button";
        closeButton.title = t("Close");
        closeButton.setAttribute("aria-label", t("Close archive manager"));
        header.append(title, closeButton);

        const saveRow = element("div", "cpw-archive-manager__save-row");
        const nameInput = element("input", "cpw-archive-manager__input");
        nameInput.type = "text";
        nameInput.maxLength = 80;
        nameInput.value = defaultArchiveName();
        nameInput.placeholder = t("Archive name");
        nameInput.setAttribute("aria-label", t("New archive name"));
        const saveButton = element(
            "button",
            "cpw-archive-manager__button cpw-archive-manager__button--primary",
            t("New Archive"),
        );
        saveButton.type = "button";
        saveRow.append(nameInput, saveButton);

        const message = element("div", "cpw-archive-manager__message");
        message.hidden = true;
        const list = element("div", "cpw-archive-manager__list");
        list.setAttribute("role", "listbox");
        list.setAttribute("aria-label", t("Archive list"));
        list.setAttribute("aria-multiselectable", "true");
        const footer = element("footer", "cpw-archive-manager__footer");
        const importButton = element("button", "cpw-archive-manager__button", t("Import Archives"));
        const exportAllButton = element("button", "cpw-archive-manager__button", t("Export All"));
        const selectedActions = element("div", "cpw-archive-manager__selected-actions");
        for (const button of [importButton, exportAllButton]) button.type = "button";
        const footerSpacer = element("span", "cpw-archive-manager__footer-spacer");
        footer.append(importButton, exportAllButton, footerSpacer, selectedActions);

        const fileInput = element("input", "");
        fileInput.type = "file";
        fileInput.accept = ".json,application/json";
        fileInput.hidden = true;
        dialog.append(header, saveRow, message, list, footer, fileInput);
        overlay.append(dialog);

        const onKeyDown = (event) => {
            if (event.key === "Escape" && !activeArchiveConfirmation) {
                event.preventDefault();
                if (activeArchiveManager?.dragSession) {
                    cancelArchiveReorder();
                    return;
                }
                if (activeArchiveManager?.renameId) {
                    cancelArchiveRename();
                    return;
                }
                closeArchiveManager();
            }
        };
        activeArchiveManager = {
            overlay,
            dialog,
            list,
            message,
            nameInput,
            fileInput,
            selectedActions,
            onKeyDown,
            selectedArchiveIds: new Set(activeArchiveId ? [activeArchiveId] : []),
            selectionAnchorId: activeArchiveId || null,
            selectionNeedsInitialization: !archives.length,
            renameId: null,
            renameInput: null,
            busy: false,
            dragSession: null,
            refreshLocale() {
                dialog.setAttribute("aria-label", t("Prompt Grid Archive Manager"));
                title.textContent = t("Prompt Grid Archives");
                closeButton.title = t("Close");
                closeButton.setAttribute("aria-label", t("Close archive manager"));
                nameInput.placeholder = t("Archive name");
                nameInput.setAttribute("aria-label", t("New archive name"));
                saveButton.textContent = t("New Archive");
                list.setAttribute("aria-label", t("Archive list"));
                importButton.textContent = t("Import Archives");
                exportAllButton.textContent = t("Export All");
                if (!this.dragSession && !this.renameId) renderArchiveManagerList();
            },
        };
        overlay.addEventListener("pointerdown", (event) => {
            if (event.target === overlay && !activeArchiveConfirmation) closeArchiveManager();
        });
        closeButton.addEventListener("click", closeArchiveManager);
        saveButton.addEventListener("click", saveCurrentArchive);
        nameInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") saveCurrentArchive();
        });
        importButton.addEventListener("click", () => fileInput.click());
        fileInput.addEventListener("change", async () => {
            const [file] = fileInput.files ?? [];
            fileInput.value = "";
            await importArchiveFile(file);
        });
        exportAllButton.addEventListener("click", () => {
            if (!archives.length) {
                setArchiveManagerMessage(t("There are no archives to export."), true);
                return;
            }
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            downloadArchiveBundle(archives, `prompt-grid-archives-${timestamp}.json`);
            setArchiveManagerMessage(t("Exported {count} archives.", { count: archives.length }));
        });
        document.addEventListener("keydown", onKeyDown, true);
        document.body.append(overlay);
        renderArchiveManagerList();
        refreshArchives({ reportError: true });
        queueMicrotask(() => nameInput.focus());
    }

    function nextTitle() {
        let highest = 0;
        for (const item of state?.items ?? []) {
            const match = /^(?:Card|\u5361\u7247|Prompt|\u63d0\u793a\u8bcd)\s+(\d+)$/i.exec(item.title.trim());
            if (match) highest = Math.max(highest, Number(match[1]));
        }
        return cardTitle(highest + 1);
    }

    function updateItem(id, patch, captureHistory = true) {
        if (!state) return;
        const index = state.items.findIndex((item) => item.id === id);
        if (index < 0) return;
        state.items[index] = { ...state.items[index], ...patch };
        commit(false, captureHistory);
    }

    function clearFavoriteRefreshTimers() {
        for (const timer of favoriteRefreshTimers.values()) clearTimeout(timer);
        favoriteRefreshTimers.clear();
    }

    function playFavoriteRefreshAnimation(itemId, card = cardElements.get(itemId)) {
        if (!card?.isConnected) return;
        const previousTimer = favoriteRefreshTimers.get(itemId);
        if (previousTimer) clearTimeout(previousTimer);
        card.classList.remove("cpw-prompt-grid__card--favorite-refreshed");
        void card.offsetWidth;
        card.classList.add("cpw-prompt-grid__card--favorite-refreshed");
        favoriteRefreshTimers.set(itemId, setTimeout(() => {
            favoriteRefreshTimers.delete(itemId);
            card.classList.remove("cpw-prompt-grid__card--favorite-refreshed");
        }, 900));
    }

    function closePromptCardLibraryMenu(restoreFocus = false) {
        const menu = activePromptCardLibraryMenu;
        activePromptCardLibraryMenu = null;
        menu?.close?.({ restoreFocus });
    }

    function switchItemToFavorite(itemId, favorite) {
        if (!state) return false;
        const index = state.items.findIndex((item) => item.id === itemId);
        if (index < 0) return false;
        const current = state.items[index];
        const next = replacePromptGridItemWithFavorite(current, favorite);
        const sameFavorite = normalizePromptCardFavoriteId(current.favorite_id)
            === normalizePromptCardFavoriteId(next.favorite_id);
        const sameSnapshot = JSON.stringify(promptCardFavoriteSnapshot(current))
            === JSON.stringify(promptCardFavoriteSnapshot(next));
        if (sameFavorite && sameSnapshot) {
            playFavoriteRefreshAnimation(itemId);
            return false;
        }
        state.items[index] = next;
        pendingFavoriteRefreshItems.add(itemId);
        commit(true, true);
        return true;
    }

    function openCardFavoriteSwitchMenu(itemId, button) {
        closePromptCardLibraryMenu(false);
        let controller = null;
        controller = openPromptCardFavoriteCascade({
            service: promptCardLibraryService,
            anchor: button,
            resolvePromptTip: resolveFavoriteCardPromptTip,
            onChooseCard: (favorite) => switchItemToFavorite(itemId, favorite),
            onClose: () => {
                if (activePromptCardLibraryMenu === controller) activePromptCardLibraryMenu = null;
                button.setAttribute("aria-expanded", "false");
            },
        });
        controller.anchor = button;
        activePromptCardLibraryMenu = controller;
        button.setAttribute("aria-expanded", "true");
    }

    function updatePromptEditorItem(id, {
        prompt,
        retainUnselected,
        promptTokens,
        favoriteId,
    }) {
        if (!state) return false;
        const index = state.items.findIndex((item) => item.id === id);
        if (index < 0) return false;
        const currentItem = state.items[index];
        const currentRetainUnselected = currentItem.retain_unselected !== false;
        const currentPromptTokens = Array.isArray(currentItem.prompt_tokens)
            ? currentItem.prompt_tokens
            : null;
        const currentFavoriteId = normalizePromptCardFavoriteId(currentItem.favorite_id);
        const nextFavoriteId = normalizePromptCardFavoriteId(favoriteId);
        if (
            currentItem.prompt === prompt
            && currentRetainUnselected === retainUnselected
            && JSON.stringify(currentPromptTokens) === JSON.stringify(promptTokens)
            && currentFavoriteId === nextFavoriteId
        ) return false;
        const {
            retain_unselected: _discardedRetainUnselected,
            prompt_tokens: _discardedPromptTokens,
            favorite_id: _discardedFavoriteId,
            ...baseItem
        } = currentItem;
        const nextItem = {
            ...baseItem,
            prompt,
            ...(!retainUnselected ? { retain_unselected: false } : {}),
            ...(retainUnselected && promptTokens?.length ? { prompt_tokens: promptTokens } : {}),
            ...(nextFavoriteId ? { favorite_id: nextFavoriteId } : {}),
        };
        state.items[index] = nextItem;
        commit(false, true);
        return true;
    }

    function applyCardColor(card, colorValue) {
        if (!card) return;
        const color = normalizePromptGridItemColor(colorValue);
        const definition = color ? PROMPT_GRID_ITEM_COLORS[color] : null;
        card.classList.toggle("cpw-prompt-grid__card--colored", Boolean(definition));
        if (definition) {
            card.dataset.itemColor = color;
            card.style.setProperty("--cpw-card-color", definition.hex);
        } else {
            delete card.dataset.itemColor;
            card.style.removeProperty("--cpw-card-color");
        }
    }

    function closeItemContextMenu({ restoreFocus = false } = {}) {
        const active = activeItemContextMenu;
        if (!active) return;
        activeItemContextMenu = null;
        active.cleanup();
        active.menu.remove();
        if (restoreFocus && active.opener?.isConnected) active.opener.focus?.();
    }

    function moveItemToEdge(itemId, edge) {
        if (!state) return;
        const reordered = movePromptGridItemToEdge(state.items, itemId, edge);
        const changed = reordered.some((item, index) => item !== state.items[index]);
        closeItemContextMenu();
        if (!changed) return;
        state.items = reordered;
        commit(true, true);
        scheduleNodeHeightFit();
    }

    function setItemColor(itemId, colorValue) {
        if (!state) return;
        const index = state.items.findIndex((item) => item.id === itemId);
        if (index < 0) return;
        const color = normalizePromptGridItemColor(colorValue);
        const currentColor = normalizePromptGridItemColor(state.items[index].color);
        closeItemContextMenu();
        if (currentColor === color) return;
        if (color) {
            state.items[index] = { ...state.items[index], color };
        } else {
            const { color: _discardedColor, ...itemWithoutColor } = state.items[index];
            state.items[index] = itemWithoutColor;
        }
        applyCardColor(cardElements.get(itemId), color);
        commit(false, true);
    }

    function deleteItem(itemId) {
        if (!state) return;
        const nextItems = state.items.filter((candidate) => candidate.id !== itemId);
        if (nextItems.length === state.items.length) return;
        closeItemContextMenu();
        state.items = nextItems;
        commit(true);
        scheduleNodeHeightFit();
    }

    function openItemContextMenu(event, item, card) {
        if (!state || disposed || dragSession) return;
        if (event.target.closest('input[type="text"], textarea, [contenteditable="true"]')) return;
        event.preventDefault();
        event.stopPropagation();
        closeItemContextMenu();

        const currentIndex = state.items.findIndex((candidate) => candidate.id === item.id);
        if (currentIndex < 0) return;
        const menu = element("div", "cpw-prompt-grid__item-menu");
        menu.setAttribute("role", "menu");
        menu.setAttribute("aria-label", t("{name} menu", { name: item.title || t("Prompt") }));
        menu.tabIndex = -1;

        const makeAction = (label, disabled, action) => {
            const button = element("button", "cpw-prompt-grid__item-menu-action", label);
            button.type = "button";
            button.setAttribute("role", "menuitem");
            button.disabled = disabled;
            button.addEventListener("click", () => action());
            return button;
        };
        let deleteConfirming = false;
        const deleteSlot = element("div", "cpw-prompt-grid__item-menu-delete-slot");
        deleteSlot.setAttribute("role", "none");

        const renderDeleteAction = ({ restoreFocus = false } = {}) => {
            deleteConfirming = false;
            const deleteAction = makeAction(t("Delete"), false, renderDeleteConfirmation);
            deleteAction.classList.add("cpw-prompt-grid__item-menu-action--danger");
            deleteSlot.replaceChildren(deleteAction);
            if (restoreFocus) queueMicrotask(() => deleteAction.focus());
        };

        const renderDeleteConfirmation = () => {
            deleteConfirming = true;
            const confirmation = element("div", "cpw-prompt-grid__item-menu-delete-confirm");
            confirmation.setAttribute("role", "group");
            confirmation.setAttribute("aria-label", t("Confirm?"));
            const question = element("span", "cpw-prompt-grid__item-menu-delete-question", t("Confirm?"));
            const confirm = element(
                "button",
                "cpw-prompt-grid__item-menu-delete-choice cpw-prompt-grid__item-menu-delete-choice--confirm",
                t("Confirm"),
            );
            confirm.type = "button";
            confirm.setAttribute("role", "menuitem");
            confirm.addEventListener("click", () => deleteItem(item.id));
            const cancel = element(
                "button",
                "cpw-prompt-grid__item-menu-delete-choice",
                t("Cancel"),
            );
            cancel.type = "button";
            cancel.setAttribute("role", "menuitem");
            cancel.addEventListener("click", () => renderDeleteAction({ restoreFocus: true }));
            confirmation.append(question, confirm, cancel);
            deleteSlot.replaceChildren(confirmation);
            queueMicrotask(() => cancel.focus());
        };
        const topButton = makeAction(t("Move to Top"), currentIndex === 0, () => (
            moveItemToEdge(item.id, "start")
        ));
        const bottomButton = makeAction(
            t("Move to Bottom"),
            currentIndex === state.items.length - 1,
            () => moveItemToEdge(item.id, "end"),
        );
        const separator = element("div", "cpw-prompt-grid__item-menu-separator");
        separator.setAttribute("role", "separator");
        const colorLabel = element("div", "cpw-prompt-grid__item-menu-label", t("Color"));
        const colorGroup = element("div", "cpw-prompt-grid__item-menu-colors");
        colorGroup.setAttribute("role", "group");
        colorGroup.setAttribute("aria-label", t("Card color"));
        const currentColor = normalizePromptGridItemColor(item.color);
        const colorOptions = [
            { key: null, label: t("No Color"), hex: null },
            ...Object.entries(PROMPT_GRID_ITEM_COLORS).map(([key, definition]) => ({
                key,
                label: t(definition.label),
                hex: definition.hex,
            })),
        ];
        for (const option of colorOptions) {
            const colorButton = element(
                "button",
                `cpw-prompt-grid__item-color${option.key ? "" : " cpw-prompt-grid__item-color--none"}`,
            );
            colorButton.type = "button";
            colorButton.setAttribute(
                "aria-label",
                option.key ? t("Color: {color}", { color: option.label }) : option.label,
            );
            colorButton.setAttribute("aria-pressed", String(currentColor === option.key));
            colorButton.title = option.label;
            if (option.hex) colorButton.style.setProperty("--cpw-item-color", option.hex);
            colorButton.addEventListener("click", () => setItemColor(item.id, option.key));
            colorGroup.append(colorButton);
        }
        const deleteSeparator = element("div", "cpw-prompt-grid__item-menu-separator");
        deleteSeparator.setAttribute("role", "separator");
        menu.append(
            topButton,
            bottomButton,
            separator,
            colorLabel,
            colorGroup,
            deleteSeparator,
            deleteSlot,
        );
        renderDeleteAction();

        const onDocumentPointerDown = (pointerEvent) => {
            if (!menu.contains(pointerEvent.target)) closeItemContextMenu();
        };
        const focusableMenuItems = () => [...menu.querySelectorAll("button:not([disabled])")];
        const onDocumentKeyDown = (keyEvent) => {
            if (!activeItemContextMenu || activeItemContextMenu.menu !== menu) return;
            if (keyEvent.key === "Escape") {
                keyEvent.preventDefault();
                keyEvent.stopPropagation();
                if (deleteConfirming) {
                    renderDeleteAction({ restoreFocus: true });
                    return;
                }
                closeItemContextMenu({ restoreFocus: true });
                return;
            }
            if (keyEvent.key === "Tab") {
                closeItemContextMenu();
                return;
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(keyEvent.key)) return;
            const candidates = focusableMenuItems();
            if (!candidates.length) return;
            keyEvent.preventDefault();
            keyEvent.stopPropagation();
            const current = candidates.indexOf(document.activeElement);
            let next = 0;
            if (keyEvent.key === "End") next = candidates.length - 1;
            else if (keyEvent.key === "ArrowUp") next = current <= 0 ? candidates.length - 1 : current - 1;
            else if (keyEvent.key === "ArrowDown") next = current < 0 || current === candidates.length - 1 ? 0 : current + 1;
            candidates[next].focus();
        };
        const onViewportChange = () => closeItemContextMenu();
        const cleanup = () => {
            document.removeEventListener("pointerdown", onDocumentPointerDown, true);
            document.removeEventListener("keydown", onDocumentKeyDown, true);
            document.removeEventListener("scroll", onViewportChange, true);
            window.removeEventListener("resize", onViewportChange);
        };
        activeItemContextMenu = { menu, opener: event.target, cleanup };
        document.addEventListener("pointerdown", onDocumentPointerDown, true);
        document.addEventListener("keydown", onDocumentKeyDown, true);
        document.addEventListener("scroll", onViewportChange, true);
        window.addEventListener("resize", onViewportChange);
        for (const eventName of [
            "pointerdown", "pointerup", "mousedown", "click", "dblclick", "contextmenu",
            "keydown", "keyup",
        ]) {
            menu.addEventListener(eventName, (menuEvent) => menuEvent.stopPropagation());
        }
        menu.addEventListener("contextmenu", (menuEvent) => menuEvent.preventDefault());
        menu.addEventListener("wheel", (menuEvent) => menuEvent.stopPropagation(), { passive: true });
        document.body.append(menu);

        const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
        const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
        const margin = 6;
        const left = Math.min(
            Math.max(margin, event.clientX),
            Math.max(margin, viewportWidth - menu.offsetWidth - margin),
        );
        const top = Math.min(
            Math.max(margin, event.clientY),
            Math.max(margin, viewportHeight - menu.offsetHeight - margin),
        );
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        queueMicrotask(() => focusableMenuItems()[0]?.focus());
    }

    function clearDropState() {
        for (const card of cardElements.values()) {
            card.classList.remove(
                "cpw-prompt-grid__card--drop",
                "cpw-prompt-grid__card--insert-before",
                "cpw-prompt-grid__card--insert-after",
            );
        }
        if (dragSession) {
            dragSession.renderedTargetId = null;
            dragSession.renderedSide = null;
        }
    }

    function applyGridColumns() {
        if (!state) return;
        grid.style.setProperty("--cpw-columns", String(state.columns));
        grid.style.minWidth = `${state.columns * 180 + (state.columns - 1) * GRID_GAP}px`;
        grid.classList.toggle("cpw-prompt-grid__cards--single-column", state.columns === 1);
    }

    function getViewportMetrics() {
        const rect = scroll.getBoundingClientRect();
        const scaleX = scroll.offsetWidth > 0 ? rect.width / scroll.offsetWidth : 1;
        const scaleY = scroll.offsetHeight > 0 ? rect.height / scroll.offsetHeight : scaleX;
        return {
            rect,
            scaleX: Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1,
            scaleY: Number.isFinite(scaleY) && scaleY > 0 ? scaleY : 1,
        };
    }

    function cacheFinalLayoutRects(session, clientRects = null) {
        const metrics = getViewportMetrics();
        const layoutRects = new Map();
        for (const item of state?.items ?? []) {
            const card = cardElements.get(item.id);
            if (!card?.isConnected) continue;
            const rect = clientRects?.get(card) ?? card.getBoundingClientRect();
            layoutRects.set(item.id, clientRectToContent(
                rect,
                metrics.rect,
                metrics.scaleX,
                metrics.scaleY,
                scroll.scrollLeft,
                scroll.scrollTop,
            ));
        }
        session.layoutRects = layoutRects;
    }

    function applyCardVisualOrder() {
        for (let index = 0; index < (state?.items.length ?? 0); index += 1) {
            const card = cardElements.get(state.items[index].id);
            if (card) card.style.order = String(index);
        }
    }

    function normalizeCardDomOrder() {
        const preservedScrollLeft = scroll.scrollLeft;
        const preservedScrollTop = scroll.scrollTop;
        for (const item of state?.items ?? []) {
            const card = cardElements.get(item.id);
            if (card) grid.append(card);
        }
        for (const card of cardElements.values()) card.style.removeProperty("order");
        scroll.scrollLeft = preservedScrollLeft;
        scroll.scrollTop = preservedScrollTop;
    }

    function animateCardsToStateOrder(movedId, session = dragSession) {
        const movedCard = cardElements.get(movedId);
        const before = new Map();
        for (const card of cardElements.values()) {
            if (card.isConnected) before.set(card, card.getBoundingClientRect());
            reorderAnimations.get(card)?.cancel();
        }

        const preservedScrollLeft = scroll.scrollLeft;
        const preservedScrollTop = scroll.scrollTop;
        // CSS order keeps the captured drag handle connected to the document.
        // Moving it through a DocumentFragment here would fire
        // lostpointercapture and incorrectly cancel the drag.
        applyCardVisualOrder();
        scroll.scrollLeft = preservedScrollLeft;
        scroll.scrollTop = preservedScrollTop;

        const after = new Map();
        for (const card of cardElements.values()) {
            if (card.isConnected) after.set(card, card.getBoundingClientRect());
        }
        if (session) cacheFinalLayoutRects(session, after);
        const animationMetrics = getViewportMetrics();

        const reduceMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
        if (reduceMotion) return;

        for (const [card, previousRect] of before) {
            if (card === movedCard) continue;
            const nextRect = after.get(card);
            if (!nextRect) continue;
            const offsetX = (previousRect.left - nextRect.left) / animationMetrics.scaleX;
            const offsetY = (previousRect.top - nextRect.top) / animationMetrics.scaleY;
            if (Math.abs(offsetX) < 0.25 && Math.abs(offsetY) < 0.25) continue;
            const animation = card.animate(
                [
                    { transform: `translate(${offsetX}px, ${offsetY}px)` },
                    { transform: "translate(0, 0)" },
                ],
                { duration: REORDER_ANIMATION_DURATION, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
            );
            reorderAnimations.set(card, animation);
            const forgetAnimation = () => {
                if (reorderAnimations.get(card) === animation) reorderAnimations.delete(card);
            };
            animation.addEventListener("finish", forgetAnimation, { once: true });
            animation.addEventListener("cancel", forgetAnimation, { once: true });
        }
    }

    function renderDropState(targetId, side) {
        if (
            dragSession?.renderedTargetId === targetId
            && dragSession?.renderedSide === side
        ) {
            return;
        }
        clearDropState();
        if (!targetId || !side) return;
        const targetCard = cardElements.get(targetId);
        if (!targetCard) return;
        targetCard.classList.add(
            "cpw-prompt-grid__card--drop",
            side === "before"
                ? "cpw-prompt-grid__card--insert-before"
                : "cpw-prompt-grid__card--insert-after",
        );
        if (dragSession) {
            dragSession.renderedTargetId = targetId;
            dragSession.renderedSide = side;
        }
    }

    function cloneCardForDrag(card) {
        const clone = card.cloneNode(true);
        const sourceInputs = card.querySelectorAll("input");
        const cloneInputs = clone.querySelectorAll("input");
        for (let index = 0; index < sourceInputs.length; index += 1) {
            cloneInputs[index].value = sourceInputs[index].value;
            cloneInputs[index].checked = sourceInputs[index].checked;
        }
        clone.classList.remove(
            "cpw-prompt-grid__card--dragging",
            "cpw-prompt-grid__card--drop",
            "cpw-prompt-grid__card--insert-before",
            "cpw-prompt-grid__card--insert-after",
        );
        clone.classList.add("cpw-prompt-grid__drag-ghost");
        clone.setAttribute("aria-hidden", "true");
        return clone;
    }

    function updateDragGhost(session) {
        const left = session.clientX - session.pointerOffsetX;
        const top = session.clientY - session.pointerOffsetY;
        session.ghost.style.transform = `translate3d(${left}px, ${top}px, 0) scale(${session.ghostScaleX}, ${session.ghostScaleY})`;
    }

    function scheduleDragFrame() {
        if (!dragSession || dragFrame) return;
        dragFrame = requestAnimationFrame(processDragFrame);
    }

    function processDragFrame() {
        dragFrame = 0;
        const session = dragSession;
        if (!session || !state) return;
        updateDragGhost(session);

        const metrics = getViewportMetrics();
        const velocityX = edgeScrollVelocity(
            session.clientX,
            metrics.rect.left,
            metrics.rect.right,
            EDGE_SCROLL_ZONE,
            EDGE_SCROLL_MAX_SPEED,
        );
        const velocityY = edgeScrollVelocity(
            session.clientY,
            metrics.rect.top,
            metrics.rect.bottom,
            EDGE_SCROLL_ZONE,
            EDGE_SCROLL_MAX_SPEED,
        );
        const previousScrollLeft = scroll.scrollLeft;
        const previousScrollTop = scroll.scrollTop;
        if (velocityX) scroll.scrollLeft += velocityX / metrics.scaleX;
        if (velocityY) scroll.scrollTop += velocityY / metrics.scaleY;
        const scrolled = scroll.scrollLeft !== previousScrollLeft || scroll.scrollTop !== previousScrollTop;

        const point = clientPointToContent(
            session.clientX,
            session.clientY,
            metrics.rect,
            metrics.scaleX,
            metrics.scaleY,
            scroll.scrollLeft,
            scroll.scrollTop,
        );
        const slots = state.items.flatMap((item) => {
            const rect = session.layoutRects.get(item.id);
            return rect ? [{ id: item.id, rect }] : [];
        });
        const target = findDropTarget(slots, point, session.sourceId, GRID_GAP, GRID_GAP);
        if (!target) {
            session.lastInsertionIndex = null;
            renderDropState(null, null);
        } else {
            const sourceIndex = state.items.findIndex((item) => item.id === session.sourceId);
            const targetIndex = state.items.findIndex((item) => item.id === target.id);
            const side = resolveImmediateInsertionSide(sourceIndex, targetIndex);
            renderDropState(target.id, side);
            const insertionIndex = computeInsertionIndex(
                sourceIndex,
                targetIndex,
                side,
                state.items.length,
            );
            if (insertionIndex !== sourceIndex && insertionIndex !== session.lastInsertionIndex) {
                const [moved] = state.items.splice(sourceIndex, 1);
                state.items.splice(insertionIndex, 0, moved);
                session.lastInsertionIndex = insertionIndex;
                session.changed = true;
                animateCardsToStateOrder(session.sourceId, session);
                commit(false, false);
            } else {
                session.lastInsertionIndex = insertionIndex;
            }
        }

        if (scrolled) scheduleDragFrame();
    }

    function cleanupDragSession(session) {
        if (dragFrame) {
            cancelAnimationFrame(dragFrame);
            dragFrame = 0;
        }
        globalThis.removeEventListener("keydown", onDragKeyDown, true);
        clearDropState();
        session.card.classList.remove("cpw-prompt-grid__card--dragging");
        session.handle.removeAttribute("aria-grabbed");
        scroll.classList.remove("cpw-prompt-grid__scroll--sorting");
        grid.classList.remove("cpw-prompt-grid__cards--sorting");
        session.ghost.remove();
    }

    function endPointerDrag(cancelled, restoreState = true) {
        const session = dragSession;
        if (!session) return;

        const currentOrder = state?.items.map((item) => item.id).join("\u0000") ?? "";
        const originalOrder = session.originalItems.map((item) => item.id).join("\u0000");
        const orderChanged = currentOrder !== originalOrder;
        if (cancelled && restoreState && state && session.changed) {
            state.items = session.originalItems;
            if (orderChanged) animateCardsToStateOrder(session.sourceId, session);
            const previousValue = serializedValue;
            serializedValue = session.originalSerialized;
            if (serializedValue !== previousValue || orderChanged) {
                notifyWidgetChanged(node, widget, inputName, serializedValue, previousValue, false);
            }
        }

        dragSession = null;
        cleanupDragSession(session);
        try {
            if (session.handle.hasPointerCapture(session.pointerId)) {
                session.handle.releasePointerCapture(session.pointerId);
            }
        } catch {
            // The browser may already have released capture during cancellation.
        }
        normalizeCardDomOrder();

        if (!cancelled && session.changed && orderChanged) captureCanvasState();
    }

    function onDragKeyDown(event) {
        if (event.key !== "Escape" || !dragSession) return;
        event.preventDefault();
        event.stopPropagation();
        endPointerDrag(true);
    }

    function beginPointerDrag(event, itemId, card, handle) {
        if (!state || dragSession || event.button !== 0 || event.isPrimary === false) return;
        event.preventDefault();
        event.stopPropagation();
        closeItemContextMenu();

        for (const candidate of cardElements.values()) reorderAnimations.get(candidate)?.cancel();
        const metrics = getViewportMetrics();
        const cardRect = card.getBoundingClientRect();
        const ghost = cloneCardForDrag(card);
        ghost.style.width = `${card.offsetWidth || cardRect.width / metrics.scaleX}px`;
        ghost.style.height = `${card.offsetHeight || cardRect.height / metrics.scaleY}px`;
        document.body.append(ghost);

        dragSession = {
            pointerId: event.pointerId,
            sourceId: itemId,
            card,
            handle,
            ghost,
            ghostScaleX: metrics.scaleX,
            ghostScaleY: metrics.scaleY,
            pointerOffsetX: event.clientX - cardRect.left,
            pointerOffsetY: event.clientY - cardRect.top,
            clientX: event.clientX,
            clientY: event.clientY,
            originalItems: state.items.slice(),
            originalSerialized: serializedValue,
            layoutRects: new Map(),
            lastInsertionIndex: null,
            renderedTargetId: null,
            renderedSide: null,
            changed: false,
        };
        cacheFinalLayoutRects(dragSession);
        card.classList.add("cpw-prompt-grid__card--dragging");
        handle.setAttribute("aria-grabbed", "true");
        scroll.classList.add("cpw-prompt-grid__scroll--sorting");
        grid.classList.add("cpw-prompt-grid__cards--sorting");
        globalThis.addEventListener("keydown", onDragKeyDown, true);
        updateDragGhost(dragSession);
        try {
            handle.setPointerCapture(event.pointerId);
        } catch {
            endPointerDrag(true);
        }
    }

    function movePointerDrag(event) {
        if (!dragSession || event.pointerId !== dragSession.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        const coalesced = event.getCoalescedEvents?.();
        const latest = coalesced?.length ? coalesced[coalesced.length - 1] : event;
        dragSession.clientX = latest.clientX;
        dragSession.clientY = latest.clientY;
        scheduleDragFrame();
    }

    function finishPointerDrag(event) {
        if (!dragSession || event.pointerId !== dragSession.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        dragSession.clientX = event.clientX;
        dragSession.clientY = event.clientY;
        if (dragFrame) {
            cancelAnimationFrame(dragFrame);
            dragFrame = 0;
            processDragFrame();
        }
        endPointerDrag(false);
    }

    function cancelPointerDrag(event) {
        if (!dragSession || event.pointerId !== dragSession.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        endPointerDrag(true);
    }

    function losePointerCapture(event) {
        if (!dragSession || event.pointerId !== dragSession.pointerId) return;
        endPointerDrag(true);
    }

    function closePromptEditor(restoreFocus = true) {
        const editor = activePromptEditor;
        if (!editor) return;
        closePromptCardLibraryMenu(false);
        editor.cancelPendingAdd?.();
        activePromptEditor = null;
        editor.overlay.remove();
        if (restoreFocus) {
            queueMicrotask(() => {
                if (editor.opener.isConnected) editor.opener.focus();
            });
        }
    }

    function openPromptEditor(promptInput, itemId, opener) {
        closePromptEditor(false);
        const currentItem = state?.items.find((item) => item.id === itemId) ?? null;
        const originalPrompt = promptInput.value;
        const parsedTokens = splitPromptTokens(originalPrompt);
        const initialTokenState = reconcilePromptTokenStates(
            originalPrompt,
            currentItem?.prompt_tokens,
        );
        const initialTokens = initialTokenState.tokens;
        const initialSelected = initialTokenState.selected;
        const promptNeedsDeduplication = parsedTokens.length
            !== dedupePromptTokens(parsedTokens).length;
        let tokens = initialTokens.slice();
        let selected = initialSelected.slice();
        let retainUnselected = currentItem?.retain_unselected !== false;
        let adding = false;
        let addInput = null;
        let addButton = null;
        let addDraft = "";
        let addBlurTimer = 0;
        let editorAutocompleteController = null;
        let tokenTranslationAbortController = null;
        let tokenTranslationGeneration = 0;
        let editorDragSession = null;
        let editorResizeSession = null;
        let tokenToggleGesture = null;
        let suppressTokenClick = false;
        let suppressTokenClickTimer = 0;
        let freeMode = false;
        let freePromptText = "";
        let freeTextArea = null;
        let copyFeedbackTimer = 0;
        let copyFeedbackState = "";
        let promptRequiresRebuild = false;
        let promptFontSize = readPromptEditorFontSize();
        let editorFavoriteId = normalizePromptCardFavoriteId(currentItem?.favorite_id);
        const editorHistory = new PromptEditorHistory();
        let pendingTextHistory = null;

        const overlay = element("div", "cpw-prompt-editor__overlay");
        const dialog = element("section", "cpw-prompt-editor");
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
        dialog.style.setProperty("--cpw-prompt-editor-font-size", `${promptFontSize}px`);

        const header = element("header", "cpw-prompt-editor__header");
        const title = element("h2", "cpw-prompt-editor__title");
        const activeCount = element("span", "cpw-prompt-editor__active-count", "0");
        activeCount.setAttribute("aria-label", tp("{count} prompt active", "{count} prompts active", 0));
        title.append(t("Edit Card ("), activeCount, t(")"));
        title.id = `cpw-prompt-editor-${createId()}`;
        dialog.setAttribute("aria-labelledby", title.id);
        const headerMain = element("div", "cpw-prompt-editor__header-main");
        const freeModeLabel = element("label", "cpw-prompt-editor__free-mode");
        const freeModeInput = element("input", "cpw-prompt-editor__free-mode-input");
        freeModeInput.type = "checkbox";
        freeModeInput.checked = false;
        freeModeInput.setAttribute("aria-label", t("Text Mode"));
        const freeModeIndicator = element("span", "cpw-prompt-editor__free-mode-indicator");
        const freeModeText = element("span", "cpw-prompt-editor__free-mode-text", t("Text Mode"));
        freeModeLabel.append(freeModeInput, freeModeIndicator, freeModeText);
        const retainUnselectedLabel = element(
            "label",
            "cpw-prompt-editor__free-mode cpw-prompt-editor__retain-unselected",
        );
        const retainUnselectedInput = element(
            "input",
            "cpw-prompt-editor__free-mode-input cpw-prompt-editor__retain-unselected-input",
        );
        retainUnselectedInput.type = "checkbox";
        retainUnselectedInput.checked = retainUnselected;
        retainUnselectedInput.setAttribute("aria-label", t("Retain unselected prompts"));
        const retainUnselectedIndicator = element(
            "span",
            "cpw-prompt-editor__free-mode-indicator",
        );
        const retainUnselectedText = element(
            "span",
            "cpw-prompt-editor__free-mode-text",
            t("Retain Unselected"),
        );
        retainUnselectedLabel.append(
            retainUnselectedInput,
            retainUnselectedIndicator,
            retainUnselectedText,
        );
        const historyActions = element("div", "cpw-prompt-editor__history-actions");
        const undoButton = element(
            "button",
            "cpw-prompt-editor__history-action cpw-prompt-editor__history-action--undo",
        );
        const undoIcon = element(
            "span",
            "cpw-prompt-editor__history-icon cpw-prompt-editor__history-icon--undo",
        );
        undoButton.type = "button";
        undoButton.disabled = true;
        undoButton.append(undoIcon);
        const redoButton = element(
            "button",
            "cpw-prompt-editor__history-action cpw-prompt-editor__history-action--redo",
        );
        const redoIcon = element(
            "span",
            "cpw-prompt-editor__history-icon cpw-prompt-editor__history-icon--redo",
        );
        redoButton.type = "button";
        redoButton.disabled = true;
        redoButton.append(redoIcon);
        historyActions.append(undoButton, redoButton);
        const fontSizeControl = element("div", "cpw-prompt-editor__font-size-control");
        const fontSizeInput = element("input", "cpw-prompt-editor__font-size-input");
        fontSizeInput.type = "range";
        fontSizeInput.min = String(PROMPT_EDITOR_MIN_FONT_SIZE);
        fontSizeInput.max = String(PROMPT_EDITOR_MAX_FONT_SIZE);
        fontSizeInput.step = "1";
        fontSizeInput.value = String(promptFontSize);
        fontSizeInput.id = `cpw-prompt-editor-font-size-${createId()}`;
        fontSizeInput.setAttribute("aria-label", t("Prompt font size"));
        fontSizeInput.setAttribute("aria-valuetext", t("{size} pixels", { size: promptFontSize }));
        const fontSizeLabel = element(
            "label",
            "cpw-prompt-editor__font-size-label",
            t("Font Size"),
        );
        fontSizeLabel.htmlFor = fontSizeInput.id;
        const fontSizeValue = element(
            "output",
            "cpw-prompt-editor__font-size-value",
            `${promptFontSize}px`,
        );
        fontSizeValue.setAttribute("for", fontSizeInput.id);
        fontSizeControl.append(fontSizeLabel, fontSizeInput, fontSizeValue);
        headerMain.append(title, freeModeLabel, retainUnselectedLabel, historyActions);
        const headerActions = element("div", "cpw-prompt-editor__header-actions");
        const closeButton = element("button", "cpw-prompt-editor__close", "×");
        closeButton.type = "button";
        closeButton.title = t("Close without saving");
        closeButton.setAttribute("aria-label", t("Close the prompt editor without saving"));
        headerActions.append(fontSizeControl, closeButton);
        header.append(headerMain, headerActions);

        const content = element("div", "cpw-prompt-editor__content");
        const tokenList = element("div", "cpw-prompt-editor__tokens");
        tokenList.setAttribute("aria-label", t("Prompt tags"));
        const addStatus = element("div", "cpw-prompt-editor__add-status");
        addStatus.setAttribute("role", "status");
        addStatus.setAttribute("aria-live", "polite");
        addStatus.hidden = true;
        content.append(tokenList, addStatus);

        const footer = element("footer", "cpw-prompt-editor__footer");
        const selectionActions = element("div", "cpw-prompt-editor__selection-actions");
        const enableAllButton = element("button", "cpw-prompt-editor__action", t("Enable All"));
        const disableAllButton = element("button", "cpw-prompt-editor__action", t("Disable All"));
        const confirmButton = element(
            "button",
            "cpw-prompt-editor__action cpw-prompt-editor__action--primary",
            t("Confirm"),
        );
        const copyButton = element(
            "button",
            "cpw-prompt-editor__action cpw-prompt-editor__action--copy",
            t("Copy"),
        );
        enableAllButton.type = "button";
        enableAllButton.title = t("Enable all prompts");
        disableAllButton.type = "button";
        disableAllButton.title = t("Disable all prompts");
        copyButton.type = "button";
        copyButton.title = t("Copy current prompt");
        copyButton.setAttribute("aria-label", t("Copy current prompt"));
        copyButton.setAttribute("aria-live", "polite");
        confirmButton.type = "button";
        selectionActions.append(enableAllButton, disableAllButton);
        const favoriteActions = element("div", "cpw-prompt-editor__favorite-actions");
        const favoriteCardsButton = element(
            "button",
            "cpw-prompt-editor__action cpw-prompt-editor__action--favorites",
        );
        favoriteCardsButton.type = "button";
        favoriteCardsButton.setAttribute("aria-haspopup", "dialog");
        favoriteCardsButton.setAttribute("aria-expanded", "false");
        const favoriteCardsIcon = element("span", "cpw-prompt-editor__favorite-icon");
        const favoriteCardsText = element("span", "", t("Favorites"));
        favoriteCardsButton.append(favoriteCardsIcon, favoriteCardsText);
        favoriteCardsButton.title = t("Save or manage this card's favorite");
        favoriteCardsButton.setAttribute("aria-label", t("Save or manage this card's favorite"));
        favoriteActions.append(favoriteCardsButton);
        const commitActions = element("div", "cpw-prompt-editor__commit-actions");
        commitActions.append(copyButton, confirmButton);
        footer.append(selectionActions, favoriteActions, commitActions);
        const resizeHandle = element("div", "cpw-prompt-editor__resize-handle");
        resizeHandle.setAttribute("role", "separator");
        resizeHandle.setAttribute("aria-label", t("Resize the prompt editor"));
        dialog.append(header, content, footer, resizeHandle);
        overlay.append(dialog);

        fontSizeInput.addEventListener("input", (event) => {
            promptFontSize = normalizeStoredPromptEditorFontSize(event.currentTarget.value);
            fontSizeInput.value = String(promptFontSize);
            fontSizeInput.setAttribute("aria-valuetext", t("{size} pixels", { size: promptFontSize }));
            fontSizeValue.textContent = `${promptFontSize}px`;
            dialog.style.setProperty("--cpw-prompt-editor-font-size", `${promptFontSize}px`);
            persistPromptEditorFontSize(promptFontSize);
        });

        const clearAddBlurTimer = () => {
            if (!addBlurTimer) return;
            clearTimeout(addBlurTimer);
            addBlurTimer = 0;
        };
        const setAddStatus = (message) => {
            addStatus.textContent = message || "";
            addStatus.hidden = !message;
        };
        const clearCopyFeedbackTimer = () => {
            if (!copyFeedbackTimer) return;
            clearTimeout(copyFeedbackTimer);
            copyFeedbackTimer = 0;
        };
        const renderCopyButton = () => {
            copyButton.textContent = t(copyFeedbackState || "Copy");
            copyButton.title = t("Copy current prompt");
            copyButton.setAttribute(
                "aria-label",
                t(copyFeedbackState || "Copy current prompt"),
            );
            copyButton.classList.toggle(
                "cpw-prompt-editor__action--copy-success",
                copyFeedbackState === "Copied",
            );
            copyButton.classList.toggle(
                "cpw-prompt-editor__action--copy-error",
                copyFeedbackState === "Copy failed",
            );
        };
        const showCopyFeedback = (state) => {
            clearCopyFeedbackTimer();
            copyFeedbackState = state;
            renderCopyButton();
            copyFeedbackTimer = window.setTimeout(() => {
                copyFeedbackTimer = 0;
                copyFeedbackState = "";
                renderCopyButton();
            }, 1400);
        };
        const refreshModeControlHints = () => {
            const textModeHint = t(freeMode
                ? "Press Tab to switch to Tag Mode"
                : "Press Tab to switch to Text Mode");
            freeModeLabel.title = textModeHint;
            freeModeInput.setAttribute("aria-description", textModeHint);
            const retainUnselectedHint = t(retainUnselected
                ? "Unselected prompts will be retained"
                : "Unselected prompts will be removed");
            retainUnselectedLabel.title = retainUnselectedHint;
            retainUnselectedInput.setAttribute("aria-description", retainUnselectedHint);
        };
        const refreshHistoryActionLabels = () => {
            const undoLabel = t("Undo");
            undoButton.dataset.tooltip = undoLabel;
            undoButton.setAttribute("aria-label", undoLabel);
            const redoLabel = t("Redo");
            redoButton.dataset.tooltip = redoLabel;
            redoButton.setAttribute("aria-label", redoLabel);
        };
        const syncHistoryActions = () => {
            const hasPendingTextEdit = pendingTextHistory?.dirty === true;
            undoButton.disabled = !editorHistory.canUndo && !hasPendingTextEdit;
            redoButton.disabled = !editorHistory.canRedo || hasPendingTextEdit;
        };
        refreshModeControlHints();
        refreshHistoryActionLabels();
        syncHistoryActions();
        const handleSuggestionAnchorChange = () => editorAutocompleteController?.position();
        const applyPromptEditorSize = (size) => {
            dialog.style.width = `${size.width}px`;
            dialog.style.height = `${size.height}px`;
        };
        const applyPromptEditorPosition = (position) => {
            dialog.style.left = `${position.left}px`;
            dialog.style.top = `${position.top}px`;
        };
        const initializePromptEditorWindow = () => {
            const defaultRect = dialog.getBoundingClientRect();
            const metrics = promptEditorViewportMetrics();
            const size = normalizePromptEditorSize(readPromptEditorSize(), metrics)
                ?? normalizePromptEditorSize(defaultRect, metrics);
            if (!size) return;
            const position = clampPromptEditorPosition({
                left: (metrics.viewportWidth - size.width) / 2,
                top: (metrics.viewportHeight - size.height) / 2,
                ...size,
            }, metrics);
            if (!position) return;
            dialog.classList.add("cpw-prompt-editor--positioned");
            applyPromptEditorSize(size);
            applyPromptEditorPosition(position);
        };
        const handlePromptEditorViewportResize = () => {
            if (!dialog.classList.contains("cpw-prompt-editor--positioned")) return;
            const metrics = promptEditorViewportMetrics();
            const rect = dialog.getBoundingClientRect();
            const size = normalizePromptEditorSize(rect, metrics);
            if (!size) return;
            const position = clampPromptEditorPosition({
                left: rect.left,
                top: rect.top,
                ...size,
            }, metrics);
            applyPromptEditorSize(size);
            if (position) applyPromptEditorPosition(position);
            handleSuggestionAnchorChange();
        };
        const beginPromptEditorDrag = (event) => {
            if (
                event.button !== 0
                || editorDragSession
                || editorResizeSession
                || event.target.closest?.(
                    ".cpw-prompt-editor__free-mode, .cpw-prompt-editor__font-size-control, button, input, textarea, select",
                )
            ) return;
            const rect = dialog.getBoundingClientRect();
            editorDragSession = {
                pointerId: event.pointerId,
                offsetX: event.clientX - rect.left,
                offsetY: event.clientY - rect.top,
                width: rect.width,
                height: rect.height,
            };
            dialog.classList.add("cpw-prompt-editor--dragging");
            event.preventDefault();
            header.setPointerCapture(event.pointerId);
        };
        const movePromptEditorDrag = (event) => {
            if (!editorDragSession || event.pointerId !== editorDragSession.pointerId) return;
            const position = clampPromptEditorPosition({
                left: event.clientX - editorDragSession.offsetX,
                top: event.clientY - editorDragSession.offsetY,
                width: editorDragSession.width,
                height: editorDragSession.height,
            }, promptEditorViewportMetrics());
            if (position) applyPromptEditorPosition(position);
            handleSuggestionAnchorChange();
            event.preventDefault();
        };
        const endPromptEditorDrag = (event) => {
            if (!editorDragSession || event.pointerId !== editorDragSession.pointerId) return;
            const pointerId = editorDragSession.pointerId;
            editorDragSession = null;
            dialog.classList.remove("cpw-prompt-editor--dragging");
            if (header.hasPointerCapture(pointerId)) header.releasePointerCapture(pointerId);
            event.preventDefault();
        };
        const beginPromptEditorResize = (event) => {
            if (event.button !== 0 || editorDragSession || editorResizeSession) return;
            const rect = dialog.getBoundingClientRect();
            editorResizeSession = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                startWidth: rect.width,
                startHeight: rect.height,
                left: rect.left,
                top: rect.top,
            };
            dialog.classList.add("cpw-prompt-editor--resizing");
            event.preventDefault();
            resizeHandle.setPointerCapture(event.pointerId);
        };
        const movePromptEditorResize = (event) => {
            if (!editorResizeSession || event.pointerId !== editorResizeSession.pointerId) return;
            const metrics = promptEditorViewportMetrics();
            const maxWidth = Math.max(1, metrics.viewportWidth - editorResizeSession.left - metrics.margin);
            const maxHeight = Math.max(1, metrics.viewportHeight - editorResizeSession.top - metrics.margin);
            const minWidth = Math.min(PROMPT_EDITOR_MIN_WIDTH, maxWidth);
            const minHeight = Math.min(PROMPT_EDITOR_MIN_HEIGHT, maxHeight);
            applyPromptEditorSize({
                width: Math.round(Math.min(
                    maxWidth,
                    Math.max(minWidth, editorResizeSession.startWidth + event.clientX - editorResizeSession.startX),
                )),
                height: Math.round(Math.min(
                    maxHeight,
                    Math.max(minHeight, editorResizeSession.startHeight + event.clientY - editorResizeSession.startY),
                )),
            });
            handleSuggestionAnchorChange();
            event.preventDefault();
        };
        const endPromptEditorResize = (event) => {
            if (!editorResizeSession || event.pointerId !== editorResizeSession.pointerId) return;
            const pointerId = editorResizeSession.pointerId;
            editorResizeSession = null;
            dialog.classList.remove("cpw-prompt-editor--resizing");
            if (resizeHandle.hasPointerCapture(pointerId)) resizeHandle.releasePointerCapture(pointerId);
            persistPromptEditorSize(dialog.getBoundingClientRect());
            event.preventDefault();
        };
        const renderActivePromptCount = () => {
            const count = freeMode
                ? promptSelectionFromFreeText(freePromptText).tokens.length
                : countActivePromptTokens(selected);
            activeCount.textContent = String(count);
            activeCount.setAttribute(
                "aria-label",
                tp("{count} prompt active", "{count} prompts active", count),
            );
        };
        const currentPromptTokenStates = () => tokens.map((text, index) => ({
            text,
            selected: Boolean(selected[index]),
        }));
        const inactivePromptTokenIndexes = () => tokens
            .map((_token, index) => index)
            .filter((index) => !selected[index]);
        const promptTokenIndexFromElement = (target) => {
            const button = target?.closest?.(".cpw-prompt-editor__token");
            if (!button || !tokenList.contains(button)) return -1;
            const index = Number(button.dataset.promptTokenIndex);
            return Number.isInteger(index) ? index : -1;
        };
        const syncPromptTokenButton = (index) => {
            const button = tokenList.querySelector(
                `.cpw-prompt-editor__token[data-prompt-token-index="${index}"]`,
            );
            if (!button) return;
            button.classList.toggle("cpw-prompt-editor__token--inactive", !selected[index]);
            button.setAttribute("aria-pressed", String(Boolean(selected[index])));
            const removeButton = tokenList.querySelector(
                `.cpw-prompt-editor__token-shell[data-prompt-token-index="${index}"] `
                + ".cpw-prompt-editor__token-remove",
            );
            if (removeButton) removeButton.hidden = !retainUnselected || Boolean(selected[index]);
        };
        const togglePromptTokenAt = (
            index,
            visitedIndexes = new Set(),
            { recordHistory = true } = {},
        ) => {
            const historySnapshot = recordHistory ? capturePromptContentSnapshot() : null;
            if (!togglePromptTokenOnce(selected, index, visitedIndexes)) return false;
            syncPromptTokenButton(index);
            renderActivePromptCount();
            if (recordHistory) recordPromptContentChange(historySnapshot);
            return true;
        };
        const removeDraftPromptToken = (index, { render = true } = {}) => {
            const token = tokens[index];
            if (selected[index]) return false;
            const historySnapshot = capturePromptContentSnapshot();
            const result = removePromptToken(tokens, selected, index);
            if (!result.removed) return false;
            tokens = result.tokens;
            selected = result.selected;
            if (render) renderTokens();
            else renderActivePromptCount();
            setAddStatus(t("Removed {prompt}.", { prompt: token }));
            recordPromptContentChange(historySnapshot);
            return true;
        };
        const clearTokenClickSuppressionTimer = () => {
            if (!suppressTokenClickTimer) return;
            clearTimeout(suppressTokenClickTimer);
            suppressTokenClickTimer = 0;
        };
        const scheduleTokenClickSuppressionEnd = () => {
            clearTokenClickSuppressionTimer();
            suppressTokenClickTimer = setTimeout(() => {
                suppressTokenClickTimer = 0;
                suppressTokenClick = false;
            }, 0);
        };
        const tokenAtPoint = (clientX, clientY) => promptTokenIndexFromElement(
            document.elementFromPoint(clientX, clientY),
        );
        const togglePromptTokensAlongSegment = (fromX, fromY, toX, toY, visitedIndexes) => {
            const distance = Math.hypot(toX - fromX, toY - fromY);
            const steps = Math.max(1, Math.ceil(distance / PROMPT_TOKEN_GESTURE_SAMPLE_STEP));
            for (let step = 1; step <= steps; step += 1) {
                const ratio = step / steps;
                togglePromptTokenAt(
                    tokenAtPoint(
                        fromX + (toX - fromX) * ratio,
                        fromY + (toY - fromY) * ratio,
                    ),
                    visitedIndexes,
                    { recordHistory: false },
                );
            }
        };
        const cleanupPromptTokenToggleGesture = () => {
            const gesture = tokenToggleGesture;
            tokenToggleGesture = null;
            tokenList.classList.remove("cpw-prompt-editor__tokens--toggling");
            if (gesture && tokenList.hasPointerCapture(gesture.pointerId)) {
                tokenList.releasePointerCapture(gesture.pointerId);
            }
            return gesture;
        };
        const beginPromptTokenToggleGesture = (event) => {
            if (event.button !== 0 || event.isPrimary === false || tokenToggleGesture) return;
            const index = promptTokenIndexFromElement(event.target);
            if (index < 0) return;
            const visitedIndexes = new Set();
            const historySnapshot = capturePromptContentSnapshot();
            if (!togglePromptTokenAt(index, visitedIndexes, { recordHistory: false })) return;
            clearTokenClickSuppressionTimer();
            suppressTokenClick = true;
            tokenToggleGesture = {
                pointerId: event.pointerId,
                visitedIndexes,
                historySnapshot,
                lastX: event.clientX,
                lastY: event.clientY,
            };
            tokenList.classList.add("cpw-prompt-editor__tokens--toggling");
            event.target.closest?.(".cpw-prompt-editor__token")?.focus({ preventScroll: true });
            event.preventDefault();
            try {
                tokenList.setPointerCapture(event.pointerId);
            } catch {
                const gesture = cleanupPromptTokenToggleGesture();
                recordPromptContentChange(gesture?.historySnapshot);
                scheduleTokenClickSuppressionEnd();
            }
        };
        const movePromptTokenToggleGesture = (event) => {
            const gesture = tokenToggleGesture;
            if (!gesture || event.pointerId !== gesture.pointerId) return;
            const coalesced = event.getCoalescedEvents?.();
            const points = coalesced?.length ? coalesced : [event];
            for (const point of points) {
                togglePromptTokensAlongSegment(
                    gesture.lastX,
                    gesture.lastY,
                    point.clientX,
                    point.clientY,
                    gesture.visitedIndexes,
                );
                gesture.lastX = point.clientX;
                gesture.lastY = point.clientY;
            }
            event.preventDefault();
        };
        const endPromptTokenToggleGesture = (event) => {
            if (!tokenToggleGesture || event.pointerId !== tokenToggleGesture.pointerId) return;
            const gesture = cleanupPromptTokenToggleGesture();
            recordPromptContentChange(gesture?.historySnapshot);
            scheduleTokenClickSuppressionEnd();
            event.preventDefault();
        };
        const cancelPromptTokenTranslations = () => {
            tokenTranslationGeneration += 1;
            tokenTranslationAbortController?.abort();
            tokenTranslationAbortController = null;
        };
        const resolvePromptTokenTranslations = async () => {
            cancelPromptTokenTranslations();
            if (freeMode || !tokens.length) return;
            for (const button of tokenList.querySelectorAll(".cpw-prompt-editor__token")) {
                const token = tokens[Number(button.dataset.promptTokenIndex)] || "";
                const translationLine = button.querySelector(".cpw-prompt-editor__token-translation");
                if (translationLine) translationLine.textContent = "—";
                button.title = token;
                button.setAttribute("aria-label", token);
            }
            const generation = tokenTranslationGeneration;
            const controller = new AbortController();
            tokenTranslationAbortController = controller;
            const pending = [];
            for (let index = 0; index < tokens.length; index += 1) {
                const token = tokens[index];
                if (promptTokenHasHanText(token)) continue;
                const lookupText = promptTokenLookupText(token);
                if (lookupText) pending.push({ index, lookupText, token });
            }
            if (!pending.length) {
                tokenTranslationAbortController = null;
                return;
            }
            try {
                const results = await promptTagAutocompleteProvider.resolveTagTranslations(
                    pending.map((entry) => entry.lookupText),
                    "zh-CN",
                    { signal: controller.signal },
                );
                if (controller.signal.aborted || generation !== tokenTranslationGeneration) return;
                for (let resultIndex = 0; resultIndex < pending.length; resultIndex += 1) {
                    const { index, token } = pending[resultIndex];
                    const button = tokenList.querySelector(
                        `.cpw-prompt-editor__token[data-prompt-token-index="${index}"]`,
                    );
                    if (!button) continue;
                    const translation = autocompleteTranslationText(results[resultIndex]);
                    const translationLine = button.querySelector(".cpw-prompt-editor__token-translation");
                    if (translationLine) translationLine.textContent = translation;
                    button.title = translation === "—" ? token : `${token}\n${translation}`;
                    button.setAttribute(
                        "aria-label",
                        translation === "—" ? token : `${token}, ${translation}`,
                    );
                }
            } catch (error) {
                if (error?.name !== "AbortError") {
                    console.warn("[Prompt Weaver] Could not resolve prompt tag translations", error);
                }
            } finally {
                if (tokenTranslationAbortController === controller) {
                    tokenTranslationAbortController = null;
                }
            }
        };
        const handlePromptTokenTranslationSettings = () => {
            if (!freeMode) void resolvePromptTokenTranslations();
        };
        const renderTokens = ({
            focusInput = false,
            focusAddButton = false,
            focusFreeText = false,
            focusTagMode = false,
        } = {}) => {
            cancelPromptTokenTranslations();
            renderActivePromptCount();
            editorAutocompleteController?.destroy();
            editorAutocompleteController = null;
            tokenList.replaceChildren();
            addInput = null;
            addButton = null;
            freeTextArea = null;
            enableAllButton.disabled = freeMode;
            disableAllButton.disabled = freeMode;
            tokenList.classList.toggle("cpw-prompt-editor__tokens--free", freeMode);
            tokenList.setAttribute(
                "aria-label",
                freeMode ? t("Text-mode prompt text") : t("Prompt tags"),
            );

            if (freeMode) {
                const freeModeContent = element("div", "cpw-prompt-editor__free-content");
                freeTextArea = element("textarea", "cpw-prompt-editor__free-text");
                freeTextArea.value = freePromptText;
                freeTextArea.placeholder = t("Enter the full prompt");
                freeTextArea.spellcheck = false;
                freeTextArea.setAttribute("aria-label", t("Text-mode prompt text"));
                freeTextArea.addEventListener("focus", (event) => beginTextHistory(event.currentTarget));
                freeTextArea.addEventListener("beforeinput", (event) => beginTextHistory(event.currentTarget));
                freeTextArea.addEventListener("input", (event) => {
                    markTextHistoryDirty(event.currentTarget);
                    freePromptText = event.currentTarget.value;
                    renderActivePromptCount();
                });
                freeTextArea.addEventListener("blur", (event) => finishTextHistory(event.currentTarget));
                freeModeContent.append(freeTextArea);
                const inactiveIndexes = inactivePromptTokenIndexes();
                if (retainUnselected && inactiveIndexes.length) {
                    const retainedSection = element(
                        "section",
                        "cpw-prompt-editor__retained-section",
                    );
                    retainedSection.setAttribute("aria-label", t("Retained unselected prompts"));
                    retainedSection.append(element(
                        "div",
                        "cpw-prompt-editor__retained-title",
                        t("Retained unselected prompts"),
                    ));
                    const retainedList = element(
                        "div",
                        "cpw-prompt-editor__retained-list",
                    );
                    for (const tokenIndex of inactiveIndexes) {
                        const token = tokens[tokenIndex];
                        const retainedTag = element(
                            "span",
                            "cpw-prompt-editor__retained-token",
                        );
                        retainedTag.dataset.promptToken = token;
                        retainedTag.append(element(
                            "span",
                            "cpw-prompt-editor__retained-token-text",
                            token,
                        ));
                        const removeButton = element(
                            "button",
                            "cpw-prompt-editor__token-remove cpw-prompt-editor__retained-remove",
                            "×",
                        );
                        removeButton.type = "button";
                        removeButton.title = t("Remove {prompt}", { prompt: token });
                        removeButton.setAttribute(
                            "aria-label",
                            t("Remove {prompt}", { prompt: token }),
                        );
                        removeButton.addEventListener("click", (event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            const currentIndex = tokens.findIndex((candidate, index) => (
                                !selected[index] && candidate === token
                            ));
                            if (!removeDraftPromptToken(currentIndex, { render: false })) return;
                            retainedTag.remove();
                            if (!retainedList.childElementCount) retainedSection.remove();
                        });
                        retainedTag.append(removeButton);
                        retainedList.append(retainedTag);
                    }
                    retainedSection.append(retainedList);
                    freeModeContent.append(retainedSection);
                }
                tokenList.append(freeModeContent);
                editorAutocompleteController = new PromptAutocompleteController(
                    freeTextArea,
                    promptTagAutocompleteProvider,
                    {
                        getLocale,
                        getLimit: readAutocompleteLimit,
                        getAnchorRect: () => textareaCaretClientRect(freeTextArea),
                        getExistingPrompt: () => freeTextArea?.value || "",
                        popupHorizontalInset: 10,
                        suppressInitialFocusSearch: true,
                        onSelect(record, context) {
                            const historySnapshot = takeTextHistorySnapshot(freeTextArea)
                                ?? capturePromptContentSnapshot();
                            const result = applyPromptCompletion(
                                freeTextArea.value,
                                context,
                                record.insertText,
                            );
                            freeTextArea.value = result.value;
                            freeTextArea.setSelectionRange?.(result.cursor, result.cursor);
                            freePromptText = result.value;
                            renderActivePromptCount();
                            recordPromptContentChange(historySnapshot);
                        },
                    },
                );
                if (focusFreeText) {
                    queueMicrotask(() => {
                        freeTextArea?.focus();
                        const cursorPosition = freeTextArea?.value.length ?? 0;
                        freeTextArea?.setSelectionRange(cursorPosition, cursorPosition);
                    });
                }
                return;
            }

            if (tokens.length) {
                for (let index = 0; index < tokens.length; index += 1) {
                    const token = tokens[index];
                    const shell = element("span", "cpw-prompt-editor__token-shell");
                    shell.dataset.promptTokenIndex = String(index);
                    const button = element(
                        "button",
                        `cpw-prompt-editor__token cpw-prompt-editor__token--color-${index % 5}`,
                    );
                    button.type = "button";
                    button.title = token;
                    button.setAttribute("aria-label", token);
                    button.dataset.promptTokenIndex = String(index);
                    button.setAttribute("aria-pressed", String(selected[index]));
                    button.classList.toggle("cpw-prompt-editor__token--inactive", !selected[index]);
                    button.append(element(
                        "span",
                        "cpw-prompt-editor__token-prompt",
                        token,
                    ));
                    button.append(element(
                        "span",
                        "cpw-prompt-editor__token-translation",
                        "—",
                    ));
                    button.addEventListener("click", (event) => {
                        if (suppressTokenClick) {
                            suppressTokenClick = false;
                            clearTokenClickSuppressionTimer();
                            event.preventDefault();
                            return;
                        }
                        togglePromptTokenAt(index);
                    });
                    const removeButton = element(
                        "button",
                        "cpw-prompt-editor__token-remove",
                        "×",
                    );
                    removeButton.type = "button";
                    removeButton.hidden = !retainUnselected || Boolean(selected[index]);
                    removeButton.title = t("Remove {prompt}", { prompt: token });
                    removeButton.setAttribute(
                        "aria-label",
                        t("Remove {prompt}", { prompt: token }),
                    );
                    removeButton.addEventListener("pointerdown", (event) => {
                        event.stopPropagation();
                    });
                    removeButton.addEventListener("click", (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        removeDraftPromptToken(index);
                    });
                    shell.append(button, removeButton);
                    tokenList.append(shell);
                }
            } else {
                tokenList.append(element(
                    "div",
                    "cpw-prompt-editor__empty",
                    t("There are no prompts. Click + to add one."),
                ));
            }

            if (adding) {
                const addComposer = element("div", "cpw-prompt-editor__add-composer");
                addInput = element("textarea", "cpw-prompt-editor__add-input");
                addInput.rows = 1;
                addInput.value = addDraft;
                addInput.placeholder = t("Enter a prompt; Chinese and English tag matching are supported");
                addInput.setAttribute("aria-label", t("Add prompt"));
                addComposer.append(addInput);
                tokenList.append(addComposer);
                addInput.addEventListener("focus", (event) => beginTextHistory(event.currentTarget));
                addInput.addEventListener("beforeinput", (event) => beginTextHistory(event.currentTarget));
                addInput.addEventListener("input", (event) => {
                    markTextHistoryDirty(event.currentTarget);
                    addDraft = event.currentTarget.value;
                });
                editorAutocompleteController = new PromptAutocompleteController(
                    addInput,
                    promptTagAutocompleteProvider,
                    {
                        getLocale,
                        getLimit: readAutocompleteLimit,
                        getExistingPrompt: () => tokens.join(", "),
                        onSelect(record) {
                            clearAddBlurTimer();
                            if (addInput) addInput.dataset.cpwSkipBlurCommit = "true";
                            const historySnapshot = takeTextHistorySnapshot(addInput)
                                ?? capturePromptContentSnapshot();
                            const result = mergePromptTokenInput(tokens, selected, record.insertText);
                            tokens = result.tokens;
                            selected = result.selected;
                            adding = true;
                            addDraft = "";
                            renderTokens({ focusInput: true });
                            setAddStatus(formatAddStatus(result, true));
                            recordPromptContentChange(historySnapshot);
                        },
                    },
                );
                addInput.addEventListener("keydown", (event) => {
                    if (event.isComposing || event.defaultPrevented) return;
                    if (event.key === "Enter") {
                        event.preventDefault();
                        event.stopPropagation();
                        commitAddInput({ focusAddButton: true });
                    } else if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        cancelAddInput();
                    }
                });
                addInput.addEventListener("blur", (event) => {
                    if (!adding || event.currentTarget.dataset.cpwSkipBlurCommit === "true") return;
                    addDraft = event.currentTarget.value;
                    clearAddBlurTimer();
                    commitAddInput({ render: false });
                    addBlurTimer = setTimeout(() => {
                        addBlurTimer = 0;
                        if (activePromptEditor?.overlay === overlay && !adding) renderTokens();
                    }, 0);
                });
            } else {
                addButton = element("button", "cpw-prompt-editor__add", "+");
                addButton.type = "button";
                addButton.title = t("Add prompt");
                addButton.setAttribute("aria-label", t("Add prompt"));
                addButton.addEventListener("click", () => {
                    adding = true;
                    addDraft = "";
                    setAddStatus("");
                    renderTokens({ focusInput: true });
                });
                tokenList.append(addButton);
            }

            void resolvePromptTokenTranslations();
            if (focusInput) queueMicrotask(() => addInput?.focus());
            if (focusAddButton) queueMicrotask(() => addButton?.focus());
            if (focusTagMode) {
                queueMicrotask(() => (
                    tokenList.querySelector(".cpw-prompt-editor__token")
                    ?? addButton
                    ?? confirmButton
                ).focus());
            }
        };
        const formatAddStatus = ({ addedCount, mergedCount, reactivatedCount }, hadInput) => {
            if (!addedCount && !mergedCount) {
                return hadInput ? t("No prompt text was detected.") : "";
            }
            const parts = [];
            if (addedCount) parts.push(t("Added {count}", { count: addedCount }));
            if (mergedCount) parts.push(t("Merged {count} duplicates", { count: mergedCount }));
            if (reactivatedCount) parts.push(t("Re-enabled {count}", { count: reactivatedCount }));
            return t("{parts}.", { parts: parts.join(t(", ")) });
        };
        function commitAddInput({ focusAddButton = false, render = true } = {}) {
            if (!adding || !addInput) return false;
            clearAddBlurTimer();
            const historySnapshot = takeTextHistorySnapshot(addInput)
                ?? capturePromptContentSnapshot();
            addDraft = addInput.value;
            const value = addDraft;
            const result = mergePromptTokenInput(tokens, selected, value);
            tokens = result.tokens;
            selected = result.selected;
            adding = false;
            addDraft = "";
            const statusMessage = formatAddStatus(result, Boolean(value.trim()));
            if (render) renderTokens({ focusAddButton });
            setAddStatus(statusMessage);
            recordPromptContentChange(historySnapshot);
            return Boolean(result.addedCount || result.mergedCount);
        }
        function cancelAddInput() {
            if (!adding) return;
            clearAddBlurTimer();
            discardTextHistory(addInput);
            adding = false;
            addDraft = "";
            setAddStatus("");
            renderTokens({ focusAddButton: true });
        }

        const promptForFreeMode = () => {
            clearAddBlurTimer();
            if (adding && addInput) commitAddInput({ render: false });
            const pendingInput = adding ? addDraft : "";
            return confirmPromptEditorDraft(
                originalPrompt,
                tokens,
                selected,
                initialSelected,
                pendingInput,
                { forceRebuild: promptNeedsDeduplication || promptRequiresRebuild },
            );
        };

        const currentPromptDraft = () => (
            freeMode
                ? (freeTextArea?.value ?? freePromptText)
                : confirmPromptEditorDraft(
                    originalPrompt,
                    tokens,
                    selected,
                    initialSelected,
                    addDraft || (adding && addInput ? addInput.value : ""),
                    { forceRebuild: promptNeedsDeduplication || promptRequiresRebuild },
                )
        );
        const currentNonFreeTokenDraft = () => {
            const pendingInput = addDraft || (adding && addInput ? addInput.value : "");
            return typeof pendingInput === "string" && pendingInput.trim()
                ? mergePromptTokenInput(tokens, selected, pendingInput)
                : { tokens: [...tokens], selected: [...selected] };
        };
        const currentStoredTokenDraft = () => (
            freeMode
                ? reconcilePromptTokenStates(
                    freeTextArea?.value ?? freePromptText,
                    currentPromptTokenStates(),
                )
                : currentNonFreeTokenDraft()
        );

        const capturePromptContentSnapshot = () => {
            const activePrompt = currentPromptDraft();
            const tokenState = freeMode
                ? reconcilePromptTokenStates(activePrompt, currentPromptTokenStates())
                : currentNonFreeTokenDraft();
            return {
                tokens: [...tokenState.tokens],
                selected: [...tokenState.selected],
                activePrompt,
                promptRequiresRebuild: Boolean(promptRequiresRebuild),
            };
        };
        const recordPromptContentChange = (previousSnapshot) => {
            if (!previousSnapshot) return false;
            const recorded = editorHistory.record(
                previousSnapshot,
                capturePromptContentSnapshot(),
            );
            syncHistoryActions();
            return recorded;
        };
        const beginTextHistory = (element) => {
            if (!element || pendingTextHistory?.element === element) return;
            pendingTextHistory = {
                element,
                snapshot: capturePromptContentSnapshot(),
                dirty: false,
            };
        };
        const markTextHistoryDirty = (element) => {
            if (pendingTextHistory?.element !== element) return;
            pendingTextHistory.dirty = true;
            syncHistoryActions();
        };
        const takeTextHistorySnapshot = (element) => {
            if (!pendingTextHistory || pendingTextHistory.element !== element) return null;
            const snapshot = pendingTextHistory.snapshot;
            pendingTextHistory = null;
            return snapshot;
        };
        const finishTextHistory = (element) => (
            recordPromptContentChange(takeTextHistorySnapshot(element))
        );
        const discardTextHistory = (element = null) => {
            if (!element || pendingTextHistory?.element === element) {
                pendingTextHistory = null;
                syncHistoryActions();
            }
        };
        const restorePromptContentSnapshot = (snapshot, { focusContent = false } = {}) => {
            if (!snapshot) return false;
            clearAddBlurTimer();
            discardTextHistory();
            cleanupPromptTokenToggleGesture();
            clearTokenClickSuppressionTimer();
            suppressTokenClick = false;
            editorAutocompleteController?.destroy();
            editorAutocompleteController = null;
            tokens = [...snapshot.tokens];
            selected = [...snapshot.selected];
            freePromptText = snapshot.activePrompt;
            promptRequiresRebuild = Boolean(snapshot.promptRequiresRebuild)
                || snapshot.activePrompt !== originalPrompt;
            adding = false;
            addDraft = "";
            setAddStatus("");
            renderTokens(freeMode
                ? { focusFreeText: focusContent }
                : { focusTagMode: focusContent });
            return true;
        };
        const undoPromptContent = ({ focusContent = false } = {}) => {
            const snapshot = editorHistory.undo(capturePromptContentSnapshot());
            syncHistoryActions();
            return restorePromptContentSnapshot(snapshot, { focusContent });
        };
        const redoPromptContent = ({ focusContent = false } = {}) => {
            const snapshot = editorHistory.redo(capturePromptContentSnapshot());
            syncHistoryActions();
            return restorePromptContentSnapshot(snapshot, { focusContent });
        };

        const currentEditorFavoriteSnapshot = () => {
            const storedDraft = currentStoredTokenDraft();
            const promptTokens = retainUnselected
                ? promptTokenStatesForStorage(storedDraft.tokens, storedDraft.selected)
                : null;
            return promptCardFavoriteSnapshot({
                title: currentItem?.title ?? "",
                prompt: currentPromptDraft(),
                color: currentItem?.color,
                retain_unselected: retainUnselected,
                prompt_tokens: promptTokens,
            });
        };

        const openEditorFavoriteMenu = () => {
            closePromptCardLibraryMenu(false);
            let controller = null;
            controller = openPromptCardLibraryMenu({
                service: promptCardLibraryService,
                anchor: favoriteCardsButton,
                mode: "assign",
                favoriteId: editorFavoriteId,
                getSnapshot: currentEditorFavoriteSnapshot,
                resolvePromptTip: resolveFavoriteCardPromptTip,
                onFavoriteLinked: (favoriteId) => {
                    editorFavoriteId = normalizePromptCardFavoriteId(favoriteId);
                },
                onClose: () => {
                    if (activePromptCardLibraryMenu === controller) {
                        activePromptCardLibraryMenu = null;
                    }
                    favoriteCardsButton.setAttribute("aria-expanded", "false");
                },
            });
            controller.anchor = favoriteCardsButton;
            activePromptCardLibraryMenu = controller;
            favoriteCardsButton.setAttribute("aria-expanded", "true");
        };

        const setFreeModeEnabled = (enabled) => {
            if (enabled === freeMode) return;
            cleanupPromptTokenToggleGesture();
            clearTokenClickSuppressionTimer();
            suppressTokenClick = false;
            editorAutocompleteController?.destroy();
            editorAutocompleteController = null;
            setAddStatus("");

            if (enabled) {
                freePromptText = promptForFreeMode();
                freeMode = true;
                freeModeInput.checked = true;
                refreshModeControlHints();
                renderTokens({ focusFreeText: true });
                return;
            }

            finishTextHistory(freeTextArea);
            freePromptText = freeTextArea?.value ?? freePromptText;
            const nextState = reconcilePromptTokenStates(
                freePromptText,
                currentPromptTokenStates(),
            );
            tokens = nextState.tokens;
            selected = nextState.selected;
            adding = false;
            addDraft = "";
            freeMode = false;
            freeModeInput.checked = false;
            promptRequiresRebuild = true;
            refreshModeControlHints();
            renderTokens({ focusTagMode: true });
            setAddStatus(tokens.length ? t("Formatted as {count} prompts.", { count: tokens.length }) : "");
        };

        const setRetainUnselectedEnabled = (enabled) => {
            retainUnselected = Boolean(enabled);
            retainUnselectedInput.checked = retainUnselected;
            refreshModeControlHints();
            renderTokens();
        };

        const setAllPromptTokensActive = (active) => {
            if (freeMode) return;
            clearAddBlurTimer();
            if (adding && addInput) commitAddInput({ render: false });
            const historySnapshot = capturePromptContentSnapshot();
            selected = setAllPromptTokenSelection(selected, active);
            renderTokens();
            setAddStatus(tokens.length
                ? (active ? t("All prompts enabled.") : t("All prompts disabled."))
                : "");
            recordPromptContentChange(historySnapshot);
        };

        const cleanupPromptEditor = () => {
            clearAddBlurTimer();
            clearCopyFeedbackTimer();
            clearTokenClickSuppressionTimer();
            discardTextHistory();
            suppressTokenClick = false;
            cleanupPromptTokenToggleGesture();
            editorAutocompleteController?.destroy();
            editorAutocompleteController = null;
            cancelPromptTokenTranslations();
            globalThis.removeEventListener(
                AUTOCOMPLETE_SETTINGS_EVENT,
                handlePromptTokenTranslationSettings,
            );
            window.removeEventListener("resize", handlePromptEditorViewportResize);
            editorHistory.clear();
            syncHistoryActions();
        };
        const refreshPromptEditorLocale = () => {
            title.childNodes[0].textContent = t("Edit Card (");
            title.childNodes[2].textContent = t(")");
            renderActivePromptCount();
            freeModeInput.setAttribute("aria-label", t("Text Mode"));
            freeModeText.textContent = t("Text Mode");
            retainUnselectedInput.setAttribute("aria-label", t("Retain unselected prompts"));
            retainUnselectedText.textContent = t("Retain Unselected");
            refreshModeControlHints();
            refreshHistoryActionLabels();
            fontSizeLabel.textContent = t("Font Size");
            fontSizeInput.setAttribute("aria-label", t("Prompt font size"));
            fontSizeInput.setAttribute("aria-valuetext", t("{size} pixels", { size: promptFontSize }));
            closeButton.title = t("Close without saving");
            closeButton.setAttribute("aria-label", t("Close the prompt editor without saving"));
            enableAllButton.textContent = t("Enable All");
            disableAllButton.textContent = t("Disable All");
            enableAllButton.title = t("Enable all prompts");
            disableAllButton.title = t("Disable all prompts");
            favoriteCardsText.textContent = t("Favorites");
            favoriteCardsButton.title = t("Save or manage this card's favorite");
            favoriteCardsButton.setAttribute("aria-label", t("Save or manage this card's favorite"));
            renderCopyButton();
            confirmButton.textContent = t("Confirm");
            resizeHandle.setAttribute("aria-label", t("Resize the prompt editor"));
            tokenList.setAttribute(
                "aria-label",
                freeMode ? t("Text-mode prompt text") : t("Prompt tags"),
            );
            if (freeTextArea) {
                freeTextArea.placeholder = t("Enter the full prompt");
                freeTextArea.setAttribute("aria-label", t("Text-mode prompt text"));
            }
            if (addInput) {
                addInput.placeholder = t("Enter a prompt; Chinese and English tag matching are supported");
                addInput.setAttribute("aria-label", t("Add prompt"));
            }
            if (addButton) {
                addButton.title = t("Add prompt");
                addButton.setAttribute("aria-label", t("Add prompt"));
            }
            editorAutocompleteController?.refreshLocale();
        };
        activePromptEditor = {
            overlay,
            opener,
            cancelPendingAdd: cleanupPromptEditor,
            refreshLocale: refreshPromptEditorLocale,
        };
        window.addEventListener("resize", handlePromptEditorViewportResize);
        globalThis.addEventListener(
            AUTOCOMPLETE_SETTINGS_EVENT,
            handlePromptTokenTranslationSettings,
        );
        header.addEventListener("pointerdown", beginPromptEditorDrag);
        header.addEventListener("pointermove", movePromptEditorDrag);
        header.addEventListener("pointerup", endPromptEditorDrag);
        header.addEventListener("pointercancel", endPromptEditorDrag);
        header.addEventListener("lostpointercapture", endPromptEditorDrag);
        resizeHandle.addEventListener("pointerdown", beginPromptEditorResize);
        resizeHandle.addEventListener("pointermove", movePromptEditorResize);
        resizeHandle.addEventListener("pointerup", endPromptEditorResize);
        resizeHandle.addEventListener("pointercancel", endPromptEditorResize);
        resizeHandle.addEventListener("lostpointercapture", endPromptEditorResize);
        tokenList.addEventListener("pointerdown", beginPromptTokenToggleGesture);
        tokenList.addEventListener("pointermove", movePromptTokenToggleGesture);
        tokenList.addEventListener("pointerup", endPromptTokenToggleGesture);
        tokenList.addEventListener("pointercancel", endPromptTokenToggleGesture);
        tokenList.addEventListener("lostpointercapture", endPromptTokenToggleGesture);
        renderTokens();
        if (promptNeedsDeduplication) {
            setAddStatus(t("Automatically merged {count} duplicates.", {
                count: parsedTokens.length - initialTokens.length,
            }));
        }
        closeButton.addEventListener("click", () => closePromptEditor());
        undoButton.addEventListener("click", () => undoPromptContent());
        redoButton.addEventListener("click", () => redoPromptContent());
        enableAllButton.addEventListener("click", () => setAllPromptTokensActive(true));
        disableAllButton.addEventListener("click", () => setAllPromptTokensActive(false));
        freeModeInput.addEventListener("change", () => setFreeModeEnabled(freeModeInput.checked));
        retainUnselectedInput.addEventListener("change", () => (
            setRetainUnselectedEnabled(retainUnselectedInput.checked)
        ));
        favoriteCardsButton.addEventListener("click", openEditorFavoriteMenu);
        copyButton.addEventListener("click", async () => {
            try {
                await copyTextToClipboard(currentPromptDraft());
                showCopyFeedback("Copied");
            } catch (error) {
                console.warn("[Prompt Weaver] Could not copy the current prompt", error);
                showCopyFeedback("Copy failed");
            }
        });
        confirmButton.addEventListener("click", () => {
            clearAddBlurTimer();
            const nextPrompt = currentPromptDraft();
            const storedDraft = currentStoredTokenDraft();
            const promptTokens = retainUnselected
                ? promptTokenStatesForStorage(storedDraft.tokens, storedDraft.selected)
                : null;
            closePromptEditor();
            promptInput.value = nextPrompt;
            updatePromptEditorItem(itemId, {
                prompt: nextPrompt,
                retainUnselected,
                promptTokens,
                favoriteId: editorFavoriteId,
            });
        });
        dialog.addEventListener("keydown", (event) => {
            const shortcutModifier = event.ctrlKey || event.metaKey;
            const shortcutKey = event.key.toLowerCase();
            const undoShortcut = shortcutModifier
                && !event.altKey
                && !event.shiftKey
                && shortcutKey === "z";
            const redoShortcut = shortcutModifier
                && !event.altKey
                && (
                    (event.shiftKey && shortcutKey === "z")
                    || (!event.metaKey && !event.shiftKey && shortcutKey === "y")
                );
            if ((undoShortcut || redoShortcut) && !event.isComposing) {
                const nativeTextHistory = pendingTextHistory?.dirty === true
                    && pendingTextHistory.element === event.target
                    && (event.target === freeTextArea || event.target === addInput);
                if (nativeTextHistory) return;
                event.preventDefault();
                event.stopPropagation();
                if (redoShortcut) redoPromptContent({ focusContent: true });
                else undoPromptContent({ focusContent: true });
                return;
            }
            if (event.key === "Escape") {
                event.preventDefault();
                closePromptEditor();
                return;
            }
            if (event.key !== "Tab" || event.isComposing) return;
            if (!event.shiftKey) {
                if (event.defaultPrevented) return;
                event.preventDefault();
                event.stopPropagation();
                setFreeModeEnabled(!freeMode);
                return;
            }
            const focusable = [...dialog.querySelectorAll(
                "button:not([disabled]), input:not([disabled]), textarea:not([disabled])",
            )].filter((candidate) => candidate.tabIndex >= 0 && !candidate.hidden);
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            }
        });
        for (const eventName of [
            "pointerdown", "pointermove", "pointerup", "pointercancel", "mousedown", "click", "dblclick",
            "keydown", "keyup", "input", "change", "contextmenu",
        ]) {
            overlay.addEventListener(eventName, (event) => event.stopPropagation());
        }
        overlay.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
        document.body.append(overlay);
        initializePromptEditorWindow();
        queueMicrotask(() => (
            tokenList.querySelector(".cpw-prompt-editor__token")
            ?? addButton
            ?? confirmButton
        ).focus());
    }

    function createCard(item) {
        const card = element("article", "cpw-prompt-grid__card");
        cardElements.set(item.id, card);
        card.classList.toggle("cpw-prompt-grid__card--disabled", !item.enabled);
        applyCardColor(card, item.color);
        if (pendingFavoriteRefreshItems.delete(item.id)) {
            queueMicrotask(() => playFavoriteRefreshAnimation(item.id, card));
        }

        const header = element("div", "cpw-prompt-grid__card-header");

        const toggleLabel = element("label", "cpw-prompt-grid__switch");
        const toggle = element("input", "");
        toggle.type = "checkbox";
        toggle.checked = item.enabled;
        toggle.setAttribute("aria-label", t("Enable this prompt"));
        toggleLabel.append(toggle, element("span", "cpw-prompt-grid__switch-track"));

        const title = element("input", "cpw-prompt-grid__title");
        title.type = "text";
        title.value = item.title;
        title.placeholder = t("Prompt title");
        title.setAttribute("aria-label", t("Prompt title"));

        const titleShell = element("div", "cpw-prompt-grid__title-shell");
        const favoriteSwitchButton = element("button", "cpw-prompt-grid__favorite-switch");
        favoriteSwitchButton.type = "button";
        favoriteSwitchButton.setAttribute("aria-haspopup", "menu");
        favoriteSwitchButton.setAttribute("aria-expanded", "false");
        const favoriteSwitchLabel = t("Switch this card to a favorite");
        favoriteSwitchButton.title = favoriteSwitchLabel;
        favoriteSwitchButton.setAttribute("aria-label", favoriteSwitchLabel);
        favoriteSwitchButton.append(element("span", "cpw-prompt-grid__favorite-switch-icon"));
        titleShell.append(title, favoriteSwitchButton);
        header.append(toggleLabel, titleShell);

        const prompt = element("input", "cpw-prompt-grid__prompt");
        prompt.type = "text";
        prompt.value = item.prompt;
        prompt.placeholder = t("Enter a prompt…");
        prompt.setAttribute("aria-label", t("Prompt content"));
        const promptEditButton = element("button", "cpw-prompt-grid__prompt-edit", "✎");
        promptEditButton.type = "button";
        promptEditButton.title = t("Split and select prompts");
        promptEditButton.setAttribute("aria-label", t("Open the prompt tag editor"));
        const promptRow = element("div", "cpw-prompt-grid__prompt-row");
        promptRow.append(prompt, promptEditButton);
        card.append(header, promptRow);

        toggle.addEventListener("change", () => {
            card.classList.toggle("cpw-prompt-grid__card--disabled", !toggle.checked);
            updateItem(item.id, { enabled: toggle.checked });
        });
        title.addEventListener("input", () => updateItem(item.id, { title: title.value }, false));
        prompt.addEventListener("input", () => updateItem(item.id, { prompt: prompt.value }, false));
        title.addEventListener("change", captureCanvasState);
        prompt.addEventListener("change", captureCanvasState);
        cardAutocompleteControllers.add(new PromptAutocompleteController(
            prompt,
            promptTagAutocompleteProvider,
            {
                getLocale,
                getLimit: readAutocompleteLimit,
                getExistingPrompt: () => prompt.value,
                completionSeparator: ", ",
            },
        ));
        promptEditButton.addEventListener("click", () => openPromptEditor(prompt, item.id, promptEditButton));
        favoriteSwitchButton.addEventListener("click", () => (
            openCardFavoriteSwitchMenu(item.id, favoriteSwitchButton)
        ));
        card.addEventListener("pointerdown", (event) => {
            const interactive = event.target?.closest?.(
                'button, input, textarea, select, option, label, a, [contenteditable="true"]',
            );
            if (interactive) return;
            beginPointerDrag(event, item.id, card, card);
        });
        card.addEventListener("pointermove", movePointerDrag);
        card.addEventListener("pointerup", finishPointerDrag);
        card.addEventListener("pointercancel", cancelPointerDrag);
        card.addEventListener("lostpointercapture", losePointerCapture);
        card.addEventListener("contextmenu", (event) => openItemContextMenu(event, item, card));
        return card;
    }

    function render() {
        if (disposed) return;
        syncLocale(app);
        closePromptCardLibraryMenu(false);
        closeItemContextMenu();
        clearFavoriteRefreshTimers();
        if (activePromptEditor) closePromptEditor(false);
        if (dragSession) endPointerDrag(true);
        for (const controller of cardAutocompleteControllers) controller.destroy();
        cardAutocompleteControllers.clear();
        const invalid = Boolean(parseError) || !state;
        toolbar.hidden = invalid;
        scroll.hidden = invalid;
        errorPanel.hidden = !invalid;
        if (invalid) {
            errorMessage.textContent = parseError || t("Unknown configuration error");
            cardElements.clear();
            grid.replaceChildren();
            reconcileArchiveSelection();
            return;
        }

        columnSelect.value = String(state.columns);
        applyGridColumns();
        cardElements.clear();
        const cards = state.items.map(createCard);
        if (cards.length) {
            grid.replaceChildren(...cards);
        } else {
            grid.replaceChildren(element(
                "div",
                "cpw-prompt-grid__empty",
                t("There are no cards. Click \"Add Card\" to begin."),
            ));
        }
        reconcileArchiveSelection();
    }

    columnSelect.addEventListener("change", () => {
        if (!state) return;
        state.columns = Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, Number(columnSelect.value) || DEFAULT_COLUMNS));
        applyGridColumns();
        commit();
        scheduleNodeHeightFit();
    });
    addButton.addEventListener("click", () => {
        if (!state) return;
        state.items.push({ id: createId(), enabled: true, title: nextTitle(), prompt: "" });
        commit(true);
        scheduleNodeHeightFit();
        queueMicrotask(() => grid.querySelector(".cpw-prompt-grid__card:last-child .cpw-prompt-grid__prompt")?.focus());
    });
    enableAllButton.addEventListener("click", () => {
        if (!state) return;
        state.items = state.items.map((item) => ({ ...item, enabled: true }));
        commit(true);
    });
    disableAllButton.addEventListener("click", () => {
        if (!state) return;
        state.items = state.items.map((item) => ({ ...item, enabled: false }));
        commit(true);
    });
    archiveSelect.addEventListener("focusin", () => refreshArchives());
    archiveSelect.addEventListener("change", async () => {
        const requestedId = archiveSelect.value;
        const archive = archives.find((candidate) => candidate.id === requestedId);
        if (!archive) {
            renderArchiveSelect();
            return;
        }
        archiveSelect.disabled = true;
        try {
            await requestArchiveLoad(archive);
        } finally {
            if (!disposed) renderArchiveSelect();
        }
    });
    quickSaveArchiveButton.addEventListener("click", quickSaveActiveArchive);
    restoreArchiveButton.addEventListener("click", restoreActiveArchive);
    manageArchivesButton.addEventListener("click", openArchiveManager);
    resetButton.addEventListener("click", () => {
        state = createDefaultConfig();
        parseError = null;
        commit(true);
        scheduleNodeHeightFit();
    });

    const onArchiveSync = () => refreshArchives();
    window.addEventListener(ARCHIVE_SYNC_EVENT, onArchiveSync);

    for (const eventName of [
        "pointerdown", "pointermove", "pointerup", "pointercancel", "mousedown", "click", "dblclick",
        "keydown", "keyup", "input", "change", "contextmenu",
    ]) {
        root.addEventListener(eventName, (event) => event.stopPropagation());
    }
    root.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });

    promptGridArchiveControllers.set(node, {
        markLoaded() {
            loadedPromptGridNodes.add(node);
            reconcileLoadedArchiveAssociation();
        },
    });
    const localeController = { node, refreshLocale };
    promptGridLocaleControllers.add(localeController);
    const sizeObserver = typeof ResizeObserver === "function"
        ? new ResizeObserver(scheduleArchiveSizeReconcile)
        : null;
    sizeObserver?.observe(root);
    const previousNodeOnResize = node.onResize;
    const promptGridOnResize = function (...args) {
        const result = previousNodeOnResize?.apply(this, args);
        scheduleArchiveSizeReconcile();
        return result;
    };
    node.onResize = promptGridOnResize;
    readValue(JSON.stringify(createDefaultConfig()));
    widget = node.addDOMWidget(inputName, WIDGET_TYPE, root, {
        serialize: true,
        hideInPanel: true,
        hideOnZoom: false,
        getValue: () => serializedValue,
        setValue: (value) => {
            receivedExternalValue = true;
            closeItemContextMenu();
            if (dragSession) endPointerDrag(true);
            if (activeArchiveConfirmation) closeArchiveConfirmation(false);
            closeArchiveManager();
            readValue(value);
            reconcileLoadedArchiveAssociation();
            render();
        },
        getMinHeight: () => MIN_WIDGET_HEIGHT,
    });
    widget.inputSpec = inputData;
    const previousOnRemove = widget.onRemove;
    widget.onRemove = function (...args) {
        closePromptCardLibraryMenu(false);
        closeItemContextMenu();
        if (activePromptEditor) closePromptEditor(false);
        if (activeArchiveConfirmation) closeArchiveConfirmation(false);
        closeArchiveManager();
        if (heightFitFrame) cancelAnimationFrame(heightFitFrame);
        if (sizeReconcileFrame) cancelAnimationFrame(sizeReconcileFrame);
        clearFavoriteRefreshTimers();
        pendingFavoriteRefreshItems.clear();
        sizeObserver?.disconnect();
        for (const controller of cardAutocompleteControllers) controller.destroy();
        cardAutocompleteControllers.clear();
        if (node.onResize === promptGridOnResize) node.onResize = previousNodeOnResize;
        window.removeEventListener(ARCHIVE_SYNC_EVENT, onArchiveSync);
        columnSelect.customSelect.destroy();
        archiveSelect.customSelect.destroy();
        promptGridArchiveControllers.delete(node);
        promptGridLocaleControllers.delete(localeController);
        previousOnRemove?.apply(this, args);
        if (dragSession) endPointerDrag(true, false);
        disposed = true;
        root.replaceChildren();
    };
    render();
    refreshArchives();

    // This runs during node construction. A loaded workflow restores its saved
    // size afterwards in configure(), while a newly created node starts at the
    // intended editing size on both Legacy Canvas and Nodes 2.0.
    const currentSize = node.size ?? [0, 0];
    if (currentSize[0] < DEFAULT_NODE_SIZE[0] || currentSize[1] < DEFAULT_NODE_SIZE[1]) {
        node.setSize([
            Math.max(currentSize[0], DEFAULT_NODE_SIZE[0]),
            Math.max(currentSize[1], DEFAULT_NODE_SIZE[1]),
        ]);
    }
    return { widget, minWidth: DEFAULT_NODE_SIZE[0], minHeight: MIN_NODE_HEIGHT };
}

app.registerExtension({
    name: "ComfyUIPromptWeaver.PromptToggleGrid",
    loadedGraphNode(node) {
        if (node?.comfyClass === "PromptWeaverPromptToggleGrid"
            || node?.type === "PromptWeaverPromptToggleGrid") {
            loadedPromptGridNodes.add(node);
            promptGridArchiveControllers.get(node)?.markLoaded();
        }
    },
    getCustomWidgets() {
        return {
            [WIDGET_TYPE]: createPromptGridWidget,
        };
    },
});
