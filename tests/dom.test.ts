import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDomPage } from '../src/parsing/dom';

const profileUrl = 'https://www.xiaohongshu.com/user/profile/u1';
const fixtureProfileUrl = 'https://www.xiaohongshu.com/user/profile/azhe';
const fixture = readFileSync(resolve(process.cwd(), 'tests/fixtures/profile-page.html'), 'utf8');

describe('parseDomPage', () => {
  it('extracts a complete profile and video note from the page fixture', () => {
    document.body.innerHTML = fixture;

    expect(parseDomPage(document, fixtureProfileUrl)).toEqual({
      userId: 'azhe',
      identityStatus: 'valid',
      hasProfileEvidence: true,
      hasWorksContainer: true,
      profile: {
        profileUrl: fixtureProfileUrl,
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

    expect(parseDomPage(document, 'https://www.xiaohongshu.com/user/profile/alice')).toMatchObject({
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
      type: 'unknown',
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
      { id: 'first-id', title: '第一篇', type: 'unknown' },
      { id: 'second-id', title: '第二篇', type: 'video' },
    ]);
    expect(parseDomPage(document, profileUrl).notes).toHaveLength(2);
  });

  it('does not let a multi-note ancestor leak one sibling cover or likes into another', () => {
    document.body.innerHTML = `
      <div class="note-item-list">
        <article class="note-item">
          <a href="/explore/one"><span class="title">作品一</span></a>
        </article>
        <article class="note-item">
          <a href="/explore/two"><span class="title">作品二</span></a>
          <a class="cover"><img src="https://img.example/two.jpg"></a>
          <span class="like-count">22</span>
        </article>
      </div>
    `;

    expect(parseDomPage(document, profileUrl).notes).toMatchObject([
      { id: 'one', title: '作品一', coverUrl: '', likes: { raw: '', value: null } },
      { id: 'two', title: '作品二', coverUrl: 'https://img.example/two.jpg', likes: { raw: '22', value: 22 } },
    ]);
  });

  it('retains video evidence from an enclosing duplicate when the child has no marker', () => {
    document.body.innerHTML = `
      <div class="note-item-wrapper"><span class="video-icon"></span>
        <article class="note-item"><a href="/explore/video-evidence"><span class="title">子卡片标题</span></a></article>
      </div>
    `;

    expect(parseDomPage(document, profileUrl).notes).toMatchObject([{
      id: 'video-evidence',
      title: '子卡片标题',
      type: 'video',
    }]);
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

  it('keeps comma-bearing image URLs whole and advances past descriptorless data URLs', () => {
    document.body.innerHTML = `
      <section class="user">
        <img class="user-avatar" src="javascript:alert(1)" srcset="https://img.example/c_fill,w_300/photo.jpg 1x">
      </section>
      <article class="note-item">
        <a href="/explore/descriptorless-data"></a>
        <a class="cover"><img src="javascript:alert(1)" srcset="data:image/svg+xml,%3Csvg%3E, https://img.example/real.jpg 2x"></a>
      </article>
    `;

    expect(parseDomPage(document, profileUrl)).toMatchObject({
      profile: { avatarUrl: 'https://img.example/c_fill,w_300/photo.jpg' },
      notes: [{ id: 'descriptorless-data', coverUrl: 'https://img.example/real.jpg' }],
    });
  });

  it('does not throw for an empty DOM', () => {
    document.body.innerHTML = '';

    expect(() => parseDomPage(document, profileUrl)).not.toThrow();
    expect(parseDomPage(document, profileUrl)).toEqual({
      userId: '',
      identityStatus: 'missing',
      hasProfileEvidence: false,
      hasWorksContainer: false,
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

  it('leaves unmarked card types unknown and accepts only explicit media markers', () => {
    document.body.innerHTML = `
      <article class="note-item"><a href="/explore/unknown"><img src="https://img.example/cover.jpg"></a></article>
      <article class="note-item"><a href="/explore/video"></a><span class="video-icon"></span></article>
      <article class="note-item" data-note-type="image"><a href="/explore/image"></a></article>
    `;

    expect(parseDomPage(document, profileUrl).notes.map(note => ({ id: note.id, type: note.type }))).toEqual([
      { id: 'unknown', type: 'unknown' },
      { id: 'video', type: 'video' },
      { id: 'image', type: 'image' },
    ]);
  });

  it('uses only explicit root identifiers and self links for DOM route identity', () => {
    document.body.innerHTML = `
      <section class="user" data-user-id="alice"><a href="/user/profile/alice">Alice</a><span class="user-name">Alice</span><section class="feeds-page"></section></section>
    `;
    expect(parseDomPage(document, 'https://www.xiaohongshu.com/user/profile/alice')).toMatchObject({
      userId: 'alice', identityStatus: 'valid', hasProfileEvidence: true, hasWorksContainer: true,
    });

    document.body.innerHTML = '<div class="user-info"><span class="user-name">Generic name</span><section class="feeds-page"></section></div>';
    expect(parseDomPage(document, profileUrl)).toMatchObject({ userId: '', identityStatus: 'missing' });
  });

  it('treats conflicting explicit media evidence as unknown and does not infer type from broad aria text', () => {
    document.body.innerHTML = `
      <article class="note-item" data-note-type="image"><a href="/explore/image"><span aria-label="我的视频剪辑教程"></span></a></article>
      <article class="note-item" aria-label="视频"><a href="/explore/exact-video"></a></article>
      <article class="note-item" data-note-type="image"><a href="/explore/conflict"></a><span class="video-icon"></span></article>
    `;
    expect(parseDomPage(document, profileUrl).notes.map(note => ({ id: note.id, type: note.type }))).toEqual([
      { id: 'image', type: 'image' },
      { id: 'exact-video', type: 'video' },
      { id: 'conflict', type: 'unknown' },
    ]);
  });

  it.each([
    ['image-first', '<article class="note-item" data-note-type="image"><a href="/explore/same"></a></article><article class="note-item"><a href="/explore/same"></a><span class="video-icon"></span></article>'],
    ['video-first', '<article class="note-item"><a href="/explore/same"></a><span class="video-icon"></span></article><article class="note-item" data-note-type="image"><a href="/explore/same"></a></article>'],
  ])('keeps duplicate %s media evidence conflict-safe', (_order, cards) => {
    document.body.innerHTML = `<section class="feeds-page">${cards}</section>`;
    expect(parseDomPage(document, profileUrl).notes).toMatchObject([{
      id: 'same', type: 'unknown', exportNotes: ['作品类型证据冲突'],
    }]);
  });

  it('scopes current profile stats and works to the bound Bob root, ignoring stale global Alice content', () => {
    document.body.innerHTML = `
      <div class="data-info"><div class="data-item"><span>关注</span><strong>999</strong></div></div>
      <section class="feeds-page" data-user-id="alice"><article class="note-item"><a href="/explore/alice-note"></a></article></section>
      <section class="user" data-user-id="bob"><a href="/user/profile/bob">Bob</a><span class="user-name">Bob</span>
        <div class="data-info"><div class="data-item"><span>关注</span><strong>7</strong></div></div>
        <section class="feeds-page"><article class="note-item"><a href="/explore/bob-note"></a></article></section>
      </section>`;
    expect(parseDomPage(document, 'https://www.xiaohongshu.com/user/profile/bob')).toMatchObject({
      userId: 'bob', hasWorksContainer: true,
      profile: { following: { raw: '7', value: 7 } }, notes: [{ id: 'bob-note' }],
    });
  });

  it('selects a later current root instead of letting an earlier stale root block Bob', () => {
    document.body.innerHTML = `
      <section class="user" data-user-id="alice"><a href="/user/profile/alice">Alice</a><span class="user-name">Alice</span><section class="feeds-page"><article class="note-item"><a href="/explore/alice-note"></a></article></section></section>
      <section class="user" data-user-id="bob"><a href="/user/profile/bob">Bob</a><span class="user-name">Bob</span><section class="feeds-page"><article class="note-item"><a href="/explore/bob-note"></a></article></section></section>`;
    expect(parseDomPage(document, 'https://www.xiaohongshu.com/user/profile/bob')).toMatchObject({
      userId: 'bob', identityStatus: 'valid', profile: { accountName: 'Bob' }, notes: [{ id: 'bob-note' }],
    });
  });

  it('uses the validated profile scope for sibling current stats and works', () => {
    document.body.innerHTML = `
      <div class="data-info"><div class="data-item"><span>关注</span><strong>999</strong></div></div>
      <section class="feeds-page" data-user-id="alice"><article class="note-item"><a href="/explore/alice-note"></a></article></section>
      <main class="profile-page" data-user-id="bob">
        <section data-testid="profile-header"><span class="user-name">Bob</span></section>
        <div class="data-info">
          <div class="data-item"><span>关注</span><strong>7</strong></div>
          <div class="data-item"><span>粉丝</span><strong>8</strong></div>
          <div class="data-item"><span>获赞与收藏</span><strong>9</strong></div>
        </div>
        <section class="feeds-page"><article class="note-item"><a href="/explore/bob-scope-note"></a></article></section>
      </main>`;
    expect(parseDomPage(document, 'https://www.xiaohongshu.com/user/profile/bob')).toMatchObject({
      userId: 'bob', identityStatus: 'valid',
      profile: {
        accountName: 'Bob', following: { raw: '7', value: 7 }, followers: { raw: '8', value: 8 },
        likedAndCollected: { raw: '9', value: 9 },
      },
      notes: [{ id: 'bob-scope-note' }],
    });
  });

  it('prefers stats in the current header over earlier wider-scope stats', () => {
    document.body.innerHTML = `
      <main class="profile-page" data-user-id="bob">
        <div class="data-info"><div class="data-item"><span>关注</span><strong>77</strong></div></div>
        <section data-testid="profile-header">
          <span class="user-name">Bob</span>
          <div class="data-info"><div class="data-item"><span>关注</span><strong>7</strong></div></div>
        </section>
        <section class="feeds-page"><article class="note-item"><a href="/explore/bob-header-note"></a></article></section>
      </main>`;
    expect(parseDomPage(document, 'https://www.xiaohongshu.com/user/profile/bob')).toMatchObject({
      profile: { following: { raw: '7', value: 7 } }, notes: [{ id: 'bob-header-note' }],
    });
  });

  it.each([
    ['unbound-first', '<section class="feeds-page"><article class="note-item"><a href="/explore/stale-unbound"></a></article></section><section class="feeds-page" data-user-id="bob"><article class="note-item"><a href="/explore/current-bob"></a></article></section>'],
    ['current-first', '<section class="feeds-page" data-user-id="bob"><article class="note-item"><a href="/explore/current-bob"></a></article></section><section class="feeds-page"><article class="note-item"><a href="/explore/stale-unbound"></a></article></section>'],
  ])('prefers explicitly current works over an identity-less candidate (%s)', (_order, feeds) => {
    document.body.innerHTML = `<main class="profile-page" data-user-id="bob">
      <section data-testid="profile-header" data-user-id="bob"><span class="user-name">Bob</span></section>${feeds}
    </main>`;
    expect(parseDomPage(document, 'https://www.xiaohongshu.com/user/profile/bob')).toMatchObject({
      hasWorksContainer: true, notes: [{ id: 'current-bob' }],
    });
  });

  it('uses an explicit current header instead of an earlier unbound header for profile fields and stats', () => {
    document.body.innerHTML = `<main class="profile-page" data-user-id="bob">
      <section data-testid="profile-header"><span class="user-name">Alice stale</span><div class="data-info"><div class="data-item"><span>关注</span><strong>99</strong></div></div></section>
      <section data-testid="profile-header" data-user-id="bob"><span class="user-name">Bob current</span><div class="data-info"><div class="data-item"><span>关注</span><strong>7</strong></div></div></section>
      <section class="feeds-page" data-user-id="bob"></section>
    </main>`;
    expect(parseDomPage(document, 'https://www.xiaohongshu.com/user/profile/bob')).toMatchObject({
      profile: { accountName: 'Bob current', following: { raw: '7', value: 7 } },
    });
  });

  it('does not accept ambiguous unbound headers inside a bound profile scope', () => {
    document.body.innerHTML = `<main class="profile-page" data-user-id="bob">
      <section data-testid="profile-header"><span class="user-name">Maybe Alice</span><div class="data-info"><div class="data-item"><span>关注</span><strong>99</strong></div></div></section>
      <section data-testid="profile-header"><span class="user-name">Maybe Bob</span><div class="data-info"><div class="data-item"><span>关注</span><strong>88</strong></div></div></section>
      <section class="feeds-page" data-user-id="bob"><article class="note-item"><a href="/explore/not-usable"></a></article></section>
    </main>`;
    expect(parseDomPage(document, 'https://www.xiaohongshu.com/user/profile/bob')).toMatchObject({
      userId: 'bob', hasProfileEvidence: false, hasWorksContainer: false, notes: [],
      profile: { accountName: '', following: { raw: '', value: null } },
    });
  });

  it('rejects an exact Bob header nested inside an explicitly Alice-bound profile scope', () => {
    document.body.innerHTML = `<main class="profile-page" data-user-id="alice">
      <section data-testid="profile-header" data-user-id="bob"><span class="user-name">Bob</span></section>
      <div class="data-info"><div class="data-item"><span>关注</span><strong>99</strong></div></div>
      <section class="feeds-page"><article class="note-item"><a href="/explore/alice-stale"></a></article></section>
    </main>`;
    expect(parseDomPage(document, 'https://www.xiaohongshu.com/user/profile/bob')).toMatchObject({
      hasProfileEvidence: false, hasWorksContainer: false, notes: [],
      profile: { accountName: '', following: { raw: '', value: null } },
    });
  });

  it('uses only direct sibling scope stats when a current header lacks stats', () => {
    document.body.innerHTML = `<main class="profile-page" data-user-id="bob">
      <section data-testid="profile-header"><span class="user-name">Alice stale</span><div class="data-info"><div class="data-item"><span>关注</span><strong>99</strong></div></div></section>
      <section data-testid="profile-header" data-user-id="bob"><span class="user-name">Bob</span></section>
      <div class="data-info"><div class="data-item"><span>关注</span><strong>7</strong></div></div>
      <section class="feeds-page" data-user-id="bob"></section>
    </main>`;
    expect(parseDomPage(document, 'https://www.xiaohongshu.com/user/profile/bob')).toMatchObject({
      profile: { accountName: 'Bob', following: { raw: '7', value: 7 } },
    });
  });

  it('does not use stale header stats when a current header has no direct sibling stats', () => {
    document.body.innerHTML = `<main class="profile-page" data-user-id="bob">
      <section data-testid="profile-header"><span class="user-name">Alice stale</span><div class="data-info"><div class="data-item"><span>关注</span><strong>99</strong></div></div></section>
      <section data-testid="profile-header" data-user-id="bob"><span class="user-name">Bob</span></section>
      <section class="feeds-page" data-user-id="bob"></section>
    </main>`;
    expect(parseDomPage(document, 'https://www.xiaohongshu.com/user/profile/bob')).toMatchObject({
      profile: { following: { raw: '', value: null } },
    });
  });

  it('rejects Bob content nested through an unbound scope into an Alice-bound ancestor scope', () => {
    document.body.innerHTML = `<main class="profile-page" data-user-id="alice">
      <section class="profile-page">
        <section data-testid="profile-header" data-user-id="bob"><span class="user-name">Bob</span></section>
        <section class="feeds-page"><article class="note-item"><a href="/explore/alice-nested"></a></article></section>
      </section>
    </main>`;
    expect(parseDomPage(document, 'https://www.xiaohongshu.com/user/profile/bob')).toMatchObject({
      hasProfileEvidence: false, hasWorksContainer: false, notes: [], profile: { accountName: '' },
    });
  });

  it('uses only direct scope stat children, excluding nested scopes, works, and wrappers', () => {
    document.body.innerHTML = `<main class="profile-page" data-user-id="bob">
      <section data-testid="profile-header" data-user-id="bob"><span class="user-name">Bob</span></section>
      <section class="profile-page" data-user-id="alice"><div class="data-info"><div class="data-item"><span>关注</span><strong>999</strong></div></div></section>
      <section class="feeds-page" data-user-id="bob"><div class="data-info"><div class="data-item"><span>关注</span><strong>998</strong></div></div></section>
      <div class="wrapper"><div class="data-info"><div class="data-item"><span>关注</span><strong>997</strong></div></div></div>
      <div class="data-info"><div class="data-item"><span>关注</span><strong>7</strong></div></div>
    </main>`;
    expect(parseDomPage(document, 'https://www.xiaohongshu.com/user/profile/bob')).toMatchObject({
      profile: { following: { raw: '7', value: 7 } },
    });
  });
});
