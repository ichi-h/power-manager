# power-manager アーキテクチャ設計

本書は「どう実現するか（HOW）」を定義する。目的・要件は [要件定義](requirements.md) を参照する。認証・秘密情報の詳細は [セキュリティ設計](security.md)、配備・設定ファイル・CI は [運用設計](operations.md) に記す。

要件 ID（`FR-*`、`NFR-*`、`SEC-*`、`CON-*`）は [要件定義](requirements.md) のものを指す。技術選定を変更する場合、本書のみを更新すればよく、要件定義は変更しない。

## 1. 技術選定

| 領域                | 採用技術                                                    | 主な根拠                                                                                     | 関連要件               |
| ------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------- |
| 実行環境            | Node.js 24（LTS）                                           | 公式ドキュメント・本番 SSR 例・Nix パッケージングがいずれも Node 前提。UDP/TCP/子プロセスが標準 | NFR-03, NFR-07, SEC-05 |
| 言語                | TypeScript                                                  | 設定と外部入力を型で拘束できる                                                               | NFR-11                 |
| フレームワーク      | React Router 8（Framework Mode、SSR 有効）                  | 1 プロセスで画面とサーバー処理を両立。loader/action とリソースルートが公式に使える            | FR-07, FR-14, NFR-09   |
| ビルド              | Vite 7（React Router のビルド統合）                         | Framework Mode の標準。クライアント資産とサーバーバンドルを同時に生成                        | NFR-03                 |
| 画面                | React 19 + JSX                                              | 行単位の進行表示・部分更新をフレームワークの再検証機構で実現                                 | FR-07, FR-14           |
| スタイル            | Tailwind CSS 4（`@tailwindcss/vite`）                       | ユーティリティクラスで完結し、別途の CSS 設計やビルド工程を増やさない                       | NFR-11                 |
| 画面遷移            | クライアントサイドルーティング                              | ページ全体の再読み込みを廃止（要件の中心）                                                   | FR-14                  |
| 状態更新            | `fetcher.load()` によるリソースルートのポーリング            | ページ loader を再実行せず状態だけ更新する。`visibilitychange` で停止                        | FR-02, NFR-08          |
| 入力検証            | Zod                                                         | スキーマによる厳格な検証（未知項目の拒否を含む）                                             | FR-09                  |
| 設定形式            | JSON（ルートに `version: 2`、サーバー・グループ・予約）     | コメント不要の単純なデータ、宣言的配備との相性                                               | CON-07, FR-09          |
| 予約実行            | プロセス内スケジューラ（`setInterval` + 次回時刻計算）      | 外部スケジューラのユニット再生成を避け、busy スキップと結果表示を同一プロセスで扱う          | FR-12, FR-13, NFR-12   |
| 起動要求            | UDP ブロードキャスト（Magic Packet、`node:dgram`）          | 標準的で対象側に追加ソフト不要                                                               | FR-04                  |
| 停止                | OpenSSH クライアントを子プロセス実行                        | 対象側に常駐エージェントを置かず、既存の SSH 基盤を使う                                      | FR-05, SEC-06          |
| 死活確認            | TCP 接続（`node:net`、設定済みホスト・ポート）              | ICMP 権限やログイン認証を必要とせず、停止コマンド経路と同じ到達性を見られる                  | FR-03                  |
| 認証                | HTTP Basic + Argon2id（サーバーミドルウェアで一元化）       | 単一利用者に対して実装が最小。v8 の middleware は stable                                     | FR-10, SEC-01          |
| CSRF                | Origin 検証（`allowedActionOrigins` ＋ 明示ミドルウェア）   | フレームワークの内蔵保護を土台に、拒否挙動を自分で固定する                                   | SEC-03                 |
| テスト              | Vitest + `createRoutesStub`                                 | 公式のテスト例と一致し、Vite 設定と統合できる                                                | NFR-11                 |
| 配布                | Nix flake（`buildNpmPackage`）+ NixOS モジュール            | バージョン固定、ロールバック、systemd 連携。単一バイナリを要求しない                         | NFR-03, NFR-05, CON-04 |
| パッケージ管理      | npm（`package-lock.json`）                                  | `buildNpmPackage` が npm の lock を前提とするため                                              | NFR-03                 |
| CI                  | GitHub Actions                                              | PR と main で型検査・テスト・Nix ビルドを検証                                                | NFR-11                 |

### 1.1 不採用とした選択肢

| 選択肢                                  | 不採用の理由                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Hono + SSR テンプレート（旧構成）       | 操作ごとに全画面再読み込みが発生する。要件 FR-07 / FR-14 を満たせない                                            |
| Bun ランタイム                          | 単一バイナリ要件を外したため利点が薄い。Node 前提の一次情報・Nix 例が多く、二重サポートのコストに見合わない      |
| SPA モード（`ssr: false`）              | リクエスト時に走る API を持てない。状態更新と操作のサーバー処理が成立しない                                      |
| API-only モード（`ssr: "unstable_api-only"`） | v8.5.0 で導入された unstable 機能。認証・初期表示の安全性で SSR の利点も残したい                            |
| フロントとバックエンドの別サーバー      | 管理対象が 1 つ増え、CORS・認証・配備が二重化する                                                                |
| Next.js                                 | 画面は数画面で、App Router の機能（RSC、キャッシュ階層）に対して過剰                                             |
| htmx 等の HTML over the wire            | 行単位の進行表示と部分更新をフレームワークの再検証機構で書くほうが素直。依存も増えない                            |
| データベース                            | 永続状態を持たない要件（NFR-02）に反する                                                                         |
| 設定から systemd timer を生成           | 定義変更のたびにユニット再生成が必要で、busy スキップや結果表示をアプリ側で扱えない                              |
| 対象側エージェント（自作 API）          | 対象ごとに導入が必要になる。既存 SSH で代替できる                                                                |
| ICMP ping による死活確認                | raw socket 権限が必要で、SSH 到達性とも一致しない                                                                |
| Docker コンテナ配備                     | NixOS モジュール + systemd hardening で足り、NixOS との統合もよい                                                |
| CSS Modules・Sass などの別 CSS 基盤     | 画面数が少なくクラス設計の共有範囲が狭いため、ユーティリティクラスで十分。ビルド工程も増やさない                  |

## 2. 構成

```text
ブラウザ
  │ HTTPS / VPN（Tailscale）
  ▼
リバースプロキシ（Nginx：TLS 終端）
  │ loopback HTTP
  ▼
power-manager（Node.js 24 プロセス、専用 system user）
  ├── React Router 8 サーバーハンドラ（SSR + action + resource route）
  ├── プロセス内スケジューラ（予約の発火）
  ├── 実行結果リングバッファ（直近 100 件、メモリのみ）
  ├── 管理対象 JSON（起動時 + 明示再読込）
  ├── 環境変数（秘密情報・待受・Origin）
  ├── OpenSSH クライアント ── SSH ──> 管理対象
  └── UDP Magic Packet ────────────> 管理対象 LAN
```

アプリケーションは外向きに 3 種類の通信を行う。loopback での HTTP 待受、UDP ブロードキャスト、SSH/TCP の外向き接続である。内向きの受信はリバースプロキシからの loopback のみを想定する（NFR-04）。管理対象は同一 LAN 上にあり（CON-01）、外部からのアクセスは既存の VPN とリバースプロキシを経由する（CON-05）。

## 3. 実行モデル

### 3.1 プロセス構成

1 プロセス・1 ポート。React Router のサーバーハンドラが HTML・action・リソースルートのすべてを処理し、静的資産（`/assets/*`）も同じプロセスが配る。フロントエンド専用のサーバーは置かない。

### 3.2 起動シーケンス

1. `server/index.ts` が `server/startup.ts` の `startRuntime()` を呼び、環境変数を読み、Zod で検証する。1 つでも不正なら標準エラーへ `startup_failed` を 1 行出し、待受を開始せずに終了コード `78`（設定エラー）で終了する（NFR-06, NFR-05）。`server/app.ts` は検証済みの設定を受け取るだけで、環境変数は読まない。
2. 管理対象 JSON を読み、検証してメモリへ展開する。失敗時も終了コード `78` で終了する（FR-08, FR-09）。

設定不備以外の例外（実装の不具合・予期しない I/O 例外）は `78` で落とさない。`78` は `RestartPreventExitStatus` に指定してあり再起動されないため、ここで `78` を使うと再起動も失敗の記録も起きない無言死になる。`server/startup.ts` の `exitAfterStartupFailure` が例外の種別で分岐し、設定不備なら `78`（1 行は `startRuntime` が出力済み）、それ以外なら `startup_failed`（`code: "operation_failed"`、`reason` は例外の名前）を 1 行出して終了コード `1` で落とす（NFR-05, NFR-10）。
3. 実行結果リングバッファとスケジューラを初期化する。
4. `createRequestListener` で HTTP サーバーを組み立て、`127.0.0.1:$POWER_MANAGER_PORT` で待受を開始する。
5. 起動完了を構造化ログへ 1 行で出す。

`ssh` の存在確認は起動時に必須とせず、停止操作の実行時に `ssh_unavailable` として検出する。これは起動要件（NFR-06）を環境変数・設定 JSON の検証に限定し、パッケージマネージャが `PATH` を提供する配置（Nix）と、手動配置の両方を許容するためである。

終了コード `78` は NixOS モジュール側で `RestartPreventExitStatus` に指定し、再起動ループを防ぐ（NFR-05）。値の定義は `app/lib/exit-codes.ts` の `configurationErrorExitCode` に 1 つだけ置き、`server/index.ts` と `scripts/smoke.mjs` が同じ定数を import する（`nix/module.nix` はリテラルで持つため、コメントで対応を示す）。

### 3.3 サーバーエントリの形

`react-router build` は `build/client`（資産）と `build/server/index.js`（ルート定義・資産マニフェスト・`entry.module` を持つ ServerBuild）を出力する。これは HTTP リスナーではないため、自前のエントリでハンドラに変換する。

```ts
// server/index.ts（概略）
import { createServer } from "node:http";
import { createAppListener } from "./app.ts";
import { startRuntime } from "./startup.ts";

// 起動時に 1 度だけ検証する。設定不備は exit 78、それ以外の例外は exit 1。
const { runtime, configStore } = await startRuntime();
const listener = createAppListener(runtime, configStore);

const server = createServer(listener);
server.listen(runtime.port, "127.0.0.1");
```

```ts
// server/app.ts（概略）
export function createAppListener(runtime: RuntimeConfig, configStore: ConfigStore) {
  return createRequestListener({
    // ビルド成果物を読み込み、handleError と allowedActionOrigins を差し替える。
    build: () => loadServerBuild(runtime),
    mode: "production",
    getLoadContext: () => createLoadContext(runtime, configStore),
  });
}

export function createLoadContext(runtime: RuntimeConfig, configStore: ConfigStore) {
  const context = new RouterContextProvider();
  // 載せるのは公開値だけ。秘密値は認証ミドルウェアが runtime から直接読む。
  context.set(configContext, toPublicRuntimeConfig(runtime));
  context.set(configStoreContext, configStore);
  return context;
}
```

- `getLoadContext` は v8 では `RouterContextProvider` を返す（プレーンオブジェクトを返す例は v6/v7 のもの）。loader/action からは `context.get(configContext)` で参照する。
- すべての load context キーは `globalThis` の 1 スロットから取る。`react-router build` の成果物（`build/server/index.js`）と自前エントリのバンドルは別のモジュールグラフになり、モジュールスコープで `createContext()` すると同じ名前でも実体が 2 つになる。`RouterContextProvider` はキーをオブジェクト同一性で照合するため、実体が分かれると「No value found for context」で 500 になる。`app/lib/config.server.ts` の `configContext` が唯一の情報源で、loader/action は `requireRuntimeConfig(context)` 経由で読む（未設定なら配線不整合と分かるメッセージで失敗する）。キーの取得と生成は `app/lib/context-registry.ts` の `sharedRouterContext(slot)` に集約し、各モジュールはスロット名の定数だけを持つ（代入を式に埋めないため）。
- load context に載せるのは公開値（`PublicRuntimeConfig`）だけである。`authPasswordHash` などの秘密値は `AuthConfig` / `SshConfig` に分け、`server/app.ts` の `createLoadContext` が `toPublicRuntimeConfig` で絞り込む。load context は全 loader/action から到達できるため、秘密値を同じ型に同居させると各 loader の実装規律だけが防御になる（SEC-05）。`nodeEnv` は起動時の検証にだけ使い、ドメイン層の型・関数へは渡さない。
- 未捕捉の例外は `build.entry.module.handleError` を差し替えて処理する（7.1 の `request_failed`）。`createRequestListener` は `handleError` を受け付けないため、ビルドを浅くコピーして差し替える。
- 仮画面の `/` も loader で `requireRuntimeConfig` を呼ぶ。起動して 1 ページ返すだけで、2 つのモジュールグラフが同じキーを共有していることを確認できる（`npm run smoke` が本番ビルドに対して検証する）。
- ストリーミングは Web 標準の `ReadableStream` をそのまま流す。
- SIGTERM/SIGINT では `shutdown(signal)` が `server.close()` → スケジューラ停止 → リングバッファの書き出し（何もしない）→ `process.exit(0)` を進める。5 秒で強制終了するタイマーはその場で張り、`server.close()` の完了時に `clearTimeout` で解除する。起動時に張ると、正常に動いているプロセスが時間経過だけで落ちるため張らない。
- 開発時（`react-router dev`）は Vite がサーバーモジュールを再インポートするため、スケジューラはモジュールスコープのシングルトンで二重起動を防ぎ、`NODE_ENV !== "production"` では起動しない。

### 3.4 プロセス内状態

永続化しない。プロセス再起動で初期化される（NFR-02）。

- 有効な設定（`Server[]`、`Group[]`、`Schedule[]`）
- 対象別の実行中フラグ（電源操作の排他）
- 対象別の進行中死活確認 Promise（多重実行の抑止）
- 死活確認・一括操作の並列度を制御するセマフォ（上限 8、固定値）
- 実行結果リングバッファ（直近 100 件）
- 予約ごとの次回実行時刻

### 3.5 モジュール構成

| ファイル                     | 責務                                                                       |
| ---------------------------- | -------------------------------------------------------------------------- |
| `server/index.ts`            | HTTP サーバー生成、待受、シグナル処理、終了コード                         |
| `server/startup.ts`          | 起動時の設定読込みと、設定不備時の終了（終了コード 78）                    |
| `server/app.ts`              | `createRequestListener` の組立て、ビルド成果物の差し替え、load context     |
| `server/log.ts`              | リクエスト処理中の失敗の分類と 1 行ログ                                    |
| `server/static.ts`           | `build/client` の静的配信                                                  |
| `app/root.tsx`               | レイアウト、認証ミドルウェアの適用、エラーバウンダリ                       |
| `app/app.css`                | Tailwind CSS の読込みと、配色・フォントなどのテーマトークン定義            |
| `app/routes.ts`              | ルート定義                                                                 |
| `app/routes/dashboard.tsx`   | 一覧画面（loader で一覧と状態、action で単体・一括操作）                   |
| `app/routes/settings.tsx`    | 定義の表示と再読込（読み取り専用）                                         |
| `app/routes/api.status.ts`   | 状態取得のリソースルート（`GET /api/status`）                              |
| `app/routes/healthz.ts`      | `GET /healthz`。認証免除                                                  |
| `app/lib/auth.server.ts`     | Basic 認証の検証、ミドルウェア                                            |
| `app/lib/csrf.server.ts`     | Origin 検証ミドルウェア                                                    |
| `app/lib/config.server.ts`   | 環境変数スキーマと検証済み設定の型（`PublicRuntimeConfig` など）           |
| `app/lib/runtime-config.server.ts` | 管理対象 JSON のスキーマ、既定値の適用、集合内の一意性と相互参照の検証 |
| `app/lib/config-store.server.ts` | 有効設定の保持、原子的な再読込、load context への公開                   |
| `app/lib/model.ts`           | ドメイン型（`Server`、`Group`、`Schedule`、状態・操作・結果コード）        |
| `app/lib/power.server.ts`    | WOL 送信、SSH 停止、TCP 死活確認、排他制御、並列度制御                     |
| `app/lib/scheduler.server.ts`| 次回実行時刻の計算、発火、busy スキップ、実行結果の記録                   |
| `app/lib/history.server.ts`  | 直近 100 件のリングバッファ                                               |

外部依存は `react-router`、`@react-router/node`、`react`、`react-dom`、`zod`、`argon2`（Argon2id 検証）に限定する。UDP/TCP/子プロセスは `node:dgram`、`node:net`、`node:child_process` を使う。

設定の検証は 2 層に分ける。`app/lib/config.server.ts` が環境変数のスキーマと検証済み設定の型を持ち、`app/lib/runtime-config.server.ts` が管理対象 JSON のスキーマ（`version: 2`、未知項目の拒否、既定値の適用）と、集合内の一意性・相互参照の検証を持つ。`app/lib/model.ts` のドメイン型は、この検証を通過した値だけが満たす形で定義する。

`app/lib/config-store.server.ts` が有効設定の保持と再読込を担う。再読込は「読込み → 全体検証 → 成功時のみ参照の差し替え」の順で行い、失敗したときは旧設定を維持したまま理由と指摘を値として返す（FR-08、NFR-13）。例外にしないのは、再読込の失敗がエラーバウンダリではなく画面の結果表示に載る対象だからである（FR-07）。

起動時の準備物は `server/startup.ts` の `startRuntime()` が `{ runtime, configStore }` としてまとめて返し、`server/app.ts` の `createAppListener(runtime, configStore)` がそれを受け取る。`server/index.ts` の責務は待受とシグナル処理、終了コードに限定したままである。`invalid_configuration` は環境変数の検証失敗・管理対象 JSON の検証失敗・待受アドレスの使用不可で共用する。前 2 つは運用者が設定を直すまで同じ結果になるため再起動で解消せず、待受アドレスの使用不可も待受開始前の判定であり同じく再試行では進展しないため、区別せず同じ終了コード 78 に集約している。待受中の異常終了は別経路（`server: "error"` のログと終了コード 1）で扱う。

ビルド時のみ Tailwind CSS（`tailwindcss`、`@tailwindcss/vite`）を devDependency として使う。ビルド時に CSS を生成するだけで、実行時のサーバー依存は増えない。スタイルは各コンポーネントのユーティリティクラスに直接記述し、共通の配色・フォントだけを `app/app.css` の `@theme` で定義する。明暗の切り替えは `color-scheme` と CSS のシステム色（`Canvas` / `CanvasText`）に委ねる。

## 4. HTTP インターフェース

すべてのエンドポイントが認証を要求する（FR-10, SEC-01）。例外は `/healthz` のみ（SEC-10）。

| メソッド | パス                        | 種類           | 用途                                     | 応答                       |
| -------- | --------------------------- | -------------- | ---------------------------------------- | -------------------------- |
| `GET`    | `/`                         | 画面           | 一覧画面（SSR）                          | HTML                       |
| `GET`    | `/settings`                 | 画面           | 定義の表示                               | HTML                       |
| `GET`    | `/api/status`               | リソースルート | 全サーバーの死活状態                     | JSON                       |
| `POST`   | `/`（`intent=wake`）        | action         | 単体の起動                               | 進行中／結果の JSON or HTML |
| `POST`   | `/`（`intent=shutdown`）    | action         | 単体の停止                               | 同上                       |
| `POST`   | `/`（`intent=wake-group`）  | action         | グループまたは全台の起動                 | 同上                       |
| `POST`   | `/`（`intent=shutdown-group`） | action      | グループまたは全台の停止                 | 同上                       |
| `POST`   | `/settings`（`intent=reload`） | action      | 定義の再読込                             | 同上                       |
| `GET`    | `/healthz`                  | リソースルート | 死活監視（認証免除）                     | 固定文字列                 |

- 状態を変更する要求は `POST` のみとし、フォーム送信と `fetcher.submit()` の両方を受け付ける。
- action の応答は、リクエストの `Accept` に応じて JSON（`fetcher` 経由）または HTML（スクリプト無効時のフォーム送信）を返す。スクリプト無効時は従来どおり `303` で一覧へ戻す（NFR-09）。
- `/api/status` は UI 用の内部エンドポイントであり、外部自動化向けの公開 API ではない（要件 4.2）。応答は `application/json` のみとする。
- `/healthz` は `ok` の固定文字列のみを返し、構成・状態・バージョンを含めない（SEC-10）。
- CSRF は React Router 内蔵の `allowedActionOrigins` と、自前の Origin 完全一致ミドルウェアの二段で検証する（SEC-03）。`allowedActionOrigins` はビルド時の定数（`react-router.config.ts` では空配列）で、`server/app.ts` の `withAllowedActionOrigins` が読み込み時に `publicOriginHost` を 1 要素として差し込む。詳細は [セキュリティ設計](security.md)。

### 4.1 画面構成

`app/root.tsx` が共通レイアウトとエラーバウンダリを持ち、認証・CSRF ミドルウェアをここで適用する。

一覧画面（`/`）は次を含む。

- 全台一括の操作ボタン（起動・停止）
- グループごとの見出しとグループ一括ボタン
- サーバーごとの行（表示名、所属グループ、状態、単体の起動・停止ボタン、行内の進行表示と結果）
- 「最近の実行」欄（直近 100 件）

停止は `useSubmit` の前に確認ダイアログを出し、拒否時は送信しない（FR-05, SEC-07）。一括停止では対象サーバーの表示名を列挙した 1 回の確認とする。

一括操作のボタンと結果表示は `BatchControls`（`app/routes/dashboard.tsx`）が担い、全台一括とグループ一括で共通に使う。完了後は対象ごとの結果と要約を、ボタンの直下に出す。

### 4.2 部分更新と進行表示

- 操作は `fetcher.submit()` で action を呼ぶ。`fetcher.state` が `submitting`/`loading` の間、対象行に「実行中」を表示する（FR-07）。
- 完了後は `fetcher.data`（対象ごとの結果）を行内に表示する。ページ全体の再読み込みも URL の変更も起きない。
- 状態の自動更新は `setInterval` から `fetcher.load("/api/status")` を呼び、返却された状態だけを行に反映する。ページ loader は再実行しない（`useRevalidator` は使わない）。
- `document.visibilityState` が `hidden` の間はタイマーを止め、`visible` に戻った時点で即座に 1 回読み込む（FR-02）。
- 応答が `4xx`/`5xx` またはネットワーク失敗のときは表示を変えず、次周期で再試行する。

### 4.3 スクリプト無効時

React Router はスクリプト無効時に通常のフォーム送信として action を実行する。この場合 action は `303` で `/?result=...&target=...` へ戻り、一覧画面がクエリから結果表示を組み立てる。操作の再実行は起きない（Post/Redirect/Get）。スクリプト無効時は自動更新も行われない（NFR-09 が許容する範囲）。

## 5. 死活確認の実装

- 各対象の `ssh.host` と `ssh.port` へ TCP 接続し、接続成立で `online`、失敗で `offline` とする（FR-03）。確認結果が未取得の初期状態は `unknown` とする。
- 1 件あたりの上限は 5 秒（NFR-07）。タイムアウトも `offline` として扱う。
- 全対象を並列に確認するが、同時実行数は 8 で固定する。コード上の定数として持ち、環境変数などで外部から変更する設定項目は設けない（NFR-08）。
- 対象 ID ごとに進行中 Promise を保持し、同時要求はその Promise を共有する。複数タブ・手動更新・自動更新が重なっても、同一対象への TCP 接続は 1 本に抑える（NFR-08）。
- 完了時に Promise を破棄するため、未完了の確認が次周期に重複登録されることはない。

## 6. 電源操作の実装

### 6.1 単体操作

1. 対象 ID の実行中フラグを立てる（既に立っていれば `busy`）。
2. 起動なら UDP Magic Packet を送信し、停止なら SSH で停止コマンドを実行する。
3. 結果をリングバッファへ記録し、フラグを下ろす。

### 6.2 起動（WOL）

1. MAC アドレスを 6 バイトに分解し、`0xFF` × 6 + MAC × 16 の 102 バイトを組み立てる。
2. UDP ソケットを ephemeral ポートで開き、`wol.broadcastAddress:wol.port` へ送信する。
3. 送信 API が成功した時点で成功とする（FR-04）。上限 5 秒（NFR-07）。

### 6.3 停止（SSH）

`ssh` を子プロセスとして実行する。シェルを介した文字列連結はせず、引数を配列で渡す。

```text
ssh -i <identityFile>
    -o BatchMode=yes
    -o StrictHostKeyChecking=yes
    -o UserKnownHostsFile=<knownHostsFile>
    -p <ssh.port>
    <ssh.user>@<ssh.host>
    <ssh.shutdownCommand>
```

- `BatchMode=yes` でパスワード入力待ちをさせない。
- ホスト鍵検証を必須にし、`known_hosts` を明示する。
- 停止コマンドは配列の 1 引数として渡し、ローカルシェルで解釈させない。
- 終了コード `0` を成功条件とする（FR-05）。上限 30 秒（NFR-07）。
- `ssh` が見つからない場合は操作せず `ssh_unavailable` として扱う。

### 6.4 排他制御と一括操作

対象 ID ごとの実行中フラグで電源操作を排他する（FR-06）。実行中の対象への操作は `busy` として扱い、結果表示では「実行中（拒否）」と区別する。フラグはメモリ上のみで、プロセス再起動で消える（NFR-02）。

一括操作は対象サーバーの集合を確定したうえで、並列度 8 のセマフォを通して単体操作を実行する。

- 実行中フラグが立っているサーバーは対象から除外し、`skipped`（理由 `busy`）として結果に含める。残りのサーバーは継続する。
- 結果は `{ target, result, code }` の配列と、`{ ok, failed, skipped }` の要約を返す。画面には「n 件成功 / m 件失敗 / k 件スキップ」として出す。
- 対象集合の確定は `resolveBatchTargets`（`app/lib/power.server.ts`）が担う。全台（`all`）またはグループ ID を受け取り、サーバー ID で重複排除する。同じサーバーが複数グループに所属しても実行は 1 回である。
- action は `intent=wake-group` / `intent=shutdown-group` と、種別を分けた対象範囲 `scopeKind`（`all` または `group`）と `scopeId`（グループ ID）を受ける。`scopeKind=group` では `scopeId` を必須とし、`scopeKind=all` では `scopeId` を無視する。種別を分けるのは、グループ ID に `all` という文字列を定義でき、`scope` 1 つでは全台一括と衝突するためである。グループ ID は `all` を含め任意の文字列を許し、予約語を設けない。未知のグループ ID と対象 0 台は `400` とし、操作しない。
- 一括の `busy` は単体操作の「実行中（拒否）」と区別し、「スキップ」として表示する（対象から外したため）。busy の対象も確認の列挙に含める（表示名で確認した集合と、結果の集合を一致させるため）。
- 一括停止の画面は、確認ダイアログに列挙した対象の ID を `confirmed`（カンマ区切り）として送る。action は確定した集合と照合し、一致しなければ操作せず `409`（`error=targets_changed`）を返す。確認のあとに設定が再読込されて対象が変わっても、利用者が承認していないサーバーを停止しないためである（SEC-07）。`confirmed` の無い要求（確認を挟まない起動）は照合しない。
- 部分失敗を全体の失敗に読み替えない（FR-11）。電源操作にトランザクションは無い。実行単位が reject した場合も、その対象を `failed`（`operation_failed`）として結果に含め、他の対象の結果と要約は失わない。
- 同時実行数の上限（8）は、単体操作・一括操作・予約実行で 1 つのセマフォを共有する（NFR-07, NFR-08）。待機から起床した操作は、解放側が持っていた枠をそのまま引き継ぐ（起床側で数を増やさない）。起床側で増やすと、起床待ちの間に新しい操作が枠を取って上限を超える。

### 6.5 予約実行

スケジューラは 1 秒間隔で「次回実行時刻を過ぎた予約」を探す。

- 次回実行時刻は、定義（毎日／毎週＋時刻）と現在時刻から Asia/Tokyo 固定で計算する。常に「現在時刻より後」の直近の時刻とする（FR-12, CON-08）。
- 発火時、対象サーバーが実行中なら `busy` としてスキップし、結果に理由を残す。待たない（FR-12）。
- 実行開始が指定時刻から 10 秒を超えた場合はその回をスキップしてログに記録し、次回時刻を再計算する（NFR-12）。これはプロセスの停止・負荷・時刻の巻き戻しで「過去分をまとめて実行する」事故を防ぐためである。
- 設定の再読込時は、新しい定義から全予約の次回時刻を再計算し、スケジューラの状態を原子的に差し替える（FR-08, NFR-13）。差し替えは実行中の操作を中断しない。
- 予約の実行も単体操作・一括操作と同じ排他制御とリングバッファを共有する。

### 6.6 実行結果の保持

メモリ上のリングバッファに直近 100 件を保持する（FR-13）。要素は `{ at, scheduleId?, target, operation, result, code }`。再起動で空になることを許容し、恒久記録は journald に委ねる。

## 7. エラー分類

| コード                  | 発生条件                                  | HTTP/表示上の扱い                             |
| ----------------------- | ----------------------------------------- | --------------------------------------------- |
| `invalid_configuration` | 環境変数の検証失敗、管理対象 JSON の検証失敗、待受アドレスの使用不可 | 起動中止（終了コード 78）／再読込は旧設定維持 |
| `ssh_unavailable`       | `ssh` 実行ファイルが見つからない          | 操作失敗                                      |
| `operation_failed`      | タイムアウト、コマンド異常終了            | 操作失敗                                      |
| `busy`                  | 同一対象の電源操作が実行中                | 拒否（実行中）／予約はスキップ                |
| `missed_schedule`       | 予約時刻から 10 秒を超えて発火が遅れた    | スキップ（ログのみ、画面には理由を表示）      |

内部エラーの詳細はログにのみ出し、画面には結果種別と対象 ID だけを出す（FR-07, SEC-05）。

### 7.1 ログ出力

標準出力・標準エラーへ 1 行 1 JSON の構造化ログを出す。ファイルへは書かない（NFR-10）。

| イベント          | 主なフィールド                                                    |
| ----------------- | ----------------------------------------------------------------- |
| `started`         | `port`                                                            |
| `startup_failed`  | `code`（`invalid_configuration` / `operation_failed`）、`reason`  |
| `shutdown`        | `signal`                                                          |
| `power_operation` | `serverId`、`operation`、`result`、`code`、`group`（一括時）      |
| `schedule_run`    | `scheduleId`、`target`、`operation`、`result`、`code`             |
| `schedule_skip`   | `scheduleId`、`target`、`operation`、`code`（`busy` / `missed_schedule` / `invalid_configuration`） |
| `config_reload`   | `result`、`reason`（失敗時）、`schedules`（再計算した予約数）     |
| `request_failed`  | `code`（`csrf_rejected` / `request_rejected` / `internal_error`）、`reason` |

`request_failed` はリクエスト処理中の失敗（action の Origin 不一致、静的配信の失敗、未捕捉の例外）を 1 行で記録する。`code` は `csrf_rejected`（Origin 不一致）/ `request_rejected`（Origin ヘッダーの解釈失敗、404・405 など想定内の拒否）/ `internal_error`（未捕捉の例外）に分ける。`reason` は例外メッセージを 1 行に潰して 200 文字で切り詰めたもので、スタックトレースは出さない。React Router が投げる `ErrorResponseImpl`（404・405 など）は `Error` でも `Response` でもないため、`status` の有無で判定して `status 405` のような短い理由にする。React Router の既定のハンドラは `console.error(error)` でスタックを複数行に出すため、`server/app.ts` の `withErrorHandler` が `build.entry.module.handleError` を差し替えている。`createRequestListener` に `mode: "production"` を明示するのも、開発用のエラー表示を残さないためである。

`Authorization`、パスワード、ハッシュ、秘密鍵、停止コマンドの内容、環境変数値は出力しない（SEC-05）。ログの保持期間と保存先はホストのログ収集機構に委ねる。

## 8. ビルドと配備

### 8.1 ビルド成果物

```text
build/
  client/           # ハッシュ付き資産。1 年キャッシュ可
  server/index.js   # ServerBuild（ハンドラではない）
server/index.js     # 自前エントリ。scripts/bundle-server.mjs が server/index.ts から生成する単一バンドル
```

`server/index.js` は `npm run build` の後半で `scripts/bundle-server.mjs`（esbuild）が生成する。`server/index.ts` は `app/lib/config.server.ts` などアプリ側の TypeScript を相対 import するため、ソースツリーを配置しない Nix パッケージでは `ERR_MODULE_NOT_FOUND` になる。自前のソースだけを 1 ファイルに畳み、実行時依存を `node_modules` と `build/` に限る。依存パッケージは external のまま残す（`argon2` のネイティブバインディングと、`build/server/index.js` を動的 import する `react-router` の解決経路を壊さないため）。

`server/static.ts` が `import.meta.url` からの相対パスで `../build/client` を解決するため、バンドルの出力先は `server/index.js`（`server/` 直下）でなければならない。生成物は `.gitignore` の対象で、リポジトリには含めない。

Nix パッケージでは、ビルド済みの `build/` と `server/index.js` を `$out/share/power-manager` に置き、`makeWrapper` で `node` を起動するラッパーを `$out/bin/power-manager` に作る。`--chdir` で作業ディレクトリを固定し、`build/client` の静的配信が相対パスで解決できるようにする。`node_modules` は本番依存のみを残す（`npm ci --omit=dev`）。

### 8.2 Nix

- `buildNpmPackage` を使い、`npmDepsHash` を固定する。ネットワークに依存しないビルド（NFR-03）。
- ビルド中に `npm run build`（`react-router build`）を実行する。
- `x86_64-linux` と `aarch64-linux` の両方を `forAllSystems` で提供する。
- 詳細な derivation とモジュールは [運用設計](operations.md) に記す。

### 8.3 systemd

- `ProtectSystem = "strict"`、`ProtectHome = true`、`PrivateTmp = true` を維持する。アプリケーションは実行時にファイルを書かないため `StateDirectory` は要求しない。
- 待受は `127.0.0.1` に固定し、`POWER_MANAGER_PORT` で受ける。
- `Restart = "on-failure"`、`RestartPreventExitStatus = [ 78 ]`。

## 9. 要件との対応

| 要件                 | 実現箇所                                                         |
| -------------------- | ---------------------------------------------------------------- |
| FR-01, FR-03         | 一覧画面 SSR、`/api/status`、TCP 死活確認                        |
| FR-02                | 15 秒間隔の `fetcher.load("/api/status")`、`visibilitychange`     |
| FR-04                | UDP Magic Packet 送信                                            |
| FR-05                | SSH 子プロセス実行、確認ダイアログ                                |
| FR-06                | 対象別実行中フラグ、一括時の `busy` スキップ                      |
| FR-07, FR-14         | `fetcher.submit()` + action、クライアントサイドルーティング       |
| FR-08, FR-09         | Zod による検証、検証成功後のみ差し替え                            |
| FR-10, SEC-01        | root の認証ミドルウェア（`/healthz` のみ免除）                    |
| FR-11                | グループ一括・全台一括、並列度 8、部分失敗の許容                  |
| FR-12, NFR-12        | プロセス内スケジューラ、次回時刻計算、`busy` スキップ             |
| FR-13                | 直近 100 件のリングバッファ                                      |
| NFR-02               | 永続ストレージを持たないプロセス内状態                            |
| NFR-03, NFR-05       | Node 24、`buildNpmPackage`、NixOS モジュール、systemd             |
| NFR-07               | 各操作のタイムアウト                                              |
| NFR-08               | セマフォ + 対象別 Promise 共有                                   |
| NFR-09               | スクリプト無効時のフォーム送信 + `303`                            |
| NFR-10               | 標準出力・標準エラーへの構造化ログ（7.1）                         |
| NFR-11               | Vitest + `createRoutesStub`、ドキュメント分離                     |
| NFR-13               | 再読込時のスケジューラ原子的差し替え                              |

## 10. 見直し候補

技術選定の再検討時に最初に問うべき点。いずれも本書と実装の変更で完結し、要件定義には影響しない。

| 論点             | 現状                              | 見直しの条件・代替案                                                                 |
| ---------------- | --------------------------------- | ------------------------------------------------------------------------------------ |
| ランタイム       | Node.js 24                        | 単一バイナリ配布が再び必要になった場合、Bun の本番 SSR 対応状況を再評価する          |
| レンダリング方式 | SSR（`ssr: true`）                | `ssr: "unstable_api-only"` が stable になったら、SPA シェル + API の構成を検討       |
| 状態更新         | 15 秒ポーリング                   | 即時性が必要になったら SSE（リソースルートでストリーム）へ                             |
| 予約の定義       | 毎日／毎週のみ                    | 単発実行や cron 式が必要になったら定義形式の拡張を検討                               |
| 予約の永続性     | メモリのみ（取りこぼしは実行しない） | 「停止中に逃した予約を後から実行したい」要求が出たら永続カーソルを検討               |
| 認証             | HTTP Basic                        | 多要素認証や複数利用者、ログアウトが必要になった時点でセッション方式へ変更           |
| 定義の編集       | ファイルのみ（UI は読み取り専用） | UI からの編集が必要になったら、状態の永続化と Nix 管理との整合を先に設計する         |
| 停止手段         | SSH + 固定コマンド                | 対象が SSH を持たない場合は、対象側 API または BMC/IPMI 連携を検討                   |
| 死活確認の意味   | TCP 接続成立                      | SSH デーモン停止＝電源断とみなせない構成では、ping やエージェント方式を検討           |
| WOL の到達範囲   | 単一ブロードキャストアドレス      | VLAN 分割やルータ越えが必要になった場合は directed broadcast / リレーを検討           |
| 設定の反映       | 明示的な再読込操作                | 変更検知による自動反映が必要になった場合、ファイル監視を追加                         |
