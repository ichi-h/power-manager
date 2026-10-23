self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.power-manager;
in
{
  options.services.power-manager = {
    enable = lib.mkEnableOption "power-manager";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "self.packages.\${system}.default";
      description = ''
        実行する power-manager パッケージ。既定はこの flake の
        `packages.<system>.default`。
      '';
    };

    environmentFile = lib.mkOption {
      type = lib.types.either lib.types.path lib.types.str;
      example = "/run/secrets/power-manager/env";
      description = ''
        アプリケーションの実行時設定を並べた systemd `EnvironmentFile` のパス。

        Basic 認証のユーザー名・Argon2id ハッシュ、SSH 秘密鍵のパスなど
        秘密情報を含むため、モジュールは値そのものを受け取らずパスだけを受け取る
        （SEC-09）。systemd が root として読むため、`power-manager` ユーザーが
        読める必要はない。
      '';
    };

    configFile = lib.mkOption {
      type = lib.types.nullOr (lib.types.either lib.types.path lib.types.str);
      default = null;
      example = "/etc/power-manager/config.json";
      description = ''
        管理対象 JSON（サーバー・グループ・予約）のパス。

        指定すると `POWER_MANAGER_CONFIG_PATH` をこの値で設定し、
        `environmentFile` 側の同名の値を上書きする。定義を編集して再読込する運用を
        取る場合は `/etc` など書き換え可能な場所を指定する（Nix store は読み取り
        専用のため、再ビルドと再起動が必要になる）。
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # `ProtectHome = true` で `/home` 配下は見えなくなる。`configFile` だけはここで
    # 検出できるため、配備時の「なぜか設定が読めない」を評価時点で止める。
    # 環境変数ファイルは systemd（root）が読むため対象外。SSH 秘密鍵・`known_hosts` の
    # パスは `environmentFile` の中にあり、モジュールからは参照できない（4.2 の責務）。
    assertions = [
      {
        assertion =
          cfg.configFile == null
          || !(lib.hasPrefix "/home/" (toString cfg.configFile) || toString cfg.configFile == "/home");
        message = ''
          services.power-manager.configFile を /home 配下に置けません。
          ProtectHome = true によりサービスからは見えないため、/etc/power-manager など
          の場所を指定してください。
        '';
      }
    ];

    users.users.power-manager = {
      isSystemUser = true;
      group = "power-manager";
      description = "power-manager service user";
    };
    users.groups.power-manager = { };

    systemd.services.power-manager = {
      description = "power-manager";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      # `environment.PATH` ではなく `path` を使う。NixOS は `path` を既定の PATH の後ろへ
      # 連結するため、`environment.PATH` を直接定義すると既定値と衝突して評価に失敗する。
      path = [ pkgs.openssh ];

      serviceConfig = {
        ExecStart = "${cfg.package}/bin/power-manager";
        EnvironmentFile = cfg.environmentFile;
        Environment = lib.optional (
          cfg.configFile != null
        ) "POWER_MANAGER_CONFIG_PATH=${toString cfg.configFile}";

        # 専用の非特権ユーザーで実行する（SEC-08）。
        User = "power-manager";
        Group = "power-manager";
        UMask = "0077";

        Restart = "on-failure";
        # 78 は sysexits.h の EX_CONFIG。アプリ側の定義は app/lib/exit-codes.ts の
        # `configurationErrorExitCode` で、この値と一致している必要がある。
        # 設定不備で再起動を繰り返さない（NFR-05）。
        RestartPreventExitStatus = [ 78 ];

        NoNewPrivileges = true;
        CapabilityBoundingSet = "";
        AmbientCapabilities = "";

        PrivateTmp = true;
        PrivateDevices = true;

        # アプリケーションは実行時にファイルを書かない（NFR-02）。そのため
        # StateDirectory も ReadWritePaths も要求しない。
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

        # loopback での待受（AF_INET / AF_INET6）、WOL・SSH・TCP 死活確認の外向き通信、
        # ローカルソケット（AF_UNIX）に必要な範囲だけを許可する。
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
        ];
      };
    };
  };
}
