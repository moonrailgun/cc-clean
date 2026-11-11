// SPDX-License-Identifier: Apache-2.0
// Derived from RTK 0.49.0, 653efb6ed02bd287d686c50e830dd1009356904f:
// cmds/system/{format_cmd,ls,env_cmd,json_cmd,deps}.rs. See third_party/rtk/NATIVE.md.
import { json, lines, object, string, type Filter } from './rtk-native-common.ts';

function black(input: string): string {
  if (!/(?:All done[! ✨]|Oh no!|\d+ files? (?:would be reformatted|(?:would be )?left unchanged))/i.test(input)) return input;
  const files: string[] = []; let unchanged = 0, reformatted = 0, done = false, ohNo = false;
  for (const raw of lines(input)) {
    const line = raw.trim(), lower = line.toLowerCase();
    if (lower.startsWith('would reformat:')) files.push(line.split(':')[1].trim());
    if (lower.includes('would be reformatted') || lower.includes('would be left unchanged')) {
      for (const part of line.split(',')) {
        const count = part.match(/(\d+) files?\b/); if (!count) continue;
        if (part.toLowerCase().includes('would be reformatted')) reformatted = +count[1];
        if (part.toLowerCase().includes('would be left unchanged')) unchanged = +count[1];
      }
    }
    if (lower.includes('left unchanged') && !lower.includes('would be')) unchanged = +(line.match(/(\d+) files?\b/)?.[1] ?? unchanged);
    done ||= lower.includes('all done!') || lower.includes('all done ✨'); ohNo ||= lower.includes('oh no!');
  }
  if (!files.length && !reformatted && !ohNo) return done || unchanged ? `Format (black): All files formatted${unchanged ? ` (${unchanged} files checked)` : ''}` : input;
  const compact = (p: string) => { p=p.replace(/\\/g,'/');for(const dir of ['/src/','/lib/','/tests/']){const i=p.lastIndexOf(dir);if(i>=0)return p.slice(i+1);}return p.split('/').at(-1)!; };
  let out = `Format (black): ${files.length || reformatted} files need formatting\n`;
  for (const [i,file] of files.slice(0,10).entries()) out += `${i+1}. ${compact(file)}\n`;
  if(files.length>10)out+=`\n... +${files.length-10} more files\n`;
  if(unchanged)out+=`\n${unchanged} files already formatted\n`;
  return (out+'\n[hint] Run `black .` to format these files\n').trim();
}
const noise = new Set('node_modules .git target __pycache__ .next dist build .cache .turbo .vercel .pytest_cache .mypy_cache .tox .venv venv env coverage .nyc_output .DS_Store Thumbs.db .idea .vscode .vs *.egg-info .eggs'.split(' '));
function ls(input: string, all = false, long = true): string {
  if (!input.trim()) return input;
  const dirs: string[]=[],files: string[]=[],filtered: string[]=[];let seen=0;
  for(const line of lines(input)) {
    if(!line || /^total \d+$/.test(line))continue;
    // Upstream recognizes English month/day/time fields only. No partial listings.
    const match=line.match(/^([bcdlps-][rwxstST-]{9}[+@.]?)\s+.+?\s(\d+)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(?:\d{4}|\d{2}:\d{2})\s+(.+)$/);
    if(!match)return input;
    const [,perms,n,name]=match;
    // Preserve upstream's broad dot-directory test, including names ending '.'.
    if(line.trim().endsWith('.'))continue;
    seen++;
    if(!all&&noise.has(name)){filtered.push(name+'/');continue;}
    const bit=(r:boolean,w:boolean,x:boolean)=>(+r*4 + +w*2 + +x);
    const special=bit(/[sS]/.test(perms[3]),/[sS]/.test(perms[6]),/[tT]/.test(perms[9]));
    const octal=(special?String(special):'')+[1,4,7].map(i=>bit(perms[i]==='r',perms[i+1]==='w',/[xst]/.test(perms[i+2]))).join('');
    if(!Number.isSafeInteger(+n))return input;
    const size=+n>=1048576?`${(+n/1048576).toFixed(1)}M`:+n>=1024?`${(+n/1024).toFixed(1)}K`:`${n}B`;
    if(perms[0]==='d')dirs.push(`${long?octal+'  ':''}${name}/`);else files.push(`${long?octal+'  ':''}${name}${long?'  '+size:''}`);
  }
  if(!seen&&!/^total \d+/m.test(input))return input;
  const allLines=[...dirs,...files],shown=allLines.slice(0,50),omitted=Math.max(0,allLines.length-50);
  let output=shown.length?shown.join('\n')+'\n':'(empty)\n';
  if(omitted||filtered.length)output+=`... (${[omitted?`${omitted} more`:'',filtered.length?`${filtered.length} filtered`:''].filter(Boolean).join(', ')})\n`;
  return output;
}
export function filterEnvironment(input: string, filter?: string): string {
  const rows=lines(input);if(!input.trim()||!rows.every(l=>/^[A-Za-z_][A-Za-z0-9_]*=/.test(l)))return input;
  const entries=rows.map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)] as [string,string]).sort(([a],[b])=>a<b?-1:a>b?1:0);
  if(new Set(entries.map(([k])=>k)).size!==entries.length)return input;
  const groups: [string,string][][]=Array.from({length:5},()=>[]);
  const matches=(k:string,patterns:string)=>patterns.split(' ').some(p=>k.toUpperCase().includes(p));
  for(const [key,value] of entries){
    if(filter!==undefined&&!key.toLowerCase().includes(filter.toLowerCase()))continue;
    const display=Buffer.byteLength(value)>100?`${Array.from(value).slice(0,50).join('')}... (${Array.from(value).length} chars)`:value;
    let category=-1;
    if(key.includes('PATH'))category=0;
    else if(matches(key,'RUST CARGO PYTHON PIP NODE NPM YARN DENO BUN JAVA MAVEN GRADLE GO GOPATH GOROOT RUBY GEM PERL PHP DOTNET NUGET'))category=1;
    else if(matches(key,'AWS AZURE GCP GOOGLE_CLOUD DOCKER KUBERNETES K8S HELM TERRAFORM VAULT CONSUL NOMAD'))category=2;
    else if(matches(key,'EDITOR VISUAL SHELL TERM GIT SSH GPG BREW HOMEBREW XDG CLAUDE ANTHROPIC'))category=3;
    else if(filter!==undefined||['HOME','USER','LANG','LC_','TZ','PWD','OLDPWD'].some(p=>key.toUpperCase().startsWith(p)))category=4;
    if(category>=0)groups[category].push([key,display]);
  }
  let out='';
  for(const [i,group] of groups.entries()){
    if(!group.length)continue;
    out+=(i?'\n':'')+['PATH Variables:','Language/Runtime:','Cloud/Services:','Tools:','Other:'][i]+'\n';
    for(const [key,value] of group.slice(0,i===4?20:Infinity)){
      if(i===0&&key==='PATH'){const paths=value.split(':');out+=`  PATH (${paths.length} entries):\n`+paths.slice(0,10).map(p=>`    ${p}\n`).join('');if(paths.length>10)out+=`    ... +${paths.length-10} more\n`;}
      else out+=`  ${key}=${value}\n`;
    }
    if(i===4&&group.length>20)out+=`  ... +${group.length-20} more\n`;
  }
  if(filter===undefined)out+=`\nTotal: ${entries.length} vars (showing ${groups.slice(0,4).reduce((n,g)=>n+g.length,0)+Math.min(20,groups[4].length)} relevant)\n`;
  return out||input;
}

// Explicit content helpers: callers supply intent; these are not inferred from cat/curl/jq.
export function filterJson(input:string,maxDepth=3,schemaOnly=false):string {
  const value=json(input.replace(/^\uFEFF/,''));if(value===undefined||!Number.isInteger(maxDepth)||maxDepth<0||maxDepth>64)return input;
  const safeNumbers=(v:unknown):boolean=>typeof v==='number'?Number.isFinite(v)&&(!Number.isInteger(v)||Number.isSafeInteger(v)):Array.isArray(v)?v.every(safeNumbers):object(v)?Object.values(v).every(safeNumbers):true;
  if(!safeNumbers(value))return input;
  const bytes=(s:string)=>Buffer.byteLength(s);
  const bytePrefix=(s:string,n:number)=>{let out='';for(const c of s){if(bytes(out)+bytes(c)>n)break;out+=c;}return out;};
  const simple=(v:unknown)=>v===null||typeof v!=='object';
  function render(v:unknown,depth:number):string {
    const indent='  '.repeat(depth);if(depth>maxDepth)return schemaOnly?'...':indent+'...';
    if(v===null)return schemaOnly?'null':indent+'null';
    if(typeof v==='boolean')return schemaOnly?'bool':indent+v;
    if(typeof v==='number')return schemaOnly?(Number.isInteger(v)?'int':'float'):indent+v;
    if(string(v))return schemaOnly?(bytes(v)>50?`string[${bytes(v)}]`:!v?'string':v.startsWith('http')?'url':v.includes('-')&&bytes(v)===10?'date?':'string'):indent+'"'+(bytes(v)>80?bytePrefix(v,77)+'...':v)+'"';
    if(Array.isArray(v)){
      if(!v.length)return schemaOnly?'[]':indent+'[]';
      if(schemaOnly)return `[${render(v[0],depth+1)}]${v.length>1?` (${v.length})`:''}`;
      if(v.length>5)return `${indent}[${render(v[0],depth+1).trim()}, ... +${v.length-1} more]`;
      const items=v.map(x=>render(x,depth+1));return v.every(simple)?`${indent}[${items.map(s=>s.trim()).join(', ')}]`:[indent+'[',...items.map(s=>s+','),indent+']'].join('\n');
    }
    const obj=v as Record<string,unknown>,keys=Object.keys(obj).sort();if(!keys.length)return schemaOnly?'{}':indent+'{}';
    if(schemaOnly){const parts=keys.slice(0,16).map(k=>`${!k||k.startsWith('...')||/[\s\x00-\x1f\x7f,:{}\[\]"\\]/u.test(k)?JSON.stringify(k):k}:${render(obj[k],depth+1)}`);if(keys.length>16)parts.push(`...+${keys.length-16}`);return '{'+parts.join(',')+'}';}
    const out=[indent+'{'];for(const [i,key] of keys.entries()){if(simple(obj[key]))out.push(`${indent}  ${key}: ${render(obj[key],0).trim()}`);else out.push(`${indent}  ${key}:`,render(obj[key],depth+1));if(i>=20){out.push(`${indent}  ... +${keys.length-i-1} more keys`);break;}}out.push(indent+'}');return out.join('\n');
  }
  return render(value,0);
}
export type DependencyKind='cargo'|'package'|'requirements'|'pyproject'|'gomod';
export function summarizeDependencies(kind:DependencyKind,input:string):string {
  if(!input.trim())return input;
  const section=(label:string,items:string[],cap=10)=>`  ${label} (${items.length}):\n`+items.slice(0,cap).map(s=>`    ${s}\n`).join('')+(items.length>cap?`    ... +${items.length-cap} more\n`:'');
  let out='';const deps:string[]=[],dev:string[]=[];
  if(kind==='package'){
    const v=json(input);if(!object(v)||![v.name,v.dependencies,v.devDependencies].some(x=>x!==undefined)||v.name!==undefined&&!string(v.name)||v.version!==undefined&&!string(v.version))return input;
    for(const field of ['dependencies','devDependencies'])if(v[field]!==undefined&&(!object(v[field])||!Object.values(v[field]).every(string)))return input;
    if(string(v.name))out+=`  ${v.name} @ ${v.version??'?'}\n`;
    const packageDeps=v.dependencies;
    if(object(packageDeps))out+=section('Dependencies',Object.keys(packageDeps).sort().map(k=>`${k} (${packageDeps[k]})`));
    if(object(v.devDependencies))out+=section('Dev Dependencies',Object.keys(v.devDependencies).sort(),5);
  } else if(kind==='cargo'){
    if(!/^\[(?:package|workspace|dependencies|dev-dependencies)\]\s*$/m.test(input))return input;
    let current='';for(const line of lines(input)){const s=line.match(/^\[([^\]]+)\]/);if(s){current=s[1];continue;}const m=line.match(/^([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]+)"|.*version\s*=\s*"([^"]+)")/);if(m&&['dependencies','dev-dependencies'].includes(current))(current==='dependencies'?deps:dev).push(`${m[1]} (${m[2]??m[3]??'*'})`);}
    if(deps.length)out+=section('Dependencies',deps);if(dev.length)out+=section('Dev',dev,5);
  } else if(kind==='requirements'){
    const rows=lines(input).map(s=>s.trim()).filter(s=>s&&!s.startsWith('#'));
    if(!rows.length||!rows.every(s=>/^[a-zA-Z0-9_-]+(?:[=<>!~]+.*)?$/.test(s)))return input;
    out=section('Packages',rows);
  } else if(kind==='pyproject'){
    let started=false,closed=false;for(const line of lines(input)){if(line.includes('dependencies')&&line.includes('[')){started=true;continue;}if(started){if(line.trim()===']'){closed=true;break;}const dep=line.trim().replace(/^["',]+|["',]+$/g,'');if(dep)deps.push(dep);}}
    if(!closed)return input;if(deps.length)out=section('Dependencies',deps);
  } else {
    let module='',version='',inRequire=false;for(const raw of lines(input)){const line=raw.trim();if(line.startsWith('module '))module=line.slice(7);else if(line.startsWith('go '))version=line.slice(3);else if(line==='require (')inRequire=true;else if(line===')')inRequire=false;else if(inRequire&&!line.startsWith('//')){const parts=line.split(/\s+/);if(parts.length>=2)deps.push(parts.slice(0,2).join(' '));}else if(line.startsWith('require ')&&!line.includes('('))deps.push(line.slice(8));}
    if(!module||!/^\d+\.\d+(?:\.\d+)?$/.test(version)||inRequire)return input;
    out=`  ${module} (go ${version})\n`;if(deps.length)out+=section('Dependencies',deps);
  }
  return out||input;
}
export const systemTextFilters:Record<string,Filter>={black,env:input=>filterEnvironment(input),'ls-long':input=>ls(input),'ls-long-all':input=>ls(input,true)};
