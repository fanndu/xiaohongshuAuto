import type { NoteRecord } from '../domain/types';
import { NoteStore } from './note-store';

export interface ScrollEnvironment {
  atBottom(): boolean;
  hasAccessBlock(): boolean;
  scrollToBottom(): void;
  wait(ms: number, signal: AbortSignal): Promise<void>;
}

export class CollectionError extends Error {
  readonly code: 'ACCESS_BLOCKED' | 'LOAD_STALLED';
  readonly notes: NoteRecord[];

  constructor(code: 'ACCESS_BLOCKED' | 'LOAD_STALLED', notes: NoteRecord[], cause?: unknown) {
    super(code === 'ACCESS_BLOCKED' ? 'Collection blocked by an access challenge' : 'Collection stalled');
    this.name = 'CollectionError';
    this.code = code;
    this.notes = notes;
    if (cause !== undefined) this.cause = cause;
  }
}

export interface CollectUntilStableOptions {
  readNotes: (signal: AbortSignal) => readonly NoteRecord[] | Promise<readonly NoteRecord[]>;
  onProgress?: (count: number) => void | Promise<void>;
  signal?: AbortSignal;
  environment: ScrollEnvironment;
  stableRounds?: number;
  maxStalledRounds?: number;
  intervalMs?: number;
  seed?: readonly NoteRecord[];
}

export interface CollectionProgress {
  reason: 'complete' | 'stopped';
  notes: NoteRecord[];
}

function validInteger(value: number, minimum: number): boolean {
  return Number.isInteger(value) && Number.isFinite(value) && value >= minimum;
}

function throwStalled(store: NoteStore, cause?: unknown): never {
  throw new CollectionError('LOAD_STALLED', store.values(), cause);
}

type AbortRace<T> =
  | { kind: 'value'; value: T }
  | { kind: 'error'; error: unknown }
  | { kind: 'aborted' };

function raceWithAbort<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<AbortRace<T>> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: AbortRace<T>) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ kind: 'aborted' });
    const source = Promise.resolve(work);
    if (signal.aborted) {
      // Keep a handler attached even after cancellation so a late rejection is not unhandled.
      source.then(() => undefined, () => undefined);
      finish({ kind: 'aborted' });
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    source.then(
      value => finish({ kind: 'value', value }),
      error => finish({ kind: 'error', error }),
    );
  });
}

/** Reads, deduplicates, and scrolls until three bottom rounds show no new notes. */
export async function collectUntilStable(options: CollectUntilStableOptions): Promise<CollectionProgress> {
  const stableRounds = options.stableRounds ?? 3;
  const maxStalledRounds = options.maxStalledRounds ?? 12;
  const intervalMs = options.intervalMs ?? 1200;
  if (!validInteger(stableRounds, 1) || !validInteger(maxStalledRounds, 1) || !validInteger(intervalMs, 0)) {
    throw new RangeError('Collection round counts must be positive integers and intervalMs must be a non-negative integer');
  }

  const store = new NoteStore();
  try {
    store.addMany(options.seed ?? []);
  } catch (error) {
    return throwStalled(store, error);
  }
  const stopped = (): CollectionProgress => ({ reason: 'stopped', notes: store.values() });
  const signal = options.signal ?? new AbortController().signal;
  const checkAccess = (): CollectionProgress | undefined => {
    try {
      const blocked = options.environment.hasAccessBlock();
      if (signal.aborted) return stopped();
      if (blocked) throw new CollectionError('ACCESS_BLOCKED', store.values());
    } catch (error) {
      if (signal.aborted) return stopped();
      if (error instanceof CollectionError) throw error;
      return throwStalled(store, error);
    }
    return undefined;
  };
  let stable = 0;
  let stalled = 0;

  while (true) {
    if (signal.aborted) return stopped();
    const beforeRead = checkAccess();
    if (beforeRead) return beforeRead;

    let readWork: readonly NoteRecord[] | Promise<readonly NoteRecord[]>;
    try {
      readWork = options.readNotes(signal);
    } catch (error) {
      if (signal.aborted) return stopped();
      return throwStalled(store, error);
    }
    const readResult = await raceWithAbort(Promise.resolve(readWork), signal);
    if (readResult.kind === 'aborted') return stopped();
    if (readResult.kind === 'error') return throwStalled(store, readResult.error);
    if (!Array.isArray(readResult.value)) return throwStalled(store, new TypeError('readNotes must return an array'));

    let added: number;
    try {
      added = store.addMany(readResult.value);
    } catch (error) {
      return throwStalled(store, error);
    }
    if (signal.aborted) return stopped();
    const afterRead = checkAccess();
    if (afterRead) return afterRead;

    let progressWork: void | Promise<void> | undefined;
    try {
      progressWork = options.onProgress?.(store.size);
    } catch (error) {
      if (signal.aborted) return stopped();
      return throwStalled(store, error);
    }
    const progressResult = await raceWithAbort(Promise.resolve(progressWork), signal);
    if (progressResult.kind === 'aborted') return stopped();
    if (progressResult.kind === 'error') return throwStalled(store, progressResult.error);
    const afterProgress = checkAccess();
    if (afterProgress) return afterProgress;

    let atBottom: boolean;
    try {
      atBottom = options.environment.atBottom();
    } catch (error) {
      if (signal.aborted) return stopped();
      return throwStalled(store, error);
    }
    if (signal.aborted) return stopped();
    if (added === 0 && atBottom) stable += 1;
    else stable = 0;
    stalled = added === 0 ? stalled + 1 : 0;

    const beforeDecision = checkAccess();
    if (beforeDecision) return beforeDecision;
    if (signal.aborted) return stopped();
    if (stable >= stableRounds) return { reason: 'complete', notes: store.values() };
    if (stalled >= maxStalledRounds) return throwStalled(store);
    if (signal.aborted) return stopped();

    let waitWork: Promise<void>;
    try {
      options.environment.scrollToBottom();
      if (signal.aborted) return stopped();
      waitWork = options.environment.wait(intervalMs, signal);
    } catch (error) {
      if (signal.aborted) return stopped();
      return throwStalled(store, error);
    }
    const waitResult = await raceWithAbort(waitWork, signal);
    if (waitResult.kind === 'aborted') return stopped();
    if (waitResult.kind === 'error') return throwStalled(store, waitResult.error);
  }
}

function isVisible(element: Element, win: Window): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') return false;
    const style = win.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (style.opacity === '0') return false;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    const viewportWidth = win.innerWidth;
    const viewportHeight = win.innerHeight;
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= viewportWidth || rect.top >= viewportHeight) return false;
  }
  return true;
}

function isChallengeContainer(element: Element): boolean {
  if (element.getAttribute('role') === 'dialog' || element.getAttribute('aria-modal') === 'true') return true;
  const tokens = [...element.classList];
  const hasChallengeToken = tokens.some(token => /(captcha|verify|verification|access-frequency|risk-control)/i.test(token));
  const hasOverlayToken = tokens.some(token => /(modal|dialog|popup|container|mask|overlay|challenge)/i.test(token));
  return hasChallengeToken && hasOverlayToken;
}

/** Browser adapter that detects only modal-like verification and rate-limit challenges. */
function createBrowserScrollEnvironment(doc: Document, win: Window): ScrollEnvironment {
  return {
    atBottom: () => {
      const root = doc.documentElement;
      const body = doc.body;
      const totalHeight = Math.max(root.scrollHeight, body?.scrollHeight ?? 0);
      return win.scrollY + win.innerHeight >= totalHeight - 2;
    },
    hasAccessBlock: () => {
      const candidates = doc.querySelectorAll([
        '[role="dialog"]',
        '[aria-modal="true"]',
        '[class*="captcha"]',
        '[class*="verify"]',
        '[class*="verification"]',
        '[class*="access-frequency"]',
        '[class*="risk-control"]',
      ].join(','));
      return [...candidates].some(element => {
        const text = element.textContent?.trim() ?? '';
        const strongChallenge = /(人机验证|验证码|请完成验证|访问频繁|操作频繁)/.test(text);
        const ambiguousSafetyChallenge = /安全验证/.test(text) && !/(教程|帮助|说明|如何(?:完成)?验证|最佳实践)/.test(text);
        return isChallengeContainer(element)
          && isVisible(element, win)
          && (strongChallenge || ambiguousSafetyChallenge);
      });
    },
    scrollToBottom: () => {
      const root = doc.documentElement;
      const totalHeight = Math.max(root.scrollHeight, doc.body?.scrollHeight ?? 0);
      win.scrollTo({ top: totalHeight, behavior: 'smooth' });
    },
    wait: (ms, signal) => new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      if (signal.aborted) {
        finish();
        return;
      }
      timer = setTimeout(finish, ms);
      signal.addEventListener('abort', finish, { once: true });
    }),
  };
}

export const browserScrollEnvironment: ScrollEnvironment = createBrowserScrollEnvironment(document, window);
