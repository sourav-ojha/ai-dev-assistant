## **Product Requirements Document**

**Autonomous, Human-in-the-Loop AI Coding System**
_(The “AI Developer Assistant”)_

---

### **1 — Vision**

Build a system where your development machine (hosted on a VPS) can:

- Generate structured development plans
- Execute code tasks step-by-step
- Send progress reports & notifications
- Ask for approval before moving to the next step
- Use reusable **AI agent skills** for reliable execution

The goal is **controlled autonomy** (not full chaos) — keeping you in charge while offloading tedious repetition.

---

### **2 — Target Users**

Primary:

- You (software engineer implementing projects)
- Developers who want asynchronous AI coding support
- Small teams who need supervised automation

Secondary:

- DevOps & engineering leads seeking structured AI assistance

#### **Jobs to Be Done**

| When I...                                     | I want to...                                        | So I can...                                          |
| --------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| Have a well-defined feature request           | Get the AI to break it into a plan with checkpoints | Approve and track progress without context-switching |
| Am away from my machine                       | Queue approvals via Telegram                        | Resume work when I'm back without losing momentum    |
| Get a failing test during execution           | Have the system pause and report clearly            | Avoid wasting time debugging silent failures         |
| Start a new project with established patterns | Load relevant skills automatically                  | Get consistent, best-practice code from the start    |
| Need to review AI-generated changes           | See concise diff summaries and test results         | Make informed approve/reject decisions in seconds    |
| Want to understand execution costs            | See token usage and cost per task                   | Stay within budget and optimize model usage          |

---

### **3 — Key Behaviors**

Your AI assistant MUST:

1. **Accept structured project goals**
2. **Generate a plan with tasks & checkpoints**
3. **Wait for your approval on every major step**
4. **Execute code changes safely & context-bounded**
5. **Run tests, summaries, and validations**
6. **Send concise status notifications to Telegram**
7. **Manage failures with clear pause/report logic**

No change is auto-merged; no plan goes ahead without human approval.

#### **Explicit Out of Scope (v1)**

The following are deliberately excluded from this system:

- **Auto-deployment** — The system will NOT deploy to production or staging environments
- **Infrastructure provisioning** — No Terraform, CloudFormation, or server management
- **Multi-user collaboration** — v1 is single-user; no team dashboards or shared queues
- **Self-hosted LLMs** — All model inference is via paid APIs, not local GPU inference
- **Replacing human code review** — AI-generated branches require manual review before merge
- **Real-time pair programming** — This is an async, batch-oriented system (use Cursor/Copilot for real-time)
- **Non-code tasks** — No design generation, copy writing, or project management automation
- **Mobile app** — Notifications are Telegram-only; no native iOS/Android client

---

### **4 — Skill Utilization (Skills.sh)**

**What skills are:**
Reusable capabilities you _install_ into an AI agent to give it **procedural knowledge** — like best practices, workflow templates, and tool integrations. They’re essentially “plugins for AI agents.” ([Skills][1])

Skills available on **skills.sh** include (trending & useful for your system):

- Frontend best practices (React, Next.js)
- Test-driven development
- API design patterns
- Architecture design patterns
- Git workflows & pull request conventions
- Product planning & executing plans
- Database design patterns
- Release notes generation
- Authentication & auth best practices ([Skills][2])

**How this helps:**

- Instead of teaching the AI from scratch every time, skills _bootstrap domain knowledge_ into its context.
- Skills allow your agent to generate more deterministic, repeatable output (reducing hallucination).
- You can install multiple skills relevant to your project domain — e.g., backend best practices, CI workflows — and let the agent call them.

**Integration Strategy:**

1. On your VPS, maintain a set of skills specific to your workflow.
2. When generating plans or executing tasks, the agent loads relevant skills into the context.
3. For example:
   - `frontend-best-practices` → used when creating a UI component
   - `test-driven-development` → used when writing tests
   - `git-advanced-workflows` → used for branching & commit conventions

This turns AI from a general text generator into a _procedural collaborator_.

---

### **5 — System Components**

#### **A) Controllers & Orchestrator**

Central service that:

- Accepts new tasks
- Calls the Planner LLM
- Sends formatted plans to you via Telegram
- Stores task state
- Coordinates execution workers

#### **B) Workers / Execution Sandboxes**

Each task executes in a **Docker sandbox**:

- Clone repo
- Checkout branch
- Apply changes step-by-step
- Run tests
- Report summaries
- Pause on checkpoints

Ephemeral containers avoid polluting your VPS environment.

#### **C) Task Lifecycle State Machine**

Every task follows a deterministic state machine — no ad-hoc control flow:

```
                    ┌──────────────────────────────────┐
                    │                                  │
  SUBMITTED ──→ PLANNING ──→ AWAITING_PLAN_APPROVAL ──┤
                    │              │         │         │
                    ▼              ▼         │         │
                  FAILED      REJECTED    MODIFIED     │
                                            │         │
                    ┌───────────────────────┘         │
                    ▼                                  │
              EXECUTING_STEP ──→ CHECKPOINT ──→ AWAITING_STEP_APPROVAL
                    │                                  │
                    ▼                                  ▼
              STEP_FAILED                         APPROVED
                    │                                  │
                    ▼                                  ▼
              PAUSED_ON_FAILURE              (next EXECUTING_STEP
                    │                         or COMPLETED)
                    ▼
          AWAITING_FAILURE_GUIDANCE
                    │
         ┌──────────┼──────────┐
         ▼          ▼          ▼
       RETRY     SKIP_STEP    ABORTED
```

**State definitions:**

| State                    | Description                                   | Next actions                              |
| ------------------------ | --------------------------------------------- | ----------------------------------------- |
| `SUBMITTED`              | Task received, queued for planning            | Auto-transition to PLANNING               |
| `PLANNING`               | Planner LLM generating structured plan        | Auto-transition to AWAITING_PLAN_APPROVAL |
| `AWAITING_PLAN_APPROVAL` | Plan sent to Telegram, waiting for human      | APPROVED / MODIFIED / REJECTED            |
| `EXECUTING_STEP`         | Worker running a single step in sandbox       | Auto-transition to CHECKPOINT             |
| `CHECKPOINT`             | Step complete, results gathered               | Auto-transition to AWAITING_STEP_APPROVAL |
| `AWAITING_STEP_APPROVAL` | Diff summary + test results sent to Telegram  | APPROVED / REJECTED                       |
| `STEP_FAILED`            | Step execution error (test failure, crash)    | Auto-transition to PAUSED_ON_FAILURE      |
| `PAUSED_ON_FAILURE`      | System halted, failure report sent            | RETRY / SKIP_STEP / ABORTED               |
| `COMPLETED`              | All steps done, branch ready for manual merge | Terminal state                            |
| `ABORTED`                | Human cancelled the task                      | Terminal state                            |
| `REJECTED`               | Plan rejected by human                        | Terminal state                            |

All state transitions are persisted and logged. The system can resume from any non-terminal state after a restart.

---

### **6 — Required Models & APIs**

**Planner Model** (high reasoning, low frequency)

- **Anthropic Claude Sonnet / Claude 4.5+** — excellent for multi-step planning, high-context reasoning.
- Used for plan structure, risk detection, architecture decisions.

**Code Generation Model** (high frequency)

- **GPT-5.2 Codex** or **Claude Code** via Anthropic API.
- Used for generating diffs, with _structured instructions_.
- Keep contexts small (only relevant files & instructions).

**Summarization Model** (low cost)

- Cheap/compact model for:
  - Diff & test summaries
  - Telegram message formatting

**Note on APIs:**

You will need **paid API access** to whichever provider you choose (OpenAI, Anthropic, etc.).
Your current Cursor/Antigravity subscriptions are great for interactive use — not headless API automation. APIs give programmable access needed for a VPS agent.

There are 3 main options:

1. **OpenAI API (GPT-5 Codex)**
   - Great for code generation
   - Easy integration

2. **Anthropic Claude Code / Sonnet APIs**
   - Best reasoning for planning
   - Best at handling structured plans with agent skills

3. **Hybrid Model Stack**
   - Claude for plans
   - GPT-5 Codex for code generation
   - Smaller cheaper model for summaries

Token budgeting and context scoping will keep your costs under control.

#### **Token Budget (First-Class Concept)**

Token usage is not a Phase 3 afterthought — it's a core domain concept from day one.

**Budget structure per task:**

| Budget Layer             | Default Limit     | Rationale                               |
| ------------------------ | ----------------- | --------------------------------------- |
| Per planning call        | 8,000 tokens out  | Plans should be structured, not verbose |
| Per code generation step | 4,000 tokens out  | Small, focused diffs only               |
| Per summarization call   | 1,000 tokens out  | Telegram messages are short             |
| Per task (total)         | 50,000 tokens out | Hard ceiling to prevent runaway costs   |
| Per month (all tasks)    | 2,000,000 tokens  | ~$20–40/month depending on model mix    |

**Enforcement rules:**

- Each LLM call checks remaining budget before executing
- If a step would exceed the per-task budget, the system transitions to `PAUSED_ON_FAILURE` with a "budget exceeded" reason
- Monthly budget triggers a hard stop with a Telegram alert when 80% consumed (warning) and 100% consumed (block)
- Token usage is logged per step and surfaced in the Telegram summary

**Context scoping strategy:**

- Only include files directly relevant to the current step (not the entire repo)
- Use file-level summaries for context instead of full file contents where possible
- Skills are loaded selectively — only the skill matching the current step type
- Plan context is passed as a compressed summary, not the full plan JSON

---

### **7 — Notifications & Approval Channels**

Implement via **Telegram Bot API**:

- Send:
  - New plan
  - Task status
  - Diff summaries
  - Test results

- Receive:
  - Approvals (YES / MODIFY / STOP)
  - Tweaked objectives

Telegram is simple, reliable, and programmable.

WhatsApp is possible via Meta/Twilio APIs, but Telegram is cheaper and cleaner for dev workflows.

---

### **8 — VPS / Infrastructure Requirements**

**Minimum:**

- 1 vCPU
- 2 GB RAM
- 40 GB Disk
- Docker support
- Open firewall for:
  - Incoming webhooks (Telegram)
  - Secure SSH

**Recommended Providers:**

- DigitalOcean (cheapest entry)
- Linode
- Hetzner
- AWS Lightsail

No GPUs needed. You’re calling models via APIs — not self-hosting LLMs.

---

### **9 — Security & Safety Requirements**

- Isolate sandboxes (Docker containers)
- No direct access to production secrets
- Use fake/stubbed env vars during execution
- Limit network access inside containers
- Log all actions
- Require approval for dangerous operations

Agent skills **can contain executable steps** — vet them before use. Some research shows security issues in unvetted skills at scale. ([arXiv][3])

---

### **10 — Workflow**

1. You submit a requirement via CLI or web UI.
2. Controller calls Planner LLM → JSON plan.
3. Plan sent to Telegram for approval.
4. You approve or modify.
5. Worker runs task in sandbox.
6. After each step:
   - Test results
   - Diff summary
   - Next checkpoint
   - Notification to you

7. You approve continuation.
8. Branch is ready → you merge manually.

No unmonitored full automation.

---

### **10.1 — Risk Analysis & Mitigation**

| Risk                                                           | Likelihood | Impact                                | Mitigation                                                                                                                                                  |
| -------------------------------------------------------------- | ---------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **LLM API downtime** (OpenAI/Anthropic outage)                 | Medium     | High — blocks all tasks               | Implement fallback model chain (e.g., Claude → GPT → local small model for summaries). Queue tasks and retry with exponential backoff.                      |
| **Context window overflow** (too many files loaded)            | High       | High — bad/hallucinated code          | Strict file scoping per step. Only include files directly referenced in the plan step. Use file summaries instead of full contents when possible.           |
| **Telegram API rate limits**                                   | Low        | Medium — missed notifications         | Batch messages. Implement message queue with backoff. Aggregate rapid-fire updates into single digest messages.                                             |
| **Runaway Docker containers** (infinite loops, resource leaks) | Medium     | High — VPS resource exhaustion        | Hard resource limits per container (CPU: 1 core, RAM: 512MB, timeout: 10 min). Auto-kill on timeout. Monitor container count.                               |
| **Cost overruns from LLM usage**                               | Medium     | Medium — budget blown                 | Token budgets enforced per-step and per-task (see Section 6). Monthly hard cap with 80% warning alert.                                                      |
| **Stale context / outdated repo state**                        | Medium     | Medium — merge conflicts, wrong code  | Fresh `git pull` at step start. Detect conflicts before code generation. Abort step if branch has diverged.                                                 |
| **Skill injection / malicious skills**                         | Low        | High — code execution risk            | Vet all skills before installation. Run skill-loaded code in sandboxed containers only. No skills have host filesystem access.                              |
| **Single point of failure (orchestrator crash)**               | Medium     | High — all tasks stall                | Persist state to SQLite on every transition. On restart, resume all non-terminal tasks from last persisted state. Systemd auto-restart.                     |
| **Telegram bot token compromise**                              | Low        | Medium — unauthorized task submission | Restrict bot to a single authorized chat ID. Validate all incoming commands against allowlisted user IDs. Rotate tokens periodically.                       |
| **LLM generates destructive operations** (rm -rf, DROP TABLE)  | Low        | Critical — data loss                  | Sandbox has no host access. Read-only filesystem except `/workspace`. No production credentials available. All git operations are on feature branches only. |

---

### **11 — Key Use Cases (Skill Examples)**

| Use Case                | Skill from skills.sh          |               |
| ----------------------- | ----------------------------- | ------------- |
| Create Auth Module      | `better-auth-best-practices`  |               |
| TDD Workflow            | `test-driven-development`     |               |
| Git Branching           | `git-advanced-workflows`      |               |
| API Design              | `api-design-principles`       |               |
| Database Patterns       | `postgresql-table-design`     |               |
| Frontend Best Practices | `vercel-react-best-practices` |               |
| Architecture Decisions  | `architecture-patterns`       |               |
| Plan Structured Steps   | `writing-plans`               | ([Skills][2]) |

These skills reduce prompt drift and improve result reliability.

---

### **11.1 — Competitive Differentiation**

Several AI coding agent tools exist. Here's why this system occupies a distinct niche:

| Tool                         | Approach                               | Key Limitation                                       | How We Differ                                                                          |
| ---------------------------- | -------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Devin (Cognition)**        | Fully autonomous AI engineer           | Black-box; limited human oversight; expensive SaaS   | We enforce human approval at every checkpoint — controlled autonomy, not full autonomy |
| **SWE-Agent**                | Research-grade autonomous bug fixer    | Focused on issue resolution; no planning workflow    | We cover the full lifecycle: planning → approval → execution → validation              |
| **OpenHands (ex-OpenDevin)** | Open-source autonomous agent           | Requires complex local setup; no notification loop   | We add Telegram-native human-in-the-loop and VPS-first deployment                      |
| **Sweep AI**                 | Auto-generates PRs from issues         | SaaS-only; no self-hosting; limited to GitHub issues | We're self-hosted, repo-agnostic, and accept arbitrary requirements                    |
| **Cursor / Copilot**         | Real-time interactive pair programming | Requires you to be at your machine, synchronous      | We're async and batch-oriented — you approve from your phone                           |
| **Claude Code / Codex CLI**  | CLI-based interactive coding agent     | Single-session, no persistent state, no notification | We persist state across sessions, notify via Telegram, and resume on restart           |

**Our unique position:**

1. **Self-hosted** — runs on your VPS, no SaaS dependency, full data control
2. **Human-in-the-loop by design** — not an afterthought, it's the core interaction model
3. **Skill-powered** — deterministic, repeatable output via procedural skills (not just prompts)
4. **Async-native** — you don't need to be at your desk; approve from Telegram on your phone
5. **Cost-transparent** — token budgets and per-task cost tracking from day one

---

### **12 — Key Performance Metrics**

#### **North Star Metric**

> **Task completion rate with tests passing on first human approval cycle.**
>
> This measures both AI quality (correct code) and system reliability (smooth workflow). If this number is high, the system is delivering value.

#### **Success Metrics with Targets**

| Metric                    | Definition                                       | Target (MVP) | Target (Mature) |
| ------------------------- | ------------------------------------------------ | ------------ | --------------- |
| Task success rate         | % of tasks where all tests pass on final branch  | >70%         | >90%            |
| First-pass approval rate  | % of plans approved without modification         | >50%         | >75%            |
| Approval cycles per task  | Average number of human approve/modify rounds    | <4           | <2              |
| Avg tokens per task       | Total tokens (in + out) consumed per task        | <80K         | <50K            |
| Time per step             | Wall-clock time from step start to checkpoint    | <5 min       | <3 min          |
| Cost per task             | USD cost of all LLM calls for one task           | <$1.00       | <$0.50          |
| Monthly cost              | Total LLM spend across all tasks                 | <$50         | <$30            |
| Unhandled failures        | % of tasks ending in a crash (not a clean pause) | <10%         | <3%             |
| Mean time to notification | Seconds from event to Telegram message delivery  | <10s         | <5s             |
| System uptime             | % of time the orchestrator is responsive         | >95%         | >99%            |

#### **Operational Dashboards**

Track and surface via logs / simple dashboard:

- **Per-task view:** Steps completed, tokens used, cost, time elapsed, current state
- **Daily digest:** Tasks submitted, completed, failed, total cost
- **Monthly summary:** Trends in success rate, cost per task, model usage breakdown

---

### **13 — Implementation Roadmap**

**Phase 0 — MVP: Planner + Telegram + Token Budgets** _(~2–3 weeks)_

Effort: **Small** | Dependencies: Telegram Bot token, LLM API key, VPS

| Deliverable           | Description                                                                 |
| --------------------- | --------------------------------------------------------------------------- |
| CLI task submission   | Accept a goal string via CLI, store in SQLite                               |
| Planner integration   | Call Claude API to generate a structured JSON plan                          |
| Telegram notification | Send formatted plan to Telegram with inline approve/modify/reject buttons   |
| Approval handling     | Receive Telegram callback, update task state                                |
| State machine (core)  | Implement SUBMITTED → PLANNING → AWAITING_PLAN_APPROVAL → APPROVED/REJECTED |
| Token budget tracking | Log tokens per call, enforce per-task ceiling, surface in Telegram messages |
| Basic persistence     | SQLite for task state, plan JSON, token usage                               |

**Exit criteria:** You can submit a goal via CLI, receive a plan on Telegram, approve it, and see the task transition to APPROVED with token usage logged.

---

**Phase 1 — Scripted Executor in Sandbox** _(~3–4 weeks)_

Effort: **Medium** | Dependencies: Docker on VPS, test framework in target repos

| Deliverable                 | Description                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| Docker sandbox runner       | Spin up ephemeral containers per task, mount repo, apply resource limits                      |
| Code generation integration | Call code gen model (GPT/Claude) with scoped file context per step                            |
| Step execution pipeline     | Execute steps sequentially, run tests, collect results                                        |
| Checkpoint & approval loop  | After each step: send diff summary + test results to Telegram, wait for approval              |
| Failure handling            | Detect test failures / crashes → transition to PAUSED_ON_FAILURE → notify with failure report |
| Git operations              | Auto-create feature branch, commit per step, push on completion                               |

**Exit criteria:** You can submit a multi-step task, watch it execute in Docker with checkpoints, approve each step via Telegram, and get a feature branch with passing tests.

---

**Phase 2 — Skill Integration** _(~2–3 weeks)_

Effort: **Medium** | Dependencies: Phase 1 complete, skills.sh account

| Deliverable          | Description                                                                    |
| -------------------- | ------------------------------------------------------------------------------ |
| Skill registry       | Local store of installed skills with metadata (type, triggers, content)        |
| Skill resolver       | Given a step type (e.g., "create React component"), auto-select relevant skill |
| Context injection    | Load skill content into LLM context alongside step instructions                |
| Skill management CLI | `install`, `list`, `remove` commands for skills                                |

**Exit criteria:** When the planner generates a step tagged "frontend," the system automatically loads `vercel-react-best-practices` into the code gen context, producing skill-informed output.

---

**Phase 3 — Cost Optimization & Observability** _(ongoing)_

Effort: **Large (continuous)** | Dependencies: Usage data from Phases 0–2

| Deliverable          | Description                                                                         |
| -------------------- | ----------------------------------------------------------------------------------- |
| Model role switching | Route planning to Claude, code gen to Codex, summaries to cheap model — dynamically |
| Fallback chains      | If primary model fails/times out, fall back to secondary model automatically        |
| Context compression  | Summarize large files before injection, cache file summaries across steps           |
| Cost dashboard       | Daily/weekly cost reports via Telegram digest                                       |
| Observability        | Structured logging, per-task traces, error rate alerts                              |

**Exit criteria:** Average cost per task drops below $0.50, and you receive a weekly cost digest on Telegram with trend data.

---

### **13.1 — Dependency Graph**

```
Phase 0 (MVP)
  │
  ├──→ Phase 1 (Executor)
  │        │
  │        ├──→ Phase 2 (Skills)
  │        │
  │        └──→ Phase 3 (Optimization)
  │                  ▲
  └──────────────────┘  (token budgets from Phase 0 feed into Phase 3)
```

Phases 2 and 3 can run in parallel once Phase 1 is stable.

---

### **14 — Proposed Architecture**

#### **Architecture Style: Hexagonal (Ports & Adapters)**

All external dependencies (LLMs, Telegram, Docker, Git, database) are behind port interfaces. Business logic has zero framework dependencies.

```
ai-dev-assistant/
├── src/
│   ├── core/                          # Domain layer (pure business logic, no deps)
│   │   ├── planning/
│   │   │   ├── entities/              # Plan, Task, Checkpoint, Step
│   │   │   ├── use-cases/            # GeneratePlan, ModifyPlan, ApprovePlan
│   │   │   └── ports/                # IPlannerModel, IPlanStore
│   │   ├── execution/
│   │   │   ├── entities/              # Sandbox, ExecutionResult, TestReport
│   │   │   ├── use-cases/            # ExecuteStep, RunTests, PauseOnFailure
│   │   │   └── ports/                # ICodeGenerator, ISandboxRunner, ITestRunner
│   │   ├── notification/
│   │   │   ├── entities/              # Message, ApprovalRequest, ApprovalResponse
│   │   │   ├── use-cases/            # SendNotification, WaitForApproval
│   │   │   └── ports/                # INotificationChannel
│   │   ├── skills/
│   │   │   ├── entities/              # Skill, SkillContext, SkillRegistry
│   │   │   ├── use-cases/            # LoadSkill, ResolveSkillsForTask
│   │   │   └── ports/                # ISkillStore
│   │   └── budget/
│   │       ├── entities/              # TokenBudget, UsageRecord
│   │       ├── use-cases/            # TrackUsage, CheckBudget, AlertOnThreshold
│   │       └── ports/                # IUsageStore
│   │
│   ├── infrastructure/                # Adapters (implementations of ports)
│   │   ├── llm/
│   │   │   ├── AnthropicPlannerAdapter.ts
│   │   │   ├── OpenAICodeGenAdapter.ts
│   │   │   ├── CheapSummarizerAdapter.ts
│   │   │   └── ModelRouter.ts         # Routes calls to correct model by role
│   │   ├── telegram/
│   │   │   └── TelegramNotificationAdapter.ts
│   │   ├── docker/
│   │   │   └── DockerSandboxRunner.ts
│   │   ├── persistence/
│   │   │   └── SQLiteTaskStore.ts
│   │   └── git/
│   │       └── GitOperationsAdapter.ts
│   │
│   ├── orchestrator/                  # Application layer (coordinates use cases)
│   │   ├── TaskOrchestrator.ts        # Main workflow coordinator
│   │   ├── ApprovalGatekeeper.ts      # Human-in-the-loop gate
│   │   └── StepExecutionPipeline.ts   # Sequential step runner with state machine
│   │
│   ├── api/                           # Interface layer
│   │   ├── cli/                       # CLI commands (submit task, list tasks, manage skills)
│   │   └── webhook/                   # Telegram webhook handler (approval callbacks)
│   │
│   └── config/
│       ├── container.ts               # Dependency injection wiring
│       ├── models.ts                  # Model configuration & routing rules
│       └── budgets.ts                 # Token budget defaults
│
├── skills/                            # Installed skill definitions
├── tests/                             # Unit & integration tests
├── docker/                            # Sandbox Dockerfile & compose
├── package.json
├── tsconfig.json
└── README.md
```

#### **Key Design Decisions**

1. **Ports & Adapters** — Swap any external dependency (Claude ↔ GPT, Telegram ↔ Slack, SQLite ↔ Postgres) without touching business logic
2. **State machine over ad-hoc control flow** — Every task transition is explicit, persisted, and resumable (see Section 5C)
3. **Model Router pattern** — A single `ModelRouter` decides which LLM handles which role, enabling easy model switching and fallback chains
4. **Token budget as domain entity** — Not middleware or logging; it's a first-class object that can veto LLM calls

#### **Recommended Tech Stack**

| Layer         | Choice                        | Rationale                                                                    |
| ------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| Language      | **TypeScript (Node.js)**      | Rich LLM SDK ecosystem, async-native, single language for CLI + server       |
| API Framework | **Fastify**                   | Lightweight, fast, plugin-based, good for webhook handling                   |
| State Storage | **SQLite (better-sqlite3)**   | Zero-config, embedded, sufficient for single-user VPS                        |
| Job Queue     | **BullMQ + Redis**            | Reliable step execution queue with retry, delay, and dead-letter support     |
| Docker SDK    | **dockerode**                 | Well-maintained Node.js Docker client for sandbox management                 |
| Telegram      | **telegraf**                  | Best Node.js Telegram bot framework, supports inline keyboards for approvals |
| LLM Clients   | **@anthropic-ai/sdk, openai** | Official SDKs, maintained by providers, library-first approach               |
| Testing       | **Vitest**                    | Fast, modern, TypeScript-native test runner                                  |
| CLI Framework | **commander**                 | Lightweight, well-documented CLI argument parsing                            |
| Logging       | **pino**                      | Fast structured JSON logging, pairs well with Fastify                        |

#### **Alternative Considerations**

- **Python instead of TypeScript** — Viable if you prefer Python. Use FastAPI + python-telegram-bot + docker-py. Trade-off: weaker typing, but richer ML ecosystem (not needed here since we're calling APIs, not running models).
- **PostgreSQL instead of SQLite** — Only if you foresee multi-user or need complex queries. SQLite is simpler and sufficient for v1.
- **Redis optional** — For Phase 0, a simple in-process queue or even sequential execution is fine. BullMQ becomes valuable in Phase 1 when step execution needs retries and timeouts.
