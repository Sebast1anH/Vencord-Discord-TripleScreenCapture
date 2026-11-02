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
 * Live CDP on Discord 1.0.9266 (this machine):
 *
 *   stream.goLiveSourceIdentifier was "window:…" with soundshareId = PID
 *   → friends hear Discord only.
 *
 *   eng.setGoLiveSource({ id, soundshareId, useLoopback }, "stream")
 *   → TypeError: Cannot destructure property 'resolution' of 'e.quality'
 *
 *   conn.setGoLiveSource({ quality, desktopDescription: { id: "screen:0:0",
 *       soundshareId: 1, useLoopback: true, … } })
 *   → goLive became screen:0:0, soundshareId 1 (Entire-Screen system mix).
 *
 * Window share of TripleScreen Output cannot carry system audio (Discord.exe PID
 * loopback). Viewers still *see* the mosaic because Output is fullscreen on the
 * stage display that we screen-capture.
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

function desktopDescriptionFor(id: string, withSystemAudio: boolean) {
    const screenAudio = withSystemAudio && isScreenSourceId(id);
    return {
        id,
        soundshareId: screenAudio ? SYSTEM_AUDIO_ID : -1,
        useLoopback: true,
        useVideoHook: false,
        useGraphicsCapture: true,
        useQuartzCapturer: false,
        allowScreenCaptureKit: false,
        hdrCaptureMode: 0
    };
}

/** Discord 1.0.9266 shape — flat {id,soundshareId} throws on missing quality.resolution. */
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
    const screenAudio = wantSystemAudio() && isScreenSourceId(activeId);
    const q = qualityFrom(source) ?? lastQuality;
    return goLiveOptions(activeId, screenAudio, q);
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
        if (withSystemAudio && isScreenSourceId(sourceId) && typeof conn.setSoundshareSource === "function") {
            try {
                conn.setSoundshareSource(SYSTEM_AUDIO_ID, true);
            } catch { /* optional */ }
        }
    }

    if (typeof engine?.setGoLiveSource === "function") {
        try {
            engine.setGoLiveSource(options, "stream");
            applied = true;
        } catch (err) {
            logger.warn("MediaEngine setGoLiveSource(quality+desktopDescription) failed", err);
        }
    }

    if (withSystemAudio && isScreenSourceId(sourceId) && typeof engine?.setSoundshareSource === "function") {
        try {
            engine.setSoundshareSource(SYSTEM_AUDIO_ID, true, "stream");
        } catch {
            try {
                engine.setSoundshareSource(SYSTEM_AUDIO_ID, true);
            } catch { /* optional */ }
        }
    }

    return applied;
}

function reinforceScreenAudio(engine: any) {
    if (!wantSystemAudio() || !engine || !activeOutputId || !isScreenSourceId(activeOutputId)) return;
    withBypass(() => {
        applyGoLive(engine, activeOutputId!, true);
    });
}

function scheduleSystemAudioKeepalive() {
    for (const ms of [100, 250, 500, 1000, 2000, 4000, 8000]) {
        scheduleAudio(() => {
            if (!ownsStream || !activeOutputId || !wantSystemAudio()) return;
            reinforceScreenAudio(MediaEngineStore?.getMediaEngine?.());
        }, ms);
    }
}

/**
 * Point Discord at the composite.
 * System audio: sourceId must be screen:N:0 (stage display hosting the Output mosaic).
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
    lastQuality = {
        resolution: quality?.resolution ?? 1080,
        frameRate: quality?.frameRate ?? 30
    };

    activeOutputId = videoSourceId;
    ownsStream = true;
    clearAudioTimers();

    const applied = withBypass(() => applyGoLive(engine, videoSourceId, useScreenAudio));

    if (useScreenAudio) {
        scheduleSystemAudioKeepalive();
    } else if (wantAudio) {
        logger.warn(
            "System audio requires screen go-live of the stage display (Output mosaic). Window share binds a process PID."
        );
    }

    logger.info(
        "Requested Discord go live",
        videoSourceId,
        lastQuality,
        useScreenAudio ? "system audio via screen + soundshareId:1 (quality+desktopDescription)" : "video only",
        applied ? "applied" : "NOT applied"
    );
    return applied;
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

            // Hold stage screen — Discord often tries to switch to Output window: (PID audio).
            if (activeOutputId && ownsStream && isScreenSourceId(activeOutputId)) {
                const nextId = sourceIdOf(source);
                if (nextId !== activeOutputId) {
                    logger.info("Keeping stage screen go-live; blocked switch to", nextId || "(complex)");
                }
                const retargeted = retargetToActive(source, activeOutputId);
                const result = withBypass(() =>
                    originalSetGoLiveSource!.call(this, retargeted, context ?? "stream")
                );
                reinforceScreenAudio(MediaEngineStore?.getMediaEngine?.());
                return result;
            }

            if (activeOutputId && ownsStream && isScreenSource(source) && !isScreenSourceId(activeOutputId)) {
                logger.info("Kept TripleScreen window as go-live video instead of", sourceIdOf(source));
                return withBypass(() =>
                    originalSetGoLiveSource!.call(
                        this,
                        retargetToActive(source, activeOutputId!),
                        context ?? "stream"
                    )
                );
            }

            if (ownsStream && source != null) {
                const nextId = sourceIdOf(source);
                if (nextId && activeOutputId && nextId !== activeOutputId && !isScreenSource(source)) {
                    ownsStream = false;
                    activeOutputId = null;
                    clearAudioTimers();
                } else if (nextId === activeOutputId || (!nextId && activeOutputId)) {
                    return withBypass(() =>
                        originalSetGoLiveSource!.call(
                            this,
                            retargetToActive(source, activeOutputId!),
                            context ?? "stream"
                        )
                    );
                }
            }

            return originalSetGoLiveSource!.apply(this, args);
        };
        patched = true;
        logger.info("Go Live guard ready (quality+desktopDescription system audio)");
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
