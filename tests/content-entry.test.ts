import { describe, expect, it, vi } from 'vitest';

import { createProfileRouteLifecycle } from '../src/app/mount';
import { isProfileUrl } from '../src/domain/routes';

describe('isProfileUrl', () => {
  it.each([
    'https://www.xiaohongshu.com/user/profile/abc123',
    'https://www.xiaohongshu.com/user/profile/abc123/',
    'https://creator.xiaohongshu.com/user/profile/abc123?tab=notes#feed',
    'https://xiaohongshu.com/user/profile/abc123',
  ])('accepts a canonical HTTPS profile URL: %s', url => {
    expect(isProfileUrl(url)).toBe(true);
  });

  it.each([
    'http://www.xiaohongshu.com/user/profile/abc123',
    'https://www.xiaohongshu.com:443/user/profile/abc123',
    'https://www.xiaohongshu.com:8443/user/profile/abc123',
    'https://user:pass@www.xiaohongshu.com/user/profile/abc123',
    'https://xiaohongshu.com.evil.test/user/profile/abc123',
    'https://evilxiaohongshu.com/user/profile/abc123',
    'https://www.xiaohongshu.com/user/profile/',
    'https://www.xiaohongshu.com/user/profile',
    'https://www.xiaohongshu.com/user/profile/abc123/notes',
    'https://www.xiaohongshu.com/user/profile/%2F',
    'https://www.xiaohongshu.com/user/profile/a%2Fb',
    'https://www.xiaohongshu.com/user/profile/%00',
    'https://www.xiaohongshu.com/user/profile/%',
    'not a URL',
  ])('rejects non-profile or unsafe URL: %s', url => {
    expect(isProfileUrl(url)).toBe(false);
  });
});

describe('createProfileRouteLifecycle', () => {
  it('mounts the initial profile and does nothing for duplicate URL events', () => {
    const unmount = vi.fn();
    const mount = vi.fn(() => unmount);
    const lifecycle = createProfileRouteLifecycle(mount);

    lifecycle.sync('https://www.xiaohongshu.com/user/profile/alice?tab=notes');
    lifecycle.sync('https://www.xiaohongshu.com/user/profile/alice?tab=notes');

    expect(mount).toHaveBeenCalledTimes(1);
    expect(unmount).not.toHaveBeenCalled();
  });

  it('unmounts before mounting a changed profile and removes collectors off-route', () => {
    const calls: string[] = [];
    const mount = vi.fn((url: string) => {
      calls.push(`mount:${url}`);
      return () => calls.push(`unmount:${url}`);
    });
    const lifecycle = createProfileRouteLifecycle(mount);
    const first = 'https://www.xiaohongshu.com/user/profile/alice';
    const second = 'https://www.xiaohongshu.com/user/profile/bob';

    lifecycle.sync(first);
    lifecycle.sync(second);
    lifecycle.sync('https://www.xiaohongshu.com/explore/abc');
    lifecycle.dispose();

    expect(calls).toEqual([
      `mount:${first}`,
      `unmount:${first}`,
      `mount:${second}`,
      `unmount:${second}`,
    ]);
  });
});
