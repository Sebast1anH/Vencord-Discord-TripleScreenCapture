# TripleScreen patch notes

Newest entries first. Each GitHub push for a fix should add a section here and mention it in the commit message.

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
