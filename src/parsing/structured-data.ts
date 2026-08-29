import { extractNoteId, normalizeNoteUrl, parseCount } from '../domain/normalize';
import type { NoteRecord, NoteType, ProfileRecord } from '../domain/types';

type JsonRecord = Record<string, unknown>;
type LexicalMode = 'code' | 'single-quote' | 'double-quote' | 'template' | 'line-comment' | 'block-comment';

const MAX_SCRIPT_CHARS = 5_000_000;
const MAX_NOTE_DEPTH = 64;
const MAX_NOTE_ITEMS = 10_000;

export interface StructuredPageResult {
  profile: Partial<ProfileRecord> | null;
  notes: NoteRecord[];
}

const record = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;

const string = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const result = string(value);
    if (result) return result;
  }
  return '';
}

function assignedJson(text: string, start: number): string | null {
  let index = start;
  while (/\s/.test(text[index] ?? '')) index += 1;
  const opening = text[index];
  if (opening !== '{' && opening !== '[') return null;

  const stack: string[] = [];
  let quote = '';
  let escaped = false;
  for (; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if (char === '}' || char === ']') {
      if (stack.pop() !== char) return null;
      if (stack.length === 0) return text.slice(start, index + 1).trim();
    }
  }
  return null;
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

function readInitialState(doc: Document): unknown {
  const marker = 'window.__INITIAL_STATE__';
  for (const script of doc.querySelectorAll('script')) {
    const text = script.textContent ?? '';
    if (text.length > MAX_SCRIPT_CHARS) continue;

    let mode: LexicalMode = 'code';
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index] ?? '';
      const next = text[index + 1] ?? '';
      if (mode === 'line-comment') {
        if (char === '\n' || char === '\r') mode = 'code';
        continue;
      }
      if (mode === 'block-comment') {
        if (char === '*' && next === '/') {
          mode = 'code';
          index += 1;
        }
        continue;
      }
      if (mode !== 'code') {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if ((mode === 'single-quote' && char === "'")
          || (mode === 'double-quote' && char === '"')
          || (mode === 'template' && char === '`')) mode = 'code';
        continue;
      }
      if (char === "'") {
        mode = 'single-quote';
        continue;
      }
      if (char === '"') {
        mode = 'double-quote';
        continue;
      }
      if (char === '`') {
        mode = 'template';
        continue;
      }
      if (char === '/' && next === '/') {
        mode = 'line-comment';
        index += 1;
        continue;
      }
      if (char === '/' && next === '*') {
        mode = 'block-comment';
        index += 1;
        continue;
      }
      if (!text.startsWith(marker, index)) continue;

      let equalsIndex = index + marker.length;
      while (/\s/.test(text[equalsIndex] ?? '')) equalsIndex += 1;
      if (text[equalsIndex] !== '=') continue;
      const source = assignedJson(text, equalsIndex + 1);
      if (!source) continue;
      try {
        return JSON.parse(replaceUndefinedPropertyValues(source)) as unknown;
      } catch {
        // A later assignment can still be valid, so keep scanning this and later scripts.
      }
    }
  }
  return null;
}

function flattenNotes(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];

  const flattened: unknown[] = [];
  const pending: Array<{ values: unknown[]; index: number; depth: number }> = [
    { values: value, index: 0, depth: 0 },
  ];
  while (pending.length > 0 && flattened.length < MAX_NOTE_ITEMS) {
    const current = pending[pending.length - 1];
    if (!current) break;
    if (current.depth >= MAX_NOTE_DEPTH || current.index >= current.values.length) {
      pending.pop();
      continue;
    }
    const child = current.values[current.index];
    current.index += 1;
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
