# Security policy

WheelsAI runs agents, workflows and models for other people, and moves their money: credits,
marketplace earnings, escrowed job payments and on-chain agent treasuries. If you find a way to
break any of that, please tell us privately so we can fix it before anyone else finds it.

## Report a vulnerability

Email **[FOUNDER: security contact email]** with the details below. The same address is given in
the Terms of Service.

You can also reach us through the contact form on the WheelsAI website (the Contact page, topic
Support). Use the form only to ask for a private channel: say that you have a security report and
how to reach you, and leave the details of the vulnerability out of the form.

If you have access to this project's repository, you can instead open a **confidential issue**,
which is visible only to you and the project's maintainers.

Please do not report a vulnerability in a public issue, a merge request, a discussion or anywhere
else in public until it is fixed.

## What to include

The more of this a report has, the faster it can be confirmed and fixed:

- **What is affected:** the component (API, web app, SDK, CLI, an on-chain program, the training
  image, the edge proxy), and the endpoint, page, command, instruction or file.
- **What an attacker gains:** for example reading another organization's data, spending
  someone else's credits, moving funds, or running code where they should not.
- **How to reproduce it:** the exact steps, requests or transactions, with the version or commit
  you tested.
- **Proof of concept:** the smallest one that shows the issue. Use your own accounts and
  wallets.
- **What you already know about a fix**, if anything.
- **How to credit you**, or that you prefer not to be named.

Leave out real credentials, API keys, private keys and other people's data. If a key or token
leaked, say where it was exposed and leave the value out.

## What to expect

- We confirm that the report arrived, and reply on the channel you used.
- We reproduce the issue and tell you whether we accept it, and why if we do not.
- We keep you updated while we fix it, and tell you when the fix is released.
- We agree on disclosure with you: please wait until the fix is released before publishing.
- We credit you in the fix's release notes if you want to be credited.

## Scope

In scope:

- The WheelsAI API (`apps/api`): authentication, API keys and their scopes, organizations and
  roles, credits and the ledger, billing and payments (card, wallet top-up, x402), the
  marketplace, offerings and jobs, payouts, deployments, fine-tuning, workflows, the scheduler,
  webhooks, custom domains and the public chat endpoints.
- The web app (`apps/web`): the dashboard, the marketplace, the documentation, the public agent
  pages and the embeddable chat widget (`widget.js`).
- The TypeScript SDK (`packages/sdk`) and the `wheelsai` CLI (`packages/cli`), including how they
  store and send credentials.
- The on-chain programs `agent-treasury` and `reputation-oracle` (`programs/`).
- The fine-tuning image (`infra/training`) and the edge proxy configuration (`infra/edge`).

Out of scope:

- Vulnerabilities in services WheelsAI relies on, such as Nosana, Solana, Stripe, model
  providers and hosting providers. Report those to their owners. If WheelsAI uses one of them
  unsafely, that is in scope.
- Denial of service by sheer volume, and findings that only show a rate limit can be reached.
- Social engineering, phishing and physical attacks.
- Findings that need an already compromised device, browser or account.
- Missing security headers or best-practice notes without a way to exploit them.
- Reports produced by automated scanners without a confirmed, working issue.

If you are not sure whether something is in scope, report it anyway.

## Testing guidelines

- Test only against accounts, organizations, agents and wallets you own or are allowed to use.
- Do not read, change or delete other people's data. If you reach some by accident, stop, and
  tell us what you saw in the report.
- Do not move funds you do not own, and keep on-chain tests to amounts you can afford to lose.
- Do not degrade the service for other users: no load tests, no spam, no destructive tests.
