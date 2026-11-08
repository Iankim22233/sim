#!/usr/bin/env node
// Builds a PowerShell-style terminal emulator in the running TurboWarpRemote.app via twctl,
// then exports powershell.sb3 next to this file.
//   open -n ../turbowarp-remote/TurboWarpRemote.app
//   [FONT_FILE=/path/to/font.ttf FONT_SIZE=13] node build.mjs
// Text is drawn with the pen: one costume per character, stamped on a grid (60 x 16 cells of 8 x 15 px).
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadTTF, glyphSvg } from './ttf.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const TW = path.join(here, '../turbowarp-remote/twctl.mjs');
const OUT = path.join(here, 'powershell.sb3');
const tmp = path.join(here, '.build'); mkdirSync(tmp, { recursive: true });
const tw = (...a) => execFileSync('node', [TW, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

const COLS = 60, ROWS = 16, CELL_W = 8, CELL_H = 15;
const FONT_FILE = process.env.FONT_FILE, FONT_SIZE = +(process.env.FONT_SIZE || 13);
const ALLOWED = 'abcdefghijklmnopqrstuvwxyz0123456789_';
const SEP = '\u00b6';   // line separator inside file contents

const VARS = ['cwd', 'HOME', 'Tok', 'Rest', 'Cmd', 'Args', 'Done', 'Input', 'PI', 'chunk', 'SI', 'Tail', 'TJ', 'Head', 'HJ', 'PadRes',
  'Src', 'Tmp', 'EI', 'Exp', 'c2', 'VN', 'VI', 'P0', 'sb', 'PJ', 'chr', 'Acc', 'Parent', 'Name', 'Full', 'k', 'Idx', 'PIdx', 'R', 'Col',
  'Line', 'ch', 'Swept', 'OI', 'PL', 'QI', 'RP', 'App', 'FromI', 'ExpText', 'FileArg', 'NT', 'AN', 'AI', 'LI', 'mm', 'ss'];
const LISTS = ['Screen', 'FSPath', 'FSParent', 'FSName', 'FSType', 'FSData', 'Seg', 'VarNames', 'VarVals'];
const vid = n => `var_${n}`, lid = n => `list_${n}`;

// ---------- glyph set ----------
const font = FONT_FILE ? loadTTF(FONT_FILE) : null;
const asciiChars = []; for (let c = 33; c <= 126; c++) asciiChars.push(String.fromCharCode(c));
const esc = c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] ?? c);
const fallbackSvg = c => `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL_W}" height="${CELL_H}" viewBox="0 0 ${CELL_W} ${CELL_H}"><text x="4" y="11.5" font-family="Menlo, Consolas, 'Courier New', monospace" font-size="13" text-anchor="middle" fill="#eeedf0">${esc(c)}</text></svg>`;
const glyphs = [];   // { ch, svg, md5 }
for (const c of asciiChars) {
  const svg = font ? glyphSvg(font, c, { w: CELL_W, h: CELL_H, size: FONT_SIZE }) : fallbackSvg(c);
  if (svg) glyphs.push({ ch: c, svg, md5: createHash('md5').update(svg).digest('hex') });
}
const PRINTABLE = glyphs.map(g => g.ch).join('');
console.log(`font: ${FONT_FILE ? path.basename(FONT_FILE) + ` @${FONT_SIZE}px` : 'system monospace (set FONT_FILE=...ttf for a custom font)'} - ${glyphs.length} glyphs`);

// ---------- tiny block DSL (project.json-style blocks) ----------
function dsl() {
  const b = {}; let n = 0;
  const N = x => ({ lit: [4, String(x)] }), T = x => ({ lit: [10, String(x)] }), C = id => ({ cond: id });
  const val = x => typeof x === 'number' ? N(x) : x;
  const mk = (opcode, { inputs = {}, fields = {}, shadow = false, mutation } = {}) => {
    const id = `${opcode}_${++n}`;
    const blk = { opcode, next: null, parent: null, inputs: {}, fields, shadow, topLevel: false };
    if (mutation) blk.mutation = mutation;
    for (const [k, v0] of Object.entries(inputs)) {
      const v = val(v0);
      if (v.lit) blk.inputs[k] = [1, v.lit];
      else if (v.cond) { blk.inputs[k] = [2, v.cond]; b[v.cond].parent = id; }
      else if (v.menu) { blk.inputs[k] = [1, v.menu]; b[v.menu].parent = id; }
      else { blk.inputs[k] = [3, v, [10, '']]; b[v].parent = id; }
    }
    b[id] = blk; return id;
  };
  const chain = ids => { ids.forEach((id, i) => { if (i) { b[ids[i - 1]].next = id; b[id].parent = ids[i - 1]; } }); return ids[0]; };
  const script = (ids, x = 20, y = 20) => { const f = chain(ids); Object.assign(b[f], { topLevel: true, x, y }); };
  // list fields must declare variableType, or the VM treats them as plain variables and creates stray ones
  const L = name => ({ LIST: { name: 'LIST', value: name, id: lid(name), variableType: 'list' } });
  const V = name => ({ VARIABLE: [name, vid(name)] });
  const bin = (op, k1, k2) => (a, c) => mk(op, { inputs: { [k1]: a, [k2]: c } });
  const boolBin = op => (a, c) => mk(op, { inputs: { OPERAND1: C(a), OPERAND2: C(c) } });

  // custom blocks ("procedures"); all run without screen refresh
  const proc = (name, args) => {
    const code = [name, ...args.map(() => '%s')].join(' ');
    const ids = args.map(a => `a_${name}_${a}`);
    const mut = extra => ({ tagName: 'mutation', children: [], proccode: code, argumentids: JSON.stringify(ids), warp: 'true', ...extra });
    return {
      call: (...vals) => mk('procedures_call', { inputs: Object.fromEntries(ids.map((id, i) => [id, vals[i]])), mutation: mut() }),
      define(body, x = 20, y = 20) {
        const shadows = Object.fromEntries(ids.map((id, i) => [id, { menu: mk('argument_reporter_string_number', { shadow: true, fields: { VALUE: [args[i], null] } }) }]));
        const proto = mk('procedures_prototype', { shadow: true, inputs: shadows, mutation: mut({ argumentnames: JSON.stringify(args), argumentdefaults: JSON.stringify(args.map(() => '')) }) });
        script([mk('procedures_definition', { inputs: { custom_block: { menu: proto } } }), ...body], x, y);
      },
    };
  };

  return {
    b, N, T, C, chain, script, mk, proc,
    arg: name => mk('argument_reporter_string_number', { fields: { VALUE: [name, null] } }),
    flag: () => mk('event_whenflagclicked'),
    forever: sub => mk('control_forever', { inputs: { SUBSTACK: C(sub) } }),
    if_: (cond, sub) => mk('control_if', { inputs: { CONDITION: C(cond), SUBSTACK: C(sub) } }),
    ifElse: (cond, a, e) => mk('control_if_else', { inputs: { CONDITION: C(cond), SUBSTACK: C(a), SUBSTACK2: C(e) } }),
    repeat: (t, sub) => mk('control_repeat', { inputs: { TIMES: t, SUBSTACK: C(sub) } }),
    repeatUntil: (cond, sub) => mk('control_repeat_until', { inputs: { CONDITION: C(cond), SUBSTACK: C(sub) } }),
    stopAll: () => mk('control_stop', { fields: { STOP_OPTION: ['all'] }, mutation: { tagName: 'mutation', children: [], hasnext: 'false' } }),
    hide: () => mk('looks_hide'),
    gotoXY: (x, y) => mk('motion_gotoxy', { inputs: { X: x, Y: y } }),
    switchCostume: name => mk('looks_switchcostumeto', { inputs: { COSTUME: name } }),
    penClear: () => mk('pen_clear'), stamp: () => mk('pen_stamp'),
    ask: q => mk('sensing_askandwait', { inputs: { QUESTION: q } }), answer: () => mk('sensing_answer'),
    current: kind => mk('sensing_current', { fields: { CURRENTMENU: [kind] } }),
    set: (name, v) => mk('data_setvariableto', { inputs: { VALUE: typeof v === 'number' ? T(v) : v }, fields: V(name) }),
    change: (name, d) => mk('data_changevariableby', { inputs: { VALUE: d }, fields: V(name) }),
    v: name => mk('data_variable', { fields: V(name) }),
    addTo: (l, x) => mk('data_addtolist', { inputs: { ITEM: x }, fields: L(l) }),
    delAll: l => mk('data_deletealloflist', { fields: L(l) }),
    delAt: (l, i) => mk('data_deleteoflist', { inputs: { INDEX: i }, fields: L(l) }),
    replaceAt: (l, i, x) => mk('data_replaceitemoflist', { inputs: { INDEX: i, ITEM: x }, fields: L(l) }),
    itemOf: (l, i) => mk('data_itemoflist', { inputs: { INDEX: i }, fields: L(l) }),
    itemNum: (l, x) => mk('data_itemnumoflist', { inputs: { ITEM: x }, fields: L(l) }),
    lenList: l => mk('data_lengthoflist', { fields: L(l) }),
    join: bin('operator_join', 'STRING1', 'STRING2'),
    letterOf: (i, s) => mk('operator_letter_of', { inputs: { LETTER: i, STRING: s } }),
    len: s => mk('operator_length', { inputs: { STRING: s } }),
    contains: bin('operator_contains', 'STRING1', 'STRING2'),
    add: bin('operator_add', 'NUM1', 'NUM2'), sub: bin('operator_subtract', 'NUM1', 'NUM2'), mul: bin('operator_multiply', 'NUM1', 'NUM2'),
    eq: bin('operator_equals', 'OPERAND1', 'OPERAND2'), gt: bin('operator_gt', 'OPERAND1', 'OPERAND2'), lt: bin('operator_lt', 'OPERAND1', 'OPERAND2'),
    and: boolBin('operator_and'), or: boolBin('operator_or'),
    not: a => mk('operator_not', { inputs: { OPERAND: C(a) } }),
  };
}

const F = dsl();
const { T, chain, script, proc, arg, flag, forever, if_, ifElse, repeat, repeatUntil, stopAll, hide, gotoXY, switchCostume, penClear, stamp, ask, answer,
  current, set, change, v, addTo, delAll, delAt, replaceAt, itemOf, itemNum, lenList, join, letterOf, len, contains, add, sub, mul, eq, gt, lt, and, or, not } = F;
const J = (...p) => p.reduceRight((acc, x) => join(x, acc));      // join(a, join(b, c))

// ---------- custom blocks ----------
const redraw = proc('redraw', []), print = proc('print', ['text']), split = proc('split', ['text']), tail = proc('tail', ['text', 'from']),
  head = proc('head', ['text', 'count']), lpad = proc('lpad', ['text', 'width']), expand = proc('expand', ['text']),
  resolve = proc('resolve', ['path']), mkentry = proc('mkentry', ['path', 'parent', 'name', 'type', 'data']),
  makeitem = proc('makeitem', ['path', 'type']), writefile = proc('writefile', ['path', 'text', 'append']),
  printlines = proc('printlines', ['text']), sweep = proc('sweep', []), skipflags = proc('skipflags', ['text']);

// redraw: wipe the pen layer and stamp every character of Screen
redraw.define([
  penClear(), set('R', 1),
  repeat(lenList('Screen'), chain([
    set('Line', itemOf('Screen', v('R'))), set('Col', 1),
    repeat(len(v('Line')), chain([
      set('ch', letterOf(v('Col'), v('Line'))),
      if_(contains(T(PRINTABLE), v('ch')), chain([
        switchCostume(join(T('g'), v('ch'))),
        gotoXY(add(-240 + CELL_W / 2, mul(sub(v('Col'), 1), CELL_W)), sub(180 - 4 - CELL_H / 2, mul(sub(v('R'), 1), CELL_H))),
        stamp(),
      ])),
      change('Col', 1),
    ])),
    change('R', 1),
  ])),
]);

// print: append text to Screen, wrapping at COLS, keeping only the last ROWS lines
print.define([
  ifElse(eq(len(arg('text')), 0), addTo('Screen', T('')), chain([
    set('chunk', T('')), set('PI', 1),
    repeat(len(arg('text')), chain([
      set('chunk', join(v('chunk'), letterOf(v('PI'), arg('text')))), change('PI', 1),
      if_(eq(len(v('chunk')), COLS), chain([addTo('Screen', v('chunk')), set('chunk', T(''))])),
    ])),
    if_(gt(len(v('chunk')), 0), addTo('Screen', v('chunk'))),
  ])),
  repeatUntil(not(gt(lenList('Screen'), ROWS)), delAt('Screen', 1)),
]);

// split: Tok = first word of text, Rest = everything after it
const ws = () => eq(letterOf(v('SI'), arg('text')), T(' '));
split.define([
  set('Tok', T('')), set('SI', 1),
  repeatUntil(or(gt(v('SI'), len(arg('text'))), not(ws())), change('SI', 1)),
  repeatUntil(or(gt(v('SI'), len(arg('text'))), ws()), chain([set('Tok', join(v('Tok'), letterOf(v('SI'), arg('text')))), change('SI', 1)])),
  repeatUntil(or(gt(v('SI'), len(arg('text'))), not(ws())), change('SI', 1)),
  set('Rest', T('')),
  repeatUntil(gt(v('SI'), len(arg('text'))), chain([set('Rest', join(v('Rest'), letterOf(v('SI'), arg('text')))), change('SI', 1)])),
]);

// tail: Tail = text from position `from` to the end. head: Head = first `count` chars.
tail.define([
  set('Tail', T('')), set('TJ', arg('from')),
  repeatUntil(gt(v('TJ'), len(arg('text'))), chain([set('Tail', join(v('Tail'), letterOf(v('TJ'), arg('text')))), change('TJ', 1)])),
]);
head.define([
  set('Head', T('')), set('HJ', 1),
  repeatUntil(or(gt(v('HJ'), arg('count')), gt(v('HJ'), len(arg('text')))), chain([set('Head', join(v('Head'), letterOf(v('HJ'), arg('text')))), change('HJ', 1)])),
]);

// lpad: PadRes = text left-padded with spaces to `width`
lpad.define([
  set('PadRes', arg('text')),
  repeatUntil(not(lt(len(v('PadRes')), arg('width'))), set('PadRes', join(T(' '), v('PadRes')))),
]);

// expand: Exp = text with surrounding quotes removed and $name / $PWD / $HOME substituted
expand.define([
  set('Src', arg('text')),
  if_(and(gt(len(v('Src')), 1), or(eq(letterOf(1, v('Src')), T('"')), eq(letterOf(1, v('Src')), T("'")))),
    if_(eq(letterOf(len(v('Src')), v('Src')), letterOf(1, v('Src'))), chain([
      set('Tmp', T('')), set('EI', 2),
      repeatUntil(gt(v('EI'), sub(len(v('Src')), 1)), chain([set('Tmp', join(v('Tmp'), letterOf(v('EI'), v('Src')))), change('EI', 1)])),
      set('Src', v('Tmp')),
    ]))),
  set('Exp', T('')), set('EI', 1),
  repeatUntil(gt(v('EI'), len(v('Src'))), chain([
    set('c2', letterOf(v('EI'), v('Src'))),
    ifElse(eq(v('c2'), T('$')), chain([
      set('VN', T('')), change('EI', 1),
      repeatUntil(or(gt(v('EI'), len(v('Src'))), not(contains(T(ALLOWED), letterOf(v('EI'), v('Src'))))),
        chain([set('VN', join(v('VN'), letterOf(v('EI'), v('Src')))), change('EI', 1)])),
      ifElse(eq(len(v('VN')), 0), set('Exp', join(v('Exp'), T('$'))), chain([
        set('VI', itemNum('VarNames', v('VN'))),
        if_(gt(v('VI'), 0), set('Exp', join(v('Exp'), itemOf('VarVals', v('VI'))))),
        if_(eq(v('VN'), T('PWD')), set('Exp', join(v('Exp'), v('cwd')))),
        if_(eq(v('VN'), T('HOME')), set('Exp', join(v('Exp'), v('HOME')))),
      ])),
    ]), chain([set('Exp', join(v('Exp'), v('c2'))), change('EI', 1)])),
  ])),
]);

// resolve: Full / Parent / Name = absolute, normalised version of a path (handles ., .., ~, / and relative paths)
resolve.define([
  delAll('Seg'), set('P0', arg('path')),
  if_(eq(len(v('P0')), 0), set('P0', v('cwd'))),
  if_(eq(v('P0'), T('~')), set('P0', v('HOME'))),
  if_(and(eq(letterOf(1, v('P0')), T('~')), or(eq(letterOf(2, v('P0')), T('\\')), eq(letterOf(2, v('P0')), T('/')))),
    chain([tail.call(v('P0'), 2), set('P0', join(v('HOME'), v('Tail')))])),
  if_(not(eq(letterOf(2, v('P0')), T(':'))),
    ifElse(or(eq(letterOf(1, v('P0')), T('\\')), eq(letterOf(1, v('P0')), T('/'))),
      set('P0', join(T('C:'), v('P0'))),
      set('P0', J(v('cwd'), T('\\'), v('P0'))))),
  set('P0', join(v('P0'), T('\\'))), set('sb', T('')), set('PJ', 1),
  repeatUntil(gt(v('PJ'), len(v('P0'))), chain([
    set('chr', letterOf(v('PJ'), v('P0'))),
    ifElse(or(eq(v('chr'), T('\\')), eq(v('chr'), T('/'))), chain([
      if_(gt(len(v('sb')), 0), ifElse(eq(v('sb'), T('..')),
        if_(gt(lenList('Seg'), 1), delAt('Seg', lenList('Seg'))),
        if_(not(eq(v('sb'), T('.'))), addTo('Seg', v('sb'))))),
      set('sb', T('')),
    ]), set('sb', join(v('sb'), v('chr')))),
    change('PJ', 1),
  ])),
  set('Acc', T('')), set('Parent', T('')), set('k', 1),
  repeat(lenList('Seg'), chain([
    if_(eq(v('k'), lenList('Seg')), chain([set('Parent', v('Acc')), if_(eq(len(v('Parent')), 2), set('Parent', join(v('Parent'), T('\\'))))])),
    ifElse(eq(v('k'), 1), set('Acc', itemOf('Seg', 1)), set('Acc', J(v('Acc'), T('\\'), itemOf('Seg', v('k'))))),
    change('k', 1),
  ])),
  set('Name', itemOf('Seg', lenList('Seg'))), set('Full', v('Acc')),
  if_(eq(len(v('Full')), 2), set('Full', join(v('Full'), T('\\')))),
]);

mkentry.define([
  addTo('FSPath', arg('path')), addTo('FSParent', arg('parent')), addTo('FSName', arg('name')), addTo('FSType', arg('type')), addTo('FSData', arg('data')),
]);

// makeitem: create a file/dir at `path` (after resolve) with the usual PowerShell-style errors
makeitem.define([
  resolve.call(arg('path')),
  ifElse(gt(itemNum('FSPath', v('Full')), 0),
    print.call(J(T("New-Item: An item with the specified name '"), v('Full'), T("' already exists."))),
    chain([
      set('PIdx', itemNum('FSPath', v('Parent'))),
      ifElse(and(gt(v('PIdx'), 0), eq(itemOf('FSType', v('PIdx')), T('d'))),
        mkentry.call(v('Full'), v('Parent'), v('Name'), arg('type'), T('')),
        print.call(J(T("New-Item: Could not find a part of the path '"), v('Full'), T("'.")))),
    ])),
]);

// writefile: Set-Content / Add-Content / redirection target
writefile.define([
  resolve.call(arg('path')),
  set('PIdx', itemNum('FSPath', v('Parent'))),
  ifElse(not(and(gt(v('PIdx'), 0), eq(itemOf('FSType', v('PIdx')), T('d')))),
    print.call(J(T("Set-Content: Could not find a part of the path '"), v('Full'), T("'."))),
    chain([
      set('Idx', itemNum('FSPath', v('Full'))),
      ifElse(eq(v('Idx'), 0), mkentry.call(v('Full'), v('Parent'), v('Name'), T('f'), arg('text')),
        ifElse(eq(itemOf('FSType', v('Idx')), T('d')),
          print.call(J(T("Set-Content: Access to the path '"), v('Full'), T("' is denied."))),
          ifElse(and(eq(arg('append'), 1), gt(len(itemOf('FSData', v('Idx'))), 0)),
            replaceAt('FSData', v('Idx'), J(itemOf('FSData', v('Idx')), T(SEP), arg('text'))),
            replaceAt('FSData', v('Idx'), arg('text'))))),
    ])),
]);

printlines.define([
  set('PL', T('')), set('QI', 1),
  repeat(len(arg('text')), chain([
    set('c2', letterOf(v('QI'), arg('text'))),
    ifElse(eq(v('c2'), T(SEP)), chain([print.call(v('PL')), set('PL', T(''))]), set('PL', join(v('PL'), v('c2')))),
    change('QI', 1),
  ])),
  if_(gt(len(arg('text')), 0), print.call(v('PL'))),
]);

// sweep: delete entries whose parent no longer exists (after removing a folder)
const del5 = i => [delAt('FSPath', i()), delAt('FSParent', i()), delAt('FSName', i()), delAt('FSType', i()), delAt('FSData', i())];
sweep.define([
  set('Swept', 1),
  repeatUntil(eq(v('Swept'), 0), chain([
    set('Swept', 0), set('OI', lenList('FSPath')),
    repeat(lenList('FSPath'), chain([
      if_(and(gt(len(itemOf('FSParent', v('OI'))), 0), eq(itemNum('FSPath', itemOf('FSParent', v('OI'))), 0)),
        chain([...del5(() => v('OI')), set('Swept', 1)])),
      change('OI', -1),
    ])),
  ])),
]);

// skipflags: Tok = first word of text that doesn't start with "-"
skipflags.define([
  split.call(arg('text')),
  repeatUntil(not(eq(letterOf(1, v('Tok')), T('-'))), split.call(v('Rest'))),
]);

// ---------- main script ----------
const P = s => print.call(T(s));
const on = (names, body) => if_(and(eq(v('Done'), 0), names.map(n => eq(v('Cmd'), T(n))).reduce((a, c) => or(a, c))), chain([...body, set('Done', 1)]));
const notFound = (cmd, what) => print.call(J(T(`${cmd}: Cannot find path '`), v('Full'), T(what)));
const resolveArg = (expandFrom) => [expand.call(expandFrom), resolve.call(v('Exp')), set('Idx', itemNum('FSPath', v('Full')))];

const branches = [
  on(['help', 'Get-Help', 'man'], [
    P('Commands (aliases in brackets):'), P('  Get-ChildItem [ls dir gci] [path]'), P('  Set-Location [cd sl] <path>   Get-Location [pwd]'),
    P('  New-Item [ni] <name> [-ItemType Directory]'), P('  mkdir [md] <name>   Remove-Item [rm del ri] <path>'),
    P('  Get-Content [cat type gc] <file>'), P('  Set-Content [sc] / Add-Content [ac] <file> <text>'),
    P('  Write-Host [echo] <text> [> file] [>> file]'), P('  $name = value   then use $name (also $PWD, $HOME)'),
    P('  Get-Date   whoami   hostname   Clear-Host [cls]   exit'),
  ]),
  on(['cls', 'clear', 'Clear-Host'], [delAll('Screen')]),
  on(['echo', 'Write-Host', 'Write-Output'], [
    set('RP', 1),
    repeatUntil(or(gt(v('RP'), len(v('Args'))), eq(letterOf(v('RP'), v('Args')), T('>'))), change('RP', 1)),
    ifElse(gt(v('RP'), len(v('Args'))),
      chain([expand.call(v('Args')), print.call(v('Exp'))]),
      chain([                                                    // redirect: text > file / text >> file
        head.call(v('Args'), sub(v('RP'), 1)),
        repeatUntil(or(eq(len(v('Head')), 0), not(eq(letterOf(len(v('Head')), v('Head')), T(' ')))), head.call(v('Head'), sub(len(v('Head')), 1))),
        expand.call(v('Head')), set('ExpText', v('Exp')),
        set('App', 0), set('FromI', add(v('RP'), 1)),
        if_(eq(letterOf(add(v('RP'), 1), v('Args')), T('>')), chain([set('App', 1), set('FromI', add(v('RP'), 2))])),
        tail.call(v('Args'), v('FromI')), split.call(v('Tail')),
        writefile.call(v('Tok'), v('ExpText'), v('App')),
      ])),
  ]),
  on(['pwd', 'Get-Location', 'gl'], [P(''), P('Path'), P('----'), print.call(v('cwd')), P('')]),
  on(['cd', 'sl', 'Set-Location', 'chdir'], [
    if_(gt(len(v('Args')), 0), chain([
      ...resolveArg(v('Args')),
      ifElse(and(gt(v('Idx'), 0), eq(itemOf('FSType', v('Idx')), T('d'))), set('cwd', v('Full')),
        notFound('Set-Location', "' because it does not exist.")),
    ])),
  ]),
  on(['ls', 'dir', 'gci', 'Get-ChildItem'], [
    skipflags.call(v('Args')), ...resolveArg(v('Tok')),
    ifElse(and(gt(v('Idx'), 0), eq(itemOf('FSType', v('Idx')), T('d'))), chain([
      P(''), print.call(join(T('    Directory: '), v('Full'))), P(''), P('Mode    Length Name'), P('----    ------ ----'), set('LI', 1),
      repeat(lenList('FSPath'), chain([
        if_(eq(itemOf('FSParent', v('LI')), v('Full')), ifElse(eq(itemOf('FSType', v('LI')), T('d')),
          print.call(join(T('d----' + ' '.repeat(10)), itemOf('FSName', v('LI')))),
          chain([lpad.call(len(itemOf('FSData', v('LI'))), 6), print.call(J(T('-a---   '), v('PadRes'), T(' '), itemOf('FSName', v('LI'))))]))),
        change('LI', 1),
      ])),
      P(''),
    ]), notFound('Get-ChildItem', "' because it does not exist.")),
  ]),
  on(['mkdir', 'md'], [expand.call(v('Args')), makeitem.call(v('Exp'), T('d'))]),
  on(['New-Item', 'ni'], [
    split.call(v('Args')), set('FileArg', v('Tok')), set('NT', T('f')),
    if_(contains(v('Rest'), T('Directory')), set('NT', T('d'))),
    expand.call(v('FileArg')), makeitem.call(v('Exp'), v('NT')),
  ]),
  on(['rm', 'del', 'ri', 'Remove-Item', 'rmdir', 'rd', 'erase'], [
    skipflags.call(v('Args')), ...resolveArg(v('Tok')),
    ifElse(eq(v('Idx'), 0), notFound('Remove-Item', "' because it does not exist."),
      ifElse(eq(len(v('Parent')), 0), print.call(T("Remove-Item: Access to the path 'C:\\' is denied.")),
        chain([...del5(() => v('Idx')), sweep.call(), if_(eq(itemNum('FSPath', v('cwd')), 0), set('cwd', v('Parent')))]))),
  ]),
  on(['cat', 'type', 'gc', 'Get-Content'], [
    skipflags.call(v('Args')), ...resolveArg(v('Tok')),
    ifElse(eq(v('Idx'), 0), notFound('Get-Content', "' because it does not exist."),
      ifElse(eq(itemOf('FSType', v('Idx')), T('d')), print.call(J(T("Get-Content: Access to the path '"), v('Full'), T("' is denied."))),
        printlines.call(itemOf('FSData', v('Idx'))))),
  ]),
  on(['Set-Content', 'sc', 'Add-Content', 'ac'], [
    set('App', 0), if_(or(eq(v('Cmd'), T('Add-Content')), eq(v('Cmd'), T('ac'))), set('App', 1)),
    split.call(v('Args')), set('FileArg', v('Tok')), expand.call(v('Rest')), writefile.call(v('FileArg'), v('Exp'), v('App')),
  ]),
  on(['Get-Date', 'date'], [
    set('mm', current('MINUTE')), if_(lt(v('mm'), 10), set('mm', join(T('0'), v('mm')))),
    set('ss', current('SECOND')), if_(lt(v('ss'), 10), set('ss', join(T('0'), v('ss')))),
    print.call(J(current('MONTH'), T('/'), current('DATE'), T('/'), current('YEAR'), T('  '), current('HOUR'), T(':'), v('mm'), T(':'), v('ss'))),
  ]),
  on(['whoami'], [P('desktop-sim\\user')]),
  on(['hostname'], [P('DESKTOP-SIM')]),
  on(['exit', 'quit'], [P('[Process completed]'), stopAll()]),
];

// "$x = 5" assigns, "$x" prints
const dollar = if_(and(eq(v('Done'), 0), eq(letterOf(1, v('Cmd')), T('$'))), chain([
  set('AN', T('')), set('AI', 2),
  repeatUntil(or(gt(v('AI'), len(v('Input'))), not(contains(T(ALLOWED), letterOf(v('AI'), v('Input'))))), chain([set('AN', join(v('AN'), letterOf(v('AI'), v('Input')))), change('AI', 1)])),
  repeatUntil(or(gt(v('AI'), len(v('Input'))), not(eq(letterOf(v('AI'), v('Input')), T(' ')))), change('AI', 1)),
  ifElse(and(not(gt(v('AI'), len(v('Input')))), eq(letterOf(v('AI'), v('Input')), T('='))), chain([
    change('AI', 1),
    repeatUntil(or(gt(v('AI'), len(v('Input'))), not(eq(letterOf(v('AI'), v('Input')), T(' ')))), change('AI', 1)),
    tail.call(v('Input'), v('AI')), expand.call(v('Tail')),
    set('FromI', itemNum('VarNames', v('AN'))),
    ifElse(eq(v('FromI'), 0), chain([addTo('VarNames', v('AN')), addTo('VarVals', v('Exp'))]), replaceAt('VarVals', v('FromI'), v('Exp'))),
  ]), chain([expand.call(v('Input')), print.call(v('Exp'))])),
  set('Done', 1),
]));

const unknown = if_(eq(v('Done'), 0), chain([
  print.call(J(v('Cmd'), T(": The term '"), v('Cmd'), T("' is not recognized as a name of a cmdlet, function, script file, or executable program."))),
  P('Check the spelling of the name, or if a path was included, verify that the path is correct and try again.'),
]));

const seed = (p, parent, name, type, data = '') => mkentry.call(T(p), T(parent), T(name), T(type), T(data));
const HOME = 'C:\\Users\\user';
script([
  flag(), hide(), ...LISTS.map(delAll), set('cwd', T(HOME)), set('HOME', T(HOME)),
  seed('C:\\', '', 'C:', 'd'), seed('C:\\Users', 'C:\\', 'Users', 'd'), seed(HOME, 'C:\\Users', 'user', 'd'),
  seed(`${HOME}\\Documents`, HOME, 'Documents', 'd'), seed(`${HOME}\\Desktop`, HOME, 'Desktop', 'd'), seed(`${HOME}\\Downloads`, HOME, 'Downloads', 'd'),
  seed(`${HOME}\\readme.txt`, HOME, 'readme.txt', 'f', `Welcome to PowerShell in Scratch!${SEP}Try: ls, mkdir demo, cd demo, echo hi > a.txt, cat a.txt${SEP}Type help for the command list.`),
  P('PowerShell 7.5.0'), P('Emulated in Scratch (TurboWarp). Type help.'), P(''),
  forever(chain([
    redraw.call(),
    ask(J(T('PS '), v('cwd'), T('> '))),
    set('Input', answer()),
    print.call(J(T('PS '), v('cwd'), T('> '), v('Input'))),
    if_(gt(len(v('Input')), 0), chain([
      set('Done', 0), split.call(v('Input')), set('Cmd', v('Tok')), set('Args', v('Rest')),
      dollar, ...branches, unknown,
    ])),
  ])),
]);

// ---------- assemble in TurboWarp ----------
const backdrop = path.join(tmp, 'blank-blue.svg');
writeFileSync(backdrop, `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><rect width="480" height="360" fill="#012456"/></svg>`);
const blank = path.join(tmp, 'cell.svg');
writeFileSync(blank, `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL_W}" height="${CELL_H}" viewBox="0 0 ${CELL_W} ${CELL_H}"></svg>`);
const blocksFile = path.join(tmp, 'Terminal.json');
writeFileSync(blocksFile, JSON.stringify(F.b));

console.log(tw('new'));
console.log(tw('eval', `(async()=>{await vm.extensionManager.loadExtensionURL('pen');
  const st=vm.runtime.getTargetForStage();
  for(const n of ${JSON.stringify(VARS)}) st.createVariable('var_'+n,n,'');
  for(const n of ${JSON.stringify(LISTS)}) st.createVariable('list_'+n,n,'list');
  return 'pen + variables + lists ok'})()`));
console.log(tw('backdrop', backdrop));
console.log(tw('sprite', 'Terminal', blank));
const glyphJson = JSON.stringify(glyphs.map(g => ({ ch: g.ch, svg: g.svg, md5: g.md5 })));
console.log(tw('eval', `(async()=>{const G=${glyphJson}; const st=vm.runtime.storage;
  const t=vm.runtime.targets.find(t=>t.isOriginal&&t.getName()==='Terminal');
  for(const g of G){ st.cache(st.AssetType.ImageVector, st.DataFormat.SVG, new TextEncoder().encode(g.svg), g.md5);
    await vm.addCostume(g.md5+'.svg',{name:'g'+g.ch,dataFormat:'svg',assetId:g.md5,md5ext:g.md5+'.svg',bitmapResolution:1,rotationCenterX:${CELL_W / 2},rotationCenterY:${CELL_H / 2}}, t.id); }
  t.setXY(0,0); return t.getCostumes().length+' costumes'})()`));
console.log(tw('select', 'Stage'));      // keep the editor off the sprite while blocks are added, so its workspace can't mangle them
console.log(tw('blocks', 'Terminal', blocksFile));
// the editor can leave stray empty lists behind while it loads the workspace; drop anything we didn't declare
console.log(tw('eval', `(async()=>{await new Promise(r=>setTimeout(r,2500)); const st=vm.runtime.getTargetForStage();
  const keep=new Set(${JSON.stringify([...VARS, ...LISTS])}); let n=0;
  for(const [id,x] of Object.entries(st.variables)) if(!keep.has(x.name)){ delete st.variables[id]; n++; }
  vm.emitWorkspaceUpdate(); return 'removed '+n+' stray variables'})()`));
console.log(tw('export', OUT));
console.log(tw('select', 'Terminal'));
