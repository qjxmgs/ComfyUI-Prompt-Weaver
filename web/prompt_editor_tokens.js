function isWordCharacter(character) {
    return typeof character === "string" && /[\p{L}\p{N}_]/u.test(character);
}

function quoteEndAt(text, index) {
    const character = text[index];
    if (character === '"') return '"';
    if (character === "“") return "”";
    if (character === "‘") return "’";
    if (character === "'" && !(isWordCharacter(text[index - 1]) && isWordCharacter(text[index + 1]))) {
        return "'";
    }
    return null;
}

function isContractionApostrophe(text, index) {
    return (text[index] === "'" || text[index] === "’")
        && isWordCharacter(text[index - 1])
        && isWordCharacter(text[index + 1]);
}

function isTopLevelSeparator(character) {
    return character === "," || character === "，" || character === "\n" || character === "\r";
}

export function splitPromptTokens(value) {
    const text = typeof value === "string" ? value : "";
    const tokens = [];
    let current = "";
    let parenthesisDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    let quoteEnd = null;
    let escaped = false;

    const flush = () => {
        const token = current.trim();
        if (token) tokens.push(token);
        current = "";
    };

    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (escaped) {
            current += character;
            escaped = false;
            continue;
        }
        if (character === "\\") {
            current += character;
            escaped = true;
            continue;
        }
        if (quoteEnd) {
            current += character;
            if (character === quoteEnd && !isContractionApostrophe(text, index)) quoteEnd = null;
            continue;
        }

        const nextQuoteEnd = quoteEndAt(text, index);
        if (nextQuoteEnd) {
            quoteEnd = nextQuoteEnd;
            current += character;
            continue;
        }

        if (
            isTopLevelSeparator(character)
            && parenthesisDepth === 0
            && bracketDepth === 0
            && braceDepth === 0
        ) {
            flush();
            continue;
        }

        current += character;
        if (character === "(") parenthesisDepth += 1;
        else if (character === ")" && parenthesisDepth > 0) parenthesisDepth -= 1;
        else if (character === "[") bracketDepth += 1;
        else if (character === "]" && bracketDepth > 0) bracketDepth -= 1;
        else if (character === "{") braceDepth += 1;
        else if (character === "}" && braceDepth > 0) braceDepth -= 1;
    }
    flush();
    return tokens;
}

function promptTokenKey(value) {
    return (typeof value === "string" ? value.trim() : "").toLowerCase();
}

export function dedupePromptTokens(tokens) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(tokens) ? tokens : []) {
        const token = typeof value === "string" ? value.trim() : "";
        const key = promptTokenKey(token);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(token);
    }
    return result;
}

export function mergePromptTokenInput(tokens, selected, input) {
    const nextTokens = Array.isArray(tokens) ? [...tokens] : [];
    const nextSelected = nextTokens.map((_token, index) => Boolean(selected?.[index]));
    const indexByKey = new Map();
    for (let index = 0; index < nextTokens.length; index += 1) {
        const key = promptTokenKey(nextTokens[index]);
        if (key && !indexByKey.has(key)) indexByKey.set(key, index);
    }

    let addedCount = 0;
    let mergedCount = 0;
    let reactivatedCount = 0;
    for (const token of splitPromptTokens(input)) {
        const key = promptTokenKey(token);
        const existingIndex = indexByKey.get(key);
        if (existingIndex !== undefined) {
            mergedCount += 1;
            if (!nextSelected[existingIndex]) {
                nextSelected[existingIndex] = true;
                reactivatedCount += 1;
            }
            continue;
        }
        indexByKey.set(key, nextTokens.length);
        nextTokens.push(token);
        nextSelected.push(true);
        addedCount += 1;
    }
    return {
        tokens: nextTokens,
        selected: nextSelected,
        addedCount,
        mergedCount,
        reactivatedCount,
    };
}

export function buildPromptFromSelection(
    originalPrompt,
    tokens,
    selected,
    initialSelected,
    { forceRebuild = false } = {},
) {
    const selectionChanged = tokens.some(
        (_token, index) => Boolean(selected[index]) !== Boolean(initialSelected[index]),
    );
    if (!selectionChanged && !forceRebuild) return originalPrompt;
    return tokens.filter((_token, index) => Boolean(selected[index])).join(", ");
}

export function confirmPromptEditorDraft(
    originalPrompt,
    tokens,
    selected,
    initialSelected,
    pendingInput,
    { forceRebuild = false } = {},
) {
    const confirmedDraft = typeof pendingInput === "string" && pendingInput.trim()
        ? mergePromptTokenInput(tokens, selected, pendingInput)
        : { tokens, selected };
    return buildPromptFromSelection(
        originalPrompt,
        confirmedDraft.tokens,
        confirmedDraft.selected,
        initialSelected,
        { forceRebuild },
    );
}
