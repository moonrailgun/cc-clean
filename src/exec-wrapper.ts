type ExecCall = {name: 'exec_command' | 'shell_command' | 'write_stdin'; args: Record<string, unknown>};

// Only accept a single literal call whose unmodified result is printed once.
// Historical JavaScript is data, never evaluated.
export function execWrapperCall(source: unknown): ExecCall | undefined {
  if (typeof source !== 'string' || source.length > 32_768) return;
  source = source.replace(/^\/\/ @exec: [^\n]*\n/, '').trim();
  const direct = /^text\(\s*await\s+tools\.(exec_command|shell_command|write_stdin)\(/.exec(source as string);
  const assigned = /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+tools\.(exec_command|shell_command|write_stdin)\(/.exec(source as string);
  if (!direct && !assigned) return;
  const text = source as string;
  let cursor = (direct ?? assigned)![0].length;
  const whitespace = () => { while (/\s/.test(text[cursor] ?? '')) cursor++; };
  function string(): string {
    const quote = text[cursor++];
    let result = '';
    while (cursor < text.length) {
      const char = text[cursor++];
      if (char === quote) return result;
      if (char === '\n' || char === '\r' || quote === '`' && char === '$' && text[cursor] === '{') throw new Error();
      if (char !== '\\') { result += char; continue; }
      const escaped = text[cursor++];
      const escapes: Record<string, string> = {n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0'};
      if (escaped in escapes) {
        if (escaped === '0' && /\d/.test(text[cursor] ?? '')) throw new Error();
        result += escapes[escaped];
      } else if (escaped === 'x' || escaped === 'u') {
        const length = escaped === 'x' ? 2 : 4, hex = text.slice(cursor, cursor + length);
        if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) throw new Error();
        result += String.fromCharCode(parseInt(hex, 16)); cursor += length;
      } else if (['\\', '"', "'", '`', '$', '/'].includes(escaped)) result += escaped;
      else throw new Error();
    }
    throw new Error();
  }
  function value(depth: number): unknown {
    if (depth > 10) throw new Error();
    whitespace();
    if (['"', "'", '`'].includes(text[cursor])) return string();
    if (text[cursor] === '{') {
      const object: Record<string, unknown> = {};
      cursor++; whitespace();
      while (text[cursor] !== '}') {
        let key: string;
        if (['"', "'"].includes(text[cursor])) key = string();
        else {
          const match = /^[A-Za-z_$][\w$]*/.exec(text.slice(cursor));
          if (!match) throw new Error();
          key = match[0]; cursor += key.length;
        }
        if (key === '__proto__' || Object.hasOwn(object, key)) throw new Error();
        whitespace(); if (text[cursor++] !== ':') throw new Error();
        object[key] = value(depth + 1); whitespace();
        if (text[cursor] !== ',') break;
        cursor++; whitespace();
      }
      if (text[cursor++] !== '}') throw new Error();
      return object;
    }
    const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![\w$.])/.exec(text.slice(cursor));
    if (!primitive) throw new Error();
    cursor += primitive[0].length;
    const result = JSON.parse(primitive[0]);
    if (typeof result === 'number' && !Number.isFinite(result)) throw new Error();
    return result;
  }
  try {
    const args = value(0);
    if (!args || typeof args !== 'object' || Array.isArray(args)) return;
    const tail = text.slice(cursor);
    if (direct ? !/^\s*\)\s*\)\s*;?\s*$/.test(tail) :
      !new RegExp(`^\\s*\\)\\s*;\\s*text\\(\\s*${assigned![1].replace(/\$/g, '\\$')}\\s*\\)\\s*;?\\s*$`).test(tail)) return;
    return {name: (direct?.[1] ?? assigned![2]) as ExecCall['name'], args: args as Record<string, unknown>};
  } catch { return; }
}
