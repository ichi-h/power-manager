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
import { logRequestFailure } from "./log.ts";

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

/**
 * ServerBuild の `entry.module.handleError` を差し替える。
 *
 * React Router の既定のハンドラは `console.error(error)` でスタックトレースを複数行に
 * わたって出す。標準エラーへ 1 行 1 JSON を出す方針（`docs/architecture.md` 7.1）と、
 * 内部スタックをログへ出さない方針（`docs/security.md` 4.3）に反するため置き換える。
 *
 * `createRequestListener` は `handleError` を受け付けず、`build.entry.module.handleError`
 * しか見ないため、ビルドを浅くコピーして差し替える。
 */
export function withErrorHandler(build: ServerBuild): ServerBuild {
  return {
    ...build,
    entry: {
      ...build.entry,
      module: {
        ...build.entry.module,
        handleError: logRequestFailure,
      },
    },
  };
}

async function loadServerBuild(): Promise<ServerBuild> {
  return withErrorHandler((await import(serverBuildPath)) as ServerBuild);
}

export function createAppListener(runtime: RuntimeConfig) {
  return createRequestListener({
    build: loadServerBuild,
    // 明示しないと `develop` 扱いになり、開発用の挙動が残る（SEC-05）。
    mode: "production",
    getLoadContext: () => createLoadContext(runtime),
  });
}
