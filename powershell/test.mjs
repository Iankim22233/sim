#!/usr/bin/env node
// Drives the running emulator without typing: starts the green flag, answers the ask box with each
// command in turn (runtime.emit('ANSWER', ...)), then prints the terminal contents (the Screen list).
//   node test.mjs '["cls","mkdir demo","cd demo","echo hi > a.txt","ls","cat a.txt"]'
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const TW = path.join(path.dirname(fileURLToPath(import.meta.url)), '../turbowarp-remote/twctl.mjs');
const cmds = JSON.parse(process.argv[2] || '["help"]');
const js = `(async()=>{
  const st=vm.runtime.getTargetForStage(), screen=()=>st.lookupVariableByNameAndType('Screen','list').value;
  vm.stopAll(); await new Promise(r=>setTimeout(r,300)); vm.greenFlag(); await new Promise(r=>setTimeout(r,900));
  for(const c of ${JSON.stringify(cmds)}){ vm.runtime.emit('ANSWER', c); await new Promise(r=>setTimeout(r,350)); }
  await new Promise(r=>setTimeout(r,300));
  return screen().map(l=>'|'+l).join('\\n'); })()`;
console.log(JSON.parse(execFileSync('node', [TW, 'eval', js], { encoding: 'utf8', env: { ...process.env, TW_OVERLAY: process.env.TW_OVERLAY ?? '0' } })));
