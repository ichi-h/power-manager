/**
 * サーバービルドと load context の組み立て。
 *
 * 環境変数の検証は `server/startup.ts` で済ませ、ここは検証済みの設定を受け取るだけ。
 * `server/index.ts` は待受と終了コードを扱う。起動時検証の失敗は呼び出し側が終了コード
 * 78 で終了する（NFR-05, NFR-06）。
 *
 * load context には検証済みの実行時設定と設定ストアを載せ、loader/action からは
 * `context.get(configContext)` / `context.get(configStoreContext)` で参照する。
 * 要求ごとに環境変数を読み直さない。設定ストアは同一インスタンスを共有し、
 * 再読込の差し替えがすべての要求へ見えるようにする。
 */
import { createRequestListener } from '@react-router/node';
import { RouterContextProvider, type ServerBuild } from 'react-router';

import {
  configContext,
  toPublicRuntimeConfig,
  type RuntimeConfig,
} from '../app/lib/config.server.ts';
import {
  configStoreContext,
  type ConfigStore,
} from '../app/lib/config-store.server.ts';
import {
  createOperationHistory,
  historyContext,
  type OperationHistory,
} from '../app/lib/history.server.ts';
import { logPowerOperation } from '../app/lib/power-log.server.ts';
import {
  createPowerOperator,
  createStatusChecker,
  type PowerOperationRecord,
  type StatusChecker,
} from '../app/lib/power.server.ts';
import { operatorContext } from '../app/lib/operator-context.server.ts';
import { statusCheckerContext } from '../app/lib/status-checker-context.ts';
import {
  getScheduleRunner,
  type ScheduleRunner,
} from '../app/lib/schedule.server.ts';
import { sshRuntimeContext } from '../app/lib/ssh-runtime-context.server.ts';
import { logRequestFailure } from './log.ts';

export type {
  ConfigStore,
  OperationHistory,
  PowerOperationRecord,
  RuntimeConfig,
  StatusChecker,
};

/** プロセス共有の死活確認器。1 つのプロセスで 1 つだけ作る（NFR-08）。 */
const sharedStatusChecker = createStatusChecker();

/** プロセス共有の実行結果リングバッファ（FR-13）。メモリ上のみで、再起動で空になることを許容する（NFR-02）。 */
const sharedHistory = createOperationHistory();

/**
 * 電源操作の実行結果の記録（`PowerOperator` の `onRecord`）。
 *
 * リングバッファ（FR-13）への追加と 1 行 JSON ログ（NFR-10,
 * `docs/architecture.md` 7.1）の両方を行う。いずれも例外を投げないため、
 * 操作の成否には影響しない。
 */
function recordOperation(record: PowerOperationRecord): void {
  sharedHistory.push(record);
  logPowerOperation(record);
}

/**
 * プロセス共有の電源操作器（FR-04〜FR-06, FR-11）。
 *
 * 実行結果は `onRecord` からリングバッファとログの両方へ記録される。
 * `t008` 以降の loader/action はこの実体を `operatorContext` から参照する。
 */
const sharedOperator = createPowerOperator({ onRecord: recordOperation });

/**
 * 予約実行器の共有インスタンス（FR-12）。
 *
 * `NODE_ENV !== production` では作らない（テスト・開発で予約が動くと操作を
 * 取り違えるため）。作成は `getScheduleRunner` の呼び出し時に行い、起動配線は
 * `createAppListener` で行う。
 */
let sharedScheduleRunner: ScheduleRunner | null = null;

/** 予約実行器を（存在しなければ）作って返す。production でしか呼ばれない。 */
function ensureScheduleRunner(
  runtime: RuntimeConfig,
  configStore: ConfigStore,
): ScheduleRunner {
  if (sharedScheduleRunner === null) {
    sharedScheduleRunner = getScheduleRunner(configStore.current(), {
      operator: sharedOperator,
      runtime: {
        sshIdentityFile: runtime.sshIdentityFile,
        sshKnownHostsFile: runtime.sshKnownHostsFile,
      },
    });
  }
  return sharedScheduleRunner;
}

/**
 * loader/action へ渡す load context を組み立てる。
 *
 * 載せるのは公開値だけである。`authPasswordHash` などの秘密値は load context に置かず、
 * 認証ミドルウェア（`t004`）が起動時の設定から直接読む。load context は全 loader/action
 * から到達できるため、型で到達不能にしておく（SEC-05）。
 */
export function createLoadContext(
  runtime: RuntimeConfig,
  configStore: ConfigStore,
): RouterContextProvider {
  const context = new RouterContextProvider();
  context.set(configContext, toPublicRuntimeConfig(runtime));
  context.set(configStoreContext, configStore);
  // 死活確認器は server-only の実体をここから載せる。ルート側は型だけに依存させる。
  context.set(statusCheckerContext, sharedStatusChecker);
  // リングバッファも同じく server-only の実体をここから載せる（FR-13）。
  context.set(historyContext, sharedHistory);
  // 電源操作器も同じく server-only の実体をここから載せる（FR-04〜FR-06, FR-11）。
  context.set(operatorContext, sharedOperator);
  // SSH 停止の実行に必要なパス（秘密値ではない）。単体操作の action が読む。
  context.set(sshRuntimeContext, {
    sshIdentityFile: runtime.sshIdentityFile,
    sshKnownHostsFile: runtime.sshKnownHostsFile,
  });
  return context;
}

/**
 * `react-router build` が生成する ServerBuild を読み込む。
 * 型解決の対象外にするため、パスは変数として渡す。
 */
const serverBuildPath = '../build/server/index.js';

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
export function withAllowedActionOrigins(
  build: ServerBuild,
  host: string,
): ServerBuild {
  return {
    ...build,
    allowedActionOrigins: [host],
  };
}

async function loadServerBuild(runtime: RuntimeConfig): Promise<ServerBuild> {
  const build = (await import(serverBuildPath)) as ServerBuild;
  return withErrorHandler(
    withAllowedActionOrigins(build, runtime.publicOriginHost),
  );
}

export function createAppListener(
  runtime: RuntimeConfig,
  configStore: ConfigStore,
) {
  // 予約実行器（FR-12）。production のときだけ起動する。テストや開発では動かさない。
  if (process.env.NODE_ENV === 'production') {
    const runner = ensureScheduleRunner(runtime, configStore);
    runner.start();
  }
  return createRequestListener({
    build: () => loadServerBuild(runtime),
    // 明示しないと `develop` 扱いになり、開発用の挙動が残る（SEC-05）。
    mode: 'production',
    getLoadContext: () => createLoadContext(runtime, configStore),
  });
}
