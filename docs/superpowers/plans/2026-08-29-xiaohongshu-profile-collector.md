# Xiaohongshu Profile Collector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Dia-compatible Manifest V3 extension that collects a currently open Xiaohongshu profile and all publicly loaded work cards, then downloads a two-sheet Excel workbook containing data and image URLs only.

**Architecture:** Use a vanilla TypeScript WXT content script with a Shadow DOM floating control. Keep parsing, normalization, scrolling, state management, and workbook generation as isolated modules; combine structured page state with DOM fallbacks and never call unpublished Xiaohongshu APIs.

**Tech Stack:** Node.js 20+, TypeScript, WXT 0.21, Manifest V3, Vitest 4 with jsdom, ExcelJS 4.4.

---

## Scope and file map

This spec is one independently testable subsystem, so it does not need further decomposition.

Files to create:

- `package.json` — scripts and pinned dependency ranges.
- `.gitignore` — generated dependencies, WXT output, coverage, and visual scratch files.
- `tsconfig.json` — strict TypeScript configuration extending WXT defaults.
- `vitest.config.ts` — jsdom test environment and test discovery.
- `wxt.config.ts` — extension name, version, and minimum manifest configuration.
- `entrypoints/xiaohongshu.content/index.ts` — WXT lifecycle, SPA navigation detection, and app mount/unmount.
- `src/domain/types.ts` — shared profile, note, count, result, and state types.
- `src/domain/normalize.ts` — count parsing, URL normalization, ID extraction, and filename sanitization.
- `src/domain/routes.ts` — pure Xiaohongshu profile-route recognition, testable outside WXT runtime.
- `src/parsing/structured-data.ts` — safe parsing of page-embedded initial state.
- `src/parsing/dom.ts` — profile and note DOM fallback parsing.
- `src/parsing/merge.ts` — deterministic structured-data/DOM merging.
- `src/collection/note-store.ts` — note deduplication and field enrichment.
- `src/collection/scroll-coordinator.ts` — scrolling, stable-bottom detection, cancellation, and progress.
- `src/export/workbook.ts` — two-sheet Excel workbook generation and local download.
- `src/ui/floating-control.ts` — isolated floating UI and user actions.
- `src/app/collector-controller.ts` — collection state machine and component orchestration.
- `src/app/mount.ts` — production dependency wiring.
- `tests/fixtures/profile-page.html` — small, sanitized DOM fixture.
- `tests/normalize.test.ts` — normalization unit tests.
- `tests/structured-data.test.ts` — embedded state parsing tests.
- `tests/dom.test.ts` — DOM fallback tests.
- `tests/merge.test.ts` — deterministic merge tests.
- `tests/note-store.test.ts` — deduplication tests.
- `tests/scroll-coordinator.test.ts` — completion and cancellation tests.
- `tests/workbook.test.ts` — workbook structure and hyperlinks.
- `tests/floating-control.test.ts` — UI rendering and actions.
- `tests/collector-controller.test.ts` — state-machine integration tests.
- `tests/content-entry.test.ts` — profile route recognition tests.
- `docs/manual-test-checklist.md` — Dia installation and acceptance checklist.

## Task 1: Scaffold the WXT TypeScript extension

**Files:**

- Create: `package.json`
- Modify: `.gitignore`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `wxt.config.ts`

- [ ] **Step 1: Create package metadata and scripts**

Create `package.json`:

```json
{
  "name": "xiaohongshu-profile-collector",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "wxt",
    "build": "wxt build",
    "zip": "wxt zip",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "check": "npm run typecheck && npm test && npm run build",
    "postinstall": "wxt prepare"
  },
  "dependencies": {
    "exceljs": "^4.4.0"
  },
  "devDependencies": {
    "jsdom": "^30.0.1",
    "typescript": "^7.0.2",
    "vitest": "^4.1.11",
    "wxt": "^0.21.4"
  }
}
```

Update `.gitignore` to:

```gitignore
.superpowers/
node_modules/
.wxt/
.output/
coverage/
```

- [ ] **Step 2: Add strict compiler and test configuration**

Create `tsconfig.json`:

```json
{
  "extends": "./.wxt/tsconfig.json",
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true
  }
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    clearMocks: true,
  },
});
```

Create `wxt.config.ts`:

```ts
import { defineConfig } from 'wxt';

export default defineConfig({
  manifestVersion: 3,
  manifest: {
    name: '小红书博主主页采集',
    description: '采集当前博主主页公开信息并导出 Excel',
    version: '0.1.0',
  },
});
```

- [ ] **Step 3: Install dependencies and generate WXT types**

Run: `npm install`

Expected: `package-lock.json` and `.wxt/tsconfig.json` are generated with no install error.

- [ ] **Step 4: Verify the empty project toolchain**

Run: `npm run typecheck && npm test -- --passWithNoTests`

Expected: typecheck succeeds and Vitest exits successfully with no tests found.

- [ ] **Step 5: Commit the scaffold**

```bash
git add .gitignore package.json package-lock.json tsconfig.json vitest.config.ts wxt.config.ts
git commit -m "chore: scaffold WXT extension"
```

## Task 2: Define records and normalization rules

**Files:**

- Create: `src/domain/types.ts`
- Create: `src/domain/normalize.ts`
- Test: `tests/normalize.test.ts`

- [ ] **Step 1: Write failing normalization tests**

Create `tests/normalize.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  extractNoteId,
  formatLocalDateTime,
  normalizeNoteUrl,
  parseCount,
  sanitizeFilenamePart,
} from '../src/domain/normalize';

describe('parseCount', () => {
  it.each([
    ['128', 128],
    ['1,234', 1234],
    ['1.2万', 12000],
    ['2.3万+', 23000],
    ['', null],
    ['隐藏', null],
  ])('converts %s', (raw, value) => {
    expect(parseCount(raw)).toEqual({ raw, value });
  });
});

it('normalizes a note URL without losing the exported URL', () => {
  const url = 'https://www.xiaohongshu.com/explore/abc123?xsec_token=secret&source=web';
  expect(normalizeNoteUrl(url)).toBe('https://www.xiaohongshu.com/explore/abc123');
  expect(extractNoteId(url)).toBe('abc123');
});

it('sanitizes workbook filenames', () => {
  expect(sanitizeFilenamePart('阿哲 / 旅行:记录')).toBe('阿哲 _ 旅行_记录');
});

it('formats local time with an explicit timezone offset', () => {
  const date = new Date('2026-08-29T18:00:00.000Z');
  expect(formatLocalDateTime(date, 360)).toBe('2026-08-29T12:00:00-06:00');
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- tests/normalize.test.ts`

Expected: FAIL because `src/domain/normalize.ts` does not exist.

- [ ] **Step 3: Add the shared types**

Create `src/domain/types.ts`:

```ts
export interface CountValue {
  raw: string;
  value: number | null;
}

export interface ProfileRecord {
  profileUrl: string;
  accountName: string;
  redId: string;
  avatarUrl: string;
  description: string;
  ipLocation: string;
  following: CountValue;
  followers: CountValue;
  likedAndCollected: CountValue;
  collectedAt: string;
  exportNotes: string[];
}

export type NoteType = 'image' | 'video' | 'unknown';

export interface NoteRecord {
  id: string;
  title: string;
  noteUrl: string;
  type: NoteType;
  likes: CountValue;
  coverUrl: string;
  exportNotes: string[];
}

export interface CollectionResult {
  profile: ProfileRecord;
  notes: NoteRecord[];
}

export type CollectionPhase = 'ready' | 'collecting' | 'complete' | 'paused' | 'failed';
```

- [ ] **Step 4: Implement normalization**

Create `src/domain/normalize.ts`:

```ts
import type { CountValue } from './types';

export function parseCount(rawInput: string): CountValue {
  const raw = rawInput.trim();
  const cleaned = raw.replaceAll(',', '').replace(/\+$/, '');
  const match = cleaned.match(/^(\d+(?:\.\d+)?)(万|千)?$/);
  if (!match) return { raw, value: null };

  const multipliers: Record<string, number> = { '': 1, 千: 1_000, 万: 10_000 };
  const amount = Number(match[1]);
  const multiplier = multipliers[match[2] ?? ''];
  return { raw, value: multiplier === undefined ? null : Math.round(amount * multiplier) };
}

export function normalizeNoteUrl(href: string, base = 'https://www.xiaohongshu.com'): string {
  try {
    const url = new URL(href, base);
    url.hash = '';
    url.search = '';
    return `${url.origin}${url.pathname}`.replace(/\/$/, '');
  } catch {
    return '';
  }
}

export function extractNoteId(href: string): string {
  const normalized = normalizeNoteUrl(href);
  return normalized.match(/\/(?:explore|discovery\/item)\/([^/]+)$/)?.[1] ?? '';
}

export function sanitizeFilenamePart(value: string): string {
  return value.trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '未命名博主';
}

export function formatLocalDateTime(
  date = new Date(),
  timezoneOffsetMinutes = date.getTimezoneOffset(),
): string {
  const local = new Date(date.getTime() - timezoneOffsetMinutes * 60_000).toISOString().slice(0, 19);
  const sign = timezoneOffsetMinutes <= 0 ? '+' : '-';
  const absolute = Math.abs(timezoneOffsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  return `${local}${sign}${hours}:${minutes}`;
}
```

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- tests/normalize.test.ts && npm run typecheck`

Expected: all normalization tests pass and TypeScript reports no errors.

```bash
git add src/domain tests/normalize.test.ts
git commit -m "feat: add collector domain normalization"
```

## Task 3: Parse page-embedded structured data

**Files:**

- Create: `src/parsing/structured-data.ts`
- Test: `tests/structured-data.test.ts`

- [ ] **Step 1: Write a failing test using a realistic, sanitized state shape**

Create `tests/structured-data.test.ts` with a document containing:

```ts
import { describe, expect, it } from 'vitest';
import { parseStructuredPage } from '../src/parsing/structured-data';

describe('parseStructuredPage', () => {
  it('extracts profile and note fields from initial state', () => {
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
      user: {
        userPageData: {
          basicInfo: {
            nickname: '旅行摄影阿哲', redId: 'xhs_azhe', desc: '记录山川',
            imageb: 'https://img.example/avatar.jpg', ipLocation: '美国',
          },
          interactions: [
            { type: 'follows', count: '128' },
            { type: 'fans', count: '1.2万' },
            { type: 'interaction', count: '8.6万' },
          ],
          notes: [[{
            id: 'abc123', displayTitle: '雪山日出', type: 'video',
            cover: { urlDefault: 'https://img.example/cover.jpg' },
            interactInfo: { likedCount: '2.3万' },
          }]],
        },
      },
    })};</script>`;

    const result = parseStructuredPage(document, 'https://www.xiaohongshu.com/user/profile/u1');
    expect(result.profile?.accountName).toBe('旅行摄影阿哲');
    expect(result.profile?.followers).toEqual({ raw: '1.2万', value: 12000 });
    expect(result.notes).toEqual([expect.objectContaining({
      id: 'abc123', title: '雪山日出', type: 'video',
      noteUrl: 'https://www.xiaohongshu.com/explore/abc123',
      coverUrl: 'https://img.example/cover.jpg',
    })]);
  });

  it('returns an empty result for malformed state instead of guessing', () => {
    document.body.innerHTML = '<script>window.__INITIAL_STATE__ = {broken;</script>';
    expect(parseStructuredPage(document, location.href)).toEqual({ profile: null, notes: [] });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- tests/structured-data.test.ts`

Expected: FAIL because the parser module does not exist.

- [ ] **Step 3: Implement guarded structured-state extraction**

Create `src/parsing/structured-data.ts` with these public contracts and rules:

```ts
import { extractNoteId, normalizeNoteUrl, parseCount } from '../domain/normalize';
import type { NoteRecord, NoteType, ProfileRecord } from '../domain/types';

type JsonRecord = Record<string, unknown>;
export interface StructuredPageResult { profile: Partial<ProfileRecord> | null; notes: NoteRecord[] }

const record = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
const string = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const path = (root: unknown, keys: string[]): unknown =>
  keys.reduce<unknown>((value, key) => record(value)?.[key], root);

function readInitialState(doc: Document): unknown {
  for (const script of doc.querySelectorAll('script')) {
    const text = script.textContent ?? '';
    const marker = 'window.__INITIAL_STATE__';
    const markerIndex = text.indexOf(marker);
    if (markerIndex < 0) continue;
    const equalsIndex = text.indexOf('=', markerIndex + marker.length);
    if (equalsIndex < 0) continue;
    const candidate = text.slice(equalsIndex + 1).trim().replace(/;\s*$/, '')
      .replace(/:\s*undefined(?=\s*[,}])/g, ':null');
    try { return JSON.parse(candidate); } catch { return null; }
  }
  return null;
}

function noteType(value: unknown): NoteType {
  const type = string(value).toLowerCase();
  return type === 'video' ? 'video' : type === 'normal' || type === 'image' ? 'image' : 'unknown';
}

function mapNote(value: unknown): NoteRecord | null {
  const source = record(value);
  if (!source) return null;
  const id = string(source.id ?? source.noteId);
  const noteUrl = normalizeNoteUrl(string(source.url) || (id ? `/explore/${id}` : ''));
  if (!noteUrl) return null;
  const cover = record(source.cover);
  const interact = record(source.interactInfo);
  return {
    id: id || extractNoteId(noteUrl),
    title: string(source.displayTitle ?? source.title),
    noteUrl,
    type: noteType(source.type),
    likes: parseCount(string(interact?.likedCount ?? source.likedCount)),
    coverUrl: string(cover?.urlDefault ?? cover?.urlPre ?? source.coverUrl),
    exportNotes: [],
  };
}

function flattenNotes(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => Array.isArray(item) ? flattenNotes(item) : [item]);
}

export function parseStructuredPage(doc: Document, profileUrl: string): StructuredPageResult {
  const state = readInitialState(doc);
  const page = record(path(state, ['user', 'userPageData']));
  if (!page) return { profile: null, notes: [] };
  const basic = record(page.basicInfo) ?? {};
  const interactions = Array.isArray(page.interactions) ? page.interactions.map(record).filter(Boolean) as JsonRecord[] : [];
  const countFor = (type: string) => parseCount(string(interactions.find(item => item.type === type)?.count));
  return {
    profile: {
      profileUrl,
      accountName: string(basic.nickname),
      redId: string(basic.redId),
      avatarUrl: string(basic.imageb ?? basic.images),
      description: string(basic.desc),
      ipLocation: string(basic.ipLocation),
      following: countFor('follows'),
      followers: countFor('fans'),
      likedAndCollected: countFor('interaction'),
      exportNotes: [],
    },
    notes: flattenNotes(page.notes).map(mapNote).filter((item): item is NoteRecord => item !== null),
  };
}
```

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- tests/structured-data.test.ts && npm run typecheck`

Expected: both structured-data tests pass and TypeScript reports no errors.

```bash
git add src/parsing/structured-data.ts tests/structured-data.test.ts
git commit -m "feat: parse embedded profile data"
```

## Task 4: Add DOM fallbacks and deterministic merging

**Files:**

- Create: `tests/fixtures/profile-page.html`
- Create: `src/parsing/dom.ts`
- Create: `src/parsing/merge.ts`
- Test: `tests/dom.test.ts`
- Test: `tests/merge.test.ts`

- [ ] **Step 1: Add a sanitized profile fixture**

Create `tests/fixtures/profile-page.html`:

```html
<main>
  <section class="user">
    <img class="user-avatar" src="https://img.example/avatar.jpg">
    <h1 class="user-name">旅行摄影阿哲</h1>
    <div class="user-redId">小红书号：xhs_azhe</div>
    <p class="user-desc">记录山川</p>
    <span class="user-IP">IP属地：美国</span>
    <div class="data-info">
      <div class="data-item"><strong>128</strong><span>关注</span></div>
      <div class="data-item"><strong>1.2万</strong><span>粉丝</span></div>
      <div class="data-item"><strong>8.6万</strong><span>获赞与收藏</span></div>
    </div>
  </section>
  <section class="feeds-page">
    <article class="note-item">
      <a class="cover" href="/explore/abc123?xsec_token=secret">
        <img src="https://img.example/cover.jpg">
      </a>
      <a class="title">雪山日出</a>
      <span class="like-wrapper"><span class="count">2.3万</span></span>
      <span class="video-icon"></span>
    </article>
  </section>
</main>
```

- [ ] **Step 2: Write failing DOM and merge tests**

Create `tests/dom.test.ts` and assert that `parseDomPage(document, profileUrl)` returns the same visible profile values, one `video` note, a normalized note URL, and only the cover URL.

Create `tests/merge.test.ts` with this exact conflict rule:

```ts
import { expect, it } from 'vitest';
import { mergeProfile } from '../src/parsing/merge';
import { parseCount } from '../src/domain/normalize';

it('prefers non-empty structured fields and fills gaps from DOM', () => {
  const merged = mergeProfile(
    { accountName: '结构化名称', description: '', followers: parseCount('1.2万') },
    { accountName: 'DOM 名称', description: 'DOM 简介', followers: parseCount('') },
    'https://www.xiaohongshu.com/user/profile/u1',
    '2026-08-29T12:00:00-06:00',
  );
  expect(merged.accountName).toBe('结构化名称');
  expect(merged.description).toBe('DOM 简介');
  expect(merged.followers.value).toBe(12000);
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npm test -- tests/dom.test.ts tests/merge.test.ts`

Expected: FAIL because `dom.ts` and `merge.ts` do not exist.

- [ ] **Step 4: Implement DOM parsing**

Create `src/parsing/dom.ts`. Use prioritized selectors rather than a single generated CSS class:

```ts
import { extractNoteId, normalizeNoteUrl, parseCount } from '../domain/normalize';
import type { NoteRecord, NoteType, ProfileRecord } from '../domain/types';

export interface DomPageResult { profile: Partial<ProfileRecord>; notes: NoteRecord[] }
const text = (root: ParentNode, selectors: string[]) => {
  for (const selector of selectors) {
    const value = root.querySelector(selector)?.textContent?.trim();
    if (value) return value;
  }
  return '';
};
const attr = (root: ParentNode, selectors: string[], name: string) => {
  for (const selector of selectors) {
    const value = root.querySelector(selector)?.getAttribute(name)?.trim();
    if (value) return value;
  }
  return '';
};
const stripLabel = (value: string, label: RegExp) => value.replace(label, '').trim();

function stat(doc: Document, label: RegExp) {
  const items = doc.querySelectorAll('.data-info .data-item, [data-testid="profile-stat"]');
  for (const item of items) {
    if (label.test(item.textContent ?? '')) return parseCount(text(item, ['strong', '.count', 'span']));
  }
  return parseCount('');
}

function domNote(card: Element, base: string): NoteRecord | null {
  const href = attr(card, ['a[href*="/explore/"], a[href*="/discovery/item/"]'], 'href');
  const noteUrl = normalizeNoteUrl(href, base);
  if (!noteUrl) return null;
  const type: NoteType = card.querySelector('.video-icon, [class*="video"]') ? 'video' : 'image';
  return {
    id: extractNoteId(noteUrl),
    title: text(card, ['.title', '[class*="title"]']),
    noteUrl,
    type,
    likes: parseCount(text(card, ['.like-wrapper .count', '[class*="like"] .count', '[class*="like"]'])),
    coverUrl: attr(card, ['a.cover img', 'img'], 'src'),
    exportNotes: [],
  };
}

export function parseDomPage(doc: Document, profileUrl: string): DomPageResult {
  const cards = [...doc.querySelectorAll('.note-item, [class*="note-item"], section.feeds-page article')];
  return {
    profile: {
      profileUrl,
      accountName: text(doc, ['.user-name', '[data-testid="user-name"]', '.nickname']),
      redId: stripLabel(text(doc, ['.user-redId', '[class*="user-redId"]']), /^小红书号[：:]\s*/),
      avatarUrl: attr(doc, ['.user-avatar', '[class*="avatar"] img', 'img[class*="avatar"]'], 'src'),
      description: text(doc, ['.user-desc', '[class*="user-desc"]', '.desc']),
      ipLocation: stripLabel(text(doc, ['.user-IP', '.ip-location']), /^IP属地[：:]\s*/),
      following: stat(doc, /关注/),
      followers: stat(doc, /粉丝/),
      likedAndCollected: stat(doc, /获赞与收藏/),
      exportNotes: [],
    },
    notes: cards.map(card => domNote(card, profileUrl)).filter((note): note is NoteRecord => note !== null),
  };
}
```

- [ ] **Step 5: Implement deterministic profile merging**

Create `src/parsing/merge.ts`:

```ts
import { parseCount } from '../domain/normalize';
import type { CountValue, ProfileRecord } from '../domain/types';

const stringValue = (a: unknown, b: unknown) =>
  typeof a === 'string' && a.trim() ? a.trim() : typeof b === 'string' ? b.trim() : '';
const countValue = (a: unknown, b: unknown): CountValue => {
  const first = a as CountValue | undefined;
  const second = b as CountValue | undefined;
  return first?.raw ? first : second?.raw ? second : parseCount('');
};

export function mergeProfile(
  structured: Partial<ProfileRecord> | null,
  dom: Partial<ProfileRecord>,
  profileUrl: string,
  collectedAt: string,
): ProfileRecord {
  const merged: ProfileRecord = {
    profileUrl,
    accountName: stringValue(structured?.accountName, dom.accountName),
    redId: stringValue(structured?.redId, dom.redId),
    avatarUrl: stringValue(structured?.avatarUrl, dom.avatarUrl),
    description: stringValue(structured?.description, dom.description),
    ipLocation: stringValue(structured?.ipLocation, dom.ipLocation),
    following: countValue(structured?.following, dom.following),
    followers: countValue(structured?.followers, dom.followers),
    likedAndCollected: countValue(structured?.likedAndCollected, dom.likedAndCollected),
    collectedAt,
    exportNotes: [],
  };
  const required: Array<[string, string]> = [
    ['账号名', merged.accountName], ['小红书号', merged.redId], ['头像链接', merged.avatarUrl],
    ['简介', merged.description], ['关注数', merged.following.raw], ['粉丝数', merged.followers.raw],
    ['获赞与收藏数', merged.likedAndCollected.raw],
  ];
  merged.exportNotes = required.filter(([, value]) => !value).map(([label]) => `${label}缺失`);
  return merged;
}
```

- [ ] **Step 6: Run tests and commit**

Run: `npm test -- tests/dom.test.ts tests/merge.test.ts && npm run typecheck`

Expected: all DOM and merge tests pass.

```bash
git add src/parsing tests/fixtures tests/dom.test.ts tests/merge.test.ts
git commit -m "feat: add DOM fallback parsing"
```

## Task 5: Deduplicate notes and stop scrolling safely

**Files:**

- Create: `src/collection/note-store.ts`
- Create: `src/collection/scroll-coordinator.ts`
- Test: `tests/note-store.test.ts`
- Test: `tests/scroll-coordinator.test.ts`

- [ ] **Step 1: Write failing store and coordinator tests**

Use a `note()` factory in `tests/note-store.test.ts` and assert that two records with the same ID become one record, while a later non-empty title and cover fill earlier empty fields.

Create `tests/scroll-coordinator.test.ts` around an injected fake environment:

```ts
import { expect, it, vi } from 'vitest';
import { collectUntilStable } from '../src/collection/scroll-coordinator';

it('finishes after three bottom rounds without new notes', async () => {
  let round = 0;
  const readNotes = vi.fn(() => round++ === 0 ? [{
    id: 'a', title: 'A', noteUrl: 'https://www.xiaohongshu.com/explore/a',
    type: 'image' as const, likes: { raw: '1', value: 1 }, coverUrl: '', exportNotes: [],
  }] : []);
  const result = await collectUntilStable({
    readNotes,
    onProgress: vi.fn(),
    signal: new AbortController().signal,
    environment: {
      atBottom: () => true,
      hasAccessBlock: () => false,
      scrollToBottom: vi.fn(),
      wait: vi.fn().mockResolvedValue(undefined),
    },
    stableRounds: 3,
    intervalMs: 1,
  });
  expect(result.reason).toBe('complete');
  expect(result.notes).toHaveLength(1);
  expect(readNotes).toHaveBeenCalledTimes(4);
});
```

Add a second test that aborts during `wait()` and expects `{ reason: 'stopped' }` with already collected notes preserved. Add a third test where `hasAccessBlock()` returns `true` and expect a `CollectionError` with code `ACCESS_BLOCKED` and the collected-note snapshot attached. Add a fourth test with `atBottom()` false and 12 rounds without new notes, expecting code `LOAD_STALLED` and the collected-note snapshot instead of an infinite loop.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- tests/note-store.test.ts tests/scroll-coordinator.test.ts`

Expected: FAIL because collection modules do not exist.

- [ ] **Step 3: Implement the note store**

Create `src/collection/note-store.ts`:

```ts
import { normalizeNoteUrl } from '../domain/normalize';
import type { NoteRecord } from '../domain/types';

const keyFor = (note: NoteRecord) => note.id || normalizeNoteUrl(note.noteUrl);
export class NoteStore {
  readonly #notes = new Map<string, NoteRecord>();

  addMany(notes: NoteRecord[]): number {
    let added = 0;
    for (const note of notes) {
      const key = keyFor(note);
      if (!key) continue;
      const existing = this.#notes.get(key);
      if (!existing) {
        this.#notes.set(key, note);
        added += 1;
        continue;
      }
      this.#notes.set(key, {
        ...existing,
        title: existing.title || note.title,
        type: existing.type === 'unknown' ? note.type : existing.type,
        likes: existing.likes.raw ? existing.likes : note.likes,
        coverUrl: existing.coverUrl || note.coverUrl,
        exportNotes: [...new Set([...existing.exportNotes, ...note.exportNotes])],
      });
    }
    return added;
  }

  values(): NoteRecord[] { return [...this.#notes.values()]; }
  get size(): number { return this.#notes.size; }
}
```

- [ ] **Step 4: Implement the scroll coordinator**

Create `src/collection/scroll-coordinator.ts`:

```ts
import type { NoteRecord } from '../domain/types';
import { NoteStore } from './note-store';

export interface ScrollEnvironment {
  atBottom(): boolean;
  hasAccessBlock(): boolean;
  scrollToBottom(): void;
  wait(ms: number, signal: AbortSignal): Promise<void>;
}
export class CollectionError extends Error {
  constructor(
    readonly code: 'ACCESS_BLOCKED' | 'LOAD_STALLED',
    readonly notes: NoteRecord[],
  ) { super(code); }
}
export interface ScrollOptions {
  readNotes(): NoteRecord[];
  onProgress(count: number): void;
  signal: AbortSignal;
  environment: ScrollEnvironment;
  stableRounds?: number;
  maxStalledRounds?: number;
  intervalMs?: number;
  seed?: NoteRecord[];
}

export async function collectUntilStable(options: ScrollOptions) {
  const store = new NoteStore();
  store.addMany(options.seed ?? []);
  const stableRounds = options.stableRounds ?? 3;
  const maxStalledRounds = options.maxStalledRounds ?? 12;
  const intervalMs = options.intervalMs ?? 1200;
  let stable = 0;
  let stalled = 0;

  while (!options.signal.aborted) {
    if (options.environment.hasAccessBlock()) throw new CollectionError('ACCESS_BLOCKED', store.values());
    const added = store.addMany(options.readNotes());
    options.onProgress(store.size);
    stable = options.environment.atBottom() && added === 0 ? stable + 1 : 0;
    stalled = added === 0 ? stalled + 1 : 0;
    if (stable >= stableRounds) return { reason: 'complete' as const, notes: store.values() };
    if (stalled >= maxStalledRounds) throw new CollectionError('LOAD_STALLED', store.values());
    options.environment.scrollToBottom();
    try { await options.environment.wait(intervalMs, options.signal); }
    catch { if (options.signal.aborted) break; throw new CollectionError('LOAD_STALLED', store.values()); }
  }
  return { reason: 'stopped' as const, notes: store.values() };
}

export const browserScrollEnvironment: ScrollEnvironment = {
  atBottom: () => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 8,
  hasAccessBlock: () => [...document.querySelectorAll('[role="dialog"], [class*="captcha"], [class*="verify"]')]
    .some(element => /验证|访问频繁|操作频繁/.test(element.textContent ?? '')),
  scrollToBottom: () => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }),
  wait: (ms, signal) => new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { window.clearTimeout(timer); reject(signal.reason); }, { once: true });
  }),
};
```

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- tests/note-store.test.ts tests/scroll-coordinator.test.ts && npm run typecheck`

Expected: deduplication, completion, and cancellation tests pass.

```bash
git add src/collection tests/note-store.test.ts tests/scroll-coordinator.test.ts
git commit -m "feat: collect notes until page is stable"
```

## Task 6: Generate and download the Excel workbook locally

**Files:**

- Create: `src/export/workbook.ts`
- Test: `tests/workbook.test.ts`

- [ ] **Step 1: Write a failing workbook test**

Create `tests/workbook.test.ts` with one profile and one note. Call `buildWorkbookBuffer`, reload the buffer with `ExcelJS.Workbook().xlsx.load`, and assert:

```ts
expect(workbook.worksheets.map(sheet => sheet.name)).toEqual(['博主信息', '作品列表']);
expect(workbook.getWorksheet('博主信息')?.getCell('B2').text).toBe('https://www.xiaohongshu.com/user/profile/u1');
expect(workbook.getWorksheet('作品列表')?.getCell('C2').value).toEqual({
  text: 'https://www.xiaohongshu.com/explore/abc123',
  hyperlink: 'https://www.xiaohongshu.com/explore/abc123',
});
expect(workbook.getWorksheet('作品列表')?.getCell('H2').text).toBe('https://img.example/cover.jpg');
```

Also assert that neither worksheet contains binary image media and that `makeWorkbookFilename('阿哲', new Date('2026-08-29'))` returns `阿哲_小红书主页_2026-08-29.xlsx`.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- tests/workbook.test.ts`

Expected: FAIL because the workbook module does not exist.

- [ ] **Step 3: Implement workbook generation**

Create `src/export/workbook.ts` using the non-streaming browser writer:

```ts
import ExcelJS from 'exceljs';
import { formatLocalDateTime, sanitizeFilenamePart } from '../domain/normalize';
import type { CollectionResult } from '../domain/types';

const link = (url: string) => url ? { text: url, hyperlink: url } : '';
const noteText = (values: string[]) => values.join('；');

export async function buildWorkbookBuffer(result: CollectionResult): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '小红书博主主页采集';
  const profile = workbook.addWorksheet('博主信息');
  profile.columns = [{ header: '字段', key: 'field', width: 24 }, { header: '值', key: 'value', width: 64 }];
  const p = result.profile;
  [
    ['主页链接', link(p.profileUrl)], ['账号名', p.accountName], ['小红书号', p.redId],
    ['头像链接', link(p.avatarUrl)], ['简介', p.description], ['IP 属地', p.ipLocation],
    ['关注数原文', p.following.raw], ['关注数值', p.following.value],
    ['粉丝数原文', p.followers.raw], ['粉丝数值', p.followers.value],
    ['获赞与收藏数原文', p.likedAndCollected.raw], ['获赞与收藏数值', p.likedAndCollected.value],
    ['已采作品数', result.notes.length], ['采集时间', p.collectedAt], ['导出备注', noteText(p.exportNotes)],
  ].forEach(row => profile.addRow(row));

  const notes = workbook.addWorksheet('作品列表');
  notes.columns = [
    { header: '序号', key: 'index', width: 8 }, { header: '标题', key: 'title', width: 36 },
    { header: '作品链接', key: 'url', width: 56 }, { header: '作品 ID', key: 'id', width: 28 },
    { header: '作品类型', key: 'type', width: 12 }, { header: '点赞数原文', key: 'likesRaw', width: 16 },
    { header: '点赞数值', key: 'likesValue', width: 16 }, { header: '封面链接', key: 'coverUrl', width: 56 },
    { header: '导出备注', key: 'notes', width: 32 },
  ];
  result.notes.forEach((note, index) => {
    const warnings = [
      ...note.exportNotes,
      ...(!note.title ? ['标题缺失'] : []),
      ...(!note.coverUrl ? ['封面链接缺失'] : []),
      ...(note.likes.raw && note.likes.value === null ? ['点赞数无法换算'] : []),
      ...(note.type === 'unknown' ? ['作品类型无法识别'] : []),
    ];
    notes.addRow({
      index: index + 1, title: note.title, url: link(note.noteUrl), id: note.id,
      type: note.type === 'image' ? '图文' : note.type === 'video' ? '视频' : '未知',
      likesRaw: note.likes.raw, likesValue: note.likes.value, coverUrl: link(note.coverUrl),
      notes: noteText([...new Set(warnings)]),
    });
  });
  for (const sheet of workbook.worksheets) {
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }
  return workbook.xlsx.writeBuffer({ useStyles: true, useSharedStrings: true });
}

export function makeWorkbookFilename(accountName: string, date = new Date()): string {
  const day = formatLocalDateTime(date).slice(0, 10);
  return `${sanitizeFilenamePart(accountName)}_小红书主页_${day}.xlsx`;
}

export async function downloadWorkbook(result: CollectionResult): Promise<void> {
  const buffer = await buildWorkbookBuffer(result);
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = makeWorkbookFilename(result.profile.accountName);
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
```

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- tests/workbook.test.ts && npm run typecheck`

Expected: workbook reloads successfully, sheets and hyperlinks match, and no image bytes are embedded.

```bash
git add src/export/workbook.ts tests/workbook.test.ts
git commit -m "feat: export profile collection to Excel"
```

## Task 7: Build the isolated floating control

**Files:**

- Create: `src/ui/floating-control.ts`
- Test: `tests/floating-control.test.ts`

- [ ] **Step 1: Write failing UI behavior tests**

Create tests that mount `FloatingControl`, confirm the host uses a Shadow Root, and cover these states and actions:

```ts
ui.render({ phase: 'ready' });
expect(ui.root.textContent).toContain('采集此博主');
ui.render({ phase: 'collecting', count: 186 });
expect(ui.root.textContent).toContain('已发现 186 篇');
ui.render({ phase: 'complete', count: 326 });
expect(ui.root.textContent).toContain('Excel 已下载');
ui.render({ phase: 'paused', count: 100, message: '页面未继续加载' });
expect(ui.root.textContent).toContain('导出已有数据');
```

Register spies for `start`, `stop`, `retry`, and `exportPartial`; click each `button[data-action]` and assert the matching callback runs exactly once.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- tests/floating-control.test.ts`

Expected: FAIL because the UI module does not exist.

- [ ] **Step 3: Implement a closed Shadow DOM UI**

Create `src/ui/floating-control.ts` with:

```ts
export type UiState =
  | { phase: 'ready' }
  | { phase: 'collecting'; count: number }
  | { phase: 'complete'; count: number }
  | { phase: 'paused' | 'failed'; count: number; message: string };
export interface UiActions {
  start(): void; stop(): void; retry(): void; exportPartial(): void;
}

const styles = `
  :host{all:initial} .panel{position:fixed;right:24px;bottom:24px;z-index:2147483647;
  width:176px;padding:12px;border-radius:14px;background:#242428;color:#fff;
  box-shadow:0 8px 28px #0004;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  button{border:0;border-radius:18px;padding:9px 12px;cursor:pointer;font:inherit}
  .primary{width:100%;background:#ff2442;color:#fff}.link{background:transparent;color:#ff9bad;padding:5px}
  .row{display:flex;gap:6px;margin-top:7px}.message{color:#ddd;margin-top:3px}
`;

export class FloatingControl {
  readonly host = document.createElement('div');
  readonly root: ShadowRoot;
  constructor(private readonly actions: UiActions) {
    this.host.id = 'xhs-profile-collector';
    this.root = this.host.attachShadow({ mode: 'open' });
    document.documentElement.append(this.host);
    this.root.addEventListener('click', event => {
      const action = (event.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.action;
      if (action && action in this.actions) this.actions[action as keyof UiActions]();
    });
  }
  render(state: UiState): void {
    const body = state.phase === 'ready'
      ? '<button class="primary" data-action="start">采集此博主</button>'
      : state.phase === 'collecting'
        ? `<div>已发现 ${state.count} 篇</div><div class="message">正在加载更多…</div><button class="link" data-action="stop">停止采集</button>`
        : state.phase === 'complete'
          ? `<div>✓ 共采集 ${state.count} 篇</div><div class="message">Excel 已下载</div>`
          : `<div>${state.phase === 'failed' ? '采集失败' : '采集已暂停'}</div><div class="message">${state.message}</div><div class="row"><button class="link" data-action="retry">重试</button><button class="link" data-action="exportPartial">导出已有数据</button></div>`;
    this.root.innerHTML = `<style>${styles}</style><div class="panel">${body}</div>`;
  }
  destroy(): void { this.host.remove(); }
}
```

Do not use `innerHTML` with text taken from Xiaohongshu or exception objects. The only interpolated values above are a numeric count and fixed UI strings; dynamic failure messages must be mapped to fixed user-safe messages by the controller.

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- tests/floating-control.test.ts && npm run typecheck`

Expected: all state and button-action tests pass.

```bash
git add src/ui/floating-control.ts tests/floating-control.test.ts
git commit -m "feat: add floating collector control"
```

## Task 8: Wire the collection state machine

**Files:**

- Create: `src/app/collector-controller.ts`
- Test: `tests/collector-controller.test.ts`

- [ ] **Step 1: Write failing controller tests with injected dependencies**

Define fakes for UI, snapshot reading, scrolling, clock, and exporter. Cover:

1. `start()` renders collecting progress and, on normal completion, exports once then renders complete.
2. `stop()` aborts the active task and leaves partial notes available.
3. `exportPartial()` exports the latest profile and notes.
4. `ACCESS_BLOCKED` maps to `页面要求验证，请处理后重试` and `LOAD_STALLED` maps to `页面未继续加载，可重试或导出已有数据`; unknown parser failures map to `页面结构或加载状态发生变化`. Failures never auto-export.
5. A second `start()` while collecting is ignored.

The success assertion should be:

```ts
await controller.start();
expect(exportResult).toHaveBeenCalledWith({ profile, notes });
expect(ui.render).toHaveBeenLastCalledWith({ phase: 'complete', count: notes.length });
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- tests/collector-controller.test.ts`

Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Implement the controller contracts and state machine**

Create `src/app/collector-controller.ts`:

```ts
import { CollectionError } from '../collection/scroll-coordinator';
import type { CollectionResult, NoteRecord, ProfileRecord } from '../domain/types';
import type { FloatingControl } from '../ui/floating-control';

export interface ControllerDependencies {
  ui: Pick<FloatingControl, 'render'>;
  readProfile(): ProfileRecord;
  collect(signal: AbortSignal, onProgress: (count: number) => void): Promise<{ reason: 'complete' | 'stopped'; notes: NoteRecord[] }>;
  exportResult(result: CollectionResult): Promise<void>;
}

export class CollectorController {
  #abort: AbortController | null = null;
  #profile: ProfileRecord | null = null;
  #notes: NoteRecord[] = [];
  constructor(private readonly deps: ControllerDependencies) {}

  async start(): Promise<void> {
    if (this.#abort) return;
    this.#abort = new AbortController();
    this.deps.ui.render({ phase: 'collecting', count: this.#notes.length });
    try {
      this.#profile = this.deps.readProfile();
      const result = await this.deps.collect(this.#abort.signal, count =>
        this.deps.ui.render({ phase: 'collecting', count }));
      this.#notes = result.notes;
      if (result.reason === 'stopped') {
        this.deps.ui.render({ phase: 'paused', count: this.#notes.length, message: '已停止，可导出当前结果' });
        return;
      }
      await this.exportPartial();
      this.deps.ui.render({ phase: 'complete', count: this.#notes.length });
    } catch (error) {
      if (error instanceof CollectionError) this.#notes = error.notes;
      const message = error instanceof CollectionError
        ? error.code === 'ACCESS_BLOCKED'
          ? '页面要求验证，请处理后重试'
          : '页面未继续加载，可重试或导出已有数据'
        : '页面结构或加载状态发生变化';
      this.deps.ui.render({ phase: 'failed', count: this.#notes.length, message });
    } finally {
      this.#abort = null;
    }
  }

  stop(): void { this.#abort?.abort(); }
  retry(): void { if (!this.#abort) void this.start(); }
  async exportPartial(): Promise<void> {
    if (!this.#profile) this.#profile = this.deps.readProfile();
    await this.deps.exportResult({ profile: this.#profile, notes: this.#notes });
  }
}
```

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- tests/collector-controller.test.ts && npm run typecheck`

Expected: success, stop, partial export, error, and re-entry tests pass.

```bash
git add src/app/collector-controller.ts tests/collector-controller.test.ts
git commit -m "feat: orchestrate profile collection states"
```

## Task 9: Mount only on profile routes and integrate production components

**Files:**

- Create: `src/app/mount.ts`
- Create: `src/domain/routes.ts`
- Create: `entrypoints/xiaohongshu.content/index.ts`
- Test: `tests/content-entry.test.ts`

- [ ] **Step 1: Write failing route recognition tests**

Import `isProfileUrl` from the pure `src/domain/routes.ts` module so Vitest does not execute WXT's content-script registration code:

```ts
import { expect, it } from 'vitest';
import { isProfileUrl } from '../src/domain/routes';

it('recognizes only Xiaohongshu profile routes', () => {
  expect(isProfileUrl('https://www.xiaohongshu.com/user/profile/abc')).toBe(true);
  expect(isProfileUrl('https://www.xiaohongshu.com/explore/abc')).toBe(false);
  expect(isProfileUrl('https://example.com/user/profile/abc')).toBe(false);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- tests/content-entry.test.ts`

Expected: FAIL because `src/domain/routes.ts` does not exist.

- [ ] **Step 3: Wire parsers, scrolling, workbook export, controller, and UI**

Create `src/domain/routes.ts`:

```ts
export function isProfileUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /(^|\.)xiaohongshu\.com$/.test(url.hostname)
      && /^\/user\/profile\/[^/]+/.test(url.pathname);
  } catch {
    return false;
  }
}
```

Create `src/app/mount.ts`:

```ts
import { browserScrollEnvironment, collectUntilStable } from '../collection/scroll-coordinator';
import { formatLocalDateTime } from '../domain/normalize';
import { downloadWorkbook } from '../export/workbook';
import { parseDomPage } from '../parsing/dom';
import { mergeProfile } from '../parsing/merge';
import { parseStructuredPage } from '../parsing/structured-data';
import { FloatingControl } from '../ui/floating-control';
import { CollectorController } from './collector-controller';

export function mountCollector(): () => void {
  let controller: CollectorController;
  const ui = new FloatingControl({
    start: () => void controller.start(), stop: () => controller.stop(),
    retry: () => controller.retry(), exportPartial: () => void controller.exportPartial(),
  });
  const profileUrl = `${location.origin}${location.pathname}`;
  const readPages = () => ({
    structured: parseStructuredPage(document, profileUrl),
    dom: parseDomPage(document, profileUrl),
  });
  controller = new CollectorController({
    ui,
    readProfile: () => {
      const page = readPages();
      return mergeProfile(page.structured.profile, page.dom.profile, profileUrl, formatLocalDateTime());
    },
    collect: (signal, onProgress) => {
      const first = readPages();
      return collectUntilStable({
        seed: [...first.structured.notes, ...first.dom.notes],
        readNotes: () => {
          const page = readPages();
          return [...page.structured.notes, ...page.dom.notes];
        },
        onProgress, signal, environment: browserScrollEnvironment,
      });
    },
    exportResult: downloadWorkbook,
  });
  ui.render({ phase: 'ready' });
  return () => { controller.stop(); ui.destroy(); };
}
```

- [ ] **Step 4: Add WXT lifecycle and SPA navigation handling**

Create `entrypoints/xiaohongshu.content/index.ts`:

```ts
import { mountCollector } from '../../src/app/mount';
import { isProfileUrl } from '../../src/domain/routes';

export default defineContentScript({
  matches: ['*://*.xiaohongshu.com/*'],
  runAt: 'document_idle',
  main(ctx) {
    let unmount: (() => void) | null = null;
    const sync = (url = location.href) => {
      unmount?.();
      unmount = isProfileUrl(url) ? mountCollector() : null;
    };
    sync();
    ctx.addEventListener(window, 'wxt:locationchange', event => sync(event.newUrl));
    ctx.onInvalidated(() => unmount?.());
  },
});
```

- [ ] **Step 5: Run unit tests, typecheck, and build**

Run: `npm test -- tests/content-entry.test.ts && npm run typecheck && npm run build`

Expected: route tests pass; WXT produces `.output/chrome-mv3/manifest.json` and bundled content-script assets. Inspect the generated manifest and confirm it has Xiaohongshu host access only, no cookie permission, and no remote script source.

- [ ] **Step 6: Commit the production integration**

```bash
git add src/app/mount.ts src/domain/routes.ts entrypoints/xiaohongshu.content/index.ts tests/content-entry.test.ts
git commit -m "feat: integrate Xiaohongshu profile collector"
```

## Task 10: Add acceptance coverage and Dia handoff documentation

**Files:**

- Modify: `tests/collector-controller.test.ts`
- Create: `docs/manual-test-checklist.md`

- [ ] **Step 1: Add an end-to-end module integration test**

Extend `tests/collector-controller.test.ts` with the sanitized HTML fixture, real DOM/structured parsers, real merge, real note store/coordinator with a fake scroll environment, and real workbook generation. Assert one completed collection produces:

- account name `旅行摄影阿哲`;
- one deduplicated note `abc123` even when it exists in both structured data and DOM;
- two workbook sheets;
- a clickable work URL and cover URL;
- no embedded image media.

- [ ] **Step 2: Add the manual Dia checklist**

Create `docs/manual-test-checklist.md`:

```markdown
# Dia 手工验收清单

1. Run `npm ci && npm run check`.
2. Open Dia's extension management page, enable Developer Mode, and load `.output/chrome-mv3` as an unpacked extension.
3. Open a Xiaohongshu explore page: confirm no collector button appears.
4. Open a logged-in profile page: confirm “采集此博主” appears at bottom right.
5. Click start: confirm the counter grows and the page scrolls with visible pauses.
6. Stop midway: confirm scrolling stops and “导出已有数据” creates a valid XLSX.
7. Retry, then allow completion: confirm the page reaches the bottom, the workbook downloads, and duplicate cards produce one row.
8. Open both sheets and compare account name, Xiaohongshu ID, description, stats, title, likes, work URL, and cover URL against the page.
9. Confirm the workbook contains links only—no downloaded or embedded avatar/cover images.
10. Repeat with a small profile, a profile with hundreds of works, mixed image/video works, a missing title, slow network, and a page verification prompt.
11. On a verification prompt, confirm the extension stops and does not try to bypass it.
```

- [ ] **Step 3: Run the complete verification suite**

Run: `npm run check`

Expected: typecheck passes, all Vitest files pass, and WXT builds `.output/chrome-mv3` without warnings that affect execution.

Run: `npm run zip`

Expected: WXT creates a distributable Chrome MV3 ZIP under `.output`.

- [ ] **Step 4: Inspect the built artifact**

Run: `rg -n "cookie|history|https?://.*\.js" .output/chrome-mv3/manifest.json .output/chrome-mv3`

Expected: no cookie/history permission and no remotely loaded JavaScript. Matches inside source comments or Xiaohongshu route patterns are acceptable only after manual inspection.

- [ ] **Step 5: Commit the acceptance suite and documentation**

```bash
git add tests/collector-controller.test.ts docs/manual-test-checklist.md
git commit -m "test: add collector acceptance coverage"
```

## Final verification

- [ ] Run `npm run check` from a clean checkout.
- [ ] Complete every item in `docs/manual-test-checklist.md` in Dia.
- [ ] Confirm `git status --short` is empty.
- [ ] Confirm the final extension never opens individual work pages, never calls unpublished APIs, and stores avatar/cover URLs without downloading, embedding, or uploading their image bytes.

## Primary references

- WXT installation and scripts: <https://wxt.dev/guide/installation>
- WXT content scripts and SPA location changes: <https://wxt.dev/guide/essentials/content-scripts>
- WXT Manifest V3 generation: <https://wxt.dev/guide/essentials/config/manifest>
- ExcelJS browser buffer generation: <https://github.com/exceljs/exceljs/blob/master/spec/manual/public/index.html>
- Approved design: `docs/superpowers/specs/2026-08-29-xiaohongshu-profile-collector-design.md`
