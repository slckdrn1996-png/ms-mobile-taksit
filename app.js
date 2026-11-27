/* MS Mobile Taksit + Stok Sayımı */
"use strict";

const BANKS = ["Diğer Kartlar"];
const ORAN = { 1: 3.70, 2: 6.73, 3: 8.66, 4: 10.54, 5: 12.46, 6: 14.24, 7: 15.92, 8: 17.84, 9: 19.78, 10: 21.55, 11: 23.63, 12: 25.40 };
const HINT_POSSIBLE_FORMATS = 2;
const HINT_TRY_HARDER = 3;
const SAYIM_KEY = "msMobileSayim.v1";
const HINT_TAKSIT = "Etiketteki IMEI barkodunu beyaz çerçevenin içine hizalayın. İzin istenirse Safari’de İzin Ver’e dokunun.";
const HINT_SAYIM = "Kamerayı açık tutun; her cihazı beyaz çerçevenin içine hizalayın. Aynı cihazı tekrar okutursanız uyarı verir.";

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
const $pageTag = el("pageTag");
const $scanHint = el("scanHint");
const $sayimPanel = el("sayimPanel");
const $taksitExtra = el("taksitExtra");
const $taksitFooter = el("taksitFooter");
const $modeTaksit = el("modeTaksit");
const $modeSayim = el("modeSayim");
const $sayimProgress = el("sayimProgress");
const $sayimExtra = el("sayimExtra");
const $sayimBar = el("sayimBar");
const $sayimLists = el("sayimLists");
const $toast = el("toast");
const $confirmModal = el("confirmModal");

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
let mode = "taksit";
let toastTimer = null;
let sayim = emptySayim();

function emptySayim() {
  return { startedAt: null, counted: {}, unknown: {} };
}

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
  const cash = Math.max(0, Number(price) || 0);
  const nakitRow = `<tr class="nakit"><td>Havale</td><td>—</td><td>${nm(cash)}</td></tr>`;
  return `<div class="tables">${BANKS.map((b) => `
    <div class="bank">
      <h3>${escapeHtml(b)}</h3>
      <table>
        <thead><tr><th>Ay</th><th>Aylık ₺</th><th>Toplam ₺</th></tr></thead>
        <tbody>
          ${nakitRow}
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
    const heading = mode === "sayim" ? `${selected.hits.length} sonuç, sayılacak olanı seçin` : `${selected.hits.length} sonuç, birini seçin`;
    $results.innerHTML = `<section class="card">
      <h2>${heading}</h2>
      <ul class="pick">${selected.hits.map((p, i) => `
        <li><button type="button" data-pick="${i}">
          <span class="name">${escapeHtml(p.name)}</span>
          <span class="sub">${escapeHtml(p.code)}${p.imei ? " · IMEI " + escapeHtml(p.imei) : ""} · ${tl(p.price)}</span>
        </button></li>`).join("")}</ul>
    </section>`;
    $results.querySelectorAll("[data-pick]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const hit = selected.hits[Number(btn.dataset.pick)];
        if (mode === "sayim") markCounted(hit, "manual");
        else selectProduct(hit);
      });
    });
    return;
  }

  const p = selected.product;
  const d = Number(discount) || 0;
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

function sanitizeScan(raw) {
  let s = String(raw == null ? "" : raw).replace(/[\s\r\n\t\u0000-\u001F\u007F]+/g, "");
  const m16 = s.match(/\d{16}/);
  if (m16) return m16[0];
  const m15 = s.match(/\d{15}/);
  if (m15) return m15[0];
  const st = s.match(/ST\d{3,}/i);
  if (st) {
    const rest = s.replace(st[0], "");
    if (!/[A-Za-z]{3,}/.test(rest)) return st[0].toLocaleUpperCase("tr-TR");
  }
  return s;
}

function looksCompleteScan(raw) {
  const s = sanitizeScan(raw);
  if (/^\d{15,16}$/.test(s)) return true;
  if (/^ST\d+$/i.test(s)) {
    const u = s.toLocaleUpperCase("tr-TR");
    return products.some((p) => p.code.toLocaleUpperCase("tr-TR") === u);
  }
  return false;
}

function isModalOpen() {
  return $confirmModal && !$confirmModal.classList.contains("hidden");
}

function isOtherEditable(el) {
  if (!el || el === $q) return false;
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "textarea" || el.isContentEditable) return true;
  if (tag === "input") {
    const typ = (el.type || "text").toLowerCase();
    return typ !== "button" && typ !== "submit" && typ !== "checkbox" && typ !== "radio" && typ !== "file" && typ !== "hidden" && typ !== "reset";
  }
  return false;
}

function focusSearchBox(opts) {
  const selectAll = opts && opts.selectAll;
  const go = () => {
    try {
      $q.focus({ preventScroll: true });
      const n = $q.value.length;
      if (selectAll && n) $q.setSelectionRange(0, n);
      else $q.setSelectionRange(n, n);
    } catch (_) { /* ignore */ }
  };
  go();
  requestAnimationFrame(go);
}

function finishSearchField(displayValue) {
  scanState.lookupDone = true;
  scanState.burst = false;
  scanState.buf = "";
  scanState.lastChar = "";
  scanState.lastAt = 0;
  clearTimeout(scanState.idleTimer);
  if (mode === "sayim") {
    $q.value = "";
    focusSearchBox();
  } else {
    if (displayValue != null) $q.value = displayValue;
    focusSearchBox({ selectAll: true });
  }
}

const SCANNER_GAP_MS = 50;
const SCANNER_IDLE_MS = 100;
const scanState = {
  lastAt: 0,
  burst: false,
  buf: "",
  lastChar: "",
  otherEl: null,
  otherBefore: "",
  lookupDone: false,
  idleTimer: null,
};

function armIdleCommit() {
  clearTimeout(scanState.idleTimer);
  scanState.idleTimer = setTimeout(() => {
    const raw = scanState.burst ? scanState.buf : $q.value;
    if (looksCompleteScan(raw)) commitWedgeScan(raw);
  }, SCANNER_IDLE_MS);
}

function commitWedgeScan(raw) {
  const cleaned = sanitizeScan(raw == null ? $q.value : raw);
  clearTimeout(scanState.idleTimer);
  scanState.burst = false;
  scanState.buf = "";
  scanState.lastChar = "";
  scanState.lastAt = 0;
  if (!cleaned) return;
  $q.value = cleaned;
  runManual(true);
}

function onWedgeKeydown(e) {
  if (isModalOpen()) return;
  if (e.key === "Enter") {
    if (e.repeat) return;
    if (isOtherEditable(e.target)) return;
    e.preventDefault();
    commitWedgeScan(scanState.burst ? scanState.buf : $q.value);
    return;
  }
  if ((e.key === "Tab" || e.key === "Clear") && (scanState.burst || scanState.buf)) {
    e.preventDefault();
    commitWedgeScan(scanState.buf || $q.value);
    return;
  }
  const scanChar = e.key.length === 1 && /[A-Za-z0-9]/i.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey;
  if (!scanChar) return;

  const now = performance.now();
  const dt = now - scanState.lastAt;
  const other = isOtherEditable(e.target);
  const fast = scanState.lastAt > 0 && dt < SCANNER_GAP_MS;
  const startReplace = scanState.lookupDone || (
    $q.value && $q.selectionStart === 0 && $q.selectionEnd === $q.value.length
  ) || looksCompleteScan($q.value);

  if (other && !fast && !scanState.burst) {
    scanState.otherEl = e.target;
    scanState.otherBefore = e.target.value;
    scanState.lastChar = e.key;
    scanState.lastAt = now;
    scanState.burst = false;
    return;
  }

  if (other && (fast || scanState.burst)) {
    e.preventDefault();
    if (scanState.otherEl && scanState.otherBefore != null) {
      try { scanState.otherEl.value = scanState.otherBefore; } catch (_) { /* ignore */ }
    }
    if (!scanState.burst) {
      scanState.buf = (scanState.lastChar || "") + e.key;
      scanState.burst = true;
    } else {
      scanState.buf += e.key;
    }
    $q.value = scanState.buf;
    focusSearchBox();
    scanState.lookupDone = false;
    scanState.lastChar = e.key;
    scanState.lastAt = now;
    armIdleCommit();
    return;
  }

  if (startReplace && !fast) {
    e.preventDefault();
    scanState.burst = false;
    scanState.buf = e.key;
    scanState.lastChar = e.key;
    $q.value = e.key;
    focusSearchBox();
    scanState.lookupDone = false;
    scanState.lastAt = now;
    armIdleCommit();
    return;
  }

  if (fast) {
    e.preventDefault();
    if (!scanState.burst) {
      scanState.burst = true;
      scanState.buf = (scanState.lastChar || "") + e.key;
    } else {
      scanState.buf += e.key;
    }
    $q.value = scanState.buf;
    focusSearchBox();
    scanState.lookupDone = false;
    scanState.lastChar = e.key;
    scanState.lastAt = now;
    armIdleCommit();
    return;
  }

  scanState.burst = false;
  scanState.buf = "";
  scanState.lastChar = e.key;
  scanState.lastAt = now;
  scanState.lookupDone = false;
  if (e.target !== $q) return;
  armIdleCommit();
}

function onWedgePaste(e) {
  if (isModalOpen()) return;
  if (isOtherEditable(e.target)) return;
  const text = (e.clipboardData && e.clipboardData.getData("text")) || "";
  if (!text) return;
  const cleaned = sanitizeScan(text);
  if (!looksCompleteScan(cleaned) && !/^\d{8,}$/.test(cleaned) && !/^ST\d+/i.test(cleaned)) return;
  e.preventDefault();
  $q.value = cleaned;
  focusSearchBox();
  commitWedgeScan(cleaned);
}

function selectProduct(p) {
  // Yeni cihaz (veya aynı cihaz yeniden) yüklenince önceki indirim kalmasın.
  discount = "";
  selected = { kind: "one", product: p };
  renderResults();
  finishSearchField(p.imei || p.code);
}

function showHits(hits, missText) {
  if (mode === "sayim") {
    handleSayimHits(hits, missText);
    return;
  }
  if (hits.length === 1) {
    selectProduct(hits[0]);
    return;
  }
  if (hits.length > 1) {
    selected = { kind: "list", hits };
    renderResults();
    finishSearchField(sanitizeScan($q.value));
    return;
  }
  selected = { kind: "miss", message: missText || "Cihaz bulunamadı" };
  renderResults();
  finishSearchField(sanitizeScan($q.value));
}

function runManual(loose) {
  const raw = sanitizeScan($q.value);
  if (raw !== $q.value) $q.value = raw;
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
    if (mode === "taksit") renderResults();
  }
  if (mode === "sayim") renderSayim();
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

function beepWarn() {
  try {
    if (!audioCtx) return;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "triangle";
    o.frequency.value = 420;
    g.gain.value = 0.06;
    o.connect(g);
    g.connect(audioCtx.destination);
    const t = audioCtx.currentTime;
    o.start(t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.stop(t + 0.2);
  } catch (_) { /* ignore */ }
  if (navigator.vibrate) navigator.vibrate([40, 40, 40]);
}

function showToast(kind, text) {
  if (!$toast) return;
  $toast.className = "toast " + kind + " show";
  $toast.textContent = text;
  document.body.classList.remove("flash-good", "flash-warn");
  document.body.classList.add(kind === "good" ? "flash-good" : "flash-warn");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $toast.classList.remove("show");
    document.body.classList.remove("flash-good", "flash-warn");
  }, 1600);
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
  if (mode === "sayim") {
    handleSayimHits(hits, compact, { fromScan: true });
    return;
  }
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

/* ---------- Stok sayımı ---------- */

function loadSayim() {
  try {
    const raw = localStorage.getItem(SAYIM_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return;
    sayim = {
      startedAt: data.startedAt || null,
      counted: data.counted && typeof data.counted === "object" ? data.counted : {},
      unknown: data.unknown && typeof data.unknown === "object" ? data.unknown : {},
    };
    if (data.mode === "sayim" || data.mode === "taksit") mode = data.mode;
  } catch (_) { /* ignore corrupt storage */ }
}

function saveSayim() {
  try {
    localStorage.setItem(SAYIM_KEY, JSON.stringify({
      mode,
      startedAt: sayim.startedAt,
      counted: sayim.counted,
      unknown: sayim.unknown,
    }));
  } catch (_) { /* quota / private mode */ }
}

function fmtTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });
  } catch (_) {
    return iso;
  }
}

function countedInStock() {
  return products.filter((p) => sayim.counted[p.code]);
}
function missingProducts() {
  return products.filter((p) => !sayim.counted[p.code]);
}
function unknownEntries() {
  return Object.keys(sayim.unknown).sort().map((k) => sayim.unknown[k]);
}

function markCounted(p, method) {
  if (!p || !p.code) return;
  if (!sayim.startedAt) sayim.startedAt = new Date().toISOString();
  if (sayim.counted[p.code]) {
    beepWarn();
    showToast("warn", "Bu cihaz zaten sayıldı");
    setMsg($searchMsg, "warn", "Zaten sayıldı: " + p.name);
    setMsg($camMsg, "warn", "Zaten sayıldı");
    renderSayim();
    saveSayim();
    selected = null;
    $results.innerHTML = "";
    finishSearchField("");
    return;
  }
  sayim.counted[p.code] = {
    code: p.code,
    name: p.name,
    imei: p.imei || "",
    at: new Date().toISOString(),
    method: method || "scan",
  };
  beep();
  showToast("good", "Sayıldı: " + p.name);
  setMsg($searchMsg, "good", "Sayıldı: " + p.name);
  setMsg($camMsg, "good", "Sayıldı");
  selected = null;
  $results.innerHTML = "";
  saveSayim();
  renderSayim();
  finishSearchField("");
}

function markUnknown(raw) {
  const key = compactDigits(raw) || String(raw).trim();
  if (!key) return;
  if (!sayim.startedAt) sayim.startedAt = new Date().toISOString();
  const prev = sayim.unknown[key];
  if (prev) {
    prev.times = (prev.times || 1) + 1;
    prev.lastAt = new Date().toISOString();
    beepWarn();
    showToast("warn", "Bu barkod zaten kaydedildi (stokta yok)");
    setMsg($searchMsg, "warn", "Stokta yok, daha önce kaydedildi: " + key);
  } else {
    sayim.unknown[key] = { raw: key, times: 1, lastAt: new Date().toISOString() };
    beepWarn();
    showToast("bad", "Stokta yok: " + key);
    setMsg($searchMsg, "warn", "Fazla / bilinmeyen: " + key);
  }
  setMsg($camMsg, "warn", "Stokta yok");
  selected = null;
  $results.innerHTML = "";
  saveSayim();
  renderSayim();
  finishSearchField("");
}

function handleSayimHits(hits, missText, opts) {
  const fromScan = opts && opts.fromScan;
  if (hits.length === 1) {
    markCounted(hits[0], fromScan ? "scan" : "manual");
    return;
  }
  if (hits.length > 1) {
    selected = { kind: "list", hits };
    renderResults();
    setMsg($searchMsg, "", "");
    finishSearchField(sanitizeScan($q.value));
    return;
  }
  if (fromScan) {
    markUnknown(missText || lastScan.text);
    return;
  }
  const raw = ($q.value || missText || "").trim();
  const compact = compactDigits(raw);
  if (compact && (/^\d{8,}$/.test(compact) || /^ST\d+/i.test(compact))) {
    markUnknown(compact);
    return;
  }
  selected = { kind: "miss", message: missText || "Cihaz bulunamadı" };
  renderResults();
  finishSearchField(sanitizeScan($q.value));
}

function renderSayim() {
  const total = products.length;
  const counted = countedInStock();
  const missing = missingProducts();
  const unknown = unknownEntries();
  $sayimProgress.textContent = `Sayılan ${counted.length} / ${total}`;
  const pct = total ? Math.round((counted.length / total) * 100) : 0;
  $sayimBar.style.width = pct + "%";
  $sayimExtra.textContent = unknown.length
    ? `Eksik ${missing.length} · Fazla / bilinmeyen ${unknown.length}`
    : (missing.length ? `Eksik ${missing.length}` : (total ? "Sayım tamam" : ""));

  const countedRows = counted.slice().sort((a, b) => (sayim.counted[b.code].at || "").localeCompare(sayim.counted[a.code].at || ""));
  $sayimLists.innerHTML = `
    <div class="sayim-sec">
      <h3>Sayılan <span class="n">${counted.length}</span></h3>
      ${countedRows.length ? `<ul class="sayim-list">${countedRows.map((p) => {
        const rec = sayim.counted[p.code];
        return `<li>
          <div><span class="name">${escapeHtml(p.name)}</span>
          <span class="sub">${escapeHtml(p.code)}${p.imei ? " · " + escapeHtml(p.imei) : ""}${rec && rec.at ? " · " + escapeHtml(fmtTime(rec.at)) : ""}</span></div>
        </li>`;
      }).join("")}</ul>` : `<p class="hint">Henüz sayılan cihaz yok.</p>`}
    </div>
    <div class="sayim-sec">
      <h3>Eksik <span class="n">${missing.length}</span></h3>
      ${missing.length ? `<ul class="sayim-list">${missing.map((p) => `
        <li>
          <div><span class="name">${escapeHtml(p.name)}</span>
          <span class="sub">${escapeHtml(p.code)}${p.imei ? " · " + escapeHtml(p.imei) : (p.imei === "" ? " · IMEI yok, dokunarak işaretleyin" : "")}</span></div>
          <button type="button" class="btn mark" data-mark="${escapeHtml(p.code)}">Say</button>
        </li>`).join("")}</ul>` : `<p class="hint">Eksik cihaz kalmadı.</p>`}
    </div>
    <div class="sayim-sec">
      <h3>Fazla / Bilinmeyen <span class="n">${unknown.length}</span></h3>
      ${unknown.length ? `<ul class="sayim-list">${unknown.map((u) => `
        <li>
          <div><span class="name">${escapeHtml(u.raw)}</span>
          <span class="sub">Stokta yok${u.times > 1 ? " · " + u.times + " kez okundu" : ""}${u.lastAt ? " · " + escapeHtml(fmtTime(u.lastAt)) : ""}</span></div>
        </li>`).join("")}</ul>` : `<p class="hint">Stokta olmayan barkod okunmadı.</p>`}
    </div>`;
  $sayimLists.querySelectorAll("[data-mark]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const p = products.find((x) => x.code === btn.dataset.mark);
      if (p) markCounted(p, "tap");
    });
  });
}

function resetSayim() {
  sayim = emptySayim();
  saveSayim();
  setMsg($searchMsg, "", "");
  setMsg($camMsg, "", "");
  selected = null;
  $results.innerHTML = "";
  renderSayim();
  showToast("warn", "Sayım sıfırlandı");
}

function csvEscape(v) {
  const s = String(v == null ? "" : v);
  if (/[",\n;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function buildExport() {
  const counted = countedInStock();
  const missing = missingProducts();
  const unknown = unknownEntries();
  const header = "Durum,Stok kodu,Ürün,IMEI,Saat,Not";
  const rows = [header];
  counted.forEach((p) => {
    const rec = sayim.counted[p.code] || {};
    rows.push(["Sayılan", p.code, p.name, p.imei, fmtTime(rec.at), rec.method || ""].map(csvEscape).join(","));
  });
  missing.forEach((p) => {
    rows.push(["Eksik", p.code, p.name, p.imei, "", ""].map(csvEscape).join(","));
  });
  unknown.forEach((u) => {
    rows.push(["Fazla/Bilinmeyen", "", "", u.raw, fmtTime(u.lastAt), u.times > 1 ? u.times + " kez" : ""].map(csvEscape).join(","));
  });
  const csv = rows.join("\n") + "\n";
  const text = [
    "MS Mobile Stok Sayımı",
    $sayimProgress.textContent,
    $stockTime.textContent,
    "",
    ...counted.map((p) => `SAYILAN  ${p.code}  ${p.name}  ${p.imei || "-"}`),
    ...missing.map((p) => `EKSİK    ${p.code}  ${p.name}  ${p.imei || "-"}`),
    ...unknown.map((u) => `FAZLA    ${u.raw}`),
  ].join("\n");
  return { csv, text };
}

async function exportSayim() {
  const { csv, text } = buildExport();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const filename = "stok-sayimi-" + stamp + ".csv";
  try {
    if (navigator.share) {
      const file = new File([csv], filename, { type: "text/csv" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ title: "MS Mobile Stok Sayımı", text, files: [file] });
        return;
      }
      await navigator.share({ title: "MS Mobile Stok Sayımı", text });
      return;
    }
  } catch (err) {
    if (err && err.name === "AbortError") return;
  }
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  try {
    await navigator.clipboard.writeText(text);
    showToast("good", "CSV indirildi, özet kopyalandı");
  } catch (_) {
    showToast("good", "CSV indirildi");
  }
}

function setMode(next) {
  mode = next === "sayim" ? "sayim" : "taksit";
  document.body.dataset.mode = mode;
  $modeTaksit.classList.toggle("on", mode === "taksit");
  $modeSayim.classList.toggle("on", mode === "sayim");
  $modeTaksit.setAttribute("aria-selected", mode === "taksit" ? "true" : "false");
  $modeSayim.setAttribute("aria-selected", mode === "sayim" ? "true" : "false");
  $pageTag.textContent = mode === "sayim" ? "Stok sayımı" : "Taksit fiyatları";
  document.title = mode === "sayim" ? "MS Mobile Stok Sayımı" : "MS Mobile Taksit Fiyatları";
  $scanHint.textContent = mode === "sayim" ? HINT_SAYIM : HINT_TAKSIT;
  $btnFind.textContent = mode === "sayim" ? "Say" : "Bul";
  $sayimPanel.classList.toggle("hidden", mode !== "sayim");
  $taksitExtra.classList.toggle("hidden", mode !== "taksit");
  $taksitFooter.classList.toggle("hidden", mode !== "taksit");
  if (mode === "sayim") {
    selected = null;
    $results.innerHTML = "";
    setMsg($searchMsg, "", "");
    renderSayim();
  } else {
    $results.innerHTML = "";
  }
  saveSayim();
}

$btnScan.addEventListener("click", startCamera);
$btnStop.addEventListener("click", () => stopCamera());
$btnFind.addEventListener("click", () => runManual(true));
$q.addEventListener("input", () => {
  if (scanState.burst) return;
  if (mode === "sayim") return;
  const v = sanitizeScan($q.value);
  if (!v) {
    selected = null;
    renderResults();
    return;
  }
  const { hits, kind } = findManual(v);
  if (hits.length === 1 && (kind === "imei" || kind === "code")) {
    showHits(hits);
  }
});
document.addEventListener("keydown", onWedgeKeydown, true);
document.addEventListener("paste", onWedgePaste, true);
$manualToggle.addEventListener("click", () => {
  $manualBox.classList.toggle("hidden");
});
$manualPrice.addEventListener("input", renderManual);
$modeTaksit.addEventListener("click", () => setMode("taksit"));
$modeSayim.addEventListener("click", () => setMode("sayim"));
el("btnResetSayim").addEventListener("click", () => {
  $confirmModal.classList.remove("hidden");
});
el("confirmNo").addEventListener("click", () => {
  $confirmModal.classList.add("hidden");
});
el("confirmYes").addEventListener("click", () => {
  $confirmModal.classList.add("hidden");
  resetSayim();
});
el("btnExport").addEventListener("click", () => { exportSayim(); });

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    loadStock().catch(() => {});
    if (cameraOn) requestWakeLock();
  }
});

async function init() {
  loadSayim();
  setMode(mode);
  try {
    await loadStock();
  } catch (err) {
    $stockCount.textContent = "Stok yüklenemedi";
    setMsg($searchMsg, "bad", "Stok verisi alınamadı. Sayfayı yenileyin.");
    console.error(err);
  }
  if (mode === "sayim") renderSayim();
  setInterval(() => loadStock().catch(() => {}), 10 * 60 * 1000);
}

init();
