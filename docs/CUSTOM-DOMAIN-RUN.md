# Custom domains with real TLS — proof run

**Date:** 2026-10-06 · **Branch:** `feat/bags-launchpad` (working tree on top of `2114947`)
**Migration under test:** `20261009200000_custom_domain_edge`

**Verdict:** partly proven. Everything the API, the checker and the edge proxy do was run for
real on one machine, up to the point where a public certificate authority issues a
certificate. **No certificate was issued for a custom domain, and none is claimed.** The edge
app and its public addresses do not exist yet (`docs/FOUNDER-ACTIONS.md`, section 12). What
that leaves unproven, and the exact run that closes it, are at the end of this document.

The claim: the Pro plan includes custom domains, and the dashboard said a domain was "SSL
Active" with a Let's Encrypt certificate. Before this work that status came from a timer and
no request to a custom domain was ever routed. The claim now rests on four things, each
exercised below: ownership verified in DNS, a verified domain routed to its one target and
nothing else, certificates issued on demand by an edge that asks the API first, and a
checker that records only what it observed.

Everything below is a command that was run and its output. Trimming, and no other edits:
`jq` filters (shown in the command) select fields, long model text is cut with `…`, API keys
and the two shared secrets are shown as `$KEY`, `$OTHER`, `$ASK_TOKEN` and `$EDGE_SECRET`.

---

## The environment

| | |
|---|---|
| API | `apps/api`, `npx tsx src/index.ts`, port **4250**, `API_HOST=::` (the setting the edge needs on Fly) |
| Database | a **disposable copy** of the local dev database, `wheelsai_cdproof`, with the pending migrations applied to the copy only |
| Redis | `localhost:6380`, database index **9**, empty at the start |
| Workers | the custom-domain checker on (`CUSTOM_DOMAIN_CHECK_INTERVAL_MS=60000`); every other worker off |
| Organization | the seeded "Northwind AI Labs" (Pro, active), owner `demo@northwind.ai`; plus a new Starter organization registered during the run |
| DNS | real, public, through `CUSTOM_DOMAIN_DNS_SERVERS=1.1.1.1,8.8.8.8` |
| Edge proxy | the image built from `infra/edge` (Caddy 2.10.2), run locally in Docker in front of the API for steps 6 and 8 |
| Model | the agent's `free/groq/llama-3.3-70b` |

### The stand-in for the edge, and why

Custom domains switch on only when the API is told the edge's hostname and **public**
addresses; private and reserved addresses are refused by the configuration. There is no
edge on a public address yet. So that the DNS checks and the certificate probe could run
against something real, the run named the addresses of a public website as "the edge":

```
CUSTOM_DOMAIN_EDGE_HOSTNAME=example.net
CUSTOM_DOMAIN_EDGE_IPV4=104.20.26.136,172.66.157.237
CUSTOM_DOMAIN_EDGE_IPV6=2606:4700:10::6814:1a88,2606:4700:10::ac42:9ded
```

Those are the addresses `example.org` resolved to on the day (`dig example.org @1.1.1.1`).
With that, `example.org` is a real hostname whose DNS "points at the edge", `example.com` is
a real hostname whose DNS points somewhere else, and neither is under our control, which is
exactly the situation of a customer who has not published a record yet. `example.net` only
plays the name customers would point a CNAME at; the API never resolves it. This is a lab
arrangement: `example.org` is not ours, and nothing below says a certificate was issued to
us for it.

### The database copy

```bash
psql postgresql://wheelsai:…@localhost:5434/postgres -c "CREATE DATABASE wheelsai_cdproof TEMPLATE wheelsai"
for m in 20261009100000_offerings_jobs_runner 20261009110000_job_model_usage \
         20261009200000_custom_domain_edge; do
  psql postgresql://wheelsai:…@localhost:5434/wheelsai_cdproof -v ON_ERROR_STOP=1 -1 -q \
    -f packages/db/prisma/migrations/$m/migration.sql
done
```

All three applied without error, each in one transaction (the first two belong to the
Offerings and Jobs work and were pending on the dev database; the API needs them to boot).
The dev database held one custom domain, never verified. After the migration, in the copy:

```
domain              | demo.wheelsai.test
verified_domain     |
verification_status | pending
routing_status      | pending
ssl_status          | pending
ssl_provider        |
ssl_expires_at      |
ssl_issuer          |
enabled             | t
is_active           | f
force_https         | t
```

The copy held no row the old timer had marked "active", so the migration's repair of such
rows had nothing to do here. That repair was run against seeded rows when the migration was
written; it is not shown again.

---

## 1. Without the edge settings: "not configured", by name

The API was first started with no `CUSTOM_DOMAIN_*` variable set.

```
INFO: Server running at http://:::4250
INFO: Custom domain check queue disabled (custom domains are not configured)
    reason: "Custom domains are not configured on this server: the edge proxy settings (CUSTOM_DOMAIN_EDGE_HOSTNAME, CUSTOM_DOMAIN_EDGE_IPV4/IPV6, CUSTOM_DOMAIN_ASK_TOKEN, CUSTOM_DOMAIN_EDGE_SECRET) are not set."
INFO: Custom domain routing disabled (custom domains are not configured)
```

`curl http://127.0.0.1:4250/health` and `curl 'http://[::1]:4250/health'` both answered 200:
with `API_HOST=::` the API listens on IPv4 and IPv6.

```bash
curl -s $B/api/domains/config -H "Authorization: Bearer $TOKEN" | jq -c .data
```

```json
{"configured":false,"unavailableReason":"Custom domains are not configured on this server: the edge proxy settings (CUSTOM_DOMAIN_EDGE_HOSTNAME, CUSTOM_DOMAIN_EDGE_IPV4/IPV6, CUSTOM_DOMAIN_ASK_TOKEN, CUSTOM_DOMAIN_EDGE_SECRET) are not set.","edge":null,"verification":{"recordPrefix":"_wheels-verification","type":"TXT"},"plan":{"plan":"pro","entitled":true,"upgradeUrl":"/dashboard/billing?upgrade=pro","includedIn":["pro","enterprise"]},"policy":{"httpsEnforced":true,"verificationGraceHours":72,"pendingExpiryDays":14}}
```

This is what the dashboard's "Custom domains are not configured on this server" banner
reads. Every write that needs the edge answers the house 501:

| Request | Answer |
|---|---|
| `POST /api/domains` | `501 {"error":"custom_domains_not_configured","message":"Custom domains are not configured on this server: the edge proxy settings (…) are not set."}` |
| `POST /api/domains/{id}/verify` | `501 custom_domains_not_configured` |
| `POST /api/domains/{id}/reverify` | `501 custom_domains_not_configured` |
| `POST /api/domains/{id}/ssl/renew` | `501 custom_domains_not_configured` |
| `POST /api/domains/{id}/toggle` `{"isActive":true}` | `501 custom_domains_not_configured` |
| `POST /api/domains/{id}/toggle` `{"isActive":false}` | `404 not_found` (switching off needs no edge; the id did not exist) |
| `GET /api/domains/{id}` | `404 not_found` (reads work) |
| `GET /internal/edge/ask?domain=example.com&token=anything` | `501 custom_domains_not_configured` |
| `GET /v1/models` with `X-Wheels-Custom-Host` and an edge token | `404 {"error":"custom_domain_not_active","message":"This domain is not serving requests."}` |

`GET /api/domains/stats` answered `{"total":0,"verified":0,"active":0,"pending":0,"paused":0,"sslExpiringSoon":0}`.

The server was stopped and started again with the stand-in edge settings above and two
random 48-character secrets:

```
INFO: Custom domain check BullMQ queue started
    intervalMs: 60000
    edge: "example.net"
INFO: Custom domain route table loaded
```

```bash
curl -s $B/api/domains/config -H "Authorization: Bearer $TOKEN" | jq -c '.data | {configured, edge, plan: .plan.plan, entitled: .plan.entitled}'
```

```json
{"configured":true,"edge":{"hostname":"example.net","ipv4":["104.20.26.136","172.66.157.237"],"ipv6":["2606:4700:10::6814:1a88","2606:4700:10::ac42:9ded"]},"plan":"pro","entitled":true}
```

## 2. A domain refused, once for each rule

`POST /api/domains` as the Pro organization's owner, target a real agent of that
organization unless stated.

| `domain` (or what was wrong) | Answer |
|---|---|
| `203.0.113.7` | `400 {"error":"invalid_domain","message":"An IP address cannot be a custom domain."}` |
| `*.example.org` | `400 {"error":"invalid_domain","message":"Wildcard domains are not supported. Add each hostname separately."}` |
| `localhost` | `400 {"error":"invalid_domain","message":"Enter a full domain name, like api.example.com."}` |
| `bad_label.example.org` | `400 {"error":"invalid_domain","message":"Domain names cannot contain underscores."}` |
| `https://example.org/path` | `400 {"error":"invalid_domain","message":"Enter only the domain name, without a scheme, port or path."}` |
| `app.fly.dev` | `400 {"error":"reserved_domain","message":"Names ending in .fly.dev cannot be used as a custom domain."}` |
| `db.internal` | `400 {"error":"reserved_domain","message":"Names ending in .internal cannot be used as a custom domain."}` |
| `example.net` (the edge's own name) | `400 {"error":"reserved_domain","message":"That name belongs to the platform and cannot be used as a custom domain."}` |
| `api.example.net` (under the edge's name) | `400 reserved_domain`, same message |
| target is an agent of another organization | `400 {"error":"target_not_found","message":"That agent does not exist in this organization."}` |
| `targetId` not a UUID | `400 {"error":"validation_failed","details":{"formErrors":[],"fieldErrors":{"targetId":["Invalid uuid"]}}}` |
| `targetType: "workflow"` | `400 validation_failed` (`Expected 'agent' \| 'deployment'`) |
| `forceHttps: false` | `400 {"error":"https_required","message":"HTTPS is always enforced on a custom domain; it cannot be switched off."}` |
| `headers: {"Set-Cookie": "a=b"}` | `400 {"error":"invalid_headers","message":"The Set-Cookie header is set by the platform and cannot be overridden."}` |
| extra key `sslStatus: "active"` | `400 validation_failed` (`Unrecognized key(s) in object: 'sslStatus'`) |
| no session | `401 {"error":"Unauthorized","message":"Authentication required"}` |
| the same name a second time | `409 {"error":"domain_exists","message":"This domain is already added to your organization."}` |
| a name another organization has verified | `409 {"error":"domain_claimed","message":"This domain is already verified by another organization."}` |
| an organization on the Starter plan | `403 {"error":"plan_limit_reached","message":"Custom domains are included in the Pro plan and above.","plan":"starter","limit":"customDomains","upgradeUrl":"/dashboard/billing?upgrade=pro"}` |

Two of those needed a set-up step. For "claimed", a verified row for `iana.org` owned by the
seeded organization "Kestrel Labs" was **inserted into the copy by hand**; the refusal left
exactly that one row for the name. For the plan, a new account was registered through
`POST /api/auth/register` during the run; its `GET /api/domains/config` said
`{"plan":"starter","entitled":false,"upgradeUrl":"/dashboard/billing?upgrade=pro","includedIn":["pro","enterprise"]}`,
which is what the dashboard's upgrade banner reads.

The plan table gives no count of custom domains per plan, only whether a plan includes them
(Starter no, Pro yes, Enterprise yes). That is what is enforced and what `includedIn` states;
no number was invented.

Not exercised over HTTP: the owner-or-admin requirement on writes. The seeded member account
could not sign in on this database ("User has no organization", a sign-in problem outside
custom domains), so that guard stands on its unit test (`domainsRoute.unit.test.ts`).

## 3. Three real hostnames added

```bash
curl -s -X POST $B/api/domains -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"domain":"EXAMPLE.ORG.","targetType":"agent","targetId":"25bc2504-946c-46ab-b1e7-ca82f182cf7e"}' \
  | jq '{message, data: (.data | {id, domain, targetType, verificationStatus, routingStatus, sslStatus, enabled, isActive, forceHttps, nextCheckAt, dnsRecords, certificate})}'
```

```json
{
  "message": "Domain added. Publish the DNS records to verify it.",
  "data": {
    "id": "19040101-b975-4ff4-a273-e3e45409c2a2",
    "domain": "example.org",
    "targetType": "agent",
    "verificationStatus": "pending",
    "routingStatus": "pending",
    "sslStatus": "pending",
    "enabled": true,
    "isActive": false,
    "forceHttps": true,
    "nextCheckAt": "2026-10-06T11:53:49.778Z",
    "dnsRecords": {
      "txtRecord": { "name": "_wheels-verification.example.org", "type": "TXT", "value": "wheels-verify-732d0ccb4e1c255051b2dcdb525aaee8" },
      "cnameRecord": { "name": "example.org", "type": "CNAME", "value": "example.net" },
      "aRecords": [
        { "name": "example.org", "type": "A", "value": "104.20.26.136" },
        { "name": "example.org", "type": "A", "value": "172.66.157.237" }
      ],
      "aaaaRecords": [
        { "name": "example.org", "type": "AAAA", "value": "2606:4700:10::6814:1a88" },
        { "name": "example.org", "type": "AAAA", "value": "2606:4700:10::ac42:9ded" }
      ],
      "recommended": "a"
    },
    "certificate": { "status": "pending", "provider": null, "issuer": null, "validFrom": null, "expiresAt": null, "fingerprint256": null, "checkedAt": null, "error": null }
  }
}
```

The name was normalised (`EXAMPLE.ORG.` became `example.org`), HTTPS is on, nothing about a
certificate is filled in, the first automatic check is scheduled two minutes out, and a root
domain is told to publish address records (`"recommended": "a"`). Every value in
`dnsRecords` comes from the server's configuration.

Two more, for contrast:

```json
{"id":"bf3e7c89-e40d-43d3-9f3c-5e93460ba7f8","domain":"www.example.org","dnsRecords":{"txt":"_wheels-verification.www.example.org","cname":{"name":"www.example.org","type":"CNAME","value":"example.net"},"recommended":"cname"}}
{"id":"54ac8364-a7b7-4f21-85ce-9cbc5538d216","domain":"example.com","targetType":"deployment","recommended":"a"}
```

A subdomain is told to publish the CNAME. `example.com` points at a model deployment of the
organization (`code-assist`, stopped).

## 4. Verification against real DNS, as far as it goes without owning the records

"Check now" (`POST /api/domains/{id}/verify`) looks the TXT record and the addresses up
through the configured resolvers.

```bash
curl -s -X POST $B/api/domains/$ID/verify -H "Authorization: Bearer $TOKEN" \
  | jq -c '.data | {verified, verificationStatus, routingStatus, sslStatus, isActive, message, observed, isApex: .domain.isApex, routingError: .domain.routing.error}'
```

`example.org`:

```json
{"verified":false,"verificationStatus":"pending","routingStatus":"ok","sslStatus":"pending","isActive":false,"message":"No TXT record was found at _wheels-verification.example.org.","observed":{"txtFound":false,"addresses":["104.20.26.136","172.66.157.237","2606:4700:10::6814:1a88","2606:4700:10::ac42:9ded"],"addressesChecked":true},"isApex":true,"routingError":null}
```

`www.example.org`: the same addresses, `"routingStatus":"ok"`, `"isApex":false`,
`"message":"No TXT record was found at _wheels-verification.www.example.org."`

`example.com`:

```json
{"verified":false,"verificationStatus":"pending","routingStatus":"misrouted","sslStatus":"pending","isActive":false,"message":"No TXT record was found at _wheels-verification.example.com.","observed":{"txtFound":false,"addresses":["104.20.23.154","172.66.147.243","2606:4700:10::6814:179a","2606:4700:10::ac42:93f3"],"addressesChecked":true},"isApex":true,"routingError":"example.com resolves to 104.20.23.154, 172.66.147.243, 2606:4700:10::6814:179a, 2606:4700:10::ac42:93f3, which is not the edge. Remove the other records; if a CDN proxies the record, switch it to DNS only."}
```

What this shows, against the public DNS:

- The ownership record is really looked up, and its absence is reported as absence. No domain
  was verified, because none of these zones is ours to publish a TXT record in. **A TXT
  record being found and a domain becoming verified by it was not run here**; it is covered
  by unit tests with a fake resolver and is step 3 of the run that remains.
- The addresses are really resolved (A and AAAA), compared with the edge's, and listed. The
  zone apex is detected from the SOA record.
- A domain pointing elsewhere says where it points and what to do.

Asking for a certificate check on an unverified domain is refused:
`POST /api/domains/{id}/ssl/renew` answered
`400 {"error":"not_verified","message":"Verify the domain before checking its certificate."}`.

## 5. The edge's question: may I obtain a certificate for this name?

`GET /internal/edge/ask?domain=<name>&token=$ASK_TOKEN` is what Caddy calls before it
requests a certificate. Anything but 200 means no certificate.

Before any domain was verified:

| Asked about | Answer |
|---|---|
| `never-added.example.org` | `404 {"allowed":false,"reason":"unknown_domain"}` |
| `example.org` (added, **not verified**) | `404 {"allowed":false,"reason":"unknown_domain"}` |
| `example.org`, wrong token | `403 {"error":"forbidden"}` |
| `example.org`, no token | `403 {"error":"forbidden"}` |
| `10.0.0.1` | `400 {"error":"invalid_domain"}` |

An unverified domain is indistinguishable from one nobody added: only the verified claim on a
name can answer for it.

**Then ownership was set by hand in the copy.** The three zones are not ours, so no TXT
record could be published. To exercise what follows verification, the state was written
directly:

```sql
update custom_domains set verification_status='verified', verified_domain=domain, verified_at=now(), verification_error=null
where id in (…the three ids…) returning domain, verification_status, routing_status, ssl_status, enabled, is_active;
```

```
     domain      | verification_status | routing_status | ssl_status | enabled | is_active
-----------------+---------------------+----------------+------------+---------+-----------
 example.org     | verified            | ok             | pending    | t       | f
 www.example.org | verified            | ok             | pending    | t       | f
 example.com     | verified            | misrouted      | pending    | t       | f
```

`www.example.org` was then switched off through the API (`POST …/toggle {"isActive":false}`
answered `"Domain switched off; it stopped serving."`, `"pausedReason":"disabled"`).

| Asked about | State | Answer |
|---|---|---|
| `www.example.org` | verified, switched off | `403 {"allowed":false,"reason":"disabled"}` |
| `example.com` | verified, DNS elsewhere | `403 {"allowed":false,"reason":"dns_not_routed"}` |
| `example.org` | verified, on, routed | `404 unknown_domain` for the next 60 seconds, then `200 {"allowed":true}` |
| `example.org` | subscription set to `canceled` in the copy | `403 {"allowed":false,"reason":"plan_inactive"}` |
| `example.org` | subscription set back to `active` | `200 {"allowed":true}` |

The 60 seconds are real and were observed: "unknown" is remembered for a minute per name so
that handshakes for random names do not each cost a database query, and `example.org` had
been asked about while unverified a minute earlier. A refusal about a known domain is never
remembered, which is why the plan change applied on the very next question.

Neither secret appeared in the API's log: `grep -c` for the ask token and for the edge secret
over both log files of the run printed `0`, and so did a search for `internal/edge/ask` (the
route logs at `warn`, so its request lines, which carry the token, are not written).

## 6. The edge proxy itself, built from `infra/edge` and run locally

```bash
docker build -f infra/edge/Dockerfile -t wheelsai-edge-check .     # runs `caddy validate` on the Caddyfile
docker run -d --name wheelsai-edge-proof -p 127.0.0.1:8080:80 -p 127.0.0.1:8443:443 \
  --add-host host.docker.internal:host-gateway \
  -e WHEELS_API_INTERNAL=http://host.docker.internal:4250 \
  -e CUSTOM_DOMAIN_ASK_TOKEN=$ASK_TOKEN -e CUSTOM_DOMAIN_EDGE_SECRET=$EDGE_SECRET \
  -e ACME_EMAIL=proof@example.org -e ACME_CA=http://127.0.0.1:9/directory \
  wheelsai-edge-check
```

The image built, so the Caddyfile is valid on the pinned Caddy. `caddy adapt` of it shows
the configuration the Caddyfile was written to produce: on-demand TLS with the permission
endpoint `http://wheelsai-api.internal:4000/internal/edge/ask?token=…`, the three headers
set on every forwarded request on both ports, automatic HTTP-to-HTTPS redirects off, and the
PROXY protocol wrapper in front of TLS.

`ACME_CA` was pointed at a closed local port **on purpose**: `example.org` is not ours, and a
real certificate authority must not be asked to issue for it. So this step shows the edge's
decision, not an issuance.

```bash
curl -s -m 15 -o /dev/null -w 'HTTP %{http_code} exit=%{exitcode} %{errormsg}\n' \
  --resolve <name>:8443:127.0.0.1 https://<name>:8443/v1/models
```

| TLS handshake for | Result |
|---|---|
| `never-added.example.org` | `exit=35 TLS connect error: … tlsv1 alert internal error` (refused: no certificate) |
| `www.example.org` (verified, switched off) | `exit=35 … tlsv1 alert internal error` (refused) |
| `example.org` (verified, on, routed) | the edge started to obtain a certificate, and timed out with no authority to reach |

From the edge's log, for the allowed name only:

```json
{"level":"info","msg":"obtaining new certificate","server_name":"example.org"}
{"level":"info","msg":"obtaining certificate","identifier":"example.org"}
{"level":"error","msg":"could not get certificate from issuer","identifier":"example.org","error":"registering account [mailto:proof@example.org] with server: provisioning client: performing request: Get \"http://127.0.0.1:9/directory\": dial tcp 127.0.0.1:9: connect: connection refused"}
```

So the edge asks the API, is refused for a name that is unknown or switched off and presents
nothing, and is allowed for the one name that qualifies, at which point it goes to the
certificate authority. **The certificate authority's part did not happen here.**

Plain HTTP through the same container reaches the API with the hostname the client asked
for (used again in step 8):

```bash
curl -s -i --haproxy-protocol http://127.0.0.1:8080/v1/models -H 'Host: never-added.example.org'
```

```
HTTP/1.1 404 Not Found
Content-Type: application/json; charset=utf-8
Strict-Transport-Security: max-age=15552000
```

(the same request without a PROXY protocol header also answered 404; the body is
`custom_domain_not_active`). The `Strict-Transport-Security` value has no
`includeSubDomains`: a customer's hostname is pinned to HTTPS, its subdomains are not.

## 7. The checker observes; it does not assume

At their next scheduled check (11:55:00, the tick after the hand-set verification), the
checker looked at `example.org` and `example.com` itself. It did not take the database's
word for it:

```
[11:55:00] INFO: Custom domain check tick complete
    due: 2   updated: 2   failed: 0   probed: 1   edgeOutageSuspected: false
```

```
domain               | example.org
verification_status  | verified
verification_lost_at | 2026-10-06 11:55:00.074
verification_error   | The TXT record at _wheels-verification.example.org is missing. The domain keeps serving until 2026-10-09T11:55:00.074Z; restore the record to keep it.
routing_status       | ok
ssl_status           | provisioning
is_active            | f
paused_reason        |
next_check_at        | 2026-10-06 11:57:00.074

domain               | example.com
verification_status  | verified
verification_lost_at | 2026-10-06 11:55:00.074
routing_status       | misrouted
ssl_status           | pending
is_active            | f
paused_reason        | dns_not_routed
```

The domain's history (`GET /api/domains/{id}/events`), newest first:

```json
{"eventType":"verification_lost","message":"The TXT record at _wheels-verification.example.org is missing. The domain keeps serving for 72 hours."}
{"eventType":"ssl_provisioning","message":"The domain is verified and routed; waiting for the edge to present a certificate."}
{"eventType":"routing_ok","message":"DNS for example.org points at the edge."}
{"eventType":"created","message":"Domain added"}
```

The 72-hour grace is the decision that was made: the record is missing, the domain is not
demoted, and the row says until when. (Whether it is demoted after the 72 hours was not
waited for; that transition is unit-tested.)

### The certificate probe against a real public site

The prober is `probeTlsCertificate` in `apps/api/src/services/tlsCertificateProbe.ts`. Called
directly, with the public trust roots and no proof request:

```bash
npx tsx probe.ts 104.20.26.136 example.org      # address, then the name sent as SNI and checked
```

```json
{"kind":"valid","certificate":{"issuer":"SSL Corporation Cloudflare TLS Issuing ECC CA 3","validFrom":"2026-09-26T22:05:05.000Z","validTo":"2026-12-25T22:13:27.000Z","fingerprint256":"72:83:11:2E:A5:A8:B4:E6:E2:2A:4A:F5:87:C1:00:F6:08:67:73:E4:66:E7:AB:C0:F5:B3:42:63:50:C1:4C:9E","altNames":["example.org","*.example.org"]},"proof":"not_requested"}
```

The same handshake with OpenSSL, for comparison:

```bash
echo | openssl s_client -connect 104.20.26.136:443 -servername example.org 2>/dev/null \
  | openssl x509 -noout -issuer -dates -fingerprint -sha256
```

```
issuer=C=US, O=SSL Corporation, CN=Cloudflare TLS Issuing ECC CA 3
notBefore=Sep 26 22:05:05 2026 GMT
notAfter=Dec 25 22:13:27 2026 GMT
sha256 Fingerprint=72:83:11:2E:A5:A8:B4:E6:E2:2A:4A:F5:87:C1:00:F6:08:67:73:E4:66:E7:AB:C0:F5:B3:42:63:50:C1:4C:9E
```

Issuer, both dates and the fingerprint agree. The other outcomes, against real hosts:

| Probe | Result |
|---|---|
| the same address, a name the certificate does not cover | `{"kind":"handshake_refused","code":"ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",…}` |
| `expired.badssl.com` | `{"kind":"certificate_invalid","code":"CERT_HAS_EXPIRED","message":"certificate has expired"}` |
| `self-signed.badssl.com` | `{"kind":"certificate_invalid","code":"DEPTH_ZERO_SELF_SIGNED_CERT","message":"self-signed certificate"}` |
| `127.0.0.1` (nothing listening on 443) | `{"kind":"unreachable","code":"ECONNREFUSED","message":"connect ECONNREFUSED 127.0.0.1:443"}` |

### The same probe through the API: a valid certificate that is not ours is not recorded

`example.org` was now "verified" (by hand) and routed, so `POST /api/domains/{id}/ssl/renew`
made the production handshake with the configured "edge" address, which in this lab is the
real `example.org`. It then asked that host for the per-domain proof
(`GET /.well-known/wheelsai-domain`), which only a request that reaches this API can answer.

```json
{"success":true,"data":{"message":"The certificate is valid, but requests for this domain did not reach the API.","probed":true,"sslStatus":"provisioning","sslIssuer":null,"sslExpiresAt":null,"sslCheckedAt":"2026-10-06T11:59:06.991Z","sslError":"The certificate is valid, but requests for this domain did not reach the API.","isActive":false,"pausedReason":null}}
```

A real, publicly trusted certificate for the exact name was on the wire, and the domain was
**not** marked as having a certificate: the issuer, the dates and the fingerprint stay null,
the status stays "provisioning", and it does not serve. A certificate counts only when the
host presenting it also forwards the domain to this API. `GET /api/domains/stats` after it:
`{"total":3,"verified":3,"active":0,"pending":0,"paused":2,"sslExpiringSoon":0}`.

This step also found a defect, fixed during the run. The first time, the handshake was made
but the answer read `"message":"No valid certificate was observed."` with `sslCheckedAt` and
`sslError` null: a handshake had happened and nothing recorded it, and the sentence was
wrong. `decideDomainTransition` now records the time and the reason for a valid certificate
whose proof fails (never the certificate's details), with a unit test; the output above is
from after the fix.

Asked again at once:

```
HTTP/1.1 429 Too Many Requests
retry-after: 900
{"error":"checked_recently","message":"The certificate was checked at 2026-10-06T11:59:06.991Z. It can be checked again after 2026-10-06T12:14:06.991Z.","retryAfterSeconds":900,"nextCheckAt":"2026-10-06T12:04:06.991Z"}
```

and for the domain whose DNS points elsewhere:
`400 {"error":"dns_not_routed","message":"example.com resolves to …, which is not the edge. …"}`.

## 8. A request for the domain reaches its target and nothing else

A domain serves only when a certificate has been observed, and none can be here. So, to
exercise routing, **the serving flag was set by hand in the copy**, and only that flag: the
certificate columns were left as observed (no issuer, status "provisioning").

Before:

```bash
edge() { curl -s -H "X-Wheels-Edge-Token: $EDGE_SECRET" -H "X-Wheels-Custom-Host: example.org" -H "X-Wheels-Edge-Proto: https" "$@"; }
edge $B/v1/models -H "Authorization: Bearer $KEY"
```

```json
{"error":"custom_domain_not_active","message":"This domain is not serving requests."}
```

(`404`). The three headers are what the edge sets on every request it forwards; here `curl`
sets them, standing in for the HTTPS leg that needs a certificate. The prober's proof is
answered for a verified domain even while it does not serve, as it must be for a first
certificate to be recognised: `GET /.well-known/wheelsai-domain` answered
`200 {"domain":"example.org","proof":"…"}`.

```sql
update custom_domains set is_active=true, next_check_at=now()+interval '30 minutes' where id='19040101-…'
returning domain, ssl_status, ssl_issuer, is_active;
--    domain    |  ssl_status  | ssl_issuer | is_active
--  example.org | provisioning |            | t
```

Within one reload of the route table (10 seconds):

```bash
edge $B/v1/models -H "Authorization: Bearer $KEY"
```

```json
{"object":"list","data":[{"id":"agent/research-analyst","object":"model","created":1790855937,"owned_by":"wheelsai","wheelsai":{"kind":"agent"}}]}
```

The same key on the platform's own host lists nine models
(`["support-llm","agent/support-concierge","agent/research-analyst","agent/release-notes-writer","agent/community-moderator","agent/sales-qualifier","agent/ops-runbook-bot","agent/seo-auditor-marketplace","workflow/weekly-release-pipeline"]`).
The domain lists the one it is bound to.

A chat completion that names a *different* agent as `model`:

```bash
edge -X POST $B/v1/chat/completions -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"agent/ops-runbook-bot","messages":[{"role":"user","content":"In one short sentence: who are you?"}]}'
```

```json
{"id":"chatcmpl-577586b8-389d-4ccf-87eb-9855d3809188","object":"chat.completion","created":1791287966,"model":"agent/research-analyst","system_fingerprint":null,"choices":[{"index":0,"message":{"role":"assistant","content":"**Executive Summary**  \nI am an artificial intelligence language model … Designed to assist users as a virtual research analyst, …
```

`200`, answered by `agent/research-analyst`, the domain's target, in that agent's report
format, by a real model call. The `model` field does not choose the target on a custom
domain. The response carried `strict-transport-security: max-age=15552000`.

Everything else on the hostname:

| # | Request on `example.org` (edge headers set) | Answer |
|---|---|---|
| 1 | `POST /v1/agents/ops-runbook-bot/chat/completions` (another agent's own path) | `404 {"error":"not_found","message":"This domain serves POST /v1/chat/completions and GET /v1/models."}` |
| 2 | `GET /api/agents` with the owner's session | `404 not_found`, same message |
| 3 | `POST /api/auth/login` | `404 not_found`, same message |
| 4 | `GET /internal/edge/ask?…` with the right ask token | `404 not_found`, same message |
| 5 | `GET /health` | `404 not_found`, same message |
| 6 | `GET /v1/models` with a key of **another organization** | `403 {"error":{"message":"This API key does not belong to the organization that owns this domain.","type":"invalid_request_error","param":null,"code":"wrong_organization"}}` |
| 7 | `GET /v1/models` with no credentials | `401 … "code":"invalid_api_key"` |
| 8 | host `www.example.org` (verified, switched off) | `404 custom_domain_not_active` |
| 9 | host `example.com` (verified, DNS elsewhere) | `404 custom_domain_not_active` |
| 10 | host `never-added.example.org` | `404 custom_domain_not_active` |
| 11 | a wrong edge secret with the custom-host header | `404 custom_domain_not_active` |
| 12 | `Host: example.org` and **no** edge headers, straight at the API | the platform's own `/v1/models` (nine models): a `Host` header alone routes nothing |
| 13 | the edge reports plain HTTP (`X-Wheels-Edge-Proto: http`), `GET /v1/models?x=1` | `308`, `location: https://example.org/v1/models?x=1` |

And through the real edge container from step 6, over plain HTTP, with a client trying to
supply the edge's headers itself:

```bash
curl -s -o /dev/null -D - http://127.0.0.1:8080/v1/models -H "Host: example.org" \
  -H "Authorization: Bearer $KEY" -H "X-Wheels-Edge-Proto: https" -H "X-Wheels-Custom-Host: www.example.org"
```

```
HTTP/1.1 308 Permanent Redirect
Location: https://example.org/v1/models
```

The edge replaced both headers with what it saw (the host `example.org`, the scheme `http`),
and the API recognised the serving domain and redirected it to HTTPS. The same request for
`Host: never-added.example.org` answered `404 custom_domain_not_active`. So a request with a
`Host` header for the domain, arriving through the edge, is recognised as that domain by the
API; what it was not possible to show is the HTTPS leg of that same path.

The counters, after the buffer's 10-second flush:

```
     domain      | total_requests |     last_request_at
-----------------+----------------+-------------------------
 example.com     |              0 |
 example.org     |              4 | 2026-10-06 11:59:27.958
 www.example.org |              0 |
```

Four: the forwarded requests made with the owning organization's key (three `GET /v1/models`,
one of them the header check, and the chat completion). The refused ones were not counted.

### The hand-set flag does not survive the checker

The domain's next check was then made due (`update … set next_check_at=now()`), and the
checker's next tick, within the minute, wrote:

```
   domain    |  ssl_status  | ssl_issuer | is_active | paused_reason
-------------+--------------+------------+-----------+---------------
 example.org | provisioning |            | f         |
```

and ten seconds later the same request answered
`404 {"error":"custom_domain_not_active","message":"This domain is not serving requests."}`.
Serving is derived from what was observed. With no observed certificate a domain does not
stay active, whatever the row says.

## 9. Owner actions

```bash
curl -s -X POST $B/api/domains/$ID/reverify -H "Authorization: Bearer $TOKEN" | jq -c '{message, verificationStatus: .data.domain.verificationStatus, verifiedDomain: .data.domain.verifiedDomain, sslStatus: .data.domain.sslStatus, isActive: .data.domain.isActive, tokenChanged: …}'
```

```json
{"message":"New verification token generated. Publish the new TXT record and check the domain.","verificationStatus":"pending","verifiedDomain":null,"sslStatus":"pending","isActive":false,"tokenChanged":true}
```

A new token releases the claim on the name and stops the domain. `DELETE /api/domains/{id}`
answered `{"success":true,"message":"Domain deleted"}` and the next read `404`.
`GET /api/domains` contained no `customKey` or `customCert` field (`grep -c` printed `0`).
A deployment read carries the new field: `GET /api/deployments/{id}` for `code-assist`
returned `"customEndpoint": null`, correct since none of its domains serves.

## 10. Shared capacity: the domain limit, the issuance budget, the checker batch

Added after a review found that one Pro organization could add any number of hostnames,
have the edge told "yes" for each, and so spend the one certificate-authority account and
the checker's passes for everyone. Run on 2026-10-06 against a second database copy
(`wheelsai_cdlimits`, both custom-domain migrations applied by `psql`, dropped afterwards)
with the real Prisma client; no edge and no certificate authority were involved.

```text
grants given 7 rows 7
refusal { granted: false, reason: 'issuance_budget_organization' }
creates { created: 5, domain_limit_reached: 25 } rows 5
at the cap, duplicate name -> domain_exists
loadDue 12 rows; per org [ 10, 1, 1 ] first four [
  'junk299.example.net', 'real0.example.org', 'real1.example.org', 'junk298.example.net' ]
```

- **Issuance budget.** 120 certificate questions for 120 fresh names of one organization,
  fired at once through two separate database clients (two API machines), with the
  organization's limit set to 7: exactly 7 were granted and 7 rows exist. The count and the
  insert run in one transaction behind `pg_advisory_xact_lock`.
- **Domain limit.** 30 simultaneous `createCustomDomain` calls with
  `CUSTOM_DOMAIN_MAX_PER_ORG=5`: 5 rows, 25 refusals `domain_limit_reached`.
- **Checker batch.** One organization with 300 due rows, all older than anyone else's, and
  two organizations with one due row each: the pass takes 10 of the 300 and both of the
  others, the others in the first three places.

Not shown here: the edge acting on a 429 (it treats every non-200 as a refusal, as in
section 6), and Let's Encrypt's own counting.

## Clean-up

```bash
docker rm -f wheelsai-edge-proof && docker rmi wheelsai-edge-check
kill <pid listening on 4250>
psql postgresql://wheelsai:…@localhost:5434/postgres -c "DROP DATABASE wheelsai_cdproof"
redis-cli -p 6380 -n 9 flushdb
```

`ss -ltn` showed nothing listening on 4250, 8080 or 8443 afterwards. The dev database was not
written to: it still has no `custom_domains.verified_domain` column, one custom domain row,
and no account from this run.

---

## What this proves, and what it does not

**Run for real here**

- The "not configured" state: the named 501 on every write, the reason in
  `GET /api/domains/config`, the checker and the router off.
- Every refusal rule for adding a domain, including the plan and a name verified elsewhere.
- DNS: the TXT lookup, A and AAAA resolution, apex detection, "points at the edge" and
  "points elsewhere", against the public DNS for real hostnames.
- The certificate question, for an unknown name, an unverified one, a wrong token, a
  switched-off domain, a misrouted one, a lapsed plan, and the one case that is allowed.
- The edge image built from `infra/edge`: its configuration is valid, it forwards with the
  right headers and overrides a client's attempt to set them, it refuses a TLS handshake for
  a name the API does not allow, and it goes to the certificate authority for one it does.
- The certificate probe reading issuer, validity and fingerprint from a real public
  certificate (matching OpenSSL), and classifying an expired, a self-signed, a wrong-name and
  an unreachable host.
- The checker noticing a missing ownership record and applying the 72-hour grace; refusing
  to record a valid certificate that does not lead to this API; and taking back a serving
  flag that no observation supports.
- Host routing: one domain, one target, nothing else on the hostname, another organization's
  key refused, plain HTTP redirected, requests counted.

**Set by hand in the database copy, and therefore not proven by this run**

- `verification_status = 'verified'` for the three domains (step 5). No TXT record of ours
  was found in DNS, because no zone here is ours.
- `is_active = true` for `example.org` (step 8). No certificate was observed for it.
- One verified row for another organization (step 2) and one subscription status (step 5).

**Not proven until the edge is deployed**

1. A public certificate authority issuing a certificate for a customer hostname through the
   edge's on-demand TLS, and Caddy storing and renewing it.
2. The checker recording that certificate (issuer, validity, fingerprint) with the proof
   passing, and the domain becoming active **by observation**.
3. An HTTPS request to `https://<customer hostname>/v1/chat/completions` answered by the
   target through the edge.
4. A TXT record of ours being found and verifying a domain end to end.
5. On Fly: the edge reaching the API over the private network with `API_HOST=::`, the PROXY
   protocol allow-list (`EDGE_PROXY_PROTOCOL_ALLOW`) being the right network, and client
   addresses surviving to the API's rate limiter. The Fly configuration files parse as TOML
   but were not validated by `flyctl` (no Fly login on this machine).
6. The 14-day expiry of a domain that never verifies and the end of the 72-hour grace were
   not waited for; both are unit-tested transitions.
7. The dashboard pages were type-checked and their wording unit-tested; they were not opened
   in a browser against this API.

## The run that remains

Needs: the items in `docs/FOUNDER-ACTIONS.md` section 12, and a hostname whose DNS you can
edit (below, `api.customer.example`). Do it on staging first. Record the output of every
step under a new heading in this file.

1. **Stand up the edge**: `docs/DEPLOY-RUNBOOK.md` section 7.1 to 7.3. Then
   `GET /api/domains/config` must say `"configured": true` and name the edge's hostname and
   every address from `flyctl ips list -a wheelsai-edge-staging`.
2. **Smoke** (runbook 7.4): a plain-HTTP request to the edge address for an unknown `Host`
   answers `404 custom_domain_not_active`, and a TLS handshake for an unknown name fails. If
   every connection fails, fix `EDGE_PROXY_PROTOCOL_ALLOW` and note the right value here.
3. **Add and verify.** As the owner of a Pro organization, `POST /api/domains` for
   `api.customer.example` with an agent on a free model as the target. Publish the TXT
   record it returns. `POST /api/domains/{id}/verify` until `"verified": true`. Record the
   response and the `verified` event.
4. **Route.** Publish the CNAME to the edge hostname (or the A and AAAA records).
   `POST …/verify` until `"routingStatus": "ok"`. Record `observed.addresses`.
5. **The ask.** `curl "https://<api>/internal/edge/ask?domain=api.customer.example&token=$ASK_TOKEN"`
   must answer `200 {"allowed":true}`.
6. **The certificate.** Wait for the checker (about two minutes after routing is ok) or
   `POST …/ssl/renew`. Record `flyctl logs -a wheelsai-edge-staging` showing the certificate
   obtained, then `GET /api/domains/{id}`: `certificate.status` must be `active` with an
   issuer, both dates and a fingerprint, `isActive` must be `true`, and the history must
   contain `ssl_observed`. Compare the fingerprint with
   `echo | openssl s_client -connect api.customer.example:443 -servername api.customer.example 2>/dev/null | openssl x509 -noout -issuer -dates -fingerprint -sha256`.
7. **Serve.**
   `curl https://api.customer.example/v1/models -H "Authorization: Bearer $KEY"` lists the
   one target;
   `curl https://api.customer.example/v1/chat/completions -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"model":"default","messages":[{"role":"user","content":"Hello"}]}'`
   is answered by it; `curl -i http://api.customer.example/v1/models` is a `308`; a key of
   another organization is a `403 wrong_organization`; `/api/auth/login` on the hostname is a
   `404`.
8. **Stop.** Switch the domain off: the same HTTPS request answers
   `404 custom_domain_not_active` (the handshake may still succeed with the stored
   certificate; the API is what refuses). Switch it on again and confirm it serves.
9. **Lose ownership.** Remove the TXT record, make the check due, and record
   `verificationLostAt` and the stated deadline. Put the record back and record that the
   deadline is cleared.
10. Only then: tick the items in `docs/FOUNDER-ACTIONS.md`, remove the first entry under
    "Custom domains" in `docs/HARDENING-BACKLOG.md`, and add the changelog entry.
