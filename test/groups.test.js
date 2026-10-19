import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GroupRegistry, GroupListener, groupStatePath } from '../src/groups.js';
import { DeliveryQueue, TelegramError } from '../src/telegram.js';

const bot = { id: 12345, username: 'test_bot' };
const group = (id = -10) => ({ id, type: 'supergroup', title: `Group ${id}` });
const membership = (id, status = 'member', update_id = 1) => ({ update_id, my_chat_member: { chat: group(id), new_chat_member: { user: bot, status } } });
async function fixture(t, privateChat = '42') {
  const dir = await mkdtemp(join(tmpdir(), 'wooclap-groups-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, registry: new GroupRegistry(join(dir, 'groups.json'), privateChat) };
}

test('registry serializes concurrent changes, saves IDs and offsets privately, and reloads per bot', async (t) => {
  const { dir, registry } = await fixture(t);
  await registry.load();
  await Promise.all([registry.set(group(-10), true), registry.set(group(-20), true), registry.acknowledge(11)]);
  const fresh = new GroupRegistry(registry.path, '42'); await fresh.load();
  assert.deepEqual(fresh.destinations(), ['42', '-10', '-20']);
  assert.equal(fresh.state.offset, 11); assert.equal((await stat(registry.path)).mode & 0o777, 0o600);
  await fresh.set(group(-10), false); await fresh.migrate(-20, -10020);
  assert.deepEqual(fresh.destinations(), ['42', '-10020']);
  assert.deepEqual(await readdir(dir), ['groups.json']);
  const a = groupStatePath({ path: join(dir, 'config.json'), botToken: 'a' });
  assert.notEqual(a, groupStatePath({ path: join(dir, 'config.json'), botToken: 'b' }));
  assert.ok(!a.includes('botToken'));
});

test('invalid state fails visibly and a failed save does not publish or acknowledge changes', async (t) => {
  const { dir, registry } = await fixture(t);
  await writeFile(registry.path, '{'); await assert.rejects(registry.load(), /Cannot read/);
  await writeFile(registry.path, JSON.stringify({ version: 1, offset: 0, groups: { '-1': { active: 'yes', title: '' } } }));
  await assert.rejects(registry.load(), /Invalid/);
  registry.path = join(dir, 'not-a-directory', 'groups.json'); await writeFile(join(dir, 'not-a-directory'), 'x');
  await assert.rejects(registry.set(group(), true)); assert.deepEqual(registry.destinations(), ['42']); assert.equal(registry.state.offset, 0);
});

test('offline joins/removals are saved before polling acknowledges them; startup verifies saved membership', async (t) => {
  const { registry } = await fixture(t); const polls = [], sent = [];
  await registry.set(group(-30), true); await registry.acknowledge(10);
  const telegram = { token: 'test', getMe: async () => bot, call: async (method, params) => {
    if (method === 'getWebhookInfo') return { url: '' };
    if (method === 'getChatMember') return { status: 'left' };
    assert.equal(method, 'getUpdates'); polls.push(params);
    assert.equal(JSON.parse(await readFile(registry.path, 'utf8')).offset, params.offset);
    return [membership(-10, 'member', 10), membership(-20, 'member', 11), membership(-10, 'left', 12), membership(-20, 'member', 11)];
  } };
  const listener = new GroupListener(telegram, registry, { queue: { enqueue: (parts) => sent.push(parts) } });
  t.after(() => listener.close()); await listener.start();
  assert.deepEqual(registry.destinations(), ['42', '-20']); assert.equal(registry.state.offset, 13);
  assert.deepEqual(polls[0].allowed_updates, ['message', 'my_chat_member']); assert.equal(polls[0].timeout, 0);
  assert.equal(sent.length, 2);
  const fresh = new GroupRegistry(registry.path, '42'); await fresh.load(); assert.deepEqual(fresh.destinations(), ['42', '-20']);
});

test('group start recovers expired joins, ignores other commands/channels, and removal/re-add works', async (t) => {
  const { registry } = await fixture(t); const sent = [], verified = [];
  const listener = new GroupListener({ call: async (method, params) => { assert.equal(method, 'getChatMember'); verified.push(params); return { status: 'member' }; } }, registry, { queue: { enqueue: (parts) => sent.push(parts) } });
  listener.bot = bot;
  for (const text of ['/start@other_bot', '/subscribe', 'hello']) await listener.handle({ message: { chat: group(), text } });
  await listener.handle({ message: { chat: { id: 9, type: 'private' }, text: 'hello' } });
  await listener.handle({ my_chat_member: { chat: { id: -5, type: 'channel' }, new_chat_member: { user: bot, status: 'member' } } });
  await listener.handle({ message: { date: 0, chat: group(), text: '/start@TEST_BOT' } });
  await listener.handle({ message: { chat: group(), text: '/start' } });
  assert.equal(sent.length, 1); assert.equal(verified.length, 2); assert.equal(verified[0].user_id, bot.id);
  await listener.handle(membership(-10, 'kicked')); assert.equal(registry.has(-10), false);
  await listener.handle(membership(-10)); assert.equal(registry.has(-10), true); assert.equal(sent.length, 2);
  await listener.handle({ message: { chat: group(), migrate_to_chat_id: -10010 } });
  assert.deepEqual(registry.destinations(), ['42', '-10010']);
  await listener.handle({ message: { chat: group(-10010), migrate_from_chat_id: -10 } });
  assert.deepEqual(registry.destinations(), ['42', '-10010']);
});

test('startup drains multiple update batches, honors bot identity and restricted membership', async (t) => {
  const { registry } = await fixture(t); const offsets = [];
  const batch = Array.from({ length: 100 }, (_, i) => membership(-10, 'member', i + 1));
  const restricted = membership(-20, 'restricted', 101); restricted.my_chat_member.new_chat_member.is_member = true;
  const left = membership(-10, 'restricted', 102); left.my_chat_member.new_chat_member.is_member = false;
  const foreign = membership(-30, 'member', 103); foreign.my_chat_member.new_chat_member.user = { id: 99 };
  const listener = new GroupListener({ token: 'test', getMe: async () => bot, call: async (method, params) => {
    if (method === 'getWebhookInfo') return { url: '' };
    assert.equal(method, 'getUpdates'); offsets.push(params.offset);
    return offsets.length === 1 ? batch : [restricted, left, foreign];
  } }, registry);
  await listener.start(); await listener.close();
  assert.deepEqual(offsets, [0, 101]); assert.equal(registry.state.offset, 104);
  assert.deepEqual(registry.destinations(), ['42', '-20']);
});

test('configured channels fail before registering or polling and preserve an existing group registry', async (t) => {
  const { registry } = await fixture(t, '-5'); await registry.set(group(-10), true);
  const calls = [];
  const listener = new GroupListener({ token: 'test', getMe: async () => bot, call: async (method) => {
    calls.push(method);
    if (method === 'getWebhookInfo') return { url: '' };
    if (method === 'getChat') return { id: -5, type: 'channel' };
    assert.fail(method);
  } }, registry, { configuredChatId: '-5' });
  await assert.rejects(listener.start(), /channels are not supported/);
  assert.deepEqual(calls, ['getWebhookInfo', 'getChat']); assert.deepEqual(registry.destinations(), ['-10']);
  await listener.close();
});

test('queued start cannot restore a group the bot has left, and a configured group is seeded only once', async (t) => {
  const { registry } = await fixture(t, '-10');
  let checks = 0;
  const telegram = { token: 'test', getMe: async () => bot, call: async (method) => {
    if (method === 'getWebhookInfo') return { url: '' };
    if (method === 'getUpdates') return [];
    if (method === 'getChat') return group();
    if (method === 'getChatMember') { checks++; return { status: 'left' }; }
    assert.fail(method);
  } };
  const listener = new GroupListener(telegram, registry, { configuredChatId: '-10' });
  await listener.start(); await listener.handle({ message: { date: 0, chat: group(), text: '/start' } }); await listener.close();
  assert.deepEqual(registry.destinations(), []); assert.equal(checks, 2);
  const next = new GroupListener(telegram, registry, { configuredChatId: '-10' });
  await next.start(); await next.close(); assert.equal(checks, 2);
});

test('listener preserves webhooks, refuses concurrent polling, releases lock on failure/shutdown', async (t) => {
  const { dir, registry } = await fixture(t);
  const telegram = { token: 'test', getMe: async () => bot, call: async (method, _params, { signal }) => {
    if (method === 'getWebhookInfo') return { url: '' };
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } };
  const hooked = new GroupListener({ token: 'test', call: async () => ({ url: 'https://existing.example' }) }, registry);
  await assert.rejects(hooked.start(), /existing webhook/);
  const listener = new GroupListener(telegram, registry); listener.poll = async () => {};
  await listener.start();
  await assert.rejects(new GroupListener(telegram, registry).start(), /Another .* receiver/);
  listener.poll = GroupListener.prototype.poll; void listener.run(); await listener.close();
  assert.deepEqual(await readdir(join(dir, 'receiver-locks')), []);
});

test('failed handling is not acknowledged and network backoff/conflict stops listener', async (t) => {
  const { registry } = await fixture(t); const waits = [], fatal = [];
  const listener = new GroupListener({ call: async () => [membership(-10)] }, registry);
  listener.bot = bot; listener.handle = async () => { throw new Error('save failed'); };
  await assert.rejects(listener.poll(0), /save failed/); assert.equal(registry.state.offset, 0);
  let attempts = 0;
  listener.poll = async () => { if (++attempts === 1) throw new TelegramError('limited', { retryable: true, retryAfterMs: 9000 }); throw new TelegramError('conflict', { code: 409 }); };
  listener.wait = async (delay) => waits.push(delay); listener.onFatal = (error) => fatal.push(error.code);
  await listener.run(); assert.deepEqual(waits, [9000]); assert.deepEqual(fatal, [409]);
});

test('delivery migration retries the replacement chat, removal skips queued work and other destinations still deliver', async (t) => {
  const { registry } = await fixture(t); await registry.set(group(-10), true); await registry.set(group(-20), true);
  const calls = [];
  const telegram = { chatId: '42', call: async (method, params) => {
    calls.push({ method, params });
    if (params.chat_id === '-10') throw new TelegramError('migrated', { code: 400, migrateToChatId: '-10010' });
    if (params.chat_id === '-20') throw new TelegramError('removed', { code: 403 });
    return { message_id: 7 };
  } };
  const listener = new GroupListener(telegram, registry);
  const queue = new DeliveryQueue(telegram, { destinations: () => registry.destinations(), isDestination: (id) => registry.has(id), onFailure: (error, id) => listener.deliveryFailure(error, id) });
  queue.enqueue([{ method: 'sendMessage', params: { text: 'q1' } }], 'q1');
  queue.enqueue([{ method: 'sendMessage', params: { text: 'q2' } }], 'q2');
  await queue.idle();
  assert.deepEqual(registry.destinations(), ['42', '-10010']);
  assert.equal(calls.filter((call) => call.params.chat_id === '-20').length, 1);
  assert.equal(calls.filter((call) => call.params.chat_id === '42').length, 2);
  assert.ok(calls.some((call) => call.params.chat_id === '-10010'));
  await queue.close();
});

test('standalone listen-groups registers and persists joins without Chrome or answer controls', async (t) => {
  const { dir } = await fixture(t); const preload = join(dir, 'fake.mjs');
  await writeFile(preload, `
let sent = false;
globalThis.fetch = async (url, init) => {
 const method = url.split('/').at(-1), params = JSON.parse(init.body);
 let result;
 if (method === 'getWebhookInfo') result = { url: '' };
 else if (method === 'getMe') result = { id: 12345, username: 'test_bot' };
 else if (method === 'getUpdates' && !sent) { sent = true; result = ${JSON.stringify([membership(-10)])}; }
 else if (method === 'getUpdates') return new Promise((resolve, reject) => {
   const timer = setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({ ok: true, result: [] }) }), 20000);
   init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
 });
 else if (method === 'sendMessage') { if (params.chat_id !== '-10' || params.reply_markup) throw new Error('wrong welcome'); result = { message_id: 1 }; }
 else throw new Error('Unexpected API ' + method);
 return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
};
`);
  const config = { path: join(dir, 'config.json'), botToken: '12345:TEST_ONLY', chatId: '42' };
  await writeFile(config.path, JSON.stringify(config));
  const child = spawn(process.execPath, ['--import', preload, fileURLToPath(new URL('../src/cli.js', import.meta.url)), '--config', config.path, '--json', 'listen-groups'], { env: { ...process.env, TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', signalled = false; child.stdout.on('data', (data) => { output += data; if (!signalled && output.includes('"event":"groups-listening"')) { signalled = true; child.kill('SIGINT'); } }); child.stderr.on('data', (data) => { output += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const code = await new Promise((resolve) => child.once('close', resolve)); clearTimeout(timer);
  assert.equal(code, 130, output); assert.match(output, /groups-listening/); assert.ok(!output.includes('12345:TEST_ONLY'));
  const saved = JSON.parse(await readFile(groupStatePath(config), 'utf8')); assert.equal(saved.groups['-10'].active, true); assert.equal(saved.offset, 2);
});

test('private preferences load legacy state, persist start/stop, and de-duplicate the configured chat', async (t) => {
  const { registry } = await fixture(t);
  await writeFile(registry.path, JSON.stringify({ version: 1, offset: 5, groups: { '-10': { title: 'Existing', active: true } } }));
  await registry.load();
  await Promise.all([registry.setPrivate({ id: 9, type: 'private' }, true), registry.setPrivate({ id: 42, type: 'private' }, true)]);
  assert.deepEqual(registry.destinations(), ['42', '9', '-10']);
  await registry.setPrivate({ id: 42, type: 'private' }, false);
  const fresh = new GroupRegistry(registry.path, '42'); await fresh.load();
  assert.deepEqual(fresh.destinations(), ['9', '-10']); assert.equal(fresh.state.offset, 5);
  assert.equal((await stat(registry.path)).mode & 0o777, 0o600);
  for (const privateChats of [null, [], { '-9': true }, { '9': 'yes' }]) {
    await writeFile(registry.path, JSON.stringify({ version: 1, offset: 5, groups: {}, privateChats }));
    await assert.rejects(fresh.load(), /Invalid Telegram private/);
  }
});

test('private start/stop works during polling and confirms stop while dropping queued alerts and edits', async (t) => {
  const { registry } = await fixture(t); const sent = [];
  const telegram = { chatId: '42', call: async (method, params) => { sent.push({ method, ...params }); return { message_id: 1 }; } };
  const queue = new DeliveryQueue(telegram, { destinations: () => registry.destinations(), isDestination: (id) => registry.has(id) });
  t.after(() => queue.close());
  const listener = new GroupListener(telegram, registry, { queue }); listener.bot = bot;
  const command = (id, text) => ({ message: { chat: { id, type: 'private' }, text } });
  for (const text of ['/start@other_bot', '/starter', 'hello', '/subscribe', '/stopped']) await listener.handle(command(9, text));
  assert.equal(registry.has(9), false); assert.equal(sent.length, 0);
  await listener.handle(command(9, '/start@TEST_BOT payload')); await queue.idle();
  assert.equal(registry.has(9), true); assert.match(sent[0].text, /subscribed/);
  await listener.handle(command(9, '/start')); await queue.idle();
  queue.enqueue([{ method: 'sendMessage', params: { text: 'question' } }], 'q'); await queue.idle();
  assert.deepEqual(sent.filter((part) => part.text === 'question').map((part) => part.chat_id), ['42', '9']);
  // Hold the worker so both already queued alerts and edits outlive /stop.
  const kick = queue.kick; queue.kick = () => {};
  queue.enqueue([{ method: 'sendPhoto', params: { chat_id: '9', caption: 'late question' } }], 'late-q');
  queue.enqueue([{ method: 'editMessageCaption', params: { chat_id: '9', message_id: 1, caption: 'late answer' } }], 'late-edit');
  await listener.handle(command(9, '/stop')); assert.equal(registry.has(9), false);
  queue.kick = kick; queue.kick(); await queue.idle();
  assert.equal(sent.filter((part) => part.method === 'sendPhoto' || part.method === 'editMessageCaption').length, 0);
  assert.match(sent.at(-1).text, /unsubscribed/); assert.equal(sent.at(-1).chat_id, '9');
  await listener.handle(command(42, '/stop')); await queue.idle(); assert.equal(registry.has(42), false);
  await listener.handle(command(42, '/start')); await queue.idle(); assert.equal(registry.has(42), true);
  const fresh = new GroupRegistry(registry.path, '42'); await fresh.load(); assert.equal(fresh.has(9), false);
});

test('blocked private chats and forbidden deliveries unsubscribe without restoring on unblock', async (t) => {
  const { registry } = await fixture(t); await registry.setPrivate({ id: 9, type: 'private' }, true);
  await registry.set(group(), true);
  const listener = new GroupListener({}, registry); listener.bot = bot;
  const update = (status, user = bot) => ({ my_chat_member: { chat: { id: 9, type: 'private' }, new_chat_member: { user, status } } });
  await listener.handle(update('kicked', { id: 99 })); assert.equal(registry.has(9), true);
  await listener.handle(update('kicked')); assert.equal(registry.has(9), false);
  await listener.handle(update('member')); assert.equal(registry.has(9), false);
  await listener.handle({ message: { chat: { id: 9, type: 'private' }, text: '/start' } });
  await listener.deliveryFailure(new TelegramError('forbidden', { code: 403 }), '9'); assert.equal(registry.has(9), false);
  await listener.deliveryFailure(new TelegramError('temporary', { code: 429 }), '42'); assert.equal(registry.has(42), true);
  await listener.deliveryFailure(new TelegramError('forbidden', { code: 403 }), '42'); assert.equal(registry.has(42), false);
  assert.equal(registry.has(-10), true);
});

test('private changes are saved before update acknowledgment; failed saves do not advance offset', async (t) => {
  const { dir, registry } = await fixture(t); let text = '/start';
  const listener = new GroupListener({ call: async () => [{ update_id: 4, message: { chat: { id: 9, type: 'private' }, text } }] }, registry);
  listener.bot = bot;
  await listener.poll(0);
  const fresh = new GroupRegistry(registry.path, '42'); await fresh.load();
  assert.equal(fresh.has(9), true); assert.equal(fresh.state.offset, 5);
  registry.path = join(dir, 'blocked', 'state.json'); await writeFile(join(dir, 'blocked'), 'x');
  registry.state.offset = 4; text = '/stop';
  await assert.rejects(listener.poll(0)); assert.equal(registry.state.offset, 4); assert.equal(registry.has(9), true);
});
