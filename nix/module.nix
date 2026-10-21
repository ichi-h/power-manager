self: { config, lib, pkgs, ... }:
let
  cfg = config.services.power-manager;
in {
  options.services.power-manager = {
    enable = lib.mkEnableOption "power-manager";
    package = lib.mkOption { type = lib.types.package; default = self.packages.${pkgs.system}.default; description = "実行する power-manager パッケージ。"; };
    environmentFile = lib.mkOption { type = lib.types.path; description = "秘密情報を含む systemd EnvironmentFile のパス。"; };
    configFile = lib.mkOption { type = lib.types.nullOr (lib.types.either lib.types.path lib.types.str); default = null; description = "管理対象 JSON（サーバー・グループ・予約）のパス。"; };
  };
  config = lib.mkIf cfg.enable {
    users.users.power-manager = { isSystemUser = true; group = "power-manager"; };
    users.groups.power-manager = {};
    systemd.services.power-manager = {
      description = "power-manager";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      environment.PATH = lib.makeBinPath [ pkgs.openssh ];
      serviceConfig = {
        ExecStart = "${cfg.package}/bin/power-manager";
        EnvironmentFile = cfg.environmentFile;
        Environment = lib.optional (cfg.configFile != null) "POWER_MANAGER_CONFIG_PATH=${toString cfg.configFile}";
        User = "power-manager";
        Group = "power-manager";
        Restart = "on-failure";
        # 78 は sysexits.h の EX_CONFIG。アプリ側の定義は app/lib/exit-codes.ts の
        # `configurationErrorExitCode` で、この値と一致している必要がある。
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
    };
  };
}
