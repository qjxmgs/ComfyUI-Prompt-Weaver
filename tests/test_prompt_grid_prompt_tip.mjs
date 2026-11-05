import assert from "node:assert/strict";
import test from "node:test";

import {
    promptFullPreviewPosition,
    promptNeedsFullPreview,
} from "../web/prompt_grid_prompt_tip.js";

test("only clipped nonempty card prompts need a full preview", () => {
    assert.equal(promptNeedsFullPreview("", "", 0, 100), false);
    assert.equal(promptNeedsFullPreview("   ", "   ", 10, 100), false);
    assert.equal(promptNeedsFullPreview("blue eyes", "blue eyes", 65, 100), false);
    assert.equal(promptNeedsFullPreview("blue eyes, smile", "blue eyes, smile", 130, 100), true);
    assert.equal(promptNeedsFullPreview("{color}\nshirt", "{color}shirt", 70, 100), true);
    assert.equal(promptNeedsFullPreview("{color} shirt", "{color} shirt", 90, 100), false);
});

test("preview prefers below and stays within horizontal viewport bounds", () => {
    assert.deepEqual(promptFullPreviewPosition({
        anchor: { left: 310, top: 50, bottom: 78 },
        tooltipWidth: 420,
        tooltipHeight: 100,
        viewportWidth: 500,
        viewportHeight: 400,
    }), { left: 72, top: 84, maxHeight: 308, openAbove: false });
});

test("preview opens above near the bottom and bounds long content", () => {
    assert.deepEqual(promptFullPreviewPosition({
        anchor: { left: -10, top: 310, bottom: 338 },
        tooltipWidth: 420,
        tooltipHeight: 600,
        viewportWidth: 500,
        viewportHeight: 400,
    }), { left: 8, top: 8, maxHeight: 296, openAbove: true });
    assert.equal(promptFullPreviewPosition({
        anchor: { left: 0, top: 3, bottom: 27 },
        tooltipWidth: 200,
        tooltipHeight: 80,
        viewportWidth: 200,
        viewportHeight: 45,
    }), null);
});
