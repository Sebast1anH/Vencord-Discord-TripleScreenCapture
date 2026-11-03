# TripleScreen full audit — 2026-11-02

Evidence-based review of `src/userplugins/triplescreen/` after live audio/minimize/2-monitor work.

## Executive summary

TripleScreen composites selected monitors into an Output `BrowserWindow` and points Discord’s MediaEngine at that window. System audio currently pins `soundshareId: 1` on the window share (user-confirmed working with a friend). Remaining structural risks: **monitor source identity** (Windows `display_id` mismatches), **tile reconnect / hold-frame dead-ends**, **go-live ownership** (false “Live”, delayed re-`setGoLiveSource`, stream-end ignored), and **park/occlusion** behavior.

## Architecture (current, verified intent)

1. Enumerate displays via Electron `desktopCapturer` + `screen` (unique source binding).
2. Open Output window → per-monitor `getUserMedia(chromeMediaSource: desktop)`.
3. Composite tiles to a canvas in the Output page.
4. `setGoLiveSource({ quality, desktopDescription: { id: window:…, soundshareId: 1|−1 } })`.
5. Minimize → park (painted, non-iconic) so `window:` capture stays alive.

## Findings

| ID | Sev | Status | Finding |
|----|-----|--------|---------|
| F01 | Critical [verify] | **Mitigated (user-confirmed audio)** | Window + `soundshareId:1` contradicted older AUDIT evidence; friend audible test passed. Keep pinning + keepalive; stage path remains fallback if regression. |
| F02 | High | **Fixing** | “Live” reported when `setGoLiveSource` doesn’t throw; no stream-connection verify. |
| F03 | High | **Fixing** | `altIds` / rematch could bind wrong/duplicate monitors (`screen:${index}:0`). |
| F04 | High | **Fixing** | Park size clamp broke aspect → stretched mosaic. |
| F05 | High | **Fixing** | Held last-frame prevented reconnect forever after DXGI drop. |
| F06 | High | **Fixing** | Delayed re-`beginNativeShare` (400/1200/3000) restarts capture. |
| F07 | High [verify] | Open | Parked/occluded Output may stall Chromium compositing. |
| F08 | High | **Reverted teardown** | Auto-stop on `STREAM_DELETE` / missing conn caused crashes after seconds. Output close / Stop remain the teardown path; Discord stop may leave Output until user closes it. |
| F09 | Medium | **Fixed (re-pin)** | Transient `setGoLiveSource(null)` re-pins Output; does not kill composite. |
| F10 | Medium | Open | `listScreens` on every layout drag (thumbnail cost). |
| F11 | Medium | **Fixing** | Alt-id fallbacks pointed at other monitors. |
| F12 | Medium | **Fixing** | Minimize→restore flash; park snaps corner (keep uniform scale). |
| F13 | Medium | Open | Orientation lock can still flip after 1.5s if sizes alternate. |
| F14 | Medium | **Fixing** | Snapshot every draw doubled GPU work. |
| F15 | Medium | **Fixing** | Output opens on primary → Droste/self-capture. Prefer non-primary host. |
| F16 | Medium | Open | Teardown races if start during stop. |
| F17 | Medium | Open | Saved layouts keyed by unstable `screen:N:0`. |
| F18 | Medium | **Partial** | Enable `webSecurity`; deny navigate/`window.open`. |
| F19 | Medium | Open | PowerShell `Add-Type` on park (AMSI / Constrained Language). |
| F20 | Medium | **Fixing** | Keepalive repaired forever with no stream connection. |
| F21 | Medium [verify] | Open | Guard may patch wrong `setGoLiveSource` export. |
| F22–F28 | Low/Info | Partial | Poll rate, dead stage code, tools/ untracked, etc. |

## Fix concept (prioritized)

### P0 — Diagnostics
Expose stream `goLive` / `soundshareId`, per-tile live/stalled, visibility. (Follow-up.)

### P1 — Monitor identity (F03, F11)
- Exact `sourceId` match first; alts only if no exact hit.
- Alts must be spellings of the **same** display, never ordinals of other monitors.
- No “first unused screen” assignment for unmatched tiles.

### P2 — Output page reliability (F05, F14, F23)
- Watchdog reconnect even while holding last frame.
- Snapshot on mute/ended only (not every paint).
- `ensureVideo` / `applyChain` error cleanup.

### P3 — Window / park (F04, F12, F15, F18)
- Uniform aspect when parking.
- Prefer host display that is not primary (reduce self-capture).
- Harden BrowserWindow navigation / `webSecurity`.

### P4 — Go-live ownership (F06, F08, F09, F20)
- Single `beginNativeShare`; keepalive repairs only when connection exists and state wrong.
- Grace period on `null` before releasing; notify adapter to stop.
- Honor confirmed stream-end after grace.

### P5 — Audio fallback
If `soundshareId:1` on window regresses: restore selectable stage-screen mode (dead native stage helpers exist).

## Verification checklist

- [ ] 2 monitors landscape — both tiles stable, no flicker
- [ ] 1 portrait + 1 landscape — portrait stable
- [ ] System audio: friend hears YouTube, not call echo
- [ ] Minimize/park — mosaic + audio continue
- [ ] Stop from Discord UI — Output tears down within a few seconds
- [ ] Layout drag — no monitor swap

## What already looks correct

- IPC sanitization (`screen:` ids only, clamped geometry, data-URL bg images).
- Unique capturer assignment intent (no double-bind of same source when matching works).
- `{ quality, desktopDescription }` go-live payload shape (Discord 1.0.9266).
- `normalizeWindowSourceId`, file:// Output page for `mediaDevices`.
- Generation guards in adapter `start()`.
