# TripleScreen patch notes

Newest entries first. Each GitHub push for a fix should add a section here and mention it in the commit message.

---

## 2026-11-02 — Portrait / vertical monitor capture glitches

### Fixed
- **Vertical monitor glitching:** Output capture used `maxHeight: 2160`, which clips portrait 1440p/4K (e.g. 1440×2560) and corrupts that tile. Caps raised to 8192×8192.
- When desktop capture returns a landscape buffer for an OS-rotated portrait display, the compositor now auto-rotates that tile so content matches the monitor orientation.

---

## 2026-11-02 — Output window + soundshareId 1 (system mix); works minimized

### Fixed
- **Discord-only stream audio:** Live CDP showed go-live stuck on `window:…` with a process PID. Discord accepts `soundshareId: 1` (system mix sentinel) on that same Output window; we now pin it via `setGoLiveSource` + `setSoundshareSource(1,true)` and re-pin every 2s (Discord rewrites PIDs).
- **Minimize broke A/V:** Always stream the Output window (park keeps it painted). No stage-screen switch, so video + system audio stay on while minimized.

### Changed
- Removed stage-screen / audio-mirror paths for system audio.

---

## 2026-11-02 — Revert audio mirror; restore stage screen system mix — SUPERSEDED

### Known issues
- Stage path did not stick live (stream stayed on window PID). Superseded by window + soundshareId 1 above.

---

## 2026-11-02 — Output window mirrors system audio (no Discord echo) — REVERTED

### Known issues
- This approach failed live: local mirror playback + viewers still Discord-only. Superseded by stage screen go-live above.

---

## 2026-11-02 — Park stays on same monitor; bootstrap stream then screen audio

### Fixed
- **Minimize jumped to main monitor:** Park now shrinks in-place on the current/stage display (corner), not the primary.
- Earlier screen-bootstrap attempt (superseded by Output audio mirror above).

### Changed
- Minimize still switches to window capture before park (avoids blank screen share)

---

## 2026-11-02 — Minimize: no exclusive fullscreen; switch capture before park

### Fixed
- **Can't minimize / blank stream:** Exclusive fullscreen hid the title bar. Stage now covers the monitor with a normal framed window. Minimize sets `pendingPark`, Discord switches to `window:` capture first, then parks — so the mosaic stays in the stream.
- Focus Output again to restore stage + system audio.

---

## 2026-11-02 — Fix go-live payload shape (quality + desktopDescription)

### Fixed
- **System audio never engaged:** Live CDP showed `goLiveSourceIdentifier: window:…` and `soundshareId: <PID>`. Our `setGoLiveSource({ id, soundshareId, useLoopback })` throws on current Discord (`Cannot destructure property 'resolution' of 'e.quality'`), so the stream stayed on the Output window PID loopback.
- Correct Discord 1.0.9266 shape: `{ quality, desktopDescription: { id: "screen:N:0", soundshareId: 1, useLoopback: true, … } }` — verified live via CDP (`goLive` → `screen:0:0`, `soundshareId` → `1`).
- Re-apply go-live after the stream connection exists (400/1200/2500 ms).

### Note
- Discord still cannot put system mix on a **window:** share of Discord.exe. Viewers see the Output mosaic because it is hosted fullscreen on the screen we capture.

---

## 2026-11-02 — Hold stage screen against window steal; restore minimize park

### Fixed
- **System audio still Discord-only after stage:** Discord re-picks the Output `window:` after we set `screen:` + `soundshareId: 1`. The go-live guard used to **drop ownership** on that switch, leaving Discord.exe process loopback (friends hear themselves). Guard now always forces the stage screen back.
- **Minimize blocked:** Stage mode restored fullscreen on every minimize. Minimize now exits exclusive fullscreen, keeps the mosaic covering the stage display, and parks behind other windows (same park path as before).

### Changed
- Stage host prefers a non-primary monitor when possible
- Go-live prefers connection `desktopDescription` (Discord Entire-Screen shape)

---

## 2026-11-02 — System audio: screen-stage go-live (evidence fix)

### Fixed
- **Friends hear themselves / no YouTube:** Window go-live of TripleScreen Output always binds Windows process loopback to Discord.exe. CDP showed `soundshareId: 1` on a window source still Discord-only. `setSoundshareSource(null, false)` and screen→window bootstrap do not change that.
- Restored **Entire-Screen go-live** (`screen:` / `screen-handle:` + `soundshareId: 1`) by fullscreen-hosting the Output on a stage display — the only path Discord uses for system mix (jimman / prior working stage build).
- **All selected monitors stay in the mosaic** (no dropped stage tile). Stage tile is frozen to a still frame before fullscreen so it does not recursively capture the composite.

### Changed
- `docs/AUDIT.md` rewritten with evidence and the rejected false fixes

---

## 2026-11-02 — System audio: Nightcord clear + screen bootstrap (insufficient)

### Known
- Did not fix audio: remaining on / returning to a window: source keeps Discord PID loopback. Superseded by screen-stage go-live above.

---

## 2026-11-02 — Crash fix + background resize preview

### Fixed
- Composite dying after a few seconds: removed auto-teardown from flaky Discord stream-store polls / `STREAM_DELETE` ownership drops; Output window close and Stop remain the stop signals
- Softened system-audio keepalive to a single re-pin (repeated `setSoundshareSource` churn)

### Added
- Background image **resize** (25–300%) and **pan X/Y** sliders
- Live **on-stream preview** matching output resolution, with % of image visible in the frame

---

## 2026-11-02 — All monitors + system audio (no stage)

### Changed
- Removed the system-audio **stage monitor** requirement — you can select and stream every display again
- Go-live always uses the TripleScreen Output **window** for video (full mosaic)
- System audio is pinned with `setSoundshareSource(0)` (fallback `1`) to clear Discord.exe PID loopback, same approach as enhanced screenshare “Entire System”

### Fixed
- Main/primary monitor dropped from the mosaic whenever system audio stole it as the stage

---

## 2026-11-02 — Custom background image

### Added
- Output setting to choose a custom background image (PNG/JPEG/WebP) behind the monitor mosaic
- Fit modes: fill, fit, stretch, center (solid background color still shows in letterbox gaps)
- Images are downscaled/compressed for settings storage and drawn on the live TripleScreen Output canvas (and editor compositor)

---

## 2026-11-02 — Full audit pass

### Fixed
- Output canvas ignored the configured FPS (always 60 Hz paint loop) — now follows `cfg.fps`
- Stream-alive check treated any MediaEngine stream connection as live — now requires TripleScreen ownership and matching go-live source id when available
- Stage ↔ window mode reuse kept wrong window chrome — recreate BrowserWindow when mode changes
- Desktop-capture track end left black mosaic tiles — re-acquire the monitor stream
- Duplicate `STREAM_DELETE` / `STREAM_CLOSE` subscriptions on guard reinstall
- HWND park helper validates numeric ids before PowerShell
- Status / settings copy updated for stage-monitor system audio (`stage-screen` mode)

### Changed
- `docs/AUDIT.md` rewritten for this full review

### Known issues
- Stage monitor omitted from mosaic without auto-reflow of remaining tiles
- Single-display systems cannot use system-audio stage path

---

## 2026-11-02 — Composite teardown after a few seconds

### Fixed
- Composite dying shortly after start: audio keepalive was re-calling `setGoLiveSource`, which restarts Discord capture and races `STREAM_DELETE` / stream-store polls into a full TripleScreen teardown
- Removed the delayed second `beginNativeShare` (same restart hazard)
- Stream-end watcher now uses MediaEngine connections, a 15s go-live guard, and 5 consecutive misses; no longer stops on lone `STREAM_DELETE`/`STREAM_CLOSE` events
- GoLiveGuard ignores stream-end events for 12s after apply
- Output-window closed watcher requires consecutive misses (IPC blips during fullscreen)
- Layout updates keep the stage monitor excluded from the mosaic

---

## 2026-11-02 — System audio via stage monitor

### Fixed
- **System audio / self-echo:** `window:` go-live cannot use Discord’s full-mix `soundshareId: 1` (native still loopbacks Discord.exe → friends hear themselves, no YouTube). TripleScreen now fullscreens the composite on a **stage monitor** and calls `setGoLiveSource` with that `screen:…` id **and** `soundshareId: 1` (same path as Entire Screen + Share system audio).

### Changed
- Stage pick order: unused (unselected) display first; otherwise steal primary when ≥2 displays exist
- Stage monitor is excluded from the mosaic to avoid recursive capture
- Single-display setups fall back to window video without system audio (logged)
- Settings blurb documents the stage-monitor requirement

### Known issues
- With every monitor selected and no spare display, one monitor becomes the stage and is omitted from the mosaic while system audio is on

---

## 2026-11-02 — Docs & public repo hygiene

### Added
- Full setup guide in root `README.md` (clone this repo, Vencord from source, inject, enable, go live)
- `docs/AUDIT.md` with audit findings
- `.gitignore` entries for `.cursor/`, `.env`, credentials, and unrelated AD helper scripts

### Changed
- Public GitHub history rewritten to a clean tree (no local machine paths in tracked files)
- Plugin README points at the root setup guide

### Known issues
- **System audio:** addressed in the newer “stage monitor” entry above

---

## 2026-11-02 — Audit / streaming overhaul

### Fixed
- Stream picker **TripleScreen** tab missing after Discord renamed tabs to Applications / Entire Screen / Devices
- Output window `data:` URL blocked `navigator.mediaDevices` (capture failed with `getUserMedia` on undefined) — now loads via `file://`
- Premature teardown right after go-live (stream-end watcher grace period)
- Go-live with zero captured monitors (black stream aborted)
- Over-broad Electron permission handlers on the output session
- Duplicate editor + output `getUserMedia` capture (skipped editor capture when native helpers exist)

### Added
- Native **TripleScreen Output** window as the Discord share target
- `GoLiveGuard` for MediaEngine `setGoLiveSource` / soundshare
- Stream picker tab + Open TripleScreen panel
- System-audio setting (intended: full mix, Discord voice excluded)

### Changed
- Supported streaming path is **output window + setGoLiveSource**, not track replacement
