// Card identity, rather than visual index, is the wire contract.
export const CARD_INPUT_PREFIX = "card_prompt_";
export const cardInputName = (id) => CARD_INPUT_PREFIX + id;
export const isCardInput = (slot) => slot?.name?.startsWith(CARD_INPUT_PREFIX);
const widgetHosts = new WeakMap();

// `widget` is a layout hint here, not a converted input backed by a widget.
// ComfyUI's widget-input migration removes inputs whose widget is missing.
// Expose native STRING slots while that migration runs, and never persist the
// transient hint in Workflow JSON. Do not recreate links after removal.
export function protectCardInputRestoration(node) {
    const previousConfigured = node.onGraphConfigured;
    const configured = function (...args) {
        const hints = new Map();
        for (const slot of this.inputs ?? []) {
            if (isCardInput(slot) && slot.widget) {
                hints.set(slot, slot.widget);
                delete slot.widget;
            }
        }
        try {
            return previousConfigured?.apply(this, args);
        } finally {
            for (const [slot, hint] of hints) {
                if (this.inputs?.includes(slot)) slot.widget = hint;
            }
        }
    };
    const previousSerialize = node.onSerialize;
    const serialize = function (data, ...args) {
        previousSerialize?.call(this, data, ...args);
        if (Array.isArray(data.inputs)) data.inputs = data.inputs.map((slot) => {
            if (!isCardInput(slot)) return slot;
            const { widget, ...nativeSlot } = slot;
            // Dynamic DOM coordinates are recalculated after mounting.
            return { ...nativeSlot, pos: [0, 0] };
        });
    };
    node.onGraphConfigured = configured;
    node.onSerialize = serialize;
    return () => {
        if (node.onGraphConfigured === configured) node.onGraphConfigured = previousConfigured;
        if (node.onSerialize === serialize) node.onSerialize = previousSerialize;
    };
}

// Nodes 2.0 can reuse its WidgetDOM host during graph undo without remounting
// the replacement custom widget. Remember only our own existing DOM host;
// never access or patch Vue's private stores/components.
export function rememberCardWidgetHost(node, root) {
    if (!node.graph || !root.parentElement?.closest("[data-node-id]")) return;
    let hosts = widgetHosts.get(node.graph);
    if (!hosts) widgetHosts.set(node.graph, hosts = new Map());
    for (const [id, reference] of hosts) {
        if (!reference.deref()?.isConnected) hosts.delete(id);
    }
    hosts.set(String(node.id), new WeakRef(root.parentElement));
}

export function connectedCardIds(node) {
    return new Set((node.inputs ?? []).filter((slot) => isCardInput(slot) && slot.link != null)
        .map((slot) => slot.name.slice(CARD_INPUT_PREFIX.length)));
}

export function removedConnectedCards(node, items) {
    const kept = new Set(items.map((item) => item.id));
    return [...connectedCardIds(node)].filter((id) => !kept.has(id));
}

export function reconcileCardInputs(node, items) {
    if (typeof node.addInput !== "function" || !Array.isArray(items)) return;
    // These ports belong to the DOM cards, not extra native input rows.
    // addInput/removeInput may auto-size the node using its current DOM height;
    // repeating that during workflow restoration must not accumulate chrome.
    const size = node.size ? [node.size[0], node.size[1]] : null;
    const wanted = new Set(items.map((item) => cardInputName(item.id)));
    // removeInput repairs the remaining link target indices. Do not sort slots:
    // visual card order and stable connection order are deliberately independent.
    for (let index = (node.inputs?.length ?? 0) - 1; index >= 0; index--) {
        if (isCardInput(node.inputs[index]) && !wanted.has(node.inputs[index].name)) node.removeInput(index);
    }
    for (const item of items) {
        const name = cardInputName(item.id);
        let slot = node.inputs?.find((input) => input.name === name);
        if (!slot) slot = node.addInput(name, "STRING", {
            pos: [0, 0], widget: { name: `cpw_port_${item.id}` }, label: " ",
        });
        if (slot) {
            slot.pos ??= [0, 0];
            // Mark as a custom-widget slot so the host does not reserve a
            // second vertical input row above the DOM grid. The DOM port owns
            // rendering; graph inputs/links remain native and serializable.
            slot.widget = { name: `cpw_port_${item.id}` };
            slot.label = " ";
            if (typeof slot.draw === "function") slot.draw = () => {};
        }
    }
    if (size && (node.size[0] !== size[0] || node.size[1] !== size[1])) {
        node.setSize(size);
    }
}

export function attachCardInputs({ node, app, root, scroll, getItems, onChange, t }) {
    const restoreLifecycle = protectCardInputRestoration(node);
    let disposed = false;
    let frame;
    let pending = false;
    let signature = "";
    const wires = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    wires.classList.add("cpw-prompt-grid__input-wires");
    wires.setAttribute("aria-hidden", "true");
    root.append(wires);
    const paths = new Map();
    const oldInputPos = node.getInputPos;
    const inputPos = function (index) {
        const slot = this.inputs?.[index];
        if (!this.flags?.collapsed && isCardInput(slot) && slot.pos) {
            return [this.pos[0] + slot.pos[0], this.pos[1] + slot.pos[1]];
        }
        return oldInputPos?.call(this, index);
    };
    node.getInputPos = inputPos;
    const schedule = () => {
        if (disposed || pending) return;
        pending = true;
        queueMicrotask(() => {
            pending = false;
            if (disposed) return;
            reconcileCardInputs(node, getItems());
            const next = JSON.stringify([...connectedCardIds(node)].sort());
            if (next !== signature) {
                signature = next;
                onChange();
            }
        });
    };
    const oldConnections = node.onConnectionsChange;
    const connections = function (...args) { oldConnections?.apply(this, args); schedule(); };
    node.onConnectionsChange = connections;
    const oldConfigure = node.onConfigure;
    const configure = function (...args) { oldConfigure?.apply(this, args); schedule(); };
    node.onConfigure = configure;

    const updatePositions = () => {
        if (disposed) return;
        if (!root.isConnected && node.graph?.getNodeById?.(node.id)?.widgets?.some((widget) => widget.element === root)) {
            const hosts = widgetHosts.get(node.graph);
            const host = hosts?.get(String(node.id))?.deref();
            const existing = host?.querySelector(".cpw-prompt-grid");
            if (host?.isConnected && host.closest("[data-node-id]")?.dataset.nodeId === String(node.id)
                && (!existing || existing.dataset.cpwDisposed === "true")) {
                host.replaceChildren(root);
                hosts.delete(String(node.id));
            }
        }
        if (root.isConnected && root.getClientRects().length && !node.flags?.collapsed) {
            const canvas = app.canvas;
            const scale = canvas?.ds?.scale || 1;
            const canvasRect = canvas?.canvas?.getBoundingClientRect();
            const offset = canvas?.ds?.offset ?? [0, 0];
            const clip = scroll.getBoundingClientRect();
            const rootRect = root.getBoundingClientRect();
            const domScale = rootRect.width / root.clientWidth || scale;
            const activePaths = new Set();
            if (canvasRect) {
                for (const port of root.querySelectorAll(".cpw-prompt-grid__input-port")) {
                    const index = node.inputs?.findIndex((slot) => slot.name === cardInputName(port.dataset.cardId));
                    if (index == null || index < 0) continue;
                    const slot = node.inputs[index];
                    const rect = port.getBoundingClientRect();
                    const centerY = rect.top + rect.height / 2;
                    // Clip wire anchors to the scroll boundary rather than expose
                    // invisible interactive ports over neighbouring cards.
                    const y = Math.min(clip.bottom, Math.max(clip.top, centerY));
                    const nextPos = [
                        (rect.left + rect.width / 2 - canvasRect.left) / scale - offset[0] - node.pos[0],
                        (y - canvasRect.top) / scale - offset[1] - node.pos[1],
                    ];
                    if (!slot.pos || Math.abs(slot.pos[0] - nextPos[0]) > .1 || Math.abs(slot.pos[1] - nextPos[1]) > .1) {
                        slot.pos = nextPos;
                        canvas.setDirty?.(true, true);
                    }
                    if (slot.boundingRect) {
                        slot.boundingRect[0] = node.pos[0] + slot.pos[0] - 8;
                        slot.boundingRect[1] = node.pos[1] + slot.pos[1] - 8;
                        slot.boundingRect[2] = 16;
                        slot.boundingRect[3] = 16;
                    }
                    port.firstElementChild.dataset.slotKey = `${node.id}-in-${index}`;
                    port.classList.toggle("is-connected", slot.link != null);
                    // The node's DOM surface occludes native canvas wires.
                    // Continue the connection inside it, through the card's
                    // header/body gap, to make multi-column targets unambiguous.
                    if (slot.link != null && centerY >= clip.top && centerY <= clip.bottom) {
                        const id = port.dataset.cardId;
                        activePaths.add(id);
                        let path = paths.get(id);
                        if (!path) {
                            path = document.createElementNS(wires.namespaceURI, "path");
                            wires.append(path);
                            paths.set(id, path);
                        }
                        const x = (rect.left + rect.width / 2 - rootRect.left) / domScale;
                        const localY = (centerY - rootRect.top) / domScale;
                        const d = `M 0 ${localY} H ${Math.max(0, x - 5)}`;
                        if (path.getAttribute("d") !== d) path.setAttribute("d", d);
                    }
                }
                for (const [id, path] of paths) {
                    if (!activePaths.has(id)) { path.remove(); paths.delete(id); }
                }
            }
        }
        frame = requestAnimationFrame(updatePositions);
    };

    // DOM widgets cover the canvas. Complete the real graph connection at the
    // exact DOM port, including when the source canvas has pointer capture.
    const drop = (event) => {
        const port = document.elementFromPoint(event.clientX, event.clientY)?.closest(".cpw-prompt-grid__input-port");
        if (!port || !root.contains(port)) return;
        const index = node.inputs?.findIndex((slot) => slot.name === cardInputName(port.dataset.cardId));
        if (index == null || index < 0) return;
        const connector = app.canvas?.linkConnector;
        if (!connector?.isConnecting || connector.state?.connectingTo !== "input") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const graph = node.graph;
        graph?.beforeChange?.();
        try {
            for (const link of connector.renderLinks ?? []) {
                if (link.canConnectToInput?.(node, node.inputs[index])) {
                    link.connectToInput(node, node.inputs[index], connector.events);
                }
            }
        } finally {
            connector.reset();
            graph?.afterChange?.();
            app.canvas?.setDirty?.(true, true);
            schedule();
        }
    };
    window.addEventListener("pointerup", drop, true);
    frame = requestAnimationFrame(updatePositions);
    return {
        sync: () => { reconcileCardInputs(node, getItems()); schedule(); },
        makePort(item) {
            const port = document.createElement("button");
            port.type = "button";
            port.className = "cpw-prompt-grid__input-port lg-slot";
            port.dataset.cardId = item.id;
            port.title = t("External STRING input. Right-click to disconnect.");
            port.setAttribute("aria-label", t("External prompt for {name}", { name: item.title }));
            port.append(document.createElement("span"));
            port.addEventListener("pointerdown", (event) => event.stopPropagation());
            const disconnect = (event) => {
                event.preventDefault();
                event.stopPropagation();
                const index = node.inputs?.findIndex((slot) => slot.name === cardInputName(item.id));
                if (index >= 0 && node.inputs[index].link != null) {
                    node.graph?.beforeChange?.();
                    node.disconnectInput(index);
                    node.graph?.afterChange?.();
                }
            };
            port.addEventListener("contextmenu", disconnect);
            port.addEventListener("keydown", (event) => {
                if (event.key === "Delete" || event.key === "Backspace") disconnect(event);
            });
            return port;
        },
        dispose() {
            restoreLifecycle();
            disposed = true;
            cancelAnimationFrame(frame);
            window.removeEventListener("pointerup", drop, true);
            wires.remove();
            if (node.onConnectionsChange === connections) node.onConnectionsChange = oldConnections;
            if (node.onConfigure === configure) node.onConfigure = oldConfigure;
            if (node.getInputPos === inputPos) node.getInputPos = oldInputPos;
        },
    };
}
