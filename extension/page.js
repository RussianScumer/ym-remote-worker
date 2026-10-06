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

  // API сайта (api.music.yandex.*) работает на куках открытой сессии. Из запросов
  // самого сайта берём адрес API и номер выбранного аккаунта (если их несколько).
  const origFetch = window.fetch;
  const API_RE = /^https:\/\/api\.music\.yandex\.[a-z]+/;
  const api = { base: "", headers: {} };
  window.fetch = function (input, init) {
    try {
      const url = input instanceof Request ? input.url : String(input);
      const m = url.match(API_RE);
      if (m) {
        api.base = m[0];
        const h = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
        const uid = h.get("x-yandex-music-multi-auth-user-id");
        if (uid) api.headers["x-yandex-music-multi-auth-user-id"] = uid;
      }
    } catch (_) {}
    return origFetch.apply(this, arguments);
  };

  const apiGet = async (path) => {
    // music.yandex.ru -> api.music.yandex.ru, если сайт ещё не сделал ни одного запроса
    const base = api.base || "https://api." + location.hostname.replace(/^next\./, "");
    const r = await origFetch.call(window, base + path, { credentials: "include", headers: api.headers });
    if (!r.ok) throw new Error("API " + r.status);
    const j = await r.json();
    return j && j.result !== undefined ? j.result : j;
  };

  const norm = (t) => {
    t = t || {};
    const alb = t.albums && t.albums[0];
    return {
      id: String(t.id || ""),
      albumId: alb ? String(alb.id) : "",
      title: t.title || "",
      artist: (t.artists || []).map((a) => a.name).join(", "),
      cover: t.coverUri ? "https://" + t.coverUri.replace("%%", "100x100") : "",
      dur: t.durationMs | 0,
      ok: t.available !== false,
    };
  };

  // «Мне нравится» целиком приходит одним запросом; держим в памяти.
  // Порядок совпадает с порядком строк (data-index) на странице плейлиста.
  let likes = null; // { uuid, at, items }
  const loadLikes = async (fresh) => {
    if (likes && !fresh && Date.now() - likes.at < 5 * 60e3) return likes;
    let uuid = likes && likes.uuid;
    if (!uuid) {
      const block = await apiGet("/landing-blocks/collection/playlist-with-likes");
      const m = JSON.stringify(block).match(/lk\.[0-9a-f-]{36}/);
      if (!m) throw new Error("Не нашёл плейлист «Мне нравится»");
      uuid = m[0];
    }
    const pl = await apiGet(`/playlist/${uuid}?resumestream=false&richtracks=true`);
    likes = { uuid, at: Date.now(), items: (pl.tracks || []).map((x) => norm(x.track)) };
    return likes;
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
  // Расширение делает вкладку активной перед запуском — ждём, пока она станет видимой.
  const whenVisible = () => waitFor(() => !document.hidden, 3000);
  const hiddenError = (err) =>
    document.hidden ? new Error("Вкладка Яндекс Музыки скрыта — разверните её окно на компьютере") : err;

  const startWave = async () => {
    await whenVisible();
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

  const trackList = () => document.querySelector('[aria-label^="Список треков"]');

  // Список виртуальный: прокручиваем скроллер до нужной строки, ждём, пока она
  // отрисуется с данными, и жмём её кнопку. Так сайт играет дальше по этому списку.
  const playRow = async (index, trackId) => {
    const list = await waitFor(() => {
      const l = trackList();
      return l && l.querySelector("[data-index]") ? l : null;
    }, 15000);
    if (!list) throw new Error("Список треков не загрузился");
    let sc = list.parentElement;
    while (sc && !/auto|scroll/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
    if (sc) {
      const rowH = list.querySelector("[data-index]").getBoundingClientRect().height || 69;
      const top = list.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      sc.scrollTop = top + index * rowH - 100;
      sc.dispatchEvent(new Event("scroll"));
    }
    const row = await waitFor(() => {
      const r = list.querySelector(`[data-index="${index}"]`);
      return r && r.querySelector('a[href*="/track/"]') ? r : null;
    });
    if (!row) throw new Error("Строка трека не появилась");
    const href = row.querySelector('a[href*="/track/"]').getAttribute("href");
    if (!href.endsWith("/track/" + trackId)) throw new Error("Список изменился, обновите его");
    const btn = row.querySelector('button[aria-label="Воспроизведение"], button[aria-label="Пауза"]');
    if (!btn) throw new Error("Нет кнопки воспроизведения");
    // «Пауза» — этот трек уже играет, нажатие поставило бы его на паузу.
    if (btn.getAttribute("aria-label") === "Воспроизведение") btn.click();
  };

  const playLikes = async (index, trackId) => {
    await whenVisible();
    const l = await loadLikes(false);
    if (!(await navigate("/playlists/" + l.uuid))) throw new Error("Не удалось открыть «Мне нравится»");
    await playRow(index, trackId);
  };

  const handle = async (d) => {
    if (d.__ymr === "req" && d.what === "likes") {
      const offset = d.offset | 0;
      const l = await loadLikes(offset === 0);
      return { what: "likes", offset, total: l.items.length, items: l.items.slice(offset, offset + 50) };
    }
    if (d.__ymr === "play" && d.src === "likes") {
      await playLikes(d.index | 0, String(d.trackId));
      return {};
    }
    throw new Error("Неизвестный запрос");
  };

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== window || !d || (d.__ymr !== "req" && d.__ymr !== "play")) return;
    const reply = (o) => window.postMessage({ __ymr: "res", to: d.from, rid: d.rid, ...o }, "*");
    handle(d).then(
      (r) => reply({ ok: true, ...r }),
      (err) => {
        err = hiddenError(err);
        reply({ ok: false, error: String((err && err.message) || err) });
      }
    );
  });

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
