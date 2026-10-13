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
| Decisions queue (left menu) | Human triage queue "what needs your decision" | `decision_queues`, `decision_queue_items`, `server/src/services/decision-queues.ts`, `ui/src/pages/DecisionQueuePage.tsx` | `attention.ts:1928` `materializeSeededQueues` (seeds `prs/plans/questions`) plus the manual `addItem` route |
| Costs → Decisions | Metadata journal of decision-model calls | `ui/src/components/decision-models/DecisionHistory.tsx`, costs tab at `ui/src/pages/Costs.tsx:733` | `decision_invocations` |

Agent-side Jev is a **fourth** path: the `typesafe_ask` connector tool
(`server/src/services/connectors/typesafe.ts`, `skills/typesafe/SKILL.md`),
which needs its own tool connection + install and is independent of the
decision model.

Note: a `decision_queue_items.sourceKind` of `"decision"` refers to the
`decisions` table (agent-created decisions the board resolves), which is again a
different subsystem from the company decision model. Do not read the left-menu
"Decisions" as decision-model usage; that lives in Costs → Decisions.

## 2. Invariants this spec must preserve

Verified contracts, unchanged by this work:

- **Company scope** on every row (`company_decision_models`, `decision_invocations`, `decision_queue_items`).
- **Accounting lock + budgets** on admission and settlement (`decision-models.ts` `settle` :160-192, admission inside `decide` :208-251).
- **Secret service** resolves keys at dispatch; never stored in config (`decision-models.ts:199-207`).
- **Metadata-only** invocation history; no state/answers/raw payloads (`packages/db/src/schema/decision_models.ts:19-45`).
- **Cost ledger** `usageKind = "decision"`, agentless allowed (`packages/db/src/schema/cost_events.ts:43`); direct Jev rate card `typesafe-jev-2026-10-12`, 4.2 cents per 1M input tokens (`decision-model-provider.ts:41-45`).
- **Fail closed**: no registered feature, no `purpose` gate, no `allowBackground` → no call.
- **Purposes** are the single taxonomy, shared with the connector (`packages/shared/src/typesafe.ts:70-129`); direct Jev purposes are company-level (`company_decision_models.purposes`).

Review-level note (repo AGENTS): decisions are a **run-log/operational** path and
a DB path, not Telemetry. This spec adds **no** first-party Telemetry events.

## 3. Layer 1 — Model, connection, pricing (shipped, keep)

Already implemented. No changes. For reference:

- Providers: `DECISION_MODELS` = openai | openrouter | typesafe (`packages/shared/src/decision-models.ts:5-11`).
- Direct Jev call: `runTypesafeDecision` maps boolean↔`noul`, choice↔choice, score↔score (`decision-model-provider.ts:49-104`).
- Purposes gate: `purpose_disabled` (`decision-models.ts:144-146`).
- `availabilityForRequest` memoizer: `decision-models.ts:156-159`.

## 4. Layer 2 — Feature registry (expand)

Today `defineDecisionFeature(id, { background, purpose })`
(`server/src/services/decision-models.ts:24-31`). Expand it to carry the full
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
- `plans.gate` — when a plan-document confirmation is resolved. Anchor the exact
  server call site in the feature PR (the confirmation path is not yet pinned).
- `inbox.garden` — the inbox archive-candidate scan.
- `guardrails.outbound` — immediately before outbound publication (Slack/email/
  chat/webhook). Find the single outbound choke point in the feature PR and route
  the hold through it; do not add per-transport hooks.
- `issues.dedupe` — in `issueService.create`, ahead of the title guard.
- `pr.mergeability` — the PR-gardening skill path (agent-side gate).

Rule: a background feature must never block a user action. Best-effort with a
short timeout, exactly like `suggestIssuePriority`. Durability (retry/outbox)
is explicitly out of scope v1 and named as a follow-up where a feature needs it.

## 6. Layer 4 — Human loop (connect decisions to the Decisions queue)

This is the missing link: Jev never appears in the left-menu **Decisions**.

Verified facts before choosing a design:

- The queue is fed by `attentionService` → `materializeSeededQueues`
  (`server/src/services/attention.ts:1928`) using `DECISION_QUEUE_SEEDS`
  (`server/src/services/decision-queues.ts:53-84`): keys `prs`, `plans`,
  `questions`. A queue created by materialization sets `seedRulesEnabled: true`
  (`decision-queues.ts:722`); the schema default is `false`
  (`packages/db/src/schema/decision_queues.ts:38`).
- `decision_queue_items.sourceKind` validates against `ATTENTION_SOURCE_KINDS`
  (`packages/shared/src/types/attention.ts:8-21`), which includes `"decision"`.
  But `"decision"` resolves to a row in the **`decisions`** table
  (`decision-queues.ts:218-224`), not to `decision_invocations`.
- A `decisions` row requires `originAgentId`, `originIssueId`, `originRunId`
  (NOT NULL, `packages/db/src/schema/decisions.ts:43-45`) and is created by an
  agent run (`server/src/routes/decisions.ts:42-63`; `decisionService.create`
  at `server/src/services/decisions.ts:253`).
- `decisionQueueService.addItem` requires a readable source
  (`requireSourceRead` → `canReadDecisionSource` → `sourceIssueId`,
  `decision-queues.ts:200-333`). An arbitrary id is rejected.

So escalation has exactly three valid shapes:

A. **Issue-scoped (primary; no new tables).** Create an `ask_user_questions`
   interaction on the issue. Pending ones are auto-collected into the `questions`
   queue by the `ask-user-questions` seed rule (`decision-queues.ts:74-83`).
   Works for every feature that has an issue: `issues.classify`, `issues.triage`,
   `issues.dedupe`, `plans.gate`, `qa.acceptance`, `pr.mergeability`.

B. **Option-with-effects (agent/run present).** When the escalation is "pick an
   option, then act", call `decisionService.create({...})` (it needs
   agent+run+issue), then `addItem({ companyId, key: "questions",
   sourceKind: "decision", sourceId: decision.id, ... })`. Valid because the
   `decisions` row now exists.

C. **No-issue / system (`guardrails.outbound`, `inbox.garden`).** There is no
   queue source for these today: `decisions` needs agent+issue+run and
   `issue_thread_interaction` needs an issue. v1 rule: these features escalate on
   their own surface (hold the message, report), not via the queue. Queueing them
   is a follow-up that needs a new attention source kind plus a migration; out of
   scope here.

Add a thin helper `escalateDecision(db, ctx, { invocationId, question, options })`
in `server/src/services/decision-features.ts`: shape A when an issue exists,
shape B when a run exists and the options carry effects, else C. It writes an
activity-log entry and copies only metadata (feature id, question, option labels,
invocation id) — never the state or the provider answer.

Result: a low-confidence `issues.triage` "escalate" verdict shows up under
**Decisions → Questions**, and the existing All / Questions / Plans filters
finally have content.

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
  (`decision-models.ts:156-159`).
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
- Decisions queue (`ui/src/pages/DecisionQueuePage.tsx`): no new renderer is
  required. Shape A items surface as `issue_thread_interaction` sources; shape B
  items surface from the `decisions` row (title/body). Verify the feature label is
  readable and that task/run links resolve.
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

- Escalation shapes A and B need **no new tables**: `company_decision_models.purposes`
  (migration `0338`) gates features; `decision_invocations.feature` stores the
  feature id; shape A reuses `issue_thread_interactions` (auto-seeded into the
  `questions` queue); shape B reuses `decisions` + `decision_queue_items`
  (`sourceKind: "decision"`).
- Escalation shape C (system, no issue/agent/run) needs a **new** attention
  source kind plus a migration (source that `sourceIssueId`/`canReadDecisionSource`
  can resolve). Explicitly deferred.
- Durable retry/outbox for background features: a separate later migration
  (`decision_requests`). Not in v1.

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

## 16. Spec verification against code (2026-10-13)

Every claim above was checked in the tree at commit `e79f3b472` (plus the spec
commit). Confirmed:

- Callers of `decisionModelService`: `routes/decision-models.ts:14`,
  `services/heartbeat.ts:5314` (`recoverInterrupted` only), and
  `services/decision-features.ts`. No other product caller.
- `defineDecisionFeature` is the only registry: `services/decision-models.ts:24-31`.
- Tables exist: `company_decision_models` + `decision_invocations`
  (`packages/db/src/schema/decision_models.ts`), `decision_queue_items` /
  `decision_queues` (`packages/db/src/schema/decision_queues.ts`), `decisions`
  (`packages/db/src/schema/decisions.ts`).
- Queue seeds `prs/plans/questions` and the `ask-user-questions` rule:
  `services/decision-queues.ts:53-84`; materialization sets `seedRulesEnabled: true`
  at `:722`.
- Left-menu page: `ui/src/App.tsx:447` → `WhatNeedsMe`; per-queue
  `ui/src/pages/DecisionQueuePage.tsx`.
- Costs → Decisions tab: `ui/src/pages/Costs.tsx:733`; history + label map:
  `ui/src/components/decision-models/DecisionHistory.tsx:9`.
- Bundled skills: `packages/skills-catalog/catalog/bundled/paperclip-operations/{issue-triage,task-planning}/SKILL.md`,
  `.../quality/qa-acceptance/SKILL.md` (each names `typesafe_ask` + a `purpose`).
- Prompt injection point: `server/src/services/heartbeat/task-markdown.ts:7`
  (`buildPaperclipTaskMarkdown`).
- `issues.classify` hook: `server/src/services/issues.ts:8`, `:9971`, `:10420`,
  `:10489-10492`.
- Rate card and accounting: `services/decision-model-provider.ts:41-45`,
  `services/decision-models.ts` settlement :160-192, admission :208-251;
  `usageKind = "decision"` check at `packages/db/src/schema/cost_events.ts:43`.

Corrections made to this spec after verification:

1. `sourceKind: "decision"` in the queue points at the **`decisions`** table
   (agent+issue+run required), not at decision-model invocations. Section 6 was
   rewritten: escalation is issue-interaction-first, `decisionService.create` only
   when a run exists, and system-only escalations are explicitly deferred.
2. Stale `decision-models.ts` line references were corrected to the current
   `settle` :160-192, admission :208-251, secret :199-207, gate :144-146,
   memoizer :156-159.
3. `DECISION_MODELS` line number corrected to `:5-11`.
4. Call-site anchors that are not yet pinned (`plans.gate`, `guardrails.outbound`)
   are marked "anchor in the feature PR" instead of asserted.
