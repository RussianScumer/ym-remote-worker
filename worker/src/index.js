import REMOTE_HTML from "./remote.html";

const ROOM_RE = /^[a-f0-9]{32}$/;
const ACTIONS = new Set(["prev", "next", "toggle", "wave"]);

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
    this.ctx.acceptWebSocket(server, [role]);

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
    if (typeof message !== "string" || message.length > 8192) return;
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    const [role] = this.ctx.getTags(ws);

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

    if (role === "remote" && data.type === "cmd" && ACTIONS.has(data.action)) {
      this.broadcast("player", { type: "cmd", action: data.action });
    }
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
    const [role] = this.ctx.getTags(ws);
    if (role !== "player") return;
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
