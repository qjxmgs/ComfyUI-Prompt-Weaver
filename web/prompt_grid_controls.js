export function promptGridMasterToggleState(items) {
    if (!Array.isArray(items) || !items.length) return "empty";
    const enabledCount = items.reduce((count, item) => count + (item?.enabled ? 1 : 0), 0);
    if (enabledCount === items.length) return "on";
    if (enabledCount === 0) return "off";
    return "mixed";
}

export function toggleAllPromptGridItems(items) {
    if (!Array.isArray(items) || !items.length) return items;
    const enabled = promptGridMasterToggleState(items) !== "on";
    return items.map((item) => (
        item.enabled === enabled ? item : { ...item, enabled }
    ));
}
