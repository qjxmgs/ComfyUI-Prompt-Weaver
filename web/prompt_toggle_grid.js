import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
    DEFAULT_ARCHIVE_ID,
    DEFAULT_ARCHIVE_NAME,
    PromptGridArchiveClient,
    applyArchiveManagerSelectionGesture,
    archiveManagerSelectionAvailability,
    buildArchiveExportBundle,
    canQuickSaveArchive,
    canRestoreArchive,
    configFromArchiveSnapshot,
    defaultArchiveName,
    formatArchiveOptionLabel,
    normalizeArchiveNodeSize,
    normalizeArchiveManagerSelection,
    resolveArchiveInitialization,
    resolveArchiveStatus,
    snapshotFromState,
    validateImportBundlePreview,
} from "./prompt_grid_archives.js?v=20260812-manager-load";
import {
    confirmPromptEditorDraft,
    dedupePromptTokens,
    mergePromptTokenInput,
    setAllPromptTokenSelection,
    splitPromptTokens,
    togglePromptTokenOnce,
} from "./prompt_editor_tokens.js?v=20260812-toggle-paint";
import {
    clampPromptEditorPosition,
    countActivePromptTokens,
    normalizePromptEditorSize,
} from "./prompt_editor_window.js?v=20260812-resizable-editor";
import {
    PromptAssistantTagCatalog,
    formatPromptAssistantTagOption,
    movePromptAssistantSuggestionIndex,
    searchPromptAssistantTags,
} from "./prompt_assistant_tags.js?v=20260811-tag-autocomplete-v2";
import {
    calculateFittedNodeHeight,
    clientPointToContent,
    clientRectToContent,
    computeInsertionIndex,
    edgeScrollVelocity,
    findDropTarget,
    resolveImmediateInsertionSide,
} from "./prompt_grid_reorder.js";

const WIDGET_TYPE = "PROMPT_WEAVER_PROMPT_GRID";
const CONFIG_VERSION = 1;
const DEFAULT_COLUMNS = 2;
const DEFAULT_CARD_COUNT = 4;
const MIN_COLUMNS = 1;
const MAX_COLUMNS = 6;
const DEFAULT_NODE_SIZE = [600, 420];
const NODE_CHROME_HEIGHT = 74;
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
const PROMPT_EDITOR_VIEWPORT_MARGIN = 16;
const PROMPT_EDITOR_MIN_WIDTH = 360;
const PROMPT_EDITOR_MIN_HEIGHT = 240;
const PROMPT_TOKEN_GESTURE_SAMPLE_STEP = 6;

const archiveClient = new PromptGridArchiveClient(api);
const promptAssistantTagCatalog = new PromptAssistantTagCatalog(api, {
    onDiagnostic(message, error) {
        console.warn(`[Prompt Weaver] ${message}`, error || "");
    },
});
const loadedPromptGridNodes = new WeakSet();
const promptGridArchiveControllers = new WeakMap();
const archiveChannel = typeof BroadcastChannel === "function"
    ? new BroadcastChannel(ARCHIVE_CHANNEL_NAME)
    : null;

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

function createId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    fallbackId += 1;
    return `prompt-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
}

function createDefaultConfig() {
    return {
        version: CONFIG_VERSION,
        columns: DEFAULT_COLUMNS,
        items: Array.from({ length: DEFAULT_CARD_COUNT }, (_, index) => ({
            id: `prompt-${index + 1}`,
            enabled: true,
            title: `提示词 ${index + 1}`,
            prompt: "",
        })),
    };
}

function configError(message) {
    return new Error(`提示词网格配置错误：${message}`);
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
            throw configError(`JSON 无法解析（${error.message}）`);
        }
    }

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw configError("顶层值必须是对象");
    }

    const hasVersion = Object.prototype.hasOwnProperty.call(raw, "version");
    const version = hasVersion ? raw.version : CONFIG_VERSION;
    if (typeof version !== "number" || !Number.isFinite(version) || version !== CONFIG_VERSION) {
        throw configError(`不支持的版本 ${String(version)}`);
    }
    if (!Array.isArray(raw.items)) throw configError("items 必须是数组");

    const columns = Number.isInteger(raw.columns)
        && raw.columns >= MIN_COLUMNS
        && raw.columns <= MAX_COLUMNS
        ? raw.columns
        : DEFAULT_COLUMNS;
    let normalized = columns !== raw.columns;
    const usedIds = new Set();
    const items = raw.items.map((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw configError(`items[${index}] 必须是对象`);
        }
        const hasEnabled = Object.prototype.hasOwnProperty.call(item, "enabled");
        if (hasEnabled && typeof item.enabled !== "boolean") {
            throw configError(`items[${index}].enabled 必须是布尔值`);
        }
        const hasPrompt = Object.prototype.hasOwnProperty.call(item, "prompt");
        if (hasPrompt && typeof item.prompt !== "string") {
            throw configError(`items[${index}].prompt 必须是字符串`);
        }

        if (Object.prototype.hasOwnProperty.call(item, "id") && typeof item.id !== "string") {
            throw configError(`items[${index}].id 必须是字符串`);
        }
        if (Object.prototype.hasOwnProperty.call(item, "title") && typeof item.title !== "string") {
            throw configError(`items[${index}].title 必须是字符串`);
        }

        let id = typeof item.id === "string" && item.id.trim() ? item.id : createId();
        if (usedIds.has(id)) throw configError(`items[${index}].id 与其他卡片重复`);
        if (id !== item.id) normalized = true;
        usedIds.add(id);
        return {
            ...item,
            id,
            enabled: hasEnabled ? item.enabled : false,
            title: typeof item.title === "string" ? item.title : `提示词 ${index + 1}`,
            prompt: hasPrompt ? item.prompt : "",
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
    link.href = new URL("./prompt_toggle_grid.css?v=20260812-toggle-paint", import.meta.url).href;
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

function createPromptGridWidget(node, inputName, inputData) {
    ensureStylesheet();

    const root = element("div", "cpw-prompt-grid");
    const toolbar = element("div", "cpw-prompt-grid__toolbar");
    const columnGroup = element("div", "cpw-prompt-grid__columns");
    columnGroup.append(element("span", "", "列数"));
    const columnSelect = createCustomSelect("", "网格列数");
    columnSelect.customSelect.setOptions(
        Array.from({ length: MAX_COLUMNS - MIN_COLUMNS + 1 }, (_, index) => {
            const columns = MIN_COLUMNS + index;
            return { value: String(columns), label: String(columns) };
        }),
    );
    columnGroup.append(columnSelect);

    const archiveGroup = element("div", "cpw-prompt-grid__archives");
    const archiveSelect = createCustomSelect("cpw-prompt-grid__archive-select", "快速切换提示词存档");
    const quickSaveArchiveButton = element(
        "button",
        "cpw-prompt-grid__button cpw-prompt-grid__archive-save",
        "保存",
    );
    const restoreArchiveButton = element(
        "button",
        "cpw-prompt-grid__button cpw-prompt-grid__archive-restore",
        "还原",
    );
    const manageArchivesButton = element("button", "cpw-prompt-grid__button", "存档管理");
    quickSaveArchiveButton.type = "button";
    restoreArchiveButton.type = "button";
    manageArchivesButton.type = "button";
    archiveGroup.append(
        archiveSelect,
        quickSaveArchiveButton,
        restoreArchiveButton,
        manageArchivesButton,
    );

    const actions = element("div", "cpw-prompt-grid__actions");
    const addButton = element("button", "cpw-prompt-grid__button cpw-prompt-grid__button--primary", "＋ 新增提示词");
    const enableAllButton = element("button", "cpw-prompt-grid__button", "全开");
    const disableAllButton = element("button", "cpw-prompt-grid__button", "全关");
    for (const button of [addButton, enableAllButton, disableAllButton]) button.type = "button";
    actions.append(addButton, enableAllButton, disableAllButton);
    toolbar.append(columnGroup, archiveGroup, actions);

    const errorPanel = element("div", "cpw-prompt-grid__error");
    errorPanel.hidden = true;
    const errorTitle = element("strong", "", "配置无法读取");
    const errorMessage = element("div", "cpw-prompt-grid__error-message");
    const resetButton = element("button", "cpw-prompt-grid__button", "重置为默认");
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
    const reorderAnimations = new WeakMap();
    const archiveReorderAnimations = new WeakMap();

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
            console.warn("[Prompt Weaver] 无法保存最后选择的存档", error);
            setArchiveManagerMessage(error.message || String(error), true);
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
            quickSaveArchiveButton.title = `正在保存“${archive?.name ?? "当前存档"}”…`;
        } else if (!archive) {
            quickSaveArchiveButton.title = "当前没有可保存的关联存档";
        } else if (!archiveDirty) {
            quickSaveArchiveButton.title = `“${archive.name}”没有需要保存的变更`;
        } else {
            quickSaveArchiveButton.title = `保存当前变更到“${archive.name}”`;
        }
    }

    function renderRestoreArchiveButton() {
        const archive = archives.find((candidate) => candidate.id === activeArchiveId) ?? null;
        const enabled = canRestoreArchive(archive, {
            dirty: archiveDirty,
            hasState: Boolean(state),
            loading: archivesLoading,
            saving: archiveQuickSaveBusy,
        });
        restoreArchiveButton.disabled = !enabled;
        if (archiveQuickSaveBusy) {
            restoreArchiveButton.title = "保存完成后才能还原存档";
        } else if (!archive) {
            restoreArchiveButton.title = "当前没有可还原的关联存档";
        } else if (!archiveDirty) {
            restoreArchiveButton.title = `“${archive.name}”没有需要还原的变更`;
        } else {
            restoreArchiveButton.title = `放弃当前变更并还原到“${archive.name}”`;
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
                    archive.name,
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
            showArchiveToast("success", "存档已保存", `已保存到“${archive.name}”。`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("[Prompt Weaver] 快捷保存存档失败", error);
            showArchiveToast("error", "存档保存失败", message);
            quickSaveArchiveButton.title = `保存失败：${message}`;
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
            if (reportError) setArchiveManagerMessage(error.message || String(error), true);
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

    function askArchiveConfirmation({ title, message, confirmText = "确认", danger = false }) {
        if (activeArchiveConfirmation) closeArchiveConfirmation(false);
        return new Promise((resolve) => {
            const overlay = element("div", "cpw-archive-confirm__overlay");
            const dialog = element("section", "cpw-archive-confirm");
            dialog.setAttribute("role", "alertdialog");
            dialog.setAttribute("aria-modal", "true");
            const heading = element("h3", "cpw-archive-confirm__title", title);
            const body = element("p", "cpw-archive-confirm__message", message);
            const actionsRow = element("div", "cpw-archive-confirm__actions");
            const cancelButton = element("button", "cpw-archive-manager__button", "取消");
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
        const normalized = normalizeConfigValue(JSON.stringify(configFromArchiveSnapshot(archive.snapshot)));
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
        showArchiveToast("success", "存档已还原", `已恢复到“${archive.name}”。`);
    }

    async function requestArchiveLoad(archive) {
        if (!archive || (archive.id === activeArchiveId && !archiveDirty)) return false;
        if (archiveDirty) {
            const proceed = await askArchiveConfirmation({
                title: "放弃当前修改？",
                message: `加载“${archive.name}”会完整替换当前网格状态。`,
                confirmText: "放弃并加载",
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
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? String(value ?? "") : date.toLocaleString("zh-CN", { hour12: false });
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
            setArchiveManagerMessage("导入文件不能超过 2 MB。", true);
            return;
        }
        try {
            const bundle = JSON.parse(await file.text());
            const preview = validateImportBundlePreview(bundle);
            const policy = await askImportPolicy(preview);
            if (!policy) return;
            setArchiveManagerMessage("正在导入…");
            const result = await archiveClient.import(bundle, policy);
            await refreshArchives({ reportError: true });
            publishArchiveSync();
            setArchiveManagerMessage(
                `导入完成：新增 ${result.imported ?? 0}，覆盖 ${result.overwritten ?? 0}，跳过 ${result.skipped ?? 0}，自动重命名 ${result.renamed ?? 0}。`,
            );
        } catch (error) {
            setArchiveManagerMessage(error.message || String(error), true);
        }
    }

    function askImportPolicy(preview) {
        if (activeArchiveConfirmation) closeArchiveConfirmation(false);
        return new Promise((resolve) => {
            const overlay = element("div", "cpw-archive-confirm__overlay");
            const dialog = element("section", "cpw-archive-confirm");
            dialog.setAttribute("role", "dialog");
            dialog.setAttribute("aria-modal", "true");
            const heading = element("h3", "cpw-archive-confirm__title", "导入存档");
            const summary = element(
                "p",
                "cpw-archive-confirm__message",
                `文件包含 ${preview.archiveCount} 个存档、${preview.itemCount} 张提示词卡片。请选择同名冲突处理方式。`,
            );
            const policy = element("select", "cpw-archive-manager__input");
            for (const [value, label] of [["skip", "跳过（推荐）"], ["overwrite", "覆盖本地存档"], ["rename", "自动重命名"]]) {
                const option = element("option", "", label);
                option.value = value;
                policy.append(option);
            }
            const actionsRow = element("div", "cpw-archive-confirm__actions");
            const cancelButton = element("button", "cpw-archive-manager__button", "取消");
            const confirmButton = element("button", "cpw-archive-manager__button cpw-archive-manager__button--primary", "开始导入");
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
        setArchiveManagerMessage("正在保存…");
        try {
            const result = await operation();
            await refreshArchives({ reportError: true });
            publishArchiveSync();
            setArchiveManagerMessage(successMessage);
            return result;
        } catch (error) {
            setArchiveManagerMessage(error.message || String(error), true);
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
            setArchiveManagerMessage("请输入存档名称。", true);
            activeArchiveManager.nameInput.focus();
            return;
        }
        const existing = archives.find((archive) => archive.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase());
        let result;
        if (existing) {
            const overwrite = await askArchiveConfirmation({
                title: "保存到同名存档？",
                message: `“${existing.name}”已存在，是否将当前网格状态保存到该存档？原有内容将被替换。`,
                confirmText: "保存",
                danger: true,
            });
            if (!overwrite) return;
            result = await runArchiveMutation(
                () => archiveClient.update(existing.id, { snapshot: currentSnapshot() }),
                `已保存到“${existing.name}”。`,
            );
        } else {
            result = await runArchiveMutation(
                () => archiveClient.create(name, currentSnapshot()),
                `已保存“${name}”。`,
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
            setArchiveManagerMessage("正在保存排序…");
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
            setArchiveManagerMessage("存档顺序已保存。");
        } catch (error) {
            archives = session.originalArchives;
            renderArchiveSelect();
            renderArchiveManagerList();
            await refreshArchives();
            setArchiveManagerMessage(`排序保存失败：${error.message || String(error)}`, true);
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
            setArchiveManagerMessage("存档名称不能为空。", true);
            manager.renameInput?.focus();
            return;
        }
        const result = await runArchiveMutation(
            () => archiveClient.update(archive.id, { name: nextName }),
            `已重命名为“${nextName}”。`,
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
            title: archive.is_default ? "保存默认存档？" : "保存存档？",
            message: `是否将当前网格状态和窗口大小保存到“${archive.name}”？原有内容将被替换。`,
            confirmText: "保存",
            danger: true,
        });
        if (!save) return;
        const result = await runArchiveMutation(
            () => archiveClient.update(archive.id, { snapshot: currentSnapshot() }),
            `已保存到“${archive.name}”。`,
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
            downloadArchiveBundle([archive], `${archive.name}.prompt-grid-archives.json`);
            setArchiveManagerMessage(`已导出“${archive.name}”。`);
            return;
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        downloadArchiveBundle(
            selectedArchives,
            `prompt-grid-archives-selection-${timestamp}.json`,
        );
        setArchiveManagerMessage(`已导出 ${selectedArchives.length} 个选中存档。`);
    }

    async function deleteSelectedArchives() {
        const manager = activeArchiveManager;
        const selectedArchives = selectedArchivesForManager(manager);
        if (!manager || !selectedArchives.length || manager.busy || manager.dragSession) return;
        if (selectedArchives.some((archive) => archive.is_default || archive.id === DEFAULT_ARCHIVE_ID)) {
            setArchiveManagerMessage("默认存档不能删除。", true);
            return;
        }
        const nameSummary = selectedArchives
            .slice(0, 5)
            .map((archive) => `“${archive.name}”`)
            .join("、");
        const extraCount = Math.max(0, selectedArchives.length - 5);
        const remove = await askArchiveConfirmation({
            title: selectedArchives.length === 1 ? "删除存档？" : `删除 ${selectedArchives.length} 个存档？`,
            message: `${nameSummary}${extraCount ? ` 等 ${selectedArchives.length} 个存档` : ""}删除后无法恢复，当前节点状态不会改变。`,
            confirmText: "删除",
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
                ? `已删除“${selectedArchives[0].name}”。`
                : `已删除 ${selectedIds.length} 个存档。`,
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
            const cancelButton = element("button", "cpw-archive-manager__button", "取消");
            const saveNameButton = element(
                "button",
                "cpw-archive-manager__button cpw-archive-manager__button--primary",
                "保存名称",
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
            ["保存", "将当前网格状态保存到所选存档", availability.save, saveSelectedArchive],
            ["加载", "加载所选存档", availability.load, loadSelectedArchive],
            [
                "重命名",
                archive?.is_default ? "默认存档不能重命名" : "重命名所选存档",
                availability.rename,
                beginArchiveRename,
            ],
            ["导出", "导出选中的存档", availability.export, exportSelectedArchives],
            [
                "删除",
                selectedArchives.some((item) => item.is_default || item.id === DEFAULT_ARCHIVE_ID)
                    ? "默认存档不能删除"
                    : "删除选中的存档",
                availability.delete,
                deleteSelectedArchives,
            ],
        ];
        for (const [label, title, enabled, handler] of definitions) {
            const button = element(
                "button",
                `cpw-archive-manager__button${label === "删除" ? " cpw-archive-manager__button--danger-text" : ""}`,
                label,
            );
            button.type = "button";
            button.title = selectedArchives.length ? title : "请先选择存档";
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
            manager.list.append(element("div", "cpw-archive-manager__empty", "还没有存档。可在上方新建存档。"));
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
            const row = element("article", "cpw-archive-manager__row");
            row.dataset.archiveId = archive.id;
            row.dataset.archiveDefault = String(Boolean(archive.is_default));
            row.tabIndex = 0;
            row.setAttribute("role", "option");
            row.setAttribute("aria-label", `${archive.name}存档`);
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
                dragControl.title = "拖拽调整存档顺序";
                dragControl.setAttribute("aria-label", `拖拽“${archive.name}”调整顺序`);
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
            const name = element("strong", "cpw-archive-manager__row-name", archive.name);
            const nameRow = element("div", "cpw-archive-manager__row-name-line");
            nameRow.append(name);
            if (archive.is_default) {
                nameRow.append(element("span", "cpw-archive-manager__default-badge", "默认"));
            }
            if (archive.id === activeArchiveId) {
                nameRow.append(element("span", "cpw-archive-manager__current-badge", "当前"));
            }
            const enabledCount = archive.snapshot.items.filter((item) => item.enabled).length;
            const meta = element(
                "span",
                "cpw-archive-manager__row-meta",
                `${archive.snapshot.columns} 列 · ${archive.snapshot.items.length} 张卡片 · ${enabledCount} 张启用 · ${archive.snapshot.node_size.width}×${archive.snapshot.node_size.height} · ${formatArchiveTime(archive.updated_at)}`,
            );
            main.append(nameRow, meta);

            if (!archive.is_default && manager.renameId === archive.id) {
                const renameInput = element("input", "cpw-archive-manager__input cpw-archive-manager__rename-input");
                renameInput.type = "text";
                renameInput.maxLength = 80;
                renameInput.value = archive.name;
                renameInput.setAttribute("aria-label", "新的存档名称");
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
        dialog.setAttribute("aria-label", "提示词网格存档管理");

        const header = element("header", "cpw-archive-manager__header");
        const title = element("h2", "cpw-archive-manager__title", "提示词网格存档");
        const closeButton = element("button", "cpw-archive-manager__close", "×");
        closeButton.type = "button";
        closeButton.title = "关闭";
        closeButton.setAttribute("aria-label", "关闭存档管理");
        header.append(title, closeButton);

        const saveRow = element("div", "cpw-archive-manager__save-row");
        const nameInput = element("input", "cpw-archive-manager__input");
        nameInput.type = "text";
        nameInput.maxLength = 80;
        nameInput.value = defaultArchiveName();
        nameInput.placeholder = "存档名称";
        nameInput.setAttribute("aria-label", "新存档名称");
        const saveButton = element("button", "cpw-archive-manager__button cpw-archive-manager__button--primary", "新建存档");
        saveButton.type = "button";
        saveRow.append(nameInput, saveButton);

        const message = element("div", "cpw-archive-manager__message");
        message.hidden = true;
        const list = element("div", "cpw-archive-manager__list");
        list.setAttribute("role", "listbox");
        list.setAttribute("aria-label", "存档列表");
        list.setAttribute("aria-multiselectable", "true");
        const footer = element("footer", "cpw-archive-manager__footer");
        const importButton = element("button", "cpw-archive-manager__button", "导入存档");
        const exportAllButton = element("button", "cpw-archive-manager__button", "导出全部");
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
                setArchiveManagerMessage("当前没有可导出的存档。", true);
                return;
            }
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            downloadArchiveBundle(archives, `prompt-grid-archives-${timestamp}.json`);
            setArchiveManagerMessage(`已导出 ${archives.length} 个存档。`);
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
            const match = /^提示词\s+(\d+)$/.exec(item.title.trim());
            if (match) highest = Math.max(highest, Number(match[1]));
        }
        return `提示词 ${highest + 1}`;
    }

    function updateItem(id, patch, captureHistory = true) {
        if (!state) return;
        const index = state.items.findIndex((item) => item.id === id);
        if (index < 0) return;
        state.items[index] = { ...state.items[index], ...patch };
        commit(false, captureHistory);
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
        const originalPrompt = promptInput.value;
        const parsedTokens = splitPromptTokens(originalPrompt);
        const initialTokens = dedupePromptTokens(parsedTokens);
        const promptNeedsDeduplication = parsedTokens.length !== initialTokens.length;
        const initialSelected = initialTokens.map(() => true);
        let tokens = initialTokens.slice();
        let selected = initialSelected.slice();
        let adding = false;
        let addInput = null;
        let addButton = null;
        let addDraft = "";
        let addBlurTimer = 0;
        let suggestionList = null;
        let suggestionResults = [];
        let activeSuggestionIndex = -1;
        let tagCatalogRecords = [];
        let editorDragSession = null;
        let editorResizeSession = null;
        let tokenToggleGesture = null;
        let suppressTokenClick = false;
        let suppressTokenClickTimer = 0;

        const overlay = element("div", "cpw-prompt-editor__overlay");
        const dialog = element("section", "cpw-prompt-editor");
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");

        const header = element("header", "cpw-prompt-editor__header");
        const title = element("h2", "cpw-prompt-editor__title");
        const activeCount = element("span", "cpw-prompt-editor__active-count", "0");
        activeCount.setAttribute("aria-label", "当前激活 0 个提示词");
        title.append("编辑提示词（", activeCount, "）");
        title.id = `cpw-prompt-editor-${createId()}`;
        dialog.setAttribute("aria-labelledby", title.id);
        const closeButton = element("button", "cpw-prompt-editor__close", "×");
        closeButton.type = "button";
        closeButton.title = "关闭且不保存";
        closeButton.setAttribute("aria-label", "关闭提示词编辑窗口且不保存");
        header.append(title, closeButton);

        const content = element("div", "cpw-prompt-editor__content");
        const tokenList = element("div", "cpw-prompt-editor__tokens");
        tokenList.setAttribute("aria-label", "提示词标签");
        const addStatus = element("div", "cpw-prompt-editor__add-status");
        addStatus.setAttribute("role", "status");
        addStatus.setAttribute("aria-live", "polite");
        addStatus.hidden = true;
        content.append(tokenList, addStatus);

        const footer = element("footer", "cpw-prompt-editor__footer");
        const selectionActions = element("div", "cpw-prompt-editor__selection-actions");
        const enableAllButton = element("button", "cpw-prompt-editor__action", "全开");
        const disableAllButton = element("button", "cpw-prompt-editor__action", "全关");
        const confirmButton = element(
            "button",
            "cpw-prompt-editor__action cpw-prompt-editor__action--primary",
            "确认",
        );
        enableAllButton.type = "button";
        enableAllButton.title = "启用全部提示词";
        disableAllButton.type = "button";
        disableAllButton.title = "停用全部提示词";
        confirmButton.type = "button";
        selectionActions.append(enableAllButton, disableAllButton);
        footer.append(selectionActions, confirmButton);
        const resizeHandle = element("div", "cpw-prompt-editor__resize-handle");
        resizeHandle.setAttribute("role", "separator");
        resizeHandle.setAttribute("aria-label", "拖拽调整提示词编辑窗口大小");
        dialog.append(header, content, footer, resizeHandle);
        overlay.append(dialog);

        promptAssistantTagCatalog.load().then((records) => {
            tagCatalogRecords = records;
            if (activePromptEditor?.overlay === overlay && adding && addInput) {
                renderPromptAssistantSuggestions();
            }
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
        const positionPromptAssistantSuggestions = () => {
            if (!suggestionList || suggestionList.hidden || !addInput?.isConnected) return;

            const inputRect = addInput.getBoundingClientRect();
            const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
            const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
            const viewportMargin = 8;
            const popupGap = 4;
            const preferredHeight = Math.min(210, suggestionList.scrollHeight || 210);
            const availableBelow = Math.max(
                0,
                viewportHeight - inputRect.bottom - viewportMargin - popupGap,
            );
            const availableAbove = Math.max(0, inputRect.top - viewportMargin - popupGap);
            const openAbove = availableBelow < preferredHeight && availableAbove > availableBelow;
            const availableHeight = openAbove ? availableAbove : availableBelow;
            const popupWidth = Math.max(
                0,
                Math.min(inputRect.width, viewportWidth - viewportMargin * 2),
            );
            const popupLeft = Math.min(
                Math.max(viewportMargin, inputRect.left),
                Math.max(viewportMargin, viewportWidth - viewportMargin - popupWidth),
            );

            suggestionList.style.left = `${Math.round(popupLeft)}px`;
            suggestionList.style.width = `${Math.round(popupWidth)}px`;
            suggestionList.style.maxHeight = `${Math.max(48, Math.min(210, availableHeight))}px`;
            if (openAbove) {
                suggestionList.style.top = "auto";
                suggestionList.style.bottom = `${Math.round(viewportHeight - inputRect.top + popupGap)}px`;
            } else {
                suggestionList.style.top = `${Math.round(inputRect.bottom + popupGap)}px`;
                suggestionList.style.bottom = "auto";
            }
        };
        const handleSuggestionAnchorChange = () => positionPromptAssistantSuggestions();
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
                || event.target.closest?.("button, input, textarea, select")
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
        const syncActiveSuggestion = () => {
            if (!suggestionList || !addInput) return;
            const options = [...suggestionList.querySelectorAll("[role='option']")];
            options.forEach((option, index) => {
                const active = index === activeSuggestionIndex;
                option.classList.toggle("cpw-prompt-editor__suggestion--active", active);
                option.setAttribute("aria-selected", String(active));
            });
            const activeOption = options[activeSuggestionIndex];
            if (activeOption) {
                addInput.setAttribute("aria-activedescendant", activeOption.id);
                activeOption.scrollIntoView({ block: "nearest" });
            } else {
                addInput.removeAttribute("aria-activedescendant");
            }
        };
        function renderPromptAssistantSuggestions() {
            if (!suggestionList || !addInput) return;
            suggestionResults = searchPromptAssistantTags(tagCatalogRecords, addInput.value);
            activeSuggestionIndex = -1;
            suggestionList.replaceChildren();
            suggestionList.hidden = !suggestionResults.length;
            suggestionList.style.visibility = suggestionResults.length ? "hidden" : "";
            addInput.setAttribute("aria-expanded", String(Boolean(suggestionResults.length)));
            addInput.removeAttribute("aria-activedescendant");

            suggestionResults.forEach((record, index) => {
                const label = formatPromptAssistantTagOption(record);
                const option = element("button", "cpw-prompt-editor__suggestion", label);
                option.type = "button";
                option.id = `${suggestionList.id}-option-${index}`;
                option.tabIndex = -1;
                option.title = label;
                option.setAttribute("role", "option");
                option.setAttribute("aria-selected", "false");
                const keepInputFocused = (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                };
                option.addEventListener("pointerdown", keepInputFocused);
                option.addEventListener("mousedown", keepInputFocused);
                option.addEventListener("click", (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    selectPromptAssistantSuggestion(index);
                });
                suggestionList.append(option);
            });
            if (suggestionResults.length) {
                positionPromptAssistantSuggestions();
                suggestionList.style.visibility = "";
            }
        }
        function selectPromptAssistantSuggestion(index) {
            const record = suggestionResults[index];
            if (!record) return;
            clearAddBlurTimer();
            if (addInput) addInput.dataset.cpwSkipBlurCommit = "true";
            const result = mergePromptTokenInput(tokens, selected, record.value);
            tokens = result.tokens;
            selected = result.selected;
            adding = true;
            addDraft = "";
            renderTokens({ focusInput: true });
            setAddStatus(formatAddStatus(result, true));
        }
        const renderActivePromptCount = () => {
            const count = countActivePromptTokens(selected);
            activeCount.textContent = String(count);
            activeCount.setAttribute("aria-label", `当前激活 ${count} 个提示词`);
        };
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
        };
        const togglePromptTokenAt = (index, visitedIndexes = new Set()) => {
            if (!togglePromptTokenOnce(selected, index, visitedIndexes)) return false;
            syncPromptTokenButton(index);
            renderActivePromptCount();
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
                togglePromptTokenAt(tokenAtPoint(
                    fromX + (toX - fromX) * ratio,
                    fromY + (toY - fromY) * ratio,
                ), visitedIndexes);
            }
        };
        const cleanupPromptTokenToggleGesture = () => {
            const gesture = tokenToggleGesture;
            tokenToggleGesture = null;
            tokenList.classList.remove("cpw-prompt-editor__tokens--toggling");
            if (gesture && tokenList.hasPointerCapture(gesture.pointerId)) {
                tokenList.releasePointerCapture(gesture.pointerId);
            }
        };
        const beginPromptTokenToggleGesture = (event) => {
            if (event.button !== 0 || event.isPrimary === false || tokenToggleGesture) return;
            const index = promptTokenIndexFromElement(event.target);
            if (index < 0) return;
            const visitedIndexes = new Set();
            if (!togglePromptTokenAt(index, visitedIndexes)) return;
            clearTokenClickSuppressionTimer();
            suppressTokenClick = true;
            tokenToggleGesture = {
                pointerId: event.pointerId,
                visitedIndexes,
                lastX: event.clientX,
                lastY: event.clientY,
            };
            tokenList.classList.add("cpw-prompt-editor__tokens--toggling");
            event.target.focus?.({ preventScroll: true });
            event.preventDefault();
            try {
                tokenList.setPointerCapture(event.pointerId);
            } catch {
                cleanupPromptTokenToggleGesture();
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
            cleanupPromptTokenToggleGesture();
            scheduleTokenClickSuppressionEnd();
            event.preventDefault();
        };
        const renderTokens = ({ focusInput = false, focusAddButton = false } = {}) => {
            renderActivePromptCount();
            suggestionList?.remove();
            tokenList.replaceChildren();
            addInput = null;
            addButton = null;
            suggestionList = null;
            suggestionResults = [];
            activeSuggestionIndex = -1;
            if (tokens.length) {
                for (let index = 0; index < tokens.length; index += 1) {
                    const token = tokens[index];
                    const button = element(
                        "button",
                        `cpw-prompt-editor__token cpw-prompt-editor__token--color-${index % 5}`,
                        token,
                    );
                    button.type = "button";
                    button.title = token;
                    button.dataset.promptTokenIndex = String(index);
                    button.setAttribute("aria-pressed", String(selected[index]));
                    button.classList.toggle("cpw-prompt-editor__token--inactive", !selected[index]);
                    button.addEventListener("click", (event) => {
                        if (suppressTokenClick) {
                            suppressTokenClick = false;
                            clearTokenClickSuppressionTimer();
                            event.preventDefault();
                            return;
                        }
                        togglePromptTokenAt(index);
                    });
                    tokenList.append(button);
                }
            } else {
                tokenList.append(element("div", "cpw-prompt-editor__empty", "当前没有提示词，可点击 + 添加。"));
            }

            if (adding) {
                const addComposer = element("div", "cpw-prompt-editor__add-composer");
                addInput = element("textarea", "cpw-prompt-editor__add-input");
                addInput.rows = 1;
                addInput.value = addDraft;
                addInput.placeholder = "输入提示词，支持中文或英文标签匹配";
                addInput.setAttribute("aria-label", "新增提示词");
                addInput.setAttribute("role", "combobox");
                addInput.setAttribute("aria-autocomplete", "list");
                addInput.setAttribute("aria-expanded", "false");
                suggestionList = element("div", "cpw-prompt-editor__suggestions");
                suggestionList.id = `cpw-prompt-editor-suggestions-${createId()}`;
                suggestionList.setAttribute("role", "listbox");
                suggestionList.setAttribute("aria-label", "Prompt Assistant 标签匹配结果");
                suggestionList.hidden = true;
                addInput.setAttribute("aria-controls", suggestionList.id);
                addComposer.append(addInput);
                tokenList.append(addComposer);
                overlay.append(suggestionList);
                addInput.addEventListener("input", (event) => {
                    addDraft = event.currentTarget.value;
                    renderPromptAssistantSuggestions();
                });
                addInput.addEventListener("keydown", (event) => {
                    if (event.isComposing) return;
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                        if (!suggestionResults.length) return;
                        event.preventDefault();
                        event.stopPropagation();
                        activeSuggestionIndex = movePromptAssistantSuggestionIndex(
                            activeSuggestionIndex,
                            suggestionResults.length,
                            event.key === "ArrowDown" ? 1 : -1,
                        );
                        syncActiveSuggestion();
                    } else if (event.key === "Enter") {
                        event.preventDefault();
                        event.stopPropagation();
                        if (activeSuggestionIndex >= 0) {
                            selectPromptAssistantSuggestion(activeSuggestionIndex);
                        } else {
                            commitAddInput({ focusAddButton: true });
                        }
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
                renderPromptAssistantSuggestions();
            } else {
                addButton = element("button", "cpw-prompt-editor__add", "+");
                addButton.type = "button";
                addButton.title = "添加提示词";
                addButton.setAttribute("aria-label", "添加提示词");
                addButton.addEventListener("click", () => {
                    adding = true;
                    addDraft = "";
                    setAddStatus("");
                    renderTokens({ focusInput: true });
                });
                tokenList.append(addButton);
            }

            if (focusInput) queueMicrotask(() => addInput?.focus());
            if (focusAddButton) queueMicrotask(() => addButton?.focus());
        };
        const formatAddStatus = ({ addedCount, mergedCount, reactivatedCount }, hadInput) => {
            if (!addedCount && !mergedCount) {
                return hadInput ? "未检测到可添加的提示词。" : "";
            }
            const parts = [];
            if (addedCount) parts.push(`已添加 ${addedCount} 个`);
            if (mergedCount) parts.push(`合并 ${mergedCount} 个重复项`);
            if (reactivatedCount) parts.push(`重新启用 ${reactivatedCount} 个`);
            return `${parts.join("，")}。`;
        };
        function commitAddInput({ focusAddButton = false, render = true } = {}) {
            if (!adding || !addInput) return false;
            clearAddBlurTimer();
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
            return Boolean(result.addedCount || result.mergedCount);
        }
        function cancelAddInput() {
            if (!adding) return;
            clearAddBlurTimer();
            adding = false;
            addDraft = "";
            setAddStatus("");
            renderTokens({ focusAddButton: true });
        }

        const setAllPromptTokensActive = (active) => {
            clearAddBlurTimer();
            if (adding && addInput) commitAddInput({ render: false });
            selected = setAllPromptTokenSelection(selected, active);
            renderTokens();
            setAddStatus(tokens.length ? (active ? "已全部启用。" : "已全部停用。") : "");
        };

        const cleanupPromptEditor = () => {
            clearAddBlurTimer();
            clearTokenClickSuppressionTimer();
            suppressTokenClick = false;
            cleanupPromptTokenToggleGesture();
            suggestionList?.remove();
            window.removeEventListener("resize", handlePromptEditorViewportResize);
            overlay.removeEventListener("scroll", handleSuggestionAnchorChange, true);
        };
        activePromptEditor = { overlay, opener, cancelPendingAdd: cleanupPromptEditor };
        window.addEventListener("resize", handlePromptEditorViewportResize);
        overlay.addEventListener("scroll", handleSuggestionAnchorChange, true);
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
            setAddStatus(`已自动合并 ${parsedTokens.length - initialTokens.length} 个重复项。`);
        }
        closeButton.addEventListener("click", () => closePromptEditor());
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) closePromptEditor();
        });
        enableAllButton.addEventListener("click", () => setAllPromptTokensActive(true));
        disableAllButton.addEventListener("click", () => setAllPromptTokensActive(false));
        confirmButton.addEventListener("click", () => {
            clearAddBlurTimer();
            const pendingInput = addDraft || (adding && addInput ? addInput.value : "");
            const nextPrompt = confirmPromptEditorDraft(
                originalPrompt,
                tokens,
                selected,
                initialSelected,
                pendingInput,
                { forceRebuild: promptNeedsDeduplication },
            );
            closePromptEditor();
            if (nextPrompt === originalPrompt) return;
            promptInput.value = nextPrompt;
            updateItem(itemId, { prompt: nextPrompt });
        });
        dialog.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                closePromptEditor();
                return;
            }
            if (event.key !== "Tab") return;
            const focusable = [...dialog.querySelectorAll(
                "button:not([disabled]), input:not([disabled]), textarea:not([disabled])",
            )].filter((candidate) => candidate.tabIndex >= 0 && !candidate.hidden);
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
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

        const header = element("div", "cpw-prompt-grid__card-header");
        const dragHandle = element("button", "cpw-prompt-grid__drag", "⠿");
        dragHandle.type = "button";
        dragHandle.title = "拖拽排序";
        dragHandle.setAttribute("aria-label", "拖拽此卡片排序");

        const toggleLabel = element("label", "cpw-prompt-grid__switch");
        const toggle = element("input", "");
        toggle.type = "checkbox";
        toggle.checked = item.enabled;
        toggle.setAttribute("aria-label", "启用此提示词");
        toggleLabel.append(toggle, element("span", "cpw-prompt-grid__switch-track"));

        const title = element("input", "cpw-prompt-grid__title");
        title.type = "text";
        title.value = item.title;
        title.placeholder = "提示词标题";
        title.setAttribute("aria-label", "提示词标题");

        const deleteButton = element("button", "cpw-prompt-grid__delete", "×");
        deleteButton.type = "button";
        deleteButton.title = "删除此提示词";
        deleteButton.setAttribute("aria-label", "删除此提示词");
        const cardActions = element("div", "cpw-prompt-grid__card-actions");
        cardActions.append(deleteButton, dragHandle);
        header.append(toggleLabel, title, cardActions);

        const prompt = element("input", "cpw-prompt-grid__prompt");
        prompt.type = "text";
        prompt.value = item.prompt;
        prompt.placeholder = "输入提示词…";
        prompt.setAttribute("aria-label", "提示词内容");
        const promptEditButton = element("button", "cpw-prompt-grid__prompt-edit", "✎");
        promptEditButton.type = "button";
        promptEditButton.title = "拆分并选择提示词";
        promptEditButton.setAttribute("aria-label", "打开提示词标签编辑窗口");
        const promptRow = element("div", "cpw-prompt-grid__prompt-row");
        promptRow.append(prompt, promptEditButton);
        card.append(header, promptRow);

        let deleteArmed = false;
        let deleteResetTimer = null;

        function resetDeleteConfirmation() {
            deleteArmed = false;
            deleteButton.textContent = "×";
            deleteButton.title = "删除此提示词";
            deleteButton.classList.remove("cpw-prompt-grid__delete--confirm");
        }

        toggle.addEventListener("change", () => {
            card.classList.toggle("cpw-prompt-grid__card--disabled", !toggle.checked);
            updateItem(item.id, { enabled: toggle.checked });
        });
        title.addEventListener("input", () => updateItem(item.id, { title: title.value }, false));
        prompt.addEventListener("input", () => updateItem(item.id, { prompt: prompt.value }, false));
        title.addEventListener("change", captureCanvasState);
        prompt.addEventListener("change", captureCanvasState);
        promptEditButton.addEventListener("click", () => openPromptEditor(prompt, item.id, promptEditButton));
        deleteButton.addEventListener("click", () => {
            if (prompt.value.trim() && !deleteArmed) {
                deleteArmed = true;
                deleteButton.textContent = "!";
                deleteButton.title = "再次点击确认删除非空提示词";
                deleteButton.classList.add("cpw-prompt-grid__delete--confirm");
                clearTimeout(deleteResetTimer);
                deleteResetTimer = setTimeout(resetDeleteConfirmation, 3000);
                return;
            }
            clearTimeout(deleteResetTimer);
            state.items = state.items.filter((candidate) => candidate.id !== item.id);
            commit(true);
            scheduleNodeHeightFit();
        });

        dragHandle.addEventListener("pointerdown", (event) => beginPointerDrag(event, item.id, card, dragHandle));
        dragHandle.addEventListener("pointermove", movePointerDrag);
        dragHandle.addEventListener("pointerup", finishPointerDrag);
        dragHandle.addEventListener("pointercancel", cancelPointerDrag);
        dragHandle.addEventListener("lostpointercapture", losePointerCapture);
        return card;
    }

    function render() {
        if (disposed) return;
        if (activePromptEditor) closePromptEditor(false);
        if (dragSession) endPointerDrag(true);
        const invalid = Boolean(parseError) || !state;
        toolbar.hidden = invalid;
        scroll.hidden = invalid;
        errorPanel.hidden = !invalid;
        if (invalid) {
            errorMessage.textContent = parseError || "未知配置错误";
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
            grid.replaceChildren(element("div", "cpw-prompt-grid__empty", "暂无提示词，点击“新增提示词”开始编辑。"));
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
    readValue(inputData?.[1]?.default ?? JSON.stringify(createDefaultConfig()));
    widget = node.addDOMWidget(inputName, WIDGET_TYPE, root, {
        serialize: true,
        hideInPanel: true,
        hideOnZoom: false,
        getValue: () => serializedValue,
        setValue: (value) => {
            receivedExternalValue = true;
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
        if (activePromptEditor) closePromptEditor(false);
        if (activeArchiveConfirmation) closeArchiveConfirmation(false);
        closeArchiveManager();
        if (heightFitFrame) cancelAnimationFrame(heightFitFrame);
        if (sizeReconcileFrame) cancelAnimationFrame(sizeReconcileFrame);
        sizeObserver?.disconnect();
        if (node.onResize === promptGridOnResize) node.onResize = previousNodeOnResize;
        window.removeEventListener(ARCHIVE_SYNC_EVENT, onArchiveSync);
        columnSelect.customSelect.destroy();
        archiveSelect.customSelect.destroy();
        promptGridArchiveControllers.delete(node);
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
