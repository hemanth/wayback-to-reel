import { FFmpeg } from "./vendor/ffmpeg/index.js";

// --- Elements ---
const entryStage = document.getElementById("entry-stage");
const studioStage = document.getElementById("studio-stage");
const urlForm = document.getElementById("url-form");
const urlInput = document.getElementById("url-input");
const entryError = document.getElementById("entry-error");

const domainWhisper = document.getElementById("domain-whisper");
const whisperDomain = document.getElementById("whisper-domain");
const whisperSpan = document.getElementById("whisper-span");

const previewCanvas = document.getElementById("preview-canvas");
const ctx = previewCanvas.getContext("2d", { alpha: false });
const reelVideo = document.getElementById("reel-video");
const waybackExtLink = document.getElementById("wayback-ext-link");
const badgeDate = document.getElementById("badge-date");

const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const paceGroup = document.getElementById("pace-group");
const playToggleBtn = document.getElementById("play-toggle-btn");
const iconPause = document.getElementById("icon-pause");
const iconPlay = document.getElementById("icon-play");
const encodeNowBtn = document.getElementById("encode-now-btn");
const encodeBtnLabel = document.getElementById("encode-btn-label");
const downloadBtn = document.getElementById("download-btn");
const resetBtn = document.getElementById("reset-btn");
const brandBtn = document.getElementById("brand-btn");
const filmstripEl = document.getElementById("filmstrip");

const infoBtn = document.getElementById("info-btn");
const infoBackdrop = document.getElementById("info-backdrop");
const infoClose = document.getElementById("info-close");

// --- Studio State ---
const VIDEO_W = 1280;
const VIDEO_H = 720;
const VIDEO_FPS = 15;

let currentRunId = 0;
let currentDomain = "";
let secondsPerYear = 1.0;
let items = []; // [{ year, timestamp, dateLabel, originalUrl, archiveUrl, iframeUrl, img, thumbUrl, included, failed, tileEl }]
let selectedIndex = -1;
let videoObjectUrl = null;
let isEncoding = false;
let ffmpegInstance = null;
let ffmpegLoadPromise = null;

// --- FFmpeg WASM Loader (Same-Origin Module Worker) ---
async function ensureFFmpeg() {
  if (ffmpegInstance && ffmpegInstance.loaded) return ffmpegInstance;
  if (ffmpegLoadPromise) return ffmpegLoadPromise;

  ffmpegLoadPromise = (async () => {
    const ff = new FFmpeg();
    ff.on("progress", ({ progress }) => {
      if (isEncoding && Number.isFinite(progress)) {
        const pct = Math.max(0, Math.min(99, Math.round(progress * 100)));
        setStatus(`Encoding H.264 MP4 with FFmpeg WASM · ${pct}%`, true);
      }
    });
    const coreURL = new URL("./vendor/ffmpeg/core/ffmpeg-core.js", window.location.href).href;
    const wasmURL = new URL("./vendor/ffmpeg/core/ffmpeg-core.wasm", window.location.href).href;
    await ff.load({ coreURL, wasmURL });
    ffmpegInstance = ff;
    return ff;
  })().catch((err) => {
    ffmpegLoadPromise = null;
    throw err;
  });

  return ffmpegLoadPromise;
}

function setStatus(message, busy = true) {
  statusText.textContent = message;
  statusDot.classList.toggle("is-busy", busy);
  statusDot.classList.toggle("is-ready", !busy);
}

// --- Archival Frame Compositor (1280x720) ---
function roundedRectPath(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r);
  c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r);
  c.quadraticCurveTo(x, y, x + r, y);
  c.closePath();
}

function drawSnapshotImage(c, img, x, y, w, h, alpha = 1) {
  if (!img) return;
  c.save();
  c.globalAlpha = alpha;
  // Cover width, top-aligned like a real browser viewport
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const sw = w / scale;
  const sh = h / scale;
  c.drawImage(img, 0, 0, sw, sh, x, y, w, h);
  c.restore();
}

/**
 * Renders a single 1280x720 archival frame onto targetCtx.
 * Supports smooth cross-dissolve between itemA and itemB via `mix` in [0, 1].
 */
function renderArchivalFrame(targetCtx, itemA, itemB = null, mix = 0, timelineProgress = 0, spanYears = "") {
  const W = VIDEO_W;
  const H = VIDEO_H;

  // 1. Warm Stone Paper Mat
  const grad = targetCtx.createRadialGradient(W * 0.5, H * 0.42, 60, W * 0.5, H * 0.5, W * 0.75);
  grad.addColorStop(0, "#f7f3eb");
  grad.addColorStop(1, "#ebe3d3");
  targetCtx.fillStyle = grad;
  targetCtx.fillRect(0, 0, W, H);

  const activeItem = mix >= 0.5 && itemB ? itemB : itemA;
  if (!activeItem) return;

  // 2. Top Archival Header (Domain + App URL Watermark + Editorial Year)
  const headerY = 33;
  targetCtx.textBaseline = "middle";

  targetCtx.fillStyle = "rgba(23, 22, 20, 0.62)";
  targetCtx.font = '500 14.5px "JetBrains Mono", ui-monospace, monospace';
  targetCtx.textAlign = "left";
  const maxLeftText = currentDomain.length > 26 ? `${currentDomain.slice(0, 25)}…` : currentDomain;
  targetCtx.fillText(`${maxLeftText}  ·  ${activeItem.dateLabel}`, 56, headerY);

  // Centered app URL pill in the video header
  const appUrlLabel = "h3manth.com/fun/wayback-to-reel";
  targetCtx.font = '500 12px "JetBrains Mono", ui-monospace, monospace';
  const pillPadX = 12;
  const pillW = Math.ceil(targetCtx.measureText(appUrlLabel).width) + pillPadX * 2;
  const pillH = 24;
  const pillX = Math.round((W - pillW) / 2);
  const pillY = Math.round(headerY - pillH / 2);

  roundedRectPath(targetCtx, pillX, pillY, pillW, pillH, 12);
  targetCtx.fillStyle = "rgba(251, 248, 242, 0.78)";
  targetCtx.fill();
  targetCtx.strokeStyle = "rgba(23, 22, 20, 0.14)";
  targetCtx.lineWidth = 1;
  targetCtx.stroke();

  targetCtx.fillStyle = "rgba(23, 22, 20, 0.68)";
  targetCtx.textAlign = "center";
  targetCtx.fillText(appUrlLabel, W / 2, headerY + 0.5);

  targetCtx.fillStyle = "#171614";
  targetCtx.font = '600 24px "JetBrains Mono", ui-monospace, monospace';
  targetCtx.textAlign = "right";
  targetCtx.fillText(String(activeItem.year), W - 56, headerY);

  // 3. Tactile Browser Card (1168 x 614)
  const cardX = 56;
  const cardY = 60;
  const cardW = W - 112;
  const cardH = H - 96;
  const chromeH = 30;

  targetCtx.save();
  targetCtx.shadowColor = "rgba(23, 22, 20, 0.14)";
  targetCtx.shadowBlur = 28;
  targetCtx.shadowOffsetY = 10;
  roundedRectPath(targetCtx, cardX, cardY, cardW, cardH, 12);
  targetCtx.fillStyle = "#ffffff";
  targetCtx.fill();
  targetCtx.restore();

  // Clip inside rounded browser card
  targetCtx.save();
  roundedRectPath(targetCtx, cardX, cardY, cardW, cardH, 12);
  targetCtx.clip();

  // Browser top chrome bar
  targetCtx.fillStyle = "#f4f1ea";
  targetCtx.fillRect(cardX, cardY, cardW, chromeH);
  targetCtx.fillStyle = "rgba(23, 22, 20, 0.1)";
  targetCtx.fillRect(cardX, cardY + chromeH - 1, cardW, 1);

  // Subtle monochrome window dots
  for (let i = 0; i < 3; i++) {
    targetCtx.beginPath();
    targetCtx.arc(cardX + 16 + i * 13, cardY + chromeH / 2, 3.8, 0, Math.PI * 2);
    targetCtx.fillStyle = i === 0 ? "rgba(214, 90, 56, 0.65)" : "rgba(23, 22, 20, 0.18)";
    targetCtx.fill();
  }

  // Historical URL pill inside browser chrome
  targetCtx.fillStyle = "rgba(23, 22, 20, 0.45)";
  targetCtx.font = '400 11.5px "JetBrains Mono", ui-monospace, monospace';
  targetCtx.textAlign = "center";
  const histUrl = `web.archive.org/web/${activeItem.timestamp.slice(0, 8)}/${currentDomain}`;
  targetCtx.fillText(histUrl, cardX + cardW / 2, cardY + chromeH / 2 + 0.5);

  // Webpage Viewport Area
  const viewX = cardX;
  const viewY = cardY + chromeH;
  const viewW = cardW;
  const viewH = cardH - chromeH;

  targetCtx.fillStyle = "#ffffff";
  targetCtx.fillRect(viewX, viewY, viewW, viewH);

  if (itemA?.img) {
    drawSnapshotImage(targetCtx, itemA.img, viewX, viewY, viewW, viewH, 1);
  }
  if (itemB?.img && mix > 0) {
    drawSnapshotImage(targetCtx, itemB.img, viewX, viewY, viewW, viewH, mix);
  }

  targetCtx.restore();

  // Subtle card border
  roundedRectPath(targetCtx, cardX, cardY, cardW, cardH, 12);
  targetCtx.strokeStyle = "rgba(23, 22, 20, 0.14)";
  targetCtx.lineWidth = 1;
  targetCtx.stroke();

  // 4. Bottom Hairline Timeline Scrub Bar
  const barY = H - 17;
  const barX = 56;
  const barW = W - 112;
  targetCtx.fillStyle = "rgba(23, 22, 20, 0.12)";
  targetCtx.fillRect(barX, barY, barW, 2);

  const progW = Math.max(4, Math.min(barW, barW * timelineProgress));
  targetCtx.fillStyle = "#d65a38";
  targetCtx.fillRect(barX, barY, progW, 2);

  if (spanYears) {
    targetCtx.fillStyle = "rgba(23, 22, 20, 0.38)";
    targetCtx.font = '400 10.5px "JetBrains Mono", ui-monospace, monospace';
    targetCtx.textAlign = "right";
    targetCtx.fillText(spanYears, W - 56, H - 8);
  }
}

function showPreviewItem(index) {
  const item = items[index];
  if (!item) return;
  selectedIndex = index;

  items.forEach((it, idx) => {
    it.tileEl?.classList.toggle("is-selected", idx === index);
  });

  waybackExtLink.href = item.archiveUrl;
  badgeDate.textContent = `${item.dateLabel} · Archive`;
  waybackExtLink.hidden = false;

  const validItems = getIncludedLoadedItems();
  const posInValid = validItems.indexOf(item);
  const progress =
    validItems.length > 1 && posInValid >= 0 ? posInValid / (validItems.length - 1) : 1;
  const spanLabel =
    validItems.length > 0 ? `${validItems[0].year} — ${validItems[validItems.length - 1].year}` : "";

  // If video is playing and user clicked a year tile, scrub video to that year's timestamp!
  if (!reelVideo.hidden && reelVideo.duration && posInValid >= 0) {
    const targetTime = Math.min(
      reelVideo.duration - 0.05,
      posInValid * secondsPerYear
    );
    reelVideo.currentTime = Math.max(0, targetTime);
    return;
  }

  reelVideo.hidden = true;
  previewCanvas.hidden = false;
  if (item.img) {
    renderArchivalFrame(ctx, item, null, 0, progress, spanLabel);
  }
}

function getIncludedLoadedItems() {
  return items.filter((it) => it.included && it.img && !it.failed);
}

// --- Static-Host Fallback Helpers (if /api/* is absent) ---
async function fetchTimelineWithFallback(rawUrl) {
  try {
    const res = await fetch(`./api/timeline?url=${encodeURIComponent(rawUrl)}`);
    if (res.ok) return await res.json();
    if (res.status === 400 || res.status === 502) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `Lookup error (${res.status})`);
    }
  } catch (err) {
    if (err.message && !/Failed to fetch|404/i.test(err.message)) throw err;
  }

  // Pure client-side CORS fallback via archive.org/wayback/available
  const host = rawUrl.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0];
  const nowYear = new Date().getFullYear();
  const years = [];
  for (let y = 1997; y <= nowYear; y++) years.push(y);

  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const found = new Map();
  const queue = [...years];
  const workers = Array.from({ length: 5 }, async () => {
    while (queue.length > 0) {
      const y = queue.shift();
      try {
        const r = await fetch(
          `https://archive.org/wayback/available?url=${encodeURIComponent(host)}&timestamp=${y}0615`
        );
        const data = await r.json();
        const c = data?.archived_snapshots?.closest;
        if (c?.available && c?.timestamp) {
          const cy = Number(c.timestamp.slice(0, 4));
          if (cy === y && !found.has(cy)) {
            const mIdx = Math.max(0, Math.min(11, Number(c.timestamp.slice(4, 6)) - 1));
            const day = c.timestamp.slice(6, 8) || "01";
            const orig = `http://${host}/`;
            found.set(cy, {
              year: cy,
              timestamp: c.timestamp,
              dateLabel: `${day} ${months[mIdx]} ${cy}`,
              originalUrl: orig,
              archiveUrl: `https://web.archive.org/web/${c.timestamp}/${orig}`,
              iframeUrl: `https://web.archive.org/web/${c.timestamp}if_/${orig}`,
            });
          }
        }
      } catch {}
    }
  });
  await Promise.all(workers);
  const snapshots = [...found.values()].sort((a, b) => a.year - b.year);
  return { domain: host, lookupKey: host, count: snapshots.length, snapshots };
}

async function loadSnapshotImage(snap) {
  const candidates = [
    {
      url: `./api/snapshot?timestamp=${encodeURIComponent(snap.timestamp)}&url=${encodeURIComponent(snap.originalUrl)}`,
      timeoutMs: 24000,
    },
    {
      url: `https://image.thum.io/get/width/1280/crop/800/noanimate/${snap.iframeUrl}`,
      timeoutMs: 14000,
    },
  ];

  for (const { url: src, timeoutMs } of candidates) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(src, { signal: ctrl.signal });
      if (!res.ok) continue;
      const ct = res.headers.get("content-type") || "";
      if (!ct.startsWith("image/")) continue;
      const blob = await res.blob();
      if (blob.size < 1800) continue;
      const objUrl = URL.createObjectURL(blob);
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = objUrl;
      });
      return { img, thumbUrl: objUrl };
    } catch {
      // Try next candidate
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Could not load ${snap.year}`);
}

// --- Build Filmstrip UI ---
function buildFilmstrip(runId) {
  filmstripEl.innerHTML = "";
  items.forEach((item, idx) => {
    const btn = document.createElement("div");
    btn.className = "year-tile is-loading";
    btn.setAttribute("role", "listitem");
    btn.tabIndex = 0;
    btn.title = `${item.dateLabel}`;

    const imgEl = document.createElement("img");
    imgEl.className = "tile-thumb";
    imgEl.alt = `${currentDomain} in ${item.year}`;
    btn.appendChild(imgEl);

    const lbl = document.createElement("span");
    lbl.className = "tile-label";
    lbl.textContent = String(item.year);
    btn.appendChild(lbl);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "tile-toggle";
    toggle.setAttribute("aria-label", `Include or exclude ${item.year}`);
    toggle.title = `Include / exclude ${item.year} from video`;
    toggle.innerHTML = `<svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>`;
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      if (runId !== currentRunId || item.failed || !item.img) return;
      item.included = !item.included;
      btn.classList.toggle("is-excluded", !item.included);
      encodeBtnLabel.textContent = "Re-encode MP4";
      encodeNowBtn.hidden = getIncludedLoadedItems().length < 1;
    });
    btn.appendChild(toggle);

    btn.addEventListener("click", () => {
      if (runId !== currentRunId || !item.img) return;
      showPreviewItem(idx);
    });
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (item.img) showPreviewItem(idx);
      }
    });

    item.tileEl = btn;
    item.thumbEl = imgEl;
    filmstripEl.appendChild(btn);
  });
}

// --- In-Browser FFmpeg WASM Video Encoder ---
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

async function encodeReelInBrowser(runId) {
  const framesData = getIncludedLoadedItems();
  if (framesData.length === 0 || isEncoding) return null;

  isEncoding = true;
  encodeNowBtn.disabled = true;
  downloadBtn.hidden = true;
  playToggleBtn.hidden = true;

  const offscreen = document.createElement("canvas");
  offscreen.width = VIDEO_W;
  offscreen.height = VIDEO_H;
  const octx = offscreen.getContext("2d", { alpha: false });

  const writtenFiles = [];
  try {
    setStatus("Loading FFmpeg WebAssembly engine...", true);
    const ffmpeg = await ensureFFmpeg();
    if (runId !== currentRunId) return null;

    const totalFramesPerYear = Math.max(8, Math.round(secondsPerYear * VIDEO_FPS));
    const dissolveFrames = framesData.length > 1 ? Math.min(5, Math.max(3, Math.floor(totalFramesPerYear * 0.28))) : 0;
    const holdFrames = Math.max(4, totalFramesPerYear - dissolveFrames);
    const spanYears = `${framesData[0].year} — ${framesData[framesData.length - 1].year}`;

    // Pre-calculate total frame count for smooth timeline progress bar
    const totalVideoFrames =
      framesData.length * holdFrames + Math.max(0, framesData.length - 1) * dissolveFrames + 6;

    let frameIdx = 0;

    async function writeCanvasFrame() {
      const blob = await new Promise((resolve) => offscreen.toBlob(resolve, "image/jpeg", 0.91));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const fname = `f_${String(frameIdx).padStart(4, "0")}.jpg`;
      await ffmpeg.writeFile(fname, bytes);
      writtenFiles.push(fname);
      frameIdx++;
    }

    for (let i = 0; i < framesData.length; i++) {
      if (runId !== currentRunId) return null;
      const cur = framesData[i];
      const next = framesData[i + 1] || null;
      setStatus(`Compositing archival frames · ${cur.year} (${i + 1}/${framesData.length})`, true);

      // Hold frames for year i
      for (let h = 0; h < holdFrames; h++) {
        const prog = frameIdx / Math.max(1, totalVideoFrames - 1);
        renderArchivalFrame(octx, cur, null, 0, prog, spanYears);
        await writeCanvasFrame();
      }

      // Cross-dissolve into year i + 1
      if (next && dissolveFrames > 0) {
        for (let d = 1; d <= dissolveFrames; d++) {
          const mix = easeInOutCubic(d / (dissolveFrames + 1));
          const prog = frameIdx / Math.max(1, totalVideoFrames - 1);
          renderArchivalFrame(octx, cur, next, mix, prog, spanYears);
          await writeCanvasFrame();
        }
      }
    }

    // Brief lingering hold on final year
    const last = framesData[framesData.length - 1];
    for (let tail = 0; tail < 6; tail++) {
      renderArchivalFrame(octx, last, null, 0, 1, spanYears);
      await writeCanvasFrame();
    }

    setStatus("Encoding H.264 MP4 with FFmpeg WASM · 0%", true);
    const outName = "wayback_out.mp4";
    const exitCode = await ffmpeg.exec([
      "-framerate",
      String(VIDEO_FPS),
      "-i",
      "f_%04d.jpg",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outName,
    ]);

    if (exitCode !== 0) {
      throw new Error(`FFmpeg exited with code ${exitCode}`);
    }

    const mp4Data = await ffmpeg.readFile(outName);
    await ffmpeg.deleteFile(outName).catch(() => {});

    if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
    const mp4Blob = new Blob([mp4Data.buffer], { type: "video/mp4" });
    videoObjectUrl = URL.createObjectURL(mp4Blob);

    // Activate video player in the projection frame
    reelVideo.src = videoObjectUrl;
    previewCanvas.hidden = true;
    reelVideo.hidden = false;
    await reelVideo.play().catch(() => {});
    syncPlayPauseIcon();

    const safeSlug = currentDomain.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
    downloadBtn.href = videoObjectUrl;
    downloadBtn.download = `${safeSlug}-${framesData[0].year}-${framesData[framesData.length - 1].year}.mp4`;
    downloadBtn.hidden = false;
    playToggleBtn.hidden = false;
    paceGroup.hidden = false;
    encodeBtnLabel.textContent = "Re-encode MP4";
    encodeNowBtn.hidden = true;

    const approxSec = Math.round(frameIdx / VIDEO_FPS);
    const mm = Math.floor(approxSec / 60);
    const ss = String(approxSec % 60).padStart(2, "0");
    const sizeMb = (mp4Blob.size / (1024 * 1024)).toFixed(1);
    setStatus(
      `${framesData.length} years · ${mm}:${ss} MP4 (${sizeMb} MB) · Mastered in browser`,
      false
    );
    return {
      url: videoObjectUrl,
      years: framesData.length,
      durationSeconds: approxSec,
      bytes: mp4Blob.size,
    };
  } catch (err) {
    console.error("[ffmpeg]", err);
    setStatus(`Encoding error: ${err.message || err}`, false);
    encodeNowBtn.hidden = false;
    throw err;
  } finally {
    isEncoding = false;
    encodeNowBtn.disabled = false;
    if (ffmpegInstance?.loaded) {
      for (const f of writtenFiles) {
        await ffmpegInstance.deleteFile(f).catch(() => {});
      }
    }
  }
}

// --- Orchestrate Full Run ---
async function startRun(rawUrl) {
  const cleaned = String(rawUrl || "").trim();
  if (!cleaned) {
    entryError.textContent = "Please enter a domain name, such as apple.com.";
    entryError.hidden = false;
    return;
  }

  entryError.hidden = true;
  const runId = ++currentRunId;

  // Cleanup prior run resources
  items.forEach((it) => {
    if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl);
  });
  items = [];
  selectedIndex = -1;
  reelVideo.pause();
  reelVideo.hidden = true;
  previewCanvas.hidden = false;
  downloadBtn.hidden = true;
  playToggleBtn.hidden = true;
  paceGroup.hidden = true;
  encodeNowBtn.hidden = true;
  waybackExtLink.hidden = true;
  filmstripEl.innerHTML = "";

  // Paint clean waiting slate on canvas immediately
  ctx.fillStyle = "#efe9dc";
  ctx.fillRect(0, 0, VIDEO_W, VIDEO_H);

  entryStage.hidden = true;
  studioStage.hidden = false;
  setStatus(`Searching Wayback Machine archive for ${cleaned}...`, true);

  // Warm FFmpeg WASM in the background in parallel with network fetches!
  ensureFFmpeg().catch(() => {});

  let timeline;
  try {
    timeline = await fetchTimelineWithFallback(cleaned);
  } catch (err) {
    if (runId !== currentRunId) return;
    studioStage.hidden = true;
    entryStage.hidden = false;
    entryError.textContent = err.message || "Could not reach Wayback Machine.";
    entryError.hidden = false;
    return;
  }

  if (runId !== currentRunId) return;

  if (!timeline.snapshots || timeline.snapshots.length === 0) {
    studioStage.hidden = true;
    entryStage.hidden = false;
    entryError.textContent = `No archived HTML snapshots found on Wayback Machine for "${cleaned}".`;
    entryError.hidden = false;
    return;
  }

  currentDomain = timeline.domain;
  const firstY = timeline.snapshots[0].year;
  const lastY = timeline.snapshots[timeline.snapshots.length - 1].year;
  whisperDomain.textContent = currentDomain;
  whisperSpan.textContent = `${firstY} — ${lastY}`;
  domainWhisper.hidden = false;

  // Reflect ?url= cleanly for shareability
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("url", timeline.lookupKey || currentDomain);
  window.history.replaceState({}, "", nextUrl);

  items = timeline.snapshots.map((s) => ({
    ...s,
    img: null,
    thumbUrl: null,
    included: true,
    failed: false,
    tileEl: null,
    thumbEl: null,
  }));

  buildFilmstrip(runId);
  setStatus(`Developing ${items.length} yearly snapshots (${firstY}–${lastY})...`, true);

  // Capture snapshots in chronological order with concurrency = 3
  let nextIdx = 0;
  let completed = 0;
  let succeeded = 0;

  const workers = Array.from({ length: Math.min(3, items.length) }, async () => {
    while (nextIdx < items.length) {
      const i = nextIdx++;
      const item = items[i];
      if (runId !== currentRunId) return;

      try {
        const { img, thumbUrl } = await loadSnapshotImage(item);
        if (runId !== currentRunId) {
          URL.revokeObjectURL(thumbUrl);
          return;
        }
        item.img = img;
        item.thumbUrl = thumbUrl;
        item.thumbEl.src = thumbUrl;
        item.tileEl.classList.remove("is-loading");
        item.tileEl.classList.add("is-loaded");
        succeeded++;

        // Advance live projection canvas as each year develops!
        showPreviewItem(i);
        item.tileEl.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });

        if (succeeded >= 2 && !isEncoding) {
          encodeBtnLabel.textContent = "Encode MP4 now";
          encodeNowBtn.hidden = false;
        }
      } catch {
        item.failed = true;
        item.included = false;
        item.tileEl.classList.remove("is-loading");
        item.tileEl.classList.add("is-failed");
      } finally {
        completed++;
        if (runId === currentRunId && !isEncoding) {
          setStatus(
            `Developed ${completed} of ${items.length} years · ${item.year}`,
            completed < items.length
          );
        }
      }
    }
  });

  await Promise.all(workers);
  if (runId !== currentRunId) return;

  if (getIncludedLoadedItems().length === 0) {
    setStatus("Wayback snapshots could not be rendered right now. Try again shortly.", false);
    return;
  }

  await encodeReelInBrowser(runId);
}

function resetToHome() {
  currentRunId++;
  isEncoding = false;
  reelVideo.pause();
  studioStage.hidden = true;
  domainWhisper.hidden = true;
  entryStage.hidden = false;
  entryError.hidden = true;

  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete("url");
  window.history.replaceState({}, "", cleanUrl);
  urlInput.focus();
  urlInput.select();
}

function syncPlayPauseIcon() {
  const paused = reelVideo.paused;
  iconPause.hidden = paused;
  iconPlay.hidden = !paused;
}

// Sync filmstrip highlight as rendered video loops through years!
reelVideo.addEventListener("timeupdate", () => {
  if (reelVideo.hidden || !reelVideo.duration) return;
  const active = getIncludedLoadedItems();
  if (active.length === 0) return;
  const approxIdx = Math.min(
    active.length - 1,
    Math.max(0, Math.floor(reelVideo.currentTime / secondsPerYear))
  );
  const targetItem = active[approxIdx];
  const fullIdx = items.indexOf(targetItem);
  if (fullIdx !== -1 && fullIdx !== selectedIndex) {
    selectedIndex = fullIdx;
    items.forEach((it, idx) => it.tileEl?.classList.toggle("is-selected", idx === fullIdx));
    waybackExtLink.href = targetItem.archiveUrl;
    badgeDate.textContent = `${targetItem.dateLabel} · Archive`;
    waybackExtLink.hidden = false;
  }
});

reelVideo.addEventListener("play", syncPlayPauseIcon);
reelVideo.addEventListener("pause", syncPlayPauseIcon);
reelVideo.addEventListener("click", () => {
  if (reelVideo.paused) reelVideo.play();
  else reelVideo.pause();
});

playToggleBtn.addEventListener("click", () => {
  if (reelVideo.hidden) return;
  if (reelVideo.paused) reelVideo.play();
  else reelVideo.pause();
});

// --- Event Listeners ---
urlForm.addEventListener("submit", (e) => {
  e.preventDefault();
  startRun(urlInput.value);
});

document.querySelectorAll(".preset-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    const u = chip.getAttribute("data-url") || "";
    urlInput.value = u;
    startRun(u);
  });
});

paceGroup.querySelectorAll(".pace-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const nextPace = Number(btn.getAttribute("data-pace"));
    if (!nextPace || nextPace === secondsPerYear || isEncoding) return;
    secondsPerYear = nextPace;
    paceGroup.querySelectorAll(".pace-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
    await encodeReelInBrowser(currentRunId);
  });
});

encodeNowBtn.addEventListener("click", () => {
  if (!isEncoding && getIncludedLoadedItems().length > 0) {
    encodeReelInBrowser(currentRunId);
  }
});

resetBtn.addEventListener("click", resetToHome);
brandBtn.addEventListener("click", resetToHome);

// Info modal
function toggleInfo(open) {
  infoBackdrop.hidden = !open;
  infoBtn.setAttribute("aria-expanded", String(open));
}
infoBtn.addEventListener("click", () => toggleInfo(infoBackdrop.hidden));
infoClose.addEventListener("click", () => toggleInfo(false));
infoBackdrop.addEventListener("click", (e) => {
  if (e.target === infoBackdrop) toggleInfo(false);
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !infoBackdrop.hidden) toggleInfo(false);
});

// Auto-launch if ?url= query param is present
const initialUrl = new URLSearchParams(window.location.search).get("url");
if (initialUrl) {
  urlInput.value = initialUrl;
  startRun(initialUrl);
}

// --- WebMCP Agent Readiness (navigator.modelContext) ---
if (typeof navigator !== "undefined" && navigator.modelContext?.registerTool) {
  try {
    navigator.modelContext.registerTool({
      name: "get_wayback_timeline",
      description: "Fetch one verified Wayback Machine HTML snapshot per archived year for a domain.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Domain or URL to look up (e.g. info.cern.ch)" },
        },
        required: ["url"],
      },
      async execute({ url }) {
        return await fetchTimelineWithFallback(url);
      },
    });

    navigator.modelContext.registerTool({
      name: "create_wayback_video",
      description:
        "Fetch one Wayback Machine snapshot per archived year for a domain and encode an H.264 MP4 time-lapse video in the browser using FFmpeg WASM.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Domain or URL to capture (e.g. example.com)" },
          secondsPerYear: { type: "number", description: "Seconds per year in the video (0.6, 1.0, or 1.6)" },
        },
        required: ["url"],
      },
      async execute({ url, secondsPerYear: pace }) {
        if (pace && [0.6, 1.0, 1.6].includes(Number(pace))) {
          secondsPerYear = Number(pace);
        }
        urlInput.value = url;
        await startRun(url);
        return {
          domain: currentDomain,
          yearsCaptured: getIncludedLoadedItems().map((i) => i.year),
          status: statusText.textContent,
          downloadReady: !downloadBtn.hidden,
        };
      },
    });
  } catch {}
}
