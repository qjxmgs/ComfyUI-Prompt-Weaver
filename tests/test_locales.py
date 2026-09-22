import json
from pathlib import Path
import re
import unittest


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
HAN_PATTERN = re.compile(r"[\u3400-\u9fff]")


class LocaleResourceTests(unittest.TestCase):
    def test_comfyui_locale_resources_cover_the_node_contract(self):
        expected_display_names = {
            "en": "Prompt Card Grid",
            "zh": "提示词卡片网格",
        }
        for locale in ("en", "zh"):
            locale_root = PLUGIN_ROOT / "locales" / locale
            main = json.loads((locale_root / "main.json").read_text(encoding="utf-8"))
            node_defs = json.loads((locale_root / "nodeDefs.json").read_text(encoding="utf-8"))
            node = node_defs["PromptWeaverPromptToggleGrid"]

            self.assertIn("Prompt", main["nodeCategories"])
            self.assertEqual(node["display_name"], expected_display_names[locale])
            self.assertTrue(node["description"])
            self.assertIn("prefix_prompt", node["inputs"])
            self.assertIn("config", node["inputs"])
            self.assertIn("0", node["outputs"])

    def test_official_locale_resources_cover_custom_ui_settings_and_commands(self):
        resources = {}
        for locale in ("en", "zh"):
            locale_root = PLUGIN_ROOT / "locales" / locale
            resources[locale] = {
                "main": json.loads((locale_root / "main.json").read_text(encoding="utf-8")),
                "settings": json.loads((locale_root / "settings.json").read_text(encoding="utf-8")),
                "commands": json.loads((locale_root / "commands.json").read_text(encoding="utf-8")),
            }

        english_ui = resources["en"]["main"]["promptWeaver"]["ui"]
        chinese_ui = resources["zh"]["main"]["promptWeaver"]["ui"]
        self.assertGreaterEqual(len(english_ui), 400)
        self.assertEqual(set(english_ui), set(chinese_ui))
        self.assertTrue(all(key == value for key, value in english_ui.items()))
        self.assertEqual(chinese_ui["Clear"], "清空")
        self.assertEqual(chinese_ui["Card title"], "卡片标题")
        self.assertEqual(
            chinese_ui["Only load tags used in at least this many Danbooru posts."],
            "只加载Danbooru上作品引用数量不低于该数值的标签",
        )

        expected_settings = {
            "PromptWeaver_Autocomplete_SourceOrder",
            "PromptWeaver_Autocomplete_MaxResults",
            "PromptWeaver_Autocomplete_MinPostCount",
            "PromptWeaver_Autocomplete_TranslationManager",
        }
        expected_commands = {"PromptWeaver_Autocomplete_UpdateDictionary"}
        for locale in ("en", "zh"):
            self.assertEqual(set(resources[locale]["settings"]), expected_settings)
            self.assertEqual(set(resources[locale]["commands"]), expected_commands)
            self.assertIn("Prompt Weaver", resources[locale]["main"]["settingsCategories"])

    def test_runtime_i18n_adapter_consumes_the_official_comfyui_endpoint(self):
        source = (PLUGIN_ROOT / "web" / "prompt_weaver_i18n.js").read_text(encoding="utf-8")
        self.assertIn("getCustomNodesI18n", source)
        self.assertIn('"/i18n"', source)
        self.assertIn("Comfy.Locale.change", source)
        self.assertNotIn("CHINESE_MESSAGES", source)
        self.assertNotIn("app.vueApp", source)

    def test_runtime_javascript_uses_english_ui_strings_only(self):
        allowed_fragments = {}
        runtime_files = [
            PLUGIN_ROOT / "__init__.py",
            PLUGIN_ROOT / "nodes.py",
            PLUGIN_ROOT / "archive_store.py",
            *(PLUGIN_ROOT / "web").glob("*.js"),
        ]
        violations = []
        for path in runtime_files:
            relative = path.relative_to(PLUGIN_ROOT).as_posix()
            allowed = allowed_fragments.get(relative, ())
            for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if HAN_PATTERN.search(line) and not any(fragment in line for fragment in allowed):
                    violations.append(f"{relative}:{line_number}: {line.strip()}")
        self.assertEqual(violations, [])

    def test_readmes_are_cross_linked_and_keep_the_same_test_commands(self):
        english = (PLUGIN_ROOT / "README.md").read_text(encoding="utf-8")
        chinese = (PLUGIN_ROOT / "README.zh-CN.md").read_text(encoding="utf-8")
        self.assertIn("](./README.zh-CN.md)", english)
        self.assertIn("](./README.md)", chinese)
        for command in (
            'python -m unittest discover -s tests -p "test_*.py" -v',
            "node --test tests/*.mjs",
        ):
            self.assertIn(command, english)
            self.assertIn(command, chinese)


if __name__ == "__main__":
    unittest.main()
