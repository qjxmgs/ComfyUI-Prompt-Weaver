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
_PROMPT_WEIGHT = re.compile(r"\s*[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\s*")

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
        return {}, [], ""

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
    clear_prompts = data.get("clear_prompts", {})
    if not isinstance(clear_prompts, dict):
        raise _config_error("'clear_prompts' must be an object")
    clear_prompt = _parse_prompt_fields(clear_prompts, "clear_prompts")

    parsed_items = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise _config_error(f"'items[{index}]' must be an object")

        enabled = item.get("enabled", False)
        if not isinstance(enabled, bool):
            raise _config_error(f"'items[{index}].enabled' must be a boolean")

        parsed_items.append((enabled, _parse_prompt_fields(item, f"items[{index}]")))

    return variables, parsed_items, clear_prompt


def _parse_prompt_fields(item, field):
    prompt = item.get("prompt", "")
    if not isinstance(prompt, str):
        raise _config_error(f"'{field}.prompt' must be a string")
    if not isinstance(item.get("retain_unselected", True), bool):
        raise _config_error(f"'{field}.retain_unselected' must be a boolean")

    prompt_tokens = item.get("prompt_tokens", [])
    if not isinstance(prompt_tokens, list):
        raise _config_error(f"'{field}.prompt_tokens' must be an array")
    for token_index, token in enumerate(prompt_tokens):
        token_field = f"{field}.prompt_tokens[{token_index}]"
        if not isinstance(token, dict):
            raise _config_error(f"'{token_field}' must be an object")
        text = token.get("text")
        if not isinstance(text, str) or not text.strip():
            raise _config_error(f"'{token_field}.text' must be a non-empty string")
        if not isinstance(token.get("selected"), bool):
            raise _config_error(f"'{token_field}.selected' must be a boolean")
    return prompt


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
    # A quote cannot start inside a word, including before a hyphen.
    if character == "'" and not (
        index > 0 and _is_word_character(text[index - 1])
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


def _prompt_syntax_characters(text):
    quote_end = None
    escaped = False
    for index, character in enumerate(text):
        if escaped:
            escaped = False
            continue
        if character == "\\":
            escaped = True
            continue
        if quote_end:
            if character == quote_end and not _is_contraction_apostrophe(text, index):
                quote_end = None
            continue
        quote_end = _quote_end_at(text, index)
        if not quote_end:
            yield index, character


def _split_prompt_tokens(value):
    text = value if isinstance(value, str) else ""
    tokens = []
    start = 0
    parenthesis_depth = 0
    bracket_depth = 0
    brace_depth = 0
    for index, character in _prompt_syntax_characters(text):
        if (
            character in (",", "，", "\n", "\r")
            and parenthesis_depth == 0
            and bracket_depth == 0
            and brace_depth == 0
        ):
            token = text[start:index].strip()
            if token:
                tokens.append(token)
            start = index + 1
            continue

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

    token = text[start:].strip()
    if token:
        tokens.append(token)
    return tokens


def _clear_prompt_key(token):
    if not (token.startswith("(") and token.endswith(")")):
        return token.lower()

    # Index balanced wrappers once so even deeply nested weights are linear.
    wrappers = {}
    stack = []
    for index, character in _prompt_syntax_characters(token):
        if character == "(":
            stack.append((index, None))
        elif character == ":" and stack:
            stack[-1] = (stack[-1][0], index)
        elif character == ")" and stack:
            opening, colon = stack.pop()
            wrappers[opening] = (index, colon)

    start, end = 0, len(token)
    while start in wrappers and wrappers[start][0] == end - 1:
        _, colon = wrappers[start]
        inner_start, inner_end = start + 1, end - 1
        if colon is not None and colon > inner_start and _PROMPT_WEIGHT.fullmatch(token, colon + 1, inner_end):
            inner_end = colon
        while inner_start < inner_end and token[inner_start].isspace():
            inner_start += 1
        while inner_end > inner_start and token[inner_end - 1].isspace():
            inner_end -= 1
        if inner_start == inner_end:
            break
        start, end = inner_start, inner_end
    return token[start:end].lower()


def _deduplicated_prompt(parts, excluded):
    result = []
    seen = set()
    for part in parts:
        for token in _split_prompt_tokens(part):
            if excluded and _clear_prompt_key(token) in excluded:
                continue
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
    variables, parsed_items, clear_prompt = _parse_config(config)
    excluded = {_clear_prompt_key(token) for token in _split_prompt_tokens(
        _expand_variables(clear_prompt, variables)
    )}
    has_prefix = bool(_split_prompt_tokens(prefix_prompt))
    for enabled, prompt in parsed_items:
        if not enabled:
            continue
        cleaned = _clean_prompt(_expand_variables(prompt, variables))
        if cleaned and excluded and not has_prefix:
            tokens = _split_prompt_tokens(cleaned)
            remaining = [token for token in tokens if _clear_prompt_key(token) not in excluded]
            if len(remaining) != len(tokens):
                cleaned = ", ".join(remaining)
        if cleaned:
            prompts.append(cleaned)

    # Preserve the exact legacy grid-only output when no usable prefix is
    # supplied. Once a prefix participates, normalize both sources with the
    # same top-level token rules as the prompt editor and keep the first copy.
    if not has_prefix:
        result = ", ".join(prompts)
    else:
        result = _deduplicated_prompt([prefix_prompt, *prompts], excluded)
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
