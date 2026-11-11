// SPDX-License-Identifier: Apache-2.0
// Derived from RTK 0.49.0 (653efb6ed02bd287d686c50e830dd1009356904f):
// cmds/scala/sbt_cmd.rs, go/golangci_cmd.rs, php/{phpt_cmd,artisan_cmd}.rs,
// cloud/psql_cmd.rs. Historical-output guards are described in NATIVE.md.
import { clean, counts, json, lines, object, string, truncate, uint, type Filter } from './rtk-native-common.ts';
const divider = '═══════════════════════════════════════';
const compiled = /\[info\] Compiling (\d+) Scala source/;
const sbtNoise = /^\[info\] (welcome to sbt|loading |set current project|Updating |Resolved |Fetching |downloading |Done )/;
function sbtCompile(input: string): string {
  let sources = 0, seconds: string | undefined;
  const errors: string[] = [];
  for (const line of lines(input).map(l => l.trim())) {
    const compile = line.match(compiled), success = line.match(/\[success\] Total time: (\d+) s/);
    if (compile) sources += Number(compile[1]);
    else if (success) seconds = success[1];
    else if (line.startsWith('[error]')) { const text = line.replace(/^\[error\] /, ''); if (text) errors.push(text); }
  }
  if (errors.length) return [`sbt compile: ${errors.length} errors`,divider,...errors.slice(0,30).map((s,i)=>`${i+1}. ${truncate(s,120)}`),...(errors.length>30?[`\n... +${errors.length-30} more errors`]:[])].join('\n');
  // Upstream's unconditional fallback is intentionally not used for unknown text.
  if (!seconds) return input;
  return `sbt compile: ${sources ? `${sources} sources` : 'Success'} (${seconds}s)`;
}
function sbtTest(input: string): string {
  let passed=0, failed=0, canceled=0, ignored=0, pending=0, suites=0, time='', summary=false, detail=false;
  const failures: {name:string;details:string[]}[]=[], failedSuites:string[]=[], errors:string[]=[];
  for (const raw of lines(input)) {
    const line=raw.trim(); let m: RegExpMatchArray|null;
    if ((m=line.match(/Tests: succeeded (\d+), failed (\d+), canceled (\d+), ignored (\d+), pending (\d+)/))) { [passed,failed,canceled,ignored,pending]=m.slice(1).map(Number);summary=true;detail=false;continue; }
    if ((m=line.match(/^\[info\] (?:Passed|Failed): Total \d+, Failed (\d+), Errors (\d+), Passed (\d+)/))) { failed=+m[1]+ +m[2];passed=+m[3];summary=true;detail=false;continue; }
    if ((m=line.match(/Suites: completed (\d+), aborted (\d+)/))) { suites=+m[1];detail=false;continue; }
    if ((m=line.match(/Run completed in (\d+) seconds?/))) { time=`${m[1]}s`;detail=false;continue; }
    if (line.includes('*** FAILED ***')) { failures.push({name:line.replace(/ \*\*\* FAILED \*\*\*$/,'').replace(/^\[info\]/,'').trim().replace(/^-+/,'').trim(),details:[]});detail=true;continue; }
    if (detail) {
      if (line.startsWith('[info]    ')) { const text=line.slice(6).trim();if(text&&!/^(at |\.\.\.)/.test(text)&&failures.at(-1)!.details.length<4)failures.at(-1)!.details.push(text);continue; }
      detail=false;
    }
    if (line.startsWith('[error]')) {
      const text=line.replace(/^\[error\] /,'').trim();
      if (!text||text.startsWith('Total time:')||text.includes('TestsFailedException')||text.includes('compileIncremental')||text==='Failed tests:') continue;
      (/^(com\.|org\.)/.test(text)?failedSuites:errors).push(text);
    }
  }
  if(!summary)return errors.length?['sbt test: errors',divider,...errors.slice(0,20).map(e=>`  ${truncate(e,120)}`)].join('\n'):input;
  if(!failed&&!canceled)return `sbt test: ${passed} passed${ignored?`, ${ignored} ignored`:''}${pending?`, ${pending} pending`:''}${suites?` (${suites} suites${time?`, ${time}`:''})`:time?` (${time})`:''}`;
  return [`sbt test: ${passed} passed, ${failed} failed${canceled?`, ${canceled} canceled`:''}${ignored?`, ${ignored} ignored`:''}${time?` (${time})`:''}`,divider,...failures.flatMap(f=>[`  [FAIL] ${truncate(f.name,120)}`,...f.details.map(d=>`         ${truncate(d,120)}`)]),...(failedSuites.length?['',...failedSuites.map(s=>`  ${s}`)]:[]),...(errors.length?['',...errors.slice(0,10).map(e=>`  ${truncate(e,120)}`)]:[])].join('\n').trim();
}
function sbtRun(input:string):string {
  if(!lines(input).some(l=>sbtNoise.test(l.trim())||/^\[info\] [Rr]unning /.test(l.trim())))return input;
  return lines(input).map(l=>l.trim()).filter(l=>!sbtNoise.test(l)&&!compiled.test(l)&&!/^\[info\] [Rr]unning /.test(l)&&!/^\[success\] Total time:/.test(l)).map(l=>l.replace(/^\[(?:info|success|error)\] /,'')).join('\n').trim();
}
function golangci(input:string,version:number):string {
  const parsed=json(input);
  if(!object(parsed)||!Array.isArray(parsed.Issues))return input;
  const issues: {linter:string;file:string;source:string[]}[]=[];
  for(const issue of parsed.Issues) {
    if(!object(issue)||!string(issue.FromLinter)||!string(issue.Text)||!object(issue.Pos)||!string(issue.Pos.Filename)||!uint(issue.Pos.Line)||!uint(issue.Pos.Column)||issue.SourceLines!==undefined&&(!Array.isArray(issue.SourceLines)||!issue.SourceLines.every(string)))return input;
    issues.push({linter:issue.FromLinter,file:issue.Pos.Filename,source:(issue.SourceLines??[]) as string[]});
  }
  if(!issues.length)return 'golangci-lint: No issues found';
  const files=counts(issues.map(i=>i.file));
  const out=[`golangci-lint: ${issues.length} issues in ${files.length} files`,'Top linters:',...counts(issues.map(i=>i.linter)).slice(0,10).map(([l,n])=>`  ${l} (${n}x)`),'','Top files:'];
  for(const [file,count] of files.slice(0,10)) {
    const path=file.replace(/\\/g,'/'); let short=path.slice(path.lastIndexOf('/')+1);
    for(const part of ['/pkg/','/cmd/','/internal/'])if(path.includes(part)){short=path.slice(path.lastIndexOf(part)+1);break;}
    out.push(`  ${short} (${count} issues)`);
    const subset=issues.filter(i=>i.file===file);
    for(const [l,n] of counts(subset.map(i=>i.linter)).slice(0,3)) { out.push(`    ${l} (${n})`); const src=subset.find(i=>i.linter===l)!.source[0];if(version>=2&&src!==undefined)out.push(`      → ${Array.from(src.trim()).slice(0,80).join('')}`); }
  }
  if(files.length>10)out.push(`\n... +${files.length-10} more files`);
  return out.join('\n').trim();
}
function phpt(input:string):string {
  const text=clean(input).replace(/\r/g,'\n');
  const scanned: Record<string,number>={}, summary: Record<string,number>={};
  let total:number|undefined,time:number|undefined,diff:string[]=[],pending:string[]=[],inDiff=false,hasSummary=false;
  const env: Record<string,string>={}, failures:{path:string;description:string;diff:string[]}[]=[];
  const names: Record<string,string>={'Tests passed':'PASS','Tests failed':'FAIL','Tests skipped':'SKIP','Tests warned':'WARN','Expected fail':'XFAIL','Expected leak':'XLEAK','Tests leaked':'LEAK','Tests borked':'BORK'};
  for(const raw of lines(text)) {
    const line=raw.trimEnd(); let m:RegExpMatchArray|null;
    if(line==='========DIFF========'){diff=[];inDiff=true;continue;}
    if(line==='========DONE========'){inDiff=false;pending=diff;continue;}
    if(inDiff){diff.push(line);continue;}
    if((m=line.match(/^(PHP_VERSION|PHP_SAPI|PHP_OS).*?:\s*(.*)/))&&!env[m[1]])env[m[1]]=m[1]==='PHP_OS'?m[2].split(' - ')[0].trim():m[2].trim();
    if((m=line.match(/(?:^|\])(PASS|FAIL|SKIP|BORK|WARN|XLEAK|LEAK|XFAIL)\s+(.*?)\s*\[([^\[\]]+\.phpt)\]/))) { scanned[m[1]]=(scanned[m[1]]??0)+1;if(['FAIL','BORK','LEAK'].includes(m[1]))failures.push({path:m[3],description:m[2].trim(),diff:pending});pending=[];continue; }
    if((m=line.match(/^\s*Number of tests\s*:\s*(\d+)/))){total=+m[1];continue;}
    if((m=line.match(/^\s*Time taken\s*:\s*([0-9.]+)/))){time=Number(m[1]);if(!Number.isFinite(time))return input;continue;}
    if((m=line.match(/^\s*(Tests passed|Tests failed|Tests skipped|Tests warned|Expected fail|Expected leak|Tests leaked|Tests borked)\s*:\s*(\d+)/))){summary[names[m[1]]]=+m[2];hasSummary=true;}
  }
  if(inDiff||!hasSummary&&!Object.keys(scanned).length)return input;
  const c=hasSummary?summary:scanned, sum=Object.values(c).reduce((a,b)=>a+b,0),broken=(c.FAIL??0)+(c.BORK??0)+(c.LEAK??0);
  if(!sum)return 'phpt: no tests ran';
  let first=`phpt: ${c.PASS??0} passed`;
  for(const [key,label] of [['FAIL','failed'],['SKIP','skipped'],['XFAIL','xfailed'],['WARN','warned'],['BORK','borked'],['LEAK','leaked'],['XLEAK','xleaked']])if(c[key])first+=`, ${c[key]} ${label}`;
  const out=[`${first}  (${total??sum} total${time!==undefined?`, ${time.toFixed(1)}s`:''})`];
  const envParts=[['PHP_VERSION','PHP'],['PHP_SAPI','SAPI'],['PHP_OS','OS']].filter(([key])=>env[key]).map(([key,label])=>`${label} ${env[key]}`);
  if(envParts.length)out.push(envParts.join('  '));
  if(broken){out.push('',`FAILURES (${broken}):`);if(!failures.length)out.push('  (per-test details unavailable — output truncated)');
    for(const [i,f]of failures.slice(0,20).entries()){if(i)out.push('');out.push(`  ${f.path}${f.description?` -- ${f.description}`:''}`,...f.diff.slice(0,6).map(l=>`    ${l}`));if(f.diff.length>6)out.push(`    ... +${f.diff.length-6} more diff lines`);}
    if(failures.length>20)out.push(`\n... +${failures.length-20} more failures`);
  }
  return out.join('\n').trimEnd();
}
function artisan(input:string):string {
  if(!/(?:Laravel|artisan|\b(?:INFO|WARN|ERROR|PASS|FAIL)\b|Environment\s+\.{3})/.test(input))return input;
  return clean(input).replace(/[\u2500-\u257f\u2580-\u259f\u25a0-\u25ff\u27a0-\u27bf]+/g,'').replace(/\.{3,}/g,'..').replace(/[ \t]{2,}/g,' ').replace(/\n{3,}/g,'\n\n').trim();
}
function psql(input:string):string {
  const ls=lines(input).map(l=>l.trim());
  if(ls.some(l=>/^-\[ RECORD \d+ \]-/.test(l))) {
    let rec='',pairs:string[]=[],n=0; const out:string[]=[];
    for(const l of ls){if(!l||/^\(\d+ rows?\)$/.test(l))continue;const m=l.match(/^-\[ RECORD (\d+) \]-[-+]*$/);if(m){if(rec&&n<=20)out.push(`${rec} ${pairs.join(' ')}`);n++;rec=`[${m[1]}]`;pairs=[];}else if(rec&&l.includes('|')){const i=l.indexOf('|');pairs.push(`${l.slice(0,i).trim()}=${l.slice(i+1).trim()}`);}else if(!rec)out.push(l);else return input;}
    if(rec&&n<=20)out.push(`${rec} ${pairs.join(' ')}`);if(n>20)out.push(`... +${n-20} more records`);return out.join('\n');
  }
  const separator=ls.findIndex(l=>/^[-+]+$/.test(l)&&l.includes('-+-'));
  if(separator<1||!ls[separator-1].includes('|')||!ls.some(l=>/^\(\d+ rows?\)$/.test(l)))return input;
  let rows=0;const out:string[]=[];
  for(const l of ls){if(!l||/^[-+]+$/.test(l)||/^\(\d+ rows?\)$/.test(l))continue;if(l.includes('|')){rows++;if(rows<=21)out.push(l.split('|').map(c=>c.trim()).join('\t'));}else out.push(l);}
  if(rows>21)out.push(`... +${rows-21} more rows`);return out.join('\n');
}
export const extraFilters:Record<string,Filter>={'sbt-compile':sbtCompile,'sbt-test':sbtTest,'sbt-run':sbtRun,'golangci-v1':s=>golangci(s,1),'golangci-v2':s=>golangci(s,2),phpt,artisan,psql};
