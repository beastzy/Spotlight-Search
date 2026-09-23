import assert from 'node:assert';

import {GIO, GLIB, calls, clipMethods, ext, prefs, SptInstance, setLsFs} from './_harness.mjs';

let passed = 0;
const fails = [];
let chain = Promise.resolve();

function check(name, fn) {
    chain = chain.then(async () => {
        try {
            await fn();
            passed++;
        } catch (e) {
            fails.push(`FAIL ${name}: ${e.message}`);
        }
    });
}

function approx(a, b, eps = 1e-9) {
    assert.ok(Math.abs(parseFloat(a) - b) < eps, `${a} ~= ${b}`);
}

/* ============ extension.js loads & exposes ============ */
check('module loads, class exposed', () => {
    assert.strictEqual(typeof ext.SpotlightSearchExtension, 'function');
    assert.strictEqual(typeof ext.evaluate, 'function');
});

/* ============ calculator (returns rounded string or null) ============ */
check('calc: 12*8+3 = 99', () => assert.strictEqual(ext.evaluate('12*8+3'), '99'));
check('calc: precedence 2+3*(4-1) = 11', () => assert.strictEqual(ext.evaluate('2+3*(4-1)'), '11'));
check('calc: power right-assoc 2^3^2 = 512', () => assert.strictEqual(ext.evaluate('2^3^2'), '512'));
check('calc: unary -5 + 2 = -3', () => assert.strictEqual(ext.evaluate('-5 + 2'), '-3'));
check('calc: sqrt(144) = 12', () => assert.strictEqual(ext.evaluate('sqrt(144)'), '12'));
check('calc: sin(pi/2) = 1', () => approx(ext.evaluate('sin(pi/2)'), 1));
check('calc: 2^10 = 1024', () => assert.strictEqual(ext.evaluate('2^10'), '1024'));
check('calc: unicode × ÷ −', () => assert.strictEqual(ext.evaluate('12 × 4 ÷ 6 − 1'), '7'));
check('calc: modulo 10%3 = 1', () => assert.strictEqual(ext.evaluate('10%3'), '1'));
check('calc: abs/round/floor/ceil', () => {
    assert.strictEqual(ext.evaluate('abs(-4)'), '4');
    assert.strictEqual(ext.evaluate('round(2.6)'), '3');
    assert.strictEqual(ext.evaluate('floor(2.9)'), '2');
    assert.strictEqual(ext.evaluate('ceil(2.1)'), '3');
});
check('calc: ln(e) = 1', () => approx(ext.evaluate('ln(e)'), 1));
check('calc: log(1000) = 3', () => approx(ext.evaluate('log(1000)'), 3));
check('calc: tau', () => approx(ext.evaluate('tau'), Math.PI * 2));
check('calc: negative power 2^-1 = 0.5', () => assert.strictEqual(ext.evaluate('2^-1'), '0.5'));
check('calc: nested parens ((1+2)*3) = 9', () => assert.strictEqual(ext.evaluate('((1+2)*3)'), '9'));
check('calc: empty => null', () => assert.strictEqual(ext.evaluate(''), null));
check('calc: invalid chars => null', () => assert.strictEqual(ext.evaluate('a&b'), null));
check('calc: open paren tolerated (live-calc UX)', () => assert.strictEqual(ext.evaluate('(2+3'), '5'));
check('calc: 1..2 => null', () => assert.strictEqual(ext.evaluate('1..2'), null));
check('calc: unknown ident => null', () => assert.strictEqual(ext.evaluate('foobar'), null));
check('calc: 1/0 => null (non-finite)', () => assert.strictEqual(ext.evaluate('1/0'), null));
check('calc: trailing junk rejected', () => assert.strictEqual(ext.evaluate('2+3x'), null));

/* ============ hotwords ============ */
const hw = ['git|url|https://github.com/umar/spotlight-search',
    '  todo  |command| ls -la',
    'shutdown|system|poweroff',
    '|url|x',
    'nolabel| |'];
const inst = SptInstance({get_strv: () => hw});

check('hotwords: parsed + token lowercase', () => {
    const list = inst._hotWords();
    assert.strictEqual(list.length, 3);
    assert.deepEqual(list[0], {token: 'git', label: 'git', type: 'url', target: 'https://github.com/umar/spotlight-search'});
    assert.strictEqual(list[1].token, 'todo');
});
check('hotwords: cached within TTL (same ref)', () => {
    const a = inst._hotWords();
    const b = inst._hotWords();
    assert.strictEqual(a, b);
    assert.ok(typeof inst._hotWordsCacheAt === 'number');
});
check('hotwords: TTL expires after 10s', async () => {
    const a = inst._hotWords();
    inst._hotWordsCacheAt = Date.now() - 11000;
    const b = inst._hotWords();
    assert.notStrictEqual(a, b);
});
check('hotword match: exact case-insensitive', () => {
    assert.strictEqual(inst._matchHotWord('GIT').token, 'git');
    assert.strictEqual(inst._matchHotWord('  shutdown  ').token, 'shutdown');
});
check('hotword match: no partial match', () => {
    assert.strictEqual(inst._matchHotWord('gi'), null);
    assert.strictEqual(inst._matchHotWord('gita'), null);
    assert.strictEqual(inst._matchHotWord(''), null);
    assert.strictEqual(inst._matchHotWord('   '), null);
});

/* ============ hotword runner (stubbed Gio/Main) ============ */
const runner = SptInstance({get_strv: () => hw});
check('run: url hotword normalizes bare domain', () => {
    calls.uris.length = 0;
    runner._runHotWord({type: 'url', target: 'duckduckgo.com'});
    assert.deepEqual(calls.uris, ['https://duckduckgo.com']);
});
check('run: url hotword keeps scheme', () => {
    calls.uris.length = 0;
    runner._runHotWord({type: 'url', target: 'https://example.com/x?y=1'});
    assert.deepEqual(calls.uris, ['https://example.com/x?y=1']);
});
check('run: url hotword handles protocol-relative', () => {
    calls.uris.length = 0;
    runner._runHotWord({type: 'url', target: '//example.com'});
    assert.deepEqual(calls.uris, ['https://example.com']);
});
check('run: command hotword runs via sh -c', () => {
    calls.subbed.length = 0;
    runner._runHotWord({type: 'command', target: 'ls -la'});
    assert.deepEqual(calls.subbed, [['sh', '-c', 'ls -la']]);
});
check('run: unknown system action notifies, no crash', () => {
    calls.notify.length = 0;
    runner._runHotWord({type: 'system', target: 'nonsense'});
    assert.ok(calls.notify.some(([t, b]) => t === 'Spotlight' && b.includes('Unknown system action')));
});

/* ============ prefs helpers (shortcut logic) ============ */
const {_normCombo, _isModifierKey, _comboFromKey} = prefs;
check('prefs: _normCombo lowercases and strips spaces', () => {
    assert.strictEqual(_normCombo(' <Control> A '), '<control>a');
    assert.strictEqual(_normCombo('SUPER+Space'), 'super+space');
});
check('prefs: _isModifierKey detects modifier keyvals', () => {
    assert.ok(_isModifierKey(0xffe1));   /* Shift_L */
    assert.ok(_isModifierKey(0xffeb));   /* Super_L */
    assert.ok(_isModifierKey(0));        /* null key */
    assert.ok(!_isModifierKey(0x61));    /* 'a' */
});
check('prefs: plain key without modifier rejected', () => {
    assert.strictEqual(_comboFromKey(0x61, 0), null);
});
check('prefs: Esc returns ESC', () => {
    assert.strictEqual(_comboFromKey(0xff1b, 0), 'ESC');
});
check('prefs: modifier-only press returns MOD', () => {
    assert.strictEqual(_comboFromKey(0xffe1, (1 << 0) | (1 << 2)), 'MOD');
});
check('prefs: Super+space produces combo', () => {
    const combo = _comboFromKey(0x20, 1 << 6);
    assert.ok(combo.includes('super') && combo.includes('space'), combo);
});

/* ============ unit conversion ============ */
check('convert: module exposes convertUnit', () => {
    assert.strictEqual(typeof ext.convertUnit, 'function');
});
check('convert: 10 km to miles', () => {
    const v = ext.convertUnit('10 km to miles');
    assert.ok(v.startsWith('6.2137'), v);
});
check('convert: 3 cups to ml', () => {
    const v = ext.convertUnit('3 cups to ml');
    assert.ok(v.startsWith('709.764'), v);
});
check('convert: 100 f to c', () => {
    const v = ext.convertUnit('100 f to c');
    assert.ok(v.startsWith('37.777'), v);
});
check('convert: 0 C to F = 32 f', () => assert.strictEqual(ext.convertUnit('0 C to F'), '32 f'));
check('convert: 1 h in minutes = 60 minutes', () => assert.strictEqual(ext.convertUnit('1 h in minutes'), '60 minutes'));
check('convert: 60 mph to km/h', () => {
    const v = ext.convertUnit('60 mph to km/h');
    assert.ok(v.startsWith('96.560'), v);
});
check('convert: 5 gb to mb', () => assert.strictEqual(ext.convertUnit('5 gb to mb'), '5000 mb'));
check('convert: unknown units => null', () => assert.strictEqual(ext.convertUnit('10 xyz to abc'), null));
check('convert: missing connective => null', () => assert.strictEqual(ext.convertUnit('10 km miles'), null));

/* ============ calculator upgrades ============ */
check('calc: 5! = 120', () => assert.strictEqual(ext.evaluate('5!'), '120'));
check('calc: 0! = 1', () => assert.strictEqual(ext.evaluate('0!'), '1'));
check('calc: 3!+4 = 10', () => assert.strictEqual(ext.evaluate('3!+4'), '10'));
check('calc: -3! = -6', () => assert.strictEqual(ext.evaluate('-3!'), '-6'));
check('calc: √9 = 3', () => assert.strictEqual(ext.evaluate('√9'), '3'));
check('calc: phi', () => approx(ext.evaluate('phi'), (1 + Math.sqrt(5)) / 2));
check('calc: phi^2', () => approx(ext.evaluate('phi^2'), 2.6180339887));

/* ============ emoji picker ============ */
check('emoji: match by keyword', () => {
    assert.ok(ext._matchEmoji('smil').some(e => e.symbol === '😀'));
});
check('emoji: rows from "emoji heart"', () => {
    const inst = SptInstance({get_strv: () => [], get_boolean: () => true, get_int: () => 20});
    assert.ok(inst._emojiRows('emoji heart').some(r => r.label.includes('❤')));
});
check('emoji: unknown keyword gives hint row', () => {
    const inst = SptInstance({get_strv: () => []});
    assert.ok(inst._emojiRows('emoji zzzqq').some(r => r.label.startsWith('No emoji')));
});

/* ============ clipboard history ============ */
check('clip: rows filtered by term', () => {
    const inst = SptInstance({get_strv: () => [], get_boolean: () => true, get_int: () => 20});
    inst._clipHist = ['hello world', 'another note', 'hello again'];
    assert.strictEqual(inst._clipRows('clip hello').length, 2);
});
check('clip: no history shows hint', () => {
    const inst = SptInstance({get_strv: () => [], get_boolean: () => true, get_int: () => 20});
    assert.ok(inst._clipRows('clip').some(r => r.label.includes('empty')));
});
check('clip: disabled returns []', () => {
    const inst = SptInstance({get_strv: () => [], get_boolean: () => false});
    assert.strictEqual(inst._clipRows('clip x').length, 0);
});
check('clip: copy puts item on clipboard', () => {
    const inst = SptInstance({get_strv: () => [], get_boolean: () => true, get_int: () => 20});
    inst._clipHist = ['snip-in-clipboard'];
    calls.clipSet.length = 0;
    const rows = inst._clipRows('clip');
    rows[0].activate();
    assert.strictEqual(calls.clipSet.pop(), 'snip-in-clipboard');
});
check('clip: readClipText captures via async callback', async () => {
    const inst = SptInstance({get_strv: () => [], get_boolean: () => true, get_int: () => 20});
    inst._clipHist = [];
    inst._readClipText();
    await new Promise(r => setTimeout(r, 10));
    assert.ok(inst._clipHist.includes('clipboard probe text'));
});
check('clip: on empty history a fresh read is triggered', async () => {
    const inst = SptInstance({get_strv: () => [], get_boolean: () => true, get_int: () => 20});
    inst._clipHist = [];
    const rows = inst._clipRows('clip');
    assert.ok(rows.some(r => r.label.includes('empty')));
    await new Promise(r => setTimeout(r, 10));
    assert.ok(inst._clipHist.includes('clipboard probe text'));
});
check('clip: pushClip dedupes and moves to top', () => {
    const inst = SptInstance({get_strv: () => [], get_boolean: () => true, get_int: () => 20});
    inst._clipHist = ['aa', 'bb'];
    assert.strictEqual(inst._pushClip('bb'), true);
    assert.deepStrictEqual(inst._clipHist, ['bb', 'aa']);
    assert.strictEqual(inst._pushClip('bb'), false);
    assert.strictEqual(inst._pushClip(''), false);
});
check('clip: captures image clipboard to history', async () => {
    const inst = SptInstance({get_strv: () => [], get_boolean: () => true, get_int: () => 20});
    inst._clipImgs = [];
    inst._readClipText();
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(inst._clipImgs.length, 1);
    assert.ok(inst._clipImgs[0].path.includes('spotlight-clip'));
    assert.strictEqual(inst._clipImgs[0].mime, 'image/png');
});
const imgBytes = {get_data: () => new Uint8Array(4)};
check('clip: image row listed above text rows', () => {
    const inst = SptInstance({get_strv: () => [], get_boolean: () => true, get_int: () => 20});
    inst._clipHist = ['note text'];
    inst._clipImgs = [{path: '/tmp/a.png', mime: 'image/png', data: imgBytes}];
    const rows = inst._clipRows('clip');
    assert.ok(rows[0].group === 'clip' && rows[0].image === '/tmp/a.png');
    assert.ok(rows[0].sublabel.includes('copy'));
    assert.strictEqual(rows[0].data, imgBytes);
});
check('clip: image stored even if cache write fails; activation is safe', () => {
    const inst = SptInstance({get_strv: () => [], get_boolean: () => true, get_int: () => 20});
    inst._clipImgs = [];
    const origFile = GIO.File.new_for_path;
    const origSet = clipMethods.set_content;
    GIO.File.new_for_path = () => ({replace_contents: () => [false, null], delete: () => true});
    clipMethods.set_content = () => { throw new Error('set_content disabled'); };
    try {
        inst._pushClipImage('image/png', {get_data: () => new Uint8Array(4)});
        assert.strictEqual(inst._clipImgs.length, 1);
        assert.strictEqual(inst._clipImgs[0].path, '');
        calls.notify.length = 0;
        inst._copyClipImage(inst._clipImgs[0]);
        assert.strictEqual(calls.notify.length, 1);
        assert.ok(calls.notify.some(([, b]) => b.includes('no longer available')));
    } finally {
        GIO.File.new_for_path = origFile;
        clipMethods.set_content = origSet;
    }
});
check('clip: image row copies back via St.Clipboard set_content', () => {
    const inst = SptInstance({get_strv: () => [], get_boolean: () => true, get_int: () => 20});
    inst._clipHist = [];
    inst._clipImgs = [{path: '/tmp/a.png', mime: 'image/png', data: new Uint8Array(4)}];
    calls.clipSet.length = 0;
    calls.subbed.length = 0;
    calls.notify.length = 0;
    const rows = inst._clipRows('clip');
    rows[0].activate();
    assert.strictEqual(calls.clipSet.pop(), 'IMG:image/png');
    assert.strictEqual(calls.subbed.length, 0);
    assert.ok(calls.notify.some(([, b]) => b.includes('paste')));
});
check('clip: image row copies its path when set_content and external tool unavailable', () => {
    const inst = SptInstance({get_strv: () => [], get_boolean: () => true, get_int: () => 20});
    inst._clipHist = [];
    inst._clipImgs = [{path: '/tmp/a.png', mime: 'image/png', data: new Uint8Array(4)}];
    const origSet = clipMethods.set_content;
    const origFind = GLIB.find_program_in_path;
    clipMethods.set_content = () => { throw new Error('set_content disabled'); };
    GLIB.find_program_in_path = () => null;
    calls.clipSet.length = 0;
    calls.notify.length = 0;
    try {
        const rows = inst._clipRows('clip');
        rows[0].activate();
        assert.strictEqual(calls.clipSet.pop(), '/tmp/a.png');
        assert.strictEqual(calls.notify.length, 1);
        assert.ok(calls.notify.some(([, b]) => b.includes('path copied')));
    } finally {
        clipMethods.set_content = origSet;
        GLIB.find_program_in_path = origFind;
    }
});
check('clip: image row uses external clipboard tool when set_content unavailable', () => {
    const inst = SptInstance({get_strv: () => [], get_boolean: () => true, get_int: () => 20});
    inst._clipImgs = [{path: '/tmp/a.png', mime: 'image/png', data: new Uint8Array(4)}];
    const origSet = clipMethods.set_content;
    const origFind = GLIB.find_program_in_path;
    clipMethods.set_content = () => { throw new Error('set_content disabled'); };
    GLIB.find_program_in_path = () => 'wl-copy';
    calls.subbed.length = 0;
    calls.clipSet.length = 0;
    try {
        inst._copyClipImage(inst._clipImgs[0]);
        assert.strictEqual(calls.subbed.length, 1);
        assert.ok(calls.subbed[0].join(' ').includes('wl-copy --type image/png'));
        assert.ok(calls.subbed[0].includes('/tmp/a.png'));
        assert.strictEqual(calls.clipSet.length, 0);
    } finally {
        clipMethods.set_content = origSet;
        GLIB.find_program_in_path = origFind;
    }
});
check('clip: images numbered newest=largest', () => {
    const inst = SptInstance({get_strv: () => [], get_boolean: () => true, get_int: () => 20});
    inst._clipHist = [];
    inst._clipImgs = [
        {path: '/tmp/new.png', mime: 'image/png', data: new Uint8Array(1)},
        {path: '/tmp/mid.png', mime: 'image/png', data: new Uint8Array(1)},
        {path: '/tmp/old.png', mime: 'image/png', data: new Uint8Array(1)},
    ];
    const rows = inst._clipRows('clip');
    assert.strictEqual(rows[0].label, 'Image 3');
    assert.strictEqual(rows[1].label, 'Image 2');
    assert.strictEqual(rows[2].label, 'Image 1');
});
check('clip: clear command empties history and clipboard', () => {
    const inst = SptInstance({get_strv: () => [], get_boolean: () => true, get_int: () => 20});
    inst._clipHist = ['a', 'b'];
    inst._clipImgs = [{path: '/tmp/a.png', mime: 'image/png', data: new Uint8Array(4)}];
    calls.clipSet.length = 0;
    const rows = inst._clipRows('clip clear');
    const clearRow = rows.find(r => r.label.includes('Clear'));
    assert.ok(clearRow, 'clear row present');
    clearRow.activate();
    assert.strictEqual(calls.clipSet.pop(), '');
    assert.strictEqual(inst._clipHist.length, 0);
    assert.strictEqual(inst._clipImgs.length, 0);
});

/* ============ timers ============ */
check('timer: 5m row', () => {
    const inst = SptInstance({get_strv: () => []});
    assert.ok(inst._timerRows('timer 5m').some(r => r.label === 'Start timer: 5 minutes'));
});
check('timer: 90s row', () => {
    const inst = SptInstance({get_strv: () => []});
    assert.ok(inst._timerRows('timer 90s').some(r => r.label === 'Start timer: 90 seconds'));
});
check('timer: cancel row when active', () => {
    const inst = SptInstance({get_strv: () => []});
    inst._timers = [{id: 7, label: '5 minutes'}];
    assert.ok(inst._timerRows('cancel timers').some(r => r.label.includes('Cancel 1 active')));
});
check('timer: unrelated query is empty', () => {
    const inst = SptInstance({get_strv: () => []});
    assert.strictEqual(inst._timerRows('firefox').length, 0);
});

/* ============ media / brightness ============ */
check('media: mute row', () => {
    const inst = SptInstance({get_strv: () => []});
    assert.ok(inst._mediaRows('mute').some(r => r.label === 'Mute audio'));
});
check('media: volume up row', () => {
    const inst = SptInstance({get_strv: () => []});
    assert.ok(inst._mediaRows('volume up').some(r => r.label === 'Volume up'));
});
check('media: brightness 40 row', () => {
    const inst = SptInstance({get_strv: () => []});
    assert.ok(inst._mediaRows('brightness 40').some(r => r.label === 'Set brightness to 40%'));
});

/* ============ web suggestions ============ */
check('suggest: skipped when disabled', () => {
    const inst = SptInstance({get_strv: () => [], get_boolean: () => false});
    calls.soupReq = 0;
    inst._webSuggest('hello world');
    assert.strictEqual(calls.soupReq, 0);
});
check('suggest: short query skipped', () => {
    const inst = SptInstance({get_strv: () => [], get_boolean: () => true, get_int: () => 20});
    calls.soupReq = 0;
    inst._webSuggest('ab');
    assert.strictEqual(calls.soupReq, 0);
});
check('suggest: fires request for plain text', () => {
    const inst = SptInstance({get_strv: () => [], get_boolean: () => true, get_int: () => 20});
    calls.soupReq = 0;
    inst._webSuggest('hello world');
    assert.strictEqual(calls.soupReq, 1);
});

/* ============ `ls <folder>` ============ */
check('ls: lists folder contents, folders first, activates item', () => {
    const fs = new Map([
        ['/home/test', [
            {name: 'notes.txt', isDir: false}, {name: 'docs', isDir: true},
        ]],
        ['/home/test/docs', [
            {name: 'a.txt', isDir: false}, {name: 'sub', isDir: true},
        ]],
        ['/home/test/docs/sub', []],
    ]);
    setLsFs(fs);
    try {
        const inst = SptInstance({get_strv: () => []});
        inst.close = () => { calls.lsClosed = true; };
        const data = inst._lsDirItems('docs');
        assert.strictEqual(data.found, true, 'folder resolved');
        assert.strictEqual(data.dirPath, '/home/test/docs');
        assert.strictEqual(data.items.length, 2);
        assert.strictEqual(data.items[0].name, 'sub');
        assert.strictEqual(data.items[0].isDir, true);
        assert.strictEqual(data.items[1].name, 'a.txt');
        assert.ok(data.items[1].uri.startsWith('file://'));
        calls.uris = [];
        inst._gridData = data;
        inst._gridActivate(1);
        assert.ok(calls.uris.includes(data.items[1].uri), 'opens item');
        assert.ok(calls.lsClosed, 'closes search');
        assert.strictEqual(inst._lsDirItems('docs/sub').items.length, 0);
        assert.strictEqual(inst._lsDirItems('docs/sub').found, true);
    } finally {
        setLsFs(null);
    }
});
check('ls: folder resolution — home, direct, case-insensitive, absolute, missing', () => {
    const fs = new Map([
        ['/home/test', [
            {name: 'DOWNLOADS', isDir: true}, {name: 'pics', isDir: true},
        ]],
        ['/home/test/DOWNLOADS', [{name: 'x.zip', isDir: false}]],
        ['/home/test/pics', [{name: 'wall.jpg', isDir: false}]],
        ['/etc/conf', [{name: 'a.conf', isDir: false}]],
    ]);
    setLsFs(fs);
    try {
        const inst = SptInstance({get_strv: () => []});
        assert.strictEqual(inst._findFolder('home'), '/home/test');
        assert.strictEqual(inst._findFolder('DOWNLOADS'), '/home/test/DOWNLOADS');
        assert.strictEqual(inst._findFolder('downloads'), '/home/test/DOWNLOADS');
        assert.strictEqual(inst._findFolder('/etc/conf'), '/etc/conf');
        assert.strictEqual(inst._findFolder('nonexistent'), null);
        const prefixed = new Map([
            ['/home/test', [
                {name: 'HyperFluent-GNOME-Theme', isDir: true},
                {name: 'hoops', isDir: true},
                {name: 'docs', isDir: true},
            ]],
            ['/home/test/HyperFluent-GNOME-Theme', [{name: 'r.txt', isDir: false}]],
            ['/home/test/hoops', [{name: 'b.txt', isDir: false}]],
            ['/home/test/docs', [{name: 'a.txt', isDir: false}]],
        ]);
        setLsFs(prefixed);
        assert.strictEqual(inst._findFolder('h'), '/home/test/hoops',
            'partial fragment resolves to the alphabetically-first match');
        assert.strictEqual(inst._findFolder('HY'), '/home/test/HyperFluent-GNOME-Theme',
            'case-insensitive prefix narrows to the right folder');
        assert.strictEqual(inst._findFolder('docs'), '/home/test/docs',
            'exact names still win');
        const grid = inst._lsDirItems('h');
        assert.strictEqual(grid.found, true, 'prefix grid resolves');
        assert.strictEqual(grid.dirPath, '/home/test/hoops');
        assert.strictEqual(grid.items.length, 1);
        assert.strictEqual(inst._findFolder('HyperFluent-GNOME-Theme'),
            '/home/test/HyperFluent-GNOME-Theme');
    } finally {
        setLsFs(null);
    }
});
check('ls: bounded recursive search finds nested folder', () => {
    const fs = new Map([
        ['/home/test', [{name: 'work', isDir: true}]],
        ['/home/test/work', [{name: 'src', isDir: true}, {name: 'x.log', isDir: false}]],
        ['/home/test/work/src', [{name: 'node_modules', isDir: true}]],
    ]);
    setLsFs(fs);
    try {
        const inst = SptInstance({get_strv: () => []});
        assert.strictEqual(inst._findFolder('src'), '/home/test/work/src');
        assert.strictEqual(inst._findFolder('x.log'), null);
        assert.strictEqual(inst._lsDirItems('nope').found, false);
        assert.strictEqual(inst._lsDirItems('').found, false);
        assert.strictEqual(inst._lsDirItems('  ').found, false);
    } finally {
        setLsFs(null);
    }
});
check('ls: grid column count derives from panel width', () => {
    const inst = SptInstance({get_strv: () => []});
    assert.strictEqual(inst._gridCols(), 5, 'default 640px -> 5 cols');
    inst._settings = {get_int: () => 1340};
    assert.strictEqual(inst._gridCols(), 8, 'wide panel capped at 8');
    inst._settings = {get_int: () => 200};
    assert.strictEqual(inst._gridCols(), 2, 'narrow panel floored at 2');
    inst._settings = {get_int: () => { throw new Error('boom'); }};
    assert.strictEqual(inst._gridCols(), 5, 'fallback to default on error');
});
check('ls: autocomplete picks first alphabetical matching folder', () => {
    const fs = new Map([
        ['/home/test', [
            {name: 'zebra', isDir: true}, {name: 'Archive', isDir: true},
            {name: 'notes.txt', isDir: false}, {name: 'readme', isDir: true},
        ]],
    ]);
    setLsFs(fs);
    try {
        const inst = SptInstance({get_strv: () => []});
        const c = inst._lsComplete('arc');
        assert.strictEqual(c.full, 'Archive');
        assert.strictEqual(c.tail, 'hive');
        assert.strictEqual(inst._lsComplete('zebra'), null, 'exact match -> null');
        assert.strictEqual(inst._lsComplete('note'), null, 'files ignored');
        assert.strictEqual(inst._lsComplete('read').full, 'readme');
        assert.strictEqual(inst._lsComplete('a/b'), null,
            'unresolvable directory part -> null');
        assert.strictEqual(inst._lsComplete(' a'), null, 'leading space excluded');
        assert.strictEqual(inst._lsComplete(''), null, 'empty fragment');
    } finally {
        setLsFs(null);
    }
});
check('ls: autocomplete works for nested folders and path-qualified names', () => {
    const fs = new Map([
        ['/home/test', [
            {name: 'work', isDir: true}, {name: 'docs', isDir: true},
        ]],
        ['/home/test/work', [
            {name: 'src', isDir: true}, {name: 'Assets', isDir: true},
            {name: 'notes.txt', isDir: false},
        ]],
        ['/home/test/work/src', [{name: 'node_modules', isDir: true}]],
    ]);
    setLsFs(fs);
    try {
        const inst = SptInstance({get_strv: () => []});
        /* nested folder, unanchored fragment: found anywhere in the tree */
        const a = inst._lsComplete('sr');
        assert.strictEqual(a.full, 'src');
        assert.strictEqual(a.tail, 'c');
        assert.strictEqual(inst._findFolder('sr'), '/home/test/work/src',
            'Enter resolves the same nested partial');
        assert.strictEqual(inst._lsDirItems('sr').found, true,
            'nested partial grid resolves');
        assert.strictEqual(inst._lsDirItems('sr').dirPath,
            '/home/test/work/src');
        /* path-qualified completion */
        const b = inst._lsComplete('work/sr');
        assert.strictEqual(b.full, 'work/src');
        assert.strictEqual(b.tail, 'c');
        const c = inst._lsComplete('work/ass');
        assert.strictEqual(c.full, 'work/Assets');
        assert.strictEqual(c.tail, 'ets');
        /* complete name (even nested) -> nothing to suggest */
        assert.strictEqual(inst._lsComplete('work/src'), null);
        /* files skipped; bogus/incomplete dir parts rejected */
        assert.strictEqual(inst._lsComplete('work/notes'), null);
        assert.strictEqual(inst._lsComplete('nope/x'), null);
        /* ~ shorthand resolves the same way */
        const d = inst._lsComplete('~/work/sr');
        assert.strictEqual(d.full, '~/work/src');
        assert.strictEqual(d.tail, 'c');
    } finally {
        setLsFs(null);
    }
});
check('ls: same-name folders show a picker with short paths', () => {
    const fs = new Map([
        ['/home/test', [
            {name: 'proj', isDir: true}, {name: 'docs', isDir: true},
        ]],
        ['/home/test/proj', [{name: 'src', isDir: true}]],
        ['/home/test/docs', [{name: 'src', isDir: true}]],
        ['/home/test/proj/src', [{name: 'a.txt', isDir: false}]],
    ]);
    setLsFs(fs);
    try {
        const inst = SptInstance({get_strv: () => []});
        const d = inst._lsDirItems('src');
        assert.strictEqual(d.found, true);
        assert.strictEqual(d.items, null, 'picker list instead of a grid');
        assert.strictEqual(d.multi.length, 2);
        assert.strictEqual(d.multi[0].path, '/home/test/docs/src',
            'sorted by path');
        assert.strictEqual(d.multi[1].path, '/home/test/proj/src');
        /* exact-name duplicates suppress the ghost: no single best */
        assert.strictEqual(inst._lsComplete('src'), null);
        /* a single same-name folder keeps the normal grid resolution */
        const single = new Map([
            ['/home/test', [{name: 'docs', isDir: true}]],
            ['/home/test/docs', [{name: 'src', isDir: true}]],
            ['/home/test/docs/src', []],
        ]);
        setLsFs(single);
        assert.strictEqual(inst._lsDirItems('src').multi, undefined);
        assert.strictEqual(inst._lsDirItems('src').dirPath,
            '/home/test/docs/src');
        /* display path = last 3 directories only */
        assert.strictEqual(inst._shortFolderPath('/home/test/proj/src'),
            'test/proj/src');
        assert.strictEqual(inst._shortFolderPath('/a/b/c/d/src'),
            'c/d/src');
        assert.strictEqual(inst._shortFolderPath('/home/x'), 'home/x');
        /* path-qualified names never trigger the picker */
        setLsFs(fs);
        assert.strictEqual(inst._findFolder('proj/src'),
            '/home/test/proj/src');
    } finally {
        setLsFs(null);
    }
});
check('ls: deep release folders are discovered (depth 4) and listed', () => {
    const fs = new Map([
        ['/home/test', [
            {name: 'Downloads', isDir: true}, {name: 'proj', isDir: true},
        ]],
        ['/home/test/Downloads', [{name: 'ABDM', isDir: true}]],
        ['/home/test/Downloads/ABDM', [{name: 'Compressed', isDir: true}]],
        ['/home/test/Downloads/ABDM/Compressed', [
            {name: 'MacTahoe-icon-theme-2026', isDir: true},
        ]],
        ['/home/test/Downloads/ABDM/Compressed/MacTahoe-icon-theme-2026', [
            {name: 'release', isDir: true},
        ]],
        ['/home/test/proj', [{name: 'release', isDir: true}]],
    ]);
    setLsFs(fs);
    try {
        const inst = SptInstance({get_strv: () => []});
        const found = inst._findFolders('release');
        assert.strictEqual(found.length, 2, 'deep + shallow both found');
        assert.strictEqual(found[0].path,
            '/home/test/Downloads/ABDM/Compressed/' +
            'MacTahoe-icon-theme-2026/release');
        assert.strictEqual(found[1].path, '/home/test/proj/release');
        const d = inst._lsDirItems('release');
        assert.strictEqual(d.found, true);
        assert.strictEqual(d.multi.length, 2);
        assert.strictEqual(inst._shortFolderPath(found[0].path),
            'Compressed/MacTahoe-icon-theme-2026/release');
    } finally {
        setLsFs(null);
    }
});
check('ls: no ghost in the buffer; Tab completion candidate tracked', () => {
    const fs = new Map([
        ['/home/test', [
            {name: 'Documents', isDir: true}, {name: 'Downloads', isDir: true},
        ]],
    ]);
    setLsFs(fs);
    try {
        const inst = SptInstance({get_strv: () => []});
        inst._markupLock = false;
        inst._hotWordMarkup = null;
        let attrs = null;
        let caretSet = false;
        let setText = null;
        inst._entry = {
            text: 'ls Do',
            get_theme_node: () => null,
            clutter_text: {
                cursor_position: 5,
                set_attributes: a => { attrs = a; },
                set_cursor_position: () => { caretSet = true; },
                set_text: t => { setText = t; },
            },
        };
        inst._applyHotWordStyle();
        assert.strictEqual(inst._hotWordMarkup, 'ls');
        assert.strictEqual(setText, null, 'entry buffer untouched');
        assert.strictEqual(caretSet, false, 'caret untouched');
        assert.strictEqual(inst._entry.text, 'ls Do', 'typed text preserved verbatim');
        const style = attrs.items.find(a => a.kind === 'style');
        assert.strictEqual(style.style, 2, 'italic attr present');
        assert.strictEqual(style.start_index, 0, 'bounded to the ls word');
        assert.strictEqual(style.end_index, 2, 'covers only "ls"');
        assert.ok(!attrs.items.some(a => a.kind === 'fg' && a.r === 138 * 257),
            'no faint tail attr while typing');
        const g = inst._ghost;
        assert.strictEqual(g.pre, '');
        assert.strictEqual(g.frag, 'Do');
        assert.strictEqual(g.full, 'Documents');
        assert.strictEqual(g.tail, 'cuments');
        inst._commitGhost();
        assert.strictEqual(inst._entry.text, 'ls Documents', 'Tab commits the name');
    } finally {
        setLsFs(null);
    }
});
check('ls: typing "ls" alone stays "ls" so backspace removes it', () => {
    const inst = SptInstance({get_strv: () => []});
    setLsFs(null);
    inst._markupLock = false;
    inst._hotWordMarkup = null;
    let attrs = null;
    let caret = -1;
    let setText = null;
    inst._entry = {
        text: 'ls',
        get_theme_node: () => null,
        clutter_text: {
            cursor_position: 2,
            set_attributes: a => { attrs = a; },
            set_cursor_position: n => { caret = n; },
            set_text: t => { setText = t; },
        },
    };
    inst._applyHotWordStyle();
    assert.strictEqual(setText, null, 'no phantom space forced');
    assert.strictEqual(inst._entry.text, 'ls');
    assert.strictEqual(inst._lsUser, '');
    assert.strictEqual(caret, -1, 'caret never moved');
    assert.ok(attrs.items.some(a => a.kind === 'style' && a.style === 2), 'ls italicized');
    /* backspace: "ls" -> "l" leaves the branch entirely */
    inst._entry.text = 'l';
    inst._entry.clutter_text.cursor_position = 1;
    inst._hotWordMarkup = 'ls';
    inst._applyHotWordStyle();
    assert.strictEqual(inst._hotWordMarkup, null, 'resets styling');
    assert.strictEqual(inst._lsUser, null);
    assert.strictEqual(inst._ghost, null);
});
check('ls: entry text is never modified while typing a fragment', () => {
    const fs = new Map([
        ['/home/test', [
            {name: 'HooperFluent-GNOME-Theme', isDir: true},
            {name: 'Documents', isDir: true}, {name: 'Downloads', isDir: true},
        ]],
    ]);
    setLsFs(fs);
    try {
        const inst = SptInstance({get_strv: () => []});
        inst._markupLock = false;
        inst._hotWordMarkup = null;
        let buf = '';
        let caret = 0;
        const entry = {clutter_text: {}};
        entry.get_theme_node = () => null;
        entry.clutter_text.set_text = t => { buf = t; };
        entry.clutter_text.set_attributes = () => {};
        entry.clutter_text.set_cursor_position = n => { caret = n; };
        Object.defineProperty(entry.clutter_text, 'cursor_position',
            {get: () => caret, configurable: true});
        Object.defineProperty(entry, 'text', {
            get: () => buf,
            set: v => { buf = v; caret = v.length; },
            configurable: true,
        });
        inst._entry = entry;
        const type = ch => {
            buf = buf.slice(0, caret) + ch + buf.slice(caret);
            caret += ch.length;
            inst._applyHotWordStyle();
        };
        for (const ch of 'ls ho') type(ch);
        assert.strictEqual(buf, 'ls ho', 'entry tracked the Tab candidate, text untouched');
        assert.strictEqual(inst._ghost.full, 'hooperFluent-GNOME-Theme',
            'candidate kept for Tab');
        for (const ch of 'm') type(ch);
        assert.strictEqual(buf, 'ls hom', 'continuing types cleanly');
        assert.strictEqual(inst._ghost, null, 'no candidate for "hom"');
        for (const ch of 'e') type(ch);
        assert.strictEqual(buf, 'ls home', 'typed text intact');
    } finally {
        setLsFs(null);
    }
});
check('ls: entry italic styling applies only to the "ls" prefix', () => {
    const inst = SptInstance({get_strv: () => []});
    inst._markupLock = false;
    let attrs = null;
    let caret = -1;
    let setText = null;
    inst._entry = {
        text: 'ls home',
        get_theme_node: () => null,
        clutter_text: {
            cursor_position: 8,
            set_attributes: a => { attrs = a; },
            set_cursor_position: n => { caret = n; },
            set_text: t => { setText = t; },
        },
    };
    inst._hotWordMarkup = null;
    inst._applyHotWordStyle();
    assert.strictEqual(inst._hotWordMarkup, 'ls');
assert.strictEqual(setText, null, 'no buffer rewrite for plain query');
    const style = attrs.items.find(a => a.kind === 'style');
    assert.strictEqual(style.style, 2, 'italic bound to the ls word');
    assert.strictEqual(style.start_index, 0);
    assert.strictEqual(style.end_index, 2);
    assert.strictEqual(caret, -1, 'caret never moved');
    assert.ok(!attrs.items.some(a => a.kind === 'fg' && a.r === 138 * 257),
        'no ghost tail in plain query');
    inst._entry.text = 'fire';
    inst._entry.clutter_text.cursor_position = 4;
    inst._hotWordMarkup = 'ls';
    inst._applyHotWordStyle();
    assert.strictEqual(inst._hotWordMarkup, null, 'styling reset when ls no longer recognized');
    assert.strictEqual(inst._ghost, null, 'ghost cleared on non-ls text');
    assert.strictEqual(inst._lsUser, null, 'lsUser cleared on non-ls text');
});

/* ============ report ============ */
chain.then(() => {
    if (fails.length) {
        console.error(`\n${fails.length} FAILED, ${passed} passed:`);
        for (const f of fails)
            console.error('  ' + f);
        process.exit(1);
    }
    console.log(`\nAll ${passed} checks passed.`);
}).catch(e => {
    console.error('\nRunner error:', e);
    process.exit(1);
});