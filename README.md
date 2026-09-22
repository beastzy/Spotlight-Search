# Spotlight Search — a GNOME Shell extension

A macOS Spotlight-style quick launcher for GNOME Shell (45+). Press **Super+Space** and an overlay slides in above your top bar, where you can search as you type.

## Features

- **Apps** — instant, usage-ranked application search with icons and descriptions.
- **Files** — live search of your home folder and common subfolders (`Desktop`, `Documents`, `Downloads`, `Pictures`, …). Hidden/cache directories (`node_modules`, `.cache`, …) are skipped, and the walk is bounded so it stays fast.
- **Calculator** — type `12*8+3`, `sqrt(144)`, `2^10`, `sin(pi/2)`, `5!`, `√9`… and the result is shown; press **Enter** to copy it.
- **Unit conversion** — `10 km to miles`, `3 cups to ml`, `100 f to c`, `60 mph to km/h` are converted instantly (Enter copies).
- **Hotwords** — type your own magic words (`youtube`, `todo`, …) to run command-line/URL/system actions.
- **Web prefixes** — `-g cats`, `-yt cats`, or any custom prefix opens results in your browser. Plain unmatched input falls back to a web search.
- **System actions** — *lock*, *log out*, *suspend*, *restart*, *power off*, *hibernate*, *overview*, *screenshot*, *empty trash*, *switch user*.
- **Volume / brightness** — `mute`, `volume up`, `volume 60`, `brightness 40`.
- **Timers** — `timer 5m` (also `90s`, `2h`); a desktop notification fires when it's done. `cancel timers` to stop them.
- **Emoji picker** — `emoji smile`, `emoji heart`, `emoji fire`… Enter copies the symbol.
- **Clipboard history** — `clip <text>` searches your recently copied text and images (screenshots); Enter copies it again. `clip clear` wipes the history and the system clipboard.
- **Web suggestions** — live Google suggestions appear under plain queries (Enter opens them). Can be toggled in settings.
- When opened with an empty query it shows your most-used apps, like Spotlight does.

## Controls

| Key | Action |
| --- | --- |
| `Super+Space` | Open / close |
| `Type` | Search |
| `↑` / `↓` | Move selection |
| `Enter` | Open selected |
| `Esc` / click outside | Close |

## Install

```bash
cd spotlight-search
chmod +x install.sh
./install.sh
```

On **Wayland**, or if the extension does not appear immediately, log out and back in, then enable it with `gnome-extensions enable spotlight-search@umar.local` (or the Extensions app).

You can tweak the shortcut and panel width via `dconf` (see profile > settings):

```
dconf write /org/gnome/shell/extensions/spotlight-search/toggle-shortcut "['<Super>space']"
dconf write /org/gnome/shell/extensions/spotlight-search/panel-width 640
```

## Layout

```
spotlight-search/
├── extension.js      # all logic + UI
├── metadata.json     # extension metadata (uuid, shell versions)
├── schemas/          # GSettings schema
│   └── …spotlight-search.gschema.xml
└── install.sh        # installs to ~/.local/share/gnome-shell/extensions
```

## Troubleshooting

- **`Failed to load extension`** — check the version you are on: the extension targets `shell-version` 45–49. If yours differs, edit `metadata.json`.
- **Super+Space does nothing** — confirm the extension is enabled and the schema compiled (`glib-compile-schemas ~/.local/share/gnome-shell/extensions/spotlight-search@umar.local/schemas`), then re-login.
- **Runs slow** — lower `search-depth` or disable file search via the `search-files` dconf key.
- **Logs / errors** — inspect with `journalctl -f -o cat /usr/bin/gnome-shell`, or from a TTY run `GNOME_SHELL_JS_DEBUG=1`.

## Notes

Written to target GNOME 45+ (ES-module extensions). It builds on stable Shell APIs (`Shell.AppSystem`, `Main.pushModal`, `Main.wm.addKeybinding`) and should keep working into GNOME 46–49. Contributions welcome.

**Privacy:** captured clipboard text is kept only in memory for the session; captured clipboard images are written to `~/.cache/spotlight-clip-*.png` (deleted on `clip clear` or when they age out) so they can be re-copied. Re-copying an image uses the same `St.Clipboard.set_content` call GNOME Shell's screenshot UI itself uses; if that is ever unavailable it falls back to an external clipboard tool (`wl-copy`/`xclip`) when installed, and finally to copying the file path. Nothing is sent anywhere — the only network requests are the Google-suggestion lookups for plain queries, which you can disable in settings.