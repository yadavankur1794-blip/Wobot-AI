# Bulk CSV Ingestion Service

Backend service for authenticated merchant catalog imports. Clients upload one
or more CSV files; the API durably stores each completed upload and returns
pollable import identifiers. A supervised worker streams each file through
decoding, RFC 4180 parsing and row validation, writes valid winners to
PostgreSQL staging, and publishes the staged catalog atomically.

The implementation is intentionally small: Fastify, PostgreSQL, direct
parameterized SQL, a persistent Docker volume and one bounded child worker.
The repository includes the original assignment reference, migrations, tests,
the supplied deterministic generator and measured benchmark evidence.

## Key capabilities

- Streaming multipart uploads and CSV processing without buffering a multi-GB
  file in memory.
- Merchant registration, Argon2id password hashing, opaque bearer sessions and
  merchant-scoped authorization.
- Durable PostgreSQL import queue with status polling, cancellation, leases,
  worker ownership and stale-attempt fencing.
- Incremental SHA-256 file hashing and merchant-scoped identical-file
  deduplication.
- RFC 4180 quoting, escaped quotes, multiline fields, shuffled headers, UTF-8,
  UTF-16LE with BOM and explicitly selected Windows-1252 decoding.
- Recoverable invalid-row rejection with streamed private CSV reports.
- Exact decimal-string monetary validation and PostgreSQL `NUMERIC` storage.
- Duplicate-SKU winner selection using timestamp and deterministic source-row
  ordering.
- Atomic, freshness-safe catalog publication with PostgreSQL rollback on
  failure or worker termination.
- Cooperative cancellation before the publication no-return boundary.

## Technology stack

| Area | Choice |
|---|---|
| Runtime | Node.js 24, ESM, strict TypeScript 5.9 |
| HTTP | Fastify 5.12 with `@fastify/multipart` 10.1 |
| Database | PostgreSQL 16.4 in the supplied Compose configuration |
| Database access | `pg` 8.23 with direct parameterized SQL; no ORM |
| CSV parser | `csv-parse` 7.0.3 |
| Passwords | `argon2` 0.45, Argon2id with configured memory/time cost |
| Validation/configuration | Zod 4.6 |
| Tests | Vitest 5.0; separate unit and PostgreSQL integration configurations |
| Operations | Dockerfile, Docker Compose, ordered SQL migrations |

All dependencies and development tools are pinned in
[`package-lock.json`](package-lock.json). The production-only audit was run
with `npm audit --omit=dev --audit-level=moderate` and reported zero
vulnerabilities.

## Architecture

```text
Client
  -> Fastify multipart endpoint
  -> streamed SHA-256 + durable .part/.csv storage
  -> PostgreSQL imports queue
  -> supervised child worker
  -> decoder -> csv-parse -> validation
  -> bounded 500-row PostgreSQL staging upserts
  -> one atomic freshness-safe publication transaction
  -> COMPLETED status and private rejection report
```

The API handles authentication, upload streaming, status, reports and
cancellation. It does not parse the whole file or hold the upload in memory.
The worker claims queued imports with an owner and attempt number, renews its
lease during validation, and is supervised by the API process. A dead worker is
restarted; expired work is reclaimed and stale owners are rejected by database
predicates.

PostgreSQL is both the durable job state and the catalog store. Uploaded files
and rejection reports live under the persistent `/data` volume. Startup runs
all pending migrations, reconciles storage, then starts listening; readiness
checks the database.

## Prerequisites and quick start

Docker Desktop with Docker Compose is sufficient to run the service from a
clean clone. Host Node.js and PostgreSQL are not required for the application
stack. Node.js is needed only for host-side development commands; integration
tests can instead run in a disposable test container.

```sh
git clone https://github.com/yadavankur1794-blip/Wobot-AI.git
cd Wobot-AI
cp .env.example .env
docker compose up --build -d
docker compose ps
curl -fsS http://localhost:3000/health/live
curl -fsS http://localhost:3000/health/ready
```

The service listens on host port `3000`. PostgreSQL is private to the Compose
network. `POSTGRES_DB`, `POSTGRES_USER` and `POSTGRES_PASSWORD` are read from
`.env` or the shell; `.env.example` contains disposable local-review values.
Do not reuse them outside a disposable environment.

The database container must become healthy before the service starts. The
application migration runner applies `001_initial.sql` through
`008_terminal_import_retries.sql` transactionally and uses an advisory lock to
serialize migration startup. The service container has a `512m` memory limit.

Health endpoints:

| Method | Path | Meaning |
|---|---|---|
| `GET` | `/health/live` | Process liveness; returns `{ "status": "ok" }` |
| `GET` | `/health/ready` | Database readiness; returns 503 when unavailable |

## Authentication

### Register a merchant user

```sh
curl -sS -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"merchantName":"Demo Merchant","email":"demo@example.invalid","password":"temporary-password-123"}'
```

Registration returns HTTP `201` with a merchant user, role, opaque token and
expiry. Passwords are never returned or logged. Emails are normalized to
lowercase and duplicate normalized addresses return HTTP `409`.

### Login, identity and logout

```sh
curl -sS -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.invalid","password":"temporary-password-123"}'

curl -sS http://localhost:3000/auth/me \
  -H "Authorization: Bearer $TOKEN"

curl -sS -X POST http://localhost:3000/auth/logout \
  -H "Authorization: Bearer $TOKEN"
```

Authentication failures deliberately use the same HTTP `401` response for an
unknown email and an incorrect password. Sessions contain only SHA-256 token
hashes in PostgreSQL, expire after 30 days and can be revoked. Identity comes
from the server-side session row, not from client claims.

### Platform staff bootstrap

There is no public staff-registration route. A controlled operator can create a
staff account with the one-shot command below. Never commit or record the
temporary values.

```sh
export STAFF_BOOTSTRAP_ENABLED=true
export STAFF_BOOTSTRAP_SECRET="$(openssl rand -hex 32)"
export STAFF_BOOTSTRAP_CONFIRM=I_UNDERSTAND
export STAFF_EMAIL=staff@example.invalid
read -rsp 'Staff password: ' STAFF_PASSWORD; export STAFF_PASSWORD; printf '\n'
docker compose run --rm --no-deps service npm run bootstrap:staff
unset STAFF_BOOTSTRAP_SECRET STAFF_BOOTSTRAP_CONFIRM STAFF_EMAIL STAFF_PASSWORD
```

The command requires a password of 12–128 characters and a bootstrap secret of
at least 32 characters. It runs migrations, hashes the password and creates a
`PLATFORM_STAFF` user. Staff can access authorized cross-merchant resources;
merchant users cannot impersonate staff or select another merchant.

## Import API

All import routes require `Authorization: Bearer <token>`.

### Upload one or more files

```sh
curl -sS -X POST 'http://localhost:3000/imports?encoding=utf8' \
  -H "Authorization: Bearer $TOKEN" \
  -F 'file=@./tmp/fixture.csv;filename=fixture.csv;type=text/csv'
```

The multipart field is `file`. The endpoint returns HTTP `202` after the file
has been durably stored and registered, not after ingestion finishes. It returns
one result per file:

```json
{
  "imports": [{
    "id": "<import-uuid>",
    "originalFilename": "fixture.csv",
    "fileSizeBytes": "12345",
    "status": "QUEUED",
    "duplicate": false
  }]
}
```

The `encoding` query parameter accepts `utf8` (default), `utf16le` or
`windows-1252`. A merchant user is restricted to its own merchant. Platform
staff may provide `merchantId` for authorized cross-tenant operations.

Configured protections include eight files per request, four active uploads, a
per-file limit of `2 GiB + 128 bytes` for the supplied generator's bounded
final-record margin, multipart part/field limits, a 1 MiB logical CSV record
limit and a separately bounded request body.

### Poll status

```sh
curl -sS http://localhost:3000/imports/$IMPORT_ID \
  -H "Authorization: Bearer $TOKEN"
```

The response includes status, cancellation state, timestamps and counters:

```json
{
  "import": {
    "id": "<import-uuid>",
    "status": "COMPLETED",
    "cancelRequested": false,
    "counters": {
      "scannedRows": "100000",
      "validRows": "98024",
      "rejectedRows": "1976",
      "distinctProducts": "93152",
      "publishedRows": "93152"
    },
    "error": null
  }
}
```

`READY_TO_APPLY` means validation and staging committed. `COMPLETED` means the
catalog publication and terminal import update committed together.

### Rejection report and cancellation

```sh
curl -sS -o ./tmp/rejections.csv \
  http://localhost:3000/imports/$IMPORT_ID/rejections \
  -H "Authorization: Bearer $TOKEN"

curl -sS -X POST http://localhost:3000/imports/$IMPORT_ID/cancel \
  -H "Authorization: Bearer $TOKEN"
```

The streamed report contains `record_ordinal`, `line_start`, `line_end`,
`field`, `reason`, `original_fields`, `error_code` and `raw_record`. Reports
are private to the merchant and are written through a temporary `.part` file
before atomic rename. Queued/ready imports become `CANCELLED`; active
validation returns `CANCEL_REQUESTED` while cleanup completes. Once publication
is `APPLYING`, cancellation returns HTTP `409 PUBLICATION_IN_PROGRESS`.

## CSV specification

The required headers are the following seven names, in any order:

```text
sku,name,category,price,currency,stock,updated_at
```

- `sku` is required and identifies a product within a merchant.
- `name` and `category` are free text, including quoted commas and newlines.
- `price` is a non-negative decimal string. Exponents and binary floating
  point are not used. Accepted fractional scale comes from the pinned ISO-4217
  registry; values are stored as PostgreSQL `NUMERIC`.
- `currency` must be supported by the ISO-4217 minor-unit registry, including
  tested zero-, two-, three- and four-decimal cases such as JPY, BHD, KWD and
  CLF.
- `stock` is a non-negative whole number within PostgreSQL `BIGINT` range.
- `updated_at` is an ISO-8601 timestamp with explicit `Z` or numeric offset.

The parser supports RFC 4180 quoting, escaped quotes, CRLF/LF/CR delimiters,
multiline fields and shuffled columns. UTF-8 is strict and may have a BOM;
UTF-16LE requires a BOM; Windows-1252 is selected explicitly. Ordinary invalid
rows are reported and later rows continue. Invalid headers, malformed quoting,
decoding errors and over-sized logical records are file-level failures.

Within an import, the valid row with the newest `updated_at` wins for a SKU.
Equal timestamps use the larger source-row ordinal. Invalid rows never enter
staging and cannot displace a valid winner.

## Database and migrations

The service uses direct parameterized SQL through `pg`; there is no ORM. The
ordered migration runner creates `schema_migrations`, takes a PostgreSQL
advisory transaction lock and applies every pending migration before readiness.

| Migration | Purpose |
|---|---|
| `001_initial.sql` | Merchants, users, sessions, imports, products, staging and base indexes |
| `002_auth_indexes.sql` | Session lookup/expiry indexes and initial constraint |
| `003_allow_expired_sessions.sql` | Adjusts the session constraint for expiration behavior |
| `004_import_file_metadata.sql` | Durable file-size metadata and integrity check |
| `005_phase4_processing.sql` | Encoding/timestamps, processing states and queue index |
| `006_publication_constraints.sql` | Non-negative price and stock checks |
| `007_phase6_recovery.sql` | Lease-expiry index for recovery scans |
| `008_terminal_import_retries.sql` | Retries after `FAILED`/`CANCELLED` while preserving active/completed deduplication |

Important keys include `(merchant_id, sku)` for live products and
`(import_id, sku)` for staging. Other constraints cover normalized email,
hashed session tokens, foreign keys and the partial active-import content-hash
unique index. Schema changes are append-only migrations.

## Lifecycle and concurrency

```text
QUEUED -> VALIDATING -> READY_TO_APPLY -> APPLYING -> COMPLETED
              |               |              |
              v               v              v
           FAILED          CANCELLED       rollback/recovery
```

Validation uses bounded 500-row batches. Progress and lease writes are checked
against the current owner and attempt. A stale worker cannot update progress,
publish products or mark an import complete.

Publication reads staged winners in keyset-ordered batches inside one
transaction. The `ON CONFLICT` predicate only updates a product when the
candidate is fresher by `updated_at`, then `import_order`, then source row.
Readers never observe a partially committed publication. If a worker dies
during an open publication transaction, PostgreSQL rolls back uncommitted
catalog changes; the supervisor restarts a worker and lease recovery reclaims
the import.

## Performance and benchmark evidence

The supplied size-based generator produced a `2,147,483,731`-byte file,
approximately 2 GiB because the generator interprets `GB` as `1024^3` bytes.
The file was uploaded through the public multipart API, processed by the
normal worker, polled through the status endpoint, and verified through the
rejection report and PostgreSQL catalog. The recorded run completed after
recovery from an external Docker/host power interruption:

| Measurement | Result |
|---|---:|
| Scanned records | 24,708,106 |
| Valid records | 23,469,719 |
| Rejected records | 1,238,387 |
| Distinct staged products | 21,177,401 |
| Published products | 21,177,401 |
| Final status | `COMPLETED` |
| Recovery attempt | 3 |
| Publication duration | approximately 365.986 seconds |
| Publication throughput | approximately 57,864 products/second |
| Service limit | 512 MiB |
| Observed service cgroup peak | 512 MiB |
| OOM kills | 0 |

Captured host/runtime details: Apple Mac mini `Mac16,10`, Apple M4, 10 logical
cores, 16 GiB RAM, macOS 26.6.2 arm64; Docker Server 29.8.2, Compose v5.6.0,
Docker VM with 10 CPUs and approximately 8 GiB RAM. Final database size was
approximately 9.70 GB, staging approximately 5.73 GB, products approximately
3.94 GB, and the terminal WAL directory observation approximately 1 GiB.

These are recovery-inclusive observations, not a clean uninterrupted
end-to-end duration. Full-scale measurements were recorded on an earlier
implementation revision; the release includes subsequent changes that have
not been separately benchmarked at 2 GiB.

## Testing

Commands defined in `package.json`:

```sh
npm run typecheck
npm run build
npm run lint
npm test
npm run test:integration
```

The integration command requires a real PostgreSQL database:

```sh
INTEGRATION_DATABASE_URL='postgres://USER:PASSWORD@HOST:PORT/DATABASE' \
  npm run test:integration
```

The final recorded results are 39/39 unit tests and 22/22 real PostgreSQL
integration tests. Disposable verification also covered empty-database Compose
startup, migrations, worker SIGKILL during publication, rollback, lease
reclaim, merchant isolation, client-aborted upload cleanup and clean-clone API
import. The production image intentionally excludes development test tooling.

## CSV generator

The required deterministic generator is
[`scripts/generate-csv.ts`](scripts/generate-csv.ts). It streams with
backpressure and supports `--out`, `--rows`, `--size`, `--bad-rate`,
`--dupe-rate`, `--seed`, `--crlf`, `--bom` and `--shuffle`.

```sh
npm run build

# Small mixed-validity fixture from the assignment.
node dist/scripts/generate-csv.js \
  --out ./tmp/fixture.csv --rows 500 --bad-rate 0.2 --seed 42

# 100,000-row regression fixture.
node dist/scripts/generate-csv.js \
  --out ./tmp/100k.csv --rows 100000 --bad-rate 0.02 --dupe-rate 0.05

# Shuffled headers with CRLF and BOM.
node dist/scripts/generate-csv.js \
  --out ./tmp/shuffled.csv --rows 10000 --shuffle --crlf --bom

# Required full-size command; run only after a disk-capacity preflight.
node dist/scripts/generate-csv.js \
  --out ./tmp/huge.csv --size 2GB --bad-rate 0.05 --dupe-rate 0.10 --crlf --bom
```

The generator interprets `GB` as `1024^3` bytes, so `2GB` is approximately
2 GiB. Generated files belong in ignored `tmp/` and are not part of the
repository.

## Security, recovery and limitations

- Passwords use Argon2id; bearer tokens use cryptographically secure randomness
  and only token hashes are persisted.
- Registration cannot create `PLATFORM_STAFF`; staff creation is a guarded
  one-shot operator command.
- Merchant visibility is derived from the authenticated server-side session.
  Client-supplied merchant IDs do not override merchant authorization.
- SQL is parameterized. Upload paths are generated storage keys, not trusted
  filenames. Temporary files are atomically finalized or cleaned up.
- Multipart limits, logical record limits, file-count limits and concurrent
  upload limits are bounded.
- Reports escape spreadsheet formula cells and do not claim original byte
  offsets when only decoded parser offsets are available.
- The production dependency audit reported zero moderate-or-higher
  vulnerabilities.

The real benchmark recovered from a machine/Docker interruption and completed
through the normal lease and fencing path. A quota-limited disk-full test was
not executed safely; simulated `ENOSPC` cleanup is separately covered. These
are distinct claims.

Known trade-offs are full validation replay after interruption, one bounded
worker per service instance, and no partial byte-offset resume.

## Repository structure

```text
.
├── Dockerfile
├── docker-compose.yml
├── package.json / package-lock.json
├── .env.example / .gitignore / .dockerignore
├── README.md
├── reference/assignment_original.txt
├── migrations/                 # ordered PostgreSQL schema changes
├── scripts/                    # staff bootstrap and CSV generator
├── src/
│   ├── auth/                   # registration, sessions, guards, bootstrap
│   ├── db/                     # pool and migration runner
│   └── imports/                # upload, parser, validation, staging, publish
└── test/                       # unit and PostgreSQL integration tests
```

## Reproducible reviewer flow

1. Clone the repository and copy `.env.example` to `.env`.
2. Run `docker compose up --build -d` and wait for `/health/ready`.
3. Register and log in a temporary merchant user.
4. Generate `tmp/fixture.csv` with the 500-row command above.
5. Upload it with `POST /imports` and the multipart field `file`.
6. Poll `GET /imports/:importId` until terminal status.
7. Download `GET /imports/:importId/rejections` when a report exists.
8. Review `src/imports/processor.ts`, `src/imports/publication.ts`,
   `src/imports/repository.ts` or `src/auth/guards.ts` when discussing the
   implementation.

The implementation is intended to be explainable from any important source
file, not only from this suggested list.
