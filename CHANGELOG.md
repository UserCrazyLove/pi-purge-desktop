# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Version numbers follow the root `package.json`. Dates are omitted on purpose: the plugin
version is the source of truth and releases are tagged as `v<version>`.

## [Unreleased]

Nothing yet.

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
  path in a text field and applied with the `使用这个文件` button, or dropped onto the panel.
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
