/**
 * 起動時の設定読込み。
 *
 * `server/index.ts` から切り離しておく。`process.exit` を呼ぶ経路こそが重要な仕様なので、
 * モジュールを読み込んだ時点で待受を始める形にすると単体テストで確かめられない。
 */
import { writeSync } from "node:fs";

import {
  ConfigurationError,
  loadRuntimeConfig,
  type RuntimeConfig,
} from "../app/lib/config.server.ts";
import { configurationErrorExitCode } from "../app/lib/exit-codes.ts";

/** 終了処理を差し替えられるようにする（テストで `process.exit` を呼ばせない）。 */
export type ExitFunction = (code: number) => void;

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
 * 環境変数を検証し、失敗したら待受を開始せずに終了コード 78 で終了する（NFR-05, NFR-06）。
 *
 * 検証以外の例外（実装の不具合など）は設定不備ではないため、握りつぶさずに再送出する。
 * これにより、設定不備だけが再起動抑止の対象になる。
 *
 * `reason` には `ConfigurationError` のメッセージだけを載せる。メッセージは変数名と理由で
 * 組み立てており、環境変数の値は含まない（SEC-05）。
 */
export function startRuntime(
  env: Record<string, string | undefined> = process.env,
  exit: ExitFunction = (code) => process.exit(code),
): RuntimeConfig {
  try {
    return loadRuntimeConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;

    writeStderrLine(
      JSON.stringify({
        event: "startup_failed",
        code: "invalid_configuration",
        reason: error.message,
      }),
    );
    exit(configurationErrorExitCode);
    // 差し替えた `exit` が戻ってきた場合は、呼び出し側が待受を始めないよう投げる。
    throw error;
  }
}
