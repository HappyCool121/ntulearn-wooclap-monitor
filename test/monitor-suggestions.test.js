import test from 'node:test';
import assert from 'node:assert/strict';
import { Monitor } from '../src/monitor.js';
import { DeliveryQueue, TelegramError } from '../src/telegram.js';

const question = (id, prompt = 'Which number is prime?') => ({ state: 'active', fingerprint: id, title: 'Lecture', session: 'ABCDEF', link: 'https://app.wooclap.com/ABCDEF', prompt, choices: ['4', '5', '6'] });

test('generation begins only on confirmed delivery and late suggestions edit their immutable original alerts', async () => {
  const calls = [], jobs = [];
  let current = question('first'), acknowledge;
  const queue = new DeliveryQueue({ chatId: '42', call: async (method, params) => {
    calls.push({ method, params });
    if (calls.length === 1) await new Promise((resolve) => { acknowledge = resolve; });
    return { message_id: calls.length === 1 ? 101 : 102 };
  } });
  const suggestions = { enqueue: (job, done) => { jobs.push({ job, done }); } };
  const monitor = new Monitor({ read: async () => current, screenshot: async () => Buffer.from('jpeg') }, queue, { suggestions });
  await monitor.tick(); assert.equal(jobs.length, 0);
  acknowledge(); await queue.idle();
  current.prompt = 'mutated'; current.choices.reverse();
  current = question('second', 'What is 2 + 2?');
  await monitor.tick(); await queue.idle();
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].job.prompt, 'Which number is prime?');
  assert.deepEqual(jobs[0].job.choices, ['4', '5', '6']);
  assert.equal(jobs[0].job.messageId, 101); assert.equal(jobs[1].job.messageId, 102);
  jobs[1].done('B — 4. Adding two and two gives four.');
  jobs[0].done('B — 5. Five has only two positive divisors.');
  await queue.idle();
  assert.deepEqual(calls.map((call) => call.method), ['sendPhoto', 'sendPhoto', 'editMessageCaption', 'editMessageCaption']);
  assert.deepEqual(calls.slice(2).map((call) => call.params.message_id), [102, 101]);
  assert.ok(calls[3].params.caption.startsWith(jobs[0].job.base));
  assert.ok(calls.every((call) => call.params.reply_markup === undefined));
});

for (const fallback of ['capture', 'telegram']) {
  test(`${fallback} photo failure uses text edits and preserves the original alert notice`, async () => {
    const calls = []; let job, done;
    const queue = new DeliveryQueue({ chatId: '42', call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'sendPhoto') throw new TelegramError('bad photo', { code: 400 });
      return { message_id: 51 };
    } });
    const source = { read: async () => question('q1'), screenshot: async () => {
      if (fallback === 'capture') throw new Error('capture failed');
      return Buffer.from('jpeg');
    } };
    await new Monitor(source, queue, { suggestions: { enqueue: (value, callback) => { job = value; done = callback; } } }).tick();
    await queue.idle();
    assert.equal(job.deliveryType, 'sendMessage');
    assert.equal(Boolean(job.photo), fallback === 'telegram');
    assert.equal(job.prompt, 'Which number is prime?');
    done(null); await queue.idle();
    assert.equal(calls.at(-1).method, 'editMessageText');
    assert.match(calls.at(-1).params.text, /Question image unavailable/);
    assert.match(calls.at(-1).params.text, /Suggested answer unavailable\./);
  });
}

test('dry runs and basic alerts never enqueue generation or expose answer controls', async () => {
  let reads = 0; const calls = [];
  const queue = new DeliveryQueue({ chatId: '42', call: async (method, params) => { calls.push({ method, params }); return { message_id: 1 }; } });
  const source = { read: async () => { reads++; return question(String(reads)); }, screenshot: async () => Buffer.from('jpeg') };
  await new Monitor(source, queue, { dryRun: true, suggestions: { enqueue: () => assert.fail('dry-run generation') } }).tick();
  await queue.idle(); assert.equal(calls.length, 0);
  await new Monitor(source, queue).tick(); await queue.idle();
  assert.equal(calls.length, 1); assert.doesNotMatch(calls[0].params.caption, /Suggested answer/);
  assert.equal(calls[0].params.reply_markup, undefined);
});

for (const immediate of [false, true]) {
  test(`broadcast shares one ${immediate ? 'immediate' : 'delayed'} suggestion across duplicate message IDs and photo/text fallbacks`, async () => {
    const calls = [], jobs = [];
    let done;
    const telegram = { chatId: '42', call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'sendPhoto' && params.chat_id === '-20') throw new TelegramError('bad photo', { code: 400 });
      return { message_id: 7, chat: { id: Number(params.chat_id) } };
    } };
    const queue = new DeliveryQueue(telegram, { destinations: () => ['42', '-10', '-20', '-10'] });
    const suggestions = { enqueue: (job, callback) => {
      jobs.push(job); done = callback;
      if (immediate) callback('B — 5. Five is prime.');
    } };
    const monitor = new Monitor({ read: async () => question('q1'), screenshot: async () => Buffer.from('jpeg') }, queue, { suggestions });
    await monitor.tick(); await queue.idle();
    assert.equal(jobs.length, 1);
    if (!immediate) { done('B — 5. Five is prime.'); await queue.idle(); }
    const edits = calls.filter((call) => call.method.startsWith('editMessage'));
    assert.deepEqual(edits.map((call) => [call.params.chat_id, call.params.message_id, call.method]), [
      ['42', 7, 'editMessageCaption'], ['-10', 7, 'editMessageCaption'], ['-20', 7, 'editMessageText'],
    ]);
    assert.ok(edits.every((call) => /Suggested answer: B — 5/.test(call.params.caption || call.params.text)));
    assert.ok(calls.every((call) => call.params.reply_markup === undefined));
    await queue.close();
  });
}

test('broadcast failed destination does not prevent later deliveries or multiply unavailable generation', async () => {
  const calls = []; let generations = 0;
  const queue = new DeliveryQueue({ chatId: '42', call: async (method, params) => {
    calls.push({ method, params });
    if (params.chat_id === '-10') throw new TelegramError('removed', { code: 403 });
    return { message_id: 1 };
  } }, { destinations: () => ['-10', '-20', '42'] });
  const source = { read: async () => question('q1'), screenshot: async () => Buffer.from('jpeg') };
  const suggestions = { enqueue: (_job, done) => { generations++; done(null); } };
  await new Monitor(source, queue, { suggestions }).tick(); await queue.idle();
  assert.equal(generations, 1);
  const edits = calls.filter((call) => call.method.startsWith('editMessage'));
  assert.deepEqual(edits.map((call) => call.params.chat_id), ['-20', '42']);
  assert.ok(edits.every((call) => /Suggested answer unavailable\./.test(call.params.caption)));
  await queue.close();
});
