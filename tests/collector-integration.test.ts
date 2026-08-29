import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { collectUntilStable, type ScrollEnvironment } from '../src/collection/scroll-coordinator';
import { formatLocalDateTime } from '../src/domain/normalize';
import { buildWorkbookBuffer } from '../src/export/workbook';
import { mergeProfile } from '../src/parsing/merge';
import { parseDomPage } from '../src/parsing/dom';
import { parseStructuredPage } from '../src/parsing/structured-data';

const profileUrl = 'https://www.xiaohongshu.com/user/profile/azhe';
const fixture = readFileSync(resolve(process.cwd(), 'tests/fixtures/profile-page.html'), 'utf8');

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

describe('collector module integration', () => {
  it('collects a merged profile through stable rounds and exports a URL-only workbook', async () => {
    document.body.innerHTML = fixture;
    const structured = parseStructuredPage(document, profileUrl);
    const dom = parseDomPage(document, profileUrl);
    const collectedAt = formatLocalDateTime(new Date('2026-08-29T04:34:56.000Z'), -480);

    expect(structured.profile).toMatchObject({
      accountName: '旅行摄影阿哲',
      followers: { raw: '1.3万', value: 13000 },
    });
    expect(structured.notes).toMatchObject([{
      id: 'abc123',
      title: '结构化雪山日出',
      type: 'image',
      likes: { raw: '1.5万', value: 15000 },
      coverUrl: 'https://img.example/structured-cover.jpg',
    }]);

    const environment = fakeScrollEnvironment();
    const collected = await collectUntilStable({
      environment,
      intervalMs: 0,
      seed: structured.notes,
      readNotes: () => parseDomPage(document, profileUrl).notes,
    });
    const profile = mergeProfile(structured.profile, dom.profile, profileUrl, collectedAt);

    expect(collected.reason).toBe('complete');
    expect(environment.scrolls).toBe(2);
    expect(profile).toMatchObject({
      profileUrl,
      accountName: '旅行摄影阿哲',
      avatarUrl: 'https://img.example/avatar.jpg',
      followers: { raw: '1.3万', value: 13000 },
      collectedAt: '2026-08-29T12:34:56+08:00',
    });
    expect(collected.notes).toEqual([{
      id: 'abc123',
      title: '雪山日出',
      noteUrl: 'https://www.xiaohongshu.com/explore/abc123',
      type: 'video',
      likes: { raw: '2.3万', value: 23000 },
      coverUrl: 'https://img.example/cover.jpg',
      exportNotes: [],
    }]);

    const buffer = await buildWorkbookBuffer({ profile, notes: collected.notes });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);

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
