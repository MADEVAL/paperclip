# Direct TypeSafe/Jev Decision integration — implementation spec

Status: spec / implementation contract. Branch: `personal`.
Scope owner: company Decision models + the existing TypeSafe/Jev connector.
This document contains **no code**; it specifies changes. Every Paperclip
mechanism named below is grounded in the current tree with a file:line reference.

## 1. Goal

Make the **direct TypeSafe Jev API key** a first-class, usable, priced, and
switchable engine for Paperclip company Decisions:

1. A connection manager can paste a Jev API key and save a **shared** connection.
2. Jev cost appears in the cost ledger and in **Costs → Decisions**.
3. **Costs → Decisions** shows provider/model/tokens/cost for direct Jev.
4. At least one real Paperclip surface actually calls Jev (no dead feature).
5. Every intended use ("purpose") can be switched on/off with a toggle.

Non-goals (v1): replacing the agent's chat model with Jev (Jev is not a coding
model); per-purpose model overrides; retries/fallbacks; storing request/answer
content anywhere.

## 2. Verified current state

Three independent Jev paths exist:

| # | Path | Key | Caller | Priced |
| - | ---- | --- | ------ | ------ |
| A | Agent tool `typesafe_ask` (connector) | tool connection secret | agent runs / CLI / HTTP | **No** cost event (`doc/connections/TYPESAFE.md:211-213`, `server/src/services/connectors/typesafe.ts:224-241` logs activity only) |
| B | Direct Decision provider `typesafe` | shared AI connection secret | `settings.test` only | **Yes** (`server/src/services/decision-model-provider.ts:41-45`) |
| C | Jev via OpenRouter `typesafe/jev-1.13` | shared AI connection secret | `settings.test` only | **Yes** (provider-reported) |

B already works on the server and in tests:
- `DECISION_MODELS.typesafe` — `packages/shared/src/decision-models.ts:7-9`.
- `decisionProviderForConnection` maps `provider:"typesafe", method:"api_key", no routing` → `"typesafe"` — `packages/shared/src/decision-models.ts:75`.
- `runTypesafeDecision` maps boolean↔`noul`, choice↔`choice`, score↔`score` — `server/src/services/decision-model-provider.ts:49-104`.
- Rate card: 4.2 cents per 1M input tokens, version `typesafe-jev-2026-10-12` — `server/src/services/decision-model-provider.ts:41-45`.
- Tests: `server/src/__tests__/decision-model-provider.test.ts:72-108`.

Three concrete defects block real use:

### D1 (P0) — the key step is misrouted, so it renders OpenAI
`ui/src/components/ai-connections/AiConnectionCredentialStep.tsx:37-40`
```tsx
if (props.provider === "openrouter" || props.provider === "google" || props.provider === "deepseek") return <ApiKeyConnectionStep {...props} />;
return <SubscriptionConnectionStep {...props}>;   // typesafe lands here
```
`SubscriptionConnectionStep` forces `adapterType = "codex_local"` for any
non-`anthropic`/`xai` provider (`AiConnectionCredentialStep.tsx:92`), and
`AgentProviderConnection` then labels the whole step "OpenAI"
(`ui/src/components/new-agent/AgentProviderConnection.tsx:100-103`).
Result: selecting **TypeSafe (Jev direct)** shows an OpenAI/Codex sign-in UI.
Confirmed live from the running dev server bundle.

### D2 (P2) — decision choice icon mislabels TypeSafe as OpenRouter
`ui/src/components/decision-models/DecisionModelSettings.tsx:54`
```tsx
icon: <AppLogo name={row.provider === "openai" ? "OpenAI" : "OpenRouter"} brandKey={row.provider} size={24} />
```

### D3 (P1) — only **shared** connections are eligible, with no explanation
`server/src/services/decision-models.ts:60-66` keeps only `ownership === "shared"`;
`server/src/services/ai-connections.ts:426` rejects non-`organization` grants.
On the live instance the only OpenAI connection is a **personal** one, so
`choices` is empty (`GET /decision-model` → `{choices:[]}`) and the settings page
explains nothing.

Secondary: `ui/src/components/ai-connections/AiConnectionField.tsx:142` repeats the
D1 provider list; `ui/src/lib/utils.ts:127 providerDisplayName` omits `typesafe`;
`doc/decision-models.md:7` still claims only OpenAI + OpenRouter.

## 3. Paperclip invariants this spec must obey

Verified contracts, not invented:

- **Company scope.** Every decision row, cost event, and setting is company-scoped
  (`packages/db/src/schema/decision_models.ts:7`, `cost_events.ts:15`).
- **Accounting lock + budgets.** Admission and settlement run inside
  `withAccountingTransaction`; hard-stop budgets block dispatch
  (`server/src/services/decision-models.ts:188-231`).
- **Secret service.** The key is resolved through `secretService` right before
  admission with audit attribution; never stored in config
  (`server/src/services/decision-models.ts:180-187`).
- **Metadata-only history.** `decision_invocations` stores no state/answers/raw
  payloads (`packages/db/src/schema/decision_models.ts:19-45`).
- **Cost ledger.** `cost_events.usageKind` may be `decision` with a null agent
  (`cost_events.ts:43`); decision settlement writes `usageKind:"decision"`,
  `provider`, `biller`, `pricingProvenance` (`decision-models.ts:154-162`).
- **Availability is local-only** and never promises reachability
  (`server/src/services/decision-models.ts:131-139`, `doc/decision-models.md:33`).
- **Activity log for mutations** (`decision-models.ts:79-80`).
- **Purpose gating exists today only for the connector**, driven by
  `TYPESAFE_PURPOSES` (`packages/shared/src/typesafe.ts:70-129`) enforced in
  `server/src/services/connectors/typesafe.ts:143-147` (403 `typesafe_purpose_disabled`).

## 4. Design

### 4.1 Connection + provider + model (unchanged shape)

Direct Jev stays an **AI connection** (`connectionPurpose = "ai"`,
`config.ai = { provider:"typesafe", method:"api_key" }`) created from the
app-definition AI method `ai-api_key` (`packages/shared/src/app-definitions/typesafe.json:110-148`).
This already flows through `aiConnectionService.save`
(`server/src/services/ai-connections.ts:552-914`), `validateAiApiKey("typesafe", …)`
(`server/src/services/ai-api-key-test.ts:17`), and `selectDecision`
(`server/src/services/ai-connections.ts:417-449`). No new provider plumbing.

The decision model keeps a single connection + `DECISION_MODELS[provider].id`
model (`server/src/services/decision-models.ts:76-77`). No change.

### 4.2 Purposes = the switch surface

Reuse the existing canonical list `TYPESAFE_PURPOSES`
(`packages/shared/src/typesafe.ts:70-107`) as the single set of purpose IDs for
**both** the connector and the direct decision path. Add a company-level
enablement map, because a decision is a company background service, not an
agent tool, and the direct path has no tool connection to attach to.

```
purpose id          decision feature (background)   action
issue_triage        issues.triage                   choice verdict, low risk
task_planning       plans.gate                      noul + score
qa_acceptance       qa.acceptance                   noul fan-out
priority            issues.classify                 score → suggested priority
inbox_gardening     inbox.garden                    choice keep/archive/hold
guardrails          guardrails.outbound             noul hazard + score
```

Defaults: **all off** (fail-closed; no background spend until opted in). This is
deliberately stricter than the connector defaults, because decision features can
mutate company data.

### 4.3 Data model

Add one column to `companyDecisionModels`
(`packages/db/src/schema/decision_models.ts:6-17`):

```
purposes jsonb("purposes").$type<Record<string, boolean>>().notNull().default({})
```

Semantics: absent/false → purpose disabled. The company's configured connection
stays the same row; disabling a purpose never deletes the connection.

Migration: next `pnpm db:generate` produces `0338_*` (latest is
`0337_bent_roulette`, `packages/db/src/migrations/`). No other tables change.

### 4.4 Server enforcement

Extend `defineDecisionFeature` to accept a purpose
(`server/src/services/decision-models.ts:24-29`):

```ts
export function defineDecisionFeature(id: string, options: { background?: boolean; purpose?: TypesafePurpose } = {})
```

In `resolve` (`decision-models.ts:84-130`), after the provider check at
line 126, add: when the resolved provider is `typesafe`, the feature has a
`purpose`, and `config.purposes[purpose] !== true` → throw
`DecisionUnavailable("purpose_disabled")`. Non-typesafe providers are unaffected.

Add `"purpose_disabled"` to `DecisionUnavailableReason`
(`packages/shared/src/decision-models.ts:28`) and to `failureMessages` in
`ui/src/components/decision-models/DecisionModelSettings.tsx:13-23`.

New service method + route:
- `configurePurposes(companyId, userId, purposes)` — validates IDs against
  `TYPESAFE_PURPOSE_IDS`, updates the column, logs
  `decision_model.purposes_configured` (`decision-models.ts` pattern at :79-80).
- `GET /api/companies/:companyId/decision-model` already returns `settings`;
  include `purposes` and the canonical purpose catalog (id, label, description,
  enabled) so the UI renders switches from the server list.
- `PUT /api/companies/:companyId/decision-model/purposes` — connection-manager
  permission via `canManageAiConnections` (same guard as `routes/decision-models.ts:25`).

### 4.5 Real callers (first ship)

**F1 — `issues.classify` (background, purpose `priority`).**
- Register in `server/src/services/decision-features.ts` (new module) with
  `defineDecisionFeature("issues.classify", { background: true, purpose: "priority" })`.
- Call site: `server/src/services/issues.ts` inside `issueService(db)` (`:6711`),
  immediately after the create path (`:9911`) commits.
- State: `{ title, description, labels, project }` — no private content bound for.
- Questions: `priority` `score` over `["info","low","medium","high","urgent"]`;
  `blocking` `noul` "does this block other work?".
- Rule: act only when returned `confidence ≥ 0.7` **and** the issue's current
  priority is the default; set the suggested priority, never assign, never
  close. Otherwise no-op.
- Execution: best-effort after commit (availability check first, then decide),
  wrapped so a Jev failure never fails issue creation. Durable queuing is a
  follow-up.
- Fallback: existing behaviour (default priority).

Later features (same pattern, separate PRs): `plans.gate`, `qa.acceptance`,
`inbox.garden`, `guardrails.outbound`, `issues.triage`. Each requires a purpose
switch before it can spend.

### 4.6 Cost accounting

Already implemented for B (`decision-model-provider.ts:41-45`,
`decision-models.ts:154-162`). Required work is verification + provenance:

- Confirm the TypeSafe rate against the provider's pricing page; if it differs,
  update the card and bump the version string. Never substitute a chat-model rate
  (`doc/decision-models.md:47`).
- Keep `costStatus:"estimated"` with `pricingProvenance.version`
  (`typesafe-jev-2026-10-12`, `inputCentsPerMillion:"4.2000000"`).
- Keep unpriced/timeout as `unpriced` with the reservation held — never shown as
  free (`doc/decision-models.md:45`).
- Add a provider-contract test asserting the receipt for a fixed input-token
  count, alongside `decision-model-provider.test.ts`.
- Out of scope v1: giving the agent **connector** (path A) a cost event. It would
  need a new `usageKind` (the check at `cost_events.ts:43` allows only
  `decision`/`fast_response`/agent) and is a separate decision.

### 4.7 Costs → Decisions display

`ui/src/components/decision-models/DecisionHistory.tsx` already renders feature,
responsible, task, model, status, duration, tokens, cost (`:14-25`) and links
`/activity/costs?tab=decisions` (`DecisionModelSettings.tsx:48`; tab wired in
`ui/src/pages/Costs.tsx:733-740`). Required edits:

- Add a **feature label map** so `issues.classify` etc. read as product names
  instead of raw IDs (currently only `settings.test → "Setup test"`, `:16`).
- Show the **provider** for direct consumers: either a Provider column or
  `TypeSafe · jev-latest` in the model cell (provider is on the row as
  `DecisionHistoryEntry.provider`).
- Fix D2 so the choice/connection identity is TypeSafe, not OpenRouter
  (`DECISION_PROVIDER_LABELS` exists at `DecisionModelSettings.tsx:24`).

### 4.8 UI switches

In `DecisionModelSettingsView` (`ui/src/components/decision-models/DecisionModelSettings.tsx:25-88`),
under the connection block, render a "Where Paperclip may use Jev" list built from
the server-provided purpose catalog, reusing the control style already shipped in
`ui/src/features/connections/TypesafePurposes.tsx:52-105` (`ToggleSwitch`,
dirty/save, error banner). Show this list only when the selected connection's
provider is `typesafe` (path C via OpenRouter keeps its own behaviour).

## 5. Workstreams (ordered)

| W | Change | Files |
| - | ------ | ----- |
| W1 | Route `typesafe` to the API-key step; add regression test | `ui/src/components/ai-connections/AiConnectionCredentialStep.tsx:38`, `AiProviderSetup.test.tsx` |
| W2 | Fix D2 label + `providerDisplayName` | `DecisionModelSettings.tsx:54`, `ui/src/lib/utils.ts:127` |
| W3 | Purposes column + migration + service + route + UI switches | `packages/db/src/schema/decision_models.ts`, migration `0338`, `packages/shared/src/decision-models.ts`, `server/src/services/decision-models.ts`, `server/src/routes/decision-models.ts`, `DecisionModelSettings.tsx` |
| W4 | First real caller `issues.classify` + registry module | `server/src/services/decision-features.ts`, `server/src/services/issues.ts` |
| W5 | Cost verification + test; history feature labels/provider | `decision-model-provider.test.ts`, `DecisionHistory.tsx` |
| W6 | Docs: direct TypeSafe section | `doc/decision-models.md`, `doc/connections/TYPESAFE.md` |

## 6. Verification (real commands)

```sh
pnpm db:generate                     # emits 0338_*
pnpm -r typecheck
pnpm exec vitest run server/src/__tests__/decision-models.test.ts server/src/__tests__/decision-model-provider.test.ts
pnpm exec vitest run ui/src/components/ai-connections/AiProviderSetup.test.tsx
pnpm exec vitest run ui/src/pages/CompanySettingsRenameHint.test.tsx
```

Live acceptance (requires a shared TypeSafe connection and a running run/actor):
1. Company settings → Decision model → Add connection → **TypeSafe** must show a
   "TypeSafe API key" card (not OpenAI).
2. Save the JEV key as a **shared** connection; it appears in the choice list
   with a TypeSafe icon/label.
3. Enable decisions + turn on at least one purpose; **Run test** returns
   boolean/choice/score answers.
4. Costs → Decisions shows the invocation with provider TypeSafe, `jev-latest`,
   tokens and an estimated cost.
5. Toggle a purpose off → the matching feature's `availability` returns
   `{ available:false, reason:"purpose_disabled" }` and the feature no-ops.

## 7. Risks

- **Rate drift.** The 4.2¢/1M card must match TypeSafe pricing or costs mislead.
  Mitigation: versioned card + contract test + provenance in the ledger.
- **Background mutation.** `issues.classify` can set priority. Mitigation:
  default-off purpose, confidence gate, never touches assignment/status.
- **Two purpose surfaces.** The connector keeps per-connection purposes while the
  decision path uses company-level ones. Both use the same IDs; the UI must say
  which surface each switch controls.
- **Shared-only requirement.** Personal JEV keys still cannot back company
  decisions. Mitigation: explicit copy in the settings section.
- **Local-only availability.** `availability` never proves reachability; the
  first real call may still fail (`typesafe_api_key_rejected` etc.).
- **No durable queue for F1.** Best-effort inline execution can drop a
  classification on restart. Mitigation: documented follow-up; never blocks
  issue creation.

## 8. Open questions

1. Company-level purposes vs. reusing the AI connection's `config.methodConfig`
   (would require confirming the tool-connections PATCH path accepts AI-connection
   config edits — `server/src/routes/tool-access.ts:2141-2146`).
2. Should a personal Jev key be allowed for human-actor (non-background)
   decisions, or stay shared-only?
3. First release scope: ship only `issues.classify`, or `plans.gate` +
   `qa.acceptance` together?

## 9. Implementation status (this change)

Shipped on `personal`:

- W1 — `typesafe` routed to the API-key step; regression test
  `ui/src/components/ai-connections/AiConnectionCredentialStep.test.tsx`. **Done.**
- W2 — connection icon uses `providerDisplayName`; `typesafe` added. **Done.**
- W3 — `purposes` jsonb column (`0338_zippy_oracle.sql`), company-level gate
  (`purpose_disabled`), `configurePurposes`, `PUT .../purposes`, UI switches. **Done.**
- W4 — `server/src/services/decision-features.ts` with `issues.classify`
  (background, purpose `priority`), wired best-effort into `issueService.create`. **Done.**
- W5 — history feature labels + provider cell; rate-card/provider tests already
  covered by `decision-model-provider.test.ts`. **Done.**
- W6 — `doc/decision-models.md` and `doc/connections/TYPESAFE.md` updated. **Done.**

Deferred / not exercised here:

- DB-backed server suites (`decision-models.test.ts` gained a purpose-gate test)
  cannot run under a Windows administrator token: embedded Postgres refuses to
  start. They typecheck; run them on a Linux runner or WSL.
- `paperclip-runner` and `check:token-gates` fail on pre-existing drift/allowlist
  state unrelated to this change.
- Purpose toggles are company-level; the OpenRouter decision route keeps its own
  behaviour and ignores them.

