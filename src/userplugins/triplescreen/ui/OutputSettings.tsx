/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 TripleScreen contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React, useEffect, useRef, useState } from "@webpack/common";

import { encodeBackgroundImageFile, resolveOutputSize } from "../settings";
import type { BackgroundImageFit, FrameRatePreset, OutputSettings, ScaleMode } from "../types";
import { computeBackgroundDest, visibleImageCoverage } from "../utils/backgroundImage";

interface Props {
    value: OutputSettings;
    onChange: (next: OutputSettings) => void;
}

export function OutputSettingsPanel({ value, onChange }: Props) {
    const patch = (partial: Partial<OutputSettings>) => onChange({ ...value, ...partial });
    const fileRef = useRef<HTMLInputElement | null>(null);
    const [imageError, setImageError] = useState<string | null>(null);
    const [imageBusy, setImageBusy] = useState(false);

    const onPickImage = async (file: File | undefined) => {
        if (!file) return;
        setImageBusy(true);
        setImageError(null);
        try {
            const dataUrl = await encodeBackgroundImageFile(file);
            patch({
                backgroundImageDataUrl: dataUrl,
                backgroundImageScale: 1,
                backgroundImageOffsetX: 0,
                backgroundImageOffsetY: 0
            });
        } catch (err) {
            setImageError(err instanceof Error ? err.message : String(err));
        } finally {
            setImageBusy(false);
            if (fileRef.current) fileRef.current.value = "";
        }
    };

    const clearImage = () => {
        setImageError(null);
        patch({
            backgroundImageDataUrl: "",
            backgroundImageScale: 1,
            backgroundImageOffsetX: 0,
            backgroundImageOffsetY: 0
        });
    };

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
                <label htmlFor="ts-bg">Background color</label>
                <input
                    id="ts-bg"
                    type="color"
                    value={normalizeColor(value.backgroundColor)}
                    onChange={e => patch({ backgroundColor: e.target.value })}
                />
            </div>

            <div className="triplescreen-field">
                <label>Background image</label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                    <input
                        ref={fileRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        style={{ display: "none" }}
                        onChange={e => void onPickImage(e.target.files?.[0])}
                    />
                    <button type="button" disabled={imageBusy} onClick={() => fileRef.current?.click()}>
                        {imageBusy ? "Loading…" : value.backgroundImageDataUrl ? "Replace image" : "Choose image"}
                    </button>
                    {value.backgroundImageDataUrl ? (
                        <button type="button" className="danger" disabled={imageBusy} onClick={clearImage}>
                            Clear
                        </button>
                    ) : null}
                </div>
                {imageError ? (
                    <p style={{ fontSize: 11, color: "var(--text-danger, #f23f43)", margin: "6px 0 0" }}>
                        {imageError}
                    </p>
                ) : null}
            </div>

            {value.backgroundImageDataUrl ? (
                <>
                    <div className="triplescreen-field">
                        <label htmlFor="ts-bg-fit">Fit mode</label>
                        <select
                            id="ts-bg-fit"
                            value={value.backgroundImageFit}
                            onChange={e => patch({ backgroundImageFit: e.target.value as BackgroundImageFit })}
                        >
                            <option value="fill">Fill (crop to frame)</option>
                            <option value="fit">Fit (letterbox)</option>
                            <option value="stretch">Stretch</option>
                            <option value="center">Center (1:1 pixels)</option>
                        </select>
                    </div>

                    <div className="triplescreen-field">
                        <label htmlFor="ts-bg-zoom">
                            Resize {Math.round(value.backgroundImageScale * 100)}%
                        </label>
                        <input
                            id="ts-bg-zoom"
                            type="range"
                            min={25}
                            max={300}
                            step={1}
                            value={Math.round(value.backgroundImageScale * 100)}
                            onChange={e => patch({ backgroundImageScale: Number(e.target.value) / 100 })}
                        />
                    </div>

                    <div className="triplescreen-field">
                        <label htmlFor="ts-bg-ox">Pan X {Math.round(value.backgroundImageOffsetX)}%</label>
                        <input
                            id="ts-bg-ox"
                            type="range"
                            min={-100}
                            max={100}
                            step={1}
                            value={value.backgroundImageOffsetX}
                            onChange={e => patch({ backgroundImageOffsetX: Number(e.target.value) })}
                        />
                    </div>

                    <div className="triplescreen-field">
                        <label htmlFor="ts-bg-oy">Pan Y {Math.round(value.backgroundImageOffsetY)}%</label>
                        <input
                            id="ts-bg-oy"
                            type="range"
                            min={-100}
                            max={100}
                            step={1}
                            value={value.backgroundImageOffsetY}
                            onChange={e => patch({ backgroundImageOffsetY: Number(e.target.value) })}
                        />
                    </div>

                    <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                        <button
                            type="button"
                            onClick={() => patch({
                                backgroundImageScale: 1,
                                backgroundImageOffsetX: 0,
                                backgroundImageOffsetY: 0
                            })}
                        >
                            Reset transform
                        </button>
                    </div>

                    <BackgroundStreamPreview value={value} />
                </>
            ) : null}

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
                The preview frame matches your stream resolution. System audio pins Discord soundshareId 1 on the
                Output window share (desktop mix, not call echo). Every selected monitor stays in the mosaic.
                Discord still caps video (often 720p without Nitro, 1080p with Nitro).
            </p>
        </div>
    );
}

function BackgroundStreamPreview({ value }: { value: OutputSettings; }) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [coverage, setCoverage] = useState(1);
    const size = resolveOutputSize(value);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !value.backgroundImageDataUrl) return;
        let cancelled = false;
        const img = new Image();
        img.onload = () => {
            if (cancelled) return;
            const maxPreviewW = 280;
            const scale = Math.min(1, maxPreviewW / size.width);
            const pw = Math.max(1, Math.round(size.width * scale));
            const ph = Math.max(1, Math.round(size.height * scale));
            canvas.width = pw;
            canvas.height = ph;
            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            ctx.fillStyle = normalizeColor(value.backgroundColor);
            ctx.fillRect(0, 0, pw, ph);
            const dest = computeBackgroundDest(
                value.backgroundImageFit,
                img.naturalWidth,
                img.naturalHeight,
                pw,
                ph,
                value.backgroundImageScale,
                value.backgroundImageOffsetX,
                value.backgroundImageOffsetY
            );
            ctx.drawImage(img, dest.x, dest.y, dest.w, dest.h);
            // Stream frame border
            ctx.strokeStyle = "rgba(255,255,255,0.85)";
            ctx.lineWidth = 2;
            ctx.strokeRect(1, 1, pw - 2, ph - 2);
            // Hatch area outside the image (letterbox) already shows bg color.
            // Dim anything of the image that spills outside? Clip already by canvas.
            const fullDest = computeBackgroundDest(
                value.backgroundImageFit,
                img.naturalWidth,
                img.naturalHeight,
                size.width,
                size.height,
                value.backgroundImageScale,
                value.backgroundImageOffsetX,
                value.backgroundImageOffsetY
            );
            setCoverage(visibleImageCoverage(fullDest, size.width, size.height));
        };
        img.src = value.backgroundImageDataUrl;
        return () => { cancelled = true; };
    }, [
        value.backgroundImageDataUrl,
        value.backgroundImageFit,
        value.backgroundImageScale,
        value.backgroundImageOffsetX,
        value.backgroundImageOffsetY,
        value.backgroundColor,
        size.width,
        size.height
    ]);

    const pct = Math.round(coverage * 100);

    return (
        <div className="triplescreen-field">
            <label>On-stream preview ({size.width}×{size.height})</label>
            <canvas
                ref={canvasRef}
                style={{
                    width: "100%",
                    maxWidth: 280,
                    height: "auto",
                    display: "block",
                    borderRadius: 6,
                    border: "1px solid var(--background-modifier-accent, #3f4147)",
                    background: "#000"
                }}
            />
            <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "6px 0 0" }}>
                {pct >= 99
                    ? "Full image fits inside the stream frame."
                    : `${pct}% of the scaled image is visible on stream (rest is cropped outside the frame).`}
            </p>
        </div>
    );
}

function normalizeColor(color: string) {
    if (/^#[0-9a-fA-F]{6}$/.test(color)) return color;
    return "#0b1020";
}
