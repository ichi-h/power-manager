export type Server = {
  id: string;
  name: string;
  macAddress: string;
  wol: { broadcastAddress: string; port: number };
  ssh: { host: string; port: number; user: string; shutdownCommand: string };
};

export type RuntimeConfig = {
  configPath: string;
  port: number;
  publicOrigin: string;
  authUsername: string;
  authPasswordHash: string;
  sshIdentityFile: string;
  sshKnownHostsFile: string;
};

export type ServerStatus = "online" | "offline" | "unknown";
export type Operation = "wake" | "shutdown";
export type OperationResult = "success" | "failed" | "busy";
export type AppErrorCode = "invalid_configuration" | "ssh_unavailable" | "operation_failed" | "busy";

export class AppError extends Error {
  constructor(public readonly code: AppErrorCode, message: string, public readonly status = 500) {
    super(message);
  }
}
