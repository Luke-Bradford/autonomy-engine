/**
 * Screenshot the preview server's canvas — the visual verify loop for design work.
 *
 * Point it at the preview server (`PREVIEW_URL`, default :8080) and it writes a
 * PNG. Kept as a script rather than an e2e spec because it asserts nothing: its
 * whole job is to produce something a human can look at.
 *
 *   node scripts/shot.mjs <pipelineId> <out.png> [selectEdge]
 */
/* eslint-disable no-undef -- the callbacks below run inside `page.evaluate`, in
   the BROWSER, where `document` and `DOMPoint` are the globals. This file's own
   scope is Node's. */
import { chromium } from '@playwright/test';

const [pipelineId, out = 'shot.png', selectEdge] = process.argv.slice(2);
const base = process.env.PREVIEW_URL ?? 'http://127.0.0.1:8080';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 940 } });
await page.goto(`${base}/#/author/pipelines/${pipelineId}`);
await page.waitForSelector('.react-flow__node', { timeout: 20_000 });
// Let fitView finish and any hover state from the load fall away.
await page.waitForTimeout(1200);

if (selectEdge === 'select') {
  const point = await page.evaluate(() => {
    const path = document.querySelector('.react-flow__edge-path');
    const mid = path.getPointAtLength(path.getTotalLength() / 2);
    const p = new DOMPoint(mid.x, mid.y).matrixTransform(path.getScreenCTM());
    return { x: p.x, y: p.y };
  });
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(600);
}

// Park the pointer off-canvas so nothing is hovered in the shot.
await page.mouse.move(4, 4);
await page.waitForTimeout(400);
await page.screenshot({ path: out });
await browser.close();
console.log(`wrote ${out}`);
