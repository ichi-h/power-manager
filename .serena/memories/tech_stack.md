# tech_stack

- 実行環境: Node.js 24（`engines.node >= 24`）。Bun は不採用（docs/architecture.md 1.1）
- 言語: TypeScript 7（`strict`、`noUncheckedIndexedAccess`、`verbatimModuleSyntax`）
- フレームワーク: React Router 8 Framework Mode、SSR 有効（`react-router.config.ts` の `ssr: true`）
- ビルド: Vite 7（`@react-router/dev/vite`）+ `vite-tsconfig-paths`
- 画面: React 19、Tailwind CSS 4（`@tailwindcss/vite`）。共通トークンは `app/app.css` の `@theme` のみ
- 検証: Zod 4
- 認証: HTTP Basic + Argon2id（`argon2` パッケージ、ネイティブバインディング）
- テスト: Vitest 5 + `createRoutesStub` + Testing Library + jsdom（`@vitest/coverage-v8`）
- 配布: Nix flake（`buildNpmPackage`）+ NixOS モジュール
- パッケージ管理: npm（`package-lock.json` が `buildNpmPackage` の前提）
- CI: GitHub Actions（`.github/workflows/ci.yml`）— typecheck+test, coverage, build, smoke, x86_64/aarch64 の Nix ビルド
- フォーマッタ/リンタは依存に含めない（導入時は package.json と CI の両方を更新する）
