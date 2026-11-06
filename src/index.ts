import { hostname } from "node:os";
import pkg from "../package.json";

import { chunkAt, cursorFrom, storyId } from "./story.ts";
type Client = { cursor: number };

const version = process.env.APP_VERSION ?? pkg.version;
// 构建时写入镜像，同一镜像的所有实例保持相同主题。
const color = process.env.DEPLOY_COLOR ?? "cyan";

const instance = process.env.NOMAD_ALLOC_ID ?? hostname();
const startedAt = new Date().toISOString();
let draining = false;
const sockets = new Set<Bun.ServerWebSocket<Client>>();
const streams = new Map<ReadableStreamDefaultController<Uint8Array>, Client>();
const encoder = new TextEncoder();

// 修改业务数据并发布新版，观察请求和长连接的版本变化。
function snapshot() {
  return {
    color,
    version,
    instance,
    startedAt,
    time: new Date().toISOString(),
    message: "Hello from Nomad!",
    draining,
    storyId,
  };
}
const json = (data: unknown) => Response.json(data, { headers: { "Cache-Control": "no-store" } });
// HTML 在启动时生成一次，主题与页面版本不会随后台请求改变。
const page = await new HTMLRewriter()
  .on("#page-version", {
    element(element) {
      element.setInnerContent(`${color} / ${version}`);
    },
  })
  .transform(
    new Response(
      (await Bun.file(new URL("./index.html", import.meta.url)).text()).replaceAll(
        "__PAGE_COLOR__",
        color,
      ),
    ),
  )
  .text();
const tlsCert = process.env.TLS_CERT;
const tlsKey = process.env.TLS_KEY;
if (!!tlsCert !== !!tlsKey) throw new Error("TLS_CERT 和 TLS_KEY 必须同时设置");

export const server = Bun.serve<Client>({
  hostname: "0.0.0.0",
  port: Number(process.env.PORT ?? 3000),
  http2: true,
  ...(tlsCert && tlsKey ? { tls: { cert: Bun.file(tlsCert), key: Bun.file(tlsKey) } } : {}),
  routes: {
    "/": () =>
      new Response(page, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      }),

    "/app.js": () =>
      new Response(Bun.file(new URL("./app.js", import.meta.url)), {
        headers: { "Content-Type": "text/javascript", "Cache-Control": "no-store" },
      }),
    "/health": () => new Response(draining ? "draining" : "ok", { status: draining ? 503 : 200 }),
    "/api/version": () => json(snapshot()),
    "/api/events": (req: Request, server: Bun.Server<Client>) => {
      if (draining) return new Response("draining", { status: 503 });
      let cursor: number;
      try {
        cursor = cursorFrom(req.url);
      } catch {
        return new Response("Invalid cursor", { status: 400 });
      }
      server.timeout(req, 0);
      let controller: ReadableStreamDefaultController<Uint8Array>;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
            const chunk = { ...snapshot(), ...chunkAt(cursor) };
            streams.set(controller, { cursor: chunk.next });
            controller.enqueue(
              encoder.encode(`retry: 200\nid: ${chunk.next}\ndata: ${JSON.stringify(chunk)}\n\n`),
            );
          },
          cancel() {
            streams.delete(controller);
          },
        }),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
          },
        },
      );
    },
  },
  fetch(req, server) {
    if (new URL(req.url).pathname === "/ws") {
      if (draining) return new Response("draining", { status: 503 });
      let cursor: number;
      try {
        cursor = cursorFrom(req.url);
      } catch {
        return new Response("Invalid cursor", { status: 400 });
      }
      if (server.upgrade(req, { data: { cursor } })) return;
      return new Response("WebSocket upgrade required (HTTP/1.1)", { status: 426 });
    }
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    maxPayloadLength: 4096,
    open(ws) {
      sockets.add(ws);
      const chunk = { ...snapshot(), ...chunkAt(ws.data.cursor) };
      if (ws.send(JSON.stringify(chunk)) !== 0) ws.data.cursor = chunk.next;
    },
    message(ws, message) {
      ws.send(JSON.stringify({ ...snapshot(), event: "echo", echo: String(message) }));
    },
    close(ws) {
      sockets.delete(ws);
    },
  },
});

const timer = setInterval(() => {
  const data = snapshot();
  for (const ws of sockets) {
    const chunk = { ...data, ...chunkAt(ws.data.cursor) };
    if (ws.send(JSON.stringify(chunk)) !== 0) ws.data.cursor = chunk.next;
  }
  for (const [controller, client] of streams) {
    if ((controller.desiredSize ?? 0) <= 0) continue;
    try {
      const chunk = { ...data, ...chunkAt(client.cursor) };
      controller.enqueue(encoder.encode(`id: ${chunk.next}\ndata: ${JSON.stringify(chunk)}\n\n`));
      client.cursor = chunk.next;
    } catch {
      streams.delete(controller);
    }
  }
}, 200);

async function shutdown() {
  if (draining) return;
  draining = true;
  clearInterval(timer);
  // 长连接不会迁移到新实例：主动关闭，让客户端通过入口重新连接。
  for (const ws of sockets) ws.close(1012, "Service restart");
  for (const controller of streams.keys()) controller.close();
  streams.clear();
  const deadline = setTimeout(() => {
    void server.stop(true);
  }, 5000);
  await server.stop();
  clearTimeout(deadline);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
console.log(`${color} / ${version} / ${instance} → ${server.url}`);
