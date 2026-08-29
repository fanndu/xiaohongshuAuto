import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectionResult } from '../src/domain/types';
import {
  buildWorkbookBuffer,
  downloadWorkbook,
  makeWorkbookFilename,
} from '../src/export/workbook';

const result = (overrides: Partial<CollectionResult> = {}): CollectionResult => ({
  profile: {
    profileUrl: 'https://www.xiaohongshu.com/user/profile/azhe',
    accountName: '阿哲',
    redId: 'azhe_01',
    avatarUrl: 'https://img.example/avatar.jpg',
    description: '记录旅行',
    ipLocation: '上海',
    following: { raw: '123', value: 123 },
    followers: { raw: '1.2万', value: 12000 },
    likedAndCollected: { raw: '隐藏', value: null },
    collectedAt: '2026-08-29T12:34:56+08:00',
    exportNotes: ['资料已核验', '资料已核验', '从页面提取'],
  },
  notes: [
    {
      id: 'image-1',
      title: '',
      noteUrl: 'https://www.xiaohongshu.com/explore/image-1',
      type: 'image',
      likes: { raw: '12', value: 12 },
      coverUrl: '',
      exportNotes: ['已有备注', '已有备注', '首条'],
    },
    {
      id: 'unknown-2',
      title: '待识别作品',
      noteUrl: '',
      type: 'unknown',
      likes: { raw: '1.2', value: null },
      coverUrl: 'https://img.example/cover.jpg',
      exportNotes: ['已有备注', '第二条'],
    },
    {
      id: 'video-3',
      title: '视频作品',
      noteUrl: 'https://www.xiaohongshu.com/explore/video-3',
      type: 'video',
      likes: { raw: '', value: null },
      coverUrl: 'https://img.example/video-cover.jpg',
      exportNotes: [],
    },
  ],
  ...overrides,
});

async function readWorkbook(source: CollectionResult = result()): Promise<ExcelJS.Workbook> {
  const buffer = await buildWorkbookBuffer(source);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);
  return workbook;
}

describe('buildWorkbookBuffer', () => {
  it('exports ordered sheets, profile fields, and only unique profile notes', async () => {
    const workbook = await readWorkbook();

    expect(workbook.creator).toBe('小红书博主主页采集');
    expect(workbook.worksheets.map(sheet => sheet.name)).toEqual(['博主信息', '作品列表']);

    const profile = workbook.getWorksheet('博主信息');
    expect(profile).toBeDefined();
    expect(profile?.getColumn(1).values).toEqual([
      undefined,
      '字段',
      '主页链接',
      '账号名',
      '小红书号',
      '头像链接',
      '简介',
      'IP 属地',
      '关注数原文',
      '关注数值',
      '粉丝数原文',
      '粉丝数值',
      '获赞与收藏数原文',
      '获赞与收藏数值',
      '已采作品数',
      '采集时间',
      '导出备注',
    ]);
    expect(profile?.getCell('B2').text).toBe('https://www.xiaohongshu.com/user/profile/azhe');
    expect(profile?.getCell('B2').hyperlink).toBe('https://www.xiaohongshu.com/user/profile/azhe');
    expect(profile?.getCell('B5').hyperlink).toBe('https://img.example/avatar.jpg');
    expect(profile?.getCell('B9').value).toBe(123);
    expect(profile?.getCell('B11').value).toBe(12000);
    expect(profile?.getCell('B13').value).toBeNull();
    expect(profile?.getCell('B14').value).toBe(3);
    expect(profile?.getCell('B16').value).toBe('资料已核验；从页面提取');
  });

  it('exports note values, hyperlinks, type labels, and stable warning notes without mutations', async () => {
    const source = result();
    const originalNotes = source.notes.map(note => [...note.exportNotes]);
    const workbook = await readWorkbook(source);
    const notes = workbook.getWorksheet('作品列表');

    expect(notes?.getRow(1).values).toEqual([
      undefined,
      '序号', '标题', '作品链接', '作品 ID', '作品类型', '点赞数原文', '点赞数值', '封面链接', '导出备注',
    ]);
    expect(notes?.getCell('A2').value).toBe(1);
    expect(notes?.getCell('C2').text).toBe('https://www.xiaohongshu.com/explore/image-1');
    expect(notes?.getCell('C2').hyperlink).toBe('https://www.xiaohongshu.com/explore/image-1');
    expect(notes?.getCell('E2').value).toBe('图文');
    expect(notes?.getCell('H2').value).toBeNull();
    expect(notes?.getCell('I2').value).toBe('已有备注；首条；标题缺失；封面链接缺失');
    expect(notes?.getCell('C3').value).toBeNull();
    expect(notes?.getCell('E3').value).toBe('未知');
    expect(notes?.getCell('G3').value).toBeNull();
    expect(notes?.getCell('H3').text).toBe('https://img.example/cover.jpg');
    expect(notes?.getCell('H3').hyperlink).toBe('https://img.example/cover.jpg');
    expect(notes?.getCell('I3').value).toBe('已有备注；第二条；点赞数无法换算；作品类型无法识别');
    expect(notes?.getCell('E4').value).toBe('视频');
    expect(notes?.getCell('G4').value).toBeNull();
    expect(notes?.getCell('I4').value).toBeNull();
    expect(source.notes.map(note => note.exportNotes)).toEqual(originalNotes);
  });

  it('formats headers, freezes first rows, plans widths, and omits media', async () => {
    const workbook = await readWorkbook();

    for (const sheet of workbook.worksheets) {
      expect(sheet.getRow(1).font?.bold).toBe(true);
      expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
      expect(sheet.columns.every(column => typeof column.width === 'number' && column.width > 0)).toBe(true);
    }
    expect(workbook.model.media).toEqual([]);
  });

  it('round-trips OOXML-sensitive text and truncates at a whole Unicode character', async () => {
    const sensitive = 'literal _x0041_\r\0\uFFFE\uD800😀\n保留';
    const exactLimit = 'a'.repeat(32_767);
    const emojiBoundary = `${'b'.repeat(32_766)}😀`;
    const source = result();
    source.profile.accountName = sensitive;
    source.profile.description = exactLimit;
    source.profile.ipLocation = emojiBoundary;

    const workbook = await readWorkbook(source);
    const profile = workbook.getWorksheet('博主信息');

    expect(profile?.getCell('B3').value).toBe(sensitive);
    expect(profile?.getCell('B6').value).toBe(exactLimit);
    expect(profile?.getCell('B7').value).toBe('b'.repeat(32_766));
    expect(profile?.getCell('B16').value).toContain('IP 属地超过 Excel 单元格限制，已截断');
  });

  it('keeps unsafe link fields as normalized text and records field-specific warnings', async () => {
    const source = result();
    source.profile.profileUrl = ' javascript:alert(1) ';
    source.profile.avatarUrl = 'http://img.example/avatar.jpg';
    source.notes[0]!.noteUrl = 'file:///private/note';
    source.notes[0]!.coverUrl = 'data:image/png;base64,abc';

    const workbook = await readWorkbook(source);
    const profile = workbook.getWorksheet('博主信息');
    const notes = workbook.getWorksheet('作品列表');

    expect(profile?.getCell('B2').value).toBe('javascript:alert(1)');
    expect(profile?.getCell('B2').hyperlink).toBeUndefined();
    expect(profile?.getCell('B5').value).toBe('http://img.example/avatar.jpg');
    expect(profile?.getCell('B16').value).toContain('主页链接不是安全 HTTPS 地址，已作为文本导出');
    expect(profile?.getCell('B16').value).toContain('头像链接不是安全 HTTPS 地址，已作为文本导出');
    expect(notes?.getCell('C2').value).toBe('file:///private/note');
    expect(notes?.getCell('C2').hyperlink).toBeUndefined();
    expect(notes?.getCell('H2').value).toBe('data:image/png;base64,abc');
    expect(notes?.getCell('I2').value).toContain('作品链接不是安全 HTTPS 地址，已作为文本导出');
    expect(notes?.getCell('I2').value).toContain('封面链接不是安全 HTTPS 地址，已作为文本导出');
  });

  it('retains zero numeric values and produces a valid header-only note sheet', async () => {
    const empty = await readWorkbook(result({ notes: [] }));
    expect(empty.getWorksheet('博主信息')?.getCell('B14').value).toBe(0);
    expect(empty.getWorksheet('作品列表')?.rowCount).toBe(1);

    const source = result();
    source.notes[0]!.likes = { raw: '0', value: 0 };
    const workbook = await readWorkbook(source);
    expect(workbook.getWorksheet('作品列表')?.getCell('G2').value).toBe(0);
  });

  it('adds stable truncation and unsafe-link warnings for oversized note display fields', async () => {
    const source = result({ notes: [result().notes[0]!] });
    const note = source.notes[0]!;
    const oversized = 'x'.repeat(32_768);
    note.title = oversized;
    note.id = oversized;
    note.noteUrl = `http://${oversized}`;
    note.coverUrl = `data:${oversized}`;
    const original = { ...note };

    const workbook = await readWorkbook(source);
    const notes = workbook.getWorksheet('作品列表');
    const exportNotes = String(notes?.getCell('I2').value);

    expect(notes?.getCell('B2').text).toHaveLength(32_767);
    expect(exportNotes).toContain('标题超过 Excel 单元格限制，已截断');
    expect(exportNotes).toContain('作品 ID超过 Excel 单元格限制，已截断');
    expect(exportNotes).toContain('作品链接超过 Excel 单元格限制，已截断');
    expect(exportNotes).toContain('作品链接不是安全 HTTPS 地址，已作为文本导出');
    expect(exportNotes).toContain('封面链接超过 Excel 单元格限制，已截断');
    expect(exportNotes).toContain('封面链接不是安全 HTTPS 地址，已作为文本导出');
    expect(note).toEqual(original);
  });

  it('retains generated warnings when an input export note consumes the cell budget', async () => {
    const source = result({ notes: [result().notes[0]!] });
    source.notes[0]!.title = 't'.repeat(32_768);
    source.notes[0]!.exportNotes = ['n'.repeat(32_768)];

    const workbook = await readWorkbook(source);
    const exportNotes = String(workbook.getWorksheet('作品列表')?.getCell('I2').value);

    expect(exportNotes).toContain('标题超过 Excel 单元格限制，已截断');
    expect(exportNotes).toContain('导出备注超过 Excel 单元格限制，已截断');
  });

  it('accepts exactly 10,000 structural note slots but rejects larger exports before writing', async () => {
    const exported = (await import('../src/export/workbook')) as unknown as { MAX_EXPORT_NOTES: number };
    expect(exported.MAX_EXPORT_NOTES).toBe(10_000);
    const writeBuffer = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    const restore = vi.spyOn(ExcelJS.Workbook.prototype, 'xlsx', 'get').mockReturnValue({ writeBuffer } as never);

    try {
      await expect(buildWorkbookBuffer(result({ notes: new Array(10_000) as CollectionResult['notes'] }))).resolves.toBeInstanceOf(Uint8Array);
      await expect(buildWorkbookBuffer(result({ notes: new Array(10_001) as CollectionResult['notes'] })))
        .rejects.toThrow('作品数量超过导出上限 10000，无法生成 Excel');
      expect(writeBuffer).toHaveBeenCalledOnce();
    } finally {
      restore.mockRestore();
    }
  });
});

describe('makeWorkbookFilename', () => {
  it('uses a sanitized account name and local calendar date', () => {
    expect(makeWorkbookFilename(' 阿哲 / 旅行 ', new Date(2026, 7, 29, 12))).toBe('阿哲 _ 旅行_小红书主页_2026-08-29.xlsx');
    expect(makeWorkbookFilename('阿哲', new Date(2026, 7, 29, 12))).toBe('阿哲_小红书主页_2026-08-29.xlsx');
  });

  it('propagates invalid dates', () => {
    expect(() => makeWorkbookFilename('阿哲', new Date('invalid'))).toThrow(RangeError);
  });
});

describe('downloadWorkbook', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('clicks a temporary download anchor before revoking its object URL', async () => {
    vi.useFakeTimers();
    vi.spyOn(ExcelJS.Workbook.prototype, 'xlsx', 'get').mockReturnValue({
      writeBuffer: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    } as never);
    const objectUrl = 'blob:workbook';
    const createObjectURL = vi.fn(() => objectUrl);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const appendChild = vi.spyOn(document.body, 'appendChild');
    const remove = vi.spyOn(HTMLAnchorElement.prototype, 'remove');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    await downloadWorkbook(result());

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(appendChild).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);
  });

  it('removes the anchor and schedules revocation when clicking throws', async () => {
    vi.useFakeTimers();
    vi.spyOn(ExcelJS.Workbook.prototype, 'xlsx', 'get').mockReturnValue({
      writeBuffer: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    } as never);
    const objectUrl = 'blob:workbook';
    const createObjectURL = vi.fn(() => objectUrl);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const remove = vi.spyOn(HTMLAnchorElement.prototype, 'remove');
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('click failed');
    });

    await expect(downloadWorkbook(result())).rejects.toThrow('click failed');
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);
  });
});
