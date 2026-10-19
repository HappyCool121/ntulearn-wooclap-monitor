import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireBotLock } from './telegram-receiver.js';

const isGroup = (chat) => ['group', 'supergroup'].includes(chat?.type) && /^-[1-9]\d*$/.test(String(chat.id));
const isPrivate = (chat) => chat?.type === 'private' && /^[1-9]\d*$/.test(String(chat.id));
const isMember = (member) => ['member', 'administrator', 'creator'].includes(member?.status) || (member?.status === 'restricted' && member.is_member);

export function groupStatePath(config) {
  const key = createHash('sha256').update(config.botToken).digest('hex');
  return join(dirname(config.path), `groups-${key}.json`);
}

// Mutations are serialized and committed to memory only after an atomic save.
export class GroupRegistry {
  constructor(path, privateChatId = '') {
    this.path = path; this.privateChatId = /^[1-9]\d*$/.test(String(privateChatId)) ? String(privateChatId) : '';
    this.state = { version: 1, offset: 0, groups: {}, privateChats: {} }; this.writes = Promise.resolve();
  }
  async load() {
    let saved;
    try { saved = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw new Error('Cannot read Telegram group state. Check the local groups JSON file.'); }
    if (saved.version !== 1 || !Number.isSafeInteger(saved.offset) || saved.offset < 0 || !saved.groups || Array.isArray(saved.groups) || typeof saved.groups !== 'object' ||
      Object.entries(saved.groups).some(([id, group]) => !/^-[1-9]\d*$/.test(id) || !group || typeof group.active !== 'boolean' || typeof group.title !== 'string')) {
      throw new Error('Invalid Telegram group state. Check the local groups JSON file.');
    }
    const privateChats = saved.privateChats === undefined ? {} : saved.privateChats;
    if (!privateChats || Array.isArray(privateChats) || typeof privateChats !== 'object' ||
      Object.entries(privateChats).some(([id, active]) => !/^[1-9]\d*$/.test(id) || typeof active !== 'boolean')) {
      throw new Error('Invalid Telegram private subscriber state. Check the local groups JSON file.');
    }
    this.state = { ...saved, privateChats };
  }
  change(update) {
    const operation = this.writes.then(async () => {
      const next = structuredClone(this.state);
      update(next);
      if (JSON.stringify(next) === JSON.stringify(this.state)) return;
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.path);
        this.state = next;
      } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
  set(chat, active) {
    if (!isGroup(chat)) return Promise.resolve();
    return this.change((state) => { state.groups[String(chat.id)] = { title: String(chat.title || ''), active: Boolean(active) }; });
  }
  setPrivate(chat, active) {
    if (!isPrivate(chat)) return Promise.resolve();
    return this.change((state) => { state.privateChats[String(chat.id)] = Boolean(active); });
  }
  migrate(from, to) {
    if (!/^-[1-9]\d*$/.test(String(from)) || !/^-[1-9]\d*$/.test(String(to))) return Promise.resolve();
    return this.change((state) => {
      const previous = state.groups[String(from)];
      state.groups[String(from)] = { title: previous?.title || '', active: false };
      state.groups[String(to)] = { title: previous?.title || '', active: true };
    });
  }
  acknowledge(offset) { return this.change((state) => { state.offset = Math.max(state.offset, offset); }); }
  destinations() {
    const privateIds = Object.keys(this.state.privateChats).filter((id) => this.state.privateChats[id]);
    const configured = this.state.privateChats[this.privateChatId] !== false ? this.privateChatId : '';
    return [...new Set([configured, ...privateIds, ...Object.keys(this.state.groups).filter((id) => this.state.groups[id].active)].filter(Boolean))];
  }
  has(id) { return this.destinations().includes(String(id)); }
}

export class GroupListener {
  constructor(telegram, registry, { queue, configuredChatId = '', log = () => {}, onFatal = () => {}, wait = sleep } = {}) {
    Object.assign(this, { telegram, registry, queue, configuredChatId, log, onFatal, wait });
    this.abort = new AbortController(); this.running = null; this.release = null;
  }
  async start() {
    this.release = await acquireBotLock(this.telegram.token, join(dirname(this.registry.path), 'receiver-locks'));
    try {
      await this.registry.load();
      const webhook = await this.telegram.call('getWebhookInfo', {}, { signal: this.abort.signal });
      if (webhook.url) throw new Error('This bot has an existing webhook. Automatic group registration requires a dedicated bot; the webhook was preserved.');
      this.bot = await this.telegram.getMe(this.abort.signal);
      // Validate saved destinations, including a previously configured group.
      const ids = new Set(Object.keys(this.registry.state.groups).filter((id) => this.registry.state.groups[id].active));
      if (/^-[1-9]\d*$/.test(String(this.configuredChatId)) && !this.registry.state.groups[this.configuredChatId]) {
        const chat = await this.telegram.call('getChat', { chat_id: this.configuredChatId }, { signal: this.abort.signal });
        if (!isGroup(chat)) throw new Error('Telegram destination must be a group or supergroup; channels are not supported.');
        await this.verify(chat);
      }
      for (const id of ids) await this.verify({ id, type: 'supergroup', title: this.registry.state.groups[id]?.title || '' });
      // Process pending joins/removals before the watcher snapshots recipients.
      await this.poll(0);
      this.log('groups-listening', { destinations: this.registry.destinations(), statePath: this.registry.path });
    } catch (error) { await this.release?.(); this.release = null; throw error; }
  }
  run() {
    if (this.running) return this.running;
    this.running = this.loop().catch(async (error) => {
      this.log('groups-listener-stopped', { reason: error.message });
      await this.onFatal(error);
    }).finally(async () => { await this.release?.(); this.release = null; });
    return this.running;
  }
  async verify(chat) {
    try {
      const member = await this.telegram.call('getChatMember', { chat_id: chat.id, user_id: this.bot.id }, { signal: this.abort.signal });
      await this.registry.set(chat, isMember(member));
      return isMember(member);
    } catch (error) {
      if (error.migrateToChatId) { await this.registry.migrate(chat.id, error.migrateToChatId); return false; }
      if ([400, 403].includes(error.code)) { await this.registry.set(chat, false); return false; }
      throw error;
    }
  }
  async handle(update) {
    const membership = update.my_chat_member;
    if (membership && isPrivate(membership.chat)) {
      if (membership.new_chat_member?.user?.id !== this.bot.id) return;
      // Unblocking alone is not consent to resume alerts: require /start.
      if (['kicked', 'left'].includes(membership.new_chat_member.status)) {
        await this.registry.setPrivate(membership.chat, false);
        this.log('private-unsubscribed', { chatId: String(membership.chat.id), reason: 'Bot blocked or removed.' });
      }
      return;
    }
    if (membership && isGroup(membership.chat)) {
      if (membership.new_chat_member?.user?.id !== this.bot.id) return;
      const active = Boolean(isMember(membership.new_chat_member));
      const wasActive = this.registry.has(membership.chat.id);
      await this.registry.set(membership.chat, active);
      this.log(active ? 'group-registered' : 'group-removed', { chatId: String(membership.chat.id), title: membership.chat.title });
      if (active && !wasActive) this.welcome(membership.chat.id);
      return;
    }
    const message = update.message;
    if (isPrivate(message?.chat)) {
      const command = /^\/(start|stop)(?:@([A-Za-z0-9_]+))?(?:\s|$)/i.exec(message.text || '');
      if (!command || (command[2] && command[2].toLowerCase() !== this.bot.username.toLowerCase())) return;
      const active = command[1].toLowerCase() === 'start';
      await this.registry.setPrivate(message.chat, active);
      this.log(active ? 'private-subscribed' : 'private-unsubscribed', { chatId: String(message.chat.id) });
      const text = active
        ? 'You are subscribed to Wooclap alerts. You will receive future questions from the session being monitored while the watcher is running. Send /stop to unsubscribe.'
        : 'You are unsubscribed from Wooclap alerts. Send /start to subscribe again.';
      this.queue?.enqueue([{ method: 'sendMessage', params: { chat_id: String(message.chat.id), text } }], `private-${active ? 'start' : 'stop'}-${message.chat.id}`, { requireDestination: false });
      return;
    }
    if (!isGroup(message?.chat)) return;
    if (message.migrate_to_chat_id) { await this.registry.migrate(message.chat.id, message.migrate_to_chat_id); return; }
    if (message.migrate_from_chat_id) { await this.registry.migrate(message.migrate_from_chat_id, message.chat.id); return; }
    // Privacy mode permits an addressed /start; verify the bot still belongs
    // before recovering an expired join update or replaying an offline command.
    const command = /^\/start(?:@([A-Za-z0-9_]+))?(?:\s|$)/i.exec(message.text || '');
    if (!command || (command[1] && command[1].toLowerCase() !== this.bot.username.toLowerCase())) return;
    const wasActive = this.registry.has(message.chat.id);
    if (await this.verify(message.chat) && !wasActive) this.welcome(message.chat.id);
  }
  welcome(id) {
    this.queue?.enqueue([{ method: 'sendMessage', params: { chat_id: String(id), text: 'Wooclap alerts are connected to this group. You will receive new questions from the session being monitored while the watcher is running. Remove the bot to stop group alerts.' } }], `group-welcome-${id}`);
  }
  async poll(timeout) {
    let updates;
    do {
      updates = await this.telegram.call('getUpdates', { offset: this.registry.state.offset, timeout, limit: 100, allowed_updates: ['message', 'my_chat_member'] }, { signal: this.abort.signal, timeoutMs: 35_000 });
      for (const update of updates) {
        if (this.abort.signal.aborted) return;
        if (!Number.isSafeInteger(update.update_id) || update.update_id < this.registry.state.offset) continue;
        await this.handle(update);
        // Never acknowledge an update before its membership change is saved.
        await this.registry.acknowledge(update.update_id + 1);
      }
    } while (timeout === 0 && updates.length === 100 && !this.abort.signal.aborted);
  }
  async loop() {
    let failures = 0;
    while (!this.abort.signal.aborted) {
      try { await this.poll(20); failures = 0; }
      catch (error) {
        if (this.abort.signal.aborted) return;
        if (!error.retryable || error.code === 409) throw error;
        const delayMs = Math.max(error.retryAfterMs || 0, Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)));
        this.log('groups-listener-retry', { delayMs });
        await this.wait(delayMs, undefined, { signal: this.abort.signal }).catch((error) => { if (!this.abort.signal.aborted) throw error; });
      }
    }
  }
  async deliveryFailure(error, id) {
    if (/^[1-9]\d*$/.test(String(id))) {
      if (error.code === 403) {
        await this.registry.setPrivate({ id, type: 'private' }, false);
        this.log('private-unsubscribed', { chatId: String(id), reason: 'Telegram denied delivery.' });
      }
      return;
    }
    if (!String(id).startsWith('-')) return;
    if (error.migrateToChatId) {
      await this.registry.migrate(id, error.migrateToChatId);
      this.log('group-migrated', { from: String(id), to: error.migrateToChatId });
      return error.migrateToChatId;
    }
    if (error.code === 403) {
      await this.registry.set({ id, type: 'supergroup', title: this.registry.state.groups[id]?.title || '' }, false);
      this.log('group-removed', { chatId: String(id), reason: 'Telegram denied delivery.' });
    }
  }
  async close() {
    this.abort.abort();
    await this.running;
    await this.registry.writes;
    await this.release?.(); this.release = null;
  }
}
