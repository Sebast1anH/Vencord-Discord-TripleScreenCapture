/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 TripleScreen contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { displayCaptureManager } from "../capture/DisplayCaptureManager";
import { layoutManager } from "../layouts/LayoutManager";
import { Compositor } from "../render/Compositor";
import { readOutputSettings, resolveOutputSize } from "../settings";
import type { LayoutDefinition } from "../types";
import { performanceMonitor } from "../utils/PerformanceMonitor";
import { beginNativeShare, endNativeShare } from "./GoLiveGuard";

const logger = new Logger("TripleScreen:StreamAdapter");

export type StreamAdapterStatus =
    | { state: "idle"; }
    | { state: "preparing"; }
    | { state: "streaming"; mode: InjectionMode; }
    | { state: "error"; message: string; };

export type InjectionMode = "output-window" | "preview-only";

type StatusListener = (status: StreamAdapterStatus) => void;

/**
 * Opens the TripleScreen Output window (live multi-monitor canvas), then points
 * Discord's Go Live encoder at that window.
 */
export class DiscordStreamAdapter {
    private compositor: Compositor | null = null;
    private status: StreamAdapterStatus = { state: "idle" };
    private listeners = new Set<StatusListener>();
    private layoutTimer = 0;
    private windowWatch: ReturnType<typeof setInterval> | null = null;
    private expectingWindow = false;
    private cleaning = false;
    private generation = 0;
    private canvasWidth = 1920;
    private canvasHeight = 1080;
    private liveFps = 30;
    private lastLayout: LayoutDefinition | null = null;
    /** Layout actually sent to the output window. */
    private liveMosaicLayout: LayoutDefinition | null = null;
    private windowMisses = 0;

    subscribe(listener: StatusListener): () => void {
        this.listeners.add(listener);
        listener(this.status);
        return () => this.listeners.delete(listener);
    }

    getStatus() {
        return this.status;
    }

    getCompositor() {
        return this.compositor;
    }

    async start(selectedMonitorIds: string[], layout?: LayoutDefinition): Promise<void> {
        if (this.status.state === "streaming" || this.status.state === "preparing") {
            await this.stop();
        }

        const gen = ++this.generation;
        this.setStatus({ state: "preparing" });
        performanceMonitor.reset();

        try {
            const monitors = displayCaptureManager.getMonitors().length
                ? displayCaptureManager.getMonitors()
                : await displayCaptureManager.enumerateMonitors();
            if (gen !== this.generation) return;

            const missing = selectedMonitorIds.filter(id => !monitors.some(m => m.id === id));
            if (missing.length) {
                throw new Error(`Saved monitors unavailable: ${missing.join(", ")}. Re-select displays.`);
            }
            if (!selectedMonitorIds.length) {
                throw new Error("Select at least one monitor to share.");
            }

            const activeLayout = layout ?? layoutManager.ensureDefault(monitors, selectedMonitorIds);
            const output = resolveOutputSize(readOutputSettings());
            const fps = readOutputSettings().frameRate;
            this.canvasWidth = output.width;
            this.canvasHeight = output.height;
            this.liveFps = fps;
            this.lastLayout = activeLayout;

            // Editor compositor is optional preview. The native output window is what Discord shares.
            // Skip a second getUserMedia pass when native helpers exist — doubles GPU load otherwise.
            const outputSettings = readOutputSettings();
            this.compositor = new Compositor({
                width: output.width,
                height: output.height,
                frameRate: Math.min(30, fps),
                backgroundColor: activeLayout.backgroundColor || outputSettings.backgroundColor,
                backgroundImageDataUrl: outputSettings.backgroundImageDataUrl,
                backgroundImageFit: outputSettings.backgroundImageFit,
                backgroundImageScale: outputSettings.backgroundImageScale,
                backgroundImageOffsetX: outputSettings.backgroundImageOffsetX,
                backgroundImageOffsetY: outputSettings.backgroundImageOffsetY
            });
            this.compositor.setLayout(activeLayout);
            const native = nativeHelpers();
            if (!native) {
                try {
                    await displayCaptureManager.startCapture(selectedMonitorIds, fps);
                    this.compositor.start(() => displayCaptureManager.synchronizer.sample());
                } catch (err) {
                    logger.warn("Editor preview capture unavailable", err);
                }
            } else {
                logger.info("Using native output window for capture (skipping duplicate editor capture)");
            }
            if (gen !== this.generation) return;

            const published = await this.publishCompositeWindow(output.width, output.height, fps, activeLayout, gen);
            if (gen !== this.generation) return;
            if (published === "closed") {
                await this.cleanup();
                this.setStatus({ state: "idle" });
                return;
            }

            const mode: InjectionMode = published ? "output-window" : "preview-only";
            if (!published) {
                performanceMonitor.setError("Discord did not start the stream. Stay in a voice channel, then press Start again.");
            }
            this.setStatus({ state: "streaming", mode });
            logger.info(`Streaming started via ${mode} at ${fps} fps`);
        } catch (err) {
            if (gen !== this.generation) return;
            const message = err instanceof Error ? err.message : String(err);
            performanceMonitor.setError(message);
            this.setStatus({ state: "error", message });
            await this.cleanup();
            throw err;
        }
    }

    updateLayout(layout: LayoutDefinition) {
        this.lastLayout = layout;
        this.liveMosaicLayout = layout;
        const outputSettings = readOutputSettings();
        this.compositor?.setLayout(layout);
        this.compositor?.setOptions({
            backgroundColor: layout.backgroundColor || outputSettings.backgroundColor,
            backgroundImageDataUrl: outputSettings.backgroundImageDataUrl,
            backgroundImageFit: outputSettings.backgroundImageFit,
            backgroundImageScale: outputSettings.backgroundImageScale,
            backgroundImageOffsetX: outputSettings.backgroundImageOffsetX,
            backgroundImageOffsetY: outputSettings.backgroundImageOffsetY
        });
        layoutManager.upsert(layout);
        if (!this.expectingWindow) return;
        if (this.layoutTimer) window.clearTimeout(this.layoutTimer);
        this.layoutTimer = window.setTimeout(() => {
            this.layoutTimer = 0;
            const native = nativeHelpers();
            if (!native || !this.expectingWindow || !this.liveMosaicLayout) return;
            void native.configureOutput(this.outputPayload(this.liveMosaicLayout)).then(result => {
                if (!result) return;
                if (result.errors?.length) {
                    performanceMonitor.setError(result.errors.join("; "));
                } else if (result.videos > 0) {
                    performanceMonitor.setError(undefined);
                }
            });
        }, 100);
    }

    async stop() {
        this.generation += 1;
        await this.cleanup();
        this.setStatus({ state: "idle" });
        logger.info("Streaming stopped — resources released");
    }

    private async cleanup() {
        if (this.cleaning) return;
        this.cleaning = true;
        this.expectingWindow = false;
        this.liveMosaicLayout = null;
        try {
            if (this.layoutTimer) {
                clearTimeout(this.layoutTimer);
                this.layoutTimer = 0;
            }
            this.stopWindowWatch();
            this.compositor?.stop();
            this.compositor = null;
            displayCaptureManager.stopCapture();
            endNativeShare();
            await nativeHelpers()?.closeOutputWindow();
        } finally {
            this.cleaning = false;
        }
    }

    private async publishCompositeWindow(
        width: number,
        height: number,
        fps: number,
        layout: LayoutDefinition,
        gen: number
    ) {
        const native = nativeHelpers();
        if (!native) return false;

        // Always share the Output *window* so every selected monitor stays in the mosaic.
        // System audio is pinned via setSoundshareSource(0|1) after go-live — no stage monitor.
        this.liveMosaicLayout = layout;

        const opened = await native.openOutputWindow(width, height, fps);
        if (gen !== this.generation) return "closed" as const;

        this.expectingWindow = true;
        this.watchOutputWindow();

        const startedCapture = await native.configureOutput(this.outputPayload(layout));
        if (gen !== this.generation) return "closed" as const;

        if (!startedCapture?.videos) {
            const message = startedCapture?.errors?.join("; ") || "The output window could not capture the monitors.";
            logger.error("Output window capture failed", message);
            performanceMonitor.setError(message);
            for (const item of layout.monitors.filter(m => m.visible && m.selected)) {
                performanceMonitor.setMonitorStatus(item.monitorId, false, "Output capture failed");
            }
            this.expectingWindow = false;
            this.stopWindowWatch();
            await native.closeOutputWindow();
            return false;
        }
        if (startedCapture.errors?.length) {
            performanceMonitor.setError(startedCapture.errors.join("; "));
            logger.warn("Some monitors failed to capture", startedCapture.errors.join("; "));
            for (const item of layout.monitors.filter(m => m.visible && m.selected)) {
                const failed = startedCapture.errors.some(err => err.startsWith(item.monitorId + ":"));
                performanceMonitor.setMonitorStatus(item.monitorId, !failed, failed ? "Output capture failed" : undefined);
            }
        } else {
            performanceMonitor.setError(undefined);
            for (const item of layout.monitors.filter(m => m.visible && m.selected)) {
                performanceMonitor.setMonitorStatus(item.monitorId, true);
            }
            logger.info(`Output window is drawing ${startedCapture.videos} monitors at ${fps} fps`);
        }

        const windowSourceId = opened?.sourceId || await this.waitForOutputSource(native);
        if (gen !== this.generation || !this.expectingWindow) return "closed" as const;
        if (!windowSourceId) {
            logger.error("TripleScreen output window was not found as a Discord share source");
            this.expectingWindow = false;
            this.stopWindowWatch();
            await native.closeOutputWindow();
            return false;
        }

        const quality = {
            resolution: discordResolution(height),
            frameRate: fps
        };
        const audio = {
            includeSystemAudio: readOutputSettings().includeSystemAudio !== false && isWindowsPlatform()
        };
        return beginNativeShare(windowSourceId, quality, audio);
    }

    private outputPayload(layout: LayoutDefinition) {
        const output = readOutputSettings();
        return {
            width: this.canvasWidth,
            height: this.canvasHeight,
            fps: this.liveFps,
            background: layout.backgroundColor || output.backgroundColor || "#000000",
            backgroundImage: output.backgroundImageDataUrl || "",
            backgroundFit: output.backgroundImageFit || "fill",
            backgroundScale: output.backgroundImageScale ?? 1,
            backgroundOffsetX: output.backgroundImageOffsetX ?? 0,
            backgroundOffsetY: output.backgroundImageOffsetY ?? 0,
            items: layout.monitors
                .filter(item => item.visible && item.selected)
                .map(item => ({
                    sourceId: item.monitorId,
                    x: item.x,
                    y: item.y,
                    width: item.width,
                    height: item.height,
                    z: item.zIndex,
                    scaleMode: item.scaleMode,
                    rotation: item.rotationDeg,
                    crop: item.crop
                }))
        };
    }

    private watchOutputWindow() {
        this.stopWindowWatch();
        this.windowMisses = 0;
        this.windowWatch = setInterval(() => void this.onOutputWindowClosed(), 500);
    }

    private stopWindowWatch() {
        if (this.windowWatch) clearInterval(this.windowWatch);
        this.windowWatch = null;
        this.windowMisses = 0;
    }

    private async onOutputWindowClosed() {
        if (this.cleaning || !this.expectingWindow) return;
        const native = nativeHelpers();
        if (!native) return;
        try {
            if (await native.isOutputWindowOpen()) {
                this.windowMisses = 0;
                return;
            }
        } catch {
            // IPC blip during fullscreen transitions — do not tear down yet.
            this.windowMisses += 1;
            if (this.windowMisses < 4) return;
            logger.warn("Output window IPC failed repeatedly — releasing composite");
            this.expectingWindow = false;
            await this.stop();
            return;
        }
        this.windowMisses += 1;
        if (this.windowMisses < 3) return;
        this.expectingWindow = false;
        logger.info("Output window closed — releasing the composite");
        await this.stop();
    }

    private async waitForOutputSource(native: NonNullable<ReturnType<typeof nativeHelpers>>) {
        for (let attempt = 0; attempt < 20; attempt++) {
            const id = await native.getOutputSourceId();
            if (id) return id;
            await sleep(250);
        }
        return null;
    }

    private setStatus(status: StreamAdapterStatus) {
        this.status = status;
        for (const listener of this.listeners) listener(status);
    }
}

function sleep(ms: number) {
    return new Promise<void>(r => setTimeout(r, ms));
}

function discordResolution(height: number) {
    if (height >= 1400) return 1440;
    if (height >= 1000) return 1080;
    if (height >= 700) return 720;
    return 480;
}

function isWindowsPlatform() {
    return (DiscordNative as any)?.process?.platform === "win32"
        || navigator.userAgent.includes("Windows");
}

function nativeHelpers() {
    const native = (globalThis as typeof globalThis & {
        VencordNative?: {
            pluginHelpers?: {
                TripleScreen?: {
                    openOutputWindow: (
                        width: number,
                        height: number,
                        frameRate?: number,
                        options?: { stageScreenId?: string | null; }
                    ) => Promise<{
                        width: number;
                        height: number;
                        sourceId?: string | null;
                        screenSourceId?: string | null;
                        stageDisplayId?: number | null;
                    }>;
                    configureOutput: (config: unknown) => Promise<{ ok: boolean; videos: number; errors: string[]; }>;
                    isOutputWindowOpen: () => Promise<boolean>;
                    getOutputSourceId: () => Promise<string | null>;
                    closeOutputWindow: () => Promise<boolean>;
                    listScreens?: () => Promise<Array<{
                        id: string;
                        name: string;
                        isPrimary: boolean;
                        bounds: { x: number; y: number; width: number; height: number; };
                    }>>;
                };
            };
        };
    }).VencordNative?.pluginHelpers?.TripleScreen;
    return native ?? null;
}

export const discordStreamAdapter = new DiscordStreamAdapter();
