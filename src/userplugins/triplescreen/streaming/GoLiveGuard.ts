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
 * TripleScreen always go-lives the Output *window* (works while parked/minimized).
 *
 * Live CDP (Discord 1.0.9266, this machine):
 * - Default window share → soundshareId = some process PID → Discord-only audio.
 * - conn.setSoundshareSource(1, true) on that same window → soundshareId stays 1.
 * - conn.setGoLiveSource({ quality, desktopDescription: { id: window:…, soundshareId: 1 } })
 *   also sticks with soundshareActive true.
 *
 * soundshareId 1 is Discord’s system-mix sentinel (same as Entire Screen + Share system audio).
 * We must re-pin it — Discord often rewrites window shares back to a PID.
 */
const SYSTEM_AUDIO_ID = 1;

let bypassDepth = 0;
let patched = false;
let originalSetGoLiveSource: ((...args: any[]) => unknown) | null = null;
let patchedModule: { setGoLiveSource: (...args: any[]) => unknown; } | null = null;
let activeOutputId: string | null = null;
let ownsStream = false;
let wantAudio = false;
let streamEventsBound = false;
let lastQuality = { resolution: 1080, frameRate: 30 };
const audioTimers = new Set<number>();
let audioInterval = 0;
let releaseTimer = 0;
let onReleased: (() => void) | null = null;

export function isNativeShareActive() {
    return ownsStream && !!activeOutputId;
}

export function getActiveGoLiveId() {
    return ownsStream ? activeOutputId : null;
}

/**
 * Optional notify when the user clearly leaves our share target.
 * Must NOT be used for Discord's false STREAM_DELETE / missing-conn blips —
 * those were tearing the composite down after a few seconds.
 */
export function setNativeShareReleaseHandler(handler: (() => void) | null) {
    onReleased = handler;
}

function clearReleaseTimer() {
    if (releaseTimer) {
        window.clearTimeout(releaseTimer);
        releaseTimer = 0;
    }
}

function dropOwnership(reason: string, notifyAdapter: boolean) {
    clearReleaseTimer();
    if (!ownsStream && !activeOutputId) return;
    logger.info("Dropping TripleScreen go-live ownership", reason, { notifyAdapter });
    ownsStream = false;
    activeOutputId = null;
    wantAudio = false;
    clearAudioTimers();
    if (!notifyAdapter) return;
    try {
        onReleased?.();
    } catch (err) {
        logger.warn("Release handler failed", err);
    }
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
    if (audioInterval) {
        window.clearInterval(audioInterval);
        audioInterval = 0;
    }
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

/** Normalize Electron getMediaSourceId() ("window:hwnd:2") to Discord's "window:hwnd". */
export function normalizeWindowSourceId(id: string) {
    const m = /^window:(\d+)(?::\d+)?$/i.exec(id.trim());
    if (m) return `window:${m[1]}`;
    return id;
}

function desktopDescriptionFor(id: string, withSystemAudio: boolean) {
    return {
        id,
        // 1 = system mix (CDP-proven on window sources). PID = Discord-only. -1 = silence.
        soundshareId: withSystemAudio ? SYSTEM_AUDIO_ID : -1,
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
    return goLiveOptions(activeId, wantAudio, q);
}

function streamConn(engine: any) {
    return [...(engine?.connections ?? [])].find(
        (c: any) => c.context === "stream" || c.streamUserId
    ) ?? null;
}

function readStreamAudioState(engine: any) {
    const c = streamConn(engine);
    if (!c) return null;
    return {
        goLive: String(c.goLiveSourceIdentifier ?? ""),
        soundshareId: c.soundshareId,
        soundshareActive: !!c.soundshareActive
    };
}

function pinSystemSoundshare(engine: any) {
    const conn = streamConn(engine);
    if (conn && typeof conn.setSoundshareSource === "function") {
        try {
            conn.setSoundshareSource(SYSTEM_AUDIO_ID, true);
        } catch { /* optional */ }
    }
    if (typeof engine?.setSoundshareSource === "function") {
        try {
            engine.setSoundshareSource(SYSTEM_AUDIO_ID, true, "stream");
        } catch {
            try {
                engine.setSoundshareSource(SYSTEM_AUDIO_ID, true);
            } catch { /* optional */ }
        }
    }
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
    }

    if (typeof engine?.setGoLiveSource === "function") {
        try {
            engine.setGoLiveSource(options, "stream");
            applied = true;
        } catch (err) {
            logger.warn("MediaEngine setGoLiveSource failed", err);
        }
    }

    if (withSystemAudio) pinSystemSoundshare(engine);

    const state = readStreamAudioState(engine);
    logger.info("applyGoLive", {
        sourceId,
        withSystemAudio,
        soundshareId: options.desktopDescription.soundshareId,
        applied,
        state
    });
    return applied;
}

function reinforceSystemAudio(engine: any) {
    if (!ownsStream || !activeOutputId || !engine) return;
    const state = readStreamAudioState(engine);
    if (!state) {
        // No stream connection yet / briefly gone — repair later, never tear down Output.
        return;
    }
    const onOurWindow = state.goLive
        && normalizeWindowSourceId(state.goLive) === normalizeWindowSourceId(activeOutputId);
    if (!wantAudio) {
        if (!onOurWindow && state.goLive) {
            withBypass(() => applyGoLive(engine, activeOutputId!, false));
        }
        return;
    }
    const audioOk = state.soundshareId === SYSTEM_AUDIO_ID && state.soundshareActive;
    if (onOurWindow && audioOk) return;

    logger.info("Repairing Output window system audio", state);
    withBypass(() => {
        applyGoLive(engine, activeOutputId!, true);
        pinSystemSoundshare(engine);
    });
}

function scheduleSystemAudioKeepalive() {
    // Sparse early pins + steady interval. Do not tear down on missing conn.
    for (const ms of [300, 1000, 2500, 5000]) {
        scheduleAudio(() => {
            if (!ownsStream || !wantAudio) return;
            reinforceSystemAudio(MediaEngineStore?.getMediaEngine?.());
        }, ms);
    }
    if (audioInterval) window.clearInterval(audioInterval);
    audioInterval = window.setInterval(() => {
        if (!ownsStream) return;
        reinforceSystemAudio(MediaEngineStore?.getMediaEngine?.());
    }, 3000);
}

/**
 * Point Discord at the Output window.
 * withSystemAudio → soundshareId 1 (system mix), re-pinned while live.
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

    wantAudio = !!(options?.includeSystemAudio ?? readOutputSettings().includeSystemAudio) && isWindows();
    lastQuality = {
        resolution: quality?.resolution ?? 1080,
        frameRate: quality?.frameRate ?? 30
    };

    clearReleaseTimer();
    activeOutputId = sourceId;
    ownsStream = true;
    clearAudioTimers();

    const applied = withBypass(() => applyGoLive(engine, sourceId, wantAudio));
    if (wantAudio) scheduleSystemAudioKeepalive();
    else {
        // Still lightly re-pin video target if Discord steals the source.
        for (const ms of [500, 2000]) {
            scheduleAudio(() => {
                if (!ownsStream || !activeOutputId) return;
                reinforceSystemAudio(MediaEngineStore?.getMediaEngine?.());
            }, ms);
        }
    }

    logger.info(
        "Requested Discord go live",
        sourceId,
        lastQuality,
        wantAudio ? "system audio via soundshareId:1 on Output window" : "video only",
        applied ? "applied" : "NOT applied"
    );
    return applied;
}

export function endNativeShare() {
    clearReleaseTimer();
    clearAudioTimers();
    wantAudio = false;
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
                // Discord clears briefly during renegotiation — re-pin ours, never kill Output.
                if (ownsStream && activeOutputId && !releaseTimer) {
                    releaseTimer = window.setTimeout(() => {
                        releaseTimer = 0;
                        if (!ownsStream || !activeOutputId) return;
                        const eng = MediaEngineStore?.getMediaEngine?.();
                        if (!eng) return;
                        logger.info("Re-pinning Output after transient setGoLiveSource(null)");
                        withBypass(() => applyGoLive(eng, activeOutputId!, wantAudio));
                    }, 800);
                }
                return originalSetGoLiveSource!.apply(this, args);
            }

            if (activeOutputId && ownsStream) {
                clearReleaseTimer();
                const nextId = sourceIdOf(source);
                const normalizedNext = isWindowSourceId(nextId) ? normalizeWindowSourceId(nextId) : nextId;
                const normalizedActive = isWindowSourceId(activeOutputId)
                    ? normalizeWindowSourceId(activeOutputId)
                    : activeOutputId;

                // Different non-Output window — user switched share target in Discord UI.
                if (
                    normalizedNext
                    && isWindowSourceId(normalizedNext)
                    && isWindowSourceId(normalizedActive)
                    && normalizedNext !== normalizedActive
                ) {
                    dropOwnership("user switched share target", true);
                    return originalSetGoLiveSource!.apply(this, args);
                }

                // Hold Output window + system-audio soundshare (block screen steals / PID rewrites).
                if (isScreenSourceId(nextId) || normalizedNext !== normalizedActive || wantAudio) {
                    if (nextId && nextId !== activeOutputId && !isWindowSourceId(nextId)) {
                        logger.info("Keeping Output window go-live; blocked switch to", nextId);
                    }
                    const retargeted = retargetToActive(source, activeOutputId);
                    const result = withBypass(() =>
                        originalSetGoLiveSource!.call(this, retargeted, context ?? "stream")
                    );
                    if (wantAudio) {
                        const eng = MediaEngineStore?.getMediaEngine?.();
                        if (eng) withBypass(() => pinSystemSoundshare(eng));
                    }
                    return result;
                }
            }

            return originalSetGoLiveSource!.apply(this, args);
        };
        patched = true;
        logger.info("Go Live guard ready (Output window + soundshareId 1 system audio)");
    });

    if (!streamEventsBound) {
        FluxDispatcher.subscribe("STREAM_DELETE", onStreamGone as any);
        FluxDispatcher.subscribe("STREAM_CLOSE", onStreamGone as any);
        streamEventsBound = true;
    }
}

function onStreamGone() {
    // Discord fires STREAM_DELETE during renegotiation / quality changes.
    // Tearing down Output here caused "crashes after a few seconds". Only the
    // Output window close (or explicit Stop) should end the composite.
    if (!ownsStream && !activeOutputId) return;
    logger.info("Ignoring stream-end event while TripleScreen owns go-live");
}

export function uninstallGoLiveGuard() {
    clearReleaseTimer();
    clearAudioTimers();
    wantAudio = false;
    onReleased = null;
    if (patchedModule && originalSetGoLiveSource) {
        patchedModule.setGoLiveSource = originalSetGoLiveSource;
    }
    patchedModule = null;
    originalSetGoLiveSource = null;
    patched = false;
    activeOutputId = null;
    ownsStream = false;
    if (streamEventsBound) {
        try {
            FluxDispatcher.unsubscribe("STREAM_DELETE", onStreamGone as any);
            FluxDispatcher.unsubscribe("STREAM_CLOSE", onStreamGone as any);
        } catch { /* ignore */ }
        streamEventsBound = false;
    }
}
