import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Provider } from './types.ts';
const exec=promisify(execFile);
type ActivityCommand=(file:string,args:string[],options:{timeout:number;maxBuffer:number})=>Promise<{stdout:string}>;
export type ActivityCheck=(provider:Provider,root:string,files?:string[])=>Promise<string|null>;
export const createActivityCheck=(run:ActivityCommand=exec,platform:NodeJS.Platform=process.platform):ActivityCheck=>async(provider,root,files)=>{
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
    if(running)return `${provider} client or service is running and may own idle open sessions; close it and retry`;
    // Explicit files must never fall back to a recursive scan of a shared system temp directory.
    const targets = files ? Array.from({length: Math.ceil(files.length / 100)}, (_, i) => ['--', ...files.slice(i * 100, (i + 1) * 100)]) : [['+D', root]];
    for (const target of targets) try {
      // The current process may hold the coordinated SQLite write transaction.
      const {stdout:opened}=await run('/usr/sbin/lsof',['-nP','-a','-p',`^${process.pid}`,'-F','n',...target],{timeout:10000,maxBuffer:4*1024*1024});
      if(opened.trim())return 'Source directory contains open files; close the writer first';
    } catch(e) { const error=e as {code?:number;stdout?:string;stderr?:string}; if(error.code!==1||error.stdout?.trim()||error.stderr?.trim()) return 'Cannot reliably check open files'; }
    return null;
  } catch {return 'Cannot reliably check client activity';}
};
export const checkActivity=createActivityCheck();
