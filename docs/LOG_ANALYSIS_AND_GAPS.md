# Log analysis and product gaps

This doc summarizes findings from terminal/session logs, explains **why** things happen, and records current gaps (no push/PR, container churn, logging).

---

## 1. Scope approval — why it was asked multiple times

From the run for task `c5a92dc6-4684-4aed-83dd-429db535ecb8` (and earlier tasks):

| Step | Allowed files (plan) | Modified by AI | Reason |
|------|----------------------|----------------|--------|
| 0 | `[README.md]` | `package.json` | Step "Create README.md template" — LLM also emitted changes to `package.json` |
| 1 | `[README.md]` | `package.json` | Same: only README was in scope, model touched `package.json` |
| 2 | `[README.md]` | `package.json` | Same after resume |
| 3 | `[README.md]` | `package.json` | Same |
| 4 | `[README.md]` | `README.md`, `package.json` | Both changed; `package.json` still out of scope |
| 5 | `[README.md]` | `package.json` | Same |

**Root cause:** The planner scoped each step to `README.md` only. The code-gen model repeatedly produced edits that included `package.json` (e.g. from its output format or habit of touching project config). File-scope validation correctly flagged this, so the user was asked “Allow and proceed” or “Revise plan” every time.

**Why it’s repetitive:** The “revise plan” path adds a strict prefix to the instruction and retries; the model still often emits `package.json` again. So the only practical path was to keep choosing “Allow and proceed” for the same kind of violation.

**Improvements (product/UX):**

- Planner could allow `package.json` in steps that “add docs” if the repo uses it for scripts/docs.
- Code-gen prompt could explicitly say “Do not output changes to files not listed in allowedFiles.”
- Scope-extension justifications (already added) show “what changed” and “why” (step goal) so the user can decide with context.

---

## 2. Task completed but no code pushed, no PR

**Observed:** Task reached state `COMPLETED` and the completion message said “Branch is ready for manual merge,” but no code was pushed and no PR was created.

**Reason:** The app does **not** implement push or PR creation. Current behavior:

- A **host clone** at `workspaceDir/<taskId>/repo` is used only for:
  - Planning (repo structure)
  - Reading file contents for LLM context
- **Step execution** runs inside **ephemeral Docker containers**. Each container:
  - Clones the repo again inside the container
  - Applies the generated diff
  - Runs tests
  - Returns `diff` and test output
  - Is then destroyed
- Diffs are stored in the **plan steps** (e.g. in the DB) but are **never**:
  - Applied to the host clone
  - Committed
  - Pushed
  - Turned into a PR

So the “feature branch” and all code changes only ever existed inside containers; after each step the container is removed, so there is no persistent branch to push. The completion message is therefore misleading.

**Intended (from PRD):** “Auto-create feature branch, commit per step, push on completion.”

**To fix (future work):**

1. After each successful step (or when user allows scope), apply the step’s diff to the host clone at `workspaceDir/<taskId>/repo`, commit on the task’s feature branch.
2. On task completion, push the branch to the remote and optionally create a PR (e.g. via GitHub API or `gh` CLI).

Until that’s implemented, “Branch is ready for manual merge” should be treated as “Task finished; apply diffs manually or implement push/PR.”

---

## 3. Multiple containers created — is that a problem?

**Observed:** Each step run creates a new container (e.g. `8f0f3a2065d0`, `817fe1f4e0ed`, `5b949146d001`, …); after the step, the container is destroyed.

**By design:** The sandbox is **one container per step**: create → run step (clone, apply diff, install, test, collect diff) → destroy. That gives:

- A clean environment per step
- No leftover state between steps
- Simple failure semantics

**Trade-offs:**

- **Resource churn:** Many create/destroy cycles (e.g. 6 steps ⇒ 6 containers). That can be heavy on Docker and I/O.
- **Alternative:** Reuse one container per task: create once, then for each step apply the new diff and run tests, and only destroy at task end. That would reduce churn but require careful handling of incremental state and errors.

So multiple containers are intentional. If it becomes an issue, the next step would be to design a “one container per task” mode and document when to use it.

---

## 4. Logs for later analysis

Logs were only on stdout, so they were lost when the terminal closed. To support later analysis:

- **File logging** was added: set `LOG_FILE` (path to a file). The same structured logs (JSON lines) are written there so you can:
  - Inspect past runs
  - Grep for task IDs, scope violations, container IDs, etc.
  - Use with log aggregators or simple scripts

See [Logging](#logging) below for how to enable it.

---

## Logging

- **Stdout:** Unchanged (pretty-printed in dev when not using `LOG_FILE` in a way that changes the transport).
- **File (optional):** Set `LOG_FILE` to a path, e.g.:
  - `LOG_FILE=./logs/ai-dev-assistant.log`
  - `LOG_FILE=/tmp/ai-dev-assistant.log`
  Logs are appended (JSON lines) for later analysis.
- **Level:** `LOG_LEVEL` (default `info`).

Example:

```bash
export LOG_FILE=./logs/ai-dev-assistant.log
mkdir -p ./logs
yarn dev submit -g "..." -r "https://github.com/..."
```

Then inspect with:

```bash
cat logs/ai-dev-assistant.log | jq .
# or
grep "scope violation" logs/ai-dev-assistant.log
grep "c5a92dc6" logs/ai-dev-assistant.log
```
