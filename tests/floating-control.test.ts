import { afterEach, describe, expect, it, vi } from 'vitest';
import { FloatingControl, type UiActions } from '../src/ui/floating-control';

const states = {
  ready: { phase: 'ready' } as const,
  collecting: { phase: 'collecting', count: 3 } as const,
  complete: { phase: 'complete', count: 4 } as const,
  paused: { phase: 'paused', count: 2, message: '已暂停' } as const,
  failed: { phase: 'failed', count: 1, message: '加载失败' } as const,
};

function makeActions(): UiActions {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    retry: vi.fn(),
    exportPartial: vi.fn(),
  };
}

function action(control: FloatingControl, name: string): HTMLButtonElement {
  const button = control.root.querySelector<HTMLButtonElement>(`button[data-action="${name}"]`);
  if (!button) throw new Error(`Missing ${name} action`);
  return button;
}

afterEach(() => {
  document.getElementById('xhs-profile-collector')?.remove();
});

describe('FloatingControl', () => {
  it('creates a fixed isolated host at the document root with local styles', () => {
    const control = new FloatingControl(makeActions());

    expect(control.host.id).toBe('xhs-profile-collector');
    expect(control.host.parentElement).toBe(document.documentElement);
    expect(control.root).toBeInstanceOf(ShadowRoot);
    expect(control.root.querySelector('style')?.textContent).toContain('position: fixed');
    expect(control.root.querySelector('style')?.textContent).toContain('z-index: 2147483647');
  });

  it.each([
    ['ready', states.ready, ['采集此博主'], ['start']],
    ['collecting', states.collecting, ['已发现 3 篇', '正在加载更多…', '停止采集'], ['stop']],
    ['complete', states.complete, ['✓ 共采集 4 篇', 'Excel 已下载'], []],
    ['paused', states.paused, ['已暂停', '已暂停', '重试', '导出已有数据'], ['retry', 'exportPartial']],
    ['failed', states.failed, ['加载失败', '加载失败', '重试', '导出已有数据'], ['retry', 'exportPartial']],
  ] as const)('renders %s state text and only its actions', (_name, state, text, actions) => {
    const control = new FloatingControl(makeActions());
    control.render(state);

    for (const expected of text) expect(control.root.textContent).toContain(expected);
    expect([...control.root.querySelectorAll<HTMLButtonElement>('button')].map((button) => button.dataset.action)).toEqual(actions);
  });

  it('calls each exact action once, supports nested button content, and ignores unknown targets', () => {
    const actions = makeActions();
    const control = new FloatingControl(actions);

    control.render(states.ready);
    const nestedLabel = document.createElement('span');
    nestedLabel.textContent = '现在';
    action(control, 'start').append(nestedLabel);
    action(control, 'start').querySelector('span')?.click();
    control.render(states.collecting);
    action(control, 'stop').click();
    control.render(states.failed);
    action(control, 'retry').click();
    action(control, 'exportPartial').click();
    const unknown = document.createElement('button');
    unknown.dataset.action = 'unknown';
    control.root.append(unknown);
    unknown.click();
    const nonButton = document.createElement('div');
    control.root.append(nonButton);
    nonButton.click();

    expect(actions.start).toHaveBeenCalledTimes(1);
    expect(actions.stop).toHaveBeenCalledTimes(1);
    expect(actions.retry).toHaveBeenCalledTimes(1);
    expect(actions.exportPartial).toHaveBeenCalledTimes(1);
  });

  it('replaces controls on repeat render without duplicate callbacks or stale buttons', () => {
    const actions = makeActions();
    const control = new FloatingControl(actions);
    control.render(states.ready);
    const staleButton = action(control, 'start');
    control.render(states.collecting);

    staleButton.click();
    action(control, 'stop').click();

    expect(actions.start).not.toHaveBeenCalled();
    expect(actions.stop).toHaveBeenCalledTimes(1);
  });

  it('renders hostile messages only as text and normalizes invalid counts to zero', () => {
    const control = new FloatingControl(makeActions());
    const hostile = '<img src=x onerror=alert(1)>';
    control.render({ phase: 'failed', count: Number.NaN, message: hostile });

    expect(control.root.textContent).toContain(hostile);
    expect(control.root.textContent).toContain('已发现 0 篇');
    expect(control.root.querySelector('img')).toBeNull();
  });

  it('keeps working after a synchronous action error', () => {
    const actions: UiActions = { ...makeActions(), start: vi.fn(() => { throw new Error('boom'); }) };
    const control = new FloatingControl(actions);
    control.render(states.ready);

    action(control, 'start').click();
    action(control, 'start').click();

    expect(actions.start).toHaveBeenCalledTimes(2);
  });

  it('replaces a stale global host and destroys safely', () => {
    const stale = document.createElement('div');
    stale.id = 'xhs-profile-collector';
    document.documentElement.append(stale);
    const actions = makeActions();
    const control = new FloatingControl(actions);

    expect(document.querySelectorAll('#xhs-profile-collector')).toHaveLength(1);
    expect(document.getElementById('xhs-profile-collector')).toBe(control.host);
    control.destroy();
    control.destroy();
    control.render(states.ready);
    expect(document.getElementById('xhs-profile-collector')).toBeNull();
    expect(control.root.querySelector('button')).toBeNull();
  });

  it('exposes accessible status and buttons', () => {
    const control = new FloatingControl(makeActions());
    control.render(states.collecting);
    const status = control.root.querySelector('[role="status"]');
    const button = action(control, 'stop');

    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('停止采集');
  });
});
