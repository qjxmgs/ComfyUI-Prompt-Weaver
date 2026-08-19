const CHINESE_MESSAGES = Object.freeze({
    "Prompt {index}": "提示词 {index}",
    "Prompt grid configuration error: {message}": "提示词网格配置错误：{message}",
    "JSON could not be parsed ({message})": "JSON 无法解析（{message}）",
    "The top-level value must be an object": "顶层值必须是对象",
    "Unsupported version {version}": "不支持的版本 {version}",
    "items must be an array": "items 必须是数组",
    "items[{index}] must be an object": "items[{index}] 必须是对象",
    "items[{index}].enabled must be a boolean": "items[{index}].enabled 必须是布尔值",
    "items[{index}].prompt must be a string": "items[{index}].prompt 必须是字符串",
    "items[{index}].id must be a string": "items[{index}].id 必须是字符串",
    "items[{index}].title must be a string": "items[{index}].title 必须是字符串",
    "items[{index}].id duplicates another card": "items[{index}].id 与其他卡片重复",
    "Columns": "列数",
    "Grid columns": "网格列数",
    "Quickly switch prompt archives": "快速切换提示词存档",
    "Save": "保存",
    "Restore": "还原",
    "Archive Manager": "存档管理",
    "+ Add Prompt": "＋ 新增提示词",
    "Enable All": "全开",
    "Disable All": "全关",
    "Configuration could not be read": "配置无法读取",
    "Reset to Default": "重置为默认",
    "Could not save the last selected archive": "无法保存最后选择的存档",
    "Current Archive": "当前存档",
    "Saving \"{name}\"…": "正在保存“{name}”…",
    "There is no associated archive to save": "当前没有可保存的关联存档",
    "\"{name}\" has no changes to save": "“{name}”没有需要保存的变更",
    "Save current changes to \"{name}\"": "保存当前变更到“{name}”",
    "Finish saving before restoring an archive": "保存完成后才能还原存档",
    "There is no associated archive to restore": "当前没有可还原的关联存档",
    "\"{name}\" has no changes to restore": "“{name}”没有需要还原的变更",
    "Discard current changes and restore \"{name}\"": "放弃当前变更并还原到“{name}”",
    "Default Archive": "默认存档",
    "Archive Saved": "存档已保存",
    "Saved to \"{name}\".": "已保存到“{name}”。",
    "Quick archive save failed": "快捷保存存档失败",
    "Archive Save Failed": "存档保存失败",
    "Save failed: {message}": "保存失败：{message}",
    "Confirm": "确认",
    "Cancel": "取消",
    "Archive Restored": "存档已还原",
    "Restored \"{name}\".": "已恢复到“{name}”。",
    "Discard current changes?": "放弃当前修改？",
    "Loading \"{name}\" will completely replace the current grid state.": "加载“{name}”会完整替换当前网格状态。",
    "Discard and Load": "放弃并加载",
    "The import file cannot exceed 2 MB.": "导入文件不能超过 2 MB。",
    "Importing…": "正在导入…",
    "Import complete: {imported} added, {overwritten} overwritten, {skipped} skipped, {renamed} automatically renamed.": "导入完成：新增 {imported}，覆盖 {overwritten}，跳过 {skipped}，自动重命名 {renamed}。",
    "Import Archives": "导入存档",
    "The file contains {archives} archives and {items} prompt cards. Choose how to handle name conflicts.": "文件包含 {archives} 个存档、{items} 张提示词卡片。请选择同名冲突处理方式。",
    "Skip (Recommended)": "跳过（推荐）",
    "Overwrite Local Archives": "覆盖本地存档",
    "Automatically Rename": "自动重命名",
    "Start Import": "开始导入",
    "Saving…": "正在保存…",
    "Enter an archive name.": "请输入存档名称。",
    "Save to an archive with the same name?": "保存到同名存档？",
    "\"{name}\" already exists. Save the current grid state to it and replace its contents?": "“{name}”已存在，是否将当前网格状态保存到该存档？原有内容将被替换。",
    "Saved \"{name}\".": "已保存“{name}”。",
    "Saving archive order…": "正在保存排序…",
    "Archive order saved.": "存档顺序已保存。",
    "Could not save archive order: {message}": "排序保存失败：{message}",
    "Archive name cannot be empty.": "存档名称不能为空。",
    "Renamed to \"{name}\".": "已重命名为“{name}”。",
    "Save the default archive?": "保存默认存档？",
    "Save the archive?": "保存存档？",
    "Save the current grid state and window size to \"{name}\" and replace its contents?": "是否将当前网格状态和窗口大小保存到“{name}”？原有内容将被替换。",
    "Exported \"{name}\".": "已导出“{name}”。",
    "Exported {count} selected archives.": "已导出 {count} 个选中存档。",
    "The default archive cannot be deleted.": "默认存档不能删除。",
    "Delete archive?": "删除存档？",
    "Delete {count} archives?": "删除 {count} 个存档？",
    "{names} cannot be recovered after deletion. The current node state will not change.": "{names}删除后无法恢复，当前节点状态不会改变。",
    "{names} and {count} archives in total cannot be recovered after deletion. The current node state will not change.": "{names} 等 {count} 个存档删除后无法恢复，当前节点状态不会改变。",
    "Delete": "删除",
    "Deleted \"{name}\".": "已删除“{name}”。",
    "Deleted {count} archives.": "已删除 {count} 个存档。",
    "Save Name": "保存名称",
    "Save the current grid state to the selected archive": "将当前网格状态保存到所选存档",
    "Load": "加载",
    "Load the selected archive": "加载所选存档",
    "Rename": "重命名",
    "The default archive cannot be renamed": "默认存档不能重命名",
    "Rename the selected archive": "重命名所选存档",
    "Export": "导出",
    "Export the selected archives": "导出选中的存档",
    "Delete the selected archives": "删除选中的存档",
    "Select an archive first": "请先选择存档",
    "There are no archives yet. Create one above.": "还没有存档。可在上方新建存档。",
    "{name} archive": "{name}存档",
    "Drag to reorder archives": "拖拽调整存档顺序",
    "Drag \"{name}\" to reorder it": "拖拽“{name}”调整顺序",
    "Default": "默认",
    "Current": "当前",
    "{columns} columns · {cards} cards · {enabled} enabled · {width}×{height} · {time}": "{columns} 列 · {cards} 张卡片 · {enabled} 张启用 · {width}×{height} · {time}",
    "New archive name": "新的存档名称",
    "Prompt Grid Archive Manager": "提示词网格存档管理",
    "Prompt Grid Archives": "提示词网格存档",
    "Close": "关闭",
    "Close archive manager": "关闭存档管理",
    "Archive name": "存档名称",
    "New Archive": "新建存档",
    "Archive list": "存档列表",
    "Export All": "导出全部",
    "There are no archives to export.": "当前没有可导出的存档。",
    "Exported {count} archives.": "已导出 {count} 个存档。",
    "{name} menu": "{name} 菜单",
    "Prompt": "提示词",
    "Move to Top": "置顶",
    "Move to Bottom": "置底",
    "Color": "颜色",
    "Card color": "卡片颜色",
    "No Color": "无色",
    "Color: {color}": "颜色：{color}",
    "Red": "红",
    "Orange": "橙",
    "Yellow": "黄",
    "Green": "绿",
    "Cyan": "青",
    "Blue": "蓝",
    "Purple": "紫",
    "Pink": "粉",
    "Gray": "灰",
    "White": "白",
    "Black": "黑",
    "0 prompts active": "当前激活 0 个提示词",
    "Edit Prompts (": "编辑提示词（",
    ")": "）",
    "Free Mode": "自由模式",
    "Prompt font size": "提示词字号",
    "{size} pixels": "{size} 像素",
    "Close without saving": "关闭且不保存",
    "Close the prompt editor without saving": "关闭提示词编辑窗口且不保存",
    "Prompt tags": "提示词标签",
    "Enable all prompts": "启用全部提示词",
    "Disable all prompts": "停用全部提示词",
    "Resize the prompt editor": "拖拽调整提示词编辑窗口大小",
    "{count} prompts active": "当前激活 {count} 个提示词",
    "{count} prompt active": "当前激活 {count} 个提示词",
    ", ": "，",
    "{parts}.": "{parts}。",
    "Free-mode prompt text": "自由模式提示词文本",
    "Enter the full prompt": "输入完整提示词",
    "There are no prompts. Click + to add one.": "当前没有提示词，可点击 + 添加。",
    "Enter a prompt; Chinese and English tag matching are supported": "输入提示词，支持中文或英文标签匹配",
    "Add prompt": "新增提示词",
    "Prompt Assistant tag matches": "Prompt Assistant 标签匹配结果",
    "No prompt text was detected.": "未检测到可添加的提示词。",
    "Added {count}": "已添加 {count} 个",
    "Merged {count} duplicates": "合并 {count} 个重复项",
    "Re-enabled {count}": "重新启用 {count} 个",
    "Formatted as {count} prompts.": "已格式化为 {count} 个提示词。",
    "All prompts enabled.": "已全部启用。",
    "All prompts disabled.": "已全部停用。",
    "Automatically merged {count} duplicates.": "已自动合并 {count} 个重复项。",
    "Drag to reorder": "拖拽排序",
    "Drag this card to reorder it": "拖拽此卡片排序",
    "Enable this prompt": "启用此提示词",
    "Prompt title": "提示词标题",
    "Delete this prompt": "删除此提示词",
    "Enter a prompt…": "输入提示词…",
    "Prompt content": "提示词内容",
    "Split and select prompts": "拆分并选择提示词",
    "Open the prompt tag editor": "打开提示词标签编辑窗口",
    "Click again to delete a non-empty prompt": "再次点击确认删除非空提示词",
    "Unknown configuration error": "未知配置错误",
    "There are no prompts. Click \"Add Prompt\" to begin.": "暂无提示词，点击“新增提示词”开始编辑。",
    "The top level of the import file must be an object": "导入文件顶层必须是对象",
    "Unsupported archive file format": "不支持的存档文件格式",
    "The import file does not contain any archives": "导入文件不包含存档",
    "Archive {timestamp}": "存档 {timestamp}",
    "Archive request failed (HTTP {status})": "存档请求失败（HTTP {status}）",
    "Archive data is invalid.": "存档数据无效。",
    "The requested archive was not found.": "找不到请求的存档。",
    "An archive with the same name already exists.": "已存在同名存档。",
    "The archive request is too large.": "存档请求过大。",
    "The archive store could not be read.": "无法读取存档数据。",
    "{label} request failed.": "{label} 请求失败。",
    "{label} returned invalid JSON.": "{label} 返回了无效 JSON。",
    "The Prompt Assistant tag file list is invalid.": "Prompt Assistant 标签文件列表格式无效。",
    "Prompt Assistant returned an invalid tag file name.": "Prompt Assistant 返回了无效标签文件名。",
    "Prompt Assistant tag data must be an object.": "Prompt Assistant 标签数据必须是对象。",
    "A Prompt Assistant tag name is missing.": "Prompt Assistant 标签名称缺失。",
    "Prompt Assistant tag data contains a non-object group or non-string tag.": "Prompt Assistant 标签数据包含非对象分组或非字符串标签。",
    "Prompt Assistant tag data contains an invalid name.": "Prompt Assistant 标签数据包含无效名称。",
    "The ComfyUI API client is unavailable.": "ComfyUI API 客户端不可用。",
    "ComfyUI extension list": "ComfyUI 扩展列表",
    "Prompt Assistant tag file list": "Prompt Assistant 标签文件列表",
    "Could not use the Prompt Assistant tag API: {base}": "无法使用 Prompt Assistant 标签接口：{base}",
    "Could not read the ComfyUI extension list; tag autocomplete is hidden.": "无法读取 ComfyUI 扩展列表，标签自动补全已隐藏。",
    "Prompt Assistant tag file {file}": "Prompt Assistant 标签文件 {file}",
    "Prompt Assistant tag file {file} is invalid.": "Prompt Assistant 标签文件 {file} 格式无效。",
    "Could not load Prompt Assistant tag file: {file}": "无法加载 Prompt Assistant 标签文件：{file}",
    "{value} ({name})": "{value}（{name}）",
    "Prompt tag matches": "提示词标签匹配结果",
    "Danbooru dictionary status": "Danbooru 词库状态",
    "Danbooru tag search": "Danbooru 标签搜索",
    "Danbooru dictionary update": "Danbooru 词库更新",
    "Danbooru dictionary update timed out.": "Danbooru 词库更新超时。",
    "General": "常规",
    "Artist": "画师",
    "Copyright": "作品",
    "Character": "角色",
    "Meta": "元数据",
    "Custom": "自定义",
    "Other": "其他",
    "Download Danbooru dictionary": "下载 Danbooru 词库",
    "Download Chinese Danbooru translations": "下载 Danbooru 中文释义",
    "Updating Danbooru dictionary…": "正在更新 Danbooru 词库…",
    "Update failed: {message}": "更新失败：{message}",
    "Enable Danbooru tag autocomplete": "启用 Danbooru 标签联想",
    "Uses the Prompt-Weaver local Danbooru CSV dictionary. Typing stays local.": "使用 Prompt-Weaver 本地 Danbooru CSV 词库，输入内容不会发送到网络。",
    "Enable Prompt Assistant autocomplete": "启用 Prompt Assistant 联想",
    "Uses tag CSV files exposed by an installed ComfyUI-Prompt-Assistant plugin.": "使用已安装 ComfyUI-Prompt-Assistant 插件提供的标签 CSV。",
    "Update Danbooru Dictionary": "更新 Danbooru 词库",
    "Danbooru Dictionary": "Danbooru 词库",
    "Checking for Danbooru dictionary updates…": "正在检查 Danbooru 词库更新…",
    "Danbooru dictionary is ready with {count} tags.": "Danbooru 词库已就绪，共 {count} 个标签。",
    "Danbooru Dictionary Update Failed": "Danbooru 词库更新失败",
    "Manage prompt translations…": "管理提示词翻译…",
    "Prompt translations": "提示词翻译",
    "View local translation coverage and manually update the prompt dictionary.": "查看本地翻译覆盖率并手动更新提示词词库。",
    "Never": "从未",
    "View source": "查看来源",
    "Not installed": "未安装",
    "Updating…": "正在更新…",
    "Update failed": "更新失败",
    "Attention needed": "需要注意",
    "Ready": "已就绪",
    "Download the local dictionary and Simplified Chinese translations to get started.": "下载本地词库和简体中文翻译后即可使用。",
    "Downloading and validating prompt translation data…": "正在下载并验证提示词翻译数据…",
    "Prompt translation data could not be installed.": "无法安装提示词翻译数据。",
    "The local dictionary remains usable, but part of the translation data needs attention.": "本地词库仍可使用，但部分翻译数据需要处理。",
    "Local prompt translations are ready. Prompt text stays on this device.": "本地提示词翻译已就绪，提示词内容始终保留在本机。",
    "Available": "可用",
    "Partially available": "部分可用",
    "Unavailable": "不可用",
    "Local tags": "本地标签",
    "Translated tags": "已翻译标签",
    "Translation coverage": "翻译覆盖率",
    "Last manual check: {date}": "上次手动检查：{date}",
    "Last data update: {date}": "上次数据更新：{date}",
    "English base dictionary": "英文基础词库",
    "Canonical Danbooru tags, categories, aliases, and usage counts.": "提供规范 Danbooru 标签、分类、别名和使用量。",
    "Installed": "已安装",
    "Tags": "标签数",
    "Version": "版本",
    "License": "许可证",
    "Primary Chinese translations": "中文主翻译",
    "The primary Simplified Chinese display and search translation layer.": "用于简体中文展示与搜索的主翻译层。",
    "Awaiting license": "等待授权",
    "Installed for local use": "已安装供本地使用",
    "Ready for local download": "可下载到本地",
    "Disabled": "已禁用",
    "This source has not declared a data license, so it is shown for transparency but cannot be enabled or downloaded.": "该来源尚未声明数据许可证，因此仅展示状态和来源，不能启用或下载。",
    "Only fills base-dictionary tags still missing from the primary translation layer.": "仅补充基础词库中主翻译层仍缺失的标签。",
    "This approved supplement will be downloaded during the next manual update.": "该已获授权的补充层将在下次手动更新时下载。",
    "Downloaded from the user-selected source for local missing-translation completion; the source has not declared a data license.": "已从用户指定来源下载，仅用于补齐本地缺失翻译；该来源尚未声明数据许可证。",
    "The next manual update downloads tag.sqlite from the user-selected source and applies it only to missing local translations.": "下次手动更新会从用户指定来源下载 tag.sqlite，并仅用于补齐本地缺失翻译。",
    "The optional missing-translation supplement is disabled by the source manifest.": "缺失翻译补充层已由数据源清单禁用。",
    "Missing-translation supplement": "中文缺失补充层",
    "Added translations": "补齐翻译数",
    "Blob SHA": "Blob SHA",
    "Updated": "更新时间",
    "The update is still running in the background. Close this panel and check again later.": "更新仍在后台进行，可关闭面板并稍后重新查看。",
    "Download dictionary and translations": "下载词库与翻译",
    "Check and update": "检查并更新",
    "Prompt translations updated with warnings": "提示词翻译已更新，但有警告",
    "Prompt translations updated": "提示词翻译已更新",
    "{translated} of {total} local tags have Chinese translations.": "本地 {total} 个标签中已有 {translated} 个中文翻译。",
    "Prompt translation update failed": "提示词翻译更新失败",
    "Close prompt translation manager": "关闭提示词翻译管理面板",
    "Reading local translation status…": "正在读取本地翻译状态…"
});

const ENGLISH_MESSAGES = Object.freeze(Object.fromEntries(
    Object.keys(CHINESE_MESSAGES).map((key) => [key, key]),
));

export const MESSAGES = Object.freeze({ en: ENGLISH_MESSAGES, zh: CHINESE_MESSAGES });

let activeLocale = "en";
const subscribers = new Set();

export function normalizeLocale(value) {
    const locale = typeof value === "string" ? value.trim().replaceAll("_", "-").toLowerCase() : "";
    return locale === "zh" || locale.startsWith("zh-cn") || locale.startsWith("zh-hans")
        ? "zh"
        : "en";
}

export function getLocale() {
    return activeLocale;
}

export function setLocale(value) {
    const nextLocale = normalizeLocale(value);
    if (nextLocale === activeLocale) return activeLocale;
    activeLocale = nextLocale;
    for (const subscriber of [...subscribers]) subscriber(activeLocale);
    return activeLocale;
}

export function syncLocale(app) {
    try {
        return setLocale(app?.extensionManager?.setting?.get?.("Comfy.Locale"));
    } catch {
        return activeLocale;
    }
}

export function connectLocale(app) {
    syncLocale(app);
    const settings = app?.ui?.settings;
    if (typeof settings?.addEventListener !== "function") return () => {};
    const handler = (event) => setLocale(event?.detail?.value);
    settings.addEventListener("Comfy.Locale.change", handler);
    return () => settings.removeEventListener?.("Comfy.Locale.change", handler);
}

export function subscribeLocale(subscriber) {
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
    const template = MESSAGES[activeLocale]?.[message] ?? ENGLISH_MESSAGES[message] ?? message;
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
