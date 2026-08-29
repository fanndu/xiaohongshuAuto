/** Returns whether a URL is exactly a Xiaohongshu user-profile route. */
export function isProfileUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return false;

    // URL normalizes a default port away, so inspect the original authority too.
    const authority = /^https:\/\/([^/?#]*)/i.exec(value)?.[1] ?? '';
    if (!authority || authority.includes('@') || /:\d*$/.test(authority)) return false;
    if (!/^(?:[a-z0-9-]+\.)*xiaohongshu\.com$/i.test(url.hostname)) return false;

    const match = /^\/user\/profile\/([^/]+)\/?$/.exec(url.pathname);
    if (!match?.[1]) return false;
    try {
      const id = decodeURIComponent(match[1]);
      return Boolean(id) && !/[\\/\u0000-\u001f\u007f]/.test(id);
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}
