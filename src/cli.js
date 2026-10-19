#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig, saveConfig, requireTelegram, redact } from './config.js';
import { ask, choose, hiddenToken } from './prompt.js';
import { connectBrowser, discoverTabs, publicTab, BrowserSource, CHROME_SETUP } from './browser.js';
import { Telegram, DeliveryQueue, timestamp, requireDestinationChat } from './telegram.js';
import { Monitor } from './monitor.js';
import { CodexSuggestions } from './codex-suggestions.js';
import { GroupRegistry, GroupListener, groupStatePath } from './groups.js';
import { acquireBotLock } from './telegram-receiver.js';
import { dirname, join } from 'node:path';

const program = new Command();
program.name('ntulearn-watch').description('Monitor Wooclap with Telegram image alerts and Luna answer suggestions.').version('1.0.0')
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

function groupDelivery(value, onFatal) {
  const telegram = new Telegram(value.botToken, value.chatId);
  const registry = new GroupRegistry(groupStatePath(value), value.chatId);
  let listener;
  const queue = new DeliveryQueue(telegram, {
    log: emit, destinations: () => registry.destinations(), isDestination: (id) => registry.has(id),
    onFailure: (error, id) => listener.deliveryFailure(error, id),
  });
  listener = new GroupListener(telegram, registry, { queue, configuredChatId: value.chatId, log: emit, onFatal });
  return { queue, listener };
}

async function withBrowser(action) {
  const value = await config();
  const browser = await connectBrowser(value.endpoint);
  try { return await action(browser, value); }
  finally { await browser.close(); }
}

program.command('setup').description('Configure a Telegram private chat or group and send a test alert')
  .option('--select-chat', 'Choose a destination again, replacing the saved chat')
  .option('--chat <id>', 'Use an explicit numeric private/group chat ID')
  .action(async (options) => {
    if (program.opts().json) throw new Error('setup is interactive; omit --json.');
    const value = await config();
    console.log('1. Open https://t.me/BotFather and send /newbot. Choose a name and a username ending in bot.');
    console.log('2. Send /start in your bot’s private chat, or add it to a group and send /start@YourBotUsername. Keep the token private.');
    value.botToken ||= await hiddenToken();
    tokenToRedact = value.botToken;
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(value.botToken)) throw new Error('Invalid Telegram bot token format.');
    const telegram = new Telegram(value.botToken, value.chatId);
    const me = await telegram.getMe();
    console.log(`Connected to @${me.username}.`);
    if (options.chat !== undefined) value.chatId = options.chat;
    if (options.selectChat && options.chat !== undefined) throw new Error('Use either --select-chat or --chat, not both.');
    if (!value.chatId || options.selectChat) {
      const release = await acquireBotLock(value.botToken, join(dirname(value.path), 'receiver-locks'));
      try {
        let chats = await telegram.destinationChats();
        if (!chats.length) {
          await ask(`Send /start privately or /start@${me.username} in your group, then press Enter here: `);
          chats = await telegram.destinationChats();
        }
        if (!chats.length) throw new Error('No Telegram destinations found. Use setup --chat <id> if your chat is outside the pending updates.');
        const selected = await choose(chats, 'Telegram destination');
        value.chatId = selected.id;
      } finally {
        await release();
      }
    }
    requireTelegram(value);
    const chat = await telegram.call('getChat', { chat_id: value.chatId });
    requireDestinationChat(chat);
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
          requireDestinationChat(chat);
          result.telegram = { ok: true, bot: me.username, chatType: chat.type };
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

program.command('listen-groups').description('Register groups and private /start or /stop subscriptions without Chrome; stop with Ctrl+C')
  .action(async () => {
    const value = await config(); requireTelegram(value);
    let listener, queue;
    const stop = () => { process.exitCode = 130; void listener?.close(); void queue?.close(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      ({ listener, queue } = groupDelivery(value, (error) => { emit('error', { message: error.message }); process.exitCode = 1; }));
      await listener.start();
      await listener.run();
    } finally {
      await listener?.close(); await queue?.close();
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    }
  });

program.command('watch').description('Poll the selected session every 10 seconds; stop with Ctrl+C')
  .option('--read-only', 'Compatibility flag; Telegram answer submission is currently disabled')
  .option('--suggestions', 'Append optional Luna answer suggestions (uses Codex inference)', false)
  .option('--no-suggestions', 'Send basic alerts without invoking Codex')
  .option('--no-auto-groups', 'Send only to the configured destination without group or private subscription handling')
  .option('--dry-run', 'Inspect questions and screenshot capture without invoking Telegram or Codex')
  .option('--once', 'Perform one check, finish delivery, suggestions and edits, then stop')
  .option('--session <code>', 'Select a Wooclap event code from tabs output')
  .option('--tab <number>', 'Select a 1-based matching tab index from tabs output')
  .option('--interval <seconds>', 'Override polling interval, at least 1 second')
  .action(async (options) => {
    const value = await config();
    const interval = options.interval === undefined ? value.intervalSeconds : Number(options.interval);
    if (!Number.isFinite(interval) || interval < 1) throw new Error('--interval must be a number of seconds, at least 1.');
    if (!options.dryRun) requireTelegram(value);
    const abort = new AbortController();
    let source, browser, queue, suggestions, listener;
    const stop = () => {
      process.exitCode = 130;
      abort.abort();
      void listener?.close();
      void suggestions?.close();
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
      if (!options.dryRun) {
        if (options.autoGroups) {
          ({ listener, queue } = groupDelivery(value, (error) => {
            emit('error', { message: `Automatic destination registration stopped: ${error.message}` });
            stop(); process.exitCode = 1;
          }));
          await listener.start();
          if (!options.once) void listener.run();
        } else queue = new DeliveryQueue(new Telegram(value.botToken, value.chatId), { log: emit });
        if (options.suggestions) suggestions = new CodexSuggestions({ log: emit });
      }
      if (abort.signal.aborted) return;
      const monitor = new Monitor(source, queue, { dryRun: options.dryRun, suggestions, log: emit });
      emit('watching', { title: selected.title, session: selected.code, intervalSeconds: interval, dryRun: Boolean(options.dryRun), remoteAnswers: false, suggestions: Boolean(suggestions), automaticGroups: Boolean(listener) });
      await monitor.run({ intervalMs: interval * 1000, signal: abort.signal, once: options.once });
      if (options.once) {
        await queue?.idle();
        await suggestions?.idle();
        await queue?.idle();
      }
    } finally {
      await listener?.close();
      await suggestions?.close();
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
