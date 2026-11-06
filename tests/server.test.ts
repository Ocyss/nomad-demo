import { afterAll, expect, test } from "bun:test";
import { connect } from "node:http2";
import pkg from "../package.json";

import { chunkAt, cursorFrom } from "../src/story.ts";

process.env.PORT = "0";
const { server } = await import("../src/index.ts");
const base = server.url;
afterAll(async () => {
  process.emit("SIGTERM");
  await server.stop(true);
});

test("health and version API", async () => {
  expect((await fetch(new URL("/health", base))).status).toBe(200);
  const data = (await (await fetch(new URL("/api/version", base))).json()) as {
    version: string;
    instance: string;
    color: string;
  };
  expect(data.version).toBe(process.env.APP_VERSION ?? pkg.version);
  expect(data.instance).toBeString();
  expect(data.color).toBe(process.env.DEPLOY_COLOR ?? "cyan");
});

test("HTML and JavaScript", async () => {
  const response = await fetch(base);
  expect(response.headers.get("content-type")).toContain("text/html");
  const html = await response.text();
  expect(html).toContain("Blue / Green");
  expect(html).not.toContain("__PAGE_COLOR__");
  expect(html).toContain(`--color-${process.env.DEPLOY_COLOR ?? "cyan"}-400`);
  let pageVersion = "";
  await new HTMLRewriter()
    .on("#page-version", {
      text(chunk) {
        pageVersion += chunk.text;
      },
    })
    .transform(new Response(html))
    .text();
  expect(pageVersion).toBe(
    `${process.env.DEPLOY_COLOR ?? "cyan"} / ${process.env.APP_VERSION ?? pkg.version}`,
  );
  const script = await (await fetch(new URL("/app.js", base))).text();
  expect(script).not.toContain("document.documentElement.style");
  expect(script).not.toContain('$("resume")');
  expect((await fetch(new URL("/app.js", base))).headers.get("content-type")).toContain(
    "javascript",
  );

  expect((await fetch(new URL("/missing", base))).status).toBe(404);
});

test("SSE sends an initial version event", async () => {
  const abort = new AbortController();
  try {
    const response = await fetch(new URL("/api/events", base), { signal: abort.signal });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('"version":');
    await reader.cancel();
  } finally {
    abort.abort();
  }
});

test("WebSocket echoes messages with deployment identity", async () => {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(new URL("/ws", base).href.replace("http:", "ws:"));
    const deadline = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket timeout"));
    }, 2000);
    ws.onopen = () => ws.send("demo");
    ws.onerror = () => {
      clearTimeout(deadline);
      ws.close();
      reject(new Error("WebSocket failed"));
    };
    ws.onmessage = ({ data }) => {
      const event = JSON.parse(String(data));
      if (event.event !== "echo") return;
      clearTimeout(deadline);
      ws.close();
      try {
        expect(event.echo).toBe("demo");
        expect(event.version).toBeString();
        expect(event.color).toBe(process.env.DEPLOY_COLOR ?? "cyan");
        resolve();
      } catch (error) {
        reject(error);
      }
    };
  });
});

test("novel cursors are deterministic across reconnects and reject invalid input", async () => {
  const first = chunkAt(0);
  expect(first.text.length).toBe(3);
  expect(chunkAt(first.next).offset).toBe(first.next);
  expect(chunkAt(9)).toEqual(chunkAt(9));
  expect(() => cursorFrom("http://demo/ws?cursor=-1")).toThrow();
  expect(() => cursorFrom("http://demo/ws?cursor=1.5")).toThrow();
  expect(() => cursorFrom("http://demo/ws?cursor=9007199254740991")).toThrow();
  for (const path of ["/api/events?cursor=-1", "/ws?cursor=bad"]) {
    expect((await fetch(new URL(path, base))).status).toBe(400);
  }
});

test("SSE resumes at the last received next cursor", async () => {
  async function read(cursor: number) {
    const response = await fetch(new URL(`/api/events?cursor=${cursor}`, base));
    const reader = response.body!.getReader();
    try {
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain("retry: 200");
      const event = JSON.parse(text.split("data: ")[1]!.split("\n")[0]!);
      expect(text).toContain(`id: ${event.next}`);
      return event as ReturnType<typeof chunkAt>;
    } finally {
      await reader.cancel();
    }
  }
  const first = await read(21);
  const resumed = await read(first.next);
  expect(first.offset).toBe(21);
  expect(resumed).toMatchObject(chunkAt(first.next));
  const restarted = await read(0);
  expect(restarted.offset).toBe(0);
});

test("WebSocket streams ordered chunks and reconnects at a supplied cursor", async () => {
  async function read(cursor: number, count: number) {
    return await new Promise<ReturnType<typeof chunkAt>[]>((resolve, reject) => {
      const chunks: ReturnType<typeof chunkAt>[] = [];
      const ws = new WebSocket(new URL(`/ws?cursor=${cursor}`, base).href.replace("http:", "ws:"));
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("Novel timeout"));
      }, 2000);
      ws.onerror = () => {
        clearTimeout(timer);
        ws.close();
        reject(new Error("Novel WS failed"));
      };
      ws.onmessage = ({ data }) => {
        const event = JSON.parse(String(data));
        if (event.event !== "chunk") return;
        chunks.push(event);
        if (chunks.length === count) {
          clearTimeout(timer);
          ws.close();
          resolve(chunks);
        }
      };
    });
  }
  const chunks = await read(30, 2);
  expect(chunks[0]).toMatchObject(chunkAt(30));
  expect(chunks[1]!.offset).toBe(chunks[0]!.next);
  const resumed = await read(chunks[1]!.next, 1);
  expect(resumed[0]).toMatchObject(chunkAt(chunks[1]!.next));
});

test("native HTTP/2 prior knowledge", async () => {
  const client = connect(base);
  try {
    const body = await new Promise<string>((resolve, reject) => {
      client.once("error", reject);
      const request = client.request({ ":path": "/api/version" });
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => resolve(body));
      request.on("error", reject);
      request.end();
    });
    expect(JSON.parse(body).version).toBeString();
  } finally {
    client.destroy();
  }
});
