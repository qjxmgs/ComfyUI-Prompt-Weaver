import assert from "node:assert/strict";
import test from "node:test";
import { cardInputName, connectedCardIds, removedConnectedCards, reconcileCardInputs, protectCardInputRestoration } from "../web/prompt_card_inputs.js";

function nodeFixture() {
    return {
        inputs: [{ name: "prefix_prompt", type: "STRING", link: 3 }],
        addInput(name, type, options) { const slot = { name, type, link: null, ...options }; this.inputs.push(slot); return slot; },
        removeInput(index) { this.inputs.splice(index, 1); },
    };
}

test("widget-input migration cannot remove card wires across repeated workflow loads", () => {
    let slots = [{name: 'prefix_prompt', type: 'STRING', link: 3},
        {name: 'card_prompt_a', type: 'STRING', link: 944, widget: {name: 'cpw_port_a'}}];
    for (let reload = 0; reload < 10; reload++) {
        const node = nodeFixture();
        node.inputs = structuredClone(slots);
        const migrate = function () {
            for (const input of [...this.inputs]) if (input.widget) this.removeInput(this.inputs.indexOf(input));
        };
        node.onGraphConfigured = migrate;
        const dispose = protectCardInputRestoration(node);
        reconcileCardInputs(node, [{id: 'a'}]);
        node.onGraphConfigured();
        assert.equal(node.inputs[1].link, 944);
        assert.equal(node.inputs[0].link, 3);
        assert.ok(node.inputs[1].widget, 'runtime layout hint restored');
        const data = {inputs: structuredClone(node.inputs)};
        node.onSerialize(data);
        assert.equal(data.inputs[1].widget, undefined);
        assert.equal(data.inputs[1].link, 944);
        assert.ok(node.inputs[1].widget, 'serialization does not mutate live ports');
        slots = data.inputs;
        dispose();
        assert.equal(node.onGraphConfigured, migrate);
    }
});

test("ports follow stable IDs, not titles or visual order", () => {
    const node = nodeFixture();
    reconcileCardInputs(node, [{ id: "a", title: "Same" }, { id: "b", title: "Same" }]);
    node.inputs[1].link = 42;
    reconcileCardInputs(node, [{ id: "b", title: "Changed" }, { id: "a", title: "New" }]);
    assert.equal(node.inputs[1].name, cardInputName("a"));
    assert.equal(node.inputs[1].link, 42);
    assert.deepEqual([...connectedCardIds(node)], ["a"]);
    assert.deepEqual(removedConnectedCards(node, [{ id: "b" }]), ["a"]);
    assert.equal(node.inputs[0].link, 3);
});

test("reconciliation removes only obsolete card ports and is idempotent", () => {
    const node = nodeFixture();
    reconcileCardInputs(node, [{ id: "a" }, { id: "b" }]);
    reconcileCardInputs(node, [{ id: "b" }]);
    reconcileCardInputs(node, [{ id: "b" }]);
    assert.deepEqual(node.inputs.map((slot) => slot.name), ["prefix_prompt", "card_prompt_b"]);
    assert.equal(node.inputs[1].type, "STRING");
    assert.deepEqual(node.inputs[1].pos, [0, 0]);
});

test("workflow restored slots are reused without dropping their links", () => {
    const node = nodeFixture();
    node.inputs.push({ name: "card_prompt_a", type: "STRING", link: 99 });
    reconcileCardInputs(node, [{ id: "a" }]);
    assert.equal(node.inputs.length, 2);
    assert.equal(node.inputs[1].link, 99);
    assert.deepEqual(node.inputs[1].pos, [0, 0]);
});

test("port reconciliation preserves saved and manually resized node dimensions", () => {
    const node = nodeFixture();
    // The user's three-column negative grid is saved at 200px, below the
    // 218px transient native layout when an unmarked input is added.
    node.size = [800, 200];
    node.setSize = function (size) { this.size = [...size]; };
    const add = node.addInput;
    node.addInput = function (name, type, options) {
        assert.ok(options.widget, "hide native input row before host auto-sizing");
        this.size[1] += 26; // Host/extension DOM auto-size side effect.
        return add.call(this, name, type, options);
    };
    const remove = node.removeInput;
    node.removeInput = function (index) { this.size[1] += 26; remove.call(this, index); };
    for (let reload = 0; reload < 10; reload++) {
        reconcileCardInputs(node, [{ id: `card-${reload}` }]);
        assert.deepEqual(node.size, [800, 200]);
    }
    node.setSize([950, 600]);
    reconcileCardInputs(node, [{ id: "new" }, { id: "second" }]);
    assert.deepEqual(node.size, [950, 600]);
});
