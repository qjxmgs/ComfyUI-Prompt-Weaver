import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
    PromptGridArchiveClient,
    buildArchiveExportBundle,
    defaultArchiveName,
    formatArchiveOptionLabel,
    resolveArchiveStatus,
    snapshotFromState,
    validateImportBundlePreview,
} from "./prompt_grid_archives.js";
import {
    buildPromptFromSelection,
    splitPromptTokens,
} from "./prompt_editor_tokens.js";
import {
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
const GRID_GAP = 8;
const EDGE_SCROLL_ZONE = 24;
const EDGE_SCROLL_MAX_SPEED = 12;
const REORDER_ANIMATION_DURATION = 120;
const ARCHIVE_SYNC_EVENT = "cpw-prompt-grid-archives-changed";
const ARCHIVE_CHANNEL_NAME = "prompt-weaver-prompt-grid-archives";
const MAX_ARCHIVE_IMPORT_BYTES = 2 * 1024 * 1024;

const archiveClient = new PromptGridArchiveClient(api);
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

    const archiveGroup = element("div", "cpw-prompt-grid__archives");
    const archiveSelect = element("select", "cpw-prompt-grid__select cpw-prompt-grid__archive-select");
    archiveSelect.setAttribute("aria-label", "快速切换提示词存档");
    const manageArchivesButton = element("button", "cpw-prompt-grid__button", "存档管理");
    manageArchivesButton.type = "button";
    archiveGroup.append(archiveSelect, manageArchivesButton);

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
    let activeArchiveId = null;
    let archiveDirty = false;
    let archivesLoading = false;
    let archivesRefreshPending = false;
    let disposed = false;
    let widget;
    const cardElements = new Map();
    const reorderAnimations = new WeakMap();

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
        reconcileArchiveSelection();
    }

    function currentSnapshot() {
        return state ? snapshotFromState(state) : null;
    }

    function renderArchiveSelect() {
        const previousValue = activeArchiveId ?? "";
        archiveSelect.replaceChildren();
        const placeholder = element("option", "");
        placeholder.value = "";
        placeholder.textContent = formatArchiveOptionLabel(
            archivesLoading ? "正在加载存档…" : archiveDirty ? "未保存" : "选择存档…",
            archiveDirty && !activeArchiveId,
        );
        archiveSelect.append(placeholder);
        for (const archive of archives) {
            const option = element(
                "option",
                "",
                formatArchiveOptionLabel(archive.name, archive.id === activeArchiveId && archiveDirty),
            );
            option.value = archive.id;
            archiveSelect.append(option);
        }
        archiveSelect.value = previousValue;
        if (archiveSelect.value !== previousValue) archiveSelect.value = "";
        archiveSelect.disabled = !state;
    }

    function reconcileArchiveSelection() {
        if (!state) {
            activeArchiveId = null;
            archiveDirty = false;
            renderArchiveSelect();
            return;
        }
        const snapshot = currentSnapshot();
        const status = resolveArchiveStatus(
            archives,
            snapshot,
            activeArchiveId,
            snapshotFromState(createDefaultConfig()),
        );
        activeArchiveId = status.activeArchiveId;
        archiveDirty = status.dirty;
        renderArchiveSelect();
    }

    function setArchiveManagerMessage(message, error = false) {
        if (!activeArchiveManager) return;
        activeArchiveManager.message.textContent = message || "";
        activeArchiveManager.message.classList.toggle("cpw-archive-manager__message--error", error);
        activeArchiveManager.message.hidden = !message;
    }

    async function refreshArchives({ reportError = false } = {}) {
        if (disposed) return false;
        if (archivesLoading) {
            archivesRefreshPending = true;
            return false;
        }
        archivesLoading = true;
        renderArchiveSelect();
        try {
            const payload = await archiveClient.list();
            if (disposed) return false;
            archives = [...(payload?.archives ?? [])].sort(
                (left, right) => String(right.updated_at).localeCompare(String(left.updated_at)),
            );
            reconcileArchiveSelection();
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
        const manager = activeArchiveManager;
        activeArchiveManager = null;
        document.removeEventListener("keydown", manager.onKeyDown, true);
        manager.overlay.remove();
        manageArchivesButton.focus();
    }

    function loadArchive(archive) {
        if (!archive || disposed) return;
        const normalized = normalizeConfigValue(JSON.stringify(archive.snapshot));
        state = normalized.state;
        serializedValue = normalized.serialized;
        parseError = null;
        activeArchiveId = archive.id;
        commit(true, true);
    }

    async function requestArchiveLoad(archive) {
        if (!archive || (archive.id === activeArchiveId && !archiveDirty)) return false;
        if (archiveDirty) {
            const proceed = await askArchiveConfirmation({
                title: "放弃未保存修改？",
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
                title: "覆盖同名存档？",
                message: `“${existing.name}”已存在，是否用当前网格状态覆盖？`,
                confirmText: "覆盖",
                danger: true,
            });
            if (!overwrite) return;
            result = await runArchiveMutation(
                () => archiveClient.update(existing.id, { snapshot: currentSnapshot() }),
                `已覆盖“${existing.name}”。`,
            );
        } else {
            result = await runArchiveMutation(
                () => archiveClient.create(name, currentSnapshot()),
                `已保存“${name}”。`,
            );
        }
        const saved = result?.archive;
        if (saved) {
            activeArchiveId = saved.id;
            reconcileArchiveSelection();
            if (activeArchiveManager) activeArchiveManager.nameInput.value = defaultArchiveName();
        }
    }

    function renderArchiveManagerList() {
        if (!activeArchiveManager) return;
        const manager = activeArchiveManager;
        manager.list.replaceChildren();
        if (!archives.length) {
            manager.list.append(element("div", "cpw-archive-manager__empty", "还没有存档。可在上方保存当前网格状态。"));
            return;
        }
        for (const archive of archives) {
            const row = element("article", "cpw-archive-manager__row");
            if (archive.id === activeArchiveId) row.classList.add("cpw-archive-manager__row--active");
            const main = element("div", "cpw-archive-manager__row-main");
            const name = element("strong", "cpw-archive-manager__row-name", archive.name);
            const enabledCount = archive.snapshot.items.filter((item) => item.enabled).length;
            const meta = element(
                "span",
                "cpw-archive-manager__row-meta",
                `${archive.snapshot.columns} 列 · ${archive.snapshot.items.length} 张卡片 · ${enabledCount} 张启用 · ${formatArchiveTime(archive.updated_at)}`,
            );
            main.append(name, meta);
            const rowActions = element("div", "cpw-archive-manager__row-actions");

            if (manager.renameId === archive.id) {
                const renameInput = element("input", "cpw-archive-manager__input cpw-archive-manager__rename-input");
                renameInput.type = "text";
                renameInput.maxLength = 80;
                renameInput.value = archive.name;
                renameInput.setAttribute("aria-label", "新的存档名称");
                const saveRename = element("button", "cpw-archive-manager__button cpw-archive-manager__button--primary", "保存名称");
                const cancelRename = element("button", "cpw-archive-manager__button", "取消");
                saveRename.type = "button";
                cancelRename.type = "button";
                main.replaceChildren(renameInput, meta);
                rowActions.append(saveRename, cancelRename);
                saveRename.addEventListener("click", async () => {
                    const nextName = renameInput.value.trim();
                    if (!nextName) {
                        setArchiveManagerMessage("存档名称不能为空。", true);
                        renameInput.focus();
                        return;
                    }
                    const result = await runArchiveMutation(
                        () => archiveClient.update(archive.id, { name: nextName }),
                        `已重命名为“${nextName}”。`,
                    );
                    if (result && activeArchiveManager) activeArchiveManager.renameId = null;
                    renderArchiveManagerList();
                });
                cancelRename.addEventListener("click", () => {
                    if (!activeArchiveManager) return;
                    activeArchiveManager.renameId = null;
                    renderArchiveManagerList();
                });
                queueMicrotask(() => {
                    renameInput.focus();
                    renameInput.select();
                });
            } else {
                for (const [label, title] of [
                    ["加载", "加载此存档"],
                    ["覆盖", "用当前网格覆盖此存档"],
                    ["重命名", "重命名此存档"],
                    ["导出", "导出此存档"],
                    ["删除", "删除此存档"],
                ]) {
                    const button = element(
                        "button",
                        `cpw-archive-manager__button${label === "删除" ? " cpw-archive-manager__button--danger-text" : ""}`,
                        label,
                    );
                    button.type = "button";
                    button.title = title;
                    rowActions.append(button);
                    if (label === "加载") {
                        button.addEventListener("click", () => requestArchiveLoad(archive));
                    } else if (label === "覆盖") {
                        button.addEventListener("click", async () => {
                            const overwrite = await askArchiveConfirmation({
                                title: "覆盖存档？",
                                message: `是否用当前网格状态覆盖“${archive.name}”？`,
                                confirmText: "覆盖",
                                danger: true,
                            });
                            if (!overwrite) return;
                            const result = await runArchiveMutation(
                                () => archiveClient.update(archive.id, { snapshot: currentSnapshot() }),
                                `已覆盖“${archive.name}”。`,
                            );
                            if (result) {
                                activeArchiveId = archive.id;
                                reconcileArchiveSelection();
                            }
                        });
                    } else if (label === "重命名") {
                        button.addEventListener("click", () => {
                            if (!activeArchiveManager) return;
                            activeArchiveManager.renameId = archive.id;
                            renderArchiveManagerList();
                        });
                    } else if (label === "导出") {
                        button.addEventListener("click", () => {
                            downloadArchiveBundle([archive], `${archive.name}.prompt-grid-archives.json`);
                            setArchiveManagerMessage(`已导出“${archive.name}”。`);
                        });
                    } else {
                        button.addEventListener("click", async () => {
                            const remove = await askArchiveConfirmation({
                                title: "删除存档？",
                                message: `“${archive.name}”删除后无法恢复，当前节点状态不会改变。`,
                                confirmText: "删除",
                                danger: true,
                            });
                            if (!remove) return;
                            const result = await runArchiveMutation(
                                () => archiveClient.delete(archive.id),
                                `已删除“${archive.name}”。`,
                            );
                            if (result) reconcileArchiveSelection();
                        });
                    }
                }
            }
            row.append(main, rowActions);
            manager.list.append(row);
        }
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
        const saveButton = element("button", "cpw-archive-manager__button cpw-archive-manager__button--primary", "保存当前");
        saveButton.type = "button";
        saveRow.append(nameInput, saveButton);

        const message = element("div", "cpw-archive-manager__message");
        message.hidden = true;
        const list = element("div", "cpw-archive-manager__list");
        const footer = element("footer", "cpw-archive-manager__footer");
        const importButton = element("button", "cpw-archive-manager__button", "导入存档");
        const exportAllButton = element("button", "cpw-archive-manager__button", "导出全部");
        const doneButton = element("button", "cpw-archive-manager__button cpw-archive-manager__button--primary", "关闭");
        for (const button of [importButton, exportAllButton, doneButton]) button.type = "button";
        const footerSpacer = element("span", "cpw-archive-manager__footer-spacer");
        footer.append(importButton, exportAllButton, footerSpacer, doneButton);

        const fileInput = element("input", "");
        fileInput.type = "file";
        fileInput.accept = ".json,application/json";
        fileInput.hidden = true;
        dialog.append(header, saveRow, message, list, footer, fileInput);
        overlay.append(dialog);

        const onKeyDown = (event) => {
            if (event.key === "Escape" && !activeArchiveConfirmation) {
                event.preventDefault();
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
            onKeyDown,
            renameId: null,
            busy: false,
        };
        overlay.addEventListener("pointerdown", (event) => {
            if (event.target === overlay && !activeArchiveConfirmation) closeArchiveManager();
        });
        closeButton.addEventListener("click", closeArchiveManager);
        doneButton.addEventListener("click", closeArchiveManager);
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
        const tokens = splitPromptTokens(originalPrompt);
        const initialSelected = tokens.map(() => true);
        const selected = initialSelected.slice();

        const overlay = element("div", "cpw-prompt-editor__overlay");
        const dialog = element("section", "cpw-prompt-editor");
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");

        const header = element("header", "cpw-prompt-editor__header");
        const title = element("h2", "cpw-prompt-editor__title", "编辑提示词");
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
        const tokenButtons = tokens.map((token, index) => {
            const button = element(
                "button",
                `cpw-prompt-editor__token cpw-prompt-editor__token--color-${index % 5}`,
                token,
            );
            button.type = "button";
            button.title = token;
            button.setAttribute("aria-pressed", "true");
            button.addEventListener("click", () => {
                selected[index] = !selected[index];
                button.classList.toggle("cpw-prompt-editor__token--inactive", !selected[index]);
                button.setAttribute("aria-pressed", String(selected[index]));
            });
            return button;
        });
        if (tokenButtons.length) {
            tokenList.append(...tokenButtons);
        } else {
            tokenList.append(element("div", "cpw-prompt-editor__empty", "当前没有可编辑的提示词。"));
        }
        content.append(tokenList);

        const footer = element("footer", "cpw-prompt-editor__footer");
        const resetSelectionButton = element("button", "cpw-prompt-editor__action", "重置");
        const confirmButton = element(
            "button",
            "cpw-prompt-editor__action cpw-prompt-editor__action--primary",
            "确认",
        );
        resetSelectionButton.type = "button";
        confirmButton.type = "button";
        footer.append(resetSelectionButton, confirmButton);
        dialog.append(header, content, footer);
        overlay.append(dialog);

        activePromptEditor = { overlay, opener };
        closeButton.addEventListener("click", () => closePromptEditor());
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) closePromptEditor();
        });
        resetSelectionButton.addEventListener("click", () => {
            for (let index = 0; index < selected.length; index += 1) {
                selected[index] = initialSelected[index];
                tokenButtons[index].classList.remove("cpw-prompt-editor__token--inactive");
                tokenButtons[index].setAttribute("aria-pressed", "true");
            }
        });
        confirmButton.addEventListener("click", () => {
            const nextPrompt = buildPromptFromSelection(
                originalPrompt,
                tokens,
                selected,
                initialSelected,
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
            const focusable = [...dialog.querySelectorAll("button:not([disabled])")];
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
        queueMicrotask(() => (tokenButtons[0] ?? confirmButton).focus());
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
    archiveSelect.addEventListener("focus", () => refreshArchives());
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
    manageArchivesButton.addEventListener("click", openArchiveManager);
    resetButton.addEventListener("click", () => {
        state = createDefaultConfig();
        parseError = null;
        commit(true);
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

    readValue(inputData?.[1]?.default ?? JSON.stringify(createDefaultConfig()));
    widget = node.addDOMWidget(inputName, WIDGET_TYPE, root, {
        serialize: true,
        hideInPanel: true,
        hideOnZoom: false,
        getValue: () => serializedValue,
        setValue: (value) => {
            if (dragSession) endPointerDrag(true);
            if (activeArchiveConfirmation) closeArchiveConfirmation(false);
            closeArchiveManager();
            readValue(value);
            render();
        },
        getMinHeight: () => 300,
        getMaxHeight: () => Math.max(300, (node.size?.[1] ?? DEFAULT_NODE_SIZE[1]) - 74),
    });
    widget.inputSpec = inputData;
    const previousOnRemove = widget.onRemove;
    widget.onRemove = function (...args) {
        if (activePromptEditor) closePromptEditor(false);
        if (activeArchiveConfirmation) closeArchiveConfirmation(false);
        closeArchiveManager();
        window.removeEventListener(ARCHIVE_SYNC_EVENT, onArchiveSync);
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
