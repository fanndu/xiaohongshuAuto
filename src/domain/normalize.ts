import type { CountValue } from './types';

export function parseCount(rawInput: string | null | undefined): CountValue {
  const raw = (rawInput ?? '').trim();
  if (!raw || raw === '隐藏') return { raw, value: null };

  const normalized = raw.replace(/,/g, '').replace(/\+$/, '');
  const match = normalized.match(/^([\d]+(?:\.\d+)?)\s*([万千])?$/);
  if (!match) return { raw, value: null };

  const amount = Number(match[1]);
  const multiplier = match[2] === '万' ? 10000 : match[2] === '千' ? 1000 : 1;
  return { raw, value: Number.isFinite(amount) ? amount * multiplier : null };
}

export function normalizeNoteUrl(
  href: string | null | undefined,
  base = 'https://www.xiaohongshu.com',
): string {
  if (!href?.trim()) return '';
  if (/\s/.test(href)) return '';
  try {
    const url = new URL(href.trim(), base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

export function extractNoteId(href: string | null | undefined): string {
  const normalized = normalizeNoteUrl(href);
  if (!normalized) return '';
  try {
    const pathname = new URL(normalized).pathname;
    const match = pathname.match(/^\/(?:explore|discovery\/item)\/([^/]+)$/);
    return match?.[1] ?? '';
  } catch {
    return '';
  }
}

export function sanitizeFilenamePart(input: string | null | undefined): string {
  const sanitized = (input ?? '').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  return sanitized || '未命名博主';
}

export function formatLocalDateTime(
  date = new Date(),
  timezoneOffsetMinutes = date.getTimezoneOffset(),
): string {
  const local = new Date(date.getTime() - timezoneOffsetMinutes * 60_000);
  const pad = (value: number) => String(value).padStart(2, '0');
  const sign = timezoneOffsetMinutes > 0 ? '-' : '+';
  const absoluteOffset = Math.abs(timezoneOffsetMinutes);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`
    + `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`
    + `${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
}
