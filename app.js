/* MS Mobile Taksit — search, camera scan, installment tables */
"use strict";

const BANKS = ["Diğer Kartlar"];
const ORAN = { 1: 3.70, 2: 6.73, 3: 8.66, 4: 10.54, 5: 12.46, 6: 14.24, 7: 15.92, 8: 17.84, 9: 19.78, 10: 21.55, 11: 23.63, 12: 25.40 };
const HINT_POSSIBLE_FORMATS = 2;
const HINT_TRY_HARDER = 3;

const el = (id) => document.getElementById(id);
const $stockCount = el("stockCount");
const $stockTime = el("stockTime");
const $q = el("q");
const $results = el("results");
const $camMsg = el("camMsg");
const $searchMsg = el("searchMsg");
const $cameraBox = el("cameraBox");
const $cameraActions = el("cameraActions");
const $video = el("video");
const $btnScan = el("btnScan");
const $btnStop = el("btnStop");
const $btnFind = el("btnFind");
const $manualToggle = el("manualToggle");
const $manualBox = el("manualBox");
const $manualPrice = el("manualPrice");
const $manualTables = el("manualTables");

let products = [];
let selected = null;
let discount = "";
let cameraOn = false;
let stream = null;
let scanTimer = null;
let scanReader = null;
let scanCanvas = null;
let wakeLock = null;
let audioCtx = null;
let lastScan = { text: "", at: 0 };

function taksitler(_bank) {
  return Array.from({ length: 9 }, (_, i) => i + 1);
}
function rate(_bank, n) {
  return ORAN[n] / 100;
}
function tl(v) {
  return Math.round(v).toLocaleString("tr-TR") + " TL";
}
function nm(v) {
  return Math.round(v).toLocaleString("tr-TR");
}
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function compactDigits(s) {
  return String(s).trim().replace(/\s+/g, "");
}

function imeiEqual(stored, query) {
  if (!stored || !query) return false;
  if (stored === query) return true;
  // 15/16 hane toleransı (stokta iki kayıt 16 haneli)
  if (/^\d{14,16}$/.test(stored) && /^\d{14,16}$/.test(query)) {
    return stored.startsWith(query) || query.startsWith(stored);
  }
  return false;
}

/** tight lookup used after a barcode scan */
function findByScan(raw) {
  const compact = compactDigits(raw);
  if (!compact) return [];
  const exact = products.filter((p) => p.imei && imeiEqual(p.imei, compact));
  if (exact.length) return exact;
  const u = compact.toLocaleUpperCase("tr-TR");
  return products.filter((p) => p.code.toLocaleUpperCase("tr-TR") === u);
}

/** manual search: full IMEI, stock code, last 4, plus helpful partials */
function findManual(raw) {
  const t = raw.trim();
  if (!t) return { kind: "empty", hits: [] };
  const u = t.toLocaleUpperCase("tr-TR");
  const compact = t.replace(/\s+/g, "");

  const exactImei = products.filter((p) => p.imei && imeiEqual(p.imei, compact));
  if (exactImei.length) return { kind: "imei", hits: exactImei };

  const exactCode = products.filter((p) => p.code.toLocaleUpperCase("tr-TR") === u);
  if (exactCode.length) return { kind: "code", hits: exactCode };

  if (/^\d{4}$/.test(compact)) {
    const last4 = products.filter((p) => p.imei.length >= 4 && p.imei.slice(-4) === compact);
    return { kind: "last4", hits: last4 };
  }

  if (/^\d{5,}$/.test(compact)) {
    const partial = products.filter((p) => p.imei && p.imei.includes(compact));
    return { kind: "partial", hits: partial };
  }

  if (u.length >= 3) {
    const codes = products.filter((p) => p.code.toLocaleUpperCase("tr-TR").includes(u));
    if (codes.length) return { kind: "code-partial", hits: codes };
    const names = products.filter((p) => p.name.toLocaleUpperCase("tr-TR").includes(u));
    return { kind: "name", hits: names };
  }

  return { kind: "none", hits: [] };
}

function installmentRows(price, bank) {
  return taksitler(bank).map((n) => {
    const t = Math.max(0, price) / (1 - rate(bank, n));
    return [String(n), nm(t / n), nm(t)];
  });
}

function bankTablesHtml(price) {
  return `<div class="tables">${BANKS.map((b) => `
    <div class="bank">
      <h3>${escapeHtml(b)}</h3>
      <table>
        <thead><tr><th>Ay</th><th>Aylık ₺</th><th>Toplam ₺</th></tr></thead>
        <tbody>
          ${installmentRows(price, b).map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join("")}
        </tbody>
      </table>
    </div>`).join("")}</div>`;
}

function setMsg(node, kind, text) {
  if (!text) {
    node.innerHTML = "";
    return;
  }
  node.innerHTML = `<div class="callout ${kind}">${escapeHtml(text)}</div>`;
}

function renderResults() {
  $searchMsg.innerHTML = "";
  if (!selected) {
    $results.innerHTML = "";
    return;
  }
  if (selected.kind === "miss") {
    $results.innerHTML = "";
    setMsg($searchMsg, "warn", selected.message || "Cihaz bulunamadı");
    return;
  }
  if (selected.kind === "list") {
    $results.innerHTML = `<section class="card">
      <h2>${selected.hits.length} sonuç, birini seçin</h2>
      <ul class="pick">${selected.hits.map((p, i) => `
        <li><button type="button" data-pick="${i}">
          <span class="name">${escapeHtml(p.name)}</span>
          <span class="sub">${escapeHtml(p.code)}${p.imei ? " · IMEI " + escapeHtml(p.imei) : ""} · ${tl(p.price)}</span>
        </button></li>`).join("")}</ul>
    </section>`;
    $results.querySelectorAll("[data-pick]").forEach((btn) => {
      btn.addEventListener("click", () => selectProduct(selected.hits[Number(btn.dataset.pick)]));
    });
    return;
  }

  const p = selected.product;
  $results.innerHTML = `<section class="card" id="deviceCard">
    <h2 class="device-name">${escapeHtml(p.name)}</h2>
    <div class="props">
      <div class="prop"><span class="k">Stok kodu</span><span class="v">${escapeHtml(p.code)}</span></div>
      <div class="prop"><span class="k">IMEI</span><span class="v">${escapeHtml(p.imei || "—")}</span></div>
      <div class="prop"><span class="k">Peşin fiyat</span><span class="v">${tl(p.price)}</span></div>
      <div class="prop hidden" id="discRow"><span class="k">İndirimli peşin fiyat</span><span class="v" id="discVal"></span></div>
    </div>
    <label class="hint" for="ind">İndirim (TL)</label>
    <input class="search" id="ind" type="number" inputmode="numeric" placeholder="örn. 2000" value="${escapeHtml(discount)}">
    <div id="deviceTables"></div>
  </section>`;
  const $ind = el("ind");
  $ind.addEventListener("input", () => {
    discount = $ind.value;
    updateDevicePricing();
  });
  updateDevicePricing();
}

function updateDevicePricing() {
  if (!selected || selected.kind !== "one") return;
  const p = selected.product;
  const d = Number(discount) || 0;
  const cash = Math.max(0, p.price - d);
  const row = el("discRow");
  const val = el("discVal");
  const tables = el("deviceTables");
  if (!row || !val || !tables) return;
  if (d > 0) {
    row.classList.remove("hidden");
    val.textContent = tl(cash);
  } else {
    row.classList.add("hidden");
  }
  tables.innerHTML = bankTablesHtml(cash);
}

function selectProduct(p) {
  selected = { kind: "one", product: p };
  $q.value = p.imei || p.code;
  renderResults();
}

function showHits(hits, missText) {
  if (hits.length === 1) {
    selectProduct(hits[0]);
    return;
  }
  if (hits.length > 1) {
    selected = { kind: "list", hits };
    renderResults();
    return;
  }
  selected = { kind: "miss", message: missText || "Cihaz bulunamadı" };
  renderResults();
}

function runManual(loose) {
  const raw = $q.value;
  const { hits } = findManual(raw);
  if (!raw.trim()) {
    selected = null;
    renderResults();
    return;
  }
  if (!loose && hits.length !== 1) return;
  showHits(hits, "Cihaz bulunamadı");
}

async function loadStock() {
  const res = await fetch("stock.json?t=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  products = (data.products || []).map((p) => ({
    code: String(p.code || ""),
    name: String(p.name || ""),
    imei: String(p.imei || ""),
    price: Number(p.price) || 0,
  }));
  $stockCount.textContent = data.count != null ? data.count + " cihaz" : products.length + " cihaz";
  $stockTime.textContent = data.updatedAtLabel
    ? "Stok: " + data.updatedAtLabel
    : "";
  if (selected && selected.kind === "one") {
    const cur = selected.product;
    const fresh = products.find((p) => p.code === cur.code && p.imei === cur.imei) || products.find((p) => p.code === cur.code);
    if (fresh) selected.product = fresh;
    renderResults();
  }
}

function primeAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (_) { /* ignore */ }
}

function beep() {
  try {
    if (!audioCtx) return;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    g.gain.value = 0.07;
    o.connect(g);
    g.connect(audioCtx.destination);
    const t = audioCtx.currentTime;
    o.start(t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.stop(t + 0.13);
  } catch (_) { /* ignore */ }
  if (navigator.vibrate) navigator.vibrate(80);
}

async function requestWakeLock() {
  try {
    if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen");
  } catch (_) { /* ignore */ }
}
async function releaseWakeLock() {
  try { await wakeLock?.release(); } catch (_) { /* ignore */ }
  wakeLock = null;
}

async function applyFocus(track) {
  try {
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    const advanced = [];
    if (caps.focusMode && caps.focusMode.includes("continuous")) {
      advanced.push({ focusMode: "continuous" });
    }
    if (caps.zoom && caps.zoom.min != null) {
      const mid = Math.min(caps.zoom.max || 1, Math.max(caps.zoom.min, 1));
      advanced.push({ zoom: mid });
    }
    if (advanced.length) await track.applyConstraints({ advanced });
  } catch (_) { /* ignore */ }
}

function makeReader() {
  const hints = new Map();
  hints.set(HINT_POSSIBLE_FORMATS, [ZXingBrowser.BarcodeFormat.CODE_128]);
  hints.set(HINT_TRY_HARDER, true);
  return new ZXingBrowser.BrowserMultiFormatReader(hints, {
    delayBetweenScanAttempts: 80,
    delayBetweenScanSuccess: 1500,
  });
}

function getScanCanvas() {
  if (!scanCanvas) scanCanvas = document.createElement("canvas");
  return scanCanvas;
}

function decodeVideoBand() {
  if (!scanReader || !cameraOn) return;
  const vw = $video.videoWidth;
  const vh = $video.videoHeight;
  if (!vw || !vh) return;
  // CSS guide is a centered horizontal window; crop the same region of the frame.
  const bandH = Math.max(120, Math.round(vh * 0.34));
  const sy = Math.max(0, Math.round((vh - bandH) / 2));
  const sx = Math.round(vw * 0.05);
  const sw = Math.max(16, vw - sx * 2);
  const canvas = getScanCanvas();
  canvas.width = sw;
  canvas.height = bandH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage($video, sx, sy, sw, bandH, 0, 0, sw, bandH);
  try {
    const result = scanReader.decodeFromCanvas(canvas);
    if (result) onDecoded(result.getText());
  } catch (_) { /* no code in this frame */ }
}

function scheduleScanTick() {
  clearTimeout(scanTimer);
  if (!cameraOn) return;
  scanTimer = setTimeout(() => {
    try { decodeVideoBand(); } catch (e) { console.error(e); }
    scheduleScanTick();
  }, 80);
}

function onDecoded(text) {
  const compact = compactDigits(text);
  const now = Date.now();
  if (compact && compact === lastScan.text && now - lastScan.at < 2000) return;
  lastScan = { text: compact, at: now };
  const hits = findByScan(compact);
  beep();
  if (hits.length) {
    showHits(hits, "");
    stopCamera({ keepHint: true });
    setMsg($camMsg, "good", "Barkod okundu");
  } else {
    showHits([], "Barkod okundu ama stokta bulunamadı: " + compact);
    setMsg($camMsg, "warn", "Bu barkod stokta yok: " + compact);
  }
}

async function startCamera() {
  setMsg($camMsg, "", "");
  if (!window.isSecureContext) {
    setMsg($camMsg, "warn", "Kamera için sayfanın HTTPS üzerinden açılması gerekir.");
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setMsg($camMsg, "warn", "Bu tarayıcı kamerayı desteklemiyor. IMEI’yi elle yazın.");
    return;
  }
  if (typeof ZXingBrowser === "undefined") {
    setMsg($camMsg, "bad", "Barkod okuyucu yüklenemedi. Sayfayı yenileyin.");
    return;
  }
  primeAudio();
  $btnScan.disabled = true;
  try {
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    const track = stream.getVideoTracks()[0];
    if (track) await applyFocus(track);
    $video.setAttribute("playsinline", "true");
    $video.muted = true;
    $video.srcObject = stream;
    await $video.play();
    $cameraBox.classList.add("on");
    $cameraActions.classList.add("on");
    $btnScan.classList.add("hidden");
    cameraOn = true;
    await requestWakeLock();
    scanReader = makeReader();
    scheduleScanTick();
    setMsg($camMsg, "", "");
  } catch (err) {
    await stopCamera();
    const name = err && err.name;
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      setMsg($camMsg, "warn", "Kamera izni verilmedi. iPad Ayarlar → Safari (veya bu site) → Kamera iznini açın, ya da IMEI’yi elle yazın.");
    } else if (name === "NotFoundError" || name === "OverconstrainedError") {
      setMsg($camMsg, "warn", "Arka kamera bulunamadı. IMEI’yi elle yazabilirsiniz.");
    } else if (name === "NotReadableError") {
      setMsg($camMsg, "warn", "Kamera başka bir uygulama tarafından kullanılıyor olabilir.");
    } else {
      setMsg($camMsg, "bad", "Kamera açılamadı. IMEI’yi elle yazın.");
      console.error(err);
    }
  } finally {
    $btnScan.disabled = false;
  }
}

async function stopCamera(opts) {
  const keepHint = opts && opts.keepHint;
  cameraOn = false;
  clearTimeout(scanTimer);
  scanTimer = null;
  scanReader = null;
  try {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  } catch (_) { /* ignore */ }
  stream = null;
  try { $video.srcObject = null; } catch (_) { /* ignore */ }
  $cameraBox.classList.remove("on");
  $cameraActions.classList.remove("on");
  $btnScan.classList.remove("hidden");
  cameraOn = false;
  await releaseWakeLock();
  if (!keepHint) setMsg($camMsg, "", "");
}

function renderManual() {
  const mp = Number($manualPrice.value) || 0;
  $manualTables.innerHTML = mp > 0 ? bankTablesHtml(mp) : "";
}

$btnScan.addEventListener("click", startCamera);
$btnStop.addEventListener("click", () => stopCamera());
$btnFind.addEventListener("click", () => runManual(true));
$q.addEventListener("input", () => {
  const v = $q.value.trim();
  if (!v) {
    selected = null;
    renderResults();
    return;
  }
  const compact = v.replace(/\s+/g, "");
  // exact IMEI or exact code should resolve immediately
  const { hits, kind } = findManual(v);
  if (hits.length === 1 && (kind === "imei" || kind === "code")) {
    showHits(hits);
  }
});
$q.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.repeat) {
    e.preventDefault();
    runManual(true);
  }
});
$manualToggle.addEventListener("click", () => {
  $manualBox.classList.toggle("hidden");
});
$manualPrice.addEventListener("input", renderManual);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    loadStock().catch(() => {});
    if (cameraOn) requestWakeLock();
  }
});

async function init() {
  try {
    await loadStock();
  } catch (err) {
    $stockCount.textContent = "Stok yüklenemedi";
    setMsg($searchMsg, "bad", "Stok verisi alınamadı. Sayfayı yenileyin.");
    console.error(err);
  }
  setInterval(() => loadStock().catch(() => {}), 10 * 60 * 1000);
}

init();
