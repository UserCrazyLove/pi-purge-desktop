# Contributing

`pi-purge-desktop` ships a PI-Desktop plugin (id `local.pi-purge`) that puts a control panel over the `pi-purge` CLI
extension, plus that extension itself. Bug reports and small, focused pull requests are welcome.

## Reporting a bug

Open an issue with the bug report form and include:

- OS and version (Windows and Linux are supported; macOS is untested).
- PI-Desktop version, and the pi / `@earendil-works/pi-coding-agent` version.
- The panel mode (`strict`, `replace`, or `append`), whether the plugin was enabled, and which persona source you selected.
- A screenshot of the panel if the problem is visible there.
- The whole `status.json` from the plugin state directory: it is small and holds the resolved state paths and the last error.
- The matching lines of `%USERPROFILE%\.pi-desktop\logs\app\plugin.log` (`~/.pi-desktop/logs/app/plugin.log` on Linux).

**Redact first.** `status.json`, the panel and the log can contain your persona text and persona file path: replace prompt
content with `[...]` and strip tokens, keys and anything else you would not publish.

## Running the tests

Requires Node.js `>=22.19.0`. There are no npm dependencies: no install step, no lockfile, nothing to download; the four
suites are plain `.mjs` scripts.

```sh
npm test
```

Without npm, run the same commands in order - the chain stops at the first failure:

```sh
node test/pi-purge.test.mjs
node test/pi-purge-env-source.test.mjs
node pi-desktop-plugin/test/pi-purge.extension.test.mjs
node pi-desktop-plugin/test/panel-host.test.mjs
```

## Project layout

| Path | What it is |
| --- | --- |
| `package.json` | Root manifest (`name: pi-purge`, `type: module`); `npm test` chains the four suites |
| `extensions/pi-purge.ts` | pi CLI extension, TypeScript, loaded by the `pi` CLI |
| `test/*.mjs` | Two CLI test suites (prompt rewriting, env / `--source` handling) |
| `pi-desktop-plugin/manifest.json` | Plugin manifest: id `local.pi-purge`, version `0.2.4`, `main: main.cjs` |
| `pi-desktop-plugin/main.cjs` | Host entry point: panel backend, config, status, state-directory resolution |
| `pi-desktop-plugin/extensions/pi-purge.extension.mjs` | Agent sidecar extension: prompt rewrite and `/purge` |
| `pi-desktop-plugin/renderer/` | Panel UI (`index.html`, `panel.js`, `panel.css`) |
| `pi-desktop-plugin/persona/embedded.md` | Bundled persona, used when no user file is chosen |
| `pi-desktop-plugin/test/*.mjs` | Two plugin suites (extension, panel/host) |

## Hard constraints

A change that breaks any of these is not merged.

1. **The host entry point stays `main.cjs`.** The root `package.json` is `"type": "module"`, so a `.js` entry loads as
   ESM and crashes on `require`.
2. **Never write runtime state into `pi-desktop-plugin/`.** PI-Desktop watches a development plugin directory
   recursively, so a write there looks like a source edit: the host reloads the plugin and the reload writes state again.
   State goes to the host's per-plugin data directory (`<pi-desktop>/plugins/data/local.pi-purge/`), with
   `state-location.json` as the pointer override.
3. **Panel and extension resolve state in lockstep.** Same candidate list, same "first directory that accepts a write"
   probe. Touch one, change the other.
4. **No network access anywhere.** The plugin declares only two permissions, `agent.extension` and `ui.panel`.
5. **Tests isolate the home directory.** Every suite points `USERPROFILE`/`HOME` at a temp root and copies the plugin
   there; a test that touches the real `~/.pi-desktop/plugins/data/local.pi-purge/` is a bug.

## Commits and pull requests

- One concern per commit; the subject is an imperative sentence under ~72 characters.
- Explain the "why" in the body, and name the mode (`strict` / `replace` / `append`) or suite the change touches.
- Update `CHANGELOG.md` under `[Unreleased]` for user-visible changes.
- A PR is merged only after `npm test` passes on Windows and Linux (the CI matrix); say so if a PR is WIP.

## Licensing

MIT (see `LICENSE`). The mechanism is ported from [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) and
the CLI extension is a fork of [ZiChuanLan/pi-purge](https://github.com/ZiChuanLan/pi-purge), also MIT; keep those
notices intact and state the origin of anything you port.
