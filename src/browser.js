import { chromium } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { extractDom, classifyObservation } from './detection.js';
import { QuestionImageRenderer, validatePhoto, withDeadline, IMAGE_CAPTURE_TIMEOUTS } from './question-image.js';

export const boxInside = (box, outer, tolerance = 1) => box && outer && box.width > 0 && box.height > 0 &&
  box.x >= outer.x - tolerance && box.y >= outer.y - tolerance &&
  box.x + box.width <= outer.x + outer.width + tolerance && box.y + box.height <= outer.y + outer.height + tolerance;

function questionUnobscured(root) {
  const candidates = [...root.querySelectorAll('h1,h2,h3,[role="heading"],[role="radio"],[role="checkbox"],label,img,canvas')];
  for (const element of candidates) {
    if (element.closest('[hidden],[aria-hidden="true"]')) continue;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    if (rect.x < 0 || rect.y < 0 || rect.right > window.innerWidth + 1 || rect.bottom > window.innerHeight + 1) return false;
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    if (!hit || (!element.contains(hit) && !hit.contains(element))) return false;
  }
  return root.scrollHeight <= root.clientHeight + 1 && root.scrollWidth <= root.clientWidth + 1;
}

async function boundedRead(frame) {
  let timer;
  try {
    return await Promise.race([
      frame.evaluate(extractDom),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Wooclap frame did not respond within 5 seconds.')), 5000); }),
    ]);
  } finally { clearTimeout(timer); }
}

export const CHROME_SETUP = 'Open chrome://inspect/#remote-debugging in Chrome, enable "Allow remote debugging for this browser instance", then approve this tool’s connection prompt.';
export const isNTULearn = (url) => { try { return new URL(url).hostname === 'ntulearn.ntu.edu.sg'; } catch { return false; } };
export const isWooclap = (url) => { try { return new URL(url).hostname === 'app.wooclap.com'; } catch { return false; } };
export function sessionIdentity(url) {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
}

export async function connectBrowser(endpoint = 'chrome') {
  try {
    return await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 10_000 });
  } catch {
    throw new Error(`Cannot attach to Chrome. ${CHROME_SETUP} For another profile/endpoint, use --endpoint with its local CDP URL.`);
  }
}

export async function discoverTabs(browser) {
  const candidates = [];
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (page.isClosed() || !isNTULearn(page.url())) continue;
      // CDP can report a cross-origin child frame before its URL is initialized.
      // Give the attachment event a short chance to finish before listing tabs.
      if (page.frames().some((frame) => !frame.url() && frame !== page.mainFrame())) {
        await page.waitForEvent('framenavigated', { predicate: (frame) => isWooclap(frame.url()), timeout: 2000 }).catch(() => {});
      }
      for (const frame of page.frames()) {
        if (!isWooclap(frame.url())) continue;
        const key = sessionIdentity(frame.url());
        const code = new URL(frame.url()).pathname.split('/').filter(Boolean)[0] || '';
        let title = 'NTULearn Wooclap';
        try {
          title = await page.locator('h1').first().innerText({ timeout: 1000 });
        } catch { try { title = await page.title(); } catch { /* Page may be navigating. */ } }
        candidates.push({ page, frame, key, code, title, url: page.url(), link: key, label: `${title} [${code}]` });
      }
    }
  }
  return candidates;
}

export const publicTab = (tab, index) => ({ index: index + 1, session: tab.code, title: tab.title, sessionLink: tab.link });

export class BrowserSource {
  constructor(browser, selected, endpoint, { connect = connectBrowser, discover = discoverTabs, renderer = new QuestionImageRenderer() } = {}) {
    this.browser = browser;
    this.selected = selected;
    this.endpoint = endpoint;
    this.connect = connect;
    this.discover = discover;
    this.identity = { key: selected.key, url: selected.url };
    this.closed = false;
    this.renderer = renderer;
    this.captureAbort = new AbortController();
    this.nativeSessions = new Set();
  }
  async resolve() {
    if (!this.browser?.isConnected()) {
      this.browser = await this.connect(this.endpoint);
      if (this.closed) { await this.browser.close(); throw new Error('Monitor stopped.'); }
    }
    const oldPage = this.selected.page;
    if (!oldPage.isClosed() && isNTULearn(oldPage.url())) {
      const frame = oldPage.frames().find((candidate) => isWooclap(candidate.url()) && sessionIdentity(candidate.url()) === this.identity.key);
      if (frame) { this.selected.frame = frame; return this.selected; }
    }
    const candidates = (await this.discover(this.browser)).filter((candidate) => candidate.key === this.identity.key);
    const exact = candidates.filter((candidate) => candidate.url === this.identity.url);
    const matches = exact.length ? exact : candidates;
    if (matches.length !== 1) throw new Error(matches.length ? 'Selected session matches several tabs; close duplicates or restart with --tab.' : 'Selected Wooclap session is unavailable. Reopen the same session in NTULearn.');
    this.selected = matches[0];
    return this.selected;
  }
  async read() {
    const selected = await this.resolve();
    const raw = await boundedRead(selected.frame);
    return { ...classifyObservation(raw), visualSnapshot: raw.visualSnapshot, answerState: raw.answerState, session: selected.code, sessionKey: selected.key, title: selected.title, link: selected.link, frame: selected.frame };
  }
  async submitAnswer(expected, index, { isCurrent = () => true, signal, confirmationMs = 3000 } = {}) {
    let selected = false, submitStarted = false;
    const guard = () => !this.closed && !signal?.aborted && isCurrent();
    const matches = (current) => current.state === 'active' && current.fingerprint === expected.fingerprint &&
      current.sessionKey === expected.sessionKey && current.answerState?.signature === expected.signature;
    const acknowledged = (current) => Boolean(current.answerState?.submitted &&
      !(current.answerState.questionId && expected.questionId && current.answerState.questionId !== expected.questionId) &&
      !(current.answerState.questionSignature && expected.questionSignature &&
        current.answerState.questionSignature !== expected.questionSignature && !current.answerState.confirmationOnly));
    const preflight = async () => {
      if (!guard()) return { code: 'expired' };
      const current = await this.read();
      if (!guard()) return { code: 'expired' };
      if (current.sessionKey !== expected.sessionKey) return { code: 'expired' };
      if (current.answerState?.submitted) return { code: acknowledged(current) ? 'already_answered' : 'expired' };
      if (!matches(current)) return { code: 'expired' };
      if (!current.answerState.supported || current.answerState.options.some((option) => !option.enabled)) return { code: 'unavailable' };
      return { current };
    };
    try {
      let check = await preflight();
      if (check.code) return check;
      if (check.current.answerState.options.some((option) => option.selected)) return { code: 'manual' };
      const option = check.current.answerState.options[index];
      if (!option) return { code: 'invalid' };
      const radio = await check.current.frame.locator('[role="radio"], input[type="radio"]').nth(option.domIndex).elementHandle({ timeout: 1000 });
      if (!radio) return { code: 'unavailable' };
      try {
        // Pin the node so an intervening rerender cannot retarget an nth locator.
        check = await preflight();
        if (check.code) return check;
        if (check.current.answerState.options.some((item) => item.selected)) return { code: 'manual' };
        if (!guard()) return { code: 'expired' };
        selected = true; // A timed-out click can still have selected the option.
        await radio.click({ timeout: 1500 });
      } finally { await radio.dispose(); }
      check = await preflight();
      if (check.code) return { code: check.code === 'already_answered' ? 'submitted' : check.code };
      const options = check.current.answerState.options;
      if (!options[index]?.selected || options.some((item, position) => position !== index && item.selected)) return { code: 'conflict' };
      if (!check.current.answerState.submit?.enabled) return { code: 'selected_only' };
      const submitLocator = check.current.frame.getByRole('button', { name: /^Submit$/i }).filter({ visible: true });
      if (await submitLocator.count() !== 1) return { code: 'selected_only' };
      const submit = await submitLocator.elementHandle({ timeout: 1000 });
      if (!submit) return { code: 'selected_only' };
      try {
        check = await preflight();
        if (check.code) return { code: check.code === 'already_answered' ? 'submitted' : check.code };
        if (!check.current.answerState.options[index]?.selected || check.current.answerState.options.some((item, position) => position !== index && item.selected)) return { code: 'conflict' };
        if (!check.current.answerState.submit?.enabled || !(await submit.isEnabled())) return { code: 'selected_only' };
        if (!guard()) return { code: 'expired' };
        submitStarted = true;
        await submit.click({ timeout: 1500 });
      } finally { await submit.dispose(); }
      const deadline = Date.now() + confirmationMs;
      do {
        if (!guard()) return { code: 'unconfirmed' };
        const current = await this.read();
        if (!guard()) return { code: 'unconfirmed' };
        if (current.sessionKey === expected.sessionKey && acknowledged(current)) return { code: 'submitted' };
        if (!matches(current)) return { code: 'unconfirmed' };
        if (Date.now() >= deadline) break;
        await sleep(Math.min(100, deadline - Date.now()), undefined, { signal });
      } while (true);
      return { code: 'unconfirmed' };
    } catch (error) {
      return { code: submitStarted ? 'unconfirmed' : selected ? 'selected_only' : 'unavailable', reason: error.message };
    }
  }
  async captureNative(observation, { signal } = {}) {
    const check = () => { if (signal?.aborted || this.closed) throw new Error('Question image capture cancelled.'); };
    check();
    const frame = observation.frame;
    const before = classifyObservation(await boundedRead(frame));
    check();
    if (before.state !== 'active' || before.fingerprint !== observation.fingerprint) throw new Error('Question changed before screenshot.');
    const selector = '[data-question-id], [data-testid="question"], [data-testid="question-container"], [data-testid="question-panel"], [data-testid="active-question"], [data-question-state="active"], .question-container, .question-panel';
    let area = frame.locator(selector).filter({ visible: true }).first();
    if (!(await area.count())) area = frame.locator('main, [role="main"]').filter({ visible: true }).first();
    if (!(await area.count())) throw new Error('No visible Wooclap question area available for screenshot.');
    if (!(await area.evaluate(questionUnobscured))) throw new Error('Question content is offscreen, clipped, or obscured.');
    check();
    const page = frame.page();
    const box = await area.boundingBox({ timeout: 1000 });
    const frameElement = await frame.frameElement();
    let frameBox;
    try {
      frameBox = await frameElement.boundingBox();
      const uncovered = await frameElement.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const hit = element.ownerDocument.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return Boolean(hit && (hit === element || element.contains(hit)));
      });
      if (!uncovered) throw new Error('Wooclap iframe is obscured by another panel.');
    }
    finally { await frameElement.dispose(); }
    check();
    if (!boxInside(box, frameBox)) throw new Error('Question extends beyond its iframe.');
    const session = await page.context().newCDPSession(page);
    this.nativeSessions.add(session);
    let image;
    try {
      check();
      const metrics = await session.send('Page.getLayoutMetrics');
      check();
      const viewport = metrics.cssVisualViewport || metrics.visualViewport;
      if (!boxInside(box, { x: 0, y: 0, width: viewport.clientWidth, height: viewport.clientHeight })) throw new Error('Question is outside the Chrome viewport.');
      const clip = { x: box.x + viewport.pageX, y: box.y + viewport.pageY, width: box.width, height: box.height, scale: 1 };
      // Capture existing paint directly. No font/stability waits, scrolling,
      // animation changes, or screenshot preparation in the user's page.
      const take = async (quality) => Buffer.from((await session.send('Page.captureScreenshot', { format: 'jpeg', quality, clip, fromSurface: true, captureBeyondViewport: false })).data, 'base64');
      image = await take(85);
      check();
      if (image.length > 10 * 1024 * 1024) image = await take(70);
      validatePhoto(image);
      const afterBox = await area.boundingBox({ timeout: 1000 });
      if (!afterBox || Math.abs(box.x - afterBox.x) > 2 || Math.abs(box.y - afterBox.y) > 2 || Math.abs(box.width - afterBox.width) > 2 || Math.abs(box.height - afterBox.height) > 2) throw new Error('Question moved during capture.');
    } finally {
      this.nativeSessions.delete(session);
      await session.detach().catch(() => {});
    }
    const after = classifyObservation(await boundedRead(frame));
    check();
    if (after.state !== 'active' || after.fingerprint !== observation.fingerprint) throw new Error('Question changed during screenshot.');
    return image;
  }
  async detachNativeSessions() {
    await Promise.allSettled([...this.nativeSessions].map((session) => session.detach()));
    this.nativeSessions.clear();
  }
  async captureImage(observation) {
    if (this.closed) throw new Error('Question image capture cancelled.');
    const attemptAbort = new AbortController();
    const signal = AbortSignal.any([this.captureAbort.signal, attemptAbort.signal]);
    return withDeadline(async () => {
      let nativeError;
      const nativeAbort = new AbortController();
      try {
        const nativeSignal = AbortSignal.any([signal, nativeAbort.signal]);
        const photo = await withDeadline(() => this.captureNative(observation, { signal: nativeSignal }), IMAGE_CAPTURE_TIMEOUTS.native, () => { nativeAbort.abort(); return this.detachNativeSessions(); }, signal);
        return { photo, imageSource: 'native' };
      } catch (error) { nativeError = error.message; }
      if (this.closed) throw new Error('Question image capture cancelled.');
      try {
        const photo = await this.renderer.render(observation.visualSnapshot, { signal });
        return { photo, imageSource: 'recreated', nativeError };
      } catch (error) { throw new Error(`Native capture: ${nativeError}\nCard rendering: ${error.message}`); }
    }, IMAGE_CAPTURE_TIMEOUTS.total, () => { attemptAbort.abort(); return Promise.allSettled([this.detachNativeSessions(), this.renderer.cancelActive()]); }, this.captureAbort.signal);
  }
  // Preserve the existing internal Buffer-returning interface for callers.
  async screenshot(observation) { return (await this.captureImage(observation)).photo; }
  async close() {
    this.closed = true;
    this.captureAbort.abort();
    await this.detachNativeSessions();
    await this.renderer.close();
    // For a connected CDP browser, Playwright close disconnects the transport.
    // Do not close pages or contexts: they belong to the user.
    await this.browser?.close().catch(() => {});
  }
}
