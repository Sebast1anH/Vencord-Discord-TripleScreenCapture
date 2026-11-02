# TripleScreen (Vencord userplugin)

Captures multiple monitors, arranges them on a canvas, and shares **one** composite stream through Discord Desktop.

Viewers do **not** need this plugin.

## Install

This folder must live at:

```text
Vencord/src/userplugins/triplescreen/
```

Then rebuild Vencord (`pnpm build`) and fully restart Discord.

**Important:** the official Vencord installer does **not** load `userplugins`. You need a [source build](https://docs.vencord.dev/installing/).

For the full setup guide, architecture, audio notes, and troubleshooting, see the repository root [`README.md`](../../../README.md).

## Quick usage

1. Join a voice channel.
2. Open TripleScreen via the Screen Share **TripleScreen** tab, `/triplescreen`, Toolbox, or voice context menu.
3. Select monitors → arrange → **Start composite stream**.
4. Leave the **TripleScreen Output** window open while streaming.
5. Stop via the modal, by closing the output window, or by ending Discord’s stream.
