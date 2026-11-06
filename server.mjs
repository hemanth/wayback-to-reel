import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const CACHE_DIR = path.join(__dirname, ".cache");
const TIMELINE_CACHE_DIR = path.join(CACHE_DIR, "timelines");
const SNAPSHOT_CACHE_DIR = path.join(CACHE_DIR, "snapshots");

await fsp.mkdir(TIMELINE_CACHE_DIR, { recursive: true });
await fsp.mkdir(SNAPSHOT_CACHE_DIR, { recursive: true });

const PORT = Number(process.env.PORT || 4321);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".ico": "image/x-icon",
};

const MONTHS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

function sha1(input) {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 16);
}

function normalizeTargetUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) return null;
  // Strip accidental Wayback wrapper if user pasted a web.archive.org URL
  const wbMatch = s.match(/web\.archive\.org\/web\/\d+(?:[a-z]+_)?\/(https?:\/\/.+)$/i);
  if (wbMatch) s = wbMatch[1];
  if (!/^https?:\/\//i.test(s)) {
    s = "https://" + s;
  }
  try {
    const u = new URL(s);
    if (!u.hostname || !u.hostname.includes(".")) return null;
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    const cleanPath = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "");
    return {
      domain: host,
      lookupKey: `${host}${cleanPath}`,
      fullUrl: `https://${host}${cleanPath || "/"}`,
    };
  } catch {
    return null;
  }
}

function formatWaybackTimestamp(ts) {
  const year = Number(ts.slice(0, 4));
  const monthIdx = Math.max(0, Math.min(11, Number(ts.slice(4, 6)) - 1));
  const day = ts.slice(6, 8) || "01";
  return {
    year,
    dateLabel: `${day} ${MONTHS[monthIdx]} ${year}`,
    isoDate: `${year}-${ts.slice(4, 6) || "01"}-${day}`,
  };
}

async function fetchJsonWithTimeout(url, timeoutMs = 14000, extraHeaders = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "application/json,text/plain,*/*",
        ...extraHeaders,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function discoverYearlyTimeline(lookupKey) {
  const cacheFile = path.join(TIMELINE_CACHE_DIR, `${sha1(lookupKey)}.json`);
  try {
    const stat = await fsp.stat(cacheFile);
    // Cache timeline for 24 hours
    if (Date.now() - stat.mtimeMs < 24 * 3600 * 1000) {
      return JSON.parse(await fsp.readFile(cacheFile, "utf8"));
    }
  } catch {}

  let byYear = new Map();

  // Strategy 1: Official Wayback CDX API collapsed by 4-digit year
  try {
    const cdxUrl =
      `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(lookupKey)}` +
      `&output=json&fl=timestamp,original,statuscode,mimetype` +
      `&filter=statuscode:200&filter=mimetype:text/html&collapse=timestamp:4`;
    const rows = await fetchJsonWithTimeout(cdxUrl, 15000);
    if (Array.isArray(rows) && rows.length > 1) {
      for (let i = 1; i < rows.length; i++) {
        const [timestamp, original] = rows[i];
        if (!timestamp || timestamp.length < 8) continue;
        const { year, dateLabel, isoDate } = formatWaybackTimestamp(timestamp);
        if (year >= 1995 && year <= new Date().getFullYear() && !byYear.has(year)) {
          byYear.set(year, {
            year,
            timestamp,
            dateLabel,
            isoDate,
            originalUrl: original || `http://${lookupKey}/`,
            archiveUrl: `https://web.archive.org/web/${timestamp}/${original || `http://${lookupKey}/`}`,
            iframeUrl: `https://web.archive.org/web/${timestamp}if_/${original || `http://${lookupKey}/`}`,
          });
        }
      }
    }
  } catch (err) {
    console.warn(`[timeline] CDX primary lookup fallback for ${lookupKey}:`, err.message);
  }

  // Strategy 2: Fallback via Sparkline + Availability API if CDX timed out or returned empty
  if (byYear.size === 0) {
    let candidateYears = [];
    try {
      const spark = await fetchJsonWithTimeout(
        `https://web.archive.org/__wb/sparkline?output=json&url=${encodeURIComponent(lookupKey)}&collection=web`,
        8000,
        { Referer: "https://web.archive.org/" }
      );
      if (spark && spark.years) {
        candidateYears = Object.entries(spark.years)
          .filter(([, months]) => Array.isArray(months) && months.some((n) => n > 0))
          .map(([y]) => Number(y))
          .filter((y) => y >= 1995 && y <= new Date().getFullYear())
          .sort((a, b) => a - b);
      }
    } catch {}

    if (candidateYears.length === 0) {
      const nowYear = new Date().getFullYear();
      for (let y = 1998; y <= nowYear; y += 2) candidateYears.push(y);
    }

    // Resolve mid-year capture per active year with polite concurrency = 5
    const queue = [...candidateYears];
    const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
      while (queue.length > 0) {
        const y = queue.shift();
        try {
          const avail = await fetchJsonWithTimeout(
            `https://archive.org/wayback/available?url=${encodeURIComponent(lookupKey)}&timestamp=${y}0615`,
            8000
          );
          const closest = avail?.archived_snapshots?.closest;
          if (closest?.available && closest?.timestamp) {
            const { year, dateLabel, isoDate } = formatWaybackTimestamp(closest.timestamp);
            if (year === y && !byYear.has(year)) {
              const orig = `http://${lookupKey}/`;
              byYear.set(year, {
                year,
                timestamp: closest.timestamp,
                dateLabel,
                isoDate,
                originalUrl: orig,
                archiveUrl: `https://web.archive.org/web/${closest.timestamp}/${orig}`,
                iframeUrl: `https://web.archive.org/web/${closest.timestamp}if_/${orig}`,
              });
            }
          }
        } catch {}
      }
    });
    await Promise.all(workers);
  }

  const snapshots = [...byYear.values()].sort((a, b) => a.year - b.year);
  if (snapshots.length > 0) {
    await fsp.writeFile(cacheFile, JSON.stringify(snapshots, null, 2));
  }
  return snapshots;
}

// --- Warm Headless Chrome Pool for Crisp, Banner-Free Wayback Captures ---
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
].filter(Boolean);

function findChromeBinary() {
  for (const p of CHROME_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

let browserPromise = null;
let activeCaptures = 0;
const MAX_CONCURRENT_CAPTURES = 3;
const waitQueue = [];
const inFlightByKey = new Map();

function acquireSlot() {
  if (activeCaptures < MAX_CONCURRENT_CAPTURES) {
    activeCaptures++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitQueue.push(resolve));
}

function releaseSlot() {
  activeCaptures = Math.max(0, activeCaptures - 1);
  const next = waitQueue.shift();
  if (next) {
    activeCaptures++;
    next();
  }
}

async function getBrowser() {
  const executablePath = findChromeBinary();
  if (!executablePath) return null;
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        executablePath,
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--hide-scrollbars",
          "--mute-audio",
        ],
      })
      .catch((err) => {
        console.warn("[chrome] Launch failed, will use remote fallback:", err.message);
        browserPromise = null;
        return null;
      });
  }
  return browserPromise;
}

async function captureViaHeadlessChrome(iframeUrl) {
  const browser = await getBrowser();
  if (!browser) throw new Error("No local Chrome binary");

  await acquireSlot();
  let context = null;
  try {
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    // Abort dead analytics/social widgets and audio/video files so 1990s-2020s pages render briskly
    await page.route("**/*", (route) => {
      const req = route.request();
      const rt = req.resourceType();
      const u = req.url();
      if (
        rt === "media" ||
        rt === "websocket" ||
        u.includes("analytics.archive.org") ||
        u.includes("wwwb-events.archive.org") ||
        u.includes("pragma.archivelab.org") ||
        u.includes("google-analytics.com") ||
        u.includes("googlesyndication.com") ||
        u.includes("doubleclick.net") ||
        u.includes("connect.facebook.net") ||
        u.includes("platform.twitter.com") ||
        u.includes("disqus.com") ||
        u.includes("addthis.com")
      ) {
        return route.abort();
      }
      return route.continue();
    });

    await page.goto(iframeUrl, {
      waitUntil: "commit",
      timeout: 14000,
    });

    // Wait up to 3.5s for DOMContentLoaded + 1.8s for CSS/hero images so dead blocking <script> tags never stall
    await Promise.race([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      new Promise((r) => setTimeout(r, 3500)),
    ]);
    await Promise.race([
      page.waitForLoadState("load").catch(() => {}),
      new Promise((r) => setTimeout(r, 1800)),
    ]);
    await new Promise((r) => setTimeout(r, 300));

    // Ensure Wayback banners are hidden & classic 1990s pages get authentic white paper background
    await page.evaluate(() => {
      const style = document.createElement("style");
      style.textContent = `
        #wm-ipp-base, #wm-ipp, #wm-ipp-print, #donato, #wb_overlay { display: none !important; }
      `;
      document.head?.appendChild(style);
      const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
      const bodyBg = document.body ? getComputedStyle(document.body).backgroundColor : "";
      const isTransparent = (c) => !c || c === "transparent" || c === "rgba(0, 0, 0, 0)";
      if (isTransparent(htmlBg) && isTransparent(bodyBg)) {
        document.documentElement.style.backgroundColor = "#ffffff";
      }
    });

    const textCheck = await page.evaluate(() => (document.body?.innerText || "").slice(0, 300));
    if (/Wayback Machine has not archived that URL|429 Too Many Requests/i.test(textCheck)) {
      throw new Error("Wayback returned error page");
    }

    const buf = await page.screenshot({
      type: "jpeg",
      quality: 88,
      clip: { x: 0, y: 0, width: 1280, height: 800 },
    });
    return buf;
  } finally {
    if (context) await context.close().catch(() => {});
    releaseSlot();
  }
}

async function captureViaRemoteFallback(iframeUrl) {
  // Fallback 1: thum.io (returns direct image)
  try {
    const thumUrl = `https://image.thum.io/get/width/1280/crop/800/noanimate/${iframeUrl}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 16000);
    const res = await fetch(thumUrl, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    clearTimeout(t);
    if (res.ok && (res.headers.get("content-type") || "").startsWith("image/")) {
      const ab = await res.arrayBuffer();
      if (ab.byteLength > 4000) return Buffer.from(ab);
    }
  } catch {}

  // Fallback 2: Microlink screenshot API
  const ml = await fetchJsonWithTimeout(
    `https://api.microlink.io/?url=${encodeURIComponent(iframeUrl)}&screenshot=true&meta=false`,
    18000
  );
  const shotUrl = ml?.data?.screenshot?.url;
  if (!shotUrl) throw new Error("Remote screenshot unavailable");
  const imgRes = await fetch(shotUrl);
  if (!imgRes.ok) throw new Error(`Screenshot fetch ${imgRes.status}`);
  return Buffer.from(await imgRes.arrayBuffer());
}

async function getOrCaptureSnapshot(timestamp, targetUrl) {
  const cleanTs = String(timestamp || "").replace(/\D/g, "");
  if (cleanTs.length < 8) throw new Error("Invalid timestamp");
  const key = `${cleanTs}_${sha1(targetUrl)}`;
  const cachePath = path.join(SNAPSHOT_CACHE_DIR, `${key}.jpg`);

  try {
    const cached = await fsp.readFile(cachePath);
    if (cached.length > 2000) return cached;
  } catch {}

  if (inFlightByKey.has(key)) {
    return inFlightByKey.get(key);
  }

  const job = (async () => {
    const iframeUrl = `https://web.archive.org/web/${cleanTs}if_/${targetUrl}`;
    let buf;
    try {
      buf = await captureViaHeadlessChrome(iframeUrl);
    } catch (err) {
      console.warn(`[snapshot] Chrome capture fallback for ${cleanTs} (${err.message})`);
      buf = await captureViaRemoteFallback(iframeUrl);
    }
    await fsp.writeFile(cachePath, buf).catch(() => {});
    return buf;
  })();

  inFlightByKey.set(key, job);
  try {
    return await job;
  } finally {
    inFlightByKey.delete(key);
  }
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = reqUrl.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept",
    });
    return res.end();
  }

  // Agent Markdown Content Negotiation on root
  const accept = req.headers.accept || "";
  if (pathname === "/" && accept.includes("text/markdown")) {
    const llms = await fsp.readFile(path.join(PUBLIC_DIR, "llms.txt"), "utf8").catch(() => "# Wayback Reel\n");
    const htmlRaw = await fsp.readFile(path.join(PUBLIC_DIR, "index.html"), "utf8").catch(() => "");
    const frontmatter =
      `---\n` +
      `title: "Wayback Reel — Yearly Website Snapshots to MP4 in Browser"\n` +
      `description: "Captures one Wayback Machine snapshot per archived year for any website and encodes an H.264 MP4 time-lapse in the browser with FFmpeg WebAssembly."\n` +
      `url: "https://h3manth.com/fun/wayback-to-video/"\n` +
      `---\n\n`;
    const body = frontmatter + llms;
    res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Vary": "Accept",
      "content-signal": "ai-train=yes, search=yes, ai-input=yes",
      "x-markdown-tokens": String(Math.ceil(body.length / 4)),
      "x-original-tokens": String(Math.ceil(htmlRaw.length / 4)),
      "Link":
        '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json", </.well-known/agent-skills/index.json>; rel="service-desc"; type="application/json", </.well-known/mcp/server-card.json>; rel="describedby"; type="application/json", </.well-known/agent-card.json>; rel="describedby"; type="application/json", </llms.txt>; rel="describedby"; type="text/plain"',
    });
    return res.end(body);
  }

  // API: Yearly Wayback timeline discovery
  if (pathname === "/api/timeline" && req.method === "GET") {
    const parsed = normalizeTargetUrl(reqUrl.searchParams.get("url"));
    if (!parsed) {
      res.writeHead(400, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(JSON.stringify({ error: "Enter a valid website domain (e.g. apple.com)" }));
    }
    try {
      const snapshots = await discoverYearlyTimeline(parsed.lookupKey);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
      });
      return res.end(
        JSON.stringify({
          domain: parsed.domain,
          lookupKey: parsed.lookupKey,
          count: snapshots.length,
          snapshots,
        })
      );
    } catch (err) {
      res.writeHead(502, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(JSON.stringify({ error: err.message || "Failed to query Wayback Machine" }));
    }
  }

  // API: Yearly Wayback visual snapshot image
  if (pathname === "/api/snapshot" && req.method === "GET") {
    const ts = reqUrl.searchParams.get("timestamp");
    const target = reqUrl.searchParams.get("url");
    if (!ts || !target) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "Missing timestamp or url" }));
    }
    try {
      const img = await getOrCaptureSnapshot(ts, target);
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": img.length,
        "Access-Control-Allow-Origin": "*",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Cache-Control": "public, max-age=604800, immutable",
      });
      return res.end(img);
    } catch (err) {
      res.writeHead(502, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(JSON.stringify({ error: err.message || "Snapshot failed" }));
    }
  }

  // Static files from public/
  const relPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const safePath = path.normalize(path.join(PUBLIC_DIR, relPath));
  if (!safePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  try {
    const stat = await fsp.stat(safePath);
    const filePath = stat.isDirectory() ? path.join(safePath, "index.html") : safePath;
    const base = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType =
      base === "api-catalog" || base === "api-catalog.json"
        ? "application/linkset+json; charset=utf-8"
        : base === "http-message-signatures-directory" || base === "oauth-protected-resource"
        ? "application/json; charset=utf-8"
        : ext === ".md"
        ? "text/markdown; charset=utf-8"
        : MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Vary": "Accept",
      "content-signal": "ai-train=yes, search=yes, ai-input=yes",
      "Link":
        '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json", </.well-known/agent-skills/index.json>; rel="service-desc"; type="application/json", </.well-known/mcp/server-card.json>; rel="describedby"; type="application/json", </.well-known/agent-card.json>; rel="describedby"; type="application/json", </llms.txt>; rel="describedby"; type="text/plain"',
      "Cache-Control": ext === ".wasm" ? "public, max-age=604800, immutable" : "no-cache",
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`Wayback Reel listening at http://localhost:${PORT}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    if (browserPromise) {
      const b = await browserPromise;
      await b?.close().catch(() => {});
    }
    process.exit(0);
  });
}
