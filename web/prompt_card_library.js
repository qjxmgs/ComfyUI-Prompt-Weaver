import {
    normalizePromptCardFavoriteId,
    normalizePromptGridItemColor,
} from "./prompt_grid_archives.js?v=20260830-prompt-card-library-v1";
import { splitPromptTokens } from "./prompt_editor_tokens.js?v=20260830-retain-unselected-v1";
import { t } from "./prompt_weaver_i18n.js?v=20260901-favorite-category-order-v1";

export const PROMPT_CARD_LIBRARY_SYNC_EVENT = "prompt-weaver-prompt-card-library-sync";
const BROADCAST_CHANNEL_NAME = "prompt-weaver-prompt-card-library-v1";
const MAX_CATEGORY_NAME_LENGTH = 80;
const MAX_CARD_TITLE_LENGTH = 200;
const MAX_CARD_PROMPT_LENGTH = 100_000;
const MAX_PRIMARY_CATEGORIES = 100;
const MAX_SECONDARY_CATEGORIES = 500;
const MAX_FAVORITE_CARDS = 2_000;
const FAVORITE_DELETE_CONFIRM_MS = 3_000;
const FAVORITE_GEOMETRY_STORAGE_KEY = "prompt-weaver-prompt-card-library-geometry-v1";
const FAVORITE_WINDOW_MARGIN = 8;
const FAVORITE_WINDOW_MIN_WIDTH = 340;
const FAVORITE_WINDOW_MIN_HEIGHT = 240;
const FAVORITE_WINDOW_DEFAULT_WIDTH = 660;
const FAVORITE_WINDOW_DEFAULT_HEIGHT = 320;
const FAVORITE_WINDOW_NARROW_WIDTH = 620;
const FAVORITE_DRAG_SCROLL_EDGE = 32;
const FAVORITE_DRAG_SCROLL_MAX_SPEED = 12;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let favoriteTooltipSequence = 0;

function element(tagName, className = "", text = null) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== null) node.textContent = text;
    return node;
}

function createFavoriteDeleteController({ root, isBusy = () => false }) {
    let armedCardId = null;
    let armedTimer = 0;
    let deletingCardId = null;

    const clearConfirmTimer = () => {
        if (!armedTimer) return;
        clearTimeout(armedTimer);
        armedTimer = 0;
    };

    const sync = () => {
        for (const button of root.querySelectorAll(".cpw-prompt-card-favorite-delete")) {
            const cardId = button.dataset.favoriteDeleteId;
            const cardName = button.dataset.favoriteDeleteName || t("Untitled Card");
            const deleting = deletingCardId === cardId;
            const armed = !deleting && armedCardId === cardId;
            const label = deleting
                ? t("Removing {name}…", { name: cardName })
                : (armed
                    ? t("Click again to remove {name}", { name: cardName })
                    : t("Remove {name} from favorites", { name: cardName }));
            button.textContent = deleting ? "…" : (armed ? "!" : "×");
            button.title = label;
            button.setAttribute("aria-label", label);
            button.disabled = isBusy() || Boolean(deletingCardId);
            button.classList.toggle("cpw-prompt-card-favorite-delete--armed", armed);
        }
    };

    const disarm = () => {
        clearConfirmTimer();
        if (!armedCardId) return false;
        armedCardId = null;
        sync();
        return true;
    };

    const arm = (cardId) => {
        if (!cardId || isBusy() || deletingCardId) return false;
        disarm();
        armedCardId = cardId;
        sync();
        armedTimer = setTimeout(() => {
            armedTimer = 0;
            disarm();
        }, FAVORITE_DELETE_CONFIRM_MS);
        return true;
    };

    const beginDelete = (cardId) => {
        if (!cardId || isBusy() || deletingCardId || armedCardId !== cardId) return false;
        clearConfirmTimer();
        armedCardId = null;
        deletingCardId = cardId;
        sync();
        return true;
    };

    const finishDelete = (cardId) => {
        if (cardId && deletingCardId !== cardId) return;
        deletingCardId = null;
        sync();
    };

    const createButton = ({ className, card, role = null, onBeforeAction = null, onArm = null, onDelete }) => {
        const cardName = card.title.trim() || t("Untitled Card");
        const button = element(
            "button",
            `cpw-prompt-card-favorite-delete ${className}`,
            "×",
        );
        button.type = "button";
        if (role) button.setAttribute("role", role);
        button.dataset.favoriteDeleteId = card.id;
        button.dataset.favoriteDeleteName = cardName;
        button.addEventListener("pointerdown", (event) => event.stopPropagation());
        button.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            onBeforeAction?.();
            if (isBusy() || deletingCardId) return;
            if (armedCardId !== card.id) {
                if (arm(card.id)) onArm?.();
                return;
            }
            if (!beginDelete(card.id)) return;
            try {
                await onDelete?.();
            } finally {
                finishDelete(card.id);
            }
        });
        button.addEventListener("blur", () => {
            if (armedCardId === card.id) disarm();
        });
        queueMicrotask(sync);
        return button;
    };

    const handlePointerDown = (event) => {
        if (!armedCardId) return false;
        const button = event.target?.closest?.(".cpw-prompt-card-favorite-delete");
        if (button?.dataset.favoriteDeleteId === armedCardId) return false;
        return disarm();
    };

    const destroy = () => {
        clearConfirmTimer();
        armedCardId = null;
        deletingCardId = null;
    };

    return { createButton, destroy, disarm, handlePointerDown, sync };
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

export function promptCardFavoriteMoveTarget(library, favoriteId, categoryId) {
    const cardId = normalizePromptCardFavoriteId(favoriteId);
    const targetId = normalizePromptCardFavoriteId(categoryId);
    const card = library?.cards?.find((candidate) => candidate.id === cardId) ?? null;
    const category = library?.categories?.find((candidate) => candidate.id === targetId) ?? null;
    const allowed = Boolean(card && category && category.parent_id !== null);
    return {
        allowed,
        changed: allowed && card.category_id !== category.id,
        changes: allowed && card.category_id !== category.id ? { category_id: category.id } : null,
    };
}

export function promptCardFavoriteReorder(cardIds, movedId, insertionIndex) {
    const ids = Array.isArray(cardIds) ? cardIds.slice() : [];
    const sourceIndex = ids.indexOf(movedId);
    if (sourceIndex < 0) return { ids, changed: false };
    const boundary = Math.min(ids.length, Math.max(0, Math.trunc(Number(insertionIndex) || 0)));
    const reordered = ids.slice();
    reordered.splice(sourceIndex, 1);
    const targetIndex = boundary > sourceIndex ? boundary - 1 : boundary;
    reordered.splice(Math.min(reordered.length, Math.max(0, targetIndex)), 0, movedId);
    return {
        ids: reordered,
        changed: reordered.some((id, index) => id !== ids[index]),
    };
}

export function promptCardCategoryPosition(categories, categoryId, targetParentId, insertionIndex) {
    const items = Array.isArray(categories) ? categories : [];
    const category = items.find((candidate) => candidate?.id === categoryId) ?? null;
    const normalizedParent = targetParentId ?? null;
    const targetParent = normalizedParent === null
        ? null
        : items.find((candidate) => candidate?.id === normalizedParent) ?? null;
    const allowed = Boolean(
        category
        && (
            (category.parent_id === null && normalizedParent === null)
            || (category.parent_id !== null && targetParent?.parent_id === null)
        )
    );
    if (!allowed) return { allowed: false, changed: false, parentId: normalizedParent, index: 0 };
    const targetSiblings = items.filter((candidate) => candidate?.parent_id === normalizedParent);
    const sourceIndex = targetSiblings.findIndex((candidate) => candidate.id === categoryId);
    const boundary = Math.min(
        targetSiblings.length,
        Math.max(0, Math.trunc(Number(insertionIndex) || 0)),
    );
    const index = sourceIndex >= 0 && boundary > sourceIndex ? boundary - 1 : boundary;
    return {
        allowed: true,
        changed: category.parent_id !== normalizedParent || index !== sourceIndex,
        parentId: normalizedParent,
        index,
    };
}

export function normalizePromptCardLibraryGeometry(value, {
    viewportWidth,
    viewportHeight,
    margin = FAVORITE_WINDOW_MARGIN,
    minWidth = FAVORITE_WINDOW_MIN_WIDTH,
    minHeight = FAVORITE_WINDOW_MIN_HEIGHT,
} = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const numbers = [value.left, value.top, value.width, value.height].map(Number);
    if (!numbers.every(Number.isFinite)) return null;
    const availableWidth = Math.max(1, Number(viewportWidth) - margin * 2);
    const availableHeight = Math.max(1, Number(viewportHeight) - margin * 2);
    const width = Math.min(availableWidth, Math.max(Math.min(minWidth, availableWidth), numbers[2]));
    const height = Math.min(availableHeight, Math.max(Math.min(minHeight, availableHeight), numbers[3]));
    const left = Math.min(
        Math.max(margin, numbers[0]),
        Math.max(margin, Number(viewportWidth) - width - margin),
    );
    const top = Math.min(
        Math.max(margin, numbers[1]),
        Math.max(margin, Number(viewportHeight) - height - margin),
    );
    return { left, top, width, height };
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

    positionCategory(id, parentId, index) {
        return this.request(`/categories/${encodeURIComponent(id)}/position`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parent_id: parentId, index }),
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

    reorderCards(categoryId, cardIds) {
        return this.request("/cards/order", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ category_id: categoryId, card_ids: cardIds }),
        });
    }

    positionCard(id, categoryId, index) {
        return this.request(`/cards/${encodeURIComponent(id)}/position`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ category_id: categoryId, index }),
        });
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
    let favoritePanelError = null;
    let favoriteTooltip = null;
    let favoriteTooltipAnchor = null;
    let favoriteTooltipAbortController = null;
    let favoriteTooltipGeneration = 0;
    let closed = false;
    let unsubscribe = () => {};
    const deleteController = createFavoriteDeleteController({ root });

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
        const tooltip = element(
            "div",
            "cpw-prompt-card-cascade__tooltip cpw-prompt-card-library__tooltip",
        );
        tooltip.id = `cpw-prompt-card-cascade-tooltip-${++favoriteTooltipSequence}`;
        tooltip.setAttribute("role", "tooltip");
        tooltip.append(
            element("div", "cpw-prompt-card-cascade__tooltip-line cpw-prompt-card-cascade__tooltip-line--en", fallback.english),
            element("div", "cpw-prompt-card-cascade__tooltip-line cpw-prompt-card-cascade__tooltip-line--zh", fallback.chinese),
        );
        favoriteTooltip = tooltip;
        favoriteTooltipAnchor = button;
        button.setAttribute("aria-describedby", tooltip.id);
        document.body.append(tooltip);
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
        if (level <= 2) hideFavoriteTooltip();
        if (level <= 2) deleteController.disarm();
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
        deleteController.destroy();
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

    const createPanel = (level, panelAnchor) => {
        removePanelsFrom(level);
        const panel = element("div", "cpw-prompt-card-cascade__panel");
        panel.dataset.level = String(level);
        panel.setAttribute("role", "menu");
        panel.setAttribute("aria-label", t(level === 0
            ? "Primary Categories"
            : (level === 1 ? "Secondary Categories" : "My Favorites")));
        panel._promptCardCascadeAnchor = panelAnchor;
        panel.addEventListener("pointerenter", () => {
            if (level < 2) hideFavoriteTooltip();
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
        button.addEventListener("pointerenter", openSubmenu);
        button.addEventListener("click", openSubmenu);
        return button;
    };

    const favoriteRow = (card) => {
        const cardName = card.title.trim() || t("Untitled Card");
        const row = element("div", "cpw-prompt-card-cascade__favorite-row");
        row.setAttribute("role", "none");
        row.dataset.favoriteCardId = card.id;
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
        const deleteButton = deleteController.createButton({
            className: "cpw-prompt-card-cascade__favorite-delete",
            card,
            role: "menuitem",
            onBeforeAction: hideFavoriteTooltip,
            onArm: () => {
                favoritePanelError = null;
                panels[2]?.querySelector(".cpw-prompt-card-cascade__empty--error")?.remove();
            },
            onDelete: async () => {
                favoritePanelError = null;
                const siblings = library.cards.filter((candidate) => candidate.category_id === card.category_id);
                const deletedIndex = Math.max(0, siblings.findIndex((candidate) => candidate.id === card.id));
                try {
                    await service.mutate((client) => client.deleteCard(card.id));
                } catch (error) {
                    favoritePanelError = error instanceof Error ? error.message : String(error);
                    if (!closed) renderOpenBranch();
                    queueMicrotask(() => panels[2]?.querySelector(
                        `[data-favorite-card-id="${card.id}"] .cpw-prompt-card-cascade__item--favorite`,
                    )?.focus?.());
                    return;
                }
                if (!closed) {
                    const remaining = library.cards.filter((candidate) => candidate.category_id === card.category_id);
                    const nextCard = remaining[Math.min(deletedIndex, Math.max(0, remaining.length - 1))] ?? null;
                    queueMicrotask(() => (
                        (nextCard && panels[2]?.querySelector(
                            `[data-favorite-card-id="${nextCard.id}"] .cpw-prompt-card-cascade__item--favorite`,
                        ))
                        ?? panels[2]?.querySelector(".cpw-prompt-card-cascade__empty")
                    )?.focus?.());
                }
            },
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
        deleteController.sync();
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
        deleteController.handlePointerDown(event);
        if (!root.contains(event.target) && !anchor?.contains?.(event.target)) {
            close({ restoreFocus: false });
        }
    };
    const onDocumentKeyDown = (event) => {
        if (event.key !== "Escape") return;
        hideFavoriteTooltip();
        if (deleteController.disarm()) {
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
    resolvePromptTip = null,
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
    const resizeHandle = element("div", "cpw-prompt-card-library__resize-handle");
    resizeHandle.tabIndex = 0;
    resizeHandle.setAttribute("role", "separator");
    resizeHandle.setAttribute("aria-orientation", "horizontal");
    resizeHandle.title = t("Resize Favorite Cards");
    resizeHandle.setAttribute("aria-label", t("Resize Favorite Cards"));
    root.append(header, status, panels, resizeHandle);
    document.body.append(root);

    let library = service.library;
    let selectedPrimaryId = null;
    let selectedSecondaryId = null;
    let mobileLevel = 0;
    let editingCategoryId = null;
    let editingFavoriteId = null;
    let creatingParentId = undefined;
    let movingCardId = null;
    let movingCategoryId = null;
    let busy = false;
    let closed = false;
    let favoriteSelectionInitialized = false;
    let activeContextMenu = null;
    let favoriteTooltip = null;
    let favoriteTooltipAnchor = null;
    let favoriteTooltipAbortController = null;
    let favoriteTooltipGeneration = 0;
    let draggingCardId = null;
    let draggingSourceCategoryId = null;
    let favoriteInsertionIndex = null;
    let favoriteDragScrollFrame = 0;
    let favoriteDragScrollSpeed = 0;
    let favoriteDragScrollList = null;
    let favoriteDragClientY = null;
    let draggingCategoryId = null;
    let categoryInsertionIndex = null;
    let categoryDragTargetParentId = undefined;
    let categoryDragScrollFrame = 0;
    let categoryDragScrollSpeed = 0;
    let categoryDragScrollList = null;
    let categoryDragClientY = null;
    let geometryInitialized = false;
    let windowMoveSession = null;
    let windowResizeSession = null;
    let renderPrimaryDragPreview = null;
    let renderSecondaryDragPreview = null;
    const deleteController = createFavoriteDeleteController({ root, isBusy: () => busy });

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
        const panelRect = favoriteTooltipAnchor
            .closest(".cpw-prompt-card-library__panel")
            ?.getBoundingClientRect?.() ?? anchorRect;
        const rect = favoriteTooltip.getBoundingClientRect();
        const tooltipPosition = promptCardCascadeTooltipPosition({
            anchorRect,
            panelRect,
            width: rect.width,
            height: rect.height,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
        });
        favoriteTooltip.style.left = `${Math.round(tooltipPosition.x)}px`;
        favoriteTooltip.style.top = `${Math.round(tooltipPosition.y)}px`;
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
        const tooltip = element(
            "div",
            "cpw-prompt-card-cascade__tooltip cpw-prompt-card-library__tooltip",
        );
        tooltip.id = `cpw-prompt-card-library-tooltip-${++favoriteTooltipSequence}`;
        tooltip.setAttribute("role", "tooltip");
        tooltip.append(
            element("div", "cpw-prompt-card-cascade__tooltip-line cpw-prompt-card-cascade__tooltip-line--en", fallback.english),
            element("div", "cpw-prompt-card-cascade__tooltip-line cpw-prompt-card-cascade__tooltip-line--zh", fallback.chinese),
        );
        favoriteTooltip = tooltip;
        favoriteTooltipAnchor = button;
        button.setAttribute("aria-describedby", tooltip.id);
        document.body.append(tooltip);
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

    const clearDragState = ({ renderAfter = false } = {}) => {
        const hadDrag = Boolean(draggingCardId);
        const sourceCategoryId = draggingSourceCategoryId;
        draggingCardId = null;
        draggingSourceCategoryId = null;
        favoriteInsertionIndex = null;
        favoriteDragScrollSpeed = 0;
        favoriteDragScrollList = null;
        favoriteDragClientY = null;
        if (favoriteDragScrollFrame) cancelAnimationFrame(favoriteDragScrollFrame);
        favoriteDragScrollFrame = 0;
        root.classList.remove("cpw-prompt-card-library--dragging");
        for (const row of root.querySelectorAll(".cpw-prompt-card-library__favorite-row--dragging")) {
            row.classList.remove("cpw-prompt-card-library__favorite-row--dragging");
        }
        for (const target of root.querySelectorAll(
            ".cpw-prompt-card-library__row-main--drag-expand, .cpw-prompt-card-library__row-main--drop-target, .cpw-prompt-card-library__favorite-wrap--insert-before, .cpw-prompt-card-library__favorite-wrap--insert-after",
        )) {
            target.classList.remove(
                "cpw-prompt-card-library__row-main--drag-expand",
                "cpw-prompt-card-library__row-main--drop-target",
                "cpw-prompt-card-library__favorite-wrap--insert-before",
                "cpw-prompt-card-library__favorite-wrap--insert-after",
            );
        }
        if (hadDrag && renderAfter && sourceCategoryId) {
            const sourceCategory = library.categories.find((category) => category.id === sourceCategoryId);
            if (sourceCategory?.parent_id) {
                selectedPrimaryId = sourceCategory.parent_id;
                selectedSecondaryId = sourceCategory.id;
                mobileLevel = 2;
            }
        }
        if (hadDrag && renderAfter && !closed) render();
    };

    const clearCategoryDragState = ({ renderAfter = false } = {}) => {
        const hadDrag = Boolean(draggingCategoryId);
        draggingCategoryId = null;
        categoryInsertionIndex = null;
        categoryDragTargetParentId = undefined;
        categoryDragScrollSpeed = 0;
        categoryDragScrollList = null;
        categoryDragClientY = null;
        if (categoryDragScrollFrame) cancelAnimationFrame(categoryDragScrollFrame);
        categoryDragScrollFrame = 0;
        root.classList.remove("cpw-prompt-card-library--category-dragging");
        for (const row of root.querySelectorAll(".cpw-prompt-card-library__row--dragging")) {
            row.classList.remove("cpw-prompt-card-library__row--dragging");
        }
        for (const target of root.querySelectorAll(
            ".cpw-prompt-card-library__row-main--drop-target, .cpw-prompt-card-library__row-wrap--insert-before, .cpw-prompt-card-library__row-wrap--insert-after",
        )) {
            target.classList.remove(
                "cpw-prompt-card-library__row-main--drop-target",
                "cpw-prompt-card-library__row-wrap--insert-before",
                "cpw-prompt-card-library__row-wrap--insert-after",
            );
        }
        if (hadDrag && renderAfter && !closed) render();
    };

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
            button.disabled = Boolean(item.disabled);
            button.addEventListener("click", () => {
                if (button.disabled) return;
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

    const readStoredGeometry = () => {
        try {
            const raw = localStorage.getItem(FAVORITE_GEOMETRY_STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    };

    const currentGeometry = () => {
        const rect = root.getBoundingClientRect();
        return normalizePromptCardLibraryGeometry({
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
        }, {
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
        });
    };

    const persistGeometry = () => {
        if (!geometryInitialized || closed) return;
        const geometry = currentGeometry();
        if (!geometry) return;
        try {
            localStorage.setItem(FAVORITE_GEOMETRY_STORAGE_KEY, JSON.stringify(geometry));
        } catch {
            // Geometry persistence is optional and must never block favorites.
        }
    };

    const applyGeometry = (geometry) => {
        if (!geometry) return;
        root.style.left = `${Math.round(geometry.left)}px`;
        root.style.top = `${Math.round(geometry.top)}px`;
        root.style.width = `${Math.round(geometry.width)}px`;
        root.style.height = `${Math.round(geometry.height)}px`;
        root.style.maxHeight = "none";
        root.classList.toggle(
            "cpw-prompt-card-library--narrow",
            geometry.width < FAVORITE_WINDOW_NARROW_WIDTH,
        );
        root.dataset.mobileLevel = String(mobileLevel);
    };

    const close = ({ restoreFocus = true } = {}) => {
        if (closed) return;
        persistGeometry();
        closed = true;
        deleteController.destroy();
        hideFavoriteTooltip();
        clearDragState();
        clearCategoryDragState();
        closeContextMenu();
        unsubscribe();
        document.removeEventListener("pointerdown", onDocumentPointerDown, true);
        document.removeEventListener("keydown", onDocumentKeyDown, true);
        document.removeEventListener("dragend", onDocumentDragEnd, true);
        window.removeEventListener("resize", onViewportResize);
        window.removeEventListener("scroll", onViewportScroll, true);
        document.removeEventListener("pointermove", onWindowPointerMove, true);
        document.removeEventListener("pointerup", onWindowPointerUp, true);
        document.removeEventListener("pointercancel", onWindowPointerUp, true);
        root.remove();
        onClose?.();
        if (restoreFocus && anchor?.isConnected) anchor.focus?.();
    };

    const position = () => {
        if (closed) return;
        if (geometryInitialized) {
            applyGeometry(currentGeometry());
            return;
        }
        const stored = normalizePromptCardLibraryGeometry(readStoredGeometry(), {
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
        });
        if (stored) {
            geometryInitialized = true;
            applyGeometry(stored);
            return;
        }
        if (!anchor?.isConnected) return;
        const anchorRect = anchor.getBoundingClientRect();
        const width = Math.min(
            FAVORITE_WINDOW_DEFAULT_WIDTH,
            Math.max(1, window.innerWidth - FAVORITE_WINDOW_MARGIN * 2),
        );
        const height = Math.min(
            FAVORITE_WINDOW_DEFAULT_HEIGHT,
            Math.max(1, window.innerHeight - FAVORITE_WINDOW_MARGIN * 2),
        );
        const preferredLeft = anchorRect.left + anchorRect.width / 2 - width / 2;
        const spaceBelow = window.innerHeight - anchorRect.bottom - FAVORITE_WINDOW_MARGIN;
        const preferredTop = spaceBelow >= height || anchorRect.top < spaceBelow
            ? anchorRect.bottom + 4
            : anchorRect.top - height - 4;
        const fallback = normalizePromptCardLibraryGeometry({
            left: preferredLeft,
            top: preferredTop,
            width,
            height,
        }, {
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
        });
        geometryInitialized = true;
        applyGeometry(fallback);
    };

    const onViewportResize = () => {
        closeContextMenu();
        position();
        positionFavoriteTooltip();
    };

    const onViewportScroll = () => {
        positionFavoriteTooltip();
    };

    const onWindowPointerMove = (event) => {
        if (windowMoveSession?.pointerId === event.pointerId) {
            event.preventDefault();
            applyGeometry(normalizePromptCardLibraryGeometry({
                left: windowMoveSession.left + event.clientX - windowMoveSession.x,
                top: windowMoveSession.top + event.clientY - windowMoveSession.y,
                width: windowMoveSession.width,
                height: windowMoveSession.height,
            }, {
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
            }));
            positionFavoriteTooltip();
        } else if (windowResizeSession?.pointerId === event.pointerId) {
            event.preventDefault();
            applyGeometry(normalizePromptCardLibraryGeometry({
                left: windowResizeSession.left,
                top: windowResizeSession.top,
                width: windowResizeSession.width + event.clientX - windowResizeSession.x,
                height: windowResizeSession.height + event.clientY - windowResizeSession.y,
            }, {
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
            }));
            positionFavoriteTooltip();
        }
    };

    const onWindowPointerUp = (event) => {
        const handled = windowMoveSession?.pointerId === event.pointerId
            || windowResizeSession?.pointerId === event.pointerId;
        if (!handled) return;
        windowMoveSession = null;
        windowResizeSession = null;
        root.classList.remove(
            "cpw-prompt-card-library--moving",
            "cpw-prompt-card-library--resizing",
        );
        persistGeometry();
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
        editingFavoriteId = null;
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
        deleteController.disarm();
        hideFavoriteTooltip();
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
        mobileLevel = 2;
        render();
    };

    const createFavoriteFromDraft = async () => {
        const snapshot = promptCardFavoriteSnapshot(getSnapshot?.() ?? {});
        if (!selectedSecondaryId || !snapshot.prompt.trim()) {
            setStatus(t("Enter a prompt before adding it to favorites."), true);
            return;
        }
        const result = await runMutation(
            (client) => client.createCard(selectedSecondaryId, snapshot),
            t("Card added to favorites."),
        );
        const saved = result?.card;
        if (!saved) return;
        favoriteId = saved.id;
        onFavoriteLinked?.(saved.id);
        render();
    };

    const overwriteFavoriteFromDraft = async (card) => {
        deleteController.disarm();
        hideFavoriteTooltip();
        const snapshot = promptCardFavoriteSnapshot(getSnapshot?.() ?? {});
        if (!snapshot.prompt.trim()) {
            setStatus(t("Enter a prompt before overwriting a favorite."), true);
            return;
        }
        const cardName = card.title.trim() || t("Untitled Card");
        const confirmed = await openConfirmDialog({
            title: t("Overwrite favorite card?"),
            message: t('Replace "{name}" with the current editor draft?', { name: cardName }),
            confirmText: t("Overwrite"),
        });
        if (!confirmed) return;
        const result = await runMutation(
            (client) => client.updateCard(card.id, { snapshot }),
            t("Favorite updated."),
        );
        const saved = result?.card;
        if (!saved) return;
        favoriteId = saved.id;
        onFavoriteLinked?.(saved.id);
        render();
    };

    const saveFavoriteName = async (card, input) => {
        const name = input.value.trim();
        if (!name) {
            setStatus(t("Favorite card title cannot be empty."), true);
            input.focus();
            return;
        }
        if (name.length > MAX_CARD_TITLE_LENGTH) {
            setStatus(t("Favorite card title is too long."), true);
            input.focus();
            return;
        }
        if (name === card.title) {
            editingFavoriteId = null;
            setStatus();
            render();
            return;
        }
        const snapshot = promptCardFavoriteSnapshot({ ...card, title: name });
        const result = await runMutation(
            (client) => client.updateCard(card.id, { snapshot }),
            t("Favorite renamed."),
        );
        if (!result) return;
        editingFavoriteId = null;
        render();
    };

    const startFavoriteEditor = (card) => {
        if (busy) return;
        editingCategoryId = null;
        creatingParentId = undefined;
        editingFavoriteId = card.id;
        deleteController.disarm();
        hideFavoriteTooltip();
        closeContextMenu();
        render();
        queueMicrotask(() => {
            const input = root.querySelector(
                `.cpw-prompt-card-library__favorite-rename-input[data-favorite-card-id="${card.id}"]`,
            );
            input?.focus();
            input?.select();
        });
    };

    const deleteFavorite = async (card) => {
        const siblings = library.cards.filter((candidate) => candidate.category_id === card.category_id);
        const deletedIndex = Math.max(0, siblings.findIndex((candidate) => candidate.id === card.id));
        const result = await runMutation(
            (client) => client.deleteCard(card.id),
            t("Favorite removed."),
        );
        if (!result) {
            queueMicrotask(() => root.querySelector(
                `[data-favorite-card-id="${card.id}"] .cpw-prompt-card-library__favorite-main`,
            )?.focus?.());
            return;
        }
        if (card.id === normalizePromptCardFavoriteId(favoriteId)) {
            favoriteId = null;
            onFavoriteLinked?.(null);
        }
        render();
        const remaining = library.cards.filter((candidate) => candidate.category_id === card.category_id);
        const nextCard = remaining[Math.min(deletedIndex, Math.max(0, remaining.length - 1))] ?? null;
        queueMicrotask(() => (
            (nextCard && root.querySelector(
                `[data-favorite-card-id="${nextCard.id}"] .cpw-prompt-card-library__favorite-main`,
            ))
            ?? root.querySelector('.cpw-prompt-card-library__panel[data-level="2"] .cpw-prompt-card-library__empty')
            ?? root.querySelector('.cpw-prompt-card-library__panel[data-level="2"] button:not([disabled])')
        )?.focus?.());
    };

    const moveFavoriteToCategory = async (cardId, category) => {
        const card = library.cards.find((candidate) => candidate.id === cardId);
        const target = promptCardFavoriteMoveTarget(library, cardId, category.id);
        if (!card || !target.allowed || !target.changed) {
            clearDragState({ renderAfter: true });
            return;
        }
        clearDragState();
        selectedPrimaryId = category.parent_id;
        selectedSecondaryId = category.id;
        mobileLevel = 2;
        await runMutation(
            (client) => client.updateCard(card.id, target.changes),
            t("Favorite moved to {path}.", { path: categoryPath(category.id) }),
        );
    };

    const reorderFavoriteCards = async (cardId, insertionIndex) => {
        const categoryId = selectedSecondaryId;
        const cards = categoryId
            ? library.cards.filter((candidate) => candidate.category_id === categoryId)
            : [];
        const reordered = promptCardFavoriteReorder(
            cards.map((candidate) => candidate.id),
            cardId,
            insertionIndex,
        );
        clearDragState();
        if (!categoryId || !reordered.changed) {
            render();
            queueMicrotask(() => root.querySelector(
                `[data-favorite-card-id="${cardId}"] .cpw-prompt-card-library__favorite-main`,
            )?.focus?.());
            return;
        }
        const result = await runMutation(
            (client) => client.reorderCards(categoryId, reordered.ids),
            t("Favorite order updated."),
        );
        if (!result) return;
        queueMicrotask(() => root.querySelector(
            `[data-favorite-card-id="${cardId}"] .cpw-prompt-card-library__favorite-main`,
        )?.focus?.());
    };

    const reorderFavoriteByCommand = (card, command) => {
        const cards = library.cards.filter((candidate) => candidate.category_id === card.category_id);
        const index = cards.findIndex((candidate) => candidate.id === card.id);
        if (index < 0) return;
        const insertionIndex = command === "top"
            ? 0
            : command === "up"
                ? Math.max(0, index - 1)
                : command === "down"
                    ? Math.min(cards.length, index + 2)
                    : cards.length;
        reorderFavoriteCards(card.id, insertionIndex);
    };

    const moveFavoriteToPosition = async (cardId, category, insertionIndex) => {
        const card = library.cards.find((candidate) => candidate.id === cardId);
        if (!card || !category?.id || card.category_id === category.id) {
            clearDragState({ renderAfter: true });
            return;
        }
        clearDragState();
        selectedPrimaryId = category.parent_id;
        selectedSecondaryId = category.id;
        mobileLevel = 2;
        const result = await runMutation(
            (client) => client.positionCard(card.id, category.id, insertionIndex),
            t("Favorite moved to {path}.", { path: categoryPath(category.id) }),
        );
        if (!result) return;
        queueMicrotask(() => root.querySelector(
            `[data-favorite-card-id="${card.id}"] .cpw-prompt-card-library__favorite-main`,
        )?.focus?.());
    };

    const runFavoriteDragScroll = () => {
        favoriteDragScrollFrame = 0;
        if (!draggingCardId || !favoriteDragScrollList?.isConnected || !favoriteDragScrollSpeed) return;
        const previousScrollTop = favoriteDragScrollList.scrollTop;
        favoriteDragScrollList.scrollTop += favoriteDragScrollSpeed;
        if (favoriteDragScrollList.scrollTop === previousScrollTop) {
            favoriteDragScrollSpeed = 0;
            return;
        }
        if (favoriteDragClientY !== null) {
            updateFavoriteInsertion(favoriteDragScrollList, favoriteDragClientY);
        }
        positionFavoriteTooltip();
        favoriteDragScrollFrame = requestAnimationFrame(runFavoriteDragScroll);
    };

    const updateFavoriteDragScroll = (list, clientY) => {
        const rect = list.getBoundingClientRect();
        let speed = 0;
        if (clientY < rect.top + FAVORITE_DRAG_SCROLL_EDGE) {
            const ratio = Math.min(1, (rect.top + FAVORITE_DRAG_SCROLL_EDGE - clientY) / FAVORITE_DRAG_SCROLL_EDGE);
            speed = -Math.max(2, Math.round(FAVORITE_DRAG_SCROLL_MAX_SPEED * ratio));
        } else if (clientY > rect.bottom - FAVORITE_DRAG_SCROLL_EDGE) {
            const ratio = Math.min(1, (clientY - (rect.bottom - FAVORITE_DRAG_SCROLL_EDGE)) / FAVORITE_DRAG_SCROLL_EDGE);
            speed = Math.max(2, Math.round(FAVORITE_DRAG_SCROLL_MAX_SPEED * ratio));
        }
        favoriteDragScrollList = list;
        favoriteDragScrollSpeed = speed;
        favoriteDragClientY = clientY;
        if (speed && !favoriteDragScrollFrame) {
            favoriteDragScrollFrame = requestAnimationFrame(runFavoriteDragScroll);
        } else if (!speed && favoriteDragScrollFrame) {
            cancelAnimationFrame(favoriteDragScrollFrame);
            favoriteDragScrollFrame = 0;
        }
    };

    const updateFavoriteInsertion = (list, clientY) => {
        const wrappers = [...list.querySelectorAll(":scope > .cpw-prompt-card-library__favorite-wrap")];
        for (const wrapper of wrappers) {
            wrapper.classList.remove(
                "cpw-prompt-card-library__favorite-wrap--insert-before",
                "cpw-prompt-card-library__favorite-wrap--insert-after",
            );
        }
        let boundary = wrappers.length;
        for (let index = 0; index < wrappers.length; index += 1) {
            const rect = wrappers[index].getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) {
                boundary = index;
                break;
            }
        }
        favoriteInsertionIndex = boundary;
        if (!wrappers.length) return;
        if (boundary < wrappers.length) {
            wrappers[boundary].classList.add("cpw-prompt-card-library__favorite-wrap--insert-before");
        } else {
            wrappers.at(-1).classList.add("cpw-prompt-card-library__favorite-wrap--insert-after");
        }
    };

    const configureFavoriteDropList = (list, secondary, cards, { allowCrossCategory = false } = {}) => {
        list.addEventListener("dragover", (event) => {
            if (!draggingCardId || !secondary) return;
            const dragged = library.cards.find((candidate) => candidate.id === draggingCardId);
            if (!dragged || (!allowCrossCategory && dragged.category_id !== secondary.id)) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
            updateFavoriteInsertion(list, event.clientY);
            updateFavoriteDragScroll(list, event.clientY);
        });
        list.addEventListener("drop", (event) => {
            if (!draggingCardId || !secondary) return;
            const dragged = library.cards.find((candidate) => candidate.id === draggingCardId);
            if (!dragged || (!allowCrossCategory && dragged.category_id !== secondary.id)) return;
            event.preventDefault();
            event.stopPropagation();
            const insertionIndex = favoriteInsertionIndex ?? cards.length;
            if (dragged.category_id === secondary.id) {
                reorderFavoriteCards(draggingCardId, insertionIndex);
            } else {
                moveFavoriteToPosition(draggingCardId, secondary, insertionIndex);
            }
        });
        list.addEventListener("dragleave", (event) => {
            if (list.contains(event.relatedTarget)) return;
            favoriteDragScrollSpeed = 0;
            favoriteDragScrollList = null;
            favoriteDragClientY = null;
            if (favoriteDragScrollFrame) cancelAnimationFrame(favoriteDragScrollFrame);
            favoriteDragScrollFrame = 0;
        });
        list.addEventListener("scroll", positionFavoriteTooltip, { passive: true });
    };

    const positionCategory = async (categoryId, targetParentId, insertionIndex) => {
        const category = library.categories.find((candidate) => candidate.id === categoryId);
        const target = promptCardCategoryPosition(
            library.categories,
            categoryId,
            targetParentId,
            insertionIndex,
        );
        clearCategoryDragState();
        if (!category || !target.allowed || !target.changed) {
            render();
            queueMicrotask(() => root.querySelector(
                `[data-category-id="${categoryId}"]`,
            )?.focus?.());
            return;
        }
        const previousParentId = category.parent_id;
        if (category.parent_id === null) {
            selectedPrimaryId = category.id;
            mobileLevel = 0;
        } else {
            selectedPrimaryId = target.parentId;
            selectedSecondaryId = category.id;
            mobileLevel = 1;
        }
        const parent = target.parentId
            ? library.categories.find((candidate) => candidate.id === target.parentId)
            : null;
        const result = await runMutation(
            (client) => client.positionCategory(category.id, target.parentId, target.index),
            previousParentId === target.parentId
                ? t("Category order updated.")
                : t("Category moved to {name}.", { name: parent?.name ?? "" }),
        );
        if (!result) {
            if (category.parent_id === null) {
                selectedPrimaryId = category.id;
                selectedSecondaryId = null;
                mobileLevel = 0;
            } else {
                selectedPrimaryId = previousParentId;
                selectedSecondaryId = category.id;
                mobileLevel = 1;
            }
            render();
        }
        queueMicrotask(() => root.querySelector(
            `[data-category-id="${category.id}"]`,
        )?.focus?.());
    };

    const reorderCategoryByCommand = (category, command) => {
        const siblings = categoryChildren(library, category.parent_id);
        const index = siblings.findIndex((candidate) => candidate.id === category.id);
        if (index < 0) return;
        const insertionIndex = command === "top"
            ? 0
            : command === "up"
                ? Math.max(0, index - 1)
                : command === "down"
                    ? Math.min(siblings.length, index + 2)
                    : siblings.length;
        positionCategory(category.id, category.parent_id, insertionIndex);
    };

    const moveSecondaryToPrimary = (categoryId, primary) => {
        const category = library.categories.find((candidate) => candidate.id === categoryId);
        movingCategoryId = null;
        if (!category || category.parent_id === null || !primary || primary.parent_id !== null) {
            render();
            return;
        }
        if (category.parent_id === primary.id) {
            selectedPrimaryId = primary.id;
            selectedSecondaryId = category.id;
            mobileLevel = 1;
            render();
            return;
        }
        const insertionIndex = categoryChildren(library, primary.id).length;
        positionCategory(category.id, primary.id, insertionIndex);
    };

    const updateCategoryInsertion = (list, clientY, parentId) => {
        const wrappers = [...list.querySelectorAll(":scope > .cpw-prompt-card-library__row-wrap")];
        for (const wrapper of wrappers) {
            wrapper.classList.remove(
                "cpw-prompt-card-library__row-wrap--insert-before",
                "cpw-prompt-card-library__row-wrap--insert-after",
            );
        }
        let boundary = wrappers.length;
        for (let index = 0; index < wrappers.length; index += 1) {
            const rect = wrappers[index].getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) {
                boundary = index;
                break;
            }
        }
        categoryInsertionIndex = boundary;
        categoryDragTargetParentId = parentId;
        if (!wrappers.length) return;
        if (boundary < wrappers.length) {
            wrappers[boundary].classList.add("cpw-prompt-card-library__row-wrap--insert-before");
        } else {
            wrappers.at(-1).classList.add("cpw-prompt-card-library__row-wrap--insert-after");
        }
    };

    const runCategoryDragScroll = () => {
        categoryDragScrollFrame = 0;
        if (!draggingCategoryId || !categoryDragScrollList?.isConnected || !categoryDragScrollSpeed) return;
        const previousScrollTop = categoryDragScrollList.scrollTop;
        categoryDragScrollList.scrollTop += categoryDragScrollSpeed;
        if (categoryDragScrollList.scrollTop === previousScrollTop) {
            categoryDragScrollSpeed = 0;
            return;
        }
        if (categoryDragClientY !== null) {
            updateCategoryInsertion(
                categoryDragScrollList,
                categoryDragClientY,
                categoryDragTargetParentId,
            );
        }
        categoryDragScrollFrame = requestAnimationFrame(runCategoryDragScroll);
    };

    const updateCategoryDragScroll = (list, clientY) => {
        const rect = list.getBoundingClientRect();
        let speed = 0;
        if (clientY < rect.top + FAVORITE_DRAG_SCROLL_EDGE) {
            const ratio = Math.min(1, (rect.top + FAVORITE_DRAG_SCROLL_EDGE - clientY) / FAVORITE_DRAG_SCROLL_EDGE);
            speed = -Math.max(2, Math.round(FAVORITE_DRAG_SCROLL_MAX_SPEED * ratio));
        } else if (clientY > rect.bottom - FAVORITE_DRAG_SCROLL_EDGE) {
            const ratio = Math.min(1, (clientY - (rect.bottom - FAVORITE_DRAG_SCROLL_EDGE)) / FAVORITE_DRAG_SCROLL_EDGE);
            speed = Math.max(2, Math.round(FAVORITE_DRAG_SCROLL_MAX_SPEED * ratio));
        }
        categoryDragScrollList = list;
        categoryDragScrollSpeed = speed;
        categoryDragClientY = clientY;
        if (speed && !categoryDragScrollFrame) {
            categoryDragScrollFrame = requestAnimationFrame(runCategoryDragScroll);
        } else if (!speed && categoryDragScrollFrame) {
            cancelAnimationFrame(categoryDragScrollFrame);
            categoryDragScrollFrame = 0;
        }
    };

    const configureCategoryDropList = (list, parentId, categories) => {
        list.dataset.categoryOrderList = parentId ?? "root";
        list.addEventListener("dragover", (event) => {
            if (!draggingCategoryId) return;
            const dragged = library.categories.find((candidate) => candidate.id === draggingCategoryId);
            const allowed = dragged?.parent_id === null ? parentId === null : parentId !== null;
            if (!dragged || !allowed) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
            updateCategoryInsertion(list, event.clientY, parentId);
            updateCategoryDragScroll(list, event.clientY);
        });
        list.addEventListener("drop", (event) => {
            if (!draggingCategoryId || categoryDragTargetParentId !== parentId) return;
            event.preventDefault();
            event.stopPropagation();
            positionCategory(
                draggingCategoryId,
                parentId,
                categoryInsertionIndex ?? categories.length,
            );
        });
        list.addEventListener("dragleave", (event) => {
            if (list.contains(event.relatedTarget)) return;
            categoryDragScrollSpeed = 0;
            categoryDragScrollList = null;
            categoryDragClientY = null;
            if (categoryDragScrollFrame) cancelAnimationFrame(categoryDragScrollFrame);
            categoryDragScrollFrame = 0;
        });
    };

    const previewFavoriteCardRow = (card) => {
        const cardName = card.title.trim() || t("Untitled Card");
        const wrapper = element("div", "cpw-prompt-card-library__favorite-wrap");
        wrapper.dataset.favoriteCardId = card.id;
        const row = element("div", "cpw-prompt-card-library__favorite-row");
        const content = element("div", "cpw-prompt-card-library__favorite-main");
        const titleLine = element("span", "cpw-prompt-card-library__favorite-title-line");
        titleLine.append(
            element("strong", "cpw-prompt-card-library__favorite-title", cardName),
            element("span", "cpw-prompt-card-library__favorite-count", `(${favoriteCardPromptCount(card)})`),
        );
        content.append(
            titleLine,
            element("span", "cpw-prompt-card-library__favorite-preview", card.prompt),
        );
        row.append(content);
        wrapper.append(row);
        return wrapper;
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
        wrapper.dataset.categoryId = category.id;
        const row = element("div", "cpw-prompt-card-library__row");
        row.draggable = true;
        const button = element("button", "cpw-prompt-card-library__row-main", category.name);
        button.type = "button";
        button.dataset.libraryLevel = String(level);
        button.dataset.categoryId = category.id;
        button.title = t("Drag to reorder; right-click for category actions");
        button.setAttribute("aria-haspopup", "menu");
        button.classList.toggle(
            "cpw-prompt-card-library__row-main--selected",
            level === 0 ? selectedPrimaryId === category.id : selectedSecondaryId === category.id,
        );
        button.classList.toggle(
            "cpw-prompt-card-library__row-main--drag-expand",
            Boolean(draggingCardId) && level === 0 && selectedPrimaryId === category.id,
        );
        const chevron = element("span", "cpw-prompt-card-library__chevron", "›");
        chevron.setAttribute("aria-hidden", "true");
        button.append(chevron);
        button.addEventListener("pointerenter", () => {
            if (busy || draggingCategoryId) return;
            deleteController.disarm();
            hideFavoriteTooltip();
            if (level === 0) {
                if (selectedPrimaryId === category.id) return;
                selectedPrimaryId = category.id;
                selectedSecondaryId = null;
                mobileLevel = 1;
            } else {
                if (selectedSecondaryId === category.id) return;
                selectedSecondaryId = category.id;
                mobileLevel = 2;
            }
            render();
        });
        button.addEventListener("click", () => {
            deleteController.disarm();
            hideFavoriteTooltip();
            closeContextMenu();
            if (level === 0) {
                if (movingCategoryId) {
                    moveSecondaryToPrimary(movingCategoryId, category);
                    return;
                }
                selectedPrimaryId = category.id;
                selectedSecondaryId = null;
                mobileLevel = 1;
                render();
            } else chooseSecondary(category);
        });
        button.addEventListener("dragenter", (event) => {
            if (draggingCategoryId) {
                const dragged = library.categories.find((candidate) => candidate.id === draggingCategoryId);
                if (level === 0 && dragged?.parent_id !== null) {
                    event.preventDefault();
                    event.stopPropagation();
                    button.classList.add("cpw-prompt-card-library__row-main--drop-target");
                }
                return;
            }
            if (!draggingCardId) return;
            deleteController.disarm();
            hideFavoriteTooltip();
            if (level === 0) {
                if (selectedPrimaryId === category.id && selectedSecondaryId === null) return;
                selectedPrimaryId = category.id;
                selectedSecondaryId = null;
                mobileLevel = 1;
                renderPrimaryDragPreview?.(category);
                return;
            }
            renderSecondaryDragPreview?.(category);
            event.preventDefault();
            for (const target of root.querySelectorAll(".cpw-prompt-card-library__row-main--drop-target")) {
                target.classList.remove("cpw-prompt-card-library__row-main--drop-target");
            }
            button.classList.add("cpw-prompt-card-library__row-main--drop-target");
        });
        button.addEventListener("dragover", (event) => {
            if (draggingCategoryId) {
                const dragged = library.categories.find((candidate) => candidate.id === draggingCategoryId);
                if (level !== 0 || dragged?.parent_id === null) return;
                event.preventDefault();
                event.stopPropagation();
                if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
                button.classList.add("cpw-prompt-card-library__row-main--drop-target");
                return;
            }
            if (!draggingCardId || level !== 1) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
            button.classList.add("cpw-prompt-card-library__row-main--drop-target");
        });
        button.addEventListener("dragleave", (event) => {
            if (button.contains(event.relatedTarget)) return;
            button.classList.remove("cpw-prompt-card-library__row-main--drop-target");
        });
        button.addEventListener("drop", (event) => {
            if (draggingCategoryId) {
                const dragged = library.categories.find((candidate) => candidate.id === draggingCategoryId);
                if (level !== 0 || dragged?.parent_id === null) return;
                event.preventDefault();
                event.stopPropagation();
                const insertionIndex = categoryChildren(library, category.id).length;
                positionCategory(draggingCategoryId, category.id, insertionIndex);
                return;
            }
            if (level !== 1) return;
            const cardId = draggingCardId
                || event.dataTransfer?.getData("application/x-prompt-weaver-favorite-id");
            if (!cardId) return;
            event.preventDefault();
            event.stopPropagation();
            moveFavoriteToCategory(cardId, category);
        });
        const openActions = ({ x, y, focus = false }) => {
            if (busy) return;
            const siblings = categoryChildren(library, category.parent_id);
            const categoryIndex = siblings.findIndex((candidate) => candidate.id === category.id);
            const items = [
                { label: t("Rename"), onSelect: () => startCategoryEditor(category) },
                {
                    label: t("Move to Top"),
                    disabled: categoryIndex <= 0,
                    onSelect: () => reorderCategoryByCommand(category, "top"),
                },
                {
                    label: t("Move Up"),
                    disabled: categoryIndex <= 0,
                    onSelect: () => reorderCategoryByCommand(category, "up"),
                },
                {
                    label: t("Move Down"),
                    disabled: categoryIndex < 0 || categoryIndex >= siblings.length - 1,
                    onSelect: () => reorderCategoryByCommand(category, "down"),
                },
                {
                    label: t("Move to Bottom"),
                    disabled: categoryIndex < 0 || categoryIndex >= siblings.length - 1,
                    onSelect: () => reorderCategoryByCommand(category, "bottom"),
                },
            ];
            if (level === 1) {
                items.push({
                    label: t("Move to Category"),
                    disabled: categoryChildren(library, null).length < 2,
                    onSelect: () => {
                        movingCategoryId = category.id;
                        movingCardId = null;
                        selectedPrimaryId = null;
                        selectedSecondaryId = null;
                        mobileLevel = 0;
                        render();
                    },
                });
            }
            items.push({ label: t("Delete"), danger: true, onSelect: () => deleteCategory(category) });
            openContextMenu({
                anchor: button,
                x,
                y,
                focus,
                items,
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
        row.addEventListener("dragstart", (event) => {
            if (busy) {
                event.preventDefault();
                return;
            }
            draggingCategoryId = category.id;
            clearDragState();
            deleteController.disarm();
            hideFavoriteTooltip();
            closeContextMenu();
            root.classList.add("cpw-prompt-card-library--category-dragging");
            row.classList.add("cpw-prompt-card-library__row--dragging");
            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("application/x-prompt-weaver-category-id", category.id);
                event.dataTransfer.setData("text/plain", category.name);
            }
        });
        row.addEventListener("dragend", () => clearCategoryDragState({ renderAfter: true }));
        row.append(button);
        wrapper.append(row);
        return wrapper;
    };

    const panelHeader = (label, {
        backLevel = null,
        createLevel = null,
        parentId = null,
        action = null,
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
        if (action) {
            const add = element("button", "cpw-prompt-card-library__panel-add", action.text ?? "+");
            add.type = "button";
            add.title = action.label;
            add.setAttribute("aria-label", action.label);
            add.disabled = Boolean(action.disabled);
            add.addEventListener("click", action.onClick);
            panelHeaderNode.append(add);
        }
        return panelHeaderNode;
    };

    renderPrimaryDragPreview = (primary) => {
        const secondaryPanel = panels.querySelector(
            '.cpw-prompt-card-library__panel[data-level="1"]',
        );
        if (!secondaryPanel) {
            render();
            return;
        }
        panels.querySelector(".cpw-prompt-card-library__list--drag-preview")?.remove();
        panels.querySelector(".cpw-prompt-card-library__list--drag-source")
            ?.classList.remove("cpw-prompt-card-library__list--drag-source");
        for (const primaryButton of panels.querySelectorAll(
            '.cpw-prompt-card-library__row-main[data-library-level="0"]',
        )) {
            const selected = primaryButton.dataset.categoryId === primary.id;
            primaryButton.classList.toggle("cpw-prompt-card-library__row-main--selected", selected);
            primaryButton.classList.toggle("cpw-prompt-card-library__row-main--drag-expand", selected);
        }
        const secondaryCategories = categoryChildren(library, primary.id);
        const secondaryList = element("div", "cpw-prompt-card-library__list");
        if (secondaryCategories.length) {
            for (const category of secondaryCategories) secondaryList.append(categoryRow(category, 1));
        } else {
            secondaryList.append(element(
                "div",
                "cpw-prompt-card-library__empty",
                t("Create a secondary category for favorite cards."),
            ));
        }
        secondaryPanel.replaceChildren(
            panelHeader(t("Secondary Categories"), {
                backLevel: 0,
                createLevel: "secondary",
                parentId: primary.id,
            }),
            secondaryList,
        );
        root.dataset.mobileLevel = "1";
        position();
    };

    renderSecondaryDragPreview = (secondary) => {
        if (!draggingCardId || !secondary?.parent_id) return;
        selectedPrimaryId = secondary.parent_id;
        selectedSecondaryId = secondary.id;
        mobileLevel = 2;
        for (const secondaryButton of panels.querySelectorAll(
            '.cpw-prompt-card-library__row-main[data-library-level="1"]',
        )) {
            const selected = secondaryButton.dataset.categoryId === secondary.id;
            secondaryButton.classList.toggle("cpw-prompt-card-library__row-main--selected", selected);
            secondaryButton.classList.toggle("cpw-prompt-card-library__row-main--drop-target", selected);
        }
        const cardPanel = panels.querySelector(
            '.cpw-prompt-card-library__panel[data-level="2"]',
        );
        const sourceList = cardPanel?.querySelector(
            ':scope > .cpw-prompt-card-library__list:not(.cpw-prompt-card-library__list--drag-preview)',
        );
        if (!cardPanel || !sourceList) return;
        cardPanel.querySelector(".cpw-prompt-card-library__list--drag-preview")?.remove();
        sourceList.classList.add("cpw-prompt-card-library__list--drag-source");
        const previewList = element(
            "div",
            "cpw-prompt-card-library__list cpw-prompt-card-library__list--drag-preview",
        );
        const cards = library.cards.filter((card) => card.category_id === secondary.id);
        if (cards.length) {
            for (const card of cards) previewList.append(previewFavoriteCardRow(card));
        } else {
            previewList.append(element(
                "div",
                "cpw-prompt-card-library__empty",
                t("Drop here to place the favorite first."),
            ));
        }
        configureFavoriteDropList(previewList, secondary, cards, { allowCrossCategory: true });
        cardPanel.append(previewList);
        root.dataset.mobileLevel = "2";
        position();
    };

    const favoriteCardEditor = (card) => {
        const wrapper = element("div", "cpw-prompt-card-library__favorite-wrap");
        wrapper.dataset.favoriteCardId = card.id;
        const editor = element("form", "cpw-prompt-card-library__favorite-rename-editor");
        const input = element("input", "cpw-prompt-card-library__favorite-rename-input");
        input.dataset.favoriteCardId = card.id;
        input.type = "text";
        input.maxLength = MAX_CARD_TITLE_LENGTH;
        input.value = card.title;
        input.setAttribute("aria-label", t("Favorite card title"));
        const cancel = element("button", "cpw-prompt-card-library__favorite-rename-cancel", t("Cancel"));
        cancel.type = "button";
        const confirm = element("button", "cpw-prompt-card-library__favorite-rename-confirm", t("Confirm"));
        confirm.type = "submit";
        editor.append(input, cancel, confirm);
        editor.addEventListener("submit", (event) => {
            event.preventDefault();
            saveFavoriteName(card, input);
        });
        cancel.addEventListener("click", () => {
            editingFavoriteId = null;
            setStatus();
            render();
        });
        input.addEventListener("keydown", (event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            editingFavoriteId = null;
            setStatus();
            render();
        });
        wrapper.append(editor);
        return wrapper;
    };

    const favoriteCardRow = (card) => {
        if (editingFavoriteId === card.id) return favoriteCardEditor(card);
        const cardName = card.title.trim() || t("Untitled Card");
        const wrapper = element("div", "cpw-prompt-card-library__favorite-wrap");
        wrapper.dataset.favoriteCardId = card.id;
        const row = element("div", "cpw-prompt-card-library__favorite-row");
        const choose = element(
            mode === "assign" ? "div" : "button",
            "cpw-prompt-card-library__favorite-main",
        );
        if (mode === "assign") {
            choose.tabIndex = 0;
            choose.setAttribute("role", "group");
        } else {
            choose.type = "button";
        }
        choose.setAttribute("aria-label", mode === "assign" ? cardName : t("Choose {name}", { name: cardName }));
        choose.setAttribute("aria-haspopup", "menu");
        const titleLine = element("span", "cpw-prompt-card-library__favorite-title-line");
        const title = element("strong", "cpw-prompt-card-library__favorite-title", cardName);
        const count = element("span", "cpw-prompt-card-library__favorite-count", `(${favoriteCardPromptCount(card)})`);
        const preview = element("span", "cpw-prompt-card-library__favorite-preview", card.prompt);
        titleLine.append(title, count);
        choose.append(titleLine, preview);
        choose.addEventListener("pointerenter", () => showFavoriteTooltip(card, choose));
        choose.addEventListener("pointerleave", () => {
            if (document.activeElement !== choose) hideFavoriteTooltip();
        });
        choose.addEventListener("focus", () => showFavoriteTooltip(card, choose));
        choose.addEventListener("blur", () => {
            if (!choose.matches(":hover")) hideFavoriteTooltip();
        });
        if (mode !== "assign") {
            choose.addEventListener("click", () => {
                closeContextMenu();
                onChooseCard?.(card);
                close({ restoreFocus: false });
            });
        }
        const openActions = ({ x, y, focus = false }) => {
            if (busy) return;
            const siblings = library.cards.filter((candidate) => candidate.category_id === card.category_id);
            const cardIndex = siblings.findIndex((candidate) => candidate.id === card.id);
            openContextMenu({
                anchor: choose,
                x,
                y,
                focus,
                items: [
                    {
                        label: t("Rename"),
                        onSelect: () => startFavoriteEditor(card),
                    },
                    {
                        label: t("Move to Top"),
                        disabled: cardIndex <= 0,
                        onSelect: () => reorderFavoriteByCommand(card, "top"),
                    },
                    {
                        label: t("Move Up"),
                        disabled: cardIndex <= 0,
                        onSelect: () => reorderFavoriteByCommand(card, "up"),
                    },
                    {
                        label: t("Move Down"),
                        disabled: cardIndex < 0 || cardIndex >= siblings.length - 1,
                        onSelect: () => reorderFavoriteByCommand(card, "down"),
                    },
                    {
                        label: t("Move to Bottom"),
                        disabled: cardIndex < 0 || cardIndex >= siblings.length - 1,
                        onSelect: () => reorderFavoriteByCommand(card, "bottom"),
                    },
                    {
                        label: t("Move to Category"),
                        onSelect: () => {
                            movingCardId = card.id;
                            movingCategoryId = null;
                            selectedPrimaryId = null;
                            selectedSecondaryId = null;
                            mobileLevel = 0;
                            setStatus(t("Choose a destination secondary category."));
                            render();
                        },
                    },
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
        row.draggable = mode === "assign";
        row.dataset.favoriteDragId = card.id;
        row.addEventListener("dragstart", (event) => {
            if (
                busy
                || mode !== "assign"
                || event.target.closest?.(
                    ".cpw-prompt-card-library__favorite-overwrite, .cpw-prompt-card-library__favorite-delete",
                )
            ) {
                event.preventDefault();
                return;
            }
            draggingCardId = card.id;
            draggingSourceCategoryId = card.category_id;
            deleteController.disarm();
            hideFavoriteTooltip();
            closeContextMenu();
            root.classList.add("cpw-prompt-card-library--dragging");
            row.classList.add("cpw-prompt-card-library__favorite-row--dragging");
            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("application/x-prompt-weaver-favorite-id", card.id);
                event.dataTransfer.setData("text/plain", cardName);
            }
        });
        row.addEventListener("dragend", () => clearDragState({ renderAfter: true }));
        const overwriteButton = mode === "assign"
            ? element("button", "cpw-prompt-card-library__favorite-overwrite", t("Overwrite"))
            : null;
        if (overwriteButton) {
            const overwriteLabel = t("Overwrite {name} with the current draft", { name: cardName });
            overwriteButton.type = "button";
            overwriteButton.title = overwriteLabel;
            overwriteButton.setAttribute("aria-label", overwriteLabel);
            overwriteButton.addEventListener("pointerdown", (event) => event.stopPropagation());
            overwriteButton.addEventListener("click", async (event) => {
                event.preventDefault();
                event.stopPropagation();
                await overwriteFavoriteFromDraft(card);
            });
        }
        const deleteButton = deleteController.createButton({
            className: "cpw-prompt-card-library__favorite-delete",
            card,
            onBeforeAction: hideFavoriteTooltip,
            onDelete: () => deleteFavorite(card),
        });
        row.append(choose);
        if (overwriteButton) row.append(overwriteButton);
        row.append(deleteButton);
        wrapper.append(row);
        return wrapper;
    };

    function render() {
        if (closed) return;
        hideFavoriteTooltip();
        closeContextMenu();
        const editingFavorite = editingFavoriteId
            ? library.cards.find((card) => card.id === editingFavoriteId)
            : null;
        if (!editingFavorite || editingFavorite.category_id !== selectedSecondaryId) {
            editingFavoriteId = null;
        }
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
        primaryPanel.addEventListener("pointerenter", hideFavoriteTooltip);
        primaryPanel.append(panelHeader(t("Primary Categories"), { createLevel: "primary" }));
        const primaryList = element("div", "cpw-prompt-card-library__list");
        if (primaryCategories.length) {
            for (const category of primaryCategories) primaryList.append(categoryRow(category, 0));
        } else {
            primaryList.append(element("div", "cpw-prompt-card-library__empty", t("Create a primary category to begin.")));
        }
        if (creatingParentId === null) primaryList.append(categoryEditor(null, null));
        configureCategoryDropList(primaryList, null, primaryCategories);
        primaryPanel.append(primaryList);

        const secondaryPanel = element("section", "cpw-prompt-card-library__panel");
        secondaryPanel.dataset.level = "1";
        secondaryPanel.addEventListener("pointerenter", hideFavoriteTooltip);
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
            configureCategoryDropList(secondaryList, primary.id, secondaryCategories);
        } else {
            secondaryList.append(element("div", "cpw-prompt-card-library__empty", t("Choose a primary category.")));
        }
        secondaryPanel.append(secondaryList);

        const cardPanel = element("section", "cpw-prompt-card-library__panel");
        cardPanel.dataset.level = "2";
        const draftSnapshot = promptCardFavoriteSnapshot(getSnapshot?.() ?? {});
        cardPanel.append(panelHeader(t("My Favorites"), {
            backLevel: 1,
            action: mode === "assign" ? {
                label: t("Add current draft to favorites"),
                disabled: !secondary || !draftSnapshot.prompt.trim(),
                onClick: createFavoriteFromDraft,
            } : null,
        }));
        const cardList = element("div", "cpw-prompt-card-library__list");
        cardList.dataset.favoriteOrderList = "true";
        const cards = secondary ? library.cards.filter((card) => card.category_id === secondary.id) : [];
        if (cards.length) {
            for (const card of cards) cardList.append(favoriteCardRow(card));
        } else {
            const empty = element(
                "div",
                "cpw-prompt-card-library__empty",
                secondary ? t("There are no favorite cards in this category.") : t("Choose a secondary category."),
            );
            empty.setAttribute("role", "status");
            empty.tabIndex = -1;
            cardList.append(empty);
        }
        configureFavoriteDropList(cardList, secondary, cards);
        cardPanel.append(cardList);
        panels.replaceChildren(primaryPanel, secondaryPanel, cardPanel);
        root.dataset.mobileLevel = String(mobileLevel);
        setBusy(busy);
        deleteController.sync();
        position();
    }

    const onDocumentPointerDown = (event) => {
        deleteController.handlePointerDown(event);
        if (event.target?.closest?.(".cpw-prompt-card-confirm__overlay")) return;
        if (activeContextMenu?.contains(event.target)) return;
        closeContextMenu();
        if (!root.contains(event.target) && !anchor?.contains?.(event.target)) close({ restoreFocus: false });
    };

    const onDocumentDragEnd = () => {
        if (draggingCardId) clearDragState({ renderAfter: true });
        if (draggingCategoryId) clearCategoryDragState({ renderAfter: true });
    };

    const focusPanelItem = (direction) => {
        const panel = root.querySelector(
            `.cpw-prompt-card-library__panel[data-level="${root.classList.contains("cpw-prompt-card-library--narrow") ? mobileLevel : Math.min(mobileLevel, 2)}"]`,
        ) ?? root.querySelector(".cpw-prompt-card-library__panel");
        const buttons = [...panel.querySelectorAll('button:not([disabled]), [tabindex="0"]')]
            .filter((button) => button.offsetParent !== null);
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
        if (
            event.target === resizeHandle
            && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
        ) return;
        if (event.key === "Escape") {
            event.preventDefault();
            if (deleteController.disarm()) {
                event.stopImmediatePropagation();
                return;
            }
            if (movingCardId || movingCategoryId) {
                movingCardId = null;
                movingCategoryId = null;
                render();
                event.stopImmediatePropagation();
                return;
            }
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
        } else if (event.key === "ArrowRight" && mobileLevel < 2) {
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
    header.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || event.target.closest("button, input, select, a, [role='button']")) return;
        position();
        const geometry = currentGeometry();
        if (!geometry) return;
        event.preventDefault();
        windowMoveSession = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            ...geometry,
        };
        windowResizeSession = null;
        root.classList.add("cpw-prompt-card-library--moving");
        hideFavoriteTooltip();
        closeContextMenu();
    });
    resizeHandle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        position();
        const geometry = currentGeometry();
        if (!geometry) return;
        event.preventDefault();
        event.stopPropagation();
        windowResizeSession = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            ...geometry,
        };
        windowMoveSession = null;
        root.classList.add("cpw-prompt-card-library--resizing");
        hideFavoriteTooltip();
        closeContextMenu();
    });
    resizeHandle.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        position();
        const geometry = currentGeometry();
        if (!geometry) return;
        const step = event.shiftKey ? 24 : 8;
        if (event.key === "ArrowLeft") geometry.width -= step;
        else if (event.key === "ArrowRight") geometry.width += step;
        else if (event.key === "ArrowUp") geometry.height -= step;
        else geometry.height += step;
        applyGeometry(normalizePromptCardLibraryGeometry(geometry, {
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
        }));
        persistGeometry();
    });
    for (const eventName of ["pointerdown", "pointerup", "click", "keydown", "keyup", "input", "change"]) {
        root.addEventListener(eventName, (event) => event.stopPropagation());
    }
    root.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    document.addEventListener("keydown", onDocumentKeyDown, true);
    document.addEventListener("dragend", onDocumentDragEnd, true);
    document.addEventListener("pointermove", onWindowPointerMove, true);
    document.addEventListener("pointerup", onWindowPointerUp, true);
    document.addEventListener("pointercancel", onWindowPointerUp, true);
    window.addEventListener("resize", onViewportResize);
    window.addEventListener("scroll", onViewportScroll, true);
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
