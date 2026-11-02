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
    bounds: { x: number; y: number; width: number; height: number; };
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
    });

    return displays.map((display, index) => {
        const source = sources.find(item => (item as { display_id?: string; }).display_id === String(display.id))
            ?? sources.find(item => item.id === `screen:${display.id}:0`)
            ?? sources.find(item => item.id.split(":")[1] === String(display.id))
            ?? sources[index];
        let url: string | undefined;
        try {
            if (source && !source.thumbnail.isEmpty()) url = source.thumbnail.toDataURL();
        } catch {
            url = undefined;
        }
        return {
            id: source?.id ?? `screen:${index}:0`,
            name: source?.name || `Monitor ${index + 1}`,
            url,
            width: Math.round(display.size.width * display.scaleFactor),
            height: Math.round(display.size.height * display.scaleFactor),
            refreshRate: display.displayFrequency || undefined,
            isPrimary: display.id === primaryId,
            bounds: {
                x: display.bounds.x,
                y: display.bounds.y,
                width: display.bounds.width,
                height: display.bounds.height
            }
        };
    });
}

const OUTPUT_TITLE = "TripleScreen Output";
const OUTPUT_PARTITION = "triplescreen-output";
let outputWindow: import("electron").BrowserWindow | null = null;
let pageReady: Promise<void> | null = null;
let captureSessionReady = false;
/** When set, output is fullscreen on this Electron display id (screen go-live for system audio). */
let stageDisplayId: number | null = null;

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
let cfg = null;

function destRect(item, srcW, srcH) {
  if (item.scaleMode === "stretch") return { x: item.x, y: item.y, w: item.width, h: item.height };
  const scale = item.scaleMode === "fill"
    ? Math.max(item.width / srcW, item.height / srcH)
    : Math.min(item.width / srcW, item.height / srcH);
  const w = srcW * scale, h = srcH * scale;
  return { x: item.x + (item.width - w) / 2, y: item.y + (item.height - h) / 2, w: w, h: h };
}

const pending = new Map();

async function ensureVideo(id) {
  if (videos.has(id)) return videos.get(id);
  if (pending.has(id)) return pending.get(id);
  const job = (async () => {
    const media = navigator.mediaDevices;
    if (!media || typeof media.getUserMedia !== "function") {
      throw new Error("mediaDevices unavailable in output page (bad origin)");
    }
    const stream = await media.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: id, maxFrameRate: 60, maxWidth: 3840, maxHeight: 2160 } }
    });
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.appendChild(video);
    await video.play();
    const track = stream.getVideoTracks()[0];
    if (track) track.onended = () => {
      try { video.remove(); } catch (_) {}
      videos.delete(id);
      // Re-acquire so a transient desktop-capturer blip does not leave a black tile.
      if (cfg && (cfg.items || []).some(item => item.sourceId === id)) {
        ensureVideo(id).catch(() => {});
      }
    };
    videos.set(id, video);
    return video;
  })();
  pending.set(id, job);
  try { return await job; }
  finally { pending.delete(id); }
}

function draw() {
  if (!cfg) return;
  const width = cfg.width | 0, height = cfg.height | 0;
  if (width > 0 && canvas.width !== width) canvas.width = width;
  if (height > 0 && canvas.height !== height) canvas.height = height;
  ctx.fillStyle = cfg.background || "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const items = (cfg.items || []).slice().sort((a, b) => (a.z || 0) - (b.z || 0));
  for (const item of items) {
    const video = videos.get(item.sourceId);
    if (!video || video.readyState < 2 || !video.videoWidth) continue;
    const crop = item.crop || { top: 0, right: 0, bottom: 0, left: 0 };
    const srcW = Math.max(1, video.videoWidth - (crop.left || 0) - (crop.right || 0));
    const srcH = Math.max(1, video.videoHeight - (crop.top || 0) - (crop.bottom || 0));
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
    const dest = destRect(item, srcW, srcH);
    ctx.drawImage(video, crop.left || 0, crop.top || 0, srcW, srcH, dest.x, dest.y, dest.w, dest.h);
    ctx.restore();
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
    const ids = [...new Set((next.items || []).map(item => item.sourceId).filter(Boolean))];
    const errors = [];
    for (const id of ids) {
      try { await ensureVideo(id); }
      catch (err) { errors.push(id + ": " + (err && err.message ? err.message : String(err))); }
    }
    for (const [id, video] of [...videos]) {
      if (ids.includes(id)) continue;
      const stream = video.srcObject;
      if (stream) stream.getTracks().forEach(track => track.stop());
      video.remove();
      videos.delete(id);
    }
    return { ok: errors.length === 0, videos: videos.size, errors: errors };
  });
  return applyChain;
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

    const stageDisplay = findDisplayForScreenId(options?.stageScreenId ?? null);
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

    if (!outputWindow || outputWindow.isDestroyed()) {
        const win = new BrowserWindow({
            width: w,
            height: h,
            title: OUTPUT_TITLE,
            show: false,
            frame: !stageDisplay,
            fullscreen: !!stageDisplay,
            resizable: false,
            minimizable: !stageDisplay,
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
        });
        win.on("minimize", () => {
            setImmediate(() => {
                if (!win || win.isDestroyed() || outputWindow !== win) return;
                // Stage must stay painted fullscreen for screen capture.
                if (stageDisplayId != null) {
                    if (win.isMinimized()) win.restore();
                    win.setFullScreen(true);
                    return;
                }
                parkOutputWindow(win);
            });
        });
        win.on("focus", () => {
            if (outputWindow !== win || win.isDestroyed()) return;
            win.setIgnoreMouseEvents(false);
            if (stageDisplayId == null) win.moveTop();
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
        outputWindow.setFullScreen(false);
        outputWindow.setBounds({
            x: stageDisplay.bounds.x,
            y: stageDisplay.bounds.y,
            width: stageDisplay.bounds.width,
            height: stageDisplay.bounds.height
        });
        outputWindow.setFullScreen(true);
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
        items.push({
            sourceId,
            x: clampInt(Number(row.x), -4096, 8192),
            y: clampInt(Number(row.y), -4096, 8192),
            width: clampInt(Number(row.width), 1, 8192),
            height: clampInt(Number(row.height), 1, 8192),
            z: clampInt(Number(row.z), -100, 100),
            scaleMode: ["fit", "fill", "stretch"].includes(String(row.scaleMode)) ? String(row.scaleMode) : "fit",
            rotation: clampInt(Number(row.rotation), -360, 360),
            crop: {
                top: clampInt(Number((row.crop as any)?.top), 0, 4096),
                right: clampInt(Number((row.crop as any)?.right), 0, 4096),
                bottom: clampInt(Number((row.crop as any)?.bottom), 0, 4096),
                left: clampInt(Number((row.crop as any)?.left), 0, 4096)
            }
        });
    }
    return {
        width: clampInt(Number(raw.width), 320, 2560),
        height: clampInt(Number(raw.height), 180, 1440),
        fps: clampInt(Number(raw.fps), 1, 60),
        background: typeof raw.background === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.background)
            ? raw.background
            : "#000000",
        items
    };
}

export async function configureOutput(_event: IpcMainInvokeEvent, config: unknown) {
    if (!outputWindow || outputWindow.isDestroyed()) return { ok: false, videos: 0, errors: ["Output window is not open"] };
    const safe = sanitizeOutputConfig(config);
    if (!safe) return { ok: false, videos: 0, errors: ["Invalid output config"] };
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
    return true;
}

/** Minimized windows capture as a blank frame. Park it behind other windows instead, still fully painted. */
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
