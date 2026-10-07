"""Loads a base model with and without a LoRA adapter and answers one prompt.

Used by run-fine-tune-local-proof.ts on the adapter directory that the
deployment's own bootstrap extracted, to show that what the pipeline stored
is an adapter that loads and changes the model's answers. It runs on CPU with
peft; it is not vLLM and says nothing about serving on a GPU.

    python fine-tune-local-proof-generate.py <base model> <adapter dir> <prompt>
"""

import sys


def generate(model, tokenizer, prompt: str) -> str:
    import torch

    text = tokenizer.apply_chat_template(
        [{"role": "user", "content": prompt}], tokenize=False, add_generation_prompt=True
    )
    encoded = tokenizer(text, return_tensors="pt", add_special_tokens=False)
    with torch.no_grad():
        output = model.generate(
            input_ids=encoded["input_ids"],
            attention_mask=encoded["attention_mask"],
            max_new_tokens=32,
            do_sample=False,
            pad_token_id=tokenizer.eos_token_id,
        )
    return tokenizer.decode(output[0, encoded["input_ids"].shape[1] :], skip_special_tokens=True).strip()


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__)
        return 2
    base_model, adapter_dir, prompt = sys.argv[1:]

    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(base_model)
    model = AutoModelForCausalLM.from_pretrained(base_model)
    print(f"prompt     {prompt}")
    print(f"base       {generate(model, tokenizer, prompt)!r}")
    tuned = PeftModel.from_pretrained(model, adapter_dir)
    tuned.eval()
    print(f"adapter    {generate(tuned, tokenizer, prompt)!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
