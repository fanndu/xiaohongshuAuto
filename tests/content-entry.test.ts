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

  it('keeps a reentrant mount as the active route and tears down the stale outer mount', () => {
    const calls: string[] = [];
    let lifecycle!: ReturnType<typeof createProfileRouteLifecycle>;
    const mount = vi.fn((url: string, signal: AbortSignal) => {
      calls.push(`mount:${url}`);
      if (url.endsWith('/alice')) lifecycle.sync('https://www.xiaohongshu.com/user/profile/bob');
      return () => calls.push(`unmount:${url}:${signal.aborted}`);
    });
    lifecycle = createProfileRouteLifecycle(mount);

    lifecycle.sync('https://www.xiaohongshu.com/user/profile/alice');
    lifecycle.sync('https://www.xiaohongshu.com/user/profile/bob');
    lifecycle.dispose();

    expect(calls).toEqual([
      'mount:https://www.xiaohongshu.com/user/profile/alice',
      'mount:https://www.xiaohongshu.com/user/profile/bob',
      'unmount:https://www.xiaohongshu.com/user/profile/alice:false',
      'unmount:https://www.xiaohongshu.com/user/profile/bob:false',
    ]);
    expect(mount).toHaveBeenCalledTimes(2);
  });

  it('lets a reentrant cleanup sync win over the outer route transition', () => {
    const calls: string[] = [];
    let lifecycle!: ReturnType<typeof createProfileRouteLifecycle>;
    const mount = vi.fn((url: string) => {
      calls.push(`mount:${url}`);
      return () => {
        calls.push(`unmount:${url}`);
        if (url.endsWith('/alice')) lifecycle.sync('https://www.xiaohongshu.com/user/profile/cathy');
      };
    });
    lifecycle = createProfileRouteLifecycle(mount);

    lifecycle.sync('https://www.xiaohongshu.com/user/profile/alice');
    lifecycle.sync('https://www.xiaohongshu.com/user/profile/bob');
    lifecycle.dispose();

    expect(calls).toEqual([
      'mount:https://www.xiaohongshu.com/user/profile/alice',
      'unmount:https://www.xiaohongshu.com/user/profile/alice',
      'mount:https://www.xiaohongshu.com/user/profile/cathy',
      'unmount:https://www.xiaohongshu.com/user/profile/cathy',
    ]);
  });

  it('prevents a cleanup from remounting after disposal begins', () => {
    let lifecycle!: ReturnType<typeof createProfileRouteLifecycle>;
    const mount = vi.fn((url: string) => () => {
      if (url.endsWith('/alice')) lifecycle.sync('https://www.xiaohongshu.com/user/profile/bob');
    });
    lifecycle = createProfileRouteLifecycle(mount);
    lifecycle.sync('https://www.xiaohongshu.com/user/profile/alice');

    lifecycle.dispose();

    expect(mount).toHaveBeenCalledTimes(1);
  });
});

describe('createProfileNavigationSynchronizer', () => {
  it('reconciles a precommit notification after its destination commits without another event', () => {
    vi.useFakeTimers();
    try {
      let current = 'https://www.xiaohongshu.com/user/profile/alice';
      const sync = vi.fn();
      const dispose = vi.fn();
      const navigation = createProfileNavigationSynchronizer({ sync, dispose }, () => current);

      navigation.syncInitial();
      navigation.notify('https://www.xiaohongshu.com/user/profile/bob');
      vi.advanceTimersByTime(250); // WXT event arrived before the browser committed.
      current = 'https://www.xiaohongshu.com/user/profile/bob?tab=notes';
      vi.advanceTimersByTime(250);

      expect(sync).toHaveBeenCalledWith(current);
      navigation.dispose();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('observes a canceled destination that later commits with no second WXT event', () => {
    vi.useFakeTimers();
    try {
      let current = 'https://www.xiaohongshu.com/user/profile/alice';
      const sync = vi.fn();
      const navigation = createProfileNavigationSynchronizer({ sync, dispose: vi.fn() }, () => current);
      navigation.syncInitial();
      navigation.notify('https://www.xiaohongshu.com/user/profile/bob'); // first navigation is canceled
      vi.advanceTimersByTime(250);
      current = 'https://www.xiaohongshu.com/user/profile/bob'; // retry emits no event
      vi.advanceTimersByTime(250);

      expect(sync).toHaveBeenLastCalledWith(current);
      navigation.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses only actual location when stale or out-of-order notifications arrive', () => {
    vi.useFakeTimers();
    try {
      let current = 'https://www.xiaohongshu.com/user/profile/cathy';
      const sync = vi.fn();
      const navigation = createProfileNavigationSynchronizer({ sync, dispose: vi.fn() }, () => current);
      navigation.syncInitial();
      sync.mockClear();

      navigation.notify('https://www.xiaohongshu.com/user/profile/alice');
      navigation.notify('https://www.xiaohongshu.com/user/profile/bob');
      vi.advanceTimersByTime(250);

      expect(sync).toHaveBeenCalled();
      expect(sync).toHaveBeenCalledWith(current);
      expect(sync).not.toHaveBeenCalledWith('https://www.xiaohongshu.com/user/profile/alice');
      expect(sync).not.toHaveBeenCalledWith('https://www.xiaohongshu.com/user/profile/bob');
      navigation.dispose();
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

      navigation.syncInitial();
      sync.mockClear();
      navigation.dispose();

      // A committed route after invalidation cannot be mounted by the monitor.
      navigation.notify('https://www.xiaohongshu.com/user/profile/bob');
      vi.runAllTimers();

      expect(sync).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('contains one reconciliation failure so the next monitor tick can retry', () => {
    vi.useFakeTimers();
    try {
      const sync = vi.fn()
        .mockImplementationOnce(() => { throw new Error('mount failed'); });
      const navigation = createProfileNavigationSynchronizer(
        { sync, dispose: vi.fn() },
        () => 'https://www.xiaohongshu.com/user/profile/bob',
      );

      expect(() => navigation.syncInitial()).not.toThrow();
      vi.advanceTimersByTime(250);
      expect(sync).toHaveBeenCalledTimes(2);
      navigation.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
