import ExcelJS from 'exceljs';
import { formatLocalDateTime, sanitizeFilenamePart } from '../domain/normalize';
import type { CollectionResult, NoteRecord, NoteType } from '../domain/types';

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function uniqueNotes(notes: string[]): string[] {
  const seen = new Set<string>();
  return notes.filter((note) => {
    if (!note || seen.has(note)) return false;
    seen.add(note);
    return true;
  });
}

function noteWarnings(note: NoteRecord): string[] {
  const warnings: string[] = [];
  if (!note.title.trim()) warnings.push('标题缺失');
  if (!note.coverUrl.trim()) warnings.push('封面链接缺失');
  if (note.likes.raw.trim() && note.likes.value === null) warnings.push('点赞数无法换算');
  if (note.type === 'unknown') warnings.push('作品类型无法识别');
  return warnings;
}

function noteTypeLabel(type: NoteType): string {
  if (type === 'image') return '图文';
  if (type === 'video') return '视频';
  return '未知';
}

function hyperlinkOrBlank(url: string): ExcelJS.CellValue {
  return url ? { text: url, hyperlink: url } : null;
}

function setHeader(sheet: ExcelJS.Worksheet, labels: string[]): void {
  sheet.addRow(labels);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

function buildProfileSheet(workbook: ExcelJS.Workbook, result: CollectionResult): void {
  const sheet = workbook.addWorksheet('博主信息');
  sheet.columns = [{ width: 22 }, { width: 70 }];
  setHeader(sheet, ['字段', '值']);

  const { profile } = result;
  const rows: Array<[string, ExcelJS.CellValue]> = [
    ['主页链接', hyperlinkOrBlank(profile.profileUrl)],
    ['账号名', profile.accountName],
    ['小红书号', profile.redId],
    ['头像链接', hyperlinkOrBlank(profile.avatarUrl)],
    ['简介', profile.description],
    ['IP 属地', profile.ipLocation],
    ['关注数原文', profile.following.raw],
    ['关注数值', profile.following.value ?? null],
    ['粉丝数原文', profile.followers.raw],
    ['粉丝数值', profile.followers.value ?? null],
    ['获赞与收藏数原文', profile.likedAndCollected.raw],
    ['获赞与收藏数值', profile.likedAndCollected.value ?? null],
    ['已采作品数', result.notes.length],
    ['采集时间', profile.collectedAt],
    ['导出备注', uniqueNotes(profile.exportNotes).join('；') || null],
  ];
  rows.forEach(row => sheet.addRow(row));
}

function buildNotesSheet(workbook: ExcelJS.Workbook, result: CollectionResult): void {
  const sheet = workbook.addWorksheet('作品列表');
  sheet.columns = [
    { width: 8 }, { width: 30 }, { width: 60 }, { width: 24 }, { width: 12 },
    { width: 16 }, { width: 16 }, { width: 60 }, { width: 40 },
  ];
  setHeader(sheet, ['序号', '标题', '作品链接', '作品 ID', '作品类型', '点赞数原文', '点赞数值', '封面链接', '导出备注']);

  result.notes.forEach((note, index) => {
    const notes = uniqueNotes([...note.exportNotes, ...noteWarnings(note)]).join('；');
    sheet.addRow([
      index + 1,
      note.title,
      hyperlinkOrBlank(note.noteUrl),
      note.id,
      noteTypeLabel(note.type),
      note.likes.raw,
      note.likes.value ?? null,
      hyperlinkOrBlank(note.coverUrl),
      notes || null,
    ]);
  });
}

/** Builds a browser-compatible XLSX byte buffer without fetching or embedding media. */
export async function buildWorkbookBuffer(result: CollectionResult): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '小红书博主主页采集';
  buildProfileSheet(workbook, result);
  buildNotesSheet(workbook, result);

  // ExcelJS types this as Node's Buffer, while its browser writer returns a Uint8Array.
  return (await workbook.xlsx.writeBuffer({ useStyles: true, useSharedStrings: true })) as unknown as Uint8Array;
}

export function makeWorkbookFilename(accountName: string, date = new Date()): string {
  const datePart = formatLocalDateTime(date).slice(0, 10);
  return `${sanitizeFilenamePart(accountName)}_小红书主页_${datePart}.xlsx`;
}

export async function downloadWorkbook(result: CollectionResult): Promise<void> {
  const buffer = await buildWorkbookBuffer(result);
  const blob = new Blob([buffer as unknown as BlobPart], { type: XLSX_MIME_TYPE });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = makeWorkbookFilename(result.profile.accountName);

  try {
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}
