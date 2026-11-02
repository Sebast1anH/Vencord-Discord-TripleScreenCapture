/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 TripleScreen contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type ScaleMode = "fit" | "fill" | "stretch";

export type OutputResolutionPreset = "720p" | "1080p" | "1440p" | "custom";

export type FrameRatePreset = 15 | 30 | 60;

export type LayoutPresetId =
    | "horizontal"
    | "vertical"
    | "grid"
    | "primaryFocus"
    | "pictureInPicture"
    | "physical"
    | "custom";

export interface MonitorInfo {
    /** Stable identifier when the OS / Discord provides one. */
    id: string;
    name: string;
    width: number;
    height: number;
    refreshRate?: number;
    /** Whether this display is the OS primary. */
    isPrimary?: boolean;
    /** OS clockwise rotation in degrees (0 / 90 / 180 / 270). */
    rotation?: number;
    /** Fallback chromeMediaSourceIds if the primary id fails on this machine. */
    altIds?: string[];
    /** Approximate OS desktop bounds when available. */
    bounds?: { x: number; y: number; width: number; height: number; };
    thumbnailDataUrl?: string;
}

export interface MonitorLayoutItem {
    monitorId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    zIndex: number;
    visible: boolean;
    selected: boolean;
    scaleMode: ScaleMode;
    lockAspectRatio: boolean;
    rotationDeg: number;
    crop: { top: number; right: number; bottom: number; left: number; };
}

export interface LayoutDefinition {
    id: string;
    name: string;
    preset: LayoutPresetId;
    canvasWidth: number;
    canvasHeight: number;
    backgroundColor: string;
    monitors: MonitorLayoutItem[];
    updatedAt: number;
}

/** How a custom background image is drawn behind the monitor mosaic. */
export type BackgroundImageFit = ScaleMode | "center";

export interface OutputSettings {
    resolutionPreset: OutputResolutionPreset;
    customWidth: number;
    customHeight: number;
    frameRate: FrameRatePreset;
    scaleModeDefault: ScaleMode;
    backgroundColor: string;
    /** Compressed data URL (image/jpeg|png|webp) or empty when using solid color only. */
    backgroundImageDataUrl: string;
    backgroundImageFit: BackgroundImageFit;
    /** Extra scale on top of fit (0.25–4). */
    backgroundImageScale: number;
    /** Horizontal pan as % of canvas width (−100…100). */
    backgroundImageOffsetX: number;
    /** Vertical pan as % of canvas height (−100…100). */
    backgroundImageOffsetY: number;
    snapToGrid: boolean;
    gridSize: number;
    includeSystemAudio: boolean;
}

export interface PerformanceSnapshot {
    compositeFps: number;
    droppedFrames: number;
    outputWidth: number;
    outputHeight: number;
    monitors: Array<{
        monitorId: string;
        capturing: boolean;
        lastFrameAgeMs: number;
        error?: string;
    }>;
    lastError?: string;
}

export interface TripleScreenSessionState {
    active: boolean;
    layoutId: string;
    selectedMonitorIds: string[];
    startedAt?: number;
}

export interface CaptureFrame {
    monitorId: string;
    /** Video frame source (HTMLVideoElement, ImageBitmap, or canvas). */
    source: CanvasImageSource;
    width: number;
    height: number;
    timestamp: number;
}

export interface DiscordDesktopSource {
    id: string;
    name: string;
    url?: string;
    display_id?: string;
}

declare global {
    interface Window {
        DiscordNative?: {
            desktopCapture?: {
                getDesktopCaptureSources: (options: {
                    types: Array<"screen" | "window">;
                    thumbnailSize?: { width: number; height: number; };
                }) => Promise<DiscordDesktopSource[]>;
            };
            process?: {
                platform: string;
            };
        };
    }
}
