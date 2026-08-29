import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import { mountCollector } from '../src/app/mount';
import { formatLocalDateTime } from '../src/domain/normalize';
import type { CollectionResult } from '../src/domain/types';
import { buildWorkbookBuffer } from '../src/export/workbook';
import type { ScrollEnvironment } from '../src/collection/scroll-coordinator';
import type { UiActions, UiState } from '../src/ui/floating-control';

const profileUrl = 'https://www.xiaohongshu.com/user/profile/azhe';
const fixture = readFileSync(
  fileURLToPath(new URL(['.', 'fixtures', 'profile-page.html'].join('/'), import.meta.url)),
  'utf8',
);
const originalBodyHtml = document.body.innerHTML;

interface FakeControl {
  actions: UiActions;
  destroyed: boolean;
  states: UiState[];
  destroy(): void;
  render(state: UiState): void;
}

function fakeScrollEnvironment(): ScrollEnvironment & { scrolls: number } {
  const environment = {
    scrolls: 0,
    atBottom: () => true,
    hasAccessBlock: () => false,
    scrollToBottom: () => { environment.scrolls += 1; },
    wait: () => Promise.resolve(),
  };
  return environment;
}

afterEach(() => {
  document.querySelector('#xhs-profile-collector')?.remove();
  document.body.innerHTML = originalBodyHtml;
});

describe('collector module integration', () => {
  it('mounts the real production flow and automatically exports its merged stable result', async () => {
    document.body.innerHTML = fixture;
    const environment = fakeScrollEnvironment();
    const exported: CollectionResult[] = [];
    let control: FakeControl | undefined;
    let workbook: ExcelJS.Workbook | undefined;
    const lifecycle = new AbortController();
    const cleanup = mountCollector(profileUrl, lifecycle.signal, {
      createControl: actions => {
        control = {
          actions,
          destroyed: false,
          states: [],
          render(state) { this.states.push({ ...state }); },
          destroy() { this.destroyed = true; },
        };
        return control;
      },
      now: () => new Date('2026-08-29T04:34:56.000Z'),
      environment,
      exportResult: async result => {
        exported.push(result);
        const buffer = await buildWorkbookBuffer(result);
        workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer as never);
      },
    });

    expect(control?.states).toEqual([{ phase: 'ready' }]);
    if (!control) throw new Error('Expected injected control');
    await control.actions.start();

    expect(control.states).toEqual([
      { phase: 'ready' },
      { phase: 'collecting', count: 0 },
      { phase: 'collecting', count: 1 },
      { phase: 'collecting', count: 1 },
      { phase: 'collecting', count: 1 },
      { phase: 'complete', count: 1 },
    ]);
    expect(environment.scrolls).toBe(2);
    expect(exported).toEqual([{
      profile: {
        profileUrl,
        accountName: '旅行摄影阿哲',
        redId: 'xhs_azhe',
        avatarUrl: 'https://img.example/avatar.jpg',
        description: '记录山川',
        ipLocation: '美国',
        following: { raw: '128', value: 128 },
        followers: { raw: '1.3万', value: 13000 },
        likedAndCollected: { raw: '8.6万', value: 86000 },
        collectedAt: formatLocalDateTime(new Date('2026-08-29T04:34:56.000Z')),
        exportNotes: [],
      },
      notes: [{
        id: 'abc123',
        title: '雪山日出',
        noteUrl: 'https://www.xiaohongshu.com/explore/abc123',
        type: 'unknown',
        likes: { raw: '2.3万', value: 23000 },
        coverUrl: 'https://img.example/cover.jpg',
        exportNotes: ['作品类型证据冲突'],
      }],
    }]);

    expect(workbook).toBeDefined();
    if (!workbook) throw new Error('Expected automatic workbook export');
    expect(workbook.worksheets.map(sheet => sheet.name)).toEqual(['博主信息', '作品列表']);
    expect(workbook.model.media).toEqual([]);

    const profileSheet = workbook.getWorksheet('博主信息');
    const notesSheet = workbook.getWorksheet('作品列表');
    expect(profileSheet).toBeDefined();
    expect(notesSheet).toBeDefined();
    if (!profileSheet || !notesSheet) throw new Error('Expected export sheets');

    expect(profileSheet.getCell('B2').hyperlink).toBe(profileUrl);
    expect(profileSheet.getCell('B3').text).toBe('旅行摄影阿哲');
    expect(profileSheet.getCell('B10').text).toBe('1.3万');
    expect(profileSheet.getCell('B11').value).toBe(13000);
    expect(profileSheet.getCell('B15').text).toBe(formatLocalDateTime(new Date('2026-08-29T04:34:56.000Z')));
    expect(notesSheet.rowCount).toBe(2);
    expect(notesSheet.getCell('B2').text).toBe('雪山日出');
    expect(notesSheet.getCell('C2').hyperlink).toBe('https://www.xiaohongshu.com/explore/abc123');
    expect(notesSheet.getCell('D2').text).toBe('abc123');
    expect(notesSheet.getCell('E2').text).toBe('未知');
    expect(notesSheet.getCell('F2').text).toBe('2.3万');
    expect(notesSheet.getCell('G2').value).toBe(23000);
    expect(notesSheet.getCell('H2').hyperlink).toBe('https://img.example/cover.jpg');

    cleanup();
    expect(control.destroyed).toBe(true);
  });

  it('seeds a retry with stopped notes and enriches them with newly virtualized DOM notes', async () => {
    document.body.innerHTML = fixture;
    let phase = 0;
    const environment: ScrollEnvironment = {
      atBottom: () => phase === 1,
      hasAccessBlock: () => false,
      scrollToBottom: () => undefined,
      wait: () => phase === 0 ? new Promise<void>(() => {}) : Promise.resolve(),
    };
    const exported: CollectionResult[] = [];
    let control: FakeControl | undefined;
    const cleanup = mountCollector(profileUrl, undefined, {
      environment,
      createControl: actions => {
        control = { actions, destroyed: false, states: [], render(state) { this.states.push({ ...state }); }, destroy() { this.destroyed = true; } };
        return control;
      },
      exportResult: async result => { exported.push(result); },
    });
    if (!control) throw new Error('Expected injected control');

    const stopped = control.actions.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    control.actions.stop();
    await stopped;
    document.querySelector('.feeds-page')?.insertAdjacentHTML('beforeend', '<article class="note-item" data-note-type="image"><a href="/explore/new-virtualized"><span class="title">新作品</span></a></article>');
    phase = 1;
    await control.actions.retry();

    expect(exported).toHaveLength(1);
    expect(exported[0]?.notes.map(note => ({ id: note.id, title: note.title, type: note.type }))).toEqual([
      { id: 'abc123', title: '雪山日出', type: 'unknown' },
      { id: 'new-virtualized', title: '新作品', type: 'image' },
    ]);
    cleanup();
  });
});
