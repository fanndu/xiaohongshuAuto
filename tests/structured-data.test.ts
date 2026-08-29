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
});
