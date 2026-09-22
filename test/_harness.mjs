import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------- stub island ---------- */

const calls = {uris: [], subbed: [], notify: [], clipSet: [], soupReq: 0};

const clipMethods = {
    set_content: (type, mime, bytes) => calls.clipSet.push('IMG:' + String(mime)),
};

const GIO = {
    AppInfo: {launch_default_for_uri: (uri, _ctx) => {calls.uris.push(uri); return true;}},
    SubprocessFlags: {STDERR_SILENCE: 1},
    Subprocess: {
        new(argv, _flags) {
            calls.subbed.push(argv);
            return {wait_check_async: () => {}, wait_check: () => true};
        },
    },
    DBus: {
        session: {call_sync: () => ({})},
        system: {call_sync: () => ({})},
    },
    Cancellable: class {cancel() {}},
    FileType: {REGULAR: 1, DIRECTORY: 2, SYMBOLIC_LINK: 3},
    FileQueryInfoFlags: {NONE: 0},
    DBusProxyFlags: {NONE: 0},
    DBusProxy: {
        new_sync: () => ({
            get_value: () => 0.5,
            SetBrightnessSilent: () => true,
            SetBrightness: () => true,
        }),
    },
};

/* Virtual filesystem used by the `ls` tests. map: path -> [{name, isDir}].
   new_for_path consults it live, and setLsFs also overrides GLib.file_test
   so directories resolve against the map keys. */
let lsFs = null;
const emptyEnumerator = () => ({next_file: () => null, close: () => {}});
GIO.File = {
    new_for_path: (p) => {
        const list = lsFs ? (lsFs.get(p) ?? null) : null;
        const enumerator = list
            ? () => {
                let i = 0;
                return {
                    next_file: () => {
                        if (i >= list.length)
                            return null;
                        const e = list[i++];
                        return {
                            get_name: () => e.name,
                            get_file_type: () => e.isDir
                                ? GIO.FileType.DIRECTORY
                                : GIO.FileType.REGULAR,
                        };
                    },
                    close: () => {},
                };
            }
            : emptyEnumerator;
        return {
            replace_contents: () => [true, null],
            delete: () => true,
            get_path: () => p,
            get_uri: () => 'file://' + p,
            enumerate_children: () => enumerator(),
        };
    },
};
const lsFileTest = (p) => Boolean(lsFs && lsFs.has(p));
function setLsFs(map) {
    lsFs = map || null;
    GLIB.file_test = lsFs ? lsFileTest : () => false;
}

const GLIB = {
    get_home_dir: () => '/home/test',
    getenv: () => null,
    timeout_add: () => 42,
    timeout_add_seconds: () => 7,
    source_remove: () => true,
    SOURCE_REMOVE: false,
    SOURCE_CONTINUE: true,
    PRIORITY_DEFAULT: 0,
    PRIORITY_DEFAULT_IDLE: 200,
    FileCreateFlags: {NONE: 0, REPLACE_DESTINATION: 1},
    ChecksumType: {MD5: 'md5', SHA256: 'sha256'},
    compute_checksum_for_bytes: () => 'abcd1234ef567890',
    get_user_cache_dir: () => '/tmp',
    file_test: () => false,
    get_file_size: () => 0,
    remove: () => true,
    find_program_in_path: () => null,
    G_FILE_TEST_EXISTS: 0,
    G_FILE_TEST_IS_DIR: 4,
};

const GDK_KEY = (v, name) => ({[`KEY_${name}`]: v, [`KEY_${name}_KEYVAL`]: v});

const GDK = {
    KEY_Escape: 0xff1b,
    KEY_Shift_L: 0xffe1, KEY_Shift_R: 0xffe2,
    KEY_Control_L: 0xffe3, KEY_Control_R: 0xffe4,
    KEY_Alt_L: 0xffe9, KEY_Alt_R: 0xffea,
    KEY_Super_L: 0xffeb, KEY_Super_R: 0xffec,
    KEY_Meta_L: 0xffe7, KEY_Meta_R: 0xffe8,
    KEY_Hyper_L: 0xffed, KEY_Hyper_R: 0xffee,
    KEY_Caps_Lock: 0xffe5, KEY_Num_Lock: 0xff7f,
    KEY_ISO_Level3_Shift: 0xfe03,
    Display: {get_default: () => 'display'},
    Clipboard: {new_for_display: display => ({set_content: () => true})},
    ContentProvider: {new_for_bytes: (mime, bytes) => `CP:${mime}`},
};

const G_MOD_MASK = (1 << 0) | (1 << 2) | (1 << 3) | (1 << 6); /* Shift|Ctrl|Alt|Super */
const KEY_NAME = {0xffe1: 'Shift', 0xffe3: 'Control', 0xffe9: 'Alt', 0xffeb: 'Super', 0x20: 'space', 0x61: 'a'};
const MOD_PREFIX = {[1 << 0]: '<Shift>', [1 << 2]: '<Control>', [1 << 3]: '<Alt>', [1 << 6]: '<Super>'};

const GTK = {
    accelerator_get_default_mod_mask: () => G_MOD_MASK,
    accelerator_name(keyval, mods) {
        const parts = [];
        for (const [bit, prefix] of Object.entries(MOD_PREFIX)) {
            if (bit & mods)
                parts.push(prefix);
        }
        return (parts.join('') + (KEY_NAME[keyval] ?? String.fromCharCode(keyval))).toLowerCase();
    },
};

const ST = {
    Entry: class {}, BoxLayout: class {}, Icon: class {}, Label: class {},
    Widget: class {}, DrawingArea: class {}, Style: {},
    ClipboardType: {CLIPBOARD: 1},
    Clipboard: {
        get_default: () => ({
            set_text: (type, text) => { calls.clipSet.push(String(text)); },
            get_text: (type, cb) => {
                if (typeof cb === 'function')
                    setTimeout(() => cb({}, 'clipboard probe text'), 0);
            },
            get_mimetypes: () => ['image/png'],
            get_content: (type, mime, cb) => {
                if (typeof cb === 'function')
                    setTimeout(
                        () => cb({}, {get_data: () => new Uint8Array(4)}), 0);
            },
            set_content: (type, mime, bytes) => clipMethods.set_content(type, mime, bytes),
            connect: () => 1,
            disconnect: () => true,
        }),
    },
};
const CLUTTER = {Orientation: {VERTICAL: 1, HORIZONTAL: 2}, Event: {event_type: 1},
    grab_key_focus: () => {}, Style: {}, RotationMode: {}, ActorAlign: {},
    Image: class {constructor(o) {this.width = o?.width; this.height = o?.height;}},
    ImageAccessFlags: {READ: 1, WRITE: 2},
    EVENT_PROPAGATE: true, EVENT_STOP: false};
const META = {KeyBindingFlags: {NONE: 0}, KeyBindingAction: {NONE: 0},
    SideEffect: {NONE: 0}, StartupNotificationId: {}, Display: {}};
const SHELL = {ActionMode: {ALL: 0, SYSTEM_MODAL: 1}, AppSystem: {get_default: () => ({connect: () => 1})}};
const PANGO = {AttrList: class {insert() {}}, Style: {ITALIC: 2}, attr_style_new: () => ({}), attr_foreground_new: () => ({})};
const MAIN = {
    notify: (t, b) => calls.notify.push([t, b]),
    pushModal: () => 1, popModal: () => {}, wm: {}, layoutManager: {uiGroup: {add_child(){}, remove_child(){}}},
    overview: {visible: false, hide(){}}, modalCount: 0,
};
const EXT_CLASS = class {};
const GObject = {};

function emptyStub(name) {
    return new Proxy({}, {
        get(t, p) { return t[p] ?? (name + '.' + String(p)); },
    });
}

const MODULE_STUBS = {
    'gi://Gio': GIO, 'gi://GLib': GLIB, 'gi://Gdk': GDK, 'gi://Gtk': GTK,
    'gi://St': ST, 'gi://Clutter': CLUTTER, 'gi://Meta': META, 'gi://Shell': SHELL,
    'gi://Pango': PANGO,
    'gi://Soup': {
        Session: class {
            constructor() { this.msg = null; }
            send_and_read_async(msg, _prio, cancel, cb) {
                calls.soupReq++;
                this.msg = msg;
            }
            send_and_read_finish() {
                return {get_data: () => new TextEncoder().encode('["q",["a","b"]]')};
            }
        },
        Message: {new: (method, uri) => ({method, uri})},
    },
    'resource:///org/gnome/shell/extensions/extension.js': {Extension: EXT_CLASS},
    'resource:///org/gnome/shell/ui/main.js': MAIN,
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js':
        {ExtensionPreferences: EXT_CLASS},
};

function transpile(src) {
    let s = src;
    s = s.replace(/import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;/g,
        'const $1 = STUBS["$2"];');
    s = s.replace(/import\s+([\w]+(?:\s*,\s*\{[^}]*\})?|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]\s*;/g,
        'const $1 = STUBS["$2"];');
    s = s.replace(/\bexport\s+default\s+class\s+(\w+)/g, 'class $1');
    s = s.replace(/\bexport\s+(class|function|const|let)\s+/g, '$1 ');
    s = s.replace(/export\s*\{[^}]*\}\s*;?/g, '');
    return s;
}

function loadModule(file, appendix) {
    let src = transpile(readFileSync(join(SRC_DIR, file), 'utf8'));
    if (appendix)
        src += '\n' + appendix;
    const sandbox = {STUBS: MODULE_STUBS, console, Math, Date, JSON, Map, Set, BigInt,
        RegExp, Number, String, Array, Object, Proxy, Promise, Error, NaN, Infinity, undefined};
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, {filename: file});
    return sandbox;
}

/* extension.js: expose the class + shared state */
const ext = loadModule('extension.js',
    'globalThis.__SS_CLASS = SpotlightSearchExtension;');
ext.SpotlightSearchExtension = ext.__SS_CLASS;

/* prefs.js: pure helpers become sandbox globals automatically */
const prefs = loadModule('prefs.js');

function SptInstance(settings) {
    const inst = Object.create(ext.SpotlightSearchExtension.prototype);
    inst._settings = settings ?? {get_strv: () => []};
    inst._hotWordsCache = null;
    inst._hotWordsCacheAt = 0;
    return inst;
}

export {GIO, GLIB, GTK, GDK, calls, clipMethods, ext, prefs, loadModule, SptInstance, setLsFs};