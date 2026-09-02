# Repository working agreement

## Git workflow

- Perform development work on a topic branch, not directly on the default branch.
- After implementation and verification, inspect the current branch plus local and remote branch history before choosing the destination branch.
- Continue an existing branch only when its purpose and history clearly match the current change. Otherwise, create a descriptive branch using an appropriate prefix such as `feature/`, `fix/`, or `chore/` from the correct base branch.
- Commit only intended, verified changes and push the topic branch to `origin` with an upstream tracking branch.
- Never force-push, rewrite shared history, or push development changes directly to the default branch unless the user explicitly requests it.
- Report the branch name, commit, push result, and verification result when handing off completed development.

## Documentation workflow

- Assign one dedicated documentation steward agent to every development task, using the task name `documentation_keeper` when supported. Reuse that agent within the current thread; otherwise create it once the scope is known. Have it review the complete implementation diff after verification and before the final commit or push. If agent delegation is unavailable, the implementing agent owns this checklist and reports that fallback.
- The steward inspects both committed and uncommitted changes against the task base, updates affected documentation in the same topic branch, and reports either the updated files or a specific evidence-based reason that no documentation change is required.
- Keep documentation close to its source of truth and apply this change map:

| Change type | Required documentation review |
| --- | --- |
| Setup, dependencies, local commands, or top-level capabilities | `README.md` |
| User workflow, acceptance criteria, roles, usability, or test evidence | `docs/product-workflows-and-verification.md` |
| Delivery status, priorities, milestones, gaps, or technical debt | `docs/maintenance-roadmap.md` |
| CI/CD, environment, artifact, deployment, backup, recovery, or rollback | `docs/release-runbook.md` |
| System boundaries, components, data flows, auth, persistence, sync, API architecture, quality scenarios, risks, or architectural decisions | `docs/architecture/arc42.md` and, when its index or baseline changes, `docs/architecture/README.md` |
| Companion server API, request/response contract, storage schema, status transition, or server environment | `server/README.md` plus the relevant arc42/API sections |

- Describe implemented behavior as current only when code and verification evidence support it. Mark future designs explicitly as `Planned / not implemented`; never mix planned elements into current C4/UML views without that label.
- Update commands, metrics, artifact hashes, dates, branch names, and commit references only from reproducible current evidence. Remove stale claims instead of retaining them as history.
- Documentation is complete only when affected links and Markdown/Mermaid fences have been checked, `git diff --check` passes, relevant code-derived verification still passes, and the final handoff names the documentation impact and validation performed.
