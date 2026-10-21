/**
 * 起動時の設定読込み。
 *
 * `server/index.ts` から切り離しておく。`process.exit` を呼ぶ経路こそが重要な仕様なので、
 * モジュールを読み込んだ時点で待受を始める形にすると単体テストで確かめられない。
 *
 * 起動時の検証は 2 段ある（`docs/architecture.md` 3.2, FR-08, FR-09）。
 *
 * 1. 環境変数の検証（NFR-06）。ここで作られる `RuntimeConfig` に、設定 JSON のパスも入る。
 * 2. 管理対象 JSON の読込みと全体検証。設定 JSON のパスは 1 で検証済みの値を使う。
 *
 * どちらの失敗も「設定不備」であり、待受を開始せずに終了コード 78 で終了する。
 * 再起動しても同じ失敗を繰り返すため、再起動抑止の対象にする（NFR-05）。
 */
import { writeSync } from "node:fs";

import {
  ConfigurationError,
  loadRuntimeConfig,
  type RuntimeConfig,
} from "../app/lib/config.server.ts";
import {
  createConfigStore,
  loadManagedConfigForStartup,
  type ConfigStore,
} from "../app/lib/config-store.server.ts";
import { configurationErrorExitCode } from "../app/lib/exit-codes.ts";
import type { ManagedConfig } from "../app/lib/model.ts";
import { ManagedConfigError } from "../app/lib/runtime-config.server.ts";

/** 終了処理を差し替えられるようにする（テストで `process.exit` を呼ばせない）。 */
export type ExitFunction = (code: number) => void;

/** 起動時に揃える準備物。`server/index.ts` はこれを受け取って待受だけを行う。 */
export type StartupResult = {
  readonly runtime: RuntimeConfig;
  readonly configStore: ConfigStore;
};

/**
 * 標準エラーへ 1 行を同期的に書く。
 *
 * `console.error` は非同期にフラッシュされるため、直後の `process.exit()` で取りこぼす
 * ことがある（パイプ越しに 65,536 バイトを超える出力で実測）。終了直前の 1 行は
 * `fs.writeSync` で書き切る。
 */
export function writeStderrLine(line: string): void {
  writeSync(2, `${line}\n`);
}

/**
 * 設定不備として終了する。`reason` には変数名・項目名と理由だけを載せ、値は載せない
 * （SEC-05）。差し替えた `exit` が戻ってきた場合に備えて投げ、呼び出し側が待受を
 * 始めないようにする。
 */
function failStartup(error: Error, exit: ExitFunction): never {
  writeStderrLine(
    JSON.stringify({
      event: "startup_failed",
      code: "invalid_configuration",
      reason: error.message,
    }),
  );
  exit(configurationErrorExitCode);
  throw error;
}

/**
 * `startRuntime` が投げた例外を受けて、種別ごとに終了する。`server/index.ts` の起動経路が
 * これ 1 つを通るため、終了コードの割り当てをここで固定できる（テスト可能にするため
 * `startRuntime` から分けている）。
 *
 * - 設定不備（`ConfigurationError` / `ManagedConfigError`）は再起動しても同じ失敗を
 *   繰り返すため、終了コード 78 で再起動抑止の対象にする（NFR-05）。
 * - それ以外（実装の不具合・I/O 例外）は終了コード 1 にし、`startup_failed`
 *   （`code: operation_failed`）を 1 行残す。78 にすると再起動もされず記録も残らない
 *   無言死になる（NFR-05, NFR-10）。
 *
 * 差し替えた `exit` が戻ってきた場合に備えて投げ、呼び出し側が待受を始めないようにする。
 */
export function exitAfterStartupFailure(
  error: unknown,
  exit: ExitFunction = (code) => process.exit(code),
): never {
  if (error instanceof ConfigurationError || error instanceof ManagedConfigError) {
    // `startRuntime` が `startup_failed` を出力済み。追加の出力はしない。
    exit(configurationErrorExitCode);
  } else {
    writeStderrLine(
      JSON.stringify({
        event: "startup_failed",
        code: "operation_failed",
        // 例外の種別だけを載せ、値やパスは載せない（SEC-05）。
        reason: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    exit(1);
  }

  throw error;
}

/**
 * 環境変数と管理対象 JSON を検証し、失敗したら待受を開始せずに終了コード 78 で終了する
 * （NFR-05, NFR-06, FR-08）。
 *
 * 検証以外の例外（実装の不具合など）は設定不備ではないため、握りつぶさずに再送出する。
 * これにより、設定不備だけが再起動抑止の対象になる。
 */
export async function startRuntime(
  env: Record<string, string | undefined> = process.env,
  exit: ExitFunction = (code) => process.exit(code),
): Promise<StartupResult> {
  let runtime: RuntimeConfig;
  try {
    runtime = loadRuntimeConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    failStartup(error, exit);
  }

  let managedConfig: ManagedConfig;
  try {
    managedConfig = await loadManagedConfigForStartup(runtime.configPath);
  } catch (error) {
    if (!(error instanceof ManagedConfigError)) throw error;
    failStartup(error, exit);
  }

  return { runtime, configStore: createConfigStore(runtime.configPath, managedConfig) };
}
