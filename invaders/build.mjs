#!/usr/bin/env node
// Builds a simple Space Invaders game in the running TurboWarpRemote.app via twctl,
// then exports space-invaders.sb3 next to this file.
//   open -n ../turbowarp-remote/TurboWarpRemote.app && node build.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const TW = path.join(here, '../turbowarp-remote/twctl.mjs');
const OUT = path.join(here, 'space-invaders.sb3');
const tmp = path.join(here, '.build'); mkdirSync(tmp, { recursive: true });
const tw = (...a) => execFileSync('node', [TW, ...a], { encoding: 'utf8' }).trim();
const asset = f => path.join(here, 'assets', f);

const VARS = ['Score', 'Direction', 'Edge', 'Over', 'Alive', 'bulletActive', 'Row', 'Col', 'Spawned', 'PlayerX', 'Ended'];
const MSGS = ['move', 'drop', 'win', 'gameover'];
const vid = n => `var_${n}`, mid = n => `msg_${n}`;
// broadcast fields must declare variableType, or the VM prunes the message as unused
const bf = m => ({ name: 'BROADCAST_OPTION', value: m, id: mid(m), variableType: 'broadcast_msg' });

// ---------- tiny block DSL (project.json-style blocks) ----------
function sprite() {
  const b = {}; let n = 0;
  const N = x => ({ lit: [4, String(x)] }), T = x => ({ lit: [10, String(x)] }), C = id => ({ cond: id });
  const val = x => typeof x === 'number' ? N(x) : x;       // number literal | reporter block id | wrapped
  const mk = (opcode, { inputs = {}, fields = {}, shadow = false, mutation } = {}) => {
    const id = `${opcode}_${++n}`;
    const blk = { opcode, next: null, parent: null, inputs: {}, fields, shadow, topLevel: false };
    if (mutation) blk.mutation = mutation;
    for (const [k, v] of Object.entries(inputs)) {
      if (v.lit) blk.inputs[k] = [1, v.lit];
      else if (v.cond) { blk.inputs[k] = [2, v.cond]; b[v.cond].parent = id; }
      else if (v.menu) { blk.inputs[k] = [1, v.menu]; b[v.menu].parent = id; }
      else { blk.inputs[k] = [3, v, [4, '0']]; b[v].parent = id; }
    }
    b[id] = blk; return id;
  };
  const menu = (opcode, fields) => ({ menu: mk(opcode, { shadow: true, fields }) });
  const chain = ids => { ids.forEach((id, i) => { if (i) { b[ids[i - 1]].next = id; b[id].parent = ids[i - 1]; } }); return ids[0]; };
  const script = (ids, x = 20, y = 20) => { const f = chain(ids); Object.assign(b[f], { topLevel: true, x, y }); };
  const bin = (op, k1, k2) => (a, c) => mk(op, { inputs: { [k1]: val(a), [k2]: val(c) } });
  const boolBin = op => (a, c) => mk(op, { inputs: { OPERAND1: C(a), OPERAND2: C(c) } });
  const F = {
    b, N, T, C, chain, script, mk,
    // events / control
    flag: () => mk('event_whenflagclicked'),
    onMsg: m => mk('event_whenbroadcastreceived', { fields: { BROADCAST_OPTION: bf(m) } }),
    startAsClone: () => mk('control_start_as_clone'),
    broadcast: m => mk('event_broadcast', { inputs: { BROADCAST_INPUT: menu('event_broadcast_menu', { BROADCAST_OPTION: bf(m) }) } }),
    broadcastWait: m => mk('event_broadcastandwait', { inputs: { BROADCAST_INPUT: menu('event_broadcast_menu', { BROADCAST_OPTION: bf(m) }) } }),
    forever: sub => mk('control_forever', { inputs: { SUBSTACK: C(sub) } }),
    if_: (cond, sub) => mk('control_if', { inputs: { CONDITION: C(cond), SUBSTACK: C(sub) } }),
    repeat: (t, sub) => mk('control_repeat', { inputs: { TIMES: N(t), SUBSTACK: C(sub) } }),
    repeatUntil: (cond, sub) => mk('control_repeat_until', { inputs: { CONDITION: C(cond), SUBSTACK: C(sub) } }),
    waitUntil: cond => mk('control_wait_until', { inputs: { CONDITION: C(cond) } }),
    wait: s => mk('control_wait', { inputs: { DURATION: val(s) } }),
    cloneSelf: () => mk('control_create_clone_of', { inputs: { CLONE_OPTION: menu('control_create_clone_of_menu', { CLONE_OPTION: ['_myself_'] }) } }),
    deleteClone: () => mk('control_delete_this_clone'),
    stopAll: () => mk('control_stop', { fields: { STOP_OPTION: ['all'] }, mutation: { tagName: 'mutation', children: [], hasnext: 'false' } }),
    // looks / motion
    show: () => mk('looks_show'), hide: () => mk('looks_hide'),
    say: t => mk('looks_say', { inputs: { MESSAGE: T(t) } }),
    gotoXY: (x, y) => mk('motion_gotoxy', { inputs: { X: val(x), Y: val(y) } }),
    changeX: d => mk('motion_changexby', { inputs: { DX: val(d) } }),
    changeY: d => mk('motion_changeyby', { inputs: { DY: val(d) } }),
    xpos: () => mk('motion_xposition'), ypos: () => mk('motion_yposition'),
    // sensing
    key: k => mk('sensing_keypressed', { inputs: { KEY_OPTION: menu('sensing_keyoptions', { KEY_OPTION: [k] }) } }),
    touching: name => mk('sensing_touchingobject', { inputs: { TOUCHINGOBJECTMENU: menu('sensing_touchingobjectmenu', { TOUCHINGOBJECTMENU: [name] }) } }),
    // data
    set: (name, v) => mk('data_setvariableto', { inputs: { VALUE: typeof v === 'number' ? T(v) : v }, fields: { VARIABLE: [name, vid(name)] } }),
    change: (name, v) => mk('data_changevariableby', { inputs: { VALUE: val(v) }, fields: { VARIABLE: [name, vid(name)] } }),
    v: name => mk('data_variable', { fields: { VARIABLE: [name, vid(name)] } }),
    // operators
    add: bin('operator_add', 'NUM1', 'NUM2'), sub: bin('operator_subtract', 'NUM1', 'NUM2'), mul: bin('operator_multiply', 'NUM1', 'NUM2'),
    eq: bin('operator_equals', 'OPERAND1', 'OPERAND2'), gt: bin('operator_gt', 'OPERAND1', 'OPERAND2'), lt: bin('operator_lt', 'OPERAND1', 'OPERAND2'),
    and: boolBin('operator_and'), or: boolBin('operator_or'),
  };
  return F;
}

// ---------- the game ----------
// Player: arrow keys move, ship tracks into PlayerX for the bullet.
const P = sprite(); {
  const { flag, gotoXY, wait, repeatUntil, eq, v, if_, and, key, gt, lt, xpos, changeX, set, touching, chain, script, onMsg, say } = P;
  script([flag(), gotoXY(0, -150), wait(0.2), repeatUntil(eq(v('Ended'), 1), chain([
    if_(and(key('left arrow'), gt(xpos(), -210)), changeX(-6)),
    if_(and(key('right arrow'), lt(xpos(), 210)), changeX(6)),
    set('PlayerX', xpos()),
    if_(touching('Invader'), set('Over', 1)),
  ]))]);
  script([onMsg('gameover'), say('GAME OVER'), set('Ended', 1)], 700, 20);
  script([onMsg('win'), say('YOU WIN!'), set('Ended', 1)], 700, 200);
}

// Bullet: one at a time; hidden when idle. An invader hit resets bulletActive to 0.
const Bu = sprite(); {
  const { flag, hide, show, wait, forever, if_, and, key, eq, v, set, gotoXY, repeatUntil, or, gt, ypos, changeY, chain, script } = Bu;
  script([flag(), hide(), wait(0.2), forever(chain([
    if_(and(and(key('space'), eq(v('bulletActive'), 0)), eq(v('Ended'), 0)), chain([
      set('bulletActive', 1), gotoXY(v('PlayerX'), -125), show(),
      repeatUntil(or(gt(ypos(), 170), eq(v('bulletActive'), 0)), changeY(12)),
      hide(), set('bulletActive', 0),
    ])),
  ]))]);
}

// Invader: the hidden original spawns a 4x8 grid of clones, then paces the group.
const I = sprite(); {
  const { flag, hide, show, set, change, repeat, gotoXY, add, sub, mul, v, cloneSelf, waitUntil, or, and, eq, gt, lt, if_, broadcast,
    broadcastWait, forever, repeatUntil, wait, startAsClone, touching, deleteClone, ypos, xpos, changeX, changeY, onMsg, chain, script } = I;
  // spawn + win/lose
  script([flag(), hide(), set('Score', 0), set('Direction', 1), set('Edge', 0), set('Over', 0), set('Ended', 0), set('Alive', 32),
    set('bulletActive', 0), set('Row', 0), set('Spawned', 0),
    repeat(4, chain([
      set('Col', 0),
      repeat(8, chain([gotoXY(add(-140, mul(v('Col'), 40)), sub(140, mul(v('Row'), 30))), cloneSelf(), change('Col', 1)])),
      change('Row', 1),
    ])),
    set('Spawned', 1),
    waitUntil(or(eq(v('Alive'), 0), eq(v('Over'), 1))),
    if_(eq(v('Over'), 1), broadcast('gameover')),
    if_(eq(v('Alive'), 0), broadcast('win')),
  ], 20, 20);
  // march: step sideways, bounce + drop at the edge; faster as invaders die
  script([flag(), waitUntil(eq(v('Spawned'), 1)), repeatUntil(eq(v('Ended'), 1), chain([
    broadcastWait('move'),
    if_(eq(v('Edge'), 1), chain([set('Direction', sub(0, v('Direction'))), set('Edge', 0), broadcastWait('drop')])),
    wait(add(0.03, mul(v('Alive'), 0.006))),
  ]))], 700, 20);
  // clones
  script([startAsClone(), set('IsClone', 1), show(), forever(chain([
    if_(and(touching('Bullet'), eq(v('bulletActive'), 1)), chain([
      change('Score', 1), change('Alive', -1), set('bulletActive', 0), deleteClone()])),
    if_(lt(ypos(), -120), set('Over', 1)),
  ]))], 700, 450);
  script([onMsg('move'), if_(eq(v('IsClone'), 1), chain([
    changeX(mul(v('Direction'), 8)), if_(or(gt(xpos(), 215), lt(xpos(), -215)), set('Edge', 1))]))], 1200, 20);
  script([onMsg('drop'), if_(eq(v('IsClone'), 1), changeY(-20))], 1200, 350);
}

// ---------- assemble in TurboWarp ----------
const dump = (name, s) => { const f = path.join(tmp, `${name}.json`); writeFileSync(f, JSON.stringify(s.b)); return f; };

console.log(tw('new'));
console.log(tw('eval', `(()=>{const st=vm.runtime.getTargetForStage();
  for(const n of ${JSON.stringify(VARS)}) st.createVariable('var_'+n,n,'');
  for(const m of ${JSON.stringify(MSGS)}) st.createVariable('msg_'+m,m,'broadcast_msg'); return 'vars+messages ok'})()`));
console.log(tw('backdrop', asset('space.svg')));
console.log(tw('sprite', 'Player', asset('player.svg')));
console.log(tw('sprite', 'Bullet', asset('bullet.svg')));
console.log(tw('sprite', 'Invader', asset('invader.svg')));
console.log(tw('eval', `(()=>{const t=vm.runtime.targets.find(t=>t.isOriginal&&t.getName()==='Invader'); t.createVariable('var_IsClone','IsClone',''); return 'local var ok'})()`));
console.log(tw('eval', `(()=>{const t=vm.runtime.targets.find(t=>t.isOriginal&&t.getName()==='Player'); t.setXY(0,-150); return 1})()`));
console.log(tw('blocks', 'Player', dump('Player', P)));
console.log(tw('blocks', 'Bullet', dump('Bullet', Bu)));
console.log(tw('blocks', 'Invader', dump('Invader', I)));
// show the score on stage
console.log(tw('eval', `(()=>{vm.runtime.monitorBlocks.changeBlock({id:'var_Score',element:'checkbox',value:true}, vm.runtime); return 'score monitor'})()`));
console.log(tw('select', 'Player'));
console.log(tw('export', OUT));
