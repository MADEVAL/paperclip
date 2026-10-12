# TypeSafe connection

TypeSafe's Jev model answers typed questions about a `state`: yes/no (`noul`),
multiple choice (`choice`) and rubric scoring (`score`). Each answer carries a
probability or a confidence. Jev does not write text, call tools or edit files,
so it is a tool that agents call, not an agent adapter.

Provider facts come from `https://docs.typesafe.ai` (`api.md`, `models.md`),
read and live-confirmed on 2026-10-12 against `https://api.typesafe.ai/v1`.

## Connection shape

| Axis | Value |
| --- | --- |
| Transport | `rest_api` |
| Authentication | `api_key`, sent as `Authorization: Bearer <key>` |
| OAuth client ownership | Not applicable |
| Credential source | `paperclip_vault` |
| Grant identity | `organization` |
| Risk tier | S2 |

Setup asks for one secret, the API key. The model is an advanced field that
defaults to `jev-latest`. A pinned version such as `jev-1.13.0` is valid.

TypeSafe publishes no hosted MCP server, so the connected MCP gateway cannot
reach it. The connection is a connector contribution instead (see
"Connector-provided skills and tools" in
[CONNECTOR-PLAYBOOK.md](./CONNECTOR-PLAYBOOK.md)): a bundled skill and one
native tool, `typesafe_ask`. The catalog for this connection is always empty.
The connection is identified by `config.sourceTemplateKey === "typesafe"`.

## Health

Health and catalog refresh resolve the vaulted key and call `GET /v1/models`.
This proves the key. It does not prove the model: the list holds aliases only,
and TypeSafe accepts versioned IDs that the list omits. A wrong model name
surfaces as 422 `typesafe_invalid_request` on the first question. The provider
answers 400 for an unknown model, which its error table does not list.

| Provider result | Health code | HTTP |
| --- | --- | --- |
| 401 or 403 | `typesafe_api_key_rejected` | 422 |
| Any other failure | `typesafe_request_failed` | 502 |

A failed first health check rolls the draft connection and its secret back.

## Who can use it

An agent can ask TypeSafe when all of these are true. Every call checks them
again, so removing access stops a run that is already in progress.

- The connection belongs to the agent's company.
- The connection is `active` and enabled, and its health is "ok". This is the
  same health gate the tool gateway applies to its catalog.
- A `tool_connection_installs` row targets the company or that agent.
- Tool governance allows the call. `typesafe_ask` asks
  `toolAccessPolicyService` for a decision as tool `typesafe.ask`, risk level
  `read`, before it resolves the key. Block policies, ask-first policies,
  approval rules and rate limits all apply, and each decision is audited. The
  audit row holds the model and the question count, never the state or the
  questions.
- On the HTTP route, the `X-Paperclip-Run-Id` header names a run that is
  `running` and belongs to the calling agent. An agent key alone is refused.
  The native runner supplies its own bound run.

The setup finish step writes those installs from the access choice ("all
agents" or selected agents). The generic API-key path creates none by itself.
The same step adds one `connection` entry to the connection's access profile,
because this connection has no catalog actions to include. Without that entry
governance denies every call by default.
`PUT /api/tool-connections/{connectionId}/installs` changes them later.

## Asking

| Surface | Form |
| --- | --- |
| Native runner | tool `typesafe_ask` |
| CLI | `paperclipai typesafe ask --file <request.json>` |
| HTTP | `POST /api/companies/{companyId}/typesafe/ask` (agent key, `X-Paperclip-Run-Id`) |

The request is `state`, `questions`, optional `model` and optional
`connectionId`. `connectionId` is required only when more than one TypeSafe
connection is assigned. Paperclip validates the request before it leaves the
instance: question types, 1 to 255 choice options, 2 to 10 score levels. The
full contract is in `skills/typesafe/SKILL.md`.

| Provider status | Response | Code |
| --- | --- | --- |
| 400 or 422 | 422 | `typesafe_invalid_request` |
| 429 | 429 | `typesafe_rate_limited`, `retryable: true` |
| 529 | 503 | `typesafe_overloaded`, `retryable: true` |
| 401 or 403 | 502 | `typesafe_api_key_rejected` |
| A body Paperclip cannot read | 502 | `typesafe_invalid_response` |
| Timeout or network failure | 503 | `typesafe_unreachable`, `retryable: true` |
| Any other failure | 502 | `typesafe_request_failed` |

One table in `server/src/services/typesafe-api.ts` holds these mappings. A
rejected key is 502 here, not 422, because the agent's request was valid; the
connection needs attention. Paperclip does not retry and does not substitute another model. The caller
decides whether to retry.

## Data handling

- The `state` and the questions are sent to TypeSafe. The key step of setup
  tells the operator this, under the key field. The text comes from the
  field's `helperMd`, because provider copy stays out of the shared access step.
- The API key stays in the vault. It is never placed in connection config, the
  skill, tool results, errors or logs. Provider error bodies are discarded
  because they can echo the submitted state.
- Each successful call writes one `typesafe.ask` activity row with the requested
  model, the question count and token usage. It never holds the state, the
  instructions, the criteria or the answers.
- The activity redactor treats dotted strings as possible tokens, so a pinned
  model such as `jev-1.13.0` shows as redacted in that row. Aliases show as
  written.

## Smoke checklist

1. Connect TypeSafe with a valid key. Health is "ok". The catalog is empty.
2. Finish setup with all agents. One company install exists.
3. Ask one `noul` question with an agent key. The answer returns with usage.
4. Confirm the `typesafe.ask` activity row and that it holds no task content.
5. Remove the install. The same call returns 403.
6. Connect with an invalid key. Setup fails with 422 and leaves no connection.

## Live proof

Run on 2026-10-12 against `https://api.typesafe.ai/v1` with an operator key,
through the real service code (`toolAccessService` connect/finish and
`executeTypesafeAsk`) and an embedded database. Only the key was external. No
key, state or answer text is recorded here.

| Step | Result |
| --- | --- |
| `GET /v1/models` | 200. Lists `jev-latest` and `jev-preview` only. The response also carries `description` and `release_date` per entry. |
| Connect with an invalid key | Provider 401. Paperclip setup fails with 422 `typesafe_api_key_rejected`. No connection and no secret remain. |
| Connect with a valid key | Health "ok", "TypeSafe API key is connected.", empty catalog. |
| Finish with all agents | One company install row exists. |
| Ask 3 questions (`noul`, `choice`, `score`) through the governed service path | 200. Provider model `jev-1.13.0`. Each answer parses to its own type; `choice` and `score` carry `confidence`. Usage 382 input and 73 output tokens (counts vary per run). |
| Ask with the pinned model `jev-1.13.0` | 200. The alias list omits this ID and the provider still accepts it. |
| Ask with an unknown model | Provider 400. Paperclip returns 422 `typesafe_invalid_request`. |
| Activity rows | Model, question count and token usage only; no state, instructions, criteria or answers. |
| Remove the install, then ask | 403. |
| A `score` with one level, sent directly to the provider | 200 (`score` 0, `confidence` 1). The documented minimum is two, so Paperclip keeps that stricter minimum. |

Not covered by this run: the setup screens against the real provider in a
browser, and the 429 and 529 paths, which the provider did not produce. The
setup screens are covered by `AppsConnect.test.tsx` and by the interactive
stories in `ui/storybook/stories/typesafe-connect-flow.stories.tsx`; the 429 and
529 mappings are covered by `server/src/__tests__/typesafe-api.test.ts` and the
connector integration suite.

## Where Paperclip can use Jev

Jev is an evaluator, not a chat model: it turns a `state` plus typed questions
into calibrated decisions. This connector therefore fits wherever a Paperclip
step needs a structured judgement that code can branch on. It does not replace
the model behind an agent, and it does not write text, call tools or edit files.

### Surfaces

| Surface | Who reaches it | Notes |
| --- | --- | --- |
| Native runner tool `typesafe_ask` | `paperclip_runner` agents | Advertised only while the connector skill is in the run's pinned bundle. |
| CLI `paperclipai typesafe ask --file <request.json>` | Any agent runtime with the CLI | The CLI forwards `PAPERCLIP_RUN_ID` as `X-Paperclip-Run-Id`. |
| HTTP `POST /api/companies/{companyId}/typesafe/ask` | Any agent runtime | Agent key plus `X-Paperclip-Run-Id`; a board user has no install to resolve. |

Every call re-checks the same gates: the connection belongs to the agent's
company, is active/enabled/healthy, has an install for the company or the agent,
tool policy allows `typesafe.ask`, and (on HTTP) the run is running and owned by
the calling agent. Removing the install stops an already-running call.

### Suitable tasks

These are the shapes Jev is built for (see the provider's primitives and
patterns pages). Each maps to real Paperclip work an agent can already do
through the surfaces above.

- **Route or classify (`choice`).** Pick the owning team, project, agent, or
  skill for a task; decide whether an issue needs a plan or a human; choose
  between named next steps. Confidence tells the agent whether to act or ask.
- **Score against a rubric (`score`).** Rate severity, priority, risk, effort,
  or the quality of a plan, PR description, or hand-off. Branch on the number
  and state the threshold.
- **Yes/no gates (`noul`).** Check preconditions before acting: does a task have
  acceptance criteria, is a change in scope, is a comment on-topic, is inbound
  content safe to process.
- **Rank or re-rank.** Score candidate issues, wakes, or retrieved passages and
  sort by the probability-weighted value.
- **Select an extracted value.** Given pre-parsed candidates, choose the right
  span or field and normalise it in code.

Because the tool is available to any agent in any task and any run, these are
reachable today through normal agent prompts and skills. No new Paperclip
feature is required to use them.

### What this connector does not wire up

- It is **not** connected to the internal **Decision models** feature
  (`server/src/services/decision-model-provider.ts`). That feature keeps routing
  Jev through OpenRouter (`typesafe/jev-1.13`) and is untouched. The two paths
  stay parallel and independent: an operator can keep OpenRouter for internal
  background decisions while agents use the direct TypeSafe connector, or use
  either alone.
- It exposes no **catalog actions**, so it has no per-action **Test** button and
  no board-side control surface. The catalog is always empty by design; a
  connection is proven by its health check and by an agent run.
- It records token **usage** in the `typesafe.ask` activity row but writes no
  **cost event**. Jev bills per input token; cost visibility would need a
  pricing snapshot like the Decision models ledger, which is out of scope here.

### Not this connector

The provider's own documentation is explicit that Jev is not a coding-agent
model and there is no `model: "jev-latest"` swap for an agent. Paperclip uses it
the same way: as a tool an agent calls for a decision, not as the agent's brain.

