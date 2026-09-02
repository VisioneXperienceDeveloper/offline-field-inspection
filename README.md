# FIELDNOTE — Offline Field Inspection

FIELDNOTE is a local-first Angular 20 field-inspection application for unreliable network conditions. It stores inspections, photo blobs and a durable sync outbox in IndexedDB, supports a `Draft → Submitted → Approved` workflow, and sends queued operations to a companion Node.js service. Device-save state and remote-sync state are deliberately separate: a successful local write is never presented as a server acknowledgement.

## Current release decision

**Production: NO-GO.** The repository is a tested local integration, not a production deployment.

- Authentication uses selectable demo identities and tokens embedded in the client. External IdP/JWT integration, token expiry, revocation and queued-action reauthorization are not implemented.
- Photos are compressed and stored as device-local IndexedDB blobs, but the server receives metadata/checksums only. Server-side photo binary upload is not implemented.
- The companion service persists to a single-process JSON file. It has no multi-instance locking or managed transactional database.
- CI builds and verifies immutable client/server artifacts, but no real staging or production host, canary promotion or automated rollback target is configured.

See [the maintenance roadmap](docs/maintenance-roadmap.md), [workflow verification](docs/product-workflows-and-verification.md), and [release runbook](docs/release-runbook.md) for the remaining gates.

## Run the local integration

Node.js 22 is required. Start the backend and frontend in separate terminals:

```bash
npm ci
npm run server:start
```

```bash
npm run start
```

Open [http://127.0.0.1:4200](http://127.0.0.1:4200). The client uses `http://127.0.0.1:8787` as its current default API endpoint. The visible profile switcher selects demo Inspector, Reviewer or Admin identities; it is a test aid, not sign-in.

## What is implemented

- Project-scoped inspection lists, detail access, audit/export queries and demo RBAC
- Template version/publish state and per-inspection template snapshots
- Awaited IndexedDB writes, hydrate-race protection, malformed-row quarantine and legacy date/photo migration
- Separate photo Blob storage with a 5 MiB compressed-photo limit and a 100 MiB project limit
- PWA application-shell caching and offline cold start of an existing local record
- Durable actor-preserving outbox, idempotency keys, revisions, batch ACKs, retry/backoff and honest sync states
- Explicit conflict recovery that fetches and applies the server version only after the user confirms that queued local edits will be discarded
- Server-side workflow/RBAC validation, author–approver separation, project CSV protection, audit events, health and Prometheus metrics
- Preferences for default inspector, automatic sync, Wi-Fi-only sync, photo metadata and compact register layout

Conflict recovery currently supports **Use server version**. Cancelling keeps the local queued version paused; automatic merge or local rebase is not implemented.

## Verification

Install the Playwright browser once, then run the complete local gate:

```bash
npx playwright install chromium
npm run verify
```

Individual commands are also available:

```bash
npm run typecheck
npm test
npm run build
npm run build:server
npm run e2e
npm run artifact:checksum
npm run artifact:verify
npm run artifact:server:checksum
npm run artifact:server:verify
```

Latest recorded evidence on 2026-09-02:

| Suite | Result |
| --- | --- |
| Client unit/component/integration | 205 passed |
| Client measured coverage | statements 93.42%, branches 81.95%, functions 85.60%, lines 93.42% |
| Core production logic coverage | statements 92.72%, branches 83.25%, functions 90.58%, lines 92.72%; 13/13 runtime files measured |
| Companion server | 13 passed; lines 92.04%, branches 82.79%, functions 88.79% |
| Playwright production-artifact E2E | 14 passed |

The complete `npm run verify` gate passed with these results. The generated client artifact checksum is `fe118bd224a6ffc2b74640091ffee7b48560989ca0c2e0ce6f4e940aab4d24a5` (32 files) and the server artifact checksum is `ca555e9cee042933665586d2d15a006f97816f0c3f4650f162c074cef3a84282` (9 files). These are local verification records, not evidence of a hosted deployment.

The coverage gate requires every runtime file under `src/app/core` to be measured and requires statements, branches, functions and lines to each be at least 80% for both the measured report and aggregated core production logic. Playwright covers six main routes plus lifecycle/role separation, reload persistence, project isolation, offline queue-to-ACK, revision-conflict recovery, offline PWA cold start, accessibility and a 390×844 viewport.

## Architecture

- `src/app/core/auth`: demo identity and project-permission model
- `src/app/core/data`: inspection and photo IndexedDB repositories
- `src/app/core/state`: signal-based inspection, template, project and preference stores
- `src/app/core/sync`: durable outbox, HTTP client and sync coordinator
- `src/app/features`: lazy-loaded dashboard, inspection, template, audit, settings and help features
- `server`: Node.js 22 companion API, file storage, authorization and audit
- `e2e`: production-artifact Playwright workflows
- `scripts`: preview, packaging, coverage and artifact-integrity gates

The client production artifact is written to `dist/fieldnote`; the packaged companion service is written to `dist/fieldnote-server`.
