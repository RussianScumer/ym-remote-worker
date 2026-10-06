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

  // Запоминаем адрес API и заголовки авторизации из запросов самого сайта,
  // чтобы потом читать списки от имени открытой сессии. Наружу они не уходят.
  const origFetch = window.fetch;
  const api = { base: "", headers: null };
  const remember = (url, headers) => {
    let auth = null;
    for (const [k, v] of headers) if (/^(authorization|x-yandex-music-)/i.test(k)) (auth = auth || {})[k] = v;
    if (!auth || !Object.keys(auth).some((k) => /^authorization$/i.test(k))) return;
    try {
      const base = new URL(url, location.href).origin;
      if (base !== api.base) console.debug("[ymr] api", base, Object.keys(auth));
      api.base = base;
      api.headers = auth;
    } catch (_) {}
  };
  const headerList = (h) => {
    if (!h) return [];
    if (h instanceof Headers) return [...h.entries()];
    if (Array.isArray(h)) return h;
    return Object.entries(h);
  };
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const h = init && init.headers ? headerList(init.headers) : input instanceof Request ? headerList(input.headers) : [];
      remember(url, h);
    } catch (_) {}
    return origFetch.apply(this, arguments);
  };
  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ymr = { url: String(url), h: [] };
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__ymr) {
      this.__ymr.h.push([k, v]);
      remember(this.__ymr.url, this.__ymr.h);
    }
    return origSetHeader.apply(this, arguments);
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Ждём элемент опросом: setTimeout работает и в фоновой вкладке (пусть и раз в секунду).
  const waitFor = async (fn, timeout = 10000) => {
    const end = Date.now() + timeout;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(250);
    }
  };

  // Переход внутри SPA, чтобы не перезагружать страницу и не обрывать звук.
  const navigate = async (path) => {
    if (location.pathname + location.search === path) return true;
    const router = window.next && window.next.router;
    if (router && router.push) router.push(path);
    else {
      const a = document.querySelector(`a[href="${CSS.escape(path)}"]`);
      if (!a) return false;
      a.click();
    }
    return !!(await waitFor(() => location.pathname + location.search === path, 20000));
  };

  // На главной экран волны. Если играет другой контекст (лайки, плейлист),
  // над плеером висит чип «Сбросить … и включить Мою волну». Иначе центральная
  // кнопка плеера: «Воспроизведение» запускает волну, «Пауза» — волна уже играет.
  const startWave = async () => {
    if (!(await navigate("/"))) return false;
    // Чип появляется чуть позже плеера — даём экрану дорисоваться.
    if (!(await waitFor(() => document.querySelector('main section[aria-label="Плеер"]')))) return false;
    await sleep(800);
    const btn = await waitFor(() =>
      document.querySelector('button[aria-label*="включить Мою волну"]') ||
      document.querySelector('main section[aria-label="Плеер"] button[aria-label="Воспроизведение"], main section[aria-label="Плеер"] button[aria-label="Пауза"]')
    );
    if (!btn) return false;
    if (btn.getAttribute("aria-label") !== "Пауза") btn.click();
    return true;
  };

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
    const action = e.data.action;
    const ack = (ok) => window.postMessage({ __ymr: "ack", action, ok }, "*");
    if (action === "wave") startWave().then(ack, () => ack(false));
    else ack(run(action));
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
