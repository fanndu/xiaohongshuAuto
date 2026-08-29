import { parseCount } from '../domain/normalize';
import type { CountValue, ProfileRecord } from '../domain/types';

const string = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const result = string(value);
    if (result) return result;
  }
  return '';
}

function countRaw(value: unknown): string {
  if (value === null || typeof value !== 'object') return '';
  return string((value as { raw?: unknown }).raw);
}

function firstCount(structured: unknown, dom: unknown): CountValue {
  return parseCount(firstString(countRaw(structured), countRaw(dom)));
}

function missing(value: string): boolean {
  return !value;
}

export function mergeProfile(
  structured: Partial<ProfileRecord> | null,
  dom: Partial<ProfileRecord>,
  profileUrl: string,
  collectedAt: string,
): ProfileRecord {
  const structuredSource = structured ?? {};
  const accountName = firstString(structuredSource.accountName, dom.accountName);
  const redId = firstString(structuredSource.redId, dom.redId);
  const avatarUrl = firstString(structuredSource.avatarUrl, dom.avatarUrl);
  const description = firstString(structuredSource.description, dom.description);
  const ipLocation = firstString(structuredSource.ipLocation, dom.ipLocation);
  const following = firstCount(structuredSource.following, dom.following);
  const followers = firstCount(structuredSource.followers, dom.followers);
  const likedAndCollected = firstCount(structuredSource.likedAndCollected, dom.likedAndCollected);
  const exportNotes = [
    missing(accountName) ? '账号名缺失' : '',
    missing(redId) ? '小红书号缺失' : '',
    missing(avatarUrl) ? '头像链接缺失' : '',
    missing(description) ? '简介缺失' : '',
    missing(following.raw) ? '关注数缺失' : '',
    missing(followers.raw) ? '粉丝数缺失' : '',
    missing(likedAndCollected.raw) ? '获赞与收藏数缺失' : '',
  ].filter((note): note is string => Boolean(note));

  return {
    profileUrl,
    accountName,
    redId,
    avatarUrl,
    description,
    ipLocation,
    following,
    followers,
    likedAndCollected,
    collectedAt,
    exportNotes,
  };
}
