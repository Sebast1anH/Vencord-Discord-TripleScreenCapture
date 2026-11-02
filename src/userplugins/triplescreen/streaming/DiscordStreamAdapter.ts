/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 TripleScreen contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { findStoreLazy } from "@webpack";
import { FluxDispatcher } from "@webpack/common";

import { displayCaptureManager } from "../capture/DisplayCaptureManager";
import { layoutManager } from "../layouts/LayoutManager";
import { Compositor } from "../render/Compositor";
import { readOutputSettings, resolveOutputSize } from "../settings";
import type { LayoutDefinition } from "../types";
import { performanceMonitor } from "../utils/PerformanceMonitor";
import { beginNativeShare, endNativeShare } from "./GoLiveGuard";

const logger = new Logger("TripleScreen:StreamAdapter");
const ApplicationStreamingStore = findStoreLazy("ApplicationStreamingStore");

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
    private reapplyTimer = 0;
    private layoutTimer = 0;
    private windowWatch: ReturnType<typeof setInterval> | null = null;
    private streamWatch: (() => void) | null = null;
    private expectingWindow = false;
    private cleaning = false;
    private generation = 0;
    private canvasWidth = 1920;
    private canvasHeight = 1080;
    private liveFps = 30;
    private lastLayout: LayoutDefinition | null = null;
    /** Ignore Discord "no stream" polls until go-live has had time to register. */
    private streamGuardUntil = 0;
    private streamMisses = 0;

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
            this.compositor = new Compositor({
                width: output.width,
                height: output.height,
                frameRate: Math.min(30, fps),
                backgroundColor: activeLayout.backgroundColor || readOutputSettings().backgroundColor
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
            } else {
                this.streamGuardUntil = performance.now() + 5000;
                this.streamMisses = 0;
                this.watchDiscordStreamEnd();
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
        this.compositor?.setLayout(layout);
        layoutManager.upsert(layout);
        if (!this.expectingWindow) return;
        if (this.layoutTimer) window.clearTimeout(this.layoutTimer);
        this.layoutTimer = window.setTimeout(() => {
            this.layoutTimer = 0;
            const native = nativeHelpers();
            if (!native || !this.expectingWindow || !this.lastLayout) return;
            void native.configureOutput(this.outputPayload(this.lastLayout)).then(result => {
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
        try {
            if (this.reapplyTimer) {
                clearTimeout(this.reapplyTimer);
                this.reapplyTimer = 0;
            }
            if (this.layoutTimer) {
                clearTimeout(this.layoutTimer);
                this.layoutTimer = 0;
            }
            this.stopWindowWatch();
            this.unwatchDiscordStreamEnd();
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

        const wantAudio = readOutputSettings().includeSystemAudio !== false && isWindowsPlatform();
        const selectedIds = layout.monitors.filter(m => m.visible && m.selected).map(m => m.monitorId);
        const stage = wantAudio ? await pickStageScreen(native, selectedIds) : null;
        // Exclude the stage monitor from the mosaic so screen-capture of the stage
        // does not recursively include the composite of itself.
        const mosaicLayout = stage
            ? {
                ...layout,
                monitors: layout.monitors.map(m =>
                    m.monitorId === stage.screenId
                        ? { ...m, selected: false, visible: false }
                        : m
                )
            }
            : layout;
        const mosaicCount = mosaicLayout.monitors.filter(m => m.visible && m.selected).length;
        const effectiveStage = mosaicCount > 0 ? stage : null;
        if (wantAudio && !effectiveStage) {
            logger.warn("No spare/stage monitor for system audio — falling back to window share (video only)");
        } else if (effectiveStage && selectedIds.includes(effectiveStage.screenId)) {
            logger.info(
                `Stage monitor ${effectiveStage.screenId} hosts the fullscreen composite (excluded from mosaic for system audio)`
            );
        }

        const opened = await native.openOutputWindow(width, height, fps, {
            stageScreenId: effectiveStage?.screenId ?? null
        });
        if (gen !== this.generation) return "closed" as const;

        this.expectingWindow = true;
        this.watchOutputWindow();

        const startedCapture = await native.configureOutput(this.outputPayload(mosaicLayout));
        if (gen !== this.generation) return "closed" as const;

        if (!startedCapture?.videos) {
            const message = startedCapture?.errors?.join("; ") || "The output window could not capture the monitors.";
            logger.error("Output window capture failed", message);
            performanceMonitor.setError(message);
            for (const item of mosaicLayout.monitors.filter(m => m.visible && m.selected)) {
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
            for (const item of mosaicLayout.monitors.filter(m => m.visible && m.selected)) {
                const failed = startedCapture.errors.some(err => err.startsWith(item.monitorId + ":"));
                performanceMonitor.setMonitorStatus(item.monitorId, !failed, failed ? "Output capture failed" : undefined);
            }
        } else {
            performanceMonitor.setError(undefined);
            for (const item of mosaicLayout.monitors.filter(m => m.visible && m.selected)) {
                performanceMonitor.setMonitorStatus(item.monitorId, true);
            }
            logger.info(`Output window is drawing ${startedCapture.videos} monitors at ${fps} fps`);
        }

        const windowSourceId = opened?.sourceId || await this.waitForOutputSource(native);
        const goLiveId = (effectiveStage && (opened?.screenSourceId || effectiveStage.screenId))
            || windowSourceId;
        if (gen !== this.generation || !this.expectingWindow) return "closed" as const;
        if (!goLiveId) {
            logger.error("TripleScreen output was not found as a Discord share source");
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
            includeSystemAudio: !!effectiveStage && wantAudio
        };
        const started = beginNativeShare(goLiveId, quality, audio);
        this.reapplyTimer = window.setTimeout(() => {
            if (!this.expectingWindow || gen !== this.generation) return;
            beginNativeShare(goLiveId, quality, audio);
        }, 1200);
        return started;
    }

    private outputPayload(layout: LayoutDefinition) {
        return {
            width: this.canvasWidth,
            height: this.canvasHeight,
            fps: this.liveFps,
            background: layout.backgroundColor || "#000000",
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
        this.windowWatch = setInterval(() => void this.onOutputWindowClosed(), 400);
    }

    private stopWindowWatch() {
        if (this.windowWatch) clearInterval(this.windowWatch);
        this.windowWatch = null;
    }

    private async onOutputWindowClosed() {
        if (this.cleaning || !this.expectingWindow) return;
        const native = nativeHelpers();
        if (!native || await native.isOutputWindowOpen()) return;
        this.expectingWindow = false;
        logger.info("Output window closed — releasing the composite");
        await this.stop();
    }

    private watchDiscordStreamEnd() {
        this.unwatchDiscordStreamEnd();
        const check = () => {
            if (!this.expectingWindow || this.cleaning) return;
            if (performance.now() < this.streamGuardUntil) return;
            try {
                const active = ApplicationStreamingStore?.getCurrentUserActiveStream?.();
                if (active) {
                    this.streamMisses = 0;
                    return;
                }
                // Require consecutive empty polls — Discord can briefly report null after go-live.
                this.streamMisses += 1;
                if (this.streamMisses < 2) return;
                if (this.status.state === "streaming") {
                    logger.info("Discord stream ended — releasing TripleScreen");
                    void this.stop();
                }
            } catch {
                /* store may be unavailable briefly */
            }
        };
        const timer = setInterval(check, 1500);
        this.streamWatch = () => clearInterval(timer);
        FluxDispatcher.subscribe("STREAM_DELETE", check as any);
        FluxDispatcher.subscribe("STREAM_CLOSE", check as any);
        const prev = this.streamWatch;
        this.streamWatch = () => {
            prev?.();
            try {
                FluxDispatcher.unsubscribe("STREAM_DELETE", check as any);
                FluxDispatcher.unsubscribe("STREAM_CLOSE", check as any);
            } catch { /* ignore */ }
        };
    }

    private unwatchDiscordStreamEnd() {
        this.streamWatch?.();
        this.streamWatch = null;
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

type NativeScreenRow = {
    id: string;
    name: string;
    isPrimary: boolean;
    bounds: { x: number; y: number; width: number; height: number; };
};

async function pickStageScreen(
    native: NonNullable<ReturnType<typeof nativeHelpers>>,
    selectedIds: string[]
): Promise<{ screenId: string; } | null> {
    if (!native.listScreens) return null;
    let screens: NativeScreenRow[] = [];
    try {
        screens = await native.listScreens();
    } catch {
        return null;
    }
    if (!screens.length) return null;

    // Prefer a monitor that is not in the mosaic (true spare display).
    const unused = screens.filter(s => !selectedIds.includes(s.id));
    if (unused.length) {
        const spare = unused.find(s => !s.isPrimary) ?? unused[0];
        return { screenId: spare.id };
    }
    // Need at least two displays so one can host the composite fullscreen.
    if (screens.length < 2) return null;
    const steal = screens.find(s => s.isPrimary && selectedIds.includes(s.id))
        ?? screens.find(s => selectedIds.includes(s.id))
        ?? screens[0];
    return steal ? { screenId: steal.id } : null;
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
                    listScreens?: () => Promise<NativeScreenRow[]>;
                };
            };
        };
    }).VencordNative?.pluginHelpers?.TripleScreen;
    return native ?? null;
}

export const discordStreamAdapter = new DiscordStreamAdapter();
