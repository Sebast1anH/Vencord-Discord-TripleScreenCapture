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
 * Discord Windows soundshareId:
 *   1   = full default-output mix, with Discord's own process tree excluded
 *         (same path as Entire Screen + "Share system audio" — viewers should
 *         not hear Discord voice / themselves echoed)
 *   PID = that process tree only
 *
 * Never pin audio to Discord.exe's PID (the TripleScreen output window lives
 * inside it) — that captures call playback and makes friends hear themselves.
 *
 * Also never put soundshareId:1 on a window: go-live object; native capture can
 * reject that combo. Video uses the window id; audio is pinned with
 * setSoundshareSource(1, true) afterward.
 */
const SYSTEM_AUDIO_ID = 1;

let bypassDepth = 0;
let patched = false;
let originalSetGoLiveSource: ((...args: any[]) => unknown) | null = null;
let patchedModule: { setGoLiveSource: (...args: any[]) => unknown; } | null = null;
let activeOutputId: string | null = null;
let ownsStream = false;
const audioTimers = new Set<number>();

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
}

function sourceIdOf(source: unknown): string {
    if (typeof source === "string") return source;
    if (!source || typeof source !== "object") return "";
    const obj = source as {
        id?: unknown;
        desktopSource?: { id?: unknown; };
        desktopDescription?: { id?: unknown; };
    };
    if (obj.id != null) return String(obj.id);
    if (obj.desktopSource?.id != null) return String(obj.desktopSource.id);
    if (obj.desktopDescription?.id != null) return String(obj.desktopDescription.id);
    return "";
}

function soundshareIdOf(source: unknown): number | null {
    if (!source || typeof source !== "object") return null;
    const obj = source as {
        soundshareId?: unknown;
        desktopSource?: { soundshareId?: unknown; };
        desktopDescription?: { soundshareId?: unknown; };
    };
    const raw = obj.soundshareId ?? obj.desktopDescription?.soundshareId ?? obj.desktopSource?.soundshareId;
    if (raw == null || raw === "" || raw === -1 || raw === "-1") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

function isScreenSource(source: unknown) {
    const id = sourceIdOf(source).toLowerCase();
    return id.startsWith("screen");
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

/** Video-only go-live payload. Audio is attached via setSoundshareSource(1). */
function videoSource(windowId: string) {
    return {
        id: windowId,
        soundshareId: null,
        useLoopback: true
    };
}

function desktopDescriptionVideo(id: string) {
    return {
        id,
        soundshareId: -1,
        useLoopback: true,
        useVideoHook: false,
        useGraphicsCapture: true,
        useQuartzCapturer: false,
        allowScreenCaptureKit: false,
        hdrCaptureMode: 0
    };
}

function retargetVideoOnly(source: unknown, windowId: string): unknown {
    if (typeof source === "string" || !source || typeof source !== "object") {
        return videoSource(windowId);
    }
    const copy = { ...(source as Record<string, unknown>) };
    copy.id = windowId;
    // Strip Discord-PID audio if Discord tried to attach it to our window share.
    const audioId = soundshareIdOf(source);
    const selfPid = discordPid();
    if (audioId != null && selfPid != null && audioId === selfPid) {
        copy.soundshareId = null;
    }
    if (copy.desktopSource && typeof copy.desktopSource === "object") {
        const ds = { ...(copy.desktopSource as Record<string, unknown>), id: windowId };
        if (selfPid != null && Number(ds.soundshareId) === selfPid) ds.soundshareId = null;
        copy.desktopSource = ds;
    }
    if (copy.desktopDescription && typeof copy.desktopDescription === "object") {
        const dd = { ...(copy.desktopDescription as Record<string, unknown>), id: windowId };
        if (selfPid != null && Number(dd.soundshareId) === selfPid) dd.soundshareId = -1;
        copy.desktopDescription = dd;
    }
    return copy;
}

/**
 * Pin stream audio to the full Windows mix (Discord voice excluded by Discord's
 * system-soundshare path). Never pass Discord's own PID.
 */
function enableSystemAudio(engine: any) {
    if (!wantSystemAudio() || !engine) return;

    const selfPid = discordPid();

    try {
        if (typeof engine.setSoundshareSource === "function") {
            engine.setSoundshareSource(SYSTEM_AUDIO_ID, true, "stream");
        }
    } catch (err) {
        logger.warn("MediaEngine setSoundshareSource(1) failed", err);
    }

    for (const conn of [...(engine.connections ?? [])]) {
        if (conn.context !== "stream" && !conn.streamUserId) continue;
        if (typeof conn.setSoundshareSource !== "function") continue;
        try {
            conn.setSoundshareSource(SYSTEM_AUDIO_ID, true);
        } catch (err) {
            logger.warn("Connection setSoundshareSource(1) failed", err);
        }
    }

    // If Discord somehow re-bound to our PID, force system again once more.
    if (selfPid != null) {
        try {
            const active = Number(
                (engine as any).getSoundshareSource?.()
                ?? (engine as any).soundshareId
                ?? 0
            );
            if (active === selfPid && typeof engine.setSoundshareSource === "function") {
                logger.info("Replaced Discord PID soundshare with full system mix (excludes Discord)");
                engine.setSoundshareSource(SYSTEM_AUDIO_ID, true, "stream");
            }
        } catch { /* optional getter */ }
    }
}

function scheduleSystemAudioKeepalive() {
    // Only re-pin soundshare — do not re-call setGoLiveSource (that killed audio before).
    for (const ms of [200, 500, 1000, 2000, 4000, 8000]) {
        scheduleAudio(() => {
            if (!ownsStream || !activeOutputId || !wantSystemAudio()) return;
            enableSystemAudio(MediaEngineStore?.getMediaEngine?.());
        }, ms);
    }
}

/** Points Discord's encoder at the composite window, then pins system audio (no Discord voice). */
export function beginNativeShare(
    windowSourceId: string,
    quality?: { resolution: number; frameRate: number; },
    options?: { includeSystemAudio?: boolean; }
) {
    const engine = MediaEngineStore?.getMediaEngine?.();
    if (!engine?.setGoLiveSource || !windowSourceId) {
        logger.warn("Media engine is not ready to go live");
        return false;
    }

    const wantAudio = (options?.includeSystemAudio ?? readOutputSettings().includeSystemAudio) && isWindows();
    const chosen = {
        resolution: quality?.resolution ?? 1080,
        frameRate: quality?.frameRate ?? 30
    };

    activeOutputId = windowSourceId;
    ownsStream = true;
    clearAudioTimers();

    withBypass(() => {
        try {
            engine.setGoLiveSource(videoSource(windowSourceId), "stream");
        } catch (err) {
            logger.warn("Flat go-live source failed, trying desktopDescription", err);
            for (const conn of [...(engine.connections ?? [])]) {
                if (conn.context !== "stream" && !conn.streamUserId) continue;
                if (typeof conn.setGoLiveSource !== "function") continue;
                try {
                    conn.setGoLiveSource({
                        quality: chosen,
                        desktopDescription: desktopDescriptionVideo(windowSourceId)
                    });
                } catch (inner) {
                    logger.warn("Connection go-live failed", inner);
                }
            }
        }
    });

    if (wantAudio) {
        enableSystemAudio(engine);
        scheduleSystemAudioKeepalive();
    }

    logger.info(
        "Requested Discord go live for composite window",
        windowSourceId,
        chosen,
        wantAudio
            ? `system audio via setSoundshareSource(1), Discord PID ${discordPid() ?? "?"} excluded`
            : "video only"
    );
    return true;
}

/** Drops the composite source ownership. Does not force-end an unrelated Discord stream. */
export function endNativeShare() {
    clearAudioTimers();
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
                    clearAudioTimers();
                }
                return originalSetGoLiveSource!.apply(this, args);
            }

            if (activeOutputId && ownsStream && isScreenSource(source)) {
                logger.info("Kept TripleScreen as the go-live video instead of", sourceIdOf(source));
                const result = withBypass(() =>
                    originalSetGoLiveSource!.call(
                        this,
                        retargetVideoOnly(source, activeOutputId!),
                        context ?? "stream"
                    )
                );
                enableSystemAudio(MediaEngineStore?.getMediaEngine?.());
                return result;
            }

            if (ownsStream && source != null) {
                const nextId = sourceIdOf(source);
                if (nextId && activeOutputId && nextId !== activeOutputId && !isScreenSource(source)) {
                    ownsStream = false;
                    activeOutputId = null;
                    clearAudioTimers();
                } else if (nextId === activeOutputId) {
                    // Discord re-applied our window, often with Discord PID audio — strip that, then pin system mix.
                    const cleaned = retargetVideoOnly(source, activeOutputId);
                    const result = withBypass(() =>
                        originalSetGoLiveSource!.call(this, cleaned, context ?? "stream")
                    );
                    enableSystemAudio(MediaEngineStore?.getMediaEngine?.());
                    return result;
                }
            }

            return originalSetGoLiveSource!.apply(this, args);
        };
        patched = true;
        logger.info("Go Live guard ready (system audio, Discord excluded)");
    });

    FluxDispatcher.subscribe("STREAM_DELETE", onStreamGone as any);
    FluxDispatcher.subscribe("STREAM_CLOSE", onStreamGone as any);
}

function onStreamGone() {
    if (!ownsStream && !activeOutputId) return;
    ownsStream = false;
    activeOutputId = null;
    clearAudioTimers();
}

export function uninstallGoLiveGuard() {
    clearAudioTimers();
    if (patchedModule && originalSetGoLiveSource) {
        patchedModule.setGoLiveSource = originalSetGoLiveSource;
    }
    patchedModule = null;
    originalSetGoLiveSource = null;
    patched = false;
    activeOutputId = null;
    ownsStream = false;
    try {
        FluxDispatcher.unsubscribe("STREAM_DELETE", onStreamGone as any);
        FluxDispatcher.unsubscribe("STREAM_CLOSE", onStreamGone as any);
    } catch { /* ignore */ }
}
