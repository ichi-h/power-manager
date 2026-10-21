# core

## 概要
ホームラボのサーバーを Tailscale + Nginx 配下のブラウザから起動/停止/死活確認する個人用アプリ。単一 Node.js プロセス（React Router 8 Framework Mode、SSR）が画面とサーバー処理を提供する。

## ソースマップ
- `app/routes.ts` — ルート定義（index=dashboard, healthz, api/status, `*`=not-found）
- `app/routes/dashboard.tsx` — 一覧画面、行内進捗、グループ一括、予約表示
- `app/routes/api.status.tsx` — 状態ポーリング用リソースルート（`fetcher.load()` から叩く）
- `app/lib/model.ts` — ドメイン型の唯一の定義。値の集合は `as const` 配列を正とし型を導出
- `app/lib/config.server.ts` — 環境変数の zod スキーマ、`PublicRuntimeConfig`（秘密値を型で排除）
- `app/lib/runtime-config.server.ts` — 管理対象 JSON（version 2）の zod スキーマ
- `app/lib/config-store.server.ts` — 設定ストア（再読込時に原子的に差し替え）
- `app/lib/power.server.ts` — TCP 死活確認、WOL、SSH 停止、排他制御、スケジューラ関連
- `app/lib/history.server.ts` — 実行結果リングバッファ（上限 100 件、メモリのみ）
- `server/app.ts` — ServerBuild 読込み、load context 組立て、middleware/CSRF 差し替え
- `server/index.ts` / `server/startup.ts` — 待受と起動時 2 段検証
- `scripts/bundle-server.mjs` — esbuild で `server/index.js` を単一ファイル化（Nix 配備用）
- `nix/module.nix` / `package.nix` / `flake.nix` — NixOS モジュールと derivation
- `docs/` — requirements（WHAT/WHY）、architecture（HOW）、security、operations。要件 ID は `FR-*` / `NFR-*` / `SEC-*` / `CON-*`

## プロジェクト全体の不変条件
- 秘密値（`authPasswordHash`、SSH 鍵パス）は load context に載せない。型で到達不能にする（SEC-05）。
- プロセス共有シングルトン（死活確認器、リングバッファ、電源操作器）は `server/app.ts` のモジュールスコープで生成し、context 経由で loader/action に渡す。要求ごとに作らない。
- 設定はすべて runtime に外部から渡す（環境変数 + 設定 JSON）。本番挙動をコードに埋め込まない。
- 永続状態を持たない。再起動でリングバッファは空になることを許容。
- Origin 検証は自前 middleware（`SEC-03`）と React Router の `allowedActionOrigins`（`withAllowedActionOrigins` で実行時差し替え）の二段。
- ログは標準エラーへ 1 行 1 JSON。内部スタックトレースをログ/エラー応答に出さない。

## 関連メモリ
- 使用技術とバージョン: `mem:tech_stack`
- 実行コマンド: `mem:suggested_commands`
- 命名・記述規約: `mem:conventions`
- 完了条件: `mem:task_completion`
- サーバー側構成の詳細: `mem:server/core`
