/**
 * 停止の確認ページ（FR-05, FR-11, SEC-07, NFR-09）。
 *
 * 破壊的操作である停止は、実行前に必ず 1 段の確認を挟む。確認をダイアログ（`window.confirm`）
 * だけで行うと、スクリプトが無効な環境ではダイアログが出ないまま操作が実行される。
 * そこで確認を独立した画面にし、対象の表示名を列挙したうえで、確認済みの値
 * （`CONFIRM_INTENT`）を持つ送信ボタンだけが一覧画面の action へ停止を届ける。
 *
 * この画面は操作を実行しない。`loader` は対象の表示名を引くだけで、`action` は持たない
 * （確認ページのフォームは一覧画面の action へ直接 POST する）。
 */
import { Form, Link } from 'react-router';

import type { Route } from './+types/confirm';
import { requireConfigStore } from '../lib/config-store.server.ts';
import type { BatchOperationScope } from '../lib/power.server.ts';
import { resolveBatchTargets } from '../lib/power.server.ts';
import { CONFIRM_INTENT } from '../lib/confirm.ts';

export function meta(_args: Route.MetaArgs) {
  return [{ title: '停止の確認 - power-manager' }];
}

/** 確認ページの対象範囲と、そこに含まれるサーバーの表示名。 */
export type ConfirmLoaderData =
  | {
      readonly kind: 'server';
      readonly intent: 'shutdown';
      readonly target: { readonly id: string; readonly name: string };
    }
  | {
      readonly kind: 'batch';
      readonly intent: 'shutdown-group';
      readonly scope: BatchOperationScope;
      readonly targets: ReadonlyArray<{
        readonly id: string;
        readonly name: string;
      }>;
    };

/**
 * 確認ページの loader。
 *
 * 対象はクエリから読み直す。定義の再読込で内容が変わっていれば、ここに出る一覧が
 * 変わる（利用者が見る前に古い集合を確定させない）。定義に無い対象は確認できないため、
 * 一覧画面へ戻す。
 */
export function loader({ context, request }: Route.LoaderArgs): ConfirmLoaderData {
  const config = requireConfigStore(context).current();
  const params = new URL(request.url).searchParams;
  const kind = params.get('kind');

  if (kind === 'server') {
    const id = params.get('target');
    const server = config.servers.find((candidate) => candidate.id === id);
    if (server === undefined) throw redirectToDashboard();
    return {
      kind: 'server',
      intent: 'shutdown',
      target: { id: server.id, name: server.name },
    };
  }

  if (kind === 'batch') {
    const rawScopeKind = params.get('scopeKind');
    const rawScopeId = params.get('scopeId');
    let scope: BatchOperationScope;
    if (rawScopeKind === 'all') {
      scope = { type: 'all' };
    } else if (rawScopeKind === 'group' && typeof rawScopeId === 'string') {
      if (!config.groups.some((group) => group.id === rawScopeId)) {
        throw redirectToDashboard();
      }
      scope = { type: 'group', id: rawScopeId };
    } else {
      throw redirectToDashboard();
    }

    const targets = resolveBatchTargets(config.servers, scope);
    if (targets.length === 0) throw redirectToDashboard();
    return {
      kind: 'batch',
      intent: 'shutdown-group',
      scope,
      targets: targets.map((server) => ({
        id: server.id,
        name: server.name,
      })),
    };
  }

  throw redirectToDashboard();
}

/** 確認できない対象（定義から消えた・未知の範囲）では一覧へ戻す。 */
function redirectToDashboard(): Response {
  return new Response(null, {
    status: 303,
    headers: { location: '/', 'cache-control': 'no-store' },
  });
}

/**
 * 確認ページの本体。
 *
 * 確認済みの値（`CONFIRM_INTENT`）を送る送信ボタンと、送信しない取り消しのリンクだけを置く。
 * 対象 ID は action が確定した集合と照合するため、そのまま hidden で送る。
 */
export default function Confirm({ loaderData }: Route.ComponentProps) {
  const names =
    loaderData.kind === 'server'
      ? [loaderData.target.name]
      : loaderData.targets.map((target) => target.name);
  const confirmed =
    loaderData.kind === 'server'
      ? loaderData.target.id
      : loaderData.targets.map((target) => target.id).join(',');

  return (
    <section>
      <h2>停止の確認</h2>
      {/* 対象の表示名を列挙する（FR-11, SEC-07）。 */}
      <p>次のサーバーを停止します。よろしいですか。</p>
      <ul>
        {names.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
      <Form method="post" action="/">
        <input type="hidden" name="intent" value={loaderData.intent} />
        {loaderData.kind === 'server' ? (
          <input type="hidden" name="target" value={loaderData.target.id} />
        ) : (
          <>
            <input
              type="hidden"
              name="scopeKind"
              value={loaderData.scope.type === 'all' ? 'all' : 'group'}
            />
            {loaderData.scope.type === 'group' ? (
              <input
                type="hidden"
                name="scopeId"
                value={loaderData.scope.id}
              />
            ) : null}
          </>
        )}
        {/* 確認した対象を送り、action 側で確定した集合と照合させる（SEC-07）。 */}
        <input type="hidden" name="confirmed" value={confirmed} />
        <button type="submit" name="confirmedIntent" value={CONFIRM_INTENT}>
          停止する
        </button>
      </Form>
      <Link to="/">取り消す</Link>
    </section>
  );
}
