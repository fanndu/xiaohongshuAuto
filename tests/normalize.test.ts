import { describe, expect, it } from 'vitest';
import {
  extractNoteId,
  formatLocalDateTime,
  normalizeNoteUrl,
  parseCount,
  sanitizeFilenamePart,
} from '../src/domain/normalize';

describe('parseCount', () => {
  it.each([
    ['128', { raw: '128', value: 128 }],
    ['1,234', { raw: '1,234', value: 1234 }],
    ['1,2,3', { raw: '1,2,3', value: null }],
    ['1.2万', { raw: '1.2万', value: 12000 }],
    ['2.3万+', { raw: '2.3万+', value: 23000 }],
    ['1.2', { raw: '1.2', value: null }],
    ['1.23456万', { raw: '1.23456万', value: 12346 }],
    ['9007199254740992', { raw: '9007199254740992', value: null }],
    ['1.5千', { raw: '1.5千', value: 1500 }],
    ['', { raw: '', value: null }],
    ['隐藏', { raw: '隐藏', value: null }],
  ])('%s', (input, expected) => expect(parseCount(`  ${input} `)).toEqual(expected));
});

describe('note URL helpers', () => {
  it('normalizes absolute and relative URLs', () => {
    expect(normalizeNoteUrl('/explore/abc/?x=1#top')).toBe('https://www.xiaohongshu.com/explore/abc');
    expect(normalizeNoteUrl('https://example.com/discovery/item/id/?x=1')).toBe('');
    expect(normalizeNoteUrl('http://www.xiaohongshu.com/explore/id')).toBe('');
    expect(normalizeNoteUrl('not a url')).toBe('');
  });

  it.each([
    ['/explore/abc', 'abc'],
    ['https://www.xiaohongshu.com/discovery/item/xyz/?foo=bar', 'xyz'],
    ['/profile/user', ''],
  ])('extracts id from %s', (href, expected) => expect(extractNoteId(href)).toBe(expected));
});

describe('sanitizeFilenamePart', () => {
  it('sanitizes reserved characters and trims', () => {
    expect(sanitizeFilenamePart(' 阿哲 / 旅行:记录 ')).toBe('阿哲 _ 旅行_记录');
  });

  it('limits output and falls back for empty values', () => {
    expect(sanitizeFilenamePart('')).toBe('未命名博主');
    expect(sanitizeFilenamePart('a'.repeat(100))).toHaveLength(80);
    expect(sanitizeFilenamePart('a\n\0b')).toBe('a__b');
    expect(sanitizeFilenamePart('😀'.repeat(100))).toBe('😀'.repeat(80));
  });
});

describe('formatLocalDateTime', () => {
  const date = new Date('2026-08-29T18:00:00.000Z');
  it.each([
    [360, '2026-08-29T12:00:00-06:00'],
    [-330, '2026-08-29T23:30:00+05:30'],
    [0, '2026-08-29T18:00:00+00:00'],
  ])('formats offset %s', (offset, expected) => expect(formatLocalDateTime(date, offset)).toBe(expected));

  it('rolls the local date across a UTC boundary', () => {
    expect(formatLocalDateTime(new Date('2026-08-30T05:00:00.000Z'), 360)).toBe('2026-08-29T23:00:00-06:00');
  });

  it.each([
    [new Date('invalid'), 0],
    [date, Number.NaN],
    [date, 1.5],
    [date, 841],
    [date, -841],
  ])('rejects invalid date or offset', (value, offset) => {
    expect(() => formatLocalDateTime(value, offset)).toThrow(RangeError);
  });
});
