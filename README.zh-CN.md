# ComfyUI Prompt Weaver

> 🌐 **文档 / Documentation：** [**← English README**](./README.md) · **简体中文**

该插件包含两个能力：

- Prompt Weaver 桌面端与 ComfyUI 之间的 Workflow 打开桥接。
- “提示词开关网格”节点，用网格卡片快速启用、停用、排序和组合提示词。

插件不需要额外 Python 或 JavaScript 依赖。

## 安装与升级

在 ComfyUI 的 `custom_nodes` 目录中克隆本仓库：

```powershell
git clone --branch master https://github.com/qjxmgs/ComfyUI-Prompt-Weaver.git
```

也可以下载源码压缩包，将整个 `ComfyUI-Prompt-Weaver` 目录复制到 `custom_nodes`。安装后重启 ComfyUI，并在浏览器中按 `Ctrl+F5` 强制刷新页面。

通过 Git 安装时，在插件目录中执行下面的命令升级：

```powershell
git pull --ff-only origin master
```

桌面端目前只会在目标目录不存在时安装插件，不会覆盖已经安装的旧版本。升级时必须手动覆盖原目录；如果节点未出现，请确认下面这些文件和目录已经复制：

- `nodes.py`、`archive_store.py`、`tag_autocomplete.py`、`data/tag_sources.json` 和 `__init__.py`
- `locales/en` 和 `locales/zh`
- `web/prompt_toggle_grid.js` 和 `web/prompt_toggle_grid.css`
- `web/prompt_weaver_i18n.js`
- `web/prompt_grid_archives.js` 和 `web/prompt_grid_reorder.js`
- `web/prompt_editor_tokens.js`、`web/prompt_editor_window.js`、`web/prompt_assistant_tags.js` 和 `web/prompt_tag_autocomplete.js`

## 语言支持

节点自动跟随 ComfyUI 的“设置 → 语言”（`Comfy.Locale`）。插件内置英文和简体中文；选择其他语言时回退到英文。切换 ComfyUI 语言会更新已经创建的 Prompt Weaver 节点，但不会修改序列化配置、当前选择、尚未确认的提示词编辑草稿或焦点。

插件只翻译自身提供的界面文案。Prompt 内容、Prompt Assistant 标签、用户创建的存档名称、卡片标题和已有 Workflow 数据不会被翻译或重写。新建节点按当前语言生成默认卡片标题；无前端的 API 运行使用 `Prompt 1` 到 `Prompt 4` 作为英文基准默认值。

固定默认存档由稳定 ID 识别，界面根据语言显示为 `Default Archive` 或“默认存档”。历史内部存储名称保持不变。完全未编辑的空白默认快照可以显示本地化自动标题且不会因此变成未保存状态；一旦编辑或保存，标题就作为用户数据处理。

## 提示词开关网格

在节点菜单的 `Prompt Weaver/提示词` 分类中添加“提示词开关网格”。节点输出标准 `STRING`，可直接连接到 `CLIPTextEncode.text` 或其他字符串输入。

可选的“前置提示词”字符串输入可连接 LoRA 触发词或其他提示词文本。连接后，节点会把它放在已启用网格提示词之前，并自动使用 `, ` 分隔；最终结果按顶层中英文逗号和换行忽略大小写去重，保留首次出现项的原始写法，同时不拆分括号、引号和转义内容内部的分隔符。输入未连接或为空时，保持原有的纯网格输出行为。

每张卡片包含：

- 启用开关。
- 可编辑标题；标题只用于界面识别，不参与输出。
- 固定单行、不可拉伸的提示词输入框，以及右侧的标签编辑按钮。
- 带实时让位动画的拖拽排序和删除按钮；拖拽时按 `Esc` 可取消并恢复原顺序。
- 可通过卡片右键菜单设置颜色；在文本输入框上右键仍使用浏览器原生菜单。

工具栏支持新增提示词、全开、全关，以及固定选择 1–6 列。新节点默认 2 列、4 张已启用的空卡片。数组/视觉顺序就是最终汇总顺序；改变列数不会改变顺序。

点击 Prompt 输入框右侧的编辑按钮会把当前内容按顶层中英文逗号和换行拆成标签；括号、方括号、花括号、引号及转义内容内部不会被拆分。编辑器会忽略大小写自动合并重复标签，保留首次出现项的原始文本和顺序。标签列表末尾的“+”可展开输入框，按 Enter、输入框失焦或直接点击“确认”时，会使用相同规则自动拆分并添加多个提示词；重复项不会再次添加，未选中的重复标签会被重新启用。点击或划过标签可切换选择状态，未选中标签会置灰。关闭按钮、弹窗级 `Esc` 或点击遮罩均不保存；输入框中的 `Esc` 只取消本次添加；“确认”只保留选中标签并使用 `, ` 回填。“自由模式”可以直接编辑完整原始 Prompt，且不会增加 Workflow 持久化设置。

卡片 Prompt 输入框、“+”添加框和自由模式共用双源提示词联想：**Danbooru** 来源使用 Prompt-Weaver 自管本地 CSV；**Prompt Assistant** 来源读取本机已安装 [ComfyUI-Prompt-Assistant](https://github.com/yawiii/comfyui_prompt_assistant) 暴露的全部 CSV。两个来源默认同时开启，并可在 ComfyUI 设置中独立关闭。候选依次按完整相等、开头匹配、连续子串和字符跳跃匹配排序。字符跳跃会忽略空格、下划线和连字符，并优先首次命中位置更靠前、跳过字符更少、候选更短的结果；其余同级结果由 Prompt Assistant 优先，Danbooru 再按使用量降序。最终写入内容会跨来源去重。

输入中文 1 个字或拉丁字符 2 个后开始普通匹配，字符跳跃匹配分别从中文 2 个字或拉丁字符 3 个开始。设置页可将最大联想数量配置为 1–100，默认显示 30 项。两个来源统一显示英文提示词及下方中文释义、分类、来源和使用量；英文 tag 与中文释义中实际命中的内容会标红，字符跳跃匹配会分别标红命中的字符。无中文释义时显示 `—`，Prompt Assistant 没有可靠使用量时保留空白。选中 Danbooru 候选后固定写入规范英文 tag，并把下划线转换为空格。浮层会根据空间向上或向下展开，并通过独立标题栏和流动强调边框与编辑器内容区分。拖动远离输入框一侧的抓手可调整高度，三个输入入口共享并保存 120–720px 的高度偏好，双击抓手恢复默认 320px。上下方向键移动高亮，只有存在高亮项时 Enter/Tab 才会选中，`Esc` 关闭。中文 IME 组合期间不会查询或抢占按键。卡片与自由模式只替换光标所在片段，保留分隔符、括号、引号、转义及权重后缀。

Danbooru 词库不随插件打包。首次输入达到联想条件时，浮层提供明确的下载按钮；平时输入内容不会发送给 Danbooru 或其他远程搜索 API。数据按 ComfyUI 用户保存在 `ComfyUI-Prompt-Weaver/tag-autocomplete/`。插件不会自动联网检查更新；可在“设置 → Prompt Weaver → 提示词翻译”点击“管理提示词翻译…”，或使用菜单“Prompt Weaver → 管理提示词翻译…”，查看本地标签数、中文覆盖率、三层数据源状态及更新时间。打开面板和查看状态只读取本地文件，只有点击“检查并更新”才访问远程数据源。下载使用固定 HTTPS 地址与 SHA-256，完整验证后才原子替换，失败继续使用上一个可用版本。简体中文释义是独立的检索/展示覆盖层，写入始终使用规范英文 tag。完整词库可能包含成人向标签，插件不声称能自动准确过滤。基础词库来自 MIT 授权的 [newtextdoc1111/danbooru-tag-csv](https://huggingface.co/datasets/newtextdoc1111/danbooru-tag-csv)，简体中文主覆盖层来自 MIT 授权的 [Aaalice233/ComfyUI-Danbooru-Gallery](https://github.com/Aaalice233/ComfyUI-Danbooru-Gallery)。

后端还支持第三层 SQLite 缺失翻译补充源。用户可以从固定上游 [`ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table`](https://github.com/ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table/blob/main/tag.sqlite) 自行下载 `tag.sqlite`，然后使用以下任一方式安装：

- 将文件放到 ComfyUI 当前用户目录下的 `ComfyUI-Prompt-Weaver/tag-autocomplete/tag.sqlite`。默认用户的完整结构通常是 `<ComfyUI>/user/default/ComfyUI-Prompt-Weaver/tag-autocomplete/tag.sqlite`；打开翻译管理面板或首次查询时会自动识别，文件大小或修改时间变化后会自动重新验证。
- 在“管理提示词翻译…”面板点击“选择本地 tag.sqlite…”。浏览器会把文件流式上传并复制到上述服务器用户目录，因此远程访问 ComfyUI 时也可以从浏览器所在电脑选择文件。面板还提供投放路径复制和强制重新扫描。

本地投放文件通过验证后优先于插件下载的补充库；此时“检查并更新”仍会更新英文基础词库和中文主翻译，但跳过 GitHub `tag.sqlite` 查询与下载，也绝不会覆盖或删除用户文件。本地文件损坏时会显示独立警告，并回退到上一个有效的插件下载补充库；没有回退库时仍可继续使用英文联想和中文主翻译。导入采用不超过 64 MiB 的流式临时文件，通过 SQLite 文件头、`quick_check`、schema、行数、主键、翻译、分类和热度约束验证后才原子替换，失败保留原文件。

无论本地导入还是插件手动下载，加载时都只按主键查询基础词库中主翻译仍为空的标签，绝不覆盖主翻译，也不引入库外标签、分类或热度。上游仓库目前仍未声明数据许可证，因此清单记录为 `license_status: user-directed`，不会将其标为 MIT 或声称拥有再分发权。`/prompt-weaver/tag-autocomplete/status` 始终只读取本地状态，并报告当前补充来源、文件 SHA-256、行数、修改时间、补齐数量、覆盖率和独立错误。

## 全局存档

工具栏中的存档下拉框用于加载和切换完整网格状态；“存档管理”用于新建、保存、重命名、删除、导入和导出存档。普通点击存档行会只选中该项；按住 `Ctrl` 点击可追加或取消单项，按住 `Shift` 点击可从最近的选择锚点连续选择一个范围，`Ctrl+Shift` 则把该范围追加到已有选择。管理列表中的选择只决定右下角“保存 / 重命名 / 导出 / 删除”的操作目标，不会加载或切换节点内容。一个存档包含节点宽高、列数、卡片顺序、开关、标题、颜色和 Prompt，但不包含画布位置或连线。通过工具栏切换存档时会自动恢复对应节点尺寸。

存档下拉框右侧的“保存”按钮用于把当前网格和节点尺寸快速写回关联存档，仅在当前状态有变更时启用；快捷保存不会再次弹出确认窗口，成功后按钮立即恢复禁用。若保存过程中继续编辑，尚未写入的新变更仍会保持待保存状态。

- 固定置顶的“默认存档”初始为 2 列、4 张已启用空卡片；它可以保存当前状态和参与导入导出，但不能重命名或删除，也不占用普通存档数量限制。
- 每个节点独立记住最后关联的存档。网格内容或节点尺寸发生修改后不会自动切换到内容相同的其他存档，而是在原名称前显示 `*`，例如 `* 常用`；所有选项预留相同标记宽度。切换存档前会先确认是否放弃当前修改。
- 旧 Workflow 没有关联信息时会先尝试按列数及有序的开关、标题、颜色和 Prompt 精确匹配；无法匹配时关联为 `* 默认存档`。当前存档被删除时也保留节点内容并回退到 `* 默认存档`。
- 插件按 ComfyUI 用户保存全局最后选择；新建节点自动加载它。已有节点不会因其他节点或浏览器标签页切换存档而改变关联。
- “新建存档”使用输入的名称保存当前状态；名称去除外围空白后必须为 1–80 个字符且不区分大小写唯一。同名新建会先询问是否将当前状态保存到已有存档。
- 默认存档固定在列表顶部且不可拖拽；普通存档初始按加入本地存档库的顺序排列，先创建的在上，新建或新导入的追加到底部。管理列表左侧的拖拽手柄可以持久化调整顺序，调整结果会同步用于工具栏的快速切换下拉框。
- 单选普通存档时可以保存、重命名、导出或删除；多选时只允许批量导出或删除。默认存档可以参与批量导出，但只要选择中包含默认存档，删除操作就会被禁用。
- 保存、重命名和修改存档内容只更新存档本身，不会改变列表位置；导入覆盖同样保留原位置，导入新增项按导入文件中的顺序追加。
- 保存到已有存档和删除必须二次确认。
- 同一页面中的所有网格节点会同步存档列表；其他浏览器标签页通过 `BroadcastChannel` 收到通知，下拉框获得焦点时也会重新获取列表。

存档写入 ComfyUI 当前用户目录下的 `ComfyUI-Prompt-Weaver/prompt-grid-archives.json`，因此可跨 Workflow 和浏览器使用，并按 ComfyUI 多用户隔离。旧文件会自动补齐默认存档、600×420 的默认节点尺寸和全局选择；后端通过临时文件和原子替换写入，文件损坏时会返回错误，不会静默覆盖。除默认存档外最多保存 100 个普通存档，每个存档最多 500 张卡片，并设有快照、导入文件和总文件大小限制。

单个、选中的多个或全部存档均可导出为统一 JSON 包，批量导出保持当前列表顺序。批量删除使用一次确认和一次原子写入，任一目标无效时整批不删除。导入前会显示存档数和卡片数，并可选择同名冲突策略：默认“跳过”、覆盖本地存档或自动重命名。服务端会先完整校验整批记录，任何非法记录都会取消整批导入。

存档快照不写入节点执行 `config`；Workflow 节点属性只保存一个关联存档 ID，不改变 Queue Prompt、Python 节点或桌面端 C++ 解析契约。新增、修改或删除存档后需要保持 ComfyUI 服务运行；安装此版本后因为新增了 Python 路由，必须重启 ComfyUI。

## 汇总规则

节点按顺序处理所有启用卡片：

1. 去除 Prompt 外围空白。
2. 去除连续的首尾英文逗号 `,`，再去除一次外围空白。
3. 跳过清理后为空的 Prompt。
4. 使用英文逗号加空格 `, ` 连接剩余内容。

Prompt 内部的逗号、换行和全角逗号不会被修改。全部关闭或全部为空时输出空字符串。

## 配置与 API Workflow

网格使用唯一的 `config` widget 保存版本化 JSON 字符串。示例：

```json
{
  "version": 1,
  "columns": 2,
  "items": [
    {
      "id": "prompt-1",
      "enabled": true,
      "title": "画质",
      "prompt": "masterpiece, best quality"
    }
  ]
}
```

API-format Prompt 的 `inputs.config` 必须是 JSON 编码后的**字符串**，不是直接嵌套的对象。例如：

```json
{
  "1": {
    "class_type": "PromptWeaverPromptToggleGrid",
    "inputs": {
      "config": "{\"version\":1,\"columns\":2,\"items\":[{\"id\":\"prompt-1\",\"enabled\":true,\"title\":\"画质\",\"prompt\":\"masterpiece, best quality\"}]}"
    }
  }
}
```

非空但无法解析、根结构错误、`version`/`items`/`enabled`/`prompt` 类型错误或版本不受支持的配置会阻止 Python 节点执行。前端还会校验卡片 ID、标题和颜色；遇到损坏配置时保留原始值，并显示“重置为默认”入口。无效列数只影响布局，前端会恢复为 2 列。

## 持久化与兼容范围

- 网格状态随 Workflow 保存，支持普通画布中的保存重开和复制粘贴。
- 桌面端解析器可以从图片中的 API Prompt 或仅有 UI Workflow 的元数据恢复实际启用的提示词。
- 已经入库且曾解析为空的旧图片不会自动全量重扫；请在桌面端使用“重新解析此图片”。该操作会绕过旧元数据缓存。
- v1 只承诺普通画布节点。Subgraph 参数提升、App Mode、存档文件夹/标签/搜索、云同步、自动定时保存、可配置分隔符、前后缀和卡片权重不在当前兼容范围内。

已验证基线：ComfyUI 0.31.1、frontend 1.48.7、Python 3.13.11。

## Workflow 打开桥接

已经打开的 ComfyUI 前端会通过心跳向插件注册。桌面端发送 `/prompt-weaver/open-workflow` 后，插件优先把 Workflow 投递给最近活跃的页面并调用 `app.loadGraphData()`；只有没有可用前端时才打开新的浏览器页面。

## 开发与测试

插件运行时只依赖 ComfyUI 自带的 Python、aiohttp 和前端环境，不需要安装额外的 Python 或 JavaScript 包。仓库中的回归测试可独立运行：

```powershell
python -m unittest discover -s tests -p "test_*.py" -v
node --test tests/*.mjs
```

测试覆盖节点配置解析、插件注册与路由、全局存档、网格排序、提示词编辑器、双源提示词联想、词库校验与失败回退、语言资源、语言切换和历史数据兼容。

## 许可

本项目采用 [MIT License](LICENSE) 开源。
