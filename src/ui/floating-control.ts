export type UiState =
  | { phase: 'ready' }
  | { phase: 'collecting'; count: number }
  | { phase: 'complete'; count: number }
  | { phase: 'paused' | 'failed'; count: number; message: string };

export interface UiActions {
  start(): void;
  stop(): void;
  retry(): void;
  exportPartial(): void;
}

type ActionName = keyof UiActions;

const hostId = 'xhs-profile-collector';
const knownActions: readonly ActionName[] = ['start', 'stop', 'retry', 'exportPartial'];

const styles = `
  :host {
    position: fixed;
    right: 20px;
    bottom: 20px;
    z-index: 2147483647;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .panel {
    width: 240px;
    padding: 16px;
    color: #fff1f4;
    background: #211217;
    border: 1px solid #77354a;
    border-radius: 14px;
    box-shadow: 0 12px 35px rgb(0 0 0 / 35%);
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

function isActionName(value: string | undefined): value is ActionName {
  return value !== undefined && knownActions.includes(value as ActionName);
}

export class FloatingControl {
  readonly host: HTMLDivElement;
  readonly root: ShadowRoot;
  private readonly actions: UiActions;
  private readonly content: HTMLDivElement;
  private destroyed = false;

  constructor(actions: UiActions) {
    document.getElementById(hostId)?.remove();
    this.actions = actions;
    this.host = document.createElement('div');
    this.host.id = hostId;
    this.root = this.host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = styles;
    this.content = document.createElement('div');
    this.root.append(style, this.content);
    this.root.addEventListener('click', this.handleClick);
    document.documentElement.append(this.host);
  }

  render(state: UiState): void {
    if (this.destroyed) return;

    const panel = document.createElement('section');
    panel.className = 'panel';
    const status = document.createElement('div');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    panel.append(status);

    switch (state.phase) {
      case 'ready':
        this.addText(status, '采集此博主', 'title');
        this.addActions(panel, [['start', '采集此博主']]);
        break;
      case 'collecting': {
        const count = validCount(state.count);
        this.addText(status, `已发现 ${count} 篇`, 'title');
        this.addText(status, '正在加载更多…', 'detail');
        this.addActions(panel, [['stop', '停止采集']]);
        break;
      }
      case 'complete': {
        const count = validCount(state.count);
        this.addText(status, `✓ 共采集 ${count} 篇`, 'title');
        this.addText(status, 'Excel 已下载', 'detail');
        break;
      }
      case 'paused':
      case 'failed': {
        const count = validCount(state.count);
        this.addText(status, state.phase === 'paused' ? '已暂停' : '采集失败', 'title');
        this.addText(status, state.message, 'detail');
        this.addText(status, `已发现 ${count} 篇`, 'detail');
        this.addActions(panel, [['retry', '重试'], ['exportPartial', '导出已有数据']]);
        break;
      }
    }

    this.content.replaceChildren(panel);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.root.removeEventListener('click', this.handleClick);
    this.content.replaceChildren();
    this.host.remove();
  }

  private addText(parent: HTMLElement, text: string, className: string): void {
    const element = document.createElement('div');
    element.className = className;
    element.textContent = text;
    parent.append(element);
  }

  private addActions(parent: HTMLElement, entries: readonly [ActionName, string][]): void {
    const actions = document.createElement('div');
    actions.className = 'actions';
    for (const [name, label] of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.action = name;
      button.setAttribute('aria-label', label);
      button.textContent = label;
      if (name === 'exportPartial') button.className = 'secondary';
      actions.append(button);
    }
    parent.append(actions);
  }

  private readonly handleClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('button[data-action]');
    if (!button || !this.root.contains(button) || !isActionName(button.dataset.action)) return;
    try {
      this.actions[button.dataset.action]();
    } catch {
      // A content-script UI must remain usable after a controller action fails.
    }
  };
}
