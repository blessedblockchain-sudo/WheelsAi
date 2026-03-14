// Training Job Service for WheelsAI
// Handles LoRA/QLoRA fine-tuning jobs on Nosana GPUs

import { createLogger } from "../utils/logger.js";

const logger = createLogger("training-service");

// ============================================
// Types
// ============================================

export interface TrainingConfig {
  // Base model
  baseModelId: string;
  baseModelHfId: string;

  // Dataset
  datasetUrl: string;
  datasetFormat: "jsonl" | "csv" | "parquet" | "alpaca" | "sharegpt";

  // Training method
  method: "lora" | "qlora" | "full";

  // Hyperparameters
  epochs: number;
  batchSize: number;
  learningRate: number;
  warmupSteps: number;
  gradientAccumulationSteps: number;

  // LoRA specific
  loraR?: number;
  loraAlpha?: number;
  loraDropout?: number;
  targetModules?: string[];

  // QLoRA specific
  quantizationBits?: 4 | 8;

  // Output
  outputPath: string;
  webhookUrl?: string;
}

export interface NosanaTrainingJob {
  version: string;
  type: string;
  meta: {
    trigger: string;
  };
  ops: Array<{
    type: string;
    id: string;
    args?: Record<string, any>;
  }>;
}

// ============================================
// Default Hyperparameters
// ============================================

const DEFAULT_LORA_CONFIG = {
  loraR: 16,
  loraAlpha: 32,
  loraDropout: 0.05,
  targetModules: ["q_proj", "v_proj", "k_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
};

const DEFAULT_QLORA_CONFIG = {
  ...DEFAULT_LORA_CONFIG,
  quantizationBits: 4 as const,
};

const DEFAULT_TRAINING_CONFIG = {
  epochs: 3,
  batchSize: 4,
  learningRate: 2e-4,
  warmupSteps: 100,
  gradientAccumulationSteps: 4,
};

// ============================================
// GPU Requirements by Model Size
// ============================================

const GPU_REQUIREMENTS: Record<string, { minVram: number; recommendedTier: string }> = {
  // 7B models
  "llama-3.1-8b": { minVram: 24, recommendedTier: "rtx-4090" },
  "mistral-7b": { minVram: 24, recommendedTier: "rtx-4090" },
  "qwen2.5-7b": { minVram: 24, recommendedTier: "rtx-4090" },

  // 13-14B models
  "llama-2-13b": { minVram: 48, recommendedTier: "a100-40gb" },
  "qwen2.5-14b": { minVram: 48, recommendedTier: "a100-40gb" },

  // 70B models (QLoRA only)
  "llama-3.1-70b": { minVram: 80, recommendedTier: "a100-80gb" },
  "qwen2.5-72b": { minVram: 80, recommendedTier: "a100-80gb" },
};

// ============================================
// Job Generation
// ============================================

export function generateTrainingJobDefinition(config: TrainingConfig): NosanaTrainingJob {
  const {
    baseModelHfId,
    datasetUrl,
    datasetFormat,
    method,
    epochs,
    batchSize,
    learningRate,
    warmupSteps,
    gradientAccumulationSteps,
    loraR,
    loraAlpha,
    loraDropout,
    targetModules,
    quantizationBits,
    outputPath,
    webhookUrl,
  } = config;

  // Build training script based on method
  const trainingScript = buildTrainingScript({
    ...config,
    loraR: loraR ?? DEFAULT_LORA_CONFIG.loraR,
    loraAlpha: loraAlpha ?? DEFAULT_LORA_CONFIG.loraAlpha,
    loraDropout: loraDropout ?? DEFAULT_LORA_CONFIG.loraDropout,
    targetModules: targetModules ?? DEFAULT_LORA_CONFIG.targetModules,
    quantizationBits: quantizationBits ?? DEFAULT_QLORA_CONFIG.quantizationBits,
  });

  // Build environment variables
  const envVars: Record<string, string> = {
    HF_HOME: "/workspace/.cache/huggingface",
    TRANSFORMERS_CACHE: "/workspace/.cache/huggingface/transformers",
    WANDB_DISABLED: "true",
    BASE_MODEL: baseModelHfId,
    DATASET_URL: datasetUrl,
    DATASET_FORMAT: datasetFormat,
    OUTPUT_PATH: outputPath,
    TRAINING_METHOD: method,
    EPOCHS: epochs.toString(),
    BATCH_SIZE: batchSize.toString(),
    LEARNING_RATE: learningRate.toString(),
    WARMUP_STEPS: warmupSteps.toString(),
    GRADIENT_ACCUMULATION_STEPS: gradientAccumulationSteps.toString(),
  };

  if (method === "lora" || method === "qlora") {
    envVars.LORA_R = (loraR ?? DEFAULT_LORA_CONFIG.loraR).toString();
    envVars.LORA_ALPHA = (loraAlpha ?? DEFAULT_LORA_CONFIG.loraAlpha).toString();
    envVars.LORA_DROPOUT = (loraDropout ?? DEFAULT_LORA_CONFIG.loraDropout).toString();
    envVars.TARGET_MODULES = (targetModules ?? DEFAULT_LORA_CONFIG.targetModules).join(",");
  }

  if (method === "qlora") {
    envVars.QUANTIZATION_BITS = (quantizationBits ?? 4).toString();
  }

  if (webhookUrl) {
    envVars.WEBHOOK_URL = webhookUrl;
  }

  // Docker image based on method
  const dockerImage = method === "qlora"
    ? "ghcr.io/wheelsai/training-qlora:latest"
    : "ghcr.io/wheelsai/training-lora:latest";

  return {
    version: "0.1",
    type: "batch",
    meta: {
      trigger: "wheelsai-training",
    },
    ops: [
      {
        type: "container/run",
        id: "training",
        args: {
          image: dockerImage,
          gpu: true,
          env: envVars,
          cmd: ["python", "/app/train.py"],
          volumes: [
            {
              name: "model-cache",
              dest: "/workspace/.cache",
            },
            {
              name: "output",
              dest: "/workspace/output",
            },
          ],
        },
      },
      {
        type: "container/run",
        id: "upload",
        args: {
          image: "ghcr.io/wheelsai/s3-upload:latest",
          cmd: [
            "aws", "s3", "cp",
            "--recursive",
            "/workspace/output",
            outputPath,
          ],
          env: {
            AWS_DEFAULT_REGION: "us-east-1",
          },
        },
      },
    ],
  };
}

// ============================================
// Training Script Builder
// ============================================

function buildTrainingScript(config: TrainingConfig & {
  loraR: number;
  loraAlpha: number;
  loraDropout: number;
  targetModules: string[];
  quantizationBits: number;
}): string {
  const {
    method,
    baseModelHfId,
    epochs,
    batchSize,
    learningRate,
    warmupSteps,
    gradientAccumulationSteps,
    loraR,
    loraAlpha,
    loraDropout,
    targetModules,
    quantizationBits,
  } = config;

  if (method === "qlora") {
    return `
import os
import torch
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    TrainingArguments,
)
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from trl import SFTTrainer
from datasets import load_dataset

# Load dataset
dataset = load_dataset("json", data_files=os.environ["DATASET_URL"], split="train")

# Quantization config
bnb_config = BitsAndBytesConfig(
    load_in_${quantizationBits}bit=True,
    bnb_${quantizationBits}bit_quant_type="nf4",
    bnb_${quantizationBits}bit_compute_dtype=torch.bfloat16,
    bnb_${quantizationBits}bit_use_double_quant=True,
)

# Load model
model = AutoModelForCausalLM.from_pretrained(
    "${baseModelHfId}",
    quantization_config=bnb_config,
    device_map="auto",
    trust_remote_code=True,
)
model = prepare_model_for_kbit_training(model)

tokenizer = AutoTokenizer.from_pretrained("${baseModelHfId}")
tokenizer.pad_token = tokenizer.eos_token

# LoRA config
lora_config = LoraConfig(
    r=${loraR},
    lora_alpha=${loraAlpha},
    lora_dropout=${loraDropout},
    target_modules=${JSON.stringify(targetModules)},
    bias="none",
    task_type="CAUSAL_LM",
)

model = get_peft_model(model, lora_config)

# Training arguments
training_args = TrainingArguments(
    output_dir="/workspace/output",
    num_train_epochs=${epochs},
    per_device_train_batch_size=${batchSize},
    gradient_accumulation_steps=${gradientAccumulationSteps},
    learning_rate=${learningRate},
    warmup_steps=${warmupSteps},
    logging_steps=10,
    save_strategy="epoch",
    bf16=True,
    optim="paged_adamw_8bit",
)

# Train
trainer = SFTTrainer(
    model=model,
    train_dataset=dataset,
    tokenizer=tokenizer,
    args=training_args,
    dataset_text_field="text",
    max_seq_length=2048,
)

trainer.train()
trainer.save_model("/workspace/output/adapter")
`;
  }

  // Standard LoRA training
  return `
import os
import torch
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    TrainingArguments,
)
from peft import LoraConfig, get_peft_model
from trl import SFTTrainer
from datasets import load_dataset

# Load dataset
dataset = load_dataset("json", data_files=os.environ["DATASET_URL"], split="train")

# Load model
model = AutoModelForCausalLM.from_pretrained(
    "${baseModelHfId}",
    torch_dtype=torch.bfloat16,
    device_map="auto",
    trust_remote_code=True,
)

tokenizer = AutoTokenizer.from_pretrained("${baseModelHfId}")
tokenizer.pad_token = tokenizer.eos_token

# LoRA config
lora_config = LoraConfig(
    r=${loraR},
    lora_alpha=${loraAlpha},
    lora_dropout=${loraDropout},
    target_modules=${JSON.stringify(targetModules)},
    bias="none",
    task_type="CAUSAL_LM",
)

model = get_peft_model(model, lora_config)

# Training arguments
training_args = TrainingArguments(
    output_dir="/workspace/output",
    num_train_epochs=${epochs},
    per_device_train_batch_size=${batchSize},
    gradient_accumulation_steps=${gradientAccumulationSteps},
    learning_rate=${learningRate},
    warmup_steps=${warmupSteps},
    logging_steps=10,
    save_strategy="epoch",
    bf16=True,
)

# Train
trainer = SFTTrainer(
    model=model,
    train_dataset=dataset,
    tokenizer=tokenizer,
    args=training_args,
    dataset_text_field="text",
    max_seq_length=2048,
)

trainer.train()
trainer.save_model("/workspace/output/adapter")
`;
}

// ============================================
// Cost Estimation
// ============================================

interface CostEstimate {
  gpuHours: number;
  costPerHour: number;
  totalCostCents: number;
}

const GPU_PRICING: Record<string, number> = {
  "rtx-3060": 20, // $0.20/hr in cents
  "rtx-4070": 35,
  "rtx-4090": 50,
  "a100-40gb": 150,
  "a100-80gb": 250,
  "h100": 350,
};

export function estimateTrainingCost(
  modelId: string,
  method: "lora" | "qlora" | "full",
  datasetRows: number,
  epochs: number,
  gpuTier: string
): CostEstimate {
  // Estimate tokens per row (average)
  const tokensPerRow = 500;
  const totalTokens = datasetRows * tokensPerRow;

  // Tokens processed per hour (rough estimates)
  const tokensPerHour: Record<string, number> = {
    "lora": 50000,
    "qlora": 30000, // Slower due to quantization
    "full": 20000, // Slowest
  };

  // Calculate training hours
  const trainingTokens = totalTokens * epochs;
  const throughput = tokensPerHour[method] ?? tokensPerHour.lora ?? 50000;
  const gpuHours = trainingTokens / throughput;

  // Get cost per hour
  const costPerHour = GPU_PRICING[gpuTier] || 50;

  return {
    gpuHours: Math.ceil(gpuHours * 10) / 10, // Round to 0.1
    costPerHour,
    totalCostCents: Math.ceil(gpuHours * costPerHour),
  };
}

// ============================================
// GPU Recommendation
// ============================================

export function recommendGpuTier(
  modelId: string,
  method: "lora" | "qlora" | "full"
): { tier: string; minVram: number } {
  const requirements = GPU_REQUIREMENTS[modelId];

  if (!requirements) {
    // Default recommendation
    return { tier: "rtx-4090", minVram: 24 };
  }

  // QLoRA can use smaller GPUs
  if (method === "qlora") {
    return {
      tier: requirements.minVram > 48 ? "a100-40gb" : "rtx-4090",
      minVram: Math.ceil(requirements.minVram * 0.4), // QLoRA uses ~40% of full VRAM
    };
  }

  return { tier: requirements.recommendedTier, minVram: requirements.minVram };
}

// ============================================
// Training Status Parsing
// ============================================

export interface TrainingProgress {
  currentStep: number;
  totalSteps: number;
  currentEpoch: number;
  totalEpochs: number;
  trainingLoss: number | null;
  evalLoss: number | null;
  learningRate: number;
  estimatedTimeRemaining: string | null;
}

export function parseTrainingLogs(logs: string): TrainingProgress | null {
  try {
    // Parse training logs for progress info
    const lines = logs.split("\n").filter(Boolean);
    const lastProgressLine = lines
      .reverse()
      .find((l) => l.includes("{'loss':") || l.includes("step"));

    if (!lastProgressLine) {
      return null;
    }

    // Try to extract JSON metrics
    const jsonMatch = lastProgressLine.match(/\{.*\}/);
    if (jsonMatch) {
      const metrics = JSON.parse(jsonMatch[0]);
      return {
        currentStep: metrics.step || 0,
        totalSteps: metrics.total_steps || 0,
        currentEpoch: metrics.epoch || 0,
        totalEpochs: metrics.total_epochs || 0,
        trainingLoss: metrics.loss || null,
        evalLoss: metrics.eval_loss || null,
        learningRate: metrics.learning_rate || 0,
        estimatedTimeRemaining: null,
      };
    }

    return null;
  } catch (error) {
    logger.error({ error }, "Failed to parse training logs");
    return null;
  }
}

// ============================================
// Dataset Format Conversion
// ============================================

export function getDatasetFormatInstructions(format: string): string {
  switch (format) {
    case "alpaca":
      return `Alpaca format expects JSONL with fields: instruction, input (optional), output
Example: {"instruction": "Summarize this text", "input": "Long text here...", "output": "Summary here"}`;

    case "sharegpt":
      return `ShareGPT format expects JSONL with conversations array
Example: {"conversations": [{"from": "human", "value": "Hello"}, {"from": "gpt", "value": "Hi!"}]}`;

    case "jsonl":
      return `Standard JSONL with a "text" field containing the full training example
Example: {"text": "Below is an instruction...\\n\\n### Response:\\nThe answer is..."}`;

    case "csv":
      return `CSV with columns: prompt, completion (or text for single column)`;

    case "parquet":
      return `Parquet file with same schema as JSONL/CSV formats`;

    default:
      return "Unknown format";
  }
}

export {
  DEFAULT_LORA_CONFIG,
  DEFAULT_QLORA_CONFIG,
  DEFAULT_TRAINING_CONFIG,
  GPU_REQUIREMENTS,
  GPU_PRICING,
};
