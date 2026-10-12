import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireBotLock, TelegramReceiver } from '../src/telegram-receiver.js';
import { TelegramError } from '../src/telegram.js';

const temporary = () => mkdtemp(join(tmpdir(), 'wooclap-receiver-test-'));
test('one receiver per bot; different bots can run and release locks', async () => {
  const dir = await temporary();
  try {
    const release = await acquireBotLock('123:TEST_ONLY', dir);
    await assert.rejects(acquireBotLock('123:TEST_ONLY', dir), /Another answer receiver/);
    const other = await acquireBotLock('456:OTHER_TEST', dir); await other(); await release();
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('stale PID locks recover and a release never removes another instance lock', async () => {
  const dir = await temporary();
  try {
    const release = await acquireBotLock('test', dir);
    const [name] = await readdir(dir); const path = join(dir, name);
    await writeFile(path, JSON.stringify({ pid: 2147483647, instance: 'stale' }));
    const fresh = await acquireBotLock('test', dir);
    const freshContents = await readFile(path, 'utf8');
    await release(); assert.equal(await readFile(path, 'utf8'), freshContents);
    await fresh();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('webhook startup refusal preserves the webhook and releases the lock', async () => {
  const dir = await temporary(); const calls = [];
  const receiver = new TelegramReceiver({ token: 'test', call: async (method) => { calls.push(method); return { url: 'https://existing.example/webhook' }; } }, { directory: dir });
  try {
    await assert.rejects(receiver.start(), /existing webhook/);
    assert.deepEqual(calls, ['getWebhookInfo']); assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('long polling uses 35-second HTTP timeout, advances offsets, and skips old/duplicate text', async () => {
  const dir = await temporary(); const handled = [], polls = [];
  let receiver, count = 0;
  const telegram = { token: 'test', call: async (method, params, options) => {
    if (method === 'getWebhookInfo') return { url: '' };
    polls.push({ params, options });
    if (++count === 1) return [
      { update_id: 10, message: { date: 0 } },
      { update_id: 11, message: { date: Math.floor(Date.now() / 1000) } },
      { update_id: 11, message: { date: Math.floor(Date.now() / 1000) } },
    ];
    receiver.abort.abort(); return [];
  } };
  receiver = new TelegramReceiver(telegram, { directory: dir, handleUpdate: async (update) => handled.push(update.update_id) });
  try {
    await receiver.start(); await receiver.running;
    assert.deepEqual(handled, [11]); assert.equal(polls[0].params.timeout, 20); assert.equal(polls[0].options.timeoutMs, 35_000);
    assert.equal(polls[1].params.offset, 12); assert.deepEqual(polls[0].params.allowed_updates, ['message', 'callback_query']);
    assert.deepEqual(await readdir(dir), []);
  } finally { await receiver.close(); await rm(dir, { recursive: true, force: true }); }
});
test('network backoff honors rate limits, then poller conflict disables remote answers', async () => {
  const dir = await temporary(); const waits = [], fatal = [];
  let calls = 0;
  const telegram = { token: 'test', call: async (method) => {
    if (method === 'getWebhookInfo') return { url: '' };
    if (++calls === 1) throw new TelegramError('limited', { retryable: true, retryAfterMs: 9000 });
    throw new TelegramError('conflict', { code: 409 });
  } };
  const receiver = new TelegramReceiver(telegram, { directory: dir, handleUpdate: async () => {}, wait: async (delay) => waits.push(delay), onFatal: (reason) => fatal.push(reason) });
  try {
    await receiver.start(); await receiver.running;
    assert.deepEqual(waits, [9000]); assert.match(fatal[0], /Another Telegram poller/);
    assert.deepEqual(await readdir(dir), []);
  } finally { await receiver.close(); await rm(dir, { recursive: true, force: true }); }
});
test('shutdown aborts a long poll and releases its bot lock', async () => {
  const dir = await temporary();
  const receiver = new TelegramReceiver({ token: 'test', call: async (method, _params, { signal }) => {
    if (method === 'getWebhookInfo') return { url: '' };
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } }, { directory: dir, handleUpdate: async () => {} });
  try { await receiver.start(); await receiver.close(); assert.deepEqual(await readdir(dir), []); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
