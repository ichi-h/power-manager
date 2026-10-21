# Evidence

## §3.1 smoke 実行結果（チケット 4894）

実行コマンド: `npm run smoke`（`npm run build` 済みの成果物 `server/index.js` を本番同様に起動）

### 結果: `smoke: ok`（全項目合格）

- `{"event":"started"}` の起動ログが出力された
- 認証なしの GET / → **401**、`WWW-Authenticate: Basic realm="power-manager"` を確認
- **誤パスワードの GET / → 401**（Canary 追加、SEC-01）
- **Origin 不一致の POST / → 400/403 で拒否**（Canary 追加、SEC-03。多重防御の
  第 1 段である React Router 内蔵 `allowedActionOrigins` が 400 を返すため、
  400/403 のどちらでも成立とする）
- `/healthz` → **200**（`ok`、SEC-10 の認証免除）
- 正当な資格情報の GET / → **200**、HTML に `power-manager` と `サーバー一覧`
  を含み、エラー画面でない（root ミドルウェア結線・load context の確認）
- 起動 6 秒後も生存（誤った shutdown タイマーなし）
- SIGTERM → exit 0 で正常終了
- 不正な設定（`POWER_MANAGER_AUTH_USERNAME` 空）→ 待受なしで
  終了コード 78（`invalid_configuration`）、`started` ログなし

### 補足

- `npm run check`（typecheck + vitest 238 tests）も全合格。
