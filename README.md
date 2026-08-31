# ComfyUI Prompt Weaver

> 🌐 **Documentation / 文档:** **English** · [**简体中文 README →**](./README.zh-CN.md)

ComfyUI Prompt Weaver provides two features:

- A workflow-opening bridge between the Prompt Weaver desktop application and ComfyUI.
- A **Prompt Card Grid** node for quickly enabling, disabling, arranging, and combining prompt cards.

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

- `nodes.py`, `archive_store.py`, `prompt_card_library.py`, `tag_autocomplete.py`, `data/tag_sources.json`, and `__init__.py`
- `locales/en` and `locales/zh`
- `web/prompt_toggle_grid.js` and `web/prompt_toggle_grid.css`
- `web/prompt_weaver_i18n.js`
- `web/prompt_grid_archives.js`, `web/prompt_grid_reorder.js`, and `web/prompt_card_library.js`
- `web/prompt_editor_tokens.js`, `web/prompt_editor_window.js`, `web/prompt_assistant_tags.js`, and `web/prompt_tag_autocomplete.js`

## Language support

The node automatically follows **Settings → Language** (`Comfy.Locale`) in ComfyUI. English and Simplified Chinese are included; every other locale falls back to English. Changing the ComfyUI language updates existing Prompt Weaver nodes without changing their serialized configuration, current selection, unsaved prompt-editor draft, or focus.

Only plugin-provided interface text is translated. Prompt text, Prompt Assistant tags, user-created archive names, card titles, and existing workflow data are never translated or rewritten. A newly created node uses the localized default card titles `Card 01` through `Card 04`. Headless/API usage uses the same canonical English defaults.

The built-in default archive is identified by its stable ID and is displayed as **Default Archive** or **默认存档**. Its historical stored name remains unchanged for compatibility. An untouched empty default snapshot can display localized generated titles without becoming dirty; after it is edited or saved, its titles are treated as user data.

## Prompt Card Grid

Add **Prompt Card Grid** from the `Prompt Weaver/Prompt` node category. The node outputs a standard `STRING`, which can connect directly to `CLIPTextEncode.text` or any other string input.

The optional `prefix_prompt` string input can receive trigger words or any other prompt text. When connected, its value is placed before the enabled grid cards with an automatic `, ` separator. The combined result is deduplicated case-insensitively at top-level English/Chinese commas and line breaks, preserving the first spelling and keeping separators inside brackets, quotes, and escaped content intact. Leaving the input disconnected or empty preserves the existing grid-only output.

Each card contains:

- An enable switch.
- An editable title used only for identification; it is not included in the output.
- A fixed single-line prompt field and a tag-editor button.
- Drag-to-reorder with live displacement animation, plus a delete button. Press `Esc` while dragging to restore the original order.
- An optional card color selected from the card context menu. Right-clicking a text field keeps the browser's native menu.

The toolbar can add cards, enable or disable every card, and select a fixed layout of 1–6 columns. A new node starts with two columns and four enabled empty cards. Array/visual order is the final combination order; changing the column count never changes that order.

The editor button next to a prompt splits its text at top-level English or Chinese commas and line breaks. Separators inside parentheses, square or curly brackets, quotes, and escaped content are preserved. The editor deduplicates tags case-insensitively while retaining the first spelling and original order. Its `+` composer accepts multiple prompts using the same splitting rules and commits on Enter, blur, or Confirm. Existing inactive duplicates are re-enabled instead of added again. Clicking or painting across tags toggles their selection. **Retain Unselected** is enabled by default per card: inactive tags remain in the group after Confirm without entering node output. Their red `×` floats over the upper-right corner without changing the tag width and removes the tag from the current draft; removal is saved only after Confirm. Text Mode keeps the raw active prompt in its textarea and shows retained inactive tags in a dim strip below it. Turning retention off discards inactive tags only when Confirm is pressed; closing, clicking the red title-bar close button, backdrop dismissal, or `Esc` cancels every draft change. Confirm writes only selected tags back with `, ` separators. The footer Copy button copies only the active current draft without closing or saving the editor.

The editor title bar shows the active-tag count and keeps **Text Mode** and **Retain Unselected** on the left. Hovering either option describes the action represented by its current checked state. With no highlighted autocomplete result, Tab switches between Text Mode and tag mode; a highlighted result still consumes Tab first, while Shift+Tab remains available for focus navigation. Undo and redo icon buttons sit after these switches. They keep up to 100 prompt-content steps for the current editor session only and are cleared on Confirm, Cancel, or close. Tag changes, additions, removals, autocomplete insertions, bulk changes, and committed text edits participate; mode, retention, font-size, and geometry changes do not. Continuous typing becomes one step when the field loses focus or is committed. Use Ctrl/Cmd+Z to undo, Ctrl/Cmd+Shift+Z to redo, or Ctrl+Y on Windows/Linux; while a text field is still actively editing, its native browser history remains in control. The right side contains a visible **Font Size** label, a 12–30 px slider, the live pixel value, and a red close button matching the autocomplete popup. Font size is remembered locally. The dialog has a 600 px minimum width, can be moved by dragging the non-interactive title-bar area, and can be resized from its corner; its saved geometry is clamped back into the current viewport when reopened.

The card prompt field, the `+` composer, and Text Mode share dual-source autocomplete. **Danbooru** suggestions come from a Prompt-Weaver-managed local CSV dictionary; **Prompt Assistant** suggestions come from every CSV exposed by an installed [ComfyUI-Prompt-Assistant](https://github.com/yawiii/comfyui_prompt_assistant). Both sources are enabled by default and appear in one rounded source group in ComfyUI settings. Use the drag handle to reorder their priority or toggle either source independently; the top source wins equal-quality matches. Exact, prefix, substring, and ordered character-skip matches are ranked in that order before source priority is applied. Character-skip matching ignores spaces, underscores, and hyphens, then favors an earlier first hit, fewer skipped characters, and a shorter candidate. Danbooru ties use post count. Final insertion text is deduplicated across sources.

Matching starts after one Chinese character or two Latin characters. Character-skip matching starts after two Chinese characters or three Latin characters. The maximum suggestion count is configurable in ComfyUI settings from 1 to 100 and defaults to 30. Both data sources use the same four-column layout: English prompt with Chinese description underneath, category, source, and usage count. Matching text is highlighted in red in both the English tag and Chinese description, including the individual characters selected by character-skip matching. Missing Chinese descriptions display `—`, while Prompt Assistant keeps the count column empty because it has no reliable usage statistics. Selecting a Danbooru tag inserts its canonical English tag with underscores converted to spaces. The popup opens above or below according to available space and has a distinct title bar plus an animated accent border. Drag the outer edge away from the input to resize its height; all three input surfaces share the saved 120–720 px preference, and double-clicking the grip restores the 320 px default. Arrow keys move the highlight, Enter or Tab selects only a highlighted result, and `Esc` closes it. IME composition is not intercepted. In the card and Text Mode fields only the fragment surrounding the caret is replaced, preserving separators, wrappers, quotes, escapes, and weight suffixes.

The Danbooru dictionary is not bundled. The first eligible query displays an explicit download action, and typing is never sent to Danbooru or another remote search API. Data is stored per ComfyUI user under `ComfyUI-Prompt-Weaver/tag-autocomplete/`. The plugin never checks for updates automatically. Open **Settings → Prompt Weaver → Prompt translations → Manage prompt translations…** or **Prompt Weaver → Manage prompt translations…** to inspect local tag counts, Chinese coverage, all three source layers, and timestamps. Opening the panel and reading status only access local files; remote sources are contacted only after **Check and update** is clicked. Downloads are pinned by HTTPS URL and SHA-256, validated before atomic replacement, and a failed update keeps the last good files. Simplified Chinese uses a separate display/search translation overlay and always inserts the canonical English tag. The full dictionary can include adult tags; automatic safety filtering is not claimed. The base dataset is [newtextdoc1111/danbooru-tag-csv](https://huggingface.co/datasets/newtextdoc1111/danbooru-tag-csv) (MIT), and the primary Simplified Chinese overlay is from [Aaalice233/ComfyUI-Danbooru-Gallery](https://github.com/Aaalice233/ComfyUI-Danbooru-Gallery) (MIT).

The backend also supports a third SQLite missing-translation supplement. Download `tag.sqlite` from the fixed upstream [`ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table`](https://github.com/ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table/blob/main/tag.sqlite), then install it in either of these ways:

- Place it at `ComfyUI-Prompt-Weaver/tag-autocomplete/tag.sqlite` inside the current ComfyUI user data directory. For the default user this is normally `<ComfyUI>/user/default/ComfyUI-Prompt-Weaver/tag-autocomplete/tag.sqlite`. Opening the translation manager or running the first lookup discovers it automatically; a size or modification-time change triggers revalidation.
- Click **Choose local tag.sqlite…** in **Manage prompt translations…**. The browser streams and copies the selected file into that server-side user directory, so this also works when the browser and ComfyUI server are on different computers. The panel can copy the drop-in path or force a local rescan.

A validated user-supplied file takes priority over the plugin-downloaded supplement. While it is active, **Check and update** still refreshes the English base and primary Chinese layers but skips the GitHub `tag.sqlite` metadata request and download; remote updates never replace or delete the user file. An invalid drop-in file produces a separate warning and falls back to the last valid downloaded supplement. If no fallback exists, English autocomplete and primary Chinese translations remain available. Imports stream through a temporary file with a 64 MiB limit and are atomically installed only after the SQLite header, `quick_check`, schema, row count, primary key, translation, category, and post-count constraints pass; failure preserves the previous file.

Both local imports and plugin downloads query only base-dictionary tags still missing from the primary overlay. They never overwrite primary translations or import out-of-dictionary tags, categories, or counts. The upstream repository currently declares no data license, so the manifest retains `license_status: user-directed` rather than claiming MIT or redistribution rights. `/prompt-weaver/tag-autocomplete/status` remains local-only and reports the active supplement origin, file SHA-256, row count, modification time, filled count, coverage, and separate errors.

## Favorite Cards

Favorite cards form a user-level library shared by every Prompt Card Grid node, workflow, archive, and browser tab for the same ComfyUI user. Every favorite belongs to a secondary category under exactly one primary category. Both category levels can be created and renamed at runtime. Empty categories can be deleted directly; deleting a branch that contains favorites first requires choosing another secondary category, and the backend migrates those cards and removes the branch in one atomic operation. Sibling category names are case-insensitively unique.

Each grid card embeds a dropdown arrow at the right edge of its title field. It opens a read-only Primary Category → Secondary Category → Favorite Card cascade: pointing at a category opens its submenu, and choosing a favorite completely switches the current grid card to that saved snapshot. The open primary and secondary branch stays highlighted, and each favorite title shows its active output-prompt count. Hovering or keyboard-focusing a favorite shows a subdued, translucent, wrapping two-part prompt tooltip: normalized English output first, followed by Chinese translations resolved through the enabled autocomplete sources and their configured priority. The Chinese line uses full-width Chinese commas between top-level tokens, while missing translations retain the corresponding English token. Moving away from the favorite keeps the current three-level branch open but hides the tooltip once that card is neither hovered nor focused; hovering another favorite shows its tooltip, and an outside click or `Esc` closes the cascade. A red `×` on the right arms deletion as `!`; clicking it again deletes the global favorite, while three seconds, another interaction, or `Esc` cancels confirmation. The title, prompt, color, retained-token policy, token states, and `favorite_id` are replaced together, while the grid card ID, enabled switch, and position stay unchanged. Selecting the same favorite reloads its latest saved snapshot. After every selection, a one-shot shine sweeps across the visible title and prompt text areas; reduced-motion environments use a brief static highlight instead. The cascade automatically flips and clamps to the viewport and supports arrow keys, Home, End, Enter/Space, `Esc`, and outside-click dismissal.

The editor footer **Favorites** action opens a three-column Primary Category → Secondary Category → My Favorites manager for the card currently being edited. Hovering or clicking a secondary category immediately browses its favorites. The `+` in the My Favorites header saves the current draft as a new independent favorite in that category, including when the draft is already linked to another favorite. Each favorite shows its active output-prompt count and the same bilingual tooltip and two-click red deletion control as the grid cascade. The favorite content area is display-only; only its rounded **Overwrite** button asks for confirmation before replacing that saved snapshot with the current editor draft and linking the draft to it. Favorites can be dragged vertically to an insertion line to reorder them within the current secondary category. While dragging, hovering another secondary category previews its favorites in the third column, where the card can be inserted at an exact position; dropping directly on the category row still appends it. The context menu also provides Rename, Top, Up, Down, Bottom, and Move to Category commands for keyboard, touch, and narrow layouts. Rename replaces the whole favorite row with a title input plus Cancel and Confirm actions without changing the saved Prompt snapshot. Empty prompts cannot be created or used to overwrite a favorite, and request failures remain in the manager without blocking editing, copying, or confirmation.

The Favorite Cards manager can be moved by dragging its title bar and resized in both directions from the lower-right handle. Its size and position are remembered in the current browser and clamped to the visible viewport when reopened. Rendering, category changes, library mutations, and list scrolling no longer recenter the window. The three columns scroll independently with compact themed scrollbars; shrinking the manager below the three-column threshold switches to the existing drill-down view and expanding it restores all columns.

Favorite-library create, move, update, and remove operations take effect immediately. The current grid card content and favorite association are committed only by **Confirm**; cancelling the editor leaves the card configuration unchanged without rolling back global library operations. Favorites remain independent snapshots, so later card edits never overwrite them implicitly.

The library is stored at `ComfyUI-Prompt-Weaver/prompt-card-library.json` in the current ComfyUI user's data directory. It uses the archive service's locked, validated, temporary-file plus atomic-replacement strategy; a corrupt or failed read never overwrites the original file. Limits are 100 primary categories, 500 secondary categories, 2,000 favorite cards, and a 20 MiB library file. Version 1 keeps categories in creation order while favorite order is persisted per secondary category; search, import, and export are not provided.

## Global archives

The archive selector loads and switches complete grid states. The adjacent Save, Restore, and Archive Manager actions use compact icon buttons; hovering or focusing an icon immediately shows its localized name below it. **Archive Manager** creates, saves, renames, deletes, imports, and exports archives. A normal click selects one archive, `Ctrl` adds or removes individual selections, `Shift` selects a range from the latest anchor, and `Ctrl+Shift` adds a range. Manager selection changes only the target of the Save/Rename/Export/Delete actions; it does not load node content. An archive contains node size, column count, card order, switches, titles, colors, active prompts, per-card retained-token state, and optional favorite associations, but not canvas position or links. Loading from the toolbar also restores the saved node size.

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

A non-empty configuration with invalid JSON, an invalid root, invalid `version`/`items`/`enabled`/`prompt`/`retain_unselected`/`prompt_tokens` types, or an unsupported version prevents Python execution. The frontend additionally validates card IDs, titles, colors, optional `favorite_id` UUIDs, and retained-token entries. A corrupt value is preserved and the node displays **Reset to Default**. An invalid column count affects layout only and is restored to two columns.

## Persistence and compatibility

- Grid state is saved with the workflow and supports reopening, copy, and paste on the normal canvas.
- `prompt` always contains only the active text used for node output. Optional `retain_unselected` and `prompt_tokens` fields preserve editor state in workflows and archives; inactive tokens are validated but never appended to Python output.
- Optional `favorite_id` links a workflow card to a user-library snapshot. It participates in workflow/archive persistence and dirty-state fingerprints but is ignored by Python execution; a missing library record never changes the saved prompt.
- The desktop parser can recover the actual enabled prompts from either an API Prompt or UI-only Workflow embedded in image metadata.
- Images already indexed with an empty parse result are not automatically rescanned. Use **Reparse this image** in the desktop application to bypass the old metadata cache.
- Version 1 supports normal canvas nodes. Promoted subgraph parameters, App Mode, archive folders/tags/search, cloud sync, timed autosave, configurable separators, prefixes/suffixes, and card weights are outside the current compatibility contract.

Validated baseline: ComfyUI 0.31.1, frontend 1.48.7, Python 3.13.11.

## Workflow-opening bridge

An open ComfyUI frontend registers through a heartbeat. When the desktop application sends `/prompt-weaver/open-workflow`, the plugin delivers the graph to the most recently active page. UI workflows use `app.loadGraphData()`, while prompt-only API graphs use ComfyUI's native `app.loadApiJson()`. It opens a new browser page only when no active frontend is available.

## Development and testing

Runtime dependencies are limited to Python, aiohttp, and the frontend environment bundled with ComfyUI. The regression suite runs without installing additional Python or JavaScript packages:

```powershell
python -m unittest discover -s tests -p "test_*.py" -v
node --test tests/*.mjs
```

Tests cover node configuration parsing, registration and routes, archive storage and ordering, the two-level prompt-card library, prompt-grid interaction, favorite insertion and deduplication, the prompt editor, dual-source autocomplete, dictionary validation and fallback, language resources, locale switching, and legacy data compatibility.

## License

Released under the [MIT License](LICENSE).
