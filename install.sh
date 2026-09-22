#!/usr/bin/env bash
# Install Spotlight Search GNOME extension locally for the current user.
set -euo pipefail

UUID="spotlight-search@umar.local"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HOME/.local/share/gnome-shell/extensions/$UUID"

echo "Installing Spotlight Search to: $TARGET"
mkdir -p "$(dirname "$TARGET")"
rm -rf "$TARGET"
mkdir -p "$TARGET"
cp -r "$DIR/extension.js" "$DIR/prefs.js" "$DIR/metadata.json" "$TARGET"
mkdir -p "$TARGET/schemas"
cp "$DIR/schemas/org.gnome.shell.extensions.spotlight-search.gschema.xml" "$TARGET/schemas/"

if command -v glib-compile-schemas >/dev/null 2>&1; then
    echo "Compiling GSettings schemas…"
    glib-compile-schemas "$TARGET/schemas"
else
    echo "WARNING: glib-compile-schemas not found; schemas not compiled." >&2
fi

# Restart shell so the extension is picked up (X11 only).
if [[ "${XDG_SESSION_TYPE:-}" == "x11" ]]; then
    echo "Restarting GNOME Shell (X11)…"
    busctl --user call org.gnome.Shell /org/gnome/Shell \
        org.gnome.Shell Eval s 'Meta.restart("Restarting for Spotlight Search")' \
        >/dev/null 2>&1 || true
fi

if command -v gnome-extensions >/dev/null 2>&1; then
    echo "Enabling extension…"
    gnome-extensions enable "$UUID"
fi

echo
echo "Done. Press $'"'"'Super+Space'"'"' to open Spotlight Search."
echo "If it does not appear, log out and back in, then enable it in GNOME Extensions."