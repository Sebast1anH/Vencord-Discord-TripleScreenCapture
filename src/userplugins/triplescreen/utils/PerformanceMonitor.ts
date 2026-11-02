/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 TripleScreen contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PerformanceSnapshot } from "../types";

type Listener = (snap: PerformanceSnapshot) => void;

export class PerformanceMonitor {
    private compositeFrames = 0;
    private droppedFrames = 0;
    private lastFpsSampleAt = performance.now();
    private compositeFps = 0;
    private outputWidth = 0;
    private outputHeight = 0;
    private lastError?: string;
    private monitorStats = new Map<string, { capturing: boolean; lastFrameAt: number; error?: string; }>();
    private listeners = new Set<Listener>();

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        listener(this.snapshot());
        return () => this.listeners.delete(listener);
    }

    setOutputSize(width: number, height: number) {
        this.outputWidth = width;
        this.outputHeight = height;
        this.emit();
    }

    markCompositeFrame() {
        this.compositeFrames += 1;
        const now = performance.now();
        const elapsed = now - this.lastFpsSampleAt;
        if (elapsed >= 1000) {
            this.compositeFps = Math.round((this.compositeFrames * 1000) / elapsed);
            this.compositeFrames = 0;
            this.lastFpsSampleAt = now;
            this.emit();
        }
    }

    markDropped(count = 1) {
        this.droppedFrames += count;
        this.emit();
    }

    setMonitorStatus(monitorId: string, capturing: boolean, error?: string) {
        const prev = this.monitorStats.get(monitorId);
        this.monitorStats.set(monitorId, {
            capturing,
            lastFrameAt: capturing ? performance.now() : (prev?.lastFrameAt ?? 0),
            error
        });
        this.emit();
    }

    markMonitorFrame(monitorId: string) {
        const prev = this.monitorStats.get(monitorId) ?? { capturing: true, lastFrameAt: 0 };
        this.monitorStats.set(monitorId, { ...prev, capturing: true, lastFrameAt: performance.now(), error: undefined });
    }

    setError(message?: string) {
        this.lastError = message;
        this.emit();
    }

    reset() {
        this.compositeFrames = 0;
        this.droppedFrames = 0;
        this.compositeFps = 0;
        this.lastError = undefined;
        this.monitorStats.clear();
        this.lastFpsSampleAt = performance.now();
        this.emit();
    }

    snapshot(): PerformanceSnapshot {
        const now = performance.now();
        return {
            compositeFps: this.compositeFps,
            droppedFrames: this.droppedFrames,
            outputWidth: this.outputWidth,
            outputHeight: this.outputHeight,
            lastError: this.lastError,
            monitors: [...this.monitorStats.entries()].map(([monitorId, stats]) => ({
                monitorId,
                capturing: stats.capturing,
                lastFrameAgeMs: stats.lastFrameAt ? Math.round(now - stats.lastFrameAt) : -1,
                error: stats.error
            }))
        };
    }

    private emit() {
        const snap = this.snapshot();
        for (const listener of this.listeners) listener(snap);
    }
}

export const performanceMonitor = new PerformanceMonitor();
