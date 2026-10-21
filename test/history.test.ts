/**
 * 実行結果リングバッファの検証（FR-13, NFR-02）。
 *
 * - 上限 100 件を超えたら最古の要素から破棄される。
 * - `recent` は新しい順で返し、保持外の要素は返さない。
 * - 呼び出し側へ渡した配列や要素を後から書き換えても内部の保持へ影響しない。
 */
import { RouterContextProvider } from 'react-router';
import { describe, expect, test } from 'vitest';

import {
  createOperationHistory,
  historyCapacity,
  historyContext,
  requireHistory,
} from '../app/lib/history.server.ts';
import type { PowerOperationRecord } from '../app/lib/power.server.ts';
import { loader as historyLoader } from '../app/routes/api.history.tsx';

/** テスト用の要素 1 件。順序を見分けるため `target.id` に連番を使う。 */
function record(id: string): PowerOperationRecord {
  return {
    at: '2026-01-02T03:04:05.678Z',
    target: { type: 'server', id },
    operation: 'wake',
    result: 'succeeded',
    code: null,
  };
}

describe('createOperationHistory', () => {
  test('既定は 100 件まで保持する', () => {
    const history = createOperationHistory();
    expect(historyCapacity).toBe(100);

    for (let index = 0; index < 150; index += 1) {
      history.push(record(`server-${index}`));
    }

    const recent = history.recent();
    expect(recent).toHaveLength(100);
    // 最古（0〜49）は破棄され、最新が先頭に来る。
    expect(recent[0]).toEqual(record('server-149'));
    expect(recent[99]).toEqual(record('server-50'));
  });

  test('上限超過時は最古から破棄する', () => {
    const history = createOperationHistory(3);
    history.push(record('a'));
    history.push(record('b'));
    history.push(record('c'));
    history.push(record('d'));

    expect(history.recent().map((r) => r.target.id)).toEqual(['d', 'c', 'b']);
  });

  test('保持枠より少ないうちは破棄しない', () => {
    const history = createOperationHistory(3);
    history.push(record('a'));
    history.push(record('b'));

    expect(history.recent().map((r) => r.target.id)).toEqual(['b', 'a']);
  });

  test('空のときは空配列を返す', () => {
    expect(createOperationHistory().recent()).toEqual([]);
  });

  test('予約実行の要素は scheduleId を保持する', () => {
    const history = createOperationHistory();
    history.push({
      at: '2026-01-02T03:04:05.678Z',
      scheduleId: 'nightly',
      target: { type: 'group', id: 'storage' },
      operation: 'shutdown',
      result: 'failed',
      code: 'ssh_unavailable',
    });

    expect(history.recent()[0]?.scheduleId).toBe('nightly');
    expect(history.recent()[0]?.code).toBe('ssh_unavailable');
  });

  test('recent が返す配列の書き換えは保持へ影響しない', () => {
    const history = createOperationHistory();
    history.push(record('a'));
    history.push(record('b'));

    const recent = history.recent() as Array<PowerOperationRecord>;
    recent.pop();
    recent.push(record('injected'));

    expect(history.recent().map((r) => r.target.id)).toEqual(['b', 'a']);
  });

  test('capacity が 0 のときは何も保持しない', () => {
    const history = createOperationHistory(0);
    history.push(record('a'));
    expect(history.recent()).toEqual([]);
  });

  test('ちょうど capacity 件のときは破棄しない', () => {
    const history = createOperationHistory();
    for (let index = 0; index < historyCapacity; index += 1) {
      history.push(record(`server-${index}`));
    }

    const recent = history.recent();
    expect(recent).toHaveLength(historyCapacity);
    // 最古（server-0）が残っており、最新が先頭に来る。
    expect(recent[0]).toEqual(record(`server-${historyCapacity - 1}`));
    expect(recent[historyCapacity - 1]).toEqual(record('server-0'));
  });

  test('capacity が負のときは何も保持しない', () => {
    const history = createOperationHistory(-1);
    history.push(record('a'));
    expect(history.recent()).toEqual([]);
  });

  test('要素は不変で、読み出し側の要素書き換えは保持へ波及しない', () => {
    const history = createOperationHistory();
    const pushed = record('a');
    history.push(pushed);

    // push 時に要素が凍結されている。
    expect(Object.isFrozen(history.recent()[0])).toBe(true);

    // 渡した側のオブジェクトを後から書き換えても、保持へは波及しない。
    expect(() => {
      (pushed as { at: string }).at = '2027-01-01T00:00:00.000Z';
    }).toThrow();
    expect(history.recent()[0]?.at).toBe('2026-01-02T03:04:05.678Z');
  });
});

describe('load context', () => {
  test('リングバッファを載せた context から読み出せる', () => {
    const provider = new RouterContextProvider();
    const history = createOperationHistory();
    provider.set(historyContext, history);

    expect(requireHistory(provider)).toBe(history);
  });

  test('載せていない context からの読み出しは配線不整合と分かるエラーになる', () => {
    expect(() => requireHistory(new RouterContextProvider())).toThrow(
      /load context/,
    );
  });

  test('配線不整合のエラーは元のエラーを cause として保持する', () => {
    let thrown: unknown;
    try {
      requireHistory(new RouterContextProvider());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).cause).toBeInstanceOf(Error);
    expect((thrown as Error).cause).not.toBe(thrown);
  });

  test('historyContext はモジュールを評価し直しても同じ実体になる', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const reloaded = await import('../app/lib/history.server.ts');
    expect(reloaded.historyContext).toBe(historyContext);
  });
});

describe('/api/history loader', () => {
  /** 履歴を差し替えた load context を作る。 */
  function contextWith(records: ReadonlyArray<PowerOperationRecord>) {
    const history = createOperationHistory();
    for (const item of records) history.push(item);
    const context = new RouterContextProvider();
    context.set(historyContext, history);
    return context;
  }

  test('直近の実行結果を新しい順で application/json として返す', async () => {
    const response = historyLoader({
      context: contextWith([record('a'), record('b')]),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(await response.text())).toEqual({
      records: [record('b'), record('a')],
    });
  });

  test('履歴が空でも空配列を返す', async () => {
    const response = historyLoader({ context: contextWith([]) });
    expect(JSON.parse(await response.text())).toEqual({ records: [] });
  });
});
