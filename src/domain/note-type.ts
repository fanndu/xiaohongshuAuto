import type { NoteType } from './types';

export const NOTE_TYPE_CONFLICT = '作品类型证据冲突';

function positive(type: NoteType): type is 'image' | 'video' {
  return type === 'image' || type === 'video';
}

/** Merges positive media evidence without ever guessing through a contradiction. */
export function mergeNoteType(
  left: NoteType,
  right: NoteType,
  leftNotes: readonly string[] = [],
  rightNotes: readonly string[] = [],
): { type: NoteType; conflict: boolean } {
  const conflict = leftNotes.includes(NOTE_TYPE_CONFLICT) || rightNotes.includes(NOTE_TYPE_CONFLICT)
    || (positive(left) && positive(right) && left !== right);
  if (conflict) return { type: 'unknown', conflict: true };
  return { type: positive(left) ? left : positive(right) ? right : 'unknown', conflict: false };
}

export function mergedExportNotes(
  left: readonly string[],
  right: readonly string[],
  conflict: boolean,
): string[] {
  return [...new Set([...left, ...right, ...(conflict ? [NOTE_TYPE_CONFLICT] : [])])];
}
