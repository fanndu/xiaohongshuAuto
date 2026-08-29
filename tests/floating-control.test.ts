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
  document.querySelectorAll('#xhs-profile-collector').forEach((host) => host.remove());
});

describe('FloatingControl', () => {
  it('creates a closed, reset isolated host with a fixed local panel', () => {
    const control = new FloatingControl(makeActions());
    const style = control.root.querySelector('style')?.textContent;

    expect(control.host.id).toBe('xhs-profile-collector');
    expect(control.host.parentElement).toBe(document.documentElement);
    expect(control.root).toBeInstanceOf(ShadowRoot);
    expect(control.host.shadowRoot).toBeNull();
    expect(style).toMatch(/:host\s*\{\s*all:\s*initial;/);
    expect(style).toMatch(/\.panel\s*\{[^}]*position:\s*fixed;/);
    expect(style).toMatch(/\.panel\s*\{[^}]*right:\s*24px;/);
    expect(style).toMatch(/\.panel\s*\{[^}]*bottom:\s*24px;/);
    expect(style).toMatch(/\.panel\s*\{[^}]*z-index:\s*2147483647;/);
    expect(style).toMatch(/\.panel\s*\{[^}]*width:\s*176px;/);
    expect(style).toMatch(/\.panel\s*\{[^}]*padding:\s*12px;/);
  });

  it('uses inline host defenses against adversarial page id styling', () => {
    const hostileStyle = document.createElement('style');
    hostileStyle.textContent = '#xhs-profile-collector { pointer-events: none !important; transform: scale(0) !important; filter: opacity(0) !important; width: 0 !important; height: 0 !important; overflow: hidden !important; }';
    document.head.append(hostileStyle);
    const control = new FloatingControl(makeActions());

    expect(control.host.style.getPropertyValue('all')).toBe('initial');
    expect(control.host.style.getPropertyValue('display')).toBe('block');
    expect(control.host.style.getPropertyPriority('display')).toBe('important');
    expect(control.host.style.getPropertyValue('visibility')).toBe('visible');
    expect(control.host.style.getPropertyValue('opacity')).toBe('1');
    expect(control.host.style.getPropertyPriority('opacity')).toBe('important');
    expect(control.host.style.getPropertyValue('pointer-events')).toBe('auto');
    expect(control.host.style.getPropertyValue('transform')).toBe('none');
    expect(control.host.style.getPropertyValue('filter')).toBe('none');
    expect(control.host.style.getPropertyValue('overflow')).toBe('visible');
    expect(control.host.style.getPropertyValue('width')).toBe('auto');
    expect(control.host.style.getPropertyPriority('width')).toBe('important');
    expect(control.host.style.getPropertyValue('height')).toBe('auto');
    expect(control.host.style.getPropertyPriority('height')).toBe('important');
    expect(control.host.style.getPropertyValue('position')).toBe('static');
    expect(getComputedStyle(control.host).display).toBe('block');
    hostileStyle.remove();
  });

  it.each([
    ['ready', states.ready, '采集此博主', ['start']],
    ['collecting', states.collecting, '已发现 3 篇正在加载更多…停止采集', ['stop']],
    ['complete', states.complete, '✓ 共采集 4 篇Excel 已下载', []],
    ['paused', states.paused, '采集已暂停已暂停已发现 2 篇重试导出已有数据', ['retry', 'exportPartial']],
    ['failed', states.failed, '采集失败加载失败已发现 1 篇重试导出已有数据', ['retry', 'exportPartial']],
  ] as const)('renders %s state text exactly and only its actions', (_name, state, text, actions) => {
    const control = new FloatingControl(makeActions());
    control.render(state);

    expect(control.root.querySelector('.panel')?.textContent).toBe(text);
    expect([...control.root.querySelectorAll<HTMLButtonElement>('button')].map((button) => button.dataset.action)).toEqual(actions);
  });

  it('renders ready text exactly once and keeps paused and failed headings separate from messages', () => {
    const control = new FloatingControl(makeActions());
    control.render(states.ready);
    expect(control.root.querySelector('.panel')?.textContent).toBe('采集此博主');
    expect(control.root.querySelectorAll('.title')).toHaveLength(0);

    control.render({ phase: 'paused', count: 0, message: '采集已暂停' });
    expect(control.root.querySelector('.title')?.textContent).toBe('采集已暂停');
    expect([...control.root.querySelectorAll('.detail')].map((element) => element.textContent)).toEqual(['采集已暂停', '已发现 0 篇']);

    control.render({ phase: 'failed', count: 0, message: '采集失败' });
    expect(control.root.querySelector('.title')?.textContent).toBe('采集失败');
    expect([...control.root.querySelectorAll('.detail')].map((element) => element.textContent)).toEqual(['采集失败', '已发现 0 篇']);
  });

  it('calls each exact action once, supports nested button content, and ignores injected or mutated buttons', () => {
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
    unknown.dataset.action = 'start';
    control.root.append(unknown);
    unknown.click();
    const mutatedRetry = action(control, 'retry');
    mutatedRetry.dataset.action = 'start';
    mutatedRetry.click();
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

  it('renders hostile messages only as text and normalizes every invalid count to zero', () => {
    const control = new FloatingControl(makeActions());
    const hostile = '<img src=x onerror=alert(1)>';
    for (const count of [Number.NaN, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5]) {
      control.render({ phase: 'failed', count, message: hostile });
      expect(control.root.querySelector('.panel')?.textContent).toContain('已发现 0 篇');
      expect(control.root.querySelector('img')).toBeNull();
    }
    expect([...control.root.querySelectorAll('.detail')].map((element) => element.textContent)).toContain(hostile);
  });

  it('keeps working after a synchronous action error', () => {
    const actions: UiActions = { ...makeActions(), start: vi.fn(() => { throw new Error('boom'); }) };
    const control = new FloatingControl(actions);
    control.render(states.ready);

    action(control, 'start').click();
    expect(control.root.querySelector('.title')?.textContent).toBe('采集失败');
    action(control, 'retry').click();

    expect(actions.start).toHaveBeenCalledTimes(1);
    expect(actions.retry).toHaveBeenCalledTimes(1);
  });

  it('destroys the prior live control so retained buttons cannot invoke it', () => {
    const firstActions = makeActions();
    const first = new FloatingControl(firstActions);
    first.render(states.ready);
    const staleButton = action(first, 'start');
    const secondActions = makeActions();
    const second = new FloatingControl(secondActions);
    second.render(states.ready);

    staleButton.click();
    action(second, 'start').click();

    expect(firstActions.start).not.toHaveBeenCalled();
    expect(secondActions.start).toHaveBeenCalledTimes(1);
  });

  it('preserves a page-owned id collision and destroys its own host safely', () => {
    const pageHost = document.createElement('div');
    pageHost.id = 'xhs-profile-collector';
    document.documentElement.append(pageHost);
    const control = new FloatingControl(makeActions());

    expect(pageHost.isConnected).toBe(true);
    expect(document.querySelectorAll('#xhs-profile-collector')).toHaveLength(2);
    control.destroy();
    control.destroy();
    control.render(states.ready);
    expect(pageHost.isConnected).toBe(true);
    expect(control.root.querySelector('button')).toBeNull();
  });

  it('keeps an accessible status shell and transfers focus across renders', () => {
    const control = new FloatingControl(makeActions());
    control.render(states.ready);
    action(control, 'start').focus();
    control.render(states.collecting);
    const status = control.root.querySelector('[role="status"]');
    const button = action(control, 'stop');

    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.getAttribute('aria-atomic')).toBe('true');
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('停止采集');
    expect(control.root.activeElement).toBe(button);
    control.render(states.complete);
    expect(status?.getAttribute('tabindex')).toBe('-1');
    expect(control.root.activeElement).toBe(status);
  });

  it('contains asynchronous action rejection and remains usable', async () => {
    const actions: UiActions = {
      ...makeActions(),
      start: vi.fn(() => Promise.reject(new Error('boom'))),
    };
    const control = new FloatingControl(actions);
    control.render(states.ready);
    action(control, 'start').click();
    await Promise.resolve();

    expect(control.root.querySelector('.title')?.textContent).toBe('采集失败');
    expect(control.root.querySelector('.detail')?.textContent).toBe('操作失败，请重试');
    action(control, 'retry').click();
    expect(actions.retry).toHaveBeenCalledTimes(1);
    control.destroy();
    await Promise.resolve();
    expect(control.host.isConnected).toBe(false);
  });

  it('ignores an older async rejection after a newer action has changed the UI', async () => {
    let rejectExport: ((reason?: unknown) => void) | undefined;
    let control: FloatingControl;
    const actions: UiActions = {
      ...makeActions(),
      exportPartial: vi.fn(() => new Promise<void>((_resolve, reject) => { rejectExport = reject; })),
      retry: vi.fn(() => control.render({ phase: 'collecting', count: 8 })),
    };
    control = new FloatingControl(actions);
    control.render(states.failed);

    action(control, 'exportPartial').click();
    action(control, 'retry').click();
    rejectExport?.(new Error('late export failure'));
    await Promise.resolve();

    expect(control.root.querySelector('.title')?.textContent).toBe('已发现 8 篇');
    expect(action(control, 'stop')).toBeInstanceOf(HTMLButtonElement);
    expect(control.root.querySelector('.detail')?.textContent).toBe('正在加载更多…');
  });
});
