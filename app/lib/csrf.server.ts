/**
 * CSRF 対策の自前 Origin 検証ミドルウェア（SEC-03, `docs/security.md` 3 章）。
 *
 * 状態を変更するメソッド（POST/PUT/PATCH/DELETE）について、`Origin` ヘッダーが
 * `POWER_MANAGER_PUBLIC_ORIGIN` と完全一致することを要求する。
 *
 * - `Origin` の欠落も拒否する。
 * - `Referer` は判定に使わない（パス・クエリの差異で判定が揺れるため）。
 * - React Router 内蔵の `allowedActionOrigins` は多重防御の第 1 段であり、
 *   拒否時のステータスとログを自分で固定するためにこの第 2 段を置く。
 *
 * `publicOrigin` はビルド成果物に埋め込めないため、初回の要求で環境変数から読む。
 * `GET`/`HEAD`/`OPTIONS` はこのミドルウェアの対象外にする。
 */
import { loadRuntimeConfig } from './config.server.ts';
import type { Route } from '../+types/root';

/** 検証対象とする状態変更メソッド。 */
const stateChangingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * 検証済みの `publicOrigin`。初回の要求で評価する。
 *
 * テストからのみキャッシュを消す（`app/lib/auth.server.ts` と同じ理由）。
 */
let publicOrigin: string | undefined;

function ensurePublicOrigin(): string {
  publicOrigin ??= loadRuntimeConfig().publicOrigin;
  return publicOrigin;
}

/** テスト用: `publicOrigin` の cache を消す。本番コードからは呼ばない。 */
export function __resetPublicOriginCache(): void {
  publicOrigin = undefined;
}

/** Origin 不一致・欠落の 403 応答。 */
function forbidden(): Response {
  return new Response('Forbidden', { status: 403 });
}

/**
 * 状態変更要求の `Origin` ヘッダーを検証する。
 * 一致なら `true`、不一致・欠落なら `false`。
 */
export function isOriginAllowed(
  request: Request,
  origin: string = ensurePublicOrigin(),
): boolean {
  if (!stateChangingMethods.has(request.method)) return true;
  return request.headers.get('origin') === origin;
}

/**
 * CSRF Origin 検証ミドルウェア。
 *
 * root に `authMiddleware` と並べて適用される（`app/root.tsx`）。
 * `GET` 等はそのまま通し、状態変更メソッドだけ `Origin` の完全一致を要求する。
 */
export const csrfMiddleware: Route.MiddlewareFunction = ({ request }, next) => {
  if (!isOriginAllowed(request)) return Promise.resolve(forbidden());
  return next();
};
