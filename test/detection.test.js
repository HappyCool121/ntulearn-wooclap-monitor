import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyObservation, AppearanceTracker } from '../src/detection.js';
import { HealthTracker, Monitor } from '../src/monitor.js';

const active = (extra = {}) => ({ text: 'What is 2 + 2?\n3\n4\n5\nSubmit', panelText: 'What is 2 + 2?', headings: ['What is 2 + 2?'], choices: ['3', '4', '5'], images: [], statuses: [], hasResponseControls: true, ...extra });
const observe = (extra) => classifyObservation(active(extra));

test('live English waiting messages are not questions', () => {
  assert.equal(classifyObservation({ text: 'There is no vote in progress at the moment. Please pay attention to the presenter.\nYou will be notified when a vote is started.\nOpen reactions', statuses: ['There is no vote in progress at the moment. Please pay attention to the presenter.'] }).state, 'waiting');
});
test('positive question plus response controls', () => assert.equal(observe().state, 'active'));
test('absence of waiting text does not count as active', () => assert.equal(classifyObservation({ text: 'Wooclap\nHelp\nOpen reactions' }).state, 'unavailable'));
test('heading without controls does not count as active', () => assert.equal(observe({ hasResponseControls: false }).state, 'unavailable'));
test('explicit active marker supports question without standard controls', () => assert.equal(observe({ hasResponseControls: false, explicitActive: true }).state, 'active'));
test('loading, connection loss, expiry, and results are separate states', () => {
  for (const [extra, state] of [[{ loading: true }, 'loading'], [{ text: 'Connection lost' }, 'unavailable'], [{ text: 'Session expired' }, 'unavailable'], [{ results: true }, 'results'], [{ text: 'Your answer has been sent' }, 'results']]) {
    assert.equal(observe(extra).state, state);
  }
});
test('image question remains active without prompt text', () => {
  const result = observe({ headings: [], hasQuestionPanel: true, panelText: '', images: [{ src: 'https://example.com/formula.png?signature=abc', alt: '', kind: 'img' }] });
  assert.equal(result.state, 'active'); assert.match(result.prompt, /Image question/);
});
test('content fingerprint ignores standalone timers and response counts', () => {
  const first = observe({ headings: ['What is 2 + 2?', 'Time remaining: 30', '2 responses'] });
  const second = observe({ headings: ['What is 2 + 2?', 'Time remaining: 20', '8 responses'] });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.notEqual(first.fingerprint, observe({ headings: ['What is 3 + 3?'] }).fingerprint);
});
test('image signed URLs do not change question identity', () => {
  const one = observe({ images: [{ src: 'https://example.com/image.png?sig=1', kind: 'img' }] });
  const two = observe({ images: [{ src: 'https://example.com/image.png?sig=2', kind: 'img' }] });
  assert.equal(one.fingerprint, two.fingerprint);
});
test('stable visible question IDs take precedence', () => assert.equal(observe({ questionId: 'q1' }).fingerprint, 'id:q1'));
test('active at startup and consecutive questions alert once each', () => {
  const tracker = new AppearanceTracker();
  const first = observe(); const second = observe({ questionId: 'q2' });
  assert.equal(tracker.observe(first).appearance, 1);
  assert.equal(tracker.observe(first), null);
  assert.equal(tracker.observe(second).appearance, 2);
});
test('waiting or results rearm, transient loading/unavailability do not', () => {
  const tracker = new AppearanceTracker(); const question = observe();
  tracker.observe(question);
  for (const state of ['loading', 'unavailable']) { tracker.observe({ state }); assert.equal(tracker.observe(question), null); }
  tracker.observe({ state: 'waiting' }); assert.equal(tracker.observe(question).appearance, 2);
  tracker.observe({ state: 'results' }); assert.equal(tracker.observe(question).appearance, 3);
});
test('health outage and recovery report only once after 60 seconds', () => {
  const health = new HealthTracker();
  assert.equal(health.observe(false, 0), null);
  assert.equal(health.observe(false, 59_999), null);
  assert.equal(health.observe(false, 60_000), 'lost');
  assert.equal(health.observe(false, 80_000), null);
  assert.equal(health.observe(true, 90_000), 'recovered');
  assert.equal(health.observe(true, 100_000), null);
});
test('monitor enqueues without awaiting delivery and does not duplicate after a read failure', async () => {
  let count = 0;
  const alerts = [];
  const question = { ...observe(), title: 'Lecture', session: 'ABCDEF', link: 'https://app.wooclap.com/ABCDEF' };
  const source = { read: async () => { if (++count === 2) throw new Error('frame detached'); return question; }, screenshot: async () => Buffer.from('photo') };
  const monitor = new Monitor(source, { enqueue: (parts) => alerts.push(parts) });
  await monitor.tick(); await monitor.tick(); await monitor.tick();
  assert.equal(alerts.length, 1);
});
test('dry run captures but never queues Telegram calls', async () => {
  const logs = []; let screenshots = 0;
  const source = { read: async () => ({ ...observe(), title: 'Lecture', session: 'ABCDEF', link: 'https://app.wooclap.com/ABCDEF' }), screenshot: async () => { screenshots++; return Buffer.from('photo'); } };
  const monitor = new Monitor(source, { enqueue: () => assert.fail('Telegram called during dry run') }, { dryRun: true, log: (event) => logs.push(event) });
  await monitor.tick(); assert.equal(screenshots, 1); assert.ok(logs.includes('would-alert'));
});
test('capture failure preserves a text alert', async () => {
  const alerts = [];
  const source = { read: async () => ({ ...observe(), title: 'Lecture', session: 'ABCDEF', link: 'https://app.wooclap.com/ABCDEF' }), screenshot: async () => { throw new Error('frame detached'); } };
  await new Monitor(source, { enqueue: (parts) => alerts.push(parts) }).tick();
  assert.equal(alerts[0][0].method, 'sendMessage');
  assert.match(alerts[0][0].params.text, /Question image unavailable/);
  assert.doesNotMatch(alerts[0][0].params.text, /frame detached/);
});
test('poll interval accounts for check time and abort stops the loop', async () => {
  let now = 0; let ticks = 0;
  const abort = new AbortController(); const waits = [];
  const monitor = new Monitor({}, null, { dryRun: true, now: () => now });
  monitor.tick = async () => { ticks++; now += 300; };
  await monitor.run({ intervalMs: 10_000, signal: abort.signal, wait: async (delay) => { waits.push(delay); abort.abort(); } });
  assert.equal(ticks, 1); assert.deepEqual(waits, [9700]);
});

test('results remain completely silent for minutes and clear a pending outage', async () => {
  let now = 0, state = 'unavailable';
  const events = [], deliveries = [];
  const monitor = new Monitor({
    read: async () => ({ state, session: 'ABCDEF' }),
    screenshot: () => assert.fail('results captured'),
  }, { enqueue: (...args) => deliveries.push(args) }, {
    now: () => now, log: (...args) => events.push(args),
    suggestions: { enqueue: () => assert.fail('results generated a suggestion') },
  });
  await monitor.tick(); now = 50_000; state = 'results'; events.length = 0;
  for (; now < 300_000; now += 10_000) await monitor.tick();
  assert.deepEqual(events, []); assert.deepEqual(deliveries, []);
  state = 'unavailable'; await monitor.tick();
  assert.equal(deliveries.length, 0);
  now += 60_000; await monitor.tick();
  assert.equal(deliveries.length, 1); assert.equal(deliveries[0][1], 'health-lost');
});

test('a genuine outage recovers silently through results and reports once on waiting or active', async () => {
  for (const healthyState of ['waiting', 'active']) {
    let now = 0, current = { state: 'unavailable' };
    const events = [], labels = [];
    const monitor = new Monitor({ read: async () => current, screenshot: async () => Buffer.from('photo') },
      { enqueue: (_parts, label) => labels.push(label) }, { now: () => now, log: (event) => events.push(event) });
    await monitor.tick(); now = 60_000; await monitor.tick();
    current = { state: 'results' }; events.length = 0;
    for (let i = 0; i < 20; i++) { now += 10_000; await monitor.tick(); }
    assert.deepEqual(events, []); assert.deepEqual(labels, ['health-lost']);
    current = healthyState === 'active' ? observe() : { state: healthyState };
    await monitor.tick(); await monitor.tick();
    assert.equal(events.filter((event) => event === 'monitoring-recovered').length, 1);
    assert.equal(labels.filter((label) => label === 'health-recovered').length, 1);
  }
});

test('question to results to waiting creates no health notices and rearms once', async () => {
  let current = observe();
  const events = [], labels = [];
  const monitor = new Monitor({ read: async () => current, screenshot: async () => Buffer.from('photo') },
    { enqueue: (_parts, label) => labels.push(label) }, { log: (event) => events.push(event) });
  await monitor.tick(); current = { state: 'results' }; events.length = 0;
  await monitor.tick(); assert.deepEqual(events, []);
  current = { state: 'waiting' }; await monitor.tick();
  current = observe(); await monitor.tick(); await monitor.tick();
  assert.equal(labels.length, 2); assert.equal(events.some((event) => event.startsWith('monitoring-')), false);
});

test('dry-run results are silent and defer recovery just like normal results', async () => {
  let now = 0, state = 'unavailable';
  const logs = [];
  const monitor = new Monitor({ read: async () => ({ state }) }, { enqueue: () => assert.fail('dry-run delivery') },
    { dryRun: true, now: () => now, log: (event) => logs.push(event) });
  await monitor.tick(); now = 60_000; await monitor.tick();
  state = 'results'; logs.length = 0; await monitor.tick(); await monitor.tick();
  assert.deepEqual(logs, []);
  state = 'waiting'; await monitor.tick();
  assert.deepEqual(logs, ['check', 'monitoring-recovered']);
});
