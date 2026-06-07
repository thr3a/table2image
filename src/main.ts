import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium } from 'playwright';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.6;
    background: #ffffff;
  }
  .wrapper {
    display: inline-block;
    padding: 20px;
  }
  table {
    border-collapse: collapse;
    width: max-content;
    box-shadow: 0 2px 8px rgba(0,0,0,0.12);
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid #d0d7de;
  }
  thead tr {
    background: #24292f;
    color: #ffffff;
  }
  thead th {
    padding: 12px 16px;
    font-weight: 600;
    font-size: 13px;
    letter-spacing: 0.02em;
    white-space: nowrap;
    border-right: 1px solid #3d444d;
  }
  thead th:last-child { border-right: none; }
  tbody tr:nth-child(even) { background: #f6f8fa; }
  tbody tr:nth-child(odd) { background: #ffffff; }
  tbody tr:last-child td { border-bottom: none; }
  td {
    padding: 10px 16px;
    border-bottom: 1px solid #d0d7de;
    border-right: 1px solid #d0d7de;
    vertical-align: top;
  }
  td:last-child { border-right: none; }
  code {
    background: #eaeef2;
    padding: 2px 6px;
    border-radius: 4px;
    font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 0.88em;
    color: #1f2328;
  }
  strong { font-weight: 700; }
  em { font-style: italic; }
  a { color: #0969da; text-decoration: none; }
`;

async function tableAstToHtml(tableNode: unknown): Promise<string> {
  const mdastRoot = { type: 'root', children: [tableNode] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hastRoot = await unified()
    .use(remarkRehype)
    .run(mdastRoot as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return unified()
    .use(rehypeStringify)
    .stringify(hastRoot as any);
}

async function main() {
  const inputFile = process.argv[2];
  if (!inputFile) {
    console.error('Usage: bun run main.ts <markdown-file>');
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

  const tableNodes: unknown[] = [];
  visit(ast, 'table', (node) => {
    tableNodes.push(node);
  });

  console.log(`Found ${tableNodes.length} table(s) in ${inputFile}`);
  if (tableNodes.length === 0) return;

  const browser = await chromium.launch();
  const page = await browser.newPage();

  for (let i = 0; i < tableNodes.length; i++) {
    const tableHtml = await tableAstToHtml(tableNodes[i]);

    const fullHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>${CSS}</style>
</head>
<body>
<div class="wrapper">${tableHtml}</div>
</body>
</html>`;

    await page.setContent(fullHtml, { waitUntil: 'load' });

    const wrapper = await page.$('.wrapper');
    if (!wrapper) continue;

    const outputPath = path.join(dir, `${basename}-table${String(i + 1).padStart(3, '0')}.png`);
    await wrapper.screenshot({ path: outputPath });
    console.log(`Saved: ${outputPath}`);
  }

  await browser.close();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
