# Spotlight Search

A macOS Spotlight-style quick launcher for **GNOME Shell**.

Press **Super+Space** and an overlay slides in above your top bar, where you can search apps, files, do math, convert units, fire off system actions, and dig through your clipboard history — as you type.

<p align="center">
  <img src="https://img.shields.io/badge/GNOME_Shell-45%E2%80%9350-4cbf20" alt="GNOME Shell 45–50">
  <img src="https://img.shields.io/badge/version-1.0-blue" alt="version 1.0">
  <img src="https://img.shields.io/badge/license-GPL--3.0-green" alt="GPL-3.0">
</p>

## Features

- **Apps** — instant, usage-ranked application search with icons and descriptions.
- **Files** — live search of your home folder and common subfolders (`Desktop`, `Documents`, `Downloads`, `Pictures`, …). Hidden/cache directories (`node_modules`, `.cache`, …) are skipped, and the walk is bounded so it stays fast.
- **Folder browser** — type `ls <folder>` (e.g. `ls home`, `ls Documents`) and every file and subfolder inside is listed right in the launcher for instant opening. The `ls` is italicized as you type.
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

## Requirements

- **GNOME Shell 45 – 50** (Wayland or X11)
- An up-to-date GNOME desktop session

## Install

### 1. From a GitHub release (easiest)

1. Download the latest `spotlight-search@umar.local.zip` from the [Releases](https://github.com/beastzy/Spotlight-Search/releases) page.
2. Extract and it place it where GNOME Shell loads extensions from:

   ```bash
   mkdir -p ~/.local/share/gnome-shell/extensions
   cd ~/.local/share/gnome-shell/extensions
   unzip ~/Downloads/spotlight-search@umar.local.zip
   glib-compile-schemas spotlight-search@umar.local/schemas
   ```

3. Log out and back in (or press **Alt+F2**, type `r` and Enter on X11), then enable it:

   ```bash
   gnome-extensions enable spotlight-search@umar.local
   ```

### 2. From source

```bash
git clone https://github.com/beastzy/Spotlight-Search.git
cd Spotlight-Search
chmod +x install.sh
./install.sh
```

The `install.sh` script copies the extension to `~/.local/share/gnome-shell/extensions` and compiles the schema, then you enable it as above.

> **Wayland** always needs a log-out/log-in (or restart) before a new extension shows up.

## Customization

You can tweak the shortcut, panel width, search depth and more via dconf:

```
dconf write /org/gnome/shell/extensions/spotlight-search/toggle-shortcut "['<Super>space']"
dconf write /org/gnome/shell/extensions/spotlight-search/panel-width 640
dconf write /org/gnome/shell/extensions/spotlight-search/search-files true
```

Or browse the full list of keys programmatically:

```
gsettings list-recursively org.gnome.shell.extensions.spotlight-search
```

## Layout

```
Spotlight-Search/
├── extension.js      # all logic + UI
├── prefs.js          # settings UI
├── metadata.json     # extension metadata (uuid, shell versions)
├── schemas/          # GSettings schema
│   └── …spotlight-search.gschema.xml
├── test/             # logic test suite (run with `node test/run-tests.mjs`)
└── install.sh        # installs to ~/.local/share/gnome-shell/extensions
```

## Troubleshooting

- **`Failed to load extension`** — make sure your shell version is in the `shell-version` list of `metadata.json`; if not, add it and re-login.
- **Super+Space does nothing** — confirm the extension is enabled and the schema is compiled (`glib-compile-schemas ~/.local/share/gnome-shell/extensions/spotlight-search@umar.local/schemas`), then re-login.
- **Runs slow** — lower `search-depth` or disable file search with the `search-files` dconf key.
- **Logs / errors** — inspect with `journalctl -f -o cat /usr/bin/gnome-shell`.

## Privacy

Captured clipboard text is kept only in memory for the session; captured clipboard images are written to `~/.cache/spotlight-clip-*.png` (deleted on `clip clear` or when they age out) so they can be re-copied. Re-copying an image uses the same `St.Clipboard.set_content` call GNOME Shell's screenshot UI itself uses; if that is ever unavailable it falls back to an external clipboard tool (`wl-copy`/`xclip`) when installed, and finally to copying the file path. Nothing is sent anywhere — the only network requests are the Google-suggestion lookups for plain queries, which you can disable in settings.

## License

GPL-3.0. Contributions welcome — see the issue tracker on this repository.