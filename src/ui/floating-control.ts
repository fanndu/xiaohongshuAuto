export type UiState =
  | { phase: 'ready' }
  | { phase: 'collecting'; count: number }
  | { phase: 'complete'; count: number }
  | { phase: 'paused' | 'failed'; count: number; message: string };

export interface UiActions {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  retry(): void | Promise<void>;
  exportPartial(): void | Promise<void>;
}

type ActionName = keyof UiActions;

const hostId = 'xhs-profile-collector';
const ownerAttribute = 'data-xhs-profile-collector-owner';
let activeControl: FloatingControl | undefined;

const styles = `
  :host {
    all: initial;
  }
  .panel {
    position: fixed;
    right: 24px;
    bottom: 24px;
    z-index: 2147483647;
    width: 176px;
    padding: 12px;
    color: #fff1f4;
    background: #211217;
    border: 1px solid #77354a;
    border-radius: 14px;
    box-shadow: 0 12px 35px rgb(0 0 0 / 35%);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .title { font-size: 14px; font-weight: 700; }
  .detail { margin-top: 6px; color: #e8b9c5; font-size: 13px; }
  .actions { display: flex; gap: 8px; margin-top: 12px; }
  button {
    appearance: none;
    border: 0;
    border-radius: 8px;
    padding: 8px 10px;
    color: #fff;
    background: #d83d6d;
    cursor: pointer;
    font: inherit;
  }
  button.secondary { color: #ffd8e2; background: #552331; }
`;

function validCount(count: number): number {
  return Number.isFinite(count) && Number.isInteger(count) && count >= 0 ? count : 0;
}

export class FloatingControl {
  readonly host: HTMLDivElement;
  readonly root: ShadowRoot;
  private readonly actions: UiActions;
  private readonly panel: HTMLElement;
  private readonly status: HTMLDivElement;
  private readonly actionsContainer: HTMLDivElement;
  private readonly actionButtons = new WeakMap<HTMLButtonElement, ActionName>();
  private count = 0;
  private destroyed = false;

  constructor(actions: UiActions) {
    activeControl?.destroy();
    document.querySelectorAll<HTMLDivElement>(`#${hostId}[${ownerAttribute}="true"]`).forEach((host) => host.remove());
    this.actions = actions;
    this.host = document.createElement('div');
    this.host.id = hostId;
    this.host.setAttribute(ownerAttribute, 'true');
    this.host.style.setProperty('display', 'block', 'important');
    this.host.style.setProperty('visibility', 'visible', 'important');
    this.host.style.setProperty('opacity', '1', 'important');
    this.root = this.host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = styles;
    this.panel = document.createElement('section');
    this.panel.className = 'panel';
    this.status = document.createElement('div');
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.status.setAttribute('aria-atomic', 'true');
    this.status.tabIndex = -1;
    this.actionsContainer = document.createElement('div');
    this.actionsContainer.className = 'actions';
    this.panel.append(this.status, this.actionsContainer);
    this.root.append(style, this.panel);
    this.root.addEventListener('click', this.handleClick);
    document.documentElement.append(this.host);
    activeControl = this;
  }

  render(state: UiState): void {
    if (this.destroyed) return;
    const hadFocus = this.root.activeElement !== null;
    this.status.replaceChildren();
    this.actionsContainer.replaceChildren();
    this.count = this.stateCount(state);

    switch (state.phase) {
      case 'ready':
        this.addActions([['start', '采集此博主']]);
        break;
      case 'collecting': {
        this.addText(this.status, `已发现 ${this.count} 篇`, 'title');
        this.addText(this.status, '正在加载更多…', 'detail');
        this.addActions([['stop', '停止采集']]);
        break;
      }
      case 'complete': {
        this.addText(this.status, `✓ 共采集 ${this.count} 篇`, 'title');
        this.addText(this.status, 'Excel 已下载', 'detail');
        break;
      }
      case 'paused':
      case 'failed': {
        this.addText(this.status, state.phase === 'paused' ? '采集已暂停' : '采集失败', 'title');
        this.addText(this.status, state.message, 'detail');
        this.addText(this.status, `已发现 ${this.count} 篇`, 'detail');
        this.addActions([['retry', '重试'], ['exportPartial', '导出已有数据']]);
        break;
      }
    }

    if (hadFocus) this.nextFocusTarget()?.focus();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.root.removeEventListener('click', this.handleClick);
    this.status.replaceChildren();
    this.actionsContainer.replaceChildren();
    this.host.remove();
    if (activeControl === this) activeControl = undefined;
  }

  private addText(parent: HTMLElement, text: string, className: string): void {
    const element = document.createElement('div');
    element.className = className;
    element.textContent = text;
    parent.append(element);
  }

  private addActions(entries: readonly [ActionName, string][]): void {
    for (const [name, label] of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.action = name;
      button.setAttribute('aria-label', label);
      button.textContent = label;
      if (name === 'exportPartial') button.className = 'secondary';
      this.actionButtons.set(button, name);
      this.actionsContainer.append(button);
    }
  }

  private readonly handleClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('button[data-action]');
    const action = button && this.actionButtons.get(button);
    if (!button || !action || button.dataset.action !== action) return;
    try {
      const result = this.actions[action]();
      void Promise.resolve(result).catch(() => this.handleActionFailure());
    } catch {
      this.handleActionFailure();
    }
  };

  private stateCount(state: UiState): number {
    return state.phase === 'ready' ? 0 : validCount(state.count);
  }

  private nextFocusTarget(): HTMLElement | null {
    return this.actionsContainer.querySelector('button') ?? this.status;
  }

  private handleActionFailure(): void {
    if (!this.destroyed) this.render({ phase: 'failed', count: this.count, message: '操作失败，请重试' });
  }
}
