import { createProfileNavigationSynchronizer, createProfileRouteLifecycle, mountCollector } from '../../src/app/mount';

export default defineContentScript({
  matches: ['https://xiaohongshu.com/*', 'https://*.xiaohongshu.com/*'],
  runAt: 'document_idle',
  main(ctx) {
    const lifecycle = createProfileRouteLifecycle(mountCollector);
    const navigation = createProfileNavigationSynchronizer(lifecycle, () => location.href);
    // Invalidations are registered before the first mount so every mounted resource
    // has a lifecycle owner, including a script invalidated during initial sync.
    ctx.onInvalidated(() => navigation.dispose());
    ctx.addEventListener(window, 'wxt:locationchange', event => navigation.notify(event.newUrl.href));
    navigation.syncInitial();
  },
});
