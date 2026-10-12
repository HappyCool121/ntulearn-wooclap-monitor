import { readFile, mkdir, writeFile, chmod, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export function configPath(env = process.env) {
  return resolve(env.NTULEARN_MONITOR_CONFIG || join(homedir(), '.config', 'ntulearn-wooclap-monitor', 'config.json'));
}

export async function loadConfig(env = process.env, path = configPath(env)) {
  let saved = {};
  try { saved = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot read configuration JSON. Check the local config file.');
  }
  const config = {
    botToken: env.TELEGRAM_BOT_TOKEN || saved.botToken || '',
    chatId: String(env.TELEGRAM_CHAT_ID || saved.chatId || ''),
    endpoint: env.NTULEARN_CDP_ENDPOINT || saved.endpoint || 'chrome',
    intervalSeconds: Number(env.NTULEARN_POLL_SECONDS || saved.intervalSeconds || 10),
    path,
    tokenSource: env.TELEGRAM_BOT_TOKEN ? 'environment' : saved.botToken ? 'config' : 'missing',
    chatSource: env.TELEGRAM_CHAT_ID ? 'environment' : saved.chatId ? 'config' : 'missing',
  };
  if (!Number.isFinite(config.intervalSeconds) || config.intervalSeconds < 1) {
    throw new Error('Polling interval must be a number of seconds, at least 1.');
  }
  return config;
}

export async function saveConfig(path, config) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({
    botToken: config.botToken, chatId: config.chatId,
    endpoint: config.endpoint, intervalSeconds: config.intervalSeconds,
  }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export function requireTelegram(config) {
  if (!config.botToken || !config.chatId) throw new Error('Telegram is not configured. Run setup, or use watch --dry-run.');
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(config.botToken)) throw new Error('Invalid Telegram bot token format. Run setup again.');
  if (!/^\d+$/.test(config.chatId)) throw new Error('Use a numeric private Telegram chat ID. Run setup again.');
}

export function redact(message, token = '') {
  let clean = String(message).replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]');
  if (token) clean = clean.replaceAll(token, '[REDACTED]');
  return clean;
}
