const $ = (id) => document.getElementById(id);

const newRoom = () =>
  [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

function normalize(url) {
  url = url.trim().replace(/\/+$/, "");
  if (url && !/^https?:\/\//.test(url)) url = "https://" + url;
  return url;
}

async function render() {
  let { server, room } = await chrome.storage.local.get(["server", "room"]);
  if (!room) {
    room = newRoom();
    await chrome.storage.local.set({ room });
  }
  $("server").value = server || "";

  if (!server) {
    $("pair").hidden = true;
    $("hint").hidden = false;
    return;
  }
  const link = `${server}/#${room}`;
  const qr = qrcode(0, "M");
  qr.addData(link);
  qr.make();
  $("qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  $("link").href = link;
  $("link").textContent = link;
  $("pair").hidden = false;
  $("hint").hidden = true;
}

async function renderStatus() {
  let st;
  try { st = await chrome.runtime.sendMessage({ type: "status" }); } catch (_) {}
  const el = $("status"), txt = $("statusText");
  if (!st || !st.tabs) {
    el.dataset.s = "";
    txt.textContent = "Откройте Яндекс Музыку в браузере";
  } else if (!st.connected) {
    el.dataset.s = "warn";
    txt.textContent = "Нет связи с воркером, проверьте адрес";
  } else {
    el.dataset.s = "ok";
    txt.textContent = st.title ? `На связи: ${st.title}` : "На связи";
  }
}

$("save").onclick = async () => {
  const server = normalize($("server").value);
  await chrome.storage.local.set({ server });
  await render();
  setTimeout(renderStatus, 1500);
};
$("server").addEventListener("keydown", (e) => { if (e.key === "Enter") $("save").click(); });

$("reset").onclick = async () => {
  await chrome.storage.local.set({ room: newRoom() });
  await render();
};

render();
renderStatus();
setInterval(renderStatus, 2000);
