import type { Config } from "@react-router/dev/config";

/**
 * React Router のビルド設定。
 *
 * - SSR を有効にし、1 プロセスで画面とサーバー処理を提供する（NFR-09）。
 * - action の Origin 検証は実行時設定 `POWER_MANAGER_PUBLIC_ORIGIN` に依存するため、
 *   ビルド時の許可リストは空にし、`server/app.ts` でサーバービルドへ注入する（SEC-03）。
 */
export default {
  ssr: true,
  allowedActionOrigins: [],
} satisfies Config;
