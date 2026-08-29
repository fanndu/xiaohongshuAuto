import { browserScrollEnvironment, collectUntilStable } from '../collection/scroll-coordinator';
import { formatLocalDateTime } from '../domain/normalize';
import { canonicalProfileRoute } from '../domain/routes';
import { parseDomPage } from '../parsing/dom';
import { mergeProfile } from '../parsing/merge';
import { parseStructuredPage } from '../parsing/structured-data';
import { FloatingControl } from '../ui/floating-control';
import { CollectorController } from './collector-controller';

export type Unmount = () => void;

/** Mounts the collector UI and binds it to the current profile document. */
export function mountCollector(url = location.href, lifecycleSignal?: AbortSignal): Unmount {
  const route = canonicalProfileRoute(url);
  if (!route) throw new TypeError('Collector can only mount on a safe profile route');
  const profileUrl = route.url;
  let controller!: CollectorController;
  let ui: FloatingControl | undefined;
  try {
    ui = new FloatingControl({
      start: () => controller.start(),
      stop: () => controller.stop(),
      retry: () => controller.retry(),
      exportPartial: () => controller.exportPartial(),
    });
    const readPages = () => ({
      structured: parseStructuredPage(document, profileUrl),
      dom: parseDomPage(document, profileUrl),
    });

    controller = new CollectorController({
      ui,
      readProfile: () => {
        const page = readPages();
        return mergeProfile(page.structured.profile, page.dom.profile, profileUrl, formatLocalDateTime());
      },
      collect: (signal, onProgress) => {
        const first = readPages();
        return collectUntilStable({
          seed: [...first.structured.notes, ...first.dom.notes],
          readNotes: () => {
            const page = readPages();
            return [...page.structured.notes, ...page.dom.notes];
          },
          onProgress,
          signal,
          environment: browserScrollEnvironment,
        },
        );
      },
      // WXT 0.20.27 inlines content-script dynamic imports as a lazy module initializer;
      // keeping this import here defers workbook/ExcelJS evaluation until export is requested.
      exportResult: async result => (await import('../export/workbook')).downloadWorkbook(
        result,
        lifecycleSignal ? { signal: lifecycleSignal } : {},
      ),
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
  let activeKey: string | undefined;
  let lifecycleController: AbortController | undefined;
  let unmount: Unmount | undefined;

  const unmountActive = (): void => {
    const cleanup = unmount;
    const controller = lifecycleController;
    // State must be clear before callbacks run: either callback may throw or re-enter.
    unmount = undefined;
    lifecycleController = undefined;
    activeKey = undefined;
    try {
      cleanup?.();
    } finally {
      controller?.abort();
    }
  };

  return {
    sync(url) {
      const route = canonicalProfileRoute(url);
      if (route?.key === activeKey) return;
      unmountActive();
      if (!route) return;

      const controller = new AbortController();
      try {
        const cleanup = mount(route.url, controller.signal);
        unmount = cleanup;
        lifecycleController = controller;
        activeKey = route.key;
      } catch (error) {
        controller.abort();
        throw error;
      }
    },
    dispose() {
      unmountActive();
    },
  };
}

interface RouteLifecycle {
  sync(url: string): void;
  dispose(): void;
}

function navigationDestinationKey(value: string): string | null {
  const profile = canonicalProfileRoute(value);
  if (profile) return `profile:${profile.key}`;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

/** Reconciles WXT notifications only after location.href has committed to that destination. */
export function createProfileNavigationSynchronizer(lifecycle: RouteLifecycle, getLocationHref: () => string): {
  syncInitial(): void;
  notify(expectedUrl: string): void;
  dispose(): void;
} {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  return {
    syncInitial() {
      if (!disposed) lifecycle.sync(getLocationHref());
    },
    notify(expectedUrl) {
      if (disposed) return;
      const expected = navigationDestinationKey(expectedUrl);
      if (!expected) return;
      const token = ++generation;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (disposed || token !== generation) return;
        const current = getLocationHref();
        if (navigationDestinationKey(current) === expected) lifecycle.sync(current);
      }, 0);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      lifecycle.dispose();
    },
  };
}
