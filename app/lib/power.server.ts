/**
 * TCP 死活確認と並列度制御（FR-03, NFR-07, NFR-08）。
 *
 * - 判定は `ssh.host` と `ssh.port` への TCP 接続のみとする。ICMP ping もログイン成否も
 *   使わない（FR-03）。
 * - 1 件あたりの上限は 5 秒（NFR-07）。タイムアウトも `offline` として扱う。
 * - 同時実行数は 8 の固定とし、環境変数などで変更する設定項目を持たない（NFR-08）。
 * - 対象 ID ごとに進行中の Promise を共有する。複数タブ・手動更新・自動更新が重なっても
 *   同一対象への TCP 接続は 1 本に抑える（NFR-08）。完了時に破棄するため、未完了の確認が
 *   次周期に重複登録されることはない。
 *
 * このモジュールは `ManagedConfig`（検証済み）の値だけを受け取る。接続先の検証は
 * `app/lib/runtime-config.server.ts` が済ませているため、ここでは「不正な定義」を
 * 考えない。
 */
import { connect } from "node:net";

import type { ServerState } from "./model.ts";

/** 死活確認 1 件あたりのタイムアウト（秒）。タイムアウトは `offline` とする（NFR-07）。 */
const checkTimeoutMs = 5_000;

/** 死活確認の同時実行数上限。固定とし設定項目にしない（NFR-08）。 */
const checkConcurrency = 8;

/**
 * 進行中の死活確認の単位。
 *
 * `error` は TCP 接続の失敗理由。判定は接続成否だけで行うため、内容は分岐に使わない。
 * 成功でも失敗でも `ServerState` へ畳めて返す。
 */
type InFlightCheck = Promise<ServerState>;

function checkOnce(host: string, port: number): Promise<ServerState> {
  return createTcpCheck(checkTimeoutMs)(host, port);
}

/**
 * テスト用: TCP 接続の単位を直接呼ぶ。本番コードからは呼ばない。
 */
export const __testCheckOnce = checkOnce;

/** テスト用: タイムアウト値を指定して確認単位を作る。本番コードからは呼ばない。 */
export const __testCreateTcpCheck = createTcpCheck;

/**
 * TCP 接続で死活を確認する。
 *
 * 接続が成立した時点で `online` を返し、ソケットは即座に閉じる。失敗・タイムアウトは
 * `offline` とする（FR-03, NFR-07）。タイムアウト値を引数で受けられるのはテストのため
 * だけである。実運用は 5 秒固定の `checkOnce` を使う。
 */
function createTcpCheck(timeoutMs: number) {
  return function checkOnce(host: string, port: number): Promise<ServerState> {
    return new Promise((resolve) => {
      // `connect` はエラーを `error` イベントで渡す。ハンドラを付けないと例外が
      // `uncaughtException` へ落ちるため、必ずここで受け止める。
      const socket = connect({ host, port });

      const finish = (state: ServerState) => {
        clearTimeout(timeout);
        socket.removeAllListeners();
        socket.destroy();
        resolve(state);
      };

      const timeout = setTimeout(() => finish("offline"), timeoutMs);

      socket.once("connect", () => finish("online"));
      socket.once("error", () => finish("offline"));
      // 接続の成否が確定する前に切れても `offline` として扱う。
      socket.once("close", () => finish("offline"));
    });
  };
}

/**
 * 死活確認器。
 *
 * 設定ストアの差し替えに合わせて呼び出し側が都度 `servers` を渡すため、ここは設定を
 * 持たない。持つのはセマフォと対象 ID ごとの進行中 Promise のみ。
 */
export type StatusChecker = {
  /**
   * 1 台の死活を確認する。
   *
   * 同一対象の確認が進行中なら、その Promise を共有して待つ。新規ならセマフォを通して
   * TCP 接続を 1 本開く。
   */
  check(serverId: string, host: string, port: number): Promise<ServerState>;
  /**
   * 全サーバーの状態をまとめて確認する。
   *
   * 全台を並列に確認するが、同時実行は `checkConcurrency` に抑える（NFR-08）。
   */
  checkAll(
    servers: ReadonlyArray<{ id: string; ssh: { host: string; port: number } }>,
  ): Promise<ReadonlyMap<string, ServerState>>;
  /** 進行中の確認を破棄する。テストの後始末以外に呼ぶ必要はない。 */
  reset(): void;
};

/**
 * 死活確認器を作る。
 *
 * 実行の単位を差し替えられるのはテストのためだけである（実運用は `checkOnce`）。
 */
export function createStatusChecker(
  run: (host: string, port: number) => Promise<ServerState> = checkOnce,
): StatusChecker {
  /** 同時実行数 8 のセマフォ。取得待ちの確認はここに並ぶ。 */
  let active = 0;
  const waiting: Array<() => void> = [];

  const acquire = async (): Promise<void> => {
    if (active < checkConcurrency) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
  };

  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };

  /** 対象 ID ごとの進行中 Promise。完了時に破棄する。 */
  const inFlight = new Map<string, InFlightCheck>();

  return {
    async check(serverId: string, host: string, port: number) {
      const shared = inFlight.get(serverId);
      if (shared) return shared;

      const entry: { promise?: InFlightCheck } = {};
      const promise: InFlightCheck = (async () => {
        await acquire();
        try {
          return await run(host, port);
        } finally {
          release();
          // 完了時に破棄するため、未完了の確認が次周期に重複登録されることはない。
          if (inFlight.get(serverId) === entry.promise) inFlight.delete(serverId);
        }
      })();
      entry.promise = promise;
      inFlight.set(serverId, promise);
      return promise;
    },

    async checkAll(servers) {
      const entries = await Promise.all(
        servers.map(async (server) => [
          server.id,
          await this.check(server.id, server.ssh.host, server.ssh.port),
        ] as const),
      );
      return new Map(entries);
    },

    reset() {
      inFlight.clear();
    },
  };
}