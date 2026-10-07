"""Dataset reading and tokenisation.

Four row formats, the same ones services/dataset.ts detects in the API:

    alpaca      {instruction, input?, output}
    sharegpt    {conversations: [{from: human|gpt|system, value}]}
    completion  {prompt, completion}
    text        {text}

over three file types (jsonl, csv, parquet). alpaca, sharegpt and completion
rows become chat messages rendered with the base model's own chat template,
so the adapter is trained on exactly the token sequence /v1/chat/completions
produces at inference; only the assistant turns carry loss. text rows are
plain causal language modelling.

Two kinds of bad row are kept apart. A row the API's validation would also
refuse (unparseable, a missing or mistyped field) fails the run with exit 11
and its row number: the file is not what was validated. A row that is well
formed but gives nothing to learn from (empty answer, no assistant turn,
nothing left after truncation) is skipped and counted.
"""

from __future__ import annotations

import csv
import json
import random
from dataclasses import dataclass, field
from typing import Iterator

from .config import DEFAULT_EVAL_MIN_ROWS, DEFAULT_EVAL_SPLIT
from .errors import BaseModelError, DatasetError

ROW_FORMATS = ("alpaca", "sharegpt", "completion", "text")
SHAREGPT_ROLES = {"human": "user", "gpt": "assistant", "system": "system"}
IGNORE_INDEX = -100

# A CSV cell holding a long document is legitimate; Python's default limit
# of 131072 characters per field is not ours to impose.
CSV_FIELD_LIMIT = 32 * 1024 * 1024
PARQUET_BATCH_ROWS = 1024

# Marker used to find out whether a chat template keeps a system message.
_SYSTEM_PROBE = "wheelsai-system-probe-7c1e"


@dataclass
class Example:
    input_ids: list
    labels: list


@dataclass
class DatasetStats:
    format: str = "unknown"
    total: int = 0
    used: int = 0
    truncated: int = 0
    skipped: int = 0
    eval: int = 0
    tokens: int = 0
    skipReasons: dict = field(default_factory=dict)
    systemFolded: bool = False

    def to_json(self) -> dict:
        return {
            "total": self.total,
            "used": self.used,
            "truncated": self.truncated,
            "skipped": self.skipped,
            "eval": self.eval,
            "tokens": self.tokens,
            "skipReasons": dict(self.skipReasons),
        }


class _Skip(Exception):
    """A well-formed row with nothing to train on."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------


def read_rows(path: str, file_type: str) -> Iterator[tuple]:
    """Yield (row number, row dict). Rows are numbered from 1 as a person
    counts them in the file: line numbers for jsonl and csv (the csv header
    is line 1), record numbers for parquet."""
    if file_type == "jsonl":
        return _read_jsonl(path)
    if file_type == "csv":
        return _read_csv(path)
    if file_type == "parquet":
        return _read_parquet(path)
    raise DatasetError(f"Unsupported file type: {file_type}", code="dataset_unknown_file_type")


def _read_jsonl(path: str) -> Iterator[tuple]:
    try:
        # utf-8-sig: a leading byte-order mark is dropped, not parsed.
        with open(path, "r", encoding="utf-8-sig") as handle:
            for number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError as error:
                    raise DatasetError(
                        f"Row {number} is not valid JSON: {error.msg}",
                        code="dataset_parse_error",
                        row=number,
                    )
                if not isinstance(row, dict):
                    raise DatasetError(
                        f"Row {number} is not a JSON object", code="dataset_parse_error", row=number
                    )
                yield number, row
    except UnicodeDecodeError:
        raise DatasetError("The dataset is not UTF-8 text", code="dataset_parse_error")


def _read_csv(path: str) -> Iterator[tuple]:
    csv.field_size_limit(CSV_FIELD_LIMIT)
    try:
        with open(path, "r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.reader(handle)
            try:
                header = [name.strip() for name in next(reader)]
            except StopIteration:
                return
            if not header or any(not name for name in header) or len(set(header)) != len(header):
                raise DatasetError(
                    "The CSV header has an empty or repeated column name",
                    code="dataset_parse_error",
                    row=1,
                )
            for values in reader:
                number = reader.line_num
                if not values or all(not value.strip() for value in values):
                    continue
                if len(values) != len(header):
                    raise DatasetError(
                        f"Row {number} has {len(values)} columns, expected {len(header)}",
                        code="dataset_parse_error",
                        row=number,
                    )
                yield number, dict(zip(header, values))
    except UnicodeDecodeError:
        raise DatasetError("The dataset is not UTF-8 text", code="dataset_parse_error")
    except csv.Error as error:
        raise DatasetError(f"The CSV could not be parsed: {error}", code="dataset_parse_error")


def _read_parquet(path: str) -> Iterator[tuple]:
    # Imported here so the jsonl and csv paths do not pay for pyarrow.
    import pyarrow as pa
    import pyarrow.parquet as pq

    try:
        parquet = pq.ParquetFile(path)
    except (pa.ArrowException, OSError) as error:
        raise DatasetError(
            f"The file is not readable as Parquet: {type(error).__name__}", code="dataset_parse_error"
        )
    number = 0
    try:
        # Batches, not read_table: memory stays bounded by the batch.
        for batch in parquet.iter_batches(batch_size=PARQUET_BATCH_ROWS):
            for row in batch.to_pylist():
                number += 1
                yield number, row
    except pa.ArrowException as error:
        raise DatasetError(
            f"The Parquet file is damaged after row {number}: {type(error).__name__}",
            code="dataset_parse_error",
            row=number,
        )


# ---------------------------------------------------------------------------
# Row formats
# ---------------------------------------------------------------------------


def detect_format(row: dict) -> str:
    """The same order of tests as detectFormat in services/dataset.ts."""
    if "instruction" in row and "output" in row:
        return "alpaca"
    if "conversations" in row and isinstance(row.get("conversations"), list):
        return "sharegpt"
    if "prompt" in row and "completion" in row:
        return "completion"
    if "text" in row:
        return "text"
    return "unknown"


def _string(row: dict, name: str, number: int, required: bool = True) -> str:
    value = row.get(name)
    if value is None:
        if required:
            raise DatasetError(
                f"Row {number} is missing the field {name}",
                code="dataset_row_invalid",
                row=number,
                field=name,
            )
        return ""
    if not isinstance(value, str):
        raise DatasetError(
            f"Row {number}: the field {name} should be a string",
            code="dataset_row_invalid",
            row=number,
            field=name,
        )
    return value


def row_to_messages(row: dict, row_format: str, number: int) -> list:
    """Turn an alpaca, sharegpt or completion row into chat messages.

    Raises DatasetError for a malformed row and _Skip for an empty one.
    """
    if row_format == "alpaca":
        instruction = _string(row, "instruction", number).strip()
        extra = _string(row, "input", number, required=False).strip()
        output = _string(row, "output", number).strip()
        prompt = f"{instruction}\n\n{extra}" if instruction and extra else instruction or extra
        if not prompt:
            raise _Skip("empty_prompt")
        if not output:
            raise _Skip("empty_answer")
        return [{"role": "user", "content": prompt}, {"role": "assistant", "content": output}]

    if row_format == "completion":
        prompt = _string(row, "prompt", number).strip()
        completion = _string(row, "completion", number).strip()
        if not prompt:
            raise _Skip("empty_prompt")
        if not completion:
            raise _Skip("empty_answer")
        return [{"role": "user", "content": prompt}, {"role": "assistant", "content": completion}]

    if row_format == "sharegpt":
        turns = row.get("conversations")
        if not isinstance(turns, list):
            raise DatasetError(
                f"Row {number}: conversations should be an array",
                code="dataset_row_invalid",
                row=number,
                field="conversations",
            )
        messages = []
        for index, turn in enumerate(turns):
            where = f"conversations[{index}]"
            if (
                not isinstance(turn, dict)
                or not isinstance(turn.get("from"), str)
                or not isinstance(turn.get("value"), str)
                or not turn["value"]
            ):
                raise DatasetError(
                    f"Row {number}: {where} needs string 'from' and 'value' fields",
                    code="dataset_row_invalid",
                    row=number,
                    field=where,
                )
            role = SHAREGPT_ROLES.get(turn["from"])
            if role is None:
                raise DatasetError(
                    f"Row {number}: {where}.from must be human, gpt or system",
                    code="dataset_row_invalid",
                    row=number,
                    field=f"{where}.from",
                )
            messages.append({"role": role, "content": turn["value"].strip()})
        if not any(m["role"] == "assistant" and m["content"] for m in messages):
            raise _Skip("no_assistant_turn")
        return messages

    raise DatasetError(f"Unsupported row format: {row_format}", code="dataset_unknown_format")


# ---------------------------------------------------------------------------
# Chat-template rendering with assistant-only loss
# ---------------------------------------------------------------------------


class ChatRenderer:
    """Renders messages with the tokenizer's chat template and reports which
    characters of the rendered text belong to assistant turns."""

    def __init__(self, tokenizer):
        if not getattr(tokenizer, "chat_template", None):
            raise BaseModelError(
                "The base model's tokenizer has no chat template, so chat-format rows "
                "cannot be rendered the way the model is served. Use the text format "
                "or an instruction-tuned base model.",
                code="no_chat_template",
            )
        self._tokenizer = tokenizer
        self.fold_system = not self._keeps_system_role()

    def _render(self, messages: list, add_generation_prompt: bool) -> str:
        return self._tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=add_generation_prompt
        )

    def _keeps_system_role(self) -> bool:
        """Some templates raise on a system message (Mistral-Instruct v0.2,
        Gemma) and some drop it without a word. Either way the system text
        must be folded into the first user turn, or it is lost."""
        probe = [
            {"role": "system", "content": _SYSTEM_PROBE},
            {"role": "user", "content": "a"},
            {"role": "assistant", "content": "b"},
        ]
        try:
            return _SYSTEM_PROBE in self._render(probe, False)
        except Exception:
            return False

    def prepare(self, messages: list) -> list:
        """Drop what follows the last assistant turn (nothing there carries
        loss) and fold system text where the template has no system role."""
        last = max(i for i, m in enumerate(messages) if m["role"] == "assistant")
        messages = [dict(m) for m in messages[: last + 1]]
        if not self.fold_system:
            return messages
        system_text = "\n\n".join(m["content"] for m in messages if m["role"] == "system" and m["content"])
        messages = [m for m in messages if m["role"] != "system"]
        if system_text:
            for message in messages:
                if message["role"] == "user":
                    message["content"] = f"{system_text}\n\n{message['content']}"
                    break
            else:
                messages.insert(0, {"role": "user", "content": system_text})
        return messages

    def render(self, messages: list) -> tuple:
        """Return (text, [(start, end)]) with one character span per assistant
        turn. A span runs from the end of the generation prompt to the end
        of the turn, so it includes the end-of-turn marker: the adapter must
        learn to stop."""
        try:
            full = self._render(messages, False)
        except Exception:
            # Typically "conversation roles must alternate".
            raise _Skip("template_rejected")
        spans = []
        cursor = 0
        last = len(messages) - 1
        for index, message in enumerate(messages):
            if message["role"] != "assistant":
                continue
            span = None
            try:
                before = self._render(messages[:index], True)
                through = self._render(messages[: index + 1], False)
                if full.startswith(through) and through.startswith(before) and len(through) > len(before):
                    span = (len(before), len(through))
            except Exception:
                span = None
            if span is None:
                # Templates that render a prefix differently from the whole
                # conversation: find the answer's own text instead.
                content = message["content"].strip()
                found = full.find(content, cursor) if content else -1
                if found < 0:
                    raise _Skip("template_alignment")
                span = (found, len(full) if index == last else found + len(content))
            spans.append(span)
            cursor = span[1]
        return full, spans


def tokenize_chat(tokenizer, text: str, spans: list, max_seq_length: int) -> tuple:
    """Tokenise rendered chat text; a token carries loss when it overlaps an
    assistant span. Returns (Example, truncated)."""
    # add_special_tokens=False: the template already wrote BOS where the
    # model wants one, and the serving path tokenises the same way.
    encoded = tokenizer(text, add_special_tokens=False, return_offsets_mapping=True)
    ids = list(encoded["input_ids"])
    labels = [IGNORE_INDEX] * len(ids)
    for position, (start, end) in enumerate(encoded["offset_mapping"]):
        if end <= start:
            continue
        for span_start, span_end in spans:
            if start < span_end and end > span_start:
                labels[position] = ids[position]
                break
    return _truncate(ids, labels, max_seq_length)


def tokenize_text(tokenizer, text: str, max_seq_length: int) -> tuple:
    """Plain causal LM: every token carries loss, and the text ends with EOS."""
    ids = list(tokenizer(text, add_special_tokens=True)["input_ids"])
    eos = tokenizer.eos_token_id
    if eos is not None and (not ids or ids[-1] != eos):
        ids.append(eos)
    return _truncate(ids, list(ids), max_seq_length)


def _truncate(ids: list, labels: list, max_seq_length: int) -> tuple:
    truncated = len(ids) > max_seq_length
    if truncated:
        ids, labels = ids[:max_seq_length], labels[:max_seq_length]
    if not any(label != IGNORE_INDEX for label in labels):
        raise _Skip("no_assistant_tokens_after_truncation" if truncated else "no_tokens")
    return Example(input_ids=ids, labels=labels), truncated


# ---------------------------------------------------------------------------
# The whole dataset
# ---------------------------------------------------------------------------


def build_examples(
    path: str,
    file_type: str,
    declared_format: str,
    tokenizer,
    max_seq_length: int,
) -> tuple:
    """Read, convert and tokenise the dataset. Returns (examples, stats).

    The format is fixed by the first row (or by DATASET_FORMAT when it is
    not "auto") and every later row is held to it, as the API's validation
    does.
    """
    if not getattr(tokenizer, "is_fast", False):
        raise BaseModelError(
            "The base model has no fast tokenizer; character offsets are needed to "
            "limit the loss to assistant turns.",
            code="tokenizer_not_fast",
        )
    stats = DatasetStats()
    examples: list = []
    row_format: str | None = None if declared_format == "auto" else declared_format
    renderer: ChatRenderer | None = None

    for number, row in read_rows(path, file_type):
        stats.total += 1
        if row_format is None:
            row_format = detect_format(row)
            if row_format == "unknown":
                raise DatasetError(
                    "The first row matches none of the supported formats "
                    "(alpaca, sharegpt, completion, text)",
                    code="dataset_unknown_format",
                    row=number,
                )
        if file_type == "csv" and row_format == "sharegpt":
            raise DatasetError(
                "The sharegpt format needs nested rows; use jsonl or parquet",
                code="dataset_format_mismatch",
                row=number,
            )
        try:
            if row_format == "text":
                text = _string(row, "text", number)
                if not text.strip():
                    raise _Skip("empty_text")
                example, truncated = tokenize_text(tokenizer, text, max_seq_length)
            else:
                messages = row_to_messages(row, row_format, number)
                if renderer is None:
                    renderer = ChatRenderer(tokenizer)
                    stats.systemFolded = renderer.fold_system
                rendered, spans = renderer.render(renderer.prepare(messages))
                example, truncated = tokenize_chat(tokenizer, rendered, spans, max_seq_length)
        except _Skip as skip:
            stats.skipped += 1
            stats.skipReasons[skip.reason] = stats.skipReasons.get(skip.reason, 0) + 1
            continue
        examples.append(example)
        stats.tokens += len(example.input_ids)
        if truncated:
            stats.truncated += 1

    stats.format = row_format or "unknown"
    stats.used = len(examples)
    if stats.total == 0:
        raise DatasetError("The dataset has no rows", code="dataset_empty")
    if not examples:
        raise DatasetError(
            f"None of the {stats.total} rows can be trained on",
            code="dataset_no_usable_rows",
            skipReasons=dict(stats.skipReasons),
        )
    return examples, stats


def split_examples(examples: list, eval_split: float | None, seed: int) -> tuple:
    """Hold out an evaluation set. With evalSplit unset, 5% is held out at
    200 rows or more and nothing below that; a held-out set never takes the
    last training row."""
    count = len(examples)
    fraction = eval_split
    if fraction is None:
        fraction = DEFAULT_EVAL_SPLIT if count >= DEFAULT_EVAL_MIN_ROWS else 0.0
    eval_count = int(count * fraction)
    if fraction > 0 and eval_count == 0 and count >= 2:
        eval_count = 1
    eval_count = min(eval_count, count - 1)
    if eval_count <= 0:
        return list(examples), []
    order = list(range(count))
    random.Random(seed).shuffle(order)
    held_out = set(order[:eval_count])
    train = [example for index, example in enumerate(examples) if index not in held_out]
    evaluation = [examples[index] for index in sorted(held_out)]
    return train, evaluation


def collate(batch: list, pad_token_id: int) -> dict:
    """Right-pad a batch to its longest row. Padding carries no loss and no
    attention, so which existing token stands in for it does not matter."""
    import torch

    width = max(len(example.input_ids) for example in batch)
    input_ids, attention, labels = [], [], []
    for example in batch:
        pad = width - len(example.input_ids)
        input_ids.append(example.input_ids + [pad_token_id] * pad)
        attention.append([1] * len(example.input_ids) + [0] * pad)
        labels.append(example.labels + [IGNORE_INDEX] * pad)
    return {
        "input_ids": torch.tensor(input_ids, dtype=torch.long),
        "attention_mask": torch.tensor(attention, dtype=torch.long),
        "labels": torch.tensor(labels, dtype=torch.long),
    }


def resolve_pad_token_id(tokenizer) -> tuple:
    """An id to pad with, taken from tokens the model already has.

    Never adds a token: a new token means resized embeddings, and an adapter
    that carries embedding weights does not load in vLLM. Returns (id, the
    existing token it was borrowed from).
    """
    if tokenizer.pad_token_id is not None:
        return tokenizer.pad_token_id, "pad"
    for name in ("eos", "unk", "bos"):
        token_id = getattr(tokenizer, f"{name}_token_id", None)
        if token_id is not None:
            # Assigning an existing token's string does not grow the vocabulary.
            tokenizer.pad_token = getattr(tokenizer, f"{name}_token")
            return token_id, name
    return 0, "id0"


def decode_supervised(tokenizer, example: Example) -> str:
    """The text the loss is computed on. For tests and for debugging a
    template by eye."""
    return tokenizer.decode([label for label in example.labels if label != IGNORE_INDEX])
