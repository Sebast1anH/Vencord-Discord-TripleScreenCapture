/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 TripleScreen contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { BackgroundImageFit, CaptureFrame, LayoutDefinition, MonitorLayoutItem, ScaleMode } from "../types";
import { computeBackgroundDest } from "../utils/backgroundImage";
import { performanceMonitor } from "../utils/PerformanceMonitor";

export interface CompositorOptions {
    width: number;
    height: number;
    frameRate: number;
    backgroundColor: string;
    backgroundImageDataUrl?: string;
    backgroundImageFit?: BackgroundImageFit;
    backgroundImageScale?: number;
    backgroundImageOffsetX?: number;
    backgroundImageOffsetY?: number;
}

/**
 * Draws selected monitor frames into a single canvas and exposes
 * a MediaStream via captureStream() for Discord adapter consumption.
 */
export class Compositor {
    readonly canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private layout: LayoutDefinition | null = null;
    private options: CompositorOptions;
    private running = false;
    private raf = 0;
    private lastFrameAt = 0;
    private stream: MediaStream | null = null;
    private frameProvider: (() => CaptureFrame[]) | null = null;
    private bgImage: HTMLImageElement | null = null;
    private bgImageUrl = "";

    constructor(options: CompositorOptions) {
        this.options = options;
        this.canvas = document.createElement("canvas");
        this.canvas.width = options.width;
        this.canvas.height = options.height;
        const ctx = this.canvas.getContext("2d", { alpha: false, desynchronized: true });
        if (!ctx) throw new Error("Failed to acquire 2D canvas context");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        this.ctx = ctx;
        performanceMonitor.setOutputSize(options.width, options.height);
        void this.ensureBackgroundImage(options.backgroundImageDataUrl);
    }

    setLayout(layout: LayoutDefinition) {
        this.layout = layout;
        if (layout.backgroundColor) {
            this.options = { ...this.options, backgroundColor: layout.backgroundColor };
        }
    }

    setOptions(partial: Partial<CompositorOptions>) {
        this.options = { ...this.options, ...partial };
        if (partial.width) this.canvas.width = partial.width;
        if (partial.height) this.canvas.height = partial.height;
        performanceMonitor.setOutputSize(this.canvas.width, this.canvas.height);
        if (partial.backgroundImageDataUrl !== undefined) {
            void this.ensureBackgroundImage(partial.backgroundImageDataUrl);
        }
    }

    private async ensureBackgroundImage(url?: string) {
        const next = url || "";
        if (!next) {
            this.bgImage = null;
            this.bgImageUrl = "";
            return;
        }
        if (next === this.bgImageUrl && this.bgImage?.complete) return;
        this.bgImageUrl = next;
        await new Promise<void>(resolve => {
            const img = new Image();
            img.onload = () => {
                this.bgImage = img;
                resolve();
            };
            img.onerror = () => {
                this.bgImage = null;
                this.bgImageUrl = "";
                resolve();
            };
            img.src = next;
        });
    }

    getOptions(): CompositorOptions {
        return { ...this.options };
    }

    start(frameProvider: () => CaptureFrame[]) {
        this.frameProvider = frameProvider;
        if (this.running) return;
        this.running = true;
        this.lastFrameAt = 0;
        const loop = (now: number) => {
            if (!this.running) return;
            const minDelta = 1000 / Math.max(1, this.options.frameRate);
            if (now - this.lastFrameAt >= minDelta - 1) {
                this.renderOnce(this.frameProvider?.() ?? []);
                this.lastFrameAt = now;
                performanceMonitor.markCompositeFrame();
            } else {
                performanceMonitor.markDropped(0);
            }
            this.raf = requestAnimationFrame(loop);
        };
        this.raf = requestAnimationFrame(loop);
    }

    stop() {
        this.running = false;
        if (this.raf) cancelAnimationFrame(this.raf);
        this.raf = 0;
        this.frameProvider = null;
        this.stream?.getTracks().forEach(t => t.stop());
        this.stream = null;
    }

    /** Live MediaStream of the composite canvas for Discord / preview. */
    getOutputStream(): MediaStream {
        if (!this.stream || this.stream.getVideoTracks().some(t => t.readyState === "ended")) {
            this.stream = this.canvas.captureStream(this.options.frameRate);
            const track = this.stream.getVideoTracks()[0];
            if (track) track.contentHint = "detail";
        }
        return this.stream;
    }

    getVideoTrack(): MediaStreamTrack | null {
        return this.getOutputStream().getVideoTracks()[0] ?? null;
    }

    renderOnce(frames: CaptureFrame[]) {
        const width = this.canvas.width;
        const height = this.canvas.height;
        this.ctx.fillStyle = this.options.backgroundColor || "#000";
        this.ctx.fillRect(0, 0, width, height);
        if (this.bgImage?.naturalWidth) {
            const dest = computeBackgroundDest(
                this.options.backgroundImageFit || "fill",
                this.bgImage.naturalWidth,
                this.bgImage.naturalHeight,
                width,
                height,
                this.options.backgroundImageScale ?? 1,
                this.options.backgroundImageOffsetX ?? 0,
                this.options.backgroundImageOffsetY ?? 0
            );
            this.ctx.drawImage(this.bgImage, dest.x, dest.y, dest.w, dest.h);
        }

        if (!this.layout) return;

        const byId = new Map(frames.map(f => [f.monitorId, f]));
        const items = [...this.layout.monitors]
            .filter(m => m.visible && m.selected)
            .sort((a, b) => a.zIndex - b.zIndex);

        for (const item of items) {
            const frame = byId.get(item.monitorId);
            if (!frame) {
                this.drawPlaceholder(item);
                continue;
            }
            this.drawMonitor(item, frame);
        }
    }

    private drawPlaceholder(item: MonitorLayoutItem) {
        this.ctx.save();
        this.ctx.fillStyle = "#1a2238";
        this.ctx.fillRect(item.x, item.y, item.width, item.height);
        this.ctx.strokeStyle = "#3d4f7a";
        this.ctx.strokeRect(item.x + 0.5, item.y + 0.5, item.width - 1, item.height - 1);
        this.ctx.fillStyle = "#8fa3d1";
        this.ctx.font = "14px sans-serif";
        this.ctx.fillText(item.monitorId, item.x + 12, item.y + 28);
        this.ctx.restore();
    }

    private drawMonitor(item: MonitorLayoutItem, frame: CaptureFrame) {
        const crop = item.crop;
        const srcW = Math.max(1, frame.width - crop.left - crop.right);
        const srcH = Math.max(1, frame.height - crop.top - crop.bottom);
        const sx = crop.left;
        const sy = crop.top;

        this.ctx.save();
        if (item.rotationDeg) {
            const cx = item.x + item.width / 2;
            const cy = item.y + item.height / 2;
            this.ctx.translate(cx, cy);
            this.ctx.rotate((item.rotationDeg * Math.PI) / 180);
            this.ctx.translate(-cx, -cy);
        }

        const dest = computeDestRect(item, srcW, srcH, item.scaleMode);
        this.ctx.beginPath();
        this.ctx.rect(item.x, item.y, item.width, item.height);
        this.ctx.clip();
        this.ctx.drawImage(frame.source, sx, sy, srcW, srcH, dest.x, dest.y, dest.w, dest.h);
        this.ctx.restore();
    }
}

function computeDestRect(
    item: MonitorLayoutItem,
    srcW: number,
    srcH: number,
    mode: ScaleMode
): { x: number; y: number; w: number; h: number; } {
    if (mode === "stretch") {
        return { x: item.x, y: item.y, w: item.width, h: item.height };
    }
    const scale = mode === "fill"
        ? Math.max(item.width / srcW, item.height / srcH)
        : Math.min(item.width / srcW, item.height / srcH);
    const w = srcW * scale;
    const h = srcH * scale;
    return {
        x: item.x + (item.width - w) / 2,
        y: item.y + (item.height - h) / 2,
        w,
        h
    };
}

