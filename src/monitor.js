import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppearanceTracker } from './detection.js';
import { questionParts, suggestionEdit, timestamp } from './telegram.js';

export class HealthTracker {
  constructor(thresholdMs = 60_000) { this.thresholdMs = thresholdMs; this.since = null; this.reported = false; }
  observe(healthy, now = Date.now()) {
    if (healthy) {
      const recovered = this.reported;
      this.since = null; this.reported = false;
      return recovered ? 'recovered' : null;
    }
    this.since ??= now;
    if (!this.reported && now - this.since >= this.thresholdMs) { this.reported = true; return 'lost'; }
    return null;
  }
}

export class Monitor {
  constructor(source, queue, { dryRun = false, answers = null, suggestions = null, log = () => {}, now = () => Date.now() } = {}) {
    this.source = source; this.queue = queue; this.dryRun = dryRun; this.log = log; this.now = now;
    this.tracker = new AppearanceTracker(); this.health = new HealthTracker(); this.runId = randomUUID().slice(0, 8);
    this.answers = answers;
    this.suggestions = suggestions;
  }
  async tick() {
    let observation;
    try { observation = await this.source.read(); }
    catch (error) { observation = { state: 'unavailable', reason: error.message }; }
    this.log('check', { state: observation.state, reason: observation.reason, session: observation.session });
    const change = this.health.observe(['active', 'waiting', 'results'].includes(observation.state), this.now());
    if (change) {
      const text = change === 'lost' ? 'Wooclap monitoring has been unavailable for at least 60 seconds. Check Chrome and your NTULearn login.' : 'Wooclap monitoring has recovered.';
      this.log(`monitoring-${change}`, {});
      if (!this.dryRun) this.queue.enqueue([{ method: 'sendMessage', params: { text: `${text}\n${timestamp(new Date(this.now()))}` } }], `health-${change}`);
    }
    const appeared = this.tracker.observe(observation);
    this.answers?.observe(observation);
    if (!appeared) return observation;
    const event = { ...appeared, frame: undefined, visualSnapshot: undefined, answerState: undefined, detectedAt: new Date(this.now()), alertId: `${this.runId}-${appeared.appearance}` };
    const binding = !this.dryRun ? this.answers?.prepare(event, observation) : null;
    try {
      if (this.source.captureImage) Object.assign(event, await this.source.captureImage(observation));
      else { event.photo = await this.source.screenshot(observation); event.imageSource = 'native'; }
    }
    catch (error) { event.screenshotError = error.message; }
    this.log(this.dryRun ? 'would-alert' : 'question', { alertId: event.alertId, prompt: event.prompt, choices: event.choices, screenshot: Boolean(event.photo), imageSource: event.imageSource, screenshotError: event.screenshotError, nativeError: event.nativeError, link: event.link });
    if (!this.dryRun) {
      // Keep the original question even if the live page changes during delivery/generation.
      const question = Object.freeze({ prompt: String(event.prompt || ''), choices: Object.freeze([...(event.choices || [])]), photo: event.photo ? Buffer.from(event.photo) : undefined });
      const parts = questionParts(event, { suggestions: Boolean(this.suggestions) });
      const deliveries = new Map();
      let generating = false, completed = false, result;
      const edit = (job) => this.queue.enqueue([suggestionEdit(job, result)], `suggestion-${job.alertId}`);
      this.queue.enqueue(this.answers ? this.answers.decorate(parts, binding) : parts, event.alertId, {
        onSent: (receipt, part) => {
          this.answers?.receipt(binding, receipt);
          if (!this.suggestions || !receipt?.message_id) return;
          const chatId = part.params.chat_id ?? receipt.chat?.id ?? this.queue.telegram?.chatId;
          const key = `${chatId}:${receipt.message_id}`;
          if (deliveries.has(key)) return;
          const job = Object.freeze({ ...question, alertId: event.alertId, chatId, messageId: receipt.message_id, deliveryType: part.method, base: part.suggestionBase });
          deliveries.set(key, job);
          if (completed) { edit(job); return; }
          if (generating) return;
          generating = true;
          this.suggestions.enqueue(job, (suggestion) => {
            result = suggestion; completed = true;
            for (const delivered of deliveries.values()) edit(delivered);
          });
        },
      });
    }
    return observation;
  }
  async run({ intervalMs = 10_000, signal, once = false, wait = sleep } = {}) {
    do {
      if (signal?.aborted) break;
      const started = this.now();
      await this.tick();
      if (once || signal?.aborted) break;
      // No overlapping reads and no burst of catch-up polls after wake/network delay.
      const delay = Math.max(0, intervalMs - (this.now() - started));
      try { await wait(delay, undefined, { signal }); }
      catch (error) { if (!signal?.aborted) throw error; }
    } while (!signal?.aborted);
  }
}
