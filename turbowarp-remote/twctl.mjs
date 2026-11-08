#!/usr/bin/env node
// twctl: remote-control a TurboWarp Desktop instance started via TurboWarpRemote.app.
// Talks to the editor page over the Chrome DevTools Protocol and drives window.vm.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
  switch (cmd) {
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
      console.log(`twctl <status|eval|flag|stop|key|vars|load|export|screenshot> [args]\nPort: ${PORT} (TW_REMOTE_PORT)`);
  }
} finally { c.close(); }
