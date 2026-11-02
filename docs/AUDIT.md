# TripleScreen audit — 2026-11-02

Full review of `src/userplugins/triplescreen` after the picker / capture fixes.

## Architecture (current)

1. User opens Discord Screen Share → **TripleScreen** tab → layout editor.
2. **Start** opens a native Electron **TripleScreen Output** window that captures each selected monitor via `getUserMedia(chromeMediaSourceId)` and composites onto a canvas.
3. `GoLiveGuard` points Discord `MediaEngine.setGoLiveSource` at that window (`getMediaSourceId`), with Windows system audio via `soundshareId: 1`.
4. Closing the output window (or Discord ending the stream) tears the composite down.

## Findings

| ID | Severity | Status | Finding |
|----|----------|--------|---------|
| A1 | Critical | Fixed earlier | Stream picker detector required “Share Your Screen” / Screens-Windows labels; Discord now uses Applications / Entire Screen / Devices with no title match. |
| A2 | Critical | Fixed earlier | Output page used a `data:` URL → `navigator.mediaDevices` undefined → all monitor captures failed. Now loads `file://` temp HTML. |
| A3 | High | **Fixed this pass** | Stream-end watcher could tear down immediately: Discord often reports no active stream for a few seconds after go-live. Added 5s guard + 2 consecutive empty polls; watch only when go-live succeeded. |
| A4 | High | **Fixed this pass** | Go-live still started when output capture returned 0 videos (black stream). Now closes the output window and returns failure. |
| A5 | High | **Fixed this pass** | Capture session permission handlers allowed *all* permissions. Restricted to media / display-capture. |
| A6 | Medium | **Fixed this pass** | Editor preview ran a second full `getUserMedia` capture per monitor while the output window already captured them (2× GPU). Skipped when native helpers exist. |
| A7 | Medium | **Fixed this pass** | `configureOutput` awaited a rejected `pageReady` and threw instead of returning `{ ok: false }`. |
| A8 | Low | **Fixed this pass** | Dead `last` variable in output page script; unused `UserStore` import. |
| A9 | Low | Accepted | Minimize parking uses a short PowerShell `SetWindowPos` helper (numeric HWND only). Preferable long-term: native addon / `koffi`, but out of scope. |
| A10 | Low | Accepted | Picker tab injection is DOM-based (MutationObserver), not a webpack patch — may need retuning if Discord redesigns the segmented control again. |
| A11 | Info | Open | Preview canvas in the layout editor stays static during a live session (by design after A6). Thumbnails + output window remain the live sources. |
| A12 | Info | Open | Frame-rate / resolution still negotiated by Discord; plugin requests settings but cannot guarantee encoder output. |

## Verification checklist

- [x] Plugin enabled; native helpers present
- [x] TripleScreen tab injects into Applications / Entire Screen / Devices picker
- [x] Output page has `navigator.mediaDevices.getUserMedia`
- [x] `configureOutput` can return `{ ok: true, videos: N }`
- [ ] Manual: Start composite in voice → viewers see all monitors; FPS matches setting approximately
- [ ] Manual: Minimize output window → stream stays painted (parked, not minimized blank)
- [ ] Manual: Close output window → TripleScreen stops; `/triplescreen` works again
- [ ] Manual: System audio = full Windows mix when setting enabled

## Files touched this pass

- `streaming/DiscordStreamAdapter.ts` — stream-end guard, abort on zero videos, skip duplicate capture
- `native.ts` — permission narrowing, safer `configureOutput`, screen id allow-list tweak
- `docs/AUDIT.md` — this document
