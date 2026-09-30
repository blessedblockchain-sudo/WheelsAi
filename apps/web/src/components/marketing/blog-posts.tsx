import type { ReactNode } from "react";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";

/**
 * Blog posts, written from facts in the repository: the credit ledger and
 * metering services, the proof-run documents under docs/, the Nosana market
 * table and the GPU billing code. Dates and author per the publishing brief.
 */

export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  date: string; // YYYY-MM-DD
  author: string;
  tags: string[];
  body: () => ReactNode;
}

const AUTHOR = "The WheelsAI team";

function ReceiptsPost() {
  return (
    <>
      <p>
        A marketplace is only as trustworthy as its numbers. When a creator&apos;s dashboard says they earned $12.40 this
        month, or a buyer&apos;s balance drops by two cents, both of them are entitled to ask the same question: where did that
        number come from? On WheelsAI the answer is always one of two things: a row in a ledger, or a transaction signature on
        Solana. This post explains how we hold ourselves to that, and why.
      </p>

      <h2 id="ledger">Every balance change is a row</h2>
      <p>
        Credits on WheelsAI are a US dollar balance kept in cents. Nothing changes that balance without writing a ledger row
        that records the amount, what it was for, a reference to the thing that caused it, and the balance after the change.
        The balance and the row are written in the same database transaction, and the &quot;balance after&quot; is read inside
        that transaction, so the ledger can never drift from the balance it describes.
      </p>
      <p>
        That rule covers everything: a card purchase, the $5 bonus for verifying your email, a hold before an inference request
        and its settlement afterwards, the one-hour reservation when a GPU deployment starts and its release when the deployment
        ends, a marketplace charge and its refund. If you can see a number, you can see the rows that add up to it.
      </p>

      <h2 id="charge-settle-refund">Charge, settle, refund</h2>
      <p>
        The marketplace is where this matters most, because two parties are involved. When a buyer runs a per-request agent,
        three things can happen, and each commits atomically:
      </p>
      <ol>
        <li>
          <strong>Charge</strong>, before the agent runs. The price is debited only if the balance covers it, using a
          conditional update, and a pending revenue row is written next to the ledger row. A buyer who cannot pay is refused
          before any work is done.
        </li>
        <li>
          <strong>Settle</strong>, after the answer is delivered. The pending row flips to settled, exactly once, and the
          creator&apos;s 90% share accrues.
        </li>
        <li>
          <strong>Refund</strong>, if the run fails. The pending row flips to refunded and the buyer gets the money back.
          Nobody earns from a failed request.
        </li>
      </ol>
      <p>
        The invariant we care about is simple to state: every cent a creator can withdraw came out of a buyer&apos;s balance.
        We checked it against a real Postgres database with the production code path. Four requests fired in parallel against a
        balance that covered exactly three: three were served, one was refused, and the balance landed on exactly zero. The
        refund for a failed request carries the same reference as the charge it reverses, so you can find either from the other:
      </p>
      <CodeBlock
        language="text"
        title="From the metering proof run"
        code={`ledger  marketplace_usage      -250c  balanceAfter    750c
ledger  marketplace_usage      -250c  balanceAfter    500c
ledger  marketplace_refund      250c  balanceAfter    750c   (same reference as the charge above)
ledger  marketplace_usage      -250c  balanceAfter    500c
ledger  marketplace_usage      -250c  balanceAfter    250c
ledger  marketplace_usage      -250c  balanceAfter      0c

collected  $10.00 from the buyer
accrued     $9.00 to the publisher ($1.00 platform fee)`}
      />

      <h2 id="money-in">Money in: only when it has actually arrived</h2>
      <p>
        Credits enter the ledger through three rails, and each one waits for proof before it grants anything:
      </p>
      <ul>
        <li>
          <strong>Card.</strong> Credits are granted from Stripe&apos;s signed webhook, never from the browser redirect, and
          exactly once per purchase. A refunded payment takes back the credits it bought.
        </li>
        <li>
          <strong>Wallet top-up.</strong> The server prepares the exact USDC transfer, your wallet signs it, and the server
          checks that what you signed is byte-for-byte what it prepared. Credits land only after the transaction is confirmed
          on-chain, and a confirmation that is interrupted can be reconciled later without ever crediting twice.
        </li>
        <li>
          <strong>x402.</strong> For per-request API payments, the signed Solana payment is verified against the exact amount
          and recipient before the request runs, and a payment transaction can be used only once.
        </li>
      </ul>

      <h2 id="money-out">Money out: reserved first, paid once</h2>
      <p>
        Creator payouts use the same shape in reverse. Requesting a payout reserves the pending balance with a conditional
        update, so two simultaneous requests cannot both claim the same money. Only a signed-in owner or admin can request one;
        an API key cannot, because a leaked key should never be able to redirect someone&apos;s earnings. On-chain payouts are
        recorded with their transaction signature.
      </p>

      <h2 id="public-receipts">Receipts anyone can check</h2>
      <p>
        Some of this is visible without an account. Every public agent has a transparency page at{" "}
        <code>/a/&#123;slug&#125;</code> showing its on-chain treasury balance, the compute it has paid for, and the signatures
        of its recent payments, each one a link you can open in a Solana explorer. It shows the agent&apos;s deployments, its
        enabled channels, and whether it currently clears the bar to launch a token. It never shows the owner&apos;s
        organization or internal error messages.
      </p>
      <p>
        The treasury behind that page is a Solana program we wrote for exactly this purpose. It lets an agent&apos;s own
        earnings pay the Nosana host that runs it. Each payment is recorded before it is broadcast, so if anything is
        interrupted, the next attempt can tell from the chain what already happened instead of guessing.
      </p>

      <h2 id="why">Why bother</h2>
      <p>
        Receipts are not the product. The product is a place where an AI tool gets built, deployed and paid for. Receipts are
        why you can trust that place with your money and your work: a creator does not have to take our word for what they
        earned, and a buyer does not have to take a publisher&apos;s word for what an agent has done.
      </p>
      <p>
        The same instinct runs through the rest of the platform. When a feature is not configured on a server, the API answers
        with a named error instead of a pretend success. When we have not measured something, like uptime before any monitor
        exists, our <Link href="/status">status page</Link> says so instead of showing 100%.
      </p>
      <p>
        Read how the pieces work in the <Link href="/docs/guides/marketplace">marketplace guide</Link> and{" "}
        <Link href="/docs/guides/plans-and-billing">plans and billing</Link>.
      </p>
    </>
  );
}

function GpuBillingPost() {
  return (
    <>
      <p>
        WheelsAI runs models and agents on Nosana, a decentralized network of GPU hosts where compute is bought by the second.
        We wanted our customers to pay the same way: for the seconds a deployment actually runs, at a rate they can see before
        they start. This post walks through how GPU billing works on WheelsAI and the rules that keep it honest.
      </p>

      <h2 id="one-table">One price table</h2>
      <p>
        Every GPU tier we offer, from an RTX 3060 to an H100, has one retail price: US dollars per second, per replica. That
        single table feeds everything. The catalog&apos;s <code>pricePerHour</code> is that rate times 3,600. The cost estimate
        uses it. The reservation taken when you deploy uses it. The charge while you run uses it.
      </p>
      <p>
        We learned why this matters the hard way. An early version kept a second, hand-typed price table for the deploy wizard,
        and it disagreed with the one used for metering: a user could pick a tier shown at one hourly price and be metered at
        another. Now there is one table, and if a price moves, every surface moves with it.
      </p>
      <CodeBlock
        language="bash"
        code={`# The tiers this server can deploy, with their current hourly price per replica
curl -s "$WHEELSAI_API_URL/api/models?tier=gpu" | jq '.gpuTiers'`}
      />

      <h2 id="admission">Admission: a reservation, not a fee</h2>
      <p>
        GPU jobs are paid for from the moment they start, so a deployment has to prove it can pay before it is submitted. Two
        checks run first. An organization has a limit on active deployments. Then one hour of the chosen tier, times the
        replica count, is reserved from the credit balance with a conditional update: the balance is decremented only if it
        covers the amount, so two deployments racing against a balance that covers one cannot both get through.
      </p>
      <p>
        The deployment row and its reservation are created in the same transaction, referenced by the deployment&apos;s id. A
        reservation that was never given back would just be a fee, so when a deployment ends, whether it failed or was
        stopped, the reservation is released, exactly once, and both the hold and the release appear in the ledger.
      </p>

      <h2 id="meter">The meter</h2>
      <p>
        Billing starts when the platform observes the deployment actually running on Nosana, not when it was submitted: time
        spent waiting for a host is not your time. From then on, a billing worker charges
      </p>
      <CodeBlock language="text" code={`price per second (tier)  ×  replicas  ×  elapsed seconds`} />
      <p>from a per-deployment cursor that marks how far the deployment has been billed. A few details make this exact:</p>
      <ul>
        <li>
          <strong>Integer money.</strong> The arithmetic is done in whole micro-dollars, never floating point.
        </li>
        <li>
          <strong>No rounding drift.</strong> The ledger is in whole cents, but GPU seconds are cheaper than a cent. Each charge
          bills whole cents only and advances the cursor by exactly the seconds those cents pay for; the remainder rolls into
          the next charge instead of being rounded up every time. The final charge when a deployment stops rounds up once.
        </li>
        <li>
          <strong>Never twice.</strong> Advancing the cursor is a compare-and-swap on its previous value. If two workers see the
          same window, one wins and the other bills nothing.
        </li>
        <li>
          <strong>Never negative.</strong> The charge is a conditional decrement. If the balance cannot cover it, nothing is
          written, including the cursor.
        </li>
      </ul>

      <h2 id="empty">When the credits run out</h2>
      <p>
        A deployment should never run on money its owner does not have, because every second it runs is a second someone has to
        pay a GPU host for. When a charge cannot be paid, the worker stops the deployment on Nosana first, then marks it stopped
        with the reason, and releases its reservation. If the stop call fails, the deployment stays marked running so the next
        pass retries it, rather than being reported stopped while it is still burning GPU time.
      </p>

      <h2 id="tokens">GPU time and tokens are separate</h2>
      <p>
        Calling a deployment through the OpenAI-compatible <code>/v1</code> API is metered separately, per token, at the
        model&apos;s pricing tier. Each request holds its worst-case cost before it reaches the GPU and settles to the actual
        usage afterwards, so concurrent requests cannot overdraw a balance either. The two show up as different ledger rows,
        so you can always see what you paid for time and what you paid for tokens.
      </p>

      <h2 id="self-paying">Agents that pay for their own compute</h2>
      <p>
        The same per-second view of compute underlies the agent treasury. For an agent with an on-chain treasury, a settlement
        cycle bills only the time since its last bill, measured from the Nosana job&apos;s own start and end times, and pays
        the host from the treasury through our Solana program. An agent whose earnings cover that bill is paying for its own
        compute.
      </p>

      <p>
        The details are in the docs: <Link href="/docs/guides/deploy-a-model">Deploy a model</Link> and{" "}
        <Link href="/docs/api/inference">Chat completions</Link>.
      </p>
    </>
  );
}

export const BLOG_POSTS: BlogPost[] = [
  {
    slug: "every-earning-has-a-receipt",
    title: "Why every earning on WheelsAI has a receipt",
    description:
      "How the credit ledger, charge-settle-refund metering, verified payment rails and public receipts pages make every number on WheelsAI traceable.",
    date: "2026-10-01",
    author: AUTHOR,
    tags: ["Marketplace", "Payments"],
    body: ReceiptsPost,
  },
  {
    slug: "per-second-gpu-billing-on-nosana",
    title: "Building on Nosana: per-second GPU billing",
    description:
      "One price table, a reservation instead of a fee, and a meter that bills whole cents without rounding drift: how GPU time is billed on WheelsAI.",
    date: "2026-10-01",
    author: AUTHOR,
    tags: ["Nosana", "Billing", "Engineering"],
    body: GpuBillingPost,
  },
];

export function getPost(slug: string): BlogPost | undefined {
  return BLOG_POSTS.find((p) => p.slug === slug);
}

export function formatPostDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
