import { CollectionError } from '../collection/scroll-coordinator';
import type { CollectionResult, NoteRecord, ProfileRecord } from '../domain/types';
import type { FloatingControl, UiState } from '../ui/floating-control';

export interface ControllerDependencies {
  ui: Pick<FloatingControl, 'render'>;
  readProfile(): ProfileRecord;
  collect(signal: AbortSignal, onProgress: (count: number) => void | Promise<void>): Promise<{
    reason: 'complete' | 'stopped'; notes: NoteRecord[];
  }>;
  exportResult(result: CollectionResult): Promise<void>;
}

type RunPhase = 'collecting' | 'exporting';
type ExportOrigin = 'manual' | 'automatic';
type ExportOutcome = 'success' | 'failed' | 'ignored';

interface ActiveRun {
  readonly controller: AbortController;
  readonly generation: number;
  readonly promise: Promise<void>;
  phase: RunPhase;
}

interface ExportRequest {
  readonly generation: number;
  readonly origin: ExportOrigin;
  readonly promise: Promise<ExportOutcome>;
  readonly publicPromise: Promise<void>;
  readonly token: number;
  readonly version: number;
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
  return { ...note, likes: { ...note.likes }, exportNotes: [...note.exportNotes] };
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

/** Coordinates collection and serializes immutable export snapshots. */
export class CollectorController {
  private active: ActiveRun | undefined;
  private disposed = false;
  private exportTail: Promise<void> = Promise.resolve();
  private exportToken = 0;
  private generation = 0;
  private notes: NoteRecord[] = [];
  private readonly pendingExports = new Map<number, ExportRequest>();
  private profile: ProfileRecord | undefined;
  private snapshotVersion = 0;

  constructor(private readonly dependencies: ControllerDependencies) {}

  start(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.active) return this.active.promise;

    let settle: () => void = () => undefined;
    const promise = new Promise<void>(resolve => { settle = resolve; });
    const run: ActiveRun = {
      controller: new AbortController(),
      generation: ++this.generation,
      phase: 'collecting',
      promise,
    };
    this.active = run;
    void this.run(run).then(settle, settle);
    return promise;
  }

  stop(): void {
    if (this.active?.phase === 'collecting') this.active.controller.abort();
  }

  retry(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.active?.promise ?? this.start();
  }

  exportPartial(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const generation = this.generation;
    if (!this.profile) {
      try {
        this.setProfile(cloneProfile(this.dependencies.readProfile()));
      } catch {
        const token = ++this.exportToken;
        if (!this.disposed && this.generation === generation && this.exportToken === token) {
          this.render({ phase: 'failed', count: this.notes.length, message: messages.export });
        }
        return Promise.resolve();
      }
    }
    const request = this.queueExport('manual', this.generation);
    return request?.publicPromise ?? Promise.resolve();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.exportToken += 1;
    this.active?.controller.abort();
    this.active = undefined;
  }

  private async run(run: ActiveRun): Promise<void> {
    try {
      if (!this.render({ phase: 'collecting', count: this.notes.length })) {
        this.fail(run, messages.unknown);
        return;
      }

      try {
        this.setProfile(cloneProfile(this.dependencies.readProfile()));
      } catch {
        this.fail(run, messages.unknown);
        return;
      }
      if (!this.isCurrent(run)) return;

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

      this.setNotes(result.notes);
      if (run.controller.signal.aborted || result.reason === 'stopped') {
        this.render({ phase: 'paused', count: this.notes.length, message: stoppedMessage });
        return;
      }

      run.phase = 'exporting';
      const request = this.queueExport('automatic', run.generation);
      const outcome = request ? await request.promise : 'failed';
      if (!this.isCurrent(run) || !request || !this.isExportCurrent(request)) return;
      if (outcome === 'success') this.render({ phase: 'complete', count: this.notes.length });
      else if (outcome === 'failed') this.render({ phase: 'failed', count: this.notes.length, message: messages.export });
    } catch {
      this.fail(run, messages.unknown);
    } finally {
      if (this.active === run) this.active = undefined;
    }
  }

  private handleCollectionError(run: ActiveRun, error: unknown): void {
    if (!this.isCurrent(run)) return;
    const known = collectionError(error);
    if (known) this.setNotes(known.notes);
    if (isAbort(error, run.controller.signal)) {
      this.render({ phase: 'paused', count: this.notes.length, message: stoppedMessage });
      return;
    }
    if (known) {
      this.render({ phase: 'failed', count: this.notes.length, message: messages[known.code] });
      return;
    }
    this.render({ phase: 'failed', count: this.notes.length, message: messages.unknown });
  }

  private queueExport(origin: ExportOrigin, generation: number): ExportRequest | undefined {
    if (!this.profile || this.disposed) return undefined;
    const version = this.snapshotVersion;
    const existing = this.pendingExports.get(version);
    if (existing) return existing;

    const token = ++this.exportToken;
    const snapshot: CollectionResult = { profile: cloneProfile(this.profile), notes: cloneNotes(this.notes) };
    let request: ExportRequest;
    const promise = this.exportTail.then(async (): Promise<ExportOutcome> => {
      if (this.disposed) return 'ignored';
      try {
        await this.dependencies.exportResult({
          profile: cloneProfile(snapshot.profile),
          notes: cloneNotes(snapshot.notes),
        });
        return 'success';
      } catch {
        return 'failed';
      }
    }).then(outcome => {
      if (this.pendingExports.get(version) === request) this.pendingExports.delete(version);
      if (outcome === 'failed' && origin === 'manual' && this.isExportCurrent(request)) {
        this.render({ phase: 'failed', count: this.notes.length, message: messages.export });
      }
      return outcome;
    });
    request = { generation, origin, promise, publicPromise: promise.then(() => undefined), token, version };
    this.pendingExports.set(version, request);
    this.exportTail = promise.then(() => undefined);
    return request;
  }

  private setNotes(notes: readonly NoteRecord[]): void {
    this.notes = cloneNotes(notes);
    this.snapshotVersion += 1;
  }

  private setProfile(profile: ProfileRecord): void {
    this.profile = cloneProfile(profile);
    this.snapshotVersion += 1;
  }

  private fail(run: ActiveRun, message: string): void {
    if (this.isCurrent(run)) this.render({ phase: 'failed', count: this.notes.length, message });
  }

  private isCurrent(run: ActiveRun): boolean {
    return !this.disposed && this.active === run && this.generation === run.generation;
  }

  private isExportCurrent(request: ExportRequest): boolean {
    return !this.disposed && this.generation === request.generation && this.exportToken === request.token;
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
