import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import { CollectorController } from '../src/app/collector-controller';
import { collectUntilStable, type ScrollEnvironment } from '../src/collection/scroll-coordinator';
import { formatLocalDateTime } from '../src/domain/normalize';
import type { CollectionResult } from '../src/domain/types';
import { buildWorkbookBuffer } from '../src/export/workbook';
import { mergeProfile } from '../src/parsing/merge';
import { parseDomPage } from '../src/parsing/dom';
import { parseStructuredPage } from '../src/parsing/structured-data';
import type { UiState } from '../src/ui/floating-control';

const profileUrl = 'https://www.xiaohongshu.com/user/profile/azhe';
const fixture = readFileSync(
  fileURLToPath(new URL(['.', 'fixtures', 'profile-page.html'].join('/'), import.meta.url)),
  'utf8',
);
const originalBodyHtml = document.body.innerHTML;

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
  document.body.innerHTML = originalBodyHtml;
});

describe('collector module integration', () => {
  it('runs the controller through stable collection and automatic URL-only export', async () => {
    document.body.innerHTML = fixture;
    const environment = fakeScrollEnvironment();
    // Mounting renders the initial ready state; the controller owns the later run states.
    const states: UiState[] = [{ phase: 'ready' }];
    const exported: CollectionResult[] = [];
    let workbook: ExcelJS.Workbook | undefined;
    const collectedAt = formatLocalDateTime(new Date('2026-08-29T04:34:56.000Z'), -480);

    const readPage = () => ({
      structured: parseStructuredPage(document, profileUrl),
      dom: parseDomPage(document, profileUrl),
    });
    const controller = new CollectorController({
      ui: { render: state => { states.push({ ...state }); } },
      readProfile: () => {
        const page = readPage();
        return mergeProfile(page.structured.profile, page.dom.profile, profileUrl, collectedAt);
      },
      collect: (signal, onProgress) => {
        const initial = readPage();
        return collectUntilStable({
          environment,
          intervalMs: 0,
          signal,
          onProgress,
          seed: [...initial.structured.notes, ...initial.dom.notes],
          readNotes: () => {
            const page = readPage();
            return [...page.structured.notes, ...page.dom.notes];
          },
        });
      },
      exportResult: async result => {
        exported.push(result);
        const buffer = await buildWorkbookBuffer(result);
        workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer as never);
      },
    });

    await controller.start();

    expect(states).toEqual([
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
        collectedAt: '2026-08-29T12:34:56+08:00',
        exportNotes: [],
      },
      notes: [{
        id: 'abc123',
        title: '雪山日出',
        noteUrl: 'https://www.xiaohongshu.com/explore/abc123',
        type: 'video',
        likes: { raw: '2.3万', value: 23000 },
        coverUrl: 'https://img.example/cover.jpg',
        exportNotes: [],
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
    expect(profileSheet.getCell('B15').text).toBe('2026-08-29T12:34:56+08:00');

    expect(notesSheet.rowCount).toBe(2);
    expect(notesSheet.getCell('B2').text).toBe('雪山日出');
    expect(notesSheet.getCell('C2').hyperlink).toBe('https://www.xiaohongshu.com/explore/abc123');
    expect(notesSheet.getCell('D2').text).toBe('abc123');
    expect(notesSheet.getCell('E2').text).toBe('视频');
    expect(notesSheet.getCell('F2').text).toBe('2.3万');
    expect(notesSheet.getCell('G2').value).toBe(23000);
    expect(notesSheet.getCell('H2').hyperlink).toBe('https://img.example/cover.jpg');
  });
});
