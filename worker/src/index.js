import REMOTE_HTML from "./remote.html";

const ROOM_RE = /^[a-f0-9]{32}$/;
const ACTIONS = new Set(["prev", "next", "toggle", "wave"]);
const RID_RE = /^[\w-]{1,32}$/;
const ID_RE = /^\d{1,15}$/;
const PAGE = 60;

const str = (v, n) => String(v ?? "").slice(0, n);
const int = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : null);

// Ответ расширения пульту: оставляем только ожидаемые поля.
function cleanRes(d) {
  const res = { type: "res", rid: d.rid, ok: !!d.ok };
  if (!d.ok) res.error = str(d.error || "Ошибка", 200);
  if (d.what === "likes") res.what = "likes";
  if (int(d.offset, 100000) !== null) res.offset = d.offset;
  if (int(d.total, 100000) !== null) res.total = d.total;
  if (Array.isArray(d.items)) {
    res.items = d.items.slice(0, PAGE).map((t) => ({
      id: ID_RE.test(t && t.id) ? t.id : "",
      albumId: ID_RE.test(t && t.albumId) ? t.albumId : "",
      title: str(t && t.title, 300),
      artist: str(t && t.artist, 300),
      cover: /^https:\/\//.test((t && t.cover) || "") ? str(t.cover, 500) : "",
      dur: int(t && t.dur, 1e8) ?? 0,
      ok: !!(t && t.ok),
    }));
  }
  return res;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const room = url.searchParams.get("room") || "";
      if (!ROOM_RE.test(room)) {
        return new Response("Bad room id", { status: 400 });
      }
      const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
      return stub.fetch(request);
    }

    if (url.pathname === "/") {
      return new Response(REMOTE_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

// Одна «комната» = одна пара «браузер с Яндекс Музыкой» + любые телефоны.
// Используется WebSocket Hibernation API: пока никто ничего не шлёт,
// объект спит и не расходует лимиты.
export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    // Пинги клиентов получают ответ без пробуждения объекта.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get("role") === "player" ? "player" : "remote";

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // У каждого пульта своя метка, чтобы отвечать на его запросы только ему.
    const tags = role === "remote" ? [role, "r:" + crypto.randomUUID().replace(/-/g, "")] : [role];
    this.ctx.acceptWebSocket(server, tags);

    if (role === "remote") {
      const state = (await this.ctx.storage.get("state")) || null;
      server.send(
        JSON.stringify({
          type: "hello",
          playerOnline: this.ctx.getWebSockets("player").length > 0,
          state,
        })
      );
    } else {
      this.broadcast("remote", { type: "player", online: true });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const tags = this.ctx.getTags(ws);
    const role = tags.includes("player") ? "player" : "remote";
    const tag = tags.find((t) => t.startsWith("r:")) || "";
    // Расширение присылает списки, им нужно больше места.
    const limit = role === "player" ? 65536 : 8192;
    if (typeof message !== "string" || message.length > limit) return;
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    if (role === "player" && data.type === "state" && data.state) {
      const s = data.state;
      const state = {
        title: String(s.title || "").slice(0, 300),
        artist: String(s.artist || "").slice(0, 300),
        album: String(s.album || "").slice(0, 300),
        artwork: /^https:\/\//.test(s.artwork || "") ? String(s.artwork).slice(0, 1000) : "",
        playing: !!s.playing,
      };
      await this.ctx.storage.put("state", state);
      this.broadcast("remote", { type: "state", state });
      return;
    }

    if (role === "player" && data.type === "res" && RID_RE.test(data.rid) && /^[a-f0-9]{32}$/.test(data.to)) {
      this.broadcast("r:" + data.to, cleanRes(data));
      return;
    }

    if (role !== "remote") return;

    if (data.type === "cmd" && ACTIONS.has(data.action)) {
      this.broadcast("player", { type: "cmd", action: data.action });
      return;
    }

    if (!RID_RE.test(data.rid)) return;
    const from = tag.slice(2);
    let out = null;
    if (data.type === "req" && data.what === "likes" && int(data.offset, 100000) !== null) {
      out = { type: "req", from, rid: data.rid, what: "likes", offset: data.offset };
    } else if (
      data.type === "play" && data.src === "likes" &&
      int(data.index, 100000) !== null && ID_RE.test(data.trackId)
    ) {
      out = { type: "play", from, rid: data.rid, src: "likes", index: data.index, trackId: data.trackId };
    }
    if (!out) return;
    if (this.ctx.getWebSockets("player").length === 0) {
      ws.send(JSON.stringify({ type: "res", rid: data.rid, ok: false, error: "Вкладка с Яндекс Музыкой закрыта" }));
      return;
    }
    this.broadcast("player", out);
  }

  async webSocketClose(ws, code) {
    this.onGone(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye");
    } catch {}
  }

  async webSocketError(ws) {
    this.onGone(ws);
  }

  onGone(ws) {
    if (!this.ctx.getTags(ws).includes("player")) return;
    const left = this.ctx.getWebSockets("player").filter((s) => s !== ws).length;
    if (left === 0) this.broadcast("remote", { type: "player", online: false });
  }

  broadcast(tag, obj) {
    const msg = JSON.stringify(obj);
    for (const s of this.ctx.getWebSockets(tag)) {
      try {
        s.send(msg);
      } catch {}
    }
  }
}
