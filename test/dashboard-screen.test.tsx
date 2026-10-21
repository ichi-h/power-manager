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
  type DashboardLoaderData,
  type OperationResult,
} from '../app/routes/dashboard.tsx';
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
    ...overrides,
  };
}

function record(
  overrides: Partial<PowerOperationRecord> = {},
): PowerOperationRecord {
  return {
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
    action?: () => OperationResult | Response;
    onStatusLoad?: () => void;
    onAction?: (formData: FormData) => void;
    statusStates?: Record<string, string>;
  } = {},
) {
  const Stub = createRoutesStub([
    {
      path: '/',
      Component: Dashboard,
      loader: () => data,
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

/** 疑似タイマーを 1ms ずつ進め、条件が満たされるまで待つ（上限 1 秒）。 */
async function advanceUntil(done: () => boolean) {
  for (let elapsed = 0; elapsed < 1_000 && !done(); elapsed += 1) {
    await advance(1);
  }
}

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
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
    expect(screen.getByText('理由: operation_failed')).toBeDefined();
    expect(screen.getByText('理由: なし')).toBeDefined();
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
        }) as unknown as OperationResult,
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

describe('状態の自動更新', () => {
  test('間隔は 15 秒で固定する（FR-02）', () => {
    expect(statusRefreshIntervalMs).toBe(15_000);
  });

  test('表示直後に 1 回取得し、15 秒ごとに繰り返す', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onStatusLoad = vi.fn();
    renderDashboard(loaderData(), { onStatusLoad });

    await advanceUntil(() => onStatusLoad.mock.calls.length === 1);
    expect(onStatusLoad).toHaveBeenCalledTimes(1);

    // 間隔の直前では追加の取得をしない。
    await advance(statusRefreshIntervalMs - 1);
    expect(onStatusLoad).toHaveBeenCalledTimes(1);

    await advance(1);
    await advanceUntil(() => onStatusLoad.mock.calls.length === 2);
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
    await advanceUntil(() => onStatusLoad.mock.calls.length === 1);
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
          // 5xx は本文を返さない。画面側は応答を状態として解釈できず、表示を変えない。
          return new Response('boom', { status: 500 });
        },
      },
    ]);
    const { container } = render(<Stub initialEntries={['/']} />);

    await advanceUntil(() => calls === 1);
    expect(calls).toBe(1);
    // 失敗しても初期状態の表示が残る。
    expect(container.textContent).toContain('状態: オンライン');

    await advance(statusRefreshIntervalMs);
    await advanceUntil(() => calls === 2);
    expect(calls).toBe(2);
  });
});
