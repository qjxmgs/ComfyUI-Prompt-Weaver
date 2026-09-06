const ENGLISH_LOCALE = "en-US";

function interpolate(template, parameters) {
    return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key) => (
        Object.prototype.hasOwnProperty.call(parameters, key) ? String(parameters[key]) : match
    ));
}

export function t(message, parameters = {}) {
    return interpolate(String(message ?? ""), parameters);
}

export function tp(singular, plural, count, parameters = {}) {
    const category = new Intl.PluralRules(ENGLISH_LOCALE).select(count);
    return t(category === "one" ? singular : plural, {
        ...parameters,
        count: formatNumber(count),
    });
}

export function formatNumber(value) {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number)) return String(value ?? "");
    return new Intl.NumberFormat(ENGLISH_LOCALE).format(number);
}

export function formatDateTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value ?? "");
    return new Intl.DateTimeFormat(ENGLISH_LOCALE, {
        dateStyle: "medium",
        timeStyle: "medium",
        hour12: false,
    }).format(date);
}

export function formatList(values) {
    return new Intl.ListFormat(ENGLISH_LOCALE, {
        style: "long",
        type: "conjunction",
    }).format(Array.isArray(values) ? values.map(String) : []);
}
