import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { cardHtml, renderNode, withDeadline, QuestionImageRenderer } from '../src/question-image.js';
import { BrowserSource, boxInside } from '../src/browser.js';

const snapshot = { question: { tag: 'span', children: [{ text: 'Question?' }] }, choices: [{ text: 'First' }, { text: 'Second' }], unsupported: '' };
test('card escapes text and attributes and rejects executable markup', () => {
  assert.equal(renderNode({ text: '<script>alert(1)</script>' }), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.throws(() => renderNode({ tag: 'script', children: [] }), /Unsupported/);
  const html = renderNode({ tag: 'math', attrs: { href: 'https://bad.example', onclick: 'alert(1)', mathvariant: 'normal' }, children: [{ tag: 'mi', children: [{ text: 'x' }] }] });
  assert.doesNotMatch(html, /href|onclick/); assert.match(html, /mathvariant="normal"/);
  assert.match(cardHtml(snapshot), /Content-Security-Policy/);
  assert.throws(() => cardHtml({ ...snapshot, unsupported: 'Unsupported image' }), /Unsupported image/);
});
test('MathML fractions and powers keep their structure', () => {
  const output = renderNode({ tag: 'math', children: [{ tag: 'mfrac', children: [{ tag: 'msup', children: [{ tag: 'mi', children: [{ text: 'x' }] }, { tag: 'mn', children: [{ text: '2' }] }] }, { tag: 'mn', children: [{ text: '3' }] }] }] });
  assert.match(output, /<mfrac><msup><mi>x<\/mi><mn>2<\/mn><\/msup><mn>3<\/mn><\/mfrac>/);
});
test('image deadline cancels work and already-aborted work never starts', async () => {
  let cleaned = false;
  await assert.rejects(withDeadline(() => new Promise(() => {}), 15, () => { cleaned = true; }), /timed out/);
  assert.equal(cleaned, true);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(withDeadline(() => assert.fail('started after abort'), 100, () => {}, abort.signal), /cancelled/);
});
test('native clipping rejects an offscreen or partially cut question', () => {
  assert.ok(boxInside({ x: 10, y: 10, width: 100, height: 100 }, { x: 0, y: 0, width: 500, height: 500 }));
  assert.equal(boxInside({ x: 10, y: 400, width: 100, height: 200 }, { x: 0, y: 0, width: 500, height: 500 }), false);
});
test('capture falls back using immutable snapshot and later questions can still capture', async () => {
  const renderer = { render: async (saved) => { assert.equal(saved, snapshot); return Buffer.from('card'); }, close: async () => {}, cancelActive: async () => {} };
  const source = new BrowserSource({ close: async () => {} }, { key: 'session', url: 'url' }, 'chrome', { renderer });
  source.captureNative = async () => { throw new Error('unstable'); };
  const result = await source.captureImage({ visualSnapshot: snapshot });
  assert.equal(result.imageSource, 'recreated'); assert.equal(result.nativeError, 'unstable');
  source.captureNative = async () => Buffer.from('native');
  assert.equal((await source.captureImage({ visualSnapshot: snapshot })).imageSource, 'native');
  await source.close();
});
test('renderer cancellation cleans a launch still in flight', async () => {
  let resolveLaunch; let closes = 0;
  const browser = { close: async () => { closes++; }, isConnected: () => true };
  const renderer = new QuestionImageRenderer({ launch: () => new Promise((resolve) => { resolveLaunch = resolve; }) });
  const rendering = renderer.render(snapshot, { timeoutMs: 20 });
  await assert.rejects(rendering, /timed out/);
  const closing = renderer.close(); resolveLaunch(browser); await closing;
  assert.ok(closes >= 1);
});
test('renderer timeout closes an active isolated context', async () => {
  let rejectContent; let closes = 0;
  const context = {
    route: async () => {},
    newPage: async () => ({ setContent: () => new Promise((_resolve, reject) => { rejectContent = reject; }) }),
    close: async () => { closes++; rejectContent?.(new Error('context closed')); },
  };
  const browser = { isConnected: () => true, newContext: async () => context, close: async () => {} };
  const renderer = new QuestionImageRenderer({ launch: async () => browser });
  await assert.rejects(renderer.render(snapshot, { timeoutMs: 20 }), /timed out/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(closes >= 1); assert.equal(renderer.contexts.size, 0);
  await renderer.close();
});
test('slow cold launch renders successfully and the browser is reused', { timeout: 10_000 }, async () => {
  let launches = 0, contexts = 0, closed = 0;
  const jpeg = Buffer.from('ffd8ffc00011080020002003012200021101031101', 'hex');
  const browser = { isConnected: () => true, close: async () => { closed++; }, newContext: async () => {
    contexts++;
    return { route: async () => {}, close: async () => {}, newPage: async () => ({
      setContent: async () => {}, locator: () => ({ boundingBox: async () => ({ height: 200 }) }), screenshot: async () => jpeg,
    }) };
  } };
  const renderer = new QuestionImageRenderer({ launch: async ({ timeout }) => {
    launches++;
    if (timeout <= 5500) throw new Error('launch timeout');
    await sleep(5500);
    return browser;
  } });
  try {
    assert.deepEqual(await renderer.render(snapshot), jpeg);
    assert.deepEqual(await renderer.render(snapshot), jpeg);
    assert.equal(launches, 1); assert.equal(contexts, 2);
  } finally { await renderer.close(); }
  assert.equal(closed, 1);
});
test('a rejected browser launch clears pending state and can retry', async () => {
  let launches = 0;
  const browser = { isConnected: () => true, close: async () => {} };
  const renderer = new QuestionImageRenderer({ launch: async () => {
    if (++launches === 1) throw new Error('cold launch failed');
    return browser;
  } });
  await assert.rejects(renderer.getBrowser(), /cold launch failed/);
  assert.equal(renderer.launching, null);
  assert.equal(await renderer.getBrowser(), browser);
  await renderer.close();
});
test('abort during browser launch prevents late context creation and closes owned browser on shutdown', async () => {
  let resolveLaunch, closes = 0;
  const renderer = new QuestionImageRenderer({ launch: () => new Promise((resolve) => { resolveLaunch = resolve; }) });
  const abort = new AbortController();
  const rendering = renderer.render(snapshot, { signal: abort.signal });
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  await assert.rejects(rendering, /cancelled/);
  const closing = renderer.close();
  resolveLaunch({ isConnected: () => true, close: async () => { closes++; }, newContext: () => assert.fail('context created after shutdown') });
  await closing;
  assert.ok(closes >= 1);
});
test('native timeout falls back and does not disable later captures', { timeout: 4000 }, async () => {
  const renderer = { render: async () => Buffer.from('card'), close: async () => {}, cancelActive: async () => {} };
  const source = new BrowserSource({ close: async () => {} }, { key: 'session', url: 'url' }, 'chrome', { renderer });
  source.captureNative = async () => new Promise(() => {});
  assert.equal((await source.captureImage({ visualSnapshot: snapshot })).imageSource, 'recreated');
  source.captureNative = async () => Buffer.from('native');
  assert.equal((await source.captureImage({ visualSnapshot: snapshot })).imageSource, 'native');
  await source.close();
});
