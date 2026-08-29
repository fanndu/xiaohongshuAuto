import { extractNoteId, normalizeNoteUrl, parseCount } from '../domain/normalize';
import type { CountValue, NoteRecord, NoteType } from '../domain/types';

type NoteInput = Partial<NoteRecord>;

function safeId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : '';
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function count(value: unknown): CountValue {
  if (!value || typeof value !== 'object') return parseCount('');
  return parseCount(string((value as { raw?: unknown }).raw));
}

function type(value: unknown): NoteType {
  return value === 'video' ? 'video' : value === 'image' ? 'image' : 'unknown';
}

function notes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const text = string(item);
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}

function clone(note: NoteRecord): NoteRecord {
  return {
    ...note,
    likes: { ...note.likes },
    exportNotes: [...note.exportNotes],
  };
}

function countStrength(value: CountValue): number {
  if (value.value !== null) return 3;
  if (value.raw === '隐藏') return 2;
  if (value.raw) return 1;
  return 0;
}

function strongestType(left: NoteType, right: NoteType): NoteType {
  if (left === 'video' || right === 'video') return 'video';
  if (left === 'image' || right === 'image') return 'image';
  return 'unknown';
}

/** Keeps one insertion-ordered, immutable-from-callers representation of every note. */
export class NoteStore {
  private readonly records: NoteRecord[] = [];
  private readonly byId = new Map<string, number>();
  private readonly byUrl = new Map<string, number>();

  get size(): number {
    return this.records.length;
  }

  values(): NoteRecord[] {
    return this.records.map(clone);
  }

  addMany(items: readonly NoteInput[]): number {
    let added = 0;
    for (const item of items) {
      const candidate = this.candidate(item);
      if (!candidate) continue;

      const index = (candidate.id ? this.byId.get(candidate.id) : undefined)
        ?? (candidate.noteUrl ? this.byUrl.get(candidate.noteUrl) : undefined);
      if (index === undefined) {
        this.records.push(candidate);
        const newIndex = this.records.length - 1;
        this.index(candidate, newIndex);
        added += 1;
        continue;
      }

      const existing = this.records[index];
      if (!existing) continue;
      const merged = this.merge(existing, candidate);
      this.records[index] = merged;
      this.index(merged, index);
    }
    return added;
  }

  private candidate(item: NoteInput): NoteRecord | null {
    const noteUrl = normalizeNoteUrl(string(item.noteUrl));
    const explicitId = safeId(item.id);
    const urlId = safeId(extractNoteId(noteUrl));
    const id = explicitId || urlId;
    if (!id && !noteUrl) return null;

    return {
      id,
      title: string(item.title),
      noteUrl,
      type: type(item.type),
      likes: count(item.likes),
      coverUrl: string(item.coverUrl),
      exportNotes: notes(item.exportNotes),
    };
  }

  private index(record: NoteRecord, index: number): void {
    if (record.id) this.byId.set(record.id, index);
    if (record.noteUrl) this.byUrl.set(record.noteUrl, index);
  }

  private merge(existing: NoteRecord, later: NoteRecord): NoteRecord {
    return {
      // Identity fields are deliberately first-seen and therefore stable.
      id: existing.id || later.id,
      noteUrl: existing.noteUrl || later.noteUrl,
      title: later.title || existing.title,
      type: strongestType(existing.type, later.type),
      likes: countStrength(later.likes) >= countStrength(existing.likes)
        ? { ...later.likes }
        : { ...existing.likes },
      coverUrl: later.coverUrl || existing.coverUrl,
      exportNotes: [...new Set([...existing.exportNotes, ...later.exportNotes])],
    };
  }
}
