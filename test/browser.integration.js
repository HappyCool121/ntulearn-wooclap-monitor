import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { connectBrowser, discoverTabs, BrowserSource } from '../src/browser.js';
import { extractDom, classifyObservation } from '../src/detection.js';
import { cardHtml, jpegDimensions } from '../src/question-image.js';
import { mathQuestionHTML } from './math-fixture.js';

const waiting = '<main><div role="status">There is no vote in progress at the moment. Please pay attention to the presenter.</div><p>You will be notified when a vote is started.</p><button>Click on this icon to send a message</button><button>Open reactions</button></main>';
const multiple = '<main><h1>Which number is prime?</h1><fieldset><label><input type="radio" name="answer">4</label><label><input type="radio" name="answer">5</label><label><input type="radio" name="answer">6</label></fieldset><button>Submit</button><span role="timer">30 seconds</span></main>';
const open = '<main><h2>Explain this theorem</h2><textarea aria-label="Your answer"></textarea><button>Send</button></main>';
const choiceButtons = '<main><h1>Select the correct symbol</h1><button>∈</button><button>⊂</button><button>∅</button></main>';
const image = `<main><section data-question-id="image-q"><img alt="" src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><text y="40">x+2=5</text></svg>')}" width="300" height="100"><input type="number" aria-label="Answer"><button>Submit</button></section></main>`;
const documentHTML = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:16px;font:18px sans-serif}main{width:650px;padding:20px}label{display:block}input,textarea,button{margin:8px}</style></head><body>${body}</body></html>`;

test('real Chrome iframe extraction, screenshots, standalone CLI, and disconnect lifecycle', { timeout: 45_000 }, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'wooclap-browser-test-'));
  let context, attached;
  let content = waiting;
  try {
    context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] });
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === 'ntulearn.ntu.edu.sg') await route.fulfill({ contentType: 'text/html', body: documentHTML('<h1>Test Lecture</h1><iframe id="lti-launch-iframe" src="https://app.wooclap.com/ABCDEF?isLTI13=true" style="width:800px;height:600px"></iframe>') });
      else if (url.hostname === 'app.wooclap.com') await route.fulfill({ contentType: 'text/html', body: documentHTML(content) });
      else await route.abort();
    });
    const page = context.pages()[0];
    await page.goto('https://ntulearn.ntu.edu.sg/ultra/courses/test/lti/launchFrame');
    const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
    const endpoint = `http://127.0.0.1:${port}`;
    attached = await connectBrowser(endpoint);
    const tabs = await discoverTabs(attached);
    assert.equal(tabs.length, 1, JSON.stringify(attached.contexts().flatMap((ctx) => ctx.pages().map((candidate) => ({ url: candidate.url(), frames: candidate.frames().map((entry) => entry.url()) })))));
    const source = new BrowserSource(attached, tabs[0], endpoint);
    const frame = tabs[0].frame;
    const set = async (html) => { content = html; await frame.goto('https://app.wooclap.com/ABCDEF?isLTI13=true'); };
    await t.test('waiting screen is recognized', async () => assert.equal((await source.read()).state, 'waiting'));
    await t.test('radio question yields prompt, choices and JPEG of the iframe area', async () => {
      await set(multiple);
      const observation = await source.read();
      assert.equal(observation.state, 'active'); assert.equal(observation.prompt, 'Which number is prime?'); assert.deepEqual(observation.choices, ['4', '5', '6']);
      const photo = await source.screenshot(observation);
      assert.equal(photo[0], 0xff); assert.equal(photo[1], 0xd8); assert.ok(photo.byteLength > 1000);
      if (process.env.NTULEARN_NATIVE_PREVIEW) await writeFile(process.env.NTULEARN_NATIVE_PREVIEW, photo);
    });
    await t.test('open response and button choices are recognized', async () => {
      await set(open); assert.equal((await source.read()).state, 'active');
      await set(choiceButtons); assert.deepEqual((await source.read()).choices, ['∈', '⊂', '∅']);
    });
    await t.test('image question works without text heading', async () => {
      await set(image); const observation = await source.read(); assert.equal(observation.state, 'active'); assert.equal(observation.questionId, 'image-q');
      assert.ok((await source.screenshot(observation)).byteLength > 1000);
    });
    await t.test('hidden stale question does not defeat the visible waiting state', async () => {
      await set(waiting + `<section hidden>${multiple}</section>`); assert.equal((await source.read()).state, 'waiting');
    });
    await t.test('loading, results and chat-only UI do not alert', async () => {
      for (const [html, expected] of [
        ['<main aria-busy="true"><h1>Loading question</h1></main>', 'loading'],
        ['<main><h1>Results</h1><button>Next</button></main>', 'results'],
        ['<main><h1>Wooclap</h1><button>Open reactions</button><button>Send a message</button></main>', 'unavailable'],
      ]) { await set(html); assert.equal(classifyObservation(await frame.evaluate(extractDom)).state, expected); }
    });
    await t.test('question change recreates the saved question instead of capturing the new one', async () => {
      await set(multiple); const previous = await source.read(); await set(open);
      const result = await source.captureImage(previous);
      assert.equal(result.imageSource, 'recreated'); assert.match(result.nativeError, /changed/);
      assert.match(cardHtml(previous.visualSnapshot), /Which number is prime/);
      assert.doesNotMatch(cardHtml(previous.visualSnapshot), /Explain this theorem/);
    });
    await t.test('moving question captures without element stability waits and does not scroll', async () => {
      await set(multiple + '<style>@keyframes moving{from{transform:translateX(0)}to{transform:translateX(.5px)}}main{animation:moving .1s linear infinite alternate}</style>');
      const scrollBefore = await frame.evaluate(() => ({ x: scrollX, y: scrollY, width: innerWidth, height: innerHeight }));
      const result = await source.captureImage(await source.read());
      assert.equal(result.imageSource, 'native');
      assert.deepEqual(await frame.evaluate(() => ({ x: scrollX, y: scrollY, width: innerWidth, height: innerHeight })), scrollBefore);
    });
    await t.test('offscreen choice triggers a complete recreated image', async () => {
      await set(multiple + '<style>fieldset label:last-child{margin-top:700px}</style>');
      const result = await source.captureImage(await source.read());
      assert.equal(result.imageSource, 'recreated');
      assert.match(result.nativeError, /offscreen|beyond|viewport/);
      assert.ok(jpegDimensions(result.photo).height > 100);
    });
    await t.test('overlay outside the iframe causes recreation instead of capturing the overlay', async () => {
      await set(multiple);
      await page.evaluate(() => {
        const overlay = document.createElement('div'); overlay.id = 'test-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:white;z-index:99999';
        document.body.append(overlay);
      });
      try {
        const result = await source.captureImage(await source.read());
        assert.equal(result.imageSource, 'recreated'); assert.match(result.nativeError, /obscured/);
      } finally { await page.locator('#test-overlay').evaluate((element) => element.remove()); }
    });
    await t.test('synthetic KaTeX question recreates each expression once and all four choices', async () => {
      await set(mathQuestionHTML);
      const observation = await source.read();
      assert.equal(observation.visualSnapshot.unsupported, '');
      assert.equal(observation.visualSnapshot.choices.length, 4);
      const html = cardHtml(observation.visualSnapshot);
      assert.equal((html.match(/<math\b/g) || []).length, 10);
      assert.doesNotMatch(html, /annotation|DUPLICATE_VISUAL_MATH|katex-html/);
      const native = source.captureNative;
      source.captureNative = async () => { throw new Error('Forced compositor failure'); };
      let result;
      try { result = await source.captureImage(observation); } finally { source.captureNative = native; }
      assert.equal(result.imageSource, 'recreated'); assert.equal(jpegDimensions(result.photo).width, 1000);
      if (process.env.NTULEARN_TEST_PREVIEW) await writeFile(process.env.NTULEARN_TEST_PREVIEW, result.photo);
    });
    await t.test('fraction/power MathML survives and external resource markup cannot execute', async () => {
      await set('<main><h1>Evaluate <math><mfrac><msup><mi>x</mi><mn>2</mn></msup><mn>3</mn></mfrac></math><span onclick="alert(1)"> exactly.</span></h1><label><input type="radio">A</label><label><input type="radio">B</label></main>');
      const observation = await source.read();
      const html = cardHtml(observation.visualSnapshot);
      assert.match(html, /<mfrac><msup>/); assert.doesNotMatch(html, /onclick|alert\(/);
      const photo = await source.renderer.render(observation.visualSnapshot);
      assert.ok(photo.byteLength > 1000);
      await set(multiple.replace('</main>', '<img src="data:image/svg+xml,x" width="200" height="100"></main>'));
      const unsupported = await source.read();
      assert.throws(() => cardHtml(unsupported.visualSnapshot), /images|visual/);
    });
    await t.test('Ctrl+C stops the standalone watcher and preserves the Chrome tab', async () => {
      await set(waiting);
      const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
      const child = spawn(process.execPath, [cli, '--endpoint', endpoint, '--json', 'watch', '--dry-run', '--interval', '1'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: tmpdir() });
      let output = ''; let error = ''; let signalled = false;
      child.stderr.on('data', (data) => { error += data; });
      child.stdout.on('data', (data) => {
        output += data;
        if (!signalled && output.includes('"event":"check"')) { signalled = true; child.kill('SIGINT'); }
      });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
      const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve(code)); });
      clearTimeout(timeout);
      assert.equal(exitCode, 130, output + error); assert.equal(signalled, true);
      assert.equal(page.isClosed(), false); assert.match(await page.title(), /^$/);
      assert.equal((await source.read()).state, 'waiting');
    });
    await source.close(); attached = null;
    assert.equal(page.isClosed(), false);
    assert.equal(await page.locator('h1').innerText(), 'Test Lecture');
  } finally {
    await attached?.close().catch(() => {});
    await context?.close().catch(() => {});
    await rm(profile, { recursive: true, force: true });
  }
});
