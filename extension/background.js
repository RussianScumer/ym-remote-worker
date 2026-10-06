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

// Скрытая вкладка сайта не перерисовывается: переходы и прокрутка списка в ней
// не срабатывают. На время запуска трека или волны делаем вкладку активной
// в её окне, потом возвращаем ту, что была. Свёрнутое окно не разворачиваем.
let restore = null; // { tabId, prevId, ops: Set<rid | "wave">, timer }

async function bringForward(t, op) {
  if (restore && restore.tabId === t.id) {
    restore.ops.add(op);
    return;
  }
  try {
    const tab = await chrome.tabs.get(t.id);
    if (tab.active) return;
    const [prev] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    await chrome.tabs.update(t.id, { active: true });
    if (prev) restore = { tabId: t.id, prevId: prev.id, ops: new Set([op]), timer: setTimeout(restoreTab, 45000) };
  } catch (_) {}
}

function opDone(tabId, op) {
  if (!restore || restore.tabId !== tabId || !restore.ops.delete(op)) return;
  if (!restore.ops.size) restoreTab();
}

async function restoreTab() {
  const r = restore;
  restore = null;
  if (!r) return;
  clearTimeout(r.timer);
  await new Promise((ok) => setTimeout(ok, 700)); // даём плееру стартовать
  try {
    const tab = await chrome.tabs.get(r.tabId);
    if (tab.active) await chrome.tabs.update(r.prevId, { active: true });
  } catch (_) {}
}

async function forwardVisible(t, msg, op) {
  await bringForward(t, op);
  t.port.postMessage(msg);
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
    const t = activeTab();
    if (d.type === "cmd") {
      if (!t) return;
      const msg = { type: "cmd", action: d.action };
      if (d.action === "wave") forwardVisible(t, msg, "wave");
      else t.port.postMessage(msg);
    } else if (d.type === "req" || d.type === "play") {
      // Запросы пульта (списки, запуск трека); ответ уйдёт обратно с тем же rid.
      if (!t) send({ type: "res", to: d.from, rid: d.rid, ok: false, error: "Вкладка не найдена" });
      else if (d.type === "play") forwardVisible(t, d, d.rid);
      else t.port.postMessage(d);
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
  tabs.set(id, { id, port, state: null, updated: Date.now() });

  port.onMessage.addListener((msg) => {
    if (msg.type === "res" || msg.type === "ack") {
      opDone(id, msg.type === "ack" ? msg.action : msg.rid);
      if (msg.type === "res") send(msg);
      return;
    }
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
