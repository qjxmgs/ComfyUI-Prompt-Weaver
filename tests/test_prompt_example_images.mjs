import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    createExampleThumbnail,
    effectiveExampleImageId,
    exampleThumbnailSize,
    normalizeExampleImageId,
} from "../web/prompt_example_images.js";

test("example image IDs and proportional dimensions are bounded", () => {
    assert.equal(normalizeExampleImageId("a".repeat(64)), "a".repeat(64));
    assert.equal(normalizeExampleImageId("A".repeat(64)), null);
    assert.equal(normalizeExampleImageId("../bad"), null);
    assert.deepEqual(exampleThumbnailSize(1200, 600), { width: 384, height: 192 });
    assert.deepEqual(exampleThumbnailSize(80, 40), { width: 80, height: 40 });
    assert.throws(() => exampleThumbnailSize(0, 12));
});

test("favorite image overrides the grid slot and random mode hides it", () => {
    const imageA = "a".repeat(64);
    const imageB = "b".repeat(64);
    const item = { favorite_id: "favorite-b", example_image_id: imageA };
    assert.equal(effectiveExampleImageId(item, { cards: [{ id: "favorite-b", example_image_id: imageB }] }), imageB);
    assert.equal(effectiveExampleImageId(item, { cards: [{ id: "favorite-b" }] }), null);
    assert.equal(effectiveExampleImageId({ ...item, random_favorite_category: { id: "category" } }, null), null);
    assert.equal(effectiveExampleImageId(item, { cards: [] }), imageA);
    assert.equal(effectiveExampleImageId({ example_image_id: imageA }, null), imageA);
});

test("browser only returns a bounded WebP thumbnail and closes decoded bitmap", async () => {
    const oldBitmap = globalThis.createImageBitmap;
    const oldDocument = globalThis.document;
    let closed = false;
    let dimensions;
    try {
        globalThis.createImageBitmap = async () => ({ width: 1200, height: 600, close: () => { closed = true; } });
        globalThis.document = { createElement: () => {
            const canvas = {
                width: 0,
                height: 0,
                getContext: () => ({ drawImage: () => { dimensions = [canvas.width, canvas.height]; } }),
                toBlob: (callback) => callback({ type: "image/webp", size: 20, marker: "thumbnail" }),
            };
            return canvas;
        } };
        const thumbnail = await createExampleThumbnail({ type: "image/png", size: 1024 });
        assert.equal(thumbnail.marker, "thumbnail");
        assert.deepEqual(dimensions, [384, 192]);
        assert.equal(closed, true);
    } finally {
        globalThis.createImageBitmap = oldBitmap;
        globalThis.document = oldDocument;
    }
});

test("oversized original is refused before decoding", async () => {
    await assert.rejects(createExampleThumbnail({ type: "image/png", size: 21 * 1024 * 1024 }), /20 MiB/);
});

test("grid uses user-aware requests and image-first hover without embedding originals", async () => {
    const grid = await readFile(new URL("../web/prompt_toggle_grid.js", import.meta.url), "utf8");
    const css = await readFile(new URL("../web/prompt_toggle_grid.css", import.meta.url), "utf8");
    assert.match(grid, /t\(imageId \? "Replace Example Image" : "Add Example Image"\)/);
    assert.match(grid, /t\("Remove Example Image"\)/);
    assert.match(grid, /api\.fetchApi\("\/prompt-weaver\/example-thumbnails",/);
    assert.match(grid, /api\.fetchApi\(\s*`\/prompt-weaver\/example-thumbnails\/\$\{imageId\}`/);
    assert.match(grid, /if \(!exampleImageId && !promptNeedsFullPreview\(/);
    assert.match(grid, /promptTooltip\.replaceChildren\(image\)/);
    assert.match(grid, /effectiveExampleImageId\(item, promptCardLibraryService\.library\)/);
    assert.match(grid, /client\.setCardExampleImage\(target\.favoriteId, imageId\)/);
    assert.equal((grid.match(/example_image_id: effectiveExampleImageId\(currentItem, promptCardLibraryService\.library\)/g) ?? []).length, 2);
    assert.match(grid, /const currentIndex = state\.items\.findIndex\(\(candidate\) => candidate\.id === item\.id\);\s*if \(currentIndex < 0\) return;\s*item = state\.items\[currentIndex\]/);
    assert.match(grid, /!item\.random_favorite_category \? \[imageSeparator, imageAction\] : \[\]/);
    assert.match(css, /\.cpw-prompt-grid__prompt-tooltip-image/);
    assert.doesNotMatch(grid, /img\.src\s*=\s*`\/prompt-weaver\/example-thumbnails/);
});
