import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig, redact, requireTelegram } from '../src/config.js';

test('config has ten-second default and environment overrides restricted saved settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wooclap-config-test-'));
  const path = join(directory, 'config.json');
  try {
    assert.equal((await loadConfig({}, path)).intervalSeconds, 10);
    await saveConfig(path, { botToken: '12345:TEST', chatId: '42', endpoint: 'chrome', intervalSeconds: 10 });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const config = await loadConfig({ TELEGRAM_BOT_TOKEN: '99999:ENV', TELEGRAM_CHAT_ID: '123', NTULEARN_POLL_SECONDS: '15' }, path);
    assert.equal(config.botToken, '99999:ENV'); assert.equal(config.chatId, '123'); assert.equal(config.intervalSeconds, 15); assert.equal(config.tokenSource, 'environment');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('invalid interval or group chat is rejected and credentials redact', async () => {
  await assert.rejects(loadConfig({ NTULEARN_POLL_SECONDS: 'NaN' }, '/no/such/file'), /Polling interval/);
  assert.throws(() => requireTelegram({ botToken: '123:ABC', chatId: '-123' }), /private/);
  assert.equal(redact('token 123:ABC and bot123:ABC', '123:ABC'), 'token [REDACTED] and bot[REDACTED]');
});
