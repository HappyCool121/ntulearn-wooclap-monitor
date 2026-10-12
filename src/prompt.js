import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';

export async function ask(question) {
  if (!process.stdin.isTTY) throw new Error('Interactive setup needs a terminal. Run this command in Terminal.');
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await input.question(question)).trim(); }
  finally { input.close(); }
}

export async function choose(items, label) {
  if (items.length === 1) return items[0];
  if (!items.length) throw new Error(`No ${label} found.`);
  if (!process.stdin.isTTY) throw new Error(`Multiple ${label} found. Select one with the documented command option.`);
  items.forEach((item, index) => console.log(`${index + 1}. ${item.label}`));
  const number = Number(await ask(`Select ${label} [1-${items.length}]: `));
  if (!Number.isInteger(number) || number < 1 || number > items.length) throw new Error('Invalid selection.');
  return items[number - 1];
}

export async function hiddenToken() {
  const input = process.stdin;
  if (!input.isTTY || !process.stdout.isTTY) throw new Error('Token entry needs a terminal, or set TELEGRAM_BOT_TOKEN locally.');
  process.stdout.write('Telegram bot token (hidden): ');
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    function finish(error) {
      input.removeListener('keypress', onKey);
      input.setRawMode(wasRaw);
      input.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(value.trim());
    }
    function onKey(text, key = {}) {
      if (key.ctrl && key.name === 'c') return finish(new Error('Setup cancelled.'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') value = value.slice(0, -1);
      else if (text && !key.ctrl && !key.meta) value += text.replace(/[\x00-\x1f\x7f]/g, '');
    }
    input.on('keypress', onKey);
  });
}
