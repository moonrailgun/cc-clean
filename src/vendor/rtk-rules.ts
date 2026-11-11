// Copyright 2026 RTK AI Labs. Licensed under Apache-2.0.
// Modified by cc-clean: pure TypeScript port of core/toml_filter.rs and
// Apache-2.0 text/src/lib.rs at 653efb6ed02bd287d686c50e830dd1009356904f.
// Built-ins only: no config loading, command execution, telemetry or tee files.
import { rtkRuleDefinitions } from './rtk-rules-data.ts';

export interface RtkRuleDefinition {
  description?: string;
  match_command: string;
  strip_ansi?: boolean;
  replace?: readonly { pattern: string; replacement: string }[];
  match_output?: readonly { pattern: string; message: string; unless?: string }[];
  strip_lines_matching?: readonly string[];
  keep_lines_matching?: readonly string[];
  truncate_lines_at?: number;
  head_lines?: number;
  tail_lines?: number;
  max_lines?: number;
  on_empty?: string;
  filter_stderr?: boolean;
}

const word = String.raw`\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}`;
const start = String.raw`(?<![\s\S])`;
const end = String.raw`(?![\s\S])`;

// Rust's classes are Unicode-aware, its dot excludes only LF, and its anchors
// do not inherit JavaScript's CR/U+2028/U+2029 or final-newline special cases.
function rustRegex(pattern: string, global = false): RegExp {
  let position = 0;
  const unsupported = () => new Error(`Unsupported RTK regex: ${pattern}`);
  function segment(flags: { m: boolean; s: boolean }, nested: boolean): string {
    let result = '';
    let inClass = false;
    while (position < pattern.length) {
      const char = pattern[position++];
      if (char === '\\') {
        const escaped = pattern[position++];
        if (escaped === undefined) throw unsupported();
        const classes: Record<string, string> = {
          d: String.raw`\p{Nd}`, D: String.raw`\P{Nd}`,
          s: String.raw`\p{White_Space}`, S: String.raw`\P{White_Space}`,
          w: inClass ? word : `[${word}]`, W: `[^${word}]`,
        };
        if (escaped in classes) {
          if (inClass && escaped === 'W') throw unsupported();
          result += classes[escaped];
        } else if (escaped === 'b' || escaped === 'B') {
          if (inClass) throw unsupported();
          const boundary = `(?:(?<=[${word}])(?![${word}])|(?<![${word}])(?=[${word}]))`;
          result += escaped === 'b' ? boundary : `(?!${boundary})`;
        } else if (escaped === 'A' || escaped === 'z') {
          if (inClass) throw unsupported();
          result += escaped === 'A' ? start : end;
        } else if (escaped === 'x' && pattern[position] === '{') {
          result += '\\u';
        } else {
          result += `\\${escaped}`;
        }
      } else if (char === '[') {
        if (inClass) throw unsupported();
        inClass = true;
        result += char;
      } else if (char === ']' && inClass) {
        inClass = false;
        result += char;
      } else if (inClass) {
        if (['&&', '--', '~~'].includes(char + (pattern[position] ?? ''))) throw unsupported();
        result += char;
      } else if (char === '(') {
        const modifier = pattern.slice(position).match(/^\?([ims]*)(?:-([ims]+))?([:)])/);
        if (modifier && (modifier[1] || modifier[2])) {
          position += modifier[0].length;
          const enabled = modifier[1], disabled = modifier[2] ?? '';
          const next = { m: enabled.includes('m') || (flags.m && !disabled.includes('m')),
            s: enabled.includes('s') || (flags.s && !disabled.includes('s')) };
          const caseFlag = enabled.includes('i') ? 'i' : disabled.includes('i') ? '-i' : '';
          if (modifier[3] === ')') {
            // Flag-only groups affect the rest of their enclosing group.
            return result + `(?${caseFlag}:` + segment(next, nested) + ')';
          }
          result += `(?${caseFlag}:` + segment(next, true) + ')';
        } else {
          let prefix = '(';
          if (pattern.startsWith('?:', position)) {
            prefix = '(?:'; position += 2;
          } else if (pattern.startsWith('?P<', position) || pattern.startsWith('?<', position)) {
            const name = pattern.slice(position).match(/^\?P?<([A-Za-z_][A-Za-z0-9_]*)>/);
            if (!name) throw unsupported();
            prefix = `(?<${name[1]}>`; position += name[0].length;
          } else if (pattern[position] === '?') throw unsupported();
          result += prefix + segment(flags, true) + ')';
        }
      } else if (char === ')') {
        if (!nested) throw unsupported();
        return result;
      } else if (char === '.') {
        result += flags.s ? String.raw`[\s\S]` : String.raw`[^\n]`;
      } else if (char === '^') {
        result += flags.m ? String.raw`(?<![^\n])` : start;
      } else if (char === '$') {
        result += flags.m ? String.raw`(?![^\n])` : end;
      } else result += char;
    }
    if (nested || inClass) throw unsupported();
    return result;
  }
  return new RegExp(segment({ m: false, s: false }, false), global ? 'gu' : 'u');
}

function replaceCaptures(replacement: string, match: string, args: unknown[]): string {
  const named = typeof args.at(-1) === 'object' ? args.at(-1) as Record<string, string | undefined> : {};
  const captures = [match, ...args.slice(0, args.length - (typeof args.at(-1) === 'object' ? 3 : 2))];
  return replacement.replace(/\$(\$|\{([^}]+)\}|[A-Za-z0-9_]+)/g, (literal, token: string, braced: string | undefined) => {
    if (token === '$') return '$';
    const name = braced ?? token;
    return String((/^\d+$/.test(name) ? captures[Number(name)] : named[name]) ?? '');
  });
}

/** Compile the pinned schema once; invalid regexes fail visibly, never skip rules. */
export function compileRtkRule(definition: RtkRuleDefinition): { match: RegExp; filter(input: string): string } {
  if (definition.strip_lines_matching?.length && definition.keep_lines_matching?.length) {
    throw new Error('strip_lines_matching and keep_lines_matching are mutually exclusive');
  }
  for (const limit of [definition.truncate_lines_at, definition.head_lines, definition.tail_lines, definition.max_lines]) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error('RTK line limits must be nonnegative integers');
  }
  const match = rustRegex(definition.match_command);
  const replacements = definition.replace?.map(rule => ({ ...rule, regex: rustRegex(rule.pattern, true) })) ?? [];
  const outputs = definition.match_output?.map(rule => ({ ...rule, regex: rustRegex(rule.pattern),
    unlessRegex: rule.unless === undefined ? undefined : rustRegex(rule.unless) })) ?? [];
  const strips = definition.strip_lines_matching?.map(pattern => rustRegex(pattern)) ?? [];
  const keeps = definition.keep_lines_matching?.map(pattern => rustRegex(pattern)) ?? [];
  return { match, filter(input: string): string {
    let lines = input === '' ? [] : input.split('\n');
    // str::lines drops CR only as part of CRLF, and ignores one final LF.
    lines = lines.map((line, index) => index < lines.length - 1 && line.endsWith('\r') ? line.slice(0, -1) : line);
    if (input.endsWith('\n')) lines.pop();
    if (definition.strip_ansi) lines = lines.map(line => line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''));
    if (replacements.length) lines = lines.map(line => {
      for (const rule of replacements) line = line.replace(rule.regex,
        (match: string, ...args: unknown[]) => replaceCaptures(rule.replacement, match, args));
      return line;
    });
    if (outputs.length) {
      const blob = lines.join('\n');
      for (const rule of outputs) if (rule.regex.test(blob) && !rule.unlessRegex?.test(blob)) return rule.message;
    }
    if (strips.length) lines = lines.filter(line => !strips.some(regex => regex.test(line)));
    if (keeps.length) lines = lines.filter(line => keeps.some(regex => regex.test(line)));
    const truncate = definition.truncate_lines_at;
    if (truncate !== undefined) lines = lines.map(line => {
      const characters = Array.from(line);
      return characters.length <= truncate ? line : characters.slice(0, Math.max(0, truncate - 3)).join('') + '...';
    });
    const total = lines.length, head = definition.head_lines, tail = definition.tail_lines;
    if (head !== undefined && tail !== undefined) {
      if (total > head + tail) lines = [...lines.slice(0, head), `... (${total - head - tail} lines omitted)`, ...lines.slice(total - tail)];
    } else if (head !== undefined && total > head) {
      lines = [...lines.slice(0, head), `... (${total - head} lines omitted)`];
    } else if (tail !== undefined && total > tail) {
      lines = [`... (${total - tail} lines omitted)`, ...lines.slice(total - tail)];
    }
    const max = definition.max_lines;
    if (max !== undefined && lines.length > max) lines = [...lines.slice(0, max), `... (${lines.length - max} lines truncated)`];
    const result = lines.join('\n');
    return definition.on_empty !== undefined && /^\p{White_Space}*$/u.test(result) ? definition.on_empty : result;
  } };
}

// BTreeMap in the Rust registry gives rule names alphabetical first-match priority.
const registry = Object.entries(rtkRuleDefinitions).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  .map(([name, definition]) => ({ name, ...compileRtkRule(definition) }));
const byName = new Map(registry.map(rule => [rule.name, rule]));

export function matchRtkRule(command: string): string | undefined {
  return registry.find(rule => rule.match.test(command))?.name;
}

export function filterRtkRule(name: string, input: string): string {
  return byName.get(name)?.filter(input) ?? input;
}
