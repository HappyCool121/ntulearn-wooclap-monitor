import { createHash } from 'node:crypto';

// Self-contained: Playwright serializes this function into the Wooclap frame.
// Read DOM only; never read app stores, hidden application state, or network tokens.
export function extractDom() {
  const visible = (el) => {
    if (!el || el.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  const text = (el) => visible(el) ? (el.innerText || el.getAttribute('aria-label') || '').trim() : '';
  const all = (root, selector) => [...(root.matches?.(selector) ? [root] : []), ...root.querySelectorAll(selector)].filter(visible);
  const main = all(document, 'main, [role="main"]')[0] || document.body;
  const panels = all(main, '[data-question-id], [data-testid="question"], [data-testid="question-container"], [data-testid="question-panel"], [data-testid="active-question"], [data-question-state="active"], .question-container, .question-panel');
  const panel = panels[0] || main;
  const statuses = all(main, '[role="status"], [role="alert"], [data-testid="waiting-screen"], [data-testid="results-screen"]').map(text);
  const headings = all(panel, 'h1, h2, h3, [role="heading"], [data-testid="question-title"], [data-testid="question-text"], .question-title, .question-text').map(text).filter(Boolean);
  const controls = all(panel, 'input:not([type="hidden"]):not([type="password"]):not([type="search"]), textarea, select, [role="radio"], [role="checkbox"], [role="textbox"], [role="slider"], [contenteditable="true"]')
    .filter((el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true');
  const buttons = all(panel, 'button, [role="button"]').filter((el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true');
  const choiceNodes = all(panel, '[data-testid="answer-option"], [data-testid="choice"], [data-answer-id], [role="radio"], [role="checkbox"], label');
  const action = /^(submit|send|vote|validate|confirm|answer|check answer|envoyer|voter|valider)(\b|$)/i;
  const utility = /^(open reactions|user settings|click on this icon|send a message|close|back|next|previous|menu|log ?in|sign ?in|join|help|exit|skip|results|show results|hide results|leaderboard|submit|send|vote|validate|confirm|answer|check answer|envoyer|voter|valider)(\b|$)/i;
  const optionButtons = buttons.map(text).filter((value) => value && !utility.test(value));
  const choices = [...new Set(choiceNodes.map(text).filter(Boolean))];
  if (!choices.length && optionButtons.length >= 2) choices.push(...optionButtons);
  const images = all(panel, 'img:not([alt="Wooclap"]), svg[role="img"], canvas').filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width >= 80 && rect.height >= 40;
  }).map((el) => ({ alt: el.getAttribute('alt') || el.getAttribute('aria-label') || '', src: el.getAttribute('src') || '', kind: el.tagName.toLowerCase() }));
  const explicitActive = panel.matches('[data-testid="active-question"], [data-question-state="active"]') ||
    !!all(panel, '[data-testid="active-question"], [data-question-state="active"]')[0];
  const questionIdNode = panel.matches('[data-question-id]') ? panel : all(panel, '[data-question-id]')[0];
  // A semantic snapshot is separate from detection/fingerprinting. Keep one
  // MathML representation of KaTeX, never its duplicate visual/TeX layers.
  let unsupported = images.length ? 'Question contains images or graphics that cannot be recreated faithfully.' : '';
  const mathTags = new Set('math mrow mi mn mo mtext mspace mfrac msqrt mroot msup msub msubsup mover munder munderover mfenced mtable mtr mtd mstyle mpadded mphantom menclose mmultiscripts mprescripts none'.split(' '));
  const mathAttributes = new Set('mathvariant stretchy fence separator accent accentunder bevelled linethickness columnalign rowalign columnspacing rowspacing open close separators notation width height depth lspace rspace'.split(' '));
  const serialize = (node, inMath = false) => {
    if (node.nodeType === Node.TEXT_NODE) return { text: node.textContent };
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const tag = node.localName.toLowerCase();
    if (tag === 'annotation' || tag === 'annotation-xml') return null;
    if (node.matches('.katex, mjx-container')) {
      const math = node.querySelector('math');
      if (!math) { unsupported = 'Math representation is unavailable.'; return null; }
      return serialize(math, true);
    }
    if (tag === 'semantics') return serialize(node.firstElementChild, true);
    if (inMath || tag === 'math') {
      if (!mathTags.has(tag)) { unsupported = 'Unsupported mathematical markup.'; return null; }
      const attrs = {};
      for (const attr of node.attributes) if (mathAttributes.has(attr.name)) attrs[attr.name] = attr.value;
      if (tag === 'math') attrs.display = 'inline';
      return { tag, attrs, children: [...node.childNodes].map((child) => serialize(child, true)).filter(Boolean) };
    }
    if (!visible(node) || node.matches('script, style, input, textarea, select, [contenteditable="true"], .katex-html')) return null;
    if (node.matches('img, svg, canvas, video, audio, iframe')) { unsupported = 'Question contains unsupported visual content.'; return null; }
    const safeTag = new Set(['strong', 'b', 'em', 'i', 'p', 'br', 'code', 'sup', 'sub', 'ul', 'ol', 'li']).has(tag) ? tag : 'span';
    return { tag: safeTag, children: [...node.childNodes].map((child) => serialize(child)).filter(Boolean) };
  };
  const headingNode = all(panel, 'h1, h2, h3, [role="heading"], [data-testid="question-title"], [data-testid="question-text"], .question-title, .question-text')
    .find((node) => text(node) && !/^(wooclap|question|multiple choice|open question)$/i.test(text(node)));
  const visualChoices = choices.map((value) => {
    const node = [...choiceNodes, ...buttons].find((candidate) => text(candidate) === value);
    return node ? serialize(node) : { text: value };
  });
  const visualQuestion = headingNode ? serialize(headingNode) : null;
  const visualSnapshot = { question: visualQuestion, choices: visualChoices, unsupported: unsupported || (!visualQuestion ? 'No semantic question heading is available.' : '') };
  return {
    text: text(main), panelText: text(panel), headings, statuses, choices, images,
    questionId: questionIdNode?.getAttribute('data-question-id') || '',
    hasQuestionPanel: panels.length > 0,
    hasResponseControls: controls.length > 0 || buttons.some((el) => action.test(text(el))) || optionButtons.length >= 2,
    explicitActive,
    loading: !!all(main, '[aria-busy="true"], [role="progressbar"], [data-testid="loading"]')[0],
    results: !!all(main, '[data-testid="results-screen"], [data-question-state="results"]')[0],
    visualSnapshot,
  };
}

const normalized = (value = '') => value.replace(/\s+/g, ' ').trim();
const noise = /^(\d+\s*(?:seconds?|secs?|s|minutes?|mins?|responses?|answers?|participants?|votes?)(?:\s+(?:left|remaining))?|(?:time(?: left| remaining)?|responses?|answers?|participants?|votes?|countdown)\s*[:：]?\s*\d+(?:\s*\/\s*\d+)?|\d{1,2}:\d{2}|question\s+\d+(?:\s*\/\s*\d+)?|submit|send|vote|validate|confirm|open reactions|user settings|click on this icon to send a message)$/i;
export const contentLines = (value = '') => value.split('\n').map(normalized).filter((line) => line && !noise.test(line));

export function classifyObservation(raw) {
  const stateText = (raw.statuses || []).join('\n');
  const lines = (raw.text || '').split('\n').map(normalized);
  const waiting = /there is no vote in progress|no (?:vote|question) (?:is )?(?:in progress|active)|waiting for (?:the |your )?(?:presenter|next question)|you will be notified when a vote is started|please wait for the (?:next question|presenter)/i;
  if (waiting.test(stateText) || lines.some((line) => waiting.test(line) && line.length < 250)) return { state: 'waiting' };
  const unavailable = /^(?:connection lost|disconnected|reconnecting|session expired|sign in to continue|log in to continue|event not found|event has ended|session has ended|you are offline)(?:[.! ]|$)/i;
  if (unavailable.test(stateText) || lines.some((line) => unavailable.test(line))) return { state: 'unavailable', reason: 'Wooclap connection/session unavailable' };
  if (raw.loading) return { state: 'loading', reason: 'Wooclap is loading' };
  const resultLine = /^(?:results|correct answer|voting (?:is )?closed|question (?:is )?closed|leaderboard|your answer has been (?:sent|submitted)|answer submitted|thanks for your (?:answer|response))(?:[.! :]|$)/i;
  if (raw.results || resultLine.test(stateText) || lines.some((line) => resultLine.test(line))) return { state: 'results' };
  const headings = (raw.headings || []).flatMap(contentLines).filter((line) => !/^(?:wooclap|question|multiple choice|open question)$/i.test(line));
  const choices = (raw.choices || []).map(normalized).filter(Boolean);
  let prompt = headings.join('\n');
  if (!prompt && raw.hasQuestionPanel) {
    prompt = contentLines(raw.panelText).filter((line) => !choices.includes(line)).join('\n');
  }
  const images = (raw.images || []).map((img) => ({ ...img, src: imageIdentity(img.src) }));
  const hasContent = Boolean(prompt || images.length);
  // Ordinary buttons alone (chat reactions, menus, etc.) are not question evidence.
  const active = hasContent && (raw.explicitActive || (raw.hasResponseControls && (raw.hasQuestionPanel || headings.length > 0)));
  if (!active) return { state: 'unavailable', reason: 'Unrecognized Wooclap screen; no positive active-question evidence' };
  prompt ||= images.map((img) => img.alt).filter(Boolean).join('\n') || '[Image question — see screenshot]';
  const fingerprint = raw.questionId ? `id:${raw.questionId}` : createHash('sha256').update(JSON.stringify({ prompt, choices, images })).digest('hex');
  return { state: 'active', fingerprint, prompt, choices, questionId: raw.questionId || '' };
}

function imageIdentity(src = '') {
  try { const url = new URL(src); return `${url.origin}${url.pathname}`; }
  catch { return src; }
}

export class AppearanceTracker {
  current = null;
  sequence = 0;
  observe(observation) {
    if (observation.state === 'waiting' || observation.state === 'results') this.current = null;
    if (observation.state !== 'active' || observation.fingerprint === this.current) return null;
    this.current = observation.fingerprint;
    return { ...observation, appearance: ++this.sequence };
  }
}
