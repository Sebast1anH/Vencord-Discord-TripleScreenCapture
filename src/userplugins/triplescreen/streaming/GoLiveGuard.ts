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
 * Discord Windows soundshare ( empirically from Nightcord + jimman):
 *
 *   setGoLiveSource({ id: "screen-…", soundshareId: 1 })  → full system mix
 *   setGoLiveSource({ id: "window:…", soundshareId: PID }) → that process tree
 *
 * TripleScreen Output is a Discord.exe BrowserWindow, so a plain window share
 * binds soundshare to Discord's PID (friends hear themselves / no YouTube).
 *
 * Nightcord "Entire System" does NOT use setSoundshareSource(0, true) — that
 * call can succeed without enabling desktop loopback. The working call is:
 *   engine.setSoundshareSource(null, false)
 * which clears the single-PID filter. We also put soundshareId: 1 on the
 * go-live payload and re-apply after the stream connection exists.
 *
 * Video stays on the Output window so every selected monitor can be in the mosaic.
 */
const SYSTEM_MIX_SENTINEL = 1;

let bypassDepth = 0;
let patched = false;
let originalSetGoLiveSource: ((...args: any[]) => unknown) | null = null;
let patchedModule: { setGoLiveSource: (...args: any[]) => unknown; } | null = null;
let activeOutputId: string | null = null;
let ownsStream = false;
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

/** Window video + system-mix sentinel (1). Never Discord PID. */
function windowGoLiveSource(windowId: string, withSystemAudio: boolean) {
    return {
        id: windowId,
        soundshareId: withSystemAudio ? SYSTEM_MIX_SENTINEL : null,
        useLoopback: true
    };
}

function desktopDescriptionFor(id: string, withSystemAudio: boolean) {
    return {
        id,
        soundshareId: withSystemAudio ? SYSTEM_MIX_SENTINEL : -1,
        useLoopback: true,
        useVideoHook: false,
        useGraphicsCapture: true,
        useQuartzCapturer: false,
        allowScreenCaptureKit: false,
        hdrCaptureMode: 0
    };
}

function retargetToOurWindow(source: unknown, activeId: string): unknown {
    const withAudio = wantSystemAudio();
    if (typeof source === "string" || !source || typeof source !== "object") {
        return windowGoLiveSource(activeId, withAudio);
    }
    const selfPid = discordPid();
    const copy = { ...(source as Record<string, unknown>) };
    copy.id = activeId;
    const audioId = soundshareIdOf(source);
    if (withAudio) {
        copy.soundshareId = SYSTEM_MIX_SENTINEL;
    } else if (audioId != null && selfPid != null && audioId === selfPid) {
        copy.soundshareId = null;
    }
    if (copy.desktopSource && typeof copy.desktopSource === "object") {
        const ds = { ...(copy.desktopSource as Record<string, unknown>), id: activeId };
        ds.soundshareId = withAudio ? SYSTEM_MIX_SENTINEL : (selfPid != null && Number(ds.soundshareId) === selfPid ? null : ds.soundshareId);
        copy.desktopSource = ds;
    }
    if (copy.desktopDescription && typeof copy.desktopDescription === "object") {
        const dd = { ...(copy.desktopDescription as Record<string, unknown>), id: activeId };
        dd.soundshareId = withAudio ? SYSTEM_MIX_SENTINEL : (selfPid != null && Number(dd.soundshareId) === selfPid ? -1 : dd.soundshareId);
        copy.desktopDescription = dd;
    }
    return copy;
}

function callSetSoundshare(target: any, id: unknown, active: boolean): boolean {
    if (!target || typeof target.setSoundshareSource !== "function") return false;
    try {
        try {
            target.setSoundshareSource(id as any, active, "stream");
        } catch {
            target.setSoundshareSource(id as any, active);
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * Nightcord entire-system path: clear the PID filter with (null, false).
 * Do NOT prefer (0, true) — it can "succeed" without enabling desktop loopback.
 */
function pinSystemAudio(engine: any, force = false) {
    if (!wantSystemAudio() || !engine || !activeOutputId) return;
    const now = performance.now();
    if (!force && now - lastAudioPinAt < 2000) return;
    lastAudioPinAt = now;

    const selfPid = discordPid();
    let cleared = false;

    // 1) Clear single-PID filter (required for full mix on a window share).
    if (callSetSoundshare(engine, null, false)) {
        cleared = true;
        logger.info("Cleared soundshare PID filter via setSoundshareSource(null, false)");
    } else if (callSetSoundshare(engine, undefined, false)) {
        cleared = true;
        logger.info("Cleared soundshare PID filter via setSoundshareSource(undefined, false)");
    }

    // 2) Reinforce classic system-mix sentinel.
    callSetSoundshare(engine, SYSTEM_MIX_SENTINEL, true);

    for (const conn of [...(engine.connections ?? [])]) {
        if (conn.context !== "stream" && !conn.streamUserId) continue;
        if (callSetSoundshare(conn, null, false) || callSetSoundshare(conn, undefined, false)) {
            cleared = true;
        }
        callSetSoundshare(conn, SYSTEM_MIX_SENTINEL, true);
    }

    // 3) If still stuck on Discord PID, clear again.
    if (selfPid != null) {
        try {
            const active = Number(
                (engine as any).getSoundshareSource?.()
                ?? (engine as any).soundshareId
                ?? NaN
            );
            if (active === selfPid) {
                logger.warn("Soundshare still on Discord PID — clearing filter again");
                callSetSoundshare(engine, null, false);
                callSetSoundshare(engine, SYSTEM_MIX_SENTINEL, true);
            }
        } catch { /* optional */ }
    }

    if (!cleared) {
        logger.warn("Could not clear soundshare PID filter — system audio may stay on Discord loopback");
    }
}

function scheduleSystemAudioKeepalive() {
    // Pins after the stream connection exists; avoid hammering (that killed composites).
    for (const ms of [200, 700, 1800, 4000]) {
        scheduleAudio(() => {
            if (!ownsStream || !activeOutputId || !wantSystemAudio()) return;
            pinSystemAudio(MediaEngineStore?.getMediaEngine?.(), true);
        }, ms);
    }
}

/**
 * Go live on the TripleScreen Output window (full mosaic).
 * System audio: optional screen bootstrap (activates Discord's desktop loopback),
 * then window video with soundshareId 1 + setSoundshareSource(null, false).
 */
export function beginNativeShare(
    windowSourceId: string,
    quality?: { resolution: number; frameRate: number; },
    options?: { includeSystemAudio?: boolean; bootstrapScreenId?: string | null; }
) {
    const engine = MediaEngineStore?.getMediaEngine?.();
    if (!engine?.setGoLiveSource || !windowSourceId) {
        logger.warn("Media engine is not ready to go live");
        return false;
    }

    const wantAudio = (options?.includeSystemAudio ?? readOutputSettings().includeSystemAudio) && isWindows();
    const bootstrapScreen = wantAudio && options?.bootstrapScreenId
        ? String(options.bootstrapScreenId)
        : null;
    const chosen = {
        resolution: quality?.resolution ?? 1080,
        frameRate: quality?.frameRate ?? 30
    };

    activeOutputId = windowSourceId;
    ownsStream = true;
    streamEventGuardUntil = performance.now() + 12_000;
    clearAudioTimers();
    lastAudioPinAt = 0;

    const windowPayload = windowGoLiveSource(windowSourceId, wantAudio);

    withBypass(() => {
        // Bootstrap: Entire-Screen-shaped go-live wakes Discord's system-mix capture path.
        // Video is immediately switched to our Output window so the mosaic stays intact.
        if (bootstrapScreen) {
            try {
                engine.setGoLiveSource({
                    id: bootstrapScreen,
                    soundshareId: SYSTEM_MIX_SENTINEL,
                    useLoopback: true
                }, "stream");
                logger.info("Bootstrapped system audio via screen source", bootstrapScreen);
            } catch (err) {
                logger.warn("Screen audio bootstrap failed (continuing with window)", err);
            }
        }

        let applied = false;
        try {
            engine.setGoLiveSource(windowPayload, "stream");
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
                        desktopDescription: desktopDescriptionFor(windowSourceId, wantAudio)
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
            ? `system audio: bootstrap=${bootstrapScreen || "none"}, soundshareId=1, clearPID; Discord PID ${discordPid() ?? "?"}`
            : "video only"
    );
    return true;
}

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
            callSetSoundshare(engine, null, false);
            callSetSoundshare(engine, SYSTEM_MIX_SENTINEL, false);
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
                logger.info("Kept TripleScreen window as go-live video instead of", sourceIdOf(source));
                const result = withBypass(() =>
                    originalSetGoLiveSource!.call(
                        this,
                        retargetToOurWindow(source, activeOutputId!),
                        context ?? "stream"
                    )
                );
                pinSystemAudio(MediaEngineStore?.getMediaEngine?.(), true);
                return result;
            }

            if (ownsStream && source != null) {
                const nextId = sourceIdOf(source);
                if (nextId && activeOutputId && nextId !== activeOutputId && !isScreenSource(source)) {
                    ownsStream = false;
                    activeOutputId = null;
                    clearAudioTimers();
                } else if (nextId === activeOutputId) {
                    // Discord re-applied our window, often with Discord PID — force system mix.
                    const cleaned = retargetToOurWindow(source, activeOutputId);
                    const result = withBypass(() =>
                        originalSetGoLiveSource!.call(this, cleaned, context ?? "stream")
                    );
                    if (wantSystemAudio()) {
                        pinSystemAudio(MediaEngineStore?.getMediaEngine?.(), true);
                    }
                    return result;
                }
            }

            return originalSetGoLiveSource!.apply(this, args);
        };
        patched = true;
        logger.info("Go Live guard ready (window mosaic + Nightcord system-audio clear)");
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
