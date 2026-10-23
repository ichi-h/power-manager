/**
 * 画面の描画の検証（FR-02, FR-05, FR-07, FR-13, FR-14, NFR-09）。
 *
 * 一覧画面は `fetcher` と `setInterval` に依存するため、draw の検証は jsdom 上で行う。
 * サーバー側の loader/action の入出力は `test/dashboard.test.ts` が受け持つ。
 */
// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { createRoutesStub } from 'react-router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import Dashboard, {
  statusRefreshIntervalMs,
  type BatchOperationFailure,
  type BatchOperationResult,
  type DashboardLoaderData,
  type OperationResult,
} from '../app/routes/dashboard.tsx';
import type { HistoryRecord } from '../app/lib/history-context.ts';
import type { PowerOperationRecord } from '../app/lib/power.server.ts';

/** 2 台・1 グループの画面データ。 */
function loaderData(
  overrides: Partial<DashboardLoaderData> = {},
): DashboardLoaderData {
  return {
    servers: [
      { id: 'nas', name: 'NAS', groups: ['storage'] },
      { id: 'test-01', name: '検証機 01', groups: [] },
    ],
    groups: [{ id: 'storage', name: 'ストレージ' }],
    states: { nas: 'online', 'test-01': 'offline' },
    recent: [],
    result: null,
    ...overrides,
  };
}

function record(overrides: Partial<PowerOperationRecord> = {}): HistoryRecord {
  return {
    seq: 1,
    at: '2026-01-02T03:04:05.000Z',
    target: { type: 'server', id: 'nas' },
    operation: 'shutdown',
    result: 'failed',
    code: 'operation_failed',
    ...overrides,
  };
}

/**
 * 一覧画面のルートを組む。`/api/status` は状態の自動更新から `fetcher.load` で呼ばれる。
 * `onStatusLoad` で呼び出し回数を数える。
 */
function renderDashboard(
  data: DashboardLoaderData,
  options: {
    action?: () =>
      | OperationResult
      | BatchOperationResult
      | BatchOperationFailure
      | Response
      | Promise<OperationResult | BatchOperationResult | BatchOperationFailure>;
    onStatusLoad?: () => void;
    onHistoryLoad?: () => void;
    onLoad?: () => void;
    onAction?: (formData: FormData) => void;
    statusStates?: Record<string, string>;
    history?: () => { records: ReadonlyArray<HistoryRecord> } | Response;
  } = {},
) {
  const Stub = createRoutesStub([
    {
      path: '/',
      Component: Dashboard,
      loader: () => {
        options.onLoad?.();
        return data;
      },
      action: async ({ request }) => {
        const form = await request.formData();
        options.onAction?.(form);
        return (
          options.action?.() ?? {
            target: 'nas',
            operation: 'wake',
            result: 'succeeded',
          }
        );
      },
    },
    {
      path: '/api/status',
      loader: () => {
        options.onStatusLoad?.();
        return {
          states: options.statusStates ?? {
            nas: 'online',
            'test-01': 'online',
          },
        };
      },
    },
    {
      path: '/api/history',
      loader: () => {
        options.onHistoryLoad?.();
        return options.history?.() ?? { records: data.recent ?? [] };
      },
    },
  ]);

  return render(<Stub initialEntries={['/']} />);
}

/**
 * 疑似タイマーを進めつつ、保留中の Promise を処理する。
 *
 * `waitFor` は疑似タイマーを検出すると自前で時間を進めるため、間隔の検証には使えない
 * （進めた分だけ `setInterval` が早く発火してしまう）。ここでは明示的に 1ms ずつ進める。
 */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * 疑似タイマーを 1ms ずつ進め、条件が満たされるまで待つ（上限 2 周期）。
 *
 * `vi.advanceTimersByTimeAsync` をまとめて進めると、タイマーの登録時刻のずれで 1 周期分の
 * 発火を取りこぼすことがあるため、1ms ずつ進めて判定する。
 */
async function advanceUntil(done: () => boolean) {
  for (
    let elapsed = 0;
    elapsed < statusRefreshIntervalMs * 2 && !done();
    elapsed += 1
  ) {
    await advance(1);
  }
}

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

/**
 * 初期の \`document.visibilityState\`。テストで差し替えたものを毎回戻す。
 *
 * 戻さないと、後続のテストが非表示のまま実行され、順序依存の失敗になる。
 */
const initialVisibilityState = Object.getOwnPropertyDescriptor(
  document,
  'visibilityState',
);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (initialVisibilityState === undefined) {
    delete (document as { visibilityState?: unknown }).visibilityState;
  } else {
    Object.defineProperty(document, 'visibilityState', initialVisibilityState);
  }
});

describe('一覧画面の描画', () => {
  test('表示名・所属グループ・状態・操作ボタンを出す', async () => {
    renderDashboard(loaderData());

    expect(await screen.findByText('NAS')).toBeDefined();
    expect(screen.getByText('所属グループ: ストレージ')).toBeDefined();
    expect(screen.getByText('所属グループ: なし')).toBeDefined();
    expect(screen.getByText('状態: オンライン')).toBeDefined();
    expect(screen.getByText('状態: オフライン')).toBeDefined();
    // 行ごとに 起動・停止 のボタンを持つ。
    expect(screen.getAllByRole('button', { name: '起動' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: '停止' })).toHaveLength(2);
  });

  test('サーバーが 0 台のときはその旨を出す', async () => {
    renderDashboard(loaderData({ servers: [], states: {} }));
    expect(
      await screen.findByText('サーバーが登録されていません。'),
    ).toBeDefined();
  });

  test('「最近の実行」を新しい順に、規定の項目だけで出す', async () => {
    renderDashboard(
      loaderData({
        recent: [
          record({
            at: '2026-01-02T03:04:05.000Z',
            scheduleId: 'night',
            target: { type: 'group', id: 'storage' },
          }),
          record({
            at: '2026-01-01T00:00:00.000Z',
            operation: 'wake',
            result: 'succeeded',
            code: null,
          }),
        ],
      }),
    );

    expect(await screen.findByText('予約: night')).toBeDefined();
    expect(screen.getByText('対象: グループ storage')).toBeDefined();
    expect(screen.getByText('予約: なし')).toBeDefined();
    expect(screen.getByText('操作: 停止')).toBeDefined();
    expect(screen.getByText('操作: 起動')).toBeDefined();
    expect(screen.getByText('結果: 失敗')).toBeDefined();
    // 失敗理由はログにのみ残し、画面には出さない（FR-13, SEC-05）。
    expect(screen.queryByText(/理由:/)).toBeNull();
  });

  test('「最近の実行」が空のときはその旨を出す', async () => {
    renderDashboard(loaderData());
    expect(await screen.findByText('まだ実行はありません。')).toBeDefined();
  });

  test('対象の識別子をエスケープして出す（HTML として解釈しない）', async () => {
    const { container } = renderDashboard(
      loaderData({
        recent: [
          record({ target: { type: 'server', id: '<script>x</script>' } }),
        ],
      }),
    );

    expect(await screen.findByText(/対象: サーバー/)).toBeDefined();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>x</script>');
  });
});

describe('単体操作の行内表示', () => {
  test('送信中は対象行に「実行中」、完了後は結果を出す', async () => {
    let resolveAction: (() => void) | undefined;
    renderDashboard(loaderData(), {
      action: () =>
        new Promise<OperationResult>((resolve) => {
          resolveAction = () =>
            resolve({ target: 'nas', operation: 'wake', result: 'succeeded' });
        }),
    });

    fireEvent.click(
      (await screen.findAllByRole('button', { name: '起動' }))[0]!,
    );

    expect(await screen.findByText('実行中')).toBeDefined();

    await act(async () => {
      resolveAction?.();
    });

    expect(await screen.findByText('起動: 成功')).toBeDefined();
    expect(screen.queryByText('実行中')).toBeNull();
  });

  test('失敗・実行中（拒否）の結果を種別だけで表示する', async () => {
    renderDashboard(loaderData(), {
      action: () => ({
        target: 'nas',
        operation: 'shutdown',
        result: 'rejected',
      }),
    });

    fireEvent.click(
      (await screen.findAllByRole('button', { name: '停止' }))[0]!,
    );
    expect(await screen.findByText('停止: 実行中（拒否）')).toBeDefined();
  });

  test('操作しても URL が変わらない', async () => {
    renderDashboard(loaderData());
    fireEvent.click(
      (await screen.findAllByRole('button', { name: '起動' }))[0]!,
    );
    expect(window.location.pathname).toBe('/');
  });
});

describe('部分更新（FR-02, FR-07, NFR-09）', () => {
  test('状態を自動更新してもページの loader を再実行しない', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onLoad = vi.fn();
    const onStatusLoad = vi.fn();
    renderDashboard(loaderData(), { onLoad, onStatusLoad });

    await advanceUntil(() => onStatusLoad.mock.calls.length >= 2);

    // 画面全体の再読み込み（loader の再実行）は起きない。
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  test('自動更新の前後で「最近の実行」の要素は同じまま', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const recent = [record({ target: { type: 'server', id: 'nas' } })];
    const { container } = renderDashboard(loaderData({ recent }));

    expect(await screen.findByText('対象: サーバー nas')).toBeDefined();
    const lists = container.querySelectorAll('ul');
    const before = lists[1];
    const beforeRow = before?.querySelector('li');

    // 状態は変わる（再レンダーが起きる）が、「最近の実行」の要素は差し替わらない。
    await advanceUntil(() => screen.queryByText('状態: オフライン') !== null);

    // 「最近の実行」のリストと行の要素が差し替わっていない（部分更新になっている）。
    const after = container.querySelectorAll('ul');
    expect(after[1]).toBe(before);
    expect(after[1]?.querySelector('li')).toBe(beforeRow);
  });

  test('送信中に 15 秒進めても対象行の「実行中」は消えない', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderDashboard(loaderData(), {
      action: () =>
        // 応答を返さず、送信中のまま 15 秒以上経過させる。
        new Promise<OperationResult>(() => {}),
    });

    fireEvent.click(
      (await screen.findAllByRole('button', { name: '起動' }))[0]!,
    );
    expect(await screen.findByText('実行中')).toBeDefined();

    await advance(statusRefreshIntervalMs * 3);

    expect(screen.getByText('実行中')).toBeDefined();
  });

  test('「実行中」は操作した対象行にだけ出る', async () => {
    const { container } = renderDashboard(loaderData(), {
      action: () => new Promise<OperationResult>(() => {}),
    });

    fireEvent.click(
      (await screen.findAllByRole('button', { name: '起動' }))[0]!,
    );
    expect(await screen.findByText('実行中')).toBeDefined();

    expect(screen.getAllByText('実行中')).toHaveLength(1);
    // 1 台目（NAS）の行にだけ出る。2 台目の行には出ない。
    const rows = container.querySelectorAll('li');
    expect(rows[0]?.textContent).toContain('実行中');
    expect(rows[1]?.textContent).not.toContain('実行中');
  });

  test('操作しても URL は変わり、再訪しても action は再実行されない（FR-07）', async () => {
    const onAction = vi.fn();
    renderDashboard(loaderData(), { onAction });
    const before = window.location.href;

    fireEvent.click(
      (await screen.findAllByRole('button', { name: '起動' }))[0]!,
    );
    await vi.waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));

    expect(window.location.href).toBe(before);
    // 表示が同じ URL に留まるため、再読み込みで action が再送されることはない。
    expect(window.location.search).toBe('');
  });
});

describe('通常フォーム送信の結果表示（NFR-09）', () => {
  test('単体操作の結果をクエリから描く', async () => {
    renderDashboard(
      loaderData({
        result: {
          kind: 'single',
          operation: 'wake',
          result: 'succeeded',
          target: 'nas',
        },
      }),
    );

    expect(await screen.findByText('NAS: 起動: 成功')).toBeDefined();
  });

  test('一括操作の要約と対象ごとの結果をクエリから描く', async () => {
    renderDashboard(
      loaderData({
        result: {
          kind: 'batch',
          scope: { type: 'all' },
          operation: 'wake',
          results: [
            {
              target: 'nas',
              operation: 'wake',
              result: 'succeeded',
              code: null,
            },
            {
              target: 'test-01',
              operation: 'wake',
              result: 'skipped',
              code: 'busy',
            },
          ],
          summary: { ok: 1, failed: 0, skipped: 1 },
        },
      }),
    );

    expect(
      await screen.findByText('1 件成功 / 0 件失敗 / 1 件スキップ'),
    ).toBeDefined();
    expect(screen.getByText('NAS: 成功')).toBeDefined();
    expect(
      screen.getByText('検証機 01: スキップ（実行中のためスキップしました）'),
    ).toBeDefined();
  });

  test('未知の理由の語彙は画面に出さない（SEC-05）', async () => {
    renderDashboard(
      loaderData({
        result: {
          kind: 'batch',
          scope: { type: 'all' },
          operation: 'wake',
          results: [
            {
              target: 'nas',
              operation: 'wake',
              result: 'skipped',
              code: 'internal_detail',
            },
          ],
          summary: { ok: 0, failed: 0, skipped: 1 },
        },
      }),
    );

    expect(await screen.findByText('NAS: スキップ')).toBeDefined();
    expect(screen.queryByText(/internal_detail/)).toBeNull();
  });

  test('受け付けられなかった理由は固定の文言で出す（NFR-09）', async () => {
    renderDashboard(
      loaderData({ result: { kind: 'error', reason: 'targets_changed' } }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      '対象が変わりました。画面を再読み込みしてから操作し直してください。',
    );
  });

  test('結果が無ければ何も出さない', async () => {
    renderDashboard(loaderData({ result: null }));

    await screen.findByText('サーバー一覧');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('停止の確認', () => {
  test('拒否したら送信しない（FR-05, SEC-07）', async () => {
    const onAction = vi.fn();
    vi.mocked(window.confirm).mockReturnValue(false);
    renderDashboard(loaderData(), { onAction });

    fireEvent.click(
      (await screen.findAllByRole('button', { name: '停止' }))[0]!,
    );
    expect(window.confirm).toHaveBeenCalledWith('NAS を停止しますか');
    expect(onAction).not.toHaveBeenCalled();
  });

  test('承認したら送信し、対象の表示名を確認に含める', async () => {
    const onAction = vi.fn();
    renderDashboard(loaderData(), { onAction });

    fireEvent.click(
      (await screen.findAllByRole('button', { name: '停止' }))[1]!,
    );
    expect(window.confirm).toHaveBeenCalledWith('検証機 01 を停止しますか');
    await vi.waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
    expect(onAction.mock.calls[0]?.[0]?.get('intent')).toBe('shutdown');
    expect(onAction.mock.calls[0]?.[0]?.get('target')).toBe('test-01');
  });

  test('起動は確認を出さない', async () => {
    const onAction = vi.fn();
    renderDashboard(loaderData(), { onAction });

    fireEvent.click(
      (await screen.findAllByRole('button', { name: '起動' }))[0]!,
    );
    await vi.waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
    expect(window.confirm).not.toHaveBeenCalled();
  });
});

describe('一括操作', () => {
  /** 一括操作の応答。draw 側は要約と対象ごとの結果だけを使う。 */
  function batchResult(
    overrides: Partial<BatchOperationResult> = {},
  ): BatchOperationResult {
    return {
      target: { type: 'all' },
      operation: 'wake',
      results: [
        { target: 'nas', operation: 'wake', result: 'succeeded', code: null },
        {
          target: 'test-01',
          operation: 'wake',
          result: 'succeeded',
          code: null,
        },
      ],
      summary: { ok: 2, failed: 0, skipped: 0 },
      ...overrides,
    };
  }

  test('全台一括とグループごとの見出し・ボタンを出す', async () => {
    renderDashboard(loaderData());

    expect(
      await screen.findByRole('heading', { name: 'ストレージ' }),
    ).toBeDefined();
    expect(
      screen.getByRole('heading', { name: 'すべてのサーバー' }),
    ).toBeDefined();
    // 全台 1 組 + グループ 1 組（ストレージ）の 起動・停止。
    expect(screen.getAllByRole('button', { name: '全台起動' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '全台停止' })).toHaveLength(1);
    expect(
      screen.getAllByRole('button', { name: 'グループ起動' }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole('button', { name: 'グループ停止' }),
    ).toHaveLength(1);
  });

  test('サーバーが 0 台のときは一括ボタンを出さない', async () => {
    renderDashboard(loaderData({ servers: [], groups: [], states: {} }));
    await screen.findByText('サーバーが登録されていません。');
    expect(screen.queryByRole('button', { name: '全台起動' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'グループ起動' })).toBeNull();
  });

  test('グループ一括は scopeKind=group と scopeId にグループ ID を送る', async () => {
    const onAction = vi.fn();
    renderDashboard(loaderData(), { onAction, action: () => batchResult() });

    fireEvent.click(
      await screen.findByRole('button', { name: 'グループ起動' }),
    );
    await vi.waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
    const form = onAction.mock.calls[0]?.[0] as FormData;
    expect(form.get('intent')).toBe('wake-group');
    expect(form.get('scopeKind')).toBe('group');
    expect(form.get('scopeId')).toBe('storage');
  });

  test('全台一括は scopeKind=all を送り、scopeId は送らない', async () => {
    const onAction = vi.fn();
    renderDashboard(loaderData(), { onAction, action: () => batchResult() });

    fireEvent.click(await screen.findByRole('button', { name: '全台起動' }));
    await vi.waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
    const form = onAction.mock.calls[0]?.[0] as FormData;
    expect(form.get('intent')).toBe('wake-group');
    expect(form.get('scopeKind')).toBe('all');
    expect(form.get('scopeId')).toBeNull();
  });

  test('一括停止は対象の表示名を列挙した確認を 1 回だけ出し、拒否したら送信しない', async () => {
    const onAction = vi.fn();
    vi.mocked(window.confirm).mockReturnValue(false);
    renderDashboard(loaderData(), { onAction });

    fireEvent.click(await screen.findByRole('button', { name: '全台停止' }));
    expect(window.confirm).toHaveBeenCalledTimes(1);
    const message = vi.mocked(window.confirm).mock.calls[0]?.[0];
    expect(message).toContain('NAS');
    expect(message).toContain('検証機 01');
    expect(onAction).not.toHaveBeenCalled();
  });

  test('承認したら 1 回だけ送信する', async () => {
    const onAction = vi.fn();
    renderDashboard(loaderData(), { onAction, action: () => batchResult() });

    fireEvent.click(await screen.findByRole('button', { name: '全台停止' }));
    expect(window.confirm).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
    const form = onAction.mock.calls[0]?.[0] as FormData;
    expect(form.get('intent')).toBe('shutdown-group');
    // 確認した対象を送り、action 側で確定した集合と照合させる（SEC-07）。
    expect(form.get('confirmed')).toBe('nas,test-01');
  });

  test('完了後に対象ごとの結果と要約を出す', async () => {
    renderDashboard(loaderData(), {
      action: () =>
        batchResult({
          results: [
            {
              target: 'nas',
              operation: 'wake',
              result: 'succeeded',
              code: null,
            },
            {
              target: 'test-01',
              operation: 'wake',
              result: 'skipped',
              code: null,
            },
          ],
          summary: { ok: 1, failed: 0, skipped: 1 },
        }),
    });

    fireEvent.click(await screen.findByRole('button', { name: '全台起動' }));
    expect(
      await screen.findByText('1 件成功 / 0 件失敗 / 1 件スキップ'),
    ).toBeDefined();
    expect(screen.getByText('NAS: 成功')).toBeDefined();
    expect(screen.getByText('検証機 01: スキップ')).toBeDefined();
  });

  test('スキップした対象には理由を日本語で添える', async () => {
    renderDashboard(loaderData(), {
      action: () =>
        batchResult({
          results: [
            {
              target: 'nas',
              operation: 'wake',
              result: 'succeeded',
              code: null,
            },
            {
              target: 'test-01',
              operation: 'wake',
              result: 'skipped',
              code: 'busy',
            },
          ],
          summary: { ok: 1, failed: 0, skipped: 1 },
        }),
    });

    fireEvent.click(await screen.findByRole('button', { name: '全台起動' }));
    expect(
      await screen.findByText(
        '検証機 01: スキップ（実行中のためスキップしました）',
      ),
    ).toBeDefined();
    // 内部の語彙（code）は画面に出さない（SEC-05）。
    expect(screen.queryByText(/busy/)).toBeNull();
  });

  test('失敗応答は要約ではなくメッセージを出す（描画で例外にならない）', async () => {
    renderDashboard(loaderData(), {
      action: () => ({
        error: 'invalid_request' as const,
        message:
          '対象を確定できませんでした。画面を再読み込みしてから操作し直してください。',
      }),
    });

    fireEvent.click(await screen.findByRole('button', { name: '全台起動' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('対象を確定できませんでした');
    // 要約（成功/失敗/スキップ）は出さない。
    expect(screen.queryByText(/件成功/)).toBeNull();
  });
});

describe('状態の自動更新', () => {
  test('周期の遅延値は 15 秒で固定する（FR-02）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const delays: Array<number | undefined> = [];
    const original = globalThis.setTimeout;
    // export 定数の写し取りではなく、実際に登録される遅延値を観測する。
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: () => void,
      delay?: number,
    ) => {
      delays.push(delay);
      return original(handler, delay);
    }) as typeof globalThis.setTimeout);

    renderDashboard(loaderData());
    // loader の解決後に画面が描画され、周期が登録される。
    await advanceUntil(() => delays.length > 0);

    // 画面の周期（状態・履歴）は 15 秒で登録される。
    expect(delays).toContain(statusRefreshIntervalMs);
    expect(
      delays.filter((delay) => delay === statusRefreshIntervalMs).length,
    ).toBeGreaterThanOrEqual(2);
    expect(statusRefreshIntervalMs).toBe(15_000);
  });

  test('loader の結果を起点に、15 秒ごとに 1 回だけ取得する（FR-02, NFR-08）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onStatusLoad = vi.fn();
    renderDashboard(loaderData(), { onStatusLoad });

    // 周期の開始までに取得を重ねない（マウント直後の二重確認をしない）。
    await advance(1_000);
    expect(onStatusLoad).not.toHaveBeenCalled();

    await advanceUntil(() => onStatusLoad.mock.calls.length >= 1);
    expect(onStatusLoad).toHaveBeenCalledTimes(1);

    // 次の周期までは追加の取得をしない。
    await advance(1_000);
    expect(onStatusLoad).toHaveBeenCalledTimes(1);

    await advanceUntil(() => onStatusLoad.mock.calls.length >= 2);
    expect(onStatusLoad).toHaveBeenCalledTimes(2);
  });

  test('取得した状態だけを差し替える', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderDashboard(loaderData(), {
      statusStates: { nas: 'offline', 'test-01': 'online' },
    });

    await advanceUntil(() => screen.queryByText('状態: オフライン') !== null);
    expect(screen.getByText('状態: オフライン')).toBeDefined();
    expect(screen.getByText('状態: オンライン')).toBeDefined();
  });

  test('タブが非表示の間は止め、表示に戻ったら即座に 1 回取得する', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onStatusLoad = vi.fn();
    renderDashboard(loaderData(), { onStatusLoad });
    await advanceUntil(() => onStatusLoad.mock.calls.length >= 1);
    expect(onStatusLoad).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await advance(statusRefreshIntervalMs * 4);
    // 非表示中は追加の取得をしない。
    expect(onStatusLoad).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advanceUntil(() => onStatusLoad.mock.calls.length === 2);
    expect(onStatusLoad).toHaveBeenCalledTimes(2);
  });

  test('取得に失敗しても表示を維持し、次周期で再試行する', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    const Stub = createRoutesStub([
      {
        path: '/',
        Component: Dashboard,
        loader: () => loaderData(),
      },
      {
        path: '/api/status',
        loader: () => {
          calls += 1;
          // 5xx の本文は JSON ではない。画面側は応答を状態として解釈できず、表示を変えない。
          return new Response('boom', { status: 500 });
        },
      },
      {
        // 履歴の取得も同じ周期で走るため、ルートを用意しないと 404 になる。
        path: '/api/history',
        loader: () => new Response('boom', { status: 500 }),
      },
    ]);
    const { container } = render(<Stub initialEntries={['/']} />);

    await advanceUntil(() => calls >= 1);
    expect(calls).toBe(1);
    // 失敗しても初期状態の表示が残る。
    expect(container.textContent).toContain('状態: オンライン');

    await advanceUntil(() => calls >= 2);
    expect(calls).toBe(2);
  });
});

describe('再現（b356 で見つかった欠陥）', () => {
  test('実行中（busy）の単体停止は「実行中（拒否）」と表示する（FR-07）', async () => {
    renderDashboard(loaderData(), {
      action: () => ({
        target: 'nas',
        operation: 'shutdown',
        result: 'rejected',
      }),
    });

    fireEvent.click(
      (await screen.findAllByRole('button', { name: '停止' }))[0]!,
    );

    expect(await screen.findByText('停止: 実行中（拒否）')).toBeDefined();
    expect(screen.queryByText('結果: スキップ')).toBeNull();
  });

  test('起動→停止の順に操作したとき、行内には最後の操作結果だけを出す（FR-07）', async () => {
    let mode: 'wake' | 'shutdown' = 'wake';
    renderDashboard(loaderData(), {
      action: () => ({
        target: 'nas',
        operation: mode,
        result: mode === 'wake' ? 'succeeded' : 'failed',
      }),
      onAction: (form) => {
        mode = form.get('intent') as 'wake' | 'shutdown';
      },
    });

    fireEvent.click(
      (await screen.findAllByRole('button', { name: '起動' }))[0]!,
    );
    expect(await screen.findByText('起動: 成功')).toBeDefined();

    fireEvent.click(
      (await screen.findAllByRole('button', { name: '停止' }))[0]!,
    );

    expect(await screen.findByText('停止: 失敗')).toBeDefined();
    expect(screen.queryByText('起動: 成功')).toBeNull();
  });

  test('画面を開いたまま実行した操作の結果が「最近の実行」に現れる（FR-02, FR-13）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const executed = record({
      at: '2026-01-02T03:04:05.000Z',
      target: { type: 'server', id: 'nas' },
      operation: 'wake',
      result: 'succeeded',
      code: null,
    });
    let history: ReadonlyArray<HistoryRecord> = [];
    renderDashboard(loaderData(), {
      history: () => ({ records: history }),
    });

    expect(screen.queryByText('まだ実行はありません。')).toBeDefined();

    history = [executed];
    await advanceUntil(() => screen.queryByText('結果: 成功') !== null);

    expect(screen.getByText('操作: 起動')).toBeDefined();
    expect(screen.queryByText('まだ実行はありません。')).toBeNull();
  });

  test('「最近の実行」の理由は利用者向け文言で出し、未知の分類は出さない（SEC-05）', async () => {
    renderDashboard(
      loaderData({
        recent: [
          record({ result: 'failed', code: 'operation_failed' }),
          record({
            at: '2026-01-01T00:00:00.000Z',
            result: 'failed',
            code: 'ssh_unavailable',
          }),
          record({
            at: '2026-01-01T00:00:01.000Z',
            result: 'skipped',
            code: 'busy',
          }),
          record({
            at: '2026-01-01T00:00:02.000Z',
            result: 'succeeded',
            code: null,
          }),
        ],
      }),
    );

    expect(
      await screen.findByText('理由: 実行中のためスキップしました'),
    ).toBeDefined();
    // 実行して失敗した操作の理由と、成功時の理由は出さない。
    expect(
      screen.queryByText(/operation_failed|ssh_unavailable|busy/),
    ).toBeNull();
  });
});
