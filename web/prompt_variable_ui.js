import { t } from "./prompt_weaver_i18n.js?v=20260923-sqlite-filter-v1";
import { MAX_VARIABLES, completeVariableReference, variableSuggestionContext } from "./prompt_variables.js?v=20260925-variables-v1";

const GEOMETRY_KEY = "prompt-weaver-variable-manager-geometry-v2";
const LEGACY_GEOMETRY_KEY = "prompt-weaver-variable-manager-geometry-v1";

function element(tag, className, label = null) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (label !== null) node.textContent = label;
    return node;
}

function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
}

function readGeometry() {
    try {
        const current = JSON.parse(localStorage.getItem(GEOMETRY_KEY) || "null");
        if (current) return { ...current, legacy: false };
        const legacy = JSON.parse(localStorage.getItem(LEGACY_GEOMETRY_KEY) || "null");
        return legacy ? { ...legacy, legacy: true } : null;
    } catch {
        return null;
    }
}

export function openPromptVariableManager({
    opener, getVariables, onAdd, onUpdate, onDelete, onReorder, referenceCount, onClose,
}) {
    const overlay = element("div", "cpw-variable-manager__overlay");
    const dialog = element("section", "cpw-variable-manager");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const header = element("header", "cpw-variable-manager__header");
    const heading = element("h2", "cpw-variable-manager__title", t("Variable Manager"));
    heading.id = `cpw-variable-manager-${Math.random().toString(36).slice(2)}`;
    dialog.setAttribute("aria-labelledby", heading.id);
    const closeButton = element("button", "cpw-variable-manager__close", "×");
    closeButton.type = "button";
    header.append(heading, closeButton);
    const main = element("div", "cpw-variable-manager__main");
    const addButton = element("button", "cpw-variable-manager__button cpw-variable-manager__button--primary");
    addButton.type = "button";
    const message = element("div", "cpw-variable-manager__message");
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    const listSection = element("section", "cpw-variable-manager__list-section");
    const listTitle = element("h3", "cpw-variable-manager__list-title");
    const listHeader = element("div", "cpw-variable-manager__list-header");
    const columnHeader = element("div", "cpw-variable-manager__columns");
    const nameColumn = element("span", "cpw-variable-manager__column-name");
    const valueColumn = element("span", "cpw-variable-manager__column-value");
    const actionColumn = element("span", "cpw-variable-manager__column-action");
    columnHeader.append(element("span", ""), nameColumn, valueColumn, actionColumn);
    const list = element("div", "cpw-variable-manager__list");
    const empty = element("div", "cpw-variable-manager__empty", t("No variables yet."));
    listHeader.append(listTitle, message, addButton);
    listSection.append(listHeader, columnHeader, list);
    main.append(listSection);
    dialog.append(header, main);
    overlay.append(dialog);
    let closed = false;
    let pendingDeleteId = null;
    let draggedId = null;
    let geometryObserver = null;
    let messageKey = "";
    let messageParams = null;
    let messageTimer = 0;
    let draft = null;
    let draftCommitTimer = 0;

    const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
    function saveGeometry() {
        if (closed) return;
        try {
            const rect = dialog.getBoundingClientRect();
            localStorage.setItem(GEOMETRY_KEY, JSON.stringify({
                left: rect.left, top: rect.top, width: rect.width, height: rect.height,
            }));
        } catch {
            // Geometry persistence is optional when browser storage is unavailable.
        }
    }
    function placeDialog() {
        const size = viewport();
        const saved = readGeometry();
        const availableWidth = Math.max(280, size.width - 16);
        const availableHeight = Math.max(220, size.height - 16);
        const storedWidth = typeof saved?.width === "number" && Number.isFinite(saved.width) ? saved.width : 760;
        const storedHeight = typeof saved?.height === "number" && Number.isFinite(saved.height) ? saved.height : 520;
        const width = clamp(saved?.legacy ? Math.max(760, storedWidth) : storedWidth,
            Math.min(340, availableWidth), availableWidth);
        const height = clamp(saved?.legacy ? Math.max(540, storedHeight) : storedHeight,
            Math.min(300, availableHeight), availableHeight);
        const storedLeft = typeof saved?.left === "number" && Number.isFinite(saved.left) ? saved.left : (size.width - width) / 2;
        const storedTop = typeof saved?.top === "number" && Number.isFinite(saved.top) ? saved.top : (size.height - height) / 2;
        dialog.style.width = `${width}px`;
        dialog.style.height = `${height}px`;
        dialog.style.left = `${clamp(storedLeft, 8, Math.max(8, size.width - width - 8))}px`;
        dialog.style.top = `${clamp(storedTop, 8, Math.max(8, size.height - height - 8))}px`;
    }
    function setMessage(key, error = false, params = null, { success = false, dismissAfterMs = 0 } = {}) {
        clearTimeout(messageTimer);
        messageTimer = 0;
        messageKey = key;
        messageParams = params;
        message.textContent = key ? t(key, params || undefined) : "";
        message.title = message.textContent;
        message.classList.toggle("cpw-variable-manager__message--error", error);
        message.classList.toggle("cpw-variable-manager__message--success", success && !error);
        if (key && dismissAfterMs > 0) {
            messageTimer = setTimeout(() => setMessage(""), dismissAfterMs);
        }
    }
    function commitDraft(focusValue = false) {
        if (!draft) return false;
        try {
            const id = onAdd(draft.name, draft.value);
            draft = null;
            pendingDeleteId = null;
            setMessage("Variable added.", false, null, { success: true, dismissAfterMs: 3000 });
            render();
            if (focusValue) {
                list.querySelector(`[data-variable-id="${CSS.escape(id)}"] textarea`)?.focus();
            }
            return true;
        } catch (error) {
            setMessage(error.message, true);
            return false;
        }
    }
    function cancelDraft() {
        if (!draft) return;
        clearTimeout(draftCommitTimer);
        draft = null;
        setMessage("");
        render();
        addButton.focus();
    }
    function commitField(input, variable, field) {
        const next = input.value;
        if (next === variable[field]) return;
        try {
            onUpdate(variable.id, field, next);
            pendingDeleteId = null;
            input.value = getVariables().find((entry) => entry.id === variable.id)?.[field] ?? next;
            setMessage("Variable updated.");
            refreshLocale();
        } catch (error) {
            setMessage(error.message, true);
            queueMicrotask(() => input.isConnected && input.focus());
        }
    }
    function fieldKeys(event, original) {
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.value = original;
            event.currentTarget.blur();
        } else if (event.key === "Enter" && (event.currentTarget.tagName === "INPUT" || event.ctrlKey)) {
            event.preventDefault();
            event.currentTarget.blur();
        }
    }
    function render() {
        const variables = getVariables();
        listTitle.textContent = t("Variable List ({count})", { count: variables.length });
        list.replaceChildren();
        if (!variables.length && !draft) list.append(empty);
        for (const variable of variables) {
            const row = element("div", "cpw-variable-manager__row");
            row.dataset.variableId = variable.id;
            const handle = element("button", "cpw-variable-manager__handle", "⋮⋮");
            handle.type = "button";
            handle.draggable = true;
            const name = element("input", "cpw-variable-manager__input");
            name.type = "text";
            name.maxLength = 64;
            name.value = variable.name;
            const value = element("textarea", "cpw-variable-manager__input cpw-variable-manager__value");
            value.rows = 1;
            value.maxLength = 10_000;
            value.value = variable.value;
            const valueCell = element("div", "cpw-variable-manager__value-cell");
            const clearValue = element("button", "cpw-variable-manager__button cpw-variable-manager__clear-value", "×");
            clearValue.type = "button";
            clearValue.disabled = !value.value;
            valueCell.append(value, clearValue);
            const remove = element("button", "cpw-variable-manager__button cpw-variable-manager__remove");
            remove.type = "button";
            name.addEventListener("keydown", (event) => fieldKeys(event, variable.name));
            value.addEventListener("keydown", (event) => fieldKeys(event, variable.value));
            value.addEventListener("input", () => { clearValue.disabled = !value.value; });
            name.addEventListener("blur", () => commitField(name, variable, "name"));
            value.addEventListener("blur", () => commitField(value, variable, "value"));
            clearValue.addEventListener("pointerdown", (event) => event.preventDefault());
            clearValue.addEventListener("click", () => {
                try {
                    onUpdate(variable.id, "value", "");
                    pendingDeleteId = null;
                    value.value = "";
                    clearValue.disabled = true;
                    setMessage("Variable updated.");
                    value.focus();
                } catch (error) {
                    setMessage(error.message, true);
                }
            });
            remove.addEventListener("click", () => {
                const count = referenceCount(variable.name);
                if (count && pendingDeleteId !== variable.id) {
                    pendingDeleteId = variable.id;
                    setMessage("{count} cards reference this variable. Click Delete again to confirm.", false, { count });
                    remove.textContent = t("Delete");
                    remove.focus();
                    return;
                }
                onDelete(variable.id);
                pendingDeleteId = null;
                setMessage("Variable deleted.");
                render();
            });
            handle.addEventListener("dragstart", (event) => {
                draggedId = variable.id;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", variable.id);
                row.classList.add("cpw-variable-manager__row--dragging");
            });
            handle.addEventListener("dragend", () => {
                draggedId = null;
                for (const candidate of list.children) candidate.classList.remove("cpw-variable-manager__row--dragging", "cpw-variable-manager__row--target");
            });
            row.addEventListener("dragover", (event) => {
                if (!draggedId || draggedId === variable.id) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                row.classList.add("cpw-variable-manager__row--target");
            });
            row.addEventListener("dragleave", () => row.classList.remove("cpw-variable-manager__row--target"));
            row.addEventListener("drop", (event) => {
                if (!draggedId || draggedId === variable.id) return;
                event.preventDefault();
                const after = event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
                onReorder(draggedId, variable.id, after);
                draggedId = null;
                pendingDeleteId = null;
                render();
            });
            handle.addEventListener("keydown", (event) => {
                const index = getVariables().findIndex((entry) => entry.id === variable.id);
                const direction = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
                if (!direction || index + direction < 0 || index + direction >= getVariables().length) return;
                event.preventDefault();
                const target = getVariables()[index + direction];
                onReorder(variable.id, target.id, direction > 0);
                pendingDeleteId = null;
                render();
                list.querySelector(`[data-variable-id="${CSS.escape(variable.id)}"] .cpw-variable-manager__handle`)?.focus();
            });
            row.append(handle, name, valueCell, remove);
            list.append(row);
        }
        if (draft) {
            const currentDraft = draft;
            const row = element("div", "cpw-variable-manager__row cpw-variable-manager__row--draft");
            const handle = element("span", "cpw-variable-manager__drag-placeholder");
            handle.setAttribute("aria-hidden", "true");
            const name = element("input", "cpw-variable-manager__input");
            name.type = "text";
            name.maxLength = 64;
            name.value = currentDraft.name;
            const value = element("textarea", "cpw-variable-manager__input cpw-variable-manager__value");
            value.rows = 1;
            value.maxLength = 10_000;
            value.value = currentDraft.value;
            const valueCell = element("div", "cpw-variable-manager__value-cell");
            const clearValue = element("button", "cpw-variable-manager__button cpw-variable-manager__clear-value", "×");
            clearValue.type = "button";
            clearValue.disabled = !value.value;
            valueCell.append(value, clearValue);
            const cancel = element("button", "cpw-variable-manager__button cpw-variable-manager__remove");
            cancel.type = "button";
            cancel.append(element("span", "cpw-variable-manager__trash-icon"));
            name.addEventListener("input", () => { currentDraft.name = name.value; });
            value.addEventListener("input", () => {
                currentDraft.value = value.value;
                clearValue.disabled = !value.value;
            });
            name.addEventListener("keydown", (event) => {
                if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelDraft(); }
                else if (event.key === "Enter") { event.preventDefault(); value.focus(); }
            });
            value.addEventListener("keydown", (event) => {
                if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelDraft(); }
                else if (event.key === "Enter" && event.ctrlKey) { event.preventDefault(); commitDraft(true); }
            });
            clearValue.addEventListener("pointerdown", (event) => event.preventDefault());
            clearValue.addEventListener("click", () => {
                currentDraft.value = "";
                value.value = "";
                clearValue.disabled = true;
                value.focus();
            });
            cancel.addEventListener("click", cancelDraft);
            row.addEventListener("focusout", () => {
                clearTimeout(draftCommitTimer);
                draftCommitTimer = setTimeout(() => {
                    if (closed || draft !== currentDraft || !row.isConnected || row.contains(document.activeElement)) return;
                    if (currentDraft.name.trim()) commitDraft();
                }, 0);
            });
            row.append(handle, name, valueCell, cancel);
            list.append(row);
        }
        refreshLocale();
    }
    function refreshLocale() {
        heading.textContent = t("Variable Manager");
        listTitle.textContent = t("Variable List ({count})", { count: getVariables().length });
        nameColumn.textContent = t("Variable name");
        valueColumn.textContent = t("Variable value");
        actionColumn.textContent = t("Actions");
        message.textContent = messageKey ? t(messageKey, messageParams || undefined) : "";
        message.title = message.textContent;
        closeButton.title = t("Close variable manager");
        closeButton.setAttribute("aria-label", t("Close variable manager"));
        addButton.textContent = t("New Variable");
        addButton.disabled = getVariables().length >= MAX_VARIABLES;
        empty.textContent = t("No variables yet.");
        for (const row of list.querySelectorAll(".cpw-variable-manager__row")) {
            row.querySelector(".cpw-variable-manager__handle")?.setAttribute("aria-label", t("Drag to reorder variable; use arrow keys for keyboard sorting"));
            row.querySelector("input")?.setAttribute("aria-label", t("Variable name"));
            row.querySelector("textarea")?.setAttribute("aria-label", t("Variable value"));
            const clearValue = row.querySelector(".cpw-variable-manager__clear-value");
            if (clearValue) {
                clearValue.title = t("Clear variable value");
                clearValue.setAttribute("aria-label", t("Clear variable value"));
            }
            const remove = row.querySelector(".cpw-variable-manager__remove");
            if (remove) {
                if (row.classList.contains("cpw-variable-manager__row--draft")) {
                    row.querySelector("input").placeholder = t("Enter variable name");
                    row.querySelector("textarea").placeholder = t("Enter variable value");
                    remove.title = t("Cancel new variable");
                    remove.setAttribute("aria-label", t("Cancel new variable"));
                    continue;
                }
                remove.replaceChildren(pendingDeleteId === row.dataset.variableId
                    ? document.createTextNode(t("Delete"))
                    : element("span", "cpw-variable-manager__trash-icon"));
                remove.title = t("Delete variable");
                remove.setAttribute("aria-label", t("Delete variable"));
            }
        }
    }
    function close() {
        if (closed) return;
        saveGeometry();
        closed = true;
        clearTimeout(draftCommitTimer);
        clearTimeout(messageTimer);
        draft = null;
        geometryObserver?.disconnect();
        window.removeEventListener("resize", placeDialog);
        overlay.remove();
        onClose?.();
        opener?.focus();
    }
    addButton.addEventListener("click", () => {
        if (draft) {
            list.querySelector(".cpw-variable-manager__row--draft input")?.focus();
            return;
        }
        if (getVariables().length >= MAX_VARIABLES) return;
        pendingDeleteId = null;
        draft = { name: "", value: "" };
        setMessage("");
        render();
        const name = list.querySelector(".cpw-variable-manager__row--draft input");
        name?.scrollIntoView({ block: "nearest" });
        name?.focus();
    });
    closeButton.addEventListener("click", close);
    overlay.addEventListener("pointerdown", (event) => { if (event.target === overlay) close(); });
    overlay.addEventListener("keydown", (event) => {
        if (event.key === "Tab") {
            const controls = [...dialog.querySelectorAll("button:not([disabled]), input:not([disabled]), textarea:not([disabled])")];
            const first = controls[0];
            const last = controls.at(-1);
            if (!dialog.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
                event.preventDefault();
                (event.shiftKey ? last : first)?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
            }
            return;
        }
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (pendingDeleteId) { pendingDeleteId = null; setMessage(""); render(); }
        else if (draft) cancelDraft();
        else close();
    });
    for (const eventName of ["pointerdown", "pointermove", "pointerup", "click", "keydown", "keyup", "input", "wheel"]) {
        overlay.addEventListener(eventName, (event) => event.stopPropagation());
    }
    let drag = null;
    header.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || event.target.closest("button")) return;
        const rect = dialog.getBoundingClientRect();
        drag = { id: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top };
        header.setPointerCapture(event.pointerId);
    });
    header.addEventListener("pointermove", (event) => {
        if (!drag || drag.id !== event.pointerId) return;
        const size = viewport();
        dialog.style.left = `${clamp(event.clientX - drag.x, 8, Math.max(8, size.width - dialog.offsetWidth - 8))}px`;
        dialog.style.top = `${clamp(event.clientY - drag.y, 8, Math.max(8, size.height - dialog.offsetHeight - 8))}px`;
    });
    const endDrag = () => { drag = null; saveGeometry(); };
    header.addEventListener("pointerup", endDrag);
    header.addEventListener("pointercancel", endDrag);
    geometryObserver = typeof ResizeObserver === "function" ? new ResizeObserver(saveGeometry) : null;
    document.body.append(overlay);
    placeDialog();
    geometryObserver?.observe(dialog);
    window.addEventListener("resize", placeDialog);
    render();
    queueMicrotask(() => addButton.focus());
    return { close, refreshLocale, overlay };
}

export class VariableSuggestionController {
    constructor(input, { getVariables, onSelect, onOpen, getAnchorRect, popupParent = document.body }) {
        this.input = input;
        this.getVariables = getVariables;
        this.onSelect = onSelect;
        this.onOpen = onOpen;
        this.getAnchorRect = getAnchorRect;
        this.popup = element("div", "cpw-variable-suggest");
        this.popup.setAttribute("role", "listbox");
        this.popup.hidden = true;
        this.context = null;
        this.matches = [];
        this.activeIndex = 0;
        this.composing = false;
        popupParent.append(this.popup);
        this.handleInput = () => this.refresh();
        this.handleKeyDown = (event) => {
            if (this.popup.hidden || this.composing || event.isComposing) return;
            if (this.matches.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                event.preventDefault();
                event.stopImmediatePropagation();
                this.activeIndex = (this.activeIndex + (event.key === "ArrowDown" ? 1 : -1) + this.matches.length) % this.matches.length;
                this.render();
            } else if (event.key === "Enter" && this.matches.length) {
                event.preventDefault();
                event.stopImmediatePropagation();
                this.select(this.matches[this.activeIndex]);
            }
        };
        this.handleBlur = () => { this.blurTimer = setTimeout(() => this.dismiss(), 100); };
        this.handleCompositionStart = () => { this.composing = true; this.dismiss(); };
        this.handleCompositionEnd = () => { this.composing = false; this.refresh(); };
        this.handleViewport = () => this.position();
        input.addEventListener("input", this.handleInput, true);
        input.addEventListener("keydown", this.handleKeyDown, true);
        input.addEventListener("blur", this.handleBlur);
        input.addEventListener("compositionstart", this.handleCompositionStart);
        input.addEventListener("compositionend", this.handleCompositionEnd);
        window.addEventListener("resize", this.handleViewport);
        window.addEventListener("scroll", this.handleViewport, true);
    }
    refresh() {
        if (this.composing || document.activeElement !== this.input) { this.dismiss(); return; }
        this.context = variableSuggestionContext(this.input.value, this.input.selectionStart, this.input.selectionEnd);
        if (!this.context) { this.dismiss(); return; }
        this.onOpen?.();
        this.matches = this.getVariables().filter((variable) => variable.name.startsWith(this.context.query));
        this.activeIndex = 0;
        this.render();
    }
    render() {
        this.popup.replaceChildren();
        const title = element("div", "cpw-variable-suggest__title", t("Variables"));
        this.popup.append(title);
        if (!this.matches.length) {
            this.popup.append(element("div", "cpw-variable-suggest__empty", t("No matching variables.")));
        }
        this.matches.forEach((variable, index) => {
            const option = element("button", "cpw-variable-suggest__option");
            option.type = "button";
            option.setAttribute("role", "option");
            option.setAttribute("aria-selected", String(index === this.activeIndex));
            option.classList.toggle("cpw-variable-suggest__option--active", index === this.activeIndex);
            option.append(element("strong", "", `{${variable.name}}`), element("span", "", variable.value));
            option.addEventListener("pointerdown", (event) => event.preventDefault());
            option.addEventListener("click", () => this.select(variable));
            this.popup.append(option);
        });
        this.popup.hidden = false;
        this.position();
    }
    position() {
        if (this.popup.hidden || !this.input.isConnected) return;
        const rect = this.getAnchorRect?.() || this.input.getBoundingClientRect();
        const width = Math.min(330, window.innerWidth - 16);
        this.popup.style.width = `${width}px`;
        this.popup.style.left = `${clamp(rect.left, 8, window.innerWidth - width - 8)}px`;
        const above = window.innerHeight - rect.bottom < 190 && rect.top > 190;
        this.popup.style.top = above ? "auto" : `${rect.bottom + 4}px`;
        this.popup.style.bottom = above ? `${window.innerHeight - rect.top + 4}px` : "auto";
    }
    select(variable) {
        const result = completeVariableReference(this.input.value, this.context, variable.name);
        if (!result) return;
        this.onSelect(result);
        this.dismiss();
        this.input.focus({ preventScroll: true });
    }
    dismiss() {
        if (this.popup.hidden) return false;
        this.popup.hidden = true;
        this.context = null;
        return true;
    }
    refreshLocale() { if (!this.popup.hidden) this.render(); }
    destroy() {
        clearTimeout(this.blurTimer);
        this.input.removeEventListener("input", this.handleInput, true);
        this.input.removeEventListener("keydown", this.handleKeyDown, true);
        this.input.removeEventListener("blur", this.handleBlur);
        this.input.removeEventListener("compositionstart", this.handleCompositionStart);
        this.input.removeEventListener("compositionend", this.handleCompositionEnd);
        window.removeEventListener("resize", this.handleViewport);
        window.removeEventListener("scroll", this.handleViewport, true);
        this.popup.remove();
    }
}
