import { splitPromptTokens, walkPromptSyntax } from "./prompt_editor_tokens.js?v=20261106-clear-prompt-tags";
import { literalPromptText, previewVariableReferences } from "./prompt_variables.js?v=20261106-editable-filtered-prompt";

const WEIGHT = /^\s*[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\s*$/u;

function clearPromptKey(token) {
    if (!token.startsWith("(") || !token.endsWith(")")) return token.toLowerCase();
    const wrappers = new Map();
    const stack = [];
    walkPromptSyntax(token, (character, index) => {
        if (character === "(") stack.push({ start: index, colon: null });
        else if (character === ":" && stack.length) stack.at(-1).colon = index;
        else if (character === ")" && stack.length) {
            const { start, colon } = stack.pop();
            wrappers.set(start, { end: index, colon });
        }
    });

    let start = 0;
    let end = token.length;
    while (wrappers.get(start)?.end === end - 1) {
        const { colon } = wrappers.get(start);
        const innerStart = start + 1;
        const innerEnd = colon > innerStart && WEIGHT.test(token.slice(colon + 1, end - 1))
            ? colon : end - 1;
        // Walk just the whitespace at each boundary, even with deep nesting.
        let left = innerStart;
        let right = innerEnd;
        while (left < right && /\s/u.test(token[left])) left += 1;
        while (right > left && /\s/u.test(token[right - 1])) right -= 1;
        if (left === right) break;
        start = left;
        end = right;
    }
    return token.slice(start, end).toLowerCase();
}

export function clearPromptKeys(prompt, variables) {
    if (!prompt) return new Set();
    const expanded = previewVariableReferences(prompt, variables);
    if (expanded.missing.length) return new Set();
    return new Set(splitPromptTokens(expanded.text).map(clearPromptKey));
}

function expandedCardTokens(prompt, variables) {
    const { text, missing } = previewVariableReferences(prompt, variables);
    if (missing.length) return null;
    return splitPromptTokens(text.trim().replace(/^,+|,+$/gu, ""));
}

// Null leaves the original text intact. An empty result means all tokens were filtered.
export function filteredCardPrompt(prompt, variables, keys) {
    if (!prompt || !keys.size) return null;
    const tokens = expandedCardTokens(prompt, variables);
    if (!tokens) return null;
    const remaining = tokens.filter((token) => !keys.has(clearPromptKey(token)));
    return remaining.length === tokens.length ? null : remaining.join(", ");
}

export function createFilteredPromptEdit(prompt, variables, keys) {
    if (!prompt || !keys.size) return null;
    const tokens = expandedCardTokens(prompt, variables);
    const isHidden = (token) => keys.has(clearPromptKey(token));
    if (!tokens?.some(isHidden)) return null;

    let groups = splitPromptTokens(prompt).map((source) => ({
        source,
        tokens: expandedCardTokens(source, variables),
    }));
    const separate = groups.flatMap((group) => group.tokens);
    // A variable can supply syntax that joins adjacent source tags into one expression.
    if (separate.length !== tokens.length || !separate.every((token, index) => token === tokens[index])) {
        groups = [{ source: prompt, tokens }];
    }
    const original = tokens.filter((token) => !isHidden(token)).map((token) => token.replace(/[\r\n]/gu, ""));
    const projectedGroups = groups.map((group) => {
        const entries = group.tokens.map((text) => ({ text, hidden: isHidden(text) }));
        return { source: group.source, tokens: entries, visibleCount: entries.filter((entry) => !entry.hidden).length };
    });

    return (draft) => {
        const edited = splitPromptTokens(draft);
        let start = 0;
        while (start < original.length && start < edited.length && original[start] === edited[start]) start += 1;
        let oldEnd = original.length;
        let newEnd = edited.length;
        if (start === oldEnd && start === newEnd) return prompt;
        while (oldEnd > start && newEnd > start && original[oldEnd - 1] === edited[newEnd - 1]) {
            oldEnd -= 1;
            newEnd -= 1;
        }

        const result = [];
        let position = 0;
        let nextNew = start;
        const insertEdit = () => {
            while (nextNew < newEnd) result.push(edited[nextNew++]);
        };
        for (const group of projectedGroups) {
            const end = position + group.visibleCount;
            if (group.visibleCount === 0 || end <= start || position >= oldEnd) {
                if (group.visibleCount && position === start) insertEdit();
                result.push(group.source);
                position = end;
                continue;
            }
            // Materialize the touched expansion so an edit can change one part without losing the hidden part.
            for (const token of group.tokens) {
                if (token.hidden) {
                    result.push(literalPromptText(token.text));
                    continue;
                }
                if (position === start) insertEdit();
                if (position < start || position >= oldEnd) result.push(literalPromptText(token.text));
                position += 1;
            }
        }
        insertEdit();
        return result.join(", ");
    };
}
