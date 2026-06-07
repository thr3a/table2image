import * as fs from 'node:fs';
import * as path from 'node:path';
import { createCanvas, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

// システムフォントを読み込み（絵文字・CJK対応）
for (const dir of [
  '/usr/share/fonts/truetype/noto',
  '/usr/share/fonts/opentype/noto',
  '/usr/share/fonts/truetype/dejavu'
]) {
  if (fs.existsSync(dir)) {
    GlobalFonts.loadFontsFromDir(dir);
  }
}

const FONT_SIZE = 14;
const FONT_FAMILY = '"Noto Sans CJK JP", "Noto Color Emoji", "DejaVu Sans", sans-serif';
const BOLD_FONT = `bold ${FONT_SIZE}px ${FONT_FAMILY}`;
const NORMAL_FONT = `${FONT_SIZE}px ${FONT_FAMILY}`;
const LINE_HEIGHT = FONT_SIZE * 1.6;
const CELL_PAD_X = 16;
const CELL_PAD_Y = 10;
const WRAPPER_PAD = 20;

const COLOR_HEADER_BG = '#24292f';
const COLOR_HEADER_FG = '#ffffff';
const COLOR_ROW_EVEN = '#f6f8fa';
const COLOR_ROW_ODD = '#ffffff';
const COLOR_BORDER = '#d0d7de';
const COLOR_TEXT = '#1f2328';
const COLOR_LINK = '#0969da';
const COLOR_CODE_BG = '#eaeef2';

type InlineNode = {
  type: string;
  value?: string;
  children?: InlineNode[];
  url?: string;
};

type TableAlign = 'left' | 'right' | 'center' | null;

type CellSegment = { text: string; bold: boolean; italic: boolean; code: boolean; link: boolean };

// remark-gfm が生成するテーブル AST ノードの型定義
type TableCellNode = {
  type: 'tableCell';
  children: InlineNode[];
};

type TableRowNode = {
  type: 'tableRow';
  children: TableCellNode[];
};

type TableNode = {
  type: 'table';
  align: TableAlign[];
  children: TableRowNode[];
};

const extractSegments = (node: InlineNode, bold = false, italic = false): CellSegment[] => {
  if (node.type === 'text') {
    return [{ text: node.value ?? '', bold, italic, code: false, link: false }];
  }
  if (node.type === 'inlineCode') {
    return [{ text: node.value ?? '', bold, italic, code: true, link: false }];
  }
  if (node.type === 'strong') {
    return (node.children ?? []).flatMap((c) => extractSegments(c, true, italic));
  }
  if (node.type === 'em') {
    return (node.children ?? []).flatMap((c) => extractSegments(c, bold, true));
  }
  if (node.type === 'link') {
    return (node.children ?? []).flatMap((c) => {
      const segs = extractSegments(c, bold, italic);
      return segs.map((s: CellSegment) => ({ ...s, link: true }));
    });
  }
  if (node.children) {
    return node.children.flatMap((c) => extractSegments(c, bold, italic));
  }
  return [];
};

type Cell = { segments: CellSegment[]; plainText: string };
type Row = { cells: Cell[]; isHeader: boolean };

const parseTable = (tableNode: TableNode): { rows: Row[]; aligns: TableAlign[] } => {
  const aligns: TableAlign[] = tableNode.align ?? [];
  const rows: Row[] = tableNode.children.map((rowNode, rowIdx) => {
    const isHeader = rowIdx === 0;
    const cells: Cell[] = rowNode.children.map((cellNode) => {
      const segments = (cellNode.children ?? []).flatMap((c: InlineNode) => extractSegments(c));
      const plainText = segments.map((s: CellSegment) => s.text).join('');
      return { segments, plainText };
    });
    return { cells, isHeader };
  });

  return { rows, aligns };
};

const measureSegmentsWidth = (ctx: SKRSContext2D, segments: CellSegment[]): number => {
  let w = 0;
  for (const seg of segments) {
    ctx.font = seg.bold ? BOLD_FONT : NORMAL_FONT;
    w += ctx.measureText(seg.text).width;
  }
  return w;
};

const drawCellContent = (
  ctx: SKRSContext2D,
  segments: CellSegment[],
  x: number,
  y: number,
  colWidth: number,
  rowHeight: number,
  align: TableAlign,
  fg: string
): void => {
  const totalW = measureSegmentsWidth(ctx, segments);
  const drawY = y + rowHeight / 2 - FONT_SIZE / 2 + FONT_SIZE - 1;

  let drawX = x + CELL_PAD_X;
  if (align === 'right') drawX = x + colWidth - CELL_PAD_X - totalW;
  else if (align === 'center') drawX = x + (colWidth - totalW) / 2;

  for (const seg of segments) {
    const baseFont = seg.bold ? BOLD_FONT : NORMAL_FONT;
    ctx.font = seg.italic ? `italic ${baseFont}` : baseFont;
    const segW = ctx.measureText(seg.text).width;

    if (seg.code) {
      ctx.fillStyle = COLOR_CODE_BG;
      ctx.fillRect(drawX - 3, drawY - FONT_SIZE + 2, segW + 6, FONT_SIZE + 4);
    }

    ctx.fillStyle = seg.link ? COLOR_LINK : fg;
    ctx.fillText(seg.text, drawX, drawY);

    if (seg.link) {
      ctx.strokeStyle = COLOR_LINK;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(drawX, drawY + 2);
      ctx.lineTo(drawX + segW, drawY + 2);
      ctx.stroke();
    }

    drawX += segW;
  }
};

const renderTable = (rows: Row[], aligns: TableAlign[]): Buffer => {
  const colCount = Math.max(...rows.map((r) => r.cells.length));

  // measure canvas using 1×1 temporary canvas
  const tempCanvas = createCanvas(1, 1);
  const tempCtx = tempCanvas.getContext('2d');

  // column widths = natural content width (no wrapping), matching CSS `width: max-content`
  const colWidths: number[] = Array(colCount).fill(0);
  for (const row of rows) {
    for (let ci = 0; ci < row.cells.length; ci++) {
      const cell = row.cells[ci];
      const segs = row.isHeader ? cell.segments.map((s) => ({ ...s, bold: true })) : cell.segments;
      const w = measureSegmentsWidth(tempCtx, segs);
      colWidths[ci] = Math.max(colWidths[ci], w + CELL_PAD_X * 2);
    }
  }

  // row height: single line (no wrapping needed since columns are naturally sized)
  const rowH = LINE_HEIGHT + CELL_PAD_Y * 2;

  const tableW = colWidths.reduce((a, b) => a + b, 0);
  const tableH = rows.length * rowH;
  const canvasW = tableW + WRAPPER_PAD * 2;
  const canvasH = tableH + WRAPPER_PAD * 2;

  const canvas = createCanvas(canvasW * 2, canvasH * 2);
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasW, canvasH);

  const tableX = WRAPPER_PAD;
  const tableY = WRAPPER_PAD;

  // draw cell backgrounds and content
  let curY = tableY;
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    let curX = tableX;

    for (let ci = 0; ci < colCount; ci++) {
      const cw = colWidths[ci];
      const cell = row.cells[ci] ?? { segments: [], plainText: '' };

      // ボディ行の縞模様はヘッダー行を除いたインデックスで判定する
      const bodyRowIndex = ri - 1;
      const bgColor = row.isHeader ? COLOR_HEADER_BG : bodyRowIndex % 2 === 0 ? COLOR_ROW_ODD : COLOR_ROW_EVEN;
      ctx.fillStyle = bgColor;
      ctx.fillRect(curX, curY, cw, rowH);

      const fg = row.isHeader ? COLOR_HEADER_FG : COLOR_TEXT;
      const segs = row.isHeader ? cell.segments.map((s) => ({ ...s, bold: true })) : cell.segments;

      drawCellContent(ctx, segs, curX, curY, cw, rowH, aligns[ci] ?? null, fg);

      curX += cw;
    }
    curY += rowH;
  }

  // outer border
  ctx.strokeStyle = COLOR_BORDER;
  ctx.lineWidth = 1;
  ctx.strokeRect(tableX + 0.5, tableY + 0.5, tableW, tableH);

  // column dividers
  let cx = tableX;
  for (let ci = 0; ci < colCount - 1; ci++) {
    cx += colWidths[ci];
    ctx.strokeStyle = COLOR_BORDER;
    ctx.beginPath();
    ctx.moveTo(cx + 0.5, tableY);
    ctx.lineTo(cx + 0.5, tableY + tableH);
    ctx.stroke();
  }

  // row dividers
  let ry = tableY;
  for (let ri = 0; ri < rows.length - 1; ri++) {
    ry += rowH;
    ctx.strokeStyle = ri === 0 ? '#3d444d' : COLOR_BORDER;
    ctx.beginPath();
    ctx.moveTo(tableX, ry + 0.5);
    ctx.lineTo(tableX + tableW, ry + 0.5);
    ctx.stroke();
  }

  return canvas.encodeSync('png');
};

const main = async () => {
  const inputFile = process.argv[2];
  if (!inputFile) {
    console.error('Usage: npx tsx src/main.ts <markdown-file>');
    process.exit(1);
  }

  if (!fs.existsSync(inputFile)) {
    console.error(`File not found: ${inputFile}`);
    process.exit(1);
  }

  const content = fs.readFileSync(inputFile, 'utf-8');
  const basename = path.basename(inputFile, path.extname(inputFile));
  const dir = path.dirname(path.resolve(inputFile));

  const ast = unified().use(remarkParse).use(remarkGfm).parse(content);

  const tableNodes: TableNode[] = [];
  visit(ast, 'table', (node) => {
    // unist-util-visit の Node 型は汎用的すぎるため、TableNode へのキャストが必要
    tableNodes.push(node as unknown as TableNode);
  });

  console.log(`Found ${tableNodes.length} table(s) in ${inputFile}`);
  if (tableNodes.length === 0) return;

  for (let i = 0; i < tableNodes.length; i++) {
    const { rows, aligns } = parseTable(tableNodes[i]);
    const png = renderTable(rows, aligns);

    const outputPath = path.join(dir, `${basename}-table${String(i + 1).padStart(3, '0')}.canvas.png`);
    fs.writeFileSync(outputPath, png);
    console.log(`Saved: ${outputPath}`);
  }

  console.log('Done.');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
