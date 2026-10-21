/**
 * 電源操作（WOL 送信・SSH 停止・排他制御・構造化ログ）の検証
 * （FR-04〜FR-06, FR-11, NFR-07, NFR-10, SEC-05）。
 *
 * - Magic Packet のバイト列（0xFF × 6 + MAC × 16）と UDP 送信先を固定する。
 * - SSH の引数組み立て（BatchMode・known_hosts 明示・停止コマンド 1 引数）を、
 *   `ssh` の代わりにダミーの実行ファイルを渡して記録で検証する。
 * - 排他制御（busy 拒否・フラグ解除・一括の skipped 除外）をモック実行単位で検証する。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

import {
  createMagicPacket,
  createPowerOperator,
  createShutdownOverSsh,
  parseMacAddress,
  resolveBatchTargets,
  sendWakeOnLan,
  summarizeBatchResults,
  type OperateServer,
  type PowerOperationRecord,
} from '../app/lib/power.server.ts';
import { createSocket as createUdpSocket } from 'node:dgram';

/** ダミーの SSH 実行ファイルを置く一時ディレクトリ。 */
const sshDummyDir = await mkdtemp(join(tmpdir(), 'power-manager-test-'));
/** タイムアウト検証用のダミー実行ファイルを置く一時ディレクトリ。 */
const sshDummyDir2 = await mkdtemp(join(tmpdir(), 'power-manager-test-'));

afterAll(async () => {
  await rm(sshDummyDir, { recursive: true, force: true });
  await rm(sshDummyDir2, { recursive: true, force: true });
});

describe('Magic Packet', () => {
  test('0xFF × 6 + MAC × 16 の 102 バイト', () => {
    const packet = createMagicPacket('00:11:22:33:44:55');
    expect(packet).not.toBeNull();
    expect(packet?.byteLength).toBe(102);
    for (let index = 0; index < 6; index += 1) {
      expect(packet?.[index]).toBe(0xff);
    }
    const mac = parseMacAddress('00:11:22:33:44:55')!;
    for (let copy = 0; copy < 16; copy += 1) {
      for (let index = 0; index < 6; index += 1) {
        expect(packet?.[6 + copy * 6 + index]).toBe(mac[index]);
      }
    }
  });

  test('MAC の分解に失敗したら null', () => {
    expect(createMagicPacket('00:11:22:33:44')).toBeNull();
    expect(createMagicPacket('XX:11:22:33:44:55')).toBeNull();
    expect(parseMacAddress('0:11:22:33:44:55')).toBeNull();
  });
});

/** テスト用の対象 1 台分。`parseManagedConfig(validManagedConfig())` と同形。 */
const server = {
  id: 'nas',
  macAddress: '00:11:22:33:44:55',
  wol: { broadcastAddress: '192.168.1.255', port: 9 },
  ssh: {
    host: 'nas.example.internal',
    port: 22,
    user: 'power-manager',
    shutdownCommand: 'sudo systemctl poweroff',
  },
} as const;

/** `runtime`（SshConfig 相当）。テストでも固定値で足りる。 */
const runtime = {
  sshIdentityFile: '/etc/power-manager/ssh/id',
  sshKnownHostsFile: '/etc/power-manager/ssh/known_hosts',
} as const;

describe('createPowerOperator の排他制御', () => {
  test('実行中の対象への操作は busy として拒否する（FR-06）', async () => {
    let release: (() => void) | undefined;
    const operator = createPowerOperator({
      runShutdown: (async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return { result: 'succeeded', code: null };
      }) as OperateServer,
    });

    const first = operator.operate(
      'nas',
      { type: 'server', id: 'nas' },
      'shutdown',
      server,
      runtime,
    );
    // 1 件目の実行中に 2 件目を始めると busy で拒否される。
    const second = await operator.operate(
      'nas',
      { type: 'server', id: 'nas' },
      'shutdown',
      server,
      runtime,
    );
    expect(second.result).toBe('skipped');
    expect(second.code).toBe('busy');

    release?.();
    const done = await first;
    expect(done.result).toBe('succeeded');
  });

  test('実行後は必ずフラグを下ろす（成功時）', async () => {
    const operator = createPowerOperator({
      runShutdown: (async () => ({
        result: 'succeeded',
        code: null,
      })) as OperateServer,
    });
    const first = await operator.operate(
      'nas',
      { type: 'server', id: 'nas' },
      'shutdown',
      server,
      runtime,
    );
    expect(first.result).toBe('succeeded');
    expect(operator.busyTargets().size).toBe(0);
  });

  test('実行後は必ずフラグを下ろす（失敗時も）', async () => {
    const operator = createPowerOperator({
      runShutdown: (async () => ({
        result: 'failed',
        code: 'operation_failed',
      })) as OperateServer,
    });
    const first = await operator.operate(
      'nas',
      { type: 'server', id: 'nas' },
      'shutdown',
      server,
      runtime,
    );
    expect(first.result).toBe('failed');
    expect(first.code).toBe('operation_failed');
    expect(operator.busyTargets().size).toBe(0);
  });

  test('wake は runWake を呼び、結果を記録する（FR-04）', async () => {
    const recorded: Array<{ mac: string; address: string; port: number }> = [];
    const operator = createPowerOperator({
      runWake: async (mac, address, port) => {
        recorded.push({ mac, address, port });
        return { result: 'succeeded', code: null };
      },
    });
    const record = await operator.operate(
      'nas',
      { type: 'server', id: 'nas' },
      'wake',
      server,
      runtime,
    );
    expect(recorded).toEqual([
      { mac: '00:11:22:33:44:55', address: '192.168.1.255', port: 9 },
    ]);
    expect(record.result).toBe('succeeded');
    expect(record.at).toBeTruthy();
  });

  test('一括は busy を skipped として除外し残りを継続する（FR-11）', async () => {
    const records: Array<PowerOperationRecord> = [];
    const operator = createPowerOperator({
      runShutdown: (async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { result: 'succeeded', code: null };
      }) as OperateServer,
      onRecord: (record) => records.push(record),
    });

    // nas を先に掴んでおく。掴んだまま一括を実行すると nas だけ skipped になる。
    const holding = operator.operate(
      'nas',
      { type: 'server', id: 'nas' },
      'shutdown',
      server,
      runtime,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(operator.busyTargets().has('nas')).toBe(true);

    const outcome = await operator.operateAll(
      { type: 'group', id: 'storage' },
      'shutdown',
      [server, { ...server, id: 'builder' }],
      runtime,
    );
    const results = outcome.records;
    // nas は busy、builder は実行される。
    const nas = results.find((r) => r.target.id === 'nas');
    const builder = results.find((r) => r.target.id === 'builder');
    expect(nas?.result).toBe('skipped');
    expect(nas?.code).toBe('busy');
    expect(builder?.result).toBe('succeeded');
    // 一括の記録は builder の 1 件のみ。nas の holding 分は一括の外で記録される。
    const batchRecords = records.filter((r) => r.group === 'storage');
    expect(batchRecords.length).toBe(2);
    // nas の holding 分（group なし）が後から追加されるため、全体は 3 件。
    await holding;
    expect(records.length).toBe(3);
  });

  test('onRecord が例外を投げても成否には影響しない', async () => {
    const operator = createPowerOperator({
      runShutdown: (async () => ({
        result: 'succeeded',
        code: null,
      })) as OperateServer,
      onRecord: () => {
        throw new Error('記録に失敗');
      },
    });
    const record = await operator.operate(
      'nas',
      { type: 'server', id: 'nas' },
      'shutdown',
      server,
      runtime,
    );
    expect(record.result).toBe('succeeded');
    expect(operator.busyTargets().size).toBe(0);
  });
});

describe('一括操作の対象集合と要約（FR-11）', () => {
  const servers = [
    { id: 'nas', groups: ['storage'] },
    { id: 'test-01', groups: ['storage', 'test'] },
    { id: 'builder', groups: ['test'] },
    { id: 'lone', groups: [] },
  ];

  test('全台は定義順の全サーバーを返す', () => {
    expect(
      resolveBatchTargets(servers, { type: 'all' }).map((server2) => server2.id),
    ).toEqual(['nas', 'test-01', 'builder', 'lone']);
  });

  test('グループは所属するサーバーだけを返す', () => {
    expect(
      resolveBatchTargets(servers, { type: 'group', id: 'storage' }).map(
        (server2) => server2.id,
      ),
    ).toEqual(['nas', 'test-01']);
  });

  test('同じ ID が複数回現れても 1 回に畳む', () => {
    // 検証はサーバー ID の集合内一意を保証しているが、対象集合の確定側でも畳む。
    const duplicated = [servers[0]!, servers[0]!, servers[1]!];
    expect(
      resolveBatchTargets(duplicated, { type: 'all' }).map(
        (server2) => server2.id,
      ),
    ).toEqual(['nas', 'test-01']);
  });

  test('所属グループの重複入力でも 1 台 1 回になる', () => {
    // `docs/operations.md` 2.2 の重複排除はサーバー ID で行うため、
    // `groups: ['storage', 'storage']` のような重複入力でも破綻しない。
    const repeated = [{ id: 'nas', groups: ['storage', 'storage'] }];
    expect(
      resolveBatchTargets(repeated, { type: 'group', id: 'storage' }),
    ).toHaveLength(1);
  });

  test('未知のグループ ID は空の集合になる', () => {
    expect(
      resolveBatchTargets(servers, { type: 'group', id: 'unknown' }),
    ).toEqual([]);
  });

  test('結果を成功・失敗・スキップに数える', () => {
    const outcomes: ReadonlyArray<
      Pick<PowerOperationRecord, 'result' | 'code'>
    > = [
      { result: 'succeeded', code: null },
      { result: 'succeeded', code: null },
      { result: 'failed', code: 'operation_failed' },
      { result: 'skipped', code: 'busy' },
    ];
    const records: ReadonlyArray<PowerOperationRecord> = outcomes.map(
      (outcome, index) => ({
        at: '2026-01-02T03:04:05.000Z',
        target: { type: 'server', id: `s${index}` },
        operation: 'wake',
        ...outcome,
      }),
    );

    expect(summarizeBatchResults(records)).toEqual({
      ok: 2,
      failed: 1,
      skipped: 1,
    });
  });

  test('部分失敗を全体の失敗に読み替えない（要約だけを返す）', async () => {
    const operator = createPowerOperator({
      runShutdown: (async (serverId: string) =>
        serverId === 'test-01'
          ? { result: 'failed', code: 'operation_failed' }
          : { result: 'succeeded', code: null }) as OperateServer,
    });

    const outcome = await operator.operateAll(
      { type: 'all' },
      'shutdown',
      [server, { ...server, id: 'test-01' }],
      runtime,
    );

    expect(outcome.records).toHaveLength(2);
    expect(outcome.summary).toEqual({ ok: 1, failed: 1, skipped: 0 });
  });

  test('一括の同時実行数は 8 を超えない（NFR-07）', async () => {
    let running = 0;
    let peak = 0;
    const operator = createPowerOperator({
      runShutdown: (async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return { result: 'succeeded' as const, code: null };
      }) as OperateServer,
    });

    const targets = Array.from({ length: 12 }, (_unused, index) => ({
      ...server,
      id: `server-${index}`,
    }));
    const outcome = await operator.operateAll(
      { type: 'all' },
      'shutdown',
      targets,
      runtime,
    );

    expect(outcome.records).toHaveLength(12);
    expect(outcome.summary).toEqual({ ok: 12, failed: 0, skipped: 0 });
    expect(peak).toBeLessThanOrEqual(8);
  });
});

describe('WOL の実送信', () => {
  test('localhost の受信ソケットへ 102 バイトが到達する（FR-04）', async () => {
    // ephemeral ポートで localhost の受信ソケットを開き、実送信の到達を検証する。
    const receiver = createUdpSocket('udp4');
    const received: Array<{ packet: Buffer; address: string; port: number }> =
      [];
    await new Promise<void>((resolve) => {
      receiver.bind(0, '127.0.0.1', resolve);
    });
    const receiverPort = receiver.address().port;
    receiver.on('message', (packet, remote) => {
      received.push({ packet, address: remote.address, port: remote.port });
    });

    const outcome = await sendWakeOnLan(
      '00:11:22:33:44:55',
      '127.0.0.1',
      receiverPort,
    );
    // 送信は非同期のため、受信側の準備を待つ。
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 5_000;
      const poll = () => {
        if (received.length > 0 || Date.now() > deadline) resolve();
        else setTimeout(poll, 20);
      };
      poll();
    });

    try {
      expect(outcome.result).toBe('succeeded');
      expect(outcome.code).toBeNull();
      expect(received.length).toBe(1);
      const { packet, address } = received[0]!;
      expect(packet.byteLength).toBe(102);
      for (let index = 0; index < 6; index += 1) {
        expect(packet[index]).toBe(0xff);
      }
      const mac = parseMacAddress('00:11:22:33:44:55')!;
      for (let copy = 0; copy < 16; copy += 1) {
        for (let index = 0; index < 6; index += 1) {
          expect(packet[6 + copy * 6 + index]).toBe(mac[index]);
        }
      }
      expect(address).toBe('127.0.0.1');
    } finally {
      receiver.close();
    }
  });

  test('不正な broadcastAddress は invalid_configuration', async () => {
    const outcome = await sendWakeOnLan(
      '00:11:22:33:44:55',
      'not-an-address',
      9,
    );
    expect(outcome.result).toBe('failed');
    expect(outcome.code).toBe('invalid_configuration');
    const outcomePort = await sendWakeOnLan(
      '00:11:22:33:44:55',
      '192.168.1.255',
      0,
    );
    expect(outcomePort.result).toBe('failed');
    expect(outcomePort.code).toBe('invalid_configuration');
    const outcomeMac = await sendWakeOnLan(
      'XX:11:22:33:44:55',
      '192.168.1.255',
      9,
    );
    expect(outcomeMac.result).toBe('failed');
    expect(outcomeMac.code).toBe('invalid_configuration');
  });
});

describe('SSH 停止の引数組み立て', () => {
  test('ssh への引数は配列で渡す（FR-05, SEC-05）', async () => {
    // ダミーの ssh 実行ファイルが受け取った引数を記録して終了する。
    const dummyPath = join(sshDummyDir, 'ssh-dummy');
    const dummyArgsPath = join(sshDummyDir, 'ssh-args.json');
    await writeFile(
      dummyPath,
      [
        '#!/usr/bin/env node',
        `require('node:fs').writeFileSync(${JSON.stringify(dummyArgsPath)},`,
        `  JSON.stringify(process.argv.slice(2)));`,
        'process.exit(0);',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    const operator = createPowerOperator({ sshBinary: dummyPath });
    const record = await operator.operate(
      'nas',
      { type: 'server', id: 'nas' },
      'shutdown',
      server,
      runtime,
    );
    expect(record.result).toBe('succeeded');
    expect(
      JSON.parse(
        await import('node:fs').then((fs) =>
          fs.readFileSync(dummyArgsPath, 'utf8'),
        ),
      ),
    ).toEqual([
      '-i',
      '/etc/power-manager/ssh/id',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'UserKnownHostsFile=/etc/power-manager/ssh/known_hosts',
      '-p',
      '22',
      'power-manager@nas.example.internal',
      'sudo systemctl poweroff',
    ]);
  });

  test('終了コード 0 以外は operation_failed（FR-05）', async () => {
    const dummyPath2 = join(sshDummyDir, 'ssh-fail');
    await writeFile(dummyPath2, ['#!/bin/sh', 'exit 1', ''].join('\n'), {
      mode: 0o755,
    });
    const operator = createPowerOperator({ sshBinary: dummyPath2 });
    const record = await operator.operate(
      'nas',
      { type: 'server', id: 'nas' },
      'shutdown',
      server,
      runtime,
    );
    expect(record.result).toBe('failed');
    expect(record.code).toBe('operation_failed');
  });

  test('ssh が見つからない場合は ssh_unavailable', async () => {
    const operator = createPowerOperator({
      sshBinary: join(sshDummyDir, 'ssh-absent'),
    });
    const record = await operator.operate(
      'nas',
      { type: 'server', id: 'nas' },
      'shutdown',
      server,
      runtime,
    );
    expect(record.result).toBe('failed');
    expect(record.code).toBe('ssh_unavailable');
  });

  test('タイムアウトは SIGKILL で打ち切り operation_failed（NFR-07）', async () => {
    // 30 秒待つダミー実行ファイル。短いタイムアウトで打ち切る。
    const sleepyPath = join(sshDummyDir2, 'ssh-sleepy');
    await writeFile(
      sleepyPath,
      ['#!/usr/bin/env node', 'setTimeout(() => {}, 30_000);', ''].join('\n'),
      { mode: 0o755 },
    );
    const shutdown2 = createShutdownOverSsh(sleepyPath, 200);
    const outcome = await shutdown2({ ssh: server.ssh, runtime });
    expect(outcome.result).toBe('failed');
    expect(outcome.code).toBe('operation_failed');
  });
});
