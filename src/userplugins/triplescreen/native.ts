/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 TripleScreen contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { IpcMainInvokeEvent } from "electron";

/**
 * Native helpers for TripleScreen.
 *
 * Discord Desktop already exposes screen enumeration through DiscordNative.
 * This module is reserved for future optional helpers (for example a virtual
 * display window) without granting broad filesystem or shell access.
 *
 * Keep the surface minimal — browser arguments are untrusted.
 */

export function getRuntimeInfo(_event: IpcMainInvokeEvent) {
    return {
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron ?? null,
        node: process.versions.node,
        triplescreenNative: true
    };
}

/**
 * Reports whether Electron desktopCapturer appears importable in the main process.
 * Actual frame capture still happens in the renderer / MediaEngine path.
 */
export async function probeDesktopCapturer(_event: IpcMainInvokeEvent) {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const electron = require("electron") as typeof import("electron");
        const available = typeof electron.desktopCapturer?.getSources === "function";
        return { available, reason: available ? "desktopCapturer.getSources present" : "desktopCapturer missing" };
    } catch (err) {
        return {
            available: false,
            reason: err instanceof Error ? err.message : String(err)
        };
    }
}

export interface NativeScreen {
    id: string;
    name: string;
    url?: string;
    width: number;
    height: number;
    refreshRate?: number;
    isPrimary: boolean;
    /** Electron Display.rotation: 0 / 90 / 180 / 270. */
    rotation?: number;
    /** Alternate chromeMediaSourceIds to try if the primary id fails / flickers. */
    altIds?: string[];
    bounds: { x: number; y: number; width: number; height: number; };
}

type CapturerSource = {
    id: string;
    name: string;
    display_id?: string;
    thumbnail: { isEmpty: () => boolean; toDataURL: () => string; getSize: () => { width: number; height: number; }; };
};

/**
 * Map each Display to a unique desktopCapturer screen source.
 *
 * On Windows, Electron often has mismatched display_id vs screen.id (or empty display_id).
 * Blindly using sources[index] can assign the SAME source to two monitors — the secondary
 * tile then fights DXGI and flickers in/out. Two monitors are fully supported; matching must
 * be unique.
 */
function matchDisplaysToSources(
    displays: Array<import("electron").Display>,
    sources: CapturerSource[],
    primaryId: number
): NativeScreen[] {
    const screenSources = sources.filter(s => /^screen:/i.test(s.id));
    const pool = [...screenSources];
    const take = (pred: (s: CapturerSource) => boolean): CapturerSource | undefined => {
        const idx = pool.findIndex(pred);
        if (idx < 0) return undefined;
        return pool.splice(idx, 1)[0];
    };

    // Stable order: primary first, then left-to-right / top-to-bottom.
    const ordered = displays
        .map((display, index) => ({ display, index }))
        .sort((a, b) => {
            if (a.display.id === primaryId) return -1;
            if (b.display.id === primaryId) return 1;
            if (a.display.bounds.y !== b.display.bounds.y) return a.display.bounds.y - b.display.bounds.y;
            if (a.display.bounds.x !== b.display.bounds.x) return a.display.bounds.x - b.display.bounds.x;
            return a.index - b.index;
        });

    const assigned = new Map<number, CapturerSource>();

    // Pass 1: exact display_id / embedded id match.
    for (const { display } of ordered) {
        const idStr = String(display.id);
        const hit = take(s =>
            String(s.display_id || "") === idStr
            || s.id === `screen:${idStr}:0`
            || s.id.split(":")[1] === idStr
        );
        if (hit) assigned.set(display.id, hit);
    }

    // Pass 2: aspect-ratio match via thumbnail (helps when display_id is wrong/empty).
    for (const { display } of ordered) {
        if (assigned.has(display.id)) continue;
        const dipW = Math.max(1, display.bounds?.width || display.size.width);
        const dipH = Math.max(1, display.bounds?.height || display.size.height);
        const expectAspect = dipW / dipH;
        let best: CapturerSource | undefined;
        let bestScore = Infinity;
        for (const s of pool) {
            let tw = 0;
            let th = 0;
            try {
                const sz = s.thumbnail.getSize();
                tw = sz.width;
                th = sz.height;
            } catch { /* ignore */ }
            if (!tw || !th) continue;
            const score = Math.abs(tw / th - expectAspect);
            if (score < bestScore) {
                bestScore = score;
                best = s;
            }
        }
        if (best && bestScore < 0.08) {
            const idx = pool.indexOf(best);
            if (idx >= 0) pool.splice(idx, 1);
            assigned.set(display.id, best);
        }
    }

    // Pass 3: remaining sources in capturer order ↔ remaining displays (no reuse).
    for (const { display } of ordered) {
        if (assigned.has(display.id)) continue;
        const hit = pool.shift();
        if (hit) assigned.set(display.id, hit);
    }

    return ordered.map(({ display, index }, orderIdx) => {
        const source = assigned.get(display.id);
        const dipW = display.bounds?.width || display.size.width;
        const dipH = display.bounds?.height || display.size.height;
        const scale = Number(display.scaleFactor) || 1;
        const primaryIdStr = source?.id ?? `screen:${orderIdx}:0`;
        const altIds = [...new Set([
            primaryIdStr,
            `screen:${orderIdx}:0`,
            `screen:${index}:0`,
            `screen:${display.id}:0`,
            source?.display_id ? `screen:${source.display_id}:0` : ""
        ].filter(Boolean))].filter(id => id !== primaryIdStr);

        let url: string | undefined;
        try {
            if (source && !source.thumbnail.isEmpty()) url = source.thumbnail.toDataURL();
        } catch {
            url = undefined;
        }

        return {
            id: primaryIdStr,
            name: source?.name || `Monitor ${orderIdx + 1}`,
            url,
            width: Math.max(1, Math.round(dipW * scale)),
            height: Math.max(1, Math.round(dipH * scale)),
            refreshRate: display.displayFrequency || undefined,
            isPrimary: display.id === primaryId,
            rotation: Number(display.rotation) || 0,
            altIds,
            bounds: {
                x: display.bounds.x,
                y: display.bounds.y,
                width: display.bounds.width,
                height: display.bounds.height
            }
        };
    });
}

/**
 * Lists every physical display. Electron source ids look like `screen:<displayId>:0`
 * and can be passed to chromeMediaSourceId for an individual monitor.
 */
export async function listScreens(_event: IpcMainInvokeEvent): Promise<NativeScreen[]> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron") as typeof import("electron");
    const displays = electron.screen.getAllDisplays();
    const primaryId = electron.screen.getPrimaryDisplay().id;
    const sources = await electron.desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: false
    }) as CapturerSource[];

    return matchDisplaysToSources(displays, sources, primaryId);
}

const OUTPUT_TITLE = "TripleScreen Output";
const OUTPUT_PARTITION = "triplescreen-output";
let outputWindow: import("electron").BrowserWindow | null = null;
let pageReady: Promise<void> | null = null;
let captureSessionReady = false;
/** When set, output is fullscreen on this Electron display id (screen go-live for system audio). */
let stageDisplayId: number | null = null;
/** Remembered stage screen id so focus can re-promote after park. */
let stageScreenIdSaved: string | null = null;
/** True after minimize/park — Discord must use window: capture or the stream goes blank. */
let outputParked = false;
/**
 * Minimize requested while staged: wait for renderer to switch Discord to window:
 * capture, then confirmOutputPark() actually parks. Otherwise the stream blanks.
 */
let pendingPark = false;
let pendingParkTimer: ReturnType<typeof setTimeout> | null = null;
/** Floating size used when parking (not covering the whole stage monitor). */
let floatingSize = { width: 960, height: 540 };

function coverStageDisplay(win: import("electron").BrowserWindow, display: import("electron").Display) {
    // Do NOT use exclusive fullscreen — it hides the title bar / breaks minimize.
    // Cover the monitor with a normal framed window so screen capture still sees the mosaic.
    if (win.isFullScreen()) win.setFullScreen(false);
    win.setBounds({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height
    });
}

function findDisplayForScreenId(screenId: string | undefined | null) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { screen } = require("electron") as typeof import("electron");
    const displays = screen.getAllDisplays();
    if (!screenId) return null;
    // Match screen:<electronDisplayId>:0 or screen:<index>:0 from listScreens.
    const parts = screenId.split(":");
    const mid = parts[1];
    if (mid && /^\d+$/.test(mid)) {
        const byId = displays.find(d => String(d.id) === mid);
        if (byId) return byId;
        const idx = Number(mid);
        if (Number.isFinite(idx) && displays[idx]) return displays[idx];
    }
    return null;
}

async function resolveScreenIdForDisplay(display: import("electron").Display): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron") as typeof import("electron");
    const sources = await electron.desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false
    });
    const match = sources.find(item => (item as { display_id?: string; }).display_id === String(display.id))
        ?? sources.find(item => item.id === `screen:${display.id}:0`)
        ?? sources.find(item => item.id.split(":")[1] === String(display.id));
    return match?.id ?? `screen:${display.id}:0`;
}

/** Discord's default session denies desktop capture for any window but its own. */
function prepareCaptureSession() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { session } = require("electron") as typeof import("electron");
    const ses = session.fromPartition(OUTPUT_PARTITION);
    if (captureSessionReady) return ses;
    captureSessionReady = true;
    const allow = (permission: string) =>
        permission === "media"
        || permission === "display-capture"
        || permission === "mediaKeySystem";
    ses.setPermissionCheckHandler((_wc, permission) => allow(String(permission)));
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allow(String(permission))));
    const extended = ses as typeof ses & {
        setDevicePermissionHandler?: (handler: (details: { deviceType?: string; }) => boolean) => void;
    };
    extended.setDevicePermissionHandler?.(details => {
        const type = String(details?.deviceType || "");
        return type === "media" || type === "display-capture" || type === "";
    });
    return ses;
}

const OUTPUT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>TripleScreen Output</title>
<style>html,body{margin:0;background:#000;overflow:hidden}canvas{width:100%;height:100%;display:block}</style>
</head><body><canvas id="c"></canvas><script>
const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
ctx.imageSmoothingEnabled = true;
ctx.imageSmoothingQuality = "high";
const videos = new Map();
const frozen = new Map();
/** Last successfully painted frame per source — avoids blank flashes when DXGI drops a frame. */
const lastFrame = new Map();
/** Locked capture→draw rotation per source (must not flip every frame). */
const orientLock = new Map();
const reconnectAt = new Map();
let cfg = null;
let bgImage = null;
let bgImageUrl = "";

function destRect(item, srcW, srcH) {
  if (item.scaleMode === "stretch") return { x: item.x, y: item.y, w: item.width, h: item.height };
  const scale = item.scaleMode === "fill"
    ? Math.max(item.width / srcW, item.height / srcH)
    : Math.min(item.width / srcW, item.height / srcH);
  const w = srcW * scale, h = srcH * scale;
  return { x: item.x + (item.width - w) / 2, y: item.y + (item.height - h) / 2, w: w, h: h };
}

function bgDest(fit, srcW, srcH, canvasW, canvasH, scaleMul, offsetXPct, offsetYPct) {
  var x = 0, y = 0, w = canvasW, h = canvasH;
  if (fit === "stretch") { w = canvasW; h = canvasH; }
  else if (fit === "center") {
    w = srcW; h = srcH;
    x = (canvasW - w) / 2; y = (canvasH - h) / 2;
  } else {
    var base = fit === "fill"
      ? Math.max(canvasW / srcW, canvasH / srcH)
      : Math.min(canvasW / srcW, canvasH / srcH);
    w = srcW * base; h = srcH * base;
    x = (canvasW - w) / 2; y = (canvasH - h) / 2;
  }
  var mul = Math.max(0.25, Math.min(4, Number(scaleMul) || 1));
  var sw = w * mul, sh = h * mul;
  var ox = (Number(offsetXPct) || 0) / 100 * canvasW;
  var oy = (Number(offsetYPct) || 0) / 100 * canvasH;
  return { x: x + (w - sw) / 2 + ox, y: y + (h - sh) / 2 + oy, w: sw, h: sh };
}

function loadBgImage(url) {
  if (!url) {
    bgImage = null;
    bgImageUrl = "";
    return Promise.resolve();
  }
  if (url === bgImageUrl && bgImage && bgImage.complete) return Promise.resolve();
  bgImageUrl = url;
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => { bgImage = img; resolve(); };
    img.onerror = () => { bgImage = null; bgImageUrl = ""; resolve(); };
    img.src = url;
  });
}

const pending = new Map();

/**
 * Decide capture→draw rotation once. DXGI often returns an unrotated (landscape) buffer for
 * portrait OS modes; Chromium sometimes then flips reported size frame-to-frame. Recomputing
 * every paint made vertical tiles flip in/out — lock after the first stable sample.
 */
function lockedOrient(id, srcW, srcH, expectW, expectH, displayRotation) {
  const prev = orientLock.get(id);
  if (prev && prev.w === srcW && prev.h === srcH) return prev.deg;
  if (prev && Date.now() - prev.at < 1500) return prev.deg;
  let deg = 0;
  if (srcW && srcH && expectW > 0 && expectH > 0) {
    const srcLandscape = srcW >= srcH;
    const expectLandscape = expectW >= expectH;
    if (srcLandscape !== expectLandscape) {
      const rot = ((Number(displayRotation) % 360) + 360) % 360;
      deg = (rot === 90 || rot === 270) ? rot : 90;
    }
  }
  orientLock.set(id, { deg, w: srcW, h: srcH, at: Date.now() });
  return deg;
}

function snapshotLastFrame(id, video) {
  if (!video || video.readyState < 2 || !video.videoWidth) return;
  try {
    let c = lastFrame.get(id);
    if (!c || c.width !== video.videoWidth || c.height !== video.videoHeight) {
      c = document.createElement("canvas");
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      lastFrame.set(id, c);
    }
    c.getContext("2d").drawImage(video, 0, 0);
  } catch (_) {}
}

function scheduleReconnect(id) {
  if (!cfg || !(cfg.items || []).some(item => item.sourceId === id)) return;
  const now = Date.now();
  const nextAt = reconnectAt.get(id) || 0;
  if (now < nextAt) return;
  reconnectAt.set(id, now + 1500);
  setTimeout(() => {
    if (!cfg || !(cfg.items || []).some(item => item.sourceId === id)) return;
    if (videos.has(id) || pending.has(id)) return;
    ensureVideo(id).catch(() => {});
  }, 200);
}

async function openDesktopStream(sourceId, maxFps) {
  const media = navigator.mediaDevices;
  return media.getUserMedia({
    audio: false,
    video: { mandatory: {
      chromeMediaSource: "desktop",
      chromeMediaSourceId: sourceId,
      maxFrameRate: maxFps,
      maxWidth: 8192,
      maxHeight: 8192
    } }
  });
}

async function ensureVideo(id) {
  if (videos.has(id)) return videos.get(id);
  if (pending.has(id)) return pending.get(id);
  const job = (async () => {
    const media = navigator.mediaDevices;
    if (!media || typeof media.getUserMedia !== "function") {
      throw new Error("mediaDevices unavailable in output page (bad origin)");
    }
    const item = (cfg && (cfg.items || []).find(i => i.sourceId === id)) || null;
    // Prefer 30fps on secondary / tall displays — dual-monitor DXGI is flaky at 60 on many GPUs.
    const secondary = item && item.isPrimary === false;
    const tall = item && item.expectH > item.expectW;
    const maxFps = (secondary || tall) ? 30 : 60;
    const candidates = [...new Set([
      id,
      ...((item && item.altSourceIds) || [])
    ].filter(Boolean))];
    // Avoid opening the same chromeMediaSourceId twice (two tiles → DXGI fight → flicker).
    const inUse = new Set();
    for (const [otherId, otherVideo] of videos) {
      if (otherId === id) continue;
      const stream = otherVideo && otherVideo.srcObject;
      const track = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
      const settings = track && track.getSettings ? track.getSettings() : null;
      // settings.deviceId is not set for desktop; track label sometimes has id — keep map of chosen ids
      if (otherVideo.__tsSourceId) inUse.add(otherVideo.__tsSourceId);
    }
    let stream = null;
    let usedId = id;
    let lastErr = null;
    for (const candidate of candidates) {
      if (inUse.has(candidate)) continue;
      try {
        stream = await openDesktopStream(candidate, maxFps);
        usedId = candidate;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!stream) throw lastErr || new Error("No desktop source worked for " + id);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.__tsSourceId = usedId;
    video.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.appendChild(video);
    await video.play();
    const track = stream.getVideoTracks()[0];
    if (track) {
      try { track.contentHint = "motion"; } catch (_) {}
      track.onended = () => {
        snapshotLastFrame(id, video);
        try { video.remove(); } catch (_) {}
        if (videos.get(id) === video) videos.delete(id);
        scheduleReconnect(id);
      };
      track.onmute = () => { snapshotLastFrame(id, video); };
    }
    videos.set(id, video);
    return video;
  })();
  pending.set(id, job);
  try { return await job; }
  finally { pending.delete(id); }
}

function paintTile(item, src, srcWidth, srcHeight, orient) {
  const crop = item.crop || { top: 0, right: 0, bottom: 0, left: 0 };
  const srcW = Math.max(1, srcWidth - (crop.left || 0) - (crop.right || 0));
  const srcH = Math.max(1, srcHeight - (crop.top || 0) - (crop.bottom || 0));
  const layoutW = (orient === 90 || orient === 270) ? srcH : srcW;
  const layoutH = (orient === 90 || orient === 270) ? srcW : srcH;
  ctx.save();
  if (item.rotation) {
    const cx = item.x + item.width / 2, cy = item.y + item.height / 2;
    ctx.translate(cx, cy);
    ctx.rotate(item.rotation * Math.PI / 180);
    ctx.translate(-cx, -cy);
  }
  ctx.beginPath();
  ctx.rect(item.x, item.y, item.width, item.height);
  ctx.clip();
  const dest = destRect(item, layoutW, layoutH);
  if (orient) {
    const cx = dest.x + dest.w / 2, cy = dest.y + dest.h / 2;
    ctx.translate(cx, cy);
    ctx.rotate(orient * Math.PI / 180);
    const dw = (orient === 90 || orient === 270) ? dest.h : dest.w;
    const dh = (orient === 90 || orient === 270) ? dest.w : dest.h;
    ctx.drawImage(src, crop.left || 0, crop.top || 0, srcW, srcH, -dw / 2, -dh / 2, dw, dh);
  } else {
    ctx.drawImage(src, crop.left || 0, crop.top || 0, srcW, srcH, dest.x, dest.y, dest.w, dest.h);
  }
  ctx.restore();
}

function draw() {
  if (!cfg) return;
  const width = cfg.width | 0, height = cfg.height | 0;
  if (width > 0 && canvas.width !== width) canvas.width = width;
  if (height > 0 && canvas.height !== height) canvas.height = height;
  ctx.fillStyle = cfg.background || "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (bgImage && bgImage.naturalWidth) {
    const dest = bgDest(
      cfg.backgroundFit || "fill",
      bgImage.naturalWidth,
      bgImage.naturalHeight,
      canvas.width,
      canvas.height,
      cfg.backgroundScale,
      cfg.backgroundOffsetX,
      cfg.backgroundOffsetY
    );
    ctx.drawImage(bgImage, dest.x, dest.y, dest.w, dest.h);
  }
  const items = (cfg.items || []).slice().sort((a, b) => (a.z || 0) - (b.z || 0));
  for (const item of items) {
    const video = videos.get(item.sourceId);
    const freeze = frozen.get(item.sourceId);
    const hold = lastFrame.get(item.sourceId);
    const liveOk = video && video.readyState >= 2 && video.videoWidth > 0
      && !(video.srcObject && video.srcObject.getVideoTracks && video.srcObject.getVideoTracks()[0] && video.srcObject.getVideoTracks()[0].muted);
    if (liveOk) snapshotLastFrame(item.sourceId, video);
    const src = liveOk ? video : (hold || freeze);
    if (!src) {
      if (!videos.has(item.sourceId) && !pending.has(item.sourceId) && !frozen.has(item.sourceId)) {
        scheduleReconnect(item.sourceId);
      }
      continue;
    }
    const srcWidth = src.videoWidth || src.width || 0;
    const srcHeight = src.videoHeight || src.height || 0;
    if (!srcWidth || !srcHeight) continue;
    const orient = lockedOrient(
      item.sourceId,
      srcWidth,
      srcHeight,
      item.expectW || 0,
      item.expectH || 0,
      item.displayRotation || 0
    );
    paintTile(item, src, srcWidth, srcHeight, orient);
  }
}
// setInterval keeps painting when covered; rAF stalls when occluded. Honor cfg.fps.
let drawTimer = null;
function armDraw(fps) {
  if (drawTimer) clearInterval(drawTimer);
  const rate = Math.max(1, Math.min(60, Number(fps) || 30));
  drawTimer = setInterval(draw, Math.max(8, Math.round(1000 / rate)));
}
armDraw(30);

let applyChain = Promise.resolve();
window.__tsApply = function (next) {
  applyChain = applyChain.then(async () => {
    cfg = next;
    armDraw(next && next.fps);
    await loadBgImage(next && next.backgroundImage ? String(next.backgroundImage) : "");
    const ids = [...new Set((next.items || []).map(item => item.sourceId).filter(Boolean))];
    const errors = [];
    for (const id of ids) {
      if (frozen.has(id)) continue;
      try { await ensureVideo(id); }
      catch (err) { errors.push(id + ": " + (err && err.message ? err.message : String(err))); }
    }
    for (const [id, video] of [...videos]) {
      if (ids.includes(id)) continue;
      const stream = video.srcObject;
      if (stream) stream.getTracks().forEach(track => track.stop());
      video.remove();
      videos.delete(id);
      lastFrame.delete(id);
      orientLock.delete(id);
      reconnectAt.delete(id);
    }
    for (const id of [...frozen.keys()]) {
      if (ids.includes(id)) continue;
      frozen.delete(id);
    }
    for (const id of [...lastFrame.keys()]) {
      if (ids.includes(id)) continue;
      lastFrame.delete(id);
      orientLock.delete(id);
      reconnectAt.delete(id);
    }
    return { ok: errors.length === 0, videos: videos.size + frozen.size, errors: errors };
  });
  return applyChain;
};

/** Snapshot live tiles then stop capture — used before fullscreen stage so the host monitor does not mirror the composite. */
window.__tsFreeze = function (ids) {
  const list = Array.isArray(ids) ? ids : [ids];
  const done = [];
  for (const id of list) {
    if (!id || frozen.has(id)) { if (id) done.push(id); continue; }
    const video = videos.get(id);
    if (!video || video.readyState < 2 || !video.videoWidth) continue;
    const c = document.createElement("canvas");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext("2d").drawImage(video, 0, 0);
    const stream = video.srcObject;
    if (stream) stream.getTracks().forEach(track => track.stop());
    try { video.remove(); } catch (_) {}
    videos.delete(id);
    frozen.set(id, c);
    done.push(id);
  }
  return { ok: done.length > 0, frozen: done };
};
</script></body></html>`;

/** data: URLs have no navigator.mediaDevices — write a real file origin instead. */
function ensureOutputHtmlFile() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require("os") as typeof import("os");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path") as typeof import("path");
    const dir = path.join(os.tmpdir(), "triplescreen-vencord");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "output.html");
    fs.writeFileSync(file, OUTPUT_HTML, "utf8");
    return file;
}

export interface OpenOutputOptions {
    /** Electron/Discord screen id to fullscreen onto for system-audio go-live. */
    stageScreenId?: string | null;
}

/**
 * Opens the TripleScreen Output window.
 * - Normal: floating window Discord shares as window:…
 * - Stage: fullscreen on a monitor Discord shares as screen:… + soundshareId 1
 */
export async function openOutputWindow(
    _event: IpcMainInvokeEvent,
    width: number,
    height: number,
    frameRate?: number,
    options?: OpenOutputOptions
) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BrowserWindow, screen } = require("electron") as typeof import("electron");
    prepareCaptureSession();
    const canvasW = clampInt(width, 640, 2560);
    const canvasH = clampInt(height, 360, 1440);
    void frameRate;
    outputParked = false;

    const stageDisplay = findDisplayForScreenId(options?.stageScreenId ?? null);
    if (options?.stageScreenId) stageScreenIdSaved = String(options.stageScreenId);
    const nextStageId = stageDisplay?.id ?? null;
    // Frame / fullscreen chrome is fixed at BrowserWindow creation — recreate when mode flips.
    if (outputWindow && !outputWindow.isDestroyed()) {
        const modeChanged = (stageDisplayId == null) !== (nextStageId == null)
            || (nextStageId != null && stageDisplayId !== nextStageId);
        if (modeChanged) {
            try { outputWindow.destroy(); } catch { /* ignore */ }
            outputWindow = null;
            pageReady = null;
        }
    }
    stageDisplayId = nextStageId;

    const area = (stageDisplay ?? screen.getPrimaryDisplay()).workArea;
    const maxW = Math.max(320, area.width - (stageDisplay ? 0 : 48));
    const maxH = Math.max(240, area.height - (stageDisplay ? 0 : 48));
    const scale = stageDisplay ? 1 : Math.min(1, maxW / canvasW, maxH / canvasH);
    const w = stageDisplay
        ? Math.max(320, stageDisplay.bounds.width)
        : Math.max(320, Math.round(canvasW * scale));
    const h = stageDisplay
        ? Math.max(240, stageDisplay.bounds.height)
        : Math.max(240, Math.round(canvasH * scale));
    // Always remember a floating size for minimize/park (even if we open staged).
    const floatScale = Math.min(1, Math.max(320, area.width - 48) / canvasW, Math.max(240, area.height - 48) / canvasH);
    floatingSize = {
        width: Math.max(320, Math.round(canvasW * floatScale)),
        height: Math.max(240, Math.round(canvasH * floatScale))
    };

    if (!outputWindow || outputWindow.isDestroyed()) {
        const win = new BrowserWindow({
            width: w,
            height: h,
            title: OUTPUT_TITLE,
            show: false,
            frame: true,
            fullscreen: false,
            resizable: false,
            minimizable: true,
            maximizable: false,
            skipTaskbar: false,
            backgroundColor: "#000000",
            webPreferences: {
                partition: OUTPUT_PARTITION,
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: false,
                webSecurity: false,
                backgroundThrottling: false
            }
        });
        outputWindow = win;
        win.setContentProtection(false);
        win.webContents.setBackgroundThrottling(false);
        win.on("closed", () => {
            if (outputWindow === win) outputWindow = null;
            pageReady = null;
            stageDisplayId = null;
            stageScreenIdSaved = null;
            outputParked = false;
            pendingPark = false;
            if (pendingParkTimer) {
                clearTimeout(pendingParkTimer);
                pendingParkTimer = null;
            }
        });
        win.on("minimize", () => {
            setImmediate(() => {
                if (!win || win.isDestroyed() || outputWindow !== win) return;
                // Undo OS minimize immediately (minimized = blank capture for window: too).
                if (win.isMinimized()) win.restore();
                requestPark(win);
            });
        });
        win.on("focus", () => {
            if (outputWindow !== win || win.isDestroyed()) return;
            win.setIgnoreMouseEvents(false);
            if (stageDisplayId == null || outputParked) win.moveTop();
        });
        pageReady = new Promise((resolve, reject) => {
            win.webContents.once("did-finish-load", () => resolve());
            win.webContents.once("did-fail-load", (_e, code, desc) => {
                reject(new Error(`Output page failed to load (${code}): ${desc}`));
            });
        });
        // file:// origin exposes navigator.mediaDevices; data: URLs do not.
        void win.loadFile(ensureOutputHtmlFile());
    } else {
        outputWindow.setContentProtection(false);
        outputWindow.webContents.setBackgroundThrottling(false);
    }

    let screenSourceId: string | null = null;
    if (stageDisplay) {
        coverStageDisplay(outputWindow, stageDisplay);
        screenSourceId = options?.stageScreenId && findDisplayForScreenId(options.stageScreenId)?.id === stageDisplay.id
            ? String(options.stageScreenId)
            : await resolveScreenIdForDisplay(stageDisplay);
    } else {
        if (outputWindow.isFullScreen()) outputWindow.setFullScreen(false);
        outputWindow.setContentSize(w, h);
        const [bw, bh] = outputWindow.getSize();
        const x = area.x + Math.max(0, Math.round((area.width - bw) / 2));
        const y = area.y + Math.max(0, Math.round((area.height - bh) / 2));
        outputWindow.setPosition(x, y);
    }

    outputWindow.showInactive();
    if (!stageDisplay) outputWindow.moveTop();

    let sourceId: string | null = null;
    try {
        sourceId = outputWindow.getMediaSourceId();
    } catch {
        sourceId = null;
    }
    return {
        width: canvasW,
        height: canvasH,
        sourceId,
        screenSourceId,
        stageDisplayId
    };
}

export function isOutputWindowOpen(_event: IpcMainInvokeEvent) {
    return !!outputWindow && !outputWindow.isDestroyed();
}

function sanitizeOutputConfig(config: unknown) {
    if (!config || typeof config !== "object") return null;
    const raw = config as Record<string, unknown>;
    const itemsIn = Array.isArray(raw.items) ? raw.items.slice(0, 8) : [];
    const items = [];
    for (const item of itemsIn) {
        if (!item || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        const sourceId = String(row.sourceId ?? "");
        // Accept Electron / DiscordNative screen ids only (never arbitrary window ids).
        if (!/^screen:\d+:\d+$/i.test(sourceId) && !/^screen-handle:\d+$/i.test(sourceId) && !/^screen:\d+$/i.test(sourceId)) continue;
        const altRaw = Array.isArray(row.altSourceIds) ? row.altSourceIds : [];
        const altSourceIds = altRaw
            .map(v => String(v))
            .filter(v =>
                /^screen:\d+:\d+$/i.test(v) || /^screen-handle:\d+$/i.test(v) || /^screen:\d+$/i.test(v)
            )
            .slice(0, 6);
        items.push({
            sourceId,
            altSourceIds,
            isPrimary: row.isPrimary === true,
            x: clampInt(Number(row.x), -4096, 8192),
            y: clampInt(Number(row.y), -4096, 8192),
            width: clampInt(Number(row.width), 1, 8192),
            height: clampInt(Number(row.height), 1, 8192),
            z: clampInt(Number(row.z), -100, 100),
            scaleMode: ["fit", "fill", "stretch"].includes(String(row.scaleMode)) ? String(row.scaleMode) : "fit",
            rotation: clampInt(Number(row.rotation), -360, 360),
            expectW: clampInt(Number(row.expectW), 0, 8192),
            expectH: clampInt(Number(row.expectH), 0, 8192),
            displayRotation: [0, 90, 180, 270].includes(Number(row.displayRotation))
                ? Number(row.displayRotation)
                : 0,
            crop: {
                top: clampInt(Number((row.crop as any)?.top), 0, 4096),
                right: clampInt(Number((row.crop as any)?.right), 0, 4096),
                bottom: clampInt(Number((row.crop as any)?.bottom), 0, 4096),
                left: clampInt(Number((row.crop as any)?.left), 0, 4096)
            }
        });
    }
    const backgroundImage = sanitizeBackgroundImage(raw.backgroundImage);
    const fitRaw = String(raw.backgroundFit || "fill");
    const backgroundFit = ["fit", "fill", "stretch", "center"].includes(fitRaw) ? fitRaw : "fill";
    const clampF = (n: number, min: number, max: number, fb: number) => {
        const v = Number(n);
        if (!Number.isFinite(v)) return fb;
        return Math.min(max, Math.max(min, v));
    };
    return {
        width: clampInt(Number(raw.width), 320, 2560),
        height: clampInt(Number(raw.height), 180, 1440),
        fps: clampInt(Number(raw.fps), 1, 60),
        background: typeof raw.background === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.background)
            ? raw.background
            : "#000000",
        backgroundImage,
        backgroundFit,
        backgroundScale: clampF(Number(raw.backgroundScale), 0.25, 4, 1),
        backgroundOffsetX: clampF(Number(raw.backgroundOffsetX), -100, 100, 0),
        backgroundOffsetY: clampF(Number(raw.backgroundOffsetY), -100, 100, 0),
        items
    };
}

function sanitizeBackgroundImage(value: unknown) {
    if (typeof value !== "string" || !value) return "";
    // Only in-memory data URLs — never remote http(s) into the output page.
    if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(value)) return "";
    if (value.length > 900_000) return "";
    return value;
}

export async function configureOutput(_event: IpcMainInvokeEvent, config: unknown) {
    if (!outputWindow || outputWindow.isDestroyed()) return { ok: false, videos: 0, errors: ["Output window is not open"] };
    const safe = sanitizeOutputConfig(config);
    if (!safe) return { ok: false, videos: 0, errors: ["Invalid output config"] };

    // Re-resolve capturer ids right before capture so Windows display_id mismatches
    // cannot leave two tiles on the same source (secondary flicker).
    try {
        const screens = await listScreens(_event);
        const used = new Set<string>();
        for (const item of safe.items as Array<Record<string, any>>) {
            let match = screens.find(s =>
                (s.id === item.sourceId || (s.altIds || []).includes(item.sourceId)) && !used.has(s.id)
            );
            if (!match && item.expectW && item.expectH) {
                match = screens.find(s =>
                    !used.has(s.id) && s.width === item.expectW && s.height === item.expectH
                );
            }
            if (!match) match = screens.find(s => !used.has(s.id) && !!s.isPrimary === !!item.isPrimary);
            if (!match) match = screens.find(s => !used.has(s.id));
            if (match) {
                used.add(match.id);
                item.sourceId = match.id;
                item.altSourceIds = match.altIds || [];
                item.isPrimary = !!match.isPrimary;
                item.expectW = match.width;
                item.expectH = match.height;
                item.displayRotation = match.rotation || 0;
            }
        }
    } catch { /* keep sanitized ids */ }

    try {
        if (pageReady) await pageReady;
    } catch (err) {
        return { ok: false, videos: 0, errors: [err instanceof Error ? err.message : String(err)] };
    }
    try {
        const result = await outputWindow.webContents.executeJavaScript(
            `window.__tsApply(${JSON.stringify(safe)})`,
            true
        );
        return result ?? { ok: false, videos: 0, errors: ["Output page did not start"] };
    } catch (err) {
        return { ok: false, videos: 0, errors: [err instanceof Error ? err.message : String(err)] };
    }
}

/** Freeze live tiles to still frames (before stage fullscreen) so the host monitor is not recursive. */
export async function freezeOutputSources(_event: IpcMainInvokeEvent, sourceIds: string[]) {
    if (!outputWindow || outputWindow.isDestroyed()) return { ok: false, frozen: [] as string[] };
    const ids = (Array.isArray(sourceIds) ? sourceIds : []).map(String).filter(Boolean).slice(0, 8);
    if (!ids.length) return { ok: false, frozen: [] as string[] };
    try {
        if (pageReady) await pageReady;
        const result = await outputWindow.webContents.executeJavaScript(
            `window.__tsFreeze(${JSON.stringify(ids)})`,
            true
        );
        return result ?? { ok: false, frozen: [] as string[] };
    } catch {
        return { ok: false, frozen: [] as string[] };
    }
}

/**
 * Move an already-open floating Output onto a display fullscreen for Discord screen go-live.
 * Call after mosaic captures + freeze so all selected monitors stay in the stream.
 */
export async function promoteOutputToStage(_event: IpcMainInvokeEvent, stageScreenId: string) {
    if (!outputWindow || outputWindow.isDestroyed()) {
        return { ok: false, screenSourceId: null as string | null, stageDisplayId: null as number | null };
    }
    const stageDisplay = findDisplayForScreenId(stageScreenId);
    if (!stageDisplay) {
        return { ok: false, screenSourceId: null, stageDisplayId: null };
    }
    stageDisplayId = stageDisplay.id;
    stageScreenIdSaved = String(stageScreenId);
    outputParked = false;
    pendingPark = false;
    if (pendingParkTimer) {
        clearTimeout(pendingParkTimer);
        pendingParkTimer = null;
    }
    try {
        coverStageDisplay(outputWindow, stageDisplay);
        outputWindow.setIgnoreMouseEvents(false);
        outputWindow.showInactive();
        outputWindow.moveTop();
    } catch (err) {
        loggerWarn("promoteOutputToStage failed", err);
        return { ok: false, screenSourceId: null, stageDisplayId: null };
    }
    const screenSourceId = findDisplayForScreenId(stageScreenId)?.id === stageDisplay.id
        ? String(stageScreenId)
        : await resolveScreenIdForDisplay(stageDisplay);
    return { ok: true, screenSourceId, stageDisplayId };
}

/**
 * Share/park state for the renderer.
 * pendingPark: minimize hit while staged — switch Discord to window: THEN call confirmOutputPark.
 */
export function getOutputShareState(_event: IpcMainInvokeEvent) {
    const open = !!outputWindow && !outputWindow.isDestroyed();
    let focused = false;
    try {
        focused = open && !!outputWindow?.isFocused();
    } catch { focused = false; }
    return {
        open,
        parked: open && outputParked,
        pendingPark: open && pendingPark,
        focused,
        stageScreenId: stageScreenIdSaved,
        stageDisplayId
    };
}

/** Renderer calls this AFTER switching go-live to the Output window source. */
export function confirmOutputPark(_event: IpcMainInvokeEvent) {
    pendingPark = false;
    if (pendingParkTimer) {
        clearTimeout(pendingParkTimer);
        pendingParkTimer = null;
    }
    if (!outputWindow || outputWindow.isDestroyed()) {
        return { ok: false, parked: false };
    }
    parkForMinimize(outputWindow);
    return { ok: true, parked: true };
}

function requestPark(win: import("electron").BrowserWindow) {
    if (outputParked) {
        parkForMinimize(win);
        return;
    }
    // Staged (screen go-live): ask renderer to switch to window: first, or stream blanks.
    if (stageDisplayId != null || stageScreenIdSaved) {
        pendingPark = true;
        if (pendingParkTimer) clearTimeout(pendingParkTimer);
        // Fallback if renderer never confirms (plugin old / stuck).
        pendingParkTimer = setTimeout(() => {
            pendingParkTimer = null;
            if (!pendingPark || !outputWindow || outputWindow.isDestroyed()) return;
            pendingPark = false;
            parkForMinimize(outputWindow);
        }, 2000);
        return;
    }
    parkForMinimize(win);
}

function loggerWarn(message: string, err?: unknown) {
    try {
        // eslint-disable-next-line no-console
        console.warn("[TripleScreen:native]", message, err);
    } catch { /* ignore */ }
}

export async function getOutputSourceId(_event: IpcMainInvokeEvent) {
    if (!outputWindow || outputWindow.isDestroyed()) return null;
    try {
        return outputWindow.getMediaSourceId();
    } catch {
        // Fallback for older Electron builds.
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { desktopCapturer } = require("electron") as typeof import("electron");
    const sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false
    });
    return sources.find(source => source.name.includes(OUTPUT_TITLE))?.id ?? null;
}

export async function closeOutputWindow(_event: IpcMainInvokeEvent) {
    const win = outputWindow;
    if (!win || win.isDestroyed()) {
        outputWindow = null;
        pageReady = null;
        stageDisplayId = null;
        stageScreenIdSaved = null;
        outputParked = false;
        return true;
    }
    try {
        if (win.isFullScreen()) win.setFullScreen(false);
    } catch { /* ignore */ }
    await new Promise<void>(resolve => {
        win.once("closed", () => resolve());
        win.close();
        setTimeout(resolve, 1500);
    });
    if (outputWindow === win) outputWindow = null;
    pageReady = null;
    stageDisplayId = null;
    stageScreenIdSaved = null;
    outputParked = false;
    pendingPark = false;
    if (pendingParkTimer) {
        clearTimeout(pendingParkTimer);
        pendingParkTimer = null;
    }
    return true;
}

/**
 * Shrink in place on the current monitor and park behind other windows.
 * Keeps the BrowserWindow painted so Discord window: capture still shows the mosaic.
 * Does NOT jump to the primary monitor.
 */
function parkForMinimize(win: import("electron").BrowserWindow) {
    outputParked = true;
    try {
        if (win.isMinimized()) win.restore();
        if (win.isFullScreen()) win.setFullScreen(false);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { screen } = require("electron") as typeof import("electron");
        const current = win.getBounds();
        const display = (stageDisplayId != null
            ? screen.getAllDisplays().find(d => d.id === stageDisplayId)
            : null) ?? screen.getDisplayMatching(current);
        const area = display.workArea;
        const fw = Math.min(Math.max(320, floatingSize.width), area.width);
        const fh = Math.min(Math.max(240, floatingSize.height), area.height);
        win.setContentSize(fw, fh);
        const [bw, bh] = win.getSize();
        // Keep on the same monitor (corner), not teleport to primary.
        win.setPosition(
            area.x + Math.max(0, area.width - bw - 16),
            area.y + Math.max(0, area.height - bh - 16)
        );
    } catch { /* park anyway */ }
    parkOutputWindow(win);
}

/** Park behind other windows while staying painted (window: capture stays alive). */
function parkOutputWindow(win: import("electron").BrowserWindow) {
    if (win.isMinimized()) win.restore();
    win.setIgnoreMouseEvents(true, { forward: true });
    win.showInactive();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BrowserWindow } = require("electron") as typeof import("electron");
    const others = BrowserWindow.getAllWindows()
        .filter(other => other !== win && !other.isDestroyed() && other.isVisible() && !other.isMinimized());
    others.sort((a, b) => {
        const [aw, ah] = a.getSize();
        const [bw, bh] = b.getSize();
        return (bw * bh) - (aw * ah);
    });
    others[0]?.focus();
    const handle = win.getNativeWindowHandle();
    const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : String(handle.readUInt32LE(0));
    if (!/^\d+$/.test(hwnd)) return;
    lowerBehind(hwnd);
    setTimeout(() => {
        if (outputWindow !== win || win.isDestroyed() || win.isFocused()) return;
        lowerBehind(hwnd);
    }, 300);
}

function lowerBehind(hwnd: string) {
    if (!/^\d+$/.test(hwnd)) return;
    const script = [
        "Add-Type -Namespace TsScreen -Name Win -MemberDefinition '",
        "[System.Runtime.InteropServices.DllImport(\"user32.dll\")]",
        "public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);'",
        `[TsScreen.Win]::SetWindowPos([IntPtr]::new([int64]${hwnd}), [IntPtr]::new(1), 0, 0, 0, 0, 19) | Out-Null`
    ].join("\n");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require("child_process") as typeof import("child_process");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    child.on("error", () => undefined);
}

function clampInt(value: number, min: number, max: number) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
}
