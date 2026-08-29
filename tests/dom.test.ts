import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDomPage } from '../src/parsing/dom';

const profileUrl = 'https://www.xiaohongshu.com/user/profile/u1';
const fixture = readFileSync(resolve(process.cwd(), 'tests/fixtures/profile-page.html'), 'utf8');

describe('parseDomPage', () => {
  it('extracts a complete profile and video note from the page fixture', () => {
    document.body.innerHTML = fixture;

    expect(parseDomPage(document, profileUrl)).toEqual({
      profile: {
        profileUrl,
        accountName: '旅行摄影阿哲',
        redId: 'xhs_azhe',
        avatarUrl: 'https://img.example/avatar.jpg',
        description: '记录山川',
        ipLocation: '美国',
        following: { raw: '128', value: 128 },
        followers: { raw: '1.2万', value: 12000 },
        likedAndCollected: { raw: '8.6万', value: 86000 },
        exportNotes: [],
      },
      notes: [{
        id: 'abc123',
        title: '雪山日出',
        noteUrl: 'https://www.xiaohongshu.com/explore/abc123',
        type: 'video',
        likes: { raw: '2.3万', value: 23000 },
        coverUrl: 'https://img.example/cover.jpg',
        exportNotes: [],
      }],
    });
  });

  it('supports testid and alternate profile selectors, retaining safe empty values', () => {
    document.body.innerHTML = `
      <img data-testid="avatar" src="https://img.example/alternate-avatar.jpg">
      <span data-testid="user-name">备用名字</span>
      <span class="nickname">不应优先</span>
      <span data-testid="user-redId">小红书号: alternate_id</span>
      <span class="desc">备用简介</span>
      <span data-testid="ip-location">IP属地: 日本</span>
      <div data-testid="profile-stat"><span>关注</span><strong>9</strong></div>
      <div data-testid="profile-stat"><span>粉丝</span><strong>隐藏</strong></div>
      <div data-testid="profile-stat"><span>获赞与收藏</span></div>
    `;

    expect(parseDomPage(document, profileUrl).profile).toEqual({
      profileUrl,
      accountName: '备用名字',
      redId: 'alternate_id',
      avatarUrl: 'https://img.example/alternate-avatar.jpg',
      description: '备用简介',
      ipLocation: '日本',
      following: { raw: '9', value: 9 },
      followers: { raw: '隐藏', value: null },
      likedAndCollected: { raw: '', value: null },
      exportNotes: [],
    });
  });

  it('resolves relative discovery links and skips invalid or off-domain cards', () => {
    document.body.innerHTML = `
      <div class="note-item"><a href="/discovery/item/relative-id/?token=secret"><span class="title">相对链接</span></a></div>
      <div class="note-item"><a href="https://example.com/explore/not-allowed">站外链接</a></div>
      <div class="note-item"><a href="javascript:alert(1)">危险链接</a></div>
      <div class="note-item"><a href="/user/profile/nope">非笔记链接</a></div>
    `;

    expect(parseDomPage(document, profileUrl).notes).toEqual([{
      id: 'relative-id',
      title: '相对链接',
      noteUrl: 'https://www.xiaohongshu.com/discovery/item/relative-id',
      type: 'image',
      likes: { raw: '', value: null },
      coverUrl: '',
      exportNotes: [],
    }]);
  });

  it('does not throw for an empty DOM', () => {
    document.body.innerHTML = '';

    expect(() => parseDomPage(document, profileUrl)).not.toThrow();
    expect(parseDomPage(document, profileUrl)).toEqual({
      profile: {
        profileUrl,
        accountName: '',
        redId: '',
        avatarUrl: '',
        description: '',
        ipLocation: '',
        following: { raw: '', value: null },
        followers: { raw: '', value: null },
        likedAndCollected: { raw: '', value: null },
        exportNotes: [],
      },
      notes: [],
    });
  });
});
