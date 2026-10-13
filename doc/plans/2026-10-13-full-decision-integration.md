# Full Decision integration — implementation spec

Status: spec / implementation contract. Branch: `personal`.
Builds on the shipped commits `b794feba1` (direct TypeSafe/Jev decision provider,
purpose switches, `issues.classify`) and `e79f3b472` (connector purposes no
longer offered on AI connections).

Every mechanism below is grounded in the current tree with a file:line
reference. This document contains no code; it specifies changes.

## 0. Problem statement

Paperclip has the accounting, the queue, and the model plumbing, but almost no
product code actually *asks* for a decision. Verified callers of
`decisionModelService`:

- `server/src/routes/decision-models.ts:14` — the setup test only.
- `server/src/services/heartbeat.ts:5314` — `recoverInterrupted()` housekeeping only.
- `server/src/services/decision-features.ts` — `issues.classify` (shipped).

So: the engine exists, adoption is one feature. "Full integration" means three
things that are today missing:

1. A **catalog of real decision features** wired into product code.
2. A **human loop**: an uncertain or authority-gated decision becomes a visible
   item in the **Decisions** queue, not silent.
3. A **prompt/agent loop**: agents that should use a decision know that a
   decision service exists and how to call it.

## 1. Names first (three different things)

Do not conflate these. They are separate subsystems with separate tables.

| Name | What it is | Where | Populated by |
| --- | --- | --- | --- |
| Company decision model | One shared API connection Paperclip uses for typed decisions (Jev, OpenAI, OpenRouter) | `company_decision_models`, `decision_invocations`, `server/src/services/decision-models.ts` | product callers (this spec) |
| Decisions queue (left menu) | Human triage queue "what needs your decision" | `decision_queues`, `decision_queue_items`, `server/src/services/decision-queues.ts`, `ui/src/pages/DecisionQueuePage.tsx` | `attention.ts:1928` `materializeSeededQueues` from attention sources |
| Costs → Decisions | Metadata journal of decision-model calls | `ui/src/components/decision-models/DecisionHistory.tsx`, costs tab at `ui/src/pages/Costs.tsx:733` | `decision_invocations` |

Agent-side Jev is a **fourth** path: the `typesafe_ask` connector tool
(`server/src/services/connectors/typesafe.ts`, `skills/typesafe/SKILL.md`),
which needs its own tool connection + install and is independent of the
decision model.

## 2. Invariants this spec must preserve

Verified contracts, unchanged by this work:

- **Company scope** on every row (`company_decision_models`, `decision_invocations`, `decision_queue_items`).
- **Accounting lock + budgets** on admission and settlement (`decision-models.ts:188-231`, `:140-173`).
- **Secret service** resolves keys at dispatch; never stored in config (`decision-models.ts:180-187`).
- **Metadata-only** invocation history; no state/answers/raw payloads (`packages/db/src/schema/decision_models.ts:19-45`).
- **Cost ledger** `usageKind = "decision"`, agentless allowed (`packages/db/src/schema/cost_events.ts:43`); direct Jev rate card `typesafe-jev-2026-10-12`, 4.2 cents per 1M input tokens (`decision-model-provider.ts:41-45`).
- **Fail closed**: no registered feature, no `purpose` gate, no `allowBackground` → no call.
- **Purposes** are the single taxonomy, shared with the connector (`packages/shared/src/typesafe.ts:70-129`); direct Jev purposes are company-level (`company_decision_models.purposes`).

Review-level note (repo AGENTS): decisions are a **run-log/operational** path and
a DB path, not Telemetry. This spec adds **no** first-party Telemetry events.

## 3. Layer 1 — Model, connection, pricing (shipped, keep)

Already implemented. No changes. For reference:

- Providers: `DECISION_MODELS` = openai | openrouter | typesafe (`packages/shared/src/decision-models.ts:4-10`).
- Direct Jev call: `runTypesafeDecision` maps boolean↔`noul`, choice↔choice, score↔score (`decision-model-provider.ts:49-104`).
- Purposes gate: `purpose_disabled` (`decision-models.ts:143-146`).

## 4. Layer 2 — Feature registry (expand)

Today `defineDecisionFeature(id, { background, purpose })`
(`server/src/services/decision-models.ts:24-30`). Expand it to carry the full
definition so every feature is one declaration and one call site.

```
type DecisionFeatureSpec = {
  id: string;                    // stable, e.g. "plans.gate"
  purpose: TypesafePurpose;      // gates on company_decision_models.purposes
  background: boolean;           // system-sponsored allowed
  label: string;                 // UI + history label
  confidence: number;            // minimum confidence to act
  buildState(ctx): DecisionState;// what is sent to the provider
  questions: DecisionRequest["questions"];
  apply(ctx, answers): Promise<"acted" | "escalated" | "skipped">;
  fallback: "current-behaviour" | "escalate";
};
```

`buildState`/`apply` stay server-side and are never reachable over JSON. Keep the
existing `WeakSet` registration gate (`decision-models.ts:22`) so a handle cannot
be forged.

Shared label map (new, `packages/shared/src/decision-models.ts`): export
`DECISION_FEATURES` metadata (id, label, purpose) so UI history and settings do
not hand-maintain labels (currently `DecisionHistory.tsx` keeps a local map).

### 4.1 Feature catalog (all opt-in, all off by default)

| Feature id | purpose | mode | state | questions | threshold | action | fallback |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `issues.classify` **(shipped)** | priority | background | title, description | score severity | 0.7 | set priority if still default | no-op |
| `issues.triage` | issue_triage | agent/human | heartbeat context + signals | choice verdict {resume,wake,reassign,unblock,escalate,close}, noul assignee_fit, score staleness | 0.7 | act only for resume/wake; else escalate | escalate |
| `plans.gate` | task_planning | background | plan doc + goal | noul verifiable criteria, score coverage, choice {ready,needs-detail,blocked} | 0.75 | block execution only when choice != ready | proceed |
| `qa.acceptance` | qa_acceptance | agent/human | acceptance criteria + change summary | one noul per criterion + score overall | 0.7 | fail review when any criterion fails | inherit |
| `inbox.garden` | inbox_gardening | background | candidate inbox items | choice {keep,archive,needs-human} per item batch | 0.85 | archive only above threshold | keep |
| `guardrails.outbound` | guardrails | background | the exact outbound text | noul leaks-credentials, score policy risk, choice {send,redact,hold} | 0.9 | hold below threshold | hold |
| `issues.dedupe` | issue_triage | background | new issue + top-K similar | choice {duplicate,related,distinct} | 0.8 | link as duplicate only above threshold | related |
| `pr.mergeability` | task_planning | agent/human | PR body, diff stat, checks | noul template complete, score readiness, choice {ready,needs-fixes,needs-human} | 0.75 | refuse auto-merge below threshold | needs-human |

Each feature ships as its own PR with: registry entry, call site, unit test,
purpose-default decision, and a documented confidence rule.

## 5. Layer 3 — Real call sites (background + lifecycle)

Wire the features where Paperclip already makes a fuzzy judgment today.

- `issues.classify` — done, hook captured at `services/issues.ts:10489-10492`.
- `issues.triage` / `qa.acceptance` — the bundled skills
  `paperclip-operations/issue-triage`, `quality/qa-acceptance`,
  `paperclip-operations/task-planning` already describe `typesafe_ask` with the
  matching `purpose` (`SKILL.md:51-89`, sibling files). Keep the agent path on
  the connector tool; the decision-model path is for the **server** to call the
  same judgment without an agent run (recovery, watchdog, routines).
- `plans.gate` — on plan acceptance (the plan document confirmation path).
- `inbox.garden` — the inbox archive-candidate scan.
- `guardrails.outbound` — immediately before outbound publication (Slack/email/
  chat/webhook), using the existing outbound publication choke point.
- `issues.dedupe` — in `issueService.create` before the title guard.
- `pr.mergeability` — the PR-gardening path.

Rule: a background feature must never block a user action. Best-effort with a
short timeout, exactly like `suggestIssuePriority`. Durability (retry/outbox)
is explicitly out of scope v1 and named as a follow-up where a feature needs it.

## 6. Layer 4 — Human loop (connect decisions to the Decisions queue)

This is the missing link the user noticed: Jev never appears in the left-menu
**Decisions**.

Two escalation targets exist and both are already modelled:

- Issue-scoped → create an `ask_user_questions` interaction. Pending
  `ask_user_questions` are auto-collected into the `questions` queue by
  `DECISION_QUEUE_SEEDS` (`server/src/services/decision-queues.ts:74-83`).
- Non-issue-scoped → add a queue item with `sourceKind: "decision"`
  (`ATTENTION_SOURCE_KINDS` includes `"decision"`, `packages/shared/src/types/attention.ts:8-21`)
  through `decisionQueueService.addItem` (`decision-queues.ts:481-503`).

Spec: when a feature's `apply` returns `"escalated"` — or confidence is below
threshold for an authority-gated action — the feature's `apply` must:

1. Persist the invocation as usual (it already did).
2. Create the issue `ask_user_questions` interaction (issue-scoped) **or** a
   `sourceKind: "decision"` queue item (system-scoped), carrying a bounded
   summary: feature id, one-line question, options, and the invocation id.
3. Never copy the state or the raw provider answer into the queue item
   (metadata-only rule). The operator sees the question and options, not the
   payload.

Add a thin helper `escalateDecision(db, ctx, { invocationId, question, options })`
in `server/src/services/decision-features.ts`. It must respect company scope and
write an activity-log entry.

Result: a low-confidence `guardrails.outbound` hold, or an `issues.triage`
"escalate" verdict, shows up under **Decisions → Questions**, and the existing
All / Questions / Plans filters finally have content.

## 7. Layer 5 — Prompt/agent integration

Agents currently have no idea a decision service exists. Add one guidance block,
gated on availability:

- Where: the heartbeat task context build (`server/src/services/heartbeat/task-markdown.ts`,
  `buildPaperclipTaskMarkdown`) plus the existing connection-instructions path.
  Do **not** touch the company instructions prefix (user-owned text).
- What: if the company has an enabled decision model with at least one purpose
  on, inject a short block: "A calibrated decision service is available. For
  judgment calls named in your skills, prefer it over guessing. It answers typed
  questions with confidence; below the stated threshold, escalate instead of
  acting."
- Runtime selection: the decision-model path is server-side only (no agent tool).
  The agent-facing path stays the `typesafe_ask` connector tool. The guidance
  must name whichever path is actually available (decision connection vs tool
  connection vs both), read from `decisionModelService.availability` and the
  assigned-connection context. Reuse `availabilityForRequest` for one request
  (`decision-models.ts:136-139`).
- Keep it out of the prompt when no connection is enabled (no dead instruction).

## 8. Layer 6 — Accounting, budgets, history

Already correct for the model path. Required additions:

- Every new feature must settle through the existing `settle` path so cost lands
  in `Costs → Decisions` and budgets see it. No per-feature pricing.
- Extend the shared feature label map so `DecisionHistory.tsx` shows product
  names for the whole catalog instead of a two-entry local map.
- Optional, separate decision: give the agent **connector** tool a cost event.
  Needs a new `usageKind` (the check at `cost_events.ts:43` allows only
  `decision`/`fast_response`/agent). Out of scope here; named so it is not
  forgotten.

## 9. Layer 7 — UI

- Decision model settings: purpose switches (shipped). Add a per-purpose
  "features enabled by this purpose" hint so an operator knows what turning it
  on spends on.
- Costs → Decisions: label map from shared (above); provider already shown.
- Decisions queue (`ui/src/pages/DecisionQueuePage.tsx`): items with
  `sourceKind: "decision"` must render the feature label and the question/options
  from the escalation summary, and link to the invoking issue/run when present.
- Issue thread: `ask_user_questions` escalation uses the existing interaction
  card; no new interaction kind is required (see `create-issue-interaction-ui`).

## 10. API deltas

| Method/path | Change |
| --- | --- |
| `GET /api/companies/:companyId/decision-model` | already returns `settings` (with `purposes`) + `choices`; add `features` (catalog + enabled-by-purpose) |
| `PUT /api/companies/:companyId/decision-model/purposes` | shipped |
| `POST /api/companies/:companyId/decision-model/test` | unchanged |
| Decision queue routes (`routes/decision-queues.ts`) | unchanged; they already accept `sourceKind: "decision"` |

No general HTTP decision-execution endpoint. Features are server-registered
handles only.

## 11. Data model

- No new tables required. `company_decision_models.purposes` (migration `0338`)
  gates features; `decision_invocations.feature` already stores the feature id;
  `decision_queue_items` already supports `sourceKind: "decision"`.
- If a future feature needs durable retry, add a `decision_requests` table in a
  later, separate migration. Not now.

## 12. Verification

Targeted, per feature:

```sh
pnpm --filter @paperclipai/server exec tsc --noEmit
pnpm --filter @paperclipai/ui typecheck
pnpm --filter @paperclipai/server exec vitest run src/__tests__/decision-models.test.ts
pnpm --filter @paperclipai/server exec vitest run src/__tests__/decision-queues-routes.test.ts
pnpm --filter @paperclipai/ui exec vitest run src/components/decision-models src/features/connections
```

DB suites need Linux/WSL (embedded Postgres refuses an admin token on Windows).
Live acceptance: enable one purpose, trigger the feature, then confirm an
invocation in Costs → Decisions **and** an escalation in Decisions → Questions
when confidence is low.

## 13. Rollout order

1. Feature registry expansion + shared label map (no behaviour change).
2. `escalateDecision` + queue wiring + queue-page rendering.
3. Prompt guidance block (gated on availability).
4. Features, one PR each: `issues.classify` (done) → `issues.triage` →
   `plans.gate` → `guardrails.outbound` → `qa.acceptance` → `inbox.garden` →
   `issues.dedupe` → `pr.mergeability`.
5. Docs: `doc/decision-models.md`, `doc/connections/TYPESAFE.md`, a Decisions
   queue doc.

## 14. Risks

- **Spend creep.** Background features spend on the operator's key. Mitigation:
  every purpose off by default; per-purpose hint in settings; budgets already
  enforced.
- **Privacy.** `state` goes to TypeSafe. Mitigation: only open, non-private
  issues; outbound guardrail sends text that is already about to leave; a
  per-purpose disclosure.
- **Silent no-ops.** A disabled purpose looks like "nothing happened".
  Mitigation: the escalation path reports `purpose_disabled` distinctly.
- **Two Jev paths.** Decision model (server) vs `typesafe_ask` (agent). Keep
  purposes shared; document which path each surface uses.
- **Escalation noise.** Low thresholds flood the queue. Mitigation: per-feature
  thresholds; batch/fan-out questions in one call; a queue retention policy
  already exists.

## 15. Non-goals

- Jev as the agent's chat model (it is an evaluator).
- A general public decision HTTP API.
- Durable decision retry/outbox in v1.
- Connector tool cost events (separate).
- Any first-party Telemetry event.
