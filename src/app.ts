import { Hono } from "hono";
import type { RuntimeConfig, ServerStatus } from "./model";
import { AppError } from "./model";
import { ServerConfigStore } from "./config";
import { ServerOperations } from "./services";

const statusLabel: Record<ServerStatus, string> = { online: "オンライン", offline: "オフライン", unknown: "不明" };
const resultLabel: Record<string, string> = { success: "操作を受け付けました", failed: "操作に失敗しました", busy: "対象サーバーは操作中です" };
const escapeHtml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

function statusFragment(rows: { id: string; status: ServerStatus }[]): string {
  return rows.map(({ id, status }) => `<span id="status-${escapeHtml(id)}" class="status status-${status}">${statusLabel[status]}</span>`).join("");
}

function page(servers: readonly { id: string; name: string }[], statuses: { id: string; status: ServerStatus }[], result?: string, serverId?: string): string {
  const byId = new Map(statuses.map((item) => [item.id, item.status]));
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>power-manager</title><style>body{font-family:sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem}.server{border:1px solid #ccc;padding:1rem;margin:.75rem 0}.status-online{color:green}.status-offline{color:#b00}.status-unknown{color:#666}button{margin-right:.5rem}</style></head><body><h1>power-manager</h1>${result ? `<p role="status">${escapeHtml(resultLabel[result] ?? "操作結果を確認してください")}${serverId ? `: ${escapeHtml(serverId)}` : ""}</p>` : ""}<form method="post" action="/reload"><button type="submit">設定を再読込</button></form><main>${servers.map((server) => `<section class="server"><h2>${escapeHtml(server.name)}</h2><p>状態: <span id="status-${escapeHtml(server.id)}" class="status status-${byId.get(server.id) ?? "unknown"}">${statusLabel[byId.get(server.id) ?? "unknown"]}</span></p><form method="post" action="/servers/${encodeURIComponent(server.id)}/wake"><button type="submit">起動</button></form><form method="post" action="/servers/${encodeURIComponent(server.id)}/shutdown" onsubmit="return window.confirm('本当に停止しますか？')"><button type="submit">停止</button></form></section>`).join("")}</main><script>setInterval(async()=>{try{const r=await fetch('/servers/status');if(!r.ok)return;const d=document.createElement('div');d.innerHTML=await r.text();d.querySelectorAll('[id]').forEach(e=>document.getElementById(e.id)?.replaceWith(e))}catch{}} ,15000)</script></body></html>`;
}

export function createApp(runtime: RuntimeConfig, store: ServerConfigStore, operations: ServerOperations): Hono {
  const app = new Hono();
  app.use("*", async (context, next) => {
    const header = context.req.header("Authorization");
    if (!header?.startsWith("Basic ")) return context.text("Authentication required", 401, { "WWW-Authenticate": 'Basic realm="power-manager"' });
    try {
      const [username, password] = atob(header.slice(6)).split(":", 2);
      if (username !== runtime.authUsername || !password || !(await Bun.password.verify(password, runtime.authPasswordHash))) throw new Error("invalid");
    } catch { return context.text("Authentication required", 401, { "WWW-Authenticate": 'Basic realm="power-manager"' }); }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(context.req.method) && context.req.header("Origin") !== runtime.publicOrigin) return context.text("Invalid Origin", 403);
    await next();
  });
  const statuses = async () => Promise.all(store.all.map(async (server) => ({ id: server.id, status: await operations.status(server) })));
  app.get("/", async (context) => context.html(page(store.all, await statuses(), context.req.query("result"), context.req.query("server"))));
  app.get("/servers/status", async (context) => context.html(statusFragment(await statuses())));
  app.post("/servers/:id/:operation", async (context) => {
    const server = store.find(context.req.param("id"));
    if (!server) return context.text("Not found", 404);
    try {
      const operation = context.req.param("operation");
      if (operation === "wake") await operations.wake(server);
      else if (operation === "shutdown") await operations.shutdown(server);
      else return context.text("Not found", 404);
      return context.redirect(`/?result=success&server=${encodeURIComponent(server.id)}`, 303);
    } catch (error) {
      const result = error instanceof AppError && error.code === "busy" ? "busy" : "failed";
      console.error(JSON.stringify({ event: "power_operation", serverId: server.id, operation: context.req.param("operation"), result, code: error instanceof AppError ? error.code : "unknown" }));
      return context.redirect(`/?result=${result}&server=${encodeURIComponent(server.id)}`, 303);
    }
  });
  app.post("/reload", async (context) => {
    try { await store.reload(); return context.redirect("/?result=success", 303); }
    catch (error) { console.error(JSON.stringify({ event: "config_reload", result: "failed", reason: error instanceof Error ? error.message : "unknown" })); return context.redirect("/?result=failed", 303); }
  });
  return app;
}
