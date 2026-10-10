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

## 2. Установка на свой сервер — ТОЛЬКО из ветки `personal`

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

## 3. Ежедневный цикл

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

## 4. Публикация в форк

```sh
git push --force-with-lease origin master   # зеркало; перезапись ожидаема
git push origin personal                    # твой слой
```

`--force-with-lease` безопаснее `--force`: не перезапишет, если кто-то (или
другая твоя машина) успел продвинуть `origin/master`.

## 5. Авто-разрешение конфликтов (rerere)

Включено один раз на машину:

```sh
git config rerere.enabled true
git config rerere.autoupdate true
```

`rerere` запоминает, как ты разрешил конфликт, и при следующих `rebase`
применяет это автоматически. Это и есть «автонакат»: первый раз разрешаешь
вручную — дальше происходит само.

## 6. Если возник конфликт при `git sync`

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

## 7. Откат

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

Пример: старый master до перестройки — тег `backup/master-pre-upstream-2026-10-10`.

## 8. Частые ситуации

- **`master` показывает `ahead/behind origin`** — это нормально, если ты обновил
  зеркало, но ещё не запушил. Отправь зеркало (раздел 4).
- **В `master` «пропали» мои правки** — их там и не должно быть. Они в `personal`
  (и в тегах/`feat/*`). Переключись: `git checkout personal`.
- **Никогда не коммить в `master`** — только `git merge --ff-only upstream/master`.
  Свой код — только в `personal`.
- **Установка/деплой — только из `personal`** (раздел 2). Из `master` ставится
  ванильный upstream без твоих правок.
- **Не редактировать upstream-доки** (`AGENTS.md`, `doc/DEVELOPING.md`,
  `CONTRIBUTING.md`, `.github/*`) без необходимости — это провоцирует конфликты
  при `git sync`. Личные заметки держи в `doc/local/`.
- **Windows / `core.autocrlf=true`**: тесты, которые хэшируют содержимое файлов
  (`sha256`) или сверяют `\n`, падают из-за CRLF в рабочем дереве. Это не ошибка
  merge: логический хэш git-blob (LF) совпадает с ожидаемым. POSIX-тесты с
  shebang-скриптами и Rust-сборка на Windows тоже недоступны (нет `link.exe`).

## 9. Быстрая проверка, что всё в порядке

```sh
git merge-base --is-ancestor master personal   # OK => master является базой personal
git log --oneline master..personal             # должен быть ровно твой слой
git rebase master                              # сразу после sync: "up to date"
```
