// End-to-end smoke test: loads the built extension into Chromium and walks through
// import -> template -> manual campaign -> helper. Usage: npm run build && npm run e2e
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dist = resolve(import.meta.dirname, '../dist');
const sample = resolve(import.meta.dirname, '../../sample/contacts-sample.csv');
const shots = process.env.SHOTS_DIR;
const executablePath = process.env.CHROMIUM_PATH || undefined;

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'wa-e2e-')), {
  headless: true,
  executablePath,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
// Never let the test reach the real WhatsApp Web.
await ctx.route(/web\.whatsapp\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>WhatsApp stub</title>' }));

const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1; };
const errors = [];
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const id = new URL(sw.url()).host;
console.log('extension id', id);

const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const shot = async (name, p = page) => shots && p.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
const base = `chrome-extension://${id}/dashboard.html`;

await page.goto(`${base}#/`);
await page.getByText('Welcome! Start by importing contacts').waitFor();
await shot('01-dashboard-empty');

// Import
await page.goto(`${base}#/import`);
await page.setInputFiles('input[type=file]', sample);
await page.getByText('1. Map columns').waitFor();
// Stat tiles: <div class="card p-4"><p>label</p><p>value</p></div>
const statIn = async (p, label) => (await p.locator('div.card.p-4', { has: p.locator('p', { hasText: new RegExp(`^${label}$`) }) }).first().locator('p').nth(1).innerText()).trim();
const stat = (label) => statIn(page, label);
console.log('import stats', { total: await stat('Total rows'), valid: await stat('Valid new'), dup: await stat('Duplicates'), invalid: await stat('Invalid') });
if ((await stat('Total rows')) !== '12') fail('expected 12 rows');
if ((await stat('Invalid')) !== '3') fail('expected 3 invalid');
if ((await stat('Duplicates')) !== '1') fail('expected 1 duplicate');
await page.selectOption('#consent', 'granted');
await page.fill('#cnote', 'Registration form opt-in');
await shot('02-import-review');
await page.getByRole('button', { name: /^Import \d+ contact/ }).click();
await page.waitForURL(/#\/contacts/);
await page.getByText('Asha Rao').waitFor();
const rows = await page.locator('tbody tr').count();
console.log('contacts listed', rows);
if (rows !== 8) fail(`expected 8 contacts, got ${rows}`);
await shot('03-contacts');

// Opt out one contact via suppression list
await page.goto(`${base}#/contacts?tab=optout`);
await page.fill('#s-phone', '8899001122');
await page.fill('#s-reason', 'Replied STOP');
await page.getByRole('button', { name: 'Add to opt-out list' }).click();
await page.getByText('+918899001122').waitFor();

// Template
await page.goto(`${base}#/templates`);
await page.getByLabel('Template name').waitFor();
await page.getByRole('button', { name: 'Save' }).click();
await page.getByText('Template saved').waitFor();
await shot('04-templates');

// Campaign
await page.goto(`${base}#/campaigns/new`);
await page.fill('#cn', 'Smoke test campaign');
await page.getByText('Will be messaged', { exact: true }).waitFor();
await page.waitForTimeout(300);
const willMsg = await stat('Will be messaged');
const excluded = await stat('Excluded');
console.log('audience', { willMsg, excluded });
// Excluded: 1 opted out, 1 missing course, 1 missing name.
if (willMsg !== '5' || excluded !== '3') fail('expected 5 included and 3 excluded');
await shot('05-new-campaign');
await page.getByRole('button', { name: 'Review & start' }).click();
await page.getByRole('button', { name: 'Start campaign' }).click();
await page.waitForURL(/#\/campaigns\/cmp_/);
const campaignId = page.url().split('/').pop();
await page.getByText('Timeline').waitFor();
await shot('06-campaign-details');

// Helper
const helper = await ctx.newPage();
helper.on('pageerror', (e) => errors.push(e.message));
await helper.setViewportSize({ width: 420, height: 900 });
await helper.goto(`chrome-extension://${id}/sidepanel.html?campaign=${campaignId}`);
await helper.getByRole('button', { name: 'Open chat in WhatsApp Web' }).click();
const waTab = await ctx.waitForEvent('page');
await waTab.waitForURL(/web\.whatsapp\.com/);
const waUrl = new URL(waTab.url());
console.log('opened', waUrl.origin + waUrl.pathname, 'phone', waUrl.searchParams.get('phone'));
if (waUrl.hostname !== 'web.whatsapp.com' || !waUrl.searchParams.get('text')?.includes('Your registration for')) fail('chat URL wrong');
await helper.bringToFront();
await helper.getByRole('button', { name: 'I sent it — next' }).click();
await helper.getByRole('button', { name: 'Open chat in WhatsApp Web' }).waitFor();
await helper.getByRole('button', { name: 'Skip' }).waitFor({ state: 'detached' });
await helper.getByRole('button', { name: 'Open chat in WhatsApp Web' }).click();
await helper.getByRole('button', { name: "Couldn't send" }).click();
await helper.getByRole('button', { name: 'Number is not on WhatsApp' }).click();
await helper.getByText('2 sent').or(helper.getByText('1 sent')).waitFor();
await shot('07-helper', helper);

// State survives a reload and shows in details
await page.reload();
await page.getByText('Timeline').waitFor();
await page.waitForTimeout(300);
const sentStat = await stat('Sent');
const failedStat = await stat('Failed');
console.log('details', { sent: sentStat, failed: failedStat });
if (sentStat !== '1' || failedStat !== '1') fail('expected 1 sent and 1 failed');
await page.getByRole('button', { name: /Retry 1 failed/ }).click();
await page.getByRole('button', { name: 'Retry', exact: true }).click();
await page.getByText('Retry 1 failed').waitFor({ state: 'detached' });
await page.getByRole('button', { name: 'Export report' }).click();
await shot('08-campaign-progress');

// Dark mode + popup
await page.goto(`${base}#/`);
await page.getByRole('button', { name: 'Dark mode' }).click();
await page.waitForTimeout(200);
await shot('09-dashboard-dark');
const popup = await ctx.newPage();
await popup.setViewportSize({ width: 340, height: 420 });
await popup.goto(`chrome-extension://${id}/popup.html`);
await popup.getByText('Active campaigns').waitFor();
await shot('10-popup', popup);

if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
console.log(process.exitCode ? 'SMOKE FAILED' : 'SMOKE OK');
await ctx.close();
