import { parse } from 'acorn-loose';
import type { Node } from 'acorn';
import { extractNoteId, normalizeNoteUrl, parseCount } from '../domain/normalize';
import type { NoteRecord, NoteType, ProfileRecord } from '../domain/types';

type JsonRecord = Record<string, unknown>;

const MAX_SCRIPT_CHARS = 5_000_000;
const MAX_NOTE_DEPTH = 64;
const MAX_NOTE_VISITS = 10_000;
const MAX_NOTE_RECORDS = 10_000;

export interface StructuredPageResult {
  profile: Partial<ProfileRecord> | null;
  notes: NoteRecord[];
}

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

function readInitialState(doc: Document): unknown {
  let latestState: unknown = null;
  for (const script of doc.querySelectorAll('script')) {
    const source = script.textContent ?? '';
    if (source.length > MAX_SCRIPT_CHARS) continue;
    const state = lastStateFromScript(source);
    if (state !== null) latestState = state;
  }
  return latestState;
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
  const source = record(value);
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
  const state = readInitialState(doc);
  const page = record(record(state)?.user);
  const userPageData = record(page?.userPageData);
  if (!userPageData) return { profile: null, notes: [] };

  const basic = record(userPageData.basicInfo) ?? {};
  const interactions = Array.isArray(userPageData.interactions)
    ? userPageData.interactions.map(record).filter((item): item is JsonRecord => item !== null)
    : [];
  const countFor = (type: string) => parseCount(string(interactions.find(item => item.type === type)?.count));

  return {
    profile: {
      profileUrl,
      accountName: string(basic.nickname),
      redId: string(basic.redId),
      avatarUrl: firstString(basic.imageb, basic.images),
      description: string(basic.desc),
      ipLocation: string(basic.ipLocation),
      following: countFor('follows'),
      followers: countFor('fans'),
      likedAndCollected: countFor('interaction'),
      exportNotes: [],
    },
    notes: flattenNotes(userPageData.notes)
      .map(safelyMapNote)
      .filter((item): item is NoteRecord => item !== null),
  };
}
