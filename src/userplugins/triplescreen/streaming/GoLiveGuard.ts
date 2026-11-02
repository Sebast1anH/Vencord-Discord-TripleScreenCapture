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
 * Discord Windows soundshare:
 *   PID  = that process tree only (window shares default to the window owner —
 *          for TripleScreen Output that is Discord.exe → friends hear themselves)
 *   1    = classic "Entire Screen" system mix sentinel
 *   0    = Nightcord/enhanced-screenshare: disable single-PID filter so native
 *          full desktop loopback runs (works with window: video sources)
 *
 * TripleScreen always go-lives the Output *window* so every selected monitor
 * can be in the mosaic. System audio is pinned afterward with setSoundshareSource(0)
 * (fallback: 1) — never leave Discord's PID attached.
 */
const SYSTEM_AUDIO_ENTRIES = [0, 1] as const;

let bypassDepth = 0;
let patched = false;
let originalSetGoLiveSource: ((...args: any[]) => unknown) | null = null;
let patchedModule: { setGoLiveSource: (...args: any[]) => unknown; } | null = null;
let activeOutputId: string | null = null;
let ownsStream = false;
/** Ignore STREAM_DELETE/CLOSE briefly after we apply go-live (Discord churns these). */
let streamEventGuardUntil = 0;
let streamEventsBound = false;
let lastAudioPinAt = 0;
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
    return id.startsWith("screen:") || id.startsWith("screen-handle:");
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

/** Composite window video — never attach Discord PID as soundshare. */
function windowVideoSource(windowId: string) {
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

function stripDiscordPidAudio(source: unknown, activeId: string): unknown {
    if (typeof source === "string" || !source || typeof source !== "object") {
        return windowVideoSource(activeId);
    }
    const selfPid = discordPid();
    const copy = { ...(source as Record<string, unknown>) };
    copy.id = activeId;
    const audioId = soundshareIdOf(source);
    if (audioId != null && selfPid != null && audioId === selfPid) {
        copy.soundshareId = null;
    }
    if (copy.desktopSource && typeof copy.desktopSource === "object") {
        const ds = { ...(copy.desktopSource as Record<string, unknown>), id: activeId };
        if (selfPid != null && Number(ds.soundshareId) === selfPid) ds.soundshareId = null;
        copy.desktopSource = ds;
    }
    if (copy.desktopDescription && typeof copy.desktopDescription === "object") {
        const dd = { ...(copy.desktopDescription as Record<string, unknown>), id: activeId };
        if (selfPid != null && Number(dd.soundshareId) === selfPid) dd.soundshareId = -1;
        copy.desktopDescription = dd;
    }
    return copy;
}

function trySetSoundshare(target: any, id: number | null, active: boolean, label: string) {
    if (!target || typeof target.setSoundshareSource !== "function") return false;
    try {
        // MediaEngine often accepts (id, active) or (id, active, context)
        try {
            target.setSoundshareSource(id as any, active, "stream");
        } catch {
            target.setSoundshareSource(id as any, active);
        }
        return true;
    } catch (err) {
        logger.warn(`${label} setSoundshareSource(${String(id)}, ${active}) failed`, err);
        return false;
    }
}

/**
 * Enable full Windows mix for a window: go-live.
 * Prefer soundshare id 0 (clear PID filter); fall back to classic sentinel 1.
 * Never leave Discord.exe PID attached.
 */
function pinSystemAudio(engine: any, force = false) {
    if (!wantSystemAudio() || !engine || !activeOutputId) return;
    const now = performance.now();
    if (!force && now - lastAudioPinAt < 2500) return;
    lastAudioPinAt = now;

    const selfPid = discordPid();
    let pinned = false;

    for (const id of SYSTEM_AUDIO_ENTRIES) {
        if (trySetSoundshare(engine, id, true, "MediaEngine")) {
            pinned = true;
            logger.info(`Pinned system audio via MediaEngine setSoundshareSource(${id})`);
            break;
        }
    }

    for (const conn of [...(engine.connections ?? [])]) {
        if (conn.context !== "stream" && !conn.streamUserId) continue;
        for (const id of SYSTEM_AUDIO_ENTRIES) {
            if (trySetSoundshare(conn, id, true, "Connection")) {
                pinned = true;
                break;
            }
        }
    }

    // Last resort: clear the PID filter entirely (Nightcord "Entire System" path).
    if (!pinned) {
        trySetSoundshare(engine, null, false, "MediaEngine-clear");
        for (const conn of [...(engine.connections ?? [])]) {
            if (conn.context !== "stream" && !conn.streamUserId) continue;
            trySetSoundshare(conn, null, false, "Connection-clear");
        }
    }

    // If Discord re-bound to our PID, force system again.
    if (selfPid != null) {
        try {
            const active = Number(
                (engine as any).getSoundshareSource?.()
                ?? (engine as any).soundshareId
                ?? 0
            );
            if (active === selfPid) {
                logger.info("Replaced Discord PID soundshare with system mix");
                trySetSoundshare(engine, 0, true, "MediaEngine-repin");
                trySetSoundshare(engine, 1, true, "MediaEngine-repin1");
            }
        } catch { /* optional getter */ }
    }
}

function scheduleSystemAudioKeepalive() {
    // One delayed re-pin only — repeated soundshare churn was killing the stream.
    scheduleAudio(() => {
        if (!ownsStream || !activeOutputId || !wantSystemAudio()) return;
        pinSystemAudio(MediaEngineStore?.getMediaEngine?.());
    }, 600);
}

/**
 * Points Discord's encoder at the TripleScreen Output window (all monitors in mosaic).
 * System audio is attached via setSoundshareSource — no stage monitor required.
 */
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
    streamEventGuardUntil = performance.now() + 12_000;
    clearAudioTimers();

    const payload = windowVideoSource(windowSourceId);

    withBypass(() => {
        let applied = false;
        try {
            engine.setGoLiveSource(payload, "stream");
            applied = true;
        } catch (err) {
            logger.warn("Flat go-live source failed, trying desktopDescription", err);
        }
        if (!applied) {
            for (const conn of [...(engine.connections ?? [])]) {
                if (conn.context !== "stream" && !conn.streamUserId) continue;
                if (typeof conn.setGoLiveSource !== "function") continue;
                try {
                    conn.setGoLiveSource({
                        quality: chosen,
                        desktopDescription: desktopDescriptionVideo(windowSourceId)
                    });
                    applied = true;
                } catch (inner) {
                    logger.warn("Connection go-live failed", inner);
                }
            }
        }
        try {
            const maybe = engine as { setQuality?: (q: { resolution: number; frameRate: number; }, ctx?: string) => void; };
            maybe.setQuality?.(chosen, "stream");
        } catch { /* optional */ }
    });

    if (wantAudio) {
        pinSystemAudio(engine, true);
        scheduleSystemAudioKeepalive();
    }

    logger.info(
        "Requested Discord go live for composite window",
        windowSourceId,
        chosen,
        wantAudio
            ? `system audio via setSoundshareSource(0|1), Discord PID ${discordPid() ?? "?"} excluded`
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
            trySetSoundshare(engine, 0, false, "MediaEngine-off");
            trySetSoundshare(engine, 1, false, "MediaEngine-off1");
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
                // Keep our composite window instead of Discord's screen pick.
                logger.info("Kept TripleScreen window as go-live video instead of", sourceIdOf(source));
                const result = withBypass(() =>
                    originalSetGoLiveSource!.call(
                        this,
                        stripDiscordPidAudio(source, activeOutputId!),
                        context ?? "stream"
                    )
                );
                pinSystemAudio(MediaEngineStore?.getMediaEngine?.());
                return result;
            }

            if (ownsStream && source != null) {
                const nextId = sourceIdOf(source);
                if (nextId && activeOutputId && nextId !== activeOutputId && !isScreenSource(source)) {
                    ownsStream = false;
                    activeOutputId = null;
                    clearAudioTimers();
                } else if (nextId === activeOutputId) {
                    const cleaned = stripDiscordPidAudio(source, activeOutputId);
                    const result = withBypass(() =>
                        originalSetGoLiveSource!.call(this, cleaned, context ?? "stream")
                    );
                    if (wantSystemAudio()) {
                        pinSystemAudio(MediaEngineStore?.getMediaEngine?.());
                    }
                    return result;
                }
            }

            return originalSetGoLiveSource!.apply(this, args);
        };
        patched = true;
        logger.info("Go Live guard ready (window composite + system audio pin)");
    });

    if (!streamEventsBound) {
        FluxDispatcher.subscribe("STREAM_DELETE", onStreamGone as any);
        FluxDispatcher.subscribe("STREAM_CLOSE", onStreamGone as any);
        streamEventsBound = true;
    }
}

function onStreamGone() {
    // Discord emits STREAM_DELETE/CLOSE while renegotiating soundshare / quality.
    // Never drop ownership from these alone — endNativeShare / setGoLiveSource(null) own teardown.
    if (!ownsStream && !activeOutputId) return;
    logger.info("Ignoring stream-end event while TripleScreen owns go-live");
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
    if (streamEventsBound) {
        try {
            FluxDispatcher.unsubscribe("STREAM_DELETE", onStreamGone as any);
            FluxDispatcher.unsubscribe("STREAM_CLOSE", onStreamGone as any);
        } catch { /* ignore */ }
        streamEventsBound = false;
    }
}
