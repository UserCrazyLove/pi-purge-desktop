# pi-purge — CLI extension reference

[English](cli.md) | [中文](cli.zh-CN.md) | [日本語](cli.ja.md) · [Back to the front page](../README.md)


A [pi](https://github.com/earendil-works/pi-coding-agent) extension for system-prompt experiments: `/purge` switches which system prompt a session runs with — pi's stock prompt, a trimmed variant, or only a persona prompt.

It is meant for prompt engineering work: comparing how the same request behaves when the harness prompt is present, trimmed, or absent; regression-testing your own instructions; and studying instruction-following and prompt-injection robustness under controlled conditions.

With it off, nothing changes — no prompt rewrite, no disk reads. pi behaves exactly as if the extension were not installed.

> The PI-Desktop plugin ships this same mechanism behind a control panel. See the [front page](../README.md#install) for the plugin.

## Install

```bash
pi install git:github.com/ZiChuanLan/pi-purge@ffafeb9
pi install npm:pi-purge
```

Then, inside a session:

```text
/purge
```

That is all. A short example prompt ships inside the package, so a fresh install works with no extra files. To run your own instructions instead:

```text
/purge source C:/prompts/my-instructions.md
/purge mode replace
/purge on
```

`/purge source embedded` switches back to the bundled persona.

## Commands

| Command | Effect |
| --- | --- |
| `/purge` | Toggle on/off for this session |
| `/purge on` / `off` | Enable or disable the rewrite |
| `/purge status` | Mode, prompt source, loaded size, and what the previous turn actually changed |
| `/purge mode append\|replace\|strict` | Switch composition mode (default `strict`) |
| `/purge source <path\|embedded>` | Change the prompt file, or go back to the bundled example; a failed switch rolls back |

The CLI extension stops at `source`: `reload` and `help` exist only in the PI-Desktop plugin extension.

## Modes

| Mode | System prompt sent to the model | Use it when |
| --- | --- | --- |
| `append` | Your prompt prepended to pi's prompt, unchanged. | You want a control run: baseline behavior plus your instructions on top. |
| `replace` | Your prompt, then pi's prompt with its built-in assistant identity line and bundled documentation section removed. Tool list, guidelines, and project context stay. | You want to measure the effect of the harness framing without losing tool context. |
| `strict` | Your prompt plus `Current working directory: …` only. | You want to isolate your instructions as a single variable. This is the default. |

`replace` finds both sections by exact wording. If a pi update rewords them, it leaves the prompt intact rather than cutting the wrong text — `/purge status` then reports `身份段 未匹配` (identity line not found) and behavior falls back to `append`. `strict` does no matching at all, so it behaves the same across pi versions. On omp, which supplies a prompt block array without these pi-specific anchors, `replace` also leaves the host prompt intact; use `strict` when the harness framing must be gone.

Tool schemas are passed through the API `tools` parameter rather than the system prompt, so tools keep working in every mode, including `strict`.

## Session scope and defaults

- Scope is the session. Every `session_start` — startup, `new`, `resume`, `reload` — begins **disabled**. Quitting pi always returns to stock behavior.
- Nothing is written to disk: there is no state file, no cache, no marker. Two pi processes cannot affect each other.
- The default prompt is the short example bundled inside `extensions/pi-purge.ts`. `/purge source <path>` points at your own file; `/purge source embedded` comes back.
- To start every process with your own file without writing any state, set `PI_PURGE_SOURCE` to an absolute path:

    ```bash
    PI_PURGE_SOURCE=/home/me/persona.md pi          # macOS / Linux
    set PI_PURGE_SOURCE=C:/prompts/persona.md        # Windows cmd
    $env:PI_PURGE_SOURCE='C:/prompts/persona.md'     # Windows PowerShell
    ```

    It only supplies the initial value of `source`: `/purge on` is still required, `enabled` still begins `false` on every `session_start`, and `/purge source <path>` in a session overrides it. If the file is missing, `/purge on` reports the error instead of silently falling back to the bundled example.
- The bundled text is deliberately minimal. Published packages are scanned for abusive prompt content, so a full custom persona does not survive publishing; keep your own prompt on disk and reference it with `/purge source`.
- The default mode is `strict`.

## Upgrading from 0.1.x

0.2 no longer writes or reads `pi-purge.json`, and it no longer auto-detects a prompt file — the persona is bundled and the mode defaults to `strict`.

- Delete `<agent dir>/pi-purge.json`; it is ignored from now on.
- Enabling is per session: after a restart or `/resume`, run `/purge` again.
- `append` and `replace` are unchanged if you need them.

## Notes for experiments

- `strict` also drops `AGENTS.md` / project context, the skills list, and prompt text injected by other extensions. That is what makes it a clean single-variable setup, and also what makes results from `strict` not comparable to a normal session.
- `append` is the least invasive mode and usually the weakest signal: later sections of the harness prompt still carry a lot of weight, so differences can be small.
- `replace` still leaves harness text behind, and other extensions may append their own prompt sections after this one runs. In practice `strict` is the only mode where the persona is not competing with other framing.
- Extension load order affects what `before_agent_start` sees. Prefer recording `/purge status` output alongside any results you keep.

## Development

```bash
npm test   # four suites: the two CLI suites below plus two plugin suites under pi-desktop-plugin/test/; all run against temporary agent dirs and assert nothing is written
```

The extension registers one `before_agent_start` hook, one `session_start` hook, and a `/purge` command. No other hooks, no background work, no file writes.

## Credits

The mechanism here is ported from [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge): the idea of **removing** the harness identity line rather than drowning it out, the three composition modes, and the bundled prompt all come from that project. Credited and linked here as its author requires.
