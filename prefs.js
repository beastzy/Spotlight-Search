import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const DEFAULT_PREFIX = '|Custom|https://duckduckgo.com/?q=';
const HOTWORD_TYPES = [
    ['url', 'Open URL'],
    ['command', 'Run command'],
    ['system', 'System action'],
];
const PREFS_LOG = `${GLib.get_home_dir()}/.local/share/spotlight-search.log`;

function prefsLog(msg) {
    try {
        const os = Gio.File.new_for_path(PREFS_LOG)
            .append_to(Gio.FileCreateFlags.NONE, null)
            .get_output_stream();
        os.write_all(new Date().toISOString() + ' [prefs] ' + msg + '\n', null);
        os.close(null);
    } catch (e) {}
}

/* ----- shortcut conflict detection ---------------------------------- */

const CONFLICT_SCHEMAS = [
    ['org.gnome.shell.keybindings', 'GNOME Shell'],
    ['org.gnome.desktop.wm.keybindings', 'GNOME Window Manager'],
    ['org.gnome.mutter.keybindings', 'Mutter'],
    ['org.gnome.settings-daemon.plugins.media-keys', 'Media Keys'],
];

const MODIFIER_KEYS = new Set([
    Gdk.KEY_Shift_L, Gdk.KEY_Shift_R, Gdk.KEY_Control_L,
    Gdk.KEY_Control_R, Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
    Gdk.KEY_Super_L, Gdk.KEY_Super_R, Gdk.KEY_Meta_L,
    Gdk.KEY_Meta_R, Gdk.KEY_Hyper_L, Gdk.KEY_Hyper_R,
    Gdk.KEY_Caps_Lock, Gdk.KEY_Num_Lock, Gdk.KEY_ISO_Level3_Shift,
]);

function _isModifierKey(keyval) {
    return MODIFIER_KEYS.has(keyval) || keyval === 0;
}

function _normCombo(combo) {
    return String(combo || '').toLowerCase().replace(/\s+/g, '');
}

/* Shared key→combo builder for both capture sources (Gtk + Clutter stage).
 * Returns 'ESC', 'MOD' (modifier-only press), a combo string, or null when
 * the key should be ignored (e.g. plain key without a modifier). */
function _comboFromKey(keyval, state) {
    if (keyval === Gdk.KEY_Escape)
        return 'ESC';
    if (_isModifierKey(keyval))
        return 'MOD';
    const mods = state & Gtk.accelerator_get_default_mod_mask();
    if (mods === 0)
        return null;
    return Gtk.accelerator_name(keyval, mods) || null;
}

function _findConflict(combo) {
    const want = _normCombo(combo);
    if (!want)
        return null;
    for (const [schemaId, source] of CONFLICT_SCHEMAS) {
        let settings;
        try {
            settings = Gio.Settings.new(schemaId);
        } catch (e) {
            continue;
        }
        let keys;
        try {
            keys = settings.list_keys();
        } catch (e) {
            continue;
        }
        for (const key of keys) {
            let value, type;
            try {
                value = settings.get_value(key);
                type = value.get_type_string();
            } catch (e2) {
                continue;
            }
            let candidates = [];
            try {
                if (type === 'as')
                    candidates = value.deep_unpack();
                else if (type === 's')
                    candidates = [value.unpack()];
            } catch (e3) {
                continue;
            }
            for (const c of candidates) {
                if (_normCombo(c) === want)
                    return {source, key, combo: c};
            }
        }
    }
    return null;
}

export default class SpotlightSearchPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings();
        this._prefixRows = [];
        this._hotWordRows = [];
        this._pendingShortcut = null;

        window.add(this._buildSearchBoxPage());
        window.add(this._buildShortcutPage());
        window.add(this._buildPrefixPage());
        window.add(this._buildHotWordPage());
        window.add(this._buildBehaviorPage());
    }

    _buildBehaviorPage() {
        const page = new Adw.PreferencesPage({
            title: 'Behavior',
            icon_name: 'preferences-desktop-general-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: 'Extras',
            description: 'Toggle the Spotlight extras. Changes apply ' +
                'immediately.',
        });
        page.add(group);

        const webSugg = new Adw.SwitchRow({
            title: 'Web search suggestions',
            subtitle: 'Show up to three live suggestions below your results ' +
                'while typing. Requires network access.',
        });
        this._settings.bind('web-suggestions', webSugg, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(webSugg);

        const clipHist = new Adw.SwitchRow({
            title: 'Clipboard history',
            subtitle: 'Remember recently copied text; search it with "clip". ' +
                'Stored only on this device.',
        });
        this._settings.bind('clipboard-history', clipHist, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(clipHist);

        group.add(this._spinRow('Clipboard history size', 'clipboard-history-size',
            1, 100, 1));

        return page;
    }

    /* ----- launch shortcut ------------------------------------------------ */

    _shortcutLabel() {
        const pending = this._pendingShortcut;
        if (pending === 'CLEAR')
            return 'Will be cleared when you press Apply.'
                + (this._currentShortcut() ? '' : ' (no shortcut set)');
        const cur = this._currentShortcut();
        if (pending)
            return `New shortcut: ${pending} — press Apply to use it.`;
        return cur ?? 'No shortcut — set one to open Spotlight Search.';
    }

    _currentShortcut() {
        const cur = this._settings.get_strv('toggle-shortcut') || [];
        return cur.length > 0 ? cur[0] : null;
    }

    _updateShortcutUi() {
        const pending = this._pendingShortcut;
        const cur = this._currentShortcut();
        let changed = false;
        if (pending === 'CLEAR')
            changed = cur !== null;
        else if (pending)
            changed = pending !== cur;
        this._applyBtn.sensitive = changed;
        if (this._revertBtn)
            this._revertBtn.sensitive = pending !== null;
        this._shortcutRow.subtitle = this._shortcutLabel();
    }

    _buildShortcutPage() {
        const page = new Adw.PreferencesPage({
            title: 'Shortcut',
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'Launch shortcut',
            description: 'Record a new key combination, then press Apply ' +
                'for it to take effect. If the combination is already used ' +
                'by another binding you will be asked whether to replace it. ' +
                'Recording needs at least one modifier key (Ctrl, Alt, Super). ' +
                'Combinations reserved by GNOME Shell itself (Super alone, ' +
                'screenshot, workspace switching) are owned by the system and ' +
                'cannot be captured here.',
        });
        page.add(group);

        this._shortcutRow = new Adw.ActionRow({
            title: 'Launch Spotlight',
            subtitle: this._shortcutLabel(),
        });
        const btnBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
        });
        this._recordBtn = new Gtk.Button({label: 'Record…'});
        this._clearBtn = new Gtk.Button({label: 'Clear'});
        this._applyBtn = new Gtk.Button({label: 'Apply', sensitive: false});
        this._revertBtn = new Gtk.Button({label: 'Revert', sensitive: false});
        btnBox.append(this._recordBtn);
        btnBox.append(this._clearBtn);
        btnBox.append(this._applyBtn);
        btnBox.append(this._revertBtn);
        this._shortcutRow.add_suffix(btnBox);
        group.add(this._shortcutRow);

        this._recordBtn.connect('clicked', () => {
            this._captureShortcut((combo) => {
                if (combo)
                    this._onComboCaptured(combo);
            });
        });
        this._clearBtn.connect('clicked', () => {
            this._pendingShortcut = 'CLEAR';
            this._updateShortcutUi();
        });
        this._applyBtn.connect('clicked', () => this._applyPendingShortcut());
        this._revertBtn.connect('clicked', () => {
            this._pendingShortcut = null;
            this._updateShortcutUi();
        });
        return page;
    }

    _captureShortcut(done) {
        let finished = false;
        let teardownStage = null;
        const finish = (combo) => {
            if (finished)
                return;
            finished = true;
            if (teardownStage)
                teardownStage();
            try {
                win.close();
            } catch (e) {}
            if (win.is_visible())
                win.set_visible(false);
            done(combo);
        };

        const win = new Gtk.Window({
            title: 'Set launch shortcut',
            modal: true,
            transient_for: this._shortcutRow.get_root(),
            resizable: false,
            default_width: 420,
            default_height: 180,
        });
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 14,
            margin_top: 22,
            margin_bottom: 22,
            margin_start: 22,
            margin_end: 22,
        });
        const tip = new Gtk.Label({
            label: 'Press the new shortcut combination…\n' +
                'A modifier (Ctrl, Alt or Super) is required. ' +
                'Esc or Cancel keeps the current shortcut.',
            xalign: 0,
            wrap: true,
        });
        const entry = new Gtk.Entry({
            editable: false,
            hexpand: true,
            text: 'Waiting for a key press…',
        });
        const cancelBtn = new Gtk.Button({
            label: 'Cancel',
            halign: Gtk.Align.END,
        });
        box.append(tip);
        box.append(entry);
        box.append(cancelBtn);
        win.set_child(box);

        cancelBtn.connect('clicked', () => finish(null));
        win.connect('close-request', () => {
            finish(null);
            return false;
        });

        const accept = (combo) => {
            if (!combo)
                return false;
            entry.text = combo;
            finish(combo);
            return true;
        };

        const controller = new Gtk.EventControllerKey();
        controller.propagation_phase = Gtk.PropagationPhase.CAPTURE;
        win.add_controller(controller);
        controller.connect('key-pressed',
            (ctrl, keyval, keycode, state) => {
                const r = _comboFromKey(keyval, state);
                if (r === 'ESC') {
                    finish(null);
                    return true;
                }
                if (r === 'MOD')
                    return false;
                if (r) {
                    accept(r);
                    return true;
                }
                entry.text =
                    'Modifier required — press Ctrl, Alt or Super plus a key.';
                return true;
            });

        /* Prefs run inside gnome-shell, so also listen at the Clutter stage
           level. Keys the Gtk window misses (focus or in-shell grab issues)
           are still seen here, and we consume what we capture so typed keys
           don't also fall through to the dialog. */
        try {
            const stage = global.stage;
            if (stage && typeof stage.connect === 'function') {
                const id = stage.connect('captured-event', (actor, event) => {
                    try {
                        if (event.type() !== Clutter.EventType.KEY_PRESS)
                            return Clutter.EVENT_PROPAGATE;
                        const r = _comboFromKey(event.get_key_symbol(),
                            event.get_state());
                        if (r === 'ESC') {
                            finish(null);
                            return Clutter.EVENT_STOP;
                        }
                        if (r === 'MOD')
                            return Clutter.EVENT_PROPAGATE;
                        if (r) {
                            accept(r);
                            return Clutter.EVENT_STOP;
                        }
                    } catch (e) {
                        prefsLog(`stage capture ERROR ${e}`);
                    }
                    return Clutter.EVENT_PROPAGATE;
                });
                teardownStage = () => {
                    try {
                        stage.disconnect(id);
                    } catch (e) {}
                };
            }
        } catch (e) {
            prefsLog(`stage capture unavailable: ${e}`);
        }

        win.present();
        entry.grab_focus();
    }

    _onComboCaptured(combo) {
        const conflict = _findConflict(combo);
        this._pendingShortcut = combo;
        if (!conflict) {
            this._updateShortcutUi();
            return;
        }
        const md = new Adw.MessageDialog({
            heading: 'Shortcut already in use',
            body: `“${combo}” is already bound to ` +
                `“${conflict.key}” (${conflict.source}).\n\n` +
                'Use Spotlight Search with this shortcut instead, or keep ' +
                'the current binding? Nothing is applied until you press Apply.',
            modal: true,
            transient_for: this._shortcutRow.get_root(),
        });
        md.add_response('keep', 'Keep current');
        md.add_response('use', 'Use Spotlight');
        md.set_default_response('keep');
        md.connect('response', (dialog, response) => {
            if (response === 'keep')
                this._pendingShortcut = null;
            this._updateShortcutUi();
            dialog.close();
        });
        md.present();
    }

    _applyPendingShortcut() {
        const pending = this._pendingShortcut;
        if (pending === null)
            return;
        if (pending === 'CLEAR') {
            this._settings.set_strv('toggle-shortcut', []);
            prefsLog('shortcut cleared (applied)');
            this._pendingShortcut = null;
            this._updateShortcutUi();
            return;
        }
        const conflict = _findConflict(pending);
        if (!conflict) {
            this._settings.set_strv('toggle-shortcut', [pending]);
            prefsLog(`shortcut applied -> ${pending}`);
            this._pendingShortcut = null;
            this._updateShortcutUi();
            return;
        }
        const md = new Adw.MessageDialog({
            heading: 'Shortcut already in use',
            body: `“${pending}” is already bound to ` +
                `“${conflict.key}” (${conflict.source}).\n\n` +
                'Replace it so Spotlight Search uses this shortcut?',
            modal: true,
            transient_for: this._shortcutRow.get_root(),
        });
        md.add_response('cancel', 'Cancel');
        md.add_response('replace', 'Replace');
        md.set_default_response('cancel');
        md.connect('response', (dialog, response) => {
            if (response === 'replace') {
                this._settings.set_strv('toggle-shortcut', [pending]);
                prefsLog(`shortcut replaced (was ${conflict.key}) -> ${pending}`);
                this._pendingShortcut = null;
                this._updateShortcutUi();
            }
            dialog.close();
        });
        md.present();
    }

    _buildHotWordPage() {
        const page = new Adw.PreferencesPage({
            title: 'HotWord',
            icon_name: 'audio-input-microphone-symbolic',
        });

        this._hotWordGroup = new Adw.PreferencesGroup({
            title: 'HotWords',
            description: 'Words that trigger an action when typed in the ' +
                'search box. Each row is stored as "word|type|target". ' +
                'Types: Open URL (open a webpage in the default browser), ' +
                'Run command (execute a shell command), System action ' +
                '(lock, logout, suspend, restart, poweroff). The word is ' +
                'bolded and highlighted in the search box, and pressing ' +
                'Enter runs its action. Changes apply immediately.',
        });
        page.add(this._hotWordGroup);

        const addBtn = new Gtk.Button({label: 'Add HotWord'});
        addBtn.connect('clicked', () => {
            try {
                const entries = this._settings.get_strv('hotwords');
                entries.push('|url|');
                this._settings.set_strv('hotwords', entries);
                this._rebuildHotWords();
                const rows = this._hotWordRows;
                if (rows.length > 0) {
                    const last = rows[rows.length - 1];
                    last.tok.grab_focus();
                    last.tok.select_region(0, -1);
                }
                this._setStatus('Added. Type a word and a target in the ' +
                    'new row — it saves as you type.');
            } catch (e) {
                prefsLog(`ADD ERROR: ${e} :: ${e?.stack || ''}`);
                this._setStatus(`Error adding: ${e.message}`);
            }
        });
        const addRow = new Adw.ActionRow({
            title: 'Register a new HotWord',
            subtitle: 'Append a new word to trigger an action.',
        });
        addRow.add_suffix(addBtn);
        this._hotWordGroup.add(addRow);

        this._hotWordStatus = new Gtk.Label({
            halign: Gtk.Align.START,
            wrap: true,
            margin_top: 6,
            margin_bottom: 2,
            label: '',
        });
        this._hotWordGroup.add(this._hotWordStatus);

        this._rebuildHotWords();
        return page;
    }

    _setStatus(text) {
        if (this._hotWordStatus)
            this._hotWordStatus.label = text;
    }

    _rebuildHotWords() {
        this._clearHotWordRows();
        try {
            const entries = this._settings.get_strv('hotwords');
            prefsLog(`rebuild: ${entries.length} hotwords -> ${entries.join(' | ')}`);
            entries.forEach((entry, index) => {
                const [token = '', type = 'url', target = ''] = entry.split('|');
                const row = this._buildHotWordRow(index, token, type, target);
                this._hotWordGroup.add(row);
            });
        } catch (e) {
            prefsLog(`REBUILD ERROR: ${e} :: ${e?.stack || ''}`);
            this._setStatus(`Error loading hotwords: ${e.message}`);
        }
    }

    _clearHotWordRows() {
        this._hotWordRows.forEach(({row}) => {
            if (row.get_parent())
                row.unparent();
        });
        this._hotWordRows = [];
    }

    _hotWordPlaceholder(type) {
        if (type === 'command')
            return 'notify-send "Hello from Spotlight"';
        if (type === 'system')
            return 'e.g. lock, logout, suspend, restart, poweroff';
        return 'https://www.youtube.com';
    }

    _buildHotWordRow(index, token, type, target) {
        const wrap = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
        });

        const fields = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            hexpand: true,
        });

        const tok = new Gtk.Entry({
            text: token,
            placeholder_text: 'youtube',
            hexpand: true,
            tooltip_text: 'Word to recognize',
        });
        const model = Gtk.StringList.new(HOTWORD_TYPES.map(t => t[1]));
        const types = new Gtk.DropDown({model, hexpand: true});
        types.selected = Math.max(0, HOTWORD_TYPES.findIndex(t => t[0] === type));
        const tgt = new Gtk.Entry({
            text: target,
            placeholder_text: this._hotWordPlaceholder(type),
            hexpand: true,
        });

        const del = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            tooltip_text: 'Delete HotWord',
            valign: Gtk.Align.CENTER,
        });
        del.connect('clicked', () => {
            try {
                const entries = this._settings.get_strv('hotwords');
                entries.splice(index, 1);
                this._settings.set_strv('hotwords', entries);
                this._rebuildHotWords();
                this._setStatus('Deleted.');
            } catch (e) {
                prefsLog(`DELETE ERROR: ${e} :: ${e?.stack || ''}`);
                this._setStatus(`Error deleting: ${e.message}`);
            }
        });

        fields.append(tok);
        fields.append(types);
        fields.append(tgt);
        fields.append(del);
        wrap.append(fields);

        const save = () => this._saveHotWord(index, tok, types, tgt);
        tok.connect('changed', save);
        types.connect('notify::selected', () => {
            tgt.placeholder_text = this._hotWordPlaceholder(
                HOTWORD_TYPES[types.selected]?.[0] || 'url');
            save();
        });
        tgt.connect('changed', save);

        this._hotWordRows.push({row: wrap, index, tok, types, tgt});
        return wrap;
    }

    _saveHotWord(index, tok, types, tgt) {
        try {
            const token = tok.text.trim();
            const type = HOTWORD_TYPES[types.selected]?.[0] || 'url';
            const target = tgt.text.trim();
            if (token === '' || target === '')
                return;
            const entries = this._settings.get_strv('hotwords');
            entries[index] = `${token}|${type}|${target}`;
            this._settings.set_strv('hotwords', entries);
            prefsLog(`saved[${index}] = ${token}|${type}|${target}`);
            this._setStatus(`Saved "${token}".`);
        } catch (e) {
            prefsLog(`SAVE ERROR: ${e} :: ${e?.stack || ''}`);
        }
    }

    _buildSearchBoxPage() {
        const page = new Adw.PreferencesPage({
            title: 'Search Box',
            icon_name: 'preferences-desktop-display-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: 'Appearance',
            description: 'Customize how the Spotlight search box looks. ' +
                'Changes apply the next time the search box opens.',
        });
        page.add(group);

        group.add(this._spinRow('Panel width (px)', 'panel-width', 320, 2560, 10));
        group.add(this._spinRow('Text size (px)', 'panel-font-size', 12, 72, 1));
        group.add(this._spinRow('Corner radius (px)', 'panel-radius', 0, 60, 1));

        const theme = this._comboRow('Theme', 'theme', [
            ['default', 'Default'],
            ['light', 'Light'],
            ['midnight', 'Midnight'],
            ['ocean', 'Ocean'],
            ['glass', 'Glass'],
            ['blur', 'Blur'],
        ]);
        group.add(theme);

        const glow = new Adw.SwitchRow({
            title: 'Glow around search bar',
            subtitle: 'Adds a soft colored halo around the panel, like ' +
                'macOS Spotlight.',
        });
        this._settings.bind('enable-glow', glow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(glow);

        const opacity = new Adw.ActionRow({
            title: 'Background opacity',
            subtitle: 'How transparent the search panel is.',
        });
        const scale = new Gtk.Scale({
            adjustment: new Gtk.Adjustment({
                value: this._settings.get_double('panel-opacity'),
                lower: 0.3,
                upper: 1.0,
                step_increment: 0.01,
            }),
            digits: 2,
            hexpand: true,
        });
        this._settings.bind('panel-opacity', scale, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        opacity.add_suffix(scale);
        group.add(opacity);

        group.add(this._spinRow('Position from top (%)', 'panel-y-offset', 0, 80, 1));

        return page;
    }

    _spinRow(title, key, lower, upper, step) {
        const row = new Adw.ActionRow({title});
        const spin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                value: this._settings.get_int(key),
                lower,
                upper,
                step_increment: step,
            }),
            valign: Gtk.Align.CENTER,
        });
        this._settings.bind(key, spin, 'value', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(spin);
        return row;
    }

    _comboRow(title, key, options) {
        const values = options.map(o => o[0]);
        const row = new Adw.ComboRow({
            title,
            model: Gtk.StringList.new(options.map(o => o[1])),
        });
        let cur = 0;
        try {
            cur = Math.max(0, values.indexOf(this._settings.get_string(key)));
        } catch (e) {}
        row.selected = cur;
        row.connect('notify::selected', () => {
            this._settings.set_string(key, values[row.selected]);
        });
        return row;
    }

    _buildPrefixPage() {
        const page = new Adw.PreferencesPage({
            title: 'Web Prefixes',
            icon_name: 'preferences-system-search-symbolic',
        });

        this._prefixGroup = new Adw.PreferencesGroup({
            title: 'Search prefixes',
            description: 'Type "<token> query" in Spotlight to open the ' +
                'results in your browser. Prefixes are stored as ' +
                '"token|Label|url prefix", e.g. ' +
                '"-g|Google|https://www.google.com/search?q=". ' +
                'Changes apply immediately.',
        });
        page.add(this._prefixGroup);

        const addBtn = new Gtk.Button({label: 'Add Prefix'});
        addBtn.connect('clicked', () => {
            const entries = this._settings.get_strv('web-prefixes');
            entries.push(DEFAULT_PREFIX);
            this._settings.set_strv('web-prefixes', entries);
            this._rebuildPrefixes();
        });
        const addRow = new Adw.ActionRow({
            title: 'Register a new prefix',
            subtitle: 'Append a new token to search other websites.',
        });
        addRow.add_suffix(addBtn);
        this._prefixGroup.add(addRow);

        this._rebuildPrefixes();
        return page;
    }

    _rebuildPrefixes() {
        this._clearPrefixRows();
        const entries = this._settings.get_strv('web-prefixes');
        entries.forEach((entry, index) => {
            const [token = '', label = '', prefix = ''] = entry.split('|');
            const row = this._buildEntryRow(index, token, label, prefix);
            this._prefixGroup.add(row);
        });
    }

    _clearPrefixRows() {
        this._prefixRows.forEach(({row}) => {
            if (row.get_parent())
                row.unparent();
        });
        this._prefixRows = [];
    }

    _buildEntryRow(index, token, label, prefix) {
        const wrap = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
        });

        const title = new Gtk.Label({
            label: token || '(prefix)',
            halign: Gtk.Align.START,
        });
        wrap.append(title);

        const fields = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            hexpand: true,
        });

        const tok = new Gtk.Entry({
            text: token,
            placeholder_text: '-g',
            hexpand: true,
        });
        const eng = new Gtk.Entry({
            text: label,
            placeholder_text: 'Google',
            hexpand: true,
        });
        const url = new Gtk.Entry({
            text: prefix,
            placeholder_text: 'https://example.com/search?q=',
            hexpand: true,
        });

        const del = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            tooltip_text: 'Delete prefix',
            valign: Gtk.Align.CENTER,
        });
        del.connect('clicked', () => {
            const entries = this._settings.get_strv('web-prefixes');
            entries.splice(index, 1);
            this._settings.set_strv('web-prefixes', entries);
            this._rebuildPrefixes();
        });

        fields.append(tok);
        fields.append(eng);
        fields.append(url);
        fields.append(del);
        wrap.append(fields);

        const save = () => this._savePrefixes(index);
        tok.connect('changed', save);
        eng.connect('changed', save);
        url.connect('changed', save);

        this._prefixRows.push({row: wrap, index, tok, eng, url});
        return wrap;
    }

    _savePrefixes(index) {
        const rowData = this._prefixRows.find(r => r.index === index);
        if (!rowData)
            return;
        const token = rowData.tok.text.trim();
        const flag = rowData.eng.text.trim();
        const prefix = rowData.url.text.trim();
        if (token === '' || prefix === '')
            return;
        const entries = this._settings.get_strv('web-prefixes');
        entries[index] = `${token}|${flag || token}|${prefix}`;
        this._settings.set_strv('web-prefixes', entries);
    }
}