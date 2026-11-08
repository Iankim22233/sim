#!/usr/bin/env node
// twctl: remote-control a TurboWarp Desktop instance started via TurboWarpRemote.app.
// Talks to the editor page over the Chrome DevTools Protocol and drives window.vm.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const PORT = process.env.TW_REMOTE_PORT || '9333';
const [cmd, ...args] = process.argv.slice(2);

async function connect() {
  let pages;
  try { pages = await (await fetch(`http://localhost:${PORT}/json`)).json(); }
  catch { fail(`Can't reach port ${PORT}. Start it with: open -n TurboWarpRemote.app`); }
  const page = pages.find(p => p.type === 'page' && p.url.includes('gui.html'));
  if (!page) fail('Editor window not found (is a project window open?)');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('ws failed')); });
  let id = 0; const pending = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise(ok => {
    const i = ++id; pending.set(i, ok); ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { send, close: () => ws.close() };
}


// Convert project.json-style blocks (compact inputs like [1,[4,"50"]]) into the VM's in-memory
// format (explicit shadow blocks), which is what vm.shareBlocksToTarget expects.
function toVmBlocks(data) {
  const entries = Array.isArray(data) ? data.map(b => [b.id, b]) : Object.entries(data);
  const out = [];
  const PRIM = { 4: ['math_number', 'NUM'], 5: ['math_positive_number', 'NUM'], 6: ['math_whole_number', 'NUM'],
    7: ['math_integer', 'NUM'], 8: ['math_angle', 'ANGLE'], 9: ['colour_picker', 'COLOUR'], 10: ['text', 'TEXT'] };
  for (const [id, b] of entries) {
    const inputs = {};
    for (const [name, v] of Object.entries(b.inputs || {})) {
      if (!Array.isArray(v)) { inputs[name] = v; continue; }       // already VM format
      const [kind, main, shadow] = v;
      const mk = (prim) => {                                         // primitive -> shadow block
        const [op, field] = PRIM[prim[0]] || PRIM[10];
        const sid = `${id}_${name}_s`;
        out.push({ id: sid, opcode: op, inputs: {}, fields: { [field]: { name: field, value: String(prim[1]) } }, next: null, parent: id, shadow: true, topLevel: false });
        return sid;
      };
      if (Array.isArray(main)) { const sid = mk(main); inputs[name] = { name, block: sid, shadow: sid }; }
      else {                                                         // block reference (+ optional shadow)
        let sh = null; if (Array.isArray(shadow)) sh = mk(shadow); else if (typeof shadow === 'string') sh = shadow;
        inputs[name] = { name, block: main, shadow: kind === 1 ? main : sh };
      }
    }
    const fields = {};
    for (const [name, v] of Object.entries(b.fields || {})) fields[name] = Array.isArray(v) ? { name, value: v[0], ...(v[1] ? { id: v[1] } : {}) } : v;
    out.push({ ...b, id, inputs, fields });
  }
  return out;
}

// Orange gradient border + label drawn over the editor so it's obvious when Claude has the wheel.
const overlayJs = (text) => `(()=>{
  document.getElementById('claude-overlay')?.remove();
  const text = ${JSON.stringify(text)};
  if (text === null) return 'overlay off';
  const root = document.createElement('div'); root.id = 'claude-overlay';
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  root.innerHTML = '<style>' +
    '@keyframes claudeFlow{0%{background-position:0% 50%}100%{background-position:300% 50%}}' +
    '@keyframes claudePulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.7)}}' +
    '#claude-overlay .b{position:absolute;inset:0;border:5px solid transparent;border-radius:6px;' +
      'background:linear-gradient(90deg,#ff7a18,#ffb347,#ff5e00,#ffc53d,#ff7a18) border-box;background-size:300% 100%;' +
      'animation:claudeFlow 5s linear infinite;' +
      '-webkit-mask:linear-gradient(#000 0 0) padding-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;' +
      'box-shadow:inset 0 0 24px rgba(255,122,24,.45)}' +
    '#claude-overlay .l{position:absolute;top:0;left:50%;transform:translateX(-50%);padding:5px 16px 6px;border-radius:0 0 12px 12px;' +
      'background:linear-gradient(90deg,#ff7a18,#ffb347,#ff5e00);background-size:200% 100%;animation:claudeFlow 4s linear infinite;' +
      'color:#fff;font:600 13px/1.2 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;letter-spacing:.02em;' +
      'display:flex;align-items:center;gap:8px;box-shadow:0 2px 10px rgba(255,94,0,.5);text-shadow:0 1px 2px rgba(0,0,0,.25)}' +
    '#claude-overlay .d{width:8px;height:8px;border-radius:50%;background:#fff;animation:claudePulse 1.2s ease-in-out infinite}' +
    '</style><div class="b"></div><div class="l"><span class="d"></span><span class="t"></span></div>';
  root.querySelector('.t').textContent = text;
  document.body.appendChild(root);
  return 'overlay on';
})()`;

function fail(msg) { console.error(msg); process.exit(1); }

async function evaluate(c, expression) {
  const r = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.error) fail(r.error.message);
  if (r.result.exceptionDetails) fail(r.result.exceptionDetails.exception?.description || 'eval error');
  return r.result.result.value;
}

const need = (n, usage) => { if (args.length < n) fail(`usage: twctl ${usage}`); };

const c = await connect();
try {
  // Show the "Claude is creating" border on every control call (disable with TW_OVERLAY=0).
  if (cmd !== 'overlay' && process.env.TW_OVERLAY !== '0') await evaluate(c, overlayJs(process.env.TW_OVERLAY_TEXT || 'Claude is creating'));
  switch (cmd) {
    case 'overlay': // overlay [on|off] ["text"]
      console.log(await evaluate(c, overlayJs(args[0] === 'off' ? null : (args[1] || 'Claude is creating')))); break;
    case 'status':
      console.log(JSON.stringify(await evaluate(c, `({
        targets: vm.runtime.targets.filter(t=>t.isOriginal).map(t=>({name:t.getName(),stage:t.isStage,blocks:Object.keys(t.blocks._blocks).length})),
        threads: vm.runtime.threads.length,
        turbo: vm.runtime.turboMode
      })`), null, 2)); break;
    case 'eval':
      need(1, 'eval "<js>"');
      console.log(JSON.stringify(await evaluate(c, args.join(' ')), null, 2)); break;
    case 'flag': await evaluate(c, 'vm.greenFlag(), 0'); console.log('green flag'); break;
    case 'stop': await evaluate(c, 'vm.stopAll(), 0'); console.log('stopped'); break;
    case 'key': { // key <name> [holdMs]
      need(1, 'key <name> [holdMs]');
      const [k, ms = 100] = args;
      await evaluate(c, `(async()=>{vm.postIOData('keyboard',{key:${JSON.stringify(k)},isDown:true});
        await new Promise(r=>setTimeout(r,${+ms}));
        vm.postIOData('keyboard',{key:${JSON.stringify(k)},isDown:false});})()`);
      console.log(`key ${k}`); break;
    }
    case 'new':
      await evaluate(c, `(async()=>{const r=await fetch('data:application/json,'+encodeURIComponent(JSON.stringify({targets:[{isStage:true,name:'Stage',variables:{},lists:{},broadcasts:{},blocks:{},currentCostume:0,costumes:[{name:'backdrop1',dataFormat:'svg',assetId:'cd21514d0531fdffb22204e0ec5ed84a',md5ext:'cd21514d0531fdffb22204e0ec5ed84a.svg',rotationCenterX:240,rotationCenterY:180}],sounds:[],volume:100,layerOrder:0,tempo:60,videoTransparency:50,videoState:'on',textToSpeechLanguage:null}],monitors:[],extensions:[],meta:{semver:'3.0.0',vm:'0.2.0',agent:''}})));
        await vm.loadProject(await r.text());})()`);
      console.log('new empty project'); break;
    case 'mouse': { // mouse <x> <y> [down|up|click]  (Scratch stage coords, -240..240 / -180..180)
      need(2, 'mouse <x> <y> [down|up|click]');
      const [x, y, act = 'move'] = args;
      await evaluate(c, `(async()=>{const m=(o)=>vm.postIOData('mouse',Object.assign({x:${+x}+240,y:180-(${+y}),canvasWidth:480,canvasHeight:360},o));
        m({}); if('${act}'==='down'||'${act}'==='click') m({isDown:true});
        if('${act}'==='click'){await new Promise(r=>setTimeout(r,80));}
        if('${act}'==='up'||'${act}'==='click') m({isDown:false});})()`);
      console.log(`mouse ${act} ${x},${y}`); break;
    }
    case 'sprite': // sprite <name> [color|file.svg]   adds a sprite (default: blue circle)
    case 'backdrop': { // backdrop <file.svg>        adds a backdrop and switches to it
      need(1, cmd === 'sprite' ? 'sprite <name> [color|file.svg]' : 'backdrop <file.svg>');
      const isBackdrop = cmd === 'backdrop';
      const src = isBackdrop ? args[0] : args[1];
      let svg, w = 40, h = 40;
      if (src && src.endsWith('.svg')) {
        svg = readFileSync(resolve(src), 'utf8');
        w = +(svg.match(/\swidth="([\d.]+)/)?.[1] ?? 40); h = +(svg.match(/\sheight="([\d.]+)/)?.[1] ?? 40);
      } else {
        svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="${src || '#4c97ff'}"/></svg>`;
      }
      const md5 = createHash('md5').update(svg).digest('hex');
      const cost = `{name:'costume1',dataFormat:'svg',assetId:'${md5}',md5ext:'${md5}.svg',bitmapResolution:1,rotationCenterX:${w / 2},rotationCenterY:${h / 2}}`;
      const prep = `const st=vm.runtime.storage; st.cache(st.AssetType.ImageVector, st.DataFormat.SVG, new TextEncoder().encode(${JSON.stringify(svg)}), ${JSON.stringify(md5)});`;
      const r = await evaluate(c, isBackdrop
        ? `(async()=>{${prep} await vm.addBackdrop('${md5}.svg', ${cost.replace("'costume1'", "'backdrop'")});
            const s=vm.runtime.getTargetForStage(); s.setCostume(s.sprite.costumes.length-1); return 'backdrop set';})()`
        : `(async()=>{${prep} await vm.addSprite(JSON.stringify({name:${JSON.stringify(args[0])},isStage:false,variables:{},lists:{},broadcasts:{},blocks:{},currentCostume:0,
            costumes:[${cost}],sounds:[],volume:100,visible:true,x:0,y:0,size:100,direction:90,draggable:false,rotationStyle:'all around'})); return 'added';})()`);
      console.log(r); break;
    }
    case 'get': { // get <spriteName>  -> blocks JSON
      need(1, 'get <sprite>');
      console.log(JSON.stringify(await evaluate(c, `vm.runtime.targets.find(t=>t.isOriginal&&t.getName()===${JSON.stringify(args[0])})?.blocks._blocks`), null, 1)); break;
    }
    case 'blocks': { // blocks <sprite> <blocks.json>  (array or id->block object, Scratch project.json format)
      need(2, 'blocks <sprite> <blocks.json>');
      const data = JSON.parse(readFileSync(resolve(args[1]), 'utf8'));
      const arr = toVmBlocks(data);
      console.log(JSON.stringify(await evaluate(c, `(async()=>{const t=vm.runtime.targets.find(t=>t.isOriginal&&t.getName()===${JSON.stringify(args[0])});
        if(!t) return 'no such sprite'; await vm.shareBlocksToTarget(${JSON.stringify(arr)}, t.id); vm.emitWorkspaceUpdate(); return 'added '+${arr.length}+' blocks';})()`))); break;
    }
    case 'select': // select <sprite>  switch the editor to a sprite
      need(1, 'select <sprite>');
      console.log(await evaluate(c, `(()=>{const t=vm.runtime.targets.find(t=>t.isOriginal&&t.getName()===${JSON.stringify(args[0])});
        if(!t) return 'no such sprite'; vm.setEditingTarget(t.id); return 'editing '+t.getName();})()`)); break;
    case 'vars':
      console.log(JSON.stringify(await evaluate(c, `Object.fromEntries(Object.values(vm.runtime.getTargetForStage().variables).map(v=>[v.name,v.value]))`), null, 2)); break;
    case 'load': { // load <file.sb3>
      need(1, 'load <file.sb3>');
      const b64 = readFileSync(resolve(args[0])).toString('base64');
      await evaluate(c, `(async()=>{const b=await (await fetch('data:application/octet-stream;base64,${b64}')).arrayBuffer();
        await vm.loadProject(b);})()`);
      console.log(`loaded ${args[0]}`); break;
    }
    case 'export': { // export <out.sb3>
      need(1, 'export <out.sb3>');
      const b64 = await evaluate(c, `(async()=>{const blob=await vm.saveProjectSb3();
        return await new Promise(r=>{const f=new FileReader();f.onload=()=>r(f.result.split(',')[1]);f.readAsDataURL(blob);});})()`);
      writeFileSync(resolve(args[0]), Buffer.from(b64, 'base64'));
      console.log(`exported ${args[0]} (${Buffer.from(b64, 'base64').length} bytes)`); break;
    }
    case 'screenshot': {
      need(1, 'screenshot <out.png>');
      const r = await c.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(resolve(args[0]), Buffer.from(r.result.data, 'base64'));
      console.log(`saved ${args[0]}`); break;
    }
    default:
      console.log(`twctl <status|eval|flag|stop|key|mouse|vars|load|export|screenshot|overlay|new|sprite|backdrop|select|get|blocks> [args]\nPort: ${PORT} (TW_REMOTE_PORT)`);
  }
} finally { c.close(); }
