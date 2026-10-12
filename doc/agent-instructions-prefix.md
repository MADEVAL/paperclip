---
title: Agent Instructions Prefix
summary: Inject a company/instance-wide directive into every agent run
---

# Agent Instructions Prefix

The **Agent instructions prefix** is a company-wide directive prepended to
every agent run's task context. Configure it in **Company Settings -> Agent
instructions**:

- **Toggle "Caveman ULTRA output style"**: on and no custom text -> use the
  built-in `CAVEMAN_ULTRA_DIRECTIVE` from `@paperclipai/shared`. Off -> no
  injection.
- **Custom prefix**: when non-empty it always wins over the toggle.

It is the "always-on" seam: unlike a skill (which the model loads only on
demand), this text reaches every adapter — local, gateway, and the native
runner — on both fresh and resumed wakes. The directive is standalone; it does
not load or depend on the caveman skill.

`PAPERCLIP_AGENT_INSTRUCTIONS_PREFIX` is an operator fallback used only when the
company has neither a custom prefix nor the toggle enabled.

## Behavior

- Empty: no injection (default).
- Set: the trimmed value is prepended, followed by a blank line, ahead of the
  task brief. It is applied to every task-context variant, so it survives
  resume deltas and compact briefs.
- Source: stored on `companies.agent_instructions_prefix`, read in
  `server/src/services/heartbeat.ts` and consumed through the shared prompt
  selection (`selectPaperclipPromptSections`), so no adapter change is needed.

## Example

A house output style for every agent:

```
## House style
Respond terse. Keep every technical fact. Drop only fluff. Code, commands,
paths, and error strings stay verbatim.
```

## Cost note

The prefix is sent on every run, including resumed wakes, so keep it short.
A ~1 KB directive adds roughly 250 tokens to every model call in a run.
