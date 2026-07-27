function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

export function countActivePromptTokens(selected) {
    if (!Array.isArray(selected)) return 0;
    return selected.reduce((count, active) => count + (active === true ? 1 : 0), 0);
}

export function normalizePromptEditorSize(
    value,
    {
        viewportWidth,
        viewportHeight,
        margin = 16,
        minWidth = 360,
        minHeight = 240,
    } = {},
) {
    const width = finiteNumber(value?.width);
    const height = finiteNumber(value?.height);
    const availableWidth = finiteNumber(viewportWidth);
    const availableHeight = finiteNumber(viewportHeight);
    if (width === null || height === null || availableWidth === null || availableHeight === null) {
        return null;
    }

    const maxWidth = Math.max(1, availableWidth - margin * 2);
    const maxHeight = Math.max(1, availableHeight - margin * 2);
    const safeMinWidth = Math.min(Math.max(1, minWidth), maxWidth);
    const safeMinHeight = Math.min(Math.max(1, minHeight), maxHeight);
    return {
        width: Math.round(clamp(width, safeMinWidth, maxWidth)),
        height: Math.round(clamp(height, safeMinHeight, maxHeight)),
    };
}

export function clampPromptEditorPosition(
    value,
    {
        viewportWidth,
        viewportHeight,
        margin = 16,
    } = {},
) {
    const left = finiteNumber(value?.left);
    const top = finiteNumber(value?.top);
    const width = finiteNumber(value?.width);
    const height = finiteNumber(value?.height);
    const availableWidth = finiteNumber(viewportWidth);
    const availableHeight = finiteNumber(viewportHeight);
    if (
        left === null
        || top === null
        || width === null
        || height === null
        || availableWidth === null
        || availableHeight === null
    ) return null;

    const maxLeft = Math.max(margin, availableWidth - width - margin);
    const maxTop = Math.max(margin, availableHeight - height - margin);
    return {
        left: Math.round(clamp(left, Math.min(margin, maxLeft), maxLeft)),
        top: Math.round(clamp(top, Math.min(margin, maxTop), maxTop)),
    };
}
