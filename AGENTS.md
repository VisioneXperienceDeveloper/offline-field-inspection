# Repository working agreement

## Git workflow

- Perform development work on a topic branch, not directly on the default branch.
- After implementation and verification, inspect the current branch plus local and remote branch history before choosing the destination branch.
- Continue an existing branch only when its purpose and history clearly match the current change. Otherwise, create a descriptive branch using an appropriate prefix such as `feature/`, `fix/`, or `chore/` from the correct base branch.
- Commit only intended, verified changes and push the topic branch to `origin` with an upstream tracking branch.
- Never force-push, rewrite shared history, or push development changes directly to the default branch unless the user explicitly requests it.
- Report the branch name, commit, push result, and verification result when handing off completed development.
