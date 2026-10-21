import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter(), tsconfigPaths()],
  server: {
    host: "127.0.0.1",
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
    /**
     * jsdom 環境で画面モジュールを読み込むための前処理。
     *
     * `react-router` の Vite プラグインが開発時用の React Refresh 前文を差し込むため、
     * これを設置しないと jsdom 上での画面モジュール読み込みが失敗する。
     */
    setupFiles: ["test/support/jsdom-setup.ts"],
    /**
     * カバレッジは `npm run coverage`（CI も同じ）で計測する。
     *
     * 閾値は網羅率そのものを目的にせず、低下の検出だけを狙って現状より少し下に置く。
     * `server/index.ts` と `server/static.ts`、画面コンポーネントは子プロセス起動を伴う
     * `npm run smoke` でしか通らないため、ユニットテストの網羅率には現れない。
     * 上回るために意味のない assert を書くより、検証したい振る舞いを優先する。
     */
    coverage: {
      provider: "v8",
      reporter: ["text"],
      include: ["app/**/*.{ts,tsx}", "server/**/*.ts"],
      exclude: ["app/**/*.d.ts"],
      thresholds: { statements: 60, branches: 65, functions: 60, lines: 60 },
    },
  },
});
