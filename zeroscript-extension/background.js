// SPDX-License-Identifier: GPL-3.0-or-later
// background.js - service worker.
// Owns ONE resilient WebSocket to the local bridge (ws://127.0.0.1:PORT).
// Keeping the socket here (not in the content script) avoids https→ws mixed
// content issues and centralises reconnect / timeout logic.
//
// Contract with content.js: every sendMessage ALWAYS gets a response object,
// even when the bridge is offline. The agentic loop must never hang waiting.
//
// ── Why this file no longer connects in a hot loop ────────────────────────
// The old worker called connect() unconditionally at load and retried every
// 1-5s FOREVER. With start.bat closed, Chrome therefore printed
//   "WebSocket connection to 'ws://127.0.0.1:17613/' failed:
//    Error in connection establishment: net::ERR_CONNECTION_REFUSED"
// every few seconds, on every Chrome start, even when the user was nowhere
// near a supported AI. Nothing could ever succeed until the bridge was
// started, so the retries were pure noise (and looked like the extension was
// broken). Three rules now:
//
//   1. CONNECT ON DEMAND. The socket is only opened while a supported AI tab
//      is open, the popup is used, or a command needs the bridge.
//   2. BACK OFF, THEN BE QUIET. Failed attempts back off (0.8s → 30s) and
//      auto-pause after a few; only a real gesture (opening a chat / popup,
//      pressing Start, clicking Reconnect) resumes them.
//   3. FIND THE BRIDGE ITSELF. bridge.py honours ZS_BRIDGE_PORT (a custom
//      port, or one chosen because 17613 was taken), so a hardcoded 17613
//      used to refuse even with a healthy bridge running. We try the
//      configured/last-known port, then scan 17613-17618, and verify the
//      socket really is a ZeroScript bridge by waiting for one of its own
//      protocol frames (normally the opening "connected") before trusting it.

const DEFAULT_PORT = 17613;
// Consecutive scan ports (inclusive): a bridge launched with
// `set ZS_BRIDGE_PORT=17614` (the documented fallback when 17613 is taken)
// is found automatically.
const PORT_SCAN = 4;
// A real bridge sends {"type":"connected", ...} right after accepting the
// socket. It is NOT instant: bridge.py probes Studio first (two MCP calls with
// an 8s budget each), so a slow/unresponsive Studio can delay that first frame
// by ~16s. The socket itself is usable meanwhile (requests are buffered), so
// opening already counts as connected for sending; this longer window only
// decides when a port that never speaks the protocol is dropped and scanning
// continues.
const HANDSHAKE_MS = 20000;
const RECONNECT_MIN = 800;
const RECONNECT_MAX = 30000;
// Stop auto-retrying after this many consecutive failures with no successful
// handshake. One full pass over PORT_SCAN ports plus one repeat - a chat tab
// stays open for hours; without this the worker would keep producing
// ERR_CONNECTION_REFUSED forever.
const AUTO_PAUSE_AFTER = PORT_SCAN + 1;
// While paused, still look once in a while: users often open the AI first and
// start start.bat afterwards, and a 60s probe finds the bridge on its own
// without restoring the every-few-seconds console spam. (A tab activation and
// any Start/Reconnect click also resume immediately.)
const PAUSED_RETRY_MS = 60000;
const HEARTBEAT_MS = 10000;
// If no message (incl. pong) arrives within this window while we believe we're
// connected, the socket is half-open: force a reconnect instead of letting
// pending requests slowly time out.
const STALE_SOCKET_MS = 25000;
const REQUEST_TIMEOUT_DEFAULT = 130000; // a bit above the 120s tool timeout
// Frames only a ZeroScript bridge sends. Receiving one proves the port belongs
// to our bridge and not to some unrelated local WebSocket server.
const BRIDGE_FRAMES = new Set(["connected", "tools", "pong", "studio_status", "tool_result", "mcp_status", "server_changed", "error"]);

// Chat sites where a ZeroScript provider content script runs. Status pushes go
// to every tab matching these. Add the new provider's URL pattern here (and in
// manifest.json content_scripts + host_permissions) when integrating another AI.
// lmarena.ai is the same app as arena.ai (LMArena rebranded to Arena and moved
// to arena.ai in January 2026) - old links and bookmarks still point at the old
// domain, so both are served by the same provider.
const PROVIDER_URLS = ["https://chat.deepseek.com/*", "https://chatgpt.com/*", "https://chat.openai.com/*", "https://gemini.google.com/*", "https://www.kimi.ai/*", "https://kimi.ai/*", "https://chat.z.ai/*", "https://chat.qwen.ai/*", "https://arena.ai/*", "https://www.arena.ai/*", "https://lmarena.ai/*", "https://www.lmarena.ai/*", "https://www.meta.ai/*", "https://meta.ai/*"];
// Same list as host names, for cheap URL checks in tab listeners.
const PROVIDER_HOSTS = ["chat.deepseek.com", "chatgpt.com", "chat.openai.com", "gemini.google.com", "www.kimi.ai", "kimi.ai", "chat.z.ai", "chat.qwen.ai", "arena.ai", "www.arena.ai", "lmarena.ai", "www.lmarena.ai", "www.meta.ai", "meta.ai"];

let ws = null;
let wsPort = DEFAULT_PORT;
let connected = false;
let connecting = false;
// A real ZeroScript bridge answered on this socket (its "connected" frame).
let handshakeOk = false;
let everConnected = false; // a handshake succeeded at least once this worker
let connectSeq = 0;        // identifies the CURRENT socket; stale handlers exit
let handshakeTimer = null;
let reconnectDelay = RECONNECT_MIN;
let reconnectTimer = null;
let heartbeatTimer = null;
let failures = 0;
let autoPaused = false;    // stop background retries until a real gesture
let lastMessageAt = 0; // timestamp of the last frame received from the bridge

// Port state. `preferredPort` is what the user saved in the popup (or null =
// automatic). `detectedPort` is the last port that actually spoke the bridge
// protocol, remembered across restarts so the common case is a first-try hit.
let preferredPort = null;
let detectedPort = null;
let bridgePort = DEFAULT_PORT;
let portCursor = 0;

let providerTabs = 0;
let demandUntil = 0; // popup / explicit gesture keeps demand alive briefly
let nextId = 1;
const pending = new Map(); // id -> {resolve, timer}
let toolsCache = [];
let toolsAt = 0;
let toolsRefresh = null;
let mcpAlive = false;
let serversCache = [];
// true/false = a PLACE is loaded and usable in Roblox Studio; null = unknown.
// The MCP process stays alive when Studio is closed or its MCP option is off,
// so this is probed separately (bridge "studio_status").
let studioConnected = null;
// true/false = a Roblox Studio app is connected to the MCP server at all; null =
// unknown. studioApp=true with studioConnected=false means "Studio open but no
// place"; studioApp=false means "Studio closed OR its MCP option disabled".
let studioApp = null;
// true/false = a Roblox Studio WINDOW/PROCESS exists on this machine (checked
// bridge-side via tasklist); null = unknown/old bridge. Distinguishes the two
// studioApp=false sub-cases the UI must word differently: Studio genuinely not
// launched ("open Roblox Studio") vs Studio OPEN but its MCP plugin never
// registered with the bridge - the documented fix for the latter is opening
// Assistant Settings > MCP Servers inside Studio (validated live 3x), which
// "open Roblox Studio" wording completely fails to convey.
let studioProc = null;

function log(...a) {
  console.log("[zs-bg]", ...a);
}

const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65536;
const urlFor = (port) => `ws://127.0.0.1:${port}`;
const isOpen = () => !!ws && ws.readyState === WebSocket.OPEN;

// ── Demand: when is a connection worth attempting? ──────────────────────
// A supported AI tab is the only place a session can exist. The popup is an
// explicit request. Everything else waits.
function hasDemand() {
  return providerTabs > 0 || Date.now() < demandUntil;
}

// A REAL gesture (chat tab opened/reloaded, popup, Start, Reconnect). Clears
// the pause/backoff so the next attempt is immediate.
function resume() {
  failures = 0;
  autoPaused = false;
  reconnectDelay = RECONNECT_MIN;
  if (hasDemand()) connect(true);
}

function isProviderUrl(u) {
  try {
    return PROVIDER_HOSTS.includes(new URL(u).hostname);
  } catch {
    return false;
  }
}

// How many supported AI tabs are open? `nudge` is true for a fresh signal
// (startup / navigation), false for housekeeping (a tab closing) - a closing
// tab must not reset the backoff of an offline bridge.
function refreshProviderTabs(nudge) {
  try {
    chrome.tabs.query({ url: PROVIDER_URLS }, (tabs) => {
      if (chrome.runtime.lastError) {
        providerTabs = 0;
        return;
      }
      providerTabs = (tabs || []).length;
      if (providerTabs > 0 && nudge) resume();
    });
  } catch {
    providerTabs = 0;
  }
}

// ── Port selection ──────────────────────────────────────────────────────
function portCandidates() {
  const list = [];
  const push = (p) => {
    if (validPort(p) && !list.includes(p)) list.push(p);
  };
  if (preferredPort) {
    // The user picked a port: that is the only one worth trying.
    push(preferredPort);
  } else {
    // Last known-good first (usually 17613), then the documented scan range.
    push(detectedPort || DEFAULT_PORT);
    for (let i = 0; i < PORT_SCAN; i++) push(DEFAULT_PORT + i);
  }
  return list;
}

function nextPort() {
  // Once a bridge has answered, stay on the port that worked.
  if (everConnected) return bridgePort;
  const list = portCandidates();
  return list[portCursor % list.length];
}

function rememberPort(port) {
  if (!validPort(port)) return;
  bridgePort = port;
  wsPort = port;
  if (detectedPort !== port) {
    detectedPort = port;
    try { chrome.storage.local.set({ zsBridgePortDetected: port }); } catch {}
  }
}

// ── Settings ────────────────────────────────────────────────────────────
function loadSettings(done) {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (typeof done === "function") done();
  };
  try {
    chrome.storage.local.get(["zsBridgePort", "zsBridgePortDetected"], (r) => {
      if (chrome.runtime.lastError) {
        finish();
        return;
      }
      const p = Number(r && r.zsBridgePort);
      if (validPort(p)) preferredPort = p;
      const d = Number(r && r.zsBridgePortDetected);
      if (validPort(d)) detectedPort = d;
      bridgePort = preferredPort || detectedPort || DEFAULT_PORT;
      finish();
    });
  } catch {
    finish();
  }
}

function savePreferredPort(port) {
  preferredPort = validPort(port) ? port : null;
  try {
    if (preferredPort) chrome.storage.local.set({ zsBridgePort: preferredPort });
    else chrome.storage.local.remove("zsBridgePort");
  } catch {}
  // A port change invalidates everything we learned about the old one.
  everConnected = false;
  portCursor = 0;
  bridgePort = preferredPort || detectedPort || DEFAULT_PORT;
}

// ── WebSocket lifecycle ─────────────────────────────────────────────────
function connect(force) {
  if (!force && !hasDemand()) return;
  if (!force && autoPaused) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const port = nextPort();
  const url = urlFor(port);
  const my = ++connectSeq;
  let sock;
  try {
    sock = new WebSocket(url);
  } catch (e) {
    log("WebSocket ctor failed", e);
    onAttemptFailed(my, false);
    return;
  }
  ws = sock;
  wsPort = port;
  bridgePort = port;
  connecting = true;
  handshakeOk = false;

  sock.onopen = () => {
    if (my !== connectSeq) return;
    connecting = false;
    connected = true;
    lastMessageAt = Date.now();
    reconnectDelay = RECONNECT_MIN;
    log(`socket open on ${url} (waiting for bridge handshake)`);
    // Requests may be sent as soon as the socket is open - the bridge buffers
    // them while its initial Studio probe runs. Making senders wait for the
    // "connected" frame would fail every call during a slow probe.
    flushConnWaiters(true);
    startHeartbeat();
    broadcastStatus();
    // A random WebSocket server on this port must not be mistaken for the
    // bridge. Only the bridge's own "connected" frame (fast) proves it.
    clearTimeout(handshakeTimer);
    handshakeTimer = setTimeout(() => {
      if (my !== connectSeq || !connected || handshakeOk) return;
      log(`no ZeroScript bridge handshake on port ${port} - not our bridge`);
      try { sock.close(); } catch {}
    }, HANDSHAKE_MS);
  };

  sock.onmessage = (ev) => {
    if (my !== connectSeq) return;
    lastMessageAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleBridgeMessage(msg);
  };

  sock.onclose = () => {
    if (my !== connectSeq) return;
    const wasBridge = handshakeOk;
    connected = false;
    connecting = false;
    handshakeOk = false;
    ws = null;
    clearTimeout(handshakeTimer);
    handshakeTimer = null;
    mcpAlive = false;
    studioConnected = null;
    studioApp = null;
    studioProc = null;
    serversCache = [];
    stopHeartbeat();
    failAllPending("bridge connection closed");
    broadcastStatus();
    onAttemptFailed(my, wasBridge);
  };

  sock.onerror = () => {
    if (my !== connectSeq) return;
    // onclose will follow; close explicitly so a browser that only reports
    // the error still tears the socket down promptly.
    try { sock.close(); } catch {}
  };
}

// The socket ended. Decide whether to retry, keep scanning ports, or pause.
function onAttemptFailed(my, wasBridge) {
  if (my !== connectSeq) return;
  if (wasBridge) {
    // This WAS the bridge and it went away (restart, sleep, studio closed).
    // Keep trying, but never auto-pause a connection that used to work.
    failures = 0;
  } else {
    failures++;
    if (!everConnected) portCursor++; // try the next candidate port
    if (!everConnected && failures >= AUTO_PAUSE_AFTER) {
      autoPaused = true;
      log(`no bridge after ${failures} attempts - slowing down to one probe a minute`);
      flushConnWaiters(false); // nobody is going to answer: fail the send now
      broadcastStatus();
      schedulePausedRetry();
      return;
    }
  }
  if (!hasDemand()) {
    flushConnWaiters(false);
    return;
  }
  scheduleReconnect();
}

// One cheap probe a minute while paused, so a bridge launched AFTER the chat
// page still gets picked up without the user touching anything.
function schedulePausedRetry() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (!hasDemand()) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(true);
  }, PAUSED_RETRY_MS);
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (!hasDemand()) {
    reconnectTimer = null;
    return;
  }
  // While still walking the candidate ports for the first time, do it FAST
  // (a bridge on 17618 should be found in about a second, not after 30s of
  // exponential backoff). The backoff only starts once every port has been
  // tried - that is the "bridge really is not running" case.
  const scanning = !everConnected && !preferredPort && failures < portCandidates().length;
  let delay;
  if (scanning) {
    delay = 180;
  } else {
    const base = Math.min(reconnectDelay, RECONNECT_MAX);
    const jitter = Math.round(base * (Math.random() * 0.3 - 0.15));
    delay = Math.max(250, base + jitter);
    reconnectDelay = Math.min(reconnectDelay * 1.7, RECONNECT_MAX);
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(true);
  }, delay);
}

function dropSocket(reason) {
  connectSeq++; // make every handler of the old socket a no-op
  const old = ws;
  ws = null;
  connected = false;
  connecting = false;
  handshakeOk = false;
  clearTimeout(handshakeTimer);
  handshakeTimer = null;
  stopHeartbeat();
  if (old) { try { old.close(); } catch {} }
  failAllPending(reason || "bridge connection reset");
}

// Reconnect from scratch: forget the previous socket and re-scan ports.
function forceReconnect(port) {
  if (port !== undefined) savePreferredPort(port);
  failures = 0;
  autoPaused = false;
  reconnectDelay = RECONNECT_MIN;
  everConnected = false;
  portCursor = 0;
  dropSocket("reconnecting to bridge");
  demandUntil = Date.now() + 30000;
  broadcastStatus();
  connect(true);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (connected) {
      // Half-open socket: the WS still reports OPEN but nothing comes through.
      // The pong (and every other frame) refreshes lastMessageAt; if it has
      // gone stale, drop the dead socket so onclose triggers a reconnect.
      if (lastMessageAt && Date.now() - lastMessageAt > STALE_SOCKET_MS) {
        log("socket stale, forcing reconnect");
        try { ws.close(); } catch {}
        return;
      }
      // Keeps the MV3 service worker alive AND detects a half-open socket.
      send({ type: "ping" }).catch(() => {});
      refreshStudioStatus();
    }
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

// ── Connection waiters (event-driven, not a 100ms poll) ──────────────────
// The old waitForConnection() polled a flag every 100ms, so the first send
// after an MV3 worker wake-up could lose up to 100ms before it even started.
// Resolving from onopen is instantaneous.
let connWaiters = [];

function waitForConnection(timeout = 8000) {
  if (isOpen()) return Promise.resolve(true);
  // A caller that genuinely needs the bridge (Start / a tool call) counts as
  // demand and clears an auto-pause.
  resume();
  connect(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      connWaiters = connWaiters.filter((w) => w !== waiter);
      resolve(v);
    };
    const waiter = { finish };
    const t = setTimeout(() => finish(false), timeout);
    connWaiters.push(waiter);
  });
}

function flushConnWaiters(ok) {
  const list = connWaiters;
  connWaiters = [];
  for (const w of list) w.finish(ok);
}

// ── request/response over the socket ────────────────────────────────────
async function send(obj, timeout = REQUEST_TIMEOUT_DEFAULT) {
  // The MV3 service worker can be suspended; the first message after a wake-up
  // arrives before the socket has re-opened. Wait for it instead of failing -
  // otherwise Kimi wrongly hears "bridge offline".
  if (!isOpen()) await waitForConnection(8000);
  return new Promise((resolve) => {
    if (!isOpen()) {
      resolve({ ok: false, kind: "disconnected", error: "bridge not connected" });
      return;
    }
    const id = nextId++;
    const payload = { ...obj, id };
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ ok: false, kind: "timeout", error: "bridge did not respond in time" });
      }
    }, timeout);
    pending.set(id, { resolve, timer });
    try {
      ws.send(JSON.stringify(payload));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ ok: false, kind: "disconnected", error: String(e) });
    }
  });
}

// Ask the bridge whether a Roblox Studio instance is actually connected to the
// MCP server. Broadcasts only on change so the UI updates promptly but quietly.
let studioProbing = false;
async function refreshStudioStatus() {
  if (studioProbing || !connected) return;
  studioProbing = true;
  try {
    const r = await send({ type: "studio_status" }, 12000);
    const v = r && r.ok && typeof r.studio === "boolean" ? r.studio : null;
    if (v !== studioConnected) {
      studioConnected = v;
      broadcastStatus();
    }
  } finally {
    studioProbing = false;
  }
}

function handleBridgeMessage(msg) {
  // A protocol frame from the socket proves this is the ZeroScript bridge (a
  // random server on the port would not speak this protocol).
  if (!handshakeOk && msg && BRIDGE_FRAMES.has(msg.type)) {
    handshakeOk = true;
    everConnected = true;
    failures = 0;
    autoPaused = false;
    clearTimeout(handshakeTimer);
    handshakeTimer = null;
    rememberPort(validPort(Number(msg && msg.port)) ? Number(msg.port) : wsPort);
    log(`bridge handshake OK on port ${bridgePort}`);
    flushConnWaiters(true);
    broadcastStatus();
  }
  if ("studio" in msg && (typeof msg.studio === "boolean" || msg.studio === null)) {
    studioConnected = msg.studio;
  }
  if ("studio_app" in msg && (typeof msg.studio_app === "boolean" || msg.studio_app === null)) {
    studioApp = msg.studio_app;
  }
  if ("studio_proc" in msg && (typeof msg.studio_proc === "boolean" || msg.studio_proc === null)) {
    studioProc = msg.studio_proc;
  }
  if ("port" in msg && validPort(Number(msg.port))) {
    rememberPort(Number(msg.port));
  }
  if (msg.type === "studio_status") {
    resolvePending(msg.id, { ok: true, studio: studioConnected });
    broadcastStatus();
    return;
  }
  if (msg.type === "connected") {
    mcpAlive = !!msg.mcp_alive;
    if (Array.isArray(msg.tools)) toolsCache = msg.tools;
    if (Array.isArray(msg.servers)) serversCache = msg.servers;
    broadcastStatus();
    return;
  }
  if (msg.type === "pong") {
    resolvePending(msg.id, { ok: true });
    return;
  }
  if (msg.type === "tools") {
    if (Array.isArray(msg.tools)) { toolsCache = msg.tools; toolsAt = Date.now(); }
    if (Array.isArray(msg.servers)) serversCache = msg.servers;
    mcpAlive = !!msg.mcp_alive;
    resolvePending(msg.id, { ok: true, tools: toolsCache });
    broadcastStatus();
    return;
  }
  if (msg.type === "tool_result") {
    resolvePending(msg.id, msg.ok
      ? { ok: true, text: msg.text, images: msg.images || [] }
      : { ok: false, kind: msg.kind, error: msg.error });
    return;
  }
  if (msg.type === "mcp_status") {
    mcpAlive = !!msg.alive;
    if (Array.isArray(msg.tools)) toolsCache = msg.tools;
    if (Array.isArray(msg.servers)) serversCache = msg.servers;
    resolvePending(msg.id, { ok: !!msg.ok, alive: msg.alive, error: msg.error });
    broadcastStatus();
    return;
  }
  if (msg.type === "server_changed") {
    // The bridge acks, then restarts itself to reload config.json. The socket
    // will drop right after this - the content script shows a spinner until the
    // reconnect lands and a fresh status arrives.
    resolvePending(msg.id, { ok: !!msg.ok, error: msg.error, restarting: !!msg.restarting });
    return;
  }
  if (msg.type === "error") {
    resolvePending(msg.id, { ok: false, error: msg.error });
    return;
  }
}

function resolvePending(id, value) {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(value);
}

function failAllPending(reason) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, kind: "disconnected", error: reason });
  }
  pending.clear();
}

// ── status push to any open AI tab + popup ───────────────────────────────
function statusObj() {
  // `tools` counts REAL MCP tools only: the bridge also advertises its own
  // Dev Kit commands (flagged local, server id "zeroscript"), which are always
  // available - folding them into `tools` would make every connectivity check
  // that falls back to "tools > 0" read as healthy with Roblox Studio closed.
  // They are reported next to it so the UI can still show the true total.
  const realTools = toolsCache.filter((t) => !t.local);
  return {
    type: "zs-status", connected, connecting, mcpAlive, studio: studioConnected, studioApp, studioProc,
    tools: realTools.length, localTools: toolsCache.length - realTools.length,
    servers: serversCache,
    // Where we are pointing, so the UI can say "bridge offline on 127.0.0.1:17613"
    // (or whatever port) instead of a generic "offline" with no next step.
    port: bridgePort, endpoint: urlFor(bridgePort),
    preferredPort, detectedPort: everConnected ? bridgePort : detectedPort,
    autoPaused,
  };
}

function broadcastStatus() {
  chrome.runtime.sendMessage(statusObj()).catch(() => {});
  chrome.tabs.query({ url: PROVIDER_URLS }, (tabs) => {
    for (const t of (tabs || [])) chrome.tabs.sendMessage(t.id, statusObj()).catch(() => {});
  });
}

// ── messages from content.js / popup.js ─────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.type) {
      sendResponse({ ok: false, error: "unknown message" });
      return;
    }
    switch (msg.type) {
      case "status":
        // The popup (no sender.tab) is an explicit gesture ONLY on its first
        // message (`resume`); its 2s refresh loop just reads. A content-script
        // poll fires every 5s and must never reconnect either, or both the
        // backoff and the auto-pause above would be meaningless (that poll was
        // the old ERR_CONNECTION_REFUSED spam). Reconnects come from a
        // tab/navigation gesture, the popup opening, Start, or a tool call
        // (see waitForConnection).
        if (!sender || !sender.tab) {
          // Keep demand alive while the popup is open, but only reset the
          // backoff on its FIRST message (opening it) - otherwise the 2s poll
          // would defeat the backoff exactly like the old hot loop.
          demandUntil = Date.now() + 30000;
          if (msg.resume) resume();
        }
        sendResponse(statusObj());
        break;
      case "list_tools": {
        // Stale-while-revalidate: once the worker holds a catalogue (from this
        // session or an earlier call), answer with it INSTANTLY and refresh in
        // the background. Boot no longer waits up to 10s for a dead addon MCP
        // server just to receive a list it already had.
        const cached = toolsCache.length > 0 && connected;
        if (cached) {
          sendResponse({ ok: true, tools: toolsCache, cached: true });
          refreshTools().then((r) => {
            if (r && r.ok) broadcastStatus();
          }).catch(() => {});
          break;
        }
        const r = await send({ type: "list_tools" }, 10000);
        if (r.ok) {
          if (Array.isArray(r.tools)) { toolsCache = r.tools; toolsAt = Date.now(); }
          sendResponse({ ok: true, tools: r.tools });
        } else {
          sendResponse({ ok: toolsCache.length > 0, tools: toolsCache, error: r.error });
        }
        break;
      }
      case "call_tool": {
        const timeout = (msg.timeout || 120000) + 10000;
        const r = await send(
          { type: "call_tool", name: msg.name, arguments: msg.arguments, timeout: msg.timeout },
          timeout
        );
        sendResponse(r);
        break;
      }
      case "restart_mcp": {
        const r = await send({ type: "restart_mcp" }, 30000);
        sendResponse(r);
        break;
      }
      case "add_server": {
        // A local server passes command/args/env; a remote one passes url (+headers).
        const r = await send({
          type: "add_server", server_id: msg.server_id,
          command: msg.command, args: msg.args, env: msg.env,
          url: msg.url, headers: msg.headers,
        }, 15000);
        sendResponse(r);
        break;
      }
      case "remove_server": {
        const r = await send({ type: "remove_server", server_id: msg.server_id }, 15000);
        sendResponse(r);
        break;
      }
      case "reconnect": {
        const p = Number(msg.port);
        forceReconnect(validPort(p) ? p : undefined);
        sendResponse({ ok: true, port: bridgePort });
        break;
      }
      case "set_port": {
        const raw = msg.port;
        if (raw === null || raw === "" || raw === "auto" || raw === undefined) {
          savePreferredPort(null);
          forceReconnect();
          sendResponse({ ok: true, port: bridgePort, auto: true });
          break;
        }
        const p = Number(raw);
        if (!validPort(p)) {
          sendResponse({ ok: false, error: "port must be 1-65535" });
          break;
        }
        savePreferredPort(p);
        forceReconnect();
        sendResponse({ ok: true, port: p });
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true; // async sendResponse
});

// One catalogue refresh at a time, shared by every caller.
function refreshTools() {
  if (toolsRefresh) return toolsRefresh;
  toolsRefresh = send({ type: "list_tools" }, 10000).then((r) => {
    if (r && r.ok && Array.isArray(r.tools)) {
      toolsCache = r.tools;
      toolsAt = Date.now();
    }
    return r;
  }).finally(() => {
    toolsRefresh = null;
  });
  return toolsRefresh;
}

// Wake/keepalive hooks. Startup/install now go through the same demand check:
// with no supported AI tab open there is nothing to connect FOR, and the old
// unconditional connect() was exactly what spammed ERR_CONNECTION_REFUSED.
chrome.runtime.onStartup.addListener(() => refreshProviderTabs(true));
chrome.runtime.onInstalled.addListener(() => refreshProviderTabs(true));

// A supported AI navigating (or finishing a reload) is a real gesture; any
// other navigation is housekeeping (it may mean the last AI tab went away).
chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
  if (!info) return;
  if (!info.url && info.status !== "complete") return;
  if (!tab || !tab.url) { refreshProviderTabs(false); return; }
  refreshProviderTabs(isProviderUrl(tab.url));
});
chrome.tabs.onRemoved.addListener(() => refreshProviderTabs(false));
// Switching back to an AI tab is a real gesture - the common flow is "start
// start.bat, then click on the AI tab". It also un-pauses a worker that had
// given up, without waiting for the slow probe.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  try {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      if (tab && tab.url && isProviderUrl(tab.url)) refreshProviderTabs(true);
    });
  } catch {}
});

// Boot: read the saved/detected port BEFORE the first attempt, then connect
// only if there is actually a supported AI tab open.
loadSettings(() => refreshProviderTabs(true));
