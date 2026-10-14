import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export async function acquireBotLock(token, directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${createHash('sha256').update(token).digest('hex')}.lock`);
  const contents = JSON.stringify({ pid: process.pid, instance: randomUUID() });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(path, contents, { flag: 'wx', mode: 0o600 });
      return async () => {
        try { if (await readFile(path, 'utf8') === contents) await unlink(path); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try { previous = await readFile(path, 'utf8'); }
      catch (readError) { if (readError.code === 'ENOENT') continue; throw readError; }
      let pid;
      try { pid = JSON.parse(previous).pid; } catch { /* Refuse unknown locks. */ }
      let alive = true;
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); }
        catch (checkError) { if (checkError.code === 'ESRCH') alive = false; }
      }
      if (alive) throw new Error('Another Telegram receiver owns this bot. Stop its watcher or group listener before starting another.');
      try { if (await readFile(path, 'utf8') === previous) await unlink(path); }
      catch (removeError) { if (removeError.code !== 'ENOENT') throw removeError; }
    }
  }
  throw new Error('Cannot acquire the bot receiver lock. Stop the other watcher or group listener and retry.');
}

export class TelegramReceiver {
  constructor(telegram, { directory, handleUpdate, onFatal = () => {}, log = () => {}, wait = sleep } = {}) {
    this.telegram = telegram; this.directory = directory; this.handleUpdate = handleUpdate;
    this.onFatal = onFatal; this.log = log; this.wait = wait;
    this.abort = new AbortController(); this.offset = 0; this.release = null; this.running = null;
    this.startedAt = Math.floor(Date.now() / 1000);
  }
  async start() {
    this.release = await acquireBotLock(this.telegram.token, this.directory);
    try {
      const webhook = await this.telegram.call('getWebhookInfo', {}, { signal: this.abort.signal });
      if (webhook.url) throw new Error('This bot has an existing webhook. Remote answers cannot start; use another bot or watch --read-only.');
      if (this.abort.signal.aborted) throw new Error('Answer receiver stopped.');
      this.running = this.run().catch((error) => {
        this.log('answer-receiver-stopped', { reason: error.message });
        this.onFatal('Telegram answer receiver stopped. Finish in Chrome.');
      });
    } catch (error) { await this.release?.(); this.release = null; throw error; }
  }
  async run() {
    let failures = 0;
    try {
      while (!this.abort.signal.aborted) {
        try {
          const updates = await this.telegram.call('getUpdates', {
            offset: this.offset, timeout: 20, limit: 100, allowed_updates: ['message', 'callback_query'],
          }, { signal: this.abort.signal, timeoutMs: 35_000 });
          failures = 0;
          for (const update of updates) {
            if (this.abort.signal.aborted) break;
            if (!Number.isInteger(update.update_id) || update.update_id < this.offset) continue;
            this.offset = update.update_id + 1;
            // No old text command may be replayed on a fresh watcher run.
            if (update.message?.date < this.startedAt) continue;
            try { await this.handleUpdate(update); }
            catch (error) { this.log('answer-handler-failed', { reason: error.message }); }
          }
        } catch (error) {
          if (this.abort.signal.aborted) break;
          if (!error.retryable || error.code === 409) {
            const reason = error.code === 409 ? 'Another Telegram poller has taken this bot. Remote answering stopped; finish in Chrome.' : 'Telegram answer receiver stopped. Finish in Chrome.';
            this.log('answer-receiver-stopped', { reason, detail: error.message });
            await this.onFatal(reason); break;
          }
          const delay = Math.max(error.retryAfterMs || 0, Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)));
          this.log('answer-receiver-retry', { delayMs: delay });
          try { await this.wait(delay, undefined, { signal: this.abort.signal }); }
          catch { if (!this.abort.signal.aborted) throw new Error('Answer receiver retry interrupted.'); }
        }
      }
    } finally {
      await this.release?.(); this.release = null;
    }
  }
  async close() {
    this.abort.abort();
    await this.running;
    await this.release?.(); this.release = null;
  }
}
