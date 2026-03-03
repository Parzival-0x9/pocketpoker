import { chromium } from 'playwright';

const url = 'http://127.0.0.1:4173/';

async function runScenario(name, css) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (css) await page.addStyleTag({ content: css });

  try {
    await page.waitForSelector('.stats-hero-wrap', { timeout: 8000 });
  } catch {
    console.log('\n' + name);
    console.log('stats wrapper not found after wait');
    await browser.close();
    return;
  }

  const samples = [];
  for (const y of [0, 120, 280, 520, 900]) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(120);
    const v = await page.evaluate(() => {
      const el = document.querySelector('.stats-hero-wrap');
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        top: Math.round(rect.top),
        pos: cs.position,
        z: cs.zIndex,
        winY: Math.round(window.scrollY),
      };
    });
    samples.push(v);
  }

  const tops = samples.map((s) => s.top);
  const works = tops.slice(1).every((t) => t >= -2 && t <= 10);
  console.log('\n' + name);
  console.log('tops:', tops.join(', '));
  console.log('position:', samples[0].pos, 'z:', samples[0].z, 'stickyWorks:', works);
  await browser.close();
}

const overflowHidden = `html, body, #root { overflow-x: hidden !important; }`;

await runScenario('BASE_grid_plus_overflowHidden', `${overflowHidden} .content{display:grid !important;}`);
await runScenario('STEP1_block_plus_overflowHidden', `${overflowHidden} .content{display:block !important;}`);
await runScenario('STEP2_grid_plus_overflowVisible', `html, body, #root { overflow-x: visible !important; } .content{display:grid !important;}`);
