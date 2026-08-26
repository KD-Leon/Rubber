/**
 * XLSX Parser — extracts tabular data from Excel workbooks as Markdown tables.
 *
 * XLSX is a ZIP archive containing:
 *   xl/worksheets/sheet1.xml, ...   (cell data)
 *   xl/sharedStrings.xml            (shared string pool)
 *   xl/workbook.xml                 (sheet names)
 */

import type { ParseResult } from '../types';
import { openZipSafe, getXmlDoc, getElementsByLocalName } from './ooxmlHelpers';

/**
 * Excel hard limits per the OOXML spec (Excel 2007+):
 *   - Columns: 16384 (A..XFD), zero-based max index = 16383
 *   - Rows:    1048576, one-based max = 1048576
 * Guards against AUDIT-034 M-8: a crafted cell ref like `ZZZZZZ1` or
 * `A99999999999` would otherwise blow up colIdx/rowIdx and cause the
 * render loop to allocate billions of cells. We clamp BOTH dimensions
 * and validate the cell-ref shape before integer conversion.
 */
const EXCEL_MAX_COL = 16384;
const EXCEL_MAX_ROW = 1048576;

/**
 * Cell-ref grammar: 1..3 uppercase letters (max column XFD), then a
 * 1..7 digit positive row number (max row 1048576). Anything outside
 * this shape (lowercase, leading zero row, empty, swapped order) is
 * rejected up-front so callers do not have to second-guess the input.
 */
const CELL_REF_PATTERN = /^[A-Z]{1,3}[1-9]\d{0,6}$/;

/** Parse column letter(s) to zero-based index: A=0, B=1, ..., Z=25, AA=26 */
function colLetterToIndex(letters: string): number {
    let idx = 0;
    for (let i = 0; i < letters.length; i++) {
        idx = idx * 26 + (letters.charCodeAt(i) - 64);
    }
    return idx - 1;
}

/**
 * Parse and validate an Excel cell reference like "B5" or "XFD1048576".
 * Returns null when the ref is malformed or when the parsed col/row
 * exceed Excel hard limits. Callers should skip the cell on null.
 */
export function parseAndValidateCellRef(
    ref: string | null | undefined,
): { colIdx: number; rowIdx: number } | null {
    if (!ref || !CELL_REF_PATTERN.test(ref)) return null;

    const match = ref.match(/^([A-Z]+)(\d+)$/);
    if (!match) return null;

    const colIdx = colLetterToIndex(match[1]);
    const rowIdx = parseInt(match[2], 10);

    if (!Number.isFinite(colIdx) || colIdx < 0 || colIdx >= EXCEL_MAX_COL) return null;
    if (!Number.isFinite(rowIdx) || rowIdx < 1 || rowIdx > EXCEL_MAX_ROW) return null;

    return { colIdx, rowIdx };
}

export async function parseXlsx(data: ArrayBuffer): Promise<ParseResult> {
    const zip = await openZipSafe(data);
    const sizeTracker = { total: 0 };

    // Load shared strings (string pool referenced by index in cells)
    const sharedStrings: string[] = [];
    const ssDoc = await getXmlDoc(zip, 'xl/sharedStrings.xml', sizeTracker);
    if (ssDoc) {
        const siElements = getElementsByLocalName(ssDoc.documentElement, 'si');
        for (const si of siElements) {
            // Concatenate all <t> text within each <si>
            const tElements = getElementsByLocalName(si, 't');
            const text = tElements.map(t => t.textContent ?? '').join('');
            sharedStrings.push(text);
        }
    }

    // Get sheet names from workbook.xml
    const sheetNames: string[] = [];
    const wbDoc = await getXmlDoc(zip, 'xl/workbook.xml', sizeTracker);
    if (wbDoc) {
        const sheets = getElementsByLocalName(wbDoc.documentElement, 'sheet');
        for (const sheet of sheets) {
            sheetNames.push(sheet.getAttribute('name') ?? `Sheet${sheetNames.length + 1}`);
        }
    }

    // Find sheet files
    const sheetFiles = Object.keys(zip.files)
        .filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
        .sort((a, b) => {
            const numA = parseInt(a.match(/sheet(\d+)/)?.[1] ?? '0', 10);
            const numB = parseInt(b.match(/sheet(\d+)/)?.[1] ?? '0', 10);
            return numA - numB;
        });

    const parts: string[] = [];

    for (let i = 0; i < sheetFiles.length; i++) {
        const sheetName = sheetNames[i] ?? `Sheet${i + 1}`;
        const doc = await getXmlDoc(zip, sheetFiles[i], sizeTracker);
        if (!doc) continue;

        // Parse cells into a sparse grid
        const rows = getElementsByLocalName(doc.documentElement, 'row');
        const grid: Map<number, Map<number, string>> = new Map();
        let maxCol = 0;
        let maxRow = 0;
        let minRow = Infinity;

        for (const row of rows) {
            const cells = getElementsByLocalName(row, 'c');
            for (const cell of cells) {
                const ref = cell.getAttribute('r');
                // Validate shape and clamp BOTH col and row to Excel hard
                // limits before they can leak into maxCol/maxRow. A single
                // malformed `r="ZZZZZZ1"` would otherwise pin maxCol into
                // the hundreds of millions and OOM the renderer below.
                const parsed = parseAndValidateCellRef(ref);
                if (!parsed) continue;
                const { colIdx, rowIdx } = parsed;
                maxCol = Math.max(maxCol, colIdx);
                maxRow = Math.max(maxRow, rowIdx);
                minRow = Math.min(minRow, rowIdx);

                // Get cell value
                const type = cell.getAttribute('t');
                const vElements = getElementsByLocalName(cell, 'v');
                const rawValue = vElements[0]?.textContent ?? '';

                let value: string;
                if (type === 's') {
                    // Shared string reference
                    const idx = parseInt(rawValue, 10);
                    value = sharedStrings[idx] ?? '';
                } else if (type === 'inlineStr') {
                    const tElements = getElementsByLocalName(cell, 't');
                    value = tElements.map(t => t.textContent ?? '').join('');
                } else {
                    value = rawValue;
                }

                if (!grid.has(rowIdx)) grid.set(rowIdx, new Map());
                grid.get(rowIdx)!.set(colIdx, value);
            }
        }

        if (grid.size === 0) {
            parts.push(`## ${sheetName}\n\n(empty sheet)`);
            continue;
        }

        // Cap rows for very large sheets
        const MAX_DISPLAY_ROWS = 200;
        const totalRows = maxRow - minRow + 1;

        // Build markdown table
        const tableRows: string[][] = [];

        let rowCount = 0;
        for (let r = minRow; r <= maxRow && rowCount < MAX_DISPLAY_ROWS; r++) {
            const rowData = grid.get(r);
            if (!rowData) continue; // skip fully empty rows
            const cells: string[] = [];
            for (let c = 0; c <= maxCol; c++) {
                cells.push((rowData.get(c) ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' '));
            }
            // Skip rows where all cells are empty
            if (cells.every(c => c === '')) continue;
            tableRows.push(cells);
            rowCount++;
        }

        if (tableRows.length === 0) {
            parts.push(`## ${sheetName}\n\n(empty sheet)`);
            continue;
        }

        // First row as header
        const header = tableRows[0];
        const dataRows = tableRows.slice(1);

        const lines: string[] = [];
        lines.push('| ' + header.join(' | ') + ' |');
        lines.push('| ' + header.map(() => '---').join(' | ') + ' |');
        for (const row of dataRows) {
            // Pad to header length
            const padded = header.map((_, idx) => row[idx] ?? '');
            lines.push('| ' + padded.join(' | ') + ' |');
        }

        let sheetSection = `## ${sheetName}\n\n` + lines.join('\n');
        if (totalRows > MAX_DISPLAY_ROWS) {
            sheetSection += `\n\n*(Showing ${MAX_DISPLAY_ROWS} of ${totalRows} rows)*`;
        }

        parts.push(sheetSection);
    }

    const text = parts.length > 0
        ? parts.join('\n\n')
        : '(Empty workbook)';

    return {
        text,
        images: [],
        metadata: {
            format: 'xlsx',
            pageCount: sheetFiles.length,
            sheetNames,
        },
    };
}
