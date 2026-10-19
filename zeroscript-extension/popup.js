// SPDX-License-Identifier: GPL-3.0-or-later
const KOFI_URL = "https://ko-fi.com/sebattfg";
const SUPPORTED_HOSTS = [
  "chat.deepseek.com", "deepseek.com", "chatgpt.com", "chat.openai.com",
  "gemini.google.com", "www.kimi.ai", "kimi.ai",
  "chat.z.ai", "chat.qwen.ai", "arena.ai", "www.arena.ai", "lmarena.ai", "www.lmarena.ai",
  "www.meta.ai", "meta.ai",
];
const DEFAULT_AI_URL = "https://chat.deepseek.com/";

document.getElementById("ver").textContent = `v${chrome.runtime.getManifest().version}`;

function render(s) {
  const dot = document.getElementById("dot");
  const state = document.getElementById("state");
  const tools = document.getElementById("tools");
  const servers = document.getElementById("servers");
  const endpoint = document.getElementById("endpoint");
  const port = document.getElementById("port");
  const list = s.servers || [];
  // Show WHICH address the worker is trying. When the bridge is offline this
  // is the difference between "it's broken" and "your bridge is on another
  // port" - the exact confusion behind ERR_CONNECTION_REFUSED.
  const p = s.port || 17613;
  endpoint.textContent = `ws://127.0.0.1:${p}` + (s.connected ? "" : " · not reachable");
  if (port && document.activeElement !== port) {
    port.value = s.preferredPort || s.port || 17613;
  }
  // The Dev Kit (id "zeroscript", flag local) runs inside the Bridge and is
  // always alive - counting it here would light the dot up with Roblox Studio
  // closed. Connectivity tracks real MCP servers only, preferring the primary
  // one exactly like the in-page bar does.
  const real = list.filter((x) => !x.local && x.id !== "zeroscript");
  const roblox = real.find((x) => x.id === "roblox");
  const up = real.filter((x) => x.alive).length;
  const mcpOk = s.connected && (roblox
    ? (!!roblox.alive || (roblox.tools || 0) > 0)
    : (s.mcpAlive || up > 0 || s.tools > 0));
  const studioOff = mcpOk && s.studio === false; // MCP up but no Studio attached
  const ok = mcpOk && !studioOff;
  dot.className = "dot " + (s.connected ? (ok ? "on" : "warn") : "");
  state.textContent = s.connected
    ? (ok ? "Connected · Roblox Studio ready"
        : studioOff ? "Studio not connected · enable the MCP server in Studio"
        : "Bridge OK · open Roblox Studio")
    : (s.connecting ? "Connecting to bridge…" : "Bridge offline");
  const total = (s.tools || 0) + (s.localTools || 0);
  tools.textContent = s.connected ? `${total} tools available` : "Run bridge.py";
  const label = (x) => (x.id === "zeroscript" ? "zeroscript dev kit (built in)" : x.id);
  servers.textContent = s.connected
    ? list.map((x) => `${x.alive ? "●" : "○"} ${label(x)} (${x.alive ? x.tools + " tools" : "down"})`).join("\n")
    : "";
}

// The FIRST status request is the popup opening = a real "try now" gesture;
// the 2s refresh after that only reads, so an offline bridge is retried on the
// worker's own backoff instead of every 2 seconds.
let firstStatus = true;
function refresh() {
  const msg = { type: "status" };
  if (firstStatus) msg.resume = true;
  firstStatus = false;
  chrome.runtime.sendMessage(msg, (s) => s && render(s));
}

// The port box lets a bridge started with a custom port be reached without
// editing the extension. Empty / "auto" = scan the default range.
const portEl = document.getElementById("port");
function typedPort() {
  const raw = String((portEl && portEl.value) || "").trim();
  if (!raw || raw === "auto") return undefined;
  const p = Number(raw);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : NaN;
}

document.getElementById("reconnect").addEventListener("click", () => {
  const p = typedPort();
  const msg = { type: "reconnect" };
  if (Number.isInteger(p)) msg.port = p;
  chrome.runtime.sendMessage(msg, () => setTimeout(refresh, 400));
});
document.getElementById("savePort").addEventListener("click", () => {
  const p = typedPort();
  if (Number.isNaN(p)) {
    document.getElementById("state").textContent = "Port must be 1-65535";
    return;
  }
  chrome.runtime.sendMessage({ type: "set_port", port: p === undefined ? null : p }, (r) => {
    if (r && r.ok === false) {
      document.getElementById("state").textContent = r.error || "Invalid port";
      return;
    }
    setTimeout(refresh, 300);
  });
});
document.getElementById("restart").addEventListener("click", (e) => {
  e.target.textContent = "Restarting…";
  chrome.runtime.sendMessage({ type: "restart_mcp" }, () => {
    e.target.textContent = "⟳ Restart Roblox server";
    setTimeout(refresh, 600);
  });
});
document.getElementById("kofi").addEventListener("click", () => {
  chrome.tabs.create({ url: KOFI_URL });
});
document.getElementById("settings").addEventListener("click", () => {
  // Same mechanism as the Ko-fi button (chrome.tabs), but tries the in-page
  // panel on an already-open supported AI tab first, so opening it doesn't
  // require a conversation to already be started there.
  chrome.tabs.query({}, (tabs) => {
    const active = tabs.find((t) => t.active && t.url && SUPPORTED_HOSTS.some((h) => t.url.includes(h)));
    const anySupported = active || tabs.find((t) => t.url && SUPPORTED_HOSTS.some((h) => t.url.includes(h)));
    if (anySupported) {
      chrome.tabs.sendMessage(anySupported.id, { type: "zs-open-menu" });
      chrome.tabs.update(anySupported.id, { active: true });
    } else {
      chrome.tabs.create({ url: DEFAULT_AI_URL });
    }
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "zs-status") render(msg);
});
refresh();
setInterval(refresh, 2000);
