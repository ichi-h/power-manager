# power-manager

ホームラボ内のサーバーを、Tailscale 配下の Nginx から起動・停止・死活確認する個人用アプリケーションです。アプリケーション本体は loopback でのみ待ち受けます。

## ドキュメント

- [要件定義](docs/requirements.md) — 目的・完成像・機能/非機能/セキュリティ要件
- [アーキテクチャ設計](docs/architecture.md) — 技術選定とその根拠、構成、実装方針
- [セキュリティ設計](docs/security.md) — 認証・CSRF・秘密情報・プロセス権限
- [運用設計](docs/operations.md) — 設定JSON・NixOS 配備・CI・テスト
- [旧設計書（非規範）](docs/design.md) — 分割前の原案。上記 4 文書と食い違う場合は 4 文書を正とする

## 開発

```sh
bun install
bun run check
bun run build
```

`bun run build` は Linux x86_64 向けの単一バイナリを `dist/power-manager` に生成します。Nix では `nix build .` により対応プラットフォーム向けのパッケージを生成します。

## 設定

起動には次の環境変数がすべて必要です。秘密値は環境ファイルに置き、リポジトリへ追加しないでください。

```ini
POWER_MANAGER_CONFIG_PATH=/etc/power-manager/servers.json
POWER_MANAGER_PORT=8080
POWER_MANAGER_PUBLIC_ORIGIN=https://power.example.ts.net
POWER_MANAGER_AUTH_USERNAME=admin
POWER_MANAGER_AUTH_PASSWORD_HASH=$argon2id$...
POWER_MANAGER_SSH_IDENTITY_FILE=/run/secrets/power-manager/id_ed25519
POWER_MANAGER_SSH_KNOWN_HOSTS_FILE=/etc/power-manager/known_hosts
```

`POWER_MANAGER_AUTH_PASSWORD_HASH` は Argon2id のハッシュです。アプリケーションはハッシュを生成しません。設定JSONの形式は [運用設計](docs/operations.md) を参照してください。設定・鍵・known_hosts は `/home` の外に置き、`power-manager` ユーザーが秘密鍵を `0400` または `0600` で読めるようにしてください。

ローカル開発時に限り、`POWER_MANAGER_PUBLIC_ORIGIN=http://localhost:8080` のようにホスト名が `localhost` の HTTP Origin を使用できます。`127.0.0.1` や外部ホストの HTTP Origin は使用できません。

## NixOS

```nix
{
  inputs.power-manager.url = "path:/path/to/power-manager";
  imports = [ inputs.power-manager.nixosModules.default ];
  services.power-manager = {
    enable = true;
    environmentFile = "/run/secrets/power-manager.env";
  };
}
```

Nginx は TLS を終端し、`127.0.0.1:$POWER_MANAGER_PORT` へプロキシしてください。外部の `Host` とプロトコル情報を転送し、Tailscale からだけ到達可能にしてください。

## 手動受け入れ確認

1. `ssh-keygen` で専用鍵を作り、各対象にパスワードなしで限定した `systemctl poweroff` だけを許可する sudoers を設定する。
2. 管理対象のホスト鍵を `known_hosts` に登録し、JSON と環境ファイルを作成する。
3. NixOS サービスを起動し、Nginx/Tailscale 経由で Basic 認証が求められることを確認する。
4. 状態表示、WOL 起動、停止、停止確認ダイアログ、設定再読込の成功・失敗を確認する。
