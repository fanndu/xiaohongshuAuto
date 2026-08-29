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
  const candidates: string[] = [];
  let index = 0;
  while (index < srcset.length) {
    while (index < srcset.length && /[\t\n\f\r ,]/.test(srcset[index] ?? '')) index += 1;
    if (index >= srcset.length) break;

    const start = index;
    while (index < srcset.length && !/[\t\n\f\r ]/.test(srcset[index] ?? '')) index += 1;
    const collected = srcset.slice(start, index);
    const candidate = collected.replace(/,+$/, '');
    if (candidate) candidates.push(candidate);

    if (candidate !== collected) continue;

    let parentheses = 0;
    while (index < srcset.length) {
      const char = srcset[index] ?? '';
      if (char === '(') parentheses += 1;
      else if (char === ')' && parentheses > 0) parentheses -= 1;
      else if (char === ',' && parentheses === 0) {
        index += 1;
        break;
      }
      index += 1;
    }
  }
  return candidates;
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
        ...srcsetCandidates(image.getAttribute('data-srcset') ?? ''),
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
  return [...doc.querySelectorAll('.note-item, [class*="note-item"], section.feeds-page article')];
}

function noteLinks(card: Element, base: string): Array<{ id: string; noteUrl: string }> {
  const links: Array<{ id: string; noteUrl: string }> = [];
  for (const anchor of card.querySelectorAll('a[href*="/explore/"], a[href*="/discovery/item/"]')) {
    const noteUrl = normalizeNoteUrl(anchor.getAttribute('href'), base);
    const id = extractNoteId(noteUrl);
    if (noteUrl && id) links.push({ id, noteUrl });
  }
  return links;
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
  const links = noteLinks(card, base);
  if (new Set(links.map(link => link.id)).size !== 1) return null;
  const link = links[0];
  if (!link) return null;

  const videoMarker = card.matches('[data-note-type="video"], [data-testid="video"], [aria-label*="视频"]')
    || card.querySelector([
    'video',
    '[data-testid="video"]',
    '[data-note-type="video"]',
    '[class~="video-icon"]',
    '[aria-label*="视频"]',
  ].join(','));
  const imageMarker = card.matches('[data-note-type="image"], [data-testid="image"], [aria-label*="图文"]')
    || card.querySelector([
      '[data-testid="image"]',
      '[data-note-type="image"]',
      '[class~="image-icon"]',
      '[aria-label*="图文"]',
    ].join(','));
  return {
    id: link.id,
    title: firstText(card, ['[data-testid="note-title"]', '.title', '[class*="title"]', 'h2', 'h3']),
    noteUrl: link.noteUrl,
    // Covers are common to video and image posts, so an <img> is not type evidence.
    type: videoMarker ? 'video' : imageMarker ? 'image' : 'unknown',
    likes: parseCount(likesRaw(card)),
    coverUrl: imageUrl(card, ['a.cover img', 'img'], base),
    exportNotes: [],
  };
}

function mergeDuplicateNote(existing: NoteRecord, later: NoteRecord): NoteRecord {
  // Later child cards win title/likes/cover conflicts, while video evidence is monotonic.
  return {
    ...existing,
    id: later.id || existing.id,
    noteUrl: later.noteUrl || existing.noteUrl,
    title: later.title || existing.title,
    type: existing.type === 'video' || later.type === 'video'
      ? 'video'
      : later.type === 'unknown' ? existing.type : later.type,
    likes: later.likes.raw ? later.likes : existing.likes,
    coverUrl: later.coverUrl || existing.coverUrl,
    exportNotes: [...new Set([...existing.exportNotes, ...later.exportNotes])],
  };
}

function uniqueNotes(cards: Element[], base: string): NoteRecord[] {
  const notes: NoteRecord[] = [];
  const indexesById = new Map<string, number>();
  const indexesByUrl = new Map<string, number>();
  for (const card of cards) {
    const note = mapNote(card, base);
    if (!note) continue;
    const existingIndex = indexesById.get(note.id) ?? indexesByUrl.get(note.noteUrl);
    if (existingIndex === undefined) {
      indexesById.set(note.id, notes.length);
      indexesByUrl.set(note.noteUrl, notes.length);
      notes.push(note);
      continue;
    }
    const existing = notes[existingIndex];
    if (!existing) continue;
    const merged = mergeDuplicateNote(existing, note);
    notes[existingIndex] = merged;
    indexesById.set(merged.id, existingIndex);
    indexesByUrl.set(merged.noteUrl, existingIndex);
  }
  return notes;
}

function profileRootElement(doc: Document): Element | null {
  for (const selector of ['[data-testid="profile-header"]', 'section.user', '.user-info']) {
    const root = doc.querySelector(selector);
    if (root) return root;
  }
  return null;
}

function profileRoot(doc: Document): ParentNode {
  return profileRootElement(doc) ?? doc;
}

/** A DOM fallback is safe only when it looks like a real profile, not a generic page fragment. */
export function isRecognizedDomProfile(doc: Document): boolean {
  const root = profileRootElement(doc);
  if (!root) return false;
  const profile = parseDomPage(doc, location.href);
  return Boolean(profile.profile.accountName || profile.profile.redId || profile.profile.avatarUrl);
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
    notes: uniqueNotes(noteCards(doc), profileUrl),
  };
}
