import test from 'node:test';
import assert from 'node:assert/strict';
import { Telegram, TelegramError, DeliveryQueue, questionParts, suggestionEdit, splitText, timestamp } from '../src/telegram.js';
import { requireDestinationChat } from '../src/telegram.js';
import { REPOSITORY_URL, SUGGESTION_DISCLAIMER, SUGGESTION_MODEL } from '../src/constants.js';

const token = '12345:TEST_TOKEN';
const response = (status, data) => ({ ok: status < 400, status, json: async () => data });
test('Bot API sends multipart photos and JSON text', async () => {
  const calls = [];
  const bot = new Telegram(token, '42', { fetchImpl: async (url, init) => { calls.push({ url, init }); return response(200, { ok: true, result: { message_id: 1 } }); } });
  await bot.call('sendPhoto', { chat_id: '42', caption: 'Question' }, { photo: Buffer.from('jpeg') });
  assert.ok(calls[0].init.body instanceof FormData);
  assert.equal(calls[0].init.body.get('photo').type, 'image/jpeg');
  const markup = { inline_keyboard: [[{ text: 'A', callback_data: 'wa:test-1:0' }]] };
  await bot.call('sendPhoto', { chat_id: '42', reply_markup: markup }, { photo: Buffer.from('jpeg') });
  assert.deepEqual(JSON.parse(calls[1].init.body.get('reply_markup')), markup);
  await bot.call('sendMessage', { chat_id: '42', text: 'hello' });
  assert.equal(JSON.parse(calls[2].init.body).text, 'hello');
});
test('Telegram rate limit is retryable and retry_after is respected', async () => {
  const bot = new Telegram(token, '42', { fetchImpl: async () => response(429, { ok: false, error_code: 429, parameters: { retry_after: 12 } }) });
  await assert.rejects(bot.getMe(), (error) => error.retryable && error.retryAfterMs === 12_000);
});
test('network errors and API descriptions do not expose tokens', async () => {
  const network = new Telegram(token, '42', { fetchImpl: async () => { throw new Error(`https://api.telegram.org/bot${token}/getMe`); } });
  await assert.rejects(network.getMe(), (error) => error.retryable && !error.message.includes(token));
  const rejected = new Telegram(token, '42', { fetchImpl: async () => response(401, { ok: false, description: token }) });
  await assert.rejects(rejected.getMe(), (error) => !error.retryable && !error.message.includes(token));
});
test('setup discovers private chats only without acknowledging updates', async () => {
  const requests = [];
  const bot = new Telegram(token, '', { fetchImpl: async (url, init) => {
    requests.push({ url, params: JSON.parse(init.body) });
    return response(200, { ok: true, result: url.endsWith('getWebhookInfo') ? { url: '' } : [
      { message: { chat: { id: 42, type: 'private', first_name: 'Owner' } } },
      { message: { chat: { id: -5, type: 'group', title: 'Group' } } },
    ] });
  } });
  assert.deepEqual((await bot.privateChats()).map((chat) => chat.id), ['42']);
  assert.equal(requests[1].params.offset, undefined);
});
test('setup preserves another service’s webhook', async () => {
  const bot = new Telegram(token, '', { fetchImpl: async () => response(200, { ok: true, result: { url: 'https://existing.example/webhook' } }) });
  await assert.rejects(bot.privateChats(), /existing webhook/);
});
test('long Unicode text splits within Telegram limits without splitting surrogate pairs', () => {
  const text = '😀'.repeat(5000);
  const chunks = splitText(text);
  assert.ok(chunks.every((chunk) => chunk.length <= 4000));
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every((chunk) => !/^[\uDC00-\uDFFF]/.test(chunk)));
});
test('questions use one image with a short caption and no extracted math dump', () => {
  const event = { title: 'Lecture', session: 'ABCDEF', link: 'https://app.wooclap.com/ABCDEF', detectedAt: new Date('2026-10-12T00:00:00Z'), prompt: 'Question?', choices: ['A', 'B'], alertId: 'test-1', photo: Buffer.from('photo') };
  const short = questionParts(event);
  assert.equal(short.length, 1); assert.match(short[0].params.caption, /New Wooclap question/);
  assert.doesNotMatch(short[0].params.caption, /Question\?|Alert:|Choices:/);
  const long = questionParts({ ...event, prompt: 'x'.repeat(9000) });
  assert.equal(long.length, 1); assert.equal(long[0].method, 'sendPhoto');
  assert.ok(long[0].params.caption.length < 1024);
  assert.match(questionParts({ ...event, imageSource: 'recreated' })[0].params.caption, /Recreated question card/);
  assert.match(timestamp(event.detectedAt), /8:00:00.*SGT/);
});
test('partial delivery retries only the failed part and honors rate limits', async () => {
  const calls = []; const waits = []; const logs = [];
  let failed = false;
  const queue = new DeliveryQueue({ chatId: '42', call: async (method) => {
    calls.push(method);
    if (method === 'sendMessage' && !failed) { failed = true; throw new TelegramError('limited', { retryable: true, retryAfterMs: 9000 }); }
  } }, { wait: async (delay) => waits.push(delay), log: (event) => logs.push(event) });
  queue.enqueue([{ method: 'sendPhoto', params: {} }, { method: 'sendMessage', params: {} }], 'q1');
  await queue.idle();
  assert.deepEqual(calls, ['sendPhoto', 'sendMessage', 'sendMessage']);
  assert.deepEqual(waits, [9000]); assert.ok(logs.includes('delivered'));
});
test('permanent failure does not loop and later alerts still deliver', async () => {
  const calls = []; const logs = [];
  const queue = new DeliveryQueue({ chatId: '42', call: async (_method, params) => {
    calls.push(params.text);
    if (params.text === 'bad') throw new TelegramError('forbidden');
  } }, { log: (event) => logs.push(event) });
  queue.enqueue([{ method: 'sendMessage', params: { text: 'bad' } }], 'q1');
  queue.enqueue([{ method: 'sendMessage', params: { text: 'good' } }], 'q2');
  await queue.idle(); assert.deepEqual(calls, ['bad', 'good']); assert.ok(logs.includes('delivery-failed'));
});
test('Telegram rejects a photo format: preserve the alert as text', async () => {
  const calls = [];
  const queue = new DeliveryQueue({ chatId: '42', call: async (method, params) => {
    calls.push({ method, params });
    if (method === 'sendPhoto') throw new TelegramError('invalid photo dimensions', { code: 400 });
  } });
  const event = { title: 'Lecture', session: 'ABCDEF', link: 'https://app.wooclap.com/ABCDEF', detectedAt: new Date(), prompt: 'Question?', choices: ['A', 'B'], alertId: 'fallback-1', photo: Buffer.from('photo') };
  queue.enqueue(questionParts(event), event.alertId); await queue.idle();
  assert.deepEqual(calls.map((call) => call.method), ['sendPhoto', 'sendMessage']);
  assert.match(calls[1].params.text, /Question image unavailable/);
  assert.doesNotMatch(calls[1].params.text, /Question\?|invalid photo dimensions/);
});
test('retry budget is bounded and cancellation aborts in-flight requests', async () => {
  let calls = 0;
  const queue = new DeliveryQueue({ chatId: '42', call: async () => { calls++; throw new TelegramError('network', { retryable: true }); } }, { wait: async () => {}, maxAttempts: 3 });
  queue.enqueue([{ method: 'sendMessage', params: {} }], 'q1'); await queue.idle(); assert.equal(calls, 3);
  const stalled = new DeliveryQueue({ chatId: '42', call: async (_method, _params, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })) });
  stalled.enqueue([{ method: 'sendMessage', params: {} }], 'q2');
  await stalled.close(); assert.equal(stalled.items.length, 0);
});
test('delivery exposes confirmed receipts without resending if receipt handling fails', async () => {
  let calls = 0; const receipts = [];
  const queue = new DeliveryQueue({ chatId: '42', call: async () => { calls++; return { message_id: 123, chat: { id: 42 } }; } });
  queue.enqueue([{ method: 'sendPhoto', params: {} }], 'q1', { onSent: (receipt, part) => {
    receipts.push({ receipt, part }); throw new Error('receipt handler failed');
  } });
  await queue.idle(); assert.equal(calls, 1); assert.equal(receipts[0].receipt.message_id, 123); assert.equal(receipts[0].part.method, 'sendPhoto');
});

test('suggestions retain metadata and truncate Unicode safely to caption/text limits', () => {
  const event = { title: '😀'.repeat(200), session: 'X'.repeat(100), link: 'x'.repeat(600), detectedAt: new Date(), photo: Buffer.from('jpeg'), imageSource: 'recreated' };
  const [photo] = questionParts(event, { suggestions: true });
  assert.match(photo.params.caption, /Suggested answer: generating…/);
  assert.ok(photo.params.caption.length <= 1024);
  for (const part of [photo, photo.fallback]) {
    const job = { deliveryType: part.method, messageId: 73, base: part.suggestionBase };
    const edit = suggestionEdit(job, '😀'.repeat(5000));
    const text = edit.params.caption || edit.params.text;
    assert.equal(edit.params.message_id, 73);
    assert.ok(text.startsWith(part.suggestionBase + '\n\nSuggested answer: '));
    assert.ok(text.length <= (part.method === 'sendPhoto' ? 1024 : 4096));
    assert.ok(text.includes('…')); assert.ok(!/[\uD800-\uDBFF]…/.test(text));
    assert.equal(text.split(REPOSITORY_URL).length, 2);
    assert.match(text, new RegExp(`Model: ${SUGGESTION_MODEL}`));
    assert.ok(text.includes(SUGGESTION_DISCLAIMER));
    assert.equal(edit.params.parse_mode, undefined); assert.equal(edit.params.reply_markup, undefined);
    assert.equal(edit.method, part.method === 'sendPhoto' ? 'editMessageCaption' : 'editMessageText');
    assert.match(suggestionEdit(job, null).params.caption || suggestionEdit(job, null).params.text, /Suggested answer unavailable\./);
  }
});

test('setup discovers private/group/supergroup destinations and excludes departed bots and channels', async () => {
  const requests = [];
  const bot = new Telegram(token, '', { fetchImpl: async (url, init) => {
    requests.push(JSON.parse(init.body));
    return response(200, { ok: true, result: url.endsWith('getWebhookInfo') ? { url: '' } : [
      { message: { chat: { id: 42, type: 'private', first_name: 'Owner' } } },
      { message: { chat: { id: -5, type: 'group', title: 'Lecture group' } } },
      { my_chat_member: { chat: { id: -1001234567890, type: 'supergroup', title: 'Lecture supergroup' }, new_chat_member: { status: 'member' } } },
      { message: { chat: { id: -6, type: 'group', title: 'Left group' } } },
      { my_chat_member: { chat: { id: -6, type: 'group' }, new_chat_member: { status: 'left' } } },
      { my_chat_member: { chat: { id: -7, type: 'channel' }, new_chat_member: { status: 'administrator' } } },
    ] });
  } });
  const chats = await bot.destinationChats();
  assert.deepEqual(chats.map((chat) => chat.id), ['42', '-5', '-1001234567890']);
  assert.match(chats[1].label, /Lecture group · group \[-5\]/);
  assert.deepEqual(requests[1].allowed_updates, ['message', 'my_chat_member']);
  assert.equal(requests[1].offset, undefined);
  for (const type of ['private', 'group', 'supergroup']) assert.doesNotThrow(() => requireDestinationChat({ type }));
  assert.throws(() => requireDestinationChat({ type: 'channel' }), /channels are not supported/);
});

test('basic, generating and unavailable alerts preserve the repository footer', () => {
  for (const photo of [undefined, Buffer.from('jpeg')]) {
    for (const suggestions of [false, true]) {
      const [part] = questionParts({ title: 'Lecture', session: 'ABCDEF', link: 'https://app.wooclap.com/ABCDEF', photo }, { suggestions });
      const text = part.params.caption || part.params.text;
      assert.ok(text.endsWith(`Source: ${REPOSITORY_URL}`));
      assert.equal(text.includes(SUGGESTION_DISCLAIMER), suggestions);
      if (suggestions) {
        const edit = suggestionEdit({ base: part.suggestionBase, deliveryType: part.method, messageId: 1 }, null);
        const unavailable = edit.params.caption || edit.params.text;
        assert.ok(unavailable.includes(SUGGESTION_DISCLAIMER));
        assert.ok(unavailable.endsWith(`Source: ${REPOSITORY_URL}`));
      }
    }
  }
});

test('group migration logs the replacement ID without retrying the old destination as text', async () => {
  const calls = [], logs = [];
  const bot = new Telegram(token, '-5', { fetchImpl: async (url) => {
    calls.push(url.split('/').at(-1));
    return response(400, { ok: false, error_code: 400, parameters: { migrate_to_chat_id: -1001234567890 } });
  } });
  const queue = new DeliveryQueue(bot, { log: (event, detail) => logs.push({ event, ...detail }) });
  queue.enqueue(questionParts({ photo: Buffer.from('jpeg') }), 'q1'); await queue.idle();
  assert.deepEqual(calls, ['sendPhoto']);
  assert.match(logs[0].reason, /setup with --chat -1001234567890/);
});

test('unchanged edit succeeds and edit retries never resend a question', async () => {
  const bot = new Telegram(token, '42', { fetchImpl: async () => response(400, { ok: false, error_code: 400, description: 'Bad Request: message is not modified: specified new message content is the same' }) });
  assert.equal(await bot.call('editMessageCaption'), true);
  await assert.rejects(bot.call('sendMessage'), { code: 400 });
  const calls = []; let edits = 0;
  const queue = new DeliveryQueue({ chatId: '42', call: async (method) => {
    calls.push(method);
    if (method === 'editMessageCaption' && ++edits < 3) throw new TelegramError('transient', { retryable: true });
    if (method === 'editMessageText') throw new TelegramError('permanent', { code: 400 });
  } }, { wait: async () => {} });
  queue.enqueue([{ method: 'sendPhoto', params: {} }], 'q1');
  queue.enqueue([{ method: 'editMessageCaption', params: {} }], 'suggestion-q1');
  queue.enqueue([{ method: 'editMessageText', params: {} }], 'suggestion-q2');
  queue.enqueue([{ method: 'sendPhoto', params: {} }], 'q3');
  await queue.idle();
  assert.deepEqual(calls, ['sendPhoto', 'editMessageCaption', 'editMessageCaption', 'editMessageCaption', 'editMessageText', 'sendPhoto']);
});
