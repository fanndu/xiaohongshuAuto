import { describe, expect, it, vi } from 'vitest';
import { CollectionError } from '../src/collection/scroll-coordinator';
import { CollectorController, type ControllerDependencies } from '../src/app/collector-controller';
import type { NoteRecord, ProfileRecord } from '../src/domain/types';

const profile = (): ProfileRecord => ({
  profileUrl: 'https://www.xiaohongshu.com/user/profile',
  accountName: '阿哲',
  redId: 'azhe',
  avatarUrl: '',
  description: '',
  ipLocation: '',
  following: { raw: '1', value: 1 },
  followers: { raw: '2', value: 2 },
  likedAndCollected: { raw: '3', value: 3 },
  collectedAt: '2026-08-29T12:00:00-06:00',
  exportNotes: [],
});

const note = (id: string): NoteRecord => ({
  id,
  title: id,
  noteUrl: `https://www.xiaohongshu.com/explore/${id}`,
  type: 'image',
  likes: { raw: '1', value: 1 },
  coverUrl: '',
  exportNotes: [],
});

function dependencies(overrides: Partial<ControllerDependencies> = {}) {
  const ui = { render: vi.fn() };
  const readProfile = vi.fn(profile);
  const collect = vi.fn(async (_signal: AbortSignal, onProgress: (count: number) => void | Promise<void>) => {
    await onProgress(1);
    return { reason: 'complete' as const, notes: [note('one')] };
  });
  const exportResult = vi.fn(async () => undefined);
  return { ui, readProfile, collect, exportResult, ...overrides };
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('CollectorController', () => {
  it('collects, reports progress, exports the exact result, then completes', async () => {
    const deps = dependencies();
    const controller = new CollectorController(deps);

    await controller.start();

    expect(deps.ui.render).toHaveBeenNthCalledWith(1, { phase: 'collecting', count: 0 });
    expect(deps.ui.render).toHaveBeenNthCalledWith(2, { phase: 'collecting', count: 1 });
    expect(deps.exportResult).toHaveBeenCalledTimes(1);
    expect(deps.exportResult).toHaveBeenCalledWith({ profile: profile(), notes: [note('one')] });
    expect(deps.ui.render).toHaveBeenLastCalledWith({ phase: 'complete', count: 1 });
  });

  it('shares an active start promise and does not duplicate work', async () => {
    const result = deferred<{ reason: 'complete'; notes: NoteRecord[] }>();
    const deps = dependencies({ collect: vi.fn(() => result.promise) });
    const controller = new CollectorController(deps);

    const first = controller.start();
    const second = controller.start();
    expect(second).toBe(first);
    expect(deps.readProfile).toHaveBeenCalledTimes(1);
    expect(deps.collect).toHaveBeenCalledTimes(1);

    result.resolve({ reason: 'complete', notes: [] });
    await first;
    expect(deps.exportResult).toHaveBeenCalledTimes(1);
  });

  it('renders paused only after a stopped collection result', async () => {
    const result = deferred<{ reason: 'stopped'; notes: NoteRecord[] }>();
    let signal: AbortSignal | undefined;
    const deps = dependencies({ collect: vi.fn((nextSignal: AbortSignal) => {
      signal = nextSignal;
      return result.promise;
    }) });
    const controller = new CollectorController(deps);

    const started = controller.start();
    controller.stop();
    controller.stop();
    expect(signal?.aborted).toBe(true);
    expect(deps.ui.render).toHaveBeenCalledTimes(1);

    result.resolve({ reason: 'stopped', notes: [note('saved')] });
    await started;
    expect(deps.ui.render).toHaveBeenLastCalledWith({
      phase: 'paused', count: 1, message: '已停止，可导出当前结果',
    });
    expect(deps.exportResult).not.toHaveBeenCalled();
  });

  it('maps an AbortError to paused while retaining prior partial notes', async () => {
    const second = deferred<never>();
    const deps = dependencies({
      collect: vi.fn()
        .mockResolvedValueOnce({ reason: 'stopped', notes: [note('saved')] })
        .mockImplementationOnce(() => second.promise),
    });
    const controller = new CollectorController(deps);

    await controller.start();
    const retried = controller.retry();
    controller.stop();
    const abort = new Error('private page data');
    abort.name = 'AbortError';
    second.reject(abort);
    await retried;

    expect(deps.ui.render).toHaveBeenLastCalledWith({
      phase: 'paused', count: 1, message: '已停止，可导出当前结果',
    });
  });

  it.each([
    ['ACCESS_BLOCKED', '页面要求验证，请处理后重试'],
    ['LOAD_STALLED', '页面未继续加载，可重试或导出已有数据'],
  ] as const)('maps %s and preserves a cloned partial result', async (code, message) => {
    const partial = [note('partial')];
    const deps = dependencies({ collect: vi.fn(async () => {
      throw new CollectionError(code, partial);
    }) });
    const controller = new CollectorController(deps);

    await controller.start();
    partial[0]!.title = 'mutated after error';
    await controller.exportPartial();

    expect(deps.ui.render).toHaveBeenLastCalledWith({ phase: 'failed', count: 1, message });
    expect(deps.exportResult).toHaveBeenLastCalledWith({ profile: profile(), notes: [note('partial')] });
  });

  it('uses safe generic failures without exposing dependency error content', async () => {
    const deps = dependencies({ collect: vi.fn(async () => { throw new Error('secret page HTML'); }) });
    const controller = new CollectorController(deps);

    await controller.start();

    expect(deps.ui.render).toHaveBeenLastCalledWith({
      phase: 'failed', count: 0, message: '页面结构或加载状态发生变化',
    });
    expect(deps.exportResult).not.toHaveBeenCalled();
  });

  it('maps export failures without exposing error content or completing', async () => {
    const deps = dependencies({ exportResult: vi.fn(async () => { throw new Error('worksheet trace'); }) });
    const controller = new CollectorController(deps);

    await controller.start();

    expect(deps.ui.render).toHaveBeenLastCalledWith({
      phase: 'failed', count: 1, message: 'Excel 生成失败，可重试或导出已有数据',
    });
  });

  it('reads once and coalesces concurrent partial exports before collection starts', async () => {
    const exported = deferred<void>();
    const deps = dependencies({ exportResult: vi.fn(() => exported.promise) });
    const controller = new CollectorController(deps);

    const first = controller.exportPartial();
    const second = controller.exportPartial();
    expect(second).toBe(first);
    expect(deps.readProfile).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(deps.exportResult).toHaveBeenCalledTimes(1));
    expect(deps.exportResult).toHaveBeenCalledTimes(1);

    exported.resolve();
    await first;
    expect(deps.exportResult).toHaveBeenCalledWith({ profile: profile(), notes: [] });
  });

  it('fulfills the public partial-export promise with void', async () => {
    const controller = new CollectorController(dependencies());

    await expect(controller.exportPartial()).resolves.toBeUndefined();
  });

  it('isolates controller records from an exporter that mutates its input', async () => {
    const seen: Array<{ profile: ProfileRecord; notes: NoteRecord[] }> = [];
    const deps = dependencies({ exportResult: vi.fn(async result => {
      seen.push({ profile: structuredClone(result.profile), notes: structuredClone(result.notes) });
      result.profile.accountName = 'corrupted';
      result.notes[0]!.title = 'corrupted';
      result.notes.push(note('injected'));
    }) });
    const controller = new CollectorController(deps);

    await controller.start();
    await controller.exportPartial();

    expect(seen).toEqual([
      { profile: profile(), notes: [note('one')] },
      { profile: profile(), notes: [note('one')] },
    ]);
  });

  it('ignores callbacks from a stopped generation after retry starts', async () => {
    let oldProgress: ((count: number) => void | Promise<void>) | undefined;
    const deps = dependencies({
      collect: vi.fn()
        .mockImplementationOnce(async (_signal, onProgress) => {
          oldProgress = onProgress;
          return { reason: 'stopped' as const, notes: [note('old')] };
        })
        .mockResolvedValueOnce({ reason: 'complete', notes: [note('new')] }),
    });
    const controller = new CollectorController(deps);

    await controller.start();
    const retried = controller.retry();
    await Promise.resolve();
    await oldProgress?.(999);
    await retried;

    expect(deps.ui.render).not.toHaveBeenCalledWith({ phase: 'collecting', count: 999 });
    expect(deps.ui.render).toHaveBeenLastCalledWith({ phase: 'complete', count: 1 });
    expect(deps.exportResult).toHaveBeenLastCalledWith({ profile: profile(), notes: [note('new')] });
  });

  it('aborts and permanently ignores late collection activity after dispose', async () => {
    const result = deferred<{ reason: 'complete'; notes: NoteRecord[] }>();
    let progress: ((count: number) => void | Promise<void>) | undefined;
    let signal: AbortSignal | undefined;
    const deps = dependencies({ collect: vi.fn((nextSignal, callback) => {
      signal = nextSignal;
      progress = callback;
      return result.promise;
    }) });
    const controller = new CollectorController(deps);

    const started = controller.start();
    controller.dispose();
    controller.dispose();
    expect(signal?.aborted).toBe(true);
    await progress?.(12);
    result.resolve({ reason: 'complete', notes: [note('late')] });
    await started;
    await controller.retry();
    await controller.exportPartial();
    controller.stop();

    expect(deps.ui.render).toHaveBeenCalledTimes(1);
    expect(deps.exportResult).not.toHaveBeenCalled();
  });

  it('contains render exceptions and does not continue after the initial collecting render fails', async () => {
    const unhandled = vi.fn();
    const listener = (event: PromiseRejectionEvent) => unhandled(event.reason);
    window.addEventListener('unhandledrejection', listener);
    const deps = dependencies({ ui: { render: vi.fn(() => { throw new Error('render failure'); }) } });
    const controller = new CollectorController(deps);

    await controller.start();
    await Promise.resolve();
    window.removeEventListener('unhandledrejection', listener);

    expect(deps.readProfile).not.toHaveBeenCalled();
    expect(deps.collect).not.toHaveBeenCalled();
    expect(deps.exportResult).not.toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('serializes a newer automatic export behind a pending manual export', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const exportResult = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const deps = dependencies({ exportResult });
    const controller = new CollectorController(deps);

    const manual = controller.exportPartial();
    const started = controller.start();
    await Promise.resolve();
    expect(exportResult).toHaveBeenCalledTimes(1);

    first.resolve();
    await manual;
    await Promise.resolve();
    expect(exportResult).toHaveBeenCalledTimes(2);
    second.resolve();
    await started;
    expect(deps.ui.render).toHaveBeenLastCalledWith({ phase: 'complete', count: 1 });
  });

  it('does not let an old manual export failure overwrite a queued newer automatic success', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const exportResult = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const deps = dependencies({ exportResult });
    const controller = new CollectorController(deps);

    const manual = controller.exportPartial();
    const started = controller.start();
    first.reject(new Error('old export failure'));
    await manual;
    await Promise.resolve();
    second.resolve();
    await started;

    expect(deps.ui.render).toHaveBeenLastCalledWith({ phase: 'complete', count: 1 });
    expect(deps.ui.render).not.toHaveBeenCalledWith({
      phase: 'failed', count: 0, message: 'Excel 生成失败，可重试或导出已有数据',
    });
  });

  it('invalidates an old manual export failure when retry begins a new run', async () => {
    const exported = deferred<void>();
    const retryResult = deferred<{ reason: 'stopped'; notes: NoteRecord[] }>();
    const deps = dependencies({
      collect: vi.fn()
        .mockResolvedValueOnce({ reason: 'stopped', notes: [note('saved')] })
        .mockImplementationOnce(() => retryResult.promise),
      exportResult: vi.fn(() => exported.promise),
    });
    const controller = new CollectorController(deps);

    await controller.start();
    const manual = controller.exportPartial();
    await vi.waitFor(() => expect(deps.exportResult).toHaveBeenCalledTimes(1));
    const retried = controller.retry();
    exported.reject(new Error('old failure'));
    await manual;
    retryResult.resolve({ reason: 'stopped', notes: [note('new')] });
    await retried;

    expect(deps.ui.render).not.toHaveBeenCalledWith({
      phase: 'failed', count: 1, message: 'Excel 生成失败，可重试或导出已有数据',
    });
    expect(deps.ui.render).toHaveBeenLastCalledWith({
      phase: 'paused', count: 1, message: '已停止，可导出当前结果',
    });
  });

  it('returns the exact active promise from retry', async () => {
    const result = deferred<{ reason: 'complete'; notes: NoteRecord[] }>();
    const deps = dependencies({ collect: vi.fn(() => result.promise) });
    const controller = new CollectorController(deps);

    const started = controller.start();
    expect(controller.retry()).toBe(started);
    result.resolve({ reason: 'complete', notes: [] });
    await started;
  });

  it('pauses without exporting when stop wins immediately after a complete result resolves', async () => {
    const result = deferred<{ reason: 'complete'; notes: NoteRecord[] }>();
    const deps = dependencies({ collect: vi.fn(() => result.promise) });
    const controller = new CollectorController(deps);

    const started = controller.start();
    result.resolve({ reason: 'complete', notes: [note('saved')] });
    controller.stop();
    await started;

    expect(deps.exportResult).not.toHaveBeenCalled();
    expect(deps.ui.render).toHaveBeenLastCalledWith({
      phase: 'paused', count: 1, message: '已停止，可导出当前结果',
    });
  });

  it('does not let stop interrupt a committed automatic export', async () => {
    const exported = deferred<void>();
    let signal: AbortSignal | undefined;
    const deps = dependencies({
      collect: vi.fn((nextSignal: AbortSignal) => {
        signal = nextSignal;
        return Promise.resolve({ reason: 'complete' as const, notes: [note('done')] });
      }),
      exportResult: vi.fn(() => exported.promise),
    });
    const controller = new CollectorController(deps);

    const started = controller.start();
    await vi.waitFor(() => expect(deps.exportResult).toHaveBeenCalledTimes(1));
    controller.stop();
    expect(signal?.aborted).toBe(false);
    exported.resolve();
    await started;
    expect(deps.ui.render).toHaveBeenLastCalledWith({ phase: 'complete', count: 1 });
  });

  it('retains CollectionError notes when stop wins the same turn and exports that partial snapshot', async () => {
    const rejected = deferred<never>();
    const deps = dependencies({ collect: vi.fn(() => rejected.promise) });
    const controller = new CollectorController(deps);

    const started = controller.start();
    rejected.reject(new CollectionError('LOAD_STALLED', [note('attached')]));
    controller.stop();
    await started;
    await controller.exportPartial();

    expect(deps.ui.render).toHaveBeenLastCalledWith({
      phase: 'paused', count: 1, message: '已停止，可导出当前结果',
    });
    expect(deps.exportResult).toHaveBeenLastCalledWith({ profile: profile(), notes: [note('attached')] });
  });
});
