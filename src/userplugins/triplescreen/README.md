# TripleScreen

Custom Vencord plugin that captures multiple monitors, lets you arrange them on a virtual canvas, and shares the composite as one Discord stream.

Viewers do **not** need TripleScreen installed.

## Install (Discord Desktop + Vencord from source)

1. Clone and set up [Vencord](https://docs.vencord.dev/installing/) from source.
2. Copy this folder to `Vencord/src/userplugins/triplescreen/`.
3. Build Vencord (`pnpm build` / `npm run build` per upstream docs) and restart Discord.
4. Enable **TripleScreen** under Settings → Vencord → Plugins.

## Usage

1. Join a voice channel or call.
2. Open TripleScreen via:
   - Vencord Toolbox → **TripleScreen layout**
   - Slash command `/triplescreen`
   - Voice context menu → **Share Multiple Monitors**
3. Select monitors, pick a layout preset or drag/resize on the canvas.
4. Click **Start composite stream**.
5. If Discord has not opened a Go Live connection yet, start screen share once — TripleScreen replaces the outgoing video track with the composite when MediaEngine exposes `conn.input.stream`.
6. **Stop TripleScreen** (or stop Discord sharing) to release capture resources.

## Architecture

See the module tree under this folder and [`docs/FEASIBILITY.md`](../../../docs/FEASIBILITY.md) for Phase 1 streaming integration details.

## Limits

- Discord may clamp resolution / FPS below the requested output settings.
- Track replacement depends on Discord’s MediaEngine connection exposing a replaceable `MediaStream`. If a client update removes that hook, TripleScreen falls back to local preview and logs diagnostics — normal single-monitor sharing remains available.
- Do not promise arbitrary encoder settings Discord cannot negotiate.
