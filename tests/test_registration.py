import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest import mock


PLUGIN_ROOT = Path(__file__).resolve().parents[1]


class _FakeRoutes:
    def __init__(self):
        self.registered = []

    def _decorator(self, method, path):
        def decorate(function):
            self.registered.append((method, path, function.__name__))
            return function

        return decorate

    def post(self, path):
        return self._decorator("POST", path)

    def get(self, path):
        return self._decorator("GET", path)


class PluginRegistrationTests(unittest.TestCase):
    def test_node_mapping_loads_without_replacing_existing_routes(self):
        routes = _FakeRoutes()
        prompt_server = types.SimpleNamespace(
            instance=types.SimpleNamespace(routes=routes)
        )

        server_module = types.ModuleType("server")
        server_module.PromptServer = prompt_server
        aiohttp_module = types.ModuleType("aiohttp")
        aiohttp_module.web = types.SimpleNamespace()

        module_name = "comfyui_prompt_weaver_plugin_test"
        spec = importlib.util.spec_from_file_location(
            module_name,
            PLUGIN_ROOT / "__init__.py",
            submodule_search_locations=[str(PLUGIN_ROOT)],
        )
        module = importlib.util.module_from_spec(spec)

        with mock.patch.dict(
            sys.modules,
            {
                module_name: module,
                "server": server_module,
                "aiohttp": aiohttp_module,
            },
        ):
            spec.loader.exec_module(module)

        node_class = module.NODE_CLASS_MAPPINGS["PromptWeaverPromptToggleGrid"]
        self.assertEqual(node_class.__name__, "PromptWeaverPromptToggleGrid")
        self.assertEqual(
            module.NODE_DISPLAY_NAME_MAPPINGS["PromptWeaverPromptToggleGrid"],
            "提示词开关网格",
        )
        self.assertEqual(module.WEB_DIRECTORY, "./web")
        self.assertEqual(
            routes.registered,
            [
                ("POST", "/prompt-weaver/frontend-ready", "frontend_ready"),
                ("POST", "/prompt-weaver/open-workflow", "open_workflow"),
                ("GET", "/prompt-weaver/workflow/{token}", "take_workflow"),
            ],
        )


if __name__ == "__main__":
    unittest.main()
