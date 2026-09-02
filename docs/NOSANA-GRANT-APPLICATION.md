# Nosana Grants Program — Application Text

**Program:** Nosana Grants ($5,000–$50,000, non-dilutive, milestone-released)
**Team:** Bprime · **Project:** WheelsAI · **Contact:** blessedbiello@gmail.com
**Status:** final text, ready to paste. Fields marked `[YOU]` need the founder's
own answer. See the pre-submit checklist at the bottom.

Positioning locked with the founder (2026-09-02): **BUILD / DEPLOY / MONETIZE**,
where BUILD covers three product types — AI agents, small language models, and
AI workflows. Creator-rails story (e.g. the wave of security-audit tools:
their creators should ship and earn here). No competitor references. Every
claim survives a diligence check — proofs are cited, gaps are named as
milestones.

---

## Project Goal

WheelsAI is where AI products get **built, deployed, and monetized** on
decentralized GPU. Build covers three product types: AI agents (imported from
GitHub in any framework — Mastra, ElizaOS, LangChain, AutoGen, CrewAI,
custom), small language models (fine-tuned and served per-second), and AI
workflows (agents, models, and retrieval chained into scheduled pipelines).
Deploy means Nosana's GPU network, billed per second. Monetize means a
marketplace with per-request, subscription, x402, and token pricing — where
every revenue figure traces to a ledger row or an on-chain signature. The
goal: when a creator builds an AI tool, WheelsAI is where they ship it and
earn from it — and Nosana is the network it runs on.

## Project Statement

Mission: give every AI creator the path from working code to working
business. A new class of AI tools appears every month — security auditors,
code reviewers, research agents — and each creator hits the same wall:
hosting, billing, and distribution are a second product they never planned to
build. WheelsAI removes that wall. Creators bring what they've built (an
agent in any framework, a fine-tuned small model, a multi-step workflow),
deploy it to Nosana's GPU network in minutes, and list it on a marketplace
where buyers install and pay per request, by subscription, via x402
micropayments, or through tokens. Creators keep 90% of revenue with payouts
settled on-chain; buyers get verified products — usage is attested by an
on-chain reputation oracle, and a token can only be launched by an agent that
has earned it with real usage. An agent's own earnings can even pay for its
Nosana compute (`pay_nosana`), a closed loop already proven end-to-end on
devnet.

## Project GitHub Link

⚠️ BLOCKER — do not paste the private GitLab URL. Resolve before submitting:
either flip the GitLab project to public (after a sensitive-history scan) or
publish a clean public mirror (roadmap item C3).

## Project Website

Leave blank, or: "Staging deployment in progress; local-first development,
full deploy runbook written (docs/DEPLOY-RUNBOOK.md)."

## Demo Link

⚠️ BLOCKER — record the 2-minute screen demo (form explicitly accepts a
recording): login → import agent from GitHub → chat (real inference) →
marketplace install → public receipts page `/a/wheels-helper`.

## Project Twitter

x.com/Wheels_Ai `[YOU — confirm handle is live]`

## How do you plan to deploy or leverage Nosana's GPU network?

Every product type on WheelsAI is a Nosana workload, metered per second on
one billing rail derived live from Nosana market pricing:

1. **Model serving.** Open-weight and fine-tuned small language models
   deployed as Nosana jobs behind an OpenAI-compatible `/v1` endpoint,
   payable per request via x402 — the full HTTP 402 → on-chain payment →
   settlement cycle is proven on devnet with documented signatures. We are
   deliberately SLM-first: 7–14B-class models are the right fit for a
   distributed GPU marketplace.
2. **Fine-tuning.** LoRA/QLoRA batch jobs on Nosana GPUs, with resulting
   adapters flowing straight back into serving as deployable, monetizable
   models. The training studio (job lifecycle, datasets, authenticated
   progress webhooks) is built; training containers and Nosana market mapping
   are grant milestone work.
3. **Agent & workflow hosting.** Per-framework runtime containers running as
   long-lived Nosana jobs — with admission control, per-org credit
   reservation, and status reconciliation already built and tested (1,600+
   unit tests). Workflows chain these into scheduled, orchestrated pipelines
   that keep GPUs working between chat sessions.
4. **Embeddings.** Self-hosted embedding models on Nosana powering
   retrieval-grounded agents, keeping the RAG pipeline decentralized end to
   end.

And the payment leg: our Anchor treasury's `pay_nosana` instruction routes a
product's earnings on-chain to the host running it — executed and finalized
on devnet. Milestone 1: first production workloads on real, paid mainnet
Nosana hosts, receipts public. From then on, every product a creator ships on
WheelsAI is recurring, metered demand for Nosana's network.

## What innovative aspects does your project bring?

1. **Open creator rails.** Any AI tool becomes a sellable product: import it
   in any framework, and the platform handles per-request metering (charged
   before inference, refunded on failure, exactly-once under concurrency —
   transaction-proven), installs, and on-chain creator payouts at a 90%
   revenue share.
2. **Products that pay their own way.** Our treasury program routes an
   agent's earnings — marketplace revenue, token trading fees — directly to
   the GPU host running it via `pay_nosana`. A closed economic loop from
   earnings to compute, executed and finalized on devnet with every
   transaction signature documented.
3. **Substance-gated tokenization.** A token launch must be earned: usage is
   attested on-chain by a reputation oracle, and paid x402 requests discount
   the bar because they are a costly signal. Tokens here represent working
   software with verified users.
4. **SLM-first economics.** Fine-tuned small models on marketplace GPUs,
   priced per second and payable per request — right-sized models on
   right-sized hardware, making owned, specialized AI cheaper than renting
   frontier APIs.
5. **Receipts-grade everything.** Public per-agent transparency pages serve
   numbers byte-identical to chain state. On WheelsAI, "trust me" is replaced
   by "verify it."

## Long-Term Vision (~270 words)

Every month a new wave of AI tools appears — this year it's security auditors
and code reviewers; next year something else. Their creators are builders,
not infrastructure companies: they shouldn't need to assemble GPU hosting,
metering, billing, payouts, and distribution before earning their first
dollar. Our vision is that WheelsAI becomes the default shipping lane for
that entire creator economy — build the agent, model, or workflow; deploy it;
monetize it — with Nosana as the compute layer underneath every product.

Phase 1 (grant period): close the last proof gap — runtime and training
containers published, first production workloads on paid mainnet Nosana
hosts, receipts public — and open the platform with all three earning models
live.

Phase 2: scale the creator ecosystem. Fine-tuning moves onto Nosana batch
jobs so creators ship specialized SLMs, not just prompts; chat-channel
distribution (three platforms today, ten planned) gives hosted products
reach; the transparency feed becomes the trust standard buyers check before
installing anything.

Phase 3: the agent economy. Product treasuries autonomously topping up their
own compute, reputation staked on-chain, and a marketplace where price
reflects attested performance history. At that point WheelsAI is
infrastructure: the clearing layer where AI product revenue and decentralized
compute meet — with Nosana underneath every transaction.

## Have you previously secured funding?

`[YOU]` — answer factually. If none: "No. The project is self-funded to date;
this would be its first external funding."

## Team Description

`[YOU to confirm]` — draft: 1 member (Bprime): full-stack engineer —
TypeScript (Fastify/Next.js), Solana/Anchor program development (two deployed
devnet programs: agent-treasury, reputation-oracle), payments infrastructure.
Full-time commitment. Velocity is documented in the commit history: the
closed devnet loop, four payment rails, and 1,666 unit tests shipped over ~8
months.

## Earliest start date

`[YOU]` — if ready: "Immediately upon acceptance."

## Files

Attach `pitch-deck-nosana-grant.pdf` (rebuild in progress — verify it matches
this text before upload). Optional: a one-page "Proofs" sheet compiling the
devnet transaction signatures from docs/D10-RUN.md, PAYOUT-RUN.md,
X402-RUN.md, WALLET-TOPUP-RUN.md, MARKETPLACE-METERING-RUN.md.

## Additional Comments

A note on how we present: this application names what does not work yet. The
money loop, metering, payouts, and attestations are proven with documented
transaction signatures; the runtime container images and the first paid
mainnet Nosana host are not — they are milestone 1. We build this way
deliberately, and we'd rather the committee hold us to receipts than to
promises.

---

## Pre-submit checklist

- [ ] Public repo link (GitLab visibility flip after history scan, or clean mirror)
- [ ] 2-minute demo recording uploaded (servers: web :3002, api :4000)
- [ ] Rebuilt pitch deck attached and consistent with this text
- [ ] `[YOU]` fields answered: funding history, team, start date, Twitter
- [ ] Deck contact slide: remove suspended GitHub link
