import { parse } from 'acorn-loose';
import type { Node } from 'acorn';
import { extractNoteId, normalizeNoteUrl, parseCount } from '../domain/normalize';
import type { NoteRecord, NoteType, ProfileRecord } from '../domain/types';

type JsonRecord = Record<string, unknown>;

const MAX_SCRIPT_CHARS = 5_000_000;
const MAX_CANDIDATE_SCRIPTS = 32;
const MAX_CANDIDATE_SCRIPT_CHARS = 8_000_000;
const MAX_NOTE_DEPTH = 64;
const MAX_NOTE_VISITS = 10_000;
const MAX_NOTE_RECORDS = 10_000;

export interface StructuredPageResult {
  /** Explicit, stable page identity. Never inferred from a red ID or display name. */
  userId: string;
  identityStatus: 'missing' | 'valid' | 'conflict' | 'budget_exhausted';
  hasProfileEvidence: boolean;
  hasNotesContainer: boolean;
  profile: Partial<ProfileRecord> | null;
  notes: NoteRecord[];
}

/** Bounded input limits for untrusted embedded application state. */
export const STRUCTURED_STATE_LIMITS = {
  maxScriptChars: MAX_SCRIPT_CHARS,
  maxCandidateScripts: MAX_CANDIDATE_SCRIPTS,
  maxCandidateScriptChars: MAX_CANDIDATE_SCRIPT_CHARS,
} as const;

interface CachedScriptParse {
  source: string;
  state: unknown;
}

let parsedScriptCount = 0;
let scriptParseCache = new WeakMap<HTMLScriptElement, CachedScriptParse>();

/** Test-only observability; production parsing behavior is unchanged by this seam. */
export const structuredStateTestHooks = {
  reset(): void {
    parsedScriptCount = 0;
    scriptParseCache = new WeakMap<HTMLScriptElement, CachedScriptParse>();
  },
  parseCalls(): number {
    return parsedScriptCount;
  },
};

const record = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;

const string = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

function hasUserPageData(value: unknown): boolean {
  return record(record(record(value)?.user)?.userPageData) !== null;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const result = string(value);
    if (result) return result;
  }
  return '';
}

function replaceUndefinedPropertyValues(source: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ':') {
      let valueStart = index + 1;
      while (/\s/.test(source[valueStart] ?? '')) valueStart += 1;
      const valueEnd = valueStart + 'undefined'.length;
      let next = valueEnd;
      while (/\s/.test(source[next] ?? '')) next += 1;
      if (source.slice(valueStart, valueEnd) === 'undefined'
        && (source[next] === ',' || source[next] === '}')) {
        output += ':null';
        index = valueEnd - 1;
        continue;
      }
    }
    output += char;
  }
  return output;
}

function isNode(value: unknown): value is Node {
  const candidate = record(value);
  return candidate !== null && typeof candidate.type === 'string'
    && typeof candidate.start === 'number' && typeof candidate.end === 'number';
}

function childNodes(node: Node): Node[] {
  const children: Node[] = [];
  for (const value of Object.values(node)) {
    if (isNode(value)) children.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) children.push(item);
    }
  }
  return children;
}

function initialStateRightHand(node: Node): Node | null {
  const assignment = node as Node & { operator?: unknown; left?: unknown; right?: unknown };
  if (assignment.type !== 'AssignmentExpression' || assignment.operator !== '=' || !isNode(assignment.left)
    || !isNode(assignment.right) || assignment.left.type !== 'MemberExpression') return null;

  const left = assignment.left as Node & { computed?: unknown; object?: unknown; property?: unknown };
  if (left.computed === true || !isNode(left.object) || !isNode(left.property)) return null;
  const object = left.object as Node & { name?: unknown };
  const property = left.property as Node & { name?: unknown };
  return object.type === 'Identifier' && object.name === 'window'
    && property.type === 'Identifier' && property.name === '__INITIAL_STATE__'
    ? assignment.right
    : null;
}

function lastStateFromScript(source: string): unknown {
  parsedScriptCount += 1;
  let program: Node;
  try {
    program = parse(source, { ecmaVersion: 'latest' });
  } catch {
    return null;
  }

  let latest: { start: number; state: unknown } | null = null;
  const pending: Node[] = [program];
  // The parser has already built the complete AST; a post-parse visit cap harms recovery without bounding parse cost.
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;

    const rightHand = initialStateRightHand(node);
    if (rightHand) {
      try {
        const state = JSON.parse(replaceUndefinedPropertyValues(source.slice(rightHand.start, rightHand.end))) as unknown;
        if (hasUserPageData(state) && (latest === null || node.start >= latest.start)) {
          latest = { start: node.start, state };
        }
      } catch {
        // Invalid JSON is not state; retain an earlier shape-valid assignment if present.
      }
    }

    const children = childNodes(node).sort((left, right) => left.start - right.start || left.end - right.end);
    // Pushing source-order children makes the stack pop the latest source node first.
    for (const child of children) pending.push(child);
  }
  return latest?.state ?? null;
}

function skipQuoted(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') index += 2;
    else if (source[index] === quote) return index + 1;
    else index += 1;
  }
  return source.length;
}

function skipRegex(source: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const char = source[index] ?? '';
    if (char === '\\') index += 2;
    else if (char === '[') { inClass = true; index += 1; }
    else if (char === ']') { inClass = false; index += 1; }
    else if (char === '/' && !inClass) {
      index += 1;
      while (/[a-z]/i.test(source[index] ?? '')) index += 1;
      return index;
    } else if (/\r|\n/.test(char)) return start + 1;
    else index += 1;
  }
  return start + 1;
}

/** Detects an assignment token outside quoted/comment/regex payloads without executing script text. */
function hasInitialStateAssignment(source: string): boolean {
  for (let index = 0; index < source.length;) {
    const char = source[index] ?? '';
    if (char === '"' || char === "'" || char === '`') { index = skipQuoted(source, index, char); continue; }
    if (char === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index + 2);
      index = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === '/') {
      const end = skipRegex(source, index);
      if (end > index + 1) { index = end; continue; }
    }
    const previous = source[index - 1] ?? '';
    const standaloneWindow = !/[\p{ID_Continue}$\u200C\u200D.]/u.test(previous);
    if (standaloneWindow && source.startsWith('window', index)
      && /^window\s*\.\s*__INITIAL_STATE__\s*=/.test(source.slice(index))) return true;
    index += 1;
  }
  return false;
}

function readInitialState(doc: Document): { state: unknown; budgetExhausted: boolean } {
  const candidates: Array<{ script: HTMLScriptElement; source: string }> = [];
  let candidateChars = 0;
  for (const script of doc.querySelectorAll('script')) {
    const source = script.textContent ?? '';
    // This constant-memory lexical pass distinguishes a real oversized assignment from a literal/comment decoy.
    if (!hasInitialStateAssignment(source)) continue;
    if (source.length > MAX_SCRIPT_CHARS) return { state: null, budgetExhausted: true };
    if (candidates.length >= MAX_CANDIDATE_SCRIPTS || candidateChars + source.length > MAX_CANDIDATE_SCRIPT_CHARS) {
      return { state: null, budgetExhausted: true };
    }
    candidateChars += source.length;
    candidates.push({ script, source });
  }
  // Newest candidate wins; an invalid newest assignment falls back to an earlier valid one.
  for (const { script, source } of candidates.reverse()) {
    const cached = scriptParseCache.get(script);
    const state = cached?.source === source ? cached.state : lastStateFromScript(source);
    if (!cached || cached.source !== source) scriptParseCache.set(script, { source, state });
    if (state !== null) return { state, budgetExhausted: false };
  }
  return { state: null, budgetExhausted: false };
}

function flattenNotes(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];

  const flattened: unknown[] = [];
  const pending: Array<{ values: unknown[]; index: number; depth: number }> = [
    { values: value, index: 0, depth: 0 },
  ];
  // The root note array is a visited node too, so it consumes one unit of work.
  let visits = 1;
  while (pending.length > 0 && visits < MAX_NOTE_VISITS && flattened.length < MAX_NOTE_RECORDS) {
    const current = pending[pending.length - 1];
    if (!current) break;
    if (current.depth >= MAX_NOTE_DEPTH || current.index >= current.values.length) {
      pending.pop();
      continue;
    }
    const child = current.values[current.index];
    current.index += 1;
    visits += 1;
    if (Array.isArray(child)) pending.push({ values: child, index: 0, depth: current.depth + 1 });
    else flattened.push(child);
  }
  return flattened;
}

function noteType(value: unknown): NoteType {
  const type = string(value).toLowerCase();
  return type === 'video' ? 'video' : type === 'normal' || type === 'image' ? 'image' : 'unknown';
}

function generatedNoteUrl(id: string): string {
  const noteUrl = normalizeNoteUrl(id ? `/explore/${id}` : '');
  return extractNoteId(noteUrl) === id ? noteUrl : '';
}

function mapNote(value: unknown): NoteRecord | null {
  const source = record(record(value)?.noteCard) ?? record(value);
  if (!source) return null;

  const suppliedId = firstString(source.id, source.noteId);
  const explicitUrl = normalizeNoteUrl(string(source.url));
  const explicitId = extractNoteId(explicitUrl);
  if (suppliedId && explicitId && suppliedId !== explicitId) return null;

  const id = suppliedId || explicitId;
  const noteUrl = explicitId ? explicitUrl : generatedNoteUrl(suppliedId);
  if (!id || !noteUrl || extractNoteId(noteUrl) !== id) return null;

  const cover = record(source.cover);
  const interactInfo = record(source.interactInfo);
  return {
    id,
    title: firstString(source.displayTitle, source.title),
    noteUrl,
    type: noteType(source.type),
    likes: parseCount(firstString(interactInfo?.likedCount, source.likedCount)),
    coverUrl: firstString(cover?.urlDefault, cover?.urlPre, source.coverUrl),
    exportNotes: [],
  };
}

function safelyMapNote(value: unknown): NoteRecord | null {
  try {
    return mapNote(value);
  } catch {
    return null;
  }
}

export function parseStructuredPage(doc: Document, profileUrl: string): StructuredPageResult {
  const read = readInitialState(doc);
  const page = record(record(read.state)?.user);
  const userPageData = record(page?.userPageData);
  if (!userPageData) return {
    userId: '', identityStatus: read.budgetExhausted ? 'budget_exhausted' : 'missing',
    hasProfileEvidence: false, hasNotesContainer: false, profile: null, notes: [],
  };

  const basic = record(userPageData.basicInfo);
  const interactions = Array.isArray(userPageData.interactions)
    ? userPageData.interactions.map(record).filter((item): item is JsonRecord => item !== null)
    : [];
  const countFor = (type: string) => parseCount(string(interactions.find(item => item.type === type)?.count));

  const identities = new Set([basic?.userId, userPageData.userId, page?.userId].map(string).filter(Boolean));
  const identityStatus = read.budgetExhausted ? 'budget_exhausted'
    : identities.size > 1 ? 'conflict' : identities.size === 1 ? 'valid' : 'missing';
  const userId = identityStatus === 'valid' ? [...identities][0] ?? '' : '';
  const noteContainers = [userPageData.notes, page?.notes].filter(Array.isArray);
  return {
    userId,
    identityStatus,
    hasProfileEvidence: Boolean(basic && (string(basic.nickname) || string(basic.redId)
      || firstString(basic.imageb, basic.images))),
    hasNotesContainer: noteContainers.length > 0,
    profile: {
      profileUrl,
      accountName: string(basic?.nickname),
      redId: string(basic?.redId),
      avatarUrl: firstString(basic?.imageb, basic?.images),
      description: string(basic?.desc),
      ipLocation: string(basic?.ipLocation),
      following: countFor('follows'),
      followers: countFor('fans'),
      likedAndCollected: countFor('interaction'),
      exportNotes: [],
    },
    notes: noteContainers.flatMap(flattenNotes)
      .map(safelyMapNote)
      .filter((item): item is NoteRecord => item !== null),
  };
}
