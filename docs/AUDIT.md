# TripleScreen audit — 2026-11-02 (system audio, evidence-based)

## What actually broke system audio

Friends heard **themselves** and nothing else (YouTube/games silent).

That is Discord.exe process loopback: TripleScreen Output is a `BrowserWindow` owned by Discord, so

```text
setGoLiveSource({ id: "window:…", soundshareId: <Discord PID> })
```

captures only Discord’s process tree (`ActivateApplicationLoopbackFromPid`).

### Evidence (not speculation)

| Source | Fact |
|--------|------|
| [jimman0I/soundshareSource.desktop](https://github.com/jimman0I/soundshareSource.desktop) | Entire Screen → `soundshareId: 1`; window → PID. `1` is the system-mix sentinel. |
| Live CDP on this project (earlier session) | Stream already had `soundshareId: 1` on a **window:** source, and viewers still heard Discord-only echo. |
| Nightcord `applyStreamAudio("system")` | Calls `setSoundshareSource(null, false)` to clear a PID filter on an **already screen-based** share — not a window→system bridge. |
| User report after null/false + screen-bootstrap→window | Still Discord-only echo. |

**Conclusion:** System audio requires go-live **video** id to be `screen:` / `screen-handle:` with `soundshareId: 1`. Switching back to a window source undoes it. Rewriting `soundshareId` on a window source does not enable endpoint loopback.

## Correct architecture

1. Select N monitors → mosaic includes **all** of them (no tile dropped for audio).
2. Open floating Output → start capture of every selected monitor.
3. If system audio: freeze the stage display’s tile (still frame), then fullscreen Output on that display.
4. `setGoLiveSource({ id: stageScreen, soundshareId: 1 })` — Discord Entire-Screen audio path.
5. Viewers see the fullscreen mosaic (all tiles). Stage tile may be a frozen pre-fullscreen snapshot so it does not recursively show the composite.

Prefer an **unselected** display as stage when one exists; otherwise host on primary / first selected (still kept in the mosaic).

## Findings

| ID | Severity | Status | Finding |
|----|----------|--------|---------|
| C1 | Critical | **Fixed** | Window go-live cannot carry system mix; restored screen-stage go-live. |
| C2 | Critical | **Fixed** | Earlier “fix” kept switching to window after bootstrap — audio stayed Discord PID. |
| C3 | High | Fixed | Do not exclude the stage monitor from the mosaic (that blocked “all 3”). Freeze tile instead. |
| C4 | High | Fixed earlier | False STREAM_DELETE / store polls tearing down composite. |
| C5 | Medium | Fixed earlier | Background scale/pan + stream-frame preview. |
| C6 | Info | Open | Stage tile content is frozen while Output hosts that display (live apps on that monitor won’t update in that tile). |
| C7 | Info | Open | Discord encoder / Nitro still cap resolution & FPS. |

## Verification

- [ ] All 3 monitors selected + system audio → mosaic shows 3 tiles
- [ ] Viewers hear YouTube/game audio, not call echo
- [ ] Stream stays up >30s (Stop / close Output ends it)
