import { AppError, type RuntimeConfig, type Server, type ServerStatus } from "./model";

const timeout = <T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> => Promise.race([
  promise,
  new Promise<T>((_, reject) => setTimeout(() => reject(new AppError("operation_failed", message)), milliseconds)),
]);

export class ServerOperations {
  private readonly busy = new Set<string>();
  private readonly statusPromises = new Map<string, Promise<ServerStatus>>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly maxConcurrent: number;
  constructor(private readonly runtime: RuntimeConfig, maxConcurrent = 8) {
    this.maxConcurrent = Math.min(Math.max(1, maxConcurrent), 16);
  }
  private async acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) { this.running++; return; }
    await new Promise<void>((resolve) => this.waiting.push(resolve)); this.running++;
  }
  private release(): void { this.running--; this.waiting.shift()?.(); }
  async status(server: Server): Promise<ServerStatus> {
    const current = this.statusPromises.get(server.id); if (current) return current;
    const check = (async () => { await this.acquire(); try {
      await timeout(Bun.connect({ hostname: server.ssh.host, port: server.ssh.port, socket: { open: (socket) => { socket.end(); }, data: () => {}, close: () => {}, error: () => {} } }), 5_000, "TCP 確認がタイムアウトしました");
      return "online";
    } catch { return "offline"; } finally { this.release(); } })();
    this.statusPromises.set(server.id, check); try { return await check; } finally { this.statusPromises.delete(server.id); }
  }
  private async exclusive<T>(server: Server, action: () => Promise<T>): Promise<T> {
    if (this.busy.has(server.id)) throw new AppError("busy", "このサーバーは操作中です", 409);
    this.busy.add(server.id); try { return await action(); } finally { this.busy.delete(server.id); }
  }
  async wake(server: Server): Promise<void> { return this.exclusive(server, async () => {
    const bytes = Uint8Array.from([ ...Array(6).fill(0xff), ...Array(16).fill(server.macAddress.split(":").map((part) => Number.parseInt(part, 16))).flat() ]);
    await timeout((async () => { const socket = await Bun.udpSocket({ hostname: "0.0.0.0", port: 0, socket: {} }); socket.send(bytes, server.wol.port, server.wol.broadcastAddress); socket.close(); })(), 5_000, "WOL 送信がタイムアウトしました");
  }); }
  async shutdown(server: Server): Promise<void> { return this.exclusive(server, async () => {
    if (!Bun.which("ssh")) throw new AppError("ssh_unavailable", "ssh コマンドを利用できません", 503);
    const result = await timeout(Bun.$`ssh -i ${this.runtime.sshIdentityFile} -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${this.runtime.sshKnownHostsFile} -p ${server.ssh.port} ${`${server.ssh.user}@${server.ssh.host}`} ${server.ssh.shutdownCommand}`.quiet(), 30_000, "SSH 停止がタイムアウトしました");
    if (result.exitCode !== 0) throw new AppError("operation_failed", "SSH 停止に失敗しました");
  }); }
}
