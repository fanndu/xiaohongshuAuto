export interface ProfileRoute {
  /** Stable identity for a profile, independent of query, hash, or host alias. */
  key: string;
  /** The one URL persisted into exported profile data. */
  url: string;
}

/** Parses a safe Xiaohongshu user-profile route into its canonical identity and URL. */
export function canonicalProfileRoute(value: string): ProfileRoute | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;

    // URL normalizes a default port away, so inspect the original authority too.
    const authority = /^https:\/\/([^/?#]*)/i.exec(value)?.[1] ?? '';
    if (!authority || authority.includes('@') || /:\d*$/.test(authority)) return null;
    if (!/^(?:[a-z0-9-]+\.)*xiaohongshu\.com$/i.test(url.hostname)) return null;

    const match = /^\/user\/profile\/([^/]+)\/?$/.exec(url.pathname);
    const id = match?.[1];
    // Route identifiers are deliberately ASCII-only. URL.pathname preserves percent
    // escapes, so this also rejects encoded separators and encoded safe characters.
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
    return { key: id, url: `https://www.xiaohongshu.com/user/profile/${id}` };
  } catch {
    return null;
  }
}

/** Returns whether a URL is exactly a safe Xiaohongshu user-profile route. */
export function isProfileUrl(value: string): boolean {
  return canonicalProfileRoute(value) !== null;
}
