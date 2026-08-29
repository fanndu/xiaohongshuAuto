import { extractNoteId, normalizeNoteUrl, parseCount } from '../domain/normalize';
import type { NoteRecord, NoteType, ProfileRecord } from '../domain/types';

type JsonRecord = Record<string, unknown>;

export interface StructuredPageResult {
  profile: Partial<ProfileRecord> | null;
  notes: NoteRecord[];
}

const record = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;

const string = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const flattenNotes = (value: unknown): unknown[] =>
  Array.isArray(value) ? value.flatMap(item => Array.isArray(item) ? flattenNotes(item) : [item]) : [];

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
  let quote = '';
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (quote) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
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
    let markerIndex = text.indexOf(marker);
    while (markerIndex >= 0) {
      let equalsIndex = markerIndex + marker.length;
      while (/\s/.test(text[equalsIndex] ?? '')) equalsIndex += 1;
      if (text[equalsIndex] === '=') {
        const source = assignedJson(text, equalsIndex + 1);
        if (!source) return null;
        try {
          return JSON.parse(replaceUndefinedPropertyValues(source)) as unknown;
        } catch {
          return null;
        }
      }
      markerIndex = text.indexOf(marker, markerIndex + marker.length);
    }
  }
  return null;
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

  const explicitUrl = normalizeNoteUrl(string(source.url));
  const sourceId = string(source.id ?? source.noteId);
  const id = sourceId || extractNoteId(explicitUrl);
  // An off-domain or malformed explicit URL falls back only when the state supplies a note id.
  const noteUrl = explicitUrl || generatedNoteUrl(id);
  if (!noteUrl || !id) return null;

  const cover = record(source.cover);
  const interactInfo = record(source.interactInfo);
  return {
    id,
    title: string(source.displayTitle ?? source.title),
    noteUrl,
    type: noteType(source.type),
    likes: parseCount(string(interactInfo?.likedCount ?? source.likedCount)),
    coverUrl: string(cover?.urlDefault ?? cover?.urlPre ?? source.coverUrl),
    exportNotes: [],
  };
}

export function parseStructuredPage(doc: Document, profileUrl: string): StructuredPageResult {
  const state = readInitialState(doc);
  try {
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
        avatarUrl: string(basic.imageb) || string(basic.images),
        description: string(basic.desc),
        ipLocation: string(basic.ipLocation),
        following: countFor('follows'),
        followers: countFor('fans'),
        likedAndCollected: countFor('interaction'),
        exportNotes: [],
      },
      notes: flattenNotes(userPageData.notes)
        .map(mapNote)
        .filter((item): item is NoteRecord => item !== null),
    };
  } catch {
    return { profile: null, notes: [] };
  }
}
