#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig, saveConfig, requireTelegram, redact } from './config.js';
import { ask, choose, hiddenToken } from './prompt.js';
import { connectBrowser, discoverTabs, publicTab, BrowserSource, CHROME_SETUP } from './browser.js';
import { Telegram, DeliveryQueue, timestamp } from './telegram.js';
import { Monitor } from './monitor.js';

const program = new Command();
program.name('ntulearn-watch').description('Monitor a logged-in NTULearn Wooclap tab and alert your private Telegram chat.').version('1.0.0')
  .option('--config <path>', 'Local credential/configuration JSON path')
  .option('--endpoint <endpoint>', 'Chrome channel name or local CDP URL (default: chrome)')
  .option('--json', 'Machine-readable results/events (no credentials)');

let tokenToRedact = '';
async function config() {
  const flags = program.opts();
  const env = { ...process.env, ...(flags.config ? { NTULEARN_MONITOR_CONFIG: flags.config } : {}) };
  const value = await loadConfig(env);
  if (flags.endpoint) value.endpoint = flags.endpoint;
  tokenToRedact = value.botToken;
  return value;
}

function emit(event, detail = {}) {
  const value = JSON.parse(redact(JSON.stringify({ event, ...detail }), tokenToRedact));
  if (program.opts().json) console.log(JSON.stringify(value));
  else {
    const { event: name, ...rest } = value;
    console.log(`[${timestamp()}] ${name}${Object.keys(rest).length ? ': ' + JSON.stringify(rest) : ''}`);
  }
}

async function withBrowser(action) {
  const value = await config();
  const browser = await connectBrowser(value.endpoint);
  try { return await action(browser, value); }
  finally { await browser.close(); }
}

program.command('setup').description('Configure Telegram locally, discover your private chat, and send a test alert')
  .action(async () => {
    if (program.opts().json) throw new Error('setup is interactive; omit --json.');
    const value = await config();
    console.log('1. Open https://t.me/BotFather and send /newbot. Choose a name and a username ending in bot.');
    console.log('2. Open your new bot’s chat and send /start. Keep the token private.');
    value.botToken ||= await hiddenToken();
    tokenToRedact = value.botToken;
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(value.botToken)) throw new Error('Invalid Telegram bot token format.');
    const telegram = new Telegram(value.botToken, value.chatId);
    const me = await telegram.getMe();
    console.log(`Connected to @${me.username}.`);
    if (!value.chatId) {
      let chats = await telegram.privateChats();
      if (!chats.length) {
        await ask('Send /start to your new bot now, then press Enter here: ');
        chats = await telegram.privateChats();
      }
      const selected = await choose(chats, 'private Telegram chat');
      value.chatId = selected.id;
    }
    requireTelegram(value);
    const chat = await telegram.call('getChat', { chat_id: value.chatId });
    if (chat.type !== 'private') throw new Error('This tool requires your private Telegram chat.');
    telegram.chatId = value.chatId;
    await saveConfig(value.path, value);
    await telegram.call('sendMessage', { chat_id: value.chatId, text: `NTULearn Wooclap alerts are connected.\n${timestamp()}\nRun the watch command during your lecture.` });
    console.log(`Saved restricted configuration to ${value.path}. Test alert sent.`);
    console.log(CHROME_SETUP);
  });

program.command('tabs').description('List NTULearn tabs with an embedded Wooclap session')
  .action(async () => withBrowser(async (browser) => {
    const tabs = (await discoverTabs(browser)).map(publicTab);
    emit('tabs', { tabs });
    if (!tabs.length && !program.opts().json) console.log('Open the lecture’s Wooclap session inside NTULearn, then retry.');
  }));

program.command('doctor').description('Check local configuration, Telegram authentication, and Chrome access without sending messages')
  .action(async () => {
    const value = await config();
    const result = { node: process.version, playwright: '1.64.0', configPath: value.path, tokenSource: value.tokenSource, chatSource: value.chatSource, intervalSeconds: value.intervalSeconds, telegram: { ok: false }, chrome: { ok: false } };
    // Independent checks: a Telegram setup issue must not hide Chrome diagnostics.
    await Promise.allSettled([
      (async () => {
        try {
          requireTelegram(value);
          const telegram = new Telegram(value.botToken, value.chatId);
          const me = await telegram.getMe();
          const chat = await telegram.call('getChat', { chat_id: value.chatId });
          if (chat.type !== 'private') throw new Error('Configured Telegram chat must be private.');
          result.telegram = { ok: true, bot: me.username };
        } catch (error) { result.telegram.reason = redact(error.message, value.botToken); }
      })(),
      (async () => {
        let browser;
        try {
          browser = await connectBrowser(value.endpoint);
          const tabs = await discoverTabs(browser);
          result.chrome = { ok: true, matchingTabs: tabs.map(publicTab) };
        } catch (error) { result.chrome.reason = error.message; }
        finally { await browser?.close(); }
      })(),
    ]);
    emit('doctor', { ...result, ready: result.telegram.ok && result.chrome.ok && result.chrome.matchingTabs.length > 0 });
    if (!result.telegram.ok || !result.chrome.ok || !result.chrome.matchingTabs?.length) process.exitCode = 1;
  });

program.command('watch').description('Poll the selected session every 10 seconds; stop with Ctrl+C')
  .option('--dry-run', 'Inspect questions and screenshot capture without sending any Telegram messages')
  .option('--once', 'Perform one check, then stop (useful with --dry-run)')
  .option('--session <code>', 'Select a Wooclap event code from tabs output')
  .option('--tab <number>', 'Select a 1-based matching tab index from tabs output')
  .option('--interval <seconds>', 'Override polling interval, at least 1 second')
  .action(async (options) => {
    const value = await config();
    const interval = options.interval === undefined ? value.intervalSeconds : Number(options.interval);
    if (!Number.isFinite(interval) || interval < 1) throw new Error('--interval must be a number of seconds, at least 1.');
    if (!options.dryRun) requireTelegram(value);
    const abort = new AbortController();
    let source, browser, queue;
    const stop = () => {
      process.exitCode = 130;
      abort.abort();
      void queue?.close();
      void (source ? source.close() : browser?.close());
    };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      browser = await connectBrowser(value.endpoint);
      if (abort.signal.aborted) return;
      const tabs = await discoverTabs(browser);
      let candidates = tabs;
      if (options.tab) {
        const index = Number(options.tab);
        if (!Number.isInteger(index) || index < 1 || index > tabs.length) throw new Error('--tab is outside the matching tabs list. Run tabs first.');
        candidates = [tabs[index - 1]];
      }
      if (options.session) candidates = candidates.filter((tab) => tab.code.toUpperCase() === options.session.toUpperCase());
      if (!candidates.length) throw new Error('No matching Wooclap session found inside NTULearn. Open it in your logged-in Chrome tab, then retry.');
      if (program.opts().json && candidates.length > 1) throw new Error('Multiple tabs match. Use --tab or --session with --json.');
      const selected = await choose(candidates, 'Wooclap session');
      source = new BrowserSource(browser, selected, value.endpoint);
      if (!options.dryRun) queue = new DeliveryQueue(new Telegram(value.botToken, value.chatId), { log: emit });
      const monitor = new Monitor(source, queue, { dryRun: options.dryRun, log: emit });
      emit('watching', { title: selected.title, session: selected.code, intervalSeconds: interval, dryRun: Boolean(options.dryRun) });
      await monitor.run({ intervalMs: interval * 1000, signal: abort.signal, once: options.once });
      if (options.once) await queue?.idle();
    } finally {
      await queue?.close();
      if (source) await source.close(); else await browser?.close();
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    }
  });

try { await program.parseAsync(); }
catch (error) {
  emit('error', { message: redact(error.message, tokenToRedact) });
  process.exitCode ||= 1;
}
