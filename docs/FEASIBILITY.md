# TripleScreen Phase 1 — Feasibility

## Problems

| Problem | Summary |
| --- | --- |
| **A — Capture & composite** | Enumerate displays, capture multiple screens, composite into one frame. |
| **B — Discord streaming injection** | Feed that composite into regular Discord Desktop’s native Go Live pipeline. |

Problem A is solvable in Chromium/Electron with permissions. Problem B is the primary risk.

## Runtime facts

1. **Regular Discord Desktop** encodes screen share through a native **MediaEngine** module (`setGoLiveSource` with desktop source ids such as `screen-handle:…`). It does **not** primarily use `navigator.mediaDevices.getDisplayMedia` for the outgoing encoder path.
2. **Vesktop** (Electron wrapper) *does* use `desktopCapturer` + `getDisplayMedia` and can tweak `conn.input.stream` video tracks after Go Live starts.
3. A canvas `captureStream()` track is **not** automatically a valid Discord screen-share source. Something must attach that track to MediaEngine’s connection input (or present a virtual display Discord already understands).
4. Standard **Vencord plugins** run in the renderer. `native.ts` can reach Node/Electron APIs over IPC, but cannot freely replace Discord’s MediaEngine binary.

## Chosen Phase 1 path

**Least invasive viable approach: MediaEngine track replacement**

1. Enumerate screens via `DiscordNative.desktopCapture.getDesktopCaptureSources`.
2. Capture each selected display with Electron `chromeMediaSource` / `chromeMediaSourceId` constraints (fallback: `getDisplayMedia`).
3. Composite on a canvas (`Compositor`) and expose `canvas.captureStream(fps)`.
4. When a local stream connection appears on `MediaEngineStore.getMediaEngine().connections`, replace `conn.input.stream`’s video track with the composite track.
5. Best-effort: set `videoStreamParameters` max resolution / frame rate (same idea Vesktop uses).

If no connection appears, TripleScreen keeps rendering locally (**preview-only** mode) and instructs the user to start a normal Discord screen share so the adapter can attach.

## Alternatives evaluated

| Approach | Pros | Cons |
| --- | --- | --- |
| Patch `getUserMedia` / `getDisplayMedia` | Easy in browsers / Vesktop | Regular Discord MediaEngine bypasses these for Go Live |
| Virtual display / helper window | Discord shares a normal source | Extra native process, OS permissions, more invasive |
| Replace MediaEngine | Full control | Unsupported, brittle, high maintenance |
| Track replacement after connect | Uses existing session, viewers need nothing | Depends on `conn.input.stream` remaining a replaceable `MediaStream` |

## Capture limits

- Simultaneous multi-display capture depends on Discord/Electron allowing multiple `chromeMediaSource` streams. If the runtime serializes capture, TripleScreen will surface a clear error instead of a black frame.
- Output resolution / FPS are **requests**. Discord’s negotiated encoder settings may clamp them (commonly 720p30 / 1080p30 / 1080p60 depending on Nitro and client).
- Viewers never need TripleScreen — they receive a normal Discord stream.

## Success criteria for Phase 1 prototype

- [x] Plugin module layout matching Vencord `userplugins` conventions
- [x] Multi-monitor enumeration + capture manager
- [x] Canvas compositor + `captureStream` output
- [x] Discord adapter implementing track-replacement with preview-only fallback
- [x] Layout presets + editor + settings persistence
- [ ] Validated on a live Discord Desktop + Vencord install with three physical monitors (requires user hardware)

## What to verify on a real machine

1. Install the plugin into a source Vencord tree and rebuild.
2. Join a voice channel, open **Share Multiple Monitors**.
3. Confirm three screens enumerate with stable ids across restart.
4. Start composite, then start Discord Go Live if not auto-connected.
5. Confirm remote viewers see all selected monitors in one stream.
6. Stop sharing and confirm capture tracks end (`chrome://webrtc-internals` or Discord logs).
7. Confirm normal single-monitor share still works with the plugin enabled but idle.
