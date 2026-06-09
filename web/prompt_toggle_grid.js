import { app } from "../../scripts/app.js";

const WIDGET_TYPE = "PROMPT_WEAVER_PROMPT_GRID";
const CONFIG_VERSION = 1;
const DEFAULT_COLUMNS = 2;
const DEFAULT_CARD_COUNT = 4;
const MIN_COLUMNS = 1;
const MAX_COLUMNS = 6;
const DEFAULT_NODE_SIZE = [600, 420];

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

function ensureStylesheet() {
    const id = "cpw-prompt-toggle-grid-styles";
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = new URL("./prompt_toggle_grid.css", import.meta.url).href;
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
    const columnGroup = element("label", "cpw-prompt-grid__columns");
    columnGroup.append(element("span", "", "列数"));
    const columnSelect = element("select", "cpw-prompt-grid__select");
    columnSelect.setAttribute("aria-label", "网格列数");
    for (let columns = MIN_COLUMNS; columns <= MAX_COLUMNS; columns += 1) {
        const option = element("option", "", String(columns));
        option.value = String(columns);
        columnSelect.append(option);
    }
    columnGroup.append(columnSelect);

    const actions = element("div", "cpw-prompt-grid__actions");
    const addButton = element("button", "cpw-prompt-grid__button cpw-prompt-grid__button--primary", "＋ 新增提示词");
    const enableAllButton = element("button", "cpw-prompt-grid__button", "全开");
    const disableAllButton = element("button", "cpw-prompt-grid__button", "全关");
    for (const button of [addButton, enableAllButton, disableAllButton]) button.type = "button";
    actions.append(addButton, enableAllButton, disableAllButton);
    toolbar.append(columnGroup, actions);

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
    let draggedId = null;
    let disposed = false;
    let widget;

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
        const previousValue = serializedValue;
        serializedValue = JSON.stringify(state);
        parseError = null;
        if (renderAfter) render();
        notifyWidgetChanged(node, widget, inputName, serializedValue, previousValue, captureHistory);
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
        for (const card of grid.querySelectorAll(".cpw-prompt-grid__card--drop")) {
            card.classList.remove("cpw-prompt-grid__card--drop");
        }
    }

    function applyGridColumns() {
        if (!state) return;
        grid.style.setProperty("--cpw-columns", String(state.columns));
        grid.style.minWidth = `${state.columns * 180 + (state.columns - 1) * 8}px`;
    }

    function createCard(item) {
        const card = element("article", "cpw-prompt-grid__card");
        card.classList.toggle("cpw-prompt-grid__card--disabled", !item.enabled);

        const header = element("div", "cpw-prompt-grid__card-header");
        const dragHandle = element("button", "cpw-prompt-grid__drag", "⠿");
        dragHandle.type = "button";
        dragHandle.draggable = true;
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
        const promptRow = element("div", "cpw-prompt-grid__prompt-row");
        promptRow.append(prompt);
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
        });

        dragHandle.addEventListener("dragstart", (event) => {
            draggedId = item.id;
            card.classList.add("cpw-prompt-grid__card--dragging");
            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", "prompt-weaver-card");
            }
        });
        dragHandle.addEventListener("dragend", () => {
            draggedId = null;
            card.classList.remove("cpw-prompt-grid__card--dragging");
            clearDropState();
        });
        card.addEventListener("dragover", (event) => {
            if (!draggedId || draggedId === item.id) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
            clearDropState();
            card.classList.add("cpw-prompt-grid__card--drop");
        });
        card.addEventListener("dragleave", () => card.classList.remove("cpw-prompt-grid__card--drop"));
        card.addEventListener("drop", (event) => {
            event.preventDefault();
            clearDropState();
            if (!draggedId || draggedId === item.id) return;
            const sourceIndex = state.items.findIndex((candidate) => candidate.id === draggedId);
            let targetIndex = state.items.findIndex((candidate) => candidate.id === item.id);
            if (sourceIndex < 0 || targetIndex < 0) return;
            const [moved] = state.items.splice(sourceIndex, 1);
            if (sourceIndex < targetIndex) targetIndex -= 1;
            const rect = card.getBoundingClientRect();
            const centerY = rect.top + rect.height / 2;
            const nearSameRow = Math.abs(event.clientY - centerY) < rect.height * 0.25;
            const after = state.columns === 1
                ? event.clientY > centerY
                : nearSameRow
                ? event.clientX > rect.left + rect.width / 2
                : event.clientY > centerY;
            state.items.splice(targetIndex + (after ? 1 : 0), 0, moved);
            draggedId = null;
            commit(true);
        });
        return card;
    }

    function render() {
        if (disposed) return;
        const invalid = Boolean(parseError) || !state;
        toolbar.hidden = invalid;
        scroll.hidden = invalid;
        errorPanel.hidden = !invalid;
        if (invalid) {
            errorMessage.textContent = parseError || "未知配置错误";
            grid.replaceChildren();
            return;
        }

        columnSelect.value = String(state.columns);
        applyGridColumns();
        const cards = state.items.map(createCard);
        if (cards.length) {
            grid.replaceChildren(...cards);
        } else {
            grid.replaceChildren(element("div", "cpw-prompt-grid__empty", "暂无提示词，点击“新增提示词”开始编辑。"));
        }
    }

    columnSelect.addEventListener("change", () => {
        if (!state) return;
        state.columns = Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, Number(columnSelect.value) || DEFAULT_COLUMNS));
        applyGridColumns();
        commit();
    });
    addButton.addEventListener("click", () => {
        if (!state) return;
        state.items.push({ id: createId(), enabled: true, title: nextTitle(), prompt: "" });
        commit(true);
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
    resetButton.addEventListener("click", () => {
        state = createDefaultConfig();
        parseError = null;
        commit(true);
    });

    for (const eventName of [
        "pointerdown", "pointermove", "mousedown", "click", "dblclick", "keydown", "contextmenu",
        "dragstart", "dragover", "dragleave", "drop", "dragend",
    ]) {
        root.addEventListener(eventName, (event) => event.stopPropagation());
    }
    root.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });

    readValue(inputData?.[1]?.default ?? JSON.stringify(createDefaultConfig()));
    widget = node.addDOMWidget(inputName, WIDGET_TYPE, root, {
        serialize: true,
        hideInPanel: true,
        hideOnZoom: false,
        getValue: () => serializedValue,
        setValue: (value) => {
            readValue(value);
            render();
        },
        getMinHeight: () => 300,
        getMaxHeight: () => Math.max(300, (node.size?.[1] ?? DEFAULT_NODE_SIZE[1]) - 74),
    });
    widget.inputSpec = inputData;
    const previousOnRemove = widget.onRemove;
    widget.onRemove = function (...args) {
        previousOnRemove?.apply(this, args);
        disposed = true;
        root.replaceChildren();
    };
    render();

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
    return { widget, minWidth: DEFAULT_NODE_SIZE[0], minHeight: DEFAULT_NODE_SIZE[1] };
}

app.registerExtension({
    name: "ComfyUIPromptWeaver.PromptToggleGrid",
    getCustomWidgets() {
        return {
            [WIDGET_TYPE]: createPromptGridWidget,
        };
    },
});
