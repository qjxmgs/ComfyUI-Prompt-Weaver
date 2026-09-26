export const MAX_VARIABLES = 100;
export const MAX_VARIABLE_NAME_LENGTH = 64;
export const MAX_VARIABLE_VALUE_LENGTH = 10_000;

const NAME_PATTERN = /^[_\p{L}][_\p{L}\p{N}]*$/u;
const REFERENCE_PATTERN = /\{([^{}]+)\}/gu;

export function normalizeVariableName(value) {
    const name = typeof value === "string" ? value.normalize("NFC") : "";
    if (!name || [...name].length > MAX_VARIABLE_NAME_LENGTH || !NAME_PATTERN.test(name)) {
        throw new Error("Variable names must start with a letter or underscore and contain only letters, numbers, or underscores (up to 64 characters).");
    }
    return name;
}

export function validateVariableValue(value) {
    if (typeof value !== "string" || [...value].length > MAX_VARIABLE_VALUE_LENGTH) {
        throw new Error("Variable values must be strings of at most 10,000 characters.");
    }
    return value;
}

export function normalizeVariables(value) {
    if (!Array.isArray(value) || value.length > MAX_VARIABLES) {
        throw new Error("variables must be an array of at most 100 entries");
    }
    const ids = new Set();
    const names = new Set();
    return value.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)
            || typeof entry.id !== "string" || !entry.id || entry.id.length > 128 || ids.has(entry.id)
            || typeof entry.name !== "string" || entry.name !== entry.name.normalize("NFC")) {
            throw new Error("Each variable needs a unique ID and an NFC name.");
        }
        const name = normalizeVariableName(entry.name);
        const variableValue = validateVariableValue(entry.value);
        if (names.has(name)) throw new Error("Variable names must be unique.");
        ids.add(entry.id);
        names.add(name);
        return { id: entry.id, name, value: variableValue };
    });
}

function escapedAt(text, index) {
    let slashes = 0;
    for (let position = index - 1; position >= 0 && text[position] === "\\"; position -= 1) slashes += 1;
    return slashes % 2 === 1;
}

export function variableSuggestionContext(value, selectionStart, selectionEnd = selectionStart, insertedReferenceStart = null) {
    const text = typeof value === "string" ? value : "";
    const cursor = Math.max(0, Math.min(text.length, Number(selectionStart) || 0));
    if (selectionEnd !== selectionStart) return null;
    const before = text.slice(0, cursor);
    const match = /\{([_\p{L}\p{N}]*)$/u.exec(before);
    if (!match || escapedAt(text, match.index)) return null;
    const prefix = match[1];
    if (prefix && !NAME_PATTERN.test(prefix)) return null;
    // An unclosed reference must never consume the next ordinary prompt word.
    // Only an existing, closed reference may include its name suffix after the caret.
    const suffixEnd = cursor + (/^[_\p{L}\p{N}]*/u.exec(text.slice(cursor))?.[0].length ?? 0);
    let end = cursor;
    if (text[cursor] === "}") end += 1;
    else if (insertedReferenceStart !== match.index && text[suffixEnd] === "}") end = suffixEnd + 1;
    return { start: match.index, end, query: prefix, cursor };
}

export function completeVariableReference(value, context, name) {
    const text = typeof value === "string" ? value : "";
    const normalizedName = normalizeVariableName(name);
    if (!context || text[context.start] !== "{") return null;
    const suffix = text.slice(context.end);
    const separator = /^[_\p{L}\p{N}]/u.test(suffix) ? " " : "";
    const replacement = `{${normalizedName}}${separator}`;
    return {
        value: text.slice(0, context.start) + replacement + suffix,
        cursor: context.start + replacement.length,
    };
}

export function replaceVariableReferences(text, oldName, newName) {
    const source = typeof text === "string" ? text : "";
    return source.replace(REFERENCE_PATTERN, (match, name, offset) => (
        !escapedAt(source, offset) && name.normalize("NFC") === oldName
            ? `{${newName}}`
            : match
    ));
}

export function renameVariableReferences(items, oldName, newName) {
    return items.map((item) => ({
        ...item,
        prompt: replaceVariableReferences(item.prompt, oldName, newName),
        ...(Array.isArray(item.prompt_tokens) ? {
            prompt_tokens: item.prompt_tokens.map((token) => ({
                ...token,
                text: replaceVariableReferences(token.text, oldName, newName),
            })),
        } : {}),
    }));
}

export function variableReferenceCount(items, name) {
    return items.filter((item) => (
        replaceVariableReferences(item.prompt, name, "") !== item.prompt
        || item.prompt_tokens?.some((token) => (
            replaceVariableReferences(token.text, name, "") !== token.text
        ))
    )).length;
}

export function variableReferences(items) {
    const names = new Set();
    for (const item of items) {
        for (const text of [item.prompt ?? "", ...(item.prompt_tokens ?? []).map((token) => token.text)]) {
            for (const match of String(text).matchAll(REFERENCE_PATTERN)) {
                if (escapedAt(text, match.index)) continue;
                try { names.add(normalizeVariableName(match[1])); } catch { /* Not a variable reference. */ }
            }
        }
    }
    return names;
}

// Clipboard payloads intentionally contain no workflow IDs or shared-library links.
export const VARIABLE_CLIPBOARD_FORMAT = "prompt-weaver-variables";
export const MAX_VARIABLE_CLIPBOARD_LENGTH = 8 * 1024 * 1024;

export function serializeVariableClipboard(variables) {
    const entries = normalizeVariables(variables).map(({ name, value }) => ({ name, value }));
    return JSON.stringify({ format: VARIABLE_CLIPBOARD_FORMAT, version: 1, variables: entries });
}

export function parseVariableClipboard(text) {
    if (typeof text !== "string" || text.length > MAX_VARIABLE_CLIPBOARD_LENGTH) {
        throw new Error("The clipboard does not contain valid Prompt Weaver variables.");
    }
    let payload;
    try { payload = JSON.parse(text); } catch {
        throw new Error("The clipboard does not contain valid Prompt Weaver variables.");
    }
    if (!payload || payload.format !== VARIABLE_CLIPBOARD_FORMAT || payload.version !== 1
        || !Array.isArray(payload.variables) || !payload.variables.length || payload.variables.length > MAX_VARIABLES) {
        throw new Error("The clipboard does not contain valid Prompt Weaver variables.");
    }
    const variables = normalizeVariables(payload.variables.map((entry, index) => ({
        id: String(index), name: entry?.name, value: entry?.value,
    })));
    return variables.map(({ name, value }) => ({ name, value }));
}

export function mergeVariableClipboard(current, payload, createId) {
    const entries = parseVariableClipboard(JSON.stringify({
        format: VARIABLE_CLIPBOARD_FORMAT, version: 1, variables: payload,
    }));
    const result = normalizeVariables(current);
    for (const entry of entries) {
        const index = result.findIndex((v) => v.name === entry.name);
        if (index < 0) result.push({ id: createId(), ...entry });
        else result[index] = { ...result[index], value: entry.value };
    }
    return normalizeVariables(result);
}
