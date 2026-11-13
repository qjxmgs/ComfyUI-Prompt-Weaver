import copy
import importlib.util
import json
import math
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location("card_input_nodes", Path(__file__).resolve().parents[1] / "nodes.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
Node = module.PromptWeaverPromptToggleGrid


class CardInputsTests(unittest.TestCase):
    def setUp(self):
        self.data = {"version": 1, "items": [
            {"id": "a", "enabled": True, "prompt": "original a"},
            {"id": "b", "enabled": False, "prompt": "{missing}"},
            {"id": "c", "enabled": True, "prompt": "original c"},
        ]}

    def config(self):
        return json.dumps(self.data)

    def test_empty_replacement_disabled_and_original_unchanged(self):
        original = copy.deepcopy(self.data)
        self.assertEqual(Node().combine(self.config(), card_prompt_a="", card_prompt_b=None), ("original c",))
        self.assertEqual(self.data, original)
        self.assertEqual(Node().combine(self.config()), ("original a, original c",))

    def test_lazy_only_requests_enabled_unresolved_inputs(self):
        self.assertEqual(Node().check_lazy_status(self.config(), card_prompt_a=None, card_prompt_b=None, card_prompt_c=""), ["card_prompt_a"])
        self.assertEqual(Node().check_lazy_status(self.config(), card_prompt_a=""), [])

    def test_external_values_use_variables_and_clear_rules(self):
        self.data["variables"] = [{"id": "v", "name": "color", "value": "red"}]
        self.data["clear_prompts"] = {"prompt": "bad"}
        self.assertEqual(Node().combine(self.config(), card_prompt_a="{color}, bad"), ("red, original c",))
        with self.assertRaisesRegex(ValueError, "undefined variable"):
            Node().combine(self.config(), card_prompt_a="{unknown}")

    def test_unknown_duplicate_and_invalid_input_rejected(self):
        for kwargs in ({"card_prompt_unknown": "x"}, {"unexpected": "x"}, {"card_prompt_a": 1}, {"card_prompt_a": None}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                Node().combine(self.config(), **kwargs)
        self.data["items"][2]["id"] = "a"
        with self.assertRaisesRegex(ValueError, "duplicate card ID"):
            Node().combine(self.config(), card_prompt_a="value")

    def test_dynamic_schema_and_validation(self):
        optional = Node.INPUT_TYPES()["optional"]
        self.assertIn("card_prompt_uuid", optional)
        self.assertEqual(optional["card_prompt_uuid"], ("STRING", {"forceInput": True, "lazy": True}))
        self.assertNotIn("arbitrary", optional)
        self.assertIs(Node.VALIDATE_INPUTS(self.config(), {"card_prompt_a": "STRING"}, card_prompt_a=None), True)
        self.assertIsNot(Node.VALIDATE_INPUTS(self.config(), {"card_prompt_a": "INT"}, card_prompt_a=None), True)
        self.assertIsNot(Node.VALIDATE_INPUTS(self.config(), {}, card_prompt_unknown=None), True)

    def test_snapshots_preserve_wires_and_originals_replace_stale_values(self):
        workflow = {"nodes": [{"id": 12, "widgets_values": [self.config()], "inputs": [{"name": "card_prompt_a", "link": 8}],
                               "properties": {"keep": True, "cpw_external_prompt_snapshot": {"b": "stale"}}}], "links": [[8, 1, 0, 12, 0, "STRING"]]}
        metadata = {"workflow": workflow}
        config_before = workflow["nodes"][0]["widgets_values"][0]
        for value in ("first", "second", ""):
            Node().combine(self.config(), unique_id="12", extra_pnginfo=metadata, card_prompt_a=value, card_prompt_b=None)
            self.assertEqual(workflow["nodes"][0]["properties"], {"keep": True, "cpw_external_prompt_snapshot": {"a": value}})
            self.assertEqual(workflow["nodes"][0]["widgets_values"][0], config_before)
            self.assertEqual(workflow["links"], [[8, 1, 0, 12, 0, "STRING"]])
        self.data["items"][0]["enabled"] = False
        Node().combine(self.config(), unique_id="12", extra_pnginfo=metadata, card_prompt_a=None)
        self.assertNotIn("cpw_external_prompt_snapshot", workflow["nodes"][0]["properties"])

    def test_execution_cache_invalidation_only_with_external_inputs(self):
        self.assertTrue(math.isnan(Node.IS_CHANGED(self.config(), card_prompt_a=None)))
        self.assertEqual(Node.IS_CHANGED(self.config()), self.config())

    def test_no_metadata_and_size_limit(self):
        self.assertEqual(Node().combine(self.config(), card_prompt_a="external"), ("external, original c",))
        with self.assertRaisesRegex(ValueError, "exceeds"):
            Node().combine(self.config(), card_prompt_a="a" * (module.MAX_EXPANDED_PROMPT_LENGTH + 1))


if __name__ == "__main__":
    unittest.main()
