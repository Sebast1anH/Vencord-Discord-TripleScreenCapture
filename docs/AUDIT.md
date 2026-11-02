# TripleScreen audit — 2026-11-02 (audio + full pass)

## Architecture

1. Layout editor selects N monitors → **Start**.
2. Native **TripleScreen Output** window composites every selected monitor (`file://` page + `getUserMedia`).
3. `GoLiveGuard.beginNativeShare` points Discord at that **window** (full mosaic).
4. **System audio (Windows):**
   1. Brief go-live on a Discord-native `screen:` / `screen-handle:` with `soundshareId: 1` (wakes desktop loopback).
   2. Switch video to the Output window with `soundshareId: 1`.
   3. `setSoundshareSource(null, false)` clears the single-PID filter (Nightcord “Entire System” — **not** `(0, true)`).
5. Stop / close Output tears down.

## Findings this pass

| ID | Severity | Status | Finding |
|----|----------|--------|---------|
| C1 | Critical | **Fixed** | System audio only captured Discord. We called `setSoundshareSource(0, true)` first; it “succeeds” but does **not** enable full desktop loopback, so the Nightcord `(null, false)` clear never ran. |
| C2 | Critical | **Fixed** | Window share of Discord-owned Output defaults to Discord.exe PID loopback. Now: screen bootstrap + `soundshareId: 1` on window payload + PID-filter clear. |
| C3 | High | Fixed earlier | Auto stream-end teardown killed composites after a few seconds. |
| C4 | Medium | **Fixed** | Background image had no resize/pan or stream-frame preview (added prior; verified in this pass). |
| C5 | Medium | Accepted | Unused stage-fullscreen path still exists in `native.ts` (no longer called). Safe to delete in a cleanup PR. |
| C6 | Low | Accepted | Picker tab is DOM/`MutationObserver` based. |
| C7 | Low | Accepted | Minimize park uses PowerShell `SetWindowPos` (HWND digits only). |
| C8 | Info | Open | Discord encoder still caps resolution/FPS (Nitro / server). |
| C9 | Info | Open | If Discord changes `setSoundshareSource` semantics, re-verify with CDP (`soundshareId` / friends hearing apps). |

## Verification

- [x] Build (`pnpm build` in Vencord)
- [ ] Manual: Select all monitors + system audio → Start in voice → viewers hear YouTube/games, not Discord echo
- [ ] Manual: Stream stays up >30s without auto-stop
- [ ] Manual: Background preview matches Output window letterbox/crop

## Files touched

- `streaming/GoLiveGuard.ts` — Nightcord audio clear + screen bootstrap
- `streaming/DiscordStreamAdapter.ts` — DiscordNative screen id for bootstrap
- `docs/AUDIT.md`, `docs/PATCH_NOTES.md`
