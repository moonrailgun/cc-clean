// SPDX-License-Identifier: Apache-2.0
// Adapted from RTK 0.49.0 src/cmds/rust/cargo_cmd.rs, pinned commit 653efb6ed02bd287d686c50e830dd1009356904f.
import { clean, json, lines, object, string, truncate, type Filter } from './rtk-native-common.ts';
const diagnostic = /^(error|warning)(?:\[|:)/;
const cargoProgress = /^\s*(?:Compiling|Checking|Downloading|Downloaded|Finished|Updating|Locking|Adding|Blocking waiting for file lock)\b/;
function cargoTextShape(input:string):boolean {
  let inDiagnostic=false;
  for(const line of lines(input)){
    if(!line.trim())continue;
    if(cargoProgress.test(line)){inDiagnostic=false;continue;}
    if(diagnostic.test(line)){inDiagnostic=true;continue;}
    if(!inDiagnostic)return false;
  }
  return true;
}
function jsonDiagnostics(input: string): { errors: string[]; warnings: string[]; valid: boolean; finished: boolean } {
  const result = { errors: [] as string[], warnings: [] as string[], valid: false, finished: false };
  for (const line of lines(input)) {
    if (!line.trim().startsWith('{')) {
      if(line.trim()&&!cargoProgress.test(line))return {...result,valid:false};
      continue;
    }
    const entry = json(line);
    if (!object(entry) || !string(entry.reason)) return {...result, valid: false};
    if(!['compiler-message','compiler-artifact','build-script-executed','build-finished'].includes(entry.reason))return {...result,valid:false};
    if(entry.reason==='build-finished'&&typeof entry.success!=='boolean'||['compiler-artifact','build-script-executed'].includes(entry.reason)&&!string(entry.package_id)||entry.reason==='compiler-artifact'&&!object(entry.target))return {...result,valid:false};
    result.valid = true;
    if (entry.reason === 'build-finished' && entry.success === true) result.finished = true;
    if (entry.reason !== 'compiler-message') continue;
    const m = entry.message;
    if (!object(m) || !string(m.level) || !['warning','error','error: internal compiler error','note','help','failure-note'].includes(m.level) || !string(m.message) || m.rendered != null && !string(m.rendered)) return {...result, valid: false};
    const text = string(m.message) ? m.message : '';
    if (/^(?:aborting due to|could not compile)/.test(text) || text.includes('warning') && text.includes('generated')) continue;
    const bucket = m.level === 'warning' ? result.warnings : ['error', 'error: internal compiler error'].includes(m.level) ? result.errors : undefined;
    if (bucket && (m.rendered || text)) bucket.push(string(m.rendered) ? clean(m.rendered).trimEnd() : text);
  }
  return result;
}
function cargoBuild(input: string, label: string): string {
  const raw = clean(input), all = lines(raw), jd = jsonDiagnostics(raw);
  if (all.some(l=>l.trimStart().startsWith('{')) && !jd.valid) return input;
  if(!jd.valid&&!cargoTextShape(raw))return input;
  if (!jd.valid && !all.some(l=>/^\s*(?:Compiling|Checking|Finished)\b/.test(l)) && !all.some(l=>diagnostic.test(l))) return input;
  let compiled = 0, errors = 0, warnings = 0, finished = '', block: string[] = []; const blocks: string[][] = [];
  const flush = () => { if (block.length) blocks.push(block); block = []; };
  for (const line of all) {
    const t = line.trimStart();
    if (/^(Compiling|Checking)\b/.test(t)) { compiled++; continue; }
    if (/^(Downloading|Downloaded)\b/.test(t)) continue;
    if (t.startsWith('Finished')) { finished = t; continue; }
    if (line.startsWith('warning:') && line.includes('generated') && line.includes('warning') || /^(error\[|error:)/.test(line) && /aborting due to|could not compile/.test(line)) continue;
    if (diagnostic.test(line)) { flush(); if (line.startsWith('error')) errors++; else warnings++; block.push(line); }
    else if (block.length) { if (!line.trim() && block.length > 3) flush(); else block.push(line); }
  }
  flush(); errors = Math.max(errors, jd.errors.length); warnings = Math.max(warnings, jd.warnings.length);
  if (!errors && !warnings) {
    if (!finished && !jd.finished) return input;
    if (label === 'clippy') return 'cargo clippy: No issues found';
    const result = `cargo ${label} (${compiled} crates compiled)\n${finished ? finished + '\n' : ''}`;
    return Buffer.byteLength(result) < Buffer.byteLength(input) ? result : input;
  }
  let result = `cargo ${label}: ${errors} errors, ${warnings} warnings (${compiled} crates)\n`;
  for (const [items, cap, noun] of [[jd.errors, 20, 'errors'],[jd.warnings, 10, 'warnings']] as const) if (items.length) result += items.slice(0,cap).join('\n') + (items.length > cap ? `\n… +${items.length-cap} more ${noun}` : '') + '\n';
  result += blocks.slice(0,20).map(b=>b.join('\n')).join('\n\n');
  if (blocks.length>20) result += `\n\n… +${blocks.length-20} more issues`;
  return result.trim();
}
function clippy(input: string): string {
  if (lines(input).some(l=>l.trimStart().startsWith('{'))) return cargoBuild(input, 'clippy');
  const all = lines(clean(input));
  if(!cargoTextShape(clean(input)))return input;
  if (!all.some(l=>diagnostic.test(l)) && !all.some(l=>/^\s*Finished\b/.test(l))) return input;
  let errors=0,warnings=0,rule='',block:string[]=[]; const blocks:string[][]=[],rules=new Map<string,string[]>();
  const flush=()=>{ if(block.length) blocks.push(block); block=[]; };
  for(const l of all) {
    if(/^\s*(?:Compiling|Checking|Downloading|Downloaded|Finished)\b/.test(l)){flush();continue;}
    if(l.includes('generated')&&l.includes('warning')||/aborting due to|could not compile/.test(l)) continue;
    if(diagnostic.test(l)) {flush();if(l.startsWith('error')){errors++;block=[l];}else warnings++; const b=l.match(/\[([^\[\]]*)\][^\]]*$/);rule=b?b[1]:l.replace(/^(error|warning): /,'');}
    else if(l.trimStart().startsWith('--> ')){const loc=l.trimStart().slice(4);if(rule)rules.set(rule,[...(rules.get(rule)??[]),loc]);if(block.length)block.push(l);}
    else if(block.length){if(!l.trim())flush();else if(block.length<15)block.push(l);}
  } flush();
  if(!errors&&!warnings)return 'cargo clippy: No issues found';
  let result=`cargo clippy: ${errors} errors, ${warnings} warnings\n`;
  if(blocks.length){result+='\nErrors:\n';for(const b of blocks.slice(0,10))result+=b.map(l=>'  '+truncate(l,160)).join('\n')+'\n\n';if(blocks.length>10)result+=`  … +${blocks.length-10} more errors\n`;}
  const ordered=[...rules].sort((a,b)=>b[1].length-a[1].length||a[0].localeCompare(b[0]));
  for(const [r,locs]of ordered.slice(0,20)){result+=`  ${r} (${locs.length}x)\n`+locs.slice(0,3).map(l=>`    ${l}\n`).join('');if(locs.length>3)result+=`    … +${locs.length-3} more\n`;}
  if(ordered.length>20)result+=`\n… +${ordered.length-20} more rules\n`;return result.trim();
}
function install(input:string):string {
  const all=lines(clean(input));if(!all.some(l=>/^\s*(?:Installing|Installed|Ignored package|Replac(?:ing|ed))\b/.test(l)))return input;
  if(!all.some(l=>/^\s*(?:Installed|Ignored package|Replaced)\b/.test(l))&&!all.some(l=>/^error(?:\[|:)/.test(l)))return input;
  let inDiagnostic=false;
  for(const line of all){if(!line.trim())continue;if(cargoProgress.test(line)||/^\s*(?:Installing|Installed|Ignored package|Replac(?:ing|ed))\b/.test(line)){inDiagnostic=false;continue;}if(diagnostic.test(line)){inDiagnostic=true;continue;}if(!inDiagnostic)return input;}
  let compiled=0,name='',version='',ignored='',block:string[]=[];const blocks:string[][]=[],replaced:string[]=[];
  const flush=()=>{if(block.length)blocks.push(block);block=[];};
  for(const l of all){const t=l.trimStart();
    if(t.startsWith('Compiling')){compiled++;continue;}
    if(/^(?:Downloading|Downloaded|Locking|Updating|Adding|Finished|Blocking waiting for file lock)/.test(t))continue;
    if(t.startsWith('Installing')){const rest=t.slice(10).trim();if(rest&&!rest.startsWith('/')){const space=rest.indexOf(' ');name=space<0?rest:rest.slice(0,space);if(space>=0)version=rest.slice(space+1);}continue;}
    if(t.startsWith('Installed')){if(!name){const p=t.slice(9).trim().split(/\s+/);if(p.length>=2)[name,version]=p;}continue;}
    if(/^Replac(?:ing|ed)/.test(t)){replaced.push(t);continue;}
    if(t.startsWith('Ignored package')){ignored=t;continue;}
    if(l.startsWith('warning:')){if(!(l.includes('generated')&&l.includes('warning')))replaced.push(l);continue;}
    if(/^(?:error\[|error:)/.test(l)){if(/aborting due to|could not compile/.test(l))continue;flush();block.push(l);}
    else if(block.length){if(!l.trim()&&block.length>3)flush();else block.push(l);}
  }flush();
  if(ignored)return `cargo install: ${ignored.split('`')[1]??ignored} already installed`;
  const info=[name,version].filter(Boolean).join(' ');
  if(blocks.length){const deps=compiled?`, ${compiled} deps compiled`:'';return (`cargo install: ${blocks.length} error${blocks.length>1?'s':''}${info?` (${info}${deps})`:deps}\n`+blocks.slice(0,20).map(b=>b.join('\n')).join('\n\n')+(blocks.length>20?`\n\n… +${blocks.length-20} more issues`:'' )).trim();}
  return `cargo install (${info||'package'}, ${compiled} deps compiled)`+replaced.map(l=>`\n  ${l}`).join('');
}
function nextest(input:string):string {
  const all=lines(clean(input)), summary=all.find(l=>l.trim().startsWith('Summary'))?.trim();
  const m=summary?.match(/^Summary \[\s*([\d.]+)s\]\s+(\d+) tests? run:\s+(\d+) passed(?:\s+\([^)]*\))?(?:,\s+(\d+) failed)?(?:,\s+(\d+) exec failed)?(?:,\s+(\d+) timed out)?(?:,\s+(\d+) skipped)?\s*$/);
  if(!m)return input;
  let binaries=0,cancel=false,block:string[]=[];let failures:string[][]=[];
  const flush=()=>{if(block.length)failures.push(block);block=[];};
  const name=(l:string)=>l.slice(l.indexOf(']')+1).trim().replace(/^\([^)]*\) /,'');
  for(const l of all){const t=l.trim();if(/^(Compiling|Downloading|Downloaded|Finished|Locking|Updating|────)/.test(t))continue;
    const start=t.match(/^Starting \d+ tests? across (\d+) binar(?:y|ies)/);if(start){binaries=+start[1];continue;}
    const status=t.replace(/^TRY \d+\s*/,'');if(/^(FAIL|TIMEOUT|TMT|PASS)\b/.test(status)){flush();failures=failures.filter(b=>name(b[0])!==name(t));if(!status.startsWith('PASS'))block=[t];continue;}
    if(/^Cancell?ing|^Canceling/.test(t)){cancel=true;continue;}if(t.startsWith('Nextest run ID'))continue;if(t.startsWith('Summary')){flush();break;}if(block.length)block.push(l);
  }
  const [passed,failed,execFailed,timed,skipped]=m.slice(3).map(x=>+(x??0)), parts=[`${passed} passed`];
  if(failed)parts.push(`${failed} failed`);if(execFailed)parts.push(`${execFailed} exec failed`);if(timed)parts.push(`${timed} timed out`);if(skipped)parts.push(`${skipped} skipped`);
  const meta=(binaries?`${binaries} binar${binaries===1?'y':'ies'}, `:'')+`${m[1]}s`;
  return ((failed+execFailed+timed?failures.map(b=>b.join('\n')+'\n').join('')+(cancel?'Cancelling due to test failure\n':''):'')+`cargo nextest: ${parts.join(', ')} (${meta})`).trim();
}
export const rustFilters:Record<string,Filter>={'cargo-build':i=>cargoBuild(i,'build'),'cargo-check':i=>cargoBuild(i,'check'),'cargo-clippy':clippy,'cargo-install':install,'cargo-nextest':nextest};
