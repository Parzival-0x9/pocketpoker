import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.stats-hero-wrap', { timeout: 15000 });

const out = [];
for (const y of [0, 80, 140, 220, 320, 520, 900]) {
  await page.evaluate((yy) => window.scrollTo(0, yy), y);
  await page.waitForTimeout(120);
  const s = await page.evaluate(() => {
    const stats = document.querySelector('.stats-hero-wrap');
    const nav = document.querySelector('nav.sticky');
    const rs = stats.getBoundingClientRect();
    const rn = nav.getBoundingClientRect();
    return {
      y: Math.round(window.scrollY),
      statsTop: Math.round(rs.top),
      navTop: Math.round(rn.top),
      statsPos: getComputedStyle(stats).position,
      navPos: getComputedStyle(nav).position,
      rootOverflowX: getComputedStyle(document.documentElement).overflowX,
      bodyOverflowX: getComputedStyle(document.body).overflowX,
    };
  });
  out.push(s);
}
console.log(JSON.stringify(out, null, 2));
await browser.close();
