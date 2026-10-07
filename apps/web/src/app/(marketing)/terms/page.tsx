import type { Metadata } from "next";
import Link from "next/link";

import { LegalPage } from "@/components/marketing/legal-page";
import { Founder } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "The terms for using WheelsAI: accounts, plans and credits, the marketplace, agent tokens, AI output, acceptable use, termination and liability. Draft pending legal review.",
};

const sections = [
  { id: "agreement", title: "The agreement" },
  { id: "accounts", title: "Accounts and organizations" },
  { id: "service", title: "The Service" },
  { id: "plans", title: "Plans, credits and payments" },
  { id: "crypto", title: "Crypto payments and blockchain" },
  { id: "marketplace", title: "The marketplace" },
  { id: "tokens", title: "Agent tokens" },
  { id: "content", title: "Your content" },
  { id: "ai-output", title: "AI output" },
  { id: "third-parties", title: "Third-party services and GPU hosts" },
  { id: "acceptable-use", title: "Acceptable use" },
  { id: "termination", title: "Suspension and termination" },
  { id: "disclaimers", title: "Disclaimers" },
  { id: "liability", title: "Limitation of liability" },
  { id: "indemnity", title: "Indemnity" },
  { id: "law", title: "Governing law and disputes" },
  { id: "changes", title: "Changes" },
  { id: "general", title: "General" },
  { id: "contact", title: "Contact" },
];

export default function TermsPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Terms of Service"
      description="The rules for using WheelsAI to build, deploy and monetize AI agents, workflows and models."
      sections={sections}
    >
      <h2 id="agreement">1. The agreement</h2>
      <p>
        These terms are an agreement between you and <Founder>legal entity name</Founder>, <Founder>registered address</Founder>{" "}
        (&quot;WheelsAI&quot;, &quot;we&quot;, &quot;us&quot;), covering the WheelsAI website, dashboard, API, marketplace, SDK
        and CLI (the &quot;Service&quot;). By creating an account or using the Service you accept them. If you use the Service
        for an organization, you accept them on its behalf and confirm you are authorized to. Our{" "}
        <Link href="/privacy">Privacy Policy</Link> explains how we handle personal data. An Enterprise agreement signed with us
        takes precedence over these terms where they conflict.
      </p>

      <h2 id="accounts">2. Accounts and organizations</h2>
      <ul>
        <li>You must be at least <Founder>minimum age</Founder> and able to enter a binding contract.</li>
        <li>Give accurate information, keep your credentials secure, and tell us promptly about unauthorized use.</li>
        <li>
          Everything you create belongs to an organization. Owners and admins can manage members, billing and payouts, and are
          responsible for what happens in the organization.
        </li>
        <li>
          API keys act with the full authority of their organization. You are responsible for every request made with your keys
          until you revoke them.
        </li>
      </ul>

      <h2 id="service">3. The Service</h2>
      <p>
        WheelsAI lets you build AI agents, workflows and small language models, deploy them to GPU capacity on the Nosana
        network, and offer them to others through a marketplace. We keep improving the Service and may add, change or remove
        features. If a feature is temporarily unavailable, the Service tells you so. Features we label as beta or preview may
        change without notice and are provided without any commitment of availability.
      </p>

      <h2 id="plans">4. Plans, credits and payments</h2>
      <h3>Plans</h3>
      <p>
        Starter is free. Pro is $49 per month, billed through Stripe, with a 14-day free trial the first time an organization
        subscribes; it renews monthly until cancelled, and you can cancel at any time in the billing portal, effective at the
        end of the paid period. Enterprise is provided under a separate agreement. Plan limits (agents, monthly API calls,
        features) are enforced by the Service and described in the{" "}
        <Link href="/docs/guides/plans-and-billing">documentation</Link>.
      </p>
      <h3>Credits</h3>
      <ul>
        <li>
          Credits are a prepaid balance in US dollars that pays for usage on the Service: inference, GPU time for deployments,
          and marketplace purchases. Bonus credits may accompany purchases or email verification.
        </li>
        <li>
          Credits are not money, bear no interest, cannot be transferred between organizations except by paying for marketplace
          items, and cannot be exchanged for cash. Refunds of unused credits: <Founder>refund policy for unused credits</Founder>.
        </li>
        <li>
          Usage is charged as described in the documentation: for example, inference requests hold their worst-case cost and
          settle to actual usage, and running deployments are charged for GPU time. When your balance cannot cover further GPU
          time, we stop the deployment.
        </li>
        <li>
          If a card payment is refunded or reversed, the credits it bought (and the matching share of any bonus) are removed.
        </li>
      </ul>
      <h3>Taxes</h3>
      <p>Prices do not include taxes unless stated. You are responsible for taxes that apply to your purchases and earnings.</p>

      <h2 id="crypto">5. Crypto payments and blockchain</h2>
      <p>
        You may pay with USDC from a Solana wallet, pay for API requests with x402, receive payouts in USDC or SOL, and interact
        with our Solana programs. Blockchain transactions are irreversible: check addresses and amounts before you sign, and
        you bear network fees. We credit a payment only after it is confirmed on-chain. We never hold the keys to your wallet.
        Records written to Solana are public and permanent.
      </p>

      <h2 id="marketplace">6. The marketplace</h2>
      <h3>For publishers</h3>
      <ul>
        <li>
          By publishing a listing you grant us a worldwide, non-exclusive licence to host, display, copy and distribute the
          listed agent to buyers who install it, and to run it for them, for as long as the listing and their installs exist.
        </li>
        <li>
          You keep 90% of what buyers pay for your listings; our platform fee is 10%. Earnings accrue as a pending balance and can
          be paid out, in credits or crypto, once they reach $10.00. Payout requests require a signed-in owner or admin.
        </li>
        <li>
          Your agent&apos;s environment variables are never copied to buyers. You are responsible for your listing&apos;s
          accuracy, for having the rights to everything in it, for the lawfulness of what your agent does, and for your own
          taxes on earnings.
        </li>
        <li>We may review, feature, rank, hide or remove listings, including to enforce these terms.</li>
      </ul>
      <h3>For buyers</h3>
      <ul>
        <li>
          Installing a listing gives your organization a licence to run your copy of the agent while the install is active and,
          for paid models, paid up. Uninstalling ends the licence.
        </li>
        <li>
          Per-request listings are charged before each run and refunded if the run fails. Monthly listings are charged for each
          30-day period in advance and renew until cancelled; an unpaid renewal has a 3-day grace period before access is
          suspended, and uninstalling does not refund the current period. Tokenized listings require your organization to hold
          the listing&apos;s token once it has launched.
        </li>
        <li>Reviews must reflect your genuine experience.</li>
        <li>
          Marketplace agents are provided by their publishers, not by WheelsAI. Evaluate them before relying on them.
        </li>
      </ul>

      <h2 id="tokens">7. Agent tokens</h2>
      <p>
        Creators can launch a token for an eligible agent through a third-party launchpad, signing from their own wallet.
        WheelsAI does not issue, sell, promote or endorse any token, does not operate the markets they trade on, and does not
        give investment, financial, legal or tax advice. Token prices can go to zero. The launch eligibility checks and the
        creator allocation lockup are product rules, not guarantees about a token or its creator. Wash trading, market
        manipulation and misleading promotion of tokens are prohibited. Do not buy a token you cannot afford to lose.
      </p>

      <h2 id="content">8. Your content</h2>
      <p>
        You own the content you bring to or create on the Service, including prompts, code, documents, datasets and outputs, to
        the extent the law allows. You grant us the licence we need to host, process, run and display it to operate the Service
        for you, including sending it to the model providers and GPU hosts described in the Privacy Policy. You are responsible
        for having the rights to your content, including code you import from repositories.
      </p>

      <h2 id="ai-output">9. AI output</h2>
      <p>
        AI models can produce output that is inaccurate, incomplete, biased, offensive or similar to others&apos; content. Output
        is not professional advice. You are responsible for reviewing output before you rely on it or publish it, for how your
        agents behave toward your users, and for complying with the terms of any third-party model you use. Do not present AI
        output as human-written where that would mislead people.
      </p>

      <h2 id="third-parties">10. Third-party services and GPU hosts</h2>
      <p>
        The Service depends on third parties we do not control, including Nosana and the independent operators of its GPU
        hosts, Stripe, model providers, Solana and its RPC providers, and services you connect such as GitHub, Slack, Discord and
        Telegram. Their availability and conduct are not under our control, and your use of them is also subject to their
        terms. We are not responsible for third-party services.
      </p>

      <h2 id="acceptable-use">11. Acceptable use</h2>
      <p>You must not use the Service to:</p>
      <ul>
        <li>break the law, or help anyone else do so, including sanctions and export-control laws;</li>
        <li>create or distribute child sexual abuse material, or content that exploits or endangers minors;</li>
        <li>harass, threaten, defraud or impersonate people, or run agents that deceive users about what they are;</li>
        <li>infringe intellectual property or privacy rights, or process personal data without a lawful basis;</li>
        <li>send spam, distribute malware, or attack, probe or overload any system, including ours and the GPU hosts;</li>
        <li>
          get around rate limits, plan limits, billing, metering or security controls, or access other organizations&apos; data;
        </li>
        <li>use GPU deployments for anything other than AI workloads, such as cryptocurrency mining;</li>
        <li>manipulate the marketplace, reputation scores, reviews or token markets.</li>
      </ul>
      <p>
        We may investigate suspected violations, and may remove content, stop deployments or suspend access to protect users,
        the Service or third parties. Report vulnerabilities to <Founder>security contact email</Founder> rather than testing
        them against other users.
      </p>

      <h2 id="termination">12. Suspension and termination</h2>
      <p>
        You can stop using the Service and close your account at any time. We may suspend or terminate access if you breach
        these terms, fail to pay, create risk or legal exposure for us or others, or if we are required to by law; where
        reasonable we will give notice first. On termination, running deployments are stopped, access ends, and we delete your
        content after <Founder>post-termination data retention period</Founder>, except records we must keep and records on public
        blockchains. Earnings already accrued to a publisher in good standing remain payable under these terms.
      </p>

      <h2 id="disclaimers">13. Disclaimers</h2>
      <p>
        To the extent permitted by law, the Service is provided &quot;as is&quot; and &quot;as available&quot;, without
        warranties of any kind, express or implied, including merchantability, fitness for a particular purpose and
        non-infringement. We do not promise that the Service will be uninterrupted or error-free, or that any output, deployment
        or marketplace agent will meet your needs. The <Link href="/status">status page</Link> is informational. No uptime
        commitment applies unless it is in a signed Enterprise agreement.
      </p>

      <h2 id="liability">14. Limitation of liability</h2>
      <p>
        To the extent permitted by law, WheelsAI will not be liable for any indirect, incidental, special, consequential or
        punitive damages, or for lost profits, revenue, data, goodwill or digital assets, arising from or related to the Service,
        and our total liability for all claims relating to the Service is limited to the greater of the amounts you paid us in
        the 12 months before the claim and US$100. Some jurisdictions do not allow these limits, so they may not apply to you in
        full.
      </p>

      <h2 id="indemnity">15. Indemnity</h2>
      <p>
        You will defend and indemnify WheelsAI against claims, losses and costs (including reasonable legal fees) arising from
        your content, your agents and listings, your use of the Service in breach of these terms, or your violation of law or
        third-party rights.
      </p>

      <h2 id="law">16. Governing law and disputes</h2>
      <p>
        These terms are governed by the laws of <Founder>governing law jurisdiction</Founder>, without regard to conflict-of-law
        rules. Disputes will be resolved in <Founder>courts or arbitration venue</Founder>, except that either party may seek
        urgent injunctive relief in any competent court. Nothing here removes rights you have as a consumer under the law of the
        place you live.
      </p>

      <h2 id="changes">17. Changes</h2>
      <p>
        We may update these terms. We will post changes on this page, and if a change is material we will tell you by email or
        in the dashboard before it takes effect. Continuing to use the Service after that means you accept the updated terms.
      </p>

      <h2 id="general">18. General</h2>
      <p>
        These terms and any documents they reference are the entire agreement between us about the Service. If a provision is
        unenforceable, the rest remains in effect. Not enforcing a provision is not a waiver. You may not assign these terms
        without our consent; we may assign them to a successor. Neither party is liable for delays caused by events beyond its
        reasonable control.
      </p>

      <h2 id="contact">19. Contact</h2>
      <p>
        <Founder>legal entity name</Founder>, <Founder>registered address</Founder>. Legal notices:{" "}
        <Founder>legal notices email</Founder>. For anything else, use the <Link href="/contact?topic=other">contact form</Link>.
      </p>
    </LegalPage>
  );
}
