import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.addInitScript(() => { localStorage.setItem('mpu_tour_done_v1', '1'); });
  await page.goto('http://127.0.0.1:8787', { waitUntil: 'networkidle' });
  await page.locator('#tool-providers').click();
  await page.getByRole('heading', { name: 'AI Providers' }).waitFor();
  await page.locator('#provider-protocol').selectOption('responses');
  if (await page.locator('#provider-api-key').getAttribute('type') !== 'password') throw new Error('Provider key input is not masked');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/providers-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Anthropic', exact: true }).click();
  if (await page.locator('#provider-protocol').inputValue() !== 'anthropic') throw new Error('Anthropic protocol selector mismatch');
  await page.locator('#tool-indodax').click();
  await page.locator('#indodax-api-key').waitFor();
  for (const field of ['#indodax-api-key', '#indodax-api-secret']) if (await page.locator(field).getAttribute('type') !== 'password') throw new Error('Indodax credentials are not masked');
  await page.screenshot({ path: 'test-results/indodax-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/indodax-mobile.png', fullPage: true });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error('Mobile page overflows horizontally');
  if (errors.length) throw new Error(`Browser page errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({ ok: true, checked: ['provider protocols', 'masked credential fields', 'desktop and mobile layout', 'no page errors'], screenshots: 'test-results' }));
} finally { await browser.close(); }
