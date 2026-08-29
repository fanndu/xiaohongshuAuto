import { createProfileRouteLifecycle, mountCollector } from '../../src/app/mount';

export default defineContentScript({
  matches: ['https://xiaohongshu.com/*', 'https://*.xiaohongshu.com/*'],
  runAt: 'document_idle',
  main(ctx) {
    const lifecycle = createProfileRouteLifecycle(mountCollector);
    lifecycle.sync(location.href);
    ctx.addEventListener(window, 'wxt:locationchange', event => lifecycle.sync(event.newUrl.href));
    ctx.onInvalidated(() => lifecycle.dispose());
  },
});
