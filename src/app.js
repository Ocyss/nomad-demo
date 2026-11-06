const $ = (id) => document.getElementById(id);
const colorValue = (color, shade = 400) => `var(--color-${color}-${shade})`;
const label = (data) => `${data.color} / ${data.version} · ${data.instance.slice(0, 12)}`;

function eventText(element, before, event, after = "") {
  const color = document.createElement("span");
  color.textContent = event.color;
  color.style.color = colorValue(event.color);
  element.replaceChildren(
    document.createTextNode(before),
    color,
    document.createTextNode(` / ${event.version} · ${event.instance.slice(0, 12)}${after}`),
  );
}
function log(id, text, event) {
  const line = document.createElement("div");
  const time = `${new Date().toLocaleTimeString()}  `;
  if (event) eventText(line, time, event, text);
  else line.textContent = time + text;
  $(id).prepend(line);
  while ($(id).children.length > 30) $(id).lastChild.remove();
}
let latest;
let success = 0;
let failure = 0;
let pending = false;
async function request() {
  if (pending) return;
  pending = true;
  const start = performance.now();
  const mark = document.createElement("span");
  mark.className = "history-marker";
  try {
    const response = await fetch("/api/version", {
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    latest = data;

    for (const channel of channels) channel.showStatus();
    $("current").textContent = `${data.color.toUpperCase()} / ${data.version}`;
    $("message").textContent = data.message;
    $("instance").textContent = `实例 ${data.instance} · 启动于 ${data.startedAt}`;
    mark.style.backgroundColor = colorValue(data.color);
    mark.title = label(data);
    $("success").textContent = String(++success);
  } catch (error) {
    mark.classList.add("history-failure");
    mark.textContent = "×";
    mark.title = `请求失败：${error}`;
    $("failure").textContent = String(++failure);
  } finally {
    $("latency").textContent = `${Math.round(performance.now() - start)} ms`;
    $("history").append(mark);
    if ($("history").children.length > 60) $("history").firstChild.remove();
    pending = false;
  }
}
$("request").onclick = request;
setInterval(() => {
  if ($("poll").checked) void request();
}, 500);

function createChannel(id) {
  const state = {
    transport: null,
    generation: 0,
    timer: null,
    attempts: 0,
    next: 0,
    storyId: null,
    duplicates: 0,
    skipped: 0,
    lastChunk: null,
    lastMessage: 0,
    disconnectedAt: null,
    recovery: null,
    firstChunk: false,
    snapshot: null,
    phase: "连接中…",
    text: "",
    mismatch: false,
  };
  const append = (text) => {
    state.text = (state.text + text).slice(-1500);
    const box = $(`${id}-novel`);
    box.textContent = state.text;
    box.scrollTop = box.scrollHeight;
  };
  function showStatus() {
    const old =
      latest &&
      state.snapshot &&
      (latest.version !== state.snapshot.version || latest.instance !== state.snapshot.instance);
    if (state.firstChunk && old && state.notedHTTPInstance !== latest.instance) {
      state.notedHTTPInstance = latest.instance;
      log(`${id}-log`, " · HTTP 已切换；此旧连接仍存活，保持连接直到实际断线", state.snapshot);
    }
    if (state.firstChunk && state.snapshot) {
      eventText(
        $(`${id}-status`),
        "连接存活 · ",
        state.snapshot,
        old ? " · 仍在旧实例（正常，未断线）" : " · 当前 HTTP 实例",
      );
    } else $(`${id}-status`).textContent = state.phase;
  }
  function stats() {
    $(`${id}-cursor`).textContent = String(state.next);
    $(`${id}-retries`).textContent = String(Math.max(0, state.attempts - 1));
    $(`${id}-recovery`).textContent =
      state.disconnectedAt !== null
        ? `恢复中 ${Math.round(performance.now() - state.disconnectedAt)} ms`
        : state.recovery === null
          ? "—"
          : `${state.recovery} ms`;
    $(`${id}-duplicates`).textContent = String(state.duplicates);
    $(`${id}-skipped`).textContent = String(state.skipped);
    const elapsed = state.lastChunk === null ? null : performance.now() - state.lastChunk;
    $(`${id}-stall`).textContent =
      elapsed === null
        ? "等待首段"
        : `${elapsed > 1500 ? "停滞" : "距上段"} ${Math.round(elapsed)} ms`;
    $(`${id}-continuity`).textContent = state.mismatch
      ? "故事已变更，游标已重置"
      : state.duplicates || state.skipped
        ? "检测到重复 / 缺字"
        : "未检测到重复 / 缺字";
  }
  function close() {
    state.generation++;
    if (!state.transport) return;
    state.transport.onopen = null;
    state.transport.onmessage = null;
    state.transport.onerror = null;
    state.transport.onclose = null;
    state.transport.close();
    state.transport = null;
  }
  function disconnect(reason) {
    close();
    if (state.disconnectedAt === null) {
      state.disconnectedAt = performance.now();
      append("\n【断线】\n");
      log(`${id}-log`, reason);
    }
    state.firstChunk = false;
    state.phase = `已断开 · ${reason} · 200 ms 后重试`;
    showStatus();
    if (state.timer === null) state.timer = setTimeout(connect, 200);
    stats();
  }
  function receive(raw) {
    let event;
    try {
      event = JSON.parse(raw);
      if (
        !event ||
        typeof event.color !== "string" ||
        typeof event.version !== "string" ||
        typeof event.instance !== "string"
      )
        throw new Error("无效快照");
      if (
        event.event === "chunk" &&
        (typeof event.storyId !== "string" ||
          typeof event.text !== "string" ||
          !Number.isSafeInteger(event.offset) ||
          event.offset < 0 ||
          !Number.isSafeInteger(event.next) ||
          event.next !== event.offset + event.text.length)
      )
        throw new Error("无效小说分段 / 游标");
    } catch (error) {
      log(`${id}-log`, `协议错误：${error}`);
      disconnect("协议错误");
      return;
    }
    state.lastMessage = performance.now();
    if (event.event !== "chunk") {
      if (event.event === "echo") log(`${id}-log`, ` · echo → ${event.echo ?? ""}`, event);
      return;
    }
    if (state.storyId !== null && state.storyId !== event.storyId) {
      state.mismatch = true;
      append(`\n【故事变更：${state.storyId} → ${event.storyId}；重置游标】\n`);
      log(`${id}-log`, "故事 ID 变更，不能声称连续；从头重新连接");
      state.storyId = event.storyId;
      state.next = 0;
      disconnect("故事变更");
      return;
    }
    state.storyId = event.storyId;
    if (!state.firstChunk) {
      const recovering = state.disconnectedAt !== null;
      if (recovering) {
        state.recovery = Math.round(performance.now() - state.disconnectedAt);
        state.disconnectedAt = null;
        append(`【恢复 ${state.recovery} ms】\n`);
      }
      log(
        `${id}-log`,
        recovering ? ` · 已恢复，首段耗时 ${state.recovery} ms` : " · 已连接，收到首段",
        event,
      );
      state.firstChunk = true;
    }
    const duplicate = Math.max(0, Math.min(event.next, state.next) - event.offset);
    const gap = Math.max(0, event.offset - state.next);
    if (duplicate || gap) {
      // Replaying from zero can repeat every chunk: report once per anomaly run.
      if (!state.anomaly)
        log(`${id}-log`, ` · 连续性异常：重复 ${duplicate} 字 / 缺 ${gap} 字`, event);
      if (!state.anomaly) append(duplicate ? "\n【重复内容】\n" : `\n【缺失 ${gap} 字】\n`);
    }
    state.anomaly = Boolean(duplicate || gap);
    state.duplicates += duplicate;
    state.skipped += gap;
    state.next = Math.max(state.next, event.next);
    state.lastChunk = performance.now();
    state.snapshot = event;
    append(event.text);
    showStatus();
    stats();
  }
  function connect() {
    clearTimeout(state.timer);
    state.timer = null;
    close();
    state.attempts++;
    state.firstChunk = false;
    state.anomaly = false;
    state.lastMessage = performance.now();
    state.phase = "连接中…等待首段（200 ms 重试 / 1500 ms 看门狗）";
    showStatus();
    const cursor = state.next;
    const generation = state.generation;
    try {
      const transport =
        id === "ws"
          ? new WebSocket(
              `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws?cursor=${cursor}`,
            )
          : new EventSource(`/api/events?cursor=${cursor}`);
      state.transport = transport;
      const current = () => state.generation === generation && state.transport === transport;
      transport.onmessage = ({ data }) => {
        if (current()) receive(data);
      };
      transport.onerror = () => {
        if (current()) disconnect("连接异常");
      };
      if (id === "ws")
        transport.onclose = ({ code }) => {
          if (current()) disconnect(`连接关闭 (${code})`);
        };
    } catch (error) {
      disconnect(`无法连接：${error}`);
    }
    stats();
  }
  $(`${id}-reconnect`).onclick = () => disconnect("手动模拟断线");
  setInterval(() => {
    if (state.transport && performance.now() - state.lastMessage > 1500)
      disconnect("超过 1500 ms 未收到消息");
    stats();
  }, 250);
  return { state, connect, showStatus };
}
const channels = [createChannel("ws"), createChannel("sse")];
for (const channel of channels) channel.connect();

$("echo-form").onsubmit = (event) => {
  event.preventDefault();
  const socket = channels[0].state.transport;
  if (socket?.readyState === WebSocket.OPEN) socket.send($("echo").value);
  else log("ws-log", "尚未连接，无法发送");
};
void request();
const navigation = performance.getEntriesByType("navigation")[0];
$("protocol").textContent = `页面协议：${navigation?.nextHopProtocol || "未知"}`;
