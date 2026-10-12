# Синхронизация форка с upstream (Paperclip)

Форк-локальная справка. Лежит на ветке `personal`. В upstream такого файла нет,
поэтому при синхронизации он ребейзится без конфликтов.

## 1. Модель репозитория

| Что | Где | Роль |
|---|---|---|
| `origin` | `https://github.com/MADEVAL/paperclip.git` | твой форк |
| `upstream` | `https://github.com/paperclipai/paperclip.git` | родительский репозиторий |
| `master` | локально | **чистое зеркало** `upstream/master`. Своих коммитов здесь быть не должно |
| `personal` | локально | `master` + **слой своих правок** (сейчас 4 сгруппированных коммита). Здесь ты работаешь, из неё ставится сервер |
| `backup/<что>-<дата>`, `deploy/<дата>` | теги | снимки для отката и деплоя. Создаются по необходимости, постоянных нет |

Схема:

```
upstream/master ──► master (только fast-forward, зеркало)
                        └─► personal (твой слой: 4 коммита по доработкам)
```

Почему так: свои правки собраны слоем поверх зеркала, поэтому обновление
upstream накатывается одной операцией `git rebase`, а не прогоняется через
десятки конфликтов.

2026-10-12: слой сгруппирован по доработкам вместо 18–21 мелких коммитов:

| Коммит `personal` | Что внутри |
|---|---|
| `feat(opencode)` | opencode-local V2, gateway-адаптер, runner-драйвер, регистрация в server/ui/cli, Dockerfile, доки адаптеров |
| `feat(deepseek)` | shared app-definition и каталог моделей, routing/defaults, server-сервисы, UI-подключения, миграция `0334` |
| `feat(company)` | company-wide префикс инструкций + caveman-ultra, миграции `0335`/`0336`, skills-catalog, `AGENTS.md` |
| `chore(local)` | `doc/local/*`, дополнение SPEC, переномеровка миграций `0334`–`0336` и регенерированные snapshot'ы, lockfile |

Так `git sync` проходит 4 «раунда» вместо 20: меньше конфликтов и читаемая
история. Все файлы миграций и их журнал лежат в `chore(local)`, поэтому каждый
коммит слоя согласован по нумерации миграций (`check:migrations` проходит на
любом из них); источник истины — вершина `personal`.

## 2. Раскладка веток и PR

Сейчас 7 локальных веток.

| Ветка | Роль | PR | Что содержит |
|---|---|---|---|
| `master` | зеркало `upstream/master` | — | ванильный upstream, ничего своего |
| `personal` | личный слой (4 коммита) | — | объединение всего; из неё ставится сервер |
| `feat/opencode-v2-support` | OpenCode V2 (direct adapter + runner) | **#15715** | adapter V2, runner `OpenCodeApiClient` V1/V2, config reload, MCP, projection, connections, pins/docs |
| `feat/deepseek-first-class-provider` | DeepSeek как first-class провайдер | **#15585** | shared/server/ui + миграция provider CHECK |
| `feat/opencode-gateway-canonical` | gateway `opencode_gateway` | — (PR позже) | HTTP/SSE adapter + wizard + registry + no-auth/free-model lists |
| `fix/windows-opencode-utf8` | форс UTF-8 в Windows-шеллах | **#15921** | плагин UTF-8 для PowerShell + env, тесты |
| `jev/typesafe-13713` | интеграция #13713 поверх upstream | — | запушена в origin как резервная копия; PR не открыт |

Рабочие каталоги (worktrees) — по одному на задачу:

```
D:/_DEV/_PAPERCLIP/paperclip            [master]
D:/_DEV/_PAPERCLIP/paperclip-personal   [personal]
D:/_DEV/_PAPERCLIP/paperclip-opencode   [feat/opencode-v2-support]        -> PR #15715
D:/_DEV/_PAPERCLIP/paperclip-pr15585    [feat/deepseek-first-class-provider] -> PR #15585
```

`feat/opencode-gateway-canonical`, `fix/windows-opencode-utf8` и
`jev/typesafe-13713` живут без отдельного worktree.

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

2026-10-11: визард создания агента для `opencode_gateway` получил полный набор
настроек (`fix(ui): show the OpenCode Gateway config schema in the create-agent
wizard`). Коммит лежит в `personal` и cherry-pick'нут в
`feat/opencode-gateway-canonical`.

2026-10-12: `git sync` на upstream `1b4c80381`; слой сжат до 4 коммитов; свои
миграции переномерованы (`0334`–`0336`), snapshot'ы перегенерированы. Теги
`backup/*` после проверки удалены (см. раздел 8). В тот же день все три
PR-ветки перебазированы на свежий `master` (PR #15715, #15585, #15921),
`feat/opencode-gateway-canonical` — на обновлённую V2-ветку, а `personal` —
на `origin` через `--force-with-lease`.

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

Ветка `personal` перебазируется при каждом `git sync` (и переписывается при
сжатии слоя), поэтому её SHA меняется. Для воспроизводимого/зафиксированного
деплоя помечай проверенный срез тегом и ставь по тегу, а не по «плавающей» ветке:

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

В раскладке с worktree каждая ветка уже развёрнута в своём каталоге, поэтому
`git checkout` между ветками не нужен (и не сработает: ветку нельзя чекаутить в
двух деревьях одновременно):

```sh
git fetch upstream
git -C D:/_DEV/_PAPERCLIP/paperclip          merge --ff-only upstream/master  # зеркало
git -C D:/_DEV/_PAPERCLIP/paperclip-personal rebase master                     # твой слой
```

Алиас для одной команды (переопредели, старый одно-деревьевый вариант здесь не
работает):

```sh
git config alias.sync '!git fetch upstream && git -C D:/_DEV/_PAPERCLIP/paperclip merge --ff-only upstream/master && git -C D:/_DEV/_PAPERCLIP/paperclip-personal rebase master'
```

## 5. Публикация в форк

```sh
git push --force-with-lease origin master    # зеркало; перезапись ожидаема
git push --force-with-lease origin personal  # слой; после rebase/сжатия это перезапись
```

Почему для `personal` тоже force: любой `rebase` (и тем более сжатие слоя)
переписывает историю, обычный push будет отбит как non-fast-forward.
`--force-with-lease` безопаснее `--force`: не перезапишет, если ветку успел
продвинуть кто-то другой (или другая твоя машина).

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

Оба репозитория могут создать миграцию с одним номером. Правило: номера
upstream фиксированы, **свою** миграцию переномеруй в первый свободный.
Актуально: upstream занимает по `0333`, свои — `0334`–`0336`.

Переименования **недостаточно**. `_journal.json` и `*_snapshot.json` помечены в
`packages/db/.gitattributes` как `-diff -merge`: их нельзя мёржить текстом, а при
переименовании snapshot сохраняет `id`/`prevId` предшественника. Тогда
`drizzle-kit generate` падает с коллизией («pointing to a parent snapshot»), а
последний snapshot теряет то, что upstream успел добавить в схему. Порядок:

```sh
pnpm --filter @paperclipai/db run check:migrations   # нумерация файлов и журнала
cd packages/db
pnpm exec tsc -p tsconfig.json                       # схема в dist/schema
pnpm exec drizzle-kit generate                       # ждём "No schema changes"
pnpm run prune:snapshots                             # оставить 5 последних snapshot'ов
```

Если `generate` ругается на коллизию: свяжи свой snapshot с предыдущим
(`prevId` = `id` предыдущего snapshot'а, у каждого свой уникальный `id`) и донеси
в свой последний snapshot то, что upstream добавил в схему. Имя файла миграции и
`tag` в `_journal.json` должны совпадать.

2026-10-12: свои `0332_little_dragon_lord`, `0333_regular_hedge_knight`,
`0334_spicy_zemo` стали `0334`, `0335`, `0336`. SQL не менялся, поэтому хэши
миграций совпадают с уже применёнными и на установленной БД они не переигрываются.

## 8. Откат

Постоянных тегов нет. Перед рискованной операцией (перестройка или сжатие
истории) поставь снимок сам:

```sh
git tag backup/<что>-<дата> personal
```

Вернуть `personal` к снимку:

```sh
git tag --list "backup/*"
git reset --hard backup/<что>-<дата>
git push --force-with-lease origin backup/<что>-<дата>:personal   # и на origin
```

Вернуть `origin/master` к прежнему состоянию:

```sh
git push --force origin <коммит>:master
```

Восстановить удалённую ветку:

```sh
git branch <имя> <коммит>                      # локально
git push origin <коммит>:refs/heads/<имя>      # обратно на origin
```

Снимки синка 2026-10-12 удалены после проверки (дерево совпадало байт-в-байт).
Пока объекты не собраны `gc`, прежние вершины достаются из reflog:

```sh
git reflog
git reset --hard 17b1e2d83   # personal до сжатия слоя (21 коммит)
git reset --hard 1f5b14ee1   # personal до синка (исходный слой)
```

Эти SHA локальны для машины, где делался sync; они же были в `origin/personal`
до перезаписи.

## 9. Частые ситуации

- **`master` показывает `ahead/behind origin`** — это нормально, если ты обновил
  зеркало, но ещё не запушил. Отправь зеркало (раздел 5).
- **В `master` «пропали» мои правки** — их там и не должно быть. Они в `personal`
  (4 сгруппированных коммита) и в рабочих `feat/*`. Смотри
  `git -C D:/_DEV/_PAPERCLIP/paperclip-personal log --oneline master..personal`.
- **Никогда не коммить в `master`** — только `git merge --ff-only upstream/master`.
  Свой код — только в `personal` или в рабочую `feat/*`.
- **Установка/деплой — только из `personal`** (раздел 3). Из `master` ставится
  ванильный upstream без твоих правок.
- **Push `personal` отбит как non-fast-forward** — значит был `rebase` или сжатие
  слоя. Пушь с `--force-with-lease` (раздел 5).
- **`AGENTS.md` несёт одну личную строку** — директиву `CAVEMAN ALWAYS ON`
  (caveman ultra, добавлена 2026-10-11). Это единственная намеренно изменённая
  upstream-дока. При `git sync` конфликт в `AGENTS.md` разрешай в пользу своей
  версии (строку сохрани), остальное бери из upstream.
- **`gh` не залогинен / нет авторизации** — токен достаётся из Windows Credential
  Manager, см. `doc/local/GITHUB-TOKEN.md`.
- **Прочие upstream-доки не редактировать** (`doc/DEVELOPING.md`,
  `CONTRIBUTING.md`, `.github/*`) без необходимости — это провоцирует конфликты
  при `git sync`. Личные заметки держи в `doc/local/`.
- **Windows / `core.autocrlf=true`**: тесты, которые хэшируют содержимое файлов
  (`sha256`) или сверяют `\n`, падают из-за CRLF в рабочем дереве. Это не ошибка
  merge: логический хэш git-blob (LF) совпадает с ожидаемым. POSIX-тесты с
  shebang-скриптами и Rust-сборка на Windows тоже недоступны (нет `link.exe`).
- **`pnpm -r typecheck` на Windows не доходит до конца** по той же причине:
  проверки `check:acpx-profiles` и `check:protocol-manifest` в
  `packages/paperclip-runner` хэшируют файлы и падают на CRLF — ровно так же на
  чистом upstream. Гоняй typecheck по пакетам:
  `pnpm --filter <имя пакета> run typecheck`.

## 10. Быстрая проверка, что всё в порядке

```sh
git merge-base --is-ancestor upstream/master master   # master = актуальное зеркало
git merge-base --is-ancestor master personal          # master является базой personal
git log --oneline master..personal                    # ровно твой слой: 4 коммита
git -C D:/_DEV/_PAPERCLIP/paperclip-personal rebase master   # сразу после sync: "up to date"
git branch -vv                                        # master, personal, 3 feat/*, fix/windows-opencode-utf8, jev/typesafe-13713
```
