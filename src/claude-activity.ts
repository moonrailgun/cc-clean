import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { readOrdinaryFile } from './state.ts';

export type ActivityCommand = (file:string,args:string[],options:{timeout:number;maxBuffer:number;env?:NodeJS.ProcessEnv}) => Promise<{stdout:string}>;
export type ActivityMetadata = (root:string,path:string) => Promise<Record<string, any>|null>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const native = /(?:^|\/)claude(?:$|\s|[-_])|\/(?:Claude|ClaudeCode)\.app\/|\/claude\/versions\/[^/\s]+$/i;
const runtime = /(?:^|\/)(?:node|bun)$/i;
const npm = /^(?:"[^"]*\/(?:node|bun)"|(?:[^\s]*\/)?(?:node|bun))\s+(?:--[^\s]+\s+)*(?:"[^"]*\/@anthropic-ai\/claude-code\/cli\.js"|[^\s]*\/@anthropic-ai\/claude-code\/cli\.js)(?:\s|$)/i;
const normalize = (v:unknown) => typeof v === 'string' ? v.trim().replace(/\s+/g,' ') : '';
const object = (v:any):v is Record<string,any> => !!v && typeof v === 'object' && !Array.isArray(v);
function fail():never {throw new Error('Unverified Claude session ownership');}

export function claudeSessionOwner(root:string,path:string):string|null {
  if(resolve(path)!==path || /[\x00-\x1f\x7f]/.test(path))return null;
  const parts=relative(root,path).split('/');
  if(parts[0]!=='projects'||!parts[1]||parts.length<3)return null;
  const id=parts.length===3?parts[2].replace(/\.jsonl$/,''):parts[2];
  return uuid.test(id)&&(parts.length>3||parts[2].endsWith('.jsonl'))?id.toLowerCase():null;
}

// Only bounded JSON metadata is read; peer keys, prompts and authentication data are never reported.
export const readActivityMetadata:ActivityMetadata=async(root,path)=>{
  const file=join(root,path),uid=process.getuid?.();
  if(uid===undefined||!file.startsWith(root+'/'))fail();
  try {
    if(await realpath(root)!==root)fail();
    const parents=[];
    for(let dir=dirname(file);;dir=dirname(dir)) {
      const s=await lstat(dir);
      if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==uid||(s.mode&0o022)!==0)fail();
      parents.push({dir,stat:s});
      if(dir===root)break;
    }
    const before=await lstat(file);
    if(before.uid!==uid||(before.mode&0o022)!==0)fail();
    const bytes=await readOrdinaryFile(file,1024*1024),after=await lstat(file);
    if(after.ino!==before.ino||after.dev!==before.dev||after.ctimeMs!==before.ctimeMs)fail();
    for(const {dir,stat} of parents) {
      const s=await lstat(dir);
      if(s.ino!==stat.ino||s.dev!==stat.dev||s.uid!==stat.uid||s.mode!==stat.mode)fail();
    }
    const value:unknown=JSON.parse(bytes.toString('utf8'));
    if(!object(value))fail();
    return value;
  }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
};

interface Process {pid:number;ppid:number;uid:number;start:string;comm:string;args:string}
async function processes(run:ActivityCommand):Promise<Process[]> {
  const options={timeout:5000,maxBuffer:4*1024*1024,env:{...process.env,TZ:'UTC',LC_ALL:'C'}};
  const {stdout}=await run('/bin/ps',['-axo','pid=,ppid=,uid=,lstart=,comm='],options);
  if(!stdout.trim())fail();
  const rows=stdout.trim().split('\n').map(line=>{
    const m=/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(line);
    if(!m)fail();
    return {pid:Number(m[1]),ppid:Number(m[2]),uid:Number(m[3]),start:normalize(m[4]),comm:m[5],args:''};
  }).filter(p=>native.test(p.comm)||runtime.test(p.comm));
  const {stdout:args}=await run('/bin/ps',['-axww','-o','pid=,args='],options);
  const byPid=new Map(args.trim().split('\n').map(line=>{
    const m=/^\s*(\d+)\s+(.+)$/.exec(line);if(!m)fail();return [Number(m[1]),m[2]];
  }));
  for(const p of rows){const args=byPid.get(p.pid);if(!args)fail();p.args=args;}
  return rows.filter(p=>native.test(p.comm)||npm.test(p.args)).sort((a,b)=>a.pid-b.pid);
}

async function snapshot(run:ActivityCommand,root:string,read:ActivityMetadata) {
  const rows=await processes(run),uid=process.getuid?.(),ids=new Set<string>(),owned=new Map<number,string>(),proof:unknown[]=[];
  if(rows.some(p=>p.uid!==uid))fail();
  const matching=(pid:unknown,start:unknown)=>rows.find(p=>p.pid===pid&&p.start===normalize(start));
  const add=(id:unknown)=>{if(typeof id!=='string'||!uuid.test(id))fail();ids.add(id.toLowerCase());return id.toLowerCase();};
  const source=(value:unknown)=>{if(typeof value!=='string')fail();return uuid.test(value)?add(value):add(claudeSessionOwner(root,value));};
  for(const p of rows) {
    const record=await read(root,`sessions/${p.pid}.json`);
    if(record) {
      if(record.pid!==p.pid||normalize(record.procStart)!==p.start||record.pidDomain!=='darwin'||!['interactive','bg'].includes(record.kind))fail();
      owned.set(p.pid,add(record.sessionId));
      proof.push([p.pid,record.procStart,record.sessionId,record.kind,record.pidDomain]);
    }
    // A fork can still depend on its resume source, even after its own session ID is registered.
    const resumes=[...p.args.matchAll(/(?:^|\s)--resume(?:=|\s+)([^\s]+)/g)];
    for(const m of resumes)source(m[1]);
    if(/(?:^|\s)--fork-session(?:\s|$)/.test(p.args)&&!resumes.length)fail();
  }
  if(rows.some(p=>!owned.has(p.pid))) {
    const lock=await read(root,'daemon.lock'),roster=await read(root,'daemon/roster.json');
    if(!lock||!roster||!matching(lock.pid,lock.procStart)||roster.supervisorPid!==lock.pid||!object(roster.workers))fail();
    const accounted=new Set(owned.keys());accounted.add(lock.pid);
    proof.push([lock.pid,lock.procStart,roster.supervisorPid]);
    for(const worker of Object.values(roster.workers)) {
      if(!object(worker))fail();
      const host=matching(worker.pid,worker.procStart),repl=matching(worker.replPid,worker.replProcStart);
      if(!host||!repl||host.ppid!==lock.pid||repl.ppid!==host.pid||owned.get(repl.pid)!==worker.sessionId||worker.dispatch?.sessionId!==worker.sessionId)fail();
      if(!/(?:^|\s)--bg-pty-host(?:\s|$)/.test(host.args))fail();
      const launch=worker.dispatch?.launch;
      if(!object(launch))fail();
      if(launch.sessionId!==undefined)source(launch.sessionId);
      else if(launch.fork)fail();
      accounted.add(host.pid);
      proof.push([worker.pid,worker.procStart,worker.replPid,worker.replProcStart,worker.sessionId,launch.sessionId,launch.fork]);
    }
    const spareHosts=rows.filter(p=>p.ppid===lock.pid&&p.comm==='claude bg-pty-host'&&/(?:^|\s)--bg-pty-host(?:\s|$)/.test(p.args)&&/(?:^|\s)--bg-spare(?:\s|$)/.test(p.args)&&!/(?:^|\s)--(?:session-id|resume|fork-session)(?:=|\s|$)/.test(p.args));
    for(const p of spareHosts)accounted.add(p.pid);
    for(const p of rows)if(p.comm==='claude bg-spare'&&spareHosts.some(host=>host.pid===p.ppid)&&/(?:^|\s)--bg-spare(?:\s|$)/.test(p.args)&&!/(?:^|\s)--(?:session-id|resume|fork-session)(?:=|\s|$)/.test(p.args))accounted.add(p.pid);
    if(rows.some(p=>!accounted.has(p.pid)))fail();
  }
  return {sessionIds:[...ids].sort(),identity:JSON.stringify([rows,proof])};
}

export async function claudeActiveSessions(run:ActivityCommand,root:string,read:ActivityMetadata=readActivityMetadata):Promise<string[]> {
  const before=await snapshot(run,root,read),after=await snapshot(run,root,read);
  if(before.identity!==after.identity)fail();
  return after.sessionIds;
}
