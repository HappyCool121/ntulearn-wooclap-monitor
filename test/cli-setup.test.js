import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
test('setup selects a group, supports explicit destinations, preserves saved chats and rejects invalid/inaccessible chats', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wooclap-setup-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config.json'), calls = join(root, 'calls.jsonl'), preload = join(root, 'telegram.mjs');
  await writeFile(preload, `
import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url, init) => {
 const method = url.split('/').at(-1), params = JSON.parse(init.body);
 appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ method, params }) + '\\n');
 let result;
 if (method === 'getMe') result = { id: 12345, username: 'test_bot', can_join_groups: true };
 else if (method === 'getWebhookInfo') result = { url: '' };
 else if (method === 'getUpdates') result = [{ my_chat_member: { chat: { id: -1001234567890, type: 'supergroup', title: 'Lecture group' }, new_chat_member: { status: 'member' } } }];
 else if (method === 'getChat') {
   if (process.env.TEST_INACCESSIBLE) return { ok: false, status: 400, json: async () => ({ ok: false, error_code: 400, description: 'chat not found' }) };
   result = { id: Number(params.chat_id), type: process.env.TEST_CHAT_TYPE || (String(params.chat_id).startsWith('-') ? 'supergroup' : 'private') };
 } else if (method === 'sendMessage') result = { message_id: 1 };
 else throw new Error('Unexpected API: ' + method);
 return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
};
`);
  const initial = JSON.stringify({ botToken: '12345:TEST_ONLY', chatId: '42', endpoint: 'chrome', intervalSeconds: 10 });
  for (const scenario of [
    { flags: [], expected: '42' },
    { flags: ['--select-chat'], expected: '-1001234567890', discovery: true },
    { flags: ['--chat', '-1001234567890'], expected: '-1001234567890' },
    { flags: ['--chat', '-5'], type: 'channel', failure: /channels are not supported/ },
    { flags: ['--chat', '-5'], inaccessible: true, failure: /chat not found/ },
    { flags: ['--chat', '0'], failure: /numeric Telegram chat ID/ },
  ]) {
    await writeFile(config, initial); await rm(calls, { force: true });
    const child = spawn(process.execPath, ['--import', preload, cli, '--config', config, 'setup', ...scenario.flags], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '', TEST_CHAT_TYPE: scenario.type || '', TEST_INACCESSIBLE: scenario.inaccessible ? '1' : '' },
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { output += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    clearTimeout(timer);
    const requests = (await readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    if (scenario.failure) {
      assert.equal(code, 1, output); assert.match(output, scenario.failure);
      assert.equal(await readFile(config, 'utf8'), initial);
      assert.ok(requests.every((request) => request.method !== 'sendMessage'));
    } else {
      assert.equal(code, 0, output);
      assert.equal(JSON.parse(await readFile(config, 'utf8')).chatId, scenario.expected);
      assert.equal(requests.at(-1).params.chat_id, scenario.expected);
      assert.equal(requests.some((request) => request.method === 'getUpdates'), Boolean(scenario.discovery));
    }
    assert.ok(!output.includes('12345:TEST_ONLY'));
  }
});
