# Plan: Automatic Telegram group destinations

## Goal

Send question alerts to every group that adds the bot, with persistent automatic registration and removal.

## Context

The user authorizes automatic delivery to all groups that add the bot. Preserve the configured private destination and disabled answer submission. Group membership must survive restarts and optional suggestions must run once per question.

## Research Summary

Telegram Bot API documentation confirms `my_chat_member` reports changes to the bot's membership. `getUpdates` retains pending updates for at most 24 hours and supports explicit allowed update types. A group `/start@bot` can recover registration when a join update has expired. Official docs: https://core.telegram.org/bots/api#getting-updates . Webfetch/Context7 tools are unavailable; the official API was read with the available web tool. No dependency changes are needed.

## Constraints

- Preserve configuration and private delivery, public helper interfaces, and answer submission restrictions.
- Keep changes additive and reversible, with no new dependencies.
- Persist IDs and update offsets atomically outside the repository, scoped to the bot.
- Run one receiver per bot and preserve existing webhooks.

## Out of Scope

Hosted deployment, unrelated refactoring, automatic answering, and changes to Luna generation. Private subscriptions are authorized in the 2026-10-19 extension below.

## Reversibility

The existing configuration remains valid. Group state is stored separately; reverting source restores single-destination behavior without deleting credentials or legacy helpers.

---

## Step A: Persistent group registration

### Status

`done`

### Objective

Register and remove groups from Telegram updates with a listener that works independently of Chrome.

### Tasks

- [x] Add atomic group state and durable update offsets, with startup membership verification.
- [x] Handle bot joins, removals, group migrations, and group start recovery.
- [x] Add listener lifecycle, exclusive polling, and offline update processing.

### Relevant Files

`src/groups.js`, `src/telegram-receiver.js`, `src/cli.js`, `test/groups.test.js`

### Expected Changes

Create group registry/listener and tests; integrate existing receiver locking and CLI.

### Do Not Modify

Credentials, external chats during tests, and answer submission behavior.

### Commands

```bash
node --test test/groups.test.js
```

### Acceptance Criteria

- [x] Joined groups persist; removal and migrations update destinations.
- [x] Offline updates are processed and persisted before acknowledgment.
- [x] Listener works without Chrome and refuses concurrent pollers/webhooks.

### Validation Results

Passed through the final full validation: `npm run check`, `npm test` (98/98), `npm run test:browser` (23/23), and `git diff --check`. Focused group and suggestion tests also passed.

### Findings / Notes

Existing receiver locking can be reused without changing legacy answer filtering.

---

## Step B: Broadcast alerts and share suggestions

### Status

`done`

### Objective

Deliver each alert independently to all current destinations and edit each confirmed message with one generated answer.

### Tasks

- [x] Snapshot destinations and bind fallback delivery/edits to the correct chat.
- [x] Skip departed groups and isolate delivery failures.
- [x] Generate once and share results with early and late delivery receipts.
- [x] Integrate default watching and standalone group listener.

### Relevant Files

`src/telegram.js`, `src/monitor.js`, `src/cli.js`, `test/monitor-suggestions.test.js`, `test/browser.integration.js`

### Expected Changes

Extend delivery queue, monitor receipt handling, CLI, and focused integration tests.

### Do Not Modify

Luna generation internals, browser submission helpers, and browser ownership behavior.

### Commands

```bash
node --test test/monitor-suggestions.test.js test/telegram.test.js
```

### Acceptance Criteria

- [x] Multiple groups get independently bound alerts and suggestion edits.
- [x] One generation serves all destinations, including delayed/fallback delivery.
- [x] Basic and dry-run modes preserve disabled inference and submission.

### Validation Results

Passed through the final full validation: `npm run check`, `npm test` (98/98), `npm run test:browser` (23/23), and `git diff --check`. Focused group and suggestion tests also passed.

### Findings / Notes

Use one shared bounded delivery queue to respect Telegram rate limits.

---

## Step C: Final verification and cleanup

### Status

`done`

### Objective

Verify all changed paths and document activation and offline limits.

### Tasks

- [x] Update README and syntax-check coverage.
- [x] Run relevant unit and isolated browser suites.
- [x] Review diff, remove temporary code and stale comments, and record limitations.

### Relevant Files

`README.md`, `package.json`, changed source and tests, `PLAN.md`

### Expected Changes

Documentation and completed validation records.

### Do Not Modify

Live Telegram messages, bot configuration, or user browser tabs.

### Commands

```bash
npm run check
npm test
npm run test:browser
git diff --check
```

### Acceptance Criteria

- [x] Relevant suites pass; remaining limitations are documented.
- [x] Final diff contains no unintended changes or credentials.

### Validation Results

Passed through the final full validation: `npm run check`, `npm test` (98/98), `npm run test:browser` (23/23), and `git diff --check`. Focused group and suggestion tests also passed.

### Findings / Notes

Real group delivery requires a running watcher and group membership. Tests used fake Telegram/Codex and an isolated Chrome profile; no live Telegram messages were sent. Final source/docs diff reviewed; no temporary debugging files or credentials added. Destination deliveries/edits remain bounded to 100 pending items; overflow is logged. Pending membership updates expire after 24 hours; group `/start@bot` recovers missed joins. Local receiver locks protect processes sharing the configuration directory; Telegram conflicts stop competing pollers across other directories/hosts.

---

## Follow-up Work

The original group work is complete. Private subscriptions are implemented by the 2026-10-19 extension below; hosting remains out of scope.

## Decision Log

| Date | Decision | Rationale | Impact |
| --- | --- | --- | --- |
| 2026-10-14 | Save bot-scoped groups in local JSON and preserve the configured private chat | The user wants automatic group delivery without database infrastructure | No new dependency or paid service |
| 2026-10-14 | Generate one suggestion per question | Every destination receives the same captured question | No multiplication of inference usage |


---

## Step D: Private subscription extension (2026-10-19)

### Status

`done`

### Objective

Allow people to privately send /start to subscribe and /stop to unsubscribe while the watcher runs, with durable preferences across restarts.

### Tasks

- [x] Extend the existing atomic bot-scoped state with private subscriber preferences; accept existing group files.
- [x] Process private start/stop commands, blocked bot updates, and forbidden delivery failures without affecting groups.
- [x] Send confirmations through the delivery queue even after unsubscribing, and skip queued alerts/edits for removed subscribers.
- [x] Update CLI help, README, and behavioral tests.

### Relevant Files

`src/groups.js`, `src/telegram.js`, `src/cli.js`, `test/groups.test.js`, `test/browser.integration.js`, `README.md`, `CLAUDE.md`

### Expected Changes

Add private preferences alongside groups; reuse fanout, polling lock, update offsets, and shared suggestions without dependencies.

### Do Not Modify

Live credentials, live state, the running watcher process, user Chrome tabs, answer submission, and Luna internals.

### Commands

```bash
node --test test/groups.test.js test/telegram.test.js
npm run check
npm test
npm run test:browser
git diff --check
```

### Acceptance Criteria

- [x] Start/stop works during an updated watcher run, persists, and de-duplicates the configured private chat.
- [x] Explicit stop also suppresses the configured private destination; another start restores it.
- [x] Blocking/forbidden delivery disables private alerts; unblocking alone does not resubscribe.
- [x] Existing groups and suggestion broadcasts still work; tests use fake Telegram only.

### Validation Results

`node --test test/groups.test.js test/telegram.test.js`: 32/32 passed. `npm run check`: passed. `npm test`: 102/102 passed. `npm run test:browser`: 23/23 passed, including fake private subscriber plus group question delivery and shared suggestion edits. `git diff --check`: passed. Diff reviewed; no live Telegram calls or running watcher changes.

### Findings / Notes

Official Telegram API https://core.telegram.org/bots/api#getting-updates confirms message and my_chat_member updates use the existing poller, with a maximum 24-hour offline retention. Dedicated webfetch/Context7 tools are unavailable; official docs were read with web. Preserve existing groups JSON format by adding an optional privateChats map. Existing process PID 22204 runs watch --suggestions and has no hot reload: one restart is needed to activate new source. Keep it running during edits/testing. The prior plan is retained as subscription implementation history.

## Step E: Final verification and cleanup

### Status

`done`

### Objective

Validate private subscription delivery and document activation clearly.

### Tasks

- [x] Run the commands in Step D, review the final diff, and remove stale behavioral documentation.
- [x] Record results and explain the required restart and subscription commands.

### Relevant Files

All files listed in Step D and `PLAN.md`.

### Expected Changes

Completed validation records and user instructions.

### Do Not Modify

Live running process, credentials, Telegram chats, and browser sessions.

### Commands

```bash
npm run check
npm test
npm run test:browser
git diff --check
```

### Acceptance Criteria

- [x] Validation passes and no unrelated changes or live calls occur.
- [x] Activation instructions distinguish the running old process from updated source.

### Validation Results

`node --test test/groups.test.js test/telegram.test.js`: 32/32 passed. `npm run check`: passed. `npm test`: 102/102 passed. `npm run test:browser`: 23/23 passed, including fake private subscriber plus group question delivery and shared suggestion edits. `git diff --check`: passed. Diff reviewed; no live Telegram calls or running watcher changes.

### Findings / Notes

An in-flight delivery can finish before /stop is processed; subsequent queued deliveries must be skipped. No historical questions are replayed to a newly registered subscriber.

## Follow-up Work (private subscriptions)

Restart the user's watcher once to load the change; no automatic restart or live messaging during implementation.

## Decision Log (private subscriptions)

| Date | Decision | Rationale | Impact |
| --- | --- | --- | --- |
| 2026-10-19 | Reuse group listener and bot-scoped atomic state for private /start and /stop | Supports subscriptions during a run without a second competing poller | One restart activates the feature; future subscriptions need no restart |
| 2026-10-19 | Explicit stop overrides configured private delivery in automatic mode | Unsubscribe must stop future alerts even for the configured recipient | --no-auto-groups remains the explicit single configured destination mode |
