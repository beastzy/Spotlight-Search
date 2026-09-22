/* Spotlight Search — a macOS/Spotlight-style quick launcher for GNOME Shell.
 * Targets GNOME 45+ (ES modules).
 * Version: 1.0
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Soup from 'gi://Soup';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const BINDING_NAME = 'toggle-shortcut';
const LOG_PATH = `${GLib.get_home_dir()}/.local/share/spotlight-search.log`;

/* Per-keystroke debug logging is expensive (string allocation + disk
 * churn), so it is compiled out unless explicitly enabled. */
const _DEBUG = false;

/* ------------------------------------------------------------------ *
 * Logging — batched in memory, flushed to disk at most every ~2 s,
 * log file capped at 4 MB so logging can never jank the shell.
 * ------------------------------------------------------------------ */

let _logBuf = [];
let _logTimer = 0;

function _logFlush() {
    _logTimer = 0;
    if (_logBuf.length === 0)
        return;
    try {
        const chunk = _logBuf.join('');
        _logBuf = [];
        if (GLib.file_test(LOG_PATH, GLib.FileTest.EXISTS) &&
            GLib.get_file_size(LOG_PATH) > 4 * 1024 * 1024)
            GLib.remove(LOG_PATH);
        const os = Gio.File.new_for_path(LOG_PATH)
            .append_to(Gio.FileCreateFlags.NONE, null)
            .get_output_stream();
        os.write_all(chunk, null);
        os.close(null);
    } catch (e) {
        /* logging must never break the extension */
    }
}

function spotLog(msg) {
    if (!_DEBUG)
        return;
    _logBuf.push(new Date().toISOString() + ' ' + msg + '\n');
    if (_logBuf.length >= 500) {
        _logFlush();
        return;
    }
    if (_logTimer === 0) {
        _logTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT_IDLE, 2, () => {
            _logTimer = 0;
            _logFlush();
            return GLib.SOURCE_REMOVE;
        });
    }
}

/* ------------------------------------------------------------------ *
 * Themes
 * ------------------------------------------------------------------ */

const THEMES = {
    default: {
        panelBg: '28, 29, 33',
        entryColor: 'white',
        caret: '#4A90E2',
        highlight: 'rgba(255,255,255,0.12)',
        subColor: 'rgba(255,255,255,0.45)',
        glow: 'rgba(74,144,226,0.40)',
        ring: 'rgba(255,255,255,0.10)',
        alphaCap: 1,
    },
    light: {
        panelBg: '245, 246, 250',
        entryColor: '#1a1a1a',
        caret: '#0a66c2',
        highlight: 'rgba(0,0,0,0.08)',
        subColor: 'rgba(0,0,0,0.5)',
        glow: 'rgba(10,102,194,0.35)',
        ring: 'rgba(0,0,0,0.08)',
        alphaCap: 1,
    },
    midnight: {
        panelBg: '16, 16, 20',
        entryColor: 'white',
        caret: '#bb86fc',
        highlight: 'rgba(187,134,252,0.18)',
        subColor: 'rgba(255,255,255,0.45)',
        glow: 'rgba(187,134,252,0.40)',
        ring: 'rgba(187,134,252,0.18)',
        alphaCap: 1,
    },
    ocean: {
        panelBg: '12, 24, 45',
        entryColor: 'white',
        caret: '#38bdf8',
        highlight: 'rgba(56,189,248,0.20)',
        subColor: 'rgba(255,255,255,0.45)',
        glow: 'rgba(56,189,248,0.45)',
        ring: 'rgba(56,189,248,0.22)',
        alphaCap: 1,
    },
    glass: {
        panelBg: '28, 32, 40',
        entryColor: 'white',
        caret: '#7dd3fc',
        highlight: 'rgba(255,255,255,0.14)',
        subColor: 'rgba(255,255,255,0.55)',
        glow: 'rgba(125,211,252,0.50)',
        ring: 'rgba(255,255,255,0.18)',
        alphaCap: 0.5,
        backdrop: 'blur(18px) saturate(1.15) brightness(1.05)',
    },
    blur: {
        panelBg: '16, 18, 24',
        entryColor: 'white',
        caret: '#c7d2fe',
        highlight: 'rgba(255,255,255,0.14)',
        subColor: 'rgba(255,255,255,0.5)',
        glow: 'rgba(199,210,254,0.32)',
        ring: 'rgba(255,255,255,0.12)',
        alphaCap: 0.45,
        backdrop: 'blur(26px) saturate(1.25) brightness(1.1)',
    },
};

function currentTheme(settings) {
    let name = 'default';
    try {
        name = settings.get_string('theme') || 'default';
    } catch (e) {}
    return THEMES[name] || THEMES.default;
}

function glowEnabled(settings) {
    try {
        return settings.get_boolean('enable-glow');
    } catch (e) {
        return true;
    }
}

/* ------------------------------------------------------------------ *
 * Ribbon — two bright-soft pastel palettes (pink, peach, baby blue,
 * periwinkle / rose, gold, sky blue, violet). The ribbon blends between
 * them as it rotates around the search box, like the iOS 26 Siri glow,
 * smoothstepped so the color stays continuous around the ring.
 * ------------------------------------------------------------------ */

const PALETTE_A = [
    [1.00, 0.55, 0.70],
    [1.00, 0.78, 0.50],
    [0.55, 0.80, 1.00],
    [0.80, 0.62, 1.00],
    [1.00, 0.55, 0.70],
];

const PALETTE_B = [
    [1.00, 0.45, 0.60],
    [1.00, 0.86, 0.38],
    [0.40, 0.82, 1.00],
    [0.70, 0.55, 1.00],
    [1.00, 0.45, 0.60],
];

const SOFT_SCRATCH = new Float64Array(3);

function softCycle(a, mix, out) {
    const n = PALETTE_A.length;
    const x = ((a % 1) + 1) % 1 * (n - 1);
    const i = Math.min(n - 2, Math.floor(x));
    const f = x - i;
    const s = f * f * (3 - 2 * f);
    const A0 = PALETTE_A[i], A1 = PALETTE_A[i + 1];
    const B0 = PALETTE_B[i], B1 = PALETTE_B[i + 1];
    const pick = (P0, P1, k) => P0[k] + (P1[k] - P0[k]) * s;
    const mixC = (cA, cB) => cA + (cB - cA) * mix;
    out[0] = mixC(pick(A0, A1, 0), pick(B0, B1, 0));
    out[1] = mixC(pick(A0, A1, 1), pick(B0, B1, 1));
    out[2] = mixC(pick(A0, A1, 2), pick(B0, B1, 2));
}

function wrapAngle(a) {
    return ((a % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
}

function pointOnRoundedRect(cx, cy, hw, hh, r, u) {
    if (hw <= 1e-6 || hh <= 1e-6)
        return [cx, cy];
    r = Math.min(Math.abs(r), hw, hh);
    const sw = Math.max(hw * 2 - r * 2, 0);
    const sh = Math.max(hh * 2 - r * 2, 0);
    const q = (Math.PI / 2) * r;
    const lens = [sw, q, sh, q, sw, q, sh, q];
    const total = lens.reduce((a, b) => a + b, 0);
    if (total <= 1e-6)
        return [cx, cy];
    const s = (((u % 1) + 1) % 1) * total;
    let acc = 0;
    for (let i = 0; i < 8; i++) {
        const L = lens[i];
        if (s - acc < L || i === 7) {
            const t = Math.max(0, Math.min(1, L > 0 ? (s - acc) / L : 0));
            switch (i) {
                case 0: return [cx - hw + r + sw * t, cy - hh];
                case 2: return [cx + hw, cy - hh + r + sh * t];
                case 4: return [cx + hw - r - sw * t, cy + hh];
                case 6: return [cx - hw, cy + hh - r - sh * t];
            }
            const corner = Math.floor((i - 1) / 2);
            const cxp = corner === 0 || corner === 1 ? cx + hw - r : cx - hw + r;
            const cyp = corner === 0 || corner === 3 ? cy - hh + r : cy + hh - r;
            const a0 = [270, 0, 90, 180][corner];
            const a = (a0 + 90 * t) * Math.PI / 180;
            return [cxp + r * Math.cos(a), cyp + r * Math.sin(a)];
        }
        acc += L;
    }
    return [cx, cy];
}

/* ------------------------------------------------------------------ *
 * System actions & launcher helpers
 * ------------------------------------------------------------------ */

const SYSTEM_ACTIONS = [
    {
        id: 'lock',
        label: 'Lock Screen',
        keyword: ['lock', 'screen lock', 'lock screen'],
        icon: 'system-lock-screen',
        run: () => dbusCall(Gio.DBus.session, 'org.gnome.ScreenSaver',
            '/org/gnome/ScreenSaver', 'org.gnome.ScreenSaver', 'Lock', null),
    },
    {
        id: 'logout',
        label: 'Log Out',
        keyword: ['log out', 'logout', 'sign out', 'exit'],
        icon: 'system-log-out',
        run: () => dbusCall(Gio.DBus.session, 'org.gnome.SessionManager',
            '/org/gnome/SessionManager', 'org.gnome.SessionManager', 'Logout',
            new GLib.Variant('(u)', [1])),
    },
    {
        id: 'suspend',
        label: 'Suspend',
        keyword: ['suspend', 'sleep'],
        icon: 'system-suspend',
        run: () => dbusCall(Gio.DBus.system, 'org.freedesktop.login1',
            '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', 'Suspend',
            new GLib.Variant('(b)', [false])),
    },
    {
        id: 'restart',
        label: 'Restart',
        keyword: ['restart', 'reboot'],
        icon: 'system-reboot',
        run: () => dbusCall(Gio.DBus.system, 'org.freedesktop.login1',
            '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', 'Reboot',
            new GLib.Variant('(b)', [false])),
    },
    {
        id: 'poweroff',
        label: 'Power Off',
        keyword: ['power off', 'shut down', 'shutdown', 'poweroff'],
        icon: 'system-shutdown',
        run: () => dbusCall(Gio.DBus.system, 'org.freedesktop.login1',
            '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', 'PowerOff',
            new GLib.Variant('(b)', [false])),
    },
    {
        id: 'hibernate',
        label: 'Hibernate',
        keyword: ['hibernate', 'hibernation'],
        icon: 'system-suspend-hibernate',
        run: () => dbusCall(Gio.DBus.system, 'org.freedesktop.login1',
            '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', 'Hibernate',
            new GLib.Variant('(b)', [false])),
    },
    {
        id: 'overview',
        label: 'Overview',
        keyword: ['overview', 'show apps', 'show applications', 'apps view',
            'show windows', 'activities'],
        icon: 'view-grid-symbolic',
        run: () => {
            try {
                Main.overview.toggle();
            } catch (e) {
                spotLog(`overview action: ERROR ${e}`);
            }
        },
    },
    {
        id: 'screenshot',
        label: 'Take a Screenshot',
        keyword: ['screenshot', 'screen shot', 'capture screen', 'capture area'],
        icon: 'camera-photo-symbolic',
        run: () => {
            try {
                dbusCall(Gio.DBus.session, 'org.gnome.Shell.Screenshot',
                    '/org/gnome/Shell/Screenshot', 'org.gnome.Shell.Screenshot',
                    'Screenshot', new GLib.Variant('(bs)', [true, '']));
            } catch (e) {
                spotLog(`screenshot action: ERROR ${e}`);
            }
        },
    },
    {
        id: 'trash',
        label: 'Empty Trash',
        keyword: ['empty trash', 'clear trash', 'emptytrash'],
        icon: 'user-trash-full',
        run: () => runShellCommand('gio trash --empty'),
    },
    {
        id: 'user-switch',
        label: 'Switch User',
        keyword: ['switch user', 'user switch', 'switch account', 'switch a user'],
        icon: 'system-users',
        run: () => {
            try {
                dbusCall(Gio.DBus.system, 'org.gnome.DisplayManager',
                    '/org/gnome/DisplayManager', 'org.gnome.DisplayManager.Manager',
                    'SwitchToUser', new GLib.Variant('(s)', ['']));
            } catch (e) {
                spotLog(`user switch action: ERROR ${e}`);
            }
        },
    },
];

function dbusCall(bus, busName, path, iface, method, params) {
    return bus.call_sync(busName, path, iface, method, params, null,
        Gio.DBusCallFlags.NONE, -1, null);
}

function openUri(uri) {
    try {
        let u = String(uri || '').trim();
        if (/^\/\//.test(u))
            u = 'https:' + u;
        else if (!/^[a-z][a-z0-9+.-]*:/i.test(u))
            u = 'https://' + u;
        Gio.AppInfo.launch_default_for_uri(u, null);
    } catch (e) {
        console.error(`Spotlight: cannot open ${u}: ${e.message}`);
    }
}

function runShellCommand(command) {
    try {
        const proc = Gio.Subprocess.new(['sh', '-c', command],
            Gio.SubprocessFlags.STDERR_SILENCE);
        proc.wait_check_async(null, () => {});
    } catch (e) {
        console.error(`Spotlight: cannot run command: ${e.message}`);
    }
}

function launchByDesktopId(id) {
    const dirs = [
        GLib.get_home_dir() + '/.local/share/applications',
        GLib.get_home_dir() + '/.local/share/flatpak/exports/share/applications',
        '/usr/local/share/applications',
        '/usr/share/applications',
        '/var/lib/flatpak/exports/share/applications',
        '/var/lib/snapd/desktop/applications',
    ];
    for (const dir of dirs) {
        const path = dir + '/' + id;
        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            continue;
        try {
            const info = Gio.DesktopAppInfo.new_from_filename(path);
            if (info)
                return info.launch([], null);
        } catch (e) {
            spotLog(`launchByDesktopId: ${path} ERROR ${e}`);
        }
    }
    return false;
}

/* ------------------------------------------------------------------ *
 * Calculator — safe recursive-descent parser
 * ------------------------------------------------------------------ */

function evaluate(expr) {
    const s = expr.toLowerCase().replace(/×/g, '*').replace(/÷/g, '/')
        .replace(/−/g, '-').replace(/\s+/g, '');
    if (!s || !/^[0-9+\-*/().^%a-z_√!]+$/.test(s))
        return null;

    let pos = 0;
    let lookahead = null;

    const tick = () => {
        if (pos >= s.length)
            return null;
        const c = s[pos];
        if (/[a-z_]/.test(c)) {
            let w = '';
            while (pos < s.length && /[a-z_0-9]/.test(s[pos]))
                w += s[pos++];
            return w;
        }
        pos++;
        return c;
    };
    const next = () => (lookahead = tick());

    const parseSum = () => {
        let v = parseTerm();
        while (lookahead === '+' || lookahead === '-') {
            const op = lookahead;
            next();
            const r = parseTerm();
            v = op === '+' ? v + r : v - r;
        }
        return v;
    };
    const parseTerm = () => {
        let v = parseUnary();
        while (lookahead === '*' || lookahead === '/' || lookahead === '%') {
            const op = lookahead;
            next();
            const r = parseUnary();
            if (op === '*')
                v *= r;
            else if (op === '/')
                v /= r;
            else
                v %= r;
        }
        return v;
    };
    const parseUnary = () => {
        if (lookahead === '-') {
            next();
            return -parseUnary();
        }
        if (lookahead === '+') {
            next();
            return parseUnary();
        }
        return parsePower();
    };
    const parsePower = () => {
        const base = parseAtom();
        if (lookahead === '^') {
            next();
            return Math.pow(base, parseUnary());
        }
        return base;
    };
    const parseAtom = () => {
        let v = parseAtomInner();
        while (lookahead === '!') {
            next();
            if (!Number.isInteger(v) || v < 0 || v > 170)
                return NaN;
            let f = 1;
            for (let i = 2; i <= v; i++)
                f *= i;
            v = f;
        }
        return v;
    };
    const parseAtomInner = () => {
        if (lookahead === '√') {
            next();
            return Math.sqrt(parseUnary());
        }
        if (lookahead === '(') {
            next();
            const v = parseSum();
            if (lookahead === ')')
                next();
            return v;
        }
        if (lookahead === null)
            return NaN;
        if (/^[a-z_]/.test(lookahead)) {
            const name = lookahead;
            next();
            switch (name) {
                case 'pi':
                    return Math.PI;
                case 'e':
                    return Math.E;
                case 'tau':
                    return Math.PI * 2;
                case 'phi':
                    return (1 + Math.sqrt(5)) / 2;
                case 'c':
                    return 299792458;
                case 'g':
                    return 9.80665;
                case 'sqrt': case 'abs': case 'round': case 'floor':
                case 'ceil': case 'sin': case 'cos': case 'tan':
                case 'log': case 'ln': {
                    const arg = parseAtom();
                    switch (name) {
                        case 'sqrt': return Math.sqrt(arg);
                        case 'abs': return Math.abs(arg);
                        case 'round': return Math.round(arg);
                        case 'floor': return Math.floor(arg);
                        case 'ceil': return Math.ceil(arg);
                        case 'sin': return Math.sin(arg);
                        case 'cos': return Math.cos(arg);
                        case 'tan': return Math.tan(arg);
                        case 'log': return Math.log10(arg);
                        case 'ln': return Math.log(arg);
                    }
                    return NaN;
                }
                default:
                    return NaN;
            }
        }
        if (/[0-9.]/.test(lookahead)) {
            let num = '';
            let dots = 0;
            while (lookahead !== null && /[0-9.]/.test(lookahead)) {
                if (lookahead === '.') {
                    dots++;
                    if (dots > 1)
                        return NaN;
                }
                num += lookahead;
                next();
            }
            if (num === '' || num === '.' || num.endsWith('.'))
                return NaN;
            return parseFloat(num) || 0;
        }
        next();
        return NaN;
    };

    lookahead = tick();
    try {
        const val = parseSum();
        if (lookahead !== null || Number.isNaN(val) || !Number.isFinite(val))
            return null;
        return String(Math.round(val * 1e10) / 1e10);
    } catch (e) {
        return null;
    }
}

const looksLikeCalc = s =>
    /[0-9]/.test(s) && /[+\-*/^%√().!]/.test(s);

/* ------------------------------------------------------------------ *
 * Unit conversion — offline, factor tables + a temperature branch.
 * ------------------------------------------------------------------ */

const UNIT_TABLES = {
    length: {
        m: 1, meter: 1, meters: 1, metre: 1, metres: 1,
        km: 1000, kilometer: 1000, kilometres: 1000,
        cm: 0.01, mm: 0.001,
        mi: 1609.344, mile: 1609.344, miles: 1609.344,
        ft: 0.3048, foot: 0.3048, feet: 0.3048,
        in: 0.0254, inch: 0.0254, inches: 0.0254,
        yd: 0.9144, yard: 0.9144, yards: 0.9144,
        nmi: 1852,
    },
    mass: {
        kg: 1, kilogram: 1, kilograms: 1,
        g: 0.001, gram: 0.001, grams: 0.001,
        mg: 1e-6, t: 1000, tonne: 1000, tonnes: 1000,
        lb: 0.45359237, pound: 0.45359237, pounds: 0.45359237, lbs: 0.45359237,
        oz: 0.028349523125, ounce: 0.028349523125, ounces: 0.028349523125,
        stone: 6.35029318, st: 6.35029318,
    },
    volume: {
        l: 1, liter: 1, liters: 1, litre: 1, litres: 1,
        ml: 0.001, m3: 1000,
        cup: 0.2365882365, cups: 0.2365882365,
        tbsp: 0.0147867648, tablespoon: 0.0147867648, tablespoons: 0.0147867648,
        tsp: 0.0049289216, teaspoon: 0.0049289216, teaspoons: 0.0049289216,
        gal: 3.785411784, gallon: 3.785411784, gallons: 3.785411784,
        qt: 0.946352946, quart: 0.946352946,
        pt: 0.473176473, pint: 0.473176473,
        floz: 0.0295735296,
    },
    time: {
        s: 1, sec: 1, second: 1, seconds: 1, secs: 1,
        ms: 0.001,
        min: 60, minute: 60, minutes: 60, mins: 60,
        h: 3600, hr: 3600, hour: 3600, hours: 3600,
        day: 86400, days: 86400,
        week: 604800, weeks: 604800,
    },
    speed: {
        'km/h': 1 / 3.6, kph: 1 / 3.6, kmh: 1 / 3.6,
        'm/s': 1, mps: 1,
        mph: 0.44704,
        knot: 0.514444444, knots: 0.514444444, kt: 0.514444444, kts: 0.514444444,
    },
    data: {
        b: 1, byte: 1, bytes: 1,
        kb: 1000, mb: 1e6, gb: 1e9, tb: 1e12,
        kib: 1024, mib: 1048576, gib: 1073741824, tib: 1099511627776,
    },
};

const TEMP_UNITS = {c: 1, celsius: 1, f: 1, fahrenheit: 1, k: 1, kelvin: 1};

function fmtNumber(v) {
    if (v === null || v === undefined || !Number.isFinite(v))
        return null;
    const r = Math.round(v * 1e10) / 1e10;
    if (Math.abs(r) < 1e-10)
        return '0';
    return String(r);
}

function convertUnit(expr) {
    const q = String(expr || '').trim().toLowerCase().replace(/°/g, '');
    if (!q)
        return null;
    const m = q.match(
        /^([0-9]+(?:\.[0-9]+)?|\.[0-9]+)\s*([a-z][a-z0-9/]*)\s+(?:to|in|as|=)\s+([a-z][a-z0-9/]*)$/);
    if (!m)
        return null;
    const value = parseFloat(m[1]);
    const from = m[2];
    const to = m[3];
    const tFrom = TEMP_UNITS[from];
    const tTo = TEMP_UNITS[to];
    if (tFrom && tTo && from !== to) {
        const c = from[0] === 'f' ? (value - 32) * 5 / 9
            : from[0] === 'k' ? value - 273.15 : value;
        const out = to[0] === 'f' ? c * 9 / 5 + 32
            : to[0] === 'k' ? c + 273.15 : c;
        return fmtNumber(out) + ' ' + to;
    }
    for (const table of Object.values(UNIT_TABLES)) {
        const fa = table[from];
        const fb = table[to];
        if (fa !== undefined && fb !== undefined)
            return fmtNumber(value * fa / fb) + ' ' + to;
    }
    return null;
}

/* ------------------------------------------------------------------ *
 * Emoji — keyword -> symbol table for the "emoji …" picker.
 * ------------------------------------------------------------------ */

const EMOJI = [
    ['smile', '😀'], ['grinning', '😀'], ['grin', '😁'], ['joy', '😂'], ['laugh', '😂'],
    ['rofl', '🤣'], ['cool', '😎'], ['sunglasses', '😎'], ['wink', '😉'], ['blush', '😊'],
    ['love', '😍'], ['heart eyes', '😍'], ['heart', '❤️'], ['heartbreak', '💔'],
    ['kiss', '😘'], ['thinking', '🤔'], ['hmm', '🤔'], ['shrug', '🤷'], ['facepalm', '🤦'],
    ['angry', '😡'], ['rage', '😡'], ['cry', '😢'], ['sad', '😢'], ['sob', '😭'],
    ['shock', '😱'], ['scared', '😱'], ['fire', '🔥'], ['flame', '🔥'], ['party', '🎉'],
    ['celebrate', '🎉'], ['tada', '🎉'], ['confetti', '🎊'], ['star', '⭐'],
    ['sparkles', '✨'], ['boom', '💥'], ['zap', '⚡'], ['lightning', '⚡'],
    ['check', '✅'], ['thumbs up', '👍'], ['ok', '👌'], ['clap', '👏'], ['wave', '👋'],
    ['pray', '🙏'], ['muscle', '💪'], ['flex', '💪'], ['rocket', '🚀'],
    ['plane', '✈️'], ['train', '🚆'], ['car', '🚗'], ['taxi', '🚕'],
    ['coffee', '☕'], ['tea', '🍵'], ['beer', '🍺'], ['pizza', '🍕'],
    ['burger', '🍔'], ['taco', '🌮'], ['apple', '🍎'], ['banana', '🍌'],
    ['grapes', '🍇'], ['cake', '🎂'], ['birthday', '🎂'], ['cookie', '🍪'],
    ['chocolate', '🍫'], ['sushi', '🍣'], ['moon', '🌙'], ['sun', '☀️'],
    ['rain', '🌧️'], ['snow', '❄️'], ['snowman', '⛄'], ['cloud', '☁️'],
    ['storm', '⛈️'], ['rainbow', '🌈'], ['flower', '🌸'], ['cherry blossom', '🌸'],
    ['tree', '🌳'], ['palm', '🌴'], ['cat', '🐱'], ['dog', '🐶'], ['paw', '🐾'],
    ['fox', '🦊'], ['bear', '🐻'], ['panda', '🐼'], ['frog', '🐸'], ['unicorn', '🦄'],
    ['money', '💰'], ['dollar', '💵'], ['coin', '🪙'], ['bell', '🔔'], ['alarm', '⏰'],
    ['clock', '🕐'], ['watch', '⌚'], ['battery', '🔋'], ['bulb', '💡'], ['idea', '💡'],
    ['book', '📖'], ['books', '📚'], ['pen', '✏️'], ['pencil', '✏️'], ['art', '🎨'],
    ['paint', '🎨'], ['game', '🎮'], ['controller', '🎮'], ['music', '🎵'],
    ['musical note', '🎵'], ['guitar', '🎸'], ['camera', '📷'], ['photo', '📷'],
    ['movie', '🎬'], ['film', '🎬'], ['tv', '📺'], ['phone', '📱'], ['mobile', '📱'],
    ['computer', '💻'], ['laptop', '💻'], ['email', '📧'], ['mail', '📧'],
    ['house', '🏠'], ['home', '🏠'], ['key', '🔑'], ['lock', '🔒'], ['unlock', '🔓'],
    ['shield', '🛡️'], ['bomb', '💣'], ['skull', '💀'], ['alien', '👽'],
    ['robot', '🤖'], ['ghost', '👻'], ['eyes', '👀'], ['tongue', '😛'], ['poop', '💩'],
];

function _matchEmoji(kw) {
    const k = String(kw || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!k)
        return [];
    return EMOJI.filter(([word]) => {
        const w = String(word).toLowerCase();
        return k === '_all' ? true : w.includes(k);
    }).map(([word, symbol]) => ({word, symbol}));
}

/* ------------------------------------------------------------------ *
 * File search — asynchronous, in a bounded child process so filesystem
 * I/O can never block or take down gnome-shell.
 * ------------------------------------------------------------------ */

function fileIconName(path) {
    const n = path.toLowerCase();
    const map = [
        [/\.pdf$/, 'application-pdf'],
        [/\.(docx?|odt|rtf|txt|md)$/, 'x-office-document'],
        [/\.(xlsx?|ods|csv)$/, 'x-office-spreadsheet'],
        [/\.(pptx?|odp)$/, 'x-office-presentation'],
        [/\.(png|jpe?g|gif|svg|webp)$/, 'image-x-generic'],
        [/\.(mp3|flac|wav|ogg|m4a)$/, 'audio-x-generic'],
        [/\.(mp4|mkv|avi|mov|webm)$/, 'video-x-generic'],
        [/\.(zip|7z|tar|gz|bz2|xz|rar)$/, 'package-x-generic'],
        [/\.(deb|rpm|apk|flatpak)$/, 'package-x-generic'],
        [/\.(py|js|ts|sh|c|cpp|h|java|rs|go|rb)$/, 'text-x-script'],
        [/\.(html?|css|json|xml)$/, 'text-html'],
    ];
    for (const [re, icon] of map) {
        if (re.test(n))
            return icon;
    }
    return 'text-x-generic';
}

class FileSearch {
    constructor(maxDepth, maxEntries, maxMatches) {
        this._maxDepth = maxDepth;
        this._maxEntries = maxEntries;
        this._maxMatches = Math.min(maxMatches, 45);
        this._proc = null;
    }

    cancel() {
        if (this._proc) {
            try {
                this._proc.force_exit();
            } catch (e) {
                spotLog(`FileSearch.cancel ERROR ${e}`);
            }
            this._proc = null;
        }
    }

    get cancelled() {
        return this._proc === null;
    }

    search(query, onMatch, onDone) {
        this.cancel();
        if (!query || query.length < 2)
            return;

        const home = GLib.get_home_dir();
        const user = GLib.get_user_name();
        const routes = [home, '/media/' + user, '/mnt'];
        const roots = [];
        for (const r of routes) {
            if (!roots.some(x => x === r) && GLib.file_test(r, GLib.FileTest.IS_DIR))
                roots.push(r);
        }
        if (!roots.length)
            return;

        const depth = this._maxDepth < 0 ? 64 : this._maxDepth;
        const esc = query.replace(/([\\*?\[\]])/g, '\\$1');
        /* Prune heavy, low-value subtrees so `find` returns matches in a
           fraction of the wall time: flatpak/container data, Steam library,
           caches, dot-directories, trash and VCS folders are the usual
           scan-time hogs on a desktop home. */
        const args = ['find', ...roots, '-maxdepth', String(depth),
            '-type', 'f', '-iname', `*${esc}*`,
            '-not', '-path', '*/node_modules/*',
            '-not', '-path', '*/.var/*',
            '-not', '-path', '*/.local/share/Steam/*',
            '-not', '-path', '*/.cache/*',
            '-not', '-path', '*/.git/*',
            '-not', '-path', '*/.npm/*',
            '-not', '-path', '*/Trash/*'];

        let proc;
        try {
            proc = Gio.Subprocess.new(args,
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            spotLog(`FileSearch: spawn ERROR ${e}`);
            return;
        }
        this._proc = proc;

        const stream = new Gio.DataInputStream({
            base_stream: proc.get_stdout_pipe(),
        });

        let count = 0;
        const readNext = () => {
            stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (s, res) => {
                if (this._proc !== proc)
                    return;
                let line = null;
                try {
                    [line] = s.read_line_finish_utf8(res);
                } catch (e) {
                    return;
                }
                if (line === null) {
                    try {
                        if (onDone)
                            onDone(count);
                    } catch (e) {
                        spotLog(`FileSearch: onDone ERROR ${e}`);
                    }
                    return;
                }
                const path = line.replace(/\r?\n$/, '');
                if (!path)
                    return readNext();
                count++;
                if (count > this._maxMatches) {
                    this.cancel();
                    return;
                }
                try {
                    onMatch(Gio.File.new_for_path(path));
                } catch (e) {
                    spotLog(`FileSearch: onMatch ERROR ${e}`);
                }
                if (count >= this._maxMatches) {
                    this.cancel();
                    try {
                        if (onDone)
                            onDone(count);
                    } catch (e) {
                        spotLog(`FileSearch: onDone ERROR ${e}`);
                    }
                    return;
                }
                readNext();
            });
        };
        readNext();
    }
}

/* ------------------------------------------------------------------ *
 * The extension
 * ------------------------------------------------------------------ */

export default class SpotlightSearchExtension extends Extension {
    /* ----- lifecycle -------------------------------------------------- */

    enable() {
        spotLog('enable(): begin');
        try {
            this._settings = this.getSettings();

            this._fileSearch = new FileSearch(
                this._settings.get_int('search-depth'),
                this._settings.get_int('max-entries'),
                this._settings.get_int('max-matches'));
            this._selected = 0;
            this._hovered = -1;
            this._resultRows = [];
            this._debounceId = 0;
            this._appCache = null;
            this._appCacheAt = 0;
            this._appIconCache = new Map();
            this._freqCache = new Map();
            this._lastRenderSig = '';
            this._lastRenderQ = null;
            this._routesCache = null;
            this._routesCacheAt = 0;
            this._freqFn = null;
            this._bandGeo = null;
            this._bandGeoKey = null;
            this._modalId = null;
            this._clipHist = [];
            this._clipImgs = [];
            this._clip = null;
            this._timers = [];
            this._lastMatches = [];
            this._suggestRows = [];
            this._suggestCache = null;
            this._suggestCancel = null;
            this._soup = null;
            this._clipPollId = 0;

            if (this._settings.get_boolean('clipboard-history')) {
                try {
                    this._clip = St.Clipboard.get_default();
                } catch (e) {
                    spotLog(`clipboard watch: setup ERROR ${e}`);
                    this._clip = null;
                }
            }

            this._buildUi();

            const action = Main.wm.addKeybinding(BINDING_NAME, this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.ALL,
                () => {
                    this.toggle();
                    return Clutter.EVENT_STOP;
                });
            spotLog(`enable(): addKeybinding returned action=${action} ` +
                `(NONE=${Meta.KeyBindingAction.NONE})`);
            this._settingsChangedId =
                this._settings.connect(`changed::${BINDING_NAME}`, () => {
                    Main.wm.removeKeybinding(BINDING_NAME);
                    const reAction = Main.wm.addKeybinding(BINDING_NAME, this._settings,
                        Meta.KeyBindingFlags.NONE,
                        Shell.ActionMode.ALL,
                        () => {
                            this.toggle();
                            return Clutter.EVENT_STOP;
                        });
                    spotLog(`enable(): keybinding re-registered on change action=${reAction}`);
                });
            this._appearanceChangedId =
                this._settings.connect('changed', (settings, key) => {
                    const k = String(key ?? '');
                    if (k !== 'theme' && k !== 'enable-glow' &&
                        k !== 'panel-width' && k !== 'panel-radius' &&
                        k !== 'panel-opacity' && k !== 'panel-font-size' &&
                        k !== 'panel-y-offset')
                        return;
                    if (!this._overlay || !this._overlay.visible)
                        return;
                    try {
                        const monitor = global.display.get_primary_monitor();
                        this._applyPanelStyle(
                            global.display.get_monitor_geometry(monitor));
                    } catch (e) {
                        spotLog(`appearance change: ERROR ${e}`);
                    }
                });
            this._appSystemChangedId = Shell.AppSystem.get_default().connect(
                'installed-changed', () => {
                    this._appCache = null;
                    this._appIconCache = new Map();
                    this._freqCache = new Map();
                });

            spotLog('enable(): done');
        } catch (e) {
            spotLog(`enable(): ERROR ${e}`);
            throw e;
        }
    }

    disable() {
        spotLog('disable(): begin');
        this._cancelDebounce();
        this.close();
        if (this._fileSearch)
            this._fileSearch.cancel();
        if (this._settingsChangedId)
            this._settings.disconnect(this._settingsChangedId);
        if (this._appearanceChangedId)
            this._settings.disconnect(this._appearanceChangedId);
        if (this._appSystemChangedId) {
            Shell.AppSystem.get_default().disconnect(this._appSystemChangedId);
            this._appSystemChangedId = null;
        }
        if (this._suggestCancel) {
            try {
                this._suggestCancel.cancel();
            } catch (e) {
                spotLog(`disable(): suggest cancel ERROR ${e}`);
            }
            this._suggestCancel = null;
        }
        if (this._soup) {
            try {
                this._soup.abort();
            } catch (e) {
                /* ignore */
            }
            this._soup = null;
        }
        this._cancelTimers();
        Main.wm.removeKeybinding(BINDING_NAME);
        if (this._entryTextId)
            this._entry.clutter_text.disconnect(this._entryTextId);
        if (this._entryKeyId)
            this._entry.clutter_text.disconnect(this._entryKeyId);
        this._stopGlowAnimation();
        if (this._overlay) {
            this._overlay.destroy();
            this._overlay = null;
        }
        this._settings = null;
        spotLog('disable(): done');
    }

    /* ----- open / close / toggle -------------------------------------- */

    toggle() {
        if (this._overlay && this._overlay.visible)
            this.close();
        else
            this.open();
    }

    open() {
        spotLog('open(): begin');
        _logFlush();
        try {
            if (!this._overlay || this._overlay.visible)
                return;

            const monitor = global.display.get_primary_monitor();
            const geo = global.display.get_monitor_geometry(monitor);
            this._overlay.set_size(geo.width, geo.height);
            this._overlay.set_position(geo.x, geo.y);

            if (Main.overview && Main.overview.visible)
                Main.overview.hide();

            Main.layoutManager.uiGroup.add_child(this._overlay);
            this._overlay.show();

            this._applyPanelStyle(geo);
            this._entry.text = '';
            this._hotWordMarkup = null;
            if (this._entry.clutter_text)
                this._entry.clutter_text.set_attributes(this._colorList());
            this._selected = 0;
            this._suggestion = null;
            this._lastRenderSig = '';
            this._lastRenderQ = null;
            this._installedApps();
            this._modalId = Main.pushModal(this._overlay,
                {actionMode: Shell.ActionMode.SYSTEM_MODAL});
            global.stage.set_key_focus(this._entry);
            this._entry.grab_key_focus();
            this._suggestCache = null;
            this._startClipWatcher();
            this._refresh();
        } catch (e) {
            spotLog(`open(): ERROR ${e}`);
        }
    }

    _readClipText() {
        try {
            const clip = St.Clipboard.get_default();
            clip.get_text(St.ClipboardType.CLIPBOARD,
                (_clipboard, text) => {
                    try {
                        const added = this._pushClip(String(text ?? ''));
                        if (added && this._overlay && this._overlay.visible &&
                            this._query().startsWith('clip')) {
                            this._refresh();
                        }
                    } catch (e) {
                        spotLog(`clip read: ERROR ${e}`);
                    }
                });
            try {
                if (typeof clip.get_mimetypes === 'function' &&
                    typeof clip.get_content === 'function') {
                    let mimes = clip.get_mimetypes(St.ClipboardType.CLIPBOARD) || [];
                    if (typeof mimes.find !== 'function')
                        mimes = Array.from(mimes);
                    const mime = mimes.find(m => String(m).startsWith('image/'));
                    if (mime) {
                        clip.get_content(St.ClipboardType.CLIPBOARD, mime,
                            (_clipboard, bytes) => {
                                try {
                                    if (this._pushClipImage(mime, bytes) &&
                                        this._overlay && this._overlay.visible &&
                                        this._query().startsWith('clip')) {
                                        this._refresh();
                                    }
                                } catch (e) {
                                    spotLog(`clip img: ERROR ${e}`);
                                }
                            });
                    }
                }
            } catch (e) {
                spotLog(`clip img: read ERROR ${e}`);
            }
        } catch (e) {
            spotLog(`clip read: init ERROR ${e}`);
        }
    }

    _startClipWatcher() {
        if (this._clipPollId)
            return;
        if (!this._settings || !this._settings.get_boolean('clipboard-history'))
            return;
        const poll = () => {
            this._readClipText();
        };
        try {
            poll();
        } catch (e) {
            /* ignore */
        }
        this._clipPollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            5, () => {
                try {
                    poll();
                } catch (e) {
                    spotLog(`clip watcher: poll ERROR ${e}`);
                }
                return GLib.SOURCE_CONTINUE;
            });
    }

    close() {
        if (!this._overlay || !this._overlay.visible)
            return;

        this._cancelDebounce();
        this._stopGlowAnimation();
        this._fileSearch.cancel();
        if (this._suggestCancel) {
            try {
                this._suggestCancel.cancel();
            } catch (e) {
                /* ignore */
            }
            this._suggestCancel = null;
        }
        this._suggestRows = [];
        this._suggestCache = null;
        if (this._clipPollId) {
            try {
                GLib.source_remove(this._clipPollId);
            } catch (e) {
                /* ignore */
            }
            this._clipPollId = 0;
        }
        if (this._modalId !== null) {
            Main.popModal(this._modalId);
            this._modalId = null;
        }
        global.stage.set_key_focus(null);
        this._overlay.hide();
        Main.layoutManager.uiGroup.remove_child(this._overlay);
    }

    /* ----- UI construction ---------------------------------------------- */

    _buildUi() {
        this._overlay = new St.Widget({
            style: 'background-color: rgba(10, 10, 12, 0.45);',
            reactive: true,
            can_focus: true,
        });

        this._panel = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: 'background-color: rgba(28, 29, 33, 0.97);' +
                    'border-radius: 18px;' +
                    'box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);' +
                    'padding: 8px 6px 8px 6px;',
            reactive: true,
            can_focus: true,
        });
        this._glowBand = new St.DrawingArea({
            reactive: false,
            style: 'background-color: transparent;',
        });
        this._glowBand.visible = false;
        this._glowBand.connect('repaint', area => {
            try {
                this._drawBand(area.get_context());
            } catch (e) {
                spotLog(`band repaint: ERROR ${e}`);
            }
        });
        this._rotRad = 0;
        this._glowTimeoutId = 0;

        this._overlay.add_child(this._glowBand);
        this._overlay.add_child(this._panel);

        this._panel.connect('notify::allocation', () => this._syncGlow());

        const entryWrap = new St.BoxLayout({
            style: 'padding: 6px 14px;',
        });
        this._entryIcon = new St.Icon({
            icon_name: 'system-search-symbolic',
            icon_size: 22,
            style: 'margin-right: 10px; color: rgba(255,255,255,0.55);',
        });
        entryWrap.add_child(this._entryIcon);

        this._entry = new St.Entry({
            style: 'background-color: transparent; border: none;' +
                    'font-size: 24px; color: white;',
            can_focus: true,
            hint_text: 'Spotlight Search',
        });
        this._entryBaseStyle = this._entry.style;
        this._entry.clutter_text.style = 'caret-color: #4A90E2;';
        entryWrap.add_child(this._entry);
        this._panel.add_child(entryWrap);

        this._suggestion = null;
        this._hotWordMarkup = null;
        this._markupLock = false;

        this._separator = new St.Widget({
            style: 'min-height: 1px; background-color: rgba(255,255,255,0.09);' +
                    'margin: 2px 6px 6px 6px;',
        });
        this._panel.add_child(this._separator);

        this._results = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: 'padding: 0px 6px;',
        });
        this._panel.add_child(this._results);

        this._footer = new St.Label({
            style: 'padding: 10px 14px 4px 14px; font-size: 11px;' +
                    'color: rgba(255,255,255,0.4);',
            text: '↑↓ Navigate    ↵ Open    Esc Close',
        });
        this._panel.add_child(this._footer);

        this._entryTextId = this._entry.clutter_text.connect('text-changed',
            () => this._onTextChanged());
        this._entryKeyId = this._entry.clutter_text.connect('key-press-event',
            (...args) => this._onKeyPress(...args));

        this._overlay.connect('button-press-event', (actor, event) => {
            const [px, py] = event.get_coords();
            const [bx, by] = this._panel.get_transformed_position();
            const [bw, bh] = this._panel.get_transformed_size();
            if (px >= bx && px <= bx + bw && py >= by && py <= by + bh)
                return Clutter.EVENT_PROPAGATE;
            this.close();
            return Clutter.EVENT_STOP;
        });
    }

    /* ----- panel styling ------------------------------------------------- */

    _applyPanelStyle(geo) {
        const i = (key, def) => {
            try {
                return this._settings.get_int(key);
            } catch (e) {
                return def;
            }
        };
        const d = (key, def) => {
            try {
                return this._settings.get_double(key);
            } catch (e) {
                return def;
            }
        };
        const panelW = i('panel-width', 640);
        const fontSize = i('panel-font-size', 24);
        const radius = i('panel-radius', 18);
        const opacity = d('panel-opacity', 0.97);
        const yPct = d('panel-y-offset', 18);
        const theme = currentTheme(this._settings);
        const glow = glowEnabled(this._settings);

        this._labelColor = theme.entryColor;
        this._subColor = theme.subColor;
        this._highlightColor = theme.highlight;

        this._ribbonOuterRadius = radius;
        if (this._glowBand)
            this._glowBand.visible = glow;
        if (glow)
            this._startGlowAnimation();
        else
            this._stopGlowAnimation();

        this._panel.set_width(panelW);
        this._panel.set_x((geo.width - panelW) / 2);
        this._panel.set_y(Math.max(10, Math.round(geo.height * yPct / 100)));
        const effOpacity = Math.min(opacity, theme.alphaCap ?? 1);
        const shadow = glow
            ? `0 0 32px 8px ${theme.glow}, 0 24px 70px rgba(0, 0, 0, 0.5)`
            : '0 24px 70px rgba(0, 0, 0, 0.5)';
        const backdrop = theme.backdrop
            ? `backdrop-filter: ${theme.backdrop};`
            : '';
        this._panel.set_style(
            `background-color: rgba(${theme.panelBg}, ${effOpacity});` +
            `border-radius: ${radius}px;` +
            `border: 1px solid ${theme.ring};` +
            `box-shadow: ${shadow};` +
            `${backdrop}` +
            'padding: 8px 6px 8px 6px;');
        this._entry.set_style(
            `background-color: transparent; border: none;` +
            `font-size: ${fontSize}px; color: ${theme.entryColor};`);
        this._entry.clutter_text.style =
            `caret-color: ${theme.caret}; font-size: ${fontSize}px;`;
        this._entryIcon.style =
            `margin-right: 10px; color: ${theme.caret};`;
        this._footer.style =
            `padding: 10px 14px 4px 14px; font-size: 11px; ` +
            `color: ${theme.subColor};`;
    }

    /* ----- ribbon: sync / animation / drawing --------------------------- */

    _syncGlow() {
        if (!this._glowBand || !this._glowBand.visible)
            return;
        try {
            const box = this._panel.get_allocation_box();
            const w = box.x2 - box.x1;
            const h = box.y2 - box.y1;
            const mBand = 48;
            this._bandRect = {
                x: box.x1 - mBand,
                y: box.y1 - mBand,
                w: w + mBand * 2,
                h: h + mBand * 2,
                panelW: w,
                panelH: h,
                radius: this._ribbonOuterRadius ?? 18,
            };
            this._glowBand.set_position(Math.round(box.x1 - mBand),
                Math.round(box.y1 - mBand));
            this._glowBand.set_size(Math.round(w + mBand * 2),
                Math.round(h + mBand * 2));
            this._glowBand.queue_repaint();
        } catch (e) {
            spotLog(`syncGlow(): ERROR ${e}`);
        }
    }

    _startGlowAnimation() {
        if (this._glowTimeoutId !== 0)
            return;
        this._glowTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
            try {
                this._rotRad += 2 * Math.PI * (33 / 7000);
                if (this._glowBand)
                    this._glowBand.queue_repaint();
            } catch (e) {
                spotLog(`glow animation: ERROR ${e}`);
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopGlowAnimation() {
        if (this._glowTimeoutId !== 0) {
            GLib.source_remove(this._glowTimeoutId);
            this._glowTimeoutId = 0;
        }
    }

    _cancelDebounce() {
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = 0;
        }
    }

    _drawBand(cr) {
        const g = this._bandRect;
        if (!g)
            return;
        const key = g.w + 'x' + g.h + 'x' + (g.radius || 18);
        if (key !== this._bandGeoKey) {
            this._buildBandGeo();
            this._bandGeoKey = key;
        }
        const bg = this._bandGeo;
        if (!bg)
            return;
        const S = bg.S;
        const rot = this._rotRad;
        const cosR = Math.cos(rot);
        const sinR = Math.sin(rot);
        const theta = bg.theta;
        const px = bg.px, py = bg.py, nx = bg.nx, ny = bg.ny;
        const cos3 = bg.cos3, sin3 = bg.sin3;
        const sin8 = bg.sin8, cos8 = bg.cos8;
        const ox = this._ox, oy = this._oy, ix = this._ix, iy = this._iy;
        const tw = this._tw;

        for (let i = 0; i < S; i++) {
            const dist = 6 + 2 * (cos3[i] * cosR + sin3[i] * sinR);
            const bx = px[i] + nx[i] * dist;
            const by = py[i] + ny[i] * dist;
            const maxT = Math.max(2.2, dist - 1.2);
            const d = theta[i] - rot;
            const dA = wrapAngle(d);
            const dB = wrapAngle(d - 2.4);
            const env = Math.exp(-(dA * dA) / 0.5) +
                0.8 * Math.exp(-(dB * dB) / 0.5);
            let t = 3.0 + 8 * env;
            if (t > maxT)
                t = maxT;
            tw[i] = Math.min(0.72,
                Math.exp(-(dA * dA) / 0.4) * 0.6 +
                Math.exp(-(dB * dB) / 0.4) * 0.5);
            ox[i] = bx + nx[i] * t;
            oy[i] = by + ny[i] * t;
            ix[i] = bx - nx[i] * t;
            iy[i] = by - ny[i] * t;
        }

        const e = 1.2;
        const softShift = rot / (2 * Math.PI);
        const palMix = 0.5 + 0.5 * cosR;
        for (let i = 0; i < S; i++) {
            const j = (i + 1) % S;
            const w = tw[i];
            softCycle(theta[i] / (2 * Math.PI) + softShift, palMix,
                SOFT_SCRATCH);
            const sr = SOFT_SCRATCH[0];
            const sg = SOFT_SCRATCH[1];
            const sb = SOFT_SCRATCH[2];
            cr.setSourceRGBA(
                Math.min(1, sr + (1 - sr) * w),
                Math.min(1, sg + (1 - sg) * w),
                Math.min(1, sb + (1 - sb) * w), 1.0);
            const dxj = sin8[j] * e;
            const dyj = cos8[j] * e;
            const dxi = sin8[i] * e;
            const dyi = cos8[i] * e;
            cr.moveTo(ox[i] - dxi, oy[i] - dyi);
            cr.lineTo(ox[j] + dxj, oy[j] + dyj);
            cr.lineTo(ix[j] + dxj, iy[j] + dyj);
            cr.lineTo(ix[i] - dxi, iy[i] - dyi);
            cr.closePath();
            cr.fill();
        }
    }

    _buildBandGeo() {
        const g = this._bandRect;
        const S = 320;
        const cx = g.w / 2;
        const cy = g.h / 2;
        const hw = g.panelW / 2;
        const hh = g.panelH / 2;
        const rad = g.radius || 18;
        const theta = new Float64Array(S);
        const cos3 = new Float64Array(S);
        const sin3 = new Float64Array(S);
        const sin8 = new Float64Array(S);
        const cos8 = new Float64Array(S);
        const px = new Float64Array(S);
        const py = new Float64Array(S);
        const nx = new Float64Array(S);
        const ny = new Float64Array(S);
        for (let i = 0; i < S; i++) {
            const u = i / S;
            const t = u * 2 * Math.PI;
            theta[i] = t;
            cos3[i] = Math.cos(3 * t);
            sin3[i] = Math.sin(3 * t);
            const p1 = pointOnRoundedRect(cx, cy, hw, hh, rad, u);
            const p2 = pointOnRoundedRect(cx, cy, hw, hh, rad,
                ((i + 1) % S) / S);
            const tx = p2[0] - p1[0];
            const ty = p2[1] - p1[1];
            const tl = Math.hypot(tx, ty) || 1;
            px[i] = p1[0];
            py[i] = p1[1];
            nx[i] = ty / tl;
            ny[i] = -tx / tl;
            sin8[i] = tx / tl;
            cos8[i] = ty / tl;
        }
        this._bandGeo = {S, theta, cos3, sin3, sin8, cos8, px, py, nx, ny};
        this._ox = new Float64Array(S);
        this._oy = new Float64Array(S);
        this._ix = new Float64Array(S);
        this._iy = new Float64Array(S);
        this._tw = new Float64Array(S);
    }

    /* ----- input handling ------------------------------------------------ */

    _onTextChanged() {
        if (this._markupLock)
            return;
        this._applyHotWordStyle();
        this._suggestion = null;
        this._cancelDebounce();
        this._selected = 0;
        this._hovered = -1;
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            this._debounceId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onKeyPress(widget, event) {
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Up || symbol === Clutter.KEY_Down ||
            symbol === Clutter.KEY_Page_Up || symbol === Clutter.KEY_Page_Down) {
            const delta = (symbol === Clutter.KEY_Down ||
                symbol === Clutter.KEY_Page_Down) ? 1 : -1;
            const n = this._resultRows.length;
            if (n > 0) {
                this._selected = (this._selected + delta + n) % n;
                this._hovered = -1;
                this._highlight();
            }
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Tab) {
            if (this._suggestion && this._suggestion.length > 0) {
                this._entry.text = this._suggestion;
                this._entry.clutter_text.set_cursor_position(
                    this._suggestion.length);
                this._selected = 0;
                this._suggestion = null;
            }
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter ||
            symbol === Clutter.KEY_ISO_Enter) {
            if (this._resultRows.length > 0)
                return this._activate(this._selected);
        }
        return Clutter.EVENT_PROPAGATE;
    }

    /* ----- querying -------------------------------------------------------- */

    _query() {
        return this._entry.text.trim().toLowerCase();
    }

    _routeIcon(token, label) {
        const key = (token + ' ' + label).toLowerCase();
        let name = 'web-browser';
        if (key.includes('youtube') || key.includes('yt'))
            name = 'youtube';
        else if (key.includes('google') || key.includes('-g'))
            name = 'web-browser';
        try {
            const ok = St.ThemeContext.get_for_stage(global.stage)
                .get_theme().has_icon_paintable(name, 30);
            if (!ok)
                return 'video-x-generic';
        } catch (e) {
            return name;
        }
        return name;
    }

    _webRoutes() {
        const now = Date.now();
        if (this._routesCache && now - this._routesCacheAt < 10000)
            return this._routesCache;
        const out = [];
        for (const entry of this._settings.get_strv('web-prefixes')) {
            const [token, label, prefix] = entry.split('|');
            if (!token || !prefix)
                continue;
            const l = label || token;
            out.push({
                token: token.toLowerCase(),
                label: l,
                prefix,
                sublabel: 'Open results in your browser',
                icon: this._routeIcon(token, l),
            });
        }
        this._routesCache = out;
        this._routesCacheAt = now;
        return out;
    }

    /* ----- hotwords ------------------------------------------------------- */

    _hotWords() {
        const now = Date.now();
        if (this._hotWordsCache && now - this._hotWordsCacheAt < 10000)
            return this._hotWordsCache;
        const out = [];
        for (const entry of this._settings.get_strv('hotwords')) {
            const parts = entry.split('|');
            const token = (parts[0] || '').trim();
            const type = (parts[1] || '').trim();
            const target = (parts[2] || '').trim();
            if (!token || !target)
                continue;
            out.push({token: token.toLowerCase(), label: token, type, target});
        }
        this._hotWordsCache = out;
        this._hotWordsCacheAt = now;
        return out;
    }

    _matchHotWord(q) {
        const ql = String(q || '').trim().toLowerCase();
        if (!ql)
            return null;
        return this._hotWords().find(h => h.token === ql) || null;
    }

    /* Italicize the entry when the whole typed text matches a HotWord. The
       match only triggers when text == the HotWord token, so italicizing the
       whole entry is visually identical to italicizing just the word. St's
       theme pushes the entry color via Pango attributes, so any replacement
       list must carry the theme color too — otherwise the text turns black. */
    _themeEntryColor() {
        try {
            const node = this._entry.get_theme_node();
            if (node) {
                const c = node.get_color('color');
                this._hotWordColor = c;
                return c;
            }
        } catch (e) {
            /* fall through */
        }
        return this._hotWordColor || null;
    }

    _colorList() {
        const c = this._themeEntryColor();
        if (!c)
            return null;
        const attrs = new Pango.AttrList();
        attrs.insert(Pango.attr_foreground_new(
            c.red * 257, c.green * 257, c.blue * 257));
        return attrs;
    }

    _applyHotWordStyle() {
        if (this._markupLock)
            return;
        if (!this._entry || !this._entry.clutter_text)
            return;
        const text = this._entry.text;
        const hot = this._matchHotWord(text);
        try {
            if (hot && this._hotWordMarkup !== true) {
                const c = this._themeEntryColor();
                const attrs = new Pango.AttrList();
                attrs.insert(Pango.attr_style_new(Pango.Style.ITALIC, 0, -1));
                if (c) {
                    attrs.insert(Pango.attr_foreground_new(
                        c.red * 257, c.green * 257, c.blue * 257));
                }
                this._entry.clutter_text.set_attributes(attrs);
                this._hotWordMarkup = true;
                spotLog(`hotword: brand «${text}» (italic)`);
            } else if (!hot && this._hotWordMarkup) {
                this._entry.clutter_text.set_attributes(this._colorList());
                this._hotWordMarkup = false;
            }
        } catch (e) {
            spotLog(`hotword style: ERROR ${e}`);
            this._entry.clutter_text.set_attributes(this._colorList());
            this._hotWordMarkup = false;
        }
    }

    _hotWordRow(hw) {
        let icon = 'emblem-favorite';
        let sublabel = 'HotWord action';
        if (hw.type === 'url') {
            icon = 'web-browser';
            sublabel = `Open in browser: ${hw.target}`;
        } else if (hw.type === 'command') {
            icon = 'utilities-terminal';
            sublabel = `Run command: ${hw.target}`;
        } else if (hw.type === 'system') {
            const action = this._systemAction(hw.target);
            if (action) {
                icon = action.icon;
                sublabel = `System action: ${action.label}`;
            } else {
                sublabel = `System action: ${hw.target}`;
            }
        }
        return {
            rank: 0,
            group: 'hotword',
            label: `Run “${hw.label}”`,
            sublabel,
            icon,
            activate: () => {
                this.close();
                this._runHotWord(hw);
            },
        };
    }

    _systemAction(target) {
        const t = String(target || '').trim().toLowerCase();
        return SYSTEM_ACTIONS.find(a => a.id === t ||
            (a.keyword || []).includes(t)) || null;
    }

    _runHotWord(hw) {
        if (hw.type === 'url') {
            openUri(hw.target);
        } else if (hw.type === 'command') {
            runShellCommand(hw.target);
        } else if (hw.type === 'system') {
            const action = this._systemAction(hw.target);
            if (!action) {
                this._hotWordNotify(`Unknown system action: ${hw.target}`);
                spotLog(`hotword: unknown system action «${hw.target}»`);
                return;
            }
            this._hotWordNotify(`Triggering: ${action.label}`);
            try {
                action.run();
                spotLog(`hotword: ran system action «${hw.target}»`);
            } catch (e) {
                this._hotWordNotify(`${action.label} failed: ${e}` +
                    (e.stack ? `\n${e.stack}` : ''));
                spotLog(`hotword: system action «${hw.target}» ERROR ${e}`);
            }
        }
    }

    _hotWordNotify(body) {
        try {
            Main.notify('Spotlight', body);
        } catch (e) {
            console.error(`Spotlight: notify failed: ${e}`);
        }
    }

    /* ----- volume / brightness quick actions -------------------------- */

    _mediaRows(q) {
        const rows = [];
        if (/^(mute|unmute|silent)$/.test(q)) {
            rows.push({
                rank: 21,
                group: 'media',
                label: q === 'unmute' ? 'Unmute' : 'Mute audio',
                sublabel: 'Toggles the default audio sink',
                icon: q === 'unmute' ? 'audio-volume-high' : 'audio-volume-muted',
                activate: () => {
                    runShellCommand('wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle');
                    this.close();
                },
            });
        }
        const vm = /^volume\s*(up|down|(\d{1,3}(?:%?)))?$/.exec(q);
        if (vm) {
            const t = vm[1] || '';
            const cmd = t === 'up'
                ? 'wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%+'
                : t === 'down'
                    ? 'wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%-'
                    : t
                        ? `wpctl set-volume @DEFAULT_AUDIO_SINK@ ${t}%`
                        : null;
            if (cmd) {
                rows.push({
                    rank: 21,
                    group: 'media',
                    label: t === 'up' ? 'Volume up'
                        : t === 'down' ? 'Volume down' : `Set volume to ${t}%`,
                    sublabel: 'Adjust the default audio sink',
                    icon: 'audio-volume-high',
                    activate: () => {
                        runShellCommand(cmd);
                        this.close();
                    },
                });
            }
        }
        const bm = /^brightness\s*(up|down|(\d{1,3})|(\d{1,3})%)?$/.exec(q);
        if (/^brightness/.test(q) && bm) {
            const t = bm[1] || '';
            const target = t.endsWith('%') ? Number(t.slice(0, -1)) : /^\d+$/.test(t) ? Number(t) : t;
            rows.push({
                rank: 21,
                group: 'media',
                label: target === 'up' ? 'Brightness up'
                    : target === 'down' ? 'Brightness down'
                        : `Set brightness to ${target}%`,
                sublabel: 'Adjust screen brightness',
                icon: 'display-brightness-symbolic',
                activate: () => {
                    this._setBrightness(target);
                    this.close();
                },
            });
        }
        return rows;
    }

    _setBrightness(target) {
        try {
            const bus = Gio.DBus.session;
            const proxy = new Gio.DBusProxy.new_sync(bus,
                Gio.DBusProxyFlags.NONE, null,
                'org.gnome.SettingsDaemon.Power',
                '/org/gnome/SettingsDaemon/Power',
                'org.gnome.SettingsDaemon.Power.Screen', null);
            let level;
            if (target === 'up' || target === 'down') {
                const cur = proxy.get_value('Brightness') * 100;
                level = Math.round(Math.min(100, Math.max(1, cur + (target === 'up' ? 10 : -10))));
            } else {
                level = Math.round(Math.min(100, Math.max(1, Number(target) || 50)));
            }
            proxy.SetBrightnessSilent(level);
        } catch (e) {
            spotLog(`brightness: ERROR ${e}`);
            this._hotWordNotify('Brightness action failed.');
        }
    }

    /* ----- timers -------------------------------------------------------- */

    _timerRows(q) {
        this._timers = this._timers || [];
        if (this._timers.length && /^(cancel|clear|stop|remove) timer(s|)$/.test(q)) {
            return [{
                rank: 22,
                group: 'timer',
                label: `Cancel ${this._timers.length} active timer${this._timers.length > 1 ? 's' : ''}`,
                sublabel: 'Stop all running timers',
                icon: 'process-stop',
                activate: () => {
                    this._cancelTimers();
                    this.close();
                },
            }];
        }
        if (this._timers.length && /^timer$/.test(q)) {
            return [{
                rank: 22,
                group: 'timer',
                label: `${this._timers.length} active timer${this._timers.length > 1 ? 's' : ''} pending`,
                sublabel: 'Type “timer 5m” to add one · ⏎ dismisses',
                icon: 'appointment-soon',
                activate: () => this.close(),
            }];
        }
        const m = /^timer(?: (?:set |start )?)?([0-9]+)\s*(s|sec|second|m|min|minute|h|hr|hour)?$/.exec(q);
        if (!m)
            return [];
        const n = Number(m[1]);
        if (!n)
            return [];
        const u = m[2] || 'm';
        const per = u[0] === 's' ? 1 : u[0] === 'h' ? 3600 : 60;
        const secs = n * per;
        const label = `${n} ${u[0] === 's' ? 'seconds' : u[0] === 'h' ? 'hours' : 'minutes'}`;
        return [{
            rank: 22,
            group: 'timer',
            label: `Start timer: ${label}`,
            sublabel: 'Desktop notification when it finishes · ⏎ to start',
            icon: 'appointment-soon',
            activate: () => {
                this._startTimer(secs, label);
                this.close();
            },
        }];
    }

    _startTimer(seconds, label) {
        this._timers = this._timers || [];
        const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            Math.max(1, seconds), () => {
                if (this._timers) {
                    const i = this._timers.findIndex(t => t.id === id);
                    if (i !== -1)
                        this._timers.splice(i, 1);
                }
                try {
                    Main.notify('Spotlight', `Timer done: ${label}`);
                } catch (e) {
                    /* ignore */
                }
                return GLib.SOURCE_REMOVE;
            });
        this._timers.push({id, label});
        try {
            Main.notify('Spotlight', `Timer set: ${label}`);
        } catch (e) {
            /* ignore */
        }
    }

    _cancelTimers() {
        for (const t of this._timers || []) {
            try {
                GLib.source_remove(t.id);
            } catch (e) {
                /* ignore */
            }
        }
        this._timers = [];
    }

    /* ----- emoji picker --------------------------------------------------- */

    _emojiRows(q) {
        const m = /^emoji(?:\s+(.+))?$/.exec(q);
        if (!m)
            return [];
        const kw = m[1] ? m[1].trim() : '_all';
        const list = _matchEmoji(kw).slice(0, 18);
        const rows = list.map(({word, symbol}) => ({
            rank: 23,
            group: 'emoji',
            label: `${symbol}  ${word}`,
            sublabel: 'Emoji · press ⏎ to copy',
            icon: 'input-keyboard-symbolic',
            activate: () => {
                this._copyToClipboard(symbol);
                this.close();
            },
        }));
        if (!rows.length) {
            rows.push({
                rank: 23,
                group: 'emoji',
                label: `No emoji found for “${kw === '_all' ? 'emoji' : kw}”`,
                sublabel: 'Try smile, heart, fire, party, rocket…',
                icon: 'edit-find-symbolic',
                activate: () => this.close(),
            });
        }
        return rows;
    }

    /* ----- clipboard history ---------------------------------------------- */

    _pushClip(text) {
        const t = String(text ?? '').trim();
        if (!t || t.length > 5000)
            return false;
        const cap = Math.max(1, this._settings.get_int('clipboard-history-size') || 20);
        const arr = this._clipHist || (this._clipHist = []);
        const i = arr.indexOf(t);
        if (i === 0)
            return false;
        if (i !== -1)
            arr.splice(i, 1);
        arr.unshift(t);
        if (arr.length > cap)
            arr.length = cap;
        return true;
    }

    _clipRows(q) {
        if (!this._settings.get_boolean('clipboard-history'))
            return [];
        const ql = String(q || '').trim().toLowerCase();
        if (!ql.startsWith('clip'))
            return [];
        const term = ql.replace(/^clip(?:board|boar|paste| history)?/, '').trim();
        if (/^(clear|erase|wipe|empty|x)$/.test(term)) {
            return [{
                rank: 24,
                group: 'clip',
                label: 'Clear clipboard history',
                sublabel: 'Delete stored items and the system clipboard',
                icon: 'edit-clear',
                activate: () => {
                    this._clearClipboard();
                    this.close();
                },
            }];
        }
        const imgTotal = (this._clipImgs || []).length;
        const imgs = (this._clipImgs || []).map((o, i) => ({
            rank: 24,
            group: 'clip',
            label: `Image ${imgTotal - i}`,
            sublabel: o.mime === 'image/png'
                ? 'Screenshot · press ⏎ to copy'
                : 'Image · press ⏎ to copy',
            icon: 'image-x-generic',
            image: o.path,
            data: o.data,
            mime: o.mime,
            activate: () => {
                this._copyClipImage(o);
                this.close();
            },
        }));
        const texts = (this._clipHist || []).map(t => ({
            rank: 24,
            group: 'clip',
            label: t.length > 70 ? t.slice(0, 67) + '…' : t,
            sublabel: 'Clipboard · press ⏎ to copy',
            icon: 'edit-paste',
            activate: () => {
                this._copyToClipboard(t);
                this.close();
            },
        }));
        if (!imgs.length && !texts.length) {
            this._readClipText();
            return [{
                rank: 24,
                group: 'clip',
                label: 'Clipboard history is empty',
                sublabel: 'Copy something first — recent items appear here',
                icon: 'edit-paste',
                activate: () => this.close(),
            }];
        }
        return imgs.concat(texts)
            .filter(r => !term ||
                (r.label + ' ' + r.sublabel).toLowerCase().includes(term))
            .slice(0, 8);
    }

    _copyToClipboard(text) {
        try {
            St.Clipboard.get_default().set_text(
                St.ClipboardType.CLIPBOARD, String(text));
        } catch (e) {
            spotLog(`clipboard: copy ERROR ${e}`);
        }
    }

    _pushClipImage(mime, bytes) {
        if (!bytes || typeof bytes.get_data !== 'function')
            return false;
        let raw = null;
        try {
            raw = bytes.get_data();
        } catch (e) {
            spotLog(`clip img: read ERROR ${e}`);
            return false;
        }
        if (!raw || !raw.length)
            return false;
        /* Deep-copy into our own buffer NOW: the GBytes borrows the clipboard
           owner's memory and can be freed at any moment once the clipboard
           changes; re-using it later dereferences freed memory (SEGV). */
        const data = new Uint8Array(raw.length);
        data.set(raw);
        let key = mime + ':' + String(raw.length);
        try {
            if (typeof GLib.compute_checksum_for_bytes === 'function')
                key = mime + ':' + GLib.compute_checksum_for_bytes(
                    GLib.ChecksumType.MD5, bytes).slice(0, 16);
        } catch (e) {
            /* fall back to size-based key */
        }
        if (key === this._lastImgKey)
            return false;
        this._lastImgKey = key;
        const ext = (mime.replace('image/', '').split('+')[0] || 'img');
        let path = '';
        try {
            const filePath = `${GLib.get_user_cache_dir()}/spotlight-clip-${this._imgSeq = (this._imgSeq || 0) + 1}.${ext}`;
            const res = Gio.File.new_for_path(filePath).replace_contents(
                data, null, false, GLib.FileCreateFlags.NONE, null);
            if (res && res[0])
                path = filePath;
        } catch (e) {
            spotLog(`clip img: write ERROR ${e}`);
        }
        const cap = Math.max(1, this._settings.get_int('clipboard-history-size') || 20);
        const arr = this._clipImgs || (this._clipImgs = []);
        arr.unshift({path, mime, data});
        const excess = arr.splice(cap);
        excess.forEach(o => {
            if (o && o.path) {
                try { Gio.File.new_for_path(o.path).delete(null); } catch (e) {}
            }
        });
        return true;
    }

    _copyClipImage(o) {
        try {
            const data = (o && ArrayBuffer.isView(o.data)) ? o.data : null;
            if (!data)
                return;
            if (o.path === '') {
                const ext = String(o.mime || 'image/png')
                    .replace('image/', '').split('+')[0].split('/')[0] || 'img';
                const filePath = `${GLib.get_user_cache_dir()}/spotlight-clip-${
                    this._imgSeq = (this._imgSeq || 0) + 1}.${ext}`;
                try {
                    const res = Gio.File.new_for_path(filePath).replace_contents(
                        data, null, false,
                        GLib.FileCreateFlags.NONE, null);
                    if (res && res[0])
                        o.path = filePath;
                } catch (e) {
                    spotLog(`clip img: rewrite ERROR ${e}`);
                }
            }
            if (this._setContentClipboard(o, data)) {
                Main.notify('Spotlight', 'Image copied — paste it with Ctrl+V');
                return;
            }
            if (o.path && this._copyImageViaCli(o.path)) {
                Main.notify('Spotlight',
                    'Copied — image is on the clipboard, paste it with Ctrl+V');
                return;
            }
            if (o.path) {
                const base = o.path.slice(o.path.lastIndexOf('/') + 1);
                try {
                    St.Clipboard.get_default().set_text(
                        St.ClipboardType.CLIPBOARD, o.path);
                } catch (e) {
                    spotLog(`clip img: cpath ERROR ${e}`);
                }
                Main.notify('Spotlight',
                    `No clipboard re-copy tool found — path copied: ~/.cache/${base}`);
                return;
            }
            Main.notify('Spotlight', 'Clipboard image is no longer available');
        } catch (e) {
            spotLog(`clip img: copy ERROR ${e}`);
        }
    }

    /* Re-copy an image to the clipboard the exact way GNOME Shell's own
       screenshot UI does (St.Clipboard.set_content) — safe by construction,
       no external tools, no GTK imports in the shell process. */
    _setContentClipboard(o, data) {
        try {
            const clip = St.Clipboard.get_default();
            if (typeof clip.set_content !== 'function')
                return false;
            /* Pass a fresh copy of OUR OWN buffer every time — never a GBytes
               borrowed from the clipboard owner (see _pushClipImage). */
            const buf = new Uint8Array(data.length);
            buf.set(data);
            clip.set_content(
                St.ClipboardType.CLIPBOARD,
                String(o.mime || 'image/png'), buf);
            return true;
        } catch (e) {
            spotLog(`clip img: st ERROR ${e}`);
            return false;
        }
    }

    /* Re-copy an image to the clipboard via an external CLI (wl-copy/xclip).
       Never touches St.Clipboard image transfers, which can crash the shell. */
    _copyImageViaCli(path) {
        const tool = GLib.find_program_in_path('wl-copy') ||
            GLib.find_program_in_path('xclip');
        if (!tool)
            return false;
        const script = tool.includes('wl-copy')
            ? 'wl-copy --type image/png < "$1"'
            : 'xclip -selection clipboard -t image/png -i "$1"';
        try {
            const proc = Gio.Subprocess.new(
                ['sh', '-c', script, 'spotlight', path],
                Gio.SubprocessFlags.STDERR_SILENCE);
            proc.wait_check_async(null, () => {});
            return true;
        } catch (e) {
            spotLog(`clip img: cli ERROR ${e}`);
            return false;
        }
    }

    _clearClipboard() {
        this._clipHist = [];
        const imgs = this._clipImgs || (this._clipImgs = []);
        imgs.splice(0).forEach(o => {
            if (o && o.path) {
                try { Gio.File.new_for_path(o.path).delete(null); } catch (e) {}
            }
        });
        this._lastImgKey = null;
        try {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, '');
        } catch (e) {
            spotLog(`clip clear: ERROR ${e}`);
        }
    }

    /* ----- web suggestions ------------------------------------------------ */

    _soupSession() {
        if (this._soup)
            return this._soup;
        try {
            this._soup = new Soup.Session();
        } catch (e) {
            this._soup = null;
        }
        return this._soup;
    }

    _webSuggest(q) {
        const session = this._soupSession();
        if (!session)
            return;
        if (!this._settings.get_boolean('web-suggestions'))
            return;
        const ql = String(q || '').trim();
        if (ql.length < 3 || !/^[a-z0-9\s]+$/i.test(ql) || /^\d/.test(ql))
            return;
        if (this._suggestCancel) {
            try {
                this._suggestCancel.cancel();
            } catch (e) {
                /* ignore */
            }
        }
        this._suggestCancel = new Gio.Cancellable();
        try {
            const msg = Soup.Message.new('GET',
                'https://suggestqueries.google.com/complete/search?client=firefox&q=' +
                encodeURIComponent(ql));
            const renderQ = ql;
            session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT,
                this._suggestCancel, (_s, res) => {
                    try {
                        const bytes = session.send_and_read_finish(res);
                        const raw = bytes.get_data() ?
                            String.fromCharCode(...bytes.get_data()) : '';
                        const arr = JSON.parse(raw);
                        const sugs = (Array.isArray(arr) && Array.isArray(arr[1]) ?
                            arr[1] : []).filter(x => typeof x === 'string').slice(0, 3);
                        if (!sugs.length || this._query() !== renderQ)
                            return;
                        const rows = sugs.map(s => ({
                            rank: 25,
                            group: 'web',
                            label: `Search: “${s}”`,
                            sublabel: 'Web suggestion · press ⏎ to open in browser',
                            icon: 'web-browser',
                            activate: () => {
                                openUri('https://www.google.com/search?q=' +
                                    encodeURIComponent(s));
                                this.close();
                            },
                        }));
                        this._suggestRows = rows;
                        this._suggestCache = {q: renderQ, rows};
                        this._render([...this._lastMatches, ...rows], renderQ);
                    } catch (e) {
                        spotLog(`suggest: ERROR ${e}`);
                    }
                });
        } catch (e) {
            spotLog(`suggest: setup ERROR ${e}`);
        }
    }

    _installedApps() {
        const now = Date.now();
        /* Apps change rarely (installs/removals), and re-enumerating every
           Shell.App + lowercasing three strings per app is wasteful on every
           keystroke. Cache long, invalidated instantly by 'installed-changed'. */
        if (this._appCache && now - this._appCacheAt < 300000)
            return this._appCache;
        const appSys = Shell.AppSystem.get_default();
        const list = appSys.get_installed().map(app => {
            const n = app.get_name();
            const d = app.get_description() || n;
            const id = app.get_id();
            return {
                app,
                name: n.toLowerCase(),
                desc: d.toLowerCase(),
                id: id.toLowerCase(),
                label: n,
                sub: d,
            };
        });
        this._appCache = list;
        this._appCacheAt = now;
        return list;
    }

    _refresh() {
        this._fileSearch.cancel();
        this._clearResults();

        const q = this._query();
        spotLog(`refresh(): q=«${q}»`);

        /* Web-route auto-detection: as soon as the entry looks like a token
           (e.g. "-yt"), mirror that route's icon in the entry, and if the
           whole token is present show its result row before a query is typed. */
        const ptext = this._entry.text.trim();
        const tokenPrefix =
            /^(-{1,4}[a-z0-9_]*)$/i.test(ptext) ? ptext.toLowerCase() : null;
        let pendingRoute = null;
        if (tokenPrefix) {
            const routes = this._webRoutes();
            const exact = routes.find(r => r.token === tokenPrefix);
            const prefixed = tokenPrefix === '-'
                ? []
                : routes.filter(r => r.token.startsWith(tokenPrefix) &&
                    r.token !== tokenPrefix);
            if (exact)
                pendingRoute = exact;
            else if (prefixed.length === 1)
                pendingRoute = prefixed[0];
        }
        this._entryIcon.icon_name = pendingRoute ?
            pendingRoute.icon : 'system-search-symbolic';

        if (tokenPrefix && pendingRoute && tokenPrefix === pendingRoute.token) {
            this._render([{
                group: 'web',
                label: `Search ${pendingRoute.label}…`,
                sublabel: 'Type your query after a space, e.g. ' +
                    `${pendingRoute.token} cats`,
                icon: pendingRoute.icon,
                activate: () => {
                    this.close();
                },
            }], q);
            return;
        }

        if (q === '') {
            return;
        }

        const matches = [];
        this._lastMatches = matches;

        /* HotWord: if the whole typed text is a registered HotWord, surface
           its action row at the top; matching apps/files still show below. */
        const hotWord = this._matchHotWord(q);
        if (hotWord)
            matches.push(this._hotWordRow(hotWord));

        /* Quick-launch extras: media, timers, emoji, clipboard history. */
        matches.push(...this._mediaRows(q));
        matches.push(...this._timerRows(q));
        matches.push(...this._emojiRows(q));
        matches.push(...this._clipRows(q));

        /* Explicit web routes: -G <query>, -Yt <query>, or custom prefixes.
           Each entry in `web-prefixes` is "token|Label|url prefix". */
        const text = this._entry.text.trim();
        const rm = text.match(/^(-{1,4}[a-z0-9_]+)[ \t\u00A0]+(.+)$/i);
        const routed = rm ?
            this._webRoutes().find(r => r.token === rm[1].toLowerCase()) : null;
        if (routed) {
            const query = rm[2].trim();
            this._render([{
                rank: 0,
                group: 'web',
                label: `Search ${routed.label}: “${query}”`,
                sublabel: routed.sublabel,
                icon: routed.icon,
                activate: () => {
                    this.close();
                    openUri(routed.prefix + encodeURIComponent(query));
                },
            }], q);
            return;
        }

        try {

        /* Calculator + conversions */
        const conv = convertUnit(q);
        if (conv !== null) {
            matches.push({
                rank: 0,
                group: 'calc',
                label: `${this._entry.text} = ${conv}`,
                sublabel: 'Conversion · press ⏎ to copy',
                icon: 'accessories-calculator',
                activate: () => {
                    this._copyToClipboard(conv);
                },
            });
        } else if (looksLikeCalc(q)) {
            const result = evaluate(q);
            if (result !== null) {
                matches.push({
                    rank: 0,
                    group: 'calc',
                    label: `${this._entry.text} = ${result}`,
                    sublabel: 'Calculator · press ⏎ to copy',
                    icon: 'accessories-calculator',
                    activate: () => {
                        this._copyResult(result);
                    },
                });
            }
        }

        /* Applications */
        const now = global.get_current_time();
        const scored = [];
        for (const c of this._installedApps()) {
            const {name, desc, id} = c;
            if (!name.includes(q) && !desc.includes(q) && !id.includes(q))
                continue;
            let score = 0;
            if (name.startsWith(q))
                score += 8;
            else if (name.includes(q))
                score += 5;
            else
                score += 2;
            if (desc.includes(q))
                score += 1;
            score += this._appFreq(c.app, now) * 10;
            scored.push({app: c.app, score, name, label: c.label, sub: c.sub});
        }
        scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
        scored.slice(0, 12).forEach(({app, label, sub}, i) => {
            matches.push({
                rank: i + 1,
                group: 'app',
                label,
                sublabel: sub,
                icon: this._appIcon(app, 30),
                activate: () => {
                    this._openApp(app);
                },
            });
        });

        /* System actions */
        const qq = q.replace(/^just /, '');
        for (const action of SYSTEM_ACTIONS) {
            if (action.keyword.some(k => qq.includes(k))) {
                matches.push({
                    id: action.id,
                    rank: 20,
                    group: 'action',
                    label: action.label,
                    sublabel: 'System',
                    icon: action.icon,
                    activate: () => {
                        action.run();
                        this.close();
                    },
                });
            }
        }

        /* Files (async, rendered on a 120 ms throttle so fast typing
           batches many file matches into a single repaint) */
        const fileIds = new Set();
        const searchFiles = this._settings.get_boolean('search-files');
        const fileSearch = this._fileSearch;
        let fileRenderId = 0;
        const foldSugs = () => (this._suggestCache && this._suggestCache.q === q)
            ? [...matches, ...this._suggestCache.rows]
            : matches;
        const renderFiles = () => this._render(foldSugs(), q);
        const scheduleRender = () => {
            if (fileRenderId)
                return;
            fileRenderId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
                fileRenderId = 0;
                renderFiles();
                return GLib.SOURCE_REMOVE;
            });
        };
        const runFileSearch = () => fileSearch.search(q, (file) => {
            try {
                if (fileSearch.cancelled)
                    return;
                const uri = file.get_uri();
                if (fileIds.has(uri))
                    return;
                fileIds.add(uri);
                const name = file.get_basename() || uri;
                const path = file.get_path() || uri;
                const exactExt = name.toLowerCase().endsWith(q);
                matches.push({
                    id: 'file:' + uri,
                    rank: exactExt ? 10 : 30,
                    group: 'file',
                    label: name,
                    sublabel: path.slice(0, 110),
                    icon: fileIconName(path),
                    activate: () => {
                        openUri(uri);
                        this.close();
                    },
                });
                scheduleRender();
            } catch (e) {
                spotLog(`refresh(): file-match ERROR ${e}`);
            }
        }, (count) => {
            if (fileRenderId) {
                GLib.source_remove(fileRenderId);
                fileRenderId = 0;
            }
            renderFiles();
        });
        if (searchFiles)
            runFileSearch();

        this._render(foldSugs(), q);
        this._webSuggest(q);
        } catch (e) {
            spotLog(`refresh(): ERROR ${e}`);
        }
    }

    _appFreq(app, now) {
        if (!this._freqFn) {
            const usage = Shell.AppUsage.get_default();
            this._freqFn = () => 0;
            for (const m of ['get_frequency', 'getSearchFrequency', 'getFrequency']) {
                if (typeof usage[m] === 'function') {
                    this._freqFn = usage[m].bind(usage);
                    break;
                }
            }
        }
        try {
            const id = app.get_id();
            if (this._freqCache) {
                const hit = this._freqCache.get(id);
                if (hit && now - hit.t < 300000)
                    return hit.v;
            }
            const v = this._freqFn(app, now);
            if (!this._freqCache)
                this._freqCache = new Map();
            this._freqCache.set(id, {t: now, v});
            return v;
        } catch (e) {
            return 0;
        }
    }

    /* ----- launching ------------------------------------------------------- */

    _openApp(app) {
        const id = app.get_id();
        spotLog(`openApp: ${id}`);
        /* close() pops the modal grab synchronously, so we can launch in the
           same tick — no extra mainloop round-trip on the hot path. */
        this.close();
        const ts = global.get_current_time();
        let done = false;
        const attempts = [
            ['activate', () => app.activate(ts)],
            ['activate_full', () => app.activate_full(-1, ts)],
            ['launch', () => app.launch(ts, -1, 0, null)],
            ['open_new_window', () => app.open_new_window(ts)],
        ];
        for (const [name, fn] of attempts) {
            if (done)
                break;
            if (typeof app[name] !== 'function')
                continue;
            try {
                fn();
                done = true;
            } catch (e) {
                spotLog(`openApp: ${name}(${id}) ERROR ${e}`);
            }
        }
        if (!done && app.app_info) {
            try {
                app.app_info.launch([], null);
                done = true;
            } catch (e) {
                spotLog(`openApp: app_info.launch(${id}) ERROR ${e}`);
            }
        }
        if (!done && id.endsWith('.desktop'))
            spotLog(`openApp: desktop-launch(${id}) => ${launchByDesktopId(id)}`);
    }

    _appIcon(app, size) {
        const id = app.get_id();
        if (this._appIconCache && this._appIconCache.has(id))
            return this._appIconCache.get(id);
        let gicon = null;
        try {
            gicon = app.get_icon();
        } catch (e) {
            spotLog(`_appIcon(): get_icon ERROR ${e}`);
        }
        if (!gicon)
            gicon = new Gio.ThemedIcon({name: 'application-x-executable'});
        if (!this._appIconCache)
            this._appIconCache = new Map();
        this._appIconCache.set(id, gicon);
        return gicon;
    }

    _copyResult(text) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        this.close();
    }

    /* ----- results rendering ---------------------------------------------- */

    _clearResults() {
        this._resultRows = [];
        this._selected = 0;
        this._hovered = -1;
        if (!this._pool)
            return;
        for (const slot of this._pool) {
            slot.row = null;
            slot.box.visible = false;
        }
    }

    _render(rows, q) {
        try {
            if (!this._overlay || !this._overlay.visible)
                return;

            this._ensurePool();
            const maxRows = Math.min(
                this._settings.get_int('max-results'), this._pool.length);

            const rankOf = r => (r.rank !== undefined ? r.rank : 99);
            rows.sort((a, b) => rankOf(a) - rankOf(b));

            /* Extension search (e.g. ".pdf"): put files first and give them
               the widest slice, like macOS Spotlight's file-type results. */
            const extQuery = q.length >= 2 && q.startsWith('.');
            const quota = {
                calc: 1, web: 1, app: 4, action: 2,
                file: extQuery ? 9 : 8, other: 3,
            };
            const first = extQuery ? ['file', 'app', 'action', 'web', 'calc', 'other']
                : null;
            const groups = new Map();
            for (const r of rows) {
                const g = r.group || 'other';
                if (!groups.has(g))
                    groups.set(g, []);
                groups.get(g).push(r);
            }

            const used = new Map();
            let picked = [];
            const groupOrder = first || [...groups.keys()];
            for (const g of groupOrder) {
                const list = groups.get(g);
                if (!list)
                    continue;
                const limit = quota[g] ?? 4;
                const take = Math.min(limit, list.length);
                used.set(g, take);
                picked.push(...list.slice(0, take));
            }
            if (picked.length < maxRows) {
                const rest = [];
                for (const [g, list] of groups)
                    rest.push(...list.slice(used.get(g) || 0));
                rest.sort((a, b) => rankOf(a) - rankOf(b));
                picked.push(...rest.slice(0, maxRows - picked.length));
            }
            picked.sort((a, b) => rankOf(a) - rankOf(b));

            let shown = picked.slice(0, maxRows);
            if (shown.length === 0 && q !== '') {
                shown = [{
                    group: 'web',
                    label: `Search the web for “${this._entry.text.trim()}”`,
                    sublabel: 'Open in your default browser',
                    icon: 'web-browser',
                    activate: () => {
                        openUri('https://www.google.com/search?q=' +
                            encodeURIComponent(this._entry.text.trim()));
                        this.close();
                    },
                }];
            }

            /* Streaming file matches can repaint the identical visible set
               many times per query — skip the whole repaint when nothing the
               user can see changed (labels, sublabels and icons identical). */
            let sig = '';
            if (shown.length > 0) {
                for (const r of shown) {
                    sig += r.label + '\u0001' + (r.sublabel || '') + '\u0001' +
                        (typeof r.icon === 'string' ? r.icon : '') + '\u0002';
                }
            }
            if (sig !== '' && sig === this._lastRenderSig && q === this._lastRenderQ)
                return;
            this._lastRenderSig = sig;
            this._lastRenderQ = q;

            this._clearResults();

            /* Pool of pre-built rows is reused and updated in place; nothing is
               destroyed/recreated on keystroke, so the dreaded
               destroy-during-GC crashes from churning St actors cannot occur. */
            for (let i = 0; i < shown.length; i++)
                this._setRow(this._pool[i], shown[i], i);
            for (let i = shown.length; i < this._pool.length; i++) {
                this._pool[i].row = null;
                this._pool[i].box.visible = false;
            }
            this._highlight();

            /* Suggestive completion: if the top result's label extends the
               typed prefix, offer it via Tab. */
            let suggestion = null;
            if (q.length >= 1 && shown.length > 0) {
                const top = shown[0];
                if (top && typeof top.label === 'string') {
                    const label = top.label;
                    if (label.length > q.length &&
                        label.toLowerCase().startsWith(q))
                        suggestion = label;
                }
            }
            this._suggestion = suggestion;
            this._footer.text = suggestion
                ? `Tab to complete “${suggestion}”    ↑↓ Navigate    ↵ Open    Esc Close`
                : '↑↓ Navigate    ↵ Open    Esc Close';

            spotLog(`render(): rows=${shown.length} q=«${q}»${shown.length === 0 ? ' <-- EMPTY' : ''}`);
        } catch (e) {
            spotLog(`render(): ERROR ${e}`);
        }
    }

    _ensurePool() {
        if (this._pool)
            return;
        this._pool = [];
        const LABEL_STYLE = 'font-size: 15px; color: rgba(255,255,255,0.95);';
        const SUB_STYLE = 'font-size: 11px; color: rgba(255,255,255,0.45);';
        const poolSize = Math.max(12,
            Math.min(this._settings.get_int('max-results'), 24));
        for (let i = 0; i < poolSize; i++) {
            const idx = i;
            const box = new St.BoxLayout({
                style: 'padding: 8px 12px; border-radius: 12px;',
                reactive: true,
                can_focus: true,
                visible: false,
            });
            const icon = new St.Icon({
                icon_size: 30,
                style: 'margin-right: 14px;',
            });
            const thumb = new St.Icon({
                icon_size: 120,
                style: 'margin-right: 14px;',
                visible: false,
            });
            const textCol = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
            });
            const label = new St.Label({text: '', style: LABEL_STYLE, x_expand: true});
            const sublabel = new St.Label({text: '', style: SUB_STYLE, x_expand: true});
            textCol.add_child(label);
            textCol.add_child(sublabel);
            box.add_child(icon);
            box.add_child(thumb);
            box.add_child(textCol);
            box.connect('button-press-event', () => {
                this._activate(idx);
                return Clutter.EVENT_STOP;
            });
            box.connect('enter-event', () => {
                if (this._resultRows.length > 0 && idx < this._resultRows.length) {
                    this._hovered = idx;
                    this._highlight();
                }
                return Clutter.EVENT_PROPAGATE;
            });
            box.connect('leave-event', () => {
                if (this._hovered === idx) {
                    this._hovered = -1;
                    this._highlight();
                }
                return Clutter.EVENT_PROPAGATE;
            });
            this._results.add_child(box);
            this._pool.push({box, icon, thumb, label, sublabel, row: null});
        }
    }

    _setRow(slot, row, index) {
        if (!slot)
            return;
        slot.row = row;
        slot.box.visible = true;
        const labelStyle = `font-size: 15px; color: ${this._labelColor};`;
        if (slot.labelStyle !== labelStyle) {
            slot.labelStyle = labelStyle;
            slot.label.style = labelStyle;
        }
        slot.label.text = row.label || '';
        if (row.sublabel) {
            const subStyle = `font-size: 11px; color: ${this._subColor};`;
            if (slot.subStyle !== subStyle) {
                slot.subStyle = subStyle;
                slot.sublabel.style = subStyle;
            }
            slot.sublabel.text = row.sublabel;
            slot.sublabel.visible = true;
        } else {
            slot.sublabel.text = '';
            slot.sublabel.visible = false;
        }
        const {icon, thumb} = slot;
        if (typeof row.icon === 'string') {
            icon.gicon = null;
            icon.icon_name = row.icon;
        } else if (row.icon instanceof Gio.Icon) {
            icon.icon_name = '';
            icon.gicon = row.icon;
        } else {
            icon.gicon = null;
            icon.icon_name = 'text-x-generic';
        }
        if (row.image) {
            try {
                thumb.gicon = Gio.FileIcon.new_for_path(row.image);
                thumb.visible = true;
            } catch (e) {
                spotLog(`thumb: ERROR ${e}`);
                thumb.gicon = null;
                thumb.visible = false;
            }
        } else {
            thumb.gicon = null;
            thumb.visible = false;
        }
        this._resultRows.push({row, box: slot.box, index});
    }

    _highlight() {
        const show = this._hovered >= 0 ? this._hovered : this._selected;
        this._resultRows.forEach(({box}, i) => {
            box.style = 'padding: 8px 12px; border-radius: 12px;' +
                (i === show
                    ? `background-color: ${this._highlightColor};`
                    : '');
        });
    }

    _activate(index) {
        if (index < 0 || index >= this._resultRows.length) {
            spotLog(`activate(): OOB index=${index} len=${this._resultRows.length}`);
            return Clutter.EVENT_PROPAGATE;
        }
        const {row} = this._resultRows[index];
        if (row.activate) {
            spotLog(`activate(): index=${index} label=«${row.label}»`);
            try {
                row.activate();
            } catch (e) {
                spotLog(`activate(): row ERROR ${e}`);
            }
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
}