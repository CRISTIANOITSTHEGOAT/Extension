// Node smoke test for the background worker's bridge connection (run: node test-bridge.js).
// Not shipped.
//
// The reported bug was:
//   WebSocket connection to 'ws://127.0.0.1:17613/' failed:
//   Error in connection establishment: net::ERR_CONNECTION_REFUSED
// printed over and over. Two separate faults produced it:
//
//   1. the worker connected at load and retried FOREVER, even with no
//      supported AI tab open and no bridge running (pure console spam), and
//   2. the port was hardcoded to 17613, while bridge.py accepts a custom port
//      (ZS_BRIDGE_PORT / the documented fallback when 17613 is taken) - so a
//      healthy bridge could still be "connection refused".
//
// background.js is a service worker script, so it is evaluated against stub
// `chrome` / `WebSocket` globals - the same no-dependency approach as the
// other tests here. A controllable clock keeps the backoff out of real time.
const fs = require("fs");

const ok = (name, cond) => {
  console.log((cond ? "PASS" : "FAIL") + "  " + name);
  if (!cond) process.exitCode = 1;
};

const SRC = fs.readFileSync(__dirname + "/background.js", "utf8");

function makeClock() {
  let seq = 0;
  const timers = [];
  return {
    setTimeout(fn, ms) {
      const t = { id: ++seq, fn, ms, dead: false };
      timers.push(t);
      return t;
    },
    clearTimeout(t) { if (t) t.dead = true; },
    setInterval() { return { id: 0 }; },
    clearInterval() {},
    pending() { return timers.filter((t) => !t.dead); },
    // Fire every pending timer whose delay matches (or all when omitted).
    run(ms) {
      for (const t of [...timers]) {
        if (t.dead) continue;
        if (ms !== undefined && t.ms !== ms) continue;
        t.dead = true;
        t.fn();
      }
    },
  };
}

function makeFakeWS() {
  const instances = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.readyState = FakeWS.CONNECTING;
      this.sent = [];
      instances.push(this);
    }
    open() {
      this.readyState = FakeWS.OPEN;
      if (this.onopen) this.onopen();
    }
    handshake(obj) {
      if (this.onmessage) {
        this.onmessage({ data: JSON.stringify(Object.assign(
          { type: "connected", mcp_alive: true, studio: true, servers: [], tools: [] },
          obj || {}
        )) });
      }
    }
    fail() {
      if (this.readyState === FakeWS.CLOSED) return;
      this.readyState = FakeWS.CLOSED;
      if (this.onclose) this.onclose();
    }
    close() {
      if (this.readyState === FakeWS.CLOSED) return;
      this.readyState = FakeWS.CLOSED;
      if (this.onclose) this.onclose();
    }
    send(raw) { this.sent.push(raw); }
  }
  FakeWS.CONNECTING = 0;
  FakeWS.OPEN = 1;
  FakeWS.CLOSING = 2;
  FakeWS.CLOSED = 3;
  FakeWS.instances = instances;
  return FakeWS;
}

function load(tabUrls, stored) {
  const state = {
    tabs: (tabUrls || []).map((url, i) => ({ id: i + 1, url, active: i === 0 })),
    storage: Object.assign({}, stored || {}),
  };
  const msgListeners = [];
  const updateListeners = [];
  const removeListeners = [];
  const activateListeners = [];
  const chrome = {
    runtime: {
      onMessage: { addListener: (f) => msgListeners.push(f) },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
      sendMessage: () => Promise.resolve(),
      lastError: undefined,
      getManifest: () => ({ version: "test" }),
    },
    tabs: {
      // Emulate Chrome's URL filtering: background.js asks only for the
      // supported AI sites, so an unrelated tab must not count as demand.
      query: (q, cb) => {
        const patterns = q && q.url;
        if (!patterns) return cb(state.tabs);
        const list = Array.isArray(patterns) ? patterns : [patterns];
        cb(state.tabs.filter((t) => list.some((p) => t.url.startsWith(String(p).replace(/\*$/, "")))));
      },
      sendMessage: () => Promise.resolve(),
      onUpdated: { addListener: (f) => updateListeners.push(f) },
      onRemoved: { addListener: (f) => removeListeners.push(f) },
      onActivated: { addListener: (f) => activateListeners.push(f) },
      get: (id, cb) => cb(state.tabs.find((t) => t.id === id)),
      create() {},
      update() {},
    },
    storage: {
      local: {
        get: (_keys, cb) => cb(state.storage),
        set: (obj) => Object.assign(state.storage, obj),
        remove: (k) => { delete state.storage[k]; },
      },
    },
  };
  const clock = makeClock();
  const FakeWS = makeFakeWS();
  const api = new Function(
    "chrome", "WebSocket", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    SRC + "\n; return { connect, forceReconnect, statusObj, handleBridgeMessage };"
  )(chrome, FakeWS, clock.setTimeout, clock.clearTimeout, clock.setInterval, clock.clearInterval);
  // By default pretend the message came from a provider CONTENT SCRIPT (the
  // 5s status poll). Pass {} explicitly to act like the popup (no sender.tab).
  const ask = (msg, sender) => new Promise((resolve) => {
    msgListeners[0](msg, sender || { tab: { id: 1, url: "https://arena.ai/text/direct" } }, resolve);
  });
  return {
    api, chrome, clock, FakeWS, state, ask,
    sockets: FakeWS.instances,
    last: () => FakeWS.instances[FakeWS.instances.length - 1],
    navigate(url) {
      state.tabs = [{ id: 1, url, active: true }];
      updateListeners.forEach((f) => f(1, { url }, { id: 1, url }));
    },
    activate() {
      activateListeners.forEach((f) => f({ tabId: state.tabs[0] && state.tabs[0].id }));
    },
  };
}

(async () => {
  // ── 1. No supported AI tab: never touch the socket ────────────────────────
  {
    const E = load([]);
    ok("no AI tab open → the worker does not open a socket at all",
      E.sockets.length === 0);
    ok("no AI tab open → status still answers (UI stays functional)",
      (await E.ask({ type: "status" })).connected === false);
  }

  // ── 2. Opening a chat tab connects, on the default port ───────────────────
  {
    const E = load([]);
    E.navigate("https://arena.ai/text/direct");
    ok("opening arena.ai opens exactly one socket", E.sockets.length === 1);
    ok("the first attempt is the default port",
      E.last().url === "ws://127.0.0.1:17613");
    E.last().open();
    const st = await E.ask({ type: "status" });
    ok("an open socket reports connected immediately", st.connected === true);
    ok("status names the endpoint", st.endpoint === "ws://127.0.0.1:17613");
  }

  // ── 3. The bridge handshake is what makes it a ZeroScript bridge ──────────
  {
    const E = load(["https://lmarena.ai/c/new"]);
    E.last().open();
    E.last().handshake({ port: 17613 });
    const st = await E.ask({ type: "status" });
    ok("the bridge handshake is accepted as our bridge", st.connected === true);
    ok("the handshake port is remembered", st.port === 17613);
  }

  // ── 4. A refused default port scans upward (ZS_BRIDGE_PORT fallback) ──────
  {
    const E = load(["https://arena.ai/text/direct"]);
    ok("attempt 1 uses 17613", E.last().url.endsWith(":17613"));
    E.last().fail();
    ok("a refused socket schedules a retry", E.clock.pending().length > 0);
    E.clock.run(); // fire the backoff timer
    ok("attempt 2 scans to 17614 instead of hammering 17613",
      E.last().url === "ws://127.0.0.1:17614");
    E.last().open();
    E.last().handshake({ port: 17614 });
    ok("a bridge on 17614 is found and used", (await E.ask({ type: "status" })).port === 17614);
    ok("the detected port is persisted for next time",
      E.state.storage.zsBridgePortDetected === 17614);
    E.last().fail();
    E.clock.run();
    ok("after a good connection, reconnects stay on the working port",
      E.last().url === "ws://127.0.0.1:17614");
  }

  // ── 5. A user-set port wins, and invalid values are refused ───────────────
  {
    const E = load(["https://arena.ai/text/direct"], { zsBridgePort: 17777 });
    ok("a saved port is used on the first attempt", E.last().url.endsWith(":17777"));
    const r1 = await E.ask({ type: "set_port", port: "auto" });
    ok("set_port auto is accepted", r1.ok === true && r1.auto === true);
    ok("auto saves nothing (falls back to discovery)",
      E.state.storage.zsBridgePort === undefined);
    const r2 = await E.ask({ type: "set_port", port: 70000 });
    ok("an out-of-range port is rejected", r2.ok === false);
  }

  // ── 6. Auto-pause: no endless ERR_CONNECTION_REFUSED spam ─────────────────
  {
    const E = load(["https://arena.ai/text/direct"]);
    // One failure per scanned port (17613-17616), plus a repeat, then pause.
    const attempts = 5;
    for (let i = 0; i < attempts; i++) {
      E.last().fail();
      if (i < attempts - 1) E.clock.run(); // the last failure only arms the 60s probe
    }
    const st = await E.ask({ type: "status" });
    ok("after 4 refused attempts the worker auto-pauses", st.autoPaused === true);
    ok("a paused worker stops opening sockets", E.sockets.length === attempts);
    const slow = E.clock.pending();
    ok("a paused worker keeps only ONE slow probe (no hot loop)",
      slow.length === 1 && slow[0].ms === 60000);

    // The 5s content-script status poll must NOT resume it...
    await E.ask({ type: "status" }, { tab: { id: 1, url: "https://arena.ai/text/direct" } });
    ok("a content-script status poll does NOT resume a paused worker",
      E.sockets.length === attempts);

    // ...but the popup opening (no sender.tab + resume) is a real gesture.
    await E.ask({ type: "status", resume: true }, {});
    ok("opening the popup resumes the paused worker", E.sockets.length === attempts + 1);

    // Switching back to the AI tab also resumes it.
    E.sockets[E.sockets.length - 1].fail();
    E.clock.run(60000);
    E.last().fail();
    const beforeTab = E.sockets.length;
    E.activate();
    ok("switching back to the AI tab resumes the worker", E.sockets.length === beforeTab + 1);

    // And clicking Start/a tool call goes through the same resume path.
    E.sockets[E.sockets.length - 1].fail();
    for (let i = 0; i < 5 && E.clock.pending().length; i++) { E.clock.run(); E.last().fail(); }
    const before = E.sockets.length;
    const tools = E.ask({ type: "list_tools" });
    await new Promise((r) => setImmediate(r));
    ok("a tool call (Start) always wakes the worker again", E.sockets.length > before);
    E.last().handshake({ port: 17613 });
    // The worker sends {type:"list_tools", id:1} once connected; answer it so
    // the tool-call promise can finish.
    await new Promise((r) => setImmediate(r));
    E.last().onmessage({ data: JSON.stringify({ type: "tools", id: 1, tools: [], servers: [] }) });
    await tools;
  }

  // ── 7. Something that is NOT the bridge on the port is dropped ────────────
  {
    const E = load(["https://arena.ai/text/direct"]);
    E.last().open();
    E.clock.run(20000); // the handshake watchdog fires: no "connected" frame
    ok("a socket that never sends the bridge handshake is closed",
      E.last().readyState === E.FakeWS.CLOSED);
    E.clock.run(); // reconnect timer
    ok("and the worker keeps scanning other ports",
      E.last().url === "ws://127.0.0.1:17614");
  }

  // ── 8. Unrelated tabs never wake the bridge ───────────────────────────────
  {
    const E = load(["https://example.com/"]);
    E.navigate("https://example.com/other");
    ok("navigating inside an unrelated site does not connect", E.sockets.length === 0);
  }

  process.exit(process.exitCode || 0);
})();
