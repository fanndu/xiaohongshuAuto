import { browserScrollEnvironment, collectUntilStable } from '../collection/scroll-coordinator';
import { formatLocalDateTime } from '../domain/normalize';
import { canonicalProfileRoute } from '../domain/routes';
import type { CollectionResult } from '../domain/types';
import type { ScrollEnvironment } from '../collection/scroll-coordinator';
import { parseDomPage } from '../parsing/dom';
import { mergeProfile } from '../parsing/merge';
import { parseStructuredPage } from '../parsing/structured-data';
import { FloatingControl, type UiActions } from '../ui/floating-control';
import { CollectorController } from './collector-controller';

export type Unmount = () => void;

/** The route has committed before its profile document/state has reconciled. */
export class ProfileDocumentNotReadyError extends Error {
  constructor() {
    super('Profile document is not ready for the current route');
    this.name = 'ProfileDocumentNotReadyError';
  }
}

type MountedControl = Pick<FloatingControl, 'destroy' | 'render'>;

/** Optional boundaries for integration tests; production uses all defaults. */
export interface MountCollectorOptions {
  createControl?: (actions: UiActions) => MountedControl;
  now?: () => Date;
  environment?: ScrollEnvironment;
  exportResult?: (result: CollectionResult) => Promise<void>;
}

/** Mounts the collector UI and binds it to the current profile document. */
export function mountCollector(
  url = location.href,
  lifecycleSignal?: AbortSignal,
  options: MountCollectorOptions = {},
): Unmount {
  const route = canonicalProfileRoute(url);
  if (!route) throw new TypeError('Collector can only mount on a safe profile route');
  const profileUrl = route.url;
  let controller!: CollectorController;
  let ui: MountedControl | undefined;
  try {
    const readPages = () => {
      const structured = parseStructuredPage(document, profileUrl);
      const dom = parseDomPage(document, profileUrl);
      const structuredCurrent = structured.identityStatus === 'valid' && structured.userId === route.key
        && structured.hasProfileEvidence && structured.hasNotesContainer;
      const domCurrent = dom.identityStatus === 'valid' && dom.userId === route.key
        && dom.hasProfileEvidence && dom.hasWorksContainer;
      // Sources are independently route-bound. A stale source can never enrich a current one.
      if (!structuredCurrent && !domCurrent) throw new ProfileDocumentNotReadyError();
      return {
        structured: structuredCurrent ? structured : { profile: null, notes: [] },
        dom: domCurrent ? dom : { profile: {}, notes: [] },
      };
    };
    // Validate before creating controls so lifecycle polling can retry a loading/error document cleanly.
    readPages();
    ui = (options.createControl ?? (actions => new FloatingControl(actions)))({
      start: () => controller.start(),
      stop: () => controller.stop(),
      retry: () => controller.retry(),
      exportPartial: () => controller.exportPartial(),
    });
    controller = new CollectorController({
      ui,
      readProfile: () => {
        const page = readPages();
        return mergeProfile(
          page.structured.profile,
          page.dom.profile,
          profileUrl,
          formatLocalDateTime(options.now ? options.now() : new Date()),
        );
      },
      collect: (signal, onProgress, retainedNotes) => {
        const first = readPages();
        return collectUntilStable({
          seed: [...retainedNotes, ...first.structured.notes, ...first.dom.notes],
          readNotes: () => {
            const page = readPages();
            return [...page.structured.notes, ...page.dom.notes];
          },
          onProgress,
          signal,
          environment: options.environment ?? browserScrollEnvironment,
        },
        );
      },
      // WXT 0.20.27 inlines content-script dynamic imports as a lazy module initializer;
      // keeping this import here defers workbook/ExcelJS evaluation until export is requested.
      exportResult: options.exportResult ?? (async result => (await import('../export/workbook')).downloadWorkbook(
          result,
          lifecycleSignal ? { signal: lifecycleSignal } : {},
        )),
    });
    ui.render({ phase: 'ready' });

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      try {
        controller.dispose();
      } finally {
        ui?.destroy();
      }
    };
  } catch (error) {
    try {
      controller?.dispose();
    } finally {
      ui?.destroy();
    }
    throw error;
  }
}

/** Keeps a single profile collector aligned with SPA navigation. */
export function createProfileRouteLifecycle(mount: (url: string, signal: AbortSignal) => Unmount): {
  sync(url: string): void;
  dispose(): void;
} {
  let active: { key: string; controller: AbortController; cleanup: Unmount } | undefined;
  let disposed = false;
  let transition = 0;

  const unmountActive = (): void => {
    const current = active;
    // State must be clear before callbacks run: either callback may throw or re-enter.
    active = undefined;
    try {
      current?.cleanup();
    } finally {
      current?.controller.abort();
    }
  };

  const discardStaleMount = (cleanup: Unmount, controller: AbortController): void => {
    try {
      cleanup();
    } finally {
      controller.abort();
    }
  };

  return {
    sync(url) {
      if (disposed) return;
      const route = canonicalProfileRoute(url);
      if (route?.key === active?.key) return;
      const token = ++transition;
      unmountActive();
      if (disposed || token !== transition || !route) return;

      const controller = new AbortController();
      try {
        const cleanup = mount(route.url, controller.signal);
        // A cleanup or mount callback can re-enter sync/dispose. Its later transition
        // owns the lifecycle; this older mount must not overwrite it or leak resources.
        if (disposed || token !== transition) {
          discardStaleMount(cleanup, controller);
          return;
        }
        active = { key: route.key, controller, cleanup };
      } catch (error) {
        controller.abort();
        throw error;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      transition += 1;
      unmountActive();
    },
  };
}

interface RouteLifecycle {
  sync(url: string): void;
  dispose(): void;
}

/** Samples committed location.href; WXT notifications only wake this monitor early. */
export function createProfileNavigationSynchronizer(lifecycle: RouteLifecycle, getLocationHref: () => string): {
  syncInitial(): void;
  notify(expectedUrl: string): void;
  dispose(): void;
} {
  let interval: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  const reconcile = (): void => {
    if (disposed) return;
    try {
      lifecycle.sync(getLocationHref());
    } catch {
      // A transient mount failure must not stop later committed-location retries.
    }
  };

  const startMonitoring = (): void => {
    if (interval === undefined) interval = setInterval(reconcile, 250);
  };

  return {
    syncInitial() {
      if (disposed) return;
      startMonitoring();
      reconcile();
    },
    notify(_expectedUrl) {
      if (disposed) return;
      startMonitoring();
      reconcile();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (interval !== undefined) clearInterval(interval);
      interval = undefined;
      lifecycle.dispose();
    },
  };
}
