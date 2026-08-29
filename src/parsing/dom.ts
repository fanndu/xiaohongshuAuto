import { extractNoteId, normalizeNoteUrl, parseCount } from '../domain/normalize';
import type { NoteRecord, ProfileRecord } from '../domain/types';

const text = (element: Element | null): string => (element?.textContent ?? '').trim();
const normalizedText = (element: Element): string => text(element).replace(/\s+/g, '');

function firstText(root: ParentNode, selectors: string[]): string {
  for (const selector of selectors) {
    const value = text(root.querySelector(selector));
    if (value) return value;
  }
  return '';
}

function stripLabel(value: string, label: string): string {
  return value.replace(new RegExp(`^\\s*${label}\\s*[：:]?\\s*`, 'i'), '').trim();
}

function safeImageUrl(value: string, base: string): string {
  const candidate = value.trim();
  if (!candidate) return '';
  try {
    const url = new URL(candidate, base);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function srcsetCandidates(srcset: string): string[] {
  return srcset.split(',').map(candidate => candidate.trim().split(/\s+/, 1)[0] ?? '');
}

function imageUrl(root: ParentNode, selectors: string[], base: string): string {
  const seen = new Set<HTMLImageElement>();
  for (const selector of selectors) {
    for (const image of root.querySelectorAll<HTMLImageElement>(selector)) {
      if (seen.has(image)) continue;
      seen.add(image);
      const candidates = [
        image.currentSrc,
        image.getAttribute('src') ?? '',
        image.getAttribute('data-src') ?? '',
        image.getAttribute('data-original') ?? '',
        ...srcsetCandidates(image.getAttribute('srcset') ?? ''),
      ];
      for (const candidate of candidates) {
        const url = candidate ? safeImageUrl(candidate, base) : '';
        if (url) return url;
      }
    }
  }
  return '';
}

function usableCount(root: Element, selectors: string[], label?: Element): string {
  const candidates = new Set<Element>([root]);
  for (const selector of selectors) {
    for (const candidate of root.querySelectorAll(selector)) candidates.add(candidate);
  }
  for (const candidate of candidates) {
    const raw = text(candidate);
    if (!raw || candidate === label || (label && normalizedText(candidate) === normalizedText(label))) continue;
    const parsed = parseCount(raw);
    if (parsed.value !== null || parsed.raw === '隐藏') return parsed.raw;
  }
  return '';
}

function labelElement(item: Element, label: string): Element | null {
  for (const candidate of item.querySelectorAll('*')) {
    if (normalizedText(candidate) === label) return candidate;
  }
  return null;
}

function statRaw(doc: Document, label: string): string {
  const items = doc.querySelectorAll('.data-info .data-item, [data-testid="profile-stat"]');
  for (const item of items) {
    const semanticLabel = labelElement(item, label);
    if (!semanticLabel) continue;
    const count = usableCount(item, [
      '[data-testid="stat-count"]',
      'strong',
      '.count',
      'b',
      'span',
    ], semanticLabel);
    if (count) return count;
  }
  return '';
}

function noteCards(doc: Document): Element[] {
  const cards = new Set<Element>();
  for (const selector of ['.note-item', '[class*="note-item"]', 'section.feeds-page article']) {
    for (const card of doc.querySelectorAll(selector)) cards.add(card);
  }
  return [...cards].filter(card => {
    for (let ancestor = card.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (cards.has(ancestor)) return false;
    }
    return true;
  });
}

function noteLink(card: Element, base: string): { id: string; noteUrl: string } | null {
  for (const anchor of card.querySelectorAll('a[href*="/explore/"], a[href*="/discovery/item/"]')) {
    const noteUrl = normalizeNoteUrl(anchor.getAttribute('href'), base);
    const id = extractNoteId(noteUrl);
    if (noteUrl && id) return { id, noteUrl };
  }
  return null;
}

function likesRaw(card: Element): string {
  const roots = new Set<Element>();
  for (const selector of ['[data-testid="like-count"]', '.like-count', '[class*="like"]']) {
    for (const root of card.querySelectorAll(selector)) roots.add(root);
  }
  for (const root of roots) {
    const count = usableCount(root, ['strong', '.count', 'b', 'span']);
    if (count) return count;
  }
  return '';
}

function mapNote(card: Element, base: string): NoteRecord | null {
  const link = noteLink(card, base);
  if (!link) return null;

  const videoMarker = card.querySelector([
    'video',
    '[data-testid="video"]',
    '[class*="video"]',
    '[aria-label*="视频"]',
  ].join(','));
  return {
    id: link.id,
    title: firstText(card, ['[data-testid="note-title"]', '.title', '[class*="title"]', 'h2', 'h3']),
    noteUrl: link.noteUrl,
    type: videoMarker ? 'video' : 'image',
    likes: parseCount(likesRaw(card)),
    coverUrl: imageUrl(card, ['a.cover img', 'img'], base),
    exportNotes: [],
  };
}

function profileRoot(doc: Document): ParentNode {
  for (const selector of ['[data-testid="profile-header"]', 'section.user', '.user-info']) {
    const root = doc.querySelector(selector);
    if (root) return root;
  }
  return doc;
}

export function parseDomPage(
  doc: Document,
  profileUrl: string,
): { profile: Partial<ProfileRecord>; notes: NoteRecord[] } {
  const root = profileRoot(doc);
  const rawRedId = firstText(root, [
    '[data-testid="user-redId"]',
    '[data-testid="user-red-id"]',
    '[data-testid="red-id"]',
    '.user-redId',
    '.user-redid',
    '[class*="redId"]',
  ]);
  const rawIpLocation = firstText(root, [
    '[data-testid="user-IP"]',
    '[data-testid="ip-location"]',
    '.user-IP',
    '.user-ip',
    '.ip-location',
  ]);

  return {
    profile: {
      profileUrl,
      accountName: firstText(root, [
        '[data-testid="user-name"]',
        '[data-testid="nickname"]',
        '.user-name',
        '.nickname',
      ]),
      redId: stripLabel(rawRedId, '小红书号'),
      avatarUrl: imageUrl(root, [
        'img[data-testid="user-avatar"]',
        '[data-testid="user-avatar"] img',
        'img[data-testid="avatar"]',
        '[data-testid="avatar"] img',
        'img.user-avatar',
        '.user-avatar img',
        'img[class*="avatar"]',
        '[class*="avatar"] img',
      ], profileUrl),
      description: firstText(root, [
        '[data-testid="user-desc"]',
        '[data-testid="description"]',
        '.user-desc',
        '.desc',
        '[class*="user-desc"]',
      ]),
      ipLocation: stripLabel(rawIpLocation, 'IP属地'),
      following: parseCount(statRaw(doc, '关注')),
      followers: parseCount(statRaw(doc, '粉丝')),
      likedAndCollected: parseCount(statRaw(doc, '获赞与收藏')),
      exportNotes: [],
    },
    notes: noteCards(doc).map(card => mapNote(card, profileUrl)).filter((note): note is NoteRecord => note !== null),
  };
}
