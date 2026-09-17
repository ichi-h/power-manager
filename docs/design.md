# power-manager 設計書

## 1. 目的と対象範囲

`power-manager` は、ホームラボ内の登録済みサーバーをブラウザから管理する個人向けアプリケーションである。NixOS ホスト上で動作し、既存の Tailscale 接続および Nginx リバースプロキシの配下から利用する。

初回版で提供する機能は次に限る。

- Wake-on-LAN による対象サーバーの起動
- SSH 経由の停止コマンド実行
- 設定した SSH ポートへの TCP 接続による死活確認
- 設定 JSON の検証付き再読込
- 操作の成功・失敗表示
- HTTP Basic 認証による管理画面の保護

再起動、強制停止、一括操作、予約実行、永続的な操作履歴、外部自動化向け API は初回版の対象外とする。

## 2. 制約と前提

- 利用者は本人一人だけであり、利用者ごとの権限管理は提供しない。
- アプリケーションは永続状態を持たない。DB、アプリ独自の一時ファイル、操作履歴ファイルを作成しない。
- 管理対象の定義は 1 個の JSON 設定ファイルから読む。
- 秘密情報は JSON に書かず、環境変数経由で渡す。平文パスワードをアプリケーション設定へ保存しない。
- 現在は impure な環境変数ファイルを使用する。将来 `sops-nix` に移行しても使える構成にする。
- アプリケーションは loopback (`127.0.0.1` および必要に応じて `::1`) でのみ待ち受ける。Nginx が TLS 終端と Tailscale 側からの受信を担当する。
- Bun と TypeScript を使用し、Bun のコンパイル機能で実行可能バイナリを生成する。Next.js は使用しない。
- 対応プラットフォームは `x86_64-linux` と `aarch64-linux` である。

## 3. アーキテクチャ

```text
ブラウザ
  │ HTTPS / Tailscale
  ▼
Nginx（TLS 終端・リバースプロキシ）
  │ loopback HTTP
  ▼
power-manager（Bun 単一バイナリ、専用 system user）
  ├── JSON 設定ファイル
  ├── OpenSSH クライアント ── SSH ──> 管理対象
  └── UDP Magic Packet ────────────> 管理対象 LAN
```

HTTP アプリケーションは Hono を使用する。`hono/jsx` により HTML をサーバーサイドレンダリングし、通常の操作は HTML フォームで実現する。初回版では HTML over the wire 用ライブラリおよび CSR フレームワークを導入しない。

### 3.1 自動ポーリング

画面を開いたままでも死活状態を自動更新することは必須要件である。初期表示と手動更新にも同じ死活確認を行う。

Hono の SSR を維持し、最小限のブラウザ JavaScript を使用する。ブラウザは認証済みの HTML フラグメント取得エンドポイントを定期的に `fetch` し、死活状態の表示領域だけを置き換える。

`GET /servers/status` は HTML フラグメントを返す認証必須の UI 用エンドポイントとする。これは外部自動化向けの公開 JSON API ではない。電源操作は通常の認証済み POST 要求として扱う。

自動ポーリングは 15 秒間隔とする。死活確認はプロセス内の共有キューで実行し、TCP 接続の同時実行数は既定で 8、設定可能な上限は 16 とする。上限を超えた対象はキューで待機し、順次確認する。

同時に到着した状態取得要求は、進行中の同一対象の死活確認を共有し、重複した TCP 接続を開始しない。これにより、複数タブ、手動更新、自動ポーリングが重なっても同時接続数を上限内に保つ。対象数が増え、最悪時の確認時間がポーリング間隔を超える場合も、未完了の確認を次回のポーリングで重複起動しない。

## 4. 認証と HTTP セキュリティ

### 4.1 認証

アプリケーション側で HTTP Basic 認証を実装する。

- `POWER_MANAGER_AUTH_USERNAME` と `POWER_MANAGER_AUTH_PASSWORD_HASH` を必須とする。
- パスワードハッシュは Argon2id 形式を受け付ける。
- アプリケーションはパスワードハッシュを生成しない。運用者が Argon2id 対応ツールで生成した値を環境変数ファイルへ設定する。
- 認証失敗時は `401 Unauthorized` と `WWW-Authenticate` を返す。
- Basic 認証の性質上、アプリケーション独自のログアウト機能は提供しない。
- HTTPS は Nginx で終端する。アプリケーションを直接外部公開してはならない。

### 4.2 CSRF 対策

起動、停止、設定再読込などの変更操作は `POST` に限定する。各要求の `Origin` ヘッダーは `POWER_MANAGER_PUBLIC_ORIGIN` と完全一致しなければ拒否する。

`POWER_MANAGER_PUBLIC_ORIGIN` は HTTPS URL とする。ただしローカル開発では、ホスト名が厳密に `localhost` の HTTP URL（ポート指定可）を使用できる。`127.0.0.1`、`::1`、その他のホスト名では HTTP を許可しない。Nginx は外部の `Host` とプロトコル情報を適切に転送する。アプリケーションは loopback から来る Nginx だけを信頼する。

### 4.3 停止確認

停止ボタンはブラウザの `window.confirm()` による確認ダイアログを必須とする。これは誤クリック防止の UI であり、サーバー側で確認済み状態を永続・署名管理するものではない。停止要求そのものは Basic 認証と Origin 検証で保護する。

## 5. 実行時設定

アプリケーションは CLI 引数を受け取らず、次の環境変数がすべて存在し妥当でなければ起動に失敗する。

| 環境変数                             | 用途                                          |
| ------------------------------------ | --------------------------------------------- |
| `POWER_MANAGER_CONFIG_PATH`          | 管理対象 JSON の絶対パス                      |
| `POWER_MANAGER_PORT`                 | loopback HTTP の待受ポート（`1`–`65535`）     |
| `POWER_MANAGER_PUBLIC_ORIGIN`        | CSRF 検証に使う外部 HTTPS Origin（開発時は `http://localhost` も可） |
| `POWER_MANAGER_AUTH_USERNAME`        | Basic 認証のユーザー名                        |
| `POWER_MANAGER_AUTH_PASSWORD_HASH`   | Argon2id パスワードハッシュ                   |
| `POWER_MANAGER_SSH_IDENTITY_FILE`    | SSH 専用秘密鍵の絶対パス                      |
| `POWER_MANAGER_SSH_KNOWN_HOSTS_FILE` | SSH 接続先を検証する `known_hosts` の絶対パス |

環境変数を変更した場合は systemd サービスの再起動が必要である。設定再読込は JSON 設定ファイルだけを対象とする。

## 6. 管理対象設定 JSON

設定フォーマットには将来の移行を判別できるよう、ルートに必須の `version: 1` を持たせる。検証は厳格に行い、未知の項目、型不一致、空の必須項目、重複 ID、不正な MAC アドレス、不正なポートを拒否する。

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

- `id` は設定内で一意な安定識別子とする。
- `ssh.port` の既定値は `22` とする。
- `wol.broadcastAddress` の既定値は `255.255.255.255`、`wol.port` の既定値は `9` とする。
- 停止コマンドは管理対象側でパスワードなしに実行できるよう、専用公開鍵と最小権限の `sudoers` 設定を事前に構成する。

再読込時は候補設定を完全に検証してから原子的に差し替える。失敗した場合は直前の有効設定を維持し、画面とログへ失敗理由を出す。起動時の設定検証に失敗した場合は HTTP サーバーを開始せずに終了する。

## 7. 電源操作と死活確認

### 7.1 起動

サーバーごとの MAC アドレスと WOL 宛先へ UDP Magic Packet を送る。送信が API レベルで成功したことだけを結果とし、起動完了は死活確認で判断する。

### 7.2 停止

OpenSSH の `ssh` コマンドを子プロセスとして実行する。秘密鍵、`known_hosts`、対象ホスト、ポート、ユーザーを明示し、次を守る。

- `BatchMode=yes` を使用し、パスワード入力待ちをしない。
- 厳格なホスト鍵検証を有効にする。
- ローカルシェルを経由して停止コマンドを組み立てない。
- SSH コマンドが成功終了したことまでを画面の成功条件とする。
- `ssh` が存在しない場合は操作せず、`ssh_unavailable` と分かるエラーを返す。

初期タイムアウトは TCP 死活確認 5 秒、WOL 送信 5 秒、SSH 停止 30 秒とする。

### 7.3 死活確認

死活確認は、各対象の設定済み SSH ホスト・ポートへの TCP 接続で行う。結果は `online`、`offline`、`unknown` の 3 状態で表示する。ICMP ping や SSH ログイン成功は確認条件に含めない。

同一対象の WOL、停止、死活確認要求が実行中の場合、プロセス内の対象別ロックにより同一の電源操作を `409 Conflict` で拒否する。このロックは永続化せず、プロセス再起動時に消える。

### 7.4 操作結果

変更操作は Post-Redirect-Get を使う。操作後は `303 See Other` で一覧へ戻し、成功・失敗種別と対象 ID のみを一時的な URL パラメータで表示する。コマンド内容、認証情報、鍵情報、内部エラーの詳細は画面に表示しない。

## 8. ログと障害処理

アプリケーションはファイルへログを書かず、stdout/stderr に構造化ログを出す。NixOS の journald が保持するかどうかは OS 側の設定に委ねる。

ログには対象 ID、操作種別、成功・失敗、失敗分類を記録してよい。認証ヘッダー、パスワード、パスワードハッシュ、SSH 秘密鍵、停止コマンドの内容、環境変数値は記録してはならない。

NixOS サービスは予期しない異常終了時に `Restart=on-failure` で systemd へ再起動を委譲する。設定または環境変数の検証エラーは専用の終了コードで終了し、モジュールはその終了コードを `RestartPreventExitStatus` に指定して再起動ループを防ぐ。

## 9. Nix パッケージと NixOS モジュール

flake は次を提供する。

- `packages.x86_64-linux.default`
- `packages.aarch64-linux.default`
- `nixosModules.default`
- 既存の import 形式にも使える `package.nix`

パッケージは Bun でコンパイルした実行可能バイナリを生成する。停止機能の実行時依存である OpenSSH は Nix 側で提供し、`nix run` と `nix profile install` で `ssh` を発見できるようにする。Nix 外でバイナリを直接実行する場合も、起動時検査と操作時エラーで不足を明確にする。

NixOS モジュールは少なくとも次を提供する。

- `services.power-manager.enable`
- `services.power-manager.package`
- `services.power-manager.environmentFile`

サービスは専用の非 root system user `power-manager` として実行する。設定 JSON、SSH 秘密鍵、`known_hosts` はこのユーザーが読める最小権限にする。`environmentFile` は systemd が読み込むため、このユーザーによる直接読取りは要求しない。

サービスには、永続的な書込み領域を不要にするため、次の systemd hardening を適用する。

```nix
serviceConfig = {
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

  RestrictAddressFamilies = [
    "AF_UNIX"
    "AF_INET"
    "AF_INET6"
  ];
};
```

`ProtectHome = true` を使用するため、設定 JSON、SSH 秘密鍵、`known_hosts` は `/home` 配下に配置してはならない。`/etc/power-manager` または `/run/secrets` などに配置する。`AF_UNIX` は DNS リゾルバや journald などのローカルソケット用、`AF_INET` と `AF_INET6` は HTTP 待受、WOL、SSH、TCP 死活確認用である。

`PrivateNetwork`、`IPAddressDeny`、`SocketBindDeny` は設定しない。サービスには loopback HTTP の待受と、設定により変化する宛先への WOL、SSH、TCP 接続が必要である。`MemoryDenyWriteExecute` と `SystemCallFilter` は Bun と OpenSSH の実行を実機で検証してから追加を検討する。

### 9.1 秘密情報の渡し方

モジュールは秘密値を Nix オプションとして受け取らず、`environmentFile` のパスだけを受け取る。これにより、現在の impure な `.env` ファイルと、将来の `sops.templates.<name>.path` が生成する root 限定ファイルのどちらも同じように使用できる。`sops-nix` はこのプロジェクトの必須依存にしない。

SSH 秘密鍵は `power-manager:power-manager` が所有し、モードは `0400` または `0600` とする。モジュールは外部から渡されたファイルの所有者・グループ・モードを変更する補助オプションを提供しない。秘密情報を生成または配置する利用側の設定が、所有権とモードを管理する。これにより、sops-nix などの秘密情報管理機構との責務の重複を避ける。

## 10. CI

GitHub Releases とリリース資産のアップロードは行わない。GitHub Actions は PR と main への push で以下を実行する CI 専用とする。

- フォーマット、lint、型検査
- ユニットテストと HTTP 結合テスト
- `x86_64-linux` と `aarch64-linux` の Nix ビルド検証
- Bun コンパイル成果物の生成確認

## 11. テスト方針

自動テストでは少なくとも次を検証する。

- 環境変数と JSON 設定の厳格な検証
- Basic 認証、Origin 検証、認可されていない操作の拒否
- 起動・停止・再読込の HTTP ルーティング
- WOL および SSH の引数組立てとタイムアウト
- `ssh` 不在時の失敗
- 設定再読込の原子性
- 対象別ロックと `409 Conflict`
- 操作後の Post-Redirect-Get

実際の WOL 送信、SSH 接続、Nginx 経由アクセス、Tailscale 接続はホームラボ上での手動受け入れテストとし、実装時に手順を README へ記載する。
