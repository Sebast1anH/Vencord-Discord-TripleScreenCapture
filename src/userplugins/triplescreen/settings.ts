/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 TripleScreen contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import type { FrameRatePreset, LayoutDefinition, OutputSettings, ScaleMode } from "./types";

export const DEFAULT_OUTPUT: OutputSettings = {
    resolutionPreset: "1080p",
    customWidth: 1920,
    customHeight: 1080,
    frameRate: 30,
    scaleModeDefault: "fit",
    backgroundColor: "#0b1020",
    snapToGrid: true,
    gridSize: 16,
    includeSystemAudio: true
};

export function resolveOutputSize(settings: OutputSettings): { width: number; height: number; } {
    switch (settings.resolutionPreset) {
        case "720p":
            return { width: 1280, height: 720 };
        case "1440p":
            return { width: 2560, height: 1440 };
        case "custom":
            return {
                width: Math.max(320, Math.min(2560, Math.round(settings.customWidth) || 1920)),
                height: Math.max(180, Math.min(1440, Math.round(settings.customHeight) || 1080))
            };
        case "1080p":
        default:
            return { width: 1920, height: 1080 };
    }
}

export const settings = definePluginSettings({
    resolutionPreset: {
        type: OptionType.SELECT,
        description: "Composite output resolution sent toward Discord's encoder",
        options: [
            { label: "1280 × 720", value: "720p" },
            { label: "1920 × 1080", value: "1080p", default: true },
            { label: "2560 × 1440", value: "1440p" },
            { label: "Custom", value: "custom" }
        ]
    },
    customWidth: {
        type: OptionType.NUMBER,
        description: "Custom output width (when Resolution is Custom)",
        default: 1920
    },
    customHeight: {
        type: OptionType.NUMBER,
        description: "Custom output height (when Resolution is Custom)",
        default: 1080
    },
    frameRate: {
        type: OptionType.SELECT,
        description: "Target composite frame rate (subject to Discord negotiation)",
        options: [
            { label: "15 FPS", value: 15 },
            { label: "30 FPS", value: 30, default: true },
            { label: "60 FPS", value: 60 }
        ]
    },
    scaleModeDefault: {
        type: OptionType.SELECT,
        description: "Default scaling when placing a monitor on the canvas",
        options: [
            { label: "Fit (letterbox)", value: "fit" as ScaleMode, default: true },
            { label: "Fill (crop)", value: "fill" as ScaleMode },
            { label: "Stretch", value: "stretch" as ScaleMode }
        ]
    },
    backgroundColor: {
        type: OptionType.STRING,
        description: "Background color for empty canvas regions",
        default: "#0b1020"
    },
    snapToGrid: {
        type: OptionType.BOOLEAN,
        description: "Snap monitor rectangles to the layout grid",
        default: true
    },
    gridSize: {
        type: OptionType.NUMBER,
        description: "Layout grid size in pixels",
        default: 16
    },
    includeSystemAudio: {
        type: OptionType.BOOLEAN,
        description: "Share Windows system audio (YouTube/games/etc.) and exclude Discord voice from the stream",
        default: true
    },
    showPerformanceOverlay: {
        type: OptionType.BOOLEAN,
        description: "Show capture / FPS diagnostics while configuring",
        default: true
    },
    showChatBarButton: {
        type: OptionType.BOOLEAN,
        description: "Also show a TripleScreen button next to the chat bar",
        default: false,
        restartNeeded: true
    },
    lastLayoutId: {
        type: OptionType.STRING,
        description: "Last used layout id",
        default: "default-horizontal",
        hidden: true
    },
    savedLayoutsJson: {
        type: OptionType.STRING,
        description: "Serialized custom layouts",
        default: "[]",
        hidden: true
    },
    selectedMonitorIdsJson: {
        type: OptionType.STRING,
        description: "Last selected monitor ids",
        default: "[]",
        hidden: true
    }
}).withPrivateSettings<{
    /** Transient runtime flag — not persisted intentionally via hidden strings above */
}>();

export function normalizeFrameRate(value: unknown): FrameRatePreset {
    const n = typeof value === "number" ? value : Number(value);
    if (n >= 45) return 60;
    if (n >= 20) return 30;
    return 15;
}

export function readOutputSettings(): OutputSettings {
    const store = settings.store;
    return {
        resolutionPreset: store.resolutionPreset as OutputSettings["resolutionPreset"],
        customWidth: store.customWidth,
        customHeight: store.customHeight,
        frameRate: normalizeFrameRate(store.frameRate),
        scaleModeDefault: store.scaleModeDefault as ScaleMode,
        backgroundColor: store.backgroundColor || DEFAULT_OUTPUT.backgroundColor,
        snapToGrid: store.snapToGrid,
        gridSize: store.gridSize || 16,
        includeSystemAudio: store.includeSystemAudio !== false
    };
}

export function loadSavedLayouts(): LayoutDefinition[] {
    try {
        const parsed = JSON.parse(settings.store.savedLayoutsJson || "[]");
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((item): item is LayoutDefinition =>
            item
            && typeof item === "object"
            && typeof item.id === "string"
            && typeof item.name === "string"
            && Array.isArray(item.monitors)
        );
    } catch {
        return [];
    }
}

export function persistLayouts(layouts: LayoutDefinition[]) {
    settings.store.savedLayoutsJson = JSON.stringify(layouts);
}

export function loadSelectedMonitorIds(): string[] {
    try {
        const parsed = JSON.parse(settings.store.selectedMonitorIdsJson || "[]");
        return Array.isArray(parsed) ? parsed.filter(id => typeof id === "string") : [];
    } catch {
        return [];
    }
}

export function persistSelectedMonitorIds(ids: string[]) {
    settings.store.selectedMonitorIdsJson = JSON.stringify(ids);
}
