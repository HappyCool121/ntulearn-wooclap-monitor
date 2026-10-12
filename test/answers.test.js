import test from 'node:test';
import assert from 'node:assert/strict';
import { AnswerController } from '../src/answers.js';

function harness(submit = async () => ({ code: 'submitted' })) {
  const calls = [], outgoing = [], acknowledgments = [];
  const source = { submitAnswer: async (...args) => { calls.push(args); return submit(...args); } };
  const telegram = { chatId: '42', call: async (...args) => { acknowledgments.push(args); return true; } };
  const queue = { enqueue: (parts, label) => { outgoing.push({ parts, label }); return true; } };
  const answers = new AnswerController(source, telegram, queue);
  const observation = { state: 'active', fingerprint: 'question1', sessionKey: 'session1', answerState: {
    supported: true, signature: 'mapping1', options: [{ enabled: true }, { enabled: true }, { enabled: true }],
  } };
  const binding = answers.prepare({ alertId: 'abc123-1' }, observation);
  const bind = (id = 100) => answers.receipt(binding, { message_id: id, chat: { id: 42 } });
  const callback = (index = 1, extra = {}) => ({ callback_query: { id: 'cb1', from: { id: 42 }, message: { message_id: 100, chat: { id: 42, type: 'private' } }, data: `wa:${binding.id}:${index}`, ...extra } });
  const reply = (letter = 'b', extra = {}) => ({ message: { message_id: 200, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: letter, reply_to_message: { message_id: 100 }, ...extra } });
  return { answers, binding, observation, calls, outgoing, acknowledgments, bind, callback, reply };
}

test('buttons have ordered letters, short callbacks and a reply instruction', () => {
  const h = harness();
  const parts = h.answers.decorate([{ method: 'sendPhoto', params: { caption: 'Question' }, fallback: { method: 'sendMessage', params: { text: 'No image' } } }], h.binding);
  assert.deepEqual(parts[0].params.reply_markup.inline_keyboard[0].map((button) => button.text), ['A', 'B', 'C']);
  assert.ok(parts[0].params.reply_markup.inline_keyboard[0].every((button) => Buffer.byteLength(button.callback_data) <= 64));
  assert.match(parts[0].params.caption, /Tap a letter/);
  assert.ok(parts[0].fallback.params.reply_markup);
});
test('receipt-bound owner callback submits its selected index and confirms', async () => {
  const h = harness(); h.bind();
  await h.answers.handleUpdate(h.callback(1));
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][1], 1);
  assert.equal(h.binding.status, 'submitted');
  assert.ok(h.outgoing.some((item) => item.parts[0].params.text === 'Submitted option B.'));
});
test('lowercase letter reply to the exact alert submits', async () => {
  const h = harness(); h.bind(); await h.answers.handleUpdate(h.reply(' c '));
  assert.equal(h.calls[0][1], 2);
});
test('unattached, old-run, forwarded, unknown, invalid and unconfirmed-delivery messages cannot submit', async () => {
  const h = harness();
  await h.answers.handleUpdate(h.callback()); // Delivery receipt not registered.
  h.bind();
  await h.answers.handleUpdate(h.reply('B', { reply_to_message: undefined }));
  await h.answers.handleUpdate(h.reply('B', { reply_to_message: { message_id: 999 } }));
  await h.answers.handleUpdate(h.reply('BB'));
  await h.answers.handleUpdate(h.reply('Z'));
  await h.answers.handleUpdate(h.callback(1, { data: 'wa:another-run:1' }));
  await h.answers.handleUpdate(h.callback(1, { message: { message_id: 101, chat: { id: 42, type: 'private' } } }));
  assert.equal(h.calls.length, 0);
  assert.ok(h.outgoing.some((item) => /Reply to the question alert/.test(item.parts[0].params.text || '')));
});
test('other users, groups and bots are rejected', async () => {
  const h = harness(); h.bind();
  await h.answers.handleUpdate(h.callback(1, { from: { id: 99 } }));
  await h.answers.handleUpdate(h.callback(1, { from: { id: 42, is_bot: true } }));
  await h.answers.handleUpdate(h.reply('A', { chat: { id: 42, type: 'group' } }));
  await h.answers.handleUpdate(h.reply('A', { chat: { id: 99, type: 'private' } }));
  assert.equal(h.calls.length, 0);
});
test('double taps and repeated replies cause at most one browser attempt', async () => {
  const h = harness(); h.bind();
  await Promise.all([h.answers.handleUpdate(h.callback(0)), h.answers.handleUpdate(h.callback(1))]);
  await h.answers.handleUpdate(h.reply('A'));
  assert.equal(h.calls.length, 1);
});
test('waiting/reopening the same question expires the old alert', async () => {
  const h = harness(); h.bind(); h.answers.observe({ state: 'waiting' });
  const fresh = h.answers.prepare({ alertId: 'abc123-2' }, h.observation);
  await h.answers.handleUpdate(h.callback());
  assert.equal(h.calls.length, 0); assert.equal(fresh.status, 'open');
});
test('manual selections, changed mappings and submitted questions disable controls', async () => {
  for (const changed of [
    (h) => ({ ...h.observation, answerState: { ...h.observation.answerState, options: [{ enabled: true, selected: true }] } }),
    (h) => ({ ...h.observation, answerState: { ...h.observation.answerState, signature: 'reordered' } }),
    () => ({ state: 'results', answerState: { submitted: true } }),
  ]) {
    const h = harness(); h.bind(); h.answers.observe(changed(h));
    await h.answers.handleUpdate(h.callback()); assert.equal(h.calls.length, 0);
    assert.ok(h.outgoing.some((item) => item.parts[0].method === 'editMessageReplyMarkup'));
  }
});
test('unconfirmed submission is never retried and technical errors stay in logs', async () => {
  const h = harness(async () => ({ code: 'unconfirmed', reason: 'locator.click: timeout stack trace' })); h.bind();
  await h.answers.handleUpdate(h.callback()); await h.answers.handleUpdate(h.callback());
  assert.equal(h.calls.length, 1);
  const texts = h.outgoing.flatMap((item) => item.parts.map((part) => part.params.text || '')).join('\n');
  assert.match(texts, /Submission unconfirmed/); assert.doesNotMatch(texts, /locator\.click/);
});
test('disabled/closed controller invalidates commands and removes active keyboards', async () => {
  const h = harness(); h.bind(); await h.answers.close(); await h.answers.handleUpdate(h.callback());
  assert.equal(h.calls.length, 0);
  assert.ok(h.acknowledgments.some(([method]) => method === 'editMessageReplyMarkup'));
});
