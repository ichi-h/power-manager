# power-manager

ホームラボ内のサーバーを、Tailscale 配下の Nginx から起動・停止・死活確認する個人用アプリケーションです。複数台の一括操作と、時刻を指定した予約実行に対応します。アプリケーション本体は loopback でのみ待ち受けます。

画面とサーバー処理は 1 つの Node.js プロセス（React Router 8 Framework Mode、SSR）が提供します。操作してもページ全体は再読み込みされません。

## ドキュメント

- [要件定義](docs/requirements.md) — 目的・完成像・機能/非機能/セキュリティ要件
- [アーキテクチャ設計](docs/architecture.md) — 技術選定とその根拠、構成、実装方針
- [セキュリティ設計](docs/security.md) — 認証・CSRF・秘密情報・プロセス権限
- [運用設計](docs/operations.md) — 設定JSON・NixOS 配備・CI・テスト
- [手動受け入れ記録用紙](docs/acceptance-record.md) — ホームラボでの受け入れ確認の記録

## 開発

Node.js 24 を使います。Bun は使いません。

```sh
npm ci
npm run dev          # 開発サーバー（Vite、127.0.0.1:5173）
npm run typecheck    # react-router typegen && tsc --noEmit
npm run test         # Vitest
npm run build        # react-router build + サーバーエントリのバンドル（server/index.js）
npm run start        # ビルド成果物を Node.js で起動
npm run smoke        # build 後に起動と HTML 応答を確認
```

### 開発サーバーの起動手順

`npm run dev` は環境変数がすべて揃っていないと起動時に終了コード `78` で止まります。ローカルでは次の 2 つを用意します。

1. 管理対象設定は同梱の `dev/config.json` を使います（既定値の適用例と daily / weekly の予約入り）。
2. 環境変数は `.example.envrc` を雛形に `.envrc` などへ置きます。最低限、次の値を設定してください。

```sh
export NODE_ENV=development
export POWER_MANAGER_CONFIG_PATH="$PWD/dev/config.json"
export POWER_MANAGER_PORT=5173
export POWER_MANAGER_PUBLIC_ORIGIN="http://localhost:5173"
export POWER_MANAGER_AUTH_USERNAME=admin
export POWER_MANAGER_AUTH_PASSWORD_HASH='$argon2id$...'   # 下記の手順で生成
export POWER_MANAGER_SSH_IDENTITY_FILE="$PWD/.local/dev_ssh_key"
export POWER_MANAGER_SSH_KNOWN_HOSTS_FILE="$PWD/.local/known_hosts"
```

- `POWER_MANAGER_SSH_*` は開発中は実在する通常ファイル（例: `package.json`）でも構いません。起動時の検証はパスの形式だけを見ます。
- `POWER_MANAGER_PUBLIC_ORIGIN` は開発時のみ `localhost` の HTTP Origin を許可します（`http://127.0.0.1:5173` は不可）。
- パスワードハッシュはアプリケーションでは生成しません。次のように作ります。

```sh
echo -n 'パスワード' | argon2 "$(head -c16 /dev/urandom | base64)" -id -e
```

起動すると `http://localhost:5173` で待ち受け、画面は Basic 認証を求めます（未認証は 401）。`/healthz` だけは認証なしで `ok` を返します。

```sh
curl -i http://localhost:5173/          # 401 + WWW-Authenticate
curl -i http://localhost:5173/healthz   # 200 ok
```

画面は React Router 8 の Framework Mode（SSR）で実装し、`app/` に画面とルート定義、`server/` に HTTP サーバーのエントリを置きます。

スタイルは Tailwind CSS 4 のユーティリティクラスを JSX に直接記述し、配色・フォントなどの共通トークンだけを `app/app.css` の `@theme` で定義します。

## 設定

起動には次の環境変数がすべて必要です。秘密値は環境ファイルに置き、リポジトリへ追加しないでください。

```ini
POWER_MANAGER_CONFIG_PATH=/etc/power-manager/config.json
POWER_MANAGER_PORT=8080
POWER_MANAGER_PUBLIC_ORIGIN=https://power.example.ts.net
POWER_MANAGER_AUTH_USERNAME=admin
POWER_MANAGER_AUTH_PASSWORD_HASH=$argon2id$...
POWER_MANAGER_SSH_IDENTITY_FILE=/run/secrets/power-manager/id_ed25519
POWER_MANAGER_SSH_KNOWN_HOSTS_FILE=/etc/power-manager/known_hosts
```

`NODE_ENV` は省略できます（省略時は `production`）。`development` を指定したときだけ `http://localhost` の Origin を許可します。

`POWER_MANAGER_AUTH_PASSWORD_HASH` は Argon2id のハッシュです。アプリケーションはハッシュを生成しません。設定JSON（`version: 2`、サーバー・グループ・予約）の形式は [運用設計](docs/operations.md) を参照してください。設定・鍵・known_hosts は `/home` の外に置き、`power-manager` ユーザーが秘密鍵を `0400` または `0600` で読めるようにしてください。

ローカル開発時に限り、`POWER_MANAGER_PUBLIC_ORIGIN=http://localhost:5173` のようにホスト名が `localhost` の HTTP Origin を使用できます。`127.0.0.1` や外部ホストの HTTP Origin は使用できません。

## NixOS

```nix
{
  inputs.power-manager.url = "path:/path/to/power-manager";
  imports = [ inputs.power-manager.nixosModules.default ];
  services.power-manager = {
    enable = true;
    environmentFile = "/run/secrets/power-manager.env";
    configFile = "/etc/power-manager/config.json";
  };
}
```

Nginx は TLS を終端し、`127.0.0.1:$POWER_MANAGER_PORT` へプロキシしてください。外部の `Host` とプロトコル情報を転送し、Tailscale からだけ到達可能にしてください。`/healthz` は loopback からのみ到達可能にし、外部へ公開しないでください。

## 手動受け入れ確認

1. `ssh-keygen` で専用鍵を作り、各対象にパスワードなしで限定した `systemctl poweroff` だけを許可する sudoers を設定する。
2. 管理対象のホスト鍵を `known_hosts` に登録し、JSON（サーバー・グループ・予約）と環境ファイルを作成する。
3. NixOS サービスを起動し、Nginx/Tailscale 経由で Basic 認証が求められることを確認する。
4. 状態表示、単体操作（行内の進行表示）、グループ一括、予約実行、「最近の実行」、設定再読込の成功・失敗を確認する。

詳細な手順は [運用設計](docs/operations.md) 8 章を参照してください。
