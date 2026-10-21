# server/core

## 起動経路
`server/index.ts` → `server/startup.ts`（検証）→ `server/app.ts`（listener 組立て）→ `server/static.ts`（配信）。

## 起動時 2 段検証（exit code 78）
1. 環境変数検証（`loadRuntimeConfig`, zod）。失敗は `ConfigurationError`。
2. 管理対象 JSON の読込みと全体検証。失敗は `ManagedConfigError`。
どちらも待受を開始せず終了コード 78（`configurationErrorExitCode`）で終了し、再起動ループに入らない（NFR-05, NFR-06）。

## ServerBuild の差し替え
- `withErrorHandler`: `build.entry.module.handleError` を `logRequestFailure` に置換（1 行 JSON、スタック非出力）。
- `withAllowedActionOrigins`: `allowedActionOrigins` を `runtime.publicOriginHost` で差し替え（ビルド時は空配列）。
- `createRequestListener` には `mode: "production"` を明示する（省略すると `develop` 扱いになる）。
- ServerBuild は `../build/server/index.js` を変数パス経由で動的 import（型解決対象外にするため）。

## load context（`createLoadContext`）
`configContext`, `configStoreContext`, `statusCheckerContext`, `historyContext`, `operatorContext`, `sshRuntimeContext` を載せる。秘密値は載せない。

## プロセス共有シングルトン
- `sharedStatusChecker` — TCP 死活確認（タイムアウト 5 秒、同時実行 8 固定）
- `sharedHistory` — リングバッファ上限 100
- `sharedOperator` — WOL/SSH 停止。`onRecord` でリングバッファとログへ記録

関連: 実行コマンドは `mem:suggested_commands`、完了条件は `mem:task_completion`。
