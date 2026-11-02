# TripleScreen audit — 2026-11-02 (full pass)

Review of `src/userplugins/triplescreen` after stage-monitor system audio and composite teardown fixes.

## Architecture (current)

1. User opens Discord Screen Share → **TripleScreen** tab (or modal / slash / context menu).
2. **Start** opens native **TripleScreen Output**:
   - **Video only:** floating `window:` share of the output BrowserWindow.
   - **System audio (Windows):** fullscreen composite on a **stage** monitor; Discord go-live uses that `screen:…` id with `soundshareId: 1` (Entire Screen path — Discord process excluded from the mix).
3. Output page (`file://` temp HTML) captures each mosaic monitor via `getUserMedia(chromeMediaSourceId)` and paints a canvas.
4. `GoLiveGuard` owns `setGoLiveSource` while streaming; closing the output window or a durable stream-end signal tears the composite down.

## Findings

| ID | Severity | Status | Finding |
|----|----------|--------|---------|
| B1 | High | **Fixed** | Output compositor always painted at 60 Hz (`setInterval(1000/60)`); `cfg.fps` ignored → wasted GPU and mismatched user FPS setting. Now `armDraw(cfg.fps)`. |
| B2 | High | **Fixed** | `streamStillLive()` treated *any* MediaEngine `stream` connection as alive, so the composite could linger after Discord moved the encoder off TripleScreen (or never tear down cleanly). Now requires native-share ownership and matching `goLiveSourceIdentifier` when present. |
| B3 | High | **Fixed** | Switching stage ↔ window mode reused a BrowserWindow created with the wrong `frame` / fullscreen chrome (constructor-only options). Mode changes now `destroy()` and recreate the window. |
| B4 | Medium | **Fixed** | Ended desktop-capture tracks removed their video and stayed black until the next layout apply. Track `onended` now re-calls `ensureVideo`. |
| B5 | Medium | **Fixed** | `installGoLiveGuard` re-subscribed `STREAM_DELETE` / `STREAM_CLOSE` on every call (duplicate handlers after plugin reload). Guarded with `streamEventsBound`. |
| B6 | Medium | **Fixed** | Status / settings copy still said viewers always see the Output *window*; with system audio they see the stage screen. Updated modal + plugin about text; added `stage-screen` injection mode. |
| B7 | Medium | **Fixed** | `lowerBehind` HWND path did not validate numeric-only before PowerShell interpolation (defense in depth). |
| B8 | Low | **Fixed** | Dead `reapplyTimer` field after removing delayed second `beginNativeShare`. |
| B9 | Low | Accepted | Minimize parking still uses short PowerShell `SetWindowPos` (HWND digits only). Native addon preferred long-term. |
| B10 | Low | Accepted | Picker tab is DOM/`MutationObserver` based — may need retuning if Discord redesigns the segmented control. |
| B11 | Info | Open | When system audio steals a selected monitor as stage, that display is omitted from the mosaic (no auto-reflow of remaining tiles — custom layouts keep their positions). |
| B12 | Info | Open | Discord still caps encoder resolution/FPS (Nitro / server limits); plugin requests settings but cannot guarantee output. |
| B13 | Info | Open | Single-display + system audio cannot use stage path → window video only (logged). |
| A1–A12 | — | Prior | See earlier audit sections / patch notes (picker labels, `file://` origin, stream-end grace, permission narrowing, duplicate capture skip, etc.). |

## Verification checklist

- [x] Plugin builds under Vencord (`pnpm build`)
- [x] Native helpers expose `listScreens`, `openOutputWindow` (+ stage), `configureOutput`
- [x] Go-live guard: no `setGoLiveSource` in audio keepalive; stream-event subscribe once
- [x] Output page honors FPS; track-end recovery
- [ ] Manual: Start with system audio + spare monitor → stage fullscreen, viewers hear apps not Discord echo
- [ ] Manual: Start without system audio → floating window share stays up
- [ ] Manual: Stop in Discord UI → TripleScreen releases within ~10s after guard
- [ ] Manual: Close output/stage window → TripleScreen stops
- [ ] Manual: Minimize floating output → parked (not blank); stage restores fullscreen

## Files touched this pass

- `native.ts` — FPS-aware paint, track reacquire, stage mode recreate, HWND validation
- `streaming/GoLiveGuard.ts` — ownership exports, single stream-event bind, quality best-effort
- `streaming/DiscordStreamAdapter.ts` — stricter live check, `stage-screen` mode, dead timer removed
- `ui/TripleScreenModal.tsx` / `index.tsx` — accurate status and about copy
- `docs/AUDIT.md` — this document
- `docs/PATCH_NOTES.md` — dated changelog entry
