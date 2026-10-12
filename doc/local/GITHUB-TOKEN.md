# GitHub CLI без `gh auth login` (токен из Credential Manager)

Форк-локальная заметка. Лежит на ветке `personal`, в upstream её нет.

VS Code хранит OAuth-токен GitHub в Windows Credential Manager. `gh` уважает
переменную окружения `GH_TOKEN`, поэтому отдельный `gh auth login` не нужен —
достаточно вытащить токен из хранилища в текущую сессию. **Работает всегда, даже
если `gh` ни разу не логинился.**

## Сниппет (PowerShell)

```powershell
$env:GH_TOKEN = (& {
    "protocol=https`nhost=github.com" | git credential-manager get 2>$null
) | Where-Object { $_ -match 'password=' } | ForEach-Object { $_ -replace 'password=', '' }
```

Одной строкой (то же самое):

```powershell
$env:GH_TOKEN = (& { "protocol=https`nhost=github.com" | git credential-manager get 2>$null } | ? { $_ -match 'password=' } | % { $_ -replace 'password=', '' })
```

## Проверка

```powershell
gh auth status
# ✓ Logged in to github.com account MADEVAL (GH_TOKEN)
# Token scopes: 'gist', 'repo', 'workflow'
```

Ожидаемая картина: источник `GH_TOKEN` (а не `gh auth login`), длина токена 40
символов, без CR/LF на конце, скоупы `gist`, `repo`, `workflow`. Если длина
больше (44+ с переводом строки) — добавь `.Trim()` к результату.

## Что теперь работает

```powershell
gh pr list -R paperclipai/paperclip --author MADEVAL --state open
gh pr view 15921 -R paperclipai/paperclip --json number,title,headRefName,mergeable
gh pr checks 15715 -R paperclipai/paperclip
gh api repos/paperclipai/paperclip/pulls/15585 --jq '.head.ref'
```

Альтернатива без `gh` (только чтение): публичный API
`https://api.github.com/search/issues?q=repo:paperclipai/paperclip+is:pr+is:open+author:MADEVAL`.

## Важно

- Токен живёт **только в текущей сессии** (`$env:GH_TOKEN`): в файлы не пишется,
  в коммит не попадает, с закрытием окна исчезает. Перезапустил шелл — нужно
  выполнить сниппет снова.
- Это тот же токен, которым `git` пушит в форк из Credential Manager (аккаунт
  `MADEVAL`). Не выводи его в чат и логи — `gh` сам маскирует (`gho_****`).
- Скоупы ограничены (`gist`, `repo`, `workflow`): хватает на PR, checks, review,
  push и repo-API. Для админ-операций (branch protection, secrets, org) нужен
  отдельный PAT.
- Если Credential Manager пуст (новая машина или другой пользователь Windows),
  сниппет вернёт пусто — сначала войди в GitHub из VS Code или `gh auth login`.
- В bash/zsh эквивалент:
  `export GH_TOKEN=$(git credential-manager get <<< $'protocol=https\nhost=github.com' | sed -n 's/^password=//p')`.
