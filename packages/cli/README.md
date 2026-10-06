# @wheelsai/cli

The `wheelsai` command: sign in, deploy an agent to GPU, list it on the marketplace, and read
deployment status and logs. It is a thin client over the WheelsAI API (through
[`@wheelsai/sdk`](../sdk)), so everything it prints is something the API returned. It never
invents an endpoint, a count or a latency; when the API returns nothing for a field, the
field says so.

The package is private to the monorepo (not on npm yet), so build it from a checkout.

## Install from the monorepo

Needs Node 18 or newer (the monorepo itself asks for 22.13+).

```bash
npm install
npm run build -w @wheelsai/sdk      # the CLI imports the compiled SDK
npm run build -w @wheelsai/cli

node packages/cli/bin/wheelsai.js --help         # plain node, no tsx needed
alias wheelsai="node $PWD/packages/cli/bin/wheelsai.js"
```

`bin/wheelsai.js` is the executable npm links as `wheelsai`; it loads the compiled `dist/`
and says how to build when that is missing. `npm run cli -w @wheelsai/cli -- <args>` runs the
TypeScript source through `tsx` instead (build the SDK first either way: the CLI resolves
`@wheelsai/sdk` to its `dist/`). The script is not called `dev` on purpose: the root
`npm run dev` starts every workspace's `dev` script, and a CLI that prints its usage and
exits would stop the API and web servers with it.

## Sign in

```bash
# An API key (create one in the dashboard, or POST /api/auth/keys with a session).
wheelsai login --url https://your-api.example.com                      # asks for the key; nothing is echoed
wheelsai login --url https://your-api.example.com --api-key-stdin < key.txt   # scripts and CI

# Or email and password. The password is asked for the same way.
wheelsai login --url https://your-api.example.com --email you@example.com
printf '%s' "$PASSWORD" | wheelsai login --url https://your-api.example.com --email you@example.com --password-stdin
# Accounts with two-factor authentication are asked for the code, or pass --code <6 digits>.

wheelsai whoami       # calls the API with the saved credentials
wheelsai logout       # forgets them; a session token is also revoked on the server that issued it
```

Secrets are read from a prompt or from stdin so they stay out of your shell history and out of
the process list, where other users on the machine can read a command line. `--api-key <key>`
and `--password <password>` still work and print a warning. `WHEELSAI_PASSWORD` is read too;
it keeps the password out of the process list, not out of your history if you type it inline.

`login` checks the key against the API before saving anything, so a typo never replaces a
working login. Saving an API key clears any saved session token and the other way round, so
the two cannot disagree. Both are sent as `Authorization: Bearer ...`.

**A saved credential belongs to the API URL it was issued for.** The URL is saved with it, and
the credential is only ever sent to that server (same scheme, host and port). If the API URL
later points somewhere else, through `config set apiUrl`, `login --url` or `WHEELSAI_API_URL`,
the credential is withheld and the command stops with the URL it is for; nothing is sent to the
new host. Sign in there, or set the URL back. `logout` revokes a session on the server that
issued it and warns if that fails (the token then stays valid until it expires).

There is no API URL until you give one: `login` refuses to send a credential to the built-in
development default (`http://localhost:4000`) unless you pass it as `--url`. URLs must be
`http(s)://` with no user name, password, query or fragment. Plain `http://` to anything but
this machine (`localhost`, `127.0.0.0/8`, `::1`) works but prints a warning on every command
that sends a credential, because the key, password and token then travel unencrypted.

### What `whoami` shows

A session token resolves to your email and organization id. An API key has no user: it acts
for its organization, so `whoami` shows `none (API keys act for the organization)` and the
organization id. (The API's `/api/auth/me` does not return the organization's name.)

### Settings and environment

Settings and credentials are stored with [`conf`](https://github.com/sindresorhus/conf) under
the project name `wheelsai` (for example `~/.config/wheelsai-nodejs/config.json`). The
directory is kept at mode 0700 and the file at 0600; both are re-applied on every run, so a
file left readable by an older version is tightened. `WHEELSAI_CONFIG_DIR` moves the directory.
A config file that is not valid JSON stops every command with its path (never its contents):
fix it or delete it.

```bash
wheelsai config show                                   # effective settings, credentials not printed
wheelsai config set apiUrl http://localhost:4310
wheelsai config set webUrl https://app.example.com    # where marketplace links point
```

| Environment variable | Overrides |
| --- | --- |
| `WHEELSAI_API_URL` | the API URL |
| `WHEELSAI_WEB_URL` | the web app URL used for marketplace links |
| `WHEELSAI_API_KEY` or `WHEELSAI_TOKEN` | the saved credentials entirely (so CI needs no config file); they go wherever the API URL points |
| `WHEELSAI_PASSWORD` | the password for `login --email` |
| `WHEELSAI_CONFIG_DIR` | where the config file is kept |

`login` warns when one of these will override what it just saved.

The API does not publish its web URL, so when `webUrl` is not set the CLI derives it:
`localhost:<any port>` becomes `localhost:3000`, `api.example.com` becomes `example.com`,
and any other host is assumed to serve the web app from the same origin. Set `webUrl` when
that guess is wrong. `wheelsai config show` says whether the web URL is `env`, `config` or
`derived`.

## Deploy

```bash
wheelsai deploy --agent my-support-bot                 # slug or id; the bare form works too
wheelsai deploy my-support-bot --gpu-tier 3060 --replicas 2
wheelsai deploy --agent my-support-bot --publish --price-per-request 5
wheelsai deploy --agent my-support-bot --resume <deployment-id>   # keep waiting; starts nothing
```

What it does, in order, stopping at the first failure:

1. **Resolve** the agent in your organization by slug or id (`GET /api/agents`; the API has
   no slug filter, so the match is done client-side).
2. **Validate.** If the agent has a graph, it is checked with the API's own validator
   (`POST /api/agents/{id}/graph/validate`) and a graph with errors is refused, with the API's
   messages. The counts shown (`3 nodes, 2 edges`) are the lengths of the graph the API
   returned. An agent with no graph is only checked for existing. Skip with `--no-validate`.
   *Agent graphs can only be read with a signed-in session:* the API's graph routes authorize
   by user, so with an API key the API's refusal (404, 401 or 403) skips the check with a
   warning. Any other failure of the graph route stops the deploy with either credential.
   With `--publish`, the listing is checked here too (see Publishing), before any GPU is requested.
3. **Choose a GPU tier** from `GET /api/models?tier=gpu`, the tiers this API can deploy right
   now. `--gpu-tier` must be one of them; without it the cheapest listed tier is used and
   the line says so. (The old default `rtx-4090` is not a tier id; real ids look like `3060`,
   `4070`, `4090`, `a100`, `h100`, and which are offered depends on the server.) If the API
   lists none (no compute configured), `--gpu-tier` is still sent so the API can answer with
   the real reason; without it there is nothing to choose and the command stops.
4. **Deploy** (`POST /api/agents/{id}/deploy`), with `--replicas` (1 to 5; the API enforces
   it) and optionally `--model-deployment <id>` or `--external-model-url <url>`.
5. **Wait** for the deployment to run, polling `GET /api/agents/{id}/deployments/{deploymentId}`
   up to `--timeout` seconds (default 600). The first checks come after 5, 10 and 20 seconds,
   then every `--interval` seconds (default 30, which is how often the API refreshes a
   deployment's status; polling faster only repeats the same answer). Each status the API
   reports (`pending`, `building`, `deploying`, `running`) appears as it happens. A `failed`
   deployment ends the run with the API's `lastError`; a timeout says which status it was
   still in. Network errors, 5xx answers, a 408 and the rate limiter's 429 are retried until
   the timeout. A refusal that will not change ends the wait at once: any other 4xx, and a
   429 for a used-up quota (`plan_limit_reached`, `deployment_quota_exceeded`).
   Ctrl-C stops watching and prints how to look at the deployment later (exit code 130); the
   deployment itself carries on server-side.
6. **Report** what the API returned, once the deployment is `running`: the endpoint, exactly
   as returned, and the channels. No endpoint returned means `none returned by the API`. The
   agent-deployment record carries no channels today, so the CLI also looks at the agent's
   OpenClaw (Discord, Telegram, Slack) deployment and prints its channels if it is `RUNNING`
   and has any; otherwise `none reported by the API`. `logs` and `agents get` show an endpoint
   as an address only while its deployment is running.
7. **Publish**, only with `--publish` (below).

```text
✔ Agent My Support Bot my-support-bot  2e86922d-...
✔ Graph valid: 3 nodes, 2 edges
✔ GPU tier 3060 (RTX 3060, 8 GB, $0.36/hr)  cheapest available
✔ Deployment 94aa7943-... created (pending)
✔ pending 0s
✔ deploying 8s
✔ Listed on the marketplace

  Agent live!
  Deployment    94aa7943-...
  GPU           3060 x1
  Endpoint      <as returned by the API>
  Channels      none reported by the API

  Listed on the marketplace
  URL           http://localhost:3000/marketplace/my-support-bot
  Status        published
  Pricing       $0.05 per request
```

Progress goes to stderr and results to stdout, so `--json` (one JSON document on stdout:
`agent`, `deployment`, `endpoint`, `channels`, `listing`) is safe to pipe.

### Once a deployment exists

From the moment the API accepts the deploy, the deployment runs on the server and its credits
are reserved, whatever happens to the command. So every later failure (a status check that is
refused, a timeout, a listing that fails) names the deployment id and says what to do with it,
and with `--json` stdout still carries one document, `agent`, `deployment` (`id` and the last
`status` seen) and `error` (`message`, `status`, `code`), with exit code 1.

**Do not run `deploy` again to keep waiting**: each run without `--resume` starts another
deployment and another reservation. `--resume <deployment-id>` waits for the existing one
(and publishes afterwards, with `--publish`); it sends no deploy request. If the deploy request
itself got no answer, the deployment may or may not exist: check `wheelsai agents get <agent>`
first.

### Publishing

`--publish` creates and publishes a marketplace listing once the deployment is running; the
`publish` command does the same on its own and is safe to run again.

With `deploy --publish`, everything about the listing that can be known in advance is checked
before any GPU is requested: prices (`--price-per-request` 1 to 100000 cents, `--monthly` 100
to 10000000), `--title` (3 to 100 characters), `--description` (10 to 280), `--category`, and,
when the agent has no listing yet, that its name works as a title. These are the API's own
limits. If the listing still fails after the deployment is running, the error says the agent is
live and gives the exact `wheelsai publish ...` command, with your flags, to retry only the listing.

```bash
wheelsai publish --agent my-support-bot                          # free listing
wheelsai publish --agent my-support-bot --price-per-request 5    # cents per request
wheelsai publish --agent my-support-bot --monthly 900            # cents per month
wheelsai publish --agent my-support-bot --tokenized             # token-gated once a token is launched
wheelsai publish --agent my-support-bot --title "Support Pro" --category customer-support \
  --description "Answers order and refund questions."
```

| Flag | Default |
| --- | --- |
| pricing: `--free`, `--price-per-request <cents>`, `--monthly <cents>`, `--tokenized` (choose one) | free for a new listing, so publishing never charges by accident; an existing listing keeps its pricing |
| `--title` | the agent's name |
| `--description` | the agent's description (cut to 280 characters), else `<name>: a <framework> agent built on WheelsAI.` |
| `--category` | a category found in the agent's tags, else `other` (`customer-support`, `coding`, `research`, `automation`, `creative`, `other`) |

An agent has at most one listing, so a second run reuses it: it is edited only if you passed
flags, published if it is not yet, and left alone otherwise. The printed URL is
`<web URL>/marketplace/<slug>`, where the slug is what the API returned (it is derived from
the title, so it can differ from the agent's slug). Pricing, `--title`, `--description` and
`--category` without `--publish` are rejected up front, before any GPU is requested.

A `--tokenized` listing is gated only once a token has been launched for it (in the
dashboard); the CLI launches none, and until then anyone can install it for free. The CLI says
so when it prints the listing.

## Inspect

```bash
wheelsai agents list                  # slug, name, latest deployment status
wheelsai agents get my-support-bot    # configuration, secrets' names, every deployment
wheelsai test my-support-bot -m "Hello" --model free/groq/llama-3.3-70b    # playground, no GPU
wheelsai logs <deployment-id>         # status and logs of an agent deployment
wheelsai logs <deployment-id> --model # a model deployment (GET /api/deployments)
```

`test` waits up to `--timeout` seconds (default 120) for the reply. If the agent is an installed
marketplace listing priced per request, the message is charged, and the charge the API reports
is printed (`Charged: $0.25 for this request (marketplace listing "Support Pro")`).

Text that comes from the API (model output, logs, error messages, names) is printed with
control characters removed, so it cannot move the cursor or write to the clipboard. `--json`
output is exact.

`logs` accepts the id `wheelsai deploy` prints. There is no endpoint that takes a deployment
id alone, so it finds the owner by trying the agent whose newest deployment matches, then the
others (`--agent <slug-or-id>` skips the search), and falls back to model deployments, whose
events are Nosana lifecycle events (`--lines 10..1000`). The API exposes no container output,
and the CLI prints exactly the logs and last error the API has: `No logs available` when there
are none. `--json` is available on `agents`, `whoami`, `config show`, `test`, `deploy`, `publish` and `logs`.

## Exit codes and errors

`0` on success, `1` on any failure, `130` when interrupted while waiting for a deployment or
at a prompt.
Failures print the API's own message, then (dim) its HTTP status and error code, then what to
do next, for example:

```text
✖ Deploying requires a reservation of $0.37 in credits. Add credits and retry.
  HTTP 402 insufficient_credits
  Add credits at http://localhost:3000/dashboard/billing
```

Errors you may meet when deploying: `401` (credentials rejected or expired: `wheelsai login`),
`402 insufficient_credits`, `429 deployment_quota_exceeded` (the organization's limit on
active agent deployments), `429 plan_limit_reached` (the plan's monthly allowance is used up;
retrying does not help until it resets), a plain `429` (rate limit: wait a minute). On a server
with no compute configured, an agent deploy is accepted and then ends as a `failed` deployment
whose error says so, and its credit reservation is released.

## Development

```bash
npm run typecheck -w @wheelsai/cli     # source and tests
npm test -w @wheelsai/cli              # unit tests against an in-memory fake of the API
```

Tests need the SDK built (`npm run build -w @wheelsai/sdk`). The deploy flow lives in
`src/lib/deploy.ts` as a function that takes the SDK client, so the tests drive it with a fake
API. `test/commands.test.ts` runs the compiled command itself against an HTTP server on
`127.0.0.1`, with `WHEELSAI_CONFIG_DIR` set to a temporary directory. Nothing touches the
network or your saved config. Both suites run in the blocking `sdk-cli` CI job.
