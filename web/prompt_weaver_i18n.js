const DEFAULT_LOCALE = "en";
const LOCALE_SETTING_ID = "Comfy.Locale";
const LOCALE_CHANGE_EVENT = "Comfy.Locale.change";
const MESSAGE_NAMESPACE = "promptWeaver";

let activeLocale = DEFAULT_LOCALE;
let messagesByLocale = Object.freeze({});
let resourceLoadPromise = null;
let connectedSettings = null;
let connectedLocaleHandler = null;
let warnedAboutResourceFailure = false;
const subscribers = new Set();

function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeResourcePayload(payload) {
    let candidate = payload;
    if (typeof candidate === "string") {
        try {
            candidate = JSON.parse(candidate);
        } catch (_error) {
            return Object.freeze({});
        }
    }
    return isRecord(candidate) ? candidate : Object.freeze({});
}

function localeMessages(locale) {
    const messages = messagesByLocale?.[locale]?.[MESSAGE_NAMESPACE]?.ui;
    return isRecord(messages) ? messages : null;
}

function notifySubscribers() {
    for (const subscriber of [...subscribers]) {
        try {
            subscriber(activeLocale);
        } catch (error) {
            console.warn("[Prompt Weaver] Locale subscriber failed", error);
        }
    }
}

function readLocaleSetting(app) {
    try {
        const current = app?.extensionManager?.setting?.get?.(LOCALE_SETTING_ID);
        if (current !== undefined && current !== null) return current;
    } catch (_error) {
        // Fall through to the legacy public settings facade.
    }
    try {
        return app?.ui?.settings?.getSettingValue?.(LOCALE_SETTING_ID);
    } catch (_error) {
        return undefined;
    }
}

async function fetchOfficialMessages(api) {
    if (typeof api?.getCustomNodesI18n === "function") {
        return normalizeResourcePayload(await api.getCustomNodesI18n());
    }
    if (typeof api?.fetchApi === "function") {
        const response = await api.fetchApi("/i18n");
        if (!response || response.ok === false) {
            throw new Error(`HTTP ${response?.status ?? "unknown"}`);
        }
        return normalizeResourcePayload(await response.json());
    }
    throw new Error("The ComfyUI i18n API is unavailable.");
}

async function loadOfficialMessages(api) {
    if (!resourceLoadPromise) {
        resourceLoadPromise = fetchOfficialMessages(api)
            .then((messages) => {
                messagesByLocale = messages;
                notifySubscribers();
                return messages;
            })
            .catch((error) => {
                resourceLoadPromise = null;
                if (!warnedAboutResourceFailure) {
                    warnedAboutResourceFailure = true;
                    console.warn(
                        "[Prompt Weaver] Could not load ComfyUI locale resources; using English UI.",
                        error,
                    );
                }
                return messagesByLocale;
            });
    }
    return resourceLoadPromise;
}

export function normalizePromptWeaverLocale(value) {
    const locale = typeof value === "string"
        ? value.trim().replaceAll("_", "-").toLowerCase()
        : "";
    return locale === "zh" || locale.startsWith("zh-cn") || locale.startsWith("zh-hans")
        ? "zh"
        : DEFAULT_LOCALE;
}

export function getPromptWeaverLocale() {
    return activeLocale;
}

export function setPromptWeaverLocale(value) {
    const nextLocale = normalizePromptWeaverLocale(value);
    if (nextLocale === activeLocale) return activeLocale;
    activeLocale = nextLocale;
    notifySubscribers();
    return activeLocale;
}

export function syncPromptWeaverLocale(app) {
    return setPromptWeaverLocale(readLocaleSetting(app));
}

export async function connectPromptWeaverI18n(app, api) {
    syncPromptWeaverLocale(app);
    const settings = app?.ui?.settings;
    if (settings !== connectedSettings) {
        if (connectedSettings && connectedLocaleHandler) {
            connectedSettings.removeEventListener?.(LOCALE_CHANGE_EVENT, connectedLocaleHandler);
        }
        connectedSettings = settings ?? null;
        connectedLocaleHandler = null;
        if (typeof connectedSettings?.addEventListener === "function") {
            connectedLocaleHandler = (event) => {
                setPromptWeaverLocale(event?.detail?.value);
                if (!localeMessages(activeLocale)) void loadOfficialMessages(api);
            };
            connectedSettings.addEventListener(LOCALE_CHANGE_EVENT, connectedLocaleHandler);
        }
    }
    await loadOfficialMessages(api);
    return activeLocale;
}

export function subscribePromptWeaverLocale(subscriber) {
    if (typeof subscriber !== "function") return () => {};
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
}

function interpolate(template, parameters) {
    return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key) => (
        Object.prototype.hasOwnProperty.call(parameters, key) ? String(parameters[key]) : match
    ));
}

export function t(message, parameters = {}) {
    const source = String(message ?? "");
    const localized = localeMessages(activeLocale)?.[source];
    const english = localeMessages(DEFAULT_LOCALE)?.[source];
    const template = typeof localized === "string"
        ? localized
        : (typeof english === "string" ? english : source);
    return interpolate(template, parameters);
}

export function tp(singular, plural, count, parameters = {}) {
    const category = new Intl.PluralRules(activeLocale === "zh" ? "zh-CN" : "en-US").select(count);
    return t(category === "one" ? singular : plural, {
        ...parameters,
        count: formatNumber(count),
    });
}

export function formatNumber(value) {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number)) return String(value ?? "");
    return new Intl.NumberFormat(activeLocale === "zh" ? "zh-CN" : "en-US").format(number);
}

export function formatDateTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value ?? "");
    return new Intl.DateTimeFormat(activeLocale === "zh" ? "zh-CN" : "en-US", {
        dateStyle: "medium",
        timeStyle: "medium",
        hour12: false,
    }).format(date);
}

export function formatList(values) {
    return new Intl.ListFormat(activeLocale === "zh" ? "zh-CN" : "en-US", {
        style: "long",
        type: "conjunction",
    }).format(Array.isArray(values) ? values.map(String) : []);
}
