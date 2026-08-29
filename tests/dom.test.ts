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

  it('supports generated avatar and description class variants', () => {
    document.body.innerHTML = `
      <div class="generated-avatar-shell"><img src="https://img.example/generated-avatar.jpg"></div>
      <p class="generated-user-desc-value">生成的简介</p>
    `;

    expect(parseDomPage(document, profileUrl).profile).toMatchObject({
      avatarUrl: 'https://img.example/generated-avatar.jpg',
      description: '生成的简介',
    });
  });

  it('uses fields inside the profile header instead of earlier note-author fields', () => {
    document.body.innerHTML = `
      <article class="note-item">
        <img class="author-avatar" src="https://img.example/note-author.jpg">
        <span class="user-name">笔记作者</span>
        <p class="user-desc">笔记摘要</p>
      </article>
      <section data-testid="profile-header">
        <img data-testid="avatar" src="https://img.example/profile.jpg">
        <span data-testid="user-name">真实主页名</span>
        <p data-testid="user-desc">真实主页简介</p>
        <span data-testid="user-redId">小红书号：real_id</span>
        <span data-testid="ip-location">IP属地：美国</span>
      </section>
    `;

    expect(parseDomPage(document, profileUrl).profile).toMatchObject({
      accountName: '真实主页名',
      avatarUrl: 'https://img.example/profile.jpg',
      description: '真实主页简介',
      redId: 'real_id',
      ipLocation: '美国',
    });
  });

  it('uses profile-root selector priority instead of document order', () => {
    document.body.innerHTML = `
      <div class="user-info"><span class="user-name">较低优先级</span></div>
      <section data-testid="profile-header"><span class="user-name">最高优先级</span></section>
    `;

    expect(parseDomPage(document, profileUrl).profile.accountName).toBe('最高优先级');
  });

  it('uses a numeric stat span without mistaking its semantic label for the count', () => {
    document.body.innerHTML = `
      <div data-testid="profile-stat"><span>关注</span><span>7</span></div>
      <div data-testid="profile-stat"><span>粉丝</span><span>1.5万</span></div>
      <div data-testid="profile-stat"><span>获赞与收藏</span><span>12</span></div>
    `;

    expect(parseDomPage(document, profileUrl).profile).toMatchObject({
      following: { raw: '7', value: 7 },
      followers: { raw: '1.5万', value: 15000 },
      likedAndCollected: { raw: '12', value: 12 },
    });
  });

  it('finds nested numeric count candidates after invalid stat and like wrappers', () => {
    document.body.innerHTML = `
      <div data-testid="profile-stat"><span>关注</span><strong>7人<span>7</span></strong></div>
      <div data-testid="profile-stat"><span>粉丝</span><strong>8人<span>8</span></strong></div>
      <div data-testid="profile-stat"><span>获赞与收藏</span><strong>9人<span>9</span></strong></div>
      <article class="note-item">
        <a href="/explore/count-id"></a>
        <span class="like-wrapper">7人<span>7</span></span>
      </article>
    `;

    expect(parseDomPage(document, profileUrl)).toMatchObject({
      profile: {
        following: { raw: '7', value: 7 },
        followers: { raw: '8', value: 8 },
        likedAndCollected: { raw: '9', value: 9 },
      },
      notes: [{ likes: { raw: '7', value: 7 } }],
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

  it('uses a later valid note anchor when the first matching anchor is unsafe', () => {
    document.body.innerHTML = `
      <article class="note-item">
        <a href="https://example.com/explore/reject-me">站外</a>
        <a href="/explore/valid-second?token=secret"><span class="title">有效作品</span></a>
      </article>
    `;

    expect(parseDomPage(document, profileUrl).notes).toMatchObject([{
      id: 'valid-second',
      noteUrl: 'https://www.xiaohongshu.com/explore/valid-second',
      title: '有效作品',
    }]);
  });

  it('resolves safe avatar and cover image fallbacks from lazy and srcset attributes', () => {
    document.body.innerHTML = `
      <section class="user">
        <img class="user-avatar" src="javascript:alert(1)" data-src="/images/avatar.jpg">
      </section>
      <article class="note-item">
        <a href="/explore/image-id"></a>
        <a class="cover"><img src="data:image/png;base64,nope" data-src="http://img.example/insecure.jpg" data-original="//img.example/data-original.jpg"></a>
      </article>
      <article class="note-item">
        <a href="/explore/srcset-id"></a>
        <a class="cover"><img src="javascript:alert(1)" data-src="http://img.example/insecure.jpg" data-original="data:image/png;base64,nope" srcset="//img.example/srcset.jpg 1x, /images/unused.jpg 2x"></a>
      </article>
    `;

    expect(parseDomPage(document, profileUrl)).toMatchObject({
      profile: { avatarUrl: 'https://www.xiaohongshu.com/images/avatar.jpg' },
      notes: [
        { id: 'image-id', coverUrl: 'https://img.example/data-original.jpg' },
        { id: 'srcset-id', coverUrl: 'https://img.example/srcset.jpg' },
      ],
    });
  });

  it('skips blank image attributes before trying lazy fallbacks', () => {
    document.body.innerHTML = `
      <section class="user"><img class="user-avatar" src="   " data-src="/images/lazy-avatar.jpg"></section>
    `;

    expect(parseDomPage(document, profileUrl).profile.avatarUrl)
      .toBe('https://www.xiaohongshu.com/images/lazy-avatar.jpg');
  });

  it('deduplicates a nested generated note card', () => {
    document.body.innerHTML = `
      <section class="feeds-page"><article class="note-item">
        <div class="generated-note-item">
          <a href="/explore/nested-id"><span class="title">嵌套作品</span></a>
        </div>
      </article></section>
    `;

    expect(parseDomPage(document, profileUrl).notes).toMatchObject([{
      id: 'nested-id',
      title: '嵌套作品',
    }]);
    expect(parseDomPage(document, profileUrl).notes).toHaveLength(1);
  });

  it('keeps both real cards under a broad note-item list without duplicate mixed records', () => {
    document.body.innerHTML = `
      <div class="note-item-list">
        <article class="note-item">
          <a href="/explore/first-id"><span class="title">第一篇</span></a>
        </article>
        <article class="note-item">
          <a href="/explore/second-id"><span class="title">第二篇</span></a>
          <span class="video-icon"></span>
        </article>
      </div>
    `;

    expect(parseDomPage(document, profileUrl).notes).toMatchObject([
      { id: 'first-id', title: '第一篇', type: 'image' },
      { id: 'second-id', title: '第二篇', type: 'video' },
    ]);
    expect(parseDomPage(document, profileUrl).notes).toHaveLength(2);
  });

  it('tokenizes data srcsets without treating rejected fragments as relative URLs', () => {
    document.body.innerHTML = `
      <section class="user">
        <img class="user-avatar" src="javascript:alert(1)" srcset="data:image/svg+xml,%3Csvg%3E 1x, https://img.example/real.jpg 2x">
      </section>
      <article class="note-item">
        <a href="/explore/data-only"></a>
        <a class="cover"><img src="javascript:alert(1)" srcset="data:image/svg+xml,%3Csvg%3E 1x"></a>
      </article>
      <article class="note-item">
        <a href="/explore/lazy-srcset"></a>
        <a class="cover"><img src="javascript:alert(1)" data-srcset="https://img.example/lazy-srcset.jpg 1x"></a>
      </article>
    `;

    expect(parseDomPage(document, profileUrl)).toMatchObject({
      profile: { avatarUrl: 'https://img.example/real.jpg' },
      notes: [
        { id: 'data-only', coverUrl: '' },
        { id: 'lazy-srcset', coverUrl: 'https://img.example/lazy-srcset.jpg' },
      ],
    });
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
