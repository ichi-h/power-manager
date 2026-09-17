self: { config, lib, pkgs, ... }:
let
  cfg = config.services.power-manager;
in {
  options.services.power-manager = {
    enable = lib.mkEnableOption "power-manager";
    package = lib.mkOption { type = lib.types.package; default = self.packages.${pkgs.system}.default; description = "実行する power-manager パッケージ。"; };
    environmentFile = lib.mkOption { type = lib.types.str; description = "秘密情報を含む systemd EnvironmentFile のパス。"; };
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
    };
  };
}
