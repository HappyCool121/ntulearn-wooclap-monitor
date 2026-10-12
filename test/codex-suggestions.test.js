import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { CodexSuggestions, diagnosticTail } from '../src/codex-suggestions.js';

const fake = `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
let input = '';
process.stdin.on('data', data => input += data);
process.stdin.on('end', () => {
 const data = JSON.parse(input.split('Question data (JSON): ')[1]);
 const q = JSON.parse(data.question || '{}');
 const imageIndex = process.argv.indexOf('--image');
 const meta = { args: process.argv.slice(2), input, data, cwd: process.cwd(), pid: process.pid,
   directoryMode: fs.statSync(process.cwd()).mode & 511,
   image: imageIndex < 0 ? null : { path: process.argv[imageIndex+1], content: fs.readFileSync(process.argv[imageIndex+1]).toString(), mode: fs.statSync(process.argv[imageIndex+1]).mode & 511 },
   telegramToken: process.env.TELEGRAM_BOT_TOKEN, apiKey: process.env.OPENAI_API_KEY };
 if (q.record) fs.writeFileSync(q.record, JSON.stringify(meta));
 if (q.mode === 'nonzero') { process.stderr.write('generation failed'); process.exit(2); }
 if (q.mode === 'auth') { process.stderr.write('401 unauthorized: login required'); process.exit(1); }
 if (q.mode === 'empty') process.exit(0);
 if (q.mode === 'oversized') { process.stdout.write('x'.repeat(70000)); setInterval(() => {}, 100); return; }
 if (q.mode === 'wait') { setInterval(() => {}, 100); return; }
 if (q.mode === 'stubborn' || q.mode === 'orphan' || q.mode === 'success-descendant') {
   const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 100)"], { stdio: q.mode === 'success-descendant' ? 'ignore' : 'inherit' });
   setTimeout(() => {
     if (q.record) fs.writeFileSync(q.record, JSON.stringify({ ...meta, grandchild: grandchild.pid }));
     if (q.mode === 'orphan') process.exit(0);
     if (q.mode === 'success-descendant') { process.stdout.write('B — Five. Five is prime.'); process.exit(0); }
   }, 100);
   process.on('SIGTERM', () => {});
   setInterval(() => {}, 100); return;
 }
 if (q.mode === 'diagnostic') process.stderr.write('x'.repeat(10000) + ' Bearer private-secret sk-test-secret eyJheader.payload.signature bot123:secret');
 setTimeout(() => { process.stdout.write(JSON.stringify(meta)); }, q.delay || 0);
});
`;

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wooclap-worker-test-'));
  const executable = join(root, 'fake-codex');
  const directory = join(root, 'jobs');
  await mkdir(directory);
  await writeFile(executable, fake, { mode: 0o700 });
  const logs = [];
  const worker = new CodexSuggestions({ executable, directory, graceMs: 150, timeoutMs: 3000, log: (event, detail) => logs.push({ event, ...detail }), ...options });
  t.after(async () => { await worker.close(); await rm(root, { recursive: true, force: true }); });
  return { root, directory, worker, logs };
}

const job = (id, options = {}, extra = {}) => ({ alertId: id, prompt: JSON.stringify(options), choices: ['First', 'Second', 'Third'], ...extra });
async function recordAt(path) {
  for (let attempt = 0; attempt < 150; attempt++) {
    try { const record = JSON.parse(await readFile(path, 'utf8')); if (record.grandchild) return record; } catch {}
    await sleep(20);
  }
  throw new Error('Fake Codex never became ready');
}
async function assertGone(pid) {
  for (let attempt = 0; attempt < 150; attempt++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await sleep(20);
  }
  assert.fail(`Owned process ${pid} still exists`);
}

test('image and ordered text reach Codex through stdin in a private directory, cleaned before callback', async (t) => {
  const { worker, directory } = await fixture(t);
  const previous = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'should-never-reach-worker';
  t.after(() => { if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = previous; });
  let result, files;
  worker.enqueue(job('image', {}, { photo: Buffer.from('synthetic-jpeg') }), (value) => { result = JSON.parse(value); files = readdir(directory); });
  await worker.idle();
  assert.deepEqual(await files, []);
  assert.equal(result.image.content, 'synthetic-jpeg'); assert.ok(isAbsolute(result.image.path));
  assert.equal(result.image.mode, 0o600); assert.equal(result.directoryMode, 0o700);
  assert.deepEqual(result.data.choices, ['First', 'Second', 'Third']);
  assert.ok(result.args.includes('gpt-6-luna')); assert.ok(result.args.includes('--ignore-user-config'));
  assert.ok(result.args.includes('--ephemeral')); assert.ok(result.args.includes('--no-daemon'));
  assert.deepEqual(result.args.slice(-2), ['--', '-']);
  for (const feature of ['shell_tool', 'hooks', 'apps', 'plugins', 'multi_agent']) {
    assert.equal(result.args[result.args.indexOf(feature) - 1], '--disable');
  }
  assert.ok(result.args.includes('web_search="disabled"'));
  assert.equal(result.telegramToken, undefined); assert.equal(result.apiKey, undefined);
  await assertGone(result.pid);
  await assert.rejects(stat(result.cwd), { code: 'ENOENT' });
});

test('one worker finishes all questions in order, snapshots input and deduplicates completed receipts', async (t) => {
  const { worker, directory, logs } = await fixture(t);
  const results = [];
  const first = job('first', { delay: 100 });
  worker.enqueue(first, (answer) => results.push(JSON.parse(answer)));
  first.choices.reverse(); first.prompt = '{}';
  worker.enqueue(job('second'), (answer) => results.push(JSON.parse(answer)));
  assert.equal(worker.enqueue(job('first'), () => assert.fail('duplicate callback')), false);
  await worker.idle();
  assert.deepEqual(results.map((result) => JSON.parse(result.data.question).delay), [100, undefined]);
  assert.deepEqual(results[0].data.choices, ['First', 'Second', 'Third']);
  assert.equal(results[1].image, null);
  assert.equal(worker.enqueue(job('first'), () => assert.fail('completed duplicate')), false);
  assert.equal(logs.filter((log) => log.event === 'suggestion-completed').length, 2);
  assert.deepEqual(await readdir(directory), []);
});

for (const [mode, category] of [['nonzero', 'generation-error'], ['auth', 'authentication'], ['empty', 'empty-output'], ['oversized', 'output-overflow'], ['wait', 'timeout']]) {
  test(`${mode} produces unavailable after process and file cleanup, then continues`, async (t) => {
    const { worker, directory, root, logs } = await fixture(t, { timeoutMs: mode === 'wait' ? 600 : 3000 });
    const record = join(root, 'record.json');
    const results = []; let files;
    worker.enqueue(job(mode, { mode, record }), (answer) => { results.push(answer); files = readdirSync(directory); });
    worker.enqueue(job('next'), (answer) => results.push(answer));
    await worker.idle();
    assert.equal(results[0], null); assert.ok(results[1]);
    assert.deepEqual(files, []);
    assert.equal(logs.find((log) => log.alertId === mode && log.event === 'suggestion-failed').category, category);
    await assertGone(JSON.parse(await readFile(record, 'utf8')).pid);
    assert.deepEqual(await readdir(directory), []);
  });
}

test('missing executable and missing image-only content fail without stopping later jobs', async (t) => {
  const { worker, directory, logs } = await fixture(t, { executable: '/nonexistent-wooclap-codex' });
  const results = [];
  worker.enqueue(job('missing'), (answer) => results.push(answer));
  worker.enqueue(job('no-image', {}, { prompt: '', choices: [] }), (answer) => results.push(answer));
  worker.enqueue(job('image-placeholder', {}, { prompt: '[Image question — see screenshot]', choices: ['4', '5'] }), (answer) => results.push(answer));
  await worker.idle();
  assert.deepEqual(results, [null, null, null]);
  assert.deepEqual(logs.filter((log) => log.event === 'suggestion-failed').map((log) => log.category), ['missing-cli', 'no-question-content', 'no-question-content']);
  assert.deepEqual(await readdir(directory), []);
});

test('queue saturation is bounded, marked unavailable and not regenerated on duplicate receipt', async (t) => {
  const { worker, logs } = await fixture(t, { maxOutstanding: 2 });
  const results = [];
  worker.enqueue(job('1', { delay: 100 }), () => results.push('1'));
  worker.enqueue(job('2'), () => results.push('2'));
  assert.equal(worker.enqueue(job('3'), (value) => results.push(value)), false);
  assert.equal(worker.enqueue(job('3'), () => assert.fail('duplicate overflow')), false);
  assert.equal(worker.items.length, 2);
  await worker.idle(); assert.deepEqual(results, [null, '1', '2']);
  assert.ok(logs.some((log) => log.category === 'queue-full' && log.alertId === '3'));
});

for (const mode of ['stubborn', 'orphan']) {
  test(`timeout kills the entire ${mode} process group, including SIGTERM-ignoring descendants`, async (t) => {
    const { worker, root, directory, logs } = await fixture(t, { timeoutMs: 700 });
    const record = join(root, 'record.json');
    let result;
    worker.enqueue(job(mode, { mode, record }), (answer) => { result = answer; });
    const processes = await recordAt(record);
    await worker.idle();
    assert.equal(result, null); assert.ok(logs.some((log) => log.category === 'timeout'));
    await assertGone(processes.pid); await assertGone(processes.grandchild);
    assert.deepEqual(await readdir(directory), []);
  });
}

test('idempotent cancellation kills stubborn processes and discards pending callbacks', async (t) => {
  const { worker, root, directory, logs } = await fixture(t);
  const record = join(root, 'record.json');
  worker.enqueue(job('active', { mode: 'stubborn', record }), () => assert.fail('cancelled active edit'));
  worker.enqueue(job('pending'), () => assert.fail('cancelled pending edit'));
  const processes = await recordAt(record);
  const closing = worker.close(); assert.equal(closing, worker.close());
  await closing;
  await assertGone(processes.pid); await assertGone(processes.grandchild);
  assert.deepEqual(await readdir(directory), []);
  assert.equal(worker.enqueue(job('after-stop'), () => {}), false);
  assert.ok(logs.some((log) => log.alertId === 'active' && log.category === 'cancelled'));
  assert.ok(logs.some((log) => log.alertId === 'pending' && log.category === 'cancelled-pending'));
});

test('successful generation removes a stubborn descendant with closed stdio before scheduling an edit', async (t) => {
  const { worker, root, directory } = await fixture(t);
  const record = join(root, 'record.json');
  let result, processesGone;
  worker.enqueue(job('success-descendant', { mode: 'success-descendant', record }), (answer) => {
    result = answer;
    processesGone = readFile(record, 'utf8').then((value) => {
      const { pid, grandchild } = JSON.parse(value);
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      assert.throws(() => process.kill(grandchild, 0), { code: 'ESRCH' });
    });
  });
  await worker.idle(); await processesGone;
  assert.match(result, /Five is prime/);
  assert.deepEqual(await readdir(directory), []);
});

test('diagnostics remain bounded and redact credentials', () => {
  const result = diagnosticTail('x'.repeat(10000) + ' Bearer private-secret sk-test-secret eyJheader.payload.signature bot123:secret access_token="secret"');
  assert.ok(result.length <= 2048);
  for (const secret of ['private-secret', 'test-secret', 'eyJheader', 'bot123:secret', '"secret"']) assert.ok(!result.includes(secret));
});
