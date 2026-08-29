import { extractNoteId, normalizeNoteUrl, parseCount } from '../domain/normalize';
import { mergedExportNotes, mergeNoteType, NOTE_TYPE_CONFLICT } from '../domain/note-type';
import { canonicalProfileRoute } from '../domain/routes';
import type { NoteRecord, ProfileRecord } from '../domain/types';

export type PageIdentityStatus = 'missing' | 'valid' | 'conflict';

export interface DomPageResult {
  userId: string;
  identityStatus: PageIdentityStatus;
  hasProfileEvidence: boolean;
  hasWorksContainer: boolean;
  profile: Partial<ProfileRecord>;
  notes: NoteRecord[];
}

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

function statRaw(scope: ParentNode, label: string, directScopeOnly = false): string {
  const items = scope.querySelectorAll('.data-info .data-item, [data-testid="profile-stat"]');
  for (const item of items) {
    if (directScopeOnly && item.closest(PROFILE_HEADER_SELECTORS.join(','))) continue;
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

const WORKS_SELECTOR = '[data-testid="profile-notes"], [data-testid="works-container"], section.feeds-page';
const PROFILE_ROOT_SELECTORS = [
  '[data-testid="profile-page"]',
  '[data-testid="profile-scope"]',
  '.profile-page',
  '[data-testid="profile-header"]',
  'section.user',
  '.user-info',
];
const PROFILE_HEADER_SELECTORS = ['[data-testid="profile-header"]', 'section.user', '.user-info'];
const PROFILE_SCOPE_SELECTOR = '[data-testid="profile-page"], [data-testid="profile-scope"], .profile-page';

function elementIdentity(element: Element, base: string): { userId: string; identityStatus: PageIdentityStatus } {
  const values = new Set<string>();
  for (const attribute of ['data-user-id', 'data-userid', 'data-profile-user-id']) {
    const value = element.getAttribute(attribute)?.trim() ?? '';
    if (value) values.add(value);
  }
  for (const anchor of element.querySelectorAll('a[href*="/user/profile/"]')) {
    try {
      const route = canonicalProfileRoute(new URL(anchor.getAttribute('href') ?? '', base).href);
      if (route) values.add(route.key);
    } catch {
      // Malformed links are not identity evidence.
    }
  }
  if (values.size !== 1) return { userId: '', identityStatus: values.size ? 'conflict' : 'missing' };
  return { userId: [...values][0] ?? '', identityStatus: 'valid' };
}

interface BoundWorksContainer {
  container: Element;
  /** The profile scope that proved this works container belongs to the current header. */
  scope: Element;
}

function selectorCandidates(scope: Element, selectors: readonly string[]): Element[] {
  const candidates = new Set<Element>();
  for (const selector of selectors) {
    if (scope.matches(selector)) candidates.add(scope);
    for (const candidate of scope.querySelectorAll(selector)) candidates.add(candidate);
  }
  return [...candidates];
}

function splitCurrentCandidates(candidates: readonly Element[], userId: string, base: string): {
  exact: Element[];
  unbound: Element[];
} {
  const exact: Element[] = [];
  const unbound: Element[] = [];
  for (const candidate of candidates) {
    const identity = elementIdentity(candidate, base);
    if (identity.identityStatus === 'valid' && identity.userId === userId) exact.push(candidate);
    else if (identity.identityStatus === 'missing') unbound.push(candidate);
    // Explicit conflicts and different identities are never eligible.
  }
  return { exact, unbound };
}

function validatedProfileScope(root: Element | null, userId: string, base: string): Element | null {
  const scope = root?.closest(PROFILE_SCOPE_SELECTOR) ?? root;
  if (!scope) return null;
  const identity = elementIdentity(scope, base);
  if (identity.identityStatus === 'conflict') return null;
  if (identity.identityStatus === 'valid' && identity.userId !== userId) return null;
  return scope;
}

/** Select only a works area bound by the current header root or by its own explicit identity. */
function worksContainer(doc: Document, scope: Element | null, userId: string, base: string): BoundWorksContainer | null {
  if (!scope || !userId) return null;
  const scoped = splitCurrentCandidates(selectorCandidates(scope, [WORKS_SELECTOR]), userId, base);
  if (scoped.exact[0]) return { container: scoped.exact[0], scope };
  // A separately rendered global works area needs its own exact identity; it outranks stale unbound markup.
  const globalExact = splitCurrentCandidates([...doc.querySelectorAll(WORKS_SELECTOR)], userId, base).exact[0];
  if (globalExact) return { container: globalExact, scope };
  if (scoped.unbound.length === 1) return { container: scoped.unbound[0]!, scope };
  return null;
}

function noteCards(root: ParentNode | null): Element[] {
  return root ? [...root.querySelectorAll('.note-item, [class*="note-item"], section.feeds-page article')] : [];
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

  const hasMarker = (type: 'image' | 'video'): boolean => {
    const expectedAria = type === 'video' ? '视频' : '图文';
    const exactAria = card.getAttribute('aria-label')?.trim() === expectedAria
      || [...card.querySelectorAll('[aria-label]')].some(element =>
        element.getAttribute('aria-label')?.trim() === expectedAria);
    return card.matches(`[data-note-type="${type}"], [data-testid="${type}"]`)
      || Boolean(card.querySelector([
        `[data-testid="${type}"]`,
        `[data-note-type="${type}"]`,
        `[class~="${type}-icon"]`,
      ].join(',')))
      || (type === 'video' && Boolean(card.querySelector('video')))
      || exactAria;
  };
  const videoMarker = hasMarker('video');
  const imageMarker = hasMarker('image');
  const typeConflict = videoMarker && imageMarker;
  return {
    id: link.id,
    title: firstText(card, ['[data-testid="note-title"]', '.title', '[class*="title"]', 'h2', 'h3']),
    noteUrl: link.noteUrl,
    // Covers are common to video and image posts, so an <img> is not type evidence.
    type: typeConflict ? 'unknown' : videoMarker ? 'video' : imageMarker ? 'image' : 'unknown',
    likes: parseCount(likesRaw(card)),
    coverUrl: imageUrl(card, ['a.cover img', 'img'], base),
    exportNotes: typeConflict ? [NOTE_TYPE_CONFLICT] : [],
  };
}

function mergeDuplicateNote(existing: NoteRecord, later: NoteRecord): NoteRecord {
  const media = mergeNoteType(existing.type, later.type, existing.exportNotes, later.exportNotes);
  return {
    ...existing,
    id: later.id || existing.id,
    noteUrl: later.noteUrl || existing.noteUrl,
    title: later.title || existing.title,
    type: media.type,
    likes: later.likes.raw ? later.likes : existing.likes,
    coverUrl: later.coverUrl || existing.coverUrl,
    exportNotes: mergedExportNotes(existing.exportNotes, later.exportNotes, media.conflict),
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

function profileRootElement(doc: Document, base: string): { root: Element | null; identity: { userId: string; identityStatus: PageIdentityStatus } } {
  const expected = canonicalProfileRoute(base)?.key ?? '';
  const seen = new Set<Element>();
  let fallback: { root: Element; identity: { userId: string; identityStatus: PageIdentityStatus } } | null = null;
  for (const selector of PROFILE_ROOT_SELECTORS) {
    for (const root of doc.querySelectorAll(selector)) {
      if (seen.has(root)) continue;
      seen.add(root);
      const identity = elementIdentity(root, base);
      if (expected && identity.identityStatus === 'valid' && identity.userId === expected) return { root, identity };
      if (!fallback) fallback = { root, identity };
    }
  }
  return fallback ?? { root: null, identity: { userId: '', identityStatus: 'missing' } };
}

/** A DOM fallback is safe only when it looks like a real profile, not a generic page fragment. */
export function isRecognizedDomProfile(doc: Document): boolean {
  const page = parseDomPage(doc, location.href);
  return page.identityStatus === 'valid' && page.hasProfileEvidence && page.hasWorksContainer;
}

function hasStats(scope: ParentNode): boolean {
  return scope.querySelector('.data-info .data-item, [data-testid="profile-stat"]') !== null;
}

/** Prefer a current header's stats over wider scope stats when both are available. */
function currentHeader(
  scope: Element | null,
  userId: string,
  base: string,
): Element | null {
  if (!scope) return null;
  const candidates = splitCurrentCandidates(selectorCandidates(scope, PROFILE_HEADER_SELECTORS), userId, base);
  if (candidates.exact[0]) return candidates.exact[0];
  return candidates.unbound.length === 1 ? candidates.unbound[0] ?? null : null;
}

export function parseDomPage(
  doc: Document,
  profileUrl: string,
): DomPageResult {
  const selectedRoot = profileRootElement(doc, profileUrl);
  const rootElement = selectedRoot.root;
  const identity = selectedRoot.identity;
  const routeCurrent = identity.identityStatus === 'valid' && identity.userId === canonicalProfileRoute(profileUrl)?.key;
  const scope = routeCurrent ? validatedProfileScope(rootElement, identity.userId, profileUrl) : null;
  const header = scope
    ? currentHeader(scope, identity.userId, profileUrl) : null;
  // A route-current source is usable only after both its enclosing scope and one header are unambiguous.
  const domUsable = Boolean(scope && header);
  const currentWorks = domUsable
    ? worksContainer(doc, scope, identity.userId, profileUrl)
    // Diagnostics retain parser output for incomplete pages; the mount gate never treats
    // a missing/conflicting-identity DOM source as usable.
    : null;
  const diagnosticWorks = currentWorks?.container ?? (routeCurrent ? null : doc.querySelector(WORKS_SELECTOR));
  const noteScope = currentWorks?.container ?? (routeCurrent ? null : doc);
  const useHeaderStats = Boolean(header && hasStats(header));
  const statScope = domUsable ? (useHeaderStats ? header : currentWorks?.scope ?? scope)
    : !routeCurrent ? rootElement ?? doc : null;
  // Missing/conflicting identity is never mountable, but legacy callers may still inspect diagnostics.
  const fieldRoot = header ?? (identity.identityStatus === 'valid' ? null : rootElement ?? doc);
  const rawRedId = fieldRoot ? firstText(fieldRoot, [
    '[data-testid="user-redId"]',
    '[data-testid="user-red-id"]',
    '[data-testid="red-id"]',
    '.user-redId',
    '.user-redid',
    '[class*="redId"]',
  ]) : '';
  const rawIpLocation = fieldRoot ? firstText(fieldRoot, [
    '[data-testid="user-IP"]',
    '[data-testid="ip-location"]',
    '.user-IP',
    '.user-ip',
    '.ip-location',
  ]) : '';

  const profile = {
    profileUrl,
    accountName: fieldRoot ? firstText(fieldRoot, [
      '[data-testid="user-name"]',
      '[data-testid="nickname"]',
      '.user-name',
      '.nickname',
    ]) : '',
    redId: stripLabel(rawRedId, '小红书号'),
    avatarUrl: fieldRoot ? imageUrl(fieldRoot, [
      'img[data-testid="user-avatar"]',
      '[data-testid="user-avatar"] img',
      'img[data-testid="avatar"]',
      '[data-testid="avatar"] img',
      'img.user-avatar',
      '.user-avatar img',
      'img[class*="avatar"]',
      '[class*="avatar"] img',
    ], profileUrl) : '',
    description: fieldRoot ? firstText(fieldRoot, [
      '[data-testid="user-desc"]',
      '[data-testid="description"]',
      '.user-desc',
      '.desc',
      '[class*="user-desc"]',
    ]) : '',
    ipLocation: stripLabel(rawIpLocation, 'IP属地'),
    following: parseCount(statScope ? statRaw(statScope, '关注', domUsable && !useHeaderStats) : ''),
    followers: parseCount(statScope ? statRaw(statScope, '粉丝', domUsable && !useHeaderStats) : ''),
    likedAndCollected: parseCount(statScope ? statRaw(statScope, '获赞与收藏', domUsable && !useHeaderStats) : ''),
    exportNotes: [],
  };
  return {
    ...identity,
    hasProfileEvidence: Boolean(profile.accountName || profile.redId || profile.avatarUrl),
    hasWorksContainer: diagnosticWorks !== null,
    profile,
    notes: uniqueNotes(noteCards(noteScope), profileUrl),
  };
}
