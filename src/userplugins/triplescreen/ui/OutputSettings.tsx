/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 TripleScreen contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from "@webpack/common";

import type { FrameRatePreset, OutputSettings, ScaleMode } from "../types";

interface Props {
    value: OutputSettings;
    onChange: (next: OutputSettings) => void;
}

export function OutputSettingsPanel({ value, onChange }: Props) {
    const patch = (partial: Partial<OutputSettings>) => onChange({ ...value, ...partial });

    return (
        <div className="triplescreen-panel">
            <h3>Output</h3>

            <div className="triplescreen-field">
                <label htmlFor="ts-res">Resolution</label>
                <select
                    id="ts-res"
                    value={value.resolutionPreset}
                    onChange={e => patch({ resolutionPreset: e.target.value as OutputSettings["resolutionPreset"] })}
                >
                    <option value="720p">1280 × 720</option>
                    <option value="1080p">1920 × 1080</option>
                    <option value="1440p">2560 × 1440</option>
                    <option value="custom">Custom</option>
                </select>
            </div>

            {value.resolutionPreset === "custom" && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <div className="triplescreen-field">
                        <label htmlFor="ts-w">Width</label>
                        <input
                            id="ts-w"
                            type="number"
                            min={320}
                            max={2560}
                            value={value.customWidth}
                            onChange={e => patch({ customWidth: Number(e.target.value) })}
                        />
                    </div>
                    <div className="triplescreen-field">
                        <label htmlFor="ts-h">Height</label>
                        <input
                            id="ts-h"
                            type="number"
                            min={180}
                            max={1440}
                            value={value.customHeight}
                            onChange={e => patch({ customHeight: Number(e.target.value) })}
                        />
                    </div>
                </div>
            )}

            <div className="triplescreen-field">
                <label htmlFor="ts-fps">Frame rate</label>
                <select
                    id="ts-fps"
                    value={value.frameRate}
                    onChange={e => patch({ frameRate: Number(e.target.value) as FrameRatePreset })}
                >
                    <option value={15}>15 FPS</option>
                    <option value={30}>30 FPS</option>
                    <option value={60}>60 FPS</option>
                </select>
            </div>

            <div className="triplescreen-field">
                <label htmlFor="ts-scale">Default scaling</label>
                <select
                    id="ts-scale"
                    value={value.scaleModeDefault}
                    onChange={e => patch({ scaleModeDefault: e.target.value as ScaleMode })}
                >
                    <option value="fit">Fit (letterbox)</option>
                    <option value="fill">Fill (crop)</option>
                    <option value="stretch">Stretch</option>
                </select>
            </div>

            <div className="triplescreen-field">
                <label htmlFor="ts-bg">Background</label>
                <input
                    id="ts-bg"
                    type="color"
                    value={normalizeColor(value.backgroundColor)}
                    onChange={e => patch({ backgroundColor: e.target.value })}
                />
            </div>

            <div className="triplescreen-field">
                <label>
                    <input
                        type="checkbox"
                        checked={value.includeSystemAudio}
                        onChange={e => patch({ includeSystemAudio: e.target.checked })}
                    />{" "}
                    Share system audio
                </label>
            </div>

            <div className="triplescreen-field">
                <label>
                    <input
                        type="checkbox"
                        checked={value.snapToGrid}
                        onChange={e => patch({ snapToGrid: e.target.checked })}
                    />{" "}
                    Snap to grid ({value.gridSize}px)
                </label>
            </div>

            <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>
                System audio captures your default playback mix (YouTube, games, browsers) and excludes Discord itself, so viewers should not hear call voice or themselves. Every selected monitor is scaled into this one frame. Discord can still cap video, usually at 720p without Nitro and 1080p with Nitro.
            </p>
        </div>
    );
}

function normalizeColor(color: string) {
    if (/^#[0-9a-fA-F]{6}$/.test(color)) return color;
    return "#0b1020";
}
