"""Row formats, file types, chat-template rendering and the loss mask."""

from __future__ import annotations

import csv
import json

import pytest

from conftest import SILENT_TEMPLATE, STRICT_TEMPLATE, fixture_rows, make_tokenizer
from wheelsai_trainer.data import (
    IGNORE_INDEX,
    ChatRenderer,
    build_examples,
    collate,
    decode_supervised,
    detect_format,
    read_rows,
    resolve_pad_token_id,
    split_examples,
)
from wheelsai_trainer.errors import EXIT_BASE_MODEL, EXIT_DATASET, BaseModelError, DatasetError


@pytest.fixture(scope="module")
def tokenizer():
    return make_tokenizer()


@pytest.fixture(scope="module")
def strict_tokenizer():
    return make_tokenizer(STRICT_TEMPLATE, strict=True)


def write_jsonl(path, rows) -> str:
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    return str(path)


def write_csv(path, header, rows) -> str:
    with open(path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)
    return str(path)


def write_parquet(path, rows) -> str:
    import pyarrow as pa
    import pyarrow.parquet as pq

    pq.write_table(pa.Table.from_pylist(rows), str(path))
    return str(path)


def build(path, file_type, tokenizer, declared="auto", max_len=128):
    return build_examples(path, file_type, declared, tokenizer, max_len)


# --- detection ------------------------------------------------------------


def test_detection_follows_the_api_order():
    assert detect_format({"instruction": "a", "output": "b"}) == "alpaca"
    assert detect_format({"conversations": []}) == "sharegpt"
    assert detect_format({"conversations": "not a list", "text": "t"}) == "text"
    assert detect_format({"prompt": "a", "completion": "b"}) == "completion"
    assert detect_format({"text": "a"}) == "text"
    assert detect_format({"question": "a"}) == "unknown"
    # alpaca wins over text when a row carries both, as in dataset.ts
    assert detect_format({"instruction": "a", "output": "b", "text": "c"}) == "alpaca"


# --- the four formats -----------------------------------------------------


def test_alpaca_jsonl_trains_on_the_answer_and_the_end_marker_only(tmp_path, tokenizer):
    rows = fixture_rows()
    examples, stats = build(write_jsonl(tmp_path / "d.jsonl", rows), "jsonl", tokenizer)
    assert stats.format == "alpaca"
    assert (stats.total, stats.used, stats.skipped, stats.truncated) == (40, 40, 0, 0)
    assert stats.tokens == sum(len(e.input_ids) for e in examples)
    first = examples[0]
    assert len(first.input_ids) == len(first.labels)
    # The supervised text is exactly the assistant turn up to its end marker.
    assert decode_supervised(tokenizer, first) == rows[0]["output"] + "<|im_end|>\n"
    whole = tokenizer.decode(first.input_ids)
    assert whole == (
        "<|im_start|>user\n" + rows[0]["instruction"] + "\n\n" + rows[0]["input"] + "<|im_end|>\n"
        "<|im_start|>assistant\n" + rows[0]["output"] + "<|im_end|>\n"
    )
    # The prompt, including the generation prompt, carries no loss.
    masked = [t for t, label in zip(first.input_ids, first.labels) if label == IGNORE_INDEX]
    assert tokenizer.decode(masked).endswith("<|im_start|>assistant\n")
    # An alpaca row without "input" has no blank separator in the prompt.
    no_input = next(i for i, row in enumerate(rows) if "input" not in row)
    assert "\n\n" not in tokenizer.decode(examples[no_input].input_ids)


def test_sharegpt_supervises_every_assistant_turn_and_drops_a_trailing_question(tmp_path, tokenizer):
    rows = [
        {
            "conversations": [
                {"from": "system", "value": "Answer in one line."},
                {"from": "human", "value": "Add 2 and 3"},
                {"from": "gpt", "value": "2 plus 3 is 5."},
                {"from": "human", "value": "Square the number 4"},
                {"from": "gpt", "value": "4 squared is 16."},
                {"from": "human", "value": "Add 9 and 9"},
            ]
        }
    ]
    examples, stats = build(write_jsonl(tmp_path / "d.jsonl", rows), "jsonl", tokenizer)
    assert stats.format == "sharegpt" and stats.systemFolded is False
    example = examples[0]
    assert decode_supervised(tokenizer, example) == "2 plus 3 is 5.<|im_end|>\n4 squared is 16.<|im_end|>\n"
    whole = tokenizer.decode(example.input_ids)
    assert whole.startswith("<|im_start|>system\nAnswer in one line.<|im_end|>\n")
    assert "Add 9 and 9" not in whole


def test_completion_rows_become_a_user_and_an_assistant_turn(tmp_path, tokenizer):
    rows = [{"prompt": "Add 2 and 3", "completion": "2 plus 3 is 5."}]
    examples, stats = build(write_jsonl(tmp_path / "d.jsonl", rows), "jsonl", tokenizer)
    assert stats.format == "completion"
    assert decode_supervised(tokenizer, examples[0]) == "2 plus 3 is 5.<|im_end|>\n"
    assert tokenizer.decode(examples[0].input_ids).startswith("<|im_start|>user\nAdd 2 and 3<|im_end|>")


def test_text_rows_are_plain_causal_lm_ending_in_eos(tmp_path, tokenizer):
    rows = [{"text": "the capital of Peru is Lima."}]
    examples, stats = build(write_jsonl(tmp_path / "d.jsonl", rows), "jsonl", tokenizer)
    assert stats.format == "text"
    example = examples[0]
    assert example.labels == example.input_ids
    assert example.input_ids[-1] == tokenizer.eos_token_id
    assert tokenizer.decode(example.input_ids[:-1]) == rows[0]["text"]


def test_text_format_needs_no_chat_template(tmp_path):
    bare = make_tokenizer(template=None)
    examples, _ = build(write_jsonl(tmp_path / "d.jsonl", [{"text": "Add 2 and 3"}]), "jsonl", bare)
    assert len(examples) == 1
    with pytest.raises(BaseModelError) as caught:
        build(write_jsonl(tmp_path / "c.jsonl", [{"prompt": "a", "completion": "b"}]), "jsonl", bare)
    assert caught.value.exit_code == EXIT_BASE_MODEL and caught.value.code == "no_chat_template"


# --- file types -----------------------------------------------------------


def test_csv_completion_and_text_by_header(tmp_path, tokenizer):
    path = write_csv(
        tmp_path / "c.csv",
        ["prompt", "completion"],
        [["Add 2 and 3", "2 plus 3 is 5."], ['Say "hi", twice', "hi,\nhi"]],
    )
    examples, stats = build(path, "csv", tokenizer)
    assert stats.format == "completion" and stats.used == 2
    # A quoted cell with a comma and a line break is one value.
    assert decode_supervised(tokenizer, examples[1]) == "hi,\nhi<|im_end|>\n"

    path = write_csv(tmp_path / "t.csv", ["id", "text"], [["1", "Add 2 and 3"], ["2", "Square the number 4"]])
    examples, stats = build(path, "csv", tokenizer)
    assert stats.format == "text" and stats.used == 2


def test_csv_alpaca_by_header_and_an_empty_input_cell(tmp_path, tokenizer):
    path = write_csv(
        tmp_path / "a.csv",
        ["instruction", "input", "output"],
        [["Add 2 and 3", "", "2 plus 3 is 5."]],
    )
    examples, stats = build(path, "csv", tokenizer)
    assert stats.format == "alpaca"
    assert tokenizer.decode(examples[0].input_ids).startswith("<|im_start|>user\nAdd 2 and 3<|im_end|>")


def test_parquet_reads_flat_and_nested_rows(tmp_path, tokenizer):
    rows = fixture_rows()[:12]
    for row in rows:
        row.setdefault("input", None)  # a nullable column, as Parquet stores a missing field
    examples, stats = build(write_parquet(tmp_path / "a.parquet", rows), "parquet", tokenizer)
    assert stats.format == "alpaca" and stats.used == 12
    assert decode_supervised(tokenizer, examples[0]) == rows[0]["output"] + "<|im_end|>\n"

    nested = [
        {"conversations": [{"from": "human", "value": "Add 2 and 3"}, {"from": "gpt", "value": "2 plus 3 is 5."}]}
    ] * 3
    examples, stats = build(write_parquet(tmp_path / "s.parquet", nested), "parquet", tokenizer)
    assert stats.format == "sharegpt" and stats.used == 3


def test_jsonl_tolerates_blank_lines_and_a_byte_order_mark(tmp_path, tokenizer):
    path = tmp_path / "d.jsonl"
    path.write_bytes(b"\xef\xbb\xbf" + b'{"text": "Add 2 and 3"}\n\n   \n{"text": "Square the number 4"}\n')
    assert [number for number, _ in read_rows(str(path), "jsonl")] == [1, 4]
    _, stats = build(str(path), "jsonl", tokenizer)
    assert stats.total == 2


# --- templates ------------------------------------------------------------


def test_a_template_that_rejects_the_system_role_gets_it_folded_into_the_first_user_turn(
    tmp_path, strict_tokenizer
):
    assert ChatRenderer(strict_tokenizer).fold_system is True
    rows = [
        {
            "conversations": [
                {"from": "system", "value": "Answer in one line."},
                {"from": "human", "value": "Add 2 and 3"},
                {"from": "gpt", "value": "2 plus 3 is 5."},
                {"from": "human", "value": "Square the number 4"},
                {"from": "gpt", "value": "4 squared is 16."},
            ]
        }
    ]
    examples, stats = build(write_jsonl(tmp_path / "d.jsonl", rows), "jsonl", strict_tokenizer)
    assert stats.systemFolded is True and stats.used == 1
    whole = strict_tokenizer.decode(examples[0].input_ids)
    assert whole == (
        "<s>[INST] Answer in one line.\n\nAdd 2 and 3 [/INST] 2 plus 3 is 5.</s>"
        "[INST] Square the number 4 [/INST] 4 squared is 16.</s>"
    )
    assert decode_supervised(strict_tokenizer, examples[0]) == " 2 plus 3 is 5.</s> 4 squared is 16.</s>"


def test_a_template_that_silently_drops_the_system_role_is_folded_too(tmp_path):
    silent = make_tokenizer(SILENT_TEMPLATE)
    assert ChatRenderer(silent).fold_system is True
    rows = [
        {
            "conversations": [
                {"from": "system", "value": "Answer in one line."},
                {"from": "human", "value": "Add 2 and 3"},
                {"from": "gpt", "value": "2 plus 3 is 5."},
            ]
        }
    ]
    examples, _ = build(write_jsonl(tmp_path / "d.jsonl", rows), "jsonl", silent)
    assert "Answer in one line.\n\nAdd 2 and 3" in silent.decode(examples[0].input_ids)


def test_a_template_with_a_system_role_keeps_it_as_a_system_turn(tokenizer):
    assert ChatRenderer(tokenizer).fold_system is False


def test_rows_the_template_refuses_are_skipped_and_counted(tmp_path, strict_tokenizer):
    rows = [
        {"conversations": [{"from": "human", "value": "Add 2 and 3"}, {"from": "gpt", "value": "5."}]},
        # Two user turns in a row: the strict template raises.
        {
            "conversations": [
                {"from": "human", "value": "Add 2 and 3"},
                {"from": "human", "value": "Add 9 and 9"},
                {"from": "gpt", "value": "5."},
            ]
        },
    ]
    _, stats = build(write_jsonl(tmp_path / "d.jsonl", rows), "jsonl", strict_tokenizer)
    assert (stats.total, stats.used, stats.skipped) == (2, 1, 1)
    assert stats.skipReasons == {"template_rejected": 1}


# --- tokens are never added ------------------------------------------------


def test_a_tokenizer_without_a_pad_token_borrows_an_existing_one(tokenizer):
    fresh = make_tokenizer()
    assert fresh.pad_token is None
    size = len(fresh)
    pad_id, source = resolve_pad_token_id(fresh)
    assert source == "eos" and pad_id == fresh.eos_token_id
    assert fresh.pad_token == fresh.eos_token
    assert len(fresh) == size, "the vocabulary must not grow"


def test_an_existing_pad_token_is_kept():
    padded = make_tokenizer(pad="<|endoftext|>")
    pad_id, source = resolve_pad_token_id(padded)
    assert source == "pad" and pad_id == padded.convert_tokens_to_ids("<|endoftext|>")


def test_collate_pads_right_with_no_loss_and_no_attention(tmp_path, tokenizer):
    examples, _ = build(write_jsonl(tmp_path / "d.jsonl", fixture_rows()[:4]), "jsonl", tokenizer)
    batch = collate(examples, pad_token_id=7)
    width = max(len(e.input_ids) for e in examples)
    assert tuple(batch["input_ids"].shape) == (4, width)
    for row, example in enumerate(examples):
        size = len(example.input_ids)
        assert batch["attention_mask"][row].tolist() == [1] * size + [0] * (width - size)
        assert batch["labels"][row, size:].tolist() == [IGNORE_INDEX] * (width - size)
        assert batch["input_ids"][row, size:].tolist() == [7] * (width - size)


# --- truncation and skipping ----------------------------------------------


def test_long_rows_are_truncated_and_counted(tmp_path, tokenizer):
    rows = [{"instruction": "Add 2 and 3", "output": "2 plus 3 is 5. " * 40}, fixture_rows()[0]]
    examples, stats = build(write_jsonl(tmp_path / "d.jsonl", rows), "jsonl", tokenizer, max_len=128)
    assert stats.truncated == 1 and stats.used == 2
    assert len(examples[0].input_ids) == 128


def test_a_row_whose_answer_falls_outside_the_window_is_skipped(tmp_path, tokenizer):
    rows = [{"instruction": "Add 2 and 3. " * 60, "output": "5."}, fixture_rows()[0]]
    _, stats = build(write_jsonl(tmp_path / "d.jsonl", rows), "jsonl", tokenizer, max_len=128)
    assert (stats.used, stats.skipped) == (1, 1)
    assert stats.skipReasons == {"no_assistant_tokens_after_truncation": 1}


def test_empty_answers_are_skipped_not_fatal(tmp_path, tokenizer):
    rows = [
        {"instruction": "Add 2 and 3", "output": "  "},
        {"instruction": "", "output": "5."},
        {"instruction": "Add 2 and 3", "output": "5."},
    ]
    _, stats = build(write_jsonl(tmp_path / "d.jsonl", rows), "jsonl", tokenizer)
    assert (stats.total, stats.used, stats.skipped) == (3, 1, 2)
    assert stats.skipReasons == {"empty_answer": 1, "empty_prompt": 1}


def test_a_conversation_without_an_assistant_turn_is_skipped(tmp_path, tokenizer):
    rows = [
        {"conversations": [{"from": "human", "value": "Add 2 and 3"}]},
        {"conversations": [{"from": "human", "value": "Add 2 and 3"}, {"from": "gpt", "value": "5."}]},
    ]
    _, stats = build(write_jsonl(tmp_path / "d.jsonl", rows), "jsonl", tokenizer)
    assert stats.skipReasons == {"no_assistant_turn": 1}


# --- exit 11 --------------------------------------------------------------


def expect_dataset_error(code, path, file_type, tokenizer, declared="auto"):
    with pytest.raises(DatasetError) as caught:
        build(path, file_type, tokenizer, declared)
    assert caught.value.exit_code == EXIT_DATASET
    assert caught.value.code == code
    return caught.value


def test_an_empty_file_is_a_dataset_error(tmp_path, tokenizer):
    path = tmp_path / "d.jsonl"
    path.write_text("\n\n", encoding="utf-8")
    expect_dataset_error("dataset_empty", str(path), "jsonl", tokenizer)
    header_only = write_csv(tmp_path / "h.csv", ["prompt", "completion"], [])
    expect_dataset_error("dataset_empty", header_only, "csv", tokenizer)


def test_no_usable_row_is_a_dataset_error(tmp_path, tokenizer):
    path = write_jsonl(tmp_path / "d.jsonl", [{"instruction": "Add 2 and 3", "output": ""}] * 3)
    error = expect_dataset_error("dataset_no_usable_rows", path, "jsonl", tokenizer)
    assert error.details["skipReasons"] == {"empty_answer": 3}


def test_malformed_json_names_the_row(tmp_path, tokenizer):
    path = tmp_path / "d.jsonl"
    path.write_text('{"text": "Add 2 and 3"}\n{"text": \n', encoding="utf-8")
    error = expect_dataset_error("dataset_parse_error", str(path), "jsonl", tokenizer)
    assert error.details["row"] == 2
    path.write_text('["a", "b"]\n', encoding="utf-8")
    assert expect_dataset_error("dataset_parse_error", str(path), "jsonl", tokenizer).details["row"] == 1


def test_bytes_that_are_not_utf8_are_a_dataset_error(tmp_path, tokenizer):
    path = tmp_path / "d.jsonl"
    path.write_bytes(b'{"text": "\xff\xfe"}\n')
    expect_dataset_error("dataset_parse_error", str(path), "jsonl", tokenizer)


def test_an_unknown_first_row_is_a_dataset_error(tmp_path, tokenizer):
    path = write_jsonl(tmp_path / "d.jsonl", [{"question": "a", "answer": "b"}])
    expect_dataset_error("dataset_unknown_format", path, "jsonl", tokenizer)


def test_a_later_row_that_breaks_the_format_fails_with_its_number(tmp_path, tokenizer):
    rows = [{"instruction": "Add 2 and 3", "output": "5."}, {"instruction": "Add 2 and 3"}]
    error = expect_dataset_error("dataset_row_invalid", write_jsonl(tmp_path / "a.jsonl", rows), "jsonl", tokenizer)
    assert (error.details["row"], error.details["field"]) == (2, "output")

    rows = [{"instruction": "Add 2 and 3", "output": 5}]
    expect_dataset_error("dataset_row_invalid", write_jsonl(tmp_path / "b.jsonl", rows), "jsonl", tokenizer)

    rows = [{"conversations": [{"from": "user", "value": "hello"}]}]
    error = expect_dataset_error("dataset_row_invalid", write_jsonl(tmp_path / "c.jsonl", rows), "jsonl", tokenizer)
    assert error.details["field"] == "conversations[0].from"

    rows = [{"conversations": [{"from": "human"}]}]
    expect_dataset_error("dataset_row_invalid", write_jsonl(tmp_path / "e.jsonl", rows), "jsonl", tokenizer)


def test_a_declared_format_is_enforced_instead_of_detected(tmp_path, tokenizer):
    path = write_jsonl(tmp_path / "d.jsonl", [{"text": "Add 2 and 3"}])
    error = expect_dataset_error("dataset_row_invalid", path, "jsonl", tokenizer, declared="alpaca")
    assert error.details["field"] == "instruction"
    # A row with both shapes is read as declared, not as detection would.
    both = write_jsonl(tmp_path / "b.jsonl", [{"instruction": "Add 2 and 3", "output": "5.", "text": "Lima"}])
    examples, stats = build(both, "jsonl", tokenizer, declared="text")
    assert stats.format == "text" and examples[0].labels == examples[0].input_ids


def test_csv_with_a_short_row_names_the_line(tmp_path, tokenizer):
    path = tmp_path / "c.csv"
    path.write_text("prompt,completion\nAdd 2 and 3,5.\nonly one cell\n", encoding="utf-8")
    assert expect_dataset_error("dataset_parse_error", str(path), "csv", tokenizer).details["row"] == 3


def test_sharegpt_cannot_come_from_csv(tmp_path, tokenizer):
    path = write_csv(tmp_path / "c.csv", ["conversations"], [["[]"]])
    expect_dataset_error("dataset_format_mismatch", path, "csv", tokenizer, declared="sharegpt")


def test_a_file_that_is_not_parquet_is_a_dataset_error(tmp_path, tokenizer):
    path = tmp_path / "d.parquet"
    path.write_bytes(b"PAR1 this is not really parquet")
    expect_dataset_error("dataset_parse_error", str(path), "parquet", tokenizer)


# --- split ----------------------------------------------------------------


def test_split_defaults_to_five_percent_from_two_hundred_rows():
    assert [len(part) for part in split_examples(list(range(199)), None, 42)] == [199, 0]
    assert [len(part) for part in split_examples(list(range(200)), None, 42)] == [190, 10]


def test_split_is_deterministic_disjoint_and_never_empties_training():
    items = list(range(40))
    train, held_out = split_examples(items, 0.1, 42)
    assert len(held_out) == 4 and sorted(train + held_out) == items
    assert split_examples(items, 0.1, 42) == (train, held_out)
    assert split_examples(items, 0.1, 43)[1] != held_out
    assert [len(part) for part in split_examples(items, 0, 42)] == [40, 0]
    # A small set with a split asked for still gets one row, never all of them.
    assert [len(part) for part in split_examples([1, 2, 3], 0.2, 42)] == [2, 1]
    assert [len(part) for part in split_examples([1], 0.2, 42)] == [1, 0]
