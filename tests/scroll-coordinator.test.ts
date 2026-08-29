import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CollectionError,
  browserScrollEnvironment,
  collectUntilStable,
  type ScrollEnvironment,
} from '../src/collection/scroll-coordinator';
import type { NoteRecord } from '../src/domain/types';

const note = (id: string): NoteRecord => ({
  id,
  title: id,
  noteUrl: `https://www.xiaohongshu.com/explore/${id}`,
  type: 'image',
  likes: { raw: '', value: null },
  coverUrl: '',
  exportNotes: [],
});

function environment(overrides: Partial<ScrollEnvironment> = {}): ScrollEnvironment & { scrolls: number } {
  const result = {
    scrolls: 0,
    atBottom: () => true,
    hasAccessBlock: () => false,
    scrollToBottom: () => { result.scrolls += 1; },
    wait: () => Promise.resolve(),
    ...overrides,
  };
  return result;
}

describe('collectUntilStable', () => {
  it('completes after exactly three bottom rounds without new notes and reports each read', async () => {
    const env = environment();
    const progress: number[] = [];
    let reads = 0;

    const result = await collectUntilStable({
      environment: env,
      intervalMs: 0,
      readNotes: () => { reads += 1; return []; },
      onProgress: notes => { progress.push(notes.length); },
    });

    expect(result).toEqual({ reason: 'complete', notes: [] });
    expect(reads).toBe(3);
    expect(progress).toEqual([0, 0, 0]);
    expect(env.scrolls).toBe(2);
  });

  it('resets both stable and stalled counters whenever new notes arrive', async () => {
    const env = environment({ atBottom: vi.fn(() => true) });
    const rounds = [[], [], [note('fresh')], [], [], []] as NoteRecord[][];

    const result = await collectUntilStable({
      environment: env,
      intervalMs: 0,
      readNotes: () => rounds.shift() ?? [],
    });

    expect(result).toEqual({ reason: 'complete', notes: [note('fresh')] });
    expect(env.scrolls).toBe(5);
  });

  it('reports a load stall after twelve no-new rounds away from the bottom', async () => {
    const env = environment({ atBottom: () => false });
    let reads = 0;

    await expect(collectUntilStable({
      environment: env,
      intervalMs: 0,
      readNotes: () => { reads += 1; return []; },
    })).rejects.toMatchObject({ code: 'LOAD_STALLED', notes: [] });
    expect(reads).toBe(12);
    expect(env.scrolls).toBe(11);
  });

  it('stops for an access block before reading or scrolling', async () => {
    const env = environment({ hasAccessBlock: () => true });
    const readNotes = vi.fn(() => []);

    await expect(collectUntilStable({ environment: env, readNotes })).rejects.toMatchObject({
      code: 'ACCESS_BLOCKED', notes: [],
    });
    expect(readNotes).not.toHaveBeenCalled();
    expect(env.scrolls).toBe(0);
  });

  it('returns stopped without work when already aborted, preserving its seed', async () => {
    const controller = new AbortController();
    controller.abort();
    const env = environment();
    const readNotes = vi.fn(() => []);

    await expect(collectUntilStable({
      environment: env,
      readNotes,
      signal: controller.signal,
      seed: [note('seed')],
    })).resolves.toEqual({ reason: 'stopped', notes: [note('seed')] });
    expect(readNotes).not.toHaveBeenCalled();
    expect(env.scrolls).toBe(0);
  });

  it('returns stopped when aborted during a wait and keeps notes read before it', async () => {
    const controller = new AbortController();
    const env = environment({
      wait: async () => {
        controller.abort();
      },
    });

    await expect(collectUntilStable({
      environment: env,
      readNotes: () => [note('before-abort')],
      signal: controller.signal,
    })).resolves.toEqual({ reason: 'stopped', notes: [note('before-abort')] });
    expect(env.scrolls).toBe(1);
  });

  it.each([
    ['read', () => environment(), () => { throw new Error('read failed'); }],
    ['scroll', () => environment({ scrollToBottom: () => { throw new Error('scroll failed'); } }), () => []],
    ['wait', () => environment({ wait: () => Promise.reject(new Error('wait failed')) }), () => []],
  ] as const)('wraps a %s error as LOAD_STALLED and retains partial notes', async (_kind, createEnv, readNotes) => {
    const seed = note('seed');

    await expect(collectUntilStable({
      environment: createEnv(),
      seed: [seed],
      readNotes,
    })).rejects.toMatchObject({ code: 'LOAD_STALLED', notes: [seed] });
  });

  it.each([
    [{ stableRounds: 0 }],
    [{ stableRounds: 1.5 }],
    [{ maxStalledRounds: 0 }],
    [{ maxStalledRounds: Number.NaN }],
    [{ intervalMs: -1 }],
    [{ intervalMs: 1.5 }],
  ])('validates loop options before starting work: %o', async options => {
    const env = environment();
    const readNotes = vi.fn(() => []);

    await expect(collectUntilStable({ environment: env, readNotes, ...options })).rejects.toThrow(RangeError);
    expect(readNotes).not.toHaveBeenCalled();
    expect(env.scrolls).toBe(0);
  });
});

describe('browserScrollEnvironment', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('detects visible verification and access-frequency dialogs but ignores unrelated text', () => {
    const env = browserScrollEnvironment(document, window);
    document.body.innerHTML = '<p>请验证一下你的邮箱地址</p><div class="article">验证码教程</div>';
    expect(env.hasAccessBlock()).toBe(false);

    document.body.innerHTML = '<div role="dialog">请完成验证</div>';
    expect(env.hasAccessBlock()).toBe(true);
    document.body.innerHTML = '<section class="captcha-modal">安全验证码</section>';
    expect(env.hasAccessBlock()).toBe(true);
    document.body.innerHTML = '<section class="verify-dialog">请完成验证</section>';
    expect(env.hasAccessBlock()).toBe(true);
    document.body.innerHTML = '<div class="access-frequency-dialog">访问频繁，请稍后再试</div>';
    expect(env.hasAccessBlock()).toBe(true);
  });

  it('cleans up its abort listener and timer when waiting is aborted', async () => {
    vi.useFakeTimers();
    const env = browserScrollEnvironment(document, window);
    const controller = new AbortController();
    const promise = env.wait(1_000, controller.signal);
    controller.abort();

    await expect(promise).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('cleans up its timer after a normal wait resolution', async () => {
    vi.useFakeTimers();
    const env = browserScrollEnvironment(document, window);
    const promise = env.wait(1_000, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(promise).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
