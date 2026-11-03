# PI Purge（PI-Desktop 版）

[English](README.md) | [中文](README.zh-CN.md) | 日本語 · [CLI 拡張リファレンス](docs/cli.ja.md)

[![CI](https://github.com/UserCrazyLove/pi-purge-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/UserCrazyLove/pi-purge-desktop/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/UserCrazyLove/pi-purge-desktop?include_prereleases)](https://github.com/UserCrazyLove/pi-purge-desktop/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![PI-Desktop v0.21.0](https://img.shields.io/badge/PI--Desktop-v0.21.0-6d5efc.svg)](https://github.com/earendil-works)

pi セッションのシステムプロンプトをスイッチにし、しかも目に見える操作パネルにした PI-Desktop プラグインです。

エージェントは通常、pi のハーネスプロンプト（アシスタントのアイデンティティ行、同梱ドキュメント節、ツール一覧、ガイドライン、プロジェクトコンテキスト）を伴って動作します。このプラグインは、その枠組みを自分のペルソナ文で置き換え、**ハーネスをどこまで残すか**を選べるようにします。同梱の `/purge` CLI 拡張と同じ仕組みに、可視化パネル、設定の永続化、ターンごとの実測値を加えたものです。

オフのときは何も変わりません。プロンプトの書き換えもディスクの読み込みもなく、インストールしていない状態とまったく同じに動作します。

> **対応バージョン：PI-Desktop v0.21.0**（開発・検証環境）。下限は 0.15.9（プラグインデータディレクトリ API の導入版）で、それより古いホストでは両側ともプラグイン隣の `state/` に退避します。

## インストール

1. [Releases](https://github.com/UserCrazyLove/pi-purge-desktop/releases) から `local.pi-purge-<version>.piplug` をダウンロードし、PI-Desktop のプラグインページからインストールします。インストーラが `agent.extension` の承認を求めます。この権限が「送信されるシステムプロンプトの書き換え」そのものであり、本プラグインが高リスクと表示される理由です。
2. あるいは `pi-desktop-plugin/` を PI-Desktop のプラグインディレクトリに置き、ローカル（開発）プラグインとして読み込みます。ホストはそのディレクトリを再帰的に監視するため、プラグインは実行時状態をそこへ書きません。
3. コマンドパレット（`PI Purge: 打开控制面板`）かプラグイン一覧からパネルを開きます。

拡張自体は `contributes.agentExtensions` で自動的に読み込まれます。`pi install` も npm 依存も `node_modules` も不要です。

## 主な機能

- **操作パネル** — マスタースイッチ、モードカード3枚、ペルソナの取得元（同梱サンプル / ローカルファイルの絶対パス / `.md` をドラッグ＆ドロップ）、直近ターンの実測値。
- **3つの組み合わせモード** — `strict`（ペルソナ＋作業ディレクトリのみ）、`replace`（ペルソナ＋アイデンティティ行と同梱ドキュメント節を削ったハーネスプロンプト）、`append`（ペルソナを元のプロンプトの前に付加）。
- **設定はセッションをまたいで保持** — ホストのプラグインデータディレクトリ（`plugins/data/local.pi-purge/config.json`）に `enabled / mode / source` を書き込みます。削除すれば CLI 版の「セッションごとにオフ」の意味に戻ります。
- **ターンごとの実測値** — アイデンティティ節・ドキュメント節を削ったか、ホストプロンプトの文字数 → 実際に送信した文字数、そのターンの作業ディレクトリ。
- **コマンドは同等** — `/purge`、`/purge on|off|status`、`/purge mode …`、`/purge source …`、`/purge reload`（引数補完あり）。パネルとコマンドは同じ設定を書き、後から書いた側が有効になります。
- **失敗しても黙って無効化しない** — ペルソナが読めないときもスイッチはそのまま。そのターンは書き換えず、理由が `status.json` 経由でパネルに戻ります。壊れた `config.json` は報告され、決して上書きされません。
- **設計上ネットワークを使わない** — `net` 権限なし、通信コードなし、テレメトリなし、自動更新なし。ローカルの JSON 2ファイルがプロトコルのすべてです。

## コマンド・モード・状態の詳細

CLI 版の詳細（セッションスコープ、`PI_PURGE_SOURCE`、0.1.x からのアップグレード、実験上の注意点、モードごとの挙動）は [CLI 拡張リファレンス](docs/cli.ja.md) にまとめています。開発手順とテスト（`npm test`、4スイート）は英語版 [README](README.md#development) と [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

## クレジット

- **仕組み** — [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) からの移植です。ハーネスのアイデンティティ行を「圧す」のではなく**取り除く**という発想、3つの組み合わせモード、同梱プロンプトはいずれも同プロジェクトに由来します。
- **CLI 拡張** — [ZiChuanLan/pi-purge](https://github.com/ZiChuanLan/pi-purge)（MIT, © 2026 ZiChuanLan）のフォークです。`extensions/pi-purge.ts` と 2つの CLI テストスイートはそこから来ています。本リポジトリが追加したのは PI-Desktop ホスト、操作パネル、永続化される状態です。
- [LINUX DO](https://linux.do) コミュニティに感謝します。

## ライセンス

[MIT](LICENSE) — 非営利の学習・研究用途に限られ、[LEGAL.md](LEGAL.md) の制限に従います（日本語の利用制限は [CLI 拡張リファレンス](docs/cli.ja.md) 末尾にあります）。