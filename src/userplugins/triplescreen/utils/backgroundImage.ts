/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 TripleScreen contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { BackgroundImageFit } from "../types";

export interface BackgroundDest {
    x: number;
    y: number;
    w: number;
    h: number;
}

/**
 * Where the background image is drawn inside the stream canvas.
 * `scale` multiplies the fitted size; offsets are % of the canvas size.
 */
export function computeBackgroundDest(
    fit: BackgroundImageFit,
    srcW: number,
    srcH: number,
    canvasW: number,
    canvasH: number,
    scale = 1,
    offsetXPct = 0,
    offsetYPct = 0
): BackgroundDest {
    const safeSrcW = Math.max(1, srcW);
    const safeSrcH = Math.max(1, srcH);
    let x = 0;
    let y = 0;
    let w = canvasW;
    let h = canvasH;

    if (fit === "stretch") {
        w = canvasW;
        h = canvasH;
    } else if (fit === "center") {
        w = safeSrcW;
        h = safeSrcH;
        x = (canvasW - w) / 2;
        y = (canvasH - h) / 2;
    } else {
        const base = fit === "fill"
            ? Math.max(canvasW / safeSrcW, canvasH / safeSrcH)
            : Math.min(canvasW / safeSrcW, canvasH / safeSrcH);
        w = safeSrcW * base;
        h = safeSrcH * base;
        x = (canvasW - w) / 2;
        y = (canvasH - h) / 2;
    }

    const mul = Math.max(0.25, Math.min(4, Number(scale) || 1));
    const scaledW = w * mul;
    const scaledH = h * mul;
    const ox = (Number(offsetXPct) || 0) / 100 * canvasW;
    const oy = (Number(offsetYPct) || 0) / 100 * canvasH;
    return {
        x: x + (w - scaledW) / 2 + ox,
        y: y + (h - scaledH) / 2 + oy,
        w: scaledW,
        h: scaledH
    };
}

/** Fraction of the image that intersects the stream frame (0–1). */
export function visibleImageCoverage(
    dest: BackgroundDest,
    canvasW: number,
    canvasH: number
): number {
    const left = Math.max(0, dest.x);
    const top = Math.max(0, dest.y);
    const right = Math.min(canvasW, dest.x + dest.w);
    const bottom = Math.min(canvasH, dest.y + dest.h);
    const visW = Math.max(0, right - left);
    const visH = Math.max(0, bottom - top);
    const destArea = Math.max(1, dest.w * dest.h);
    return Math.min(1, (visW * visH) / destArea);
}
