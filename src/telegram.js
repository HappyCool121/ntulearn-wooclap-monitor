import { setTimeout as sleep } from 'node:timers/promises';
import { redact } from './config.js';
import { SUGGESTION_MODEL, REPOSITORY_URL, SUGGESTION_DISCLAIMER } from './constants.js';

export function requireDestinationChat(chat) {
  if (!['private', 'group', 'supergroup'].includes(chat?.type)) throw new Error('Telegram destination must be a private chat, group, or supergroup; channels are not supported.');
}

export class TelegramError extends Error {
  constructor(message, { retryable = false, retryAfterMs = 0, code, migrateToChatId } = {}) {
    super(message); this.retryable = retryable; this.retryAfterMs = retryAfterMs; this.code = code; this.migrateToChatId = migrateToChatId;
  }
}

export class Telegram {
  constructor(token, chatId, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
    this.token = token; this.chatId = chatId; this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
  }
  async call(method, params = {}, { photo, signal, timeoutMs = this.timeoutMs } = {}) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let body;
    let headers;
    if (photo) {
      body = new FormData();
      for (const [name, value] of Object.entries(params)) body.append(name, typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value));
      body.append('photo', new Blob([photo], { type: 'image/jpeg' }), 'question.jpg');
    } else {
      body = JSON.stringify(params); headers = { 'content-type': 'application/json' };
    }
    let response;
    try { response = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, { method: 'POST', headers, body, signal: combined }); }
    catch {
      if (signal?.aborted) throw new TelegramError('Telegram delivery cancelled.');
      throw new TelegramError('Telegram network request failed or timed out.', { retryable: true });
    }
    let data;
    try { data = await response.json(); }
    catch { throw new TelegramError('Telegram returned an invalid response.', { retryable: response.status >= 500 }); }
    if (!response.ok || !data.ok) {
      const code = data.error_code || response.status;
      if (code === 400 && /^editMessage/.test(method) && /message is not modified/i.test(data.description || '')) return true;
      if (data.parameters?.migrate_to_chat_id) throw new TelegramError(`Telegram group migrated to ${data.parameters.migrate_to_chat_id}. Rerun setup with --chat ${data.parameters.migrate_to_chat_id}, then restart the watcher.`, { code, migrateToChatId: String(data.parameters.migrate_to_chat_id) });
      const retryAfterMs = Math.max(0, Number(data.parameters?.retry_after) || 0) * 1000;
      throw new TelegramError(redact(`Telegram ${method} failed (${code}): ${data.description || 'Request rejected'}`, this.token), { retryable: code === 429 || code >= 500, retryAfterMs, code });
    }
    return data.result;
  }
  getMe(signal) { return this.call('getMe', {}, { signal }); }
  async destinationChats(signal) {
    const webhook = await this.call('getWebhookInfo', {}, { signal });
    if (webhook.url) throw new Error('This bot has an existing webhook. Use a separate bot for this monitor; setup will not remove another service’s webhook.');
    const updates = await this.call('getUpdates', { limit: 100, timeout: 0, allowed_updates: ['message', 'my_chat_member'] }, { signal });
    const chats = new Map();
    for (const update of updates) {
      const membership = update.my_chat_member;
      const chat = membership?.chat || update.message?.chat;
      if (!['private', 'group', 'supergroup'].includes(chat?.type)) continue;
      const status = membership?.new_chat_member;
      if (status && !['member', 'administrator', 'creator'].includes(status.status) && !(status.status === 'restricted' && status.is_member)) { chats.delete(String(chat.id)); continue; }
      const name = chat.type === 'private' ? chat.first_name || 'Private chat' : chat.title || 'Group';
      chats.set(String(chat.id), { id: String(chat.id), type: chat.type, label: `${name}${chat.username ? ` (@${chat.username})` : ''} · ${chat.type} [${chat.id}]` });
    }
    return [...chats.values()];
  }
  async privateChats(signal) { return (await this.destinationChats(signal)).filter((chat) => chat.type === 'private'); }
}

export function splitText(text, limit = 4000) {
  const chunks = [];
  while (text.length > limit) {
    let cut = text.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit;
    if (/^[\uDC00-\uDFFF]$/.test(text[cut])) cut--;
    chunks.push(text.slice(0, cut)); text = text.slice(cut).replace(/^\n/, '');
  }
  if (text) chunks.push(text);
  return chunks;
}

export function timestamp(date = new Date()) {
  return new Intl.DateTimeFormat('en-SG', { timeZone: 'Asia/Singapore', dateStyle: 'medium', timeStyle: 'medium' }).format(date) + ' SGT';
}

export function truncateText(text, limit) {
  if (text.length <= limit) return text;
  if (limit <= 0) return '';
  let cut = limit - 1;
  if (/^[\uDC00-\uDFFF]$/.test(text[cut])) cut--;
  return text.slice(0, cut) + '…';
}

export function suggestionText(base, suggestion, limit) {
  const prefix = `${base}\n\nSuggested answer${suggestion ? ': ' : ' unavailable.'}`;
  const footer = `\n\nModel: ${SUGGESTION_MODEL}\n${SUGGESTION_DISCLAIMER}\nSource: ${REPOSITORY_URL}`;
  return prefix + (suggestion ? truncateText(suggestion, limit - prefix.length - footer.length) : '') + footer;
}

export function suggestionEdit(job, suggestion) {
  const photo = job.deliveryType === 'sendPhoto';
  return { method: photo ? 'editMessageCaption' : 'editMessageText', params: {
    ...(job.chatId ? { chat_id: job.chatId } : {}),
    message_id: job.messageId,
    [photo ? 'caption' : 'text']: suggestionText(job.base, suggestion, photo ? 1024 : 4096),
    ...(!photo ? { link_preview_options: { is_disabled: true } } : {}),
  } };
}

export function questionParts(event, { suggestions = false } = {}) {
  const short = (value, max) => {
    const text = String(value || '');
    if (text.length <= max) return text;
    let cut = max - 1;
    if (/^[\uDC00-\uDFFF]$/.test(text[cut])) cut--;
    return text.slice(0, cut) + '…';
  };
  const header = `🔔 New Wooclap question\n${short(event.title, 200)}\n${timestamp(event.detectedAt)} · ${short(event.session, 40)}\n${short(event.link, 400)}`;
  const notice = { method: 'sendMessage', params: { text: `${header}\n\nQuestion image unavailable — open Wooclap.`, link_preview_options: { is_disabled: true } } };
  const decorate = (part) => {
    const key = part.method === 'sendPhoto' ? 'caption' : 'text';
    if (suggestions) {
      part.suggestionBase = part.params[key];
      part.params[key] = suggestionText(part.suggestionBase, 'generating…', key === 'caption' ? 1024 : 4096);
    } else part.params[key] += `\n\nSource: ${REPOSITORY_URL}`;
    return part;
  };
  decorate(notice);
  if (!event.photo) return [notice];
  return [decorate({ method: 'sendPhoto', params: { caption: `${header}${event.imageSource === 'recreated' ? '\n\nRecreated question card' : ''}` }, photo: event.photo, fallback: notice })];
}

// Serial delivery resumes at the first unconfirmed part after a failure.
// Polling enqueues work without awaiting this worker.
export class DeliveryQueue {
  constructor(telegram, { log = () => {}, wait = sleep, maxAttempts = 5, maxPending = 100,
    destinations = null, isDestination = null, onFailure = null } = {}) {
    this.telegram = telegram; this.log = log; this.wait = wait;
    this.maxAttempts = maxAttempts; this.maxPending = maxPending;
    this.destinations = destinations; this.isDestination = isDestination; this.onFailure = onFailure;
    this.items = []; this.running = null; this.stopped = false;
    this.abort = new AbortController();
  }
  enqueue(parts, label, { onSent, requireDestination = true } = {}) {
    if (this.stopped) return false;
    if (this.destinations && parts.every((part) => part.params.chat_id === undefined)) {
      let accepted = false;
      const bind = (part, id) => ({ ...part, params: { ...part.params, chat_id: id }, ...(part.fallback ? { fallback: bind(part.fallback, id) } : {}) });
      for (const id of new Set(this.destinations().map(String))) {
        accepted = this.enqueue(parts.map((part) => bind(part, id)), `${label}@${id}`, { onSent, requireDestination }) || accepted;
      }
      return accepted;
    }
    if (this.items.length >= this.maxPending) { this.log('delivery-failed', { label, reason: 'Delivery queue full; alert not queued.' }); return false; }
    this.items.push({ parts, label, onSent, requireDestination });
    this.kick(); return true;
  }
  kick() {
    if (this.running || this.stopped) return;
    this.running = this.drain().finally(() => {
      this.running = null;
      if (this.items.length && !this.stopped) this.kick();
    });
  }
  async drain() {
    while (this.items.length && !this.stopped) {
      const item = this.items[0];
      let failed = false;
      for (let part of item.parts) {
        let sent = false;
        for (let attempt = 1; attempt <= this.maxAttempts && !this.stopped; attempt++) {
          const chatId = String(part.params.chat_id ?? this.telegram.chatId);
          if (item.requireDestination && this.isDestination && !this.isDestination(chatId)) {
            this.log('delivery-skipped', { label: item.label, chatId, reason: 'Destination is no longer registered.' });
            break;
          }
          try {
            const receipt = await this.telegram.call(part.method, { chat_id: this.telegram.chatId, ...part.params }, { photo: part.photo, signal: this.abort.signal });
            sent = true;
            // Receipt bookkeeping failures must never resend an acknowledged photo.
            try { await item.onSent?.(receipt, part); }
            catch (error) { this.log('receipt-handler-failed', { label: item.label, reason: error.message }); }
            break;
          } catch (error) {
            if (this.stopped) break;
            let migrated;
            try { migrated = await this.onFailure?.(error, chatId); }
            catch (failure) { this.log('destination-update-failed', { label: item.label, reason: failure.message }); }
            if (migrated && /^send/.test(part.method) && attempt < this.maxAttempts) {
              const bind = (value) => ({ ...value, params: { ...value.params, chat_id: migrated }, ...(value.fallback ? { fallback: bind(value.fallback) } : {}) });
              part = bind(part); continue;
            }
            if (part.fallback && error.code === 400 && !error.migrateToChatId) {
              this.log('photo-fallback', { label: item.label });
              part = part.fallback; attempt = 0; continue;
            }
            if (!error.retryable || attempt === this.maxAttempts) {
              this.log('delivery-failed', { label: item.label, part: part.method, reason: error.message }); break;
            }
            const delay = Math.max(error.retryAfterMs || 0, Math.min(30_000, 1000 * 2 ** (attempt - 1)));
            this.log('delivery-retry', { label: item.label, attempt, delayMs: delay });
            try { await this.wait(delay, undefined, { signal: this.abort.signal }); } catch { break; }
          }
        }
        if (!sent) { failed = true; break; }
      }
      if (!failed && !this.stopped) this.log('delivered', { label: item.label });
      this.items.shift();
    }
  }
  async idle() { while (this.running) await this.running; }
  async close() {
    this.stopped = true; this.abort.abort(); this.items.length = 0;
    await this.idle();
  }
}
