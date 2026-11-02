/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 TripleScreen contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

import type { DiscordDesktopSource, MonitorInfo } from "../types";
import { performanceMonitor } from "../utils/PerformanceMonitor";
import { FrameSynchronizer } from "./FrameSynchronizer";

const logger = new Logger("TripleScreen:Capture");

interface ActiveCapture {
    monitorId: string;
    stream: MediaStream;
    video: HTMLVideoElement;
    raf?: number;
}

/**
 * Enumerates displays and acquires per-monitor MediaStreams.
 *
 * Discord Desktop path:
 *   1. DiscordNative.desktopCapture.getDesktopCaptureSources({ types: ["screen"] })
 *   2. navigator.mediaDevices.getUserMedia with chromeMediaSource / chromeMediaSourceId
 *
 * Browser / preview fallback:
 *   Repeated getDisplayMedia prompts (one display per call).
 */
export class DisplayCaptureManager {
    readonly synchronizer = new FrameSynchronizer();
    private captures = new Map<string, ActiveCapture>();
    private monitors: MonitorInfo[] = [];

    async enumerateMonitors(): Promise<MonitorInfo[]> {
        const fromNative = await this.enumerateViaPluginNative();
        if (fromNative.length) {
            this.monitors = fromNative;
            logger.info(`Enumerated ${fromNative.length} displays via Electron`);
            return this.monitors;
        }

        const fromDiscord = await this.enumerateViaDiscordNative();
        if (fromDiscord.length) {
            this.monitors = fromDesktopSources(fromDiscord);
            logger.info(`Enumerated ${this.monitors.length} displays via DiscordNative`);
            return this.monitors;
        }

        // Fallback: Screen Details API (Chromium) when available.
        const detailed = await this.enumerateViaScreenDetails();
        if (detailed.length) {
            this.monitors = detailed;
            return this.monitors;
        }

        // Last resort placeholders so the UI remains usable outside Discord.
        this.monitors = [
            placeholderMonitor("screen:0", "Monitor 1", 2560, 1440, true, { x: 0, y: 0 }),
            placeholderMonitor("screen:1", "Monitor 2", 1920, 1080, false, { x: 2560, y: 0 }),
            placeholderMonitor("screen:2", "Monitor 3", 1920, 1080, false, { x: 4480, y: 180 })
        ];
        logger.warn("Using placeholder monitors — DiscordNative / Screen Details unavailable");
        return this.monitors;
    }

    getMonitors(): MonitorInfo[] {
        return this.monitors;
    }

    async startCapture(monitorIds: string[], frameRate = 30): Promise<void> {
        const unique = [...new Set(monitorIds)];
        const fps = frameRate === 60 ? 60 : frameRate === 15 ? 15 : 30;
        for (const id of unique) {
            if (this.captures.has(id)) continue;
            const monitor = this.monitors.find(m => m.id === id);
            if (!monitor) {
                performanceMonitor.setMonitorStatus(id, false, "Monitor not found");
                throw new Error(`Monitor not found: ${id}`);
            }
            try {
                const stream = await this.acquireStream(monitor, fps);
                const video = document.createElement("video");
                video.srcObject = stream;
                video.muted = true;
                video.playsInline = true;
                await video.play();

                const active: ActiveCapture = { monitorId: id, stream, video };
                this.captures.set(id, active);
                this.synchronizer.ensure(id);
                performanceMonitor.setMonitorStatus(id, true);
                this.pumpFrames(active);
                logger.info(`Capturing ${monitor.name} (${id})`);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                performanceMonitor.setMonitorStatus(id, false, message);
                logger.error(`Failed to capture ${id}:`, err);
                throw new Error(`Permission denied or capture failed for ${monitor.name}: ${message}`);
            }
        }
    }

    stopCapture(monitorId?: string) {
        if (monitorId) {
            this.releaseOne(monitorId);
            return;
        }
        for (const id of [...this.captures.keys()]) this.releaseOne(id);
        this.synchronizer.clear();
    }

    isCapturing(monitorId: string) {
        return this.captures.has(monitorId);
    }

    private releaseOne(monitorId: string) {
        const active = this.captures.get(monitorId);
        if (!active) return;
        if (active.raf) cancelAnimationFrame(active.raf);
        active.stream.getTracks().forEach(t => t.stop());
        active.video.srcObject = null;
        this.captures.delete(monitorId);
        this.synchronizer.remove(monitorId);
        performanceMonitor.setMonitorStatus(monitorId, false);
        logger.info(`Released capture ${monitorId}`);
    }

    private pumpFrames(active: ActiveCapture) {
        const tick = () => {
            if (!this.captures.has(active.monitorId)) return;
            const { video } = active;
            if (video.readyState >= 2 && video.videoWidth > 0) {
                this.synchronizer.push({
                    monitorId: active.monitorId,
                    source: video,
                    width: video.videoWidth,
                    height: video.videoHeight,
                    timestamp: performance.now()
                });
            }
            active.raf = requestAnimationFrame(tick);
        };
        active.raf = requestAnimationFrame(tick);
    }

    private async acquireStream(monitor: MonitorInfo, frameRate: number): Promise<MediaStream> {
        const media = navigator.mediaDevices;
        if (!media?.getUserMedia && !media?.getDisplayMedia) {
            throw new Error("navigator.mediaDevices is unavailable in this page");
        }

        // Electron / Discord Desktop: chromeMediaSource constraints.
        if (media.getUserMedia) {
            try {
                const constraints: MediaStreamConstraints = {
                    audio: false,
                    video: {
                        // @ts-expect-error Electron-specific mandatory constraints
                        mandatory: {
                            chromeMediaSource: "desktop",
                            chromeMediaSourceId: monitor.id,
                            maxWidth: monitor.width,
                            maxHeight: monitor.height,
                            maxFrameRate: 60
                        }
                    }
                };
                const stream = await media.getUserMedia(constraints);
                await lockFrameRate(stream, 60);
                return stream;
            } catch (electronErr) {
                logger.info(`chromeMediaSource failed for ${monitor.id}, trying getDisplayMedia`, electronErr);
            }
        }

        // Browser path — user must pick the matching display each time.
        if (!media.getDisplayMedia) {
            throw new Error("No display capture API available in this runtime");
        }
        const stream = await media.getDisplayMedia({
            audio: false,
            video: {
                width: { ideal: monitor.width },
                height: { ideal: monitor.height },
                frameRate: { ideal: 60, max: 60 }
            }
        });
        await lockFrameRate(stream, frameRate);
        return stream;
    }

    private async enumerateViaPluginNative(): Promise<MonitorInfo[]> {
        try {
            const native = (globalThis as typeof globalThis & {
                VencordNative?: { pluginHelpers?: { TripleScreen?: { listScreens?: () => Promise<Array<MonitorInfo & { url?: string; }>>; }; }; };
            }).VencordNative?.pluginHelpers?.TripleScreen;
            if (!native?.listScreens) return [];
            const screens = await native.listScreens();
            return screens.map(screen => ({
                id: screen.id,
                name: screen.name,
                width: screen.width,
                height: screen.height,
                refreshRate: screen.refreshRate,
                isPrimary: screen.isPrimary,
                bounds: screen.bounds,
                thumbnailDataUrl: screen.url
            }));
        } catch (err) {
            logger.warn("Native screen list failed", err);
            return [];
        }
    }

    private async enumerateViaDiscordNative(): Promise<DiscordDesktopSource[]> {
        try {
            const api = window.DiscordNative?.desktopCapture;
            if (!api?.getDesktopCaptureSources) return [];
            const sources = await api.getDesktopCaptureSources({
                types: ["screen"],
                thumbnailSize: { width: 320, height: 180 }
            });
            const screens = sources.filter(s => s.id.startsWith("screen") || s.name.toLowerCase().includes("screen") || s.name.toLowerCase().includes("display"));
            return screens.length ? screens : sources;
        } catch (err) {
            logger.warn("DiscordNative desktopCapture unavailable", err);
            return [];
        }
    }

    private async enumerateViaScreenDetails(): Promise<MonitorInfo[]> {
        try {
            // Experimental Screen Details API
            const anyWindow = window as Window & {
                getScreenDetails?: () => Promise<{ screens: Array<{
                    label: string;
                    width: number;
                    height: number;
                    devicePixelRatio: number;
                    isPrimary: boolean;
                    left: number;
                    top: number;
                }>; }>;
            };
            if (!anyWindow.getScreenDetails) return [];
            const details = await anyWindow.getScreenDetails();
            return details.screens.map((screen, index) => ({
                id: `screen-detail:${screen.label || index}`,
                name: screen.label || `Monitor ${index + 1}`,
                width: Math.round(screen.width * (screen.devicePixelRatio || 1)),
                height: Math.round(screen.height * (screen.devicePixelRatio || 1)),
                isPrimary: screen.isPrimary,
                bounds: {
                    x: screen.left,
                    y: screen.top,
                    width: screen.width,
                    height: screen.height
                }
            }));
        } catch {
            return [];
        }
    }
}

async function lockFrameRate(stream: MediaStream, frameRate: number) {
    const track = stream.getVideoTracks()[0];
    if (!track?.applyConstraints) return;
    try {
        await track.applyConstraints({
            frameRate: { ideal: frameRate, max: 60 }
        });
    } catch (err) {
        logger.info(`Capture kept its own frame rate instead of ${frameRate}`, err);
    }
}

function fromDesktopSources(sources: DiscordDesktopSource[]): MonitorInfo[] {
    return sources.map((source, index) => {
        const parsed = parseResolutionFromName(source.name);
        return {
            id: source.id,
            name: source.name || `Monitor ${index + 1}`,
            width: parsed?.width ?? 1920,
            height: parsed?.height ?? 1080,
            isPrimary: index === 0,
            thumbnailDataUrl: source.url
        };
    });
}

function parseResolutionFromName(name: string): { width: number; height: number; } | null {
    const match = name.match(/(\d{3,5})\s*[x×]\s*(\d{3,5})/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

function placeholderMonitor(
    id: string,
    name: string,
    width: number,
    height: number,
    isPrimary: boolean,
    origin: { x: number; y: number; }
): MonitorInfo {
    return {
        id,
        name,
        width,
        height,
        refreshRate: 60,
        isPrimary,
        bounds: { x: origin.x, y: origin.y, width, height }
    };
}

export const displayCaptureManager = new DisplayCaptureManager();
