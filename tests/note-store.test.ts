import { describe, expect, it } from 'vitest';
import { NoteStore } from '../src/collection/note-store';
import type { NoteRecord } from '../src/domain/types';

const note = (overrides: Partial<NoteRecord> = {}): NoteRecord => ({
  id: '',
  title: '',
  noteUrl: '',
  type: 'unknown',
  likes: { raw: '', value: null },
  coverUrl: '',
  exportNotes: [],
  ...overrides,
});

describe('NoteStore', () => {
  it('deduplicates a matching explicit ID without changing insertion order', () => {
    const store = new NoteStore();

    expect(store.addMany([
      note({ id: 'note-1', noteUrl: 'https://www.xiaohongshu.com/explore/note-1', title: 'first' }),
      note({ id: 'note-2', noteUrl: 'https://www.xiaohongshu.com/explore/note-2', title: 'second' }),
      note({ id: 'note-1', title: 'updated' }),
    ])).toBe(2);
    expect(store.values().map(({ id, title }) => ({ id, title }))).toEqual([
      { id: 'note-1', title: 'updated' },
      { id: 'note-2', title: 'second' },
    ]);
    expect(store.size).toBe(2);
  });

  it('unifies an ID-only record with a URL that contains that ID', () => {
    const store = new NoteStore();

    expect(store.addMany([note({ id: 'same-id', title: 'from API' })])).toBe(1);
    expect(store.addMany([note({
      noteUrl: 'https://www.xiaohongshu.com/discovery/item/same-id/?from=feed',
      coverUrl: 'https://img.example/cover.jpg',
    })])).toBe(0);
    expect(store.values()).toMatchObject([{
      id: 'same-id',
      noteUrl: 'https://www.xiaohongshu.com/discovery/item/same-id',
      title: 'from API',
      coverUrl: 'https://img.example/cover.jpg',
    }]);
  });

  it('deduplicates normalized query and hash URL variants when no note ID is available', () => {
    const store = new NoteStore();

    expect(store.addMany([
      note({ noteUrl: 'https://www.xiaohongshu.com/user/profile/a?from=feed#top' }),
      note({ noteUrl: 'https://www.xiaohongshu.com/user/profile/a/' }),
    ])).toBe(1);
    expect(store.values()[0]?.noteUrl).toBe('https://www.xiaohongshu.com/user/profile/a');
  });

  it('enriches duplicates while keeping stable identifiers and monotonic type evidence', () => {
    const store = new NoteStore();

    store.addMany([note({
      id: 'rich-note',
      noteUrl: 'https://www.xiaohongshu.com/explore/rich-note',
      type: 'unknown',
      exportNotes: ['first warning'],
    })]);
    store.addMany([note({
      id: 'rich-note',
      title: 'A title',
      type: 'image',
      likes: { raw: '12', value: 12 },
      coverUrl: 'https://img.example/cover.jpg',
      exportNotes: ['first warning', 'second warning'],
    })]);
    expect(store.values()[0]?.type).toBe('image');
    store.addMany([note({
      id: 'rich-note',
      type: 'video',
      title: 'Later title',
      likes: { raw: '13', value: 13 },
      coverUrl: 'https://img.example/later-cover.jpg',
    })]);

    expect(store.values()).toEqual([note({
      id: 'rich-note',
      noteUrl: 'https://www.xiaohongshu.com/explore/rich-note',
      title: 'Later title',
      type: 'video',
      likes: { raw: '13', value: 13 },
      coverUrl: 'https://img.example/later-cover.jpg',
      exportNotes: ['first warning', 'second warning'],
    })]);
  });

  it('keeps the strongest count evidence while allowing later equally strong values', () => {
    const numeric = new NoteStore();
    numeric.addMany([note({ id: 'count', likes: { raw: '12', value: 12 } })]);
    numeric.addMany([note({ id: 'count', likes: { raw: '隐藏', value: null } })]);
    numeric.addMany([note({ id: 'count', likes: { raw: 'not-a-count', value: null } })]);
    expect(numeric.values()[0]?.likes).toEqual({ raw: '12', value: 12 });
    numeric.addMany([note({ id: 'count', likes: { raw: '13', value: 13 } })]);
    expect(numeric.values()[0]?.likes).toEqual({ raw: '13', value: 13 });

    const hidden = new NoteStore();
    hidden.addMany([note({ id: 'hidden', likes: { raw: '隐藏', value: null } })]);
    hidden.addMany([note({ id: 'hidden', likes: { raw: '8', value: 8 } })]);
    expect(hidden.values()[0]?.likes).toEqual({ raw: '8', value: 8 });

    const empty = new NoteStore();
    empty.addMany([note({ id: 'empty', likes: { raw: '', value: null } })]);
    empty.addMany([note({ id: 'empty', likes: { raw: 'not-a-count', value: null } })]);
    expect(empty.values()[0]?.likes).toEqual({ raw: 'not-a-count', value: null });
  });

  it('skips records without a safe ID or valid xiaohongshu URL', () => {
    const store = new NoteStore();

    expect(store.addMany([
      note({ id: 'has spaces' }),
      note({ noteUrl: 'https://example.com/explore/not-ours' }),
      note({ id: 'valid_id' }),
    ])).toBe(1);
    expect(store.values().map(item => item.id)).toEqual(['valid_id']);
  });

  it('does not mutate caller records or arrays', () => {
    const source = note({
      id: 'immutable',
      noteUrl: 'https://www.xiaohongshu.com/explore/immutable?token=secret',
      likes: { raw: '2.3万', value: 23000 },
      exportNotes: ['warning'],
    });
    const input = [source];
    const store = new NoteStore();

    store.addMany(input);

    expect(source).toEqual(note({
      id: 'immutable',
      noteUrl: 'https://www.xiaohongshu.com/explore/immutable?token=secret',
      likes: { raw: '2.3万', value: 23000 },
      exportNotes: ['warning'],
    }));
    expect(input).toEqual([source]);

    const snapshot = store.values();
    snapshot[0]!.title = 'changed outside';
    snapshot[0]!.exportNotes.push('outside');
    expect(store.values()[0]).toMatchObject({ title: '', exportNotes: ['warning'] });
  });
});
