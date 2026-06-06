# ComfyUI Prompt Weaver bridge

Copy the `ComfyUI-Prompt-Weaver` directory into ComfyUI's `custom_nodes` directory,
then restart ComfyUI. The desktop application can then send an image's embedded UI
workflow to `/prompt-weaver/open-workflow`; the bundled frontend extension opens it
with ComfyUI's `app.loadGraphData()` API.

An already-open ComfyUI frontend registers itself using a heartbeat. Workflows are
sent directly to the most recently active registered frontend without opening a new
browser tab. A browser page is opened only when no frontend instance is available.
