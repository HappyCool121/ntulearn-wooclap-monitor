import { chromium } from 'playwright';

// Rendering includes cold browser startup; the outer budget also covers native capture.
export const IMAGE_CAPTURE_TIMEOUTS = Object.freeze({ native: 2000, launch: 15_000, render: 20_000, total: 23_000 });

export const escapeHtml = (value = '') => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const mathTags = new Set('math mrow mi mn mo mtext mspace mfrac msqrt mroot msup msub msubsup mover munder munderover mfenced mtable mtr mtd mstyle mpadded mphantom menclose mmultiscripts mprescripts none'.split(' '));
const htmlTags = new Set('span strong b em i p br code sup sub ul ol li'.split(' '));
const attributes = new Set('display mathvariant stretchy fence separator accent accentunder bevelled linethickness columnalign rowalign columnspacing rowspacing open close separators notation width height depth lspace rspace'.split(' '));

export function renderNode(node, depth = 0) {
  if (!node || depth > 80) throw new Error('Question markup is missing or too deeply nested.');
  if (Object.hasOwn(node, 'text')) return escapeHtml(node.text);
  if (!htmlTags.has(node.tag) && !mathTags.has(node.tag)) throw new Error('Unsupported question markup.');
  const attrs = Object.entries(node.attrs || {}).filter(([name]) => attributes.has(name))
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`).join('');
  if (node.tag === 'br') return '<br>';
  return `<${node.tag}${attrs}>${(node.children || []).map((child) => renderNode(child, depth + 1)).join('')}</${node.tag}>`;
}

export function cardHtml(snapshot) {
  if (!snapshot || snapshot.unsupported) throw new Error(snapshot?.unsupported || 'Question snapshot is unavailable.');
  const question = renderNode(snapshot.question);
  const choices = snapshot.choices.map((choice, index) => `<li><div class="label">${index < 26 ? String.fromCharCode(65 + index) : index + 1}</div><div>${renderNode(choice)}</div></li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'"><style>
    *{box-sizing:border-box}body{margin:0;background:#fff;color:#172033;font:26px/1.5 Arial,sans-serif;width:1000px;padding:32px}
    .eyebrow{font-size:17px;letter-spacing:1px;color:#59667a;margin-bottom:20px}h1{font-size:30px;line-height:1.5;font-weight:600;margin:0 0 28px;overflow-wrap:anywhere}
    ul{list-style:none;padding:0;margin:0;display:grid;gap:16px}li{display:grid;grid-template-columns:46px 1fr;gap:14px;align-items:start;border:1px solid #d9e0eb;border-radius:14px;padding:20px;background:#f7f9fc;overflow-wrap:anywhere}
    .label{font-size:21px;font-weight:700;line-height:38px;text-align:center;background:#e5ebf5;border-radius:9px}p{margin:0 0 12px}math{font-size:1.08em}mtext{font-family:Arial,sans-serif}
    </style></head><body><div class="eyebrow">WOOCLAP · QUESTION</div><h1>${question}</h1>${choices ? `<ul>${choices}</ul>` : ''}</body></html>`;
}

export async function withDeadline(task, milliseconds, onTimeout = () => {}, signal) {
  if (signal?.aborted) throw new Error('Question image capture cancelled.');
  let timer, onAbort;
  const stopped = new Promise((_, reject) => {
    const stop = (message) => { Promise.resolve().then(onTimeout).catch(() => {}); reject(new Error(message)); };
    timer = setTimeout(() => stop('Question image operation timed out.'), milliseconds);
    if (signal) {
      onAbort = () => stop('Question image capture cancelled.');
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try { return await Promise.race([Promise.resolve().then(task), stopped]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}

export function jpegDimensions(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error('Question image is not a JPEG.');
  let position = 2;
  while (position + 8 < buffer.length) {
    if (buffer[position] !== 0xff) { position++; continue; }
    const marker = buffer[position + 1]; position += 2;
    if (marker === 0xff || marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = buffer.readUInt16BE(position);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: buffer.readUInt16BE(position + 3), width: buffer.readUInt16BE(position + 5) };
    }
    if (length < 2) break;
    position += length;
  }
  throw new Error('Cannot determine question image dimensions.');
}

export function validatePhoto(buffer) {
  const { width, height } = jpegDimensions(buffer);
  if (!width || !height || buffer.length > 10 * 1024 * 1024 || width + height > 10_000 || Math.max(width / height, height / width) > 20) {
    throw new Error('Question image exceeds Telegram photo limits.');
  }
  return buffer;
}

export class QuestionImageRenderer {
  constructor({ launch = (options) => chromium.launch(options) } = {}) {
    this.launch = launch; this.browser = null; this.launching = null;
    this.contexts = new Set(); this.closed = false;
  }
  async getBrowser() {
    if (this.closed) throw new Error('Question image renderer is closed.');
    if (!this.browser?.isConnected()) {
      this.launching ||= this.launch({ channel: 'chrome', headless: true, timeout: IMAGE_CAPTURE_TIMEOUTS.launch }).finally(() => { this.launching = null; });
      this.browser = await this.launching;
      if (this.closed) { await this.browser.close(); throw new Error('Question image renderer is closed.'); }
    }
    return this.browser;
  }
  async render(snapshot, { signal, timeoutMs = IMAGE_CAPTURE_TIMEOUTS.render } = {}) {
    const html = cardHtml(snapshot);
    let context;
    let cancelled = false;
    const cancel = async () => { cancelled = true; await context?.close().catch(() => {}); };
    return withDeadline(async () => {
      try {
        const browser = await this.getBrowser();
        if (cancelled) throw new Error('Question rendering cancelled.');
        context = await browser.newContext({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1, javaScriptEnabled: false, serviceWorkers: 'block' });
        this.contexts.add(context);
        if (cancelled) throw new Error('Question rendering cancelled.');
        await context.route('**/*', (route) => route.abort());
        const page = await context.newPage();
        await page.setContent(html, { waitUntil: 'load', timeout: 3000 });
        if (cancelled) throw new Error('Question rendering cancelled.');
        const size = await page.locator('body').boundingBox({ timeout: 1000 });
        if (!size || size.height > 9000) throw new Error('Question card is too tall for Telegram.');
        let image = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 85, scale: 'css', timeout: 3000 });
        if (image.length > 10 * 1024 * 1024) image = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 70, scale: 'css', timeout: 2000 });
        return validatePhoto(image);
      } finally {
        await context?.close().catch(() => {});
        this.contexts.delete(context);
      }
    }, timeoutMs, cancel, signal);
  }
  async close() {
    this.closed = true;
    await this.cancelActive();
    // A launch in flight must also be cleaned up after cancellation.
    const pending = await this.launching?.catch(() => null);
    await (this.browser || pending)?.close().catch(() => {});
  }
  async cancelActive() { await Promise.allSettled([...this.contexts].map((context) => context.close())); }
}
