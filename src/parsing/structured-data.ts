import { parse } from 'acorn-loose';
import { tokenizer } from 'acorn';
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

interface CachedClassification {
  source: string;
  classification: CandidateClassification;
}

let parsedScriptCount = 0;
let scriptParseCache = new WeakMap<HTMLScriptElement, CachedScriptParse>();
let tokenizedScriptCount = 0;
let classificationCache = new WeakMap<HTMLScriptElement, CachedClassification>();

/** Test-only observability; production parsing behavior is unchanged by this seam. */
export const structuredStateTestHooks = {
  reset(): void {
    parsedScriptCount = 0;
    scriptParseCache = new WeakMap<HTMLScriptElement, CachedScriptParse>();
    tokenizedScriptCount = 0;
    classificationCache = new WeakMap<HTMLScriptElement, CachedClassification>();
  },
  parseCalls(): number {
    return parsedScriptCount;
  },
  tokenizeCalls(): number {
    return tokenizedScriptCount;
  },
};

function rawRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

/** Reads only own data properties, so reactive wrappers and hostile getters cannot execute here. */
function own(value: JsonRecord | null, key: string): unknown {
  if (!value) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function hasOwn(value: JsonRecord | null, key: string): boolean {
  if (!value) return false;
  try {
    return Object.prototype.hasOwnProperty.call(value, key);
  } catch {
    return false;
  }
}

function ownKeys(value: JsonRecord | null): string[] {
  if (!value) return [];
  try {
    return Object.keys(value);
  } catch {
    return [];
  }
}

/** Conservative Vue-style ref unwrapping, bounded and limited to own data properties. */
function unwrap(value: unknown): unknown {
  let current = value;
  const seen = new Set<object>();
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = rawRecord(current);
    if (!candidate || seen.has(candidate)) break;
    seen.add(candidate);
    let next: unknown = undefined;
    for (const key of ['_rawValue', '_value', 'value']) {
      if (hasOwn(candidate, key)) {
        next = own(candidate, key);
        break;
      }
    }
    if (next === undefined) break;
    current = next;
  }
  return current;
}

const record = (value: unknown): JsonRecord | null => rawRecord(unwrap(value));

const string = (value: unknown): string => typeof unwrap(value) === 'string' ? (unwrap(value) as string).trim() : '';

function hasUserPageData(value: unknown): boolean {
  const page = record(own(record(value), 'user'));
  return record(own(page, 'userPageData')) !== null;
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

type CandidateClassification = 'candidate' | 'none' | 'ambiguous';

/** Uses Acorn's lexer only: comments, regexes, templates, and division are classified without an AST. */
function classifyInitialStateCandidate(source: string): CandidateClassification {
  if (!source.includes('__INITIAL_STATE__')) return 'none';
  try {
    tokenizedScriptCount += 1;
    const tokens = tokenizer(source, { ecmaVersion: 'latest' });
    const recent: Array<{ label: string; value: unknown }> = [];
    let found = false;
    const isName = (token: { label: string; value: unknown }, expected: string) =>
      token.label === 'name' && token.value === expected;
    const notMemberTarget = (before: { label: string; value: unknown } | undefined) =>
      before?.label !== '.' && before?.label !== '?.';
    const direct = (): boolean => {
      const start = recent.length - 4;
      return start >= 0 && isName(recent[start]!, 'window') && recent[start + 1]?.label === '.'
        && isName(recent[start + 2]!, '__INITIAL_STATE__') && recent[start + 3]?.label === '='
        && notMemberTarget(recent[start - 1]);
    };
    const wrappedWindow = (): boolean => {
      const start = recent.length - 6;
      return start >= 0 && recent[start]?.label === '(' && isName(recent[start + 1]!, 'window')
        && recent[start + 2]?.label === ')' && recent[start + 3]?.label === '.'
        && isName(recent[start + 4]!, '__INITIAL_STATE__') && recent[start + 5]?.label === '='
        && notMemberTarget(recent[start - 1]);
    };
    const wrappedMember = (): boolean => {
      const start = recent.length - 6;
      return start >= 0 && recent[start]?.label === '(' && isName(recent[start + 1]!, 'window')
        && recent[start + 2]?.label === '.' && isName(recent[start + 3]!, '__INITIAL_STATE__')
        && recent[start + 4]?.label === ')' && recent[start + 5]?.label === '='
        && notMemberTarget(recent[start - 1]);
    };
    for (;;) {
      const token = tokens.getToken();
      const label = token.type.label;
      if (label === 'eof') return found ? 'candidate' : 'none';
      recent.push({ label, value: (token as { value?: unknown }).value });
      if (recent.length > 7) recent.shift();
      if (direct() || wrappedWindow() || wrappedMember()) found = true;
    }
  } catch {
    // A marker-bearing script that cannot be lexed is unsafe to classify as an older route's state.
    return 'ambiguous';
  }
}

function readInitialState(doc: Document): { state: unknown; budgetExhausted: boolean } {
  const candidates: Array<{ script: HTMLScriptElement; source: string }> = [];
  let candidateChars = 0;
  for (const script of doc.querySelectorAll('script')) {
    const source = script.textContent ?? '';
    const cached = classificationCache.get(script);
    const classification = cached?.source === source
      ? cached.classification : classifyInitialStateCandidate(source);
    if (!cached || cached.source !== source) classificationCache.set(script, { source, classification });
    if (classification === 'ambiguous') return { state: null, budgetExhausted: true };
    if (classification === 'none') continue;
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

function supportedNotesContainer(value: unknown): boolean {
  const unwrapped = unwrap(value);
  if (Array.isArray(unwrapped)) return true;
  const container = rawRecord(unwrapped);
  return Boolean(container && ownKeys(container).some(key => /^\d+$/.test(key)));
}

function flattenNotes(value: unknown): unknown[] {
  const flattened: unknown[] = [];
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visits = 0;
  while (pending.length > 0 && visits < MAX_NOTE_VISITS && flattened.length < MAX_NOTE_RECORDS) {
    const current = pending.pop();
    if (!current || current.depth >= MAX_NOTE_DEPTH) continue;
    visits += 1;
    const child = unwrap(current.value);
    const candidate = rawRecord(child);
    if (candidate && (hasOwn(candidate, 'noteCard') || hasOwn(candidate, 'id') || hasOwn(candidate, 'noteId') || hasOwn(candidate, 'url'))) {
      flattened.push(child);
      continue;
    }
    const children = Array.isArray(child) ? child : candidate
      ? ownKeys(candidate).filter(key => /^\d+$/.test(key)).sort((left, right) => Number(left) - Number(right)).map(key => own(candidate, key))
      : [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ value: children[index], depth: current.depth + 1 });
    }
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

function noteIdentity(source: JsonRecord): string[] {
  const author = record(own(source, 'author'));
  const user = record(own(source, 'user'));
  return [own(source, 'userId'), own(source, 'authorId'), own(author, 'userId'), own(user, 'userId')]
    .map(string).filter(Boolean);
}

function coverUrl(cover: JsonRecord | null): string {
  const infoList = unwrap(own(cover, 'infoList'));
  const infoUrl = Array.isArray(infoList)
    ? firstString(...infoList.slice(0, 10).map(item => own(record(item), 'url')))
    : '';
  return firstString(own(cover, 'urlDefault'), own(cover, 'urlPre'), own(cover, 'url'), own(cover, 'url_default'), infoUrl);
}

function mapNote(value: unknown, expectedIdentity: string): { note: NoteRecord | null; conflict: boolean } {
  const wrapper = record(value);
  const card = record(own(wrapper, 'noteCard'));
  const source = card ?? wrapper;
  if (!source) return { note: null, conflict: false };
  const identities = [...(wrapper ? noteIdentity(wrapper) : []), ...noteIdentity(source)];
  if (expectedIdentity && identities.some(identity => identity !== expectedIdentity)) return { note: null, conflict: true };

  const suppliedId = firstString(own(wrapper, 'id'), own(wrapper, 'noteId'), own(source, 'id'), own(source, 'noteId'));
  const explicitUrl = normalizeNoteUrl(firstString(own(wrapper, 'url'), own(source, 'url')));
  const explicitId = extractNoteId(explicitUrl);
  if (suppliedId && explicitId && suppliedId !== explicitId) return { note: null, conflict: false };

  const id = suppliedId || explicitId;
  const noteUrl = explicitId ? explicitUrl : generatedNoteUrl(suppliedId);
  if (!id || !noteUrl || extractNoteId(noteUrl) !== id) return { note: null, conflict: false };

  const cover = record(own(source, 'cover')) ?? record(own(wrapper, 'cover'));
  const interactInfo = record(own(source, 'interactInfo')) ?? record(own(wrapper, 'interactInfo'));
  return { note: {
    id,
    title: firstString(own(source, 'displayTitle'), own(source, 'title'), own(wrapper, 'displayTitle'), own(wrapper, 'title')),
    noteUrl,
    type: noteType(firstString(own(source, 'type'), own(wrapper, 'type'))),
    likes: parseCount(firstString(own(interactInfo, 'likedCount'), own(source, 'likedCount'), own(wrapper, 'likedCount'))),
    coverUrl: firstString(coverUrl(cover), own(source, 'coverUrl'), own(wrapper, 'coverUrl')),
    exportNotes: [],
  }, conflict: false };
}

function safelyMapNote(value: unknown, expectedIdentity: string): { note: NoteRecord | null; conflict: boolean } {
  try {
    return mapNote(value, expectedIdentity);
  } catch {
    return { note: null, conflict: false };
  }
}

export function parseStructuredPage(doc: Document, profileUrl: string): StructuredPageResult {
  const read = readInitialState(doc);
  const page = record(own(record(read.state), 'user'));
  const userPageData = record(own(page, 'userPageData'));
  if (!userPageData) return {
    userId: '', identityStatus: read.budgetExhausted ? 'budget_exhausted' : 'missing',
    hasProfileEvidence: false, hasNotesContainer: false, profile: null, notes: [],
  };

  const basic = record(own(userPageData, 'basicInfo'));
  const interactionList = unwrap(own(userPageData, 'interactions'));
  const interactions = Array.isArray(interactionList)
    ? interactionList.map(record).filter((item): item is JsonRecord => item !== null)
    : [];
  const countFor = (type: string) => parseCount(string(own(interactions.find(item => string(own(item, 'type')) === type) ?? null, 'count')));

  const identities = new Set([own(basic, 'userId'), own(userPageData, 'userId'), own(page, 'userId')].map(string).filter(Boolean));
  const identityStatus = read.budgetExhausted ? 'budget_exhausted'
    : identities.size > 1 ? 'conflict' : identities.size === 1 ? 'valid' : 'missing';
  const userId = identityStatus === 'valid' ? [...identities][0] ?? '' : '';
  const pageNotesExplicit = hasOwn(userPageData, 'notes');
  const pageNotes = own(userPageData, 'notes');
  const siblingNotes = own(page, 'notes');
  const parentIdentity = string(own(page, 'userId'));
  const selectedNotes = pageNotesExplicit && supportedNotesContainer(pageNotes) ? pageNotes
    : !pageNotesExplicit && Boolean(userId) && Boolean(parentIdentity) && parentIdentity === userId
      && supportedNotesContainer(siblingNotes) ? siblingNotes
      : undefined;
  const mappedNotes = identityStatus !== 'conflict' && identityStatus !== 'budget_exhausted' && selectedNotes !== undefined
    ? flattenNotes(selectedNotes).map(note => safelyMapNote(note, userId)) : [];
  const noteConflict = mappedNotes.some(result => result.conflict);
  return {
    userId: noteConflict ? '' : userId,
    identityStatus: noteConflict ? 'conflict' : identityStatus,
    hasProfileEvidence: Boolean(basic && (string(own(basic, 'nickname')) || string(own(basic, 'redId'))
      || firstString(own(basic, 'imageb'), own(basic, 'images')))),
    hasNotesContainer: selectedNotes !== undefined,
    profile: {
      profileUrl,
      accountName: string(own(basic, 'nickname')),
      redId: string(own(basic, 'redId')),
      avatarUrl: firstString(own(basic, 'imageb'), own(basic, 'images')),
      description: string(own(basic, 'desc')),
      ipLocation: string(own(basic, 'ipLocation')),
      following: countFor('follows'),
      followers: countFor('fans'),
      likedAndCollected: countFor('interaction'),
      exportNotes: [],
    },
    notes: noteConflict ? [] : mappedNotes.map(result => result.note)
      .filter((item): item is NoteRecord => item !== null),
  };
}
