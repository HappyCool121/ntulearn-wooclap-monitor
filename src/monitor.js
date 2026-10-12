import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppearanceTracker } from './detection.js';
import { questionParts, timestamp } from './telegram.js';

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
  constructor(source, queue, { dryRun = false, log = () => {}, now = () => Date.now() } = {}) {
    this.source = source; this.queue = queue; this.dryRun = dryRun; this.log = log; this.now = now;
    this.tracker = new AppearanceTracker(); this.health = new HealthTracker(); this.runId = randomUUID().slice(0, 8);
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
    if (!appeared) return observation;
    const event = { ...appeared, frame: undefined, visualSnapshot: undefined, detectedAt: new Date(this.now()), alertId: `${this.runId}-${appeared.appearance}` };
    try {
      if (this.source.captureImage) Object.assign(event, await this.source.captureImage(observation));
      else { event.photo = await this.source.screenshot(observation); event.imageSource = 'native'; }
    }
    catch (error) { event.screenshotError = error.message; }
    this.log(this.dryRun ? 'would-alert' : 'question', { alertId: event.alertId, prompt: event.prompt, choices: event.choices, screenshot: Boolean(event.photo), imageSource: event.imageSource, screenshotError: event.screenshotError, nativeError: event.nativeError, link: event.link });
    if (!this.dryRun) this.queue.enqueue(questionParts(event), event.alertId);
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
