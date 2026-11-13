// Captures the homepage globe's overview as assets/globe-still.webp: the still shown behind the WebGL canvas
// (and while it loads). Run with the app serving the homepage, e.g.:
//   node scripts/make-globe-still.mjs http://127.0.0.1:4173/
// Needs a Chromium-based browser; uses software WebGL, so no GPU is required. Re-run after changing the globe's look.
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import { existsSync } from 'node:fs';

const url = process.argv[2] || 'http://127.0.0.1:4173/';
const executablePath = [process.env.BROWSER_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => p && existsSync(p));
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', deviceScaleFactor: 1 });
  await page.goto(url);
  const wrap = page.locator('#globe-wrap');
  await wrap.scrollIntoViewIfNeeded();
  await page.locator('.globe-canvas').waitFor();
  await page.waitForTimeout(9000);   // software WebGL needs a moment to build the dotted map
  // The badge, the callouts and the leader lines are live DOM; the still shows only the sphere, its glow and its shadow.
  await page.addStyleTag({ content: '.globe-cluster, .callouts, .globe-leaders { display: none !important; } #globe-wrap, .globe-canvas { background: none !important; }' });
  const png = await wrap.screenshot({ omitBackground: true });
  await sharp(png).resize(720, 720).webp({ quality: 82, alphaQuality: 90 }).toFile('assets/globe-still.webp');
  console.log('Saved assets/globe-still.webp');
} finally {
  await browser.close();
}
