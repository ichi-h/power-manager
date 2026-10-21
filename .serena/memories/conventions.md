# conventions

- コメント・ドキュメントは日本語（標準的な日本語、関西弁は使わない）。コメントには要件 ID（`FR-*` 等）や設計書の節番号を参照として添える。
- モジュール先頭に「何を担うか」「何を担わないか」を列挙するブロックコメントを置く。
- server-only モジュールは `*.server.ts` サフィックス。型だけの共有は `*-context.ts`（例: `status-checker-context.ts` は window を開かないように分離）。
- 相対 import は拡張子付き（`./model.ts`）。tsconfig は `allowImportingTsExtensions`。パスエイリアス `~/*` → `./app/*`。
- 値の集合（操作種別・曜日・状態など）は `as const` 配列を唯一の定義とし、型は `(typeof x)[number]` で導出する。配列と型を二重定義しない。
- 公開設定と秘密設定を別の型に分ける（`PublicRuntimeConfig` / `AuthConfig` / `SshConfig`）。
- React Router の loader/action は context から依存を取る（`context.get(xxxContext)`）。環境変数の再読込はしない。
- スタイルは Tailwind ユーティリティを JSX に直接書く。共通トークンのみ `app/app.css` の `@theme`。
- テストは `test/` 配下にフラット配置、共通ヘルパは `test/support/`（`jsdom-setup.ts`, `environment.ts`, `managed-config.ts`）。
- エラー分類のコード語彙は `powerOperationCodes`（`invalid_configuration`, `ssh_unavailable`, `operation_failed`, `busy`, `missed_schedule`）。
- 設計判断を変える場合は `docs/architecture.md` のみ更新し、`docs/requirements.md` の要件 ID は維持する（削除時は欠番）。
