export function clientPointToContent(
    clientX,
    clientY,
    viewportRect,
    scaleX,
    scaleY,
    scrollLeft,
    scrollTop,
) {
    const safeScaleX = Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1;
    const safeScaleY = Number.isFinite(scaleY) && scaleY > 0 ? scaleY : safeScaleX;
    return {
        x: (clientX - viewportRect.left) / safeScaleX + scrollLeft,
        y: (clientY - viewportRect.top) / safeScaleY + scrollTop,
    };
}

export function clientRectToContent(
    clientRect,
    viewportRect,
    scaleX,
    scaleY,
    scrollLeft,
    scrollTop,
) {
    const topLeft = clientPointToContent(
        clientRect.left,
        clientRect.top,
        viewportRect,
        scaleX,
        scaleY,
        scrollLeft,
        scrollTop,
    );
    const safeScaleX = Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1;
    const safeScaleY = Number.isFinite(scaleY) && scaleY > 0 ? scaleY : safeScaleX;
    const width = clientRect.width / safeScaleX;
    const height = clientRect.height / safeScaleY;
    return {
        left: topLeft.x,
        top: topLeft.y,
        right: topLeft.x + width,
        bottom: topLeft.y + height,
        width,
        height,
    };
}

export function findDropTarget(slots, point, skipId, gapX = 0, gapY = gapX) {
    let best = null;
    const expandX = Math.max(0, gapX) / 2;
    const expandY = Math.max(0, gapY) / 2;

    for (const slot of slots) {
        if (slot.id === skipId) continue;
        const rect = slot.rect;
        if (
            point.x < rect.left - expandX
            || point.x > rect.right + expandX
            || point.y < rect.top - expandY
            || point.y > rect.bottom + expandY
        ) {
            continue;
        }

        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const distance = (point.x - centerX) ** 2 + (point.y - centerY) ** 2;
        if (!best || distance < best.distance) best = { ...slot, distance };
    }

    if (!best) return null;
    const { distance: _distance, ...slot } = best;
    return slot;
}

export function resolveImmediateInsertionSide(sourceIndex, targetIndex) {
    return sourceIndex < targetIndex ? "after" : "before";
}

export function computeInsertionIndex(sourceIndex, targetIndex, side, itemCount) {
    if (
        !Number.isInteger(sourceIndex)
        || !Number.isInteger(targetIndex)
        || !Number.isInteger(itemCount)
        || itemCount <= 0
        || sourceIndex < 0
        || sourceIndex >= itemCount
        || targetIndex < 0
        || targetIndex >= itemCount
    ) {
        return sourceIndex;
    }

    let insertionIndex = targetIndex + (side === "after" ? 1 : 0);
    if (sourceIndex < insertionIndex) insertionIndex -= 1;
    return Math.max(0, Math.min(itemCount - 1, insertionIndex));
}

export function movePromptGridItemToEdge(items, itemId, edge) {
    const candidates = Array.isArray(items) ? items : [];
    const sourceIndex = candidates.findIndex((item) => item?.id === itemId);
    const targetIndex = edge === "start"
        ? 0
        : (edge === "end" ? candidates.length - 1 : sourceIndex);
    if (sourceIndex < 0 || sourceIndex === targetIndex || targetIndex < 0) return [...candidates];
    const reordered = [...candidates];
    const [moved] = reordered.splice(sourceIndex, 1);
    if (edge === "start") reordered.unshift(moved);
    else if (edge === "end") reordered.push(moved);
    return reordered;
}

export function edgeScrollVelocity(coordinate, minimum, maximum, threshold = 24, maximumSpeed = 12) {
    if (!Number.isFinite(coordinate) || maximum <= minimum || threshold <= 0 || maximumSpeed <= 0) return 0;
    if (coordinate < minimum || coordinate > maximum) return 0;

    const distanceFromStart = coordinate - minimum;
    if (distanceFromStart < threshold) {
        return -maximumSpeed * (1 - distanceFromStart / threshold);
    }

    const distanceFromEnd = maximum - coordinate;
    if (distanceFromEnd < threshold) {
        return maximumSpeed * (1 - distanceFromEnd / threshold);
    }
    return 0;
}

export function calculateFittedNodeHeight(
    currentHeight,
    viewportHeight,
    contentHeight,
    paddingTop,
    paddingBottom,
    minimumHeight,
    tolerance = 2,
) {
    const availableContentHeight = Math.max(0, viewportHeight - paddingTop - paddingBottom);
    const excessHeight = availableContentHeight - contentHeight;
    if (excessHeight <= tolerance) return currentHeight;
    return Math.max(minimumHeight, Math.ceil(currentHeight - excessHeight));
}
