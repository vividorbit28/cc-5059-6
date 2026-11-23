import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
// 1. default search
await page.getByRole('button', { name: '搜索两条对位声部' }).click();
await page.waitForTimeout(2500);
console.log('default search:', await page.locator('.result-panel .status').innerText());

// 2. drag a note to test editor
const before = await page.locator('.score-svg text').allInnerTexts();
const note = page.locator('.note-editable').first();
const box = await note.boundingBox();
if (box) {
  await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width/2, box.y + box.height/2 - 28, { steps: 6 });
  await page.mouse.up();
}
await page.waitForTimeout(500);
await page.screenshot({ path: '/tmp/shots/20-dragged.png', fullPage: true });
console.log('diag after drag:', (await page.locator('.diag-panel').innerText()).split('\n').slice(0,6).join(' | '));

// 3. toggling a rule triggers re-diagnose and prune stats
await page.getByRole('button', { name: '打开谱例与演示' }).click();
await page.waitForTimeout(200);
await page.locator('.example-card', { hasText: '跳进未恢复' }).click();
await page.waitForTimeout(600);
await page.screenshot({ path: '/tmp/shots/21-leap.png', fullPage: true });
console.log('leap diag:', (await page.locator('.diag-panel').innerText()).replace(/\n/g,' | ').slice(0,400));

// 4. moment inspector
await page.locator('.moment-table-wrap tbody tr').nth(1).click();
await page.waitForTimeout(300);
console.log('moment:', (await page.locator('.moment-inspector').innerText()).replace(/\n/g,' | ').slice(0,300));

// 5. wav export via offline path in browser
const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
await page.getByRole('button', { name: /导出 WAV/ }).click();
await page.waitForTimeout(2500);

console.log('ERRORS', JSON.stringify(errors, null, 1));
await browser.close();
