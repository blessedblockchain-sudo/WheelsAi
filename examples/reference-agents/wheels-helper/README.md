# WheelsHelper — reference ElizaOS agent

WheelsHelper is the platform's reference agent. We deploy it on our own
infrastructure to:

1. **Demonstrate the full build → deploy → tokenize → auto-pay loop**
   live for prospective builders.
2. **Dogfood every layer** — if WheelsHelper goes down or runs out of
   runway, the team knows about it before any customer does.
3. **Carry the "agents that pay for their own compute" narrative** —
   the tokenholders fund the bot they talk to.

## Files

| Path | What it is |
|---|---|
| `character.json` | ElizaOS character file. Personality, model provider, clients, plugins. Validated by `parseElizaCharacter` in CI. |
| `README.md` | This file. |

## What gets deployed

When the launch wizard processes `character.json`:

- **Model:** Claude Haiku 4.5 via Anthropic API (Eliza's `modelProvider: anthropic`)
- **Clients (channels):** Discord + Telegram, both inbound — replies routed
  through the WheelsAI channel-webhooks pipeline (plan A6)
- **GPU tier:** RTX 4070 (`nosana.MARKETS["4070"]`); demo runs on RTX 3060
- **Replicas:** 1 (single-replica suffices; scale up if traffic warrants)
- **Treasury:** auto-provisioned via the agent-treasury Anchor program (plan
  A2 — once it ships; today the platform-derived keypair from
  `WALLET_MASTER_KEY` + `treasuryId` plays the role)
- **Token:** $WHEELS on pump.fun; 1% of trading fees stream to the treasury
  PDA via the Raydium V4 indexer

## Deploying it for the first time

> **Operational owner:** anyone on the WheelsAI core team. This is _our_
> reference agent — not a customer agent.

### 1. Provision the upstream credentials

You'll need:

- A Discord bot token + application ID (DDP > Application > Bot)
- A Telegram bot token (BotFather)
- An Anthropic API key (with usage-based billing on)
- A Solana devnet wallet funded with ~5 SOL for the treasury seed
- A funded Nosana wallet (NOS for posting jobs)

Drop them into `.env` (or your secret manager):

```bash
ANTHROPIC_API_KEY=...
DISCORD_API_TOKEN=...
DISCORD_APPLICATION_ID=...
TELEGRAM_BOT_TOKEN=...
WALLET_MASTER_KEY=...
NOSANA_WALLET_PRIVATE_KEY=...
```

### 2. Submit through the launch route

```bash
curl -X POST http://localhost:4000/api/launch \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $WHEELSAI_TOKEN" \
  -d @<(jq -n \
        --slurpfile char examples/reference-agents/wheels-helper/character.json \
        --arg apk "$ANTHROPIC_API_KEY" \
        --arg dat "$DISCORD_API_TOKEN" \
        --arg dai "$DISCORD_APPLICATION_ID" \
        --arg tbt "$TELEGRAM_BOT_TOKEN" \
        '{
          characterJson: $char[0],
          envValues: {
            ANTHROPIC_API_KEY: $apk,
            DISCORD_API_TOKEN: $dat,
            DISCORD_APPLICATION_ID: $dai,
            TELEGRAM_BOT_TOKEN: $tbt
          },
          gpuTier: "4070",
          replicas: 1
        }')
```

The route returns the new `Agent.id` plus the `AgentDeployment.id`. The
deployment goes through the existing OpenClaw → Nosana pipeline — no
special-casing for the reference agent.

### 3. Tokenize

After 7 days of uptime, the eligibility gate flips to ready. Use the
dashboard tokenize wizard at `/dashboard/agents/<id>/tokenize`. Set the
ticker to `WHEELS`, name to "WheelsAI Helper". Accept the 30-day creator
lockup.

### 4. Treasury fund + first auto-pay

The treasury PDA shows up in the Runway card on the agent overview tab.
Send some devnet SOL there to seed it (mainnet: just wait for trading
fees). The next `treasury-settlement` tick (default 60s) emits a
ComputePayment row; `payment-submit` signs it; `payment-poll` confirms it.
Verify on `solana explorer`.

## Operational invariants

- **Never** delete this character file or rename `wheels-helper`. It's
  referenced by tests (`elizaCharacter.unit.test.ts:wheelsHelper`).
- **Don't** check secrets into the file. The character format separates
  the persona (this file, in git) from credentials (env, never in git).
- **Bump the model** — keep the `model` field on the latest Claude
  release; update the README in the same PR.
- **System prompt changes** must go through governance once tokenized
  (plan A9). For now they're a regular code change, reviewed by the
  team.

## Health checks

The platform's monitoring routes (`/api/monitoring/*`) cover this agent
just like any other. Add the agent's slug (`wheels-helper`) to the
status page's pinned-list when it goes live so external observers can
verify uptime independently.
