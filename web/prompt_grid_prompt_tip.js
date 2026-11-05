export function promptNeedsFullPreview(rawPrompt, visibleValue, textWidth, contentWidth) {
    if (typeof rawPrompt !== "string" || !rawPrompt.trim()) return false;
    if (rawPrompt !== visibleValue) return true;
    return Number.isFinite(textWidth)
        && Number.isFinite(contentWidth)
        && textWidth > contentWidth + 1;
}

export function promptFullPreviewPosition({
    anchor,
    tooltipWidth,
    tooltipHeight,
    viewportWidth,
    viewportHeight,
    gap = 6,
    inset = 8,
}) {
    const width = Math.min(tooltipWidth, viewportWidth - inset * 2);
    const below = Math.max(0, viewportHeight - inset - anchor.bottom - gap);
    const above = Math.max(0, anchor.top - inset - gap);
    const openAbove = tooltipHeight > below && above > below;
    const available = openAbove ? above : below;
    if (width <= 0 || available < 24) return null;
    const height = Math.min(tooltipHeight, available);
    return {
        left: Math.max(inset, Math.min(anchor.left, viewportWidth - inset - width)),
        top: openAbove ? anchor.top - gap - height : anchor.bottom + gap,
        maxHeight: available,
        openAbove,
    };
}
