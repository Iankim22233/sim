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
| `new` | replace the project with an empty one |
| `sprite <name> [color]` | add a circle sprite |
| `select <sprite>` | switch the editor to that sprite |
| `get <sprite>` | dump a sprite's blocks as JSON |
| `blocks <sprite> <file.json>` | add blocks (project.json format; compact inputs like `[1,[4,"50"]]` are expanded) |
| `mouse <x> <y> [down\|up\|click]` | move/click the mouse in stage coords |
| `eval "<js>"` | run JS in the editor page (full `vm` access: add sprites, blocks, ...) |

Env: `TW_REMOTE_PORT` (default 9333), `TW_REMOTE_PROFILE`, `TW_APP` (TurboWarp location at build time).
The debug port gives any local process full control of the editor; it listens on localhost only.
