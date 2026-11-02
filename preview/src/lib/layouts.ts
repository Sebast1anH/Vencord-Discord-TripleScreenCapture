import type {
  LayoutDefinition,
  LayoutPresetId,
  MonitorInfo,
  MonitorLayoutItem,
  ScaleMode,
} from "./types";

const GAP = 24;

function item(
  monitor: MonitorInfo,
  x: number,
  y: number,
  width: number,
  height: number,
  zIndex: number,
  scaleMode: ScaleMode
): MonitorLayoutItem {
  return {
    monitorId: monitor.id,
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    zIndex,
    visible: true,
    selected: true,
    scaleMode,
    lockAspectRatio: true,
    rotationDeg: 0,
    crop: { top: 0, right: 0, bottom: 0, left: 0 },
  };
}

export function buildPreset(
  preset: LayoutPresetId,
  monitors: MonitorInfo[],
  canvasW: number,
  canvasH: number,
  scaleMode: ScaleMode,
  backgroundColor: string
): LayoutDefinition {
  const selected = monitors;
  let monitorsLayout: MonitorLayoutItem[] = [];

  switch (preset) {
    case "vertical": {
      const n = selected.length || 1;
      const cellH = (canvasH - GAP * (n + 1)) / n;
      const cellW = canvasW - GAP * 2;
      monitorsLayout = selected.map((m, i) =>
        item(m, GAP, GAP + i * (cellH + GAP), cellW, cellH, i, scaleMode)
      );
      break;
    }
    case "grid": {
      const n = selected.length || 1;
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      const cellW = (canvasW - GAP * (cols + 1)) / cols;
      const cellH = (canvasH - GAP * (rows + 1)) / rows;
      monitorsLayout = selected.map((m, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        return item(
          m,
          GAP + col * (cellW + GAP),
          GAP + row * (cellH + GAP),
          cellW,
          cellH,
          i,
          scaleMode
        );
      });
      break;
    }
    case "primaryFocus": {
      const [primary, ...rest] = selected;
      const mainW = canvasW * 0.68;
      monitorsLayout = [
        item(primary, GAP, GAP, mainW - GAP, canvasH - GAP * 2, 0, scaleMode),
      ];
      if (rest.length) {
        const sideW = canvasW - mainW - GAP;
        const sideH = (canvasH - GAP * (rest.length + 1)) / rest.length;
        rest.forEach((m, i) => {
          monitorsLayout.push(
            item(m, mainW, GAP + i * (sideH + GAP), sideW - GAP, sideH, i + 1, scaleMode)
          );
        });
      }
      break;
    }
    case "pictureInPicture": {
      const [main, second, third] = selected;
      monitorsLayout = [
        item(main, GAP, GAP, canvasW - GAP * 2, canvasH - GAP * 2, 0, scaleMode),
      ];
      if (second) {
        monitorsLayout.push(
          item(
            second,
            canvasW - canvasW * 0.28 - GAP,
            canvasH - canvasH * 0.28 - GAP,
            canvasW * 0.28,
            canvasH * 0.28,
            2,
            scaleMode
          )
        );
      }
      if (third) {
        monitorsLayout.push(
          item(third, GAP, canvasH - canvasH * 0.22 - GAP, canvasW * 0.22, canvasH * 0.22, 1, scaleMode)
        );
      }
      break;
    }
    case "physical": {
      const minX = Math.min(...selected.map((m) => m.bounds!.x));
      const minY = Math.min(...selected.map((m) => m.bounds!.y));
      const maxX = Math.max(...selected.map((m) => m.bounds!.x + m.bounds!.width));
      const maxY = Math.max(...selected.map((m) => m.bounds!.y + m.bounds!.height));
      const worldW = Math.max(1, maxX - minX);
      const worldH = Math.max(1, maxY - minY);
      const scale = Math.min((canvasW - GAP * 2) / worldW, (canvasH - GAP * 2) / worldH);
      const offsetX = (canvasW - worldW * scale) / 2;
      const offsetY = (canvasH - worldH * scale) / 2;
      monitorsLayout = selected.map((m, i) => {
        const b = m.bounds!;
        return item(
          m,
          offsetX + (b.x - minX) * scale,
          offsetY + (b.y - minY) * scale,
          b.width * scale,
          b.height * scale,
          i,
          scaleMode
        );
      });
      break;
    }
    case "horizontal":
    default: {
      const n = selected.length || 1;
      const cellW = (canvasW - GAP * (n + 1)) / n;
      const cellH = canvasH - GAP * 2;
      monitorsLayout = selected.map((m, i) =>
        item(m, GAP + i * (cellW + GAP), GAP, cellW, cellH, i, scaleMode)
      );
      break;
    }
  }

  return {
    id: `layout-${preset}`,
    name: preset,
    preset,
    canvasWidth: canvasW,
    canvasHeight: canvasH,
    backgroundColor,
    monitors: monitorsLayout,
  };
}
