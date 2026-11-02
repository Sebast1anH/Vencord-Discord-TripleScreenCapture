import { useEffect, useMemo, useRef, useState } from "react";
import { PreviewCompositor } from "./lib/compositor";
import { buildPreset } from "./lib/layouts";
import { DEMO_MONITORS, MockDisplayFeed } from "./lib/mockMonitors";
import type {
  LayoutDefinition,
  LayoutPresetId,
  MonitorLayoutItem,
  OutputSettings,
} from "./lib/types";

const PRESETS: Array<{ id: LayoutPresetId; label: string }> = [
  { id: "horizontal", label: "Horizontal" },
  { id: "vertical", label: "Vertical" },
  { id: "grid", label: "Grid" },
  { id: "primaryFocus", label: "Primary Focus" },
  { id: "pictureInPicture", label: "PiP" },
  { id: "physical", label: "Physical" },
];

const defaultOutput: OutputSettings = {
  width: 1920,
  height: 1080,
  frameRate: 30,
  backgroundColor: "#0b1020",
  snapToGrid: true,
  gridSize: 16,
  scaleModeDefault: "fit",
};

export default function App() {
  const [selectedIds, setSelectedIds] = useState(DEMO_MONITORS.map((m) => m.id));
  const [output, setOutput] = useState(defaultOutput);
  const [layout, setLayout] = useState<LayoutDefinition>(() =>
    buildPreset(
      "horizontal",
      DEMO_MONITORS,
      defaultOutput.width,
      defaultOutput.height,
      defaultOutput.scaleModeDefault,
      defaultOutput.backgroundColor
    )
  );
  const [selectedRect, setSelectedRect] = useState<string | null>(DEMO_MONITORS[0].id);
  const [fps, setFps] = useState(0);
  const [liveHint, setLiveHint] = useState("Simulated monitor feeds — compositor running locally");
  const [streaming, setStreaming] = useState(false);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const previewHostRef = useRef<HTMLDivElement | null>(null);
  const compositorRef = useRef<PreviewCompositor | null>(null);
  const feedsRef = useRef<Map<string, MockDisplayFeed>>(new Map());
  const dragRef = useRef<{
    type: "move" | "resize";
    id: string;
    ox: number;
    oy: number;
    start: MonitorLayoutItem;
  } | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const selectedMonitors = useMemo(
    () => DEMO_MONITORS.filter((m) => selectedIds.includes(m.id)),
    [selectedIds]
  );

  useEffect(() => {
    const feeds = new Map<string, MockDisplayFeed>();
    for (const monitor of DEMO_MONITORS) {
      const feed = new MockDisplayFeed(monitor);
      feed.start();
      feeds.set(monitor.id, feed);
    }
    feedsRef.current = feeds;

    const compositor = new PreviewCompositor(output.width, output.height);
    compositorRef.current = compositor;
    if (previewHostRef.current) {
      compositor.canvas.className = "h-full w-full object-contain";
      previewHostRef.current.appendChild(compositor.canvas);
    }
    compositor.setLayout(layout);
    compositor.setFrameRate(output.frameRate);
    compositor.start(() =>
      selectedIds
        .map((id) => {
          const feed = feedsRef.current.get(id);
          if (!feed) return null;
          return {
            monitorId: id,
            source: feed.canvas,
            width: feed.canvas.width,
            height: feed.canvas.height,
          };
        })
        .filter(Boolean) as Array<{
        monitorId: string;
        source: CanvasImageSource;
        width: number;
        height: number;
      }>
    );

    const fpsTimer = window.setInterval(() => setFps(compositor.fps), 500);

    return () => {
      window.clearInterval(fpsTimer);
      compositor.stop();
      feeds.forEach((f) => f.stop());
      compositor.canvas.remove();
    };
    // intentionally once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const compositor = compositorRef.current;
    if (!compositor) return;
    compositor.setSize(output.width, output.height);
    compositor.setFrameRate(output.frameRate);
  }, [output.width, output.height, output.frameRate]);

  useEffect(() => {
    compositorRef.current?.setLayout(layout);
  }, [layout]);

  const applyPreset = (preset: LayoutPresetId) => {
    const next = buildPreset(
      preset,
      selectedMonitors,
      output.width,
      output.height,
      output.scaleModeDefault,
      output.backgroundColor
    );
    setLayout(next);
  };

  useEffect(() => {
    setLayout((prev) => ({ ...prev, backgroundColor: output.backgroundColor }));
  }, [output.backgroundColor]);

  useEffect(() => {
    setLayout((prev) => {
      const preset = prev.preset === "custom" ? "horizontal" : prev.preset;
      return buildPreset(
        preset,
        selectedMonitors,
        output.width,
        output.height,
        output.scaleModeDefault,
        output.backgroundColor
      );
    });
  }, [selectedIds.join("|"), output.width, output.height, output.scaleModeDefault]);

  const toggleMonitor = (id: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) {
        if (prev.length === 1) return prev;
        return prev.filter((x) => x !== id);
      }
      return [...prev, id];
    });
  };

  const updateItem = (id: string, patch: Partial<MonitorLayoutItem>) => {
    setLayout((prev) => ({
      ...prev,
      preset: "custom",
      monitors: prev.monitors.map((m) => (m.monitorId === id ? { ...m, ...patch } : m)),
    }));
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    const stage = stageRef.current;
    if (!drag || !stage) return;
    const scaleX = layout.canvasWidth / stage.clientWidth;
    const scaleY = layout.canvasHeight / stage.clientHeight;
    const dx = (e.clientX - drag.ox) * scaleX;
    const dy = (e.clientY - drag.oy) * scaleY;
    if (drag.type === "move") {
      let x = drag.start.x + dx;
      let y = drag.start.y + dy;
      if (output.snapToGrid) {
        x = Math.round(x / output.gridSize) * output.gridSize;
        y = Math.round(y / output.gridSize) * output.gridSize;
      }
      updateItem(drag.id, { x, y });
    } else {
      let width = Math.max(80, drag.start.width + dx);
      let height = Math.max(45, drag.start.height + dy);
      if (drag.start.lockAspectRatio) {
        height = width / (drag.start.width / Math.max(1, drag.start.height));
      }
      if (output.snapToGrid) {
        width = Math.round(width / output.gridSize) * output.gridSize;
        height = Math.round(height / output.gridSize) * output.gridSize;
      }
      updateItem(drag.id, { width, height });
    }
  };

  const startPreviewStream = async () => {
    const compositor = compositorRef.current;
    const video = videoRef.current;
    if (!compositor || !video) return;
    const stream = compositor.captureStream(output.frameRate);
    video.srcObject = stream;
    await video.play();
    setStreaming(true);
    setLiveHint(
      "Local MediaStream active via canvas.captureStream(). In Discord + Vencord, DiscordStreamAdapter attaches this track to MediaEngine."
    );
  };

  const stopPreviewStream = () => {
    const video = videoRef.current;
    if (video?.srcObject) {
      (video.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    }
    setStreaming(false);
    setLiveHint("Simulated monitor feeds — compositor running locally");
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-[1400px] flex-col gap-6 px-4 py-6 md:px-8 md:py-8">
      <header className="relative overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--bg1)]/80 px-6 py-7 backdrop-blur">
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)",
            backgroundSize: "28px 28px",
          }}
        />
        <div className="relative flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="font-[family-name:var(--font-mono)] text-xs tracking-[0.22em] text-[var(--accent-2)] uppercase">
              Vencord plugin preview
            </p>
            <h1 className="mt-2 text-4xl font-bold tracking-tight text-white md:text-5xl">
              TripleScreen
            </h1>
            <p className="mt-2 max-w-2xl text-[var(--muted)]">
              Arrange three monitors on one canvas, composite them live, and feed a single stream into Discord.
              This preview runs the layout editor and compositor outside Discord.
            </p>
          </div>
          <div className="font-[family-name:var(--font-mono)] text-xs text-[var(--muted)]">
            {output.width}×{output.height} · {output.frameRate}fps · composite {fps}fps
          </div>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)_260px]">
        <section className="rounded-xl border border-[var(--line)] bg-[var(--bg1)]/90 p-4">
          <h2 className="mb-3 text-xs tracking-[0.16em] text-[var(--muted)] uppercase">Monitors</h2>
          <div className="space-y-2">
            {DEMO_MONITORS.map((monitor) => {
              const on = selectedIds.includes(monitor.id);
              return (
                <label
                  key={monitor.id}
                  className="grid cursor-pointer grid-cols-[10px_1fr_auto] items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--bg0)] px-3 py-3"
                >
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: monitor.color }} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{monitor.name}</span>
                    <span className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--muted)]">
                      {monitor.width}×{monitor.height}
                      {monitor.refreshRate ? ` · ${monitor.refreshRate}Hz` : ""}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggleMonitor(monitor.id)}
                    aria-label={`Select ${monitor.name}`}
                  />
                </label>
              );
            })}
          </div>
        </section>

        <section className="rounded-xl border border-[var(--line)] bg-[var(--bg1)]/90 p-4">
          <div className="mb-3 flex flex-wrap gap-2">
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyPreset(preset.id)}
                className={`rounded-md border px-3 py-1.5 text-xs ${
                  layout.preset === preset.id
                    ? "border-[var(--accent)] text-[var(--accent)]"
                    : "border-[var(--line)] text-[var(--muted)] hover:border-[var(--accent)]/50"
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div
            ref={stageRef}
            className="relative h-[380px] overflow-hidden rounded-lg border border-[var(--line)] bg-[#081018]"
            onPointerMove={onPointerMove}
            onPointerUp={() => {
              dragRef.current = null;
            }}
            onPointerLeave={() => {
              dragRef.current = null;
            }}
          >
            <div ref={previewHostRef} className="pointer-events-none absolute inset-0 opacity-90" />
            {layout.monitors.map((item) => (
              <div
                key={item.monitorId}
                className={`absolute border-2 ${
                  selectedRect === item.monitorId ? "border-sky-300" : "border-sky-500/80"
                } bg-sky-400/10`}
                style={{
                  left: `${(item.x / layout.canvasWidth) * 100}%`,
                  top: `${(item.y / layout.canvasHeight) * 100}%`,
                  width: `${(item.width / layout.canvasWidth) * 100}%`,
                  height: `${(item.height / layout.canvasHeight) * 100}%`,
                  zIndex: item.zIndex + 5,
                  transform: item.rotationDeg ? `rotate(${item.rotationDeg}deg)` : undefined,
                }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  setSelectedRect(item.monitorId);
                  dragRef.current = {
                    type: "move",
                    id: item.monitorId,
                    ox: e.clientX,
                    oy: e.clientY,
                    start: { ...item },
                  };
                }}
              >
                <div className="pointer-events-none px-2 pt-1 text-[11px] font-semibold text-white drop-shadow">
                  {DEMO_MONITORS.find((m) => m.id === item.monitorId)?.name ?? item.monitorId}
                </div>
                <div
                  className="absolute right-[-5px] bottom-[-5px] h-2.5 w-2.5 rounded-sm border border-sky-400 bg-white"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSelectedRect(item.monitorId);
                    dragRef.current = {
                      type: "resize",
                      id: item.monitorId,
                      ox: e.clientX,
                      oy: e.clientY,
                      start: { ...item },
                    };
                  }}
                />
              </div>
            ))}
          </div>

          {selectedRect && (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="text-xs text-[var(--muted)]">
                Scale mode
                <select
                  className="mt-1 w-full rounded-md border border-[var(--line)] bg-[var(--bg0)] px-2 py-2 text-sm text-white"
                  value={layout.monitors.find((m) => m.monitorId === selectedRect)?.scaleMode}
                  onChange={(e) =>
                    updateItem(selectedRect, {
                      scaleMode: e.target.value as MonitorLayoutItem["scaleMode"],
                    })
                  }
                >
                  <option value="fit">Fit</option>
                  <option value="fill">Fill</option>
                  <option value="stretch">Stretch</option>
                </select>
              </label>
              <label className="text-xs text-[var(--muted)]">
                Rotation
                <input
                  type="number"
                  min={-180}
                  max={180}
                  className="mt-1 w-full rounded-md border border-[var(--line)] bg-[var(--bg0)] px-2 py-2 text-sm text-white"
                  value={layout.monitors.find((m) => m.monitorId === selectedRect)?.rotationDeg ?? 0}
                  onChange={(e) => updateItem(selectedRect, { rotationDeg: Number(e.target.value) })}
                />
              </label>
            </div>
          )}
        </section>

        <section className="space-y-4">
          <div className="rounded-xl border border-[var(--line)] bg-[var(--bg1)]/90 p-4">
            <h2 className="mb-3 text-xs tracking-[0.16em] text-[var(--muted)] uppercase">Output</h2>
            <label className="mb-3 block text-xs text-[var(--muted)]">
              Resolution
              <select
                className="mt-1 w-full rounded-md border border-[var(--line)] bg-[var(--bg0)] px-2 py-2 text-sm text-white"
                value={`${output.width}x${output.height}`}
                onChange={(e) => {
                  const [width, height] = e.target.value.split("x").map(Number);
                  setOutput((o) => ({ ...o, width, height }));
                }}
              >
                <option value="1280x720">1280 × 720</option>
                <option value="1920x1080">1920 × 1080</option>
                <option value="2560x1440">2560 × 1440</option>
              </select>
            </label>
            <label className="mb-3 block text-xs text-[var(--muted)]">
              Frame rate
              <select
                className="mt-1 w-full rounded-md border border-[var(--line)] bg-[var(--bg0)] px-2 py-2 text-sm text-white"
                value={output.frameRate}
                onChange={(e) =>
                  setOutput((o) => ({
                    ...o,
                    frameRate: Number(e.target.value) as OutputSettings["frameRate"],
                  }))
                }
              >
                <option value={15}>15 FPS</option>
                <option value={30}>30 FPS</option>
                <option value={60}>60 FPS</option>
              </select>
            </label>
            <label className="mb-3 block text-xs text-[var(--muted)]">
              Background
              <input
                type="color"
                className="mt-1 h-10 w-full rounded-md border border-[var(--line)] bg-[var(--bg0)]"
                value={output.backgroundColor}
                onChange={(e) => setOutput((o) => ({ ...o, backgroundColor: e.target.value }))}
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
              <input
                type="checkbox"
                checked={output.snapToGrid}
                onChange={(e) => setOutput((o) => ({ ...o, snapToGrid: e.target.checked }))}
              />
              Snap to grid
            </label>
          </div>

          <div className="rounded-xl border border-[var(--line)] bg-[var(--bg1)]/90 p-4">
            <h2 className="mb-3 text-xs tracking-[0.16em] text-[var(--muted)] uppercase">
              Stream probe
            </h2>
            <video
              ref={videoRef}
              className="mb-3 aspect-video w-full rounded-md border border-[var(--line)] bg-black object-contain"
              muted
              playsInline
            />
            <p className="mb-3 font-[family-name:var(--font-mono)] text-[11px] leading-relaxed text-[var(--muted)]">
              {liveHint}
            </p>
            <div className="flex flex-wrap gap-2">
              {!streaming ? (
                <button
                  type="button"
                  onClick={() => void startPreviewStream()}
                  className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-[#041018]"
                >
                  Start local stream
                </button>
              ) : (
                <button
                  type="button"
                  onClick={stopPreviewStream}
                  className="rounded-md bg-[var(--danger)] px-3 py-2 text-sm font-semibold text-white"
                >
                  Stop local stream
                </button>
              )}
            </div>
          </div>
        </section>
      </div>

      <footer className="rounded-xl border border-[var(--line)] bg-[var(--bg1)]/70 px-4 py-3 font-[family-name:var(--font-mono)] text-[11px] text-[var(--muted)]">
        Plugin path: <code className="text-[var(--accent-2)]">src/userplugins/triplescreen/</code>
        {" · "}
        Feasibility: <code className="text-[var(--accent-2)]">docs/FEASIBILITY.md</code>
        {" · "}
        Copy the plugin folder into a Vencord source tree to run inside Discord Desktop.
      </footer>
    </div>
  );
}
