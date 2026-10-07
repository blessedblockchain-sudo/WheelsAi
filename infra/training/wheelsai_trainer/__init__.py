"""WheelsAI training container: LoRA / QLoRA fine-tuning driven by env vars.

The contract (inputs, outputs, events, callbacks, exit codes) is written
down in infra/training/README.md. Nothing in this package decides what a
run costs: it reports facts and the API classifies them.
"""

TRAINER_VERSION = "1.0.0"

# Version of the WHEELSAI_EVENT line and of the callback body.
EVENT_SCHEMA_VERSION = 1

# Version of metrics.json and of wheelsai_manifest.json.
METRICS_SCHEMA_VERSION = 1
