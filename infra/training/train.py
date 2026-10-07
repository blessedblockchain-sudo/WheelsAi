#!/usr/bin/env python
"""Entry point of the WheelsAI training image (ENTRYPOINT in the Dockerfile).

Everything a run needs arrives in environment variables; see README.md for
the contract. The exit code is the result:

    0 success                 12 base model error      20 artifact upload failed
    1 unexpected              13 out of memory         30 interrupted (SIGTERM)
    10 invalid configuration  14 training diverged
    11 dataset error
"""

import os
import sys

# One tokenizer process is enough, and the fork warning it prints otherwise
# would sit between two event lines.
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
# A multi-gigabyte download redraws its progress bar thousands of times; the
# job log is where the events are read from, so keep it to the events.
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from wheelsai_trainer.runner import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
