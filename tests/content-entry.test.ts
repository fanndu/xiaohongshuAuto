import { describe, expect, it, vi } from 'vitest';

import { createProfileNavigationSynchronizer, createProfileRouteLifecycle } from '../src/app/mount';
import { canonicalProfileRoute, isProfileUrl } from '../src/domain/routes';

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

describe('canonicalProfileRoute', () => {
  it('uses one canonical URL for equivalent safe profile routes', () => {
    expect(canonicalProfileRoute('https://creator.xiaohongshu.com/user/profile/Alice_01/?tab=notes#feed'))
      .toEqual({ key: 'Alice_01', url: 'https://www.xiaohongshu.com/user/profile/Alice_01' });
  });

  it.each([
    'https://www.xiaohongshu.com/user/profile/a.b',
    'https://www.xiaohongshu.com/user/profile/a%2Db',
    'https://www.xiaohongshu.com/user/profile/a%5Fb',
    'https://www.xiaohongshu.com/user/profile/a%2Fb',
  ])('does not canonicalize encoded or nonconservative IDs: %s', url => {
    expect(canonicalProfileRoute(url)).toBeNull();
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

  it('does not remount query, hash, host, or trailing-slash variants of the same profile', () => {
    const unmount = vi.fn();
    const mount = vi.fn(() => unmount);
    const lifecycle = createProfileRouteLifecycle(mount);

    lifecycle.sync('https://creator.xiaohongshu.com/user/profile/alice/?tab=notes#feed');
    lifecycle.sync('https://www.xiaohongshu.com/user/profile/alice');

    expect(mount).toHaveBeenCalledTimes(1);
    expect(mount).toHaveBeenCalledWith('https://www.xiaohongshu.com/user/profile/alice', expect.any(AbortSignal));
    expect(unmount).not.toHaveBeenCalled();
  });

  it('clears state before a throwing unmount so a later sync can retry', () => {
    const throwingUnmount = vi.fn(() => { throw new Error('unmount'); });
    const mount = vi.fn()
      .mockReturnValueOnce(throwingUnmount)
      .mockReturnValueOnce(vi.fn());
    const lifecycle = createProfileRouteLifecycle(mount);
    lifecycle.sync('https://www.xiaohongshu.com/user/profile/alice');

    expect(() => lifecycle.sync('https://www.xiaohongshu.com/user/profile/bob')).toThrow('unmount');
    lifecycle.sync('https://www.xiaohongshu.com/user/profile/bob');

    expect(mount).toHaveBeenCalledTimes(2);
  });

  it('commits route state only after mounting succeeds', () => {
    const mount = vi.fn()
      .mockImplementationOnce(() => { throw new Error('mount'); })
      .mockReturnValueOnce(vi.fn());
    const lifecycle = createProfileRouteLifecycle(mount);
    const url = 'https://www.xiaohongshu.com/user/profile/alice';

    expect(() => lifecycle.sync(url)).toThrow('mount');
    lifecycle.sync(url);

    expect(mount).toHaveBeenCalledTimes(2);
  });

  it('aborts an in-flight mount after its cleanup runs and remains idempotent if cleanup throws', () => {
    let signal: AbortSignal | undefined;
    const unmount = vi.fn(() => {
      expect(signal?.aborted).toBe(false);
      throw new Error('unmount');
    });
    const lifecycle = createProfileRouteLifecycle((_url, nextSignal) => {
      signal = nextSignal;
      return unmount;
    });
    lifecycle.sync('https://www.xiaohongshu.com/user/profile/alice');

    expect(() => lifecycle.dispose()).toThrow('unmount');
    expect(signal?.aborted).toBe(true);
    expect(() => lifecycle.dispose()).not.toThrow();
    expect(unmount).toHaveBeenCalledOnce();
  });
});

describe('createProfileNavigationSynchronizer', () => {
  it('waits for the actual location to match and coalesces canceled, superseded, and out-of-order notifications', () => {
    vi.useFakeTimers();
    try {
      let current = 'https://www.xiaohongshu.com/user/profile/alice';
      const sync = vi.fn();
      const dispose = vi.fn();
      const navigation = createProfileNavigationSynchronizer({ sync, dispose }, () => current);

      navigation.notify('https://www.xiaohongshu.com/user/profile/bob'); // canceled before commit
      vi.runAllTimers();
      expect(sync).not.toHaveBeenCalled();

      navigation.notify('https://www.xiaohongshu.com/user/profile/bob');
      navigation.notify('https://www.xiaohongshu.com/user/profile/cathy');
      current = 'https://www.xiaohongshu.com/user/profile/cathy?tab=notes';
      vi.runAllTimers();

      expect(sync).toHaveBeenCalledTimes(1);
      expect(sync).toHaveBeenCalledWith(current);
      navigation.dispose();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a pending navigation reconciliation on invalidation-equivalent disposal', () => {
    vi.useFakeTimers();
    try {
      const sync = vi.fn();
      const dispose = vi.fn();
      const navigation = createProfileNavigationSynchronizer(
        { sync, dispose },
        () => 'https://www.xiaohongshu.com/user/profile/bob',
      );

      navigation.notify('https://www.xiaohongshu.com/user/profile/bob');
      navigation.dispose();
      vi.runAllTimers();

      expect(sync).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
