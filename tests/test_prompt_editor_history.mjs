import assert from "node:assert/strict";
import test from "node:test";

import {
    PROMPT_EDITOR_HISTORY_LIMIT,
    PromptEditorHistory,
} from "../web/prompt_editor_history.js";

function snapshot(text, selected = [true]) {
    return {
        tokens: [text],
        selected,
        activePrompt: text,
        promptRequiresRebuild: false,
    };
}

test("prompt editor history starts empty and ignores no-op records", () => {
    const history = new PromptEditorHistory();
    assert.equal(history.canUndo, false);
    assert.equal(history.canRedo, false);
    assert.equal(history.record(snapshot("one"), snapshot("one")), false);
    assert.equal(history.undoCount, 0);
});

test("prompt editor history undoes, redoes, and invalidates redo after a new edit", () => {
    const history = new PromptEditorHistory();
    const one = snapshot("one");
    const two = snapshot("two");
    const three = snapshot("three");
    history.record(one, two);
    history.record(two, three);
    assert.deepEqual(history.undo(three), two);
    assert.deepEqual(history.undo(two), one);
    assert.deepEqual(history.redo(one), two);
    history.record(two, snapshot("replacement"));
    assert.equal(history.canRedo, false);
});

test("prompt editor history clones snapshots and removes duplicate consecutive entries", () => {
    const history = new PromptEditorHistory();
    const one = snapshot("one");
    const two = snapshot("two");
    history.record(one, two);
    one.tokens[0] = "mutated";
    history.record(snapshot("one"), snapshot("three"));
    assert.equal(history.undoCount, 1);
    assert.deepEqual(history.undo(snapshot("three")), snapshot("one"));
});

test("prompt editor history enforces its limit and clear releases both stacks", () => {
    const history = new PromptEditorHistory(3);
    for (let index = 0; index < 5; index += 1) {
        history.record(snapshot(String(index)), snapshot(String(index + 1)));
    }
    assert.equal(history.undoCount, 3);
    assert.deepEqual(history.undo(snapshot("5")), snapshot("4"));
    assert.deepEqual(history.undo(snapshot("4")), snapshot("3"));
    assert.deepEqual(history.undo(snapshot("3")), snapshot("2"));
    assert.equal(history.undo(snapshot("2")), null);
    history.clear();
    assert.equal(history.canUndo, false);
    assert.equal(history.canRedo, false);
    assert.equal(PROMPT_EDITOR_HISTORY_LIMIT, 100);
});

test("separate prompt editor history instances do not share state", () => {
    const first = new PromptEditorHistory();
    const second = new PromptEditorHistory();
    first.record(snapshot("one"), snapshot("two"));
    assert.equal(first.canUndo, true);
    assert.equal(second.canUndo, false);
});
