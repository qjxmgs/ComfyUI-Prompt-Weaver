import json
import re
import unicodedata


CONFIG_WIDGET_TYPE = "PROMPT_WEAVER_PROMPT_GRID"
CONFIG_VERSION = 1
MAX_VARIABLES = 100
MAX_VARIABLE_NAME_LENGTH = 64
MAX_VARIABLE_VALUE_LENGTH = 10_000
MAX_EXPANDED_PROMPT_LENGTH = 1_048_576
_VARIABLE_REFERENCE = re.compile(r"\{([^{}]+)\}")

DEFAULT_CONFIG = json.dumps(
    {
        "version": CONFIG_VERSION,
        "columns": 2,
        "items": [
            {
                "id": f"prompt-{index}",
                "title": f"Card {index:02d}",
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


def _valid_variable_name(name):
    if not name or len(name) > MAX_VARIABLE_NAME_LENGTH:
        return False
    first = name[0]
    if first != "_" and not unicodedata.category(first).startswith("L"):
        return False
    return all(
        character == "_" or unicodedata.category(character)[0] in ("L", "N")
        for character in name[1:]
    )


def _parse_variables(value):
    if not isinstance(value, list) or len(value) > MAX_VARIABLES:
        raise _config_error(f"'variables' must be an array of at most {MAX_VARIABLES} entries")
    names = set()
    ids = set()
    variables = {}
    for index, entry in enumerate(value):
        if not isinstance(entry, dict):
            raise _config_error(f"'variables[{index}]' must be an object")
        identifier = entry.get("id")
        name = entry.get("name")
        variable_value = entry.get("value")
        if not isinstance(identifier, str) or not identifier or len(identifier) > 128 or identifier in ids:
            raise _config_error(f"'variables[{index}].id' must be a unique non-empty string")
        if not isinstance(name, str) or not _valid_variable_name(name) or unicodedata.normalize("NFC", name) != name or name in names:
            raise _config_error(f"'variables[{index}].name' must be a unique NFC variable name")
        if not isinstance(variable_value, str) or len(variable_value) > MAX_VARIABLE_VALUE_LENGTH:
            raise _config_error(f"'variables[{index}].value' must be a string of at most {MAX_VARIABLE_VALUE_LENGTH} characters")
        ids.add(identifier)
        names.add(name)
        variables[name] = variable_value
    return variables


def _expand_variables(prompt, variables):
    result = []
    last = 0
    for match in _VARIABLE_REFERENCE.finditer(prompt):
        name = unicodedata.normalize("NFC", match.group(1))
        if not _valid_variable_name(name):
            continue
        prefix = prompt[last:match.start()]
        slash_count = 0
        position = match.start() - 1
        while position >= 0 and prompt[position] == "\\":
            slash_count += 1
            position -= 1
        if slash_count % 2:
            result.extend((prefix[:-1], match.group(0)))
        else:
            if name not in variables:
                raise _config_error(f"undefined variable {{{name}}}")
            result.extend((prefix, variables[name]))
        last = match.end()
    result.append(prompt[last:])
    expanded = "".join(result)
    if len(expanded) > MAX_EXPANDED_PROMPT_LENGTH:
        raise _config_error("expanded prompt exceeds 1 MiB")
    return expanded


def _parse_config(config):
    if not isinstance(config, str):
        raise _config_error("expected a JSON string")

    if not config.strip():
        return {}, []

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
    variables = _parse_variables(data.get("variables", []))

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

        retain_unselected = item.get("retain_unselected", True)
        if not isinstance(retain_unselected, bool):
            raise _config_error(
                f"'items[{index}].retain_unselected' must be a boolean"
            )

        if "prompt_tokens" in item:
            prompt_tokens = item.get("prompt_tokens")
            if not isinstance(prompt_tokens, list):
                raise _config_error(
                    f"'items[{index}].prompt_tokens' must be an array"
                )
            for token_index, token in enumerate(prompt_tokens):
                if not isinstance(token, dict):
                    raise _config_error(
                        f"'items[{index}].prompt_tokens[{token_index}]' must be an object"
                    )
                text = token.get("text")
                if not isinstance(text, str) or not text.strip():
                    raise _config_error(
                        f"'items[{index}].prompt_tokens[{token_index}].text' "
                        "must be a non-empty string"
                    )
                if not isinstance(token.get("selected"), bool):
                    raise _config_error(
                        f"'items[{index}].prompt_tokens[{token_index}].selected' "
                        "must be a boolean"
                    )

        parsed_items.append((enabled, prompt))

    return variables, parsed_items


def _clean_prompt(prompt):
    # Only ASCII commas are delimiters. Full-width and other comma characters
    # are part of the user's prompt and must be preserved.
    return prompt.strip().lstrip(",").rstrip(",").strip()


def _is_word_character(character):
    return bool(character) and (character.isalnum() or character == "_")


def _quote_end_at(text, index):
    character = text[index]
    if character == '"':
        return '"'
    if character == "“":
        return "”"
    if character == "‘":
        return "’"
    if character == "'" and not (
        index > 0
        and index + 1 < len(text)
        and _is_word_character(text[index - 1])
        and _is_word_character(text[index + 1])
    ):
        return "'"
    return None


def _is_contraction_apostrophe(text, index):
    return (
        text[index] in ("'", "’")
        and index > 0
        and index + 1 < len(text)
        and _is_word_character(text[index - 1])
        and _is_word_character(text[index + 1])
    )


def _split_prompt_tokens(value):
    text = value if isinstance(value, str) else ""
    tokens = []
    current = []
    parenthesis_depth = 0
    bracket_depth = 0
    brace_depth = 0
    quote_end = None
    escaped = False

    def flush():
        token = "".join(current).strip()
        if token:
            tokens.append(token)
        current.clear()

    for index, character in enumerate(text):
        if escaped:
            current.append(character)
            escaped = False
            continue
        if character == "\\":
            current.append(character)
            escaped = True
            continue
        if quote_end:
            current.append(character)
            if character == quote_end and not _is_contraction_apostrophe(text, index):
                quote_end = None
            continue

        next_quote_end = _quote_end_at(text, index)
        if next_quote_end:
            quote_end = next_quote_end
            current.append(character)
            continue

        if (
            character in (",", "，", "\n", "\r")
            and parenthesis_depth == 0
            and bracket_depth == 0
            and brace_depth == 0
        ):
            flush()
            continue

        current.append(character)
        if character == "(":
            parenthesis_depth += 1
        elif character == ")" and parenthesis_depth > 0:
            parenthesis_depth -= 1
        elif character == "[":
            bracket_depth += 1
        elif character == "]" and bracket_depth > 0:
            bracket_depth -= 1
        elif character == "{":
            brace_depth += 1
        elif character == "}" and brace_depth > 0:
            brace_depth -= 1

    flush()
    return tokens


def _deduplicated_prompt(parts):
    result = []
    seen = set()
    for part in parts:
        for token in _split_prompt_tokens(part):
            key = token.casefold()
            if key in seen:
                continue
            seen.add(key)
            result.append(token)
    return ", ".join(result)


def combine_prompt_grid_config(config, prefix_prompt=""):
    if not isinstance(prefix_prompt, str):
        raise _config_error("'prefix_prompt' must be a string")

    prompts = []
    variables, parsed_items = _parse_config(config)
    for enabled, prompt in parsed_items:
        if not enabled:
            continue
        cleaned = _clean_prompt(_expand_variables(prompt, variables))
        if cleaned:
            prompts.append(cleaned)

    # Preserve the exact legacy grid-only output when no usable prefix is
    # supplied. Once a prefix participates, normalize both sources with the
    # same top-level token rules as the prompt editor and keep the first copy.
    if not _split_prompt_tokens(prefix_prompt):
        result = ", ".join(prompts)
    else:
        result = _deduplicated_prompt([prefix_prompt, *prompts])
    if len(result) > MAX_EXPANDED_PROMPT_LENGTH:
        raise _config_error("expanded prompt exceeds 1 MiB")
    return result


class PromptWeaverPromptToggleGrid:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "config": (
                    CONFIG_WIDGET_TYPE,
                    {"default": DEFAULT_CONFIG},
                )
            },
            "optional": {
                "prefix_prompt": (
                    "STRING",
                    {
                        "default": "",
                        "forceInput": True,
                        "tooltip": "Optional text prepended to enabled prompt cards; duplicates are removed.",
                    },
                )
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "combine"
    CATEGORY = "Prompt Weaver/Prompt"
    DESCRIPTION = (
        "Prepend optional prompt text, then combine enabled prompt cards and remove duplicates."
    )

    def combine(self, config, prefix_prompt=""):
        return (combine_prompt_grid_config(config, prefix_prompt),)
