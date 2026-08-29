import type { CountValue } from './types';

export function parseCount(rawInput: string | null | undefined): CountValue {
  const raw = (rawInput ?? '').trim();
  if (!raw || raw === '隐藏') return { raw, value: null };

  const normalized = raw.replace(/\+$/, '');
  const hasUnit = /[万千]$/.test(normalized);
  const numericPart = hasUnit ? normalized.slice(0, -1) : normalized;
  const validNumber = numericPart.includes(',')
    ? /^\d{1,3}(,\d{3})+$/.test(numericPart)
    : hasUnit
      ? /^\d+(?:\.\d+)?$/.test(numericPart)
      : /^\d+$/.test(numericPart);
  if (!validNumber) return { raw, value: null };

  const numberText = numericPart.replace(/,/g, '');
  const amount = Number(numberText);
  const multiplier = normalized.endsWith('万') ? 10000 : normalized.endsWith('千') ? 1000 : 1;
  const value = multiplier === 1 ? amount : Math.round(amount * multiplier);
  return { raw, value: Number.isSafeInteger(value) ? value : null };
}

export function normalizeNoteUrl(
  href: string | null | undefined,
  base = 'https://www.xiaohongshu.com',
): string {
  if (!href?.trim()) return '';
  if (/\s/.test(href)) return '';
  try {
    const url = new URL(href.trim(), base);
    if (url.protocol !== 'https:') return '';
    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'xiaohongshu.com' && !hostname.endsWith('.xiaohongshu.com')) return '';
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
  const sanitized = (input ?? '').trim().replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_');
  const truncated = [...sanitized].slice(0, 80).join('');
  return truncated || '未命名博主';
}

export function formatLocalDateTime(
  date = new Date(),
  timezoneOffsetMinutes = date.getTimezoneOffset(),
): string {
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(timezoneOffsetMinutes)
    || !Number.isInteger(timezoneOffsetMinutes) || Math.abs(timezoneOffsetMinutes) > 14 * 60) {
    throw new RangeError('Invalid date or timezone offset');
  }
  const local = new Date(date.getTime() - timezoneOffsetMinutes * 60_000);
  const pad = (value: number) => String(value).padStart(2, '0');
  const sign = timezoneOffsetMinutes > 0 ? '-' : '+';
  const absoluteOffset = Math.abs(timezoneOffsetMinutes);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`
    + `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`
    + `${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
}
