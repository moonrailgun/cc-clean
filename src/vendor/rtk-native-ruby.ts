// SPDX-License-Identifier: Apache-2.0
// Adapted from RTK 0.49.0 src/cmds/ruby/{rake,rspec,rubocop}_cmd.rs, commit 653efb6ed02bd287d686c50e830dd1009356904f.
import { clean, json, lines, object, string, uint, truncate, type Filter, type Obj } from './rtk-native-common.ts';
function minitest(input:string):string {
 const all=lines(clean(input)),summary=all.map(l=>l.trim()).find(l=>/^\d+ (?:runs|tests), \d+ assertions, \d+ failures, \d+ errors(?:, \d+ skips)?$/.test(l));if(!summary)return input;
 const [runs,,failed,errors,skips=0]=summary.split(',').map(p=>parseInt(p));let active=false,block:string[]=[],failures:string[][]=[];
 const flush=()=>{if(block.length)failures.push(block);block=[];};
 for(const l of all){const t=l.trim();if(t===summary)continue;if(t==='# Running:'||t.startsWith('Started with run options')){active=false;continue;}if(t.startsWith('Finished in ')){active=true;continue;}if(!active)continue;if(/^\d+\)\s+(?:Failure|Error):$/.test(t)){flush();block=[t];}else if(!t)flush();else block.push(l);}flush();
 if(!failed&&!errors)return `ok rake test: ${runs} runs, 0 failures${skips?`, ${skips} skips`:''}`;
 let out=`rake test: ${runs} runs, ${failed} failures, ${errors} errors${skips?`, ${skips} skips`:''}`;
 if(failures.length)out+='\n\n'+failures.slice(0,5).map((b,i)=>`${i+1}. ${b[0].trim()}\n`+b.slice(1,5).filter(l=>l.trim()).map(l=>'   '+truncate(l.trim(),120)).join('\n')).join('\n\n');
 if(failures.length>5)out+=`\n\n... +${failures.length-5} more failures`;return out.trim();
}
function rspecNoise(input:string):string {
 let cov=false;const out:string[]=[];for(const l of lines(input)){const t=l.trim();if(/running via spring preloader/i.test(t)||/^DEPRECATION WARNING:|^Finished in \d/.test(t))continue;if(/coverage report|simplecov|coverage\/|\.simplecov|All Files.*Lines/i.test(t)){cov=true;continue;}if(cov){if(!t)cov=false;continue;}const shot=t.match(/saved screenshot to (.+)/);out.push(shot?`[screenshot: ${shot[1].trim()}]`:l);}return out.join('\n');
}
const gem=(s:string)=>/\/gems\/|lib\/rspec|lib\/ruby\/|vendor\/bundle/.test(s);
function rspec(input:string):string {
 const stripped=rspecNoise(clean(input)),data=json(stripped);
 if(object(data)){
  if(!Array.isArray(data.examples)||!object(data.summary))return input;const s=data.summary;
  if(!['example_count','failure_count','pending_count'].every(k=>uint(s[k]))||typeof s.duration!=='number'||!Number.isFinite(s.duration)||s.duration<0||s.errors_outside_of_examples_count!==undefined&&!uint(s.errors_outside_of_examples_count))return input;
  if(!data.examples.every(e=>object(e)&&string(e.full_description)&&string(e.status)&&string(e.file_path)&&uint(e.line_number)&&(e.exception==null||object(e.exception)&&string(e.exception.class)&&string(e.exception.message)&&(e.exception.backtrace===undefined||Array.isArray(e.exception.backtrace)&&e.exception.backtrace.every(string)))))return input;
  const count=s.example_count as number,fail=s.failure_count as number,pending=s.pending_count as number,outside=(s.errors_outside_of_examples_count as number)??0,duration=s.duration.toFixed(2);
  if(!count)return outside?`RSpec: ${outside} errors outside of examples (${duration}s)`:'RSpec: No examples found';
  if(!fail&&!outside)return `✓ RSpec: ${Math.max(0,count-pending)} passed${pending?`, ${pending} pending`:''} (${duration}s)`;
  let out=`RSpec: ${Math.max(0,count-fail-pending)} passed, ${fail} failed${pending?`, ${pending} pending`:''} (${duration}s)`;const failures=(data.examples as Obj[]).filter(e=>e.status==='failed');
  if(failures.length)out+='\n\nFailures:\n'+failures.slice(0,5).map((e,i)=>{let text=`${i+1}. ✗ ${e.full_description}\n   ${e.file_path}:${e.line_number}`;if(object(e.exception)){const exc=e.exception;text+=`\n   ${(exc.class as string).split('::').at(-1)}: ${truncate(lines(exc.message as string)[0],120)}`;const bt=((exc.backtrace??[]) as string[]).find(s=>!s.includes('/gems/')&&!s.includes('lib/rspec'));if(bt)text+='\n   '+truncate(bt,120);}return text;}).join('\n\n');
  if(failures.length>5)out+=`\n\n... +${failures.length-5} more failures`;return out;
 }
 if(stripped.trim().startsWith('{')||stripped.trim().startsWith('['))return input;
 let state='header',summary='',block:string[]=[],failures:string[]=[];
 const flush=()=>{if(block.length){let spec='';const kept=block.filter(l=>{if(/^# \.\/(spec|test)\//.test(l)){spec=l.slice(2);return false;}return !l.startsWith('#')||!gem(l);});failures.push(kept.join('\n   ')+(spec?'\n   '+spec:''));block=[];}};
 for(const l of lines(stripped)){const t=l.trim();if(/^\d+ examples?, \d+ failures?/.test(t)){flush();summary=t;break;}if(t==='Failures:'){state='failures';continue;}if(t==='Failed examples:'){flush();state='failed-examples';continue;}if(state==='failures'){if(/^\d+\)/.test(t)){flush();block=[t];}else if(t&&!gem(t))block.push(t);}}
 if(!summary)return input;let out=`RSpec: ${summary}`;if(failures.length)out+='\n'+failures.slice(0,5).map((f,i)=>`${i+1}. ✗ ${f}`).join('\n\n');if(failures.length>5)out+=`\n\n... +${failures.length-5} more failures`;return out;
}
function rubyPath(path:string):string {path=path.replace(/\\/g,'/');for(const p of ['app/models/','app/controllers/','app/views/','app/helpers/','app/services/','app/jobs/','app/mailers/','lib/','spec/','test/','config/']){const i=path.indexOf(p);if(i>=0)return path.slice(i);}const app=path.lastIndexOf('/app/');return app>=0?path.slice(app+1):path.slice(path.lastIndexOf('/')+1);}
const rank=(s:unknown)=>s==='fatal'||s==='error'?0:s==='warning'?1:['convention','refactor','info'].includes(s as string)?2:3;
function rubocop(input:string):string {
 const d=json(input);
 if(object(d)){
  if(!object(d.summary)||!Array.isArray(d.files))return input;const s=d.summary;
  if(!['offense_count','target_file_count','inspected_file_count'].every(k=>uint(s[k]))||s.correctable_offense_count!==undefined&&!uint(s.correctable_offense_count))return input;
  if(!d.files.every(f=>object(f)&&string(f.path)&&Array.isArray(f.offenses)&&f.offenses.every(o=>object(o)&&['cop_name','severity','message'].every(k=>string(o[k]))&&typeof o.correctable==='boolean'&&object(o.location)&&uint(o.location.start_line))))return input;
  if(!s.offense_count)return `ok ✓ rubocop (${s.inspected_file_count} files)`;
  const files=(d.files as Obj[]).filter(f=>(f.offenses as Obj[]).length).sort((a,b)=>Math.min(...(a.offenses as Obj[]).map(o=>rank(o.severity)))-Math.min(...(b.offenses as Obj[]).map(o=>rank(o.severity)))||(a.path as string).localeCompare(b.path as string));
  const correct=(s.correctable_offense_count as number)||files.flatMap(f=>f.offenses as Obj[]).filter(o=>o.correctable).length;
  let out=`rubocop: ${s.offense_count} offenses (${s.inspected_file_count} files)\n`;
  for(const f of files.slice(0,10)){out+=`\n${rubyPath(f.path as string)}\n`;const offenses=(f.offenses as Obj[]).toSorted((a,b)=>rank(a.severity)-rank(b.severity)||((a.location as Obj).start_line as number)-((b.location as Obj).start_line as number));for(const o of offenses.slice(0,5))out+=`  :${(o.location as Obj).start_line} ${o.cop_name} — ${lines(o.message as string)[0]}\n`;if(offenses.length>5)out+=`  … +${offenses.length-5} more\n`;}
  if(files.length>10)out+=`\n… +${files.length-10} more files\n`;if(correct)out+=`\n(${correct} correctable, run \`rubocop -A\`)`;return out.trim();
 }
 if(input.trim().startsWith('{')||input.trim().startsWith('['))return input;
 const all=lines(clean(input));if(all.some(l=>/cannot load such file|Bundler::GemNotFound|Gem::MissingSpecError|^rubocop: (?:command not found|No such file)/.test(l.trim()))){const ls=lines(input.trim());return `RuboCop error:\n${ls.slice(0,20).join('\n')}${ls.length>20?`\n... (${ls.length-20} more lines)`:''}`;}
 const summary=all.toReversed().map(l=>l.trim()).find(l=>/^\d+ files? inspected, /.test(l)&&/offense|autocorrected/.test(l));if(!summary)return input;
 const files=parseInt(summary),correct=summary.match(/(\d+) offenses? autocorrected/);if(correct)return files&&+correct[1]?`ok ✓ rubocop -A (${files} files, ${correct[1]} autocorrected)`:`RuboCop: ${summary}`;
 return summary.includes('no offenses')?files?`ok ✓ rubocop (${files} files)`:'ok ✓ rubocop (no offenses)':`RuboCop: ${summary}`;
}
export const rubyFilters:Record<string,Filter>={'rake-test':minitest,rspec,rubocop};
