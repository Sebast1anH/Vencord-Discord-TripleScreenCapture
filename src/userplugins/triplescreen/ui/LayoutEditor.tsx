/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 TripleScreen contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useCallback, useEffect, useRef, useState } from "@webpack/common";

import type { LayoutDefinition, LayoutPresetId, MonitorInfo, MonitorLayoutItem } from "../types";

interface Props {
    layout: LayoutDefinition;
    monitors: MonitorInfo[];
    previewCanvas?: HTMLCanvasElement | null;
    snapToGrid: boolean;
    gridSize: number;
    onChange: (layout: LayoutDefinition) => void;
    onPreset: (preset: LayoutPresetId) => void;
}

type DragMode = { type: "move" | "resize"; id: string; ox: number; oy: number; start: MonitorLayoutItem; };

const PRESETS: Array<{ id: LayoutPresetId; label: string; }> = [
    { id: "horizontal", label: "Horizontal" },
    { id: "vertical", label: "Vertical" },
    { id: "grid", label: "Grid" },
    { id: "primaryFocus", label: "Primary Focus" },
    { id: "pictureInPicture", label: "PiP" },
    { id: "physical", label: "Physical" }
];

export function LayoutEditor({
    layout,
    monitors,
    previewCanvas,
    snapToGrid,
    gridSize,
    onChange,
    onPreset
}: Props) {
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(layout.monitors[0]?.monitorId ?? null);
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const drag = useRef<DragMode | null>(null);

    useEffect(() => {
        const host = wrapRef.current;
        if (!host || !previewCanvas) return;
        previewCanvas.classList.add("triplescreen-preview");
        host.appendChild(previewCanvas);
        return () => {
            previewCanvas.classList.remove("triplescreen-preview");
            if (previewCanvas.parentElement === host) host.removeChild(previewCanvas);
        };
    }, [previewCanvas]);

    const nameOf = (id: string) => monitors.find(m => m.id === id)?.name ?? id;

    const updateItem = useCallback((monitorId: string, patch: Partial<MonitorLayoutItem>) => {
        onChange({
            ...layout,
            preset: "custom",
            monitors: layout.monitors.map(m => m.monitorId === monitorId ? { ...m, ...patch } : m)
        });
    }, [layout, onChange]);

    const onPointerDownMove = (e: React.PointerEvent, item: MonitorLayoutItem) => {
        e.preventDefault();
        e.stopPropagation();
        setSelectedId(item.monitorId);
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        drag.current = {
            type: "move",
            id: item.monitorId,
            ox: e.clientX,
            oy: e.clientY,
            start: { ...item }
        };
    };

    const onPointerDownResize = (e: React.PointerEvent, item: MonitorLayoutItem) => {
        e.preventDefault();
        e.stopPropagation();
        setSelectedId(item.monitorId);
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        drag.current = {
            type: "resize",
            id: item.monitorId,
            ox: e.clientX,
            oy: e.clientY,
            start: { ...item }
        };
    };

    const onPointerMove = (e: React.PointerEvent) => {
        const d = drag.current;
        if (!d) return;
        const scaleX = layout.canvasWidth / Math.max(1, wrapRef.current?.clientWidth ?? layout.canvasWidth);
        const scaleY = layout.canvasHeight / Math.max(1, wrapRef.current?.clientHeight ?? layout.canvasHeight);
        const dx = ((e.clientX - d.ox) / zoom) * scaleX;
        const dy = ((e.clientY - d.oy) / zoom) * scaleY;

        if (d.type === "move") {
            let x = d.start.x + dx;
            let y = d.start.y + dy;
            if (snapToGrid) {
                x = Math.round(x / gridSize) * gridSize;
                y = Math.round(y / gridSize) * gridSize;
            }
            updateItem(d.id, { x, y });
        } else {
            let width = Math.max(80, d.start.width + dx);
            let height = Math.max(45, d.start.height + dy);
            if (d.start.lockAspectRatio) {
                const aspect = d.start.width / Math.max(1, d.start.height);
                height = width / aspect;
            }
            if (snapToGrid) {
                width = Math.round(width / gridSize) * gridSize;
                height = Math.round(height / gridSize) * gridSize;
            }
            updateItem(d.id, { width, height });
        }
    };

    const onPointerUp = () => {
        drag.current = null;
    };

    const bringForward = () => {
        if (!selectedId) return;
        const maxZ = Math.max(...layout.monitors.map(m => m.zIndex), 0);
        updateItem(selectedId, { zIndex: maxZ + 1 });
    };

    const sendBack = () => {
        if (!selectedId) return;
        const minZ = Math.min(...layout.monitors.map(m => m.zIndex), 0);
        updateItem(selectedId, { zIndex: minZ - 1 });
    };

    const align = (axis: "h" | "v") => {
        const selected = layout.monitors.filter(m => m.selected || m.monitorId === selectedId);
        if (selected.length < 2) return;
        if (axis === "h") {
            const y = selected[0].y;
            onChange({
                ...layout,
                preset: "custom",
                monitors: layout.monitors.map(m => selected.some(s => s.monitorId === m.monitorId) ? { ...m, y } : m)
            });
        } else {
            const x = selected[0].x;
            onChange({
                ...layout,
                preset: "custom",
                monitors: layout.monitors.map(m => selected.some(s => s.monitorId === m.monitorId) ? { ...m, x } : m)
            });
        }
    };

    const toCss = (item: MonitorLayoutItem) => {
        const left = (item.x / layout.canvasWidth) * 100;
        const top = (item.y / layout.canvasHeight) * 100;
        const width = (item.width / layout.canvasWidth) * 100;
        const height = (item.height / layout.canvasHeight) * 100;
        return {
            left: `${left}%`,
            top: `${top}%`,
            width: `${width}%`,
            height: `${height}%`,
            zIndex: item.zIndex + 10,
            transform: item.rotationDeg ? `rotate(${item.rotationDeg}deg)` : undefined
        } as React.CSSProperties;
    };

    return (
        <div className="triplescreen-panel" style={{ display: "flex", flexDirection: "column" }}>
            <h3>Layout editor</h3>
            <div className="triplescreen-toolbar">
                {PRESETS.map(p => (
                    <button
                        key={p.id}
                        type="button"
                        className={layout.preset === p.id ? "active" : ""}
                        onClick={() => onPreset(p.id)}
                    >
                        {p.label}
                    </button>
                ))}
            </div>
            <div className="triplescreen-toolbar">
                <button type="button" onClick={() => setZoom(z => Math.min(2.5, z + 0.1))}>Zoom +</button>
                <button type="button" onClick={() => setZoom(z => Math.max(0.4, z - 0.1))}>Zoom −</button>
                <button type="button" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>Reset view</button>
                <button type="button" onClick={() => align("h")}>Align H</button>
                <button type="button" onClick={() => align("v")}>Align V</button>
                <button type="button" onClick={bringForward}>Bring forward</button>
                <button type="button" onClick={sendBack}>Send back</button>
            </div>

            <div
                ref={wrapRef}
                className="triplescreen-canvas-wrap"
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={onPointerUp}
                style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "center center" }}
            >
                {layout.monitors.filter(m => m.visible).map(item => (
                    <div
                        key={item.monitorId}
                        className={`triplescreen-rect${selectedId === item.monitorId ? " selected" : ""}`}
                        style={toCss(item)}
                        onPointerDown={e => onPointerDownMove(e, item)}
                    >
                        <div className="label">{nameOf(item.monitorId)}</div>
                        <div
                            className="triplescreen-handle"
                            onPointerDown={e => onPointerDownResize(e, item)}
                        />
                    </div>
                ))}
            </div>

            {selectedId && (
                <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <label className="triplescreen-field">
                        Scale mode
                        <select
                            value={layout.monitors.find(m => m.monitorId === selectedId)?.scaleMode}
                            onChange={e => updateItem(selectedId, { scaleMode: e.target.value as MonitorLayoutItem["scaleMode"] })}
                        >
                            <option value="fit">Fit</option>
                            <option value="fill">Fill</option>
                            <option value="stretch">Stretch</option>
                        </select>
                    </label>
                    <label className="triplescreen-field">
                        Rotation
                        <input
                            type="number"
                            min={-180}
                            max={180}
                            value={layout.monitors.find(m => m.monitorId === selectedId)?.rotationDeg ?? 0}
                            onChange={e => updateItem(selectedId, { rotationDeg: Number(e.target.value) })}
                        />
                    </label>
                    <label className="triplescreen-field" style={{ gridColumn: "1 / -1" }}>
                        <input
                            type="checkbox"
                            checked={!!layout.monitors.find(m => m.monitorId === selectedId)?.lockAspectRatio}
                            onChange={e => updateItem(selectedId, { lockAspectRatio: e.target.checked })}
                        />{" "}
                        Lock aspect ratio
                    </label>
                </div>
            )}
        </div>
    );
}
