/**
 * 電源操作器の load context キー（FR-04〜FR-06, FR-11）。
 *
 * このモジュールは client ビルドからも型だけ参照される可能性があるため、
 * server-only の実装（`app/lib/power.server.ts`）へ直接依存しない。
 * 実体は `server/app.ts` が `createPowerOperator()` で作り、
 * `context.set(operatorContext, ...)` で載せる。
 */
import { createContext, type RouterContext } from 'react-router';

import type { PowerOperator } from './power.server.ts';

const operatorContextSlot = '__powerManagerOperatorContext';

type OperatorContextRegistry = {
  [operatorContextSlot]?: RouterContext<PowerOperator>;
};

const operatorContextRegistry =
  globalThis as unknown as OperatorContextRegistry;

/** 電源操作器の load context キー。`server/app.ts` が実体を設定する。 */
export const operatorContext: RouterContext<PowerOperator> =
  (operatorContextRegistry[operatorContextSlot] ??=
    createContext<PowerOperator>());
