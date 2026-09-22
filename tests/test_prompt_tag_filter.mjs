import assert from "node:assert/strict";
import test from "node:test";
import { DanbooruFilterState, parseMinPostCount } from "../web/prompt_tag_filter.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
};

test("threshold requires a safe integer, defaults to 100 and includes 10", () => {
    for (const value of ["", null, undefined, true, 9, -10, 10.5, "1e2", 2 ** 53]) {
        assert.equal(parseMinPostCount(value), null);
    }
    assert.equal(parseMinPostCount("10"), 10);
    const state = new DanbooruFilterState({ save() {}, status() {} });
    assert.equal(state.value, 100);
    assert.equal(state.delay, 300);
});

test("debounce saves only the latest legal input and reports actual count", async () => {
    const saved = [];
    const state = new DanbooruFilterState({
        delay: 1, save: async (value) => saved.push(value),
        status: async (value) => ({ active_count: value, total_count: 1000 }),
    });
    state.input("10");
    state.input("100");
    state.input("500");
    assert.equal(state.pending, true);
    await tick();
    assert.deepEqual(saved, [500]);
    assert.equal(state.status.active_count, 500);
    state.input("9");
    await tick();
    assert.equal(state.invalid, true);
    assert.equal(state.value, 500);
    assert.deepEqual(saved, [500]);
    state.dispose();
});

test("late statistics never overwrite newer input", async () => {
    const first = deferred();
    const state = new DanbooruFilterState({
        delay: 1, save: async () => {},
        status: (value) => value === 100 ? first.promise : Promise.resolve({ active_count: 10 }),
    });
    const loading = state.refresh(100);
    state.input("10");
    await tick();
    first.resolve({ active_count: 100 });
    await loading;
    assert.equal(state.status.active_count, 10);
    assert.equal(state.value, 10);
    state.dispose();
});

test("writes serialize and a pending newer value wins over a slow save", async () => {
    const first = deferred();
    const saved = [];
    const state = new DanbooruFilterState({
        delay: 1, save: async (value) => {
            saved.push(value);
            if (value === 500) await first.promise;
        },
        status: async (value) => ({ active_count: value }),
    });
    state.input(500);
    await tick();
    state.input(1000);
    await tick();
    assert.deepEqual(saved, [500]);
    first.resolve();
    await tick();
    assert.deepEqual(saved, [500, 1000]);
    assert.equal(state.value, 1000);
    assert.equal(state.status.active_count, 1000);
    state.dispose();
});

test("failed save leaves effective threshold unchanged and allows retry", async () => {
    let fail = true;
    const state = new DanbooruFilterState({
        delay: 1, save: async () => { if (fail) throw new Error("offline"); },
        status: async () => ({ active_count: 0 }),
    });
    state.input(10);
    await tick();
    assert.equal(state.value, 100);
    assert.equal(state.error, "offline");
    fail = false;
    state.input(10);
    await tick();
    assert.equal(state.value, 10);
    assert.equal(state.status.active_count, 0);
    state.dispose();
});
