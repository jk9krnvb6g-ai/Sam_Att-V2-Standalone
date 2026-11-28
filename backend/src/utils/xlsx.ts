import zlib from 'zlib';

/**
 * Pure Node.js OpenXML (.xlsx) Reader & Writer
 * Supports generating genuine Excel .xlsx templates and parsing uploaded .xlsx files
 * without requiring external binary/third-party packages.
 */

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function escapeXml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(str: string): string {
  return String(str ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function colIndexToLetters(indexZeroBased: number): string {
  let n = indexZeroBased + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function colLettersToIndex(letters: string): number {
  let idx = 0;
  const clean = letters.toUpperCase().replace(/[^A-Z]/g, '');
  for (let i = 0; i < clean.length; i++) {
    idx = idx * 26 + (clean.charCodeAt(i) - 64);
  }
  return Math.max(0, idx - 1);
}

function createZipArchive(entries: Array<{ name: string; content: Buffer }>): Buffer {
  const localFileParts: Buffer[] = [];
  const centralDirParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const uncompressed = entry.content;
    const compressed = zlib.deflateRawSync(uncompressed);
    const crc = crc32(uncompressed);

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 flag
    localHeader.writeUInt16LE(8, 8); // deflate
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x5421, 12); // mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(uncompressed.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra len
    nameBuf.copy(localHeader, 30);

    localFileParts.push(localHeader, compressed);

    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8
    centralHeader.writeUInt16LE(8, 10); // deflate
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x5421, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(uncompressed.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra
    centralHeader.writeUInt16LE(0, 32); // comment
    centralHeader.writeUInt16LE(0, 34); // disk
    centralHeader.writeUInt16LE(0, 36); // int attr
    centralHeader.writeUInt32LE(0, 38); // ext attr
    centralHeader.writeUInt32LE(offset, 42); // relative offset
    nameBuf.copy(centralHeader, 46);

    centralDirParts.push(centralHeader);
    offset += localHeader.length + compressed.length;
  }

  const centralDirBuf = Buffer.concat(centralDirParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localFileParts, centralDirBuf, eocd]);
}

export function readZipArchiveEntries(zipBuffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  if (zipBuffer.length < 22 || zipBuffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('INVALID_XLSX_ZIP_FORMAT: ไฟล์ที่อัปโหลดไม่ใช่ไฟล์ Excel (.xlsx) ที่ถูกต้อง');
  }

  // Locate End of Central Directory (EOCD)
  let eocdOffset = -1;
  const minEocdSearch = Math.max(0, zipBuffer.length - 65557);
  for (let i = zipBuffer.length - 22; i >= minEocdSearch; i--) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('INVALID_XLSX_EOCD_MISSING: โครงสร้างไฟล์ .xlsx ไม่สมบูรณ์');
  }

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  let ptr = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (ptr + 46 > zipBuffer.length || zipBuffer.readUInt32LE(ptr) !== 0x02014b50) {
      break;
    }
    const compressionMethod = zipBuffer.readUInt16LE(ptr + 10);
    const compressedSize = zipBuffer.readUInt32LE(ptr + 20);
    const fileNameLen = zipBuffer.readUInt16LE(ptr + 28);
    const extraLen = zipBuffer.readUInt16LE(ptr + 30);
    const commentLen = zipBuffer.readUInt16LE(ptr + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(ptr + 42);
    const fileName = zipBuffer
      .subarray(ptr + 46, ptr + 46 + fileNameLen)
      .toString('utf8')
      .replace(/\\/g, '/');

    const localNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const rawSlice = zipBuffer.subarray(dataStart, dataStart + compressedSize);

    if (compressionMethod === 0) {
      entries.set(fileName, Buffer.from(rawSlice));
    } else if (compressionMethod === 8) {
      entries.set(fileName, zlib.inflateRawSync(rawSlice));
    }

    ptr += 46 + fileNameLen + extraLen + commentLen;
  }

  return entries;
}

export function buildXlsxBufferFromRows(sheetName: string, rows: string[][]): Buffer {
  const safeSheetName = escapeXml((sheetName || 'ScheduleTemplate').slice(0, 31));

  const rowXmlParts: string[] = [];
  for (let rIdx = 0; rIdx < rows.length; rIdx++) {
    const row = rows[rIdx];
    const rowNumber = rIdx + 1;
    const cellParts: string[] = [];
    for (let cIdx = 0; cIdx < row.length; cIdx++) {
      const colRef = `${colIndexToLetters(cIdx)}${rowNumber}`;
      const val = escapeXml(String(row[cIdx] ?? ''));
      cellParts.push(`<c r="${colRef}" t="inlineStr"><is><t>${val}</t></is></c>`);
    }
    rowXmlParts.push(`<row r="${rowNumber}">${cellParts.join('')}</row>`);
  }

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${safeSheetName}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

  const sheet1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rowXmlParts.join('')}</sheetData>
</worksheet>`;

  return createZipArchive([
    { name: '[Content_Types].xml', content: Buffer.from(contentTypesXml, 'utf8') },
    { name: '_rels/.rels', content: Buffer.from(rootRelsXml, 'utf8') },
    { name: 'xl/workbook.xml', content: Buffer.from(workbookXml, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', content: Buffer.from(workbookRelsXml, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', content: Buffer.from(sheet1Xml, 'utf8') },
  ]);
}

function excelSerialNumberToYmd(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 20000 || serial > 80000) return null;
  // Excel 1900 epoch with leap year bug adjustment (25569 = 1970-01-01)
  const utcDays = Math.floor(serial - 25569);
  const ms = utcDays * 86400 * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function parseXlsxToRows(fileBuffer: Buffer): string[][] {
  const entries = readZipArchiveEntries(fileBuffer);

  // Parse sharedStrings.xml if present
  const sharedStrings: string[] = [];
  const sharedStringsBuf = entries.get('xl/sharedStrings.xml');
  if (sharedStringsBuf) {
    const sstXml = sharedStringsBuf.toString('utf8');
    const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let siMatch: RegExpExecArray | null;
    while ((siMatch = siRegex.exec(sstXml)) !== null) {
      const inner = siMatch[1];
      const tRegex = /<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>/g;
      let tMatch: RegExpExecArray | null;
      const parts: string[] = [];
      while ((tMatch = tRegex.exec(inner)) !== null) {
        parts.push(unescapeXml(tMatch[1]));
      }
      sharedStrings.push(parts.join(''));
    }
  }

  // Find first worksheet
  let sheetBuf = entries.get('xl/worksheets/sheet1.xml');
  if (!sheetBuf) {
    for (const [k, v] of entries.entries()) {
      if (k.startsWith('xl/worksheets/sheet') && k.endsWith('.xml')) {
        sheetBuf = v;
        break;
      }
    }
  }
  if (!sheetBuf) {
    throw new Error('INVALID_XLSX_WORKSHEET_MISSING: ไม่พบแผ่นงาน (Worksheet) ในไฟล์ .xlsx');
  }

  const sheetXml = sheetBuf.toString('utf8');
  const rows: string[][] = [];
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRegex.exec(sheetXml)) !== null) {
    const rowInner = rowMatch[1];
    const rowCells: string[] = [];
    const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch: RegExpExecArray | null;
    let nextSequentialCol = 0;

    while ((cellMatch = cellRegex.exec(rowInner)) !== null) {
      const attrs = cellMatch[1] || '';
      const cellInner = cellMatch[2] || '';

      const refMatch = /\br="([A-Z]+)\d+"/i.exec(attrs);
      const colIdx = refMatch ? colLettersToIndex(refMatch[1]) : nextSequentialCol;
      nextSequentialCol = colIdx + 1;

      const typeMatch = /\bt="([^"]+)"/.exec(attrs);
      const cellType = typeMatch ? typeMatch[1] : '';

      let cellValue = '';
      if (cellType === 'inlineStr') {
        const tRegex = /<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>/g;
        let tMatch: RegExpExecArray | null;
        const parts: string[] = [];
        while ((tMatch = tRegex.exec(cellInner)) !== null) {
          parts.push(unescapeXml(tMatch[1]));
        }
        cellValue = parts.join('');
      } else if (cellType === 's') {
        const vMatch = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cellInner);
        const sIdx = vMatch ? Number(vMatch[1].trim()) : -1;
        cellValue = sIdx >= 0 && sIdx < sharedStrings.length ? sharedStrings[sIdx] : '';
      } else {
        const vMatch = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cellInner);
        cellValue = vMatch ? unescapeXml(vMatch[1].trim()) : '';
      }

      while (rowCells.length <= colIdx) {
        rowCells.push('');
      }
      rowCells[colIdx] = cellValue.trim();
    }

    if (rowCells.some((c) => c !== '')) {
      rows.push(rowCells);
    }
  }

  return rows;
}

export interface ParsedScheduleExcelRow {
  rowNumber: number;
  personId: string;
  workDate: string;
  shiftCode: string;
  note: string;
}

export function normalizeExcelWorkDate(rawVal: string): string {
  const trimmed = String(rawVal ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  // Support DD/MM/YYYY (Gregorian or Buddhist Era >= 2500)
  const dmyMatch = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (dmyMatch) {
    const dd = dmyMatch[1].padStart(2, '0');
    const mm = dmyMatch[2].padStart(2, '0');
    let yyyy = Number(dmyMatch[3]);
    if (yyyy >= 2400) yyyy -= 543;
    return `${yyyy}-${mm}-${dd}`;
  }
  // Support Excel numeric date serial (e.g., 46344)
  if (/^\d{5}(?:\.\d+)?$/.test(trimmed)) {
    const converted = excelSerialNumberToYmd(Number(trimmed));
    if (converted) return converted;
  }
  return trimmed;
}

export function extractScheduleRecordsFromXlsxBuffer(fileBuffer: Buffer): ParsedScheduleExcelRow[] {
  const rawRows = parseXlsxToRows(fileBuffer);
  if (rawRows.length === 0) {
    return [];
  }

  // Detect header row
  const headerRow = rawRows[0].map((h) => h.trim().toLowerCase());
  let colPersonId = headerRow.findIndex((h) =>
    ['person_id', 'personid', 'รหัสบุคลากร', 'รหัสพนักงาน'].includes(h)
  );
  let colWorkDate = headerRow.findIndex((h) =>
    ['work_date', 'workdate', 'date', 'วันที่ปฏิบัติงาน', 'วันที่เวร', 'วันที่'].includes(h)
  );
  let colShiftCode = headerRow.findIndex((h) =>
    ['shift_code', 'shiftcode', 'รหัสกะ', 'รหัสเวร', 'กะทำงาน'].includes(h)
  );
  let colNote = headerRow.findIndex((h) => ['note', 'remark', 'หมายเหตุ'].includes(h));

  let startRowIdx = 1;
  if (colPersonId === -1 && colWorkDate === -1 && colShiftCode === -1) {
    // Assume positional columns if header was omitted
    colPersonId = 0;
    colWorkDate = 1;
    colShiftCode = 2;
    colNote = 3;
    startRowIdx = 0;
  } else {
    if (colPersonId === -1) colPersonId = 0;
    if (colWorkDate === -1) colWorkDate = 1;
    if (colShiftCode === -1) colShiftCode = 2;
    if (colNote === -1) colNote = 3;
  }

  const parsed: ParsedScheduleExcelRow[] = [];
  for (let i = startRowIdx; i < rawRows.length; i++) {
    const row = rawRows[i];
    const personId = String(row[colPersonId] ?? '').trim();
    const rawDate = String(row[colWorkDate] ?? '').trim();
    const shiftCode = String(row[colShiftCode] ?? '').trim().toUpperCase();
    const note = colNote >= 0 ? String(row[colNote] ?? '').trim() : '';

    if (!personId && !rawDate && !shiftCode) {
      continue;
    }

    parsed.push({
      rowNumber: i + 1,
      personId,
      workDate: normalizeExcelWorkDate(rawDate),
      shiftCode,
      note,
    });
  }

  return parsed;
}

export interface ExcelWorkbookSheetSpec {
  name: string;
  title?: string;
  subtitle?: string;
  headers: string[];
  rows: Array<Array<string | number | boolean | null | undefined>>;
  columnWidths?: number[];
  autoFilter?: boolean;
}

export function sanitizeExcelText(raw: unknown): string {
  const str = String(raw ?? '');
  if (!str) return '';
  if (/^[=+\-@\t\r]/.test(str)) {
    return `'${str}`;
  }
  return str;
}

function sanitizeSheetTabName(raw: string, usedNames: Set<string>, index: number): string {
  const cleaned = String(raw || `Sheet${index}`)
    .replace(/[:\\/?*\[\]]/g, ' ')
    .trim()
    .slice(0, 31) || `Sheet${index}`;
  let candidate = cleaned;
  let suffix = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    const tag = `_${suffix}`;
    candidate = `${cleaned.slice(0, Math.max(1, 31 - tag.length))}${tag}`;
    suffix++;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function buildExcelStylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="4">
    <font><sz val="11"/><name val="Tahoma"/><family val="2"/></font>
    <font><b/><sz val="14"/><color rgb="FF4E3978"/><name val="Tahoma"/></font>
    <font><sz val="10"/><color rgb="FF4A4160"/><name val="Tahoma"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Tahoma"/></font>
  </fonts>
  <fills count="4">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF4E3978"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF8F7FC"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFD8D0E5"/></left>
      <right style="thin"><color rgb="FFD8D0E5"/></right>
      <top style="thin"><color rgb="FFD8D0E5"/></top>
      <bottom style="thin"><color rgb="FFD8D0E5"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="7">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="4" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
  </cellXfs>
</styleSheet>`;
}

export function buildWorkbookBuffer(sheets: ExcelWorkbookSheetSpec[]): Buffer {
  const safeSheets =
    sheets.length > 0
      ? sheets
      : [{ name: 'Report', headers: ['ไม่มีข้อมูล'], rows: [] }];

  const usedNames = new Set<string>();
  const zipEntries: Array<{ name: string; content: Buffer }> = [];
  const contentTypeOverrides: string[] = [
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`,
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`,
  ];
  const workbookSheetTags: string[] = [];
  const workbookRelTags: string[] = [
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
  ];

  safeSheets.forEach((spec, idx) => {
    const sheetIndex = idx + 1;
    const sheetName = sanitizeSheetTabName(spec.name, usedNames, sheetIndex);
    const relId = `rId${sheetIndex + 1}`;
    const colCount = Math.max(1, spec.headers.length);
    const colWidths = spec.headers.map((h, cIdx) => {
      if (spec.columnWidths && spec.columnWidths[cIdx]) {
        return spec.columnWidths[cIdx];
      }
      let maxLen = String(h || '').length + 4;
      const sampleRows = spec.rows.slice(0, 200);
      for (const row of sampleRows) {
        const len = String(row[cIdx] ?? '').length + 3;
        if (len > maxLen) maxLen = len;
      }
      return Math.min(46, Math.max(13, maxLen));
    });

    const colsXml = `<cols>${colWidths
      .map(
        (w, cIdx) =>
          `<col min="${cIdx + 1}" max="${cIdx + 1}" width="${w}" customWidth="1"/>`
      )
      .join('')}</cols>`;

    const rowXmlParts: string[] = [];
    let currentRowNum = 1;

    if (spec.title) {
      rowXmlParts.push(
        `<row r="${currentRowNum}" ht="24" customHeight="1"><c r="A${currentRowNum}" s="1" t="inlineStr"><is><t>${escapeXml(
          sanitizeExcelText(spec.title)
        )}</t></is></c></row>`
      );
      currentRowNum++;
    }
    if (spec.subtitle) {
      rowXmlParts.push(
        `<row r="${currentRowNum}" ht="18" customHeight="1"><c r="A${currentRowNum}" s="2" t="inlineStr"><is><t>${escapeXml(
          sanitizeExcelText(spec.subtitle)
        )}</t></is></c></row>`
      );
      currentRowNum++;
    }

    const headerRowNum = currentRowNum;
    const headerCells = spec.headers.map((header, cIdx) => {
      const colRef = `${colIndexToLetters(cIdx)}${headerRowNum}`;
      return `<c r="${colRef}" s="3" t="inlineStr"><is><t>${escapeXml(
        sanitizeExcelText(header)
      )}</t></is></c>`;
    });
    rowXmlParts.push(`<row r="${headerRowNum}" ht="24" customHeight="1">${headerCells.join('')}</row>`);
    currentRowNum++;

    for (const dataRow of spec.rows) {
      const cells: string[] = [];
      for (let cIdx = 0; cIdx < colCount; cIdx++) {
        const colRef = `${colIndexToLetters(cIdx)}${currentRowNum}`;
        const rawVal = dataRow[cIdx];
        if (typeof rawVal === 'number' && Number.isFinite(rawVal)) {
          const styleId = Number.isInteger(rawVal) ? 4 : 5;
          cells.push(`<c r="${colRef}" s="${styleId}" t="n"><v>${rawVal}</v></c>`);
        } else {
          const safeStr = sanitizeExcelText(
            typeof rawVal === 'boolean' ? (rawVal ? 'ใช่' : 'ไม่ใช่') : rawVal ?? ''
          );
          cells.push(`<c r="${colRef}" s="6" t="inlineStr"><is><t>${escapeXml(safeStr)}</t></is></c>`);
        }
      }
      rowXmlParts.push(`<row r="${currentRowNum}">${cells.join('')}</row>`);
      currentRowNum++;
    }

    const lastColLetter = colIndexToLetters(colCount - 1);
    const lastRowNum = Math.max(headerRowNum, currentRowNum - 1);
    const autoFilterXml =
      spec.autoFilter !== false
        ? `<autoFilter ref="A${headerRowNum}:${lastColLetter}${lastRowNum}"/>`
        : '';

    const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews>
    <sheetView workbookViewId="0">
      <pane ySplit="${headerRowNum}" topLeftCell="A${headerRowNum + 1}" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="19"/>
  ${colsXml}
  <sheetData>${rowXmlParts.join('')}</sheetData>
  ${autoFilterXml}
</worksheet>`;

    zipEntries.push({
      name: `xl/worksheets/sheet${sheetIndex}.xml`,
      content: Buffer.from(sheetXml, 'utf8'),
    });
    contentTypeOverrides.push(
      `<Override PartName="/xl/worksheets/sheet${sheetIndex}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    );
    workbookSheetTags.push(
      `<sheet name="${escapeXml(sheetName)}" sheetId="${sheetIndex}" r:id="${relId}"/>`
    );
    workbookRelTags.push(
      `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sheetIndex}.xml"/>`
    );
  });

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-officedocument.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${contentTypeOverrides.join('\n  ')}
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    ${workbookSheetTags.join('\n    ')}
  </sheets>
</workbook>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${workbookRelTags.join('\n  ')}
</Relationships>`;

  return createZipArchive([
    { name: '[Content_Types].xml', content: Buffer.from(contentTypesXml, 'utf8') },
    { name: '_rels/.rels', content: Buffer.from(rootRelsXml, 'utf8') },
    { name: 'xl/workbook.xml', content: Buffer.from(workbookXml, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', content: Buffer.from(workbookRelsXml, 'utf8') },
    { name: 'xl/styles.xml', content: Buffer.from(buildExcelStylesXml(), 'utf8') },
    ...zipEntries,
  ]);
}

