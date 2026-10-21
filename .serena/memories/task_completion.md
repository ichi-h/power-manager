# task_completion

コーディング完了時は次を順に実行し、すべて通すこと。

1. `npm run check`（= `npm run typecheck` → `npm run test`）
2. カバレッジ低下が気になる場合: `npm run coverage`
3. `server/` やビルド設定・ルート構成を変えた場合: `npm run build` と `npm run smoke`
4. Nix 配備に関わる変更（`package.nix`, `nix/module.nix`, `flake.nix`, bundle 設定）: `nix build .#packages.x86_64-linux.default`

フォーマッタ/リンタは未導入のため、整形は手作業で既存スタイルに合わせる。
