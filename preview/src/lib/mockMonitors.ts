import type { MonitorInfo } from "./types";

export const DEMO_MONITORS: MonitorInfo[] = [
  {
    id: "screen:0",
    name: "Monitor 1 — Ultrawide desk",
    width: 2560,
    height: 1440,
    refreshRate: 144,
    isPrimary: true,
    color: "#3d9cff",
    bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  },
  {
    id: "screen:1",
    name: "Monitor 2 — Code",
    width: 1920,
    height: 1080,
    refreshRate: 60,
    color: "#26c7a0",
    bounds: { x: 2560, y: 180, width: 1920, height: 1080 },
  },
  {
    id: "screen:2",
    name: "Monitor 3 — Chat / refs",
    width: 1920,
    height: 1080,
    refreshRate: 75,
    color: "#f0b429",
    bounds: { x: 4480, y: 180, width: 1920, height: 1080 },
  },
];

/** Animated fake desktop content for each monitor. */
export class MockDisplayFeed {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private t0 = performance.now();
  private monitor: MonitorInfo;

  constructor(monitor: MonitorInfo) {
    this.monitor = monitor;
    this.canvas = document.createElement("canvas");
    this.canvas.width = Math.min(monitor.width, 1280);
    this.canvas.height = Math.min(monitor.height, 720);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable");
    this.ctx = ctx;
  }

  start() {
    const tick = (now: number) => {
      this.draw((now - this.t0) / 1000);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }

  private draw(t: number) {
    const { width: w, height: h } = this.canvas;
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, shade(this.monitor.color, -40));
    g.addColorStop(1, shade(this.monitor.color, -70));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // Window chrome mockups
    for (let i = 0; i < 3; i++) {
      const x = 40 + i * (w * 0.22) + Math.sin(t + i) * 8;
      const y = 50 + i * 28 + Math.cos(t * 0.8 + i) * 6;
      const ww = w * 0.28;
      const hh = h * 0.34;
      ctx.fillStyle = "rgba(8,12,20,0.72)";
      roundRect(ctx, x, y, ww, hh, 10);
      ctx.fill();
      ctx.fillStyle = this.monitor.color;
      ctx.fillRect(x, y, ww, 18);
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.font = "12px IBM Plex Mono, monospace";
      ctx.fillText(`${this.monitor.name.split("—")[0].trim()} · pane ${i + 1}`, x + 10, y + 13);
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      for (let line = 0; line < 6; line++) {
        ctx.fillRect(x + 14, y + 36 + line * 16, ww * (0.4 + ((line + i) % 3) * 0.15), 8);
      }
    }

    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "600 22px Space Grotesk, sans-serif";
    ctx.fillText(this.monitor.name, 28, h - 36);
    ctx.font = "13px IBM Plex Mono, monospace";
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText(
      `${this.monitor.width}×${this.monitor.height} @ ${this.monitor.refreshRate ?? 60}Hz`,
      28,
      h - 14
    );
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function shade(hex: string, amount: number) {
  const n = hex.replace("#", "");
  const num = parseInt(n, 16);
  const r = clamp(((num >> 16) & 255) + amount);
  const g = clamp(((num >> 8) & 255) + amount);
  const b = clamp((num & 255) + amount);
  return `rgb(${r},${g},${b})`;
}

function clamp(v: number) {
  return Math.max(0, Math.min(255, v));
}
