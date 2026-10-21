/**
 * TCP 死活確認・電源操作・排他制御（FR-03〜FR-06, NFR-07, NFR-08）。
 *
 * - 死活判定は `ssh.host` と `ssh.port` への TCP 接続のみとする。ICMP ping もログイン成否も
 *   使わない（FR-03）。
 * - 死活確認 1 件あたりの上限は 5 秒（NFR-07）。タイムアウトも `offline` として扱う。
 * - 同時実行数は 8 の固定とし、環境変数などで変更する設定項目を持たない（NFR-08）。
 * - 対象 ID ごとに進行中の Promise を共有する。複数タブ・手動更新・自動更新が重なっても
 *   同一対象への TCP 接続は 1 本に抑える（NFR-08）。完了時に破棄するため、未完了の確認が
 *   次周期に重複登録されることはない。
 *
 * このモジュールは `ManagedConfig`（検証済み）の値だけを受け取る。接続先の検証は
 * `app/lib/runtime-config.server.ts` が済ませているため、ここでは「不正な定義」を
 * 考えない。
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { createSocket } from 'node:dgram';

import type { PowerOperation, ServerState, Target } from './model.ts';

/** 死活確認 1 件あたりのタイムアウト（ミリ秒）。タイムアウトは `offline` とする（NFR-07）。 */
export const checkTimeoutMs = 5_000;

/** 死活確認の同時実行数上限。固定とし設定項目にしない（NFR-08）。 */
const checkConcurrency = 8;

/** SSH 停止コマンド実行のタイムアウト（ミリ秒）。終了コード 0 を成功とする（FR-05, NFR-07）。 */
export const sshTimeoutMs = 30_000;

/** 電源操作の失敗・拒否分類（`docs/architecture.md` 7 章）。 */
export const powerOperationCodes = [
  'invalid_configuration',
  'ssh_unavailable',
  'operation_failed',
  'busy',
  'missed_schedule',
] as const;

/** 電源操作の失敗・拒否分類。 */
export type PowerOperationCode = (typeof powerOperationCodes)[number];

/** 電源操作 1 回の成否。 */
export type PowerResult = 'succeeded' | 'failed' | 'skipped';

/** 単体操作の結果。 */
export type SingleOperationOutcome = {
  readonly result: PowerResult;
  /** 失敗・拒否時の分類。成功時は `null`。 */
  readonly code: PowerOperationCode | null;
};

/**
 * MAC アドレスを 6 バイトへ分解する。
 *
 * `ManagedConfig` の検証（`app/lib/runtime-config.server.ts`）を通った値だけを
 * 受け取るため、実運用では `null` にはならない。失敗時は `invalid_configuration` として
 * 扱えるように `null` を返す。
 */
export function parseMacAddress(macAddress: string): Uint8Array | null {
  const parts = macAddress.split(':');
  if (parts.length !== 6) return null;
  const bytes = new Uint8Array(6);
  for (let index = 0; index < 6; index += 1) {
    const byte = Number.parseInt(parts[index] ?? '', 16);
    if (!/^[0-9A-Fa-f]{2}$/.test(parts[index] ?? '')) return null;
    bytes[index] = byte;
  }
  return bytes;
}

/**
 * Magic Packet の本体（102 バイト）を組み立てる（`docs/architecture.md` 6.2）。
 *
 * `0xFF` × 6 + MAC × 16。MAC が分解できない場合は `null`。
 */
export function createMagicPacket(macAddress: string): Uint8Array | null {
  const mac = parseMacAddress(macAddress);
  if (mac === null) return null;
  const packet = new Uint8Array(102);
  packet.fill(0xff, 0, 6);
  for (let index = 0; index < 16; index += 1) {
    packet.set(mac, 6 + index * 6);
  }
  return packet;
}

/**
 * UDP ソケットを 1 つ開き、`send` の成否を `Promise` で返す。
 *
 * ephemeral ポートで開き、`setBroadcast(true)`（SO_BROADCAST）を設定してからブロード
 * キャストアドレス宛の送信に備える。送信後に閉じる。`send` が失敗しても `close` は行う。
 * ソケット作成・`bind`・`setBroadcast` の失敗は `operation_failed` として扱う。
 */
async function createDefaultSocket(): Promise<{
  send: (packet: Uint8Array, port: number, address: string) => Promise<void>;
  close: () => void;
} | null> {
  let socket: ReturnType<typeof createSocket> | null = null;
  try {
    socket = createSocket('udp4');
  } catch {
    return null;
  }
  const bound = new Promise<void>((resolve, reject) => {
    socket?.once('error', reject);
    socket?.bind(0, () => {
      socket?.removeListener('error', reject);
      // ブロードキャストアドレス宛の送信には SO_BROADCAST が要る。設定に失敗したら
      // `bind` 失敗と同じく `null` を返して `operation_failed` 扱いにする。
      try {
        socket?.setBroadcast(true);
      } catch {
        reject(new Error('setBroadcast failed'));
        return;
      }
      resolve();
    });
  });
  return {
    async send(packet: Uint8Array, port2: number, address: string) {
      await bound;
      await new Promise<void>((resolve, reject) => {
        socket?.send(packet, port2, address, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
    close() {
      socket?.close();
    },
  };
}

/**
 * IPv4 アドレス（ドット区切り 4 分節、各 0〜255）として検査する。
 */
function isIPv4(address: string): boolean {
  const parts = address.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number.parseInt(part, 10);
    return value >= 0 && value <= 255;
  });
}

/**
 * WOL Magic Packet を UDP で送る。
 *
 * `send` が成功した時点で成功とする。OS の起動完了は待たない（FR-04）。UDP 送信は補機
 * の受信を保証しないため、送信 API の成否だけを成功とし、秒数上限は設けない（NFR-07 の
 * 上限は TCP 死活確認・SSH 停止にのみ適用する）。
 */
export async function sendWakeOnLan(
  macAddress: string,
  broadcastAddress: string,
  port: number,
): Promise<SingleOperationOutcome> {
  const packet = createMagicPacket(macAddress);
  // 設定ストアは検証済みとはいえ、ここは送信先を確定させる最後の関所なので検査して
  // 不正値は `invalid_configuration` に分類する。
  if (packet === null || !isIPv4(broadcastAddress)) {
    return { result: 'failed', code: 'invalid_configuration' };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { result: 'failed', code: 'invalid_configuration' };
  }
  const socketResult = await createDefaultSocket();
  if (socketResult === null) {
    return { result: 'failed', code: 'operation_failed' };
  }
  try {
    await socketResult.send(packet, port, broadcastAddress);
    return { result: 'succeeded', code: null };
  } catch {
    return { result: 'failed', code: 'operation_failed' };
  } finally {
    socketResult.close();
  }
}

/**
 * SSH 停止の 1 回分の実行単位を作る。
 *
 * `ssh` を引数配列で組み立てて実行する。シェルを介さない（`docs/architecture.md` 6.3）。
 * `BatchMode=yes` でパスワード入力をさせず、`known_hosts` を明示してホスト鍵検証を必須に
 * する（SEC-05）。終了コード 0 を成功とする（FR-05）。`ssh` の不在は
 * `ssh_unavailable`、その他の失敗は `operation_failed`。上限 30 秒（NFR-07）。
 */
export function createShutdownOverSsh(
  sshBinary: string,
  timeoutMs = sshTimeoutMs,
): (target: {
  readonly ssh: {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly shutdownCommand: string;
  };
  readonly runtime: {
    readonly sshIdentityFile: string;
    readonly sshKnownHostsFile: string;
  };
}) => Promise<SingleOperationOutcome> {
  return async (target) => {
    const args = [
      '-i',
      target.runtime.sshIdentityFile,
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${target.runtime.sshKnownHostsFile}`,
      '-p',
      String(target.ssh.port),
      `${target.ssh.user}@${target.ssh.host}`,
      target.ssh.shutdownCommand,
    ];
    return new Promise<SingleOperationOutcome>((resolve) => {
      let settled = false;
      const settle = (outcome: SingleOperationOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      const child = spawn(sshBinary, args, { stdio: 'ignore' });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        settle({ result: 'failed', code: 'operation_failed' });
      }, timeoutMs);
      timer.unref?.();
      child.once('error', (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        settle(
          code === 'ENOENT'
            ? { result: 'failed', code: 'ssh_unavailable' }
            : { result: 'failed', code: 'operation_failed' },
        );
      });
      child.once('exit', (code, signal) => {
        if (code === 0) {
          settle({ result: 'succeeded', code: null });
        } else {
          void signal;
          settle({ result: 'failed', code: 'operation_failed' });
        }
      });
    });
  };
}

/**
 * 進行中の死活確認の単位。
 *
 * `error` は TCP 接続の失敗理由。判定は接続成否だけで行うため、内容は分岐に使わない。
 * 成功でも失敗でも `ServerState` に畳めて返す。
 */
type InFlightCheck = Promise<ServerState>;
function checkOnce(host: string, port: number): Promise<ServerState> {
  return createTcpCheck(checkTimeoutMs)(host, port);
}

/**
 * TCP 接続で死活を確認する。
 *
 * 接続が成立した時点で `online` を返し、ソケットは即座に閉じる。失敗・タイムアウトは
 * `offline` とする（FR-03, NFR-07）。タイムアウト値を引数で受けられるのは、短い値で
 * 打ち切る検証を書けるようにするためだけである。実運用は 5 秒固定の `checkOnce` を
 * 使う。
 */
export function createTcpCheck(timeoutMs: number) {
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

      const timeout = setTimeout(() => finish('offline'), timeoutMs);
      // ソケットの待ち受けだけでは打ち切れない環境でイベントループを保持しない。
      timeout.unref?.();

      socket.once('connect', () => finish('online'));
      socket.once('error', () => finish('offline'));
      // 接続の成否が確定する前に切れても `offline` として扱う。
      socket.once('close', () => finish('offline'));
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
   *
   * 進行中 Promise の共有は `serverId` のみで照合する。確認中に設定の差し替えで
   * `host` / `port` が変わっても、進行中の確認は開始時の接続先で最後まで完走し、新しい
   * 接続先は完了後の次回確認から反映される。移行窓の最大幅は 1 確認分（5 秒上限）で、
   * その間の状態判定は古い接続先の結果になる。
   */
  check(serverId: string, host: string, port: number): Promise<ServerState>;
  /**
   * 全サーバーの状態をまとめて確認する。
   *
   * 全台を並列に確認するが、同時実行は `checkConcurrency` に抑える（NFR-08）。結果は
   * 設定順の `Map` で返す。
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
 * 実行の単位 `run` を差し替えられるのはテストのためだけである（実運用は既定の
 * `checkOnce`）。テストでは即応答のモックを `run` に渡して確認器の挙動だけを検証する。
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

  /**
   * 1 台の死活を確認する。`checkAll` からもこのクロージャ経由で呼ぶ。
   *
   * `StatusChecker.check` と同じ挙動で、メソッド呼び出し形式の `this` に依存しない。
   */
  const check = async (
    serverId: string,
    host: string,
    port: number,
  ): Promise<ServerState> => {
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
  };

  return {
    async check(serverId: string, host: string, port: number) {
      return check(serverId, host, port);
    },

    async checkAll(servers) {
      const entries = await Promise.all(
        servers.map(
          async (server) =>
            [
              server.id,
              await check(server.id, server.ssh.host, server.ssh.port),
            ] as const,
        ),
      );
      return new Map(entries);
    },

    reset() {
      inFlight.clear();
    },
  };
}

/**
 * 電源操作の実行結果（`docs/architecture.md` 6.6）。リングバッファの要素の型。
 *
 * `scheduleId` は予約実行時だけを持つ。`group` は一括操作時にだけ持つ。
 */
export type PowerOperationRecord = {
  readonly at: string;
  readonly scheduleId?: string;
  readonly target: Target;
  readonly operation: PowerOperation;
  readonly result: PowerResult;
  readonly code: PowerOperationCode | null;
  readonly group?: string;
};

/**
 * 電源操作の実行を排他する器（FR-06）。
 *
 * 対象 ID ごとの実行中フラグで排他する。実行中の対象への操作は `busy` として拒否する。
 * 一括操作は busy の対象を `skipped` として除外し、残りを継続する（FR-11）。
 *
 * 実行結果は `onRecord` コールバックへ渡す（リングバッファへの登録・ログ出力は呼び出
 * 側の責務）。テストでは `onRecord` を差し替えて結果の記録だけを検証できる。
 *
 * 実行の単位（`wake` / `shutdown` の実体）を注入できるのはテストのためだけである
 * （実運用は既定の WOL 送信・SSH 停止）。
 */
export type PowerOperator = {
  /**
   * 1 台への電源操作を実行する。
   *
   * 実行中なら `busy` を返す（拒否）。実行後は必ずフラグを下ろす。
   */
  operate(
    serverId: string,
    target: Target,
    operation: PowerOperation,
    server: {
      readonly macAddress: string;
      readonly wol: {
        readonly broadcastAddress: string;
        readonly port: number;
      };
      readonly ssh: {
        readonly host: string;
        readonly port: number;
        readonly user: string;
        readonly shutdownCommand: string;
      };
    },
    runtime: {
      readonly sshIdentityFile: string;
      readonly sshKnownHostsFile: string;
    },
    options?: { readonly scheduleId?: string },
  ): Promise<PowerOperationRecord>;
  /**
   * 複数台へ一括で電源操作を実行する（FR-11）。
   *
   * busy の対象を `skipped` として除外し、残りは継続する。実行は並列度 8 に抑える。
   */
  operateAll(
    groupId: string,
    operation: PowerOperation,
    servers: ReadonlyArray<{
      readonly id: string;
      readonly macAddress: string;
      readonly wol: {
        readonly broadcastAddress: string;
        readonly port: number;
      };
      readonly ssh: {
        readonly host: string;
        readonly port: number;
        readonly user: string;
        readonly shutdownCommand: string;
      };
    }>,
    runtime: {
      readonly sshIdentityFile: string;
      readonly sshKnownHostsFile: string;
    },
  ): Promise<ReadonlyArray<PowerOperationRecord>>;
  /** 現在実行中の対象 ID 一覧。テストで排他状態を確認するためにだけ公開する。 */
  busyTargets(): ReadonlySet<string>;
  /** 進行中の操作を破棄する。テストの後始末以外に呼ぶ必要はない。 */
  reset(): void;
};

/**
 * 単体操作の実行単位。テストでモックに差し替えられるようにするためだけに分ける。
 */
export type OperateServer = (
  serverId: string,
  target: Target,
  operation: PowerOperation,
  server: {
    readonly macAddress: string;
    readonly wol: { readonly broadcastAddress: string; readonly port: number };
    readonly ssh: {
      readonly host: string;
      readonly port: number;
      readonly user: string;
      readonly shutdownCommand: string;
    };
  },
  runtime: {
    readonly sshIdentityFile: string;
    readonly sshKnownHostsFile: string;
  },
) => Promise<SingleOperationOutcome>;
/**
 * 電源操作器を作る。
 *
 * - `runWake` / `runShutdown` はテストで差し替えられるように引数で受ける。実運用は
 *   既定の WOL 送信（`sendWakeOnLan`）・SSH 停止（`createShutdownOverSsh`）を使う。
 * - 結果の記録は `onRecord` で受ける。実運用はリングバッファへの追加と 1 行 JSON
 *   ログ（`docs/architecture.md` 7.1）の両方を行う。`onRecord` が例外を投げても操作の
 *   成否には影響させない。
 */
export function createPowerOperator(
  options: {
    readonly sshBinary?: string;
    readonly onRecord?: (record: PowerOperationRecord) => void;
    readonly runWake?: (
      macAddress: string,
      broadcastAddress: string,
      port: number,
    ) => Promise<SingleOperationOutcome>;
    readonly runShutdown?: OperateServer;
  } = {},
): PowerOperator {
  const { sshBinary = 'ssh', onRecord = () => {} } = options;
  const shutdown: OperateServer =
    options.runShutdown ??
    (async (_serverId, _target2, _operation, server, runtime) =>
      createShutdownOverSsh(sshBinary)({ ssh: server.ssh, runtime }));
  const runWake =
    options.runWake ??
    (async (macAddress, broadcastAddress, port) =>
      sendWakeOnLan(macAddress, broadcastAddress, port));

  /** 対象 ID ごとの実行中フラグ。 */
  const busy = new Set<string>();
  /** 同時実行数 8 のセマフォ。 */
  let active = 0;
  const waiting: Array<() => void> = [];

  const acquire = async (): Promise<void> => {
    if (active < operationConcurrency) {
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

  /**
   * 1 台への操作。排他の取得・解除と結果の記録をここで行う。
   */
  const operateOne = async (
    serverId: string,
    target: Target,
    operation: PowerOperation,
    server: Parameters<OperateServer>[3],
    runtime: Parameters<OperateServer>[4],
    options2?: { readonly scheduleId?: string; readonly group?: string },
  ): Promise<PowerOperationRecord> => {
    const record = (outcome: SingleOperationOutcome): PowerOperationRecord => ({
      at: new Date().toISOString(),
      ...(options2?.scheduleId === undefined
        ? {}
        : { scheduleId: options2.scheduleId }),
      target,
      operation,
      result: outcome.result,
      code: outcome.code,
      ...(options2?.group === undefined ? {} : { group: options2.group }),
    });
    if (busy.has(serverId)) {
      const skipped = record({
        result: 'skipped',
        code: 'busy',
      } as SingleOperationOutcome);
      try {
        onRecord(skipped);
      } catch {
        // 記録の失敗は操作の成否に影響させない。
      }
      return skipped;
    }
    busy.add(serverId);
    let outcome: SingleOperationOutcome;
    try {
      await acquire();
      try {
        outcome =
          operation === 'wake'
            ? await runWake(
                server.macAddress,
                server.wol.broadcastAddress,
                server.wol.port,
              )
            : await shutdown(serverId, target, operation, server, runtime);
      } finally {
        release();
      }
    } finally {
      // 成功・失敗を問わず、実行後は必ずフラグを下ろす（FR-06）。
      busy.delete(serverId);
    }
    const done = record(outcome);
    try {
      onRecord(done);
    } catch {
      // 記録の失敗は操作の成否に影響させない。
    }
    return done;
  };

  return {
    async operate(serverId, target, operation, server, runtime, options) {
      return operateOne(serverId, target, operation, server, runtime, options);
    },

    async operateAll(groupId, operation, servers, runtime) {
      // 一括は busy の対象を除外し、残りを並列度 8 で実行する（FR-11）。
      const records = await Promise.all(
        servers.map(async (server) =>
          operateOne(
            server.id,
            { type: 'server', id: server.id },
            operation,
            server,
            runtime,
            { group: groupId },
          ),
        ),
      );
      return records;
    },

    busyTargets() {
      return new Set(busy);
    },

    reset() {
      busy.clear();
    },
  };
}

/** 一括電源操作の同時実行数上限（NFR-07, FR-11）。 */
const operationConcurrency = 8;
