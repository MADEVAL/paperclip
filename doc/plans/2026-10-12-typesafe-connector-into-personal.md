# TypeSafe/Jev connector into the `personal` branch

Status: plan. The connector itself is finished and verified on
`jev/typesafe-13713`; this records how to bring it into `personal` later without
touching anything else.

## Goal

Land the direct TypeSafe/Jev connector from `jev/typesafe-13713` on top of
`personal` as an independent, self-contained addition. The existing OpenRouter
Decision models path stays exactly as it is; the connector does not replace or
reroute it.

## Current state

- `jev/typesafe-13713` is rebased onto upstream `master` (`1b4c80381`). It is 20
  TypeSafe-only commits on top of master with no merge commits. All TypeSafe
  tests pass and `server`, `ui`, `shared`, `db`, and `cli` typecheck.
- `personal` is also based on `master` (`1b4c80381`) and adds unrelated work:
  OpenCode V2 adapter, DeepSeek provider, company instructions prefix,
  caveman-ultra, local fork docs, and migrations `0334`–`0336`.
- The connector adds **no database migration**, so `personal`'s migration
  history is untouched.

## Recommended approach

Merge or cherry-pick the TypeSafe commits onto `personal` (a merge of
`jev/typesafe-13713` into `personal` is also fine, since both branches share the
same base and the connector is additive). Prefer the smallest history change:
either

1. `git checkout personal && git merge jev/typesafe-13713` and resolve the seven
   files below, or
2. cherry-pick the 20 commits in order and resolve the same files.

Do not rebase `personal`; its history is already pushed and unrelated to this
work.

## Expected conflicts

Only seven files are changed by both branches. The rest of the connector merges
cleanly.

| File | Both branches change | Resolution |
| --- | --- | --- |
| `packages/shared/src/app-definitions.generated.ts` | `personal` inserts `deepseek` mid-list (shifting `a96`+), `jev` appends `typesafe` as `a102` | Produce the union: `deepseek` inserted, `typesafe` appended (renumber after `deepseek`). Best done by regenerating with `pnpm connections:ingest-app-definitions`; otherwise merge by hand and rerun `packages/shared/src/app-definitions.test.ts`. |
| `packages/shared/src/app-definitions.test.ts` | `personal` and `jev` both change the `APP_STORE_DEFINITIONS` length assertion `79 → 80` | Use `81`; keep both the `deepseek` slug-list entry and the `typesafe` describe block. |
| `packages/shared/src/app-definitions.ts` | `personal` adds a connectable slug, `jev` adds `typesafe` | Union. |
| `packages/shared/src/index.ts` | Both add exports | Union (different export lines). |
| `scripts/ingest-app-definitions.mjs` | Both add catalog entries | Union (`deepseek` and `typesafe` are separate entries). |
| `server/src/routes/openapi.ts` | Both add path registrations | Union (different sections, different tags). |
| `ui/public/brands/apps/manifest.json` | Both add brand entries | Union; run `node scripts/check-app-brand-assets.mjs`. |

No other file overlaps. In particular `server/src/services/connector-runtime.ts`,
`server/src/services/tool-access.ts`, the connector/route/service files, the CLI
command, the skill, the storybook stories, and all TypeSafe tests are unique to
`jev` and merge cleanly.

## OpenRouter stays parallel

`personal`'s Decision models (`server/src/services/decision-model-provider.ts`,
`DECISION_MODELS.openrouter = "typesafe/jev-1.13"`) is untouched. The connector
adds a separate tool surface (`typesafe_ask`, CLI, HTTP) with its own connection,
secrets, installs, profiles, and audit. The two share only the printable name
"TypeSafe"; there is no shared table, slug, route, or provider identifier that
can collide. Adding a direct-Jev Decision models provider later would be a
separate, deliberate change and is out of scope here.

## Verification after merge

1. `pnpm connections:ingest-app-definitions` (or a hand-merge of the generated
   registry) then `pnpm exec vitest run packages/shared/src/app-definitions.test.ts packages/shared/src/typesafe.test.ts`.
2. `pnpm exec vitest run cli/src/__tests__/typesafe.test.ts ui/src/pages/apps/AppsConnect.test.tsx`.
3. DB-backed connector suites (they need a real Postgres; embedded Postgres
   refuses to run under a Windows administrator token, so use WSL Postgres or a
   Linux runner):
   `server/src/__tests__/typesafe-api.test.ts`,
   `typesafe-connection.test.ts`, `typesafe-routes.test.ts`,
   `typesafe-connector.integration.test.ts`.
4. `pnpm --filter @paperclipai/server typecheck`, `@paperclipai/ui`,
   `@paperclipai/shared`, `@paperclipai/db`, `paperclipai`.
5. `node scripts/check-app-brand-assets.mjs`.

## Risks

- The generated app registry is ordering-sensitive; a hand-merge that skips
  renumbering will pass a casual read but fail `app-definitions.test.ts`. Prefer
  regeneration.
- `personal`'s DeepSeek provider and the connector both add catalog entries; the
  `APP_STORE_DEFINITIONS` count and slug expectations must both be updated.
- No migration is added by the connector, so there is no schema risk.
