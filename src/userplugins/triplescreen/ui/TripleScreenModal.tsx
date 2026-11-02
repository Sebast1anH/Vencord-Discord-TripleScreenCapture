/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 TripleScreen contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, openModal } from "@utils/modal";
import { React, useEffect, useMemo, useRef, useState } from "@webpack/common";

import { displayCaptureManager } from "../capture/DisplayCaptureManager";
import { layoutManager } from "../layouts/LayoutManager";
import {
    loadSelectedMonitorIds,
    persistSelectedMonitorIds,
    readOutputSettings,
    settings
} from "../settings";
import { discordStreamAdapter } from "../streaming/DiscordStreamAdapter";
import type { LayoutDefinition, LayoutPresetId, MonitorInfo, OutputSettings, PerformanceSnapshot } from "../types";
import { performanceMonitor } from "../utils/PerformanceMonitor";
import { LayoutEditor } from "./LayoutEditor";
import { MonitorSelector } from "./MonitorSelector";
import { OutputSettingsPanel } from "./OutputSettings";

import "./styles.css";

const logger = new Logger("TripleScreen:UI");

function statusLabel(status: ReturnType<typeof discordStreamAdapter.getStatus>, fallback: string) {
    if (status.state === "idle") return "Not streaming";
    if (status.state === "preparing") return "Starting the Discord stream…";
    if (status.state === "error") return status.message;
    if (status.state === "streaming" && status.mode === "preview-only") {
        return "Preview only. Join a voice channel, then press Start composite stream.";
    }
    if (status.state === "streaming") {
        return "Live. Viewers see the TripleScreen Output window (all selected monitors). System audio uses Discord’s full mix when enabled.";
    }
    return fallback;
}

function TripleScreenModal({ modalProps }: { modalProps: ModalProps; }) {
    const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
    const [selectedIds, setSelectedIds] = useState<string[]>(loadSelectedMonitorIds());
    const [output, setOutput] = useState<OutputSettings>(readOutputSettings());
    const [layout, setLayout] = useState<LayoutDefinition | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [statusText, setStatusText] = useState("Idle");
    const [perf, setPerf] = useState<PerformanceSnapshot | null>(null);
    const showPerf = settings.use(["showPerformanceOverlay"]).showPerformanceOverlay;
    const rootRef = useRef<HTMLDivElement | null>(null);

    const previewCanvas = useMemo(
        () => discordStreamAdapter.getCompositor()?.canvas ?? null,
        // re-read when status changes
        [statusText]
    );

    const refreshMonitors = async () => {
        try {
            const list = await displayCaptureManager.enumerateMonitors();
            setMonitors(list);
            setSelectedIds(prev => {
                const valid = prev.filter(id => list.some(m => m.id === id));
                if (valid.length) return valid;
                return list.slice(0, Math.min(3, list.length)).map(m => m.id);
            });
            setError(null);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            logger.error(err);
        }
    };

    useEffect(() => {
        void refreshMonitors();
        const unsubPerf = performanceMonitor.subscribe(setPerf);
        const unsubStatus = discordStreamAdapter.subscribe(status => {
            setStatusText(statusLabel(status, "Not streaming"));
        });
        return () => {
            unsubPerf();
            unsubStatus();
        };
    }, []);

    useEffect(() => {
        if (!monitors.length) return;
        const next = layoutManager.ensureDefault(monitors, selectedIds);
        setLayout(next);
    }, [monitors, selectedIds.join("|")]);

    useEffect(() => {
        persistSelectedMonitorIds(selectedIds);
    }, [selectedIds]);

    const applyOutputToSettings = (next: OutputSettings) => {
        setOutput(next);
        settings.store.resolutionPreset = next.resolutionPreset;
        settings.store.customWidth = next.customWidth;
        settings.store.customHeight = next.customHeight;
        settings.store.frameRate = next.frameRate;
        settings.store.scaleModeDefault = next.scaleModeDefault;
        settings.store.backgroundColor = next.backgroundColor;
        settings.store.backgroundImageDataUrl = next.backgroundImageDataUrl || "";
        settings.store.backgroundImageFit = next.backgroundImageFit;
        settings.store.backgroundImageScale = next.backgroundImageScale;
        settings.store.backgroundImageOffsetX = next.backgroundImageOffsetX;
        settings.store.backgroundImageOffsetY = next.backgroundImageOffsetY;
        settings.store.snapToGrid = next.snapToGrid;
        settings.store.gridSize = next.gridSize;
        settings.store.includeSystemAudio = next.includeSystemAudio;
        const liveLayout = layout;
        if (discordStreamAdapter.getStatus().state === "streaming" && liveLayout) {
            discordStreamAdapter.updateLayout(liveLayout);
        }
    };

    const onPreset = (preset: LayoutPresetId) => {
        const next = layoutManager.applyPreset(preset, monitors, selectedIds, output.scaleModeDefault);
        setLayout(next);
        if (discordStreamAdapter.getStatus().state === "streaming") {
            discordStreamAdapter.updateLayout(next);
        }
    };

    const onLayoutChange = (next: LayoutDefinition) => {
        setLayout(next);
        layoutManager.upsert(next);
        if (discordStreamAdapter.getStatus().state === "streaming") {
            discordStreamAdapter.updateLayout(next);
        }
    };

    const start = async () => {
        if (!layout) return;
        setBusy(true);
        setError(null);
        try {
            await discordStreamAdapter.start(selectedIds, layout);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
        } finally {
            setBusy(false);
        }
    };

    const stop = async () => {
        setBusy(true);
        try {
            await discordStreamAdapter.stop();
        } finally {
            setBusy(false);
        }
    };

    return (
        <ModalRoot {...modalProps} size="large">
            <ModalHeader>
                <div className="triplescreen-header" style={{ width: "100%" }}>
                    <div>
                        <h2>Share Multiple Monitors</h2>
                        <p>Select every monitor you want in the mosaic, arrange the layout, then press Start. Closing the TripleScreen Output window stops the stream.</p>
                    </div>
                    <ModalCloseButton onClick={modalProps.onClose} />
                </div>
            </ModalHeader>
            <ModalContent>
                <div className="triplescreen-root" data-triplescreen-root="" ref={rootRef}>
                    <div className={`triplescreen-status ${error ? "error" : "ok"}`}>
                        {error ?? statusText}
                    </div>
                    <div className="triplescreen-grid">
                        <div className="triplescreen-monitors">
                            <MonitorSelector
                                monitors={monitors}
                                selectedIds={selectedIds}
                                onChange={setSelectedIds}
                                onRefresh={() => void refreshMonitors()}
                            />
                        </div>
                        {layout && (
                            <div className="triplescreen-stage">
                                <LayoutEditor
                                    layout={layout}
                                    monitors={monitors}
                                    previewCanvas={previewCanvas}
                                    snapToGrid={output.snapToGrid}
                                    gridSize={output.gridSize}
                                    onChange={onLayoutChange}
                                    onPreset={onPreset}
                                />
                            </div>
                        )}
                        <div className="triplescreen-side">
                            <OutputSettingsPanel value={output} onChange={applyOutputToSettings} />
                            {showPerf && perf && (
                                <div className="triplescreen-panel">
                                    <h3>Performance</h3>
                                    <div className="triplescreen-perf">
                                        {`Output ${perf.outputWidth}×${perf.outputHeight}\n`}
                                        {`Composite FPS ${perf.compositeFps}\n`}
                                        {`Dropped ${perf.droppedFrames}\n`}
                                        {perf.monitors.map(m =>
                                            `${m.monitorId}: ${m.capturing ? "live" : "off"} age=${m.lastFrameAgeMs}ms${m.error ? ` err=${m.error}` : ""}`
                                        ).join("\n")}
                                        {perf.lastError ? `\n${perf.lastError}` : ""}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </ModalContent>
            <ModalFooter>
                <div className="triplescreen-actions" style={{ width: "100%" }}>
                    <button type="button" onClick={modalProps.onClose}>Close</button>
                    <button type="button" className="danger" disabled={busy} onClick={() => void stop()}>
                        Stop TripleScreen
                    </button>
                    <button type="button" className="primary" disabled={busy || !selectedIds.length} onClick={() => void start()}>
                        {busy ? "Working…" : "Start composite stream"}
                    </button>
                </div>
            </ModalFooter>
        </ModalRoot>
    );
}

export function openTripleScreenModal() {
    openModal(modalProps => <TripleScreenModal modalProps={modalProps} />);
}
