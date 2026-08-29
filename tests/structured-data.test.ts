import { describe, expect, it } from 'vitest';
import { parseStructuredPage } from '../src/parsing/structured-data';

describe('parseStructuredPage', () => {
  it('extracts profile and note fields from initial state', () => {
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
      user: {
        userPageData: {
          basicInfo: {
            nickname: '旅行摄影阿哲',
            redId: 'xhs_azhe',
            desc: '记录山川',
            imageb: 'https://img.example/avatar.jpg',
            ipLocation: '美国',
          },
          interactions: [
            { type: 'follows', count: '128' },
            { type: 'fans', count: '1.2万' },
            { type: 'interaction', count: '8.6万' },
          ],
          notes: [[{
            id: 'abc123',
            displayTitle: '雪山日出',
            type: 'video',
            cover: { urlDefault: 'https://img.example/cover.jpg' },
            interactInfo: { likedCount: '2.3万' },
          }]],
        },
      },
    })};</script>`;

    const result = parseStructuredPage(document, 'https://www.xiaohongshu.com/user/profile/u1');

    expect(result.profile).toEqual({
      profileUrl: 'https://www.xiaohongshu.com/user/profile/u1',
      accountName: '旅行摄影阿哲',
      redId: 'xhs_azhe',
      avatarUrl: 'https://img.example/avatar.jpg',
      description: '记录山川',
      ipLocation: '美国',
      following: { raw: '128', value: 128 },
      followers: { raw: '1.2万', value: 12000 },
      likedAndCollected: { raw: '8.6万', value: 86000 },
      exportNotes: [],
    });
    expect(result.notes).toEqual([{
      id: 'abc123',
      title: '雪山日出',
      noteUrl: 'https://www.xiaohongshu.com/explore/abc123',
      type: 'video',
      likes: { raw: '2.3万', value: 23000 },
      coverUrl: 'https://img.example/cover.jpg',
      exportNotes: [],
    }]);
  });

  it('accepts an undefined object-property value without executing script text', () => {
    document.body.innerHTML = `<script>
      window.__INITIAL_STATE__ = {
        "user": {"userPageData": {
          "basicInfo": {"nickname": "阿哲", "imageb": undefined},
          "interactions": [],
          "notes": []
        }}
      };
      window.__INITIAL_STATE__.user.userPageData.basicInfo.nickname = '不应执行';
    </script>`;

    expect(parseStructuredPage(document, 'https://www.xiaohongshu.com/user/profile/u1').profile).toMatchObject({
      accountName: '阿哲',
      avatarUrl: '',
    });
  });

  it('uses supported fallbacks for nested notes and an invalid explicit URL', () => {
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
      user: {
        userPageData: {
          basicInfo: { nickname: '阿哲', images: 'https://img.example/fallback-avatar.jpg' },
          interactions: [],
          notes: [[[{
            noteId: 'fallback-id',
            title: '备用字段',
            url: 'https://example.com/explore/not-this-note',
            type: 'normal',
            cover: { urlPre: 'https://img.example/pre-cover.jpg' },
            likedCount: '42',
          }]]],
        },
      },
    })};</script>`;

    expect(parseStructuredPage(document, location.href)).toMatchObject({
      profile: { avatarUrl: 'https://img.example/fallback-avatar.jpg' },
      notes: [{
        id: 'fallback-id',
        title: '备用字段',
        noteUrl: 'https://www.xiaohongshu.com/explore/fallback-id',
        type: 'image',
        likes: { raw: '42', value: 42 },
        coverUrl: 'https://img.example/pre-cover.jpg',
      }],
    });
  });

  it('uses a valid explicit note URL to derive a missing id and preserves unknown types', () => {
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
      user: {
        userPageData: {
          basicInfo: {},
          interactions: [],
          notes: [{
            url: 'https://www.xiaohongshu.com/discovery/item/derived-id/?from=feed#top',
            type: 'article',
            coverUrl: 'https://img.example/scalar-cover.jpg',
          }, {
            url: 'https://example.com/explore/reject-me',
          }],
        },
      },
    })};</script>`;

    expect(parseStructuredPage(document, location.href).notes).toEqual([{
      id: 'derived-id',
      title: '',
      noteUrl: 'https://www.xiaohongshu.com/discovery/item/derived-id',
      type: 'unknown',
      likes: { raw: '', value: null },
      coverUrl: 'https://img.example/scalar-cover.jpg',
      exportNotes: [],
    }]);
  });

  it('skips an off-domain URL when its supplied id cannot form a note URL', () => {
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
      user: {
        userPageData: {
          basicInfo: {},
          interactions: [],
          notes: [{ id: 'not/a-note-id', url: 'https://example.com/explore/nope' }],
        },
      },
    })};</script>`;

    expect(parseStructuredPage(document, location.href).notes).toEqual([]);
  });

  it('returns the empty result for missing, malformed, or wrong-shaped state', () => {
    document.body.innerHTML = '<script>window.__INITIAL_STATE__ = {broken;</script>';
    expect(parseStructuredPage(document, location.href)).toEqual({ profile: null, notes: [] });

    document.body.innerHTML = '<script>window.otherState = {}</script>';
    expect(parseStructuredPage(document, location.href)).toEqual({ profile: null, notes: [] });

    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
      user: { userPageData: { basicInfo: [], interactions: {}, notes: {} } },
    })};</script>`;
    expect(parseStructuredPage(document, location.href)).toEqual({
      profile: {
        profileUrl: location.href,
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

  it('ignores marker-shaped text in strings, templates, and comments', () => {
    const valid = {
      user: { userPageData: { basicInfo: { nickname: '真实状态' }, interactions: [], notes: [] } },
    };
    document.body.innerHTML = [
      '<script>',
      'const quoted = \'window.__INITIAL_STATE__ = {"user": {}}\';',
      'const templated = `window.__INITIAL_STATE__ = {"user": {}}`;',
      '// window.__INITIAL_STATE__ = {"user": {}}',
      '/* window.__INITIAL_STATE__ = {"user": {}} */',
      `window.__INITIAL_STATE__ = ${JSON.stringify(valid)};`,
      '</script>',
    ].join('\n');

    expect(parseStructuredPage(document, location.href).profile?.accountName).toBe('真实状态');
  });

  it('continues after malformed candidates in a script and later scripts', () => {
    const valid = {
      user: { userPageData: { basicInfo: { nickname: '后续有效状态' }, interactions: [], notes: [] } },
    };
    document.body.innerHTML = [
      '<script>window.__INITIAL_STATE__ = {broken; window.__INITIAL_STATE__ = {also: broken;</script>',
      `<script>window.__INITIAL_STATE__ = ${JSON.stringify(valid)};</script>`,
    ].join('');

    expect(parseStructuredPage(document, location.href).profile?.accountName).toBe('后续有效状态');
  });

  it('rejects conflicting explicit and supplied note identities', () => {
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
      user: { userPageData: { basicInfo: {}, interactions: [], notes: [{
        id: 'supplied-id', url: 'https://www.xiaohongshu.com/explore/url-id',
      }] } },
    })};</script>`;

    expect(parseStructuredPage(document, location.href).notes).toEqual([]);
  });

  it('falls back from an on-domain non-note URL when a safe supplied id exists', () => {
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
      user: { userPageData: { basicInfo: {}, interactions: [], notes: [{
        id: 'safe-id', url: 'https://www.xiaohongshu.com/user/profile/user-id',
      }] } },
    })};</script>`;

    expect(parseStructuredPage(document, location.href).notes).toMatchObject([{
      id: 'safe-id', noteUrl: 'https://www.xiaohongshu.com/explore/safe-id',
    }]);
  });

  it('uses later usable values when preferred mapping fields are empty or non-strings', () => {
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
      user: { userPageData: { basicInfo: {}, interactions: [], notes: [{
        id: '',
        noteId: 'fallback-id',
        displayTitle: 12,
        title: '后备标题',
        interactInfo: { likedCount: '' },
        likedCount: '19',
        cover: { urlDefault: '', urlPre: 'https://img.example/pre.jpg' },
        coverUrl: 'https://img.example/scalar.jpg',
      }] } },
    })};</script>`;

    expect(parseStructuredPage(document, location.href).notes).toMatchObject([{
      id: 'fallback-id',
      title: '后备标题',
      likes: { raw: '19', value: 19 },
      coverUrl: 'https://img.example/pre.jpg',
    }]);
  });

  it('bounds traversal without overflowing and preserves a parsed profile', () => {
    let deeplyNested: unknown = [{ id: 'too-deep', title: '不应出现' }];
    for (let depth = 0; depth < 5_000; depth += 1) deeplyNested = [deeplyNested];
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
      user: { userPageData: { basicInfo: { nickname: '保留资料' }, interactions: [], notes: deeplyNested } },
    })};</script>`;

    const result = parseStructuredPage(document, location.href);
    expect(result.profile?.accountName).toBe('保留资料');
    expect(result.notes).toEqual([]);
  });

  it('truncates excessive notes and skips oversized state scripts', () => {
    const notes = Array.from({ length: 10_001 }, (_, index) => ({ id: `item-${index}` }));
    const bounded = {
      user: { userPageData: { basicInfo: { nickname: '有界资料' }, interactions: [], notes } },
    };
    const later = {
      user: { userPageData: { basicInfo: { nickname: '稍后资料' }, interactions: [], notes: [] } },
    };
    const oversized = JSON.stringify({
      user: { userPageData: { basicInfo: { nickname: '应跳过' }, interactions: [], notes: [] } },
    }) + ' '.repeat(5_000_001);
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify(bounded)};</script>`;

    const boundedResult = parseStructuredPage(document, location.href);
    expect(boundedResult.notes).toHaveLength(9_999);
    expect(boundedResult.notes[0]?.id).toBe('item-0');
    expect(boundedResult.notes[9_998]?.id).toBe('item-9998');
    document.body.innerHTML = [
      `<script>window.__INITIAL_STATE__ = ${oversized};</script>`,
      `<script>window.__INITIAL_STATE__ = ${JSON.stringify(later)};</script>`,
    ].join('');
    expect(parseStructuredPage(document, location.href).profile?.accountName).toBe('稍后资料');
  });

  it('keeps escaped delimiters and literal undefined strings intact', () => {
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = {
      "user": {"userPageData": {
        "basicInfo": {"nickname": "quote \\" } ] undefined"},
        "interactions": [],
        "notes": []
      }}
    };</script>`;

    expect(parseStructuredPage(document, location.href).profile?.accountName)
      .toBe('quote " } ] undefined');
  });

  it('skips placeholder assignments and retains the latest shape-valid state', () => {
    const sameScript = {
      user: { userPageData: { basicInfo: { nickname: '同脚本有效' }, interactions: [], notes: [] } },
    };
    const laterScript = {
      user: { userPageData: { basicInfo: { nickname: '后脚本有效' }, interactions: [], notes: [] } },
    };
    document.body.innerHTML = [
      `<script>window.__INITIAL_STATE__ = {}; window.__INITIAL_STATE__ = ${JSON.stringify(sameScript)};</script>`,
      `<script>window.__INITIAL_STATE__ = {}; window.__INITIAL_STATE__ = ${JSON.stringify(laterScript)};</script>`,
      '<script>window.__INITIAL_STATE__ = {broken;</script>',
    ].join('');

    expect(parseStructuredPage(document, location.href).profile?.accountName).toBe('后脚本有效');
  });

  it('does not let a regex-literal marker win over a shape-valid assignment', () => {
    const valid = {
      user: { userPageData: { basicInfo: { nickname: '正则后有效' }, interactions: [], notes: [] } },
    };
    document.body.innerHTML = [
      '<script>const matcher = /window.__INITIAL_STATE__ = {}/;',
      `window.__INITIAL_STATE__ = ${JSON.stringify(valid)};</script>`,
    ].join('');

    expect(parseStructuredPage(document, location.href).profile?.accountName).toBe('正则后有效');
  });

  it('counts nested arrays against the traversal visit budget', () => {
    const notes = [
      ...Array.from({ length: 9_999 }, () => []),
      { id: 'after-visit-budget' },
    ];
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
      user: { userPageData: { basicInfo: { nickname: '有界遍历' }, interactions: [], notes } },
    })};</script>`;

    const result = parseStructuredPage(document, location.href);
    expect(result.profile?.accountName).toBe('有界遍历');
    expect(result.notes).toEqual([]);
  });

  it('ignores a shape-valid marker embedded in a regex after the real assignment', () => {
    const real = {
      user: { userPageData: { basicInfo: { nickname: '真实正则前状态' }, interactions: [], notes: [] } },
    };
    const regexFake = JSON.stringify({
      user: { userPageData: { basicInfo: { nickname: '正则伪状态' }, interactions: [], notes: [] } },
    });
    document.body.innerHTML = [
      `<script>window.__INITIAL_STATE__ = ${JSON.stringify(real)};`,
      `const matcher = /window.__INITIAL_STATE__ = ${regexFake}/;</script>`,
    ].join('');

    expect(parseStructuredPage(document, location.href).profile?.accountName).toBe('真实正则前状态');
  });

  it('ignores regex markers with escaped slashes and character classes', () => {
    const real = {
      user: { userPageData: { basicInfo: { nickname: '复杂正则后状态' }, interactions: [], notes: [] } },
    };
    const regexFake = JSON.stringify({
      user: { userPageData: { basicInfo: { nickname: '复杂正则伪状态' }, interactions: [], notes: [] } },
    });
    document.body.innerHTML = [
      `<script>window.__INITIAL_STATE__ = ${JSON.stringify(real)};`,
      'const matcher = /[\\/\\]]escaped\\/slash',
      `window.__INITIAL_STATE__ = ${regexFake}[brackets]/gi;</script>`,
    ].join('');

    expect(parseStructuredPage(document, location.href).profile?.accountName).toBe('复杂正则后状态');
  });

  it('recognizes a real assignment after an ordinary division expression', () => {
    const real = {
      user: { userPageData: { basicInfo: { nickname: '除法后状态' }, interactions: [], notes: [] } },
    };
    document.body.innerHTML = [
      '<script>const quotient = 10 / 2;',
      `window.__INITIAL_STATE__ = ${JSON.stringify(real)};</script>`,
    ].join('');

    expect(parseStructuredPage(document, location.href).profile?.accountName).toBe('除法后状态');
  });
});
