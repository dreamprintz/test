// Cloud API flow against the real backend with a mocked Meta API (backend/e2e/mock-meta-server.ts).
// Starts its own mock backend. Usage: npm run build && npm run e2e:cloud
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dist = resolve(import.meta.dirname, '../dist');
const sample = resolve(import.meta.dirname, '../../sample/contacts-sample.csv');
const port = process.env.MOCK_PORT ?? '8799';
const backend = `http://127.0.0.1:${port}`;
const key = process.env.BACKEND_API_KEY ?? 'e2e-key-0123456789abcdefghij';
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1; };

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'wa-e2e-')), {
  headless: true, executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const id = new URL(sw.url()).host;
console.log('extension id', id);

const backendDir = resolve(import.meta.dirname, '../../backend');
const mock = spawn(join(backendDir, 'node_modules/.bin/tsx'), ['e2e/mock-meta-server.ts'], { cwd: backendDir, detached: true, env: { ...process.env, PORT: port, BACKEND_API_KEY: key, ALLOWED_ORIGINS: `chrome-extension://${id}` }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => {
  mock.stdout.on('data', (d) => { if (process.env.VERBOSE) process.stdout.write(d); if (String(d).includes('listening')) res(); });
  mock.on('exit', (c) => rej(new Error(`mock backend exited ${c}`)));
});
const stopMock = () => { try { process.kill(-mock.pid); } catch {} };
process.on('exit', stopMock);

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const base = `chrome-extension://${id}/dashboard.html`;
await page.goto(`${base}#/`);
// Equivalent to filling in Settings (which also asks Chrome for host permission via a prompt).
await page.evaluate(async ({ backend, key }) => {
  const { settings = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, cloudApi: { enabled: true, backendUrl: backend, backendKey: key, dataSharingConsent: true, ratePerMinute: 600 } } });
}, { backend, key });
const stat = async (label) => (await page.locator('div.card.p-4', { has: page.locator('p', { hasText: new RegExp(`^${label}$`) }) }).first().locator('p').nth(1).innerText()).trim();

await page.goto(`${base}#/import`);
await page.setInputFiles('input[type=file]', sample);
await page.selectOption('#consent', 'granted');
await page.getByRole('button', { name: /^Import \d+ contact/ }).click();
await page.waitForURL(/#\/contacts/);
await page.goto(`${base}#/templates`);
await page.getByRole('button', { name: 'Save' }).click();
await page.getByText('Template saved').waitFor();

await page.goto(`${base}#/campaigns/new`);
await page.fill('#cn', 'Cloud campaign');
await page.getByLabel(/Official WhatsApp Business API/).check();
await page.fill('#ctn', 'registration_confirmation');
await page.getByRole('button', { name: 'Add body parameter' }).click();
await page.getByRole('button', { name: 'Add body parameter' }).click();
await page.getByLabel('Field for parameter 2').selectOption('course');
await page.getByText('Template parameters:').waitFor();
await page.getByRole('button', { name: 'Review & start' }).click();
await page.getByRole('button', { name: 'Start campaign' }).click();
await page.waitForURL(/#\/campaigns\/cmp_/);

// The service worker sends in the background.
await page.waitForFunction(() => /Pending\s*0/.test(document.body.innerText.replace(/\n/g, ' ')) || document.body.innerText.includes('Completed'), null, { timeout: 30000 });
await page.getByText('Completed', { exact: true }).waitFor({ timeout: 30000 });
const sent = await stat('Sent'), failed = await stat('Failed'), skipped = await stat('Skipped');
console.log('cloud results', { sent, failed, skipped });
// 8 contacts: 2 skipped (missing name / missing course). Asha's number ends in 0, which the mock rejects as undeliverable.
if (sent !== '5' || failed !== '1' || skipped !== '2') fail('expected 5 sent, 1 failed, 2 skipped');
if (await page.getByRole('button', { name: /^Retry \d+ failed/ }).count()) fail('permanent failure must not be offered for automatic retry');

// Webhook: mark first message read, then pull statuses.
const body = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.mock1', status: 'read' }], messages: [{ from: '919876543210', type: 'text', text: { body: 'STOP' } }] } }] }] });
const wh = await fetch(`${backend}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', 'mock-secret').update(body).digest('hex')}` }, body });
if (wh.status !== 200) fail(`webhook ${wh.status}`);
await page.getByRole('button', { name: 'Export report' }).waitFor();
await page.evaluate(() => chrome.runtime.sendMessage({ type: 'cloud-queue-kick' }));
await page.waitForFunction(() => document.body.innerText.includes('1 / 1'), null, { timeout: 15000 });
console.log('delivery/read updated');
await page.goto(`${base}#/contacts?tab=optout`);
await page.getByText('+919876543210').waitFor({ timeout: 10000 });
console.log('STOP reply synced to opt-out list');

if (errors.length) fail(errors.join(' | '));
console.log(process.exitCode ? 'CLOUD E2E FAILED' : 'CLOUD E2E OK');
await ctx.close();
stopMock();
