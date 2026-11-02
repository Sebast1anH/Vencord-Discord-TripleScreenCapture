/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 TripleScreen contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { loadSavedLayouts, persistLayouts, readOutputSettings, resolveOutputSize } from "../settings";
import type {
    LayoutDefinition,
    LayoutPresetId,
    MonitorInfo,
    MonitorLayoutItem,
    ScaleMode
} from "../types";

const GAP = 24;

export class LayoutManager {
    private layouts: LayoutDefinition[] = [];
    private activeId: string;

    constructor() {
        this.layouts = loadSavedLayouts();
        if (!this.layouts.length) {
            this.layouts = [];
        }
        this.activeId = this.layouts[0]?.id ?? "default-horizontal";
    }

    list(): LayoutDefinition[] {
        return this.layouts.map(l => structuredClone(l));
    }

    getActive(): LayoutDefinition | null {
        return this.layouts.find(l => l.id === this.activeId) ?? null;
    }

    setActive(id: string) {
        if (this.layouts.some(l => l.id === id)) this.activeId = id;
    }

    upsert(layout: LayoutDefinition) {
        const idx = this.layouts.findIndex(l => l.id === layout.id);
        const next = { ...layout, updatedAt: Date.now() };
        if (idx >= 0) this.layouts[idx] = next;
        else this.layouts.push(next);
        this.activeId = next.id;
        this.persist();
    }

    remove(id: string) {
        this.layouts = this.layouts.filter(l => l.id !== id);
        if (this.activeId === id) this.activeId = this.layouts[0]?.id ?? "";
        this.persist();
    }

    persist() {
        persistLayouts(this.layouts);
    }

    applyPreset(
        preset: LayoutPresetId,
        monitors: MonitorInfo[],
        selectedIds: string[],
        scaleMode: ScaleMode = "fit"
    ): LayoutDefinition {
        const output = resolveOutputSize(readOutputSettings());
        const selected = monitors.filter(m => selectedIds.includes(m.id));
        const items = buildPresetItems(preset, selected, output.width, output.height, scaleMode);
        const layout: LayoutDefinition = {
            id: `preset-${preset}-${Date.now()}`,
            name: presetLabel(preset),
            preset,
            canvasWidth: output.width,
            canvasHeight: output.height,
            backgroundColor: readOutputSettings().backgroundColor,
            monitors: items,
            updatedAt: Date.now()
        };
        this.upsert(layout);
        return structuredClone(layout);
    }

    ensureDefault(monitors: MonitorInfo[], selectedIds: string[]): LayoutDefinition {
        const existing = this.getActive();
        if (existing && existing.monitors.length) {
            return this.reconcileWithMonitors(existing, monitors, selectedIds);
        }
        return this.applyPreset("horizontal", monitors, selectedIds);
    }

    reconcileWithMonitors(
        layout: LayoutDefinition,
        monitors: MonitorInfo[],
        selectedIds: string[]
    ): LayoutDefinition {
        const available = new Set(monitors.map(m => m.id));
        const scaleMode = readOutputSettings().scaleModeDefault;
        const kept = layout.monitors.filter(m => available.has(m.monitorId));
        const keptIds = new Set(kept.map(m => m.monitorId));

        for (const id of selectedIds) {
            if (keptIds.has(id)) {
                const item = kept.find(m => m.monitorId === id)!;
                item.selected = true;
                item.visible = true;
                continue;
            }
            const monitor = monitors.find(m => m.id === id);
            if (!monitor) continue;
            kept.push(createItem(monitor, kept.length * 40, kept.length * 40, 480, 270, kept.length, scaleMode, true));
        }

        for (const item of kept) {
            if (!selectedIds.includes(item.monitorId)) {
                item.selected = false;
            }
        }

        const next = { ...layout, monitors: kept, updatedAt: Date.now(), preset: "custom" as LayoutPresetId };
        this.upsert(next);
        return structuredClone(next);
    }
}

function presetLabel(preset: LayoutPresetId): string {
    switch (preset) {
        case "horizontal": return "Horizontal";
        case "vertical": return "Vertical";
        case "grid": return "Grid";
        case "primaryFocus": return "Primary Focus";
        case "pictureInPicture": return "Picture-in-Picture";
        case "physical": return "Physical Arrangement";
        default: return "Custom";
    }
}

function createItem(
    monitor: MonitorInfo,
    x: number,
    y: number,
    width: number,
    height: number,
    zIndex: number,
    scaleMode: ScaleMode,
    selected: boolean
): MonitorLayoutItem {
    return {
        monitorId: monitor.id,
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
        zIndex,
        visible: true,
        selected,
        scaleMode,
        lockAspectRatio: true,
        rotationDeg: 0,
        crop: { top: 0, right: 0, bottom: 0, left: 0 }
    };
}

function buildPresetItems(
    preset: LayoutPresetId,
    monitors: MonitorInfo[],
    canvasW: number,
    canvasH: number,
    scaleMode: ScaleMode
): MonitorLayoutItem[] {
    if (!monitors.length) return [];

    switch (preset) {
        case "vertical":
            return layoutVertical(monitors, canvasW, canvasH, scaleMode);
        case "grid":
            return layoutGrid(monitors, canvasW, canvasH, scaleMode);
        case "primaryFocus":
            return layoutPrimaryFocus(monitors, canvasW, canvasH, scaleMode);
        case "pictureInPicture":
            return layoutPip(monitors, canvasW, canvasH, scaleMode);
        case "physical":
            return layoutPhysical(monitors, canvasW, canvasH, scaleMode);
        case "horizontal":
        case "custom":
        default:
            return layoutHorizontal(monitors, canvasW, canvasH, scaleMode);
    }
}

function layoutHorizontal(monitors: MonitorInfo[], canvasW: number, canvasH: number, scaleMode: ScaleMode) {
    const n = monitors.length;
    const totalGap = GAP * (n + 1);
    const cellW = (canvasW - totalGap) / n;
    const cellH = canvasH - GAP * 2;
    return monitors.map((m, i) =>
        createItem(m, GAP + i * (cellW + GAP), GAP, cellW, cellH, i, scaleMode, true)
    );
}

function layoutVertical(monitors: MonitorInfo[], canvasW: number, canvasH: number, scaleMode: ScaleMode) {
    const n = monitors.length;
    const totalGap = GAP * (n + 1);
    const cellH = (canvasH - totalGap) / n;
    const cellW = canvasW - GAP * 2;
    return monitors.map((m, i) =>
        createItem(m, GAP, GAP + i * (cellH + GAP), cellW, cellH, i, scaleMode, true)
    );
}

function layoutGrid(monitors: MonitorInfo[], canvasW: number, canvasH: number, scaleMode: ScaleMode) {
    const n = monitors.length;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const cellW = (canvasW - GAP * (cols + 1)) / cols;
    const cellH = (canvasH - GAP * (rows + 1)) / rows;
    return monitors.map((m, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        return createItem(
            m,
            GAP + col * (cellW + GAP),
            GAP + row * (cellH + GAP),
            cellW,
            cellH,
            i,
            scaleMode,
            true
        );
    });
}

function layoutPrimaryFocus(monitors: MonitorInfo[], canvasW: number, canvasH: number, scaleMode: ScaleMode) {
    const [primary, ...rest] = monitors;
    const mainW = canvasW * 0.68;
    const items = [
        createItem(primary, GAP, GAP, mainW - GAP, canvasH - GAP * 2, 0, scaleMode, true)
    ];
    if (!rest.length) return items;
    const sideW = canvasW - mainW - GAP;
    const sideH = (canvasH - GAP * (rest.length + 1)) / rest.length;
    rest.forEach((m, i) => {
        items.push(createItem(m, mainW, GAP + i * (sideH + GAP), sideW - GAP, sideH, i + 1, scaleMode, true));
    });
    return items;
}

function layoutPip(monitors: MonitorInfo[], canvasW: number, canvasH: number, scaleMode: ScaleMode) {
    const [main, second, third] = monitors;
    const items = [
        createItem(main, GAP, GAP, canvasW - GAP * 2, canvasH - GAP * 2, 0, scaleMode, true)
    ];
    if (second) {
        items.push(createItem(
            second,
            canvasW - canvasW * 0.28 - GAP,
            canvasH - canvasH * 0.28 - GAP,
            canvasW * 0.28,
            canvasH * 0.28,
            2,
            scaleMode,
            true
        ));
    }
    if (third) {
        items.push(createItem(
            third,
            GAP,
            canvasH - canvasH * 0.22 - GAP,
            canvasW * 0.22,
            canvasH * 0.22,
            1,
            scaleMode,
            true
        ));
    }
    return items;
}

function layoutPhysical(monitors: MonitorInfo[], canvasW: number, canvasH: number, scaleMode: ScaleMode) {
    const withBounds = monitors.filter(m => m.bounds);
    if (withBounds.length < monitors.length) {
        return layoutHorizontal(monitors, canvasW, canvasH, scaleMode);
    }
    const minX = Math.min(...withBounds.map(m => m.bounds!.x));
    const minY = Math.min(...withBounds.map(m => m.bounds!.y));
    const maxX = Math.max(...withBounds.map(m => m.bounds!.x + m.bounds!.width));
    const maxY = Math.max(...withBounds.map(m => m.bounds!.y + m.bounds!.height));
    const worldW = Math.max(1, maxX - minX);
    const worldH = Math.max(1, maxY - minY);
    const scale = Math.min((canvasW - GAP * 2) / worldW, (canvasH - GAP * 2) / worldH);
    const offsetX = (canvasW - worldW * scale) / 2;
    const offsetY = (canvasH - worldH * scale) / 2;

    return monitors.map((m, i) => {
        const b = m.bounds!;
        return createItem(
            m,
            offsetX + (b.x - minX) * scale,
            offsetY + (b.y - minY) * scale,
            b.width * scale,
            b.height * scale,
            i,
            scaleMode,
            true
        );
    });
}

export const layoutManager = new LayoutManager();
