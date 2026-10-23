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
import type { ManagedConfig } from './model.ts';

const scheduleRunnerContextSlot = '__powerManagerScheduleRunnerContext';

/**
 * 再読込の action が予約実行器に求める操作だけを表す。
 *
 * `app/lib/schedule.server.ts`（server-only）の `ScheduleRunner` へ型で依存すると、
 * このモジュールが client ビルドへ引き込まれる可能性がある。必要な部分だけを写し、
 * 実体（`ScheduleRunner`）はこの形を満たすため構造的に代入できる。
 */
export type SchedulePlanReplacer = {
  /** 計画を原子的に差し替える（j004）。 */
  replacePlans(config: ManagedConfig): void;
  /** 差し替え後の計画。件数を数えるために読む。 */
  plans(): ReadonlyArray<unknown>;
};

/** 予約実行器の load context キー。`server/app.ts` が実体（または `null`）を設定する。 */
export const scheduleRunnerContext: RouterContext<SchedulePlanReplacer | null> =
  sharedRouterContext<SchedulePlanReplacer | null>(
    scheduleRunnerContextSlot,
  );

/** `RouterContextProvider` のうち `requireScheduleRunner` が使う部分。 */
type RouterContextProviderLike = { get: <T>(key: RouterContext<T>) => T };

/**
 * load context から予約実行器を読む。production 以外では `null` が返る（予約を動かさない）。
 *
 * 差し替えの成否に関わる値なので、未設定（配線不整合）は例外にして `null` と区別する。
 */
export function requireScheduleRunner(
  context: RouterContextProviderLike,
): SchedulePlanReplacer | null {
  try {
    return context.get(scheduleRunnerContext);
  } catch {
    throw new Error(
      '予約実行器が load context にありません（server/app.ts の createLoadContext を経由していません）',
    );
  }
}
