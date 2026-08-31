# FIELDNOTE — Offline Field Inspection

FIELDNOTE is an Angular field-inspection application inspired by modern construction operations platforms. It supports template-driven inspection capture, photo evidence, IndexedDB offline persistence, automatic reconnection sync, a `Draft → Submitted → Approved` workflow, and a complete audit trail.

## Run locally

```bash
npm install
npm run start
```

Open [http://127.0.0.1:4200](http://127.0.0.1:4200).

## Production build

```bash
npm run build
```

Build output is written to `dist/fieldnote`.

## Architecture

The application follows Angular's feature-first standalone architecture:

- `core/data`: IndexedDB repository and seed data
- `core/models`: domain types and workflow contracts
- `core/services`: connectivity and cross-feature notifications
- `core/state`: signal-based inspection, template and project stores
- `layout`: persistent application shell and responsive navigation
- `features`: lazy-loaded dashboard, inspections, templates, audit, settings and help areas
- `shared/ui`: reusable status and toast components

Each route is lazy loaded. Feature pages own their presentation and interaction logic, while data access, workflow validation and persistence remain in the core layer.

## Verification workflow

1. Start an inspection from an active template.
2. Choose a site zone, complete every required checklist item and add photo evidence when required.
3. Enable offline test mode from the sidebar and continue editing.
4. Submit the inspection, return online and verify pending changes sync automatically.
5. Approve the submitted record and review every workflow event in the audit log.
