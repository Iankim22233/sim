# TurboWarpRemote

A launcher `.app` around the installed **TurboWarp Desktop** that exposes Chromium's remote-debugging
port, plus `twctl.mjs`, a CLI that drives the editor's Scratch VM (`window.vm`) over it.
Projects export as normal `.sb3` files.

```bash
./make-app.sh                 # builds TurboWarpRemote.app (gitignored)
open -n TurboWarpRemote.app   # separate profile + debug port 9333; won't touch your normal TurboWarp
node twctl.mjs status
```

| command | what it does |
|---|---|
| `status` | targets (with block counts), thread count, turbo mode |
| `load <file.sb3>` / `export <out.sb3>` | import / export a project |
| `flag` / `stop` | green flag / stop all |
| `key <name> [ms]` | press and release a key |
| `vars` | stage (global) variable values |
| `screenshot <out.png>` | capture the editor window |
| `overlay [on\|off] ["text"]` | orange gradient border + "Claude is creating" label (auto-shown on every command; `TW_OVERLAY=0` disables) |
| `backdrop <file.svg>` | add a backdrop and switch to it |
| `new` | replace the project with an empty one |
| `sprite <name> [color\|file.svg]` | add a sprite (circle, or from an SVG) |
| `select <sprite>` | switch the editor to that sprite |
| `get <sprite>` | dump a sprite's blocks as JSON |
| `blocks <sprite> <file.json>` | add blocks (project.json format; compact inputs like `[1,[4,"50"]]` are expanded) |
| `mouse <x> <y> [down\|up\|click]` | move/click the mouse in stage coords |
| `eval "<js>"` | run JS in the editor page (full `vm` access: add sprites, blocks, ...) |

Env: `TW_REMOTE_PORT` (default 9333), `TW_REMOTE_PROFILE`, `TW_APP` (TurboWarp location at build time).
The debug port gives any local process full control of the editor; it listens on localhost only.

The launcher passes `--disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows`
so the project runs at full speed even when the window isn't frontmost.
If `open -n` right after killing an instance shows no window, wait a few seconds and retry.
