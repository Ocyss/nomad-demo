import { expect, test } from "bun:test";

const html = await Bun.file(new URL("../src/index.html", import.meta.url)).text();

test("theme CSS stays in a style element, not visible body text", async () => {
  let styles = "";
  let body = "";
  const parsed = new HTMLRewriter()
    .on("style", {
      text(chunk) {
        styles += chunk.text;
      },
    })
    .on("body", {
      text(chunk) {
        body += chunk.text;
      },
    })
    .transform(new Response(html));
  await parsed.text();

  expect(styles).toContain(":root {");
  expect(styles).toContain(".theme-page {");
  expect(styles).toContain(".history-failure {");
  expect(body).not.toContain(":root {");
  expect(body).not.toContain("--accent:");
  expect(body).toContain("LATEST HTTP RESPONSE");
});

test("stream controls and counters have unique usable DOM ids", async () => {
  const ids: string[] = [];
  await new HTMLRewriter()
    .on("[id]", {
      element(element) {
        ids.push(element.getAttribute("id")!);
      },
    })
    .transform(new Response(html))
    .text();
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).not.toContain("resume");
  expect(ids).not.toContain("reset-story");
  for (const id of ["page-version", "current", "success", "failure", "latency"]) {
    expect(ids).toContain(id);
  }
  for (const channel of ["ws", "sse"]) {
    for (const suffix of [
      "novel",
      "status",
      "reconnect",
      "cursor",
      "retries",
      "recovery",
      "stall",
      "duplicates",
      "skipped",
      "continuity",
      "log",
    ]) {
      expect(ids).toContain(`${channel}-${suffix}`);
    }
  }
});
