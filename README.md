# ComfyUI Prompt Weaver

> 🌐 **Documentation / 文档:** **English** · [**简体中文 README →**](./README.zh-CN.md)

ComfyUI Prompt Weaver provides two features:

- A workflow-opening bridge between the Prompt Weaver desktop application and ComfyUI.
- A **Prompt Toggle Grid** node for quickly enabling, disabling, arranging, and combining prompt cards.

The plugin has no additional Python or JavaScript dependencies.

## Installation and upgrades

Clone this repository into ComfyUI's `custom_nodes` directory:

```powershell
git clone --branch master https://github.com/qjxmgs/ComfyUI-Prompt-Weaver.git
```

Alternatively, download the source archive and copy the complete `ComfyUI-Prompt-Weaver` directory into `custom_nodes`. Restart ComfyUI after installation, then press `Ctrl+F5` in the browser to force a full refresh.

For a Git installation, update from inside the plugin directory:

```powershell
git pull --ff-only origin master
```

The desktop application currently installs the plugin only when the target directory does not exist. It does not overwrite an older installation. Upgrade that installation manually and make sure the following files and directories are present if the node does not appear:

- `nodes.py`, `archive_store.py`, `tag_autocomplete.py`, `data/tag_sources.json`, and `__init__.py`
- `locales/en` and `locales/zh`
- `web/prompt_toggle_grid.js` and `web/prompt_toggle_grid.css`
- `web/prompt_weaver_i18n.js`
- `web/prompt_grid_archives.js` and `web/prompt_grid_reorder.js`
- `web/prompt_editor_tokens.js`, `web/prompt_editor_window.js`, `web/prompt_assistant_tags.js`, and `web/prompt_tag_autocomplete.js`

## Language support

The node automatically follows **Settings → Language** (`Comfy.Locale`) in ComfyUI. English and Simplified Chinese are included; every other locale falls back to English. Changing the ComfyUI language updates existing Prompt Weaver nodes without changing their serialized configuration, current selection, unsaved prompt-editor draft, or focus.

Only plugin-provided interface text is translated. Prompt text, Prompt Assistant tags, user-created archive names, card titles, and existing workflow data are never translated or rewritten. A newly created node uses localized default card titles. Headless/API usage uses the canonical English defaults `Prompt 1` through `Prompt 4`.

The built-in default archive is identified by its stable ID and is displayed as **Default Archive** or **默认存档**. Its historical stored name remains unchanged for compatibility. An untouched empty default snapshot can display localized generated titles without becoming dirty; after it is edited or saved, its titles are treated as user data.

## Prompt Toggle Grid

Add **Prompt Toggle Grid** from the `Prompt Weaver/Prompt` node category. The node outputs a standard `STRING`, which can connect directly to `CLIPTextEncode.text` or any other string input.

Each card contains:

- An enable switch.
- An editable title used only for identification; it is not included in the output.
- A fixed single-line prompt field and a tag-editor button.
- Drag-to-reorder with live displacement animation, plus a delete button. Press `Esc` while dragging to restore the original order.
- An optional card color selected from the card context menu. Right-clicking a text field keeps the browser's native menu.

The toolbar can add prompts, enable or disable every card, and select a fixed layout of 1–6 columns. A new node starts with two columns and four enabled empty cards. Array/visual order is the final combination order; changing the column count never changes that order.

The editor button next to a prompt splits its text at top-level English or Chinese commas and line breaks. Separators inside parentheses, square or curly brackets, quotes, and escaped content are preserved. The editor deduplicates tags case-insensitively while retaining the first spelling and original order. Its `+` composer accepts multiple prompts using the same splitting rules and commits on Enter, blur, or Confirm. Existing inactive duplicates are re-enabled instead of added again. Clicking or painting across tags toggles their selection. The close button, dialog-level `Esc`, or backdrop discards changes; `Esc` inside the composer cancels only that addition. Confirm writes only selected tags back with `, ` separators. Free Mode edits the complete raw prompt without making a persistent workflow setting.

The card prompt field, the `+` composer, and Free Mode share dual-source autocomplete. **Danbooru** suggestions come from a Prompt-Weaver-managed local CSV dictionary; **Prompt Assistant** suggestions come from every CSV exposed by an installed [ComfyUI-Prompt-Assistant](https://github.com/yawiii/comfyui_prompt_assistant). Both sources are enabled by default and can be toggled independently in ComfyUI settings. Exact, prefix, substring, and ordered character-skip matches are ranked in that order. Character-skip matching ignores spaces, underscores, and hyphens, then favors an earlier first hit, fewer skipped characters, and a shorter candidate. Prompt Assistant wins remaining equal-rank ties, while Danbooru ties use post count. Final insertion text is deduplicated across sources.

Matching starts after one Chinese character or two Latin characters and returns at most 20 results. Character-skip matching starts after two Chinese characters or three Latin characters. Both data sources use the same four-column layout: English prompt with Chinese description underneath, category, source, and usage count. Missing Chinese descriptions display `—`, while Prompt Assistant keeps the count column empty because it has no reliable usage statistics. Selecting a Danbooru tag inserts its canonical English tag with underscores converted to spaces. The popup opens above or below according to available space; arrow keys move the highlight, Enter or Tab selects only a highlighted result, and `Esc` closes it. IME composition is not intercepted. In the card and Free Mode fields only the fragment surrounding the caret is replaced, preserving separators, wrappers, quotes, escapes, and weight suffixes.

The Danbooru dictionary is not bundled. The first eligible query displays an explicit download action, and typing is never sent to Danbooru or another remote search API. Data is stored per ComfyUI user under `ComfyUI-Prompt-Weaver/tag-autocomplete/`. The plugin never checks for updates automatically. Open **Settings → Prompt Weaver → Prompt translations → Manage prompt translations…** or **Prompt Weaver → Manage prompt translations…** to inspect local tag counts, Chinese coverage, all three source layers, and timestamps. Opening the panel and reading status only access local files; remote sources are contacted only after **Check and update** is clicked. Downloads are pinned by HTTPS URL and SHA-256, validated before atomic replacement, and a failed update keeps the last good files. Simplified Chinese uses a separate display/search translation overlay and always inserts the canonical English tag. The full dictionary can include adult tags; automatic safety filtering is not claimed. The base dataset is [newtextdoc1111/danbooru-tag-csv](https://huggingface.co/datasets/newtextdoc1111/danbooru-tag-csv) (MIT), and the primary Simplified Chinese overlay is from [Aaalice233/ComfyUI-Danbooru-Gallery](https://github.com/Aaalice233/ComfyUI-Danbooru-Gallery) (MIT).

The backend also supports a third SQLite missing-translation supplement. Download `tag.sqlite` from the fixed upstream [`ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table`](https://github.com/ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table/blob/main/tag.sqlite), then install it in either of these ways:

- Place it at `ComfyUI-Prompt-Weaver/tag-autocomplete/tag.sqlite` inside the current ComfyUI user data directory. For the default user this is normally `<ComfyUI>/user/default/ComfyUI-Prompt-Weaver/tag-autocomplete/tag.sqlite`. Opening the translation manager or running the first lookup discovers it automatically; a size or modification-time change triggers revalidation.
- Click **Choose local tag.sqlite…** in **Manage prompt translations…**. The browser streams and copies the selected file into that server-side user directory, so this also works when the browser and ComfyUI server are on different computers. The panel can copy the drop-in path or force a local rescan.

A validated user-supplied file takes priority over the plugin-downloaded supplement. While it is active, **Check and update** still refreshes the English base and primary Chinese layers but skips the GitHub `tag.sqlite` metadata request and download; remote updates never replace or delete the user file. An invalid drop-in file produces a separate warning and falls back to the last valid downloaded supplement. If no fallback exists, English autocomplete and primary Chinese translations remain available. Imports stream through a temporary file with a 64 MiB limit and are atomically installed only after the SQLite header, `quick_check`, schema, row count, primary key, translation, category, and post-count constraints pass; failure preserves the previous file.

Both local imports and plugin downloads query only base-dictionary tags still missing from the primary overlay. They never overwrite primary translations or import out-of-dictionary tags, categories, or counts. The upstream repository currently declares no data license, so the manifest retains `license_status: user-directed` rather than claiming MIT or redistribution rights. `/prompt-weaver/tag-autocomplete/status` remains local-only and reports the active supplement origin, file SHA-256, row count, modification time, filled count, coverage, and separate errors.

## Global archives

The archive selector loads and switches complete grid states. **Archive Manager** creates, saves, renames, deletes, imports, and exports archives. A normal click selects one archive, `Ctrl` adds or removes individual selections, `Shift` selects a range from the latest anchor, and `Ctrl+Shift` adds a range. Manager selection changes only the target of the Save/Rename/Export/Delete actions; it does not load node content. An archive contains node size, column count, card order, switches, titles, colors, and prompts, but not canvas position or links. Loading from the toolbar also restores the saved node size.

The Save button next to the selector writes the current grid and node size back to the associated archive. It is enabled only while the state is dirty and does not ask for confirmation. Changes made while a save is in progress remain dirty if they were not part of the saved snapshot.

- The pinned **Default Archive** starts with two columns and four enabled empty cards. It can be updated, imported, and exported, but cannot be renamed or deleted and does not count toward the regular archive limit.
- Every node remembers its associated archive independently. Editing grid content or node size keeps that association and prefixes its name with `*`, for example `* Common`; every option reserves the same marker width. Switching archives asks before discarding changes.
- A legacy workflow without an archive association first tries an exact match using columns and the ordered switches, titles, colors, and prompts. If no match exists, it associates with `* Default Archive`. Deleting an associated archive preserves node content and falls back in the same way.
- ComfyUI stores the last globally selected archive per user, and a new node automatically loads it. Existing nodes do not change association when another node or browser tab switches archives.
- Archive names are trimmed, must contain 1–80 characters, and are unique without regard to case. Creating a duplicate name asks whether to overwrite the existing archive.
- The default archive is fixed at the top and cannot be dragged. Regular archives preserve insertion order; new or newly imported archives are appended. Drag handles persist a new order that is also used by the toolbar selector.
- One regular archive may be saved, renamed, exported, or deleted. Multiple archives may be exported or deleted together. The default archive may be part of an export selection, but any selection containing it disables deletion.
- Updating or renaming an archive keeps its list position. Import overwrite also preserves position; imported additions retain their order and are appended.
- Saving over an archive and deleting archives require confirmation.
- Nodes on the same page synchronize archive changes immediately. Other tabs use `BroadcastChannel`, and focusing the selector also refreshes the list.

Archives are stored under the current ComfyUI user's data directory at `ComfyUI-Prompt-Weaver/prompt-grid-archives.json`, so they can be shared across workflows and browser sessions while remaining isolated between ComfyUI users. Older files are upgraded with the default archive, a 600×420 default node size, and the global selection. Writes use a temporary file and atomic replacement; corrupt files return an error and are never silently replaced. The limits are 100 regular archives, 500 cards per archive, and bounded snapshot, import, and total file sizes.

One archive, the selected archives, or all archives can be exported in the same portable JSON format; batch export retains list order. Batch deletion uses one confirmation and one atomic write, and an invalid target cancels the entire operation. Import preview shows archive and card counts and supports Skip, Overwrite Local Archives, or Automatically Rename for name conflicts. The server validates the whole batch before writing anything.

Archive snapshots are not written into the execution `config`. Workflow node properties store only the associated archive ID, leaving Queue Prompt, the Python node contract, and desktop C++ parsing unchanged. ComfyUI must remain running while archive operations are used. Restart ComfyUI after upgrading because the plugin registers Python routes.

## Combination rules

The node processes enabled cards in order:

1. Trim surrounding whitespace from the prompt.
2. Remove consecutive leading and trailing ASCII commas `,`, then trim once more.
3. Skip the prompt if it is empty after cleanup.
4. Join the remaining values with an ASCII comma and space: `, `.

Internal commas, line breaks, and full-width commas remain unchanged. The result is an empty string when every card is disabled or empty.

## Configuration and API workflows

The grid stores a versioned JSON string in its single `config` widget:

```json
{
  "version": 1,
  "columns": 2,
  "items": [
    {
      "id": "prompt-1",
      "enabled": true,
      "title": "Quality",
      "prompt": "masterpiece, best quality"
    }
  ]
}
```

In an API-format prompt, `inputs.config` must be a JSON-encoded **string**, not a nested object:

```json
{
  "1": {
    "class_type": "PromptWeaverPromptToggleGrid",
    "inputs": {
      "config": "{\"version\":1,\"columns\":2,\"items\":[{\"id\":\"prompt-1\",\"enabled\":true,\"title\":\"Quality\",\"prompt\":\"masterpiece, best quality\"}]}"
    }
  }
}
```

A non-empty configuration with invalid JSON, an invalid root, invalid `version`/`items`/`enabled`/`prompt` types, or an unsupported version prevents Python execution. The frontend additionally validates card IDs, titles, and colors. A corrupt value is preserved and the node displays **Reset to Default**. An invalid column count affects layout only and is restored to two columns.

## Persistence and compatibility

- Grid state is saved with the workflow and supports reopening, copy, and paste on the normal canvas.
- The desktop parser can recover the actual enabled prompts from either an API Prompt or UI-only Workflow embedded in image metadata.
- Images already indexed with an empty parse result are not automatically rescanned. Use **Reparse this image** in the desktop application to bypass the old metadata cache.
- Version 1 supports normal canvas nodes. Promoted subgraph parameters, App Mode, archive folders/tags/search, cloud sync, timed autosave, configurable separators, prefixes/suffixes, and card weights are outside the current compatibility contract.

Validated baseline: ComfyUI 0.31.1, frontend 1.48.7, Python 3.13.11.

## Workflow-opening bridge

An open ComfyUI frontend registers through a heartbeat. When the desktop application sends `/prompt-weaver/open-workflow`, the plugin delivers the workflow to the most recently active page and calls `app.loadGraphData()`. It opens a new browser page only when no active frontend is available.

## Development and testing

Runtime dependencies are limited to Python, aiohttp, and the frontend environment bundled with ComfyUI. The regression suite runs without installing additional Python or JavaScript packages:

```powershell
python -m unittest discover -s tests -p "test_*.py" -v
node --test tests/*.mjs
```

Tests cover node configuration parsing, registration and routes, archive storage and ordering, prompt-grid interaction, the prompt editor, dual-source autocomplete, dictionary validation and fallback, language resources, locale switching, and legacy data compatibility.

## License

Released under the [MIT License](LICENSE).
