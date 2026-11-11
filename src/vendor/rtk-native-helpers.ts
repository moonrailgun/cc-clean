// SPDX-License-Identifier: Apache-2.0
// Derived from RTK 0.49.0, 653efb6ed02bd287d686c50e830dd1009356904f:
// core/filter.rs, text/src/lib.rs, cmds/system/{local_llm,summary}.rs,
// cmds/python/uv_cmd.rs, cmds/cloud/{wget,curl}_cmd.rs, cmds/system/read.rs,
// cmds/js/lint_cmd.rs and cmds/php/{php_cmd,utils}.rs. No execution or tee writes.
// These explicit-context helpers are never guessed from ordinary command output.
import { clean, json, lines, object, truncate } from './rtk-native-common.ts';

export type SourceLanguage='Rust'|'Python'|'JavaScript'|'TypeScript'|'Go'|'C'|'Cpp'|'Java'|'Ruby'|'Shell'|'Data'|'Unknown';
const sourceLines=(input:string):string[]=>input===''?[]:lines(input);
const isImport=(s:string)=>/^(use |import |from |require\(|#include)/.test(s);
const isSignature=(s:string)=>/^(pub\s+)?(async\s+)?(fn|def|function|func|class|struct|enum|trait|interface|type)\s+\w+/.test(s);

export function formatWithLineNumbers(input:string):string {
  const rows=sourceLines(input),width=String(rows.length).length;
  return rows.map((line,i)=>`${String(i+1).padStart(width)}\t${line}\n`).join('');
}
export function applyLineWindow(input:string,maxLines?:number,headLines?:number,tailLines?:number):string {
  if([maxLines,headLines,tailLines].some(n=>n!==undefined&&(!Number.isSafeInteger(n)||n<0)))return input;
  if(headLines!==undefined){if(!headLines)return '';let count=0;for(let i=0;i<input.length;i++)if(input[i]==='\n'&&++count===headLines)return input.slice(0,i+1);return input;}
  if(tailLines!==undefined){if(!tailLines)return '';let count=0;for(let i=input.length-(input.endsWith('\n')?2:1);i>=0;i--)if(input[i]==='\n'&&++count===tailLines)return input.slice(i+1);return input;}
  return maxLines===undefined?input:smartTruncate(input,maxLines);
}
export function filterGenericLint(input:string):string {
  let errors=0,warnings=0;const issues:string[]=[];
  for(const row of sourceLines(input)){const lower=row.toLowerCase();if(lower.includes('warning')){warnings++;issues.push(row);}if(lower.includes('error')&&!lower.includes('0 error')){errors++;issues.push(row);}}
  if(!errors&&!warnings)return 'Lint: No issues found';
  return (`Lint: ${errors} errors, ${warnings} warnings\n`+issues.slice(0,20).map(row=>truncate(row,100)+'\n').join('')+(issues.length>20?`\n… +${issues.length-20} more issues\n`:'')).trim();
}
export function filterPhpOutput(input:string):string {
  return clean(input).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').trim()||'ok';
}
// This is the no-tee path: historical filters cannot manufacture a recall file.
export function filterCurlOutput(input:string):string {return input.includes('\0')?input:input.trim();}
export function curlError(stderr:string,stdout:string):string {return `FAILED: curl ${stderr.trim()||stdout.trim()}`;}

function tripleQuote(line:string,open:string|undefined):string|undefined {
  let i=0;
  while(i<line.length){
    if(open){if(line[i]==='\\')i+=2;else if(line.startsWith(open,i)){open=undefined;i+=3;}else i++;continue;}
    if(line[i]==='#')break;
    if(line.startsWith('"""',i)||line.startsWith("'''",i)){open=line.slice(i,i+3);i+=3;continue;}
    if(line[i]==='"'||line[i]==="'"){
      const quote=line[i],prefix=/[a-zA-Z0-9_]+$/.exec(line.slice(0,i))?.[0].toLowerCase();
      const interpolated=['f','fr','rf','t','tr','rt'].includes(prefix??'');let depth=0;i++;
      while(i<line.length){if(line[i]==='\\')i++;else if(interpolated&&line[i]==='{'){if(depth===0&&line[i+1]==='{')i++;else depth++;}else if(interpolated&&line[i]==='}'&&depth>0)depth--;else if(line[i]===quote&&depth===0)break;i++;}i++;continue;
    }i++;
  }return open;
}
function minimalSource(input:string,language:SourceLanguage):string {
  const out:string[]=[];let open:string|undefined,block=false;
  const comment=language==='Data'?undefined:['Python','Ruby','Shell'].includes(language)?'#':'//';
  const start=language==='Ruby'?'=begin':['Shell','Data'].includes(language)?undefined:'/*';
  const end=language==='Ruby'?'=end':'*/';
  for(const row of sourceLines(input)){
    const s=row.trim();
    if(language==='Python'){
      if(open){out.push(row);open=tripleQuote(row,open);continue;}
      if(s.startsWith('#'))continue;
      out.push(s?row:'');open=tripleQuote(row,undefined);continue;
    }
    if(start){if(s.startsWith(start)&&!s.startsWith(['Ruby','Unknown'].includes(language)?'###':'/**'))block=true;if(block){if(s.includes(end))block=false;continue;}}
    if(comment&&s.startsWith(comment)){if(language==='Rust'&&s.startsWith('///'))out.push(row);continue;}
    out.push(s?row:'');
  }return (out.join('\n')+'\n').replace(/\n{3,}/g,'\n\n').trim();
}
export function filterSource(input:string,language:SourceLanguage,level:'none'|'minimal'|'aggressive'):string {
  if(level==='none')return input;
  const minimal=minimalSource(input,language);
  if(level==='minimal'||language==='Data')return minimal||input;
  const out:string[]=[];let depth=0,body=false;
  for(const row of sourceLines(minimal)){
    const s=row.trim();if(isImport(s)){out.push(row);continue;}if(isSignature(s)){out.push(row);body=true;depth=0;continue;}
    if(body){depth+=(s.match(/{/g)?.length??0)-(s.match(/}/g)?.length??0);if(depth<=1&&(s==='{'||s==='}'||s.endsWith('{')))out.push(row);if(depth<=0){body=false;if(s&&s!=='}')out.push('    // ... implementation');}continue;}
    if(/^(const |static |let |pub const |pub static )/.test(s))out.push(row);
  }return out.join('\n').trim()||input;
}
export function smartTruncate(input:string,maxLines:number):string {
  if(!Number.isSafeInteger(maxLines)||maxLines<0)return input;if(maxLines===0)return '';
  const rows=sourceLines(input);if(rows.length<=maxLines)return input;const kept:string[]=[];
  for(const row of rows){const s=row.trim();if(isSignature(s)||isImport(s)||s.startsWith('pub ')||s.startsWith('export ')||s==='}'||s==='{'||kept.length<Math.floor(maxLines/2))kept.push(row);if(kept.length>=maxLines-1)break;}
  return [...kept,`[${rows.length-kept.length} more lines]`].join('\n');
}
export function analyzeCode(input:string,language:SourceLanguage):string {
  const rows=sourceLines(input),name=language==='Cpp'?'C++':language==='Unknown'?'Code':language;
  const imp:Partial<Record<SourceLanguage,RegExp>>={Rust:/^use\s+([a-zA-Z_][a-zA-Z0-9_]*(?:::[a-zA-Z_][a-zA-Z0-9_]*)?)/,Python:/^(?:from\s+(\S+)|import\s+(\S+))/,JavaScript:/(?:import.*from\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\))/,Go:/^\s*"([^"]+)"$/};imp.TypeScript=imp.JavaScript;
  const fn:Partial<Record<SourceLanguage,RegExp>>={Rust:/(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)/,Python:/def\s+([a-zA-Z_][a-zA-Z0-9_]*)/,JavaScript:/(?:async\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_]*)|(?:const|let|var)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:async\s+)?\(/,Go:/func\s+(?:\([^)]+\)\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/};fn.TypeScript=fn.JavaScript;
  const structs:Partial<Record<SourceLanguage,RegExp>>={Rust:/(?:pub\s+)?(?:struct|enum)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,Python:/class\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,TypeScript:/(?:interface|class|type)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,Go:/type\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+struct/g,Java:/(?:public\s+)?class\s+([a-zA-Z_][a-zA-Z0-9_]*)/g};
  const matches=(re:RegExp|undefined)=>re?rows.flatMap(row=>{const m=re.exec(row);return m?[m[1]??m[2]]:[];}):[];
  const standard=language==='Rust'?['std','core','alloc']:language==='Python'?['os','sys','re','json','typing']:[];
  const imports=[...new Set(matches(imp[language]).map(s=>s.split('::')[0]).filter(s=>!standard.includes(s)))].slice(0,5);
  const functions=matches(fn[language]).filter(s=>!s.startsWith('test_')&&!['main','new'].includes(s)).slice(0,10);
  const structures=structs[language]?[...input.matchAll(structs[language]!)].slice(0,10):[];
  const traits=language==='Rust'?[...input.matchAll(/(?:pub\s+)?trait\s+([a-zA-Z_][a-zA-Z0-9_]*)/g)].slice(0,5):language==='TypeScript'?[...input.matchAll(/interface\s+([a-zA-Z_][a-zA-Z0-9_]*)/g)].slice(0,5):[];
  const patterns:string[]=[];if(input.includes('async')&&input.includes('await'))patterns.push('async');
  if(language==='Rust'){if(input.includes('impl')&&input.includes('for'))patterns.push('trait impl');if(input.includes('#[derive'))patterns.push('derive');if(input.includes('Result<')||input.includes('anyhow::'))patterns.push('error handling');if(input.includes('#[test]'))patterns.push('tests');if(input.includes('Box<dyn')||input.includes('&dyn'))patterns.push('dyn dispatch');}
  if(language==='Python'){if(input.includes('@dataclass'))patterns.push('dataclass');if(input.includes('def __init__'))patterns.push('OOP');}
  if(['JavaScript','TypeScript'].includes(language)){if(input.includes('useState')||input.includes('useEffect'))patterns.push('React hooks');if(input.includes('export default'))patterns.push('ES modules');}
  const type=structures.length?(functions.length?'module':'data structures'):functions.length?'functions':'code';
  const components=[functions.length?`${functions.length} fn`:'',structures.length?`${structures.length} struct`:'',traits.length?`${traits.length} trait`:''].filter(Boolean);
  const line1=components.length?`${name} ${type} (${components.join(', ')}) - ${rows.length} lines`:`${name} ${type} (${rows.length} lines)`;
  const details=[imports.length?`uses: ${imports.slice(0,3).join(', ')}`:'',patterns.length?`patterns: ${patterns.slice(0,3).join(', ')}`:''].filter(Boolean);
  if(!details.length&&functions.length)details.push(`defines: ${functions.slice(0,3).join(', ')}`);
  return `${line1}\n${details.join(' | ')||'General purpose code file'}`;
}

export function summarizeOutput(input:string,command:string,success:boolean):string {
  const rows=sourceLines(input),lower=input.toLowerCase(),cmd=command.toLowerCase(),out=[`${success?'[ok]':'[FAIL]'} Command: ${truncate(command,60)}`,`   ${rows.length} lines of output`,''];
  if(cmd.includes('test')||lower.includes('passed')&&lower.includes('failed')){
    out.push('Test Results:');let passed=0,failed=0,skipped=0;const failures:string[]=[];
    const number=(s:string,word:string)=>{const m=new RegExp(`(\\d+)\\s*${word}`).exec(s);return m?Number(m[1]):undefined;};
    for(const row of rows){const l=row.toLowerCase();if(l.includes('passed')||l.includes('✓')||l.includes('ok'))passed=number(l,'passed')??passed+1;if(l.includes('failed')||l.includes('[x]')||l.includes('fail')){failed=number(l,'failed')??failed;if(!row.includes('0 failed'))failures.push(row);}if(l.includes('skipped')||l.includes('ignored'))skipped=number(l,'skipped')??number(l,'ignored')??skipped;}
    out.push(`   [ok] ${passed} passed`);if(failed>0)out.push(`   [FAIL] ${failed} failed`);if(skipped>0)out.push(`   skip ${skipped} skipped`);if(failures.length)out.push('','   Failures:',...failures.slice(0,5).map(s=>`   • ${truncate(s,70)}`));
  }else if(cmd.includes('build')||cmd.includes('compile')||lower.includes('compiling')){
    out.push('Build Summary:');let errors=0,warnings=0,compiled=0;const messages:string[]=[];
    for(const row of rows){const l=row.toLowerCase();if(l.includes('error')&&!l.includes('0 error')){errors++;if(messages.length<5)messages.push(row);}if(l.includes('warning')&&!l.includes('0 warning'))warnings++;if(l.includes('compiling')||l.includes('compiled'))compiled++;}
    if(compiled)out.push(`   ${compiled} crates/files compiled`);if(errors)out.push(`   [error] ${errors} errors`);if(warnings)out.push(`   [warn] ${warnings} warnings`);if(!errors&&!warnings)out.push('   [ok] Build successful');if(messages.length)out.push('','   Errors:',...messages.map(s=>`   • ${truncate(s,70)}`));
  }else if(lower.includes('error:')||lower.includes('warn:')||lower.includes('[info]')){
    let errors=0,warnings=0,info=0;for(const row of rows){const l=row.toLowerCase();if(l.includes('error')||l.includes('fatal'))errors++;else if(l.includes('warn'))warnings++;else if(l.includes('info'))info++;}
    out.push('Log Summary:',`   [error] ${errors} errors`,`   [warn] ${warnings} warnings`,`   [info] ${info} info`);
  }else if(/^[{[]/.test(input.trimStart())){
    out.push('JSON Output:');const value=json(input);if(value===undefined)out.push('   (Invalid JSON)');else if(Array.isArray(value))out.push(`   Array with ${value.length} items`);else if(object(value)){const keys=Object.keys(value).sort();out.push(`   Object with ${keys.length} keys:`,...keys.slice(0,10).map(s=>`   • ${s}`));if(keys.length>10)out.push(`   ... +${keys.length-10} more keys`);}else out.push(`   ${truncate(JSON.stringify(value),100)}`);
  }else if(rows.every(s=>Buffer.byteLength(s)<200&&!s.includes('\t')&&(s.trim()?s.trim().split(/\s+/).length:0)<10)){
    const items=rows.filter(s=>s.trim());out.push(`List (${items.length} items):`,...items.slice(0,10).map(s=>`   • ${truncate(s,70)}`));if(items.length>10)out.push(`   ... +${items.length-10} more`);
  }else{out.push('Output:',...rows.slice(0,5).filter(s=>s.trim()).map(s=>`   ${truncate(s,75)}`));if(rows.length>10)out.push('   ...',...rows.slice(-3).filter(s=>s.trim()).map(s=>`   ${truncate(s,75)}`));}
  return out.join('\n');
}

export function filterUvRun(input:string,stdout:string,stderr:string,exitCode:number):string {
  const program=(s:string)=>{const rows=sourceLines(clean(s));while(rows.length&&!rows.at(-1)!.trim())rows.pop();const cut=rows.map(s=>truncate(s,500));return cut.length<=50?cut.join('\n'):[...cut.slice(0,25),`... (${cut.length-50} lines omitted)`,...cut.slice(-25)].join('\n');};
  if(exitCode===0)return [program(stdout),program(stderr)].filter(Boolean).join('\n')||'ok';
  const rows=sourceLines(clean(input)),selected:string[]=[];
  const frame=/^\s*File ".*", line \d+.*$/,exception=/^\s*[A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception):/,js=/^\s*at .+:\d+:\d+.*$/;
  const error=(s:string)=>frame.test(s)||exception.test(s)||js.test(s)||s.includes('No module named ')||/\b(?:error|failed|failure|exception|panic|warn(?:ing)?|assert(?:ion)?)\b/i.test(s)||/^(?:E\s+|Caused by:|note:|help:)/.test(s);
  const continuation=(s:string)=>/^[ \t]/.test(s)||/^(?:>|\||During handling of the above exception|The above exception|Caused by:|note:|help:)/.test(s.trim())||frame.test(s.trim())||exception.test(s.trim())||js.test(s.trim());
  for(let i=0;i<rows.length;){const s=rows[i].trim();if(!s){i++;continue;}let block:string[]=[];
    if(s.startsWith('Traceback ')){block=[s];const frames:string[]=[],tail:string[]=[];i++;while(i<rows.length&&rows[i].trim()){const t=rows[i].trim();(frame.test(t)?frames:tail).push(truncate(t,frame.test(t)?160:200));i++;}block.push(...frames.slice(0,10));if(frames.length>10)block.push(`... +${frames.length-10} more frames`);block.push(...tail.slice(-2));}
    else if(error(s)){block=[truncate(s,200)];let count=0;i++;while(i<rows.length&&rows[i].trim()&&continuation(rows[i])){count++;if(count<=10)block.push(truncate(rows[i].trim(),200));i++;}if(count>10)block.push(`... +${count-10} more lines`);}
    else{i++;continue;}
    selected.push(...block.filter((s,i)=>i===0||s!==block[i-1]),'');
  }
  return selected.join('\n').trim()||rows.map(s=>s.trim()).filter(Boolean).map(s=>truncate(s,200)).slice(-10).join('\n');
}
export function wgetError(stderr:string,stdout:string):string {
  const text=`${stderr}\n${stdout}`;
  for(const [needle,result] of [['404','404 Not Found'],['403','403 Forbidden'],['401','401 Unauthorized'],['500','500 Server Error'],['Connection refused','Connection refused'],['unable to resolve','DNS lookup failed'],['Name or service not known','DNS lookup failed'],['timed out','Connection timed out'],['SSL','SSL/TLS error'],['certificate','SSL/TLS error']])if(text.includes(needle))return result;
  const row=sourceLines(stderr).map(s=>s.trim()).find(s=>s&&!s.startsWith('--'));
  return row?Buffer.byteLength(row)>60?Array.from(row).slice(0,60).join('')+'...':row:'Unknown error';
}
export function summarizeWgetStdout(input:string,url:string):string {
  const chars=Array.from(url.replace(/^https?:\/\//,'')),name=chars.length>50?chars.slice(0,25).join('')+'...'+chars.slice(-20).join(''):chars.join('');
  const rows=sourceLines(input);let output='';
  if(rows.length>20){const bytes=Buffer.byteLength(input),size=bytes<1024?`${bytes}B`:bytes<1024**2?`${(bytes/1024).toFixed(1)}KB`:bytes<1024**3?`${(bytes/1024**2).toFixed(1)}MB`:`${(bytes/1024**3).toFixed(1)}GB`;output=`${name} ok | ${rows.length} lines | ${size}\nfirst 10 lines:\n`+rows.slice(0,10).map(row=>Buffer.byteLength(row)<=100?row:Array.from(row).slice(0,97).join('')+'...').join('\n')+`\n... +${rows.length-10} more lines`;
  }else output=`${name} ok | ${rows.length} lines\n`+rows.map(s=>s+'\n').join('');
  return Buffer.byteLength(output)<Buffer.byteLength(input)?output:input;
}
