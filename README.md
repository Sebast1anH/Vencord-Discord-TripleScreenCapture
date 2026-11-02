# TripleScreen

**Vencord** plugin for **Discord Desktop (Windows)** that captures multiple monitors, lets you arrange them on a canvas, and shares them as **one** Discord Go Live stream.

Viewers do **not** need the plugin.

---

## Features

- Composite 1–N monitors into a single outgoing Discord stream
- Layout editor with presets (horizontal, grid, custom drag/resize)
- **TripleScreen** tab inside Discord’s Screen Share picker (Applications / Entire Screen / Devices)
- Native **TripleScreen Output** window that Discord actually shares
- Optional **system audio** (YouTube, games, browsers) while excluding Discord voice so friends don’t hear themselves
- Minimize parks the output window (keeps painting) instead of sending a blank frame
- Closing the output window stops the composite so `/triplescreen` works again
- Resolution / FPS settings (still subject to Discord / Nitro negotiation)

---

## Requirements

| Requirement | Notes |
| --- | --- |
| **Windows** | Primary supported platform (system audio + output window) |
| **Discord Desktop** | Stable / PTB / Canary with Vencord injected |
| **Vencord from source** | The official installer **does not** load `userplugins` — you must build Vencord yourself |
| **Node.js + pnpm** | For building Vencord (see [Vencord install docs](https://docs.vencord.dev/installing/)) |
| **Voice channel / call** | You must be connected before starting a composite stream |

---

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/userplugins/triplescreen/` | The Vencord userplugin (copy this into Vencord) |
| `preview/` | Optional browser demo of the layout editor |
| `docs/FEASIBILITY.md` | Early MediaEngine research notes |
| `docs/AUDIT.md` | Recent audit findings and fixes |
| `docs/PATCH_NOTES.md` | Changelog / patch notes for each fix push |

---

## Detailed setup guide

### 1. Install prerequisites

1. Install a current **Node.js LTS** from [nodejs.org](https://nodejs.org/).
2. Enable **pnpm** (Vencord’s package manager), for example:

   ```bash
   npm install -g pnpm
   ```

3. Install **Git** if you don’t already have it.

### 2. Download this repository

Clone TripleScreen (or download the ZIP from GitHub and extract it):

```powershell
git clone https://github.com/Sebast1anH/Vencord-Discord-TripleScreenCapture.git
cd Vencord-Discord-TripleScreenCapture
```

ZIP alternative: open the repo on GitHub → **Code → Download ZIP** → extract somewhere convenient, then open that folder in PowerShell (`cd` into it).

You will need this folder in step 4 when copying the plugin into Vencord.

### 3. Build Vencord from source

Official installer builds **cannot** load custom `userplugins`. Follow the upstream guide:

→ [https://docs.vencord.dev/installing/](https://docs.vencord.dev/installing/)

Typical flow on Windows (PowerShell):

```powershell
# From a parent folder (e.g. next to TripleScreen), not inside the TripleScreen clone
git clone https://github.com/Vendicated/Vencord.git
cd Vencord
pnpm install
pnpm build
pnpm inject
```

`pnpm inject` patches your installed Discord. Fully quit Discord (system tray included) before injecting if the tool asks you to.

Confirm Vencord works: open Discord → **Settings → Vencord**. You should see the Vencord settings pane.

### 4. Install TripleScreen into Vencord

Copy the plugin from this repo into your Vencord tree. Adjust the paths if your folders are elsewhere:

```powershell
# Example: both repos live under the same parent folder
Copy-Item -Recurse -Force `
  .\Vencord-Discord-TripleScreenCapture\src\userplugins\triplescreen `
  .\Vencord\src\userplugins\triplescreen
```

If your current directory is already the TripleScreen clone:

```powershell
Copy-Item -Recurse -Force `
  .\src\userplugins\triplescreen `
  ..\Vencord\src\userplugins\triplescreen
```

Or manually:

1. Create `Vencord/src/userplugins/` if it does not exist.
2. Copy the entire `triplescreen` folder from this repo so you have:

   `Vencord/src/userplugins/triplescreen/index.tsx`  
   (and the rest of the plugin files next to it)

### 5. Rebuild and restart Discord

```powershell
cd Vencord
pnpm build
```

Then **fully restart Discord** (Quit Discord → start again). A normal window close is not enough if Discord stays in the tray.

### 6. Enable the plugin

1. Discord → **User Settings → Vencord → Plugins**
2. Find **TripleScreen** and enable it
3. Ensure dependency **ChatInputButtonAPI** is available/enabled if Vencord prompts for it
4. Optional settings:
   - Output resolution (720p / 1080p / 1440p / custom)
   - Frame rate (15 / 30 / 60)
   - **Share Windows system audio** (recommended on)
   - Performance overlay while configuring
   - Chat bar button (restart needed if you toggle it)

### 7. Go live with multiple monitors

1. Join a **voice channel** or call.
2. Open TripleScreen using any of:
   - Screen Share → **TripleScreen** tab → **Open TripleScreen**
   - Slash command `/triplescreen`
   - Voice / channel context menu → **Share Multiple Monitors**
   - Vencord Toolbox → **TripleScreen layout**
3. Select the monitors to include.
4. Arrange them (presets or drag/resize on the canvas).
5. Confirm **Share system audio** if you want YouTube/game audio on the stream.
6. Click **Start composite stream**.
7. A window titled **TripleScreen Output** appears — that is what Discord encodes. Leave it open while streaming.
8. Ask a friend to confirm they see **all** selected monitors and hear system audio (not Discord call echo).

### 8. Stopping

Use any of:

- **Stop TripleScreen** in the plugin modal
- Close the **TripleScreen Output** window
- Stop streaming from Discord’s call UI

Capture and the output window are released when the composite stops.

### 9. Updating the plugin later

```powershell
cd Vencord-Discord-TripleScreenCapture
git pull

Copy-Item -Recurse -Force .\src\userplugins\triplescreen ..\Vencord\src\userplugins\triplescreen
cd ..\Vencord
pnpm build
# Fully restart Discord
```

---

## How streaming works (current design)

1. Enumerate displays via Electron / `DiscordNative` desktop capturer.
2. Open an on-screen **TripleScreen Output** BrowserWindow.
3. That window captures each selected monitor (`getUserMedia` + `chromeMediaSourceId`) and paints the layout onto a canvas at your chosen resolution / FPS.
4. TripleScreen points Discord’s MediaEngine at that window (`setGoLiveSource` with the window media source id).
5. System audio is pinned with Discord’s system soundshare path (`setSoundshareSource(1)`), which is intended to include app audio while excluding Discord’s own voice playback.
6. Viewers receive a normal Discord stream — no plugin required on their side.

Older notes in `docs/FEASIBILITY.md` describe an early “track replacement” experiment. The **supported path today is the output window**, not `conn.input.stream` replacement.

---

## Usage tips

| Tip | Detail |
| --- | --- |
| Keep the output window open | Closing it ends the composite |
| Minimize is OK | The window is parked and keeps painting (minimized windows capture blank) |
| System audio | Enable in plugin settings; covers default playback mix (browser, games, etc.), not Discord voice |
| Nitro / Discord caps | Discord may still clamp to 720p or 1080p regardless of plugin settings |
| One composite at a time | Start again after stop if you change monitors heavily |
| Picker tab missing | Rebuild Vencord, restart Discord, confirm the plugin is enabled |

---

## Optional: layout preview (no Discord)

Browser-only demo of the editor / compositor:

```bash
cd preview
npm install
npm run dev
```

Open the URL Vite prints (default [http://127.0.0.1:47321](http://127.0.0.1:47321)).

---

## Privacy

- Capture starts only after an explicit action (Start / Open TripleScreen flow).
- Frames go only into the Discord Go Live session you start — nothing is uploaded to a TripleScreen server.
- Stopping the stream or closing the output window releases capture tracks.
- Do not commit Discord tokens, `.env` files, or personal machine paths if you fork this repo.

---

## Limits & troubleshooting

| Symptom | What to try |
| --- | --- |
| Plugin not listed | Copied into `src/userplugins/triplescreen`? Ran `pnpm build`? Using a **source** Vencord install? |
| No TripleScreen picker tab | Plugin enabled? Fully restarted Discord? Open Screen Share from a voice call |
| Black / empty stream | Is **TripleScreen Output** visible and painting? Check Performance panel for capture errors |
| Friends hear themselves | System audio should exclude Discord; rebuild latest plugin, restart, ensure Share system audio is on |
| No YouTube / game audio | Enable **Share system audio**; play audio on the Windows **default** output device |
| Low FPS | Discord negotiation, GPU load, or covered output window — keep output on-screen or minimized via park |
| Normal screen share broken | Disable TripleScreen, restart Discord; file an issue with Vencord + Discord version |

More audit detail: [`docs/AUDIT.md`](docs/AUDIT.md).  
Release-style fix log: [`docs/PATCH_NOTES.md`](docs/PATCH_NOTES.md).

---

## License

Plugin sources follow **GPL-3.0-or-later**, matching Vencord.
