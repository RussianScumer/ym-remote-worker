// Держит одно WebSocket-соединение с облачным ретранслятором, пока открыта
// хотя бы одна вкладка Яндекс Музыки. Пинг каждые 20 секунд не даёт Chrome
// усыпить фоновый скрипт (Chrome 116+).

const tabs = new Map(); // tabId -> { port, state, updated }
let ws = null;
let wsUrl = "";
let pingTimer = null;
let reconnectTimer = null;
let retry = 0;

async function buildUrl() {
  const { server, room } = await chrome.storage.local.get(["server", "room"]);
  if (!server || !room) return "";
  const base = server.trim().replace(/\/+$/, "").replace(/^http/, "ws");
  return `${base}/ws?role=player&room=${room}`;
}

// Вкладка, которой отправляем команды: та, где играет музыка,
// иначе та, что последней сообщила о себе.
function activeTab() {
  let best = null;
  for (const t of tabs.values()) {
    if (!best) { best = t; continue; }
    const tp = t.state && t.state.playing, bp = best.state && best.state.playing;
    if ((tp && !bp) || (tp === bp && t.updated > best.updated)) best = t;
  }
  return best;
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function sendState() {
  const t = activeTab();
  if (t && t.state) send({ type: "state", state: t.state });
}

function closeWs() {
  clearInterval(pingTimer);
  clearTimeout(reconnectTimer);
  if (ws) {
    const old = ws;
    ws = null;
    old.onclose = null;
    try { old.close(); } catch (_) {}
  }
}

async function ensureWs() {
  const url = tabs.size ? await buildUrl() : "";
  if (url === wsUrl && ws && ws.readyState <= WebSocket.OPEN) return;
  closeWs();
  wsUrl = url;
  if (!url) return;

  const sock = new WebSocket(url);
  ws = sock;
  sock.onopen = () => {
    retry = 0;
    sendState();
    pingTimer = setInterval(() => {
      if (sock.readyState === WebSocket.OPEN) sock.send("ping");
    }, 20000);
  };
  sock.onmessage = (e) => {
    if (e.data === "pong") return;
    let d;
    try { d = JSON.parse(e.data); } catch (_) { return; }
    if (d.type === "cmd") {
      const t = activeTab();
      if (t) t.port.postMessage({ type: "cmd", action: d.action });
    }
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    clearInterval(pingTimer);
    ws = null;
    wsUrl = "";
    if (tabs.size) {
      reconnectTimer = setTimeout(ensureWs, Math.min(15000, 1000 * 2 ** retry++));
    }
  };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ym-tab" || !port.sender.tab) return;
  const id = port.sender.tab.id;
  tabs.set(id, { port, state: null, updated: Date.now() });

  port.onMessage.addListener((msg) => {
    if (msg.type !== "state") return;
    const t = tabs.get(id);
    if (!t) return;
    t.state = msg.state;
    t.updated = Date.now();
    if (activeTab() === t) send({ type: "state", state: t.state });
  });

  port.onDisconnect.addListener(() => {
    tabs.delete(id);
    if (tabs.size) sendState();
    else ensureWs(); // вкладок нет — закрываем соединение, телефон увидит «вкладка закрыта»
  });

  ensureWs();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.server || changes.room)) {
    wsUrl = ""; // форсируем переподключение с новыми настройками
    ensureWs();
  }
});

// Статус для попапа
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === "status") {
    const t = activeTab();
    reply({
      tabs: tabs.size,
      connected: !!ws && ws.readyState === WebSocket.OPEN,
      title: t && t.state ? t.state.title : "",
    });
  }
});
