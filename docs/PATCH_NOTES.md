# TripleScreen patch notes

Newest entries first. Each GitHub push for a fix should add a section here and mention it in the commit message.

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
- **System audio:** viewers may still hear Discord call echo (themselves) and miss YouTube/other apps when the share is bound to Discord’s process audio. Fix in progress — pin full system soundshare without Discord PID loopback.

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
