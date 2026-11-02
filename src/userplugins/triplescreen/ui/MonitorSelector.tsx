/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 TripleScreen contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from "@webpack/common";

import type { MonitorInfo } from "../types";

interface Props {
    monitors: MonitorInfo[];
    selectedIds: string[];
    onChange: (ids: string[]) => void;
    onRefresh: () => void;
}

export function MonitorSelector({ monitors, selectedIds, onChange, onRefresh }: Props) {
    const toggle = (id: string) => {
        if (selectedIds.includes(id)) onChange(selectedIds.filter(x => x !== id));
        else onChange([...selectedIds, id]);
    };

    return (
        <div className="triplescreen-panel">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h3>Monitors ({selectedIds.length}/{monitors.length})</h3>
                <button type="button" onClick={onRefresh}>Refresh</button>
            </div>
            <div className="triplescreen-toolbar">
                <button type="button" onClick={() => onChange(monitors.map(m => m.id))}>Select all</button>
                <button type="button" onClick={() => onChange([])}>Clear</button>
            </div>
            {!monitors.length && (
                <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    No displays found yet. Click Refresh after Discord finishes loading capture sources.
                </p>
            )}
            {monitors.map(monitor => {
                const checked = selectedIds.includes(monitor.id);
                return (
                    <div
                        key={monitor.id}
                        className={`triplescreen-monitor-card${checked ? " selected" : ""}`}
                        role="checkbox"
                        aria-checked={checked}
                        tabIndex={0}
                        onClick={event => {
                            event.preventDefault();
                            event.stopPropagation();
                            toggle(monitor.id);
                        }}
                        onKeyDown={event => {
                            if (event.key === " " || event.key === "Enter") {
                                event.preventDefault();
                                toggle(monitor.id);
                            }
                        }}
                    >
                        {monitor.thumbnailDataUrl
                            ? <img src={monitor.thumbnailDataUrl} alt="" />
                            : <div className="triplescreen-monitor-thumb" />}
                        <div className="triplescreen-monitor-meta">
                            <strong>{monitor.name}</strong>
                            <span>
                                {monitor.width} × {monitor.height}
                                {monitor.refreshRate ? ` · ${monitor.refreshRate} Hz` : ""}
                                {monitor.isPrimary ? " · Primary" : ""}
                            </span>
                        </div>
                        <input
                            type="checkbox"
                            checked={checked}
                            readOnly
                            tabIndex={-1}
                            aria-label={`Select ${monitor.name}`}
                        />
                    </div>
                );
            })}
        </div>
    );
}
