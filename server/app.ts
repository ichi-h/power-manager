/**
 * サーバービルドと load context の組み立て。
 *
 * 環境変数・設定 JSON の検証はここで完結させ、`server/index.ts` は待受だけを扱う。
 * 起動時検証の失敗は呼び出し側が終了コード 78 で終了する（NFR-05, NFR-06）。
 */
import { createRequestListener } from "@react-router/node";
import { createContext, RouterContextProvider, type ServerBuild } from "react-router";
import { z } from "zod";

export type RuntimeConfig = {
  port: number;
};

/** loader/action から実行時設定を参照するためのキー。 */
export const runtimeConfigContext = createContext<RuntimeConfig>();

const port = z.coerce.number().int().min(1).max(65535);

/**
 * 環境変数を検証して実行時設定を返す。不正なら例外を投げる。
 */
export function loadRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): RuntimeConfig {
  const parsed = z
    .object({
      POWER_MANAGER_PORT: port,
    })
    .safeParse(env);

  if (!parsed.success) {
    const keys = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`環境変数が不正です: ${keys}`);
  }

  return {
    port: parsed.data.POWER_MANAGER_PORT,
  };
}

/**
 * loader/action へ渡す load context を組み立てる。
 */
export function createLoadContext(runtime: RuntimeConfig): RouterContextProvider {
  const context = new RouterContextProvider();
  context.set(runtimeConfigContext, runtime);
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
