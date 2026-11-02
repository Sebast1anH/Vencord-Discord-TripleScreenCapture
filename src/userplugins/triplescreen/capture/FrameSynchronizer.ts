/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 TripleScreen contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { CaptureFrame } from "../types";
import { performanceMonitor } from "../utils/PerformanceMonitor";

interface Slot {
    monitorId: string;
    latest?: CaptureFrame;
    stallMs: number;
}

/**
 * Holds the newest frame per monitor. Perfect sync is not required —
 * the compositor reads the latest valid frame for each source every tick.
 */
export class FrameSynchronizer {
    private slots = new Map<string, Slot>();
    private stallThresholdMs = 1500;

    ensure(monitorId: string) {
        if (!this.slots.has(monitorId)) {
            this.slots.set(monitorId, { monitorId, stallMs: 0 });
        }
    }

    push(frame: CaptureFrame) {
        this.ensure(frame.monitorId);
        const slot = this.slots.get(frame.monitorId)!;
        slot.latest = frame;
        slot.stallMs = 0;
        performanceMonitor.markMonitorFrame(frame.monitorId);
    }

    remove(monitorId: string) {
        this.slots.delete(monitorId);
    }

    clear() {
        this.slots.clear();
    }

    /** Returns the newest frame for each tracked monitor. */
    sample(now = performance.now()): CaptureFrame[] {
        const frames: CaptureFrame[] = [];
        for (const slot of this.slots.values()) {
            if (!slot.latest) continue;
            const age = now - slot.latest.timestamp;
            if (age > this.stallThresholdMs) {
                slot.stallMs = age;
                performanceMonitor.setMonitorStatus(slot.monitorId, true, `Capture stall (${Math.round(age)}ms)`);
            }
            frames.push(slot.latest);
        }
        return frames;
    }

    ids(): string[] {
        return [...this.slots.keys()];
    }
}
