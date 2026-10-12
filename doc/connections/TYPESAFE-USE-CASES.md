# TypeSafe/Jev in Paperclip — capability audit and brainstorm

Status: analysis / proposal. Companion to [TYPESAFE.md](./TYPESAFE.md), which
documents the shipped connector. This document answers two questions:

1. Do we use everything Jev offers?
2. Where in Paperclip can we actually apply it?

Provider source: `https://docs.typesafe.ai` (`introduction`, `primitives`,
`confidence`, `api`, `models`, `patterns`, `agent-skill`), read 2026-10-12.

## 1. Capability audit

Jev is a System One evaluator: a `state` plus typed questions in, structured
answers out. There is no text generation, no tool calling, no file editing, and
no chat. "Use everything" therefore means every primitive, every field shape,
and every aggregation the model returns.

| Jev capability (docs) | Used by the connector | Where | Gap / note |
| --- | --- | --- | --- |
| `noul` (yes/no probability) | Yes | `typesafeAskSchema`, `typesafe-api.ts` | — |
| `choice` (option + distribution) | Yes | same | — |
| `score` (rubric, probability-weighted) | Yes | same | — |
| `probabilities` (per-option / per-level) | Yes | returned unchanged in `TypesafeAnswer` | Agents decide whether to use them. |
| `confidence` (choice/score) | Yes | returned unchanged | Skill explains confidence-gated use. |
| Several questions in one call (parallel fan-out) | Yes | `questions` map, `minProperties: 1`; tests ask three at once | Cheaper/faster than one call per question. |
| Structured `instructions` (`string \| object \| array`) | Yes | `structured` schema | — |
| `noul.criteria` (`{true,false}`, each string/object/array) | Yes | strict object | — |
| `choice.criteria` (1–255 options, `null` allowed) | Yes | record + range refine | — |
| `score.criteria` (2–10 ordered levels) | Yes | array min 2 max 10 | Provider accepts 1 level; Paperclip keeps the documented stricter minimum. |
| `state` as `string \| object \| array` | Yes | `structured` | — |
| Model alias, pinned version, per-call override | Yes | `extensionFields.model` default `jev-latest`; optional request `model` | Live-confirmed pinned `jev-1.13.0`. |
| Model listing | Yes | health/refresh `GET /v1/models` | — |
| Multiple connections + explicit pick | Yes | `connectionId`, `typesafe_connection_required` | — |
| Token usage | Yes | `typesafe.ask` activity row | — |
| Error taxonomy (401/400/422/429/529) | Yes | mapping table in `typesafe-api.ts` | — |
| SDK retry/backoff and `retry-after` | No, deliberately | Surfaces `retryable` + 429/503 | The caller decides; no silent spend or double work. |
| 64k / 32k context budgets | Provider-enforced only | — | **Gap:** Paperclip could fail fast with a clear 422 on oversized requests instead of forwarding to a provider 422. |
| Pricing (billed per input token) | Usage logged only | — | **Gap:** no cost event; needed only if decision spend must show in Costs. |
| Board-side try-it surface | No | Catalog is empty by design | **Gap:** operators can only test through an agent run. |

**Conclusion.** The request/response surface is fully used: every primitive, every
criteria shape, probabilities, confidence, fan-out, alias/pin and the error
taxonomy are exposed and validated. The real remaining gaps are the total-size
guard, optional cost accounting, and the lack of a board test surface.

## 2. Why it looks unused today

Two independent facts:

- The connector is a **tool**. It is reachable, governed and audited, but nothing
  *in the product* is written to call it. A tool with no caller looks unused.
- Paperclip's internal decision mechanism (`decisionModelService` +
  `defineDecisionFeature`) has exactly **one** registered feature, `settings.test`
  (the setup button), and it routes Jev through **OpenRouter** as
  `typesafe/jev-1.13`. No product feature calls `decide()` yet.

So the capability exists; the callers do not. The brainstorm below supplies the
callers.

## 3. Where Paperclip makes fuzzy judgments

These are real Paperclip surfaces that today use heuristics, an agent's own
judgement, or nothing. Each one is a place a calibrated Jev call fits.

| Surface | Decision made today | Jev fit |
| --- | --- | --- |
| Built-in `issue-triage` skill | Classify each issue into resume / wake / reassign / unblock / escalate / close | `choice` (6 options) |
| Issue priority | Defaults to `medium`; humans set it | `score` (severity rubric) |
| `task-planning` skill | Is a plan complete and actionable? | `noul` + `score` |
| `qa-acceptance` skill | Does the work meet acceptance criteria? | `score` + `noul` per criterion |
| `garden-inbox` runtime skill | Which inbox items are safe to archive | `choice` / `noul` |
| Incoming issue vs existing | Duplicate or new? | `noul` |
| `pr-gardening` / `prepare-paperclip-pr` | Is a PR merge-ready | `score` |
| `summarize-status` skill | What matters in a status roll-up | `score` per item |
| `diagnose-why-work-stopped` skill | How severe is a stall | `score` |
| Outbound Slack/email/chat text | Is it safe/on-policy to send | `noul` hazard + `score` severity |
| Skill selection for a turn | Which of N skills applies | `choice` (skill-suggestion pattern) |
| Company onboarding | What does this company want | `choice` + `score` |

## 4. Concrete applications

Each spec: where it attaches, the state sent, the questions, the decision rule,
what changes as a result, the wiring path, and the risk. None of these stores
task content in Paperclip; only usage and answers in memory.

### 4.1 Triage verdict (`issue-triage` skill)

- **Trigger:** a triage pass over `in_progress` / `in_review` / `blocked`.
- **State:** the compact `heartbeat-context` for the issue plus the triage
  heuristics text.
- **Questions:** `choice` verdict {resume, wake-needed, reassign,
  unblock, escalate, close} with one-line criteria each; `score` how stale the
  issue is; `noul` "is the current assignee the right specialty?".
- **Rule:** act only when `confidence ≥ 0.7` for the verdict; below that,
  escalate (create an `ask_user_questions`) instead of guessing. This turns the
  skill's "escalate rather than guess" line into an actual measured threshold.
- **Wiring:** the connector tool `typesafe_ask` when installed; heuristics
  otherwise. No server change.
- **Risk:** low. The skill already asks for one action per issue; Jev only
  sharpens the classification. Every call stays governed and audited.

### 4.2 Priority and severity (`score`)

- **Trigger:** on issue creation or first triage.
- **State:** title, body, labels, related issues.
- **Questions:** `score` severity on an ordered rubric
  {info, low, medium, high, urgent}; `noul` "does this block other work?".
- **Rule:** map the weighted score to the Paperclip priority band; suggest rather
  than overwrite when confidence is low.
- **Wiring:** the triage skill first (safe), then an internal decision feature for
  automatic suggestion.

### 4.3 Plan-completeness gate (`task-planning`)

- **Trigger:** before executing an accepted plan.
- **State:** the plan document plus the issue goal.
- **Questions:** `noul` "does the plan have verifiable acceptance criteria?";
  `score` coverage of goal / risks / tests; `choice` {ready, needs-detail,
  blocked}.
- **Rule:** proceed only when `choice = ready` and confidence ≥ threshold;
  otherwise reopen planning with the named gap. Faithful to the Decision models
  contract: "select your own thresholds".

### 4.4 Acceptance check (`qa-acceptance`)

- **State:** the issue's acceptance criteria plus the change summary/diff summary.
- **Questions:** one `noul` per criterion ("is `criteria[i]` met?") plus a `score`
  for overall confidence. This is the fan-out pattern: many atomic questions in
  one call, combined in code, rather than one broad question.

### 4.5 Inbox gardening (`garden-inbox`)

- **Trigger:** the archive-candidate scan.
- **Questions:** `choice` {keep, archive, needs-human} per candidate batch;
  `noul` "is this item already resolved?".
- **Rule:** archive only above a high confidence; everything else stays and is
  reported. The existing skill explicitly wants reversible, certain actions — a
  calibrated probability is exactly the right guard.

### 4.6 Duplicate detection

- **State:** the new issue plus the top-K similar existing issues.
- **Questions:** `choice` {duplicate, related, distinct} over the candidates plus
  `noul` "is `candidate[i]` the same work?".
- **Rule:** link as duplicate only when confidence is high; otherwise link as
  related. Prevents both duplicate trees and false merges.

### 4.7 Merge-readiness (`pr-gardening`, `prepare-paperclip-pr`)

- **State:** PR body, diff stat, check results, review state.
- **Questions:** `noul` "does the PR body fill every template section?";
  `score` merge-readiness on a rubric; `choice` {ready, needs-fixes, needs-human}.
- **Rule:** the same barriers the skills already enumerate, but measured, so the
  gardener can rank many PRs instead of reading each.

### 4.8 Outbound-message guardrails

- **State:** the exact text an agent is about to send externally.
- **Questions:** `noul` "does this leak credentials/private content?"; `score`
  policy risk; `choice` {send, redact, hold-for-human}.
- **Rule:** hold below a strict threshold. This is a classic guardrail and is
  cheap insurance on Slack/email/chat sends.

### 4.9 Skill selection

- **State:** the current turn/task summary plus the available skill names and
  descriptions.
- **Questions:** `choice` over skills; `noul` "is a specialized skill clearly
  better than the default?".
- **Rule:** use the pick only above a confidence threshold; otherwise keep the
  default. (The provider's own `skill_suggestion` cookbook is this pattern.)

### 4.10 Internal decision features (no agent involved)

Once a caller needs an automatic decision (issue create, routine start, watchdog
tick), the right home is `decisionModelService`:

- `defineDecisionFeature("issues.classify")` and similar, with `background: true`
  for system-initiated calls.
- It already enforces company scope, active-run identity for agent calls,
  responsible-user resolution, access checks, budgets, cost settlement, privacy
  (no state/answers stored) and history.

Today that path resolves an **AI connection** (`openai` or `openrouter`). To let
it call Jev **direct**, add a `typesafe` decision provider on the AI-connection
side (the same shape as `personal`'s first-class DeepSeek provider), or keep the
OpenRouter route for internal decisions and use this connector for agent-side
decisions. The two are independent by design.

## 5. Roadmap

1. **Phase 1 — done.** The built-in `issue-triage` skill uses `typesafe_ask`
   (one choice + noul + score request) with a `0.7` confidence gate, an
   escalate-instead-of-guess rule and a heuristic fallback.
2. **Phase 2 — done.** The same optional gate ships in `task-planning` and
   `qa-acceptance` (atomic fan-out over acceptance criteria).
3. **Purpose toggles — done.** A canonical list of named Jev purposes with
   switches, on the connection Permissions page and in Company Settings. A
   disabled purpose is refused server-side (403 `typesafe_purpose_disabled`) and
   is no longer advertised to agents.
4. **Phase 3 — next, larger.** A first-class `typesafe` **AI provider** so the
   internal Decision models feature can call Jev direct, plus the first
   background feature (`issues.classify`) that suggests a priority/route on
   issue creation. This touches the whole AI-provider registry, routing,
   provider defaults, secret handling, the decision-provider branch and the
   provider setup UI — the same size as the DeepSeek first-class provider. A
   leaner alternative is a small governed service that calls this connector's
   API from a background feature, reusing the purpose gate instead of an AI
   connection; decide before implementing.

Optional hardening alongside Phase 1: a client-side request-size guard (fail fast
under the 64k/32k budgets), and a cost event for decision spend if Costs should
show Jev usage.

## 6. Governance, privacy, cost, limits

- Every agent call is company-scoped, install-gated, health-gated, tool-policy
  gated, audited, and requires a running owned run on the HTTP path. Removing the
  install stops an in-flight caller.
- The `state`, instructions and criteria are sent to TypeSafe. This is surfaced
  in setup and is the reason access is opt-in. Keep proprietary content out of
  the `state` where policy requires it; Jev is not trained on customer data, and
  enterprise ZDR is a provider-side contract.
- Token usage is recorded per call. Cost is billed per input token; add a ledger
  entry only where spend must be accountable.
- Rate limits are dynamic; 429/529 are surfaced as retryable and never auto-
  retried by Paperclip. Fan-out into one call where possible to cut request count.
