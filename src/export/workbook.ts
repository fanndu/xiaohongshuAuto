import ExcelJS from 'exceljs';
import { formatLocalDateTime, sanitizeFilenamePart } from '../domain/normalize';
import type { CollectionResult, NoteRecord, NoteType } from '../domain/types';

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_CELL_TEXT_LENGTH = 32_767;
export const MAX_EXPORT_NOTES = 10_000;

interface NormalizedText {
  text: string;
  truncated: boolean;
}

function ooxmlEscape(codeUnit: number): string {
  return `_x${codeUnit.toString(16).toUpperCase().padStart(4, '0')}_`;
}

function truncateUtf16(input: string, maxLength: number): NormalizedText {
  if (input.length <= maxLength) return { text: input, truncated: false };

  let end = maxLength;
  const finalCodeUnit = input.charCodeAt(end - 1);
  const nextCodeUnit = input.charCodeAt(end);
  if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF
    && nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF) {
    end -= 1;
  }
  return { text: input.slice(0, end), truncated: true };
}

function normalizeCellText(input: string, maxLength = MAX_CELL_TEXT_LENGTH): NormalizedText {
  const retained = truncateUtf16(input, maxLength);
  let text = '';

  for (let index = 0; index < retained.text.length;) {
    const codeUnit = retained.text.charCodeAt(index);
    let chunk: string;

    if (retained.text.slice(index, index + 7).match(/^_x[0-9a-fA-F]{4}_$/)) {
      chunk = `_x005F_${retained.text.slice(index + 1, index + 7)}`;
      index += 7;
    } else if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const next = retained.text.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        chunk = retained.text.slice(index, index + 2);
        index += 2;
      } else {
        chunk = ooxmlEscape(codeUnit);
        index += 1;
      }
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      chunk = ooxmlEscape(codeUnit);
      index += 1;
    } else if (codeUnit === 0x0D
      || (codeUnit <= 0x1F && codeUnit !== 0x09 && codeUnit !== 0x0A)
      || (codeUnit >= 0x7F && codeUnit <= 0x9F)
      || codeUnit === 0xFFFE
      || codeUnit === 0xFFFF) {
      chunk = ooxmlEscape(codeUnit);
      index += 1;
    } else {
      chunk = retained.text[index] ?? '';
      index += 1;
    }
    text += chunk;
  }

  return { text, truncated: retained.truncated };
}

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

function textCell(value: string, field: string, warnings: string[]): ExcelJS.CellValue {
  const normalized = normalizeCellText(value);
  if (normalized.truncated) warnings.push(`${field}超过 Excel 单元格限制，已截断`);
  return normalized.text || null;
}

function hyperlinkOrBlank(url: string, field: string, warnings: string[]): ExcelJS.CellValue {
  const trimmed = url.trim();
  if (!trimmed) return null;

  const normalized = normalizeCellText(trimmed);
  if (normalized.truncated) warnings.push(`${field}超过 Excel 单元格限制，已截断`);
  let parsed: URL | null = null;
  if (!/[\u0000-\u001F\u007F-\u009F\uD800-\uDFFF\uFFFE\uFFFF]/.test(trimmed)) {
    try {
      parsed = new URL(trimmed);
    } catch {
      // Invalid values are exported as ordinary text below.
    }
  }

  if (parsed?.protocol !== 'https:') {
    warnings.push(`${field}不是安全 HTTPS 地址，已作为文本导出`);
    return normalized.text || null;
  }
  if (!normalized.truncated) return { text: normalized.text, hyperlink: parsed.toString() };
  return normalized.text || null;
}

function notesCell(notes: string[], generatedWarnings: string[] = []): ExcelJS.CellValue {
  const uniqueInputNotes = uniqueNotes(notes);
  const uniqueWarnings = uniqueNotes(generatedWarnings.filter(warning => !uniqueInputNotes.includes(warning)));
  const source = [...uniqueInputNotes, ...uniqueWarnings].join('；');
  const normalized = normalizeCellText(source);
  if (!normalized.truncated) return normalized.text || null;

  const warning = '导出备注超过 Excel 单元格限制，已截断';
  const suffix = uniqueNotes([...uniqueWarnings, warning]).join('；');
  const separator = '；';
  const inputText = uniqueInputNotes.join(separator);
  const prefix = normalizeCellText(inputText, MAX_CELL_TEXT_LENGTH - suffix.length - separator.length).text;
  return `${prefix}${separator}${suffix}`;
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
  const warnings: string[] = [];
  const rows: Array<[string, ExcelJS.CellValue]> = [
    ['主页链接', hyperlinkOrBlank(profile.profileUrl, '主页链接', warnings)],
    ['账号名', textCell(profile.accountName, '账号名', warnings)],
    ['小红书号', textCell(profile.redId, '小红书号', warnings)],
    ['头像链接', hyperlinkOrBlank(profile.avatarUrl, '头像链接', warnings)],
    ['简介', textCell(profile.description, '简介', warnings)],
    ['IP 属地', textCell(profile.ipLocation, 'IP 属地', warnings)],
    ['关注数原文', textCell(profile.following.raw, '关注数原文', warnings)],
    ['关注数值', profile.following.value ?? null],
    ['粉丝数原文', textCell(profile.followers.raw, '粉丝数原文', warnings)],
    ['粉丝数值', profile.followers.value ?? null],
    ['获赞与收藏数原文', textCell(profile.likedAndCollected.raw, '获赞与收藏数原文', warnings)],
    ['获赞与收藏数值', profile.likedAndCollected.value ?? null],
    ['已采作品数', result.notes.length],
    ['采集时间', textCell(profile.collectedAt, '采集时间', warnings)],
  ];
  rows.push(['导出备注', notesCell(profile.exportNotes, warnings)]);
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
    const warnings = noteWarnings(note);
    sheet.addRow([
      index + 1,
      textCell(note.title, '标题', warnings),
      hyperlinkOrBlank(note.noteUrl, '作品链接', warnings),
      textCell(note.id, '作品 ID', warnings),
      noteTypeLabel(note.type),
      textCell(note.likes.raw, '点赞数原文', warnings),
      note.likes.value ?? null,
      hyperlinkOrBlank(note.coverUrl, '封面链接', warnings),
      notesCell(note.exportNotes, warnings),
    ]);
  });
}

/** Builds a browser-compatible XLSX byte buffer without fetching or embedding media. */
export async function buildWorkbookBuffer(result: CollectionResult): Promise<Uint8Array> {
  if (result.notes.length > MAX_EXPORT_NOTES) {
    throw new RangeError(`作品数量超过导出上限 ${MAX_EXPORT_NOTES}，无法生成 Excel`);
  }
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

export interface DownloadWorkbookOptions {
  /** Prevents browser download side effects after a page lifecycle has ended. */
  signal?: AbortSignal;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  throw new DOMException('Workbook download was aborted', 'AbortError');
}

export async function downloadWorkbook(result: CollectionResult, options: DownloadWorkbookOptions = {}): Promise<void> {
  throwIfAborted(options.signal);
  const buffer = await buildWorkbookBuffer(result);
  // ExcelJS generation is synchronous once entered and cannot be preempted. This
  // check prevents its completed buffer from becoming a download after navigation.
  throwIfAborted(options.signal);
  const blob = new Blob([buffer as unknown as BlobPart], { type: XLSX_MIME_TYPE });
  throwIfAborted(options.signal);
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = makeWorkbookFilename(result.profile.accountName);

  try {
    throwIfAborted(options.signal);
    document.body.appendChild(anchor);
    throwIfAborted(options.signal);
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}
