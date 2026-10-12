import { setTimeout as sleep } from 'node:timers/promises';
import { redact } from './config.js';

export class TelegramError extends Error {
  constructor(message, { retryable = false, retryAfterMs = 0, code } = {}) {
    super(message); this.retryable = retryable; this.retryAfterMs = retryAfterMs; this.code = code;
  }
}

export class Telegram {
  constructor(token, chatId, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
    this.token = token; this.chatId = chatId; this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
  }
  async call(method, params = {}, { photo, signal } = {}) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let body;
    let headers;
    if (photo) {
      body = new FormData();
      for (const [name, value] of Object.entries(params)) body.append(name, String(value));
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
      const retryAfterMs = Math.max(0, Number(data.parameters?.retry_after) || 0) * 1000;
      throw new TelegramError(redact(`Telegram ${method} failed (${code}): ${data.description || 'Request rejected'}`, this.token), { retryable: code === 429 || code >= 500, retryAfterMs, code });
    }
    return data.result;
  }
  getMe(signal) { return this.call('getMe', {}, { signal }); }
  async privateChats(signal) {
    const webhook = await this.call('getWebhookInfo', {}, { signal });
    if (webhook.url) throw new Error('This bot has an existing webhook. Use a separate bot for this monitor; setup will not remove another service’s webhook.');
    const updates = await this.call('getUpdates', { limit: 100, timeout: 0, allowed_updates: ['message'] }, { signal });
    const chats = new Map();
    for (const update of updates) {
      const chat = update.message?.chat;
      if (chat?.type === 'private') chats.set(String(chat.id), { id: String(chat.id), label: `${chat.first_name || 'Private chat'}${chat.username ? ` (@${chat.username})` : ''} [${chat.id}]` });
    }
    return [...chats.values()];
  }
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

export function questionParts(event) {
  const short = (value, max) => {
    const text = String(value || '');
    if (text.length <= max) return text;
    let cut = max - 1;
    if (/^[\uDC00-\uDFFF]$/.test(text[cut])) cut--;
    return text.slice(0, cut) + '…';
  };
  const header = `🔔 New Wooclap question\n${short(event.title, 200)}\n${timestamp(event.detectedAt)} · ${short(event.session, 40)}\n${short(event.link, 400)}`;
  const notice = { method: 'sendMessage', params: { text: `${header}\n\nQuestion image unavailable — open Wooclap.`, link_preview_options: { is_disabled: true } } };
  if (!event.photo) return [notice];
  return [{ method: 'sendPhoto', params: { caption: `${header}${event.imageSource === 'recreated' ? '\n\nRecreated question card' : ''}` }, photo: event.photo, fallback: notice }];
}

// Serial delivery resumes at the first unconfirmed part after a failure.
// Polling enqueues work without awaiting this worker.
export class DeliveryQueue {
  constructor(telegram, { log = () => {}, wait = sleep, maxAttempts = 5, maxPending = 100 } = {}) {
    this.telegram = telegram; this.log = log; this.wait = wait;
    this.maxAttempts = maxAttempts; this.maxPending = maxPending;
    this.items = []; this.running = null; this.stopped = false;
    this.abort = new AbortController();
  }
  enqueue(parts, label) {
    if (this.stopped) return false;
    if (this.items.length >= this.maxPending) { this.log('delivery-failed', { label, reason: 'Delivery queue full; alert not queued.' }); return false; }
    this.items.push({ parts, label });
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
          try {
            await this.telegram.call(part.method, { chat_id: this.telegram.chatId, ...part.params }, { photo: part.photo, signal: this.abort.signal });
            sent = true; break;
          } catch (error) {
            if (this.stopped) break;
            if (part.fallback && error.code === 400) {
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
