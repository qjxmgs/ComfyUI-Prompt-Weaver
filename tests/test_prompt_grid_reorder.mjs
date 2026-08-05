import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const moduleSource = await readFile(
    new URL("../web/prompt_grid_reorder.js", import.meta.url),
    "utf8",
);
const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`;
const {
    calculateFittedNodeHeight,
    clientPointToContent,
    clientRectToContent,
    computeInsertionIndex,
    edgeScrollVelocity,
    findDropTarget,
    movePromptGridItemToEdge,
    resolveImmediateInsertionSide,
} = await import(moduleUrl);

test("client coordinates are converted through ComfyUI scale and internal scroll", () => {
    const viewport = { left: 100, top: 50 };
    assert.deepEqual(
        clientPointToContent(150, 90, viewport, 0.5, 0.5, 40, 20),
        { x: 140, y: 100 },
    );
    assert.deepEqual(
        clientRectToContent(
            { left: 125, top: 75, width: 90, height: 40 },
            viewport,
            0.5,
            0.5,
            40,
            20,
        ),
        { left: 90, top: 70, right: 270, bottom: 150, width: 180, height: 80 },
    );
});

test("four-column hit testing selects the actual third-row card", () => {
    const slots = [
        { id: "prompt-3", rect: { left: 188, top: 80, right: 368, bottom: 120, width: 180, height: 40 } },
        { id: "prompt-12", rect: { left: 188, top: 128, right: 368, bottom: 168, width: 180, height: 40 } },
    ];
    assert.equal(findDropTarget(slots, { x: 200, y: 145 }, null, 8, 8)?.id, "prompt-12");
});

test("half-gap expansion removes dead zones and nearest center resolves the boundary", () => {
    const slots = [
        { id: "left", rect: { left: 0, top: 0, right: 180, bottom: 70, width: 180, height: 70 } },
        { id: "right", rect: { left: 188, top: 0, right: 368, bottom: 70, width: 180, height: 70 } },
    ];
    assert.equal(findDropTarget(slots, { x: 183, y: 35 }, null, 8, 8)?.id, "left");
    assert.equal(findDropTarget(slots, { x: 185, y: 35 }, null, 8, 8)?.id, "right");
});

test("entering a target immediately chooses the direction that occupies its slot", () => {
    assert.equal(resolveImmediateInsertionSide(0, 3), "after");
    assert.equal(resolveImmediateInsertionSide(3, 0), "before");
    assert.equal(computeInsertionIndex(0, 3, resolveImmediateInsertionSide(0, 3), 5), 3);
    assert.equal(computeInsertionIndex(3, 0, resolveImmediateInsertionSide(3, 0), 5), 0);
});

test("insertion index models insert-and-shift semantics without repeat movement", () => {
    assert.equal(computeInsertionIndex(0, 2, "before", 4), 1);
    assert.equal(computeInsertionIndex(0, 2, "after", 4), 2);
    assert.equal(computeInsertionIndex(2, 0, "after", 4), 1);
    assert.equal(computeInsertionIndex(1, 2, "before", 4), 1);
    assert.equal(computeInsertionIndex(2, 2, "after", 4), 2);
});

test("context menu ordering moves one item to either edge without mutating the input", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    assert.deepEqual(movePromptGridItemToEdge(items, "b", "start").map((item) => item.id), ["b", "a", "c"]);
    assert.deepEqual(movePromptGridItemToEdge(items, "b", "end").map((item) => item.id), ["a", "c", "b"]);
    assert.deepEqual(movePromptGridItemToEdge(items, "a", "start"), items);
    assert.deepEqual(movePromptGridItemToEdge(items, "c", "end"), items);
    assert.deepEqual(movePromptGridItemToEdge(items, "missing", "start"), items);
    assert.deepEqual(items.map((item) => item.id), ["a", "b", "c"]);
});

test("edge scrolling starts only inside the 24px edge band", () => {
    assert.equal(edgeScrollVelocity(24, 0, 200), 0);
    assert.equal(edgeScrollVelocity(176, 0, 200), 0);
    assert.equal(edgeScrollVelocity(12, 0, 200), -6);
    assert.equal(edgeScrollVelocity(188, 0, 200), 6);
    assert.equal(edgeScrollVelocity(0, 0, 200), -12);
    assert.equal(edgeScrollVelocity(200, 0, 200), 12);
    assert.equal(edgeScrollVelocity(-1, 0, 200), 0);
});

test("node height fitting removes only blank space below the grid", () => {
    assert.equal(calculateFittedNodeHeight(800, 700, 590, 1, 3, 234), 694);
    assert.equal(calculateFittedNodeHeight(420, 330, 100, 1, 3, 234), 234);
    assert.equal(calculateFittedNodeHeight(420, 300, 400, 1, 3, 234), 420);
    assert.equal(calculateFittedNodeHeight(420, 300, 295, 1, 3, 234), 420);
});
