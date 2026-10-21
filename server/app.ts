/**
 * サーバービルドと load context の組み立て。
 *
 * 環境変数の検証は `server/startup.ts` で済ませ、ここは検証済みの設定を受け取るだけ。
 * `server/index.ts` は待受と終了コードを扱う。起動時検証の失敗は呼び出し側が終了コード
 * 78 で終了する（NFR-05, NFR-06）。
 *
 * load context には検証済みの実行時設定を 1 度だけ載せ、loader/action からは
 * `context.get(configContext)` で参照する。要求ごとに環境変数を読み直さない。
 */
import { createRequestListener } from "@react-router/node";
import { RouterContextProvider, type ServerBuild } from "react-router";

import {
  configContext,
  toPublicRuntimeConfig,
  type RuntimeConfig,
} from "../app/lib/config.server.ts";
import { logRequestFailure } from "./log.ts";

export type { RuntimeConfig };

/**
 * loader/action へ渡す load context を組み立てる。
 *
 * 載せるのは公開値だけである。`authPasswordHash` などの秘密値は load context に置かず、
 * 認証ミドルウェア（`t004`）が起動時の設定から直接読む。load context は全 loader/action
 * から到達できるため、型で到達不能にしておく（SEC-05）。
 */
export function createLoadContext(runtime: RuntimeConfig): RouterContextProvider {
  const context = new RouterContextProvider();
  context.set(configContext, toPublicRuntimeConfig(runtime));
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

/**
 * ビルド成果物の `allowedActionOrigins` を実行時の公開 Origin で差し替える。
 *
 * この配列はビルド時に埋め込まれ、`createRequestListener` のオプションでは渡せない。
 * 空配列のままでは、自前の Origin 検証を通った要求でも React Router の CSRF 検査で
 * 拒否される。照合対象は `Origin` ヘッダーの `host`（`Url.host`）なので、スキーム付きの
 * `publicOrigin` ではなく `publicOriginHost` を渡す。
 *
 * なお React Router 側の照合はワイルドカード（`*`）を解釈するため、`*` を含まない
 * ホストだけを受け付ける検証は `parsePublicOrigin` で済ませてある。
 */
export function withAllowedActionOrigins(build: ServerBuild, host: string): ServerBuild {
  return {
    ...build,
    allowedActionOrigins: [host],
  };
}

async function loadServerBuild(runtime: RuntimeConfig): Promise<ServerBuild> {
  const build = (await import(serverBuildPath)) as ServerBuild;
  return withErrorHandler(withAllowedActionOrigins(build, runtime.publicOriginHost));
}

export function createAppListener(runtime: RuntimeConfig) {
  return createRequestListener({
    build: () => loadServerBuild(runtime),
    // 明示しないと `develop` 扱いになり、開発用の挙動が残る（SEC-05）。
    mode: "production",
    getLoadContext: () => createLoadContext(runtime),
  });
}
