import { browserScrollEnvironment, collectUntilStable } from '../collection/scroll-coordinator';
import { formatLocalDateTime } from '../domain/normalize';
import { isProfileUrl } from '../domain/routes';
import { parseDomPage } from '../parsing/dom';
import { mergeProfile } from '../parsing/merge';
import { parseStructuredPage } from '../parsing/structured-data';
import { FloatingControl } from '../ui/floating-control';
import { CollectorController } from './collector-controller';

export type Unmount = () => void;

/** Mounts the collector UI and binds it to the current profile document. */
export function mountCollector(url = location.href): Unmount {
  const profile = new URL(url);
  const profileUrl = `${profile.origin}${profile.pathname}`;
  let controller!: CollectorController;
  const ui = new FloatingControl({
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
      });
    },
    // WXT 0.20.27 inlines content-script dynamic imports as a lazy module initializer;
    // keeping this import here defers workbook/ExcelJS evaluation until export is requested.
    exportResult: async result => (await import('../export/workbook')).downloadWorkbook(result),
  });
  ui.render({ phase: 'ready' });

  return () => {
    controller.dispose();
    ui.destroy();
  };
}

/** Keeps a single profile collector aligned with SPA navigation. */
export function createProfileRouteLifecycle(mount: (url: string) => Unmount): {
  sync(url: string): void;
  dispose(): void;
} {
  let activeUrl: string | undefined;
  let unmount: Unmount | undefined;

  return {
    sync(url) {
      if (url === activeUrl) return;
      unmount?.();
      unmount = undefined;
      activeUrl = url;
      if (isProfileUrl(url)) unmount = mount(url);
    },
    dispose() {
      unmount?.();
      unmount = undefined;
      activeUrl = undefined;
    },
  };
}
