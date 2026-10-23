/**
 * 予約実行器の load context キー（FR-12, t011 の接続口）。
 *
 * このモジュールは client ビルドからも型だけ参照される可能性があるため、
 * server-only の実装（`app/lib/schedule.server.ts`）へ直接依存しない。
 * 実体は `server/app.ts` が `ensureScheduleRunner()` で作り、
 * `context.set(scheduleRunnerContext, ...)` で載せる。
 *
 * production 以外では `null` を載せる。テスト・開発では予約を動かさないため、
 * 再読込の action も `null` のときは差し替えを行わない。
 */
import type { RouterContext } from 'react-router';

import { sharedRouterContext } from './context-registry.ts';

const scheduleRunnerContextSlot = '__powerManagerScheduleRunnerContext';

/** 予約実行器の load context キー。`server/app.ts` が実体（または `null`）を設定する。 */
export const scheduleRunnerContext: RouterContext<unknown> =
  sharedRouterContext<unknown>(scheduleRunnerContextSlot);
