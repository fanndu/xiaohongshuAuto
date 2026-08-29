import { describe, expect, it } from 'vitest';
import { parseStructuredPage, structuredStateTestHooks, STRUCTURED_STATE_LIMITS } from '../src/parsing/structured-data';

describe('parseStructuredPage', () => {
  it('extracts profile and note fields from initial state', () => {
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
      user: {
        userPageData: {
          basicInfo: {
            userId: 'u1',
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
    expect(result.userId).toBe('u1');
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
    expect(parseStructuredPage(document, location.href)).toEqual({ userId: '', identityStatus: 'missing', hasProfileEvidence: false, hasNotesContainer: false, profile: null, notes: [] });

    document.body.innerHTML = '<script>window.otherState = {}</script>';
    expect(parseStructuredPage(document, location.href)).toEqual({ userId: '', identityStatus: 'missing', hasProfileEvidence: false, hasNotesContainer: false, profile: null, notes: [] });

    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
      user: { userPageData: { basicInfo: [], interactions: {}, notes: {} } },
    })};</script>`;
    expect(parseStructuredPage(document, location.href)).toEqual({
      userId: '',
      identityStatus: 'missing',
      hasProfileEvidence: false,
      hasNotesContainer: false,
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
    for (let depth = 0; depth < 100; depth += 1) deeplyNested = [deeplyNested];
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
      user: { userPageData: { basicInfo: { nickname: '保留资料' }, interactions: [], notes: deeplyNested } },
    })};</script>`;

    const result = parseStructuredPage(document, location.href);
    expect(result.profile?.accountName).toBe('保留资料');
    expect(result.notes).toEqual([]);
  });

  it('truncates excessive notes and fails closed for oversized state candidates', () => {
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
    expect(parseStructuredPage(document, location.href)).toMatchObject({ identityStatus: 'budget_exhausted', profile: null });
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

  it.each(['if (true)', 'if (true) {}'])('ignores a regex marker after %s', (prefix) => {
    const real = {
      user: { userPageData: { basicInfo: { nickname: '控制流真实状态' }, interactions: [], notes: [] } },
    };
    const regexFake = JSON.stringify({
      user: { userPageData: { basicInfo: { nickname: '控制流正则伪状态' }, interactions: [], notes: [] } },
    });
    document.body.innerHTML = [
      `<script>window.__INITIAL_STATE__ = ${JSON.stringify(real)};`,
      `${prefix} /window.__INITIAL_STATE__ = ${regexFake}/;</script>`,
    ].join('');

    expect(parseStructuredPage(document, location.href).profile?.accountName).toBe('控制流真实状态');
  });

  it('recognizes a real assignment after Unicode-identifier division', () => {
    const real = {
      user: { userPageData: { basicInfo: { nickname: 'Unicode除法后状态' }, interactions: [], notes: [] } },
    };
    document.body.innerHTML = [
      '<script>const 变量 = 10; 变量 / 2;',
      `window.__INITIAL_STATE__ = ${JSON.stringify(real)};</script>`,
    ].join('');

    expect(parseStructuredPage(document, location.href).profile?.accountName).toBe('Unicode除法后状态');
  });

  it('finds a late state assignment within the AST visit budget', () => {
    const valid = {
      user: { userPageData: { basicInfo: { nickname: '末尾状态' }, interactions: [], notes: [] } },
    };
    const precedingStatements = 'a;'.repeat(50_100);
    document.body.innerHTML = `<script>${precedingStatements}
      window.__INITIAL_STATE__ = ${JSON.stringify(valid)};
    </script>`;

    expect(parseStructuredPage(document, location.href).profile?.accountName).toBe('末尾状态');
  });

  it('extracts only explicit stable user identity fields, never redId or display name', () => {
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
      user: { userId: 'from-user', userPageData: { userId: 'from-page', basicInfo: {
        userId: 'from-basic', redId: 'not-a-route-id', nickname: '也不是路由 ID',
      }, interactions: [], notes: [] } },
    })};</script>`;

    expect(parseStructuredPage(document, location.href)).toMatchObject({ userId: '', identityStatus: 'conflict' });
  });

  it('marks conflicting structured identity aliases unsafe instead of choosing one', () => {
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
      user: { userId: 'alice', userPageData: { userId: 'alice', basicInfo: { userId: 'bob', nickname: 'Bob' }, interactions: [], notes: [] } },
    })};</script>`;
    expect(parseStructuredPage(document, location.href)).toMatchObject({ userId: '', identityStatus: 'conflict' });
  });

  it('maps current nested user notes through noteCard wrappers', () => {
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
      user: { userId: 'u1', userPageData: { basicInfo: { nickname: 'U1' }, interactions: [] }, notes: [[{
        noteCard: { noteId: 'nested-current', displayTitle: 'Current nested note', type: 'normal', cover: { urlDefault: 'https://img.example/current.jpg' }, interactInfo: { likedCount: '7' } },
      }]] },
    })};</script>`;
    expect(parseStructuredPage(document, location.href).notes).toMatchObject([{
      id: 'nested-current', title: 'Current nested note', type: 'image', likes: { raw: '7', value: 7 }, coverUrl: 'https://img.example/current.jpg',
    }]);
  });

  it('recognizes whitespace assignments and ignores comment-only candidates before budgets', () => {
    structuredStateTestHooks.reset();
    const valid = { user: { userPageData: { userId: 'u1', basicInfo: { nickname: 'U1' }, interactions: [], notes: [] } } };
    const comments = Array.from({ length: STRUCTURED_STATE_LIMITS.maxCandidateScripts }, () => '<script>// window.__INITIAL_STATE__ = {}</script>').join('');
    document.body.innerHTML = `${comments}<script>window . __INITIAL_STATE__ = ${JSON.stringify(valid)};</script>`;
    expect(parseStructuredPage(document, location.href)).toMatchObject({ userId: 'u1', identityStatus: 'valid' });
    expect(structuredStateTestHooks.parseCalls()).toBe(1);
  });

  it('does not let an oversized comment-only decoy starve a later valid state', () => {
    const valid = { user: { userPageData: { userId: 'u1', basicInfo: { nickname: 'U1' }, interactions: [], notes: [] } } };
    document.body.innerHTML = `<script>/* window.__INITIAL_STATE__ = {};${' '.repeat(STRUCTURED_STATE_LIMITS.maxScriptChars + 1)} */</script><script>window.__INITIAL_STATE__ = ${JSON.stringify(valid)};</script>`;
    expect(parseStructuredPage(document, location.href)).toMatchObject({ userId: 'u1', identityStatus: 'valid' });
  });

  it('fails closed when a newer oversized script contains a real state assignment', () => {
    const alice = { user: { userPageData: { userId: 'alice', basicInfo: { nickname: 'Alice' }, interactions: [], notes: [] } } };
    const bob = { user: { userPageData: { userId: 'bob', basicInfo: { nickname: 'Bob' }, interactions: [], notes: [] } } };
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify(alice)};</script><script>window . __INITIAL_STATE__ = ${JSON.stringify(bob)};${' '.repeat(STRUCTURED_STATE_LIMITS.maxScriptChars + 1)}</script>`;
    expect(parseStructuredPage(document, location.href)).toMatchObject({ userId: '', identityStatus: 'budget_exhausted', profile: null });
  });

  it('does not count identifier-prefix decoys against the candidate budget', () => {
    structuredStateTestHooks.reset();
    const valid = { user: { userPageData: { userId: 'u1', basicInfo: { nickname: 'U1' }, interactions: [], notes: [] } } };
    const decoys = Array.from({ length: STRUCTURED_STATE_LIMITS.maxCandidateScripts }, () =>
      '<script>notwindow.__INITIAL_STATE__ = {};$window.__INITIAL_STATE__ = {};obj.window.__INITIAL_STATE__ = {};</script>').join('');
    document.body.innerHTML = `${decoys}<script>window . __INITIAL_STATE__ = ${JSON.stringify(valid)};</script>`;
    expect(parseStructuredPage(document, location.href)).toMatchObject({ userId: 'u1', identityStatus: 'valid' });
    expect(structuredStateTestHooks.parseCalls()).toBe(1);
  });

  it('recognizes a real assignment between same-line division operators before failing an oversized candidate closed', () => {
    const alice = { user: { userPageData: { userId: 'alice', basicInfo: { nickname: 'Alice' }, interactions: [], notes: [] } } };
    const bob = { user: { userPageData: { userId: 'bob', basicInfo: { nickname: 'Bob' }, interactions: [], notes: [] } } };
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify(alice)};</script><script>const a = 8 / 2; window . __INITIAL_STATE__ = ${JSON.stringify(bob)}; const b = 8 / 2;${' '.repeat(STRUCTURED_STATE_LIMITS.maxScriptChars + 1)}</script>`;
    expect(parseStructuredPage(document, location.href)).toMatchObject({ userId: '', identityStatus: 'budget_exhausted', profile: null });
  });

  it('does not count spaced member-property decoys against the candidate budget', () => {
    structuredStateTestHooks.reset();
    const valid = { user: { userPageData: { userId: 'u1', basicInfo: { nickname: 'U1' }, interactions: [], notes: [] } } };
    const decoys = Array.from({ length: STRUCTURED_STATE_LIMITS.maxCandidateScripts }, () =>
      '<script>obj . window . __INITIAL_STATE__ = {};</script>').join('');
    document.body.innerHTML = `${decoys}<script>window . __INITIAL_STATE__ = ${JSON.stringify(valid)};</script>`;
    expect(parseStructuredPage(document, location.href)).toMatchObject({ userId: 'u1', identityStatus: 'valid' });
    expect(structuredStateTestHooks.parseCalls()).toBe(1);
  });

  it('fails closed when a marker-bearing script cannot be tokenized', () => {
    const alice = { user: { userPageData: { userId: 'alice', basicInfo: { nickname: 'Alice' }, interactions: [], notes: [] } } };
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify(alice)};</script><script></script>`;
    document.querySelectorAll('script')[1]!.textContent = 'window.__INITIAL_STATE__ = @';
    expect(parseStructuredPage(document, location.href)).toMatchObject({ userId: '', identityStatus: 'budget_exhausted', profile: null });
  });

  it('uses userPageData notes authoritatively and excludes stale sibling notes', () => {
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({ user: {
      userId: 'bob', userPageData: { userId: 'bob', basicInfo: { nickname: 'Bob' }, interactions: [], notes: [{ id: 'bob-note' }] },
      notes: [{ noteCard: { id: 'alice-note', userId: 'alice' } }],
    } })};</script>`;
    expect(parseStructuredPage(document, 'https://www.xiaohongshu.com/user/profile/bob').notes.map(note => note.id)).toEqual(['bob-note']);
  });

  it('uses sibling notes only with a matching explicit parent identity and fails closed on note-card identity mismatch', () => {
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({ user: {
      userId: 'bob', userPageData: { basicInfo: { nickname: 'Bob' }, interactions: [] },
      notes: [{ noteCard: { id: 'bob-note', userId: 'bob' } }],
    } })};</script>`;
    expect(parseStructuredPage(document, 'https://www.xiaohongshu.com/user/profile/bob')).toMatchObject({
      userId: 'bob', identityStatus: 'valid', hasNotesContainer: true, notes: [{ id: 'bob-note' }],
    });

    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({ user: {
      userId: 'bob', userPageData: { basicInfo: { nickname: 'Bob' }, interactions: [] },
      notes: [{ noteCard: { id: 'alice-note', userId: 'alice' } }],
    } })};</script>`;
    expect(parseStructuredPage(document, 'https://www.xiaohongshu.com/user/profile/bob')).toMatchObject({ identityStatus: 'conflict', notes: [] });
  });

  it('never uses sibling notes without an explicit matching parent identity', () => {
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({ user: {
      userPageData: { userId: 'bob', basicInfo: { nickname: 'Bob' }, interactions: [] },
      notes: [{ noteCard: { id: 'stale-alice', userId: 'alice' } }],
    } })};</script>`;
    expect(parseStructuredPage(document, 'https://www.xiaohongshu.com/user/profile/bob')).toMatchObject({
      userId: 'bob', identityStatus: 'valid', hasNotesContainer: false, notes: [],
    });
  });

  it('unwraps bounded reactive maps, preserves wrapper identities, and reads current cover variants', () => {
    const reactive = {
      user: {
        _rawValue: {
          userId: 'bob',
          userPageData: {
            _value: {
              basicInfo: { value: { nickname: 'Bob' } },
              interactions: [],
              notes: { value: [{
                0: {
                  id: 'wrapped-id', url: '/explore/wrapped-id',
                  noteCard: { value: {
                    displayTitle: 'Wrapped',
                    cover: { _value: { infoList: [{ url: 'https://img.example/info.jpg' }] } },
                    interactInfo: { value: { likedCount: '8' } },
                  } },
                },
              }] },
            },
          },
        },
      },
    };
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify(reactive)};</script>`;
    expect(parseStructuredPage(document, 'https://www.xiaohongshu.com/user/profile/bob')).toMatchObject({ notes: [{
      id: 'wrapped-id', title: 'Wrapped', coverUrl: 'https://img.example/info.jpg', likes: { raw: '8', value: 8 },
    }] });
  });

  it('caches token classification for unchanged oversized candidates and supports parenthesized assignments', () => {
    structuredStateTestHooks.reset();
    const oversized = `<script>(window).__INITIAL_STATE__ = ${JSON.stringify({ user: { userPageData: { userId: 'bob', basicInfo: { nickname: 'Bob' }, interactions: [], notes: [] } } })};${' '.repeat(STRUCTURED_STATE_LIMITS.maxScriptChars + 1)}</script>`;
    document.body.innerHTML = oversized;
    expect(parseStructuredPage(document, location.href)).toMatchObject({ identityStatus: 'budget_exhausted' });
    expect(parseStructuredPage(document, location.href)).toMatchObject({ identityStatus: 'budget_exhausted' });
    expect(structuredStateTestHooks.tokenizeCalls()).toBe(1);
    const script = document.querySelector('script')!;
    script.textContent = `(window . __INITIAL_STATE__) = ${JSON.stringify({ user: { userPageData: { userId: 'bob', basicInfo: { nickname: 'Bob' }, interactions: [], notes: [] } } })};`;
    expect(parseStructuredPage(document, location.href)).toMatchObject({ userId: 'bob', identityStatus: 'valid' });
    expect(structuredStateTestHooks.tokenizeCalls()).toBe(2);
  });

  it('skips unrelated scripts before Acorn and caches unchanged candidate script text', () => {
    structuredStateTestHooks.reset();
    const state = { user: { userPageData: { userId: 'u1', basicInfo: {}, interactions: [], notes: [] } } };
    document.body.innerHTML = `<script>${'x'.repeat(200_000)}</script><script>window.__INITIAL_STATE__ = ${JSON.stringify(state)};</script>`;

    expect(parseStructuredPage(document, location.href).userId).toBe('u1');
    expect(structuredStateTestHooks.parseCalls()).toBe(1);
    expect(parseStructuredPage(document, location.href).userId).toBe('u1');
    expect(structuredStateTestHooks.parseCalls()).toBe(1);

    const script = document.querySelectorAll('script')[1]!;
    script.textContent = `window.__INITIAL_STATE__ = ${JSON.stringify({ ...state, user: { ...state.user, userPageData: { ...state.user.userPageData, userId: 'u2' } } })};`;
    expect(parseStructuredPage(document, location.href).userId).toBe('u2');
    expect(structuredStateTestHooks.parseCalls()).toBe(2);
  });

  it('limits candidate-script count and aggregate parse bytes without letting skipped candidates mask earlier valid state', () => {
    structuredStateTestHooks.reset();
    const state = (userId: string) => ({ user: { userPageData: { userId, basicInfo: {}, interactions: [], notes: [] } } });
    const accepted = Array.from({ length: STRUCTURED_STATE_LIMITS.maxCandidateScripts }, (_, index) =>
      `<script>window.__INITIAL_STATE__ = ${JSON.stringify(state(`accepted-${index}`))};</script>`).join('');
    document.body.innerHTML = `${accepted}<script>window.__INITIAL_STATE__ = ${JSON.stringify(state('beyond-count'))};</script>`;
    expect(parseStructuredPage(document, location.href)).toMatchObject({ userId: '', identityStatus: 'budget_exhausted' });

    const oversized = ' '.repeat(STRUCTURED_STATE_LIMITS.maxScriptChars + 1);
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify(state('oversized'))};${oversized}</script><script>window.__INITIAL_STATE__ = ${JSON.stringify(state('after-oversized'))};</script>`;
    expect(parseStructuredPage(document, location.href)).toMatchObject({ userId: '', identityStatus: 'budget_exhausted' });

    const padding = ' '.repeat(Math.ceil(STRUCTURED_STATE_LIMITS.maxCandidateScriptChars / 2));
    document.body.innerHTML = [
      `<script>window.__INITIAL_STATE__ = ${JSON.stringify(state('within-budget'))};${padding}</script>`,
      `<script>window.__INITIAL_STATE__ = ${JSON.stringify(state('beyond-byte-budget'))};${padding}</script>`,
    ].join('');
    expect(parseStructuredPage(document, location.href)).toMatchObject({ userId: '', identityStatus: 'budget_exhausted' });
  });

  it('falls back when a later wrong-shaped assignment has a huge RHS', () => {
    const valid = {
      user: { userPageData: { basicInfo: { nickname: '较早有效状态' }, interactions: [], notes: [] } },
    };
    const wrongShape = `{"unexpected":[${'0,'.repeat(100_100)}0]}`;
    document.body.innerHTML = [
      `<script>window.__INITIAL_STATE__ = ${JSON.stringify(valid)};`,
      `window.__INITIAL_STATE__ = ${wrongShape};</script>`,
    ].join('');

    expect(parseStructuredPage(document, location.href).profile?.accountName).toBe('较早有效状态');
  });

  it('rejects wrapper/card note identity disagreement rather than producing a chimeric note', () => {
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({ user: { userId: 'bob', userPageData: {
      userId: 'bob', basicInfo: { nickname: 'Bob' }, interactions: [], notes: [{
        id: 'wrapper-id', url: '/explore/wrapper-id', noteCard: { id: 'card-id', url: '/explore/card-id' },
      }],
    } } })};</script>`;
    expect(parseStructuredPage(document, 'https://www.xiaohongshu.com/user/profile/bob').notes).toEqual([]);
  });

  it.each([
    ['wrapper-video', 'video', 'normal'],
    ['card-video', 'normal', 'video'],
  ])('keeps wrapper/card %s media evidence conflict-safe', (_name, wrapperType, cardType) => {
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({ user: { userId: 'bob', userPageData: {
      userId: 'bob', basicInfo: { nickname: 'Bob' }, interactions: [], notes: [{
        id: 'same-note', type: wrapperType, noteCard: { type: cardType },
      }],
    } } })};</script>`;
    expect(parseStructuredPage(document, 'https://www.xiaohongshu.com/user/profile/bob').notes).toMatchObject([{
      id: 'same-note', type: 'unknown', exportNotes: ['作品类型证据冲突'],
    }]);
  });

  it('uses only the active reactive note bucket and reconciles its query identity', () => {
    const state = { user: {
      userPageData: { _rawValue: { basicInfo: { value: { nickname: 'Bob' } }, interactions: [] } },
      userId: { value: 'bob' },
      activeTab: { _value: { index: { value: 3 }, query: { value: 'note' } } },
      noteQueries: { value: { 0: { userId: 'alice' }, 1: { userId: 'alice' }, 2: { userId: 'alice' }, 3: { _rawValue: { userId: { value: 'bob' } } }, 4: { userId: 'alice' } } },
      notes: { value: [[{ id: 'stale-0' }], [{ id: 'stale-1' }], [{ id: 'stale-2' }], [{ id: 'active-3' }], [{ id: 'stale-4' }]] },
    } };
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify(state)};</script>`;
    expect(parseStructuredPage(document, 'https://www.xiaohongshu.com/user/profile/bob')).toMatchObject({
      userId: 'bob', identityStatus: 'valid', hasNotesContainer: true, notes: [{ id: 'active-3' }],
    });
  });

  it.each([
    [{ index: 5, query: 'note' }, { 0: { userId: 'bob' } }],
    [{ index: 0, query: 'fav' }, { 0: { userId: 'bob' } }],
    [{ index: 0, query: 'note' }, { 0: { userId: 'alice' } }],
  ])('fails closed for invalid active multi-bucket state', (activeTab, noteQueries) => {
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({ user: {
      userId: 'bob', userPageData: { basicInfo: { nickname: 'Bob' }, interactions: [], notes: [{ id: 'stale-page-data' }] }, activeTab, noteQueries,
      notes: [[{ id: 'should-not-use' }]],
    } })};</script>`;
    expect(parseStructuredPage(document, 'https://www.xiaohongshu.com/user/profile/bob')).toMatchObject({ hasNotesContainer: false, notes: [] });
  });
});
