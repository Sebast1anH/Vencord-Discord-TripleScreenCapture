import type { LayoutDefinition, MonitorLayoutItem, ScaleMode } from "./types";

export interface Frame {
  monitorId: string;
  source: CanvasImageSource;
  width: number;
  height: number;
}

export class PreviewCompositor {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private layout: LayoutDefinition | null = null;
  private background = "#0b1020";
  private raf = 0;
  private running = false;
  private provider: (() => Frame[]) | null = null;
  private frameRate = 30;
  private last = 0;
  fps = 0;
  private framesCounted = 0;
  private fpsAt = performance.now();

  constructor(width: number, height: number) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D context unavailable");
    this.ctx = ctx;
  }

  setSize(width: number, height: number) {
    this.canvas.width = width;
    this.canvas.height = height;
  }

  setLayout(layout: LayoutDefinition) {
    this.layout = layout;
    this.background = layout.backgroundColor;
  }

  setFrameRate(fps: number) {
    this.frameRate = fps;
  }

  start(provider: () => Frame[]) {
    this.provider = provider;
    if (this.running) return;
    this.running = true;
    const loop = (now: number) => {
      if (!this.running) return;
      const minDelta = 1000 / this.frameRate;
      if (now - this.last >= minDelta - 1) {
        this.render(this.provider?.() ?? []);
        this.last = now;
        this.framesCounted += 1;
        if (now - this.fpsAt >= 1000) {
          this.fps = this.framesCounted;
          this.framesCounted = 0;
          this.fpsAt = now;
        }
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  captureStream(fps = this.frameRate) {
    return this.canvas.captureStream(fps);
  }

  private render(frames: Frame[]) {
    const { width, height } = this.canvas;
    this.ctx.fillStyle = this.background;
    this.ctx.fillRect(0, 0, width, height);
    if (!this.layout) return;
    const byId = new Map(frames.map((f) => [f.monitorId, f]));
    const items = [...this.layout.monitors]
      .filter((m) => m.visible && m.selected)
      .sort((a, b) => a.zIndex - b.zIndex);
    for (const item of items) {
      const frame = byId.get(item.monitorId);
      if (!frame) {
        this.placeholder(item);
        continue;
      }
      this.draw(item, frame);
    }
  }

  private placeholder(item: MonitorLayoutItem) {
    this.ctx.fillStyle = "#152033";
    this.ctx.fillRect(item.x, item.y, item.width, item.height);
    this.ctx.strokeStyle = "#35507a";
    this.ctx.strokeRect(item.x + 0.5, item.y + 0.5, item.width - 1, item.height - 1);
  }

  private draw(item: MonitorLayoutItem, frame: Frame) {
    const crop = item.crop;
    const srcW = Math.max(1, frame.width - crop.left - crop.right);
    const srcH = Math.max(1, frame.height - crop.top - crop.bottom);
    this.ctx.save();
    if (item.rotationDeg) {
      const cx = item.x + item.width / 2;
      const cy = item.y + item.height / 2;
      this.ctx.translate(cx, cy);
      this.ctx.rotate((item.rotationDeg * Math.PI) / 180);
      this.ctx.translate(-cx, -cy);
    }
    this.ctx.beginPath();
    this.ctx.rect(item.x, item.y, item.width, item.height);
    this.ctx.clip();
    const dest = destRect(item, srcW, srcH, item.scaleMode);
    this.ctx.drawImage(
      frame.source,
      crop.left,
      crop.top,
      srcW,
      srcH,
      dest.x,
      dest.y,
      dest.w,
      dest.h
    );
    this.ctx.restore();
  }
}

function destRect(
  item: MonitorLayoutItem,
  srcW: number,
  srcH: number,
  mode: ScaleMode
) {
  if (mode === "stretch") {
    return { x: item.x, y: item.y, w: item.width, h: item.height };
  }
  const scale =
    mode === "fill"
      ? Math.max(item.width / srcW, item.height / srcH)
      : Math.min(item.width / srcW, item.height / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return {
    x: item.x + (item.width - w) / 2,
    y: item.y + (item.height - h) / 2,
    w,
    h,
  };
}
