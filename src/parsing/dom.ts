import { extractNoteId, normalizeNoteUrl, parseCount } from '../domain/normalize';
import type { NoteRecord, ProfileRecord } from '../domain/types';

const text = (element: Element | null): string => (element?.textContent ?? '').trim();

function firstText(doc: ParentNode, selectors: string[]): string {
  for (const selector of selectors) {
    const value = text(doc.querySelector(selector));
    if (value) return value;
  }
  return '';
}

function firstAttribute(doc: ParentNode, selectors: string[], attribute: string): string {
  for (const selector of selectors) {
    const element = doc.querySelector(selector);
    const value = element?.getAttribute(attribute)?.trim() ?? '';
    if (value) return value;
  }
  return '';
}

function stripLabel(value: string, label: string): string {
  return value.replace(new RegExp(`^\\s*${label}\\s*[：:]?\\s*`, 'i'), '').trim();
}

function statRaw(doc: Document, label: string): string {
  const items = doc.querySelectorAll('.data-info .data-item, [data-testid="profile-stat"]');
  for (const item of items) {
    if (!text(item).includes(label)) continue;
    const count = firstText(item, [
      '[data-testid="stat-count"]',
      '.count',
      '[class*="count"]',
      'strong',
      'b',
    ]);
    if (count) return count;
  }
  return '';
}

function noteCards(doc: Document): Element[] {
  const cards = new Set<Element>();
  for (const selector of ['.note-item', '[class*="note-item"]', 'section.feeds-page article']) {
    for (const card of doc.querySelectorAll(selector)) cards.add(card);
  }
  return [...cards];
}

function mapNote(card: Element): NoteRecord | null {
  const link = [...card.querySelectorAll('a[href]')].find(anchor => {
    const href = anchor.getAttribute('href') ?? '';
    return href.includes('/explore/') || href.includes('/discovery/item/');
  });
  const noteUrl = normalizeNoteUrl(link?.getAttribute('href'));
  const id = extractNoteId(noteUrl);
  if (!noteUrl || !id) return null;

  const likes = firstText(card, [
    '[data-testid="like-count"]',
    '.like-count',
    '[class*="like"]',
  ]);
  const videoMarker = card.querySelector([
    'video',
    '[data-testid="video"]',
    '[class*="video"]',
    '[aria-label*="视频"]',
  ].join(','));
  return {
    id,
    title: firstText(card, ['[data-testid="note-title"]', '.title', '[class*="title"]', 'h2', 'h3']),
    noteUrl,
    type: videoMarker ? 'video' : 'image',
    likes: parseCount(likes),
    coverUrl: firstAttribute(card, ['img'], 'src'),
    exportNotes: [],
  };
}

export function parseDomPage(
  doc: Document,
  profileUrl: string,
): { profile: Partial<ProfileRecord>; notes: NoteRecord[] } {
  const rawRedId = firstText(doc, [
    '.user-redId',
    '.user-redid',
    '[data-testid="user-redId"]',
    '[data-testid="user-red-id"]',
    '[data-testid="red-id"]',
    '[class*="redId"]',
  ]);
  const rawIpLocation = firstText(doc, [
    '.user-IP',
    '.user-ip',
    '[data-testid="user-IP"]',
    '[data-testid="ip-location"]',
    '.ip-location',
  ]);
  const avatarUrl = firstAttribute(doc, [
    'img.user-avatar',
    '.user-avatar img',
    'img[data-testid="user-avatar"]',
    '[data-testid="user-avatar"] img',
    'img[data-testid="avatar"]',
    '[data-testid="avatar"] img',
    'img[class*="avatar"]',
  ], 'src');

  return {
    profile: {
      profileUrl,
      accountName: firstText(doc, ['.user-name', '[data-testid="user-name"]', '.nickname', '[data-testid="nickname"]']),
      redId: stripLabel(rawRedId, '小红书号'),
      avatarUrl,
      description: firstText(doc, ['.user-desc', '[data-testid="user-desc"]', '.desc', '[data-testid="description"]']),
      ipLocation: stripLabel(rawIpLocation, 'IP属地'),
      following: parseCount(statRaw(doc, '关注')),
      followers: parseCount(statRaw(doc, '粉丝')),
      likedAndCollected: parseCount(statRaw(doc, '获赞与收藏')),
      exportNotes: [],
    },
    notes: noteCards(doc).map(mapNote).filter((note): note is NoteRecord => note !== null),
  };
}
