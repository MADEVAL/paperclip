---
name: task-planning
description: Write or revise a useful Paperclip plan with a clear outcome and verification. Use when a plan is requested or uncertainty needs resolving before execution.
key: paperclipai/bundled/paperclip-operations/task-planning
recommendedForRoles:
  - manager
  - engineer
  - product
tags:
  - paperclip
  - planning
  - issues
  - delegation
---

# Task planning

Plan only as much as the work needs. If execution is authorized and the next step
is small and clear, do it. A request for a plan alone does not require child tasks
or a new approval gate.

Describe the intended outcome, relevant constraints, chosen approach, and how to
verify success. Include uncertainties or decisions that affect execution. Use the
user's preferred format; keep implementation steps within one owner's task unless
another owner, useful parallel output, dependency, or independent review warrants
separate work.

Save a requested plan as the issue document with key `plan`. Update its current
revision instead of duplicating it, and link the saved document in your response.
Use the native document tools when available; legacy agents follow the `paperclip`
skill's document and planning API mechanics.

Respect planning mode and explicit approval requests. When approval is required,
request confirmation of the latest plan revision and wait for that decision.
After acceptance, execute cohesive work on the current ordinary task. Use
`paperclip-converting-plans-to-tasks` when delegation is justified.

## Calibrated plan review with TypeSafe (optional)

If a TypeSafe connection is assigned to you, the `typesafe` skill is present and
describes how to ask (`typesafe_ask` on native runners, or `paperclipai typesafe
ask` / the HTTP route elsewhere). Use it as a review gate before you accept or
request approval for a plan.

Ask every question about the plan in one call:

```json
{
  "state": { "goal": "<issue goal>", "plan": "<latest plan revision>" },
  "purpose": "task_planning",
  "questions": {
    "verifiable": {
      "type": "noul",
      "instructions": "Does the plan state a concrete outcome and how to verify it?"
    },
    "coverage": {
      "type": "score",
      "instructions": "How well does the plan cover outcome, constraints, approach and verification?",
      "criteria": ["Missing", "Partial", "Complete"]
    },
    "readiness": {
      "type": "choice",
      "instructions": "Is the plan ready to execute?",
      "criteria": {
        "ready": "Clear outcome, approach and verification",
        "needs-detail": "A named section is missing or vague",
        "blocked": "Depends on an unresolved decision or unknown"
      }
    }
  }
}
```

Rules:

- Accept or request approval only when `readiness = ready` with `confidence` at
  least `0.7` and `verifiable` at least `0.7`.
- Otherwise revise the plan naming the exact gap, then re-ask. Do not silently
  downgrade a `needs-detail`/`blocked` verdict.
- The plan text leaves the instance. Redact anything that must stay private
  before asking; if the call fails (`403`, `422`, `429`, `502`, `503`), proceed
  on your own judgement and say so.
