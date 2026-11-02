export type ScaleMode = "fit" | "fill" | "stretch";
export type LayoutPresetId =
  | "horizontal"
  | "vertical"
  | "grid"
  | "primaryFocus"
  | "pictureInPicture"
  | "physical"
  | "custom";

export interface MonitorInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  refreshRate?: number;
  isPrimary?: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  color: string;
}

export interface MonitorLayoutItem {
  monitorId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  visible: boolean;
  selected: boolean;
  scaleMode: ScaleMode;
  lockAspectRatio: boolean;
  rotationDeg: number;
  crop: { top: number; right: number; bottom: number; left: number };
}

export interface LayoutDefinition {
  id: string;
  name: string;
  preset: LayoutPresetId;
  canvasWidth: number;
  canvasHeight: number;
  backgroundColor: string;
  monitors: MonitorLayoutItem[];
}

export interface OutputSettings {
  width: number;
  height: number;
  frameRate: 15 | 30 | 60;
  backgroundColor: string;
  snapToGrid: boolean;
  gridSize: number;
  scaleModeDefault: ScaleMode;
}
