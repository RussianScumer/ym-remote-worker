// Выполняется в контексте самой страницы Яндекс Музыки, до её скриптов.
// Перехватываем обработчики MediaSession (те самые, что Яндекс регистрирует
// для медиаклавиш) и запоминаем аудиоэлемент плеера. Так управление
// не зависит от вёрстки сайта.
(() => {
  const ms = navigator.mediaSession;
  const handlers = {};
  let media = null;

  if (ms && ms.setActionHandler) {
    const orig = ms.setActionHandler.bind(ms);
    ms.setActionHandler = (action, handler) => {
      handlers[action] = handler || null;
      return orig(action, handler);
    };
  }

  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    media = this;
    return origPlay.apply(this, args);
  };

  // Если сайт сообщает состояние через MediaSession — верим ему,
  // иначе смотрим на сам аудиоэлемент.
  const isPlaying = () => {
    if (ms && ms.playbackState && ms.playbackState !== "none") return ms.playbackState === "playing";
    return !!media && !media.paused;
  };

  const call = (action) => {
    const h = handlers[action];
    if (!h) return false;
    try { h({ action }); } catch (_) {}
    return true;
  };

  const run = (action) => {
    if (action === "next") return call("nexttrack");
    if (action === "prev") return call("previoustrack");
    if (action === "toggle") {
      const want = isPlaying() ? "pause" : "play";
      if (call(want)) return true;
      if (media) {
        want === "pause" ? media.pause() : media.play().catch(() => {});
        return true;
      }
    }
    return false;
  };

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__ymr !== "cmd") return;
    const ok = run(e.data.action);
    window.postMessage({ __ymr: "ack", action: e.data.action, ok }, "*");
  });

  const readState = () => {
    const m = ms && ms.metadata;
    const art = m && m.artwork && m.artwork.length ? m.artwork[m.artwork.length - 1].src : "";
    return {
      title: (m && m.title) || "",
      artist: (m && m.artist) || "",
      album: (m && m.album) || "",
      artwork: art,
      playing: isPlaying(),
    };
  };

  let last = "";
  const tick = (force) => {
    const s = readState();
    const json = JSON.stringify(s);
    if (force || json !== last) {
      last = json;
      window.postMessage({ __ymr: "state", state: s }, "*");
    }
  };
  setInterval(tick, 500);
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data && e.data.__ymr === "need-state") tick(true);
  });
})();
