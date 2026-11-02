# TripleScreen

Custom **Vencord** plugin for Discord Desktop that captures multiple monitors, lets you arrange them on a virtual canvas, and shares the result as **one** Discord stream.

Viewers do not need the plugin.

## What’s in this repo

| Path | Purpose |
| --- | --- |
| `src/userplugins/triplescreen/` | Vencord userplugin (copy into a Vencord source tree) |
| `preview/` | Browser demo of the layout editor + compositor |
| `docs/FEASIBILITY.md` | Phase 1 findings on Discord MediaEngine integration |

## Quick start — layout preview

```bash
cd preview
npm install
npm run dev
```

Open the printed local URL (default [http://127.0.0.1:47321](http://127.0.0.1:47321)).

## Install into Discord + Vencord

1. Install [Vencord from source](https://docs.vencord.dev/installing/).
2. Copy `src/userplugins/triplescreen` → `Vencord/src/userplugins/triplescreen`.
3. Rebuild Vencord and restart Discord.
4. Enable **TripleScreen** in Settings → Vencord → Plugins.

Open the UI from:

- Vencord Toolbox → **TripleScreen layout**
- Slash command `/triplescreen`
- Voice context menu → **Share Multiple Monitors**

## How streaming works

1. Capture each selected display (`DiscordNative` sources + Electron `chromeMediaSource`, with `getDisplayMedia` fallback).
2. Composite frames on a canvas (`Compositor`).
3. Expose `canvas.captureStream()`.
4. Attach the composite video track to Discord’s MediaEngine connection (`conn.input.stream`) when Go Live is active.

See [docs/FEASIBILITY.md](docs/FEASIBILITY.md) for limits, alternatives, and what still needs hardware validation.

## Privacy

Capture starts only after an explicit user action. Frames are not uploaded to any service outside the Discord session you start. Stopping the stream releases capture tracks.
