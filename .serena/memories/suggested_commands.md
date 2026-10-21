# suggested_commands

- `npm ci` — 依存インストール（lock 前提）
- `npm run dev` — Vite 開発サーバー。127.0.0.1:5173（`vite.config.ts` で host 固定）
- `npm run typecheck` — `react-router typegen && tsc --noEmit`
- `npm run test` — `vitest run`（`test/**/*.test.{ts,tsx}`）
- `npm run coverage` — カバレッジ。閾値 statements/functions/lines 60、branches 65
- `npm run check` — typecheck + test
- `npm run build` — `react-router build` 後に `scripts/bundle-server.mjs` で `server/index.js` を生成
- `npm run start` — `node ./server/index.js`（build 済みが前提）
- `npm run smoke` — build 済み成果物を起動して HTML 応答を確認（`scripts/smoke.mjs`）
- `nix build .#packages.x86_64-linux.default` — Nix パッケージ検証
- 開発用環境変数は `.envrc`（direnv + `use flake`）。秘密値は `.local/`、設定 JSON は `.local/servers.json`
- 起動に必要な環境変数は `POWER_MANAGER_CONFIG_PATH`, `_PORT`, `_PUBLIC_ORIGIN`, `_AUTH_USERNAME`, `_AUTH_PASSWORD_HASH`, `_SSH_IDENTITY_FILE`, `_SSH_KNOWN_HOSTS_FILE`
- ロケール警告（`LC_ALL: cannot change locale (ja_JP.UTF-8)`）がシェル出力に混ざるが無害
