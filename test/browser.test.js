import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSource, discoverTabs, isNTULearn, isWooclap, sessionIdentity } from '../src/browser.js';

const frame = { url: () => 'https://app.wooclap.com/ABCDEF?isLTI13=true' };
const page = { isClosed: () => false, url: () => 'https://ntulearn.ntu.edu.sg/ultra/courses/123/lti/launchFrame', frames: () => [frame], locator: () => ({ first: () => ({ innerText: async () => 'Lecture' }) }) };
const selected = { page, frame, key: sessionIdentity(frame.url()), url: page.url() };
test('discovery only matches exact NTULearn and Wooclap hosts', async () => {
  assert.ok(isNTULearn(page.url())); assert.ok(isWooclap(frame.url()));
  assert.equal(isNTULearn('https://ntulearn.ntu.edu.sg.evil.test/'), false);
  assert.equal(isWooclap('https://app.wooclap.com.evil.test/'), false);
  const tabs = await discoverTabs({ contexts: () => [{ pages: () => [page, { ...page, url: () => 'https://example.com' }] }] });
  assert.equal(tabs.length, 1); assert.equal(tabs[0].code, 'ABCDEF');
  assert.equal(tabs[0].link, 'https://app.wooclap.com/ABCDEF');
});
test('frame replacement is reacquired on the same selected page', async () => {
  const replacement = { ...frame };
  const changed = { ...page, frames: () => [replacement] };
  const source = new BrowserSource({ isConnected: () => true }, { ...selected, page: changed }, 'chrome');
  assert.equal((await source.resolve()).frame, replacement);
});
test('browser reconnect keeps selected session identity', async () => {
  let connects = 0;
  const replacement = { ...selected, page: { ...page, isClosed: () => false } };
  const source = new BrowserSource({ isConnected: () => false }, { ...selected, page: { isClosed: () => true } }, 'chrome', {
    connect: async () => { connects++; return { isConnected: () => true }; }, discover: async () => [replacement],
  });
  assert.equal((await source.resolve()).key, selected.key); assert.equal(connects, 1);
});
test('reconnection never silently switches to another event or duplicate tab', async () => {
  for (const candidates of [[{ ...selected, key: 'https://app.wooclap.com/OTHER' }], [selected, selected]]) {
    const source = new BrowserSource({ isConnected: () => true }, { ...selected, page: { isClosed: () => true } }, 'chrome', { discover: async () => candidates });
    await assert.rejects(source.resolve(), /unavailable|several/);
  }
});
test('shutdown disconnects the browser without closing user pages or contexts', async () => {
  let disconnects = 0;
  const source = new BrowserSource({ close: async () => { disconnects++; } }, selected, 'chrome');
  await source.close(); assert.equal(disconnects, 1); assert.equal(source.closed, true);
});
