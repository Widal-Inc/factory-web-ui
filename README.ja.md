# Widal Factory

ソフトウェアファクトリーを管理する Web アプリ。[Widal-Inc/factory-web-ui](https://github.com/Widal-Inc/factory-web-ui) で開発しています。

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

現在は React のブラウザークライアントと Bun のブリッジを提供し、herdr のワークスペース、エージェントの会話、確認カード、ファイル、ターミナルを扱います。ターミナルとエージェントの状態は herdr が管理します。Factory 専用ページ、共通サインイン、Setup は統合待ちです。このリポジトリだけで完成済みのホスト型サービスにはなりません。

## ソースから実行

Git、Bun 1.4 以降（CI は 1.4.2）、起動済みの herdr 0.9.0 以降が必要です。Linux/macOS のターミナル接続には Rust PTY ホスト、または代替の Node 18 以降を使います。どちらもなければ画面をミラーリングします。Windows はミラー表示です。[セットアップ](INSTALL.md)を参照してください。

```bash
git clone https://github.com/Widal-Inc/factory-web-ui.git
cd factory-web-ui
bun install --frozen-lockfile
```

1 つ目のターミナルで、継承した上流テレメトリーを無効にして実行します。

```bash
OVIS_TELEMETRY=0 OVIS_RUNTIME=herdr HOST=127.0.0.1 bun run server
```

別のターミナルで実行します。

```bash
bun run dev
```

`http://localhost:5173` を開きます。Vite は API と WebSocket をポート 7317 に転送します。QA では専用の herdr テストセッションを使ってください。ビルド済みクライアントを使う場合は `bun run build` の後に同じサーバーコマンドを実行し、`http://127.0.0.1:7317` を開きます。PowerShell の環境変数の設定方法は [INSTALL.md](INSTALL.md) にあります。

## 現在の範囲

対応エージェントの会話を読み、確認カードに回答し、ターミナルや選択中の PC のファイル・変更を確認できます。切断後も未送信の下書きは残り、送信には明示的な操作が必要です。[リモート PC](docs/remote-pcs.md) のランタイム配布は別途統合が必要です。

UI、アイコン、インストーラー、サービスコードは移行途中です。Widal 用のインストール URL、公開デモ、ネイティブ版ダウンロード、リリース経路はここでは提供していません。上流のインストーラー、アカウント、リレー、ペアリング、更新機能をこのフォークの導入に使わないでください。[配布状況](docs/app-updates.md)を参照してください。

実行例は `OVIS_TELEMETRY=0` で上流テレメトリーを無効にします。この文書は実装を削除せず、Widal の送信先も追加しません。「アカウント不要」「PC 外には何も送られない」「共通サインインが実装済み」とは解釈しないでください。[アクセスとデータ](docs/guide.md#access-and-safety)を確認してください。

## ドキュメントと貢献

- [ユーザーガイド](docs/guide.md)、[開発とチェック](docs/development.md)、[貢献方法](CONTRIBUTING.md)、[エージェント向け指示](AGENTS.md)
- [フォークの文書監査と互換性名](docs/fork-status.md)、[デザイン](DESIGN.md)、[過去の変更履歴](CHANGELOG.md)
- [バグ報告](https://github.com/Widal-Inc/factory-web-ui/issues)、[非公開のセキュリティ報告](SECURITY.md)

## 上流への謝辞

Widal Factory は [Ovis](https://github.com/devswha/ovis) のフォークです。上流の著作権、法的表示、作者の記録を保持します。既存のアートワークは継承したもので、この文書は新しい Widal ロゴを提供しません。

Built on [herdr](https://github.com/herdrdev/herdr), with inspiration from [chatmux](https://github.com/devswha/chatmux), and powered by [xterm.js](https://xtermjs.org), [React](https://react.dev), [Bun](https://bun.sh) and [Lucide](https://lucide.dev).

Thanks to everyone who has contributed, including [@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha), and to [@sanguneo](https://github.com/sanguneo), who helped design the icon and the website.

[MIT](LICENSE). Copyright © 2026 devswha. [Third-party notices](THIRD_PARTY_NOTICES.md).
