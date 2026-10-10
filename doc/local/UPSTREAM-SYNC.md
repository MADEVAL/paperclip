# Синхронизация форка с upstream (Paperclip)

Форк-локальная справка. Лежит на ветке `personal`. В upstream такого файла нет,
поэтому при синхронизации он ребейзится без конфликтов.

## 1. Модель репозитория

| Что | Где | Роль |
|---|---|---|
| `origin` | `https://github.com/MADEVAL/paperclip.git` | твой форк |
| `upstream` | `https://github.com/paperclipai/paperclip.git` | родительский репозиторий |
| `master` | локально | **чистое зеркало** `upstream/master`. Своих коммитов здесь быть не должно |
| `personal` | локально | `master` + **один коммит со всеми твоими правками** (слой). Здесь ты работаешь |
| `backup/*`, `personal-pre-restructure-*` | теги | неизменяемые снимки старых состояний для отката |

Схема:

```
upstream/master ──► master (только fast-forward, зеркало)
                        └─► personal (твой слой: все правки одним коммитом)
```

Почему так: свои правки собраны в один слой поверх зеркала, поэтому при
обновлении upstream они накатываются одной операцией `git rebase`, а не
прогоняются через десятки конфликтов.

## 2. Раскладка веток и PR

Всего 5 веток: `master`, `personal` и три рабочие (по одной на задачу).

| Ветка | Роль | PR | Что содержит |
|---|---|---|---|
| `master` | зеркало `upstream/master` | — | ванильный upstream, ничего своего |
| `personal` | личный слой (все правки одним коммитом) | — | объединение всего; из неё ставится сервер |
| `feat/opencode-v2-support` | OpenCode V2 (direct adapter + runner) | **#15715** | adapter V2, runner `OpenCodeApiClient` V1/V2, config reload, MCP, projection, connections, pins/docs |
| `feat/deepseek-first-class-provider` | DeepSeek как first-class провайдер | **#15585** | shared/server/ui + миграция provider CHECK |
| `feat/opencode-gateway-canonical` | gateway `opencode_gateway` | — (PR позже) | HTTP/SSE adapter + wizard + registry + no-auth/free-model lists |

Рабочие каталоги (worktrees) — по одному на задачу:

```
D:/_DEV/_PAPERCLIP/paperclip           [personal]
D:/_DEV/_PAPERCLIP/paperclip-opencode  [feat/opencode-v2-support]        -> PR #15715
D:/_DEV/_PAPERCLIP/paperclip-pr15585   [feat/deepseek-first-class-provider] -> PR #15585
```

Правила:
- **Одна задача — одна ветка.** Доработки идут коммитами в существующую ветку,
  новые имена (`-canonical`, `-support`, `-runner-driver`, `-adapter`) не плодятся.
- **Головы PR не переключать.** PR #15715 привязан к имени
  `feat/opencode-v2-support`, PR #15585 — к `feat/deepseek-first-class-provider`.
  Переименование или удаление этих веток закроет PR.
- **Gateway зависит от V2.** Ветка `feat/opencode-gateway-canonical` построена
  поверх V2-коммитов, поэтому её будущий PR будет включать и изменения V2, пока
  #15715 не влит. После мержа V2 сожми ветку до чистого gateway:
  ```sh
  git checkout feat/opencode-gateway-canonical
  git rebase master
  ```

Историю навели в порядок 2026-10-11: удалены дубликаты
`feat/opencode-v2-canonical`, `feat/opencode-v2-runner-driver` и
`feat/opencode-gateway-adapter` (последний был старым снимком всей интеграции).
Снимки сохранены в тегах `backup/*` (см. раздел 8).

## 3. Установка на свой сервер — ТОЛЬКО из ветки `personal`

Версию Paperclip со своими правками собирают и ставят **из ветки `personal`**.
`master` — это чистое зеркало `upstream`, свои изменения в нём отсутствуют;
установка из `master` даст ванильный Paperclip без правок.

Managed install прямо из форка:

```sh
npx --registry https://registry.npmjs.org paperclipai install \
  --repo MADEVAL/paperclip \
  --ref personal
```

Ветка `personal` перебазируется при каждом `git sync`, поэтому её SHA меняется.
Для воспроизводимого/зафиксированного деплоя помечай проверенный срез тегом и
ставь по тегу, а не по «плавающей» ветке:

```sh
# у себя в форке
git tag deploy/<дата> personal
git push origin deploy/<дата>

# на сервере
paperclipai install --repo MADEVAL/paperclip --ref deploy/<дата>
```

Docker — образ собирают из чекаута ветки `personal`:

```sh
git clone --branch personal https://github.com/MADEVAL/paperclip.git
cd paperclip
docker build -t paperclip-local .
```

Из исходников на сервере:

```sh
git clone --branch personal https://github.com/MADEVAL/paperclip.git
cd paperclip && pnpm install && pnpm build
```

Обновление версии: `git sync` у себя → новый тег `deploy/<дата>` → на сервере
`paperclipai install --repo MADEVAL/paperclip --ref deploy/<новая-дата>`.

## 4. Ежедневный цикл

Одна команда:

```sh
git sync
```

Она делает: `fetch upstream` → `master` fast-forward до свежего upstream →
`personal` rebase поверх обновлённого `master`.

Алиас уже настроен:

```sh
git config alias.sync '!git fetch upstream && git checkout master && git merge --ff-only upstream/master && git checkout personal && git rebase master'
```

Ручной эквивалент (если алиаса нет):

```sh
git fetch upstream
git checkout master && git merge --ff-only upstream/master
git checkout personal && git rebase master
```

## 5. Публикация в форк

```sh
git push --force-with-lease origin master   # зеркало; перезапись ожидаема
git push origin personal                    # твой слой
```

`--force-with-lease` безопаснее `--force`: не перезапишет, если кто-то (или
другая твоя машина) успел продвинуть `origin/master`.

## 6. Авто-разрешение конфликтов (rerere)

Включено один раз на машину:

```sh
git config rerere.enabled true
git config rerere.autoupdate true
```

`rerere` запоминает, как ты разрешил конфликт, и при следующих `rebase`
применяет это автоматически. Это и есть «автонакат»: первый раз разрешаешь
вручную — дальше происходит само.

## 7. Если возник конфликт при `git sync`

1. `git status` покажет конфликтные файлы.
2. Правь файлы, убирая маркеры `<<<<<<<` / `=======` / `>>>>>>>`.
3. `git add <файлы>` → `git rebase --continue`.
4. Не получилось / хочешь начать заново: `git rebase --abort`.

### Коллизия номеров миграций

Оба репозитория могут создать миграцию с одним номером (например `0323`).
Правило: номера upstream фиксированы, **свою** миграцию переномеруй в первый
свободный (например `0332`). Быстрый способ — перегенерировать из схемы:

```sh
cd packages/db
pnpm exec tsc -p tsconfig.json     # скомпилировать схему в dist/schema
pnpm exec drizzle-kit generate     # создаст новую миграцию + snapshot + запись в журнале
```

Затем при необходимости переименуй файл миграции и поправь `tag` в
`packages/db/src/migrations/meta/_journal.json` (имя файла и тег должны
совпадать), оставь в `meta/` 5 последних snapshot-файлов.

## 8. Откат

Посмотреть бэкапы:

```sh
git tag --list "backup/*"
```

Вернуть `personal` к прежнему состоянию:

```sh
git reset --hard <backup-тег>
```

Вернуть `origin/master` к прежнему состоянию:

```sh
git push --force origin <backup-тег>:master
```

Восстановить удалённую ветку:

```sh
git branch <имя> <backup-тег>          # локально
git push origin <backup-тег>:refs/heads/<имя>   # обратно на origin
```

Текущие важные теги:

| Тег | Что хранит |
|---|---|
| `backup/master-pre-upstream-2026-10-10` | `master`/`personal` до перестройки (все правки) |
| `personal-pre-restructure-2026-10-10` | то же (синоним) |
| `backup/v2-support-2026-10-10` | прежняя вершина V2-PR-ветки |
| `backup/v2-canonical-2026-10-11` | удалённая `feat/opencode-v2-canonical` |
| `backup/v2-runner-driver-2026-10-10` | удалённая `feat/opencode-v2-runner-driver` |
| `backup/gateway-canonical-2026-10-11` | `feat/opencode-gateway-canonical` |
| `backup/gateway-2026-10-10`, `backup/fork-master-2026-10-10` | старые снимки gateway/форка |
| `backup/deepseek-2026-10-10` | `feat/deepseek-first-class-provider` |
| `backup/refresh-lockfile-2026-10-11` | удалённая `chore/refresh-lockfile` |

## 9. Частые ситуации

- **`master` показывает `ahead/behind origin`** — это нормально, если ты обновил
  зеркало, но ещё не запушил. Отправь зеркало (раздел 5).
- **В `master` «пропали» мои правки** — их там и не должно быть. Они в `personal`
  и в трёх рабочих `feat/*`. Переключись: `git checkout personal`.
- **Никогда не коммить в `master`** — только `git merge --ff-only upstream/master`.
  Свой код — только в `personal` или в рабочую `feat/*`.
- **Установка/деплой — только из `personal`** (раздел 3). Из `master` ставится
  ванильный upstream без твоих правок.
- **Не редактировать upstream-доки** (`AGENTS.md`, `doc/DEVELOPING.md`,
  `CONTRIBUTING.md`, `.github/*`) без необходимости — это провоцирует конфликты
  при `git sync`. Личные заметки держи в `doc/local/`.
- **Windows / `core.autocrlf=true`**: тесты, которые хэшируют содержимое файлов
  (`sha256`) или сверяют `\n`, падают из-за CRLF в рабочем дереве. Это не ошибка
  merge: логический хэш git-blob (LF) совпадает с ожидаемым. POSIX-тесты с
  shebang-скриптами и Rust-сборка на Windows тоже недоступны (нет `link.exe`).

## 10. Быстрая проверка, что всё в порядке

```sh
git merge-base --is-ancestor master personal   # OK => master является базой personal
git log --oneline master..personal             # должен быть ровно твой слой
git rebase master                              # сразу после sync: "up to date"
git branch -vv                                 # ожидаемо: master, personal и 3 feat/*
```
