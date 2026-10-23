/**
 * 起動時の環境変数ファイル読み込み。
 *
 * 担うこと: `POWER_MANAGER_ENV_FILE`（未指定なら作業ディレクトリの `.env`）を
 * `process.env` へ流し込む。既に設定済みの変数は上書きしない（シェルや systemd の
 * `EnvironmentFile` が優先）。
 *
 * 担わないこと: 環境変数の検証（`server/startup.ts` の `loadRuntimeConfig`）。
 *
 * 本番の `npm start` でも開発の `npm run dev` でも同じ経路を通るよう、
 * `startRuntime` の先頭で適用する。既定のファイルは任意であり、無ければ何もしない。
 *
 * 書式はシェルスクリプトではない（`loadEnvFile` の仕様）。`export` は書かない前提で、
 * `$PWD` や `${VAR}` のような変数展開・クォート・行末コメントの解釈もしない。値をそのまま
 * 読むため、`.envrc`（`source` 前提）を `.env` に置くとパスやハッシュが展開されずに
 * 検証で落ちる。
 * 明示指定されたファイルが無い場合と、読めない・解釈できない場合だけ、値を伏せた 1 行で
 * 失敗させる（SEC-05）。
 */
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';

import { configurationErrorExitCode } from '../app/lib/exit-codes.ts';
import { writeStderrLine } from './startup.ts';

/** 規約上の既定ファイル名。`npm` を実行したディレクトリからの相対位置で探す。 */
const defaultEnvFileName = '.env';

/** 明示指定があるか。既定ファイルの不在を正常と扱うかの判定に使う。 */
function isExplicitlyConfigured(
  env: Record<string, string | undefined>,
): boolean {
  const configured = env.POWER_MANAGER_ENV_FILE;
  return configured !== undefined && configured !== '';
}

/** 環境変数ファイルのパスを決める。`cwd` はテストで固定できるように差し込める。 */
export function resolveEnvFilePath(
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
): string {
  return isExplicitlyConfigured(env)
    ? (env.POWER_MANAGER_ENV_FILE as string)
    : join(cwd, defaultEnvFileName);
}

/** 読み込みの結果。呼び出し側が終了コードを決めるために使う。 */
export type EnvFileLoadResult =
  | { readonly status: 'loaded'; readonly path: string }
  | { readonly status: 'missing'; readonly path: string }
  | { readonly status: 'rejected'; readonly path: string; readonly code: string };

/**
 * 環境変数ファイルを読む。
 *
 * 既定のファイルが存在しない場合は `missing`（設定不備ではない）。明示指定されたファイルが
 * 無い場合と、読めない・書式が不正な場合は `rejected` を返す。例外は投げない
 * （呼び出し側で終了コードを決める）。
 */
export function loadEnvironmentFile(
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
): EnvFileLoadResult {
  const path = resolveEnvFilePath(env, cwd);
  try {
    loadEnvFile(path);
    return { status: 'loaded', path };
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error
        ? String((error as NodeJS.ErrnoException).code)
        : 'unknown';
    // 既定の `.env` が無いのは正常（シェルや systemd だけで起動できる）。明示指定された
    // ファイルが無いのは設定の書き間違いなので、起動を止める。
    if (code === 'ENOENT' && !isExplicitlyConfigured(env)) {
      return { status: 'missing', path };
    }
    return { status: 'rejected', path, code };
  }
}

/**
 * 起動経路から呼ぶ薄い包み。`rejected` のときは 1 行残して終了コード 78 で終わる。
 *
 * `path` はログに載せない（利用者の環境依存の値をそのまま出さないため、SEC-05）。
 */
export function applyEnvironmentFile(
  env: Record<string, string | undefined> = process.env,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  const result = loadEnvironmentFile(env);
  if (result.status !== 'rejected') return;

  writeStderrLine(
    JSON.stringify({
      event: 'startup_failed',
      code: 'invalid_configuration',
      reason: `環境変数ファイルを読み込めません（${result.code}）`,
    }),
  );
  exit(configurationErrorExitCode);
}
