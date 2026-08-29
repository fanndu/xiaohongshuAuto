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

  it('coalesces separately indexed ID and URL records when a bridge arrives', () => {
    const store = new NoteStore();
    store.addMany([
      note({ id: 'bridge-id', title: 'earliest', exportNotes: ['ID evidence'] }),
      note({ noteUrl: 'https://www.xiaohongshu.com/user/profile/bridge-url', coverUrl: 'https://img.example/cover.jpg' }),
    ]);

    expect(store.addMany([note({
      id: 'bridge-id',
      noteUrl: 'https://www.xiaohongshu.com/user/profile/bridge-url',
      title: 'bridge title',
      type: 'video',
      exportNotes: ['bridge evidence'],
    })])).toBe(0);
    expect(store.values()).toEqual([note({
      id: 'bridge-id',
      noteUrl: 'https://www.xiaohongshu.com/user/profile/bridge-url',
      title: 'bridge title',
      type: 'video',
      coverUrl: 'https://img.example/cover.jpg',
      exportNotes: ['ID evidence', 'bridge evidence'],
    })]);
    expect(store.size).toBe(1);
  });

  it('returns the net count of unique records added by a same-batch bridge', () => {
    const store = new NoteStore();

    expect(store.addMany([
      note({ id: 'net-id' }),
      note({ noteUrl: 'https://www.xiaohongshu.com/explore/net-id' }),
      note({ id: 'net-id', noteUrl: 'https://www.xiaohongshu.com/explore/net-id' }),
    ])).toBe(1);
    expect(store.size).toBe(1);
  });

  it('rejects mismatched supplied IDs and URL IDs without poisoning stored records', () => {
    const mismatched = note({
      id: 'declared-id',
      noteUrl: 'https://www.xiaohongshu.com/explore/url-id',
      title: 'must not enter',
    });
    const sameBatch = new NoteStore();
    expect(sameBatch.addMany([mismatched, note({ id: 'declared-id', title: 'valid' })])).toBe(1);
    expect(sameBatch.values()).toEqual([note({ id: 'declared-id', title: 'valid' })]);

    const crossCall = new NoteStore();
    crossCall.addMany([note({ id: 'declared-id', title: 'existing' })]);
    expect(crossCall.addMany([mismatched])).toBe(0);
    expect(crossCall.values()).toEqual([note({ id: 'declared-id', title: 'existing' })]);
  });

  it('atomically rejects a different ID that matches a stored fallback URL', () => {
    const store = new NoteStore();
    const fallbackUrl = 'https://www.xiaohongshu.com/user/profile/fallback';
    store.addMany([note({ id: 'A', noteUrl: fallbackUrl, title: 'A evidence' })]);

    expect(store.addMany([note({ id: 'B', noteUrl: fallbackUrl, title: 'B evidence' })])).toBe(0);
    expect(store.values()).toEqual([note({ id: 'A', noteUrl: fallbackUrl, title: 'A evidence' })]);
  });

  it('does not delete or enrich conflicting records when a bridge matches both', () => {
    const store = new NoteStore();
    const fallbackUrl = 'https://www.xiaohongshu.com/user/profile/bridge';
    store.addMany([
      note({ id: 'A', title: 'A evidence' }),
      note({ id: 'B', noteUrl: fallbackUrl, title: 'B evidence' }),
    ]);

    expect(store.addMany([note({ id: 'A', noteUrl: fallbackUrl, title: 'bad bridge', type: 'video' })])).toBe(0);
    expect(store.values()).toEqual([
      note({ id: 'A', title: 'A evidence' }),
      note({ id: 'B', noteUrl: fallbackUrl, title: 'B evidence' }),
    ]);
  });

  it('counts surviving new components even when existing records coalesce', () => {
    const store = new NoteStore();
    const fallbackUrl = 'https://www.xiaohongshu.com/user/profile/existing-bridge';
    store.addMany([note({ id: 'A' })]);
    store.addMany([note({ noteUrl: fallbackUrl })]);

    expect(store.addMany([
      note({ id: 'C', title: 'new component' }),
      note({ id: 'A', noteUrl: fallbackUrl }),
    ])).toBe(1);
    expect(store.values().map(item => item.id)).toEqual(['A', 'C']);
  });

  it('counts a same-batch alias bridge as one new component', () => {
    const store = new NoteStore();
    const fallbackUrl = 'https://www.xiaohongshu.com/user/profile/new-bridge';

    expect(store.addMany([
      note({ id: 'A' }),
      note({ noteUrl: fallbackUrl }),
      note({ id: 'A', noteUrl: fallbackUrl }),
    ])).toBe(1);
  });

  it('does not count a new alias that becomes part of an existing record', () => {
    const store = new NoteStore();
    const fallbackUrl = 'https://www.xiaohongshu.com/user/profile/existing-alias';
    store.addMany([note({ id: 'A' })]);

    expect(store.addMany([
      note({ noteUrl: fallbackUrl }),
      note({ id: 'A', noteUrl: fallbackUrl }),
    ])).toBe(0);
    expect(store.values()).toEqual([note({ id: 'A', noteUrl: fallbackUrl })]);
  });

  it('deduplicates normalized query and hash URL variants when no note ID is available', () => {
    const store = new NoteStore();

    expect(store.addMany([
      note({ noteUrl: 'https://www.xiaohongshu.com/user/profile/a?from=feed#top' }),
      note({ noteUrl: 'https://www.xiaohongshu.com/user/profile/a/' }),
    ])).toBe(1);
    expect(store.values()[0]?.noteUrl).toBe('https://www.xiaohongshu.com/user/profile/a');
  });

  it('enriches duplicates while quarantining contradictory type evidence', () => {
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
      type: 'unknown',
      likes: { raw: '13', value: 13 },
      coverUrl: 'https://img.example/later-cover.jpg',
      exportNotes: ['first warning', 'second warning', '作品类型证据冲突'],
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

  it.each([
    ['image then video', ['image', 'video']],
    ['video then image', ['video', 'image']],
  ] as const)('keeps %s evidence conflict durable across later merges', (_order, [first, second]) => {
    const store = new NoteStore();
    store.addMany([note({ id: 'media-conflict', type: first })]);
    store.addMany([note({ id: 'media-conflict', type: second })]);
    store.addMany([note({ id: 'media-conflict', type: 'video' })]);

    expect(store.values()).toMatchObject([{
      id: 'media-conflict', type: 'unknown', exportNotes: ['作品类型证据冲突'],
    }]);
  });

  it('enriches missing type evidence with one positive source without adding a conflict warning', () => {
    const store = new NoteStore();
    store.addMany([note({ id: 'unknown-then-image', type: 'unknown' })]);
    store.addMany([note({ id: 'unknown-then-image', type: 'image' })]);
    expect(store.values()).toMatchObject([{
      id: 'unknown-then-image', type: 'image', exportNotes: [],
    }]);
  });
});
