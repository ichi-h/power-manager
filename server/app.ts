/**
 * サーバービルドと load context の組み立て。
 *
 * 環境変数・設定 JSON の検証はここで完結させ、`server/index.ts` は待受だけを扱う。
 * 起動時検証の失敗は呼び出し側が終了コード 78 で終了する（NFR-05, NFR-06）。
 *
 * load context には検証済みの実行時設定を 1 度だけ載せ、loader/action からは
 * `context.get(configContext)` で参照する。要求ごとに環境変数を読み直さない。
 */
import { createRequestListener } from "@react-router/node";
import { RouterContextProvider, type ServerBuild } from "react-router";

import { configContext, type RuntimeConfig } from "../app/lib/config.server.ts";

export type { RuntimeConfig };

/**
 * loader/action へ渡す load context を組み立てる。
 */
export function createLoadContext(runtime: RuntimeConfig): RouterContextProvider {
  const context = new RouterContextProvider();
  context.set(configContext, runtime);
  return context;
}

/**
 * `react-router build` が生成する ServerBuild を読み込む。
 * 型解決の対象外にするため、パスは変数として渡す。
 */
const serverBuildPath = "../build/server/index.js";

async function loadServerBuild(): Promise<ServerBuild> {
  return (await import(serverBuildPath)) as ServerBuild;
}

export function createAppListener(runtime: RuntimeConfig) {
  return createRequestListener({
    build: loadServerBuild,
    getLoadContext: () => createLoadContext(runtime),
  });
}
