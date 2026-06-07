import json


CONFIG_WIDGET_TYPE = "PROMPT_WEAVER_PROMPT_GRID"
CONFIG_VERSION = 1

DEFAULT_CONFIG = json.dumps(
    {
        "version": CONFIG_VERSION,
        "columns": 2,
        "items": [
            {
                "id": f"prompt-{index}",
                "title": f"提示词 {index}",
                "prompt": "",
                "enabled": True,
            }
            for index in range(1, 5)
        ],
    },
    ensure_ascii=False,
    separators=(",", ":"),
)


def _config_error(message):
    return ValueError(f"Prompt Weaver prompt grid config: {message}")


def _reject_nonstandard_json_constant(value):
    raise _config_error(f"invalid JSON constant {value!r}")


def _parse_config(config):
    if not isinstance(config, str):
        raise _config_error("expected a JSON string")

    if not config.strip():
        return []

    try:
        data = json.loads(config, parse_constant=_reject_nonstandard_json_constant)
    except json.JSONDecodeError as error:
        raise _config_error(
            f"invalid JSON at line {error.lineno}, column {error.colno}: {error.msg}"
        ) from error

    if not isinstance(data, dict):
        raise _config_error("the top-level value must be an object")

    version = data.get("version", CONFIG_VERSION)
    if (
        isinstance(version, bool)
        or not isinstance(version, (int, float))
        or version != CONFIG_VERSION
    ):
        raise _config_error(
            f"unsupported version {version!r}; only version {CONFIG_VERSION} is supported"
        )

    items = data.get("items")
    if not isinstance(items, list):
        raise _config_error("'items' must be an array")

    parsed_items = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise _config_error(f"'items[{index}]' must be an object")

        enabled = item.get("enabled", False)
        if not isinstance(enabled, bool):
            raise _config_error(f"'items[{index}].enabled' must be a boolean")

        prompt = item.get("prompt", "")
        if not isinstance(prompt, str):
            raise _config_error(f"'items[{index}].prompt' must be a string")

        parsed_items.append((enabled, prompt))

    return parsed_items


def _clean_prompt(prompt):
    # Only ASCII commas are delimiters. Full-width and other comma characters
    # are part of the user's prompt and must be preserved.
    return prompt.strip().lstrip(",").rstrip(",").strip()


def combine_prompt_grid_config(config):
    prompts = []
    for enabled, prompt in _parse_config(config):
        if not enabled:
            continue
        cleaned = _clean_prompt(prompt)
        if cleaned:
            prompts.append(cleaned)
    return ", ".join(prompts)


class PromptWeaverPromptToggleGrid:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "config": (
                    CONFIG_WIDGET_TYPE,
                    {"default": DEFAULT_CONFIG},
                )
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "combine"
    CATEGORY = "Prompt Weaver/提示词"

    def combine(self, config):
        return (combine_prompt_grid_config(config),)
