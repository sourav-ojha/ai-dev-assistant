# Why "Fix it" Could Not Fix the vitest / Yarn Failure

When a step failed with errors like:

- `sh: 1: vitest: not found`
- `packageManager": "yarn@4.11.0"` but current Yarn is 1.22.22
- `NO_TEST_RUNNER_FOUND`

pressing **Fix it** in Telegram did not resolve the failure. Here’s why.

## Root cause: environment, not code

The failure was **environmental**, not a bug in the AI-generated code.

1. **Dependencies were never installed in the sandbox**  
   The Docker sandbox flow was: clone repo → apply diff → run tests.  
   It did **not** run `yarn install` or `npm install`. So `node_modules` did not exist, and `vitest` (and other devDependencies) were not available → `vitest: not found`.

2. **Yarn / Corepack mismatch**  
   This repo uses `"packageManager": "yarn@4.11.0"`. The sandbox image (Node 20 slim) did not enable Corepack and used an older Yarn (1.22.22). So even with an install step, the project’s Yarn 4 setup would not be used unless Corepack is enabled.

## What "Fix it" can and cannot do

**Fix it** is designed to fix **code or instruction** issues:

- It sends the failure reason and test output to the LLM.
- The LLM returns a **revised step instruction** (e.g. “Update README to include X”).
- The orchestrator updates the plan and **retries the same step** in the **same sandbox flow**: generate code from the new instruction → apply in container → run the **same** test command (`npm test || yarn test`).

So Fix it can change **what code we generate** and **what the step asks for**. It **cannot**:

- Change how the sandbox runs (e.g. add an install step).
- Change the test command (that’s hardcoded in the sandbox runner).
- Fix missing dependencies or wrong Node/Yarn/Corepack setup.

Because the failure was “no deps + wrong Yarn”, no revised instruction could fix it; the next run would still see the same environment and the same errors.

## What we changed

- **Sandbox** now runs an **install step** after applying the diff and before running tests:
  - **Package manager detection** supports **Yarn (all versions)** and **npm**:
    - If `package.json` has `"packageManager": "yarn@..."` (Corepack uses that version) → `yarn install` / `yarn test`.
    - Else if `yarn.lock` or `.yarnrc.yml` exists → Yarn (classic or 2+).
    - Else if `package-lock.json` exists → `npm ci`; otherwise `npm install` / `npm test`.
  - Corepack is enabled so Yarn 2/3/4 work when `packageManager` is set.
- With that in place, tests can run in the sandbox. Any failure that **is** due to code or instructions can then be addressed by **Fix it**.

## When Fix it will help

Fix it is effective when the failure is due to:

- Wrong or incomplete implementation (logic, missing cases).
- Wrong files or scope.
- Misunderstood step instruction.

Fix it will **not** fix:

- Missing or wrong tooling in the image (Node, Yarn, Corepack).
- Sandbox not installing dependencies (now addressed by the install step).
- Network or permission issues in the container.
