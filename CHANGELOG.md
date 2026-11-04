# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Version numbers follow the root `package.json`. Dates are omitted on purpose: the plugin
version is the source of truth and releases are tagged as `v<version>`.

## [Unreleased]

### Added

- A **选择文件…** button next to the persona path field: it opens the system file
  dialog, resolves the chosen file to an absolute path through the panel preload and
  switches the persona immediately — no more typing paths by hand. Drag-and-drop and
  manual entry still work, and the same file can be picked twice in a row.
- **选择目录…** plus a file list under the persona path: pick a folder once and switch
  between the `.md` / `.markdown` / `.txt` files in it with a single click. The active
  persona is highlighted and marked 当前; the folder is remembered in `config.json`
  (`sourceDir`, a panel-only field the extension ignores) and listed again next time.
  Dropping a folder onto the panel does the same, and the host lists at most 200 entries
  per folder and says when it stopped.
- `purge.listDir` host channel: lists one directory level, refuses a file or a missing
  folder with a message instead of throwing, and marks the current persona. The panel keeps
  that list out of the 1.5 s poll, so the list survives every status refresh.
- Five more panel/host tests (18 now): the file picker wiring, the directory picker wiring,
  listing/sorting/filtering, a missing folder or a file instead of a folder, the remembered
  `sourceDir`, and the 200-entry cap.
- A partial write now persists the whole effective config instead of only the patched keys,
  so `config.json` never ends up as a fragment that reads like a broken file.

### Changed

- The 人设来源 card was laid out again: the two pickers share one row, the path field is a
  single line with an inline `应用` chip, the directory path and its `刷新` chip sit on the
  list header, and there is one hint line instead of two. Selecting 内嵌示例 now hides the
  whole file block instead of leaving an empty path field and an empty list on screen, and
  the preview header names the file (basename, full path in the tooltip) with its real size
  in B/KB instead of rounding a small persona to `0 KB`.

## [0.2.4]

First release of the PI-Desktop plugin in this repository. The plugin id is
`local.pi-purge`; the mechanism is ported from
[YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) and the CLI extension is
a fork of [ZiChuanLan/pi-purge](https://github.com/ZiChuanLan/pi-purge) (MIT).

### Added

- Control panel for a session's system prompt: an on/off switch, three mutually exclusive
  mode cards (`strict` drops the harness system prompt entirely, `replace` cuts the
  identity line and bundled docs, `append` prepends the persona) and a live status readout
  showing the resolved mode, state directory, prompt sizes and last error.
- Persona source picker: the bundled persona, or your own markdown file, given as an absolute
  path in a text field and applied with the `应用` chip, picked in the system file
  dialog with `选择文件…`, or dropped onto the panel.
- Configuration persisted in the host's per-plugin data directory
  (`<pi-desktop>/plugins/data/local.pi-purge/config.json`), so `enabled`, `mode` and
  `source` survive a restart. The extension re-reads it on `session_start` and before each
  turn.
- `/purge` command parity with the CLI extension: `on`, `off`, `status`, and mode selection
  behave the same inside the agent as they do on the command line.
- State directory fallback chain shared by the panel and the extension: the host's
  per-plugin data directory, then the plugin's own `state/` directory, then
  `<plugins root>/data/<id>`, each probed by an actual write.

### Changed

- The host entry point is `main.cjs`. The root `package.json` is `"type": "module"`, so a
  `.js` entry would load as ESM and fail.

### Fixed

- Persona loading errors are surfaced in the panel instead of silently disabling the
  plugin: an unreadable or empty persona file leaves the previous state intact and shows
  the reason.
- Configuration writes are atomic (temporary file plus rename, with a retry for the
  Windows replace race), so the extension never reads a half-written file.
- A corrupt `config.json` is refused rather than overwritten: the panel reports the parse
  error and keeps the file, instead of resetting the user's mode and persona to defaults.

### Compatibility

- Developed and tested against **PI-Desktop v0.21.0**, the release this plugin ships for.
  The declared floor is `engines.piDesktop: ">=0.15.9"`, the version that introduced the
  per-plugin data-directory API; on an older host the panel and the extension fall back
  together to a `state/` directory next to the plugin.
- CI runs the four suites on Node 22 on both Ubuntu and Windows; the plugin itself needs no
  dependencies and no `node_modules`.

## [0.2.x] (pi-purge CLI upstream)

The `extensions/pi-purge.ts` CLI extension is a fork of
[ZiChuanLan/pi-purge](https://github.com/ZiChuanLan/pi-purge), MIT, Copyright (c) 2026
ZiChuanLan. Its 0.2.x line covers `PI_PURGE_SOURCE` and `/purge source` for persona sources, and the
prompt-rewrite modes that this plugin's panel drives. Those
changes are recorded upstream, not in this file; the sections above list only what the
PI-Desktop plugin adds or changes on top.

[0.2.4]: https://github.com/UserCrazyLove/pi-purge-desktop/releases/tag/v0.2.4
