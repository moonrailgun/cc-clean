import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Provider } from './types.ts';
import { claudeActiveSessions, claudeSessionOwner, type ActivityCommand, type ActivityMetadata } from './claude-activity.ts';
import { codexActiveSessions, codexSessionOwners } from './codex-activity.ts';
const exec=promisify(execFile);
export type ActivityResult=string|null|{sessionIds:string[];openFiles:string[];codexOwners?:Record<string,string[]>};
export type ActivityCheck=(provider:Provider,root:string,files?:string[])=>Promise<ActivityResult>;
export function activityReason(result:ActivityResult,root:string,files:string[],sessionIds:string[]=[],ownershipPaths=files):string|null {
  if(typeof result==='string'||result===null)return result;
  if(result.openFiles.some(path=>files.includes(path)))return 'Candidate contains open files; close the writer first';
  if(!result.sessionIds.length)return null;
  if(result.codexOwners) {
    const owners=files.map(path=>result.codexOwners![path]??[]);
    const active=[...sessionIds.map(id=>id.toLowerCase()),...owners.flat()].find(id=>result.sessionIds.includes(id));
    if(active)return `Codex active session ${active} owns this operation; idle open sessions remain protected`;
    if(!owners.length||owners.some(ids=>!ids.length))return 'Cannot associate candidate files with a Codex session while clients are running';
    return null;
  }
  const owners=ownershipPaths.map(path=>claudeSessionOwner(root,path));
  const active=[...sessionIds.map(id=>id.toLowerCase()),...owners].find(id=>id&&result.sessionIds.includes(id));
  if(active)return `Claude active session ${active} owns this operation; idle open sessions remain protected`;
  if(!owners.length||owners.some(id=>!id))return 'Cannot associate candidate files with a Claude session while clients are running';
  return null;
}
export const createActivityCheck=(run:ActivityCommand=exec,platform:NodeJS.Platform=process.platform,readMetadata?:ActivityMetadata):ActivityCheck=>async(provider,root,files)=>{
  if(platform!=='darwin') return 'Mutations are not verified on this platform; analysis only';
  try {
    const {stdout}=await run('/bin/ps',['-axo','comm='],{timeout:5000,maxBuffer:4*1024*1024});
    if(!stdout.trim())return 'Cannot reliably check client activity';
    const commands=stdout.split('\n').map(line=>line.trim());
    const pattern=provider==='codex'?/(?:^|\/)codex(?:$|\s|[-_])|\/(?:Codex|CodexCLI)\.app\//i:/(?:^|\/)claude(?:$|\s|[-_])|\/(?:Claude|ClaudeCode)\.app\/|\/claude\/versions\/[^/\s]+$/i;
    let running=commands.some(line=>pattern.test(line));
    if(!running&&commands.some(line=>/(?:^|\/)(?:node|bun)$/i.test(line))) {
      // Inspect only known CLI entry points; never include arguments in warnings.
      const {stdout:args}=await run('/bin/ps',['-axww','-o','args='],{timeout:5000,maxBuffer:4*1024*1024});
      if(!args.trim())return 'Cannot reliably check client activity';
      const entry=provider==='codex'?'@openai/codex/bin/codex\\.js':'@anthropic-ai/claude-code/cli\\.js';
      const script=new RegExp(`^(?:"[^"]*\\/(?:node|bun)"|(?:[^\\s]*\\/)?(?:node|bun))\\s+(?:--[^\\s]+\\s+)*(?:"[^"]*\\/${entry}"|[^\\s]*\\/${entry})(?:\\s|$)`, 'i');
      running=args.split('\n').some(line=>script.test(line.trim()));
    }
    let sessionIds:string[]=[];
    if(running) {
      try {sessionIds=provider==='codex'?await codexActiveSessions(run,root):await claudeActiveSessions(run,root,readMetadata);}
      catch {return `Cannot reliably associate every ${provider==='codex'?'Codex':'Claude'} client or service with its idle open session; provider retained`;}
      if(!files)return 'Clients are running; candidate paths are required for session activity checks';
    }
    // Explicit files must never fall back to a recursive scan of a shared system temp directory.
    const targets = files ? Array.from({length: Math.ceil(files.length / 100)}, (_, i) => ['--', ...files.slice(i * 100, (i + 1) * 100)]) : [['+D', root]];
    const openFiles:string[]=[];
    for (const target of targets) {
      let opened:string;
      // The current process may hold the coordinated SQLite write transaction.
      try {
        const result=await run('/usr/sbin/lsof',['-nP','-a','-p',`^${process.pid}`,'-F','n',...target],{timeout:10000,maxBuffer:4*1024*1024});
        if(result.stderr?.trim())return 'Cannot reliably check open files';
        opened=result.stdout;
      } catch(e) {
        // lsof also exits 1 when only some requested files have matching descriptors.
        const error=e as {code?:number;stdout?:string;stderr?:string};
        if(error.code!==1||error.stderr?.trim())return 'Cannot reliably check open files';
        opened=error.stdout??'';
      }
      if(opened.trim()) {
        if(!files)return 'Source directory contains open files; close the writer first';
        const names=opened.split('\n').filter(line=>line.startsWith('n')).map(line=>line.slice(1));
        if(!names.length||names.some(path=>!files.includes(path)))return 'Cannot reliably check open files';
        openFiles.push(...names);
      }
    }
    return sessionIds.length||openFiles.length?{sessionIds,openFiles:[...new Set(openFiles)],...provider==='codex'?{codexOwners:await codexSessionOwners(sessionIds.length?files??[]:[])}:{}}:null;
  } catch {return 'Cannot reliably check client activity';}
};
export const checkActivity=createActivityCheck();
