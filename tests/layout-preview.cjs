/* Synthetic viewport checks for the production UI. Chromium is a layout probe,
 * not Firefox Android evidence. No uploaded captures or account data are read. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const {chromium} = require('playwright');

const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.LAYOUT_OUTPUT || path.join(root, 'test-artifacts/layout'));
const staging = path.join(output, 'staging');
const baseline = '1fa9a345';
const errors = [];
const rows = [];
const screenshots = path.join(output, 'screenshots');
fs.mkdirSync(screenshots, {recursive:true});
function sourceText(version, name) {
  return version === 'before'
    ? execFileSync('git', ['show', `${baseline}:${name}`], {cwd:root, encoding:'utf8'})
    : fs.readFileSync(path.join(root, name), 'utf8');
}
function stage(version) {
  const dir = path.join(staging, version);
  fs.mkdirSync(dir, {recursive:true});
  for (const name of ['downloads.css', 'parser.js', 'scanner.js', 'archive.js']) {
    fs.writeFileSync(path.join(dir, name), sourceText(version, `firefox/${name}`));
  }
  // Freeze the old fixture boundary as well as old source for the comparison.
  fs.writeFileSync(path.join(dir, 'ui-adapter.js'), sourceText(version, 'tests/selftest/ui-adapter.js'));
  fs.writeFileSync(path.join(dir, 'downloads.html'), sourceText(version, 'firefox/downloads.html')
    .replace('<script src="downloads.js" defer></script>', '<script src="ui-adapter.js" defer></script>\n<script src="downloads.js" defer></script>'));
  fs.writeFileSync(path.join(dir, 'downloads.js'), sourceText(version, 'firefox/downloads.js').replace(/\bbrowser\./g, 'SyntheticBrowser.'));
  return dir;
}
function recordCheck(condition, description, row) {
  if (!condition) errors.push(`${row.version}/${row.viewport.width}x${row.viewport.height}/${row.textScale}x/${row.state}: ${description}`);
}
async function geometry(page) {
  return page.evaluate(() => {
    const app = document.querySelector('.app');
    const visible = n => {
      if (!n || getComputedStyle(n).display === 'none' || getComputedStyle(n).visibility === 'hidden'
        || !n.getClientRects().length || n.closest('[hidden]') || n.classList.contains('visually-hidden')) return false;
      // Chromium may retain boxes for unpainted descendants of closed details.
      // Only the direct summary and its descendants are exposed in that state.
      for (let ancestor = n.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.tagName !== 'DETAILS' || ancestor.open) continue;
        const summary = [...ancestor.children].find(child => child.tagName === 'SUMMARY');
        if (!summary?.contains(n)) return false;
      }
      return true;
    };
    const rect = n => {
      if (!visible(n)) return null;
      const r = n.getBoundingClientRect();
      return {x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom};
    };
    const description = n => n.id || n.getAttribute('for') || n.textContent.trim().slice(0, 64);
    const controls = [...document.querySelectorAll('button,a,summary,label,input[type=number],input[type=date]')].filter(visible)
      .filter(n => n.tagName !== 'LABEL' || n.querySelector('input'))
      .map(n => ({name:description(n), disabled:Boolean(n.disabled || n.querySelector('input:disabled')), rect:rect(n)}));
    const clippedText = [...document.querySelectorAll('button,.segmented span,.file-type,.type-name,.type-description,.date-summary,.selection-title,.selection-range,.selection-files,.review-heading h2')]
      .filter(visible).filter(n => n.scrollWidth > n.clientWidth + 1)
      .map(n => ({name:description(n), scrollWidth:n.scrollWidth, clientWidth:n.clientWidth, rect:rect(n)}));
    const primary = [...document.querySelectorAll('.button.primary')].find(visible);
    return {
      viewport:{width:innerWidth, height:innerHeight},
      main:{scrollHeight:app.scrollHeight, clientHeight:app.clientHeight, scrollWidth:app.scrollWidth, clientWidth:app.clientWidth, scrollTop:app.scrollTop, rect:rect(app)},
      body:{scrollHeight:document.body.scrollHeight, clientHeight:document.body.clientHeight},
      horizontalOverflow:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth) > innerWidth + 1 || app.scrollWidth > app.clientWidth + 1,
      footer:rect(document.querySelector('.action-bar')), primary:rect(primary), primaryLabel:primary?.textContent.trim(),
      settings:rect(document.getElementById('settings-form')), review:rect(document.getElementById('review-panel')),
      results:rect(document.querySelector('.results-section')), selection:rect(document.getElementById('selection-summary')),
      routeDisclosureOpen:document.getElementById('routes-disclosure')?.open ?? null,
      fileCount:document.getElementById('file-count').textContent, controls, clippedText
    };
  });
}
(async () => {
  const executablePath = process.env.CHROME_PATH || chromium.executablePath();
  const browser = await chromium.launch({headless:true, executablePath, args:['--no-sandbox']});
  const provenance = {
    engine:await browser.version(), executablePath,
    currentCommit:execFileSync('git', ['rev-parse','HEAD'], {cwd:root,encoding:'utf8'}).trim(), baselineCommit:baseline,
    fixture:'Invented device and route fixture; extension API boundary replaced; all HTTP(S) blocked.',
    viewportMeaning:'CSS viewport without native Firefox toolbar. Separate Android emulator checks cover Firefox.',
    textScaleMeaning:'2x multiplies every pre-measured computed font size by two. This is a text stress probe, not Android system font scaling.'
  };
  try {
    for (const version of ['before','after']) {
      const dir = stage(version);
      for (const [width,height,textScale] of [[360,640,1],[390,844,1],[320,640,1],[320,640,2]]) {
        const page = await browser.newPage({viewport:{width,height}, deviceScaleFactor:1});
        const pageErrors=[];
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.route(/^https?:\/\//, route => route.abort());
        await page.addInitScript(() => {
          globalThis.browser = {runtime:{getURL:name=>name}, storage:{local:{get:async()=>({}),set:async()=>{}}}};
        });
        await page.goto(pathToFileURL(path.join(dir, 'downloads.html')).href + '?sourceTab=42');
        await page.waitForFunction(() => !document.getElementById('scan-button').disabled);
        if (textScale !== 1) {
          await page.evaluate(scale => {
            const nodes = [document.body,...document.querySelectorAll('body *')];
            const sizes = nodes.map(node => getComputedStyle(node).fontSize);
            nodes.forEach((node,index) => { node.style.fontSize = `${parseFloat(sizes[index]) * scale}px`; });
          }, textScale);
        }
        const capture = async state => {
          const row = {version,state,textScale,...await geometry(page),pageErrors:[...pageErrors]};
          const filename=`${version}-${width}x${height}-${textScale}x-${state}.png`;
          row.screenshot=`screenshots/${filename}`;
          await page.screenshot({path:path.join(screenshots, filename)});
          rows.push(row);
          if (version === 'after') {
            recordCheck(!row.pageErrors.length, `script errors: ${row.pageErrors.join('; ')}`, row);
            recordCheck(!row.horizontalOverflow, 'page has horizontal overflow', row);
            recordCheck(!row.clippedText.length, `clipped text: ${row.clippedText.map(item=>item.name).join(', ')}`, row);
            recordCheck(row.primary && row.primary.y >= 0 && row.primary.bottom <= height + 1, 'primary action is outside viewport', row);
            recordCheck(row.footer && row.footer.bottom <= height + 1, 'footer extends below viewport', row);
            recordCheck(row.controls.every(control => control.rect.height >= 43.9 && control.rect.width >= 43.9), 'interactive target below 44 CSS pixels', row);
            if (textScale === 1 && [360,390].includes(width) && ['configure','review'].includes(state)) {
              recordCheck(row.main.scrollHeight <= row.main.clientHeight + 1, 'default view requires scrolling', row);
            }
            if (state === 'review') {
              recordCheck(row.settings === null, 'settings should be collapsed while reviewing', row);
              recordCheck(row.routeDisclosureOpen === false, 'route list should start collapsed', row);
              recordCheck(row.fileCount === '6', `expected 6 synthetic rlogs, found ${row.fileCount}`, row);
            }
          }
        };
        await capture('configure');
        await page.locator('#scan-button').click();
        await page.waitForFunction(() => !document.getElementById('download-button').hidden && !document.getElementById('download-button').disabled);
        await capture('review');
        if (version === 'after') await page.locator('#edit-filters-button').click();
        await page.locator('#date-preset-custom').click();
        await capture('custom');
        if (version === 'after') {
          await page.locator('#edit-days-button').click();
          await capture('days');
        }
        await page.close();
      }
    }
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(output,'geometry.json'), JSON.stringify({provenance,checksPassed:!errors.length,errors,rows},null,2)+'\n');
    console.log(JSON.stringify({provenance,errors,rows:rows.map(({version,state,textScale,viewport,main,primaryLabel,horizontalOverflow,clippedText})=>({version,state,textScale,viewport,main,primaryLabel,horizontalOverflow,clippedText}))},null,2));
  }
  assert.equal(errors.length, 0, errors.join('\n'));
})().catch(error=>{console.error(error);process.exitCode=1;});
