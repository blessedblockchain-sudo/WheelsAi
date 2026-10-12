# The GPU door

A small program that stands between a public tunnel and the API on a development machine and passes
two requests only.

## Why

Fine-tuning hands two addresses of the API to a container on a rented GPU: the address a training run
reports its progress to, and the address a deployed fine-tuned model fetches its adapter from. On a
development machine the API is not on the internet, so a GPU can reach it only through a tunnel. A
tunnel straight to the API would also put the sign-in, the dashboard's API and the admin routes on the
internet for as long as it runs.

The door is what the tunnel points at instead. It lets those two requests through to the API and
answers `404` to everything else, so the rest of the machine is never reachable from outside.

The tunnel is for a proof. Its address changes at every start. A hosted API has a public address of
its own and needs no door: the door is never deployed.

## What passes

| Request | What it is |
|---|---|
| `POST /api/training/jobs/<job id>/events?n=<nonce>` | A training run's signed progress report. The job id is a lower-case UUID, the nonce is 16 lower-case hex characters. The body must be `Content-Type: application/json` and at most 65,536 bytes (`TRAINING_CALLBACK_MAX_BYTES`). |
| `GET /api/training/fine-tuned-models/<model id>/adapter?d=<deployment id>&g=<digits>&sig=<64 hex>` | The adapter download of a deployed fine-tuned model. Both ids are lower-case UUIDs, the parameters come in this order, and there is no body. The API's answer comes back as it is: a `302` with its `Location` (the door does not follow it), a `200` stream, or a `404`. |
| `GET /__door/health` | Answered by the door itself with `200 {"door":"ok"}`. The API never sees it. Use it to check a tunnel from outside. |

The request target is matched as it arrives, before anything is decoded, and is forwarded byte for
byte. The door checks shapes, not secrets: the API still verifies the signature of every progress
report and of every adapter address.

## What does not

Everything else is answered `404 {"error":"not_found"}` with `Cache-Control: no-store`, and the API
never sees it: any other path, any other method on the two paths, a different or extra query
parameter, capitals in the hex, a trailing slash, `//`, `%` escapes, a target that does not start with
`/`, a `GET` with a body, a `POST` whose content type is not exactly `application/json`, `CONNECT`,
any `Upgrade`, and anything that is not readable HTTP. For the last three the socket is closed.

The door's other answers:

| Status | When |
|---|---|
| `413 {"error":"payload_too_large"}` | A progress report over 65,536 bytes. The bytes are counted as they arrive, whatever `Content-Length` said. |
| `429 {"error":"rate_limited"}` | More than one passing request a second, after a burst of 30. |
| `503 {"error":"busy"}` | 32 passing requests are already in the door's hands. |
| `502 {"error":"bad_gateway"}` | The API is not answering (it is not running, or it broke off), or its answer has a status outside 200 to 599. |
| `504 {"error":"gateway_timeout"}` | The API did not start its answer in 10 seconds, or a whole progress report took more than 30 seconds, or an adapter download more than 15 minutes. |
| `408 {"error":"request_timeout"}` | The caller did not finish sending a progress report in 30 seconds. |

The trainer and the serving container both try again after `429` and any `5xx`, and give up on any
other `4xx`.

## What is forwarded

To the API: the method, the target, and four request headers only (`content-type`, `content-length`,
`x-wheelsai-signature`, `user-agent`), plus the `Host` and `Connection` that HTTP itself needs, which
name the upstream. No cookie, no `authorization`, no forwarding header. The door reads a whole
progress report before it sends it on, so the API never receives a part of one.

Back to the caller: the status and four headers only (`content-type`, `content-length`, `location`,
`cache-control`).

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `DOOR_UPSTREAM` | `http://127.0.0.1:4000` | Where the API is. It must be http on a loopback address (`127.x.x.x` or `[::1]`), written as an address, with nothing after the port. Anything else, a name such as `localhost` included, is refused at start. |
| `DOOR_PORT` | `4180` | The port the door listens on. It listens on `127.0.0.1` only. |
| `DOOR_MAX_IN_FLIGHT` | `32` | Passing requests in the door's hands at once. |
| `DOOR_RATE_PER_SECOND` | `1` | Passing requests a second, once the burst is spent. |
| `DOOR_BURST` | `30` | Passing requests that may come at once. |
| `DOOR_SOURCE_ADDRESS` | `127.0.0.2` on Linux | The address the door calls the API from: any address in `127.0.0.0/8`, or `off` for `127.0.0.1`. See "Its own allowance at the API" below. |

A bad setting ends the program with one sentence and a non-zero exit. No setting can point the door
at another machine.

## What it logs

One JSON line per request on stdout:

```
{"time":"2026-10-12T09:30:00.000Z","method":"POST","path":"/api/training/jobs/<job id>/events","passed":true,"status":200,"bytesIn":118,"bytes":32,"ms":7}
```

- `path` never holds the query, because the query holds the nonce and the adapter signature. For a
  refused request it is cut to 80 characters and holds printable ASCII only.
- `passed` is true when the request was sent on to the API (or was the health check). A `502` or a
  `504` is a passed request the API did not answer.
- `status` is what the caller was sent, and `0` when the caller left before any answer.
- `bytesIn` is the size of the body received, `bytes` the size of the body sent back, `ms` the time
  it took.

Never a header and never a body. The first line says where the door listens, where it sends, and
what passes.

## How the proof uses it

Node 20 or newer. No dependency, no build step.

```
node infra/gpu-door/door.mjs                      # 127.0.0.1:4180 -> 127.0.0.1:4000
cloudflared tunnel --url http://127.0.0.1:4180    # prints https://<name>.trycloudflare.com
# start the API with GPU_FACING_API_URL=https://<name>.trycloudflare.com
```

1. Start the door. It does not need the API to be running yet.
2. Start the tunnel and point it at the door, never at the API.
3. Check the tunnel from outside: `curl https://<name>.trycloudflare.com/__door/health` answers
   `{"door":"ok"}`, and any other address answers `404`.
4. Start the API with `GPU_FACING_API_URL` set to the tunnel's address. Only the training progress
   address and the adapter download use it. `PUBLIC_API_URL` stays as it is.
5. When the proof is over, stop the tunnel, then the door (Ctrl-C, or SIGTERM).

Every start of the tunnel prints a new address. A job submitted with the old address reports to
nowhere, and a deployment started with it cannot fetch its adapter on a restart, so keep one tunnel
up for the whole proof and restart the API whenever the address changes.

One limit to know: the door only helps with the two addresses on the API. With the local storage
driver the dataset and upload links of a training job also point at this machine, and the door does
not pass them. A proof on a real GPU needs a bucket for those (`STORAGE_DRIVER=s3`).

## Its own allowance at the API

The API allows one address so many requests a minute (`RATE_LIMIT_MAX_PER_MINUTE`, 100 when it is not
set), and on a development machine the dashboard reaches the API from `127.0.0.1`. The door forwards
no caller address, so if it called from `127.0.0.1` too, a stranger who found the tunnel could use up
the dashboard's allowance with well-formed requests.

Two things keep that from happening:

- **The door calls the API from an address of its own**, `127.0.0.2`. The API counts it apart from
  `127.0.0.1`, so nothing sent through the tunnel is ever counted against the dashboard. On Linux
  every address in `127.0.0.0/8` is this machine and nothing needs setting up. Elsewhere only
  `127.0.0.1` is, the default is `off`, and the door shares the allowance of everything else on the
  machine.
- **The door passes less than the API allows.** One request a second after a burst of 30 is at most
  90 in its busiest minute, under the API's 100. A training run reports every ten seconds at most,
  with a handful more at its start and end, and a deployment fetches its adapter once a start, so the
  door's limit is many times what a proof sends.

What a stranger can still do: fill the door's own limit, so that real progress reports get `429` from
the door. The trainer tries each report three times and then goes on training; the run still finishes
and the API learns how it ended from Nosana. Live progress is what is lost. Keep the tunnel's address
private and the tunnel up no longer than the proof needs.

## Tests

```
unshare -r -n sh -c 'ip link set lo up; node --test infra/gpu-door/door.test.mjs'
node --check infra/gpu-door/door.mjs
```

Name the file: `node --test infra/gpu-door/` fails on Node 22 before any test runs. The tests run a
fake API and the door on loopback ports the system picks. Nothing leaves the machine.
