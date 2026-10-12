import { withDeadline } from './question-image.js';

const messages = {
  submitted: 'Submitted option {letter}.',
  already_answered: 'This question is already answered. Nothing changed.',
  manual: 'An option is already selected in Chrome. Finish there; your selection was left alone.',
  expired: 'That question is no longer available. Use the latest question alert.',
  unavailable: 'Remote answering is unavailable for this question. Please use Chrome.',
  invalid: 'Invalid option. Choose one of the letters shown below the question.',
  conflict: 'The selection changed while answering. Finish in Chrome; Submit was not clicked.',
  selected_only: 'An option may be selected, but Submit was not clicked. Please finish in Chrome.',
  unconfirmed: 'Submission unconfirmed—check Chrome. Submit will not be retried.',
  pending: 'An answer is already being submitted. Please wait.',
  reply_required: 'Reply to the question alert with a letter, or tap its answer buttons.',
};

export class AnswerController {
  constructor(source, telegram, queue, { log = () => {} } = {}) {
    this.source = source; this.telegram = telegram; this.queue = queue; this.log = log;
    this.bindings = new Map(); this.messageBindings = new Map(); this.current = null;
    this.tail = Promise.resolve(); this.closed = false; this.abort = new AbortController();
  }
  observe(observation) {
    const binding = this.current;
    if (!binding || binding.status !== 'open') return;
    if (observation.answerState?.submitted) this.finish(binding, 'already_answered');
    else if (['waiting', 'results'].includes(observation.state) || (observation.state === 'active' &&
      (binding.fingerprint !== observation.fingerprint || binding.signature !== observation.answerState?.signature))) this.finish(binding, 'expired');
    else if (observation.state === 'active' && observation.answerState?.options.some((option) => option.selected)) this.finish(binding, 'manual');
  }
  prepare(event, observation) {
    if (this.closed) return null;
    if (this.current) this.finish(this.current, 'expired');
    this.current = null;
    const answers = observation.answerState;
    if (!answers?.supported || answers.submitted || answers.options.some((option) => !option.enabled || option.selected)) return null;
    const binding = {
      id: event.alertId, fingerprint: observation.fingerprint, sessionKey: observation.sessionKey,
      questionSignature: answers.questionSignature, questionId: answers.questionId,
      signature: answers.signature, count: answers.options.length, status: 'open', messageIds: new Set(),
    };
    this.bindings.set(binding.id, binding); this.current = binding;
    // Keep tombstones for recent alerts while bounding session memory.
    while (this.bindings.size > 100) {
      const old = this.bindings.get(this.bindings.keys().next().value);
      this.bindings.delete(old.id);
      for (const id of old.messageIds) this.messageBindings.delete(id);
    }
    return binding;
  }
  decorate(parts, binding) {
    if (!binding) return parts;
    const rows = [];
    for (let index = 0; index < binding.count; index++) {
      if (index % 4 === 0) rows.push([]);
      rows.at(-1).push({ text: String.fromCharCode(65 + index), callback_data: `wa:${binding.id}:${index}` });
    }
    const markup = { inline_keyboard: rows };
    for (const part of parts) {
      part.params.reply_markup = markup;
      const instruction = '\n\nTap a letter to submit, or reply to this alert with a letter. A is the first choice, B the second, and so on.';
      if (part.params.caption) part.params.caption += instruction;
      else if (part.params.text) part.params.text += instruction;
      if (part.fallback) this.decorate([part.fallback], binding);
    }
    return parts;
  }
  receipt(binding, receipt) {
    if (!binding || !Number.isInteger(receipt?.message_id) || String(receipt.chat?.id) !== this.telegram.chatId) return;
    binding.messageIds.add(receipt.message_id);
    this.messageBindings.set(receipt.message_id, binding);
    if (binding.status !== 'open' || this.closed) this.clearKeyboard(receipt.message_id);
  }
  clearKeyboard(messageId) {
    this.queue.enqueue([{ method: 'editMessageReplyMarkup', params: { message_id: messageId, reply_markup: { inline_keyboard: [] } } }], `answer-controls-${messageId}`);
  }
  finish(binding, status) {
    if (binding.status === 'submitted' || binding.status === 'unconfirmed') return;
    binding.status = status;
    for (const id of binding.messageIds) this.clearKeyboard(id);
  }
  async acknowledge(callback, text) {
    if (!callback) return;
    try { await this.telegram.call('answerCallbackQuery', { callback_query_id: callback.id, text }, { timeoutMs: 5000 }); }
    catch (error) { this.log('answer-callback-ack-failed', { reason: error.message }); }
  }
  notify(messageId, code, index) {
    const text = (messages[code] || messages.unavailable).replace('{letter}', String.fromCharCode(65 + index));
    this.queue.enqueue([{ method: 'sendMessage', params: { text, reply_parameters: { message_id: messageId, allow_sending_without_reply: true } } }], `answer-result-${messageId}`);
  }
  async handleUpdate(update) {
    const callback = update.callback_query;
    const message = callback?.message || update.message;
    const actor = callback?.from || update.message?.from;
    if (!message || message.chat?.type !== 'private' || String(message.chat.id) !== this.telegram.chatId ||
      String(actor?.id) !== this.telegram.chatId || actor?.is_bot) {
      await this.acknowledge(callback, 'This action is not available to this account.'); return;
    }
    let binding, index, messageId;
    if (callback) {
      const parsed = /^wa:([a-zA-Z0-9-]+):(\d{1,2})$/.exec(callback.data || '');
      messageId = message.message_id;
      binding = this.messageBindings.get(messageId);
      if (!parsed || !binding || parsed[1] !== binding.id) { await this.acknowledge(callback, 'This question alert has expired.'); return; }
      index = Number(parsed[2]);
    } else {
      const text = (message.text || '').trim();
      messageId = message.reply_to_message?.message_id;
      binding = this.messageBindings.get(messageId);
      if (!messageId) {
        if (/^[a-z]$/i.test(text)) this.notify(message.message_id, 'reply_required', 0);
        return;
      }
      if (!binding) { if (/^[a-z]$/i.test(text)) this.notify(message.message_id, 'expired', 0); return; }
      if (!/^[a-z]$/i.test(text)) { this.notify(messageId, 'invalid', 0); return; }
      index = text.toUpperCase().charCodeAt(0) - 65;
    }
    if (index < 0 || index >= binding.count) { await this.acknowledge(callback, 'Invalid answer option.'); this.notify(messageId, 'invalid', index); return; }
    if (binding.status !== 'open' || this.current !== binding || this.closed) {
      const code = binding.status === 'submitted' ? 'already_answered' : binding.status === 'open' ? 'expired' : binding.status;
      await this.acknowledge(callback, messages[code] || messages.expired);
      this.notify(messageId, code, index); return;
    }
    // Mark synchronously before any await to close the double-tap window.
    binding.status = 'pending';
    await this.acknowledge(callback, 'Checking the question…');
    const operation = this.tail.then(async () => {
      if (this.closed || this.current !== binding || binding.status !== 'pending') return { code: 'expired' };
      // Never retry browser mutations. A timeout becomes an unconfirmed result.
      const attempt = new AbortController();
      const signal = AbortSignal.any([this.abort.signal, attempt.signal]);
      try {
        return await withDeadline(() => this.source.submitAnswer(binding, index, {
          signal, isCurrent: () => !this.closed && this.current === binding && binding.status === 'pending',
        }), 15_000, () => attempt.abort(), signal);
      } catch (error) { return { code: 'unconfirmed', reason: error.message }; }
    });
    this.tail = operation.then(() => {}, () => {});
    const result = await operation;
    binding.status = result.code;
    for (const id of binding.messageIds) this.clearKeyboard(id);
    this.log('answer-result', { alertId: binding.id, option: String.fromCharCode(65 + index), result: result.code, reason: result.reason });
    if (!this.closed) this.notify(messageId, result.code, index);
  }
  disable(reason) {
    this.closed = true; this.abort.abort();
    if (this.current) this.finish(this.current, 'expired');
    this.queue.enqueue([{ method: 'sendMessage', params: { text: reason } }], 'answer-receiver-unavailable');
  }
  async close() {
    this.closed = true; this.abort.abort();
    const ids = this.current ? [...this.current.messageIds] : [];
    if (this.current) this.current.status = 'expired';
    await Promise.allSettled(ids.map((id) => this.telegram.call('editMessageReplyMarkup', {
      chat_id: this.telegram.chatId, message_id: id, reply_markup: { inline_keyboard: [] },
    }, { timeoutMs: 1500 })));
    await this.tail;
  }
}
