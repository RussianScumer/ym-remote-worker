// Мост между страницей (page.js) и фоновым скриптом расширения.
(() => {
  let port = null;
  let lastState = null;

  // Запасной вариант, если у сайта нет нужного обработчика MediaSession:
  // ищем кнопку плеера по aria-label. Нижний плеер закреплён внизу экрана,
  // поэтому из подходящих кнопок берём самую нижнюю.
  const LABELS = {
    next: /следующ|next/i,
    prev: /предыдущ|previous|prev/i,
    toggle: /пауза|воспроизв|слушать|играть|pause|play/i,
  };
  const clickFallback = (action) => {
    const re = LABELS[action];
    if (!re) return;
    const btns = [...document.querySelectorAll("button[aria-label]")].filter((b) => {
      if (!re.test(b.getAttribute("aria-label"))) return false;
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!btns.length) return;
    btns.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    btns[0].click();
  };

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.__ymr === "state") {
      lastState = e.data.state;
      if (port) port.postMessage({ type: "state", state: lastState });
    } else if (e.data.__ymr === "ack" && !e.data.ok) {
      clickFallback(e.data.action);
    }
  });

  const connect = () => {
    try {
      port = chrome.runtime.connect({ name: "ym-tab" });
    } catch (_) {
      return; // расширение обновили/отключили — эта вкладка больше не активна
    }
    port.onMessage.addListener((msg) => {
      if (msg.type === "cmd") window.postMessage({ __ymr: "cmd", action: msg.action }, "*");
    });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connect, 1000); // фоновый скрипт перезапустился — подключаемся снова
    });
    if (lastState) port.postMessage({ type: "state", state: lastState });
    else window.postMessage({ __ymr: "need-state" }, "*");
  };

  connect();
})();
