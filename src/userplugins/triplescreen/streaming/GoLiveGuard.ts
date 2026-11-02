/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 TripleScreen contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { findStoreLazy, waitFor } from "@webpack";
import { FluxDispatcher } from "@webpack/common";

import { readOutputSettings } from "../settings";

const logger = new Logger("TripleScreen:GoLive");
const MediaEngineStore = findStoreLazy("MediaEngineStore");

/**
 * TripleScreen streams the Output *window* (the mosaic).
 *
 * System audio path (Windows):
 * 1. Output page mirrors WASAPI loopback with Chromium/Discord excluded
 *    (loopbackWithoutChrome) and plays it into Discord.exe.
 * 2. Go-live that window with soundshareId = Discord PID so process loopback
 *    picks up the mirrored mix (NOT soundshareId 1 — that only works on screen:
 *    shares — and NOT -1 which disables stream audio entirely → silence).
 * 3. Self-deafen while mirroring so Discord call playback is not rendered into
 *    the same process (friends would hear themselves).
 *
 * CDP: flat {id,soundshareId} throws without quality; use quality+desktopDescription.
 */
const SYSTEM_AUDIO_ID = 1;

let bypassDepth = 0;
let patched = false;
let originalSetGoLiveSource: ((...args: any[]) => unknown) | null = null;
let patchedModule: { setGoLiveSource: (...args: any[]) => unknown; } | null = null;
let activeOutputId: string | null = null;
let ownsStream = false;
let streamEventsBound = false;
let lastQuality = { resolution: 1080, frameRate: 30 };
let mirrorAudioActive = false;
let weDeafened = false;
let wasDeafBefore = false;
const audioTimers = new Set<number>();

export function isNativeShareActive() {
    return ownsStream && !!activeOutputId;
}

export function getActiveGoLiveId() {
    return ownsStream ? activeOutputId : null;
}

function withBypass<T>(fn: () => T): T {
    bypassDepth += 1;
    try {
        return fn();
    } finally {
        bypassDepth -= 1;
    }
}

function clearAudioTimers() {
    for (const id of audioTimers) window.clearTimeout(id);
    audioTimers.clear();
}

function scheduleAudio(fn: () => void, ms: number) {
    const id = window.setTimeout(() => {
        audioTimers.delete(id);
        fn();
    }, ms);
    audioTimers.add(id);
    return id;
}

function sourceIdOf(source: unknown): string {
    if (typeof source === "string") return source;
    if (!source || typeof source !== "object") return "";
    const obj = source as {
        id?: unknown;
        desktopSource?: { id?: unknown; };
        desktopDescription?: { id?: unknown; };
    };
    if (obj.desktopDescription?.id != null) return String(obj.desktopDescription.id);
    if (obj.id != null) return String(obj.id);
    if (obj.desktopSource?.id != null) return String(obj.desktopSource.id);
    return "";
}

function isScreenSourceId(id: string) {
    const lower = id.toLowerCase();
    return lower.startsWith("screen:") || lower.startsWith("screen-handle:");
}

function isWindowSourceId(id: string) {
    return id.toLowerCase().startsWith("window:");
}

function isWindows() {
    return (DiscordNative as any)?.process?.platform === "win32"
        || navigator.userAgent.includes("Windows");
}

function wantSystemAudio() {
    return readOutputSettings().includeSystemAudio !== false && isWindows();
}

function discordPid(): number | null {
    try {
        const pid = Number((DiscordNative as any)?.process?.pid);
        return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
        return null;
    }
}

/**
 * Normalize Electron getMediaSourceId() ("window:hwnd:2") to Discord's "window:hwnd".
 */
export function normalizeWindowSourceId(id: string) {
    const m = /^window:(\d+)(?::\d+)?$/i.exec(id.trim());
    if (m) return `window:${m[1]}`;
    return id;
}

function desktopDescriptionFor(id: string, withSystemAudio: boolean) {
    const screen = isScreenSourceId(id);
    const win = isWindowSourceId(id);
    let soundshareId = -1;
    if (withSystemAudio && screen) {
        soundshareId = SYSTEM_AUDIO_ID;
    } else if (withSystemAudio && win) {
        // Capture Discord.exe process audio (= Output mirror of system mix after we inject it).
        soundshareId = discordPid() ?? -1;
    }
    return {
        id,
        soundshareId,
        useLoopback: true,
        useVideoHook: false,
        useGraphicsCapture: true,
        useQuartzCapturer: false,
        allowScreenCaptureKit: false,
        hdrCaptureMode: 0
    };
}

function goLiveOptions(
    sourceId: string,
    withSystemAudio: boolean,
    quality?: { resolution: number; frameRate: number; }
) {
    const q = quality ?? lastQuality;
    return {
        quality: {
            resolution: q.resolution,
            frameRate: q.frameRate
        },
        desktopDescription: desktopDescriptionFor(sourceId, withSystemAudio)
    };
}

function qualityFrom(source: unknown): { resolution: number; frameRate: number; } | null {
    if (!source || typeof source !== "object") return null;
    const q = (source as { quality?: { resolution?: unknown; frameRate?: unknown; }; }).quality;
    if (!q) return null;
    const resolution = Number(q.resolution);
    const frameRate = Number(q.frameRate);
    if (!Number.isFinite(resolution) || !Number.isFinite(frameRate)) return null;
    return { resolution, frameRate };
}

function retargetToActive(source: unknown, activeId: string): unknown {
    const q = qualityFrom(source) ?? lastQuality;
    return goLiveOptions(activeId, mirrorAudioActive || (wantSystemAudio() && isScreenSourceId(activeId)), q);
}

function streamConn(engine: any) {
    return [...(engine?.connections ?? [])].find(
        (c: any) => c.context === "stream" || c.streamUserId
    ) ?? null;
}

function applyGoLive(engine: any, sourceId: string, withSystemAudio: boolean) {
    const options = goLiveOptions(sourceId, withSystemAudio, lastQuality);
    let applied = false;

    for (const conn of [...(engine?.connections ?? [])]) {
        if (conn.context !== "stream" && !conn.streamUserId) continue;
        if (typeof conn.setGoLiveSource !== "function") continue;
        try {
            conn.setGoLiveSource(options);
            applied = true;
        } catch (err) {
            logger.warn("Connection setGoLiveSource failed", err);
        }
        if (withSystemAudio && typeof conn.setSoundshareSource === "function") {
            const sid = options.desktopDescription.soundshareId;
            if (sid != null && sid !== -1) {
                try {
                    conn.setSoundshareSource(sid, true);
                } catch { /* optional */ }
            }
        }
    }

    if (typeof engine?.setGoLiveSource === "function") {
        try {
            engine.setGoLiveSource(options, "stream");
            applied = true;
        } catch (err) {
            logger.warn("MediaEngine setGoLiveSource failed", err);
        }
    }

    if (withSystemAudio && typeof engine?.setSoundshareSource === "function") {
        const sid = options.desktopDescription.soundshareId;
        if (sid != null && sid !== -1) {
            try {
                engine.setSoundshareSource(sid, true, "stream");
            } catch {
                try {
                    engine.setSoundshareSource(sid, true);
                } catch { /* optional */ }
            }
        }
    }

    const conn = streamConn(engine);
    logger.info("applyGoLive", {
        sourceId,
        withSystemAudio,
        soundshareId: options.desktopDescription.soundshareId,
        applied,
        live: conn?.goLiveSourceIdentifier,
        liveSoundshare: conn?.soundshareId,
        liveActive: conn?.soundshareActive
    });
    return applied;
}

function ensureSelfDeafForMirror() {
    try {
        const store = MediaEngineStore as any;
        const deaf = !!(store?.isSelfDeaf?.() ?? store?.getSelfDeaf?.());
        wasDeafBefore = deaf;
        if (!deaf) {
            // Prefer MediaEngineConnection API when available.
            const eng = store?.getMediaEngine?.();
            const def = [...(eng?.connections ?? [])].find((c: any) => c.context === "default");
            if (def && typeof def.setSelfDeaf === "function") {
                def.setSelfDeaf(true);
            } else {
                FluxDispatcher.dispatch({ type: "AUDIO_TOGGLE_SELF_DEAF" });
            }
            weDeafened = true;
            logger.info("Self-deafened so Discord call audio is not in Output process loopback");
        } else {
            weDeafened = false;
        }
    } catch (err) {
        logger.warn("Could not self-deafen for system-audio mirror", err);
    }
}

function restoreSelfDeaf() {
    if (!weDeafened) return;
    weDeafened = false;
    try {
        const store = MediaEngineStore as any;
        const deaf = !!(store?.isSelfDeaf?.() ?? store?.getSelfDeaf?.());
        if (deaf && !wasDeafBefore) {
            const eng = store?.getMediaEngine?.();
            const def = [...(eng?.connections ?? [])].find((c: any) => c.context === "default");
            if (def && typeof def.setSelfDeaf === "function") {
                def.setSelfDeaf(false);
            } else {
                FluxDispatcher.dispatch({ type: "AUDIO_TOGGLE_SELF_DEAF" });
            }
            logger.info("Restored undeafen after TripleScreen stream");
        }
    } catch (err) {
        logger.warn("Could not restore undeafen", err);
    }
}

function scheduleKeepalive() {
    for (const ms of [300, 800, 2000, 5000]) {
        scheduleAudio(() => {
            if (!ownsStream || !activeOutputId || !mirrorAudioActive) return;
            const engine = MediaEngineStore?.getMediaEngine?.();
            if (!engine) return;
            withBypass(() => applyGoLive(engine, activeOutputId!, true));
        }, ms);
    }
}

/**
 * Point Discord at the Output window (or stage screen).
 * withSystemAudio on a window: uses Discord PID soundshare — pair with Output audio mirror.
 */
export function beginNativeShare(
    videoSourceId: string,
    quality?: { resolution: number; frameRate: number; },
    options?: { includeSystemAudio?: boolean; }
) {
    const engine = MediaEngineStore?.getMediaEngine?.();
    if (!engine?.setGoLiveSource || !videoSourceId) {
        logger.warn("Media engine is not ready to go live");
        return false;
    }

    let sourceId = videoSourceId;
    if (isWindowSourceId(sourceId)) sourceId = normalizeWindowSourceId(sourceId);

    const wantAudio = (options?.includeSystemAudio ?? readOutputSettings().includeSystemAudio) && isWindows();
    lastQuality = {
        resolution: quality?.resolution ?? 1080,
        frameRate: quality?.frameRate ?? 30
    };

    activeOutputId = sourceId;
    ownsStream = true;
    mirrorAudioActive = wantAudio && isWindowSourceId(sourceId);
    clearAudioTimers();

    if (mirrorAudioActive) ensureSelfDeafForMirror();

    const applied = withBypass(() => applyGoLive(engine, sourceId, wantAudio));
    if (wantAudio) scheduleKeepalive();

    logger.info(
        "Requested Discord go live",
        sourceId,
        lastQuality,
        wantAudio
            ? (isWindowSourceId(sourceId)
                ? `window + Discord PID soundshare (Output mirrors system audio); pid=${discordPid()}`
                : "screen + soundshareId 1")
            : "video only",
        applied ? "applied" : "NOT applied"
    );
    return applied;
}

export function endNativeShare() {
    clearAudioTimers();
    restoreSelfDeaf();
    mirrorAudioActive = false;
    if (!ownsStream && !activeOutputId) return;

    const engine = MediaEngineStore?.getMediaEngine?.();
    const wasOurs = ownsStream;
    activeOutputId = null;
    ownsStream = false;
    if (!engine?.setGoLiveSource || !wasOurs) return;

    withBypass(() => {
        try {
            if (typeof engine.setSoundshareSource === "function") {
                engine.setSoundshareSource(SYSTEM_AUDIO_ID, false, "stream");
            }
            engine.setGoLiveSource(null, "stream");
            logger.info("Cleared the TripleScreen Discord stream source");
        } catch (err) {
            logger.warn("Could not clear the Discord stream source", err);
        }
    });
}

export function installGoLiveGuard() {
    waitFor("setGoLiveSource", mod => {
        if (patched || typeof mod?.setGoLiveSource !== "function") return;
        originalSetGoLiveSource = mod.setGoLiveSource;
        patchedModule = mod;
        mod.setGoLiveSource = function (this: unknown, ...args: any[]) {
            const [source, context] = args;
            if (bypassDepth > 0) {
                return originalSetGoLiveSource!.apply(this, args);
            }

            if (source == null) {
                if (ownsStream) {
                    ownsStream = false;
                    activeOutputId = null;
                    mirrorAudioActive = false;
                    clearAudioTimers();
                    restoreSelfDeaf();
                }
                return originalSetGoLiveSource!.apply(this, args);
            }

            if (activeOutputId && ownsStream) {
                const nextId = sourceIdOf(source);
                const normalizedNext = isWindowSourceId(nextId) ? normalizeWindowSourceId(nextId) : nextId;
                if (normalizedNext && normalizedNext !== activeOutputId && isWindowSourceId(normalizedNext) && isWindowSourceId(activeOutputId)) {
                    // Discord may re-emit window:hwnd:2 vs window:hwnd — keep ours.
                }
                if (nextId && normalizedNext !== activeOutputId && !isScreenSourceId(nextId) && normalizedNext !== normalizeWindowSourceId(activeOutputId)) {
                    // Different window — user switched share target.
                    if (normalizedNext && isWindowSourceId(activeOutputId) && normalizedNext !== normalizeWindowSourceId(activeOutputId)) {
                        ownsStream = false;
                        activeOutputId = null;
                        mirrorAudioActive = false;
                        clearAudioTimers();
                        restoreSelfDeaf();
                        return originalSetGoLiveSource!.apply(this, args);
                    }
                }
                const retargeted = retargetToActive(source, activeOutputId);
                return withBypass(() =>
                    originalSetGoLiveSource!.call(this, retargeted, context ?? "stream")
                );
            }

            return originalSetGoLiveSource!.apply(this, args);
        };
        patched = true;
        logger.info("Go Live guard ready (Output window + system-audio mirror)");
    });

    if (!streamEventsBound) {
        FluxDispatcher.subscribe("STREAM_DELETE", onStreamGone as any);
        FluxDispatcher.subscribe("STREAM_CLOSE", onStreamGone as any);
        streamEventsBound = true;
    }
}

function onStreamGone() {
    if (!ownsStream && !activeOutputId) return;
    logger.info("Ignoring stream-end event while TripleScreen owns go-live");
}

export function uninstallGoLiveGuard() {
    clearAudioTimers();
    restoreSelfDeaf();
    if (patchedModule && originalSetGoLiveSource) {
        patchedModule.setGoLiveSource = originalSetGoLiveSource;
    }
    patchedModule = null;
    originalSetGoLiveSource = null;
    patched = false;
    activeOutputId = null;
    ownsStream = false;
    mirrorAudioActive = false;
    if (streamEventsBound) {
        try {
            FluxDispatcher.unsubscribe("STREAM_DELETE", onStreamGone as any);
            FluxDispatcher.unsubscribe("STREAM_CLOSE", onStreamGone as any);
        } catch { /* ignore */ }
        streamEventsBound = false;
    }
}
