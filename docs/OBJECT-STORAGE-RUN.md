# Object storage and datasets — proof run

**Date:** 2026-10-07 · **Branch:** `feat/bags-launchpad` (working tree on top of `688fe21`)
**Migration under test:** `20261011200000_dataset_storage`

What this run shows, on this machine, with nothing simulated:

1. the migration applies to a copy of the local database, backfills the rows the old code
   left behind, and leaves no drift against `schema.prisma`;
2. the **local driver** through the running API: a dataset uploaded through a signed transfer
   link, validated end to end (a 30 MB file, then a 149 MB one with the API's memory watched),
   validated a second time, and deleted; every refusal on the way;
3. the **S3 driver** against a MinIO container at a custom endpoint with path-style addressing:
   presigned PUT and GET, head, ranged read, delete, and the same dataset flow through the API;
4. the honest refusals when no storage is configured.

Everything below is the command that was run and its output. `$S` is a scratch directory outside
the repository, `<token>` stands for a transfer token, `<uuid>` for an id, and signatures and
key ids in presigned URLs are masked by the `sed` shown in the script. The demo password is read
from `$DEMO_PASSWORD`. Section F lists what this run did **not** prove.

Sections A to E are the first run. A review of that work then found four defects in dataset
handling; **section G** is the second run, after they were fixed. Where G changes what an
earlier section shows (the Parquet line of B.10, the columns of A), the earlier output is left
as it was recorded and G says what is different now.

---

## The environment

| | |
|---|---|
| API | `apps/api/src/index.ts` under `tsx`, port **4300**, bound to 127.0.0.1 |
| Database | a **disposable copy** of the local dev database, `wheelsai_chainf` (`CREATE DATABASE … TEMPLATE wheelsai`), dropped at the end |
| Redis | `localhost:6380`, database index **11**, empty at the start, flushed at the end |
| Workers | every `*_INTERVAL_MS` set to 0; no Nosana wallet in the environment (`NOSANA_WALLET_PRIVATE_KEY=""`, and the API is started from a directory with no `.env`) |
| Owner | the seeded demo organization "Northwind AI Labs", `demo@northwind.ai` |
| S3 store | MinIO `RELEASE.2026-09-22T19-25-18Z` in a container on **127.0.0.1:4310**, data on a tmpfs, root credentials generated for the run and never printed |

The API was started three times with this script, once per storage configuration (the storage
variables are the script's arguments):

```bash
#!/usr/bin/env bash
# Starts the API for the storage proof: database copy, Redis index 11, every
# worker off, no Nosana wallet, local object store.
set -euo pipefail
REPO=/home/bprime/Bounties/WheelsAi
S=$S
DB_URL="$(grep '^DATABASE_URL=' $REPO/packages/db/.env | sed -E 's/^DATABASE_URL="?//; s/"?$//; s#/wheelsai(\?|$)#/wheelsai_chainf\1#')"
case "$DB_URL" in *"/wheelsai_chainf"*) ;; *) echo "WRONG TARGET"; exit 1;; esac
cd "$S/run"   # no .env here: nothing is loaded from the repository's .env files
env -i PATH="$PATH" HOME="$HOME" \
  NODE_ENV=development LOG_LEVEL=warn \
  DATABASE_URL="$DB_URL" REDIS_URL="redis://localhost:6380/11" \
  JWT_SECRET="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)" \
  API_PORT=4300 API_HOST=127.0.0.1 CORS_ORIGIN="http://localhost:4301" \
  NOSANA_WALLET_PRIVATE_KEY="" \
  RATE_LIMIT_MAX_PER_MINUTE=1000 \
  ALERT_EVALUATOR_INTERVAL_MS=0 ANALYTICS_SNAPSHOT_INTERVAL_MS=0 BAGS_FEE_SWEEP_INTERVAL_MS=0 \
  CUSTOM_DOMAIN_CHECK_INTERVAL_MS=0 DEPLOYMENT_STATUS_INTERVAL_MS=0 EMBEDDING_BACKFILL_INTERVAL_MS=0 \
  FEE_ROUTER_INTERVAL_MS=0 GPU_BILLING_INTERVAL_MS=0 JOB_SWEEP_INTERVAL_MS=0 PAYMENT_POLL_INTERVAL_MS=0 \
  PAYMENT_REAP_INTERVAL_MS=0 PAYMENT_SUBMIT_INTERVAL_MS=0 PAYOUT_EXECUTOR_INTERVAL_MS=0 \
  REPUTATION_ATTESTATION_INTERVAL_MS=0 SCHEDULER_INTERVAL_MS=0 SUBSCRIPTION_RENEWAL_INTERVAL_MS=0 \
  TOKEN_INDEXER_INTERVAL_MS=0 TREASURY_SETTLEMENT_BATCH_INTERVAL_MS=0 TREASURY_SETTLEMENT_INTERVAL_MS=0 \
  UPTIME_PROBER_INTERVAL_MS=0 WORKFLOW_REAP_INTERVAL_MS=0 \
  X402_SETTLEMENT_WORKER_ENABLED=false \
  "$@" \
  $REPO/node_modules/.bin/tsx --tsconfig $REPO/apps/api/tsconfig.json $REPO/apps/api/src/index.ts
```

A note on the MinIO image: `docker pull minio/minio` answered "repository does not exist" on
this date (Docker Hub's API returns 404 for `minio/minio`), and `quay.io/minio/minio` refused
anonymous pulls. The run used Chainguard's build of the same server,
`cgr.dev/chainguard/minio:latest`
(`sha256:e7ca559d9f7c0b5f24f5f669bb92f40f3ca88d56273b808bf3a7c116c17d2ffa`), started with:

```bash
docker run -d --name wheelsai-chainf-minio -p 127.0.0.1:4310:9000 --env-file $S/run/minio.env \
  --tmpfs /data:uid=65532,gid=65532 cgr.dev/chainguard/minio:latest server /data
```

---

## A. The migration on a copy of the database

Four rows shaped like the ones the old code wrote were inserted first, so the backfill has
something to do: a dataset whose `format` had been overwritten with the detected row format, one
only *declared* as sharegpt, a Parquet file (which the old validator passed with zero rows), and
a CSV recognisable only by its extension.

```bash
docker exec wheelsai-postgres psql -U wheelsai -d postgres -c "CREATE DATABASE wheelsai_chainf TEMPLATE wheelsai"
# (insert of the four legacy rows)
cd packages/db
DATABASE_URL=$COPY npx prisma migrate deploy
```

```
migrations/
  └─ 20261011200000_dataset_storage/
    └─ migration.sql

All migrations have been successfully applied.
```

```
           name           | live |   format   | file_type | schema_format | row_count | known | live_row
--------------------------+------+------------+-----------+---------------+-----------+-------+----------
 legacy-csv-by-extension  | t    | completion | csv       | completion    |         9 | t     | t
 legacy-declared-sharegpt | t    | sharegpt   | jsonl     |               |         0 | t     | t
 legacy-parquet           | t    | parquet    | parquet   |               |         0 | f     | t
 legacy-validated-alpaca  | t    | alpaca     | jsonl     | alpaca        |        40 | t     | t
 support-transcripts-q3   | t    | jsonl      | jsonl     |               |     12400 | t     | t
(5 rows)
```

(`live` is `live_name = name`; `known` is `row_count_known`.) The unique index moved from the
name to the live name:

```
           indexname           |                                               indexdef
-------------------------------+------------------------------------------------------------------------------------------------------
 datasets_org_id_idx           | CREATE INDEX datasets_org_id_idx ON public.datasets USING btree (org_id)
 datasets_org_id_live_name_key | CREATE UNIQUE INDEX datasets_org_id_live_name_key ON public.datasets USING btree (org_id, live_name)
 datasets_pkey                 | CREATE UNIQUE INDEX datasets_pkey ON public.datasets USING btree (id)
```

Drift check, the migrated copy against the schema file:

```bash
DATABASE_URL=$COPY npx prisma migrate diff --from-url "$COPY" --to-schema-datamodel prisma/schema.prisma --script
```

```
-- This is an empty migration.
```

The other change in flight on this branch adds `20261011100000_nosana_access_mode`. Once it was
in the tree the test was repeated on a fresh copy with both:

```
The following migration(s) have been applied:

migrations/
  └─ 20261011100000_nosana_access_mode/
    └─ migration.sql
  └─ 20261011200000_dataset_storage/
    └─ migration.sql

All migrations have been successfully applied.
=== drift
-- This is an empty migration.
```

---

## B. The local driver, through the running API

```bash
$S/run/start-api.sh STORAGE_DRIVER=local STORAGE_LOCAL_DIR=$S/store PUBLIC_API_URL=http://127.0.0.1:4300
curl -s -c $S/run/cookies.txt -X POST http://127.0.0.1:4300/api/auth/login -H 'content-type: application/json' \
  -d "{\"email\":\"demo@northwind.ai\",\"password\":\"$DEMO_PASSWORD\"}"
```

The script that was run:

```bash
#!/usr/bin/env bash
# Local-driver proof, through the running API on 127.0.0.1:4300.
set -uo pipefail
S=$S
API=http://127.0.0.1:4300
J="-b $S/run/cookies.txt"
pg() { docker exec -i wheelsai-postgres psql -U wheelsai -d wheelsai_chainf -v ON_ERROR_STOP=1 "$@"; }
say() { printf '\n### %s\n' "$*"; }
# Tokens are long and single-use; show only the shape.
short() { sed -E 's#(/api/storage/t/)[A-Za-z0-9_.-]{20}[A-Za-z0-9_.-]*#\1<token>#g'; }
post() { curl -s -w '\nHTTP %{http_code}\n' $J -X POST "$API$1" -H 'content-type: application/json' -d "$2"; }

say "1. A 25 MB JSONL (the old validator stopped at 10 MB)"
node -e '
const fs=require("fs"); const out=fs.createWriteStream(process.argv[1]); let i=0;
(function w(){ let ok=true; while(ok && i<150000){ ok=out.write(JSON.stringify({instruction:"Summarise ticket "+i+": "+"the customer reports a problem ".repeat(3),input:"",output:"Resolved ticket "+i+" by resetting the device."})+"\n"); i++; } if(i<150000) out.once("drain",w); else out.end(); })();
' $S/run/big.jsonl
sleep 1
SIZE=$(stat -c %s $S/run/big.jsonl); ROWS=$(wc -l < $S/run/big.jsonl)
echo "bytes=$SIZE rows=$ROWS sha256=$(sha256sum $S/run/big.jsonl | cut -c1-16)..."

say "2. Storage state reported to the page"
curl -s $J $API/api/training/datasets | jq -c '.storage'

say "3. Refused before any upload link or row"
post /api/training/datasets '{"name":"too-big","fileName":"a.jsonl","sizeBytes":209715201}' | jq -c . 2>/dev/null || true
post /api/training/datasets '{"name":"too-big","fileName":"a.jsonl","sizeBytes":209715201}' | tail -1
post /api/training/datasets '{"name":"rows","fileName":"a.jsonl","sizeBytes":10,"rowCount":200001}' | tail -2
post /api/training/datasets '{"name":"wrong-type","fileName":"notes.txt","sizeBytes":10}' | tail -2
post /api/training/datasets '{"name":"legacy-validated-alpaca","fileName":"a.jsonl","sizeBytes":10}' | tail -2
post /api/training/datasets '{"name":"no-size","fileName":"a.jsonl"}' | tail -1

say "4. Create the dataset: an upload link for exactly this file"
CREATE=$(curl -s $J -X POST $API/api/training/datasets -H 'content-type: application/json' \
  -d "{\"name\":\"proof-big\",\"fileName\":\"big.jsonl\",\"sizeBytes\":$SIZE,\"rowCount\":$ROWS,\"contentType\":\"application/jsonl\",\"format\":\"alpaca\"}")
echo "$CREATE" | jq -c '.upload.url |= sub("/t/.*";"/t/<token>")'
ID=$(echo "$CREATE" | jq -r .dataset.id); URL=$(echo "$CREATE" | jq -r .upload.url)

say "5. Validate before uploading"
post /api/training/datasets/$ID/validate '' | tail -2

say "6. The link refuses what it was not issued for"
echo -n "forged token:        "; curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X PUT --data-binary @$S/run/big.jsonl "$API/api/storage/t/eyJ2IjoxfQ.AAAA"
echo -n "GET with a PUT link: "; curl -s -w ' HTTP %{http_code}\n' "$URL"
head -c $((SIZE+1)) /dev/zero > $S/run/oversize.bin
echo -n "one byte too many:   "; curl -s -w ' HTTP %{http_code}\n' -X PUT -H 'content-type: application/jsonl' --data-binary @$S/run/oversize.bin "$URL"
echo -n "same, length hidden: "; curl -s -w ' HTTP %{http_code}\n' -X PUT -H 'content-type: application/jsonl' -H 'transfer-encoding: chunked' -T - "$URL" < $S/run/oversize.bin
echo "files in the store after the refused uploads: $(find $S/store -type f | wc -l)"

say "7. Upload through the signed link"
curl -s -w '\nHTTP %{http_code}  (%{size_upload} bytes sent in %{time_total}s)\n' -X PUT -H 'content-type: application/jsonl' --data-binary @$S/run/big.jsonl "$URL"
( cd $S/store && find . -type f | sed -E 's#[0-9a-f-]{36}#<uuid>#g' ) ; echo "stored sha256=$(find $S/store -type f -name data.jsonl | xargs sha256sum | cut -c1-16)..."

say "8. Validate (the whole file is read)"
post /api/training/datasets/$ID/validate '' | jq -c 'if .validation then {validation: (.validation | del(.errors,.warnings)), errors: (.validation.errors|length), warnings: .validation.warnings, stats, samples: (.sampleRows|length)} else . end' 2>/dev/null

say "9. Validate a second time (this failed before: the format column had been overwritten)"
post /api/training/datasets/$ID/validate '' | jq -c '{isValid: .validation.isValid, fileType: .validation.fileType, schemaFormat: .validation.schemaFormat, rowCount: .validation.rowCount}' 2>/dev/null
curl -s $J $API/api/training/datasets/$ID | jq -c '.dataset | {name, format, fileType, schemaFormat, rowCount, sizeBytes, avgTokensPerRow, totalTokens, isValidated, storageType, validationErrors}'

say "10. CSV and Parquet"
printf 'prompt,completion\n"What is 2+2?","4"\n"Say hi\non two lines","hi, ""friend"""\n' > $S/run/pairs.csv
printf 'PAR1' > $S/run/table.parquet; head -c 4096 /dev/urandom >> $S/run/table.parquet; printf 'PAR1' >> $S/run/table.parquet
cp $S/run/pairs.csv $S/run/fake.parquet
for f in pairs.csv table.parquet fake.parquet; do
  C=$(curl -s $J -X POST $API/api/training/datasets -H 'content-type: application/json' -d "{\"name\":\"proof-$f\",\"fileName\":\"$f\",\"sizeBytes\":$(stat -c %s $S/run/$f)}")
  curl -s -o /dev/null -X PUT --data-binary @$S/run/$f "$(echo "$C" | jq -r .upload.url)"
  echo -n "$f: "; curl -s $J -X POST $API/api/training/datasets/$(echo "$C" | jq -r .dataset.id)/validate -H 'content-type: application/json' | jq -c '.validation | {isValid, fileType, schemaFormat, rowCount, errors: [.errors[].message], warnings: [.warnings[].message]}'
done

say "11. Delete is refused while a job that has not finished uses the dataset"
pg -q -c "INSERT INTO training_jobs (id, org_id, name, base_model_id, base_model_hf_id, dataset_id, method, config, gpu_tier, status, updated_at)
  SELECT gen_random_uuid(), org_id, 'proof-job', 'phi-3-mini', 'microsoft/Phi-3-mini-4k-instruct', id, 'lora', '{}', '4090', 'running', now() FROM datasets WHERE id = '$ID'"
curl -s -w '\nHTTP %{http_code}\n' $J -X DELETE $API/api/training/datasets/$ID
pg -q -c "UPDATE training_jobs SET status = 'completed' WHERE dataset_id = '$ID'"
echo "(job marked completed)"
curl -s -w '\nHTTP %{http_code}\n' $J -X DELETE $API/api/training/datasets/$ID

say "12. After the delete: object gone, row hidden, name free"
echo "data.jsonl files left in the store: $(find $S/store -type f -name data.jsonl | wc -l)"
echo -n "GET by id: "; curl -s -o /dev/null -w 'HTTP %{http_code}\n' $J $API/api/training/datasets/$ID
echo -n "in the list: "; curl -s $J $API/api/training/datasets | jq -c '[.datasets[] | select(.name=="proof-big")] | length'
echo -n "delete again: "; curl -s -o /dev/null -w 'HTTP %{http_code}\n' $J -X DELETE $API/api/training/datasets/$ID
echo -n "same name again: "; post /api/training/datasets '{"name":"proof-big","fileName":"again.jsonl","sizeBytes":10}' | tail -1
pg -c "SELECT name, live_name, file_type, schema_format, row_count, avg_tokens_per_row, total_tokens, deleted_at IS NOT NULL AS deleted,
       (SELECT count(*) FROM training_jobs j WHERE j.dataset_id = d.id) AS jobs FROM datasets d WHERE name = 'proof-big' ORDER BY created_at"
```

Its output:

```

### 1. A 25 MB JSONL (the old validator stopped at 10 MB)
bytes=30827780 rows=150000 sha256=53f0a12604635a0b...

### 2. Storage state reported to the page
{"configured":true,"maxDatasetBytes":209715200,"maxDatasetRows":200000}

### 3. Refused before any upload link or row
{"error":"dataset_too_large","message":"Dataset is larger than the 209715200 byte limit.","maxBytes":209715200}
HTTP 413
{"error":"dataset_too_many_rows","message":"Dataset has more than the 200000 rows allowed.","maxRows":200000}
HTTP 413
{"error":"unsupported_file_type","message":"Unsupported file type. Upload a .jsonl, .csv or .parquet file."}
HTTP 400
{"error":"dataset_name_taken","message":"Dataset 'legacy-validated-alpaca' already exists"}
HTTP 409
HTTP 400

### 4. Create the dataset: an upload link for exactly this file
{"dataset":{"id":"8c3bdeef-4b99-4c4a-8b5d-1bf6bf00c6e3","name":"proof-big","fileType":"jsonl"},"upload":{"url":"http://127.0.0.1:4300/api/storage/t/<token>","method":"PUT","headers":{"Content-Type":"application/jsonl"},"expiresAt":"2026-10-07T05:35:26.258Z","maxBytes":30827780},"message":"Upload your dataset using the provided URL, then call POST /datasets/:id/validate"}

### 5. Validate before uploading
{"error":"dataset_not_uploaded","message":"The dataset file has not been uploaded yet. Upload it, then validate."}
HTTP 409

### 6. The link refuses what it was not issued for
forged token:        HTTP 401
GET with a PUT link: {"error":"invalid_transfer_token","message":"This transfer link is invalid or has expired."} HTTP 401
one byte too many:   {"error":"object_too_large","message":"Upload is larger than the 30827780 bytes this link allows.","maxBytes":30827780} HTTP 413
same, length hidden: {"error":"object_too_large","message":"Upload is larger than the 30827780 bytes this link allows.","maxBytes":30827780} HTTP 413
files in the store after the refused uploads: 0

### 7. Upload through the signed link
{"stored":true,"size":30827780}
HTTP 200  (30827780 bytes sent in 0.075033s)
./datasets/<uuid>/<uuid>/data.jsonl
stored sha256=53f0a12604635a0b...

### 8. Validate (the whole file is read)
{"validation":{"isValid":true,"format":"jsonl","fileType":"jsonl","schemaFormat":"alpaca","detectedFormat":"alpaca","rowCount":150000,"sizeBytes":30827780,"errorCount":0},"errors":0,"warnings":[],"stats":{"totalTokens":6131945,"avgTokensPerRow":41,"minTokens":39,"maxTokens":42},"samples":5}

### 9. Validate a second time (this failed before: the format column had been overwritten)
{"isValid":true,"fileType":"jsonl","schemaFormat":"alpaca","rowCount":150000}
{"name":"proof-big","format":"alpaca","fileType":"jsonl","schemaFormat":"alpaca","rowCount":150000,"sizeBytes":30827780,"avgTokensPerRow":41,"totalTokens":6131945,"isValidated":true,"storageType":"local","validationErrors":null}

### 10. CSV and Parquet
pairs.csv: {"isValid":true,"fileType":"csv","schemaFormat":"completion","rowCount":2,"errors":[],"warnings":["Dataset has only 2 valid rows. Recommend at least 100 examples for fine-tuning."]}
table.parquet: {"isValid":true,"fileType":"parquet","schemaFormat":"unknown","rowCount":null,"errors":[],"warnings":["Rows in a Parquet file are not counted or checked here; they are checked when training starts."]}
fake.parquet: {"isValid":false,"fileType":"parquet","schemaFormat":"unknown","rowCount":null,"errors":["File is not a Parquet file (the PAR1 marker is missing at its start or end)"],"warnings":[]}

### 11. Delete is refused while a job that has not finished uses the dataset
{"error":"dataset_in_use","message":"Dataset is used by 1 training job(s) that have not finished and cannot be deleted yet.","activeJobs":1}
HTTP 409
(job marked completed)
{"deleted":true,"message":"Dataset deleted"}
HTTP 200

### 12. After the delete: object gone, row hidden, name free
data.jsonl files left in the store: 0
GET by id: HTTP 404
in the list: 0
delete again: HTTP 404
same name again: HTTP 201
   name    | live_name | file_type | schema_format | row_count | avg_tokens_per_row | total_tokens | deleted | jobs 
-----------+-----------+-----------+---------------+-----------+--------------------+--------------+---------+------
 proof-big |           | jsonl     | alpaca        |    150000 |                 41 |      6131945 | t       |    1
 proof-big | proof-big | jsonl     |               |         0 |                    |              | f       |    0
(2 rows)
```

What to read in it:

- **3**: over the size limit, over the row limit, an unsupported file type and a taken name are
  each refused before a link exists; the last line is the 400 for a request with no `sizeBytes`.
- **6**: the link is for one operation, one key and one size. The oversize upload is refused
  both when it declares its length and when it hides it (`Transfer-Encoding: chunked`), and
  nothing is left in the store either time.
- **8 and 9**: 150,000 rows of a 30 MB file, three times the old 10 MB cut-off, valid; the
  second validation gives the same answer, and the stored `format` is still what was declared
  (`alpaca`) with the detected format beside it.
- **10**: a CSV with a quoted line break and doubled quotes; a Parquet file recognised by its
  magic bytes with `rowCount: null`; a CSV renamed `.parquet` refused. (The Parquet file here
  is random bytes between two markers. Since the review fixes a real Parquet file has its rows
  counted from the footer; a file like this one still validates with `rowCount: null`, now with
  the warning "The rows of this Parquet file could not be counted from its footer", and cannot
  be priced. See G.)
- **11 and 12**: delete refused with one running job, allowed once that job finished; then the
  object is gone, the row is hidden (404, not listed, cannot be deleted twice) but kept for the
  job that used it, and the name is taken again by a new dataset.

### Memory while validating

The same API process, a 149 MB file inside the row limit, resident memory sampled every 50 ms
while the validation ran:

```bash
#!/usr/bin/env bash
set -uo pipefail
S=$S
cd $S/run; API=http://127.0.0.1:4300; J="-b $S/run/cookies.txt"
PID=$(ss -ltnp 2>/dev/null | grep ':4300 ' | sed -E 's/.*pid=([0-9]+).*/\1/' | head -1)
rss() { awk '/VmRSS/{print $2}' /proc/$PID/status; }
SIZE=$(stat -c %s huge.jsonl); ROWS=$(wc -l < huge.jsonl)
C=$(curl -s $J -X POST $API/api/training/datasets -H 'content-type: application/json' -d "{\"name\":\"proof-memory\",\"fileName\":\"huge.jsonl\",\"sizeBytes\":$SIZE,\"rowCount\":$ROWS}")
ID=$(echo "$C" | jq -r .dataset.id)
echo "file: $SIZE bytes, $ROWS rows"
echo "API process resident memory before upload: $(rss) kB"
curl -s -o /dev/null -w 'upload HTTP %{http_code}\n' -X PUT --data-binary @huge.jsonl "$(echo "$C" | jq -r .upload.url)"
echo "after upload:                              $(rss) kB"
rm -f done.flag; echo 0 > peak.txt
( PEAK=0; while [ ! -f done.flag ]; do R=$(rss); if [ "$R" -gt "$PEAK" ]; then PEAK=$R; echo $PEAK > peak.txt; fi; sleep 0.05; done ) &
T0=$(date +%s%N)
curl -s $J -X POST $API/api/training/datasets/$ID/validate -H 'content-type: application/json' | jq -c '{isValid: .validation.isValid, rowCount: .validation.rowCount, sizeBytes: .validation.sizeBytes, totalTokens: .stats.totalTokens}'
T1=$(date +%s%N); touch done.flag; wait
echo "validate wall time: $(( (T1 - T0) / 1000000 )) ms"
echo "peak during validation:                    $(cat peak.txt) kB"
echo "after validation:                          $(rss) kB"
rm -f done.flag peak.txt
curl -s -o /dev/null -w 'cleanup delete HTTP %{http_code}\n' $J -X DELETE $API/api/training/datasets/$ID
```

```
file: 149117780 bytes, 190000 rows
API process resident memory before upload: 272896 kB
upload HTTP 200
after upload:                              271208 kB
{"isValid":true,"rowCount":190000,"sizeBytes":149117780,"totalTokens":35284445}
validate wall time: 528 ms
peak during validation:                    271804 kB
after validation:                          271808 kB
cleanup delete HTTP 200
```

149 MB validated in about half a second with resident memory within 0.6 MB of where it started
(the process had already served the run above; it had also streamed the 149 MB upload to disk
without growing).

### Download through a signed link

This is how a training container will fetch a dataset when the store is the local one. No route
issues a download link yet (the job service is the next build), so the link was minted with
`issueTransferUrl` and the secret the API was started with (a random value generated for the run,
passed to the start script as `JWT_SECRET`), then used against the running API:

```bash
#!/usr/bin/env bash
set -uo pipefail
S=$S
API=http://127.0.0.1:4300; J="-b $S/run/cookies.txt"; cd $S/run
for i in $(seq 1 60); do curl -s -o /dev/null $API/health && break; sleep 1; done
curl -s -o /dev/null -c $S/run/cookies.txt -X POST $API/api/auth/login -H 'content-type: application/json' -d "{\"email\":\"demo@northwind.ai\",\"password\":\"$DEMO_PASSWORD\"}"
node -e 'const fs=require("fs");let s="";for(let i=0;i<60000;i++)s+=JSON.stringify({prompt:"Question "+i+"?",completion:"Answer "+i+"."})+"\n";fs.writeFileSync("mid.jsonl",s)'
SIZE=$(stat -c %s mid.jsonl)
C=$(curl -s $J -X POST $API/api/training/datasets -H 'content-type: application/json' -d "{\"name\":\"proof-download\",\"fileName\":\"mid.jsonl\",\"sizeBytes\":$SIZE}")
ID=$(echo "$C" | jq -r .dataset.id)
curl -s -o /dev/null -w 'upload HTTP %{http_code}\n' -X PUT --data-binary @mid.jsonl "$(echo "$C" | jq -r .upload.url)"
KEY=$(cd $S/store && find datasets -name data.jsonl)
mint() { (cd /home/bprime/Bounties/WheelsAi/apps/api && JWT_SECRET="$(cat $S/run/proof-secret)" STORAGE_LOCAL_DIR=$S/store npx tsx scripts/_tmp-mint-get.ts "$@"); }
GET=$(mint "$KEY" 600)
echo "download link: $(echo "$GET" | sed -E 's#/t/.*#/t/<token>#')"
curl -s -D headers.txt -o downloaded.jsonl -w 'download HTTP %{http_code}, %{size_download} bytes\n' "$GET"
grep -i -E '^content-(type|length)' headers.txt | tr -d '\r'
echo "uploaded   sha256 $(sha256sum mid.jsonl | cut -c1-32)"
echo "downloaded sha256 $(sha256sum downloaded.jsonl | cut -c1-32)"
echo -n "the download link used to upload: "; curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X PUT --data-binary x "$GET"
SHORT=$(mint "$KEY" 1); sleep 2
echo -n "a one-second link, two seconds later: "; curl -s -o /dev/null -w 'HTTP %{http_code}\n' "$SHORT"
echo -n "validate: "; curl -s $J -X POST $API/api/training/datasets/$ID/validate -H 'content-type: application/json' | jq -c '.validation | {isValid, schemaFormat, rowCount}'
echo -n "delete: "; curl -s -o /dev/null -w 'HTTP %{http_code}\n' $J -X DELETE $API/api/training/datasets/$ID
echo -n "the same download link after the delete: "; curl -s -w ' HTTP %{http_code}\n' "$GET"
rm -f mid.jsonl downloaded.jsonl headers.txt
```

`scripts/_tmp-mint-get.ts` was a seven-line caller of
`issueTransferUrl({ op: "get", key, ttlSeconds }, { store, secret, publicOrigin, now })`,
removed after the run.

```
upload HTTP 200
download link: http://127.0.0.1:4300/api/storage/t/<token>
download HTTP 200, 3457780 bytes
content-type: application/octet-stream
content-length: 3457780
uploaded   sha256 f79f2307116d1a895b1e9586a1d105a3
downloaded sha256 f79f2307116d1a895b1e9586a1d105a3
the download link used to upload: HTTP 401
a one-second link, two seconds later: HTTP 401
validate: {"isValid":true,"schemaFormat":"completion","rowCount":60000}
delete: HTTP 200
the same download link after the delete: {"error":"object_not_found","message":"Object not found"} HTTP 404
```

### The browser's upload

The dashboard uploads from another origin, so the preflight has to pass:

```bash
curl -s -o /dev/null -D - -X OPTIONS http://127.0.0.1:4300/api/storage/t/x -H 'Origin: http://localhost:4301' \
  -H 'Access-Control-Request-Method: PUT' -H 'Access-Control-Request-Headers: content-type'
```

```
HTTP/1.1 204 No Content
access-control-allow-origin: http://localhost:4301
access-control-allow-methods: GET,HEAD,PUT,PATCH,POST,DELETE
access-control-allow-headers: content-type
```

---

## C. The S3 driver against MinIO (custom endpoint, path style)

### C1. The driver itself

`apps/api/scripts/object-store-smoke.ts` reads the storage settings the way the API does and
exercises the driver. It is the same script to run against the real bucket.

```bash
cd apps/api
STORAGE_DRIVER=s3 S3_ENDPOINT=http://127.0.0.1:4310 S3_FORCE_PATH_STYLE=true \
AWS_ACCESS_KEY_ID="$MINIO_ROOT_USER" AWS_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD" DATASETS_BUCKET=wheelsai-proof \
npx tsx scripts/object-store-smoke.ts --create-bucket
```

```
driver=s3 endpoint=http://127.0.0.1:4310 pathStyle=true region=auto bucket=wheelsai-proof
created bucket wheelsai-proof
PUT http://127.0.0.1:4310/wheelsai-proof/smoke/94995a3b97a9/data.jsonl?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=<key id>%2F20261007%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261007T043852Z&X-Amz-Expires=300&X-Amz-Signature=<signature>&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost&x-id=PutObject
ok    no head before the upload
ok    PUT of another length is refused  (HTTP 403)
ok    PUT of another content type is refused  (HTTP 403)
ok    nothing stored by the refused uploads
ok    presigned PUT  (HTTP 200, 38889 bytes)
ok    head  (size=38889 etag="73a21b24cec7e16f8f7f5dcfc2481a6f")
GET http://127.0.0.1:4310/wheelsai-proof/smoke/94995a3b97a9/data.jsonl?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=<key id>%2F20261007%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261007T043852Z&X-Amz-Expires=300&X-Amz-Signature=<signature>&X-Amz-SignedHeaders=host&x-id=GetObject
ok    presigned GET returns the same bytes  (HTTP 200, sha256 f7dd292bf4ae8a71...)
ok    the same URL without its signature is refused  (HTTP 403)
ok    ranged read  (16 bytes)
ok    full stream read  (38889 bytes)
ok    a link past its lifetime is refused  (HTTP 403)
ok    server-side put
ok    delete
ok    deleting again is not an error
ok    deletePrefix  (1 object)
all checks passed
```

The presigned PUT is signed for `content-length;content-type;host`, and MinIO enforces both: one
byte more is a 403, another content type is a 403, and neither leaves an object. That is the
only size limit a presigned PUT can carry, which is why the API asks the uploader for the exact
size.

### C2. The dataset flow through the API on the same bucket

```bash
$S/run/start-api.sh STORAGE_DRIVER=s3 S3_ENDPOINT=http://127.0.0.1:4310 S3_FORCE_PATH_STYLE=true \
  AWS_ACCESS_KEY_ID="$MINIO_ROOT_USER" AWS_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD" DATASETS_BUCKET=wheelsai-proof
```

```bash
#!/usr/bin/env bash
# S3 driver through the running API, against MinIO on 127.0.0.1:4310.
set -uo pipefail
S=$S
API=http://127.0.0.1:4300; J="-b $S/run/cookies.txt"; cd $S/run
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:4300/health && break; sleep 1; done
curl -s -o /dev/null -w 'login HTTP %{http_code}\n' -c $S/run/cookies.txt -X POST $API/api/auth/login -H 'content-type: application/json' -d "{\"email\":\"demo@northwind.ai\",\"password\":\"$DEMO_PASSWORD\"}"
mask() { sed -E 's/(X-Amz-Signature=)[0-9a-f]+/\1<signature>/; s/(X-Amz-Credential=)[^%&"]+/\1<key id>/'; }
SIZE=$(stat -c %s big.jsonl); ROWS=$(wc -l < big.jsonl)
echo "### create"
C=$(curl -s $J -X POST $API/api/training/datasets -H 'content-type: application/json' -d "{\"name\":\"proof-s3\",\"fileName\":\"big.jsonl\",\"sizeBytes\":$SIZE,\"rowCount\":$ROWS,\"contentType\":\"application/jsonl\"}")
echo "$C" | jq -c 'del(.message)' | mask
ID=$(echo "$C" | jq -r .dataset.id); URL=$(echo "$C" | jq -r .upload.url)
echo "### the transfer routes do not exist with this driver"
curl -s -w ' HTTP %{http_code}\n' -X PUT --data-binary 'x' "$API/api/storage/t/anything"
echo "### upload to the presigned URL (straight to the bucket, not through the API)"
echo -n "a smaller body than declared: "; curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X PUT -H 'content-type: application/jsonl' --data-binary @pairs.csv "$URL"
echo -n "the declared file:            "; curl -s -o /dev/null -w 'HTTP %{http_code} (%{size_upload} bytes)\n' -X PUT -H 'content-type: application/jsonl' --data-binary @big.jsonl "$URL"
echo "### validate (streamed from the bucket)"
curl -s $J -X POST $API/api/training/datasets/$ID/validate -H 'content-type: application/json' | jq -c '{validation: (.validation | del(.errors,.warnings)), stats}'
curl -s $J $API/api/training/datasets/$ID | jq -c '.dataset | {storageType, fileType, schemaFormat, rowCount, sizeBytes, avgTokensPerRow, totalTokens, isValidated}'
echo "### delete"
curl -s -w ' HTTP %{http_code}\n' $J -X DELETE $API/api/training/datasets/$ID
echo -n "validate after delete: "; curl -s -o /dev/null -w 'HTTP %{http_code}\n' $J -X POST $API/api/training/datasets/$ID/validate -H 'content-type: application/json'
```

```
login HTTP 200
### create
{"dataset":{"id":"42315f66-7924-4cd0-bf55-095855cdbd88","name":"proof-s3","fileType":"jsonl"},"upload":{"url":"http://127.0.0.1:4310/wheelsai-proof/datasets/ad698f19-bf63-4d1e-9402-fd6c51636a66/42315f66-7924-4cd0-bf55-095855cdbd88/data.jsonl?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=<key id>%2F20261007%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261007T043916Z&X-Amz-Expires=3600&X-Amz-Signature=<signature>&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost&x-id=PutObject","method":"PUT","headers":{"Content-Type":"application/jsonl"},"expiresAt":"2026-10-07T05:39:16.809Z","maxBytes":30827780}}
### the transfer routes do not exist with this driver
{"error":"storage_transfer_unavailable","message":"Not found"} HTTP 404
### upload to the presigned URL (straight to the bucket, not through the API)
a smaller body than declared: HTTP 403
the declared file:            HTTP 200 (30827780 bytes)
### validate (streamed from the bucket)
{"validation":{"isValid":true,"format":"jsonl","fileType":"jsonl","schemaFormat":"alpaca","detectedFormat":"alpaca","rowCount":150000,"sizeBytes":30827780,"errorCount":0},"stats":{"totalTokens":6131945,"avgTokensPerRow":41,"minTokens":39,"maxTokens":42}}
{"storageType":"s3","fileType":"jsonl","schemaFormat":"alpaca","rowCount":150000,"sizeBytes":30827780,"avgTokensPerRow":41,"totalTokens":6131945,"isValidated":true}
### delete
{"deleted":true,"message":"Dataset deleted"} HTTP 200
validate after delete: HTTP 404
```

After the delete the bucket was listed with the driver's own client:

```
objects in wheelsai-proof: 0
```

---

## D. No storage configured

The API started with none of the storage variables:

```bash
#!/usr/bin/env bash
set -uo pipefail
S=$S
API=http://127.0.0.1:4300; J="-b $S/run/cookies.txt"
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:4300/health && break; sleep 1; done
curl -s -o /dev/null -c $S/run/cookies.txt -X POST $API/api/auth/login -H 'content-type: application/json' -d "{\"email\":\"demo@northwind.ai\",\"password\":\"$DEMO_PASSWORD\"}"
pg() { docker exec -i wheelsai-postgres psql -U wheelsai -d wheelsai_chainf -At "$@"; }
echo "datasets rows before: $(pg -c 'select count(*) from datasets')"
echo -n "GET  /api/training/datasets -> "; curl -s $J $API/api/training/datasets | jq -c '{total, storage}'
echo -n "POST /api/training/datasets -> "; curl -s -w ' HTTP %{http_code}\n' $J -X POST $API/api/training/datasets -H 'content-type: application/json' -d '{"name":"no-storage","fileName":"a.jsonl","sizeBytes":10}'
ID=$(pg -c "select id from datasets where name='proof-pairs.csv' and deleted_at is null")
echo -n "POST /api/training/datasets/<id>/validate -> "; curl -s -w ' HTTP %{http_code}\n' $J -X POST $API/api/training/datasets/$ID/validate -H 'content-type: application/json'
echo -n "PUT  /api/storage/t/<token> -> "; curl -s -w ' HTTP %{http_code}\n' -X PUT --data-binary x $API/api/storage/t/anything
echo "datasets rows after:  $(pg -c 'select count(*) from datasets')"
```

```
datasets rows before: 12
GET  /api/training/datasets -> {"total":9,"storage":{"configured":false,"maxDatasetBytes":209715200,"maxDatasetRows":200000}}
POST /api/training/datasets -> {"error":"dataset_storage_not_configured","message":"Dataset uploads are not available: object storage is not configured on this deployment."} HTTP 503
POST /api/training/datasets/<id>/validate -> {"error":"dataset_storage_not_configured","message":"Dataset uploads are not available: object storage is not configured on this deployment."} HTTP 503
PUT  /api/storage/t/<token> -> {"error":"storage_transfer_unavailable","message":"Not found"} HTTP 404
datasets rows after:  12
```

The list still answers and tells the page `configured: false`, which is what the datasets page
shows in place of its upload form. Nothing is written by a refused request.

---

## E. Cleaning up

```bash
docker rm -f -v wheelsai-chainf-minio && docker rmi cgr.dev/chainguard/minio:latest
docker exec wheelsai-redis redis-cli -n 11 flushdb          # 26 BullMQ bookkeeping keys, no jobs
docker exec wheelsai-postgres psql -U wheelsai -d postgres -c "DROP DATABASE wheelsai_chainf"
rm -rf $S/store $S/run/big.jsonl $S/run/huge.jsonl $S/run/minio.env $S/run/cookies.txt
```

Nothing listens on 4300 or 4310 afterwards; the container, its tmpfs data and the image are gone.

---

## F. What this run did not prove

- **A real bucket.** Cloudflare R2 and AWS S3 were not touched: there are no credentials for
  either here. The driver code path is the one MinIO exercised; whether R2 enforces a signed
  `content-length` on a presigned PUT the way MinIO does is for the smoke script to show on the
  real bucket (it fails loudly if not).
- **A browser upload to a bucket.** The bucket's CORS rule (`docs/FOUNDER-ACTIONS.md`, section
  15) is a setting on the provider's side and cannot be tested against a bucket that does not
  exist. The preflight above is the API's, for the local driver.
- **The datasets page in a browser.** The page type-checks and passes the web unit tests and
  UI gates; the requests it makes (create with the file's size, PUT with the returned headers,
  validate, delete) are the ones this run made with `curl`. It was not opened in a browser in
  this run.
- **Virtual-hosted addressing** (`S3_FORCE_PATH_STYLE=false` with an endpoint) is covered by a
  unit test of the signed URL only, not by a live store.
- **Parquet contents.** The magic bytes are checked and the row count is read from the footer
  (section G); the rows themselves are not read. The count is what the file declares.
- **A dataset reaching a training container.** Download links of both kinds were fetched (the
  local one in B, the presigned one in C1), by `curl` and `fetch` on this machine; no job
  consumed one. The job service is the next build.

---

## G. After the review: four fixes, on real Postgres

**Date:** 2026-10-07, same working tree. The review found that (1) the upload link keeps
working after validation and nothing tied the stored counts to the stored bytes, (2) a Parquet
dataset was priced as 0 rows by the job routes, (3) a NUL character in a row made validation
answer 500 every time, and (4) sample rows of up to 20 MB per dataset were stored and loaded on
every list. Each was confirmed against the code first (a throwaway test, output in the fixer's
report), then fixed in `services/dataset.ts`, `services/buildDatasetDeps.ts`,
`routes/training.ts` and the migration.

### G1. The migration again (two more columns)

`content_sha256` and `content_etag` were added to `20261011200000_dataset_storage`, which has
never been applied anywhere but a scratch copy.

```bash
docker exec wheelsai-postgres psql -U wheelsai -d postgres -c "CREATE DATABASE wheelsai_fixf TEMPLATE wheelsai"
cd packages/db
DATABASE_URL=postgresql://wheelsai:<password>@localhost:5434/wheelsai_fixf npx prisma migrate deploy
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script
```

```text
migrations/
  └─ 20261011100000_nosana_access_mode/
    └─ migration.sql
  └─ 20261011200000_dataset_storage/
    └─ migration.sql

All migrations have been successfully applied.
-- This is an empty migration.

content_etag|text|YES
content_sha256|text|YES
```

### G2. The dataset service over that database and the local driver

A script (kept outside the repository) builds the production composition root
(`buildDatasetDeps(prisma)`) with `STORAGE_DRIVER=local` and the copy as `DATABASE_URL`, then
for each case creates a dataset, writes the file where its upload link points, validates, and
reads the row back with SQL (`octet_length(sample_rows::text)` and so on). No API process and no
worker was started. Output, with Prisma's query log lines removed:

```text
3 NUL: {
  isValid: false,
  errors: [
    'row 1: Row contains a NUL character',
    `row 2: Invalid JSON: Unexpected token '\ufffd', "\ufffd{"text":"a"}" is not valid JSON`,
    'row 3: Row contains an unpaired surrogate character'
  ]
} {
  is_validated: false,
  row_count: 1,
  row_count_known: true,
  content_sha256: '719aec968e32d2a8aed0f09bcf8452e4a36ce3c174abe46e0dacb15722e18b53',
  has_etag: true,
  sample_bytes: 18,
  error_bytes: 295
}
4 big rows: { isValid: true, rowCount: 5, uploadedBytes: 20971259 } {
  is_validated: true,
  row_count: 5,
  row_count_known: true,
  content_sha256: 'a32826091c1d516c360b66563f1e2e38b6b5c8ab4b864bb4a403ee3ed43ba52c',
  has_etag: true,
  sample_bytes: 2080,
  error_bytes: null
}
4 list columns: avgTokensPerRow,contentEtag,contentSha256,createdAt,deletedAt,description,fileType,format,id,isValidated,name,orgId,rowCount,rowCountKnown,schemaFormat,sizeBytes,storageType,storageUrl,totalTokens,updatedAt
1 sha256 matches the upload: true
1 state after validation: unchanged
1 state after a same-length swap: changed | stored sha256 still names the validated bytes: true
2 parquet: {
  isValid: true,
  rowCount: 5,
  warning: 'Rows in a Parquet file are counted from its footer but not checked here; they are checked when training starts.'
} {
  is_validated: true,
  row_count: 5,
  row_count_known: true,
  content_sha256: '78905914e2386b0f0c4bfeb2fa277df4435001ec09e1f6c2f747a89b2c09932c',
  has_etag: true,
  sample_bytes: 2,
  error_bytes: null
}
2 unreadable footer: {
  is_validated: true,
  row_count: 0,
  row_count_known: false,
  content_sha256: 'e6133fdf14b9ca90db03ba0741866fcdc15564f7c2a62c0daab50b9892a7d12e',
  has_etag: true,
  sample_bytes: 2,
  error_bytes: null
} | row count to price: null
```

(The second error of case 3 quotes the raw NUL of the uploaded line; it is stored and shown as
U+FFFD, written `\ufffd` above.)

What it shows:

- **3 (NUL).** The file has an escaped NUL inside a value, a raw NUL byte outside any string
  and an unpaired surrogate. Before the fix Postgres refused the `jsonb` write
  (`unsupported Unicode escape sequence`) and the route answered 500 on every attempt. Now the
  validation is saved: three row errors, 295 bytes of them, and the dataset is invalid.
- **4 (sample rows).** Five rows of 4 MiB each, 20 MB uploaded. What is stored as the sample is
  2,080 bytes (it was the 20 MB itself). A list reads twenty columns, none of them
  `sampleRows` or `validationErrors`.
- **1 (binding).** The stored `content_sha256` equals the sha256 of the uploaded file. After
  the object is overwritten with different bytes of the same length (which the upload link
  still allows until it expires), `datasetObjectState` answers `changed`, and the row still
  names the bytes that were counted.
- **2 (Parquet).** A real Parquet file (a nested `list<struct>` schema, three row groups,
  written by pyarrow) is counted from its footer: 5 rows, `row_count_known = true`. A file
  with the markers and an unreadable footer stays `row_count_known = false`, and
  `knownDatasetRowCount` gives the job routes `null`, on which they answer
  `422 dataset_row_count_unknown` instead of pricing 0 rows.

The footer reader was also checked against pyarrow's own count on two larger files that are
not in the repository: 1,200 rows in three row groups (footer 1,511 bytes) and 300 columns by
31 rows (footer 52,428 bytes). Both counts matched.

```bash
docker exec wheelsai-postgres psql -U wheelsai -d postgres -c "DROP DATABASE wheelsai_fixf"
rm -rf $S/store
```

### G3. What section G did not prove

- The two job routes that now refuse (`POST /api/training/jobs`, `POST /api/training/estimate`)
  were not called over HTTP in this run. The rule they apply (`knownDatasetRowCount`) and the
  refusal they send are unit-tested; the routes themselves read Prisma directly and have no
  route test. They are replaced by the job service in the next build.
- The S3 driver was not run again. Nothing in it changed; on S3 the ETag compared by
  `datasetObjectState` is the provider's, on the local driver it is made from the file's size
  and modification time.
- A swapped object reaching a training container: the trainer's refusal of bytes that do not
  match `DATASET_SHA256` is covered by its own offline tests (exit 11,
  `dataset_checksum_mismatch`); no job passed it a stored `contentSha256`, because no job
  service exists yet.

