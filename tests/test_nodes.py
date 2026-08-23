import importlib.util
import json
from pathlib import Path
import re
import unittest


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "comfyui_prompt_weaver_nodes",
    PLUGIN_ROOT / "nodes.py",
)
NODES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(NODES)


class PromptWeaverPromptToggleGridTests(unittest.TestCase):
    def combine(self, config, prefix_prompt=""):
        return NODES.PromptWeaverPromptToggleGrid().combine(config, prefix_prompt)[0]

    def test_node_contract_and_default_config(self):
        input_spec = NODES.PromptWeaverPromptToggleGrid.INPUT_TYPES()
        widget_type, options = input_spec["required"]["config"]
        prefix_type, prefix_options = input_spec["optional"]["prefix_prompt"]

        self.assertEqual(widget_type, "PROMPT_WEAVER_PROMPT_GRID")
        self.assertEqual(prefix_type, "STRING")
        self.assertEqual(prefix_options["default"], "")
        self.assertTrue(prefix_options["forceInput"])
        self.assertEqual(NODES.PromptWeaverPromptToggleGrid.RETURN_TYPES, ("STRING",))
        self.assertEqual(NODES.PromptWeaverPromptToggleGrid.RETURN_NAMES, ("prompt",))
        self.assertEqual(NODES.PromptWeaverPromptToggleGrid.FUNCTION, "combine")
        self.assertEqual(
            NODES.PromptWeaverPromptToggleGrid.CATEGORY,
            "Prompt Weaver/Prompt",
        )

        default = json.loads(options["default"])
        self.assertEqual(default["version"], 1)
        self.assertEqual(default["columns"], 2)
        self.assertEqual(len(default["items"]), 4)
        self.assertEqual(
            [item["id"] for item in default["items"]],
            ["prompt-1", "prompt-2", "prompt-3", "prompt-4"],
        )
        self.assertEqual(
            [item["title"] for item in default["items"]],
            ["Prompt 1", "Prompt 2", "Prompt 3", "Prompt 4"],
        )
        self.assertTrue(all(item["enabled"] for item in default["items"]))
        self.assertTrue(all(item["prompt"] == "" for item in default["items"]))
        self.assertEqual(self.combine(options["default"]), "")

    def test_prefix_is_optional_and_precedes_enabled_grid_prompts(self):
        config = json.dumps(
            {
                "items": [
                    {"enabled": True, "prompt": "best quality"},
                    {"enabled": False, "prompt": "disabled"},
                    {"enabled": True, "prompt": "blue eyes"},
                ]
            }
        )

        self.assertEqual(
            self.combine(config, "trigger one, trigger two"),
            "trigger one, trigger two, best quality, blue eyes",
        )

    def test_prefix_and_grid_tokens_are_deduplicated_case_insensitively(self):
        config = json.dumps(
            {
                "items": [
                    {
                        "enabled": True,
                        "prompt": "masterpiece, best quality, (red, blue:1.2)",
                    },
                    {
                        "enabled": True,
                        "prompt": 'BLUE EYES, "quoted, value", escaped\\, comma',
                    },
                ]
            }
        )

        self.assertEqual(
            self.combine(
                config,
                'MasterPiece, blue eyes, MASTERPIECE, "quoted, value"',
            ),
            'MasterPiece, blue eyes, "quoted, value", best quality, '
            '(red, blue:1.2), escaped\\, comma',
        )

    def test_prefix_can_be_the_only_output(self):
        config = json.dumps({"items": []})
        self.assertEqual(
            self.combine(config, "trigger one，trigger two\ntrigger one"),
            "trigger one, trigger two",
        )

    def test_separator_only_prefix_preserves_legacy_grid_formatting(self):
        config = json.dumps(
            {
                "items": [
                    {"enabled": True, "prompt": "写实人像,\n柔和光线"},
                    {"enabled": True, "prompt": "，，夜景，，"},
                ]
            },
            ensure_ascii=False,
        )
        self.assertEqual(
            self.combine(config, " ,，\r\n "),
            "写实人像,\n柔和光线, ，，夜景，，",
        )

    def test_prefix_must_be_a_string(self):
        with self.assertRaisesRegex(ValueError, "'prefix_prompt' must be a string"):
            self.combine(json.dumps({"items": []}), None)

    def test_empty_config_returns_empty_output(self):
        for config in ("", "   \n\t  "):
            with self.subTest(config=config):
                self.assertEqual(self.combine(config), "")

    def test_combines_enabled_nonempty_prompts_in_item_order(self):
        config = json.dumps(
            {
                "version": 1,
                "columns": 6,
                "items": [
                    {"enabled": True, "prompt": "  ,,,best quality,,,  "},
                    {"enabled": False, "prompt": "must not appear"},
                    {"enabled": True, "prompt": " blue eyes, red hair "},
                    {"enabled": True, "prompt": ",, masterpiece, ultra detailed,,"},
                    {"enabled": True, "prompt": " ,,, "},
                ],
            }
        )

        self.assertEqual(
            self.combine(config),
            "best quality, blue eyes, red hair, masterpiece, ultra detailed",
        )

    def test_missing_version_defaults_to_v1_and_columns_is_ignored(self):
        config = json.dumps(
            {
                "columns": {"not": "a backend concern"},
                "items": [
                    {"enabled": True, "prompt": "first"},
                    {"enabled": True, "prompt": "second"},
                ],
            }
        )
        self.assertEqual(self.combine(config), "first, second")

    def test_json_number_one_is_a_supported_version(self):
        for version in (1, 1.0):
            with self.subTest(version=version):
                config = json.dumps(
                    {
                        "version": version,
                        "items": [{"enabled": True, "prompt": "kept"}],
                    }
                )
                self.assertEqual(self.combine(config), "kept")

    def test_missing_enabled_is_false_and_missing_prompt_is_empty(self):
        config = json.dumps(
            {
                "items": [
                    {"prompt": "disabled by default"},
                    {"enabled": True},
                    {"enabled": True, "prompt": "kept"},
                ]
            }
        )
        self.assertEqual(self.combine(config), "kept")

    def test_only_ascii_edge_commas_are_removed(self):
        config = json.dumps(
            {
                "items": [
                    {"enabled": True, "prompt": "  ,,,alpha,,,  "},
                    {"enabled": True, "prompt": "，，中文逗号，，"},
                ]
            },
            ensure_ascii=False,
        )
        self.assertEqual(self.combine(config), "alpha, ，，中文逗号，，")

    def test_chinese_text_and_internal_newlines_are_preserved(self):
        config = json.dumps(
            {
                "items": [
                    {
                        "enabled": True,
                        "prompt": "  ,,\n写实人像,\n柔和光线,,  ",
                    },
                    {"enabled": True, "prompt": "  电影感  "},
                ]
            },
            ensure_ascii=False,
        )
        self.assertEqual(self.combine(config), "写实人像,\n柔和光线, 电影感")

    def test_rejects_invalid_json_with_location(self):
        with self.assertRaisesRegex(
            ValueError,
            r"Prompt Weaver prompt grid config: invalid JSON at line 1, column",
        ):
            self.combine('{"version":1,"items":[')

    def test_rejects_nonstandard_json_constants(self):
        for constant in ("NaN", "Infinity", "-Infinity"):
            with self.subTest(constant=constant):
                config = (
                    '{"version":1,"columns":' + constant
                    + ',"items":[{"enabled":true,"prompt":"must not leak"}]}'
                )
                with self.assertRaisesRegex(
                    ValueError,
                    re.escape(f"invalid JSON constant {constant!r}"),
                ):
                    self.combine(config)

    def test_rejects_invalid_root_version_and_item_types(self):
        cases = [
            (None, "expected a JSON string"),
            (json.dumps([]), "top-level value must be an object"),
            (json.dumps({}), "'items' must be an array"),
            (json.dumps({"version": 2, "items": []}), "unsupported version 2"),
            (json.dumps({"version": True, "items": []}), "unsupported version True"),
            (json.dumps({"version": "1", "items": []}), "unsupported version '1'"),
            (json.dumps({"version": 1.5, "items": []}), "unsupported version 1.5"),
            (json.dumps({"items": {}}), "'items' must be an array"),
            (json.dumps({"items": ["prompt"]}), "'items[0]' must be an object"),
            (
                json.dumps({"items": [{"enabled": 1, "prompt": "prompt"}]}),
                "'items[0].enabled' must be a boolean",
            ),
            (
                json.dumps({"items": [{"enabled": True, "prompt": None}]}),
                "'items[0].prompt' must be a string",
            ),
        ]

        for config, message in cases:
            with self.subTest(config=config):
                with self.assertRaisesRegex(ValueError, re.escape(message)):
                    self.combine(config)


if __name__ == "__main__":
    unittest.main()
