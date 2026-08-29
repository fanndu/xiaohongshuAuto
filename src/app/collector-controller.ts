import { CollectionError } from '../collection/scroll-coordinator';
import type { CollectionResult, NoteRecord, ProfileRecord } from '../domain/types';
import type { FloatingControl, UiState } from '../ui/floating-control';

export interface ControllerDependencies {
  ui: Pick<FloatingControl, 'render'>;
  readProfile(): ProfileRecord;
  collect(
    signal: AbortSignal,
    onProgress: (count: number) => void | Promise<void>,
  ): Promise<{ reason: 'complete' | 'stopped'; notes: NoteRecord[] }>;
  exportResult(result: CollectionResult): Promise<void>;
}

interface ActiveRun {
  readonly controller: AbortController;
  readonly generation: number;
  readonly promise: Promise<void>;
}

const stoppedMessage = '已停止，可导出当前结果';
const messages = {
  ACCESS_BLOCKED: '页面要求验证，请处理后重试',
  LOAD_STALLED: '页面未继续加载，可重试或导出已有数据',
  unknown: '页面结构或加载状态发生变化',
  export: 'Excel 生成失败，可重试或导出已有数据',
} as const;

function cloneProfile(profile: ProfileRecord): ProfileRecord {
  return {
    ...profile,
    following: { ...profile.following },
    followers: { ...profile.followers },
    likedAndCollected: { ...profile.likedAndCollected },
    exportNotes: [...profile.exportNotes],
  };
}

function cloneNote(note: NoteRecord): NoteRecord {
  return {
    ...note,
    likes: { ...note.likes },
    exportNotes: [...note.exportNotes],
  };
}

function cloneNotes(notes: readonly NoteRecord[]): NoteRecord[] {
  return notes.map(cloneNote);
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted
    || (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError')
    || (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError');
}

function collectionError(error: unknown): CollectionError | null {
  return error instanceof CollectionError ? error : null;
}

/** Coordinates collection without allowing a stale page task to update the active UI. */
export class CollectorController {
  private active: ActiveRun | undefined;
  private exportInFlight: Promise<void> | undefined;
  private generation = 0;
  private disposed = false;
  private profile: ProfileRecord | undefined;
  private notes: NoteRecord[] = [];

  constructor(private readonly dependencies: ControllerDependencies) {}

  start(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.active) return this.active.promise;

    let settle: () => void = () => undefined;
    const promise = new Promise<void>(resolve => { settle = resolve; });
    const run: ActiveRun = {
      controller: new AbortController(),
      generation: ++this.generation,
      promise,
    };
    this.active = run;
    void this.run(run).then(settle, settle);
    return promise;
  }

  stop(): void {
    this.active?.controller.abort();
  }

  retry(): Promise<void> {
    return this.active || this.disposed ? Promise.resolve() : this.start();
  }

  exportPartial(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.exportInFlight) return this.exportInFlight;

    let operation: Promise<void>;
    operation = this.exportCurrent().finally(() => {
      if (this.exportInFlight === operation) this.exportInFlight = undefined;
    });
    this.exportInFlight = operation;
    return operation;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.active?.controller.abort();
    this.active = undefined;
  }

  private async run(run: ActiveRun): Promise<void> {
    try {
      if (!this.render({ phase: 'collecting', count: this.notes.length })) {
        this.fail(run, messages.unknown);
        return;
      }

      let profile: ProfileRecord;
      try {
        profile = cloneProfile(this.dependencies.readProfile());
      } catch {
        this.fail(run, messages.unknown);
        return;
      }
      if (!this.isCurrent(run)) return;
      this.profile = profile;

      let result: { reason: 'complete' | 'stopped'; notes: NoteRecord[] };
      try {
        result = await this.dependencies.collect(run.controller.signal, count => {
          if (this.isCurrent(run)) this.render({ phase: 'collecting', count });
        });
      } catch (error) {
        this.handleCollectionError(run, error);
        return;
      }
      if (!this.isCurrent(run)) return;

      this.notes = cloneNotes(result.notes);
      if (result.reason === 'stopped') {
        this.render({ phase: 'paused', count: this.notes.length, message: stoppedMessage });
        return;
      }

      try {
        await this.exportSnapshot();
      } catch {
        if (this.isCurrent(run)) this.render({ phase: 'failed', count: this.notes.length, message: messages.export });
        return;
      }
      if (this.isCurrent(run)) this.render({ phase: 'complete', count: this.notes.length });
    } catch {
      this.fail(run, messages.unknown);
    } finally {
      if (this.active === run) this.active = undefined;
    }
  }

  private handleCollectionError(run: ActiveRun, error: unknown): void {
    if (!this.isCurrent(run)) return;
    if (isAbort(error, run.controller.signal)) {
      this.render({ phase: 'paused', count: this.notes.length, message: stoppedMessage });
      return;
    }
    const known = collectionError(error);
    if (known) {
      this.notes = cloneNotes(known.notes);
      this.render({
        phase: 'failed',
        count: this.notes.length,
        message: messages[known.code],
      });
      return;
    }
    this.render({ phase: 'failed', count: this.notes.length, message: messages.unknown });
  }

  private async exportCurrent(): Promise<void> {
    try {
      if (!this.profile) this.profile = cloneProfile(this.dependencies.readProfile());
      if (this.disposed) return;
      await this.exportSnapshot();
    } catch {
      if (!this.disposed) this.render({ phase: 'failed', count: this.notes.length, message: messages.export });
    }
  }

  private exportSnapshot(): Promise<void> {
    if (!this.profile) return Promise.reject(new Error('Profile is unavailable'));
    return this.dependencies.exportResult({
      profile: cloneProfile(this.profile),
      notes: cloneNotes(this.notes),
    });
  }

  private fail(run: ActiveRun, message: string): void {
    if (this.isCurrent(run)) this.render({ phase: 'failed', count: this.notes.length, message });
  }

  private isCurrent(run: ActiveRun): boolean {
    return !this.disposed && this.active === run && this.generation === run.generation;
  }

  private render(state: UiState): boolean {
    if (this.disposed) return false;
    try {
      this.dependencies.ui.render(state);
      return true;
    } catch {
      return false;
    }
  }
}
