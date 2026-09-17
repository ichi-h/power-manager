import { z } from "zod";
import type { RuntimeConfig, Server } from "./model";

const absolutePath = z.string().min(1).refine((value) => value.startsWith("/"), "絶対パスを指定してください");
const port = z.coerce.number().int().min(1).max(65535);
const ipv4 = z.ipv4();
const publicOrigin = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost");
}, "HTTPS Origin、または localhost の HTTP Origin を指定してください");
const serverSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  macAddress: z.string().regex(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/),
  wol: z.object({ broadcastAddress: ipv4.default("255.255.255.255"), port: port.default(9) }).default({ broadcastAddress: "255.255.255.255", port: 9 }),
  ssh: z.object({
    host: z.string().min(1), port: port.default(22), user: z.string().min(1), shutdownCommand: z.string().min(1),
  }).strict(),
}).strict();
const configSchema = z.object({ version: z.literal(1), servers: z.array(serverSchema) }).strict().superRefine((config, ctx) => {
  const ids = new Set<string>();
  for (const [index, server] of config.servers.entries()) {
    if (ids.has(server.id)) ctx.addIssue({ code: "custom", path: ["servers", index, "id"], message: "id は一意でなければなりません" });
    ids.add(server.id);
  }
});

export function loadRuntimeConfig(env: Record<string, string | undefined> = process.env): RuntimeConfig {
  const parsed = z.object({
    POWER_MANAGER_CONFIG_PATH: absolutePath,
    POWER_MANAGER_PORT: port,
    POWER_MANAGER_PUBLIC_ORIGIN: publicOrigin,
    POWER_MANAGER_AUTH_USERNAME: z.string().min(1),
    POWER_MANAGER_AUTH_PASSWORD_HASH: z.string().startsWith("$argon2id$"),
    POWER_MANAGER_SSH_IDENTITY_FILE: absolutePath,
    POWER_MANAGER_SSH_KNOWN_HOSTS_FILE: absolutePath,
  }).safeParse(env);
  if (!parsed.success) throw new Error(`環境変数が不正です: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  return {
    configPath: parsed.data.POWER_MANAGER_CONFIG_PATH, port: parsed.data.POWER_MANAGER_PORT,
    publicOrigin: parsed.data.POWER_MANAGER_PUBLIC_ORIGIN, authUsername: parsed.data.POWER_MANAGER_AUTH_USERNAME,
    authPasswordHash: parsed.data.POWER_MANAGER_AUTH_PASSWORD_HASH, sshIdentityFile: parsed.data.POWER_MANAGER_SSH_IDENTITY_FILE,
    sshKnownHostsFile: parsed.data.POWER_MANAGER_SSH_KNOWN_HOSTS_FILE,
  };
}

export function parseServerConfig(json: unknown): Server[] { return configSchema.parse(json).servers; }

export class ServerConfigStore {
  private servers: Server[] = [];
  constructor(private readonly path: string) {}
  async reload(): Promise<Server[]> {
    const candidate = parseServerConfig(JSON.parse(await Bun.file(this.path).text()));
    this.servers = candidate;
    return candidate;
  }
  get all(): readonly Server[] { return this.servers; }
  find(id: string): Server | undefined { return this.servers.find((server) => server.id === id); }
}
