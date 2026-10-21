import type { Config } from "@react-router/dev/config";

/**
 * React Router のビルド設定。
 *
 * - SSR を有効にし、1 プロセスで画面とサーバー処理を提供する（NFR-09）。
 * - action の Origin 検証は実行時設定 `POWER_MANAGER_PUBLIC_ORIGIN` に依存する。この配列は
 *   ビルド成果物に埋め込まれ `createRequestListener` のオプションでは渡せないため、
 *   ビルド時は空にし、`server/app.ts` の `withAllowedActionOrigins` が読み込み時に
 *   `publicOriginHost` を差し込む（SEC-03）。
 */
export default {
  ssr: true,
  allowedActionOrigins: [],
} satisfies Config;
