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
 *   1   = full default-output mix, Discord process tree excluded
 *         (Entire Screen + "Share system audio")
 *   PID = that process tree only (ActivateApplicationLoopbackFromPid)
 *
 * soundshareId:1 only works when the go-live *video* source is a screen /
 * screen-handle. On window: sources Discord still binds process loopback to
 * the window owner (Discord.exe for TripleScreen Output) — viewers hear
 * themselves and miss YouTube. So with system audio we go live on the stage
 * monitor (screen:…) with soundshareId:1 in the same payload.
 */
const SYSTEM_AUDIO_ID = 1;

let bypassDepth = 0;
let patched = false;
let originalSetGoLiveSource: ((...args: any[]) => unknown) | null = null;
let patchedModule: { setGoLiveSource: (...args: any[]) => unknown; } | null = null;
let activeOutputId: string | null = null;
let ownsStream = false;
/** Ignore STREAM_DELETE/CLOSE briefly after we apply go-live (Discord churns these). */
let streamEventGuardUntil = 0;
let streamEventsBound = false;
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

function isScreenSourceId(id: string) {
    const lower = id.toLowerCase();
    return lower.startsWith("screen:") || lower.startsWith("screen-handle:");
}

function isScreenSource(source: unknown) {
    return isScreenSourceId(sourceIdOf(source));
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

/** Window video only — never attach Discord PID as soundshare. */
function windowVideoSource(windowId: string) {
    return {
        id: windowId,
        soundshareId: null,
        useLoopback: true
    };
}

/** Screen + system mix (Discord excluded). Same shape as Entire Screen go-live. */
function screenSystemAudioSource(screenId: string) {
    return {
        id: screenId,
        soundshareId: SYSTEM_AUDIO_ID,
        useLoopback: true
    };
}

function desktopDescriptionFor(id: string, withSystemAudio: boolean) {
    return {
        id,
        soundshareId: withSystemAudio && isScreenSourceId(id) ? SYSTEM_AUDIO_ID : -1,
        useLoopback: true,
        useVideoHook: false,
        useGraphicsCapture: true,
        useQuartzCapturer: false,
        allowScreenCaptureKit: false,
        hdrCaptureMode: 0
    };
}

function retargetToActive(source: unknown, activeId: string): unknown {
    const screenAudio = wantSystemAudio() && isScreenSourceId(activeId);
    if (typeof source === "string" || !source || typeof source !== "object") {
        return screenAudio ? screenSystemAudioSource(activeId) : windowVideoSource(activeId);
    }
    const copy = { ...(source as Record<string, unknown>) };
    copy.id = activeId;
    if (screenAudio) {
        copy.soundshareId = SYSTEM_AUDIO_ID;
    } else {
        const audioId = soundshareIdOf(source);
        const selfPid = discordPid();
        if (audioId != null && selfPid != null && audioId === selfPid) {
            copy.soundshareId = null;
        } else if (audioId === SYSTEM_AUDIO_ID && !isScreenSourceId(activeId)) {
            // window + 1 is ignored/broken natively — leave null and let caller decide
            copy.soundshareId = null;
        }
    }
    if (copy.desktopSource && typeof copy.desktopSource === "object") {
        const ds = { ...(copy.desktopSource as Record<string, unknown>), id: activeId };
        if (screenAudio) ds.soundshareId = SYSTEM_AUDIO_ID;
        else if (discordPid() != null && Number(ds.soundshareId) === discordPid()) ds.soundshareId = null;
        copy.desktopSource = ds;
    }
    if (copy.desktopDescription && typeof copy.desktopDescription === "object") {
        const dd = { ...(copy.desktopDescription as Record<string, unknown>), id: activeId };
        if (screenAudio) dd.soundshareId = SYSTEM_AUDIO_ID;
        else if (discordPid() != null && Number(dd.soundshareId) === discordPid()) dd.soundshareId = -1;
        copy.desktopDescription = dd;
    }
    return copy;
}

/**
 * Pin soundshare only. Never re-call setGoLiveSource here — that tears down /
 * restarts capture and was crashing the composite after a few seconds.
 */
function pinSystemAudio(engine: any) {
    if (!wantSystemAudio() || !engine || !activeOutputId || !isScreenSourceId(activeOutputId)) return;

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
}

function scheduleSystemAudioKeepalive() {
    // Light touch only — soundshare pin, no setGoLiveSource.
    for (const ms of [400, 1500]) {
        scheduleAudio(() => {
            if (!ownsStream || !activeOutputId || !wantSystemAudio()) return;
            pinSystemAudio(MediaEngineStore?.getMediaEngine?.());
        }, ms);
    }
}

/**
 * Points Discord's encoder at the composite.
 * Prefer a screen: id with soundshareId:1 when system audio is on.
 * Fall back to window: video-only when no stage screen is available.
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

    const wantAudio = (options?.includeSystemAudio ?? readOutputSettings().includeSystemAudio) && isWindows();
    const useScreenAudio = wantAudio && isScreenSourceId(videoSourceId);
    const chosen = {
        resolution: quality?.resolution ?? 1080,
        frameRate: quality?.frameRate ?? 30
    };

    activeOutputId = videoSourceId;
    ownsStream = true;
    streamEventGuardUntil = performance.now() + 12_000;
    clearAudioTimers();

    const payload = useScreenAudio
        ? screenSystemAudioSource(videoSourceId)
        : windowVideoSource(videoSourceId);

    withBypass(() => {
        let applied = false;
        // Flat { id, soundshareId } is the shape Discord's renderer uses for Go Live.
        try {
            engine.setGoLiveSource(payload, "stream");
            applied = true;
        } catch (err) {
            logger.warn("Flat go-live source failed, trying desktopDescription + quality", err);
        }
        if (!applied) {
            for (const conn of [...(engine.connections ?? [])]) {
                if (conn.context !== "stream" && !conn.streamUserId) continue;
                if (typeof conn.setGoLiveSource !== "function") continue;
                try {
                    conn.setGoLiveSource({
                        quality: chosen,
                        desktopDescription: desktopDescriptionFor(videoSourceId, useScreenAudio)
                    });
                    applied = true;
                } catch (inner) {
                    logger.warn("Connection go-live failed", inner);
                }
            }
        }
        // Best-effort quality hint without a second video-source swap.
        try {
            const maybe = engine as { setQuality?: (q: { resolution: number; frameRate: number; }, ctx?: string) => void; };
            maybe.setQuality?.(chosen, "stream");
        } catch { /* optional */ }
    });

    if (useScreenAudio) {
        pinSystemAudio(engine);
        scheduleSystemAudioKeepalive();
    } else if (wantAudio) {
        logger.warn(
            "System audio needs a stage monitor (screen go-live). Window share would bind Discord PID loopback — streaming video only."
        );
    }

    logger.info(
        "Requested Discord go live",
        videoSourceId,
        chosen,
        useScreenAudio
            ? "system audio via screen + soundshareId:1 (Discord excluded)"
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

            if (activeOutputId && ownsStream && isScreenSource(source) && !isScreenSourceId(activeOutputId)) {
                // User/Discord picked a screen while we own a window composite — keep window video.
                logger.info("Kept TripleScreen window as go-live video instead of", sourceIdOf(source));
                const result = withBypass(() =>
                    originalSetGoLiveSource!.call(
                        this,
                        retargetToActive(source, activeOutputId!),
                        context ?? "stream"
                    )
                );
                return result;
            }

            if (activeOutputId && ownsStream && isScreenSource(source) && isScreenSourceId(activeOutputId)) {
                // Keep our stage screen + system audio instead of Discord's pick.
                const result = withBypass(() =>
                    originalSetGoLiveSource!.call(
                        this,
                        retargetToActive(source, activeOutputId!),
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
                    const cleaned = retargetToActive(source, activeOutputId);
                    const result = withBypass(() =>
                        originalSetGoLiveSource!.call(this, cleaned, context ?? "stream")
                    );
                    if (wantSystemAudio() && isScreenSourceId(activeOutputId)) {
                        pinSystemAudio(MediaEngineStore?.getMediaEngine?.());
                    }
                    return result;
                }
            }

            return originalSetGoLiveSource!.apply(this, args);
        };
        patched = true;
        logger.info("Go Live guard ready (screen-stage system audio)");
    });

    if (!streamEventsBound) {
        FluxDispatcher.subscribe("STREAM_DELETE", onStreamGone as any);
        FluxDispatcher.subscribe("STREAM_CLOSE", onStreamGone as any);
        streamEventsBound = true;
    }
}

function onStreamGone() {
    if (!ownsStream && !activeOutputId) return;
    // Discord emits STREAM_DELETE/CLOSE while renegotiating go-live; ignore during guard.
    if (performance.now() < streamEventGuardUntil) {
        logger.info("Ignoring stream-end event during go-live guard");
        return;
    }
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
    if (streamEventsBound) {
        try {
            FluxDispatcher.unsubscribe("STREAM_DELETE", onStreamGone as any);
            FluxDispatcher.unsubscribe("STREAM_CLOSE", onStreamGone as any);
        } catch { /* ignore */ }
        streamEventsBound = false;
    }
}
