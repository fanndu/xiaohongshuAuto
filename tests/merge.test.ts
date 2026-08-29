import { describe, expect, it } from 'vitest';
import { mergeProfile } from '../src/parsing/merge';
import type { ProfileRecord } from '../src/domain/types';

const profileUrl = 'https://www.xiaohongshu.com/user/profile/u1';
const collectedAt = '2026-08-29T12:34:56+00:00';
const count = (raw: string, value: number | null) => ({ raw, value });

const complete = (overrides: Partial<ProfileRecord> = {}): ProfileRecord => ({
  profileUrl: 'https://stale.example/profile',
  accountName: '结构化名字',
  redId: 'structured_id',
  avatarUrl: 'https://img.example/structured-avatar.jpg',
  description: '结构化简介',
  ipLocation: '中国',
  following: count('1', 1),
  followers: count('2', 2),
  likedAndCollected: count('3', 3),
  collectedAt: 'stale-time',
  exportNotes: [],
  ...overrides,
});

describe('mergeProfile', () => {
  it('prefers non-empty structured values and supplied metadata', () => {
    const structured = complete();
    const dom = complete({
      accountName: 'DOM名字',
      redId: 'dom_id',
      following: count('11', 11),
      profileUrl: 'https://stale-dom.example/profile',
      collectedAt: 'stale-dom-time',
    });

    expect(mergeProfile(structured, dom, profileUrl, collectedAt)).toEqual(complete({
      profileUrl,
      collectedAt,
    }));
    expect(structured.profileUrl).toBe('https://stale.example/profile');
    expect(dom.accountName).toBe('DOM名字');
  });

  it('fills blank structured values from DOM values', () => {
    const structured: Partial<ProfileRecord> = {
      accountName: '  ',
      redId: '',
      avatarUrl: '',
      description: '',
      ipLocation: '',
      following: count('', null),
      followers: count('', null),
      likedAndCollected: count('', null),
    };
    const dom = complete({
      accountName: 'DOM名字',
      redId: 'dom_id',
      avatarUrl: 'https://img.example/dom-avatar.jpg',
      description: 'DOM简介',
      ipLocation: '美国',
      following: count('10', 10),
      followers: count('20', 20),
      likedAndCollected: count('30', 30),
    });

    expect(mergeProfile(structured, dom, profileUrl, collectedAt)).toMatchObject({
      profileUrl,
      collectedAt,
      accountName: 'DOM名字',
      redId: 'dom_id',
      avatarUrl: 'https://img.example/dom-avatar.jpg',
      description: 'DOM简介',
      ipLocation: '美国',
      following: count('10', 10),
      followers: count('20', 20),
      likedAndCollected: count('30', 30),
      exportNotes: [],
    });
  });

  it('handles malformed string and count values safely and warns only for missing required fields', () => {
    const malformed = {
      accountName: 12,
      redId: ' ',
      avatarUrl: null,
      description: undefined,
      ipLocation: '',
      following: { raw: 10, value: 10 },
      followers: null,
      likedAndCollected: { raw: '', value: 9 },
    } as unknown as Partial<ProfileRecord>;

    const result = mergeProfile(malformed, {}, profileUrl, collectedAt);

    expect(result).toMatchObject({
      profileUrl,
      collectedAt,
      accountName: '',
      redId: '',
      avatarUrl: '',
      description: '',
      ipLocation: '',
      following: count('', null),
      followers: count('', null),
      likedAndCollected: count('', null),
    });
    expect(result.exportNotes).toEqual([
      '账号名缺失',
      '小红书号缺失',
      '头像链接缺失',
      '简介缺失',
      '关注数缺失',
      '粉丝数缺失',
      '获赞与收藏数缺失',
    ]);
  });
});
