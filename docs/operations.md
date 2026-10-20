# power-manager 運用設計

本書は設定・配備・CI・テストの実務を定義する。要件は [要件定義](requirements.md)、技術選定と構成は [アーキテクチャ設計](architecture.md)、認証と秘密情報の扱いは [セキュリティ設計](security.md) を参照する。

## 1. 実行時設定（環境変数）

アプリケーションは CLI 引数を受け取らない。次の環境変数がすべて存在し妥当でなければ起動に失敗する（NFR-06）。

| 環境変数                             | 用途                                          | 検証                                        |
| ------------------------------------ | --------------------------------------------- | ------------------------------------------- |
| `POWER_MANAGER_CONFIG_PATH`          | 管理対象 JSON の絶対パス                      | 絶対パス、非空                              |
| `POWER_MANAGER_PORT`                 | loopback HTTP の待受ポート                    | 整数 `1`–`65535`                            |
| `POWER_MANAGER_PUBLIC_ORIGIN`        | CSRF 検証に使う外部 Origin                    | HTTPS、開発時のみ `http://localhost[:port]` |
| `POWER_MANAGER_AUTH_USERNAME`        | Basic 認証のユーザー名                        | 非空                                        |
| `POWER_MANAGER_AUTH_PASSWORD_HASH`   | Argon2id パスワードハッシュ                   | `$argon2id$` で始まる                       |
| `POWER_MANAGER_SSH_IDENTITY_FILE`    | SSH 専用秘密鍵の絶対パス                      | 絶対パス                                    |
| `POWER_MANAGER_SSH_KNOWN_HOSTS_FILE` | SSH 接続先を検証する `known_hosts` の絶対パス | 絶対パス                                    |

環境変数を変更した場合は systemd サービスの再起動が必要である。再読込操作の対象は管理対象 JSON のみ（FR-08）。

環境変数ファイルの例:

```ini
POWER_MANAGER_CONFIG_PATH=/etc/power-manager/servers.json
POWER_MANAGER_PORT=8080
POWER_MANAGER_PUBLIC_ORIGIN=https://power.example.ts.net
POWER_MANAGER_AUTH_USERNAME=admin
POWER_MANAGER_AUTH_PASSWORD_HASH=$argon2id$...
POWER_MANAGER_SSH_IDENTITY_FILE=/run/secrets/power-manager/id_ed25519
POWER_MANAGER_SSH_KNOWN_HOSTS_FILE=/etc/power-manager/known_hosts
```

パスワードハッシュは運用者が生成する。アプリケーションは生成機能を持たない。

## 2. 管理対象設定 JSON

ルートに必須の `version: 1` を持つ。検証は厳格に行い、未知の項目、型不一致、空の必須項目、重複 ID、不正な MAC アドレス、範囲外のポートを拒否する（FR-09）。MAC アドレスと接続先ホスト・ポートは、利用者が事前に把握して記述する（CON-03）。

```json
{
  "version": 1,
  "servers": [
    {
      "id": "nas",
      "name": "NAS",
      "macAddress": "00:11:22:33:44:55",
      "wol": {
        "broadcastAddress": "192.168.1.255",
        "port": 9
      },
      "ssh": {
        "host": "nas.example.internal",
        "port": 2222,
        "user": "power-manager",
        "shutdownCommand": "sudo systemctl poweroff"
      }
    }
  ]
}
```

| 項目                   | 必須   | 既定値            | 備考                                   |
| ---------------------- | ------ | ----------------- | -------------------------------------- |
| `id`                   | はい   | —                 | 設定内で一意な安定識別子。URL に現れる |
| `name`                 | はい   | —                 | 画面表示名                             |
| `macAddress`           | はい   | —                 | `XX:XX:XX:XX:XX:XX` 形式               |
| `wol.broadcastAddress` | いいえ | `255.255.255.255` | IPv4 のみ                              |
| `wol.port`             | いいえ | `9`               | `1`–`65535`                            |
| `ssh.host`             | はい   | —                 | ホスト名または IP アドレス             |
| `ssh.port`             | いいえ | `22`              | `1`–`65535`                            |
| `ssh.user`             | はい   | —                 | 管理専用ユーザー                       |
| `ssh.shutdownCommand`  | はい   | —                 | 対象側 `sudoers` で許可される範囲      |

秘密情報はこのファイルに含めない（SEC-04）。`ssh.user` と停止コマンドは秘密ではないが、権限は対象側で最小化する（[セキュリティ設計](security.md) 5 章）。

### 2.1 再読込の挙動

1. ファイルを読み、JSON としてパースする。
2. 候補設定を全体検証する。
3. 検証成功時のみ有効設定を差し替える（原子的差し替え）。
4. 失敗時は直前の有効設定を維持し、結果種別（失敗）を画面に表示し、失敗理由をログに記録する。

起動時の検証に失敗した場合は HTTP サーバーを開始せず、終了コード `78` で終了する。

## 3. Nix パッケージ

flake は次を提供する。

- `packages.x86_64-linux.default`
- `packages.aarch64-linux.default`
- `nixosModules.default`
- 既存の import 形式向けの `package.nix`

パッケージは Bun でコンパイルした実行可能バイナリを生成する。停止機能の実行時依存である OpenSSH は `makeWrapper` で `PATH` に追加し、`nix run` と `nix profile install` で `ssh` を発見できるようにする。NixOS モジュールも `environment.PATH` に OpenSSH を追加する。Nix 外でバイナリを直接実行する場合も、停止操作時に `ssh_unavailable` エラーで不足を明示する（起動時の検査は行わない）。

ビルド手順:

```sh
bun install --frozen-lockfile
bun build --compile --target=bun-linux-<x64|arm64> --outfile dist/power-manager src/index.ts
```

## 4. NixOS モジュール

### 4.1 オプション

| オプション                               | 型       | 既定値                 | 説明                                     |
| ---------------------------------------- | -------- | ---------------------- | ---------------------------------------- |
| `services.power-manager.enable`          | bool     | `false`                | サービスを有効化する                     |
| `services.power-manager.package`         | package  | flake の既定パッケージ | 実行するパッケージ                       |
| `services.power-manager.environmentFile` | path/str | —                      | 秘密情報を含む systemd `EnvironmentFile` |

モジュールは秘密値をオプションとして受け取らず、`environmentFile` のパスだけを受け取る（SEC-09）。

### 4.2 サービス定義

```nix
serviceConfig = {
  ExecStart = "${cfg.package}/bin/power-manager";
  EnvironmentFile = cfg.environmentFile;
  User = "power-manager";
  Group = "power-manager";
  Restart = "on-failure";
  RestartPreventExitStatus = [ 78 ];

  UMask = "0077";

  NoNewPrivileges = true;
  CapabilityBoundingSet = "";
  AmbientCapabilities = "";

  PrivateTmp = true;
  PrivateDevices = true;

  ProtectSystem = "strict";
  ProtectHome = true;
  ProtectControlGroups = true;
  ProtectKernelModules = true;
  ProtectKernelTunables = true;
  ProtectKernelLogs = true;
  ProtectClock = true;
  ProtectHostname = true;

  LockPersonality = true;
  RestrictSUIDSGID = true;
  RestrictRealtime = true;
  RestrictNamespaces = true;
  SystemCallArchitectures = "native";

  RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
};
```

- `ProtectHome = true` のため、設定 JSON・SSH 秘密鍵・`known_hosts` を `/home` 配下に置かない。`/etc/power-manager` や `/run/secrets` などに置く。
- `AF_UNIX` は DNS リゾルバや journald などのローカルソケット用、`AF_INET` と `AF_INET6` は HTTP 待受、WOL、SSH、TCP 死活確認用である。
- `PrivateNetwork`、`IPAddressDeny`、`SocketBindDeny` は設定しない（loopback 待受と可変宛先への外向き通信が必要なため）。
- `MemoryDenyWriteExecute` と `SystemCallFilter` は Bun と OpenSSH での動作確認後に追加を検討する。

### 4.3 ファイルの所有権

サービスは専用の非 root system user `power-manager` として実行する。次を満たすよう配備側で構成する。

- SSH 秘密鍵: `power-manager:power-manager`、`0400` または `0600`
- 管理対象 JSON・`known_hosts`: `power-manager` が読めること
- `environmentFile`: systemd が root で読むため、`power-manager` による直接読取りは不要

モジュールは外部ファイルの所有者・グループ・モードを変更しない。秘密情報の配置は利用側（または `sops-nix` 等）の責務とする。

### 4.4 リバースプロキシ

TLS を終端し、`127.0.0.1:$POWER_MANAGER_PORT` へプロキシする。外部の `Host` とプロトコル情報を転送し、VPN からだけ到達可能にする。`POWER_MANAGER_PUBLIC_ORIGIN` はブラウザが見る Origin と一致させる（SEC-03）。

## 5. CI

GitHub Releases とリリース資産のアップロードは行わない。GitHub Actions は PR と main への push で次を実行する。

- 型検査（`tsc --noEmit`）
- ユニットテストと HTTP 結合テスト
- `x86_64-linux` と `aarch64-linux` の Nix ビルド検証
- Bun コンパイル成果物の生成確認

フォーマッタとリンタは依存に加えていない。導入する場合は `package.json` のスクリプトと CI の両方を更新する。

## 6. テスト方針

自動テストで少なくとも次を検証する（NFR-11）。

| 対象          | 検証内容                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| 環境変数      | 必須欠落、ポート範囲、Origin の HTTP 許可条件、ハッシュ形式                                                |
| 管理対象 JSON | 未知項目、型不一致、空値、重複 ID、MAC、ポート、既定値の適用                                               |
| 設定ストア    | 再読込成功時の差し替え、失敗時の旧設定維持（原子性）                                                       |
| 認証          | 未認証の拒否、`WWW-Authenticate`、誤パスワードの拒否                                                       |
| CSRF          | 不正 `Origin` と `Origin` 欠落の拒否                                                                       |
| ルーティング  | 起動・停止・再読込の `303` リダイレクトと結果パラメータ                                                    |
| WOL           | Magic Packet のバイト列、宛先・ポート、タイムアウト                                                        |
| SSH 停止      | 引数組立て（鍵・`BatchMode`・`known_hosts`・ポート・ユーザー・コマンド）、タイムアウト、`ssh` 不在時の失敗 |
| 排他制御      | 実行中の同一対象への操作拒否、結果種別の区別                                                               |
| 死活確認      | 3 状態の判定、同時実行数（固定 8）の上限、進行中確認の共有                                                         |
| 画面          | HTML エスケープ、状態断片の要素 ID                                                                         |

実際の WOL 送信、SSH 接続、VPN・リバースプロキシ経由のアクセスは、ホームラボ上での手動受け入れテストとする。

## 7. 手動受け入れ手順

1. 専用の SSH 鍵を作成し、各対象へ公開鍵を配備する。
2. 各対象の `sudoers` に、停止コマンドのみをパスワードなしで許可する設定を追加する（[セキュリティ設計](security.md) 5 章）。
3. 各対象のホスト鍵を `known_hosts` に登録する。
4. 管理対象 JSON と環境変数ファイルを作成し、`/home` の外に配置する。
5. NixOS サービスを起動し、`systemctl status power-manager` が active であることを確認する。
6. VPN 経由でリバースプロキシへアクセスし、Basic 認証が求められることを確認する。
7. 一覧表示と 15 秒ごとの状態更新を確認する。
8. 起動操作で対象が起動し、状態が `online` に変わることを確認する。
9. 停止操作で確認ダイアログが出ること、承諾後に対象が停止し状態が `offline` に変わることを確認する。
10. 不正な JSON を書き込んで再読込し、旧設定のまま動作継続することと失敗表示を確認する。
11. 不正な環境変数で起動し、終了コード `78` で停止して再起動ループに入らないことを確認する（`systemctl show -p NRestarts`）。
12. 同一サーバーへの二重操作が拒否されることを確認する。
13. VPN 外から到達できないことを確認する。

## 8. トラブルシューティング

| 症状                            | 確認点                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| 起動直後に終了する              | `journalctl -u power-manager` で `startup_failed` の理由を確認。環境変数と JSON の検証エラー |
| 状態が常に `unknown`            | `/servers/status` が認証付きで取得できているか、ブラウザのコンソールを確認                   |
| 状態が常に `offline`            | 対象の SSH ホスト・ポートへ TCP 到達できるか、名前解決を確認                                 |
| 起動操作が効かない              | ブロードキャストアドレスとポート、対象の WOL 設定、同一 LAN かを確認                         |
| 停止が `ssh_unavailable` になる | サービスの `PATH` に `ssh` があるか（`nix run` 以外では明示が必要）                          |
| 停止が失敗する                  | `known_hosts` の登録、鍵の権限、対象側 `sudoers` の許可範囲を確認                            |
| 変更操作が `403` になる         | `POWER_MANAGER_PUBLIC_ORIGIN` とブラウザの Origin、プロキシのヘッダー転送を確認              |
