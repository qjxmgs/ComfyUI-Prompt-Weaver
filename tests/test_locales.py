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

    def test_runtime_chinese_is_confined_to_the_dictionary_and_legacy_markers(self):
        allowed_fragments = {
            "archive_store.py": ("DEFAULT_ARCHIVE_NAME",),
            "web/prompt_grid_archives.js": (
                "DEFAULT_ARCHIVE_NAME",
                "item.title === `提示词 ${number}`",
            ),
            "web/prompt_toggle_grid.js": ("(?:Prompt|提示词)",),
        }
        runtime_files = [
            PLUGIN_ROOT / "__init__.py",
            PLUGIN_ROOT / "nodes.py",
            PLUGIN_ROOT / "archive_store.py",
            *(path for path in (PLUGIN_ROOT / "web").glob("*.js") if path.name != "prompt_weaver_i18n.js"),
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
