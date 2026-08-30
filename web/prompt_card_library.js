import {
    normalizePromptCardFavoriteId,
    normalizePromptGridItemColor,
} from "./prompt_grid_archives.js?v=20260830-prompt-card-library-v1";
import { splitPromptTokens } from "./prompt_editor_tokens.js?v=20260830-retain-unselected-v1";
import { t } from "./prompt_weaver_i18n.js?v=20260831-favorite-cascade-actions-v1";

export const PROMPT_CARD_LIBRARY_SYNC_EVENT = "prompt-weaver-prompt-card-library-sync";
const BROADCAST_CHANNEL_NAME = "prompt-weaver-prompt-card-library-v1";
const MAX_CATEGORY_NAME_LENGTH = 80;
const MAX_CARD_TITLE_LENGTH = 200;
const MAX_CARD_PROMPT_LENGTH = 100_000;
const MAX_PRIMARY_CATEGORIES = 100;
const MAX_SECONDARY_CATEGORIES = 500;
const MAX_FAVORITE_CARDS = 2_000;
const FAVORITE_DELETE_CONFIRM_MS = 3_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let favoriteTooltipSequence = 0;

function element(tagName, className = "", text = null) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== null) node.textContent = text;
    return node;
}

function uuid(value) {
    return typeof value === "string" && UUID_PATTERN.test(value.trim())
        ? value.trim().toLowerCase()
        : null;
}

function timestamp(value) {
    return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

export function favoriteCardPromptCount(value) {
    return splitPromptTokens(value?.prompt).length;
}

export function favoriteCardBilingualPrompt(value, translations = []) {
    const tokens = splitPromptTokens(value?.prompt);
    const localized = Array.isArray(translations) ? translations : [];
    return {
        english: tokens.join(", "),
        chinese: tokens.map((token, index) => {
            const translation = typeof localized[index] === "string"
                ? localized[index].trim()
                : "";
            return translation && translation !== "—" ? translation : token;
        }).join("，"),
    };
}

function normalizeCategory(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const id = uuid(value.id);
    const parentId = value.parent_id === null ? null : uuid(value.parent_id);
    const name = typeof value.name === "string" ? value.name.trim() : "";
    const createdAt = timestamp(value.created_at);
    const updatedAt = timestamp(value.updated_at);
    if (
        !id
        || (value.parent_id !== null && !parentId)
        || !name
        || name.length > MAX_CATEGORY_NAME_LENGTH
        || !createdAt
        || !updatedAt
    ) return null;
    return { id, parent_id: parentId, name, created_at: createdAt, updated_at: updatedAt };
}

function normalizePromptTokens(value) {
    if (!Array.isArray(value)) return [];
    return value
        .filter((entry) => (
            entry
            && typeof entry.text === "string"
            && entry.text.trim()
            && typeof entry.selected === "boolean"
        ))
        .map((entry) => ({ text: entry.text.trim(), selected: entry.selected }));
}

export function promptCardFavoriteSnapshot(value) {
    const color = normalizePromptGridItemColor(value?.color);
    const retainUnselected = value?.retain_unselected !== false;
    const promptTokens = retainUnselected ? normalizePromptTokens(value?.prompt_tokens) : [];
    return {
        title: typeof value?.title === "string" ? value.title : "",
        prompt: typeof value?.prompt === "string" ? value.prompt : "",
        ...(color ? { color } : {}),
        ...(!retainUnselected ? { retain_unselected: false } : {}),
        ...(promptTokens.some((entry) => !entry.selected) ? { prompt_tokens: promptTokens } : {}),
    };
}

function normalizeFavoriteCard(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const id = uuid(value.id);
    const categoryId = uuid(value.category_id);
    const createdAt = timestamp(value.created_at);
    const updatedAt = timestamp(value.updated_at);
    const snapshot = promptCardFavoriteSnapshot(value);
    if (
        !id
        || !categoryId
        || snapshot.title.length > MAX_CARD_TITLE_LENGTH
        || !snapshot.prompt.trim()
        || snapshot.prompt.length > MAX_CARD_PROMPT_LENGTH
        || !createdAt
        || !updatedAt
    ) return null;
    return {
        id,
        category_id: categoryId,
        ...snapshot,
        created_at: createdAt,
        updated_at: updatedAt,
    };
}

export function normalizePromptCardLibrary(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(t("Favorite card library data is invalid."));
    }
    const revision = Number.isInteger(value.revision) && value.revision >= 0 ? value.revision : null;
    if (value.format_version !== 1 || revision === null || !Array.isArray(value.categories) || !Array.isArray(value.cards)) {
        throw new Error(t("Favorite card library data is invalid."));
    }
    const categories = value.categories.map(normalizeCategory);
    const cards = value.cards.map(normalizeFavoriteCard);
    if (categories.some((entry) => !entry) || cards.some((entry) => !entry)) {
        throw new Error(t("Favorite card library data is invalid."));
    }
    const categoryIds = new Set(categories.map((category) => category.id));
    const categoryById = new Map(categories.map((category) => [category.id, category]));
    if (categoryIds.size !== categories.length || new Set(cards.map((card) => card.id)).size !== cards.length) {
        throw new Error(t("Favorite card library data is invalid."));
    }
    const siblingNames = new Set();
    let primaryCount = 0;
    let secondaryCount = 0;
    for (const category of categories) {
        const siblingKey = `${category.parent_id ?? "root"}\u0000${category.name.toLowerCase()}`;
        if (siblingNames.has(siblingKey)) throw new Error(t("Favorite card library data is invalid."));
        siblingNames.add(siblingKey);
        if (category.parent_id === null) continue;
        const parent = categoryById.get(category.parent_id);
        if (!parent || parent.parent_id !== null) throw new Error(t("Favorite card library data is invalid."));
        secondaryCount += 1;
    }
    primaryCount = categories.length - secondaryCount;
    if (
        primaryCount > MAX_PRIMARY_CATEGORIES
        || secondaryCount > MAX_SECONDARY_CATEGORIES
        || cards.length > MAX_FAVORITE_CARDS
    ) {
        throw new Error(t("Favorite card library data is invalid."));
    }
    for (const card of cards) {
        const category = categoryById.get(card.category_id);
        if (!category || category.parent_id === null) throw new Error(t("Favorite card library data is invalid."));
    }
    return { format_version: 1, revision, categories, cards };
}

export function promptCardFavoriteFingerprint(value) {
    return JSON.stringify(promptCardFavoriteSnapshot(value));
}

export function replacePromptGridItemWithFavorite(item, favorite) {
    const {
        title: _discardedTitle,
        prompt: _discardedPrompt,
        color: _discardedColor,
        retain_unselected: _discardedRetainUnselected,
        prompt_tokens: _discardedPromptTokens,
        favorite_id: _discardedFavoriteId,
        ...preserved
    } = item && typeof item === "object" ? item : {};
    const favoriteId = normalizePromptCardFavoriteId(favorite?.id);
    return {
        ...preserved,
        ...promptCardFavoriteSnapshot(favorite),
        ...(favoriteId ? { favorite_id: favoriteId } : {}),
    };
}

export function promptCardFavoritePath(library, favoriteId) {
    const id = normalizePromptCardFavoriteId(favoriteId);
    const favorite = library?.cards?.find((card) => card.id === id);
    if (!favorite) return null;
    const secondary = library.categories.find((category) => category.id === favorite.category_id);
    const primary = secondary
        ? library.categories.find((category) => category.id === secondary.parent_id)
        : null;
    return primary && secondary ? `${primary.name} / ${secondary.name}` : null;
}

export class PromptCardLibraryClient {
    constructor(api) {
        this.api = api;
        this.basePath = "/prompt-weaver/prompt-card-library";
    }

    async request(path = "", options = {}) {
        const response = await this.api.fetchApi(`${this.basePath}${path}`, options);
        let payload = null;
        try {
            payload = await response.json();
        } catch {
            // Keep the HTTP status when an upstream failure does not return JSON.
        }
        if (!response.ok) {
            const error = new Error(
                payload?.error || t("Favorite card library request failed (HTTP {status})", { status: response.status }),
            );
            error.status = response.status;
            throw error;
        }
        return payload;
    }

    list() {
        return this.request();
    }

    createCategory(name, parentId = null) {
        return this.request("/categories", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, parent_id: parentId }),
        });
    }

    updateCategory(id, name) {
        return this.request(`/categories/${encodeURIComponent(id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
        });
    }

    deleteCategory(id, targetCategoryId = null) {
        return this.request(`/categories/${encodeURIComponent(id)}`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ target_category_id: targetCategoryId }),
        });
    }

    createCard(categoryId, snapshot) {
        return this.request("/cards", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ category_id: categoryId, snapshot }),
        });
    }

    updateCard(id, changes) {
        return this.request(`/cards/${encodeURIComponent(id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(changes),
        });
    }

    deleteCard(id) {
        return this.request(`/cards/${encodeURIComponent(id)}`, { method: "DELETE" });
    }
}

export function setPromptCardLibraryControlsBusy(root, value) {
    const busy = Boolean(value);
    for (const control of root.querySelectorAll("button, input, select")) {
        const hasStoredState = Object.prototype.hasOwnProperty.call(
            control.dataset,
            "libraryDisabledBeforeBusy",
        );
        if (busy) {
            if (!hasStoredState) {
                control.dataset.libraryDisabledBeforeBusy = String(control.disabled);
            }
            control.disabled = true;
        } else if (hasStoredState) {
            control.disabled = control.dataset.libraryDisabledBeforeBusy === "true";
            delete control.dataset.libraryDisabledBeforeBusy;
        }
    }
}

export function clampPromptCardContextMenuPosition({
    x,
    y,
    width,
    height,
    viewportWidth,
    viewportHeight,
    margin = 6,
}) {
    const safeMargin = Math.max(0, Number(margin) || 0);
    const maxX = Math.max(safeMargin, (Number(viewportWidth) || 0) - (Number(width) || 0) - safeMargin);
    const maxY = Math.max(safeMargin, (Number(viewportHeight) || 0) - (Number(height) || 0) - safeMargin);
    return {
        x: Math.min(Math.max(safeMargin, Number(x) || 0), maxX),
        y: Math.min(Math.max(safeMargin, Number(y) || 0), maxY),
    };
}

class PromptCardLibraryService {
    constructor(api) {
        this.client = new PromptCardLibraryClient(api);
        this.library = { format_version: 1, revision: 0, categories: [], cards: [] };
        this.loaded = false;
        this.loading = null;
        this.subscribers = new Set();
        this.channel = typeof BroadcastChannel === "function"
            ? new BroadcastChannel(BROADCAST_CHANNEL_NAME)
            : null;
        this.channel?.addEventListener("message", () => this.refresh(true).catch(() => {}));
        this.onWindowSync = (event) => {
            if (event?.detail?.source === this) return;
            this.refresh(true).catch(() => {});
        };
        globalThis.addEventListener?.(PROMPT_CARD_LIBRARY_SYNC_EVENT, this.onWindowSync);
    }

    subscribe(callback) {
        if (typeof callback !== "function") return () => {};
        this.subscribers.add(callback);
        return () => this.subscribers.delete(callback);
    }

    notify() {
        for (const subscriber of [...this.subscribers]) subscriber(this.library);
    }

    publish() {
        globalThis.dispatchEvent?.(new CustomEvent(PROMPT_CARD_LIBRARY_SYNC_EVENT, {
            detail: { source: this, revision: this.library.revision },
        }));
        this.channel?.postMessage({ revision: this.library.revision });
    }

    async refresh(force = false) {
        if (this.loaded && !force) return this.library;
        if (this.loading) return this.loading;
        this.loading = this.client.list()
            .then((payload) => {
                this.library = normalizePromptCardLibrary(payload);
                this.loaded = true;
                this.notify();
                return this.library;
            })
            .finally(() => {
                this.loading = null;
            });
        return this.loading;
    }

    async mutate(operation) {
        const result = await operation(this.client);
        if (result?.library) {
            this.library = normalizePromptCardLibrary(result.library);
            this.loaded = true;
            this.notify();
        } else {
            await this.refresh(true);
        }
        this.publish();
        return result;
    }
}

const services = new WeakMap();

export function getPromptCardLibraryService(api) {
    let service = services.get(api);
    if (!service) {
        service = new PromptCardLibraryService(api);
        services.set(api, service);
    }
    return service;
}

export function promptCardCascadePanelPosition({
    anchorRect,
    width,
    height,
    viewportWidth,
    viewportHeight,
    submenu = false,
    margin = 6,
    gap = 4,
}) {
    const anchor = anchorRect ?? { left: 0, right: 0, top: 0, bottom: 0 };
    const panelWidth = Math.max(0, Number(width) || 0);
    const panelHeight = Math.max(0, Number(height) || 0);
    const safeMargin = Math.max(0, Number(margin) || 0);
    const safeGap = Math.max(0, Number(gap) || 0);
    let x;
    let y;
    if (submenu) {
        const right = (Number(anchor.right) || 0) + safeGap;
        const left = (Number(anchor.left) || 0) - panelWidth - safeGap;
        x = right + panelWidth + safeMargin <= viewportWidth ? right : left;
        y = Number(anchor.top) || 0;
    } else {
        x = (Number(anchor.right) || 0) - panelWidth;
        const below = (Number(anchor.bottom) || 0) + safeGap;
        const above = (Number(anchor.top) || 0) - panelHeight - safeGap;
        y = below + panelHeight + safeMargin <= viewportHeight ? below : above;
    }
    return clampPromptCardContextMenuPosition({
        x,
        y,
        width: panelWidth,
        height: panelHeight,
        viewportWidth,
        viewportHeight,
        margin: safeMargin,
    });
}

export function promptCardCascadeTooltipPosition({
    anchorRect,
    panelRect,
    width,
    height,
    viewportWidth,
    viewportHeight,
    margin = 8,
    gap = 6,
}) {
    const anchor = anchorRect ?? { left: 0, right: 0, top: 0, bottom: 0 };
    const panel = panelRect ?? anchor;
    const tooltipWidth = Math.max(0, Number(width) || 0);
    const tooltipHeight = Math.max(0, Number(height) || 0);
    const safeMargin = Math.max(0, Number(margin) || 0);
    const safeGap = Math.max(0, Number(gap) || 0);
    const availableRight = Math.max(0, viewportWidth - (Number(panel.right) || 0) - safeGap - safeMargin);
    const availableLeft = Math.max(0, (Number(panel.left) || 0) - safeGap - safeMargin);
    const openRight = availableRight >= tooltipWidth || availableRight >= availableLeft;
    const x = openRight
        ? (Number(panel.right) || 0) + safeGap
        : (Number(panel.left) || 0) - tooltipWidth - safeGap;
    return clampPromptCardContextMenuPosition({
        x,
        y: Number(anchor.top) || 0,
        width: tooltipWidth,
        height: tooltipHeight,
        viewportWidth,
        viewportHeight,
        margin: safeMargin,
    });
}

export function openPromptCardFavoriteCascade({
    service,
    anchor,
    onChooseCard = null,
    resolvePromptTip = null,
    onClose = null,
}) {
    const root = element("div", "cpw-prompt-card-cascade");
    root.setAttribute("role", "presentation");
    document.body.append(root);
    anchor?.setAttribute?.("aria-expanded", "true");

    let library = service.library;
    let selectedPrimaryId = null;
    let selectedSecondaryId = null;
    let panels = [];
    let branchCloseTimer = 0;
    let armedDeleteCardId = null;
    let armedDeleteTimer = 0;
    let deletingCardId = null;
    let favoritePanelError = null;
    let favoriteTooltip = null;
    let favoriteTooltipAnchor = null;
    let favoriteTooltipAbortController = null;
    let favoriteTooltipGeneration = 0;
    let closed = false;
    let unsubscribe = () => {};

    const clearBranchCloseTimer = () => {
        if (!branchCloseTimer) return;
        clearTimeout(branchCloseTimer);
        branchCloseTimer = 0;
    };

    const clearDeleteConfirmTimer = () => {
        if (!armedDeleteTimer) return;
        clearTimeout(armedDeleteTimer);
        armedDeleteTimer = 0;
    };

    const syncDeleteButtons = () => {
        for (const button of root.querySelectorAll(".cpw-prompt-card-cascade__favorite-delete")) {
            const cardId = button.dataset.favoriteDeleteId;
            const cardName = button.dataset.favoriteDeleteName || t("Untitled Card");
            const deleting = deletingCardId === cardId;
            const armed = !deleting && armedDeleteCardId === cardId;
            const label = deleting
                ? t("Removing {name}…", { name: cardName })
                : (armed
                    ? t("Click again to remove {name}", { name: cardName })
                    : t("Remove {name} from favorites", { name: cardName }));
            button.textContent = deleting ? "…" : (armed ? "!" : "×");
            button.title = label;
            button.setAttribute("aria-label", label);
            button.disabled = deleting;
            button.classList.toggle("cpw-prompt-card-cascade__favorite-delete--armed", armed);
        }
    };

    const disarmFavoriteDelete = () => {
        clearDeleteConfirmTimer();
        if (!armedDeleteCardId) return false;
        armedDeleteCardId = null;
        syncDeleteButtons();
        return true;
    };

    const hideFavoriteTooltip = () => {
        favoriteTooltipGeneration += 1;
        favoriteTooltipAbortController?.abort();
        favoriteTooltipAbortController = null;
        favoriteTooltipAnchor?.removeAttribute("aria-describedby");
        favoriteTooltipAnchor = null;
        favoriteTooltip?.remove();
        favoriteTooltip = null;
    };

    const positionFavoriteTooltip = () => {
        if (!favoriteTooltip?.isConnected || !favoriteTooltipAnchor?.isConnected) return;
        const anchorRect = favoriteTooltipAnchor.getBoundingClientRect();
        const panelRect = panels[2]?.getBoundingClientRect?.() ?? anchorRect;
        const rect = favoriteTooltip.getBoundingClientRect();
        const position = promptCardCascadeTooltipPosition({
            anchorRect,
            panelRect,
            width: rect.width,
            height: rect.height,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
        });
        favoriteTooltip.style.left = `${Math.round(position.x)}px`;
        favoriteTooltip.style.top = `${Math.round(position.y)}px`;
    };

    const setFavoriteTooltipContent = (content) => {
        if (!favoriteTooltip) return;
        const fallback = favoriteCardBilingualPrompt({ prompt: "" });
        const english = typeof content?.english === "string" ? content.english : fallback.english;
        const chinese = typeof content?.chinese === "string" ? content.chinese : english;
        favoriteTooltip.querySelector(".cpw-prompt-card-cascade__tooltip-line--en").textContent = english;
        favoriteTooltip.querySelector(".cpw-prompt-card-cascade__tooltip-line--zh").textContent = chinese;
        queueMicrotask(positionFavoriteTooltip);
    };

    const showFavoriteTooltip = (card, button) => {
        if (closed || !button?.isConnected) return;
        hideFavoriteTooltip();
        const fallback = favoriteCardBilingualPrompt(card);
        const tooltip = element("div", "cpw-prompt-card-cascade__tooltip");
        tooltip.id = `cpw-prompt-card-cascade-tooltip-${++favoriteTooltipSequence}`;
        tooltip.setAttribute("role", "tooltip");
        tooltip.append(
            element("div", "cpw-prompt-card-cascade__tooltip-line cpw-prompt-card-cascade__tooltip-line--en", fallback.english),
            element("div", "cpw-prompt-card-cascade__tooltip-line cpw-prompt-card-cascade__tooltip-line--zh", fallback.chinese),
        );
        favoriteTooltip = tooltip;
        favoriteTooltipAnchor = button;
        button.setAttribute("aria-describedby", tooltip.id);
        root.append(tooltip);
        positionFavoriteTooltip();
        if (typeof resolvePromptTip !== "function") return;
        const generation = favoriteTooltipGeneration;
        const controller = new AbortController();
        favoriteTooltipAbortController = controller;
        Promise.resolve(resolvePromptTip(card, { signal: controller.signal }))
            .then((content) => {
                if (
                    controller.signal.aborted
                    || generation !== favoriteTooltipGeneration
                    || favoriteTooltipAnchor !== button
                ) return;
                setFavoriteTooltipContent(content);
            })
            .catch((error) => {
                if (error?.name !== "AbortError") {
                    console.warn("[Prompt Weaver] Could not resolve favorite card translations", error);
                }
            })
            .finally(() => {
                if (favoriteTooltipAbortController === controller) {
                    favoriteTooltipAbortController = null;
                }
            });
    };

    const syncBranchSelection = () => {
        for (const button of root.querySelectorAll(".cpw-prompt-card-cascade__item[data-category-id]")) {
            const level = Number(button.dataset.cascadeLevel);
            const selected = level === 0
                ? button.dataset.categoryId === selectedPrimaryId
                : button.dataset.categoryId === selectedSecondaryId;
            const expanded = selected && panels[level + 1]?._promptCardCascadeAnchor === button;
            button.classList.toggle("cpw-prompt-card-cascade__item--selected", selected);
            button.setAttribute("aria-expanded", String(expanded));
        }
    };

    const removePanelsFrom = (level) => {
        clearBranchCloseTimer();
        if (level <= 2) hideFavoriteTooltip();
        if (level <= 2) disarmFavoriteDelete();
        for (let index = panels.length - 1; index >= level; index -= 1) {
            panels[index]?.remove();
            panels.pop();
        }
        if (level <= 1) selectedPrimaryId = null;
        if (level <= 2) selectedSecondaryId = null;
        syncBranchSelection();
    };

    const close = ({ restoreFocus = true } = {}) => {
        if (closed) return;
        closed = true;
        clearBranchCloseTimer();
        clearDeleteConfirmTimer();
        hideFavoriteTooltip();
        unsubscribe();
        document.removeEventListener("pointerdown", onDocumentPointerDown, true);
        document.removeEventListener("keydown", onDocumentKeyDown, true);
        window.removeEventListener("resize", repositionPanels);
        window.removeEventListener("scroll", repositionPanels, true);
        anchor?.setAttribute?.("aria-expanded", "false");
        root.remove();
        onClose?.();
        if (restoreFocus && anchor?.isConnected) anchor.focus?.();
    };

    const positionPanel = (panel) => {
        if (closed) return;
        const panelAnchor = panel._promptCardCascadeAnchor;
        if (!panelAnchor?.isConnected && panelAnchor !== anchor) {
            close({ restoreFocus: false });
            return;
        }
        const anchorRect = panelAnchor?.getBoundingClientRect?.();
        if (!anchorRect) return;
        const rect = panel.getBoundingClientRect();
        const position = promptCardCascadePanelPosition({
            anchorRect,
            width: rect.width,
            height: rect.height,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            submenu: panel.dataset.level !== "0",
        });
        panel.style.left = `${Math.round(position.x)}px`;
        panel.style.top = `${Math.round(position.y)}px`;
    };

    const repositionPanels = () => {
        if (!anchor?.isConnected) {
            close({ restoreFocus: false });
            return;
        }
        for (const panel of panels) positionPanel(panel);
        positionFavoriteTooltip();
    };

    const scheduleBranchClose = (level) => {
        clearBranchCloseTimer();
        branchCloseTimer = setTimeout(() => {
            branchCloseTimer = 0;
            removePanelsFrom(level);
        }, 160);
    };

    const createPanel = (level, panelAnchor) => {
        removePanelsFrom(level);
        const panel = element("div", "cpw-prompt-card-cascade__panel");
        panel.dataset.level = String(level);
        panel.setAttribute("role", "menu");
        panel.setAttribute("aria-label", t(level === 0
            ? "Primary Categories"
            : (level === 1 ? "Secondary Categories" : "My Favorites")));
        panel._promptCardCascadeAnchor = panelAnchor;
        panel.addEventListener("pointerenter", clearBranchCloseTimer);
        panel.addEventListener("pointerleave", () => {
            if (level > 0) scheduleBranchClose(level);
        });
        panel.addEventListener("keydown", (event) => {
            const items = [...panel.querySelectorAll(
                ".cpw-prompt-card-cascade__item:not([disabled]), .cpw-prompt-card-cascade__favorite-delete:not([disabled])",
            )];
            const current = items.indexOf(document.activeElement);
            let nextIndex = null;
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close();
                return;
            }
            if (event.key === "Tab") {
                close({ restoreFocus: false });
                return;
            }
            if (event.key === "ArrowDown") nextIndex = current < 0 ? 0 : (current + 1) % items.length;
            else if (event.key === "ArrowUp") nextIndex = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
            else if (event.key === "Home") nextIndex = 0;
            else if (event.key === "End") nextIndex = items.length - 1;
            else if (event.key === "ArrowRight" && document.activeElement?._promptCardOpenSubmenu) {
                event.preventDefault();
                event.stopPropagation();
                document.activeElement._promptCardOpenSubmenu();
                queueMicrotask(() => panels[level + 1]?.querySelector(".cpw-prompt-card-cascade__item")?.focus());
                return;
            } else if (event.key === "ArrowLeft" && level > 0) {
                event.preventDefault();
                event.stopPropagation();
                const parentButton = panel._promptCardCascadeAnchor;
                removePanelsFrom(level);
                parentButton?.focus?.();
                return;
            } else if ((event.key === "Enter" || event.key === " ") && current >= 0) {
                event.preventDefault();
                event.stopPropagation();
                items[current].click();
                return;
            }
            if (nextIndex === null || !items.length) return;
            event.preventDefault();
            event.stopPropagation();
            items[nextIndex].focus();
        });
        root.append(panel);
        panels.push(panel);
        queueMicrotask(() => positionPanel(panel));
        return panel;
    };

    const emptyRow = (message) => {
        const row = element("div", "cpw-prompt-card-cascade__empty", message);
        row.setAttribute("role", "status");
        row.tabIndex = -1;
        return row;
    };

    const categoryButton = (category, level, openSubmenu) => {
        const button = element("button", "cpw-prompt-card-cascade__item");
        button.type = "button";
        button.setAttribute("role", "menuitem");
        button.setAttribute("aria-haspopup", "menu");
        button.dataset.categoryId = category.id;
        button.dataset.cascadeLevel = String(level);
        button.setAttribute("aria-expanded", "false");
        button.append(
            element("span", "cpw-prompt-card-cascade__label", category.name),
            element("span", "cpw-prompt-card-cascade__chevron", "›"),
        );
        button._promptCardOpenSubmenu = openSubmenu;
        button.addEventListener("pointerenter", () => {
            clearBranchCloseTimer();
            openSubmenu();
        });
        button.addEventListener("pointerleave", () => scheduleBranchClose(level + 1));
        button.addEventListener("click", openSubmenu);
        return button;
    };

    const favoriteRow = (card) => {
        const cardName = card.title.trim() || t("Untitled Card");
        const row = element("div", "cpw-prompt-card-cascade__favorite-row");
        row.setAttribute("role", "none");
        const chooseButton = element(
            "button",
            "cpw-prompt-card-cascade__item cpw-prompt-card-cascade__item--favorite",
        );
        chooseButton.type = "button";
        chooseButton.setAttribute("role", "menuitem");
        const titleLine = element("span", "cpw-prompt-card-cascade__favorite-title-line");
        titleLine.append(
            element("strong", "cpw-prompt-card-cascade__favorite-title", cardName),
            element("span", "cpw-prompt-card-cascade__favorite-count", `(${favoriteCardPromptCount(card)})`),
        );
        chooseButton.append(
            titleLine,
            element("span", "cpw-prompt-card-cascade__favorite-preview", card.prompt),
        );
        chooseButton.addEventListener("pointerenter", () => showFavoriteTooltip(card, chooseButton));
        chooseButton.addEventListener("pointerleave", () => {
            if (document.activeElement !== chooseButton) hideFavoriteTooltip();
        });
        chooseButton.addEventListener("focus", () => showFavoriteTooltip(card, chooseButton));
        chooseButton.addEventListener("blur", () => {
            if (!chooseButton.matches(":hover")) hideFavoriteTooltip();
        });
        chooseButton.addEventListener("click", () => {
            onChooseCard?.(card);
            close({ restoreFocus: false });
        });
        const deleteButton = element("button", "cpw-prompt-card-cascade__favorite-delete", "×");
        deleteButton.type = "button";
        deleteButton.setAttribute("role", "menuitem");
        deleteButton.dataset.favoriteDeleteId = card.id;
        deleteButton.dataset.favoriteDeleteName = cardName;
        deleteButton.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            hideFavoriteTooltip();
            if (deletingCardId) return;
            if (armedDeleteCardId !== card.id) {
                disarmFavoriteDelete();
                favoritePanelError = null;
                panels[2]?.querySelector(".cpw-prompt-card-cascade__empty--error")?.remove();
                armedDeleteCardId = card.id;
                syncDeleteButtons();
                armedDeleteTimer = setTimeout(() => {
                    armedDeleteTimer = 0;
                    disarmFavoriteDelete();
                }, FAVORITE_DELETE_CONFIRM_MS);
                return;
            }
            clearDeleteConfirmTimer();
            armedDeleteCardId = null;
            deletingCardId = card.id;
            favoritePanelError = null;
            syncDeleteButtons();
            try {
                await service.mutate((client) => client.deleteCard(card.id));
            } catch (error) {
                deletingCardId = null;
                favoritePanelError = error instanceof Error ? error.message : String(error);
                if (!closed) renderOpenBranch();
                return;
            }
            deletingCardId = null;
            if (!closed) {
                queueMicrotask(() => (
                    panels[2]?.querySelector(".cpw-prompt-card-cascade__item--favorite")
                    ?? panels[2]?.querySelector(".cpw-prompt-card-cascade__empty")
                )?.focus?.());
            }
        });
        row.append(chooseButton, deleteButton);
        return row;
    };

    const openFavoritePanel = (secondary, button, { preserveFavoriteError = false } = {}) => {
        const changingBranch = selectedSecondaryId !== secondary.id;
        const panel = createPanel(2, button);
        if (changingBranch && !preserveFavoriteError) favoritePanelError = null;
        selectedSecondaryId = secondary.id;
        syncBranchSelection();
        const cards = library.cards.filter((card) => card.category_id === secondary.id);
        if (favoritePanelError) {
            const errorRow = emptyRow(favoritePanelError);
            errorRow.classList.add("cpw-prompt-card-cascade__empty--error");
            panel.append(errorRow);
        }
        if (cards.length) {
            for (const card of cards) panel.append(favoriteRow(card));
        } else {
            panel.append(emptyRow(t("There are no favorite cards in this category.")));
        }
        syncDeleteButtons();
        positionPanel(panel);
    };

    const openSecondaryPanel = (primary, button, { preserveFavoriteError = false } = {}) => {
        const panel = createPanel(1, button);
        selectedPrimaryId = primary.id;
        selectedSecondaryId = null;
        if (!preserveFavoriteError) favoritePanelError = null;
        syncBranchSelection();
        const categories = categoryChildren(library, primary.id);
        if (categories.length) {
            for (const category of categories) {
                let categoryNode = null;
                const openSubmenu = () => openFavoritePanel(category, categoryNode);
                categoryNode = categoryButton(category, 1, openSubmenu);
                panel.append(categoryNode);
            }
        } else {
            panel.append(emptyRow(t("There are no secondary categories.")));
        }
        positionPanel(panel);
    };

    const renderPrimaryPanel = ({ focus = false, error = null } = {}) => {
        removePanelsFrom(0);
        const panel = createPanel(0, anchor);
        if (error) {
            const message = emptyRow(error instanceof Error ? error.message : String(error));
            message.classList.add("cpw-prompt-card-cascade__empty--error");
            const retry = element("button", "cpw-prompt-card-cascade__retry", t("Retry"));
            retry.type = "button";
            retry.addEventListener("click", () => load(true));
            panel.append(message, retry);
        } else if (!service.loaded) {
            panel.append(emptyRow(t("Loading favorites…")));
        } else {
            const categories = categoryChildren(library, null);
            if (categories.length) {
                for (const category of categories) {
                    let categoryNode = null;
                    const openSubmenu = () => openSecondaryPanel(category, categoryNode);
                    categoryNode = categoryButton(category, 0, openSubmenu);
                    panel.append(categoryNode);
                }
            } else {
                panel.append(emptyRow(t("There are no primary categories.")));
            }
        }
        positionPanel(panel);
        if (focus) queueMicrotask(() => panel.querySelector("button:not([disabled])")?.focus());
    };

    const renderOpenBranch = ({ focus = false, error = null } = {}) => {
        const primaryId = selectedPrimaryId;
        const secondaryId = selectedSecondaryId;
        renderPrimaryPanel({ focus, error });
        if (error || !service.loaded || !primaryId) return;
        const primary = library.categories.find((item) => (
            item.id === primaryId && item.parent_id === null
        ));
        const primaryButton = panels[0]?.querySelector(
            `.cpw-prompt-card-cascade__item[data-category-id="${primaryId}"]`,
        );
        if (!primary || !primaryButton) return;
        openSecondaryPanel(primary, primaryButton, { preserveFavoriteError: true });
        if (!secondaryId) return;
        const secondary = library.categories.find((item) => (
            item.id === secondaryId && item.parent_id === primaryId
        ));
        const secondaryButton = panels[1]?.querySelector(
            `.cpw-prompt-card-cascade__item[data-category-id="${secondaryId}"]`,
        );
        if (secondary && secondaryButton) {
            openFavoritePanel(secondary, secondaryButton, { preserveFavoriteError: true });
        }
    };

    const load = async (force = false) => {
        renderPrimaryPanel();
        try {
            library = await service.refresh(force);
            if (!closed) renderOpenBranch({ focus: force });
        } catch (error) {
            if (!closed) renderPrimaryPanel({ error, focus: true });
        }
    };

    const onDocumentPointerDown = (event) => {
        if (armedDeleteCardId) {
            const deleteButton = event.target?.closest?.(".cpw-prompt-card-cascade__favorite-delete");
            if (deleteButton?.dataset.favoriteDeleteId !== armedDeleteCardId) {
                disarmFavoriteDelete();
            }
        }
        if (!root.contains(event.target) && !anchor?.contains?.(event.target)) {
            close({ restoreFocus: false });
        }
    };
    const onDocumentKeyDown = (event) => {
        if (event.key !== "Escape") return;
        hideFavoriteTooltip();
        if (disarmFavoriteDelete()) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        event.preventDefault();
        close();
    };

    unsubscribe = service.subscribe((nextLibrary) => {
        library = nextLibrary;
        if (!closed) renderOpenBranch();
    });
    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    document.addEventListener("keydown", onDocumentKeyDown, true);
    window.addEventListener("resize", repositionPanels);
    window.addEventListener("scroll", repositionPanels, true);
    load(false);

    return { root, anchor, close };
}

function categoryChildren(library, parentId) {
    return library.categories.filter((category) => category.parent_id === parentId);
}

function categoryContainsCards(library, category) {
    const categoryIds = category.parent_id === null
        ? new Set([category.id, ...categoryChildren(library, category.id).map((item) => item.id)])
        : new Set([category.id]);
    return library.cards.some((card) => categoryIds.has(card.category_id));
}

function openConfirmDialog({ title, message, confirmText, danger = false, selectOptions = null }) {
    return new Promise((resolve) => {
        const overlay = element("div", "cpw-prompt-card-confirm__overlay");
        const dialog = element("section", "cpw-prompt-card-confirm");
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
        dialog.setAttribute("aria-label", title);
        const heading = element("h3", "cpw-prompt-card-confirm__title", title);
        const body = element("p", "cpw-prompt-card-confirm__message", message);
        const select = selectOptions ? element("select", "cpw-prompt-card-confirm__select") : null;
        if (select) {
            select.setAttribute("aria-label", t("Move favorites to"));
            for (const option of selectOptions) {
                const node = element("option", "", option.label);
                node.value = option.value;
                select.append(node);
            }
        }
        const actions = element("div", "cpw-prompt-card-confirm__actions");
        const cancel = element("button", "cpw-prompt-card-confirm__button", t("Cancel"));
        const confirm = element(
            "button",
            `cpw-prompt-card-confirm__button${danger ? " cpw-prompt-card-confirm__button--danger" : ""}`,
            confirmText,
        );
        cancel.type = "button";
        confirm.type = "button";
        confirm.disabled = Boolean(select && !select.options.length);
        actions.append(cancel, confirm);
        dialog.append(heading, body);
        if (select) dialog.append(select);
        dialog.append(actions);
        overlay.append(dialog);
        const close = (value) => {
            document.removeEventListener("keydown", onKeyDown, true);
            overlay.remove();
            resolve(value);
        };
        const onKeyDown = (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                close(null);
            }
        };
        overlay.addEventListener("pointerdown", (event) => {
            if (event.target === overlay) close(null);
        });
        cancel.addEventListener("click", () => close(null));
        confirm.addEventListener("click", () => close(select ? select.value : true));
        document.addEventListener("keydown", onKeyDown, true);
        document.body.append(overlay);
        queueMicrotask(() => (select ?? confirm).focus());
    });
}

export function openPromptCardLibraryMenu({
    service,
    anchor,
    mode = "browse",
    favoriteId = null,
    getSnapshot = null,
    onChooseCard = null,
    onFavoriteLinked = null,
    onClose = null,
}) {
    const root = element("section", "cpw-prompt-card-library");
    root.classList.toggle("cpw-prompt-card-library--assign", mode === "assign");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", t("Favorite Cards"));
    root.tabIndex = -1;
    const header = element("header", "cpw-prompt-card-library__header");
    const heading = element("strong", "cpw-prompt-card-library__heading", t("Favorite Cards"));
    const closeButton = element("button", "cpw-prompt-card-library__close", "×");
    closeButton.type = "button";
    closeButton.title = t("Close");
    closeButton.setAttribute("aria-label", t("Close favorite cards"));
    header.append(heading, closeButton);
    const status = element("div", "cpw-prompt-card-library__status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.hidden = true;
    const panels = element("div", "cpw-prompt-card-library__panels");
    root.append(header, status, panels);
    document.body.append(root);

    let library = service.library;
    let selectedPrimaryId = null;
    let selectedSecondaryId = null;
    let mobileLevel = 0;
    let editingCategoryId = null;
    let creatingParentId = undefined;
    let movingCardId = null;
    let busy = false;
    let closed = false;
    let favoriteSelectionInitialized = false;
    let activeContextMenu = null;

    const closeContextMenu = ({ restoreFocus = false } = {}) => {
        const menu = activeContextMenu;
        if (!menu) return;
        activeContextMenu = null;
        const menuAnchor = menu._promptCardAnchor;
        menu.remove();
        if (restoreFocus && menuAnchor?.isConnected) menuAnchor.focus?.();
    };

    const openContextMenu = ({ anchor: menuAnchor, x, y, items, focus = false }) => {
        closeContextMenu();
        const menu = element("div", "cpw-prompt-card-library__context-menu");
        menu.setAttribute("role", "menu");
        menu._promptCardAnchor = menuAnchor;
        for (const item of items) {
            const button = element(
                "button",
                item.danger ? "cpw-prompt-card-library__context-item cpw-prompt-card-library__danger" : "cpw-prompt-card-library__context-item",
                item.label,
            );
            button.type = "button";
            button.setAttribute("role", "menuitem");
            button.addEventListener("click", () => {
                closeContextMenu();
                item.onSelect?.();
            });
            menu.append(button);
        }
        for (const eventName of ["pointerdown", "pointerup", "click", "keyup"]) {
            menu.addEventListener(eventName, (event) => event.stopPropagation());
        }
        menu.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        menu.addEventListener("keydown", (event) => {
            const controls = [...menu.querySelectorAll("button:not([disabled])")];
            const current = controls.indexOf(document.activeElement);
            let next = null;
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeContextMenu({ restoreFocus: true });
                return;
            }
            if (event.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % controls.length;
            else if (event.key === "ArrowUp") next = current < 0 ? controls.length - 1 : (current - 1 + controls.length) % controls.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = controls.length - 1;
            if (next === null || !controls.length) return;
            event.preventDefault();
            event.stopPropagation();
            controls[next].focus();
        });
        activeContextMenu = menu;
        document.body.append(menu);
        const rect = menu.getBoundingClientRect();
        const position = clampPromptCardContextMenuPosition({
            x,
            y,
            width: rect.width,
            height: rect.height,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
        });
        menu.style.left = `${Math.round(position.x)}px`;
        menu.style.top = `${Math.round(position.y)}px`;
        if (focus) queueMicrotask(() => menu.querySelector("button:not([disabled])")?.focus());
    };

    const setStatus = (message = "", error = false) => {
        const visible = Boolean(message) && Boolean(error);
        status.textContent = visible ? message : "";
        status.hidden = !visible;
        status.classList.toggle("cpw-prompt-card-library__status--error", visible);
    };

    const setRetryStatus = (message) => {
        const text = element("span", "", message);
        const retry = element("button", "cpw-prompt-card-library__retry", t("Retry"));
        retry.type = "button";
        retry.addEventListener("click", async () => {
            setStatus(t("Loading favorites…"));
            try {
                library = await service.refresh(true);
                setStatus("");
                render();
                queueMicrotask(() => root.querySelector("button:not([disabled])")?.focus());
            } catch (error) {
                setRetryStatus(error instanceof Error ? error.message : String(error));
            }
        });
        status.replaceChildren(text, retry);
        status.hidden = false;
        status.classList.add("cpw-prompt-card-library__status--error");
    };

    const currentFavorite = () => {
        const id = normalizePromptCardFavoriteId(favoriteId);
        return id ? library.cards.find((card) => card.id === id) ?? null : null;
    };

    const close = ({ restoreFocus = true } = {}) => {
        if (closed) return;
        closed = true;
        closeContextMenu();
        unsubscribe();
        document.removeEventListener("pointerdown", onDocumentPointerDown, true);
        document.removeEventListener("keydown", onDocumentKeyDown, true);
        window.removeEventListener("resize", onViewportChange);
        window.removeEventListener("scroll", onViewportChange, true);
        root.remove();
        onClose?.();
        if (restoreFocus && anchor?.isConnected) anchor.focus?.();
    };

    const position = () => {
        if (closed || !anchor?.isConnected) return;
        const viewportMargin = 8;
        const anchorRect = anchor.getBoundingClientRect();
        const narrow = window.innerWidth < 680;
        root.classList.toggle("cpw-prompt-card-library--narrow", narrow);
        root.dataset.mobileLevel = String(mobileLevel);
        root.style.maxHeight = `${Math.max(220, window.innerHeight - viewportMargin * 2)}px`;
        const rect = root.getBoundingClientRect();
        const left = Math.min(
            Math.max(viewportMargin, anchorRect.left + anchorRect.width / 2 - rect.width / 2),
            Math.max(viewportMargin, window.innerWidth - rect.width - viewportMargin),
        );
        const spaceBelow = window.innerHeight - anchorRect.bottom - viewportMargin;
        const top = spaceBelow >= rect.height || anchorRect.top < spaceBelow
            ? anchorRect.bottom + 4
            : Math.max(viewportMargin, anchorRect.top - rect.height - 4);
        root.style.left = `${Math.round(left)}px`;
        root.style.top = `${Math.round(top)}px`;
    };

    const onViewportChange = () => {
        closeContextMenu();
        position();
    };

    const categoryPath = (categoryId) => {
        const secondary = library.categories.find((category) => category.id === categoryId);
        const primary = secondary
            ? library.categories.find((category) => category.id === secondary.parent_id)
            : null;
        return primary && secondary ? `${primary.name} / ${secondary.name}` : secondary?.name ?? "";
    };

    const setBusy = (value) => {
        busy = Boolean(value);
        root.classList.toggle("cpw-prompt-card-library--busy", busy);
        root.setAttribute("aria-busy", String(busy));
        setPromptCardLibraryControlsBusy(root, busy);
    };

    const runMutation = async (operation, successMessage = "") => {
        if (busy) return null;
        setBusy(true);
        setStatus(t("Saving…"));
        try {
            const result = await service.mutate(operation);
            library = service.library;
            setStatus(successMessage);
            return result;
        } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error), true);
            return null;
        } finally {
            setBusy(false);
            render();
        }
    };

    const saveCategoryName = async (category, parentId, input) => {
        const name = input.value.trim();
        if (!name) {
            input.focus();
            setStatus(t("Category name cannot be empty."), true);
            return;
        }
        if (name.length > MAX_CATEGORY_NAME_LENGTH) {
            setStatus(t("Category name is too long."), true);
            input.focus();
            return;
        }
        const result = category
            ? await runMutation(
                (client) => client.updateCategory(category.id, name),
                t("Category renamed."),
            )
            : await runMutation(
                (client) => client.createCategory(name, parentId),
                t("Category created."),
            );
        if (!result) return;
        editingCategoryId = null;
        creatingParentId = undefined;
        const saved = result.category;
        if (saved?.parent_id === null) selectedPrimaryId = saved.id;
        else if (saved) {
            selectedPrimaryId = saved.parent_id;
            selectedSecondaryId = saved.id;
        }
        render();
    };

    const startCategoryEditor = (category = null, parentId = null) => {
        editingCategoryId = category?.id ?? null;
        creatingParentId = category ? undefined : parentId;
        closeContextMenu();
        render();
        queueMicrotask(() => root.querySelector(".cpw-prompt-card-library__category-input")?.focus());
    };

    const deleteCategory = async (category) => {
        const hasCards = categoryContainsCards(library, category);
        const removedIds = new Set([category.id]);
        if (category.parent_id === null) {
            for (const child of categoryChildren(library, category.id)) removedIds.add(child.id);
        }
        const targetOptions = library.categories
            .filter((candidate) => candidate.parent_id !== null && !removedIds.has(candidate.id))
            .map((candidate) => ({ value: candidate.id, label: categoryPath(candidate.id) }));
        const target = await openConfirmDialog({
            title: t("Delete category?"),
            message: hasCards
                ? (targetOptions.length
                    ? t("Favorites in this category must be moved before deletion.")
                    : t("Create another secondary category before deleting this category."))
                : t("The category will be permanently deleted."),
            confirmText: t("Delete"),
            danger: true,
            selectOptions: hasCards ? targetOptions : null,
        });
        if (!target) return;
        const result = await runMutation(
            (client) => client.deleteCategory(category.id, hasCards ? target : null),
            t("Category deleted."),
        );
        if (!result) return;
        if (removedIds.has(selectedPrimaryId)) selectedPrimaryId = null;
        if (removedIds.has(selectedSecondaryId)) selectedSecondaryId = null;
        mobileLevel = selectedPrimaryId ? 1 : 0;
        render();
    };

    const chooseSecondary = async (category) => {
        selectedSecondaryId = category.id;
        if (movingCardId) {
            const moving = movingCardId;
            const result = await runMutation(
                (client) => client.updateCard(moving, { category_id: category.id }),
                t("Favorite moved to {path}.", { path: categoryPath(category.id) }),
            );
            if (result) movingCardId = null;
            mobileLevel = 2;
            render();
            return;
        }
        if (mode !== "assign") {
            mobileLevel = 2;
            render();
            return;
        }
        const snapshot = promptCardFavoriteSnapshot(getSnapshot?.() ?? {});
        if (!snapshot.prompt.trim()) {
            setStatus(t("Enter a prompt before adding it to favorites."), true);
            return;
        }
        const favorite = currentFavorite();
        const result = favorite
            ? await runMutation(
                (client) => client.updateCard(favorite.id, { category_id: category.id }),
                t("Favorite moved to {path}.", { path: categoryPath(category.id) }),
            )
            : await runMutation(
                (client) => client.createCard(category.id, snapshot),
                t("Card added to favorites."),
            );
        const saved = result?.card;
        if (saved) {
            favoriteId = saved.id;
            onFavoriteLinked?.(saved.id);
            library = service.library;
            render();
        }
    };

    const updateCurrentFavorite = async () => {
        const favorite = currentFavorite();
        const snapshot = promptCardFavoriteSnapshot(getSnapshot?.() ?? {});
        if (!favorite || !snapshot.prompt.trim()) return;
        const result = await runMutation(
            (client) => client.updateCard(favorite.id, { snapshot }),
            t("Favorite updated."),
        );
        if (result) render();
    };

    const removeCurrentFavorite = async () => {
        const favorite = currentFavorite();
        if (!favorite) return;
        const confirmed = await openConfirmDialog({
            title: t("Remove favorite?"),
            message: t("This favorite card will be permanently removed from the library."),
            confirmText: t("Remove"),
            danger: true,
        });
        if (!confirmed) return;
        const result = await runMutation(
            (client) => client.deleteCard(favorite.id),
            t("Favorite removed."),
        );
        if (result) {
            favoriteId = null;
            onFavoriteLinked?.(null);
            render();
        }
    };

    const deleteFavorite = async (card) => {
        const confirmed = await openConfirmDialog({
            title: t("Remove favorite?"),
            message: t("This favorite card will be permanently removed from the library."),
            confirmText: t("Remove"),
            danger: true,
        });
        if (!confirmed) return;
        const result = await runMutation(
            (client) => client.deleteCard(card.id),
            t("Favorite removed."),
        );
        if (result && card.id === normalizePromptCardFavoriteId(favoriteId)) {
            favoriteId = null;
            onFavoriteLinked?.(null);
        }
    };

    const categoryEditor = (category, parentId) => {
        const row = element("form", "cpw-prompt-card-library__inline-editor");
        const input = element("input", "cpw-prompt-card-library__category-input");
        input.type = "text";
        input.maxLength = MAX_CATEGORY_NAME_LENGTH;
        input.value = category?.name ?? "";
        input.placeholder = t(category ? "Category name" : "New category name");
        input.setAttribute("aria-label", input.placeholder);
        const save = element("button", "cpw-prompt-card-library__inline-save", t("Save"));
        const cancel = element("button", "cpw-prompt-card-library__inline-cancel", t("Cancel"));
        save.type = "submit";
        cancel.type = "button";
        row.append(input, save, cancel);
        row.addEventListener("submit", (event) => {
            event.preventDefault();
            saveCategoryName(category, parentId, input);
        });
        cancel.addEventListener("click", () => {
            editingCategoryId = null;
            creatingParentId = undefined;
            render();
        });
        input.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                editingCategoryId = null;
                creatingParentId = undefined;
                render();
            }
        });
        return row;
    };

    const categoryRow = (category, level) => {
        if (editingCategoryId === category.id) return categoryEditor(category, category.parent_id);
        const wrapper = element("div", "cpw-prompt-card-library__row-wrap");
        const row = element("div", "cpw-prompt-card-library__row");
        const button = element("button", "cpw-prompt-card-library__row-main", category.name);
        button.type = "button";
        button.dataset.libraryLevel = String(level);
        button.title = t("Right-click for category actions");
        button.setAttribute("aria-haspopup", "menu");
        button.classList.toggle(
            "cpw-prompt-card-library__row-main--selected",
            level === 0 ? selectedPrimaryId === category.id : selectedSecondaryId === category.id,
        );
        const chevron = element("span", "cpw-prompt-card-library__chevron", "›");
        chevron.setAttribute("aria-hidden", "true");
        button.append(chevron);
        button.addEventListener("pointerenter", () => {
            if (busy) return;
            if (level === 0) {
                if (selectedPrimaryId === category.id) return;
                selectedPrimaryId = category.id;
                selectedSecondaryId = null;
            } else if (mode !== "assign" && !movingCardId) {
                if (selectedSecondaryId === category.id) return;
                selectedSecondaryId = category.id;
            } else return;
            render();
        });
        button.addEventListener("click", () => {
            closeContextMenu();
            if (level === 0) {
                selectedPrimaryId = category.id;
                selectedSecondaryId = null;
                mobileLevel = 1;
                render();
            } else chooseSecondary(category);
        });
        const openActions = ({ x, y, focus = false }) => {
            openContextMenu({
                anchor: button,
                x,
                y,
                focus,
                items: [
                    { label: t("Rename"), onSelect: () => startCategoryEditor(category) },
                    { label: t("Delete"), danger: true, onSelect: () => deleteCategory(category) },
                ],
            });
        };
        row.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            event.stopPropagation();
            openActions({ x: event.clientX, y: event.clientY });
        });
        button.addEventListener("keydown", (event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            event.stopPropagation();
            const rect = button.getBoundingClientRect();
            openActions({ x: rect.left + 8, y: rect.bottom + 4, focus: true });
        });
        row.append(button);
        wrapper.append(row);
        return wrapper;
    };

    const panelHeader = (label, {
        backLevel = null,
        createLevel = null,
        parentId = null,
    } = {}) => {
        const panelHeaderNode = element("div", "cpw-prompt-card-library__panel-header");
        if (backLevel !== null) {
            const back = element("button", "cpw-prompt-card-library__back", "‹");
            back.type = "button";
            back.title = t("Back");
            back.setAttribute("aria-label", t("Back"));
            back.addEventListener("click", () => {
                mobileLevel = backLevel;
                render();
            });
            panelHeaderNode.append(back);
        }
        panelHeaderNode.append(element("span", "cpw-prompt-card-library__panel-title", label));
        if (createLevel) {
            const isPrimary = createLevel === "primary";
            const tooltip = t(isPrimary ? "New Primary Category" : "New Secondary Category");
            const add = element("button", "cpw-prompt-card-library__panel-add", "+");
            add.type = "button";
            add.title = tooltip;
            add.setAttribute("aria-label", tooltip);
            add.disabled = !isPrimary && !parentId;
            add.addEventListener("click", () => {
                if (!isPrimary && !parentId) return;
                startCategoryEditor(null, isPrimary ? null : parentId);
            });
            panelHeaderNode.append(add);
        }
        return panelHeaderNode;
    };

    const favoriteCardRow = (card) => {
        const wrapper = element("div", "cpw-prompt-card-library__favorite-wrap");
        const row = element("div", "cpw-prompt-card-library__favorite-row");
        const choose = element("button", "cpw-prompt-card-library__favorite-main");
        choose.type = "button";
        choose.title = t("Right-click for favorite actions");
        choose.setAttribute("aria-haspopup", "menu");
        const title = element("strong", "cpw-prompt-card-library__favorite-title", card.title.trim() || t("Untitled Card"));
        const preview = element("span", "cpw-prompt-card-library__favorite-preview", card.prompt);
        choose.append(title, preview);
        choose.addEventListener("click", () => {
            closeContextMenu();
            onChooseCard?.(card);
            close({ restoreFocus: false });
        });
        const openActions = ({ x, y, focus = false }) => {
            openContextMenu({
                anchor: choose,
                x,
                y,
                focus,
                items: [
                    {
                        label: t("Move"),
                        onSelect: () => {
                            movingCardId = card.id;
                            selectedPrimaryId = null;
                            selectedSecondaryId = null;
                            mobileLevel = 0;
                            setStatus(t("Choose a destination secondary category."));
                            render();
                        },
                    },
                    { label: t("Remove"), danger: true, onSelect: () => deleteFavorite(card) },
                ],
            });
        };
        row.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            event.stopPropagation();
            openActions({ x: event.clientX, y: event.clientY });
        });
        choose.addEventListener("keydown", (event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            event.stopPropagation();
            const rect = choose.getBoundingClientRect();
            openActions({ x: rect.left + 8, y: rect.bottom + 4, focus: true });
        });
        row.append(choose);
        wrapper.append(row);
        return wrapper;
    };

    const renderAssignActions = (container) => {
        if (mode !== "assign") return;
        const favorite = currentFavorite();
        if (!favorite) return;
        const actionBar = element("div", "cpw-prompt-card-library__assign-actions");
        const path = element("span", "cpw-prompt-card-library__current-path", categoryPath(favorite.category_id));
        const snapshot = promptCardFavoriteSnapshot(getSnapshot?.() ?? {});
        const dirty = promptCardFavoriteFingerprint(snapshot) !== promptCardFavoriteFingerprint(favorite);
        const update = element("button", "", t("Update Favorite"));
        const remove = element("button", "cpw-prompt-card-library__danger", t("Remove Favorite"));
        update.type = "button";
        remove.type = "button";
        update.disabled = !dirty || !snapshot.prompt.trim();
        update.title = dirty ? t("Update the saved snapshot from this card") : t("Favorite is up to date");
        update.addEventListener("click", updateCurrentFavorite);
        remove.addEventListener("click", removeCurrentFavorite);
        actionBar.append(path, update, remove);
        container.append(actionBar);
    };

    function render() {
        if (closed) return;
        closeContextMenu();
        if (mode === "assign" && !favoriteSelectionInitialized) {
            const favorite = currentFavorite();
            const secondary = favorite
                ? library.categories.find((category) => category.id === favorite.category_id)
                : null;
            if (secondary?.parent_id) {
                selectedPrimaryId = secondary.parent_id;
                selectedSecondaryId = secondary.id;
                favoriteSelectionInitialized = true;
            } else if (service.loaded) {
                favoriteSelectionInitialized = true;
            }
        }
        const primaryCategories = categoryChildren(library, null);
        if (selectedPrimaryId && !primaryCategories.some((item) => item.id === selectedPrimaryId)) {
            selectedPrimaryId = null;
            selectedSecondaryId = null;
        }
        const primary = primaryCategories.find((item) => item.id === selectedPrimaryId) ?? null;
        const secondaryCategories = primary ? categoryChildren(library, primary.id) : [];
        if (selectedSecondaryId && !secondaryCategories.some((item) => item.id === selectedSecondaryId)) {
            selectedSecondaryId = null;
        }
        const secondary = secondaryCategories.find((item) => item.id === selectedSecondaryId) ?? null;

        const primaryPanel = element("section", "cpw-prompt-card-library__panel");
        primaryPanel.dataset.level = "0";
        primaryPanel.append(panelHeader(t("Primary Categories"), { createLevel: "primary" }));
        renderAssignActions(primaryPanel);
        const primaryList = element("div", "cpw-prompt-card-library__list");
        if (primaryCategories.length) {
            for (const category of primaryCategories) primaryList.append(categoryRow(category, 0));
        } else {
            primaryList.append(element("div", "cpw-prompt-card-library__empty", t("Create a primary category to begin.")));
        }
        if (creatingParentId === null) primaryList.append(categoryEditor(null, null));
        primaryPanel.append(primaryList);

        const secondaryPanel = element("section", "cpw-prompt-card-library__panel");
        secondaryPanel.dataset.level = "1";
        secondaryPanel.append(panelHeader(t("Secondary Categories"), {
            backLevel: 0,
            createLevel: "secondary",
            parentId: primary?.id ?? null,
        }));
        const secondaryList = element("div", "cpw-prompt-card-library__list");
        if (primary) {
            if (secondaryCategories.length) {
                for (const category of secondaryCategories) secondaryList.append(categoryRow(category, 1));
            } else {
                secondaryList.append(element("div", "cpw-prompt-card-library__empty", t("Create a secondary category for favorite cards.")));
            }
            if (creatingParentId === primary.id) {
                secondaryList.append(categoryEditor(null, primary.id));
            }
        } else {
            secondaryList.append(element("div", "cpw-prompt-card-library__empty", t("Choose a primary category.")));
        }
        secondaryPanel.append(secondaryList);

        const cardPanel = element("section", "cpw-prompt-card-library__panel");
        cardPanel.dataset.level = "2";
        cardPanel.append(panelHeader(t("My Favorites"), { backLevel: 1 }));
        const cardList = element("div", "cpw-prompt-card-library__list");
        const cards = secondary ? library.cards.filter((card) => card.category_id === secondary.id) : [];
        if (cards.length) {
            for (const card of cards) cardList.append(favoriteCardRow(card));
        } else {
            cardList.append(element(
                "div",
                "cpw-prompt-card-library__empty",
                secondary ? t("There are no favorite cards in this category.") : t("Choose a secondary category."),
            ));
        }
        cardPanel.append(cardList);
        panels.replaceChildren(primaryPanel, secondaryPanel);
        if (mode !== "assign") panels.append(cardPanel);
        root.dataset.mobileLevel = String(mobileLevel);
        setBusy(busy);
        position();
    }

    const onDocumentPointerDown = (event) => {
        if (activeContextMenu?.contains(event.target)) return;
        closeContextMenu();
        if (!root.contains(event.target) && !anchor?.contains?.(event.target)) close({ restoreFocus: false });
    };

    const focusPanelItem = (direction) => {
        const panel = root.querySelector(
            `.cpw-prompt-card-library__panel[data-level="${root.classList.contains("cpw-prompt-card-library--narrow") ? mobileLevel : Math.min(mobileLevel, mode === "assign" ? 1 : 2)}"]`,
        ) ?? root.querySelector(".cpw-prompt-card-library__panel");
        const buttons = [...panel.querySelectorAll("button:not([disabled])")].filter((button) => button.offsetParent !== null);
        if (!buttons.length) return;
        const index = buttons.indexOf(document.activeElement);
        const next = direction === "home"
            ? 0
            : direction === "end"
                ? buttons.length - 1
                : (index < 0 ? 0 : (index + direction + buttons.length) % buttons.length);
        buttons[next].focus();
    };

    const onDocumentKeyDown = (event) => {
        if (closed || !root.contains(document.activeElement)) return;
        if (event.key === "Escape") {
            event.preventDefault();
            close();
        } else if (event.key === "ArrowDown") {
            event.preventDefault();
            focusPanelItem(1);
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            focusPanelItem(-1);
        } else if (event.key === "Home") {
            event.preventDefault();
            focusPanelItem("home");
        } else if (event.key === "End") {
            event.preventDefault();
            focusPanelItem("end");
        } else if (event.key === "ArrowRight" && mobileLevel < (mode === "assign" ? 1 : 2)) {
            event.preventDefault();
            mobileLevel += 1;
            render();
            queueMicrotask(() => focusPanelItem("home"));
        } else if (event.key === "ArrowLeft" && mobileLevel > 0) {
            event.preventDefault();
            mobileLevel -= 1;
            render();
            queueMicrotask(() => focusPanelItem("home"));
        } else if (event.key === "Tab") {
            close({ restoreFocus: false });
        }
    };

    const unsubscribe = service.subscribe((nextLibrary) => {
        library = nextLibrary;
        render();
    });
    closeButton.addEventListener("click", () => close());
    for (const eventName of ["pointerdown", "pointerup", "click", "keydown", "keyup", "input", "change"]) {
        root.addEventListener(eventName, (event) => event.stopPropagation());
    }
    root.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    document.addEventListener("keydown", onDocumentKeyDown, true);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    render();
    setStatus(t("Loading favorites…"));
    service.refresh()
        .then((nextLibrary) => {
            if (closed) return;
            library = nextLibrary;
            setStatus("");
            render();
            queueMicrotask(() => root.querySelector("button:not([disabled])")?.focus());
        })
        .catch((error) => {
            if (closed) return;
            setRetryStatus(error instanceof Error ? error.message : String(error));
            render();
        });
    position();
    return { close, root };
}
