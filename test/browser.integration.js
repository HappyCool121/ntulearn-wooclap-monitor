import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { connectBrowser, discoverTabs, BrowserSource } from '../src/browser.js';
import { extractDom, classifyObservation } from '../src/detection.js';
import { cardHtml, jpegDimensions } from '../src/question-image.js';
import { mathQuestionHTML } from './math-fixture.js';
import { AnswerController } from '../src/answers.js';
import { DeliveryQueue } from '../src/telegram.js';
import { Monitor } from '../src/monitor.js';

const waiting = '<main><div role="status">There is no vote in progress at the moment. Please pay attention to the presenter.</div><p>You will be notified when a vote is started.</p><button>Click on this icon to send a message</button><button>Open reactions</button></main>';
const multiple = '<main><h1>Which number is prime?</h1><fieldset><label><input type="radio" name="answer">4</label><label><input type="radio" name="answer">5</label><label><input type="radio" name="answer">6</label></fieldset><button>Submit</button><span role="timer">30 seconds</span></main>';
const open = '<main><h2>Explain this theorem</h2><textarea aria-label="Your answer"></textarea><button>Send</button></main>';
const choiceButtons = '<main><h1>Select the correct symbol</h1><button>∈</button><button>⊂</button><button>∅</button></main>';
const image = `<main><section data-question-id="image-q"><img alt="" src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><text y="40">x+2=5</text></svg>')}" width="300" height="100"><input type="number" aria-label="Answer"><button>Submit</button></section></main>`;
const documentHTML = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:16px;font:18px sans-serif}main{width:650px;padding:20px}label{display:block}input,textarea,button{margin:8px}</style></head><body>${body}</body></html>`;

test('real Chrome iframe extraction, screenshots, standalone CLI, and disconnect lifecycle', { timeout: 90_000 }, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'wooclap-browser-test-'));
  let context, attached;
  let content = waiting;
  try {
    context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] });
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === 'ntulearn.ntu.edu.sg') await route.fulfill({ contentType: 'text/html', body: documentHTML('<h1>Test Lecture</h1><iframe id="lti-launch-iframe" src="https://app.wooclap.com/ABCDEF?isLTI13=true" style="width:800px;height:600px"></iframe>') });
      else if (url.hostname === 'app.wooclap.com') await route.fulfill({ contentType: 'text/html', body: documentHTML(content) });
      else await route.abort();
    });
    const page = context.pages()[0];
    await page.goto('https://ntulearn.ntu.edu.sg/ultra/courses/test/lti/launchFrame');
    const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
    const endpoint = `http://127.0.0.1:${port}`;
    attached = await connectBrowser(endpoint);
    const tabs = await discoverTabs(attached);
    assert.equal(tabs.length, 1, JSON.stringify(attached.contexts().flatMap((ctx) => ctx.pages().map((candidate) => ({ url: candidate.url(), frames: candidate.frames().map((entry) => entry.url()) })))));
    const source = new BrowserSource(attached, tabs[0], endpoint);
    const frame = tabs[0].frame;
    const set = async (html) => { content = html; await frame.goto('https://app.wooclap.com/ABCDEF?isLTI13=true'); };
    await t.test('waiting screen is recognized', async () => assert.equal((await source.read()).state, 'waiting'));
    await t.test('radio question yields prompt, choices and JPEG of the iframe area', async () => {
      await set(multiple);
      const observation = await source.read();
      assert.equal(observation.state, 'active'); assert.equal(observation.prompt, 'Which number is prime?'); assert.deepEqual(observation.choices, ['4', '5', '6']);
      const photo = await source.screenshot(observation);
      assert.equal(photo[0], 0xff); assert.equal(photo[1], 0xd8); assert.ok(photo.byteLength > 1000);
      if (process.env.NTULEARN_NATIVE_PREVIEW) await writeFile(process.env.NTULEARN_NATIVE_PREVIEW, photo);
    });
    await t.test('open response and button choices are recognized', async () => {
      await set(open); assert.equal((await source.read()).state, 'active');
      await set(choiceButtons); assert.deepEqual((await source.read()).choices, ['∈', '⊂', '∅']);
    });
    await t.test('image question works without text heading', async () => {
      await set(image); const observation = await source.read(); assert.equal(observation.state, 'active'); assert.equal(observation.questionId, 'image-q');
      assert.ok((await source.screenshot(observation)).byteLength > 1000);
    });
    await t.test('hidden stale question does not defeat the visible waiting state', async () => {
      await set(waiting + `<section hidden>${multiple}</section>`); assert.equal((await source.read()).state, 'waiting');
    });
    await t.test('loading, results and chat-only UI do not alert', async () => {
      for (const [html, expected] of [
        ['<main aria-busy="true"><h1>Loading question</h1></main>', 'loading'],
        ['<main><h1>Results</h1><button>Next</button></main>', 'results'],
        ['<main><h1>Wooclap</h1><button>Open reactions</button><button>Send a message</button></main>', 'unavailable'],
      ]) { await set(html); assert.equal(classifyObservation(await frame.evaluate(extractDom)).state, expected); }
    });
    await t.test('question change recreates the saved question instead of capturing the new one', async () => {
      await set(multiple); const previous = await source.read(); await set(open);
      const result = await source.captureImage(previous);
      assert.equal(result.imageSource, 'recreated'); assert.match(result.nativeError, /changed/);
      assert.match(cardHtml(previous.visualSnapshot), /Which number is prime/);
      assert.doesNotMatch(cardHtml(previous.visualSnapshot), /Explain this theorem/);
    });
    await t.test('moving question captures without element stability waits and does not scroll', async () => {
      await set(multiple + '<style>@keyframes moving{from{transform:translateX(0)}to{transform:translateX(.5px)}}main{animation:moving .1s linear infinite alternate}</style>');
      const scrollBefore = await frame.evaluate(() => ({ x: scrollX, y: scrollY, width: innerWidth, height: innerHeight }));
      const result = await source.captureImage(await source.read());
      assert.equal(result.imageSource, 'native');
      assert.deepEqual(await frame.evaluate(() => ({ x: scrollX, y: scrollY, width: innerWidth, height: innerHeight })), scrollBefore);
    });
    await t.test('offscreen choice triggers a complete recreated image', async () => {
      await set(multiple + '<style>fieldset label:last-child{margin-top:700px}</style>');
      const result = await source.captureImage(await source.read());
      assert.equal(result.imageSource, 'recreated');
      assert.match(result.nativeError, /offscreen|beyond|viewport/);
      assert.ok(jpegDimensions(result.photo).height > 100);
    });
    await t.test('overlay outside the iframe causes recreation instead of capturing the overlay', async () => {
      await set(multiple);
      await page.evaluate(() => {
        const overlay = document.createElement('div'); overlay.id = 'test-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:white;z-index:99999';
        document.body.append(overlay);
      });
      try {
        const result = await source.captureImage(await source.read());
        assert.equal(result.imageSource, 'recreated'); assert.match(result.nativeError, /obscured/);
      } finally { await page.locator('#test-overlay').evaluate((element) => element.remove()); }
    });
    await t.test('synthetic KaTeX question recreates each expression once and all four choices', async () => {
      await set(mathQuestionHTML);
      const observation = await source.read();
      assert.equal(observation.visualSnapshot.unsupported, '');
      assert.equal(observation.visualSnapshot.choices.length, 4);
      const html = cardHtml(observation.visualSnapshot);
      assert.equal((html.match(/<math\b/g) || []).length, 10);
      assert.doesNotMatch(html, /annotation|DUPLICATE_VISUAL_MATH|katex-html/);
      const native = source.captureNative;
      source.captureNative = async () => { throw new Error('Forced compositor failure'); };
      let result;
      try { result = await source.captureImage(observation); } finally { source.captureNative = native; }
      assert.equal(result.imageSource, 'recreated'); assert.equal(jpegDimensions(result.photo).width, 1000);
      if (process.env.NTULEARN_TEST_PREVIEW) await writeFile(process.env.NTULEARN_TEST_PREVIEW, result.photo);
    });
    await t.test('fraction/power MathML survives and external resource markup cannot execute', async () => {
      await set('<main><h1>Evaluate <math><mfrac><msup><mi>x</mi><mn>2</mn></msup><mn>3</mn></mfrac></math><span onclick="alert(1)"> exactly.</span></h1><label><input type="radio">A</label><label><input type="radio">B</label></main>');
      const observation = await source.read();
      const html = cardHtml(observation.visualSnapshot);
      assert.match(html, /<mfrac><msup>/); assert.doesNotMatch(html, /onclick|alert\(/);
      const photo = await source.renderer.render(observation.visualSnapshot);
      assert.ok(photo.byteLength > 1000);
      await set(multiple.replace('</main>', '<img src="data:image/svg+xml,x" width="200" height="100"></main>'));
      const unsupported = await source.read();
      assert.throws(() => cardHtml(unsupported.visualSnapshot), /images|visual/);
    });
    const bindAnswer = (observation) => ({ fingerprint: observation.fingerprint, sessionKey: observation.sessionKey, signature: observation.answerState.signature, questionSignature: observation.answerState.questionSignature, questionId: observation.answerState.questionId });
    const interactive = async (mode = 'success') => {
      await set(multiple);
      await frame.evaluate((mode) => {
        window.testSubmits = 0;
        const button = document.querySelector('button');
        button.disabled = true;
        document.querySelectorAll('input[type="radio"]').forEach((radio) => radio.addEventListener('change', () => {
          button.disabled = false;
          if (mode === 'selection-conflict') document.querySelectorAll('input[type="radio"]')[2].checked = true;
          if (mode === 'question-change') document.querySelector('h1').textContent = 'A completely new question';
          if (mode === 'missing-submit') button.remove();
        }));
        button.addEventListener('click', () => {
          window.testSubmits++;
          if (mode === 'success' || mode === 'different-ack') {
            if (mode === 'different-ack') document.querySelector('h1').textContent = 'Another question already answered';
            const confirmation = document.createElement('div'); confirmation.setAttribute('role', 'status');
            confirmation.textContent = 'Your answer has been submitted.'; document.querySelector('main').append(confirmation);
          } else if (mode === 'late-question') document.querySelector('h1').textContent = 'A different question after clicking Submit';
        });
      }, mode);
    };
    await t.test('remote answer selects B, clicks Submit once, and verifies explicit acknowledgment', async () => {
      await interactive(); const expected = bindAnswer(await source.read());
      const result = await source.submitAnswer(expected, 1);
      assert.equal(result.code, 'submitted');
      assert.ok(await frame.locator('input[type="radio"]').nth(1).isChecked());
      assert.equal(await frame.evaluate(() => window.testSubmits), 1);
      assert.equal((await source.submitAnswer(expected, 1)).code, 'already_answered');
      assert.equal(await frame.evaluate(() => window.testSubmits), 1);
    });
    await t.test('manual selection is preserved and no Submit click occurs', async () => {
      await interactive(); const expected = bindAnswer(await source.read());
      await frame.locator('input[type="radio"]').nth(0).click();
      assert.equal((await source.submitAnswer(expected, 1)).code, 'manual');
      assert.ok(await frame.locator('input[type="radio"]').nth(0).isChecked());
      assert.equal(await frame.evaluate(() => window.testSubmits), 0);
    });
    await t.test('question change, manual conflict, or missing Submit between actions prevents submission', async () => {
      for (const mode of ['selection-conflict', 'question-change', 'missing-submit']) {
        await interactive(mode); const expected = bindAnswer(await source.read());
        const result = await source.submitAnswer(expected, 1);
        assert.notEqual(result.code, 'submitted');
        assert.equal(await frame.evaluate(() => window.testSubmits), 0);
      }
    });
    await t.test('reordered choices, expired binding and closed questions cannot submit', async () => {
      await interactive(); const expected = bindAnswer(await source.read());
      await frame.evaluate(() => document.querySelector('fieldset').prepend(document.querySelector('fieldset label:last-child')));
      assert.equal((await source.submitAnswer(expected, 0)).code, 'expired');
      assert.equal(await frame.evaluate(() => window.testSubmits), 0);
      await interactive(); const fresh = bindAnswer(await source.read());
      assert.equal((await source.submitAnswer(fresh, 0, { isCurrent: () => false })).code, 'expired');
      assert.equal(await frame.evaluate(() => window.testSubmits), 0);
      await set(waiting); assert.equal((await source.submitAnswer(fresh, 0)).code, 'expired');
    });
    await t.test('no acknowledgment or a new question after Submit is unconfirmed and not retried', async () => {
      for (const mode of ['no-confirmation', 'late-question', 'different-ack']) {
        await interactive(mode); const expected = bindAnswer(await source.read());
        const result = await source.submitAnswer(expected, 1, { confirmationMs: 100 });
        assert.equal(result.code, 'unconfirmed'); assert.equal(await frame.evaluate(() => window.testSubmits), 1);
      }
    });
    await t.test('duplicate labels remain separate options and checkbox/free-text questions are unsupported', async () => {
      await set(multiple.replace('>6</label>', '>5</label>'));
      const observation = await source.read();
      assert.deepEqual(observation.choices, ['4', '5', '5']); assert.equal(observation.visualSnapshot.choices.length, 3);
      assert.equal(observation.answerState.options.length, 3);
      assert.equal(observation.answerState.supported, true);
      await set(multiple.replaceAll('type="radio"', 'type="checkbox"'));
      assert.equal((await source.read()).answerState.supported, false);
      await set(open); assert.equal((await source.read()).answerState.supported, false);
    });
    await t.test('custom ARIA radios map and submit in the same order as Telegram letters', async () => {
      await set('<main><h1>Pick an option</h1><div role="radiogroup"><div role="radio" tabindex="0" aria-checked="false">First</div><div role="radio" tabindex="0" aria-checked="false">Second</div></div><button>Submit</button></main>');
      await frame.evaluate(() => {
        const radios = [...document.querySelectorAll('[role="radio"]')];
        radios.forEach((radio) => radio.addEventListener('click', () => radios.forEach((item) => item.setAttribute('aria-checked', item === radio ? 'true' : 'false'))));
        document.querySelector('button').addEventListener('click', () => {
          const acknowledgment = document.createElement('div'); acknowledgment.setAttribute('role', 'status');
          acknowledgment.textContent = 'Your response has been recorded.'; document.querySelector('main').append(acknowledgment);
        });
      });
      const expected = bindAnswer(await source.read());
      assert.equal((await source.submitAnswer(expected, 1)).code, 'submitted');
      assert.equal(await frame.locator('[role="radio"]').nth(1).getAttribute('aria-checked'), 'true');
    });
    await t.test('monitor alert receipt and Telegram callback integrate with real browser submission', async () => {
      await interactive();
      const calls = [];
      const telegram = { chatId: '42', call: async (method, params) => {
        calls.push({ method, params });
        return { message_id: 900, chat: { id: 42 } };
      } };
      const queue = new DeliveryQueue(telegram);
      const answers = new AnswerController(source, telegram, queue);
      try {
        await new Monitor(source, queue, { answers }).tick(); await queue.idle();
        const alert = calls.find((call) => call.method === 'sendPhoto');
        assert.ok(alert.params.reply_markup);
        const data = alert.params.reply_markup.inline_keyboard[0][1].callback_data;
        await answers.handleUpdate({ callback_query: { id: 'simulated', from: { id: 42 }, message: { message_id: 900, chat: { id: 42, type: 'private' } }, data } });
        await queue.idle();
        assert.equal(await frame.evaluate(() => window.testSubmits), 1);
        assert.ok(calls.some((call) => call.method === 'sendMessage' && call.params.text === 'Submitted option B.'));
      } finally { await answers.close(); await queue.close(); }
    });
    await t.test('dry-run/read-only/one-shot CLI modes disable remote answers and preserve Chrome on exit', async () => {
      await set(waiting);
      const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
      for (const mode of ['', '--dry-run', '--read-only', '--once', '--no-suggestions']) {
      const child = spawn(process.execPath, [cli, '--endpoint', endpoint, '--json', 'watch', '--no-auto-groups', ...(mode ? [mode] : []), '--interval', '1'], {
        stdio: ['ignore', 'pipe', 'pipe'], cwd: tmpdir(),
        env: { ...process.env, TELEGRAM_BOT_TOKEN: '12345:TEST_ONLY', TELEGRAM_CHAT_ID: '42', NTULEARN_MONITOR_CONFIG: join(profile, 'unused-config.json') },
      });
      let output = ''; let error = ''; let signalled = false;
      child.stderr.on('data', (data) => { error += data; });
      child.stdout.on('data', (data) => {
        output += data;
        if (mode !== '--once' && !signalled && output.includes('"event":"check"')) { signalled = true; child.kill('SIGINT'); }
      });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
      const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve(code)); });
      clearTimeout(timeout);
      assert.equal(exitCode, mode === '--once' ? 0 : 130, output + error);
      assert.equal(JSON.parse(output.split('\n').find((line) => line.includes('"event":"watching"'))).remoteAnswers, false);
      assert.equal(page.isClosed(), false); assert.match(await page.title(), /^$/);
      assert.equal((await source.read()).state, 'waiting');
      }
    });
    await t.test('standalone watch registers groups, broadcasts Luna edits on --once, supports basic/dry modes, and never submits answers', async () => {
      await interactive();
      const bin = join(profile, 'bin'); await mkdir(bin);
      const record = join(profile, 'codex-record.json');
      const callsFile = join(profile, 'telegram-calls.jsonl');
      const preload = join(profile, 'fake-telegram.mjs');
      const fakeCodex = join(bin, 'codex');
      await writeFile(fakeCodex, `#!${process.execPath}
const fs = require('node:fs');
let input = '';
process.stdin.on('data', data => input += data);
process.stdin.on('end', () => {
 const args = process.argv.slice(2);
 fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ input, args, cwd: process.cwd() }));
 setTimeout(() => process.stdout.write('B — 5. Five is prime because its only positive divisors are one and five.'), 200);
});
`, { mode: 0o700 });
      await writeFile(preload, `
import { appendFileSync } from 'node:fs';
let edits = 0, polled = false;
globalThis.fetch = async (url, init) => {
 const method = url.split('/').at(-1);
 const params = init.body instanceof FormData ? Object.fromEntries([...init.body].filter(([key]) => key !== 'photo')) : JSON.parse(init.body);
 appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ method, params }) + '\\n');
 if (method === 'getWebhookInfo') return { ok: true, status: 200, json: async () => ({ ok: true, result: { url: '' } }) };
 if (method === 'getMe') return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: 12345, username: 'test_bot' } }) };
 if (method === 'getChatMember') return { ok: true, status: 200, json: async () => ({ ok: true, result: { status: 'member' } }) };
 if (method === 'getChat') return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: Number(params.chat_id), type: 'supergroup', title: 'Test group' } }) };
 if (method === 'getUpdates') {
   if (!polled) {
     polled = true;
     const updates = process.env.TEST_GROUPS ? [-1009871, -1009872].map((id, i) => ({ update_id: i + 1, my_chat_member: { chat: { id, type: 'supergroup', title: 'Test group' }, new_chat_member: { user: { id: 12345 }, status: 'member' } } })) : [];
     return { ok: true, status: 200, json: async () => ({ ok: true, result: updates }) };
   }
   return new Promise((resolve, reject) => {
     const timer = setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({ ok: true, result: [] }) }), 20000);
     init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
   });
 }
 if (!['sendPhoto', 'sendMessage', 'editMessageCaption', 'editMessageText'].includes(method)) throw new Error('Unexpected receiver/API call ' + method);
 if (method === 'sendPhoto' && process.env.TEST_PHOTO_FALLBACK) return { ok: false, status: 400, json: async () => ({ ok: false, error_code: 400, description: 'invalid photo' }) };
 if (method.startsWith('editMessage') && ++edits === 1) return { ok: false, status: 429, json: async () => ({ ok: false, error_code: 429, description: 'retry', parameters: { retry_after: 0 } }) };
 return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 321 } }) };
};
`);
      const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
      for (const scenario of [
        { flags: ['--once', '--suggestions'], suggestions: true },
        { flags: ['--once', '--suggestions'], suggestions: true, groups: true },
        { flags: ['--suggestions'], suggestions: true, continuous: true },
        { flags: ['--once', '--read-only', '--suggestions'], suggestions: true, fallback: true, chatId: '-1001234567890' },
        { flags: ['--once'], suggestions: false },
        { flags: ['--once', '--no-auto-groups'], suggestions: false, legacy: true },
        { flags: ['--once', '--suggestions', '--no-suggestions'], suggestions: false },
        { flags: ['--once', '--suggestions', '--dry-run'], suggestions: false, dry: true },
      ]) {
        await rm(record, { force: true }); await rm(callsFile, { force: true });
        const { groupStatePath } = await import('../src/groups.js');
        await rm(groupStatePath({ path: join(profile, 'unused-config.json'), botToken: '12345:TEST_ONLY' }), { force: true });
        const child = spawn(process.execPath, ['--import', preload, cli, '--endpoint', endpoint, '--json', 'watch', ...scenario.flags, '--interval', '1'], {
          stdio: ['ignore', 'pipe', 'pipe'], cwd: tmpdir(),
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TELEGRAM_BOT_TOKEN: '12345:TEST_ONLY', TELEGRAM_CHAT_ID: scenario.chatId || '42', NTULEARN_MONITOR_CONFIG: join(profile, 'unused-config.json'), TEST_PHOTO_FALLBACK: scenario.fallback ? '1' : '', TEST_GROUPS: scenario.groups ? '1' : '' },
        });
        let output = '', error = '', signalled = false;
        child.stdout.on('data', (data) => {
          output += data;
          if (scenario.continuous && !signalled && /"event":"delivered","label":"suggestion-/.test(output)) { signalled = true; child.kill('SIGINT'); }
        });
        child.stderr.on('data', (data) => { error += data; });
        const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
        const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        clearTimeout(timeout);
        assert.equal(code, scenario.continuous ? 130 : 0, output + error);
        const events = output.trim().split('\n').map((line) => JSON.parse(line));
        const watching = events.find((event) => event.event === 'watching');
        assert.equal(watching.remoteAnswers, false); assert.equal(watching.suggestions, scenario.suggestions);
        assert.equal(watching.automaticGroups, !scenario.dry && !scenario.legacy);
        assert.ok(events.every((event) => !event.event.startsWith('receiver')));
        assert.equal(await frame.evaluate(() => window.testSubmits), 0);
        assert.equal(await frame.locator('input:checked').count(), 0);
        if (scenario.dry) {
          await assert.rejects(readFile(callsFile), { code: 'ENOENT' });
        } else {
          const allCalls = (await readFile(callsFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
          const calls = allCalls.filter((call) => ['sendPhoto', 'sendMessage', 'editMessageCaption', 'editMessageText'].includes(call.method) && !call.params.text?.startsWith('Wooclap alerts are connected'));
          assert.ok(calls.every((call) => call.params.reply_markup === undefined));
          const ids = scenario.groups ? ['42', '-1009871', '-1009872'] : [scenario.chatId || '42'];
          assert.ok(calls.every((call) => ids.includes(call.params.chat_id)));
          assert.ok(calls.every((call) => (call.params.caption || call.params.text).includes('Source: https://github.com/HappyCool121/ntulearn-wooclap-monitor')));
          assert.equal(calls.filter((call) => call.method === 'sendPhoto').length, ids.length);
          assert.equal(allCalls.some((call) => call.method === 'getUpdates'), !scenario.legacy);
          if (scenario.suggestions) {
            const editMethod = scenario.fallback ? 'editMessageText' : 'editMessageCaption';
            assert.equal(calls.filter((call) => call.method === editMethod).length, ids.length + 1, 'edit rate limit retried before process exited');
            assert.deepEqual([...new Set(calls.filter((call) => call.method === editMethod).map((call) => call.params.chat_id))], ids);
            assert.equal(events.filter((event) => event.event === 'suggestion-started').length, 1);
            assert.equal(calls.at(-1).params.message_id, 321);
            assert.match(calls.at(-1).params.caption || calls.at(-1).params.text, /Suggested answer: B — 5/);
            assert.match(calls[0].params.caption, /Suggested answer: generating…/);
            assert.match(calls.at(-1).params.caption || calls.at(-1).params.text, /Model: gpt-6-luna\nAI suggestion; may be incorrect\. Verify before use\./);
            const generation = JSON.parse(await readFile(record, 'utf8'));
            assert.match(generation.input, /Which number is prime/); assert.match(generation.input, /"choices":\["4","5","6"\]/);
            assert.ok(generation.args.includes('--image'));
            await assert.rejects(readFile(join(generation.cwd, 'question.jpg')), { code: 'ENOENT' });
          } else {
            assert.deepEqual(calls.map((call) => call.method), ['sendPhoto']);
            assert.doesNotMatch(calls[0].params.caption, /Suggested answer/);
          }
        }
        if (!scenario.suggestions) await assert.rejects(readFile(record), { code: 'ENOENT' });
        assert.equal(page.isClosed(), false);
      }
    });
    await source.close(); attached = null;
    assert.equal(page.isClosed(), false);
    assert.equal(await page.locator('h1').innerText(), 'Test Lecture');
  } finally {
    await attached?.close().catch(() => {});
    await context?.close().catch(() => {});
    await rm(profile, { recursive: true, force: true });
  }
});
