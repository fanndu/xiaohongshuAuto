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
  readNotes: () => readonly NoteRecord[] | Promise<readonly NoteRecord[]>;
  onProgress?: (count: number) => void;
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

/** Reads, deduplicates, and scrolls until three bottom rounds show no new notes. */
export async function collectUntilStable(options: CollectUntilStableOptions): Promise<CollectionProgress> {
  const stableRounds = options.stableRounds ?? 3;
  const maxStalledRounds = options.maxStalledRounds ?? 12;
  const intervalMs = options.intervalMs ?? 1200;
  if (!validInteger(stableRounds, 1) || !validInteger(maxStalledRounds, 1) || !validInteger(intervalMs, 0)) {
    throw new RangeError('Collection round counts must be positive integers and intervalMs must be a non-negative integer');
  }

  const store = new NoteStore();
  store.addMany(options.seed ?? []);
  const stopped = (): CollectionProgress => ({ reason: 'stopped', notes: store.values() });
  let stable = 0;
  let stalled = 0;

  while (true) {
    if (options.signal?.aborted) return stopped();

    try {
      const hasAccessBlock = options.environment.hasAccessBlock();
      if (options.signal?.aborted) return stopped();
      if (hasAccessBlock) {
        throw new CollectionError('ACCESS_BLOCKED', store.values());
      }
    } catch (error) {
      if (options.signal?.aborted) return stopped();
      if (error instanceof CollectionError) throw error;
      return throwStalled(store, error);
    }

    let read: readonly NoteRecord[];
    try {
      read = await options.readNotes();
    } catch (error) {
      if (options.signal?.aborted) return stopped();
      return throwStalled(store, error);
    }
    const added = store.addMany(read);
    if (options.signal?.aborted) return stopped();
    try {
      options.onProgress?.(store.size);
    } catch (error) {
      if (options.signal?.aborted) return stopped();
      return throwStalled(store, error);
    }
    if (options.signal?.aborted) return stopped();

    let atBottom: boolean;
    try {
      atBottom = options.environment.atBottom();
    } catch (error) {
      if (options.signal?.aborted) return stopped();
      return throwStalled(store, error);
    }
    if (options.signal?.aborted) return stopped();
    if (added === 0 && atBottom) stable += 1;
    else stable = 0;
    stalled = added === 0 ? stalled + 1 : 0;

    if (options.signal?.aborted) return stopped();
    if (stable >= stableRounds) return { reason: 'complete', notes: store.values() };
    if (stalled >= maxStalledRounds) return throwStalled(store);
    if (options.signal?.aborted) return stopped();

    try {
      options.environment.scrollToBottom();
      if (options.signal?.aborted) return stopped();
      await options.environment.wait(intervalMs, options.signal ?? new AbortController().signal);
    } catch (error) {
      if (options.signal?.aborted) return stopped();
      return throwStalled(store, error);
    }
    if (options.signal?.aborted) return stopped();
  }
}

function isVisible(element: Element, win: Window): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') return false;
    const style = win.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  }
  return true;
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
        '.captcha-modal',
        '[class*="captcha"]',
        '[class*="verify"]',
        '[class*="verification"]',
        '[class*="access-frequency"]',
        '[class*="risk-control"]',
      ].join(','));
      return [...candidates].some(element => {
        const text = element.textContent?.trim() ?? '';
        return isVisible(element, win)
          && /(请完成验证|安全验证|访问频繁|操作频繁)/.test(text)
          && !/(教程|帮助|说明|如何(?:完成)?验证)/.test(text);
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
