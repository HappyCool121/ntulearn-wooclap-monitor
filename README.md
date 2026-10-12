# NTULearn Wooclap → Telegram

[![CI](https://github.com/HappyCool121/ntulearn-wooclap-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/HappyCool121/ntulearn-wooclap-monitor/actions/workflows/ci.yml)

Monitor a Wooclap session embedded in your logged-in NTULearn Chrome tab. Receive an image alert in your private Telegram chat when a question appears.

- Checks the selected session every **10 seconds**.
- Captures the original question and answer choices without scrolling or changing your lecture tab.
- Recreates a readable card from the question's MathML if native capture fails or would cut off content.
- Suppresses repeated alerts for an unchanged question and reports prolonged monitoring outages.
- Uses deterministic DOM inspection. No AI API, paid inference service, or Telegram webhook is required.

![Synthetic example of a recreated mathematical question](docs/example-question.jpg)

This repository publishes the source code. Run the monitor on a computer with your own logged-in Chrome session and your own Telegram bot. GitHub does not run the lecture watcher for you. The current version supports **one private chat per process**. Group destinations, automatic subscriptions, and `/subscribe` commands are not implemented.

## Requirements

- Node.js **22 or newer**, with npm.
- Recent Google Chrome with `chrome://inspect/#remote-debugging` available, or an existing local Chrome DevTools Protocol endpoint.
- A logged-in NTULearn tab displaying the embedded Wooclap session.
- A Telegram account and a bot created through [BotFather](https://t.me/BotFather).

Tested locally on macOS. CI runs unit tests on Node 22/24 and isolated Chrome browser tests on Linux. Chrome channel attachment depends on your installed Chrome version and profile. The tool's default target host is `ntulearn.ntu.edu.sg`; standalone Wooclap tabs and other learning systems are not selected.

## Install

```bash
git clone https://github.com/HappyCool121/ntulearn-wooclap-monitor.git
cd ntulearn-wooclap-monitor
npm ci
```

Normal monitoring uses your installed Chrome, so it does not require downloading Playwright's bundled Chromium.

## Configure Telegram once

1. Open [BotFather](https://t.me/BotFather), send `/newbot`, and follow its prompts. The username must end in `bot`.
2. Keep the returned bot token private.
3. Open your new bot's chat and send `/start`.
4. Run:

   ```bash
   node src/cli.js setup
   ```

5. Paste your token into the hidden local prompt. Setup validates the bot, discovers private chats, lets you choose when several match, saves configuration, and sends a test message.

Settings are stored outside the repository at `~/.config/ntulearn-wooclap-monitor/config.json`, with `0600` file permissions on POSIX systems. Environment variables can override them. Setup reuses existing settings; edit that local file or use environment variables to change them.

Sending `/start` is a one-time setup step. It does not automatically subscribe other users or groups. Use a dedicated bot: setup preserves existing webhooks rather than removing another service's configuration. See [Telegram's official tutorial](https://core.telegram.org/bots/tutorial) for bot creation.

## Connect your Chrome tab

1. In Chrome, open `chrome://inspect/#remote-debugging`.
2. Enable **Allow remote debugging for this browser instance**.
3. Open your lecture in NTULearn and enter its Wooclap activity.
4. Run the checks below and approve Chrome's connection prompt if shown:

   ```bash
   node src/cli.js doctor
   node src/cli.js tabs
   ```

Playwright 1.64 attaches through `chromium.connectOverCDP('chrome', { noDefaults: true })`. It uses the existing login and leaves browser context settings alone. It does not read login credentials, copy cookies, or automate authentication.

For another configured local endpoint:

```bash
node src/cli.js --endpoint http://127.0.0.1:9222 tabs
```

The tool does not enable debugging or open a debugging port itself. An automation connection used by another application is separate from this standalone tool's connection. See [Playwright's connection guidance](https://playwright.dev/mcp/configuration/browser-extension).

## Run for each lecture

```bash
# Optional: inspect detection without sending Telegram messages.
node src/cli.js watch --dry-run

# Start alerts; stop with Ctrl+C.
node src/cli.js watch
```

Exactly one matching session is selected automatically. If several tabs match, choose one interactively. Confirm the lecture title and session code in the initial `watching` line.

To select explicitly, use a code or 1-based index from `tabs`:

```bash
node src/cli.js watch --session ABCDEF
node src/cli.js watch --tab 2
```

`ABCDEF` is a placeholder; replace it with your own session code. The index refers to a fresh `tabs` listing. If multiple tabs have the same code, use the index or interactive selection. After a disconnect, the tool only reacquires the selected session; it does not switch lectures automatically.

Start the watcher again for later lectures. Keep Chrome, the session tab, the terminal process, and your computer running and awake. On macOS you can prevent idle system sleep while watching:

```bash
caffeinate -i node src/cli.js watch
```

This does not prevent sleep when you close the laptop lid. Closing Terminal stops monitoring. If no matching session is open at startup, the command exits with an error; open it first, then rerun. `Ctrl+C` leaves your browser and tabs open and closes only the monitor's owned renderer.

## Commands

| Command | Behavior |
| --- | --- |
| `setup` | Hidden local token entry, private-chat discovery, save settings, send test alert |
| `doctor` | Check config, Telegram bot/chat access, Chrome, and matching tabs; send no messages |
| `tabs` | List NTULearn tabs with embedded Wooclap sessions |
| `watch` | Check the selected session and send question/outage alerts |
| `watch --dry-run` | Run detection and image capture without Telegram calls |
| `watch --once` | One check, finish queued delivery, then exit |
| `--help` | Show commands and flags |

Global flags: `--config <path>`, `--endpoint <channel-or-url>`, `--json`.
Watch flags: `--session <code>`, `--tab <number>`, `--interval <seconds>`, `--dry-run`, `--once`.

The default interval is 10 seconds; overrides must be at least one second. Checks do not overlap, so a slow read or capture can extend an interval.

## Configuration

Environment variables override saved settings. Explicit endpoint/interval flags override both.

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot token, configured locally |
| `TELEGRAM_CHAT_ID` | Numeric private chat ID |
| `NTULEARN_MONITOR_CONFIG` | Alternate config JSON path |
| `NTULEARN_CDP_ENDPOINT` | Chrome channel or existing CDP URL; default `chrome` |
| `NTULEARN_POLL_SECONDS` | Check interval; default `10` |

`config.example.json` documents the file shape and contains placeholders only. Keep live credential files outside this repository. Tokens are redacted from tool diagnostics; credential URLs are not printed.

Optional command installation:

```bash
npm link
ntulearn-watch --help
```

## Images and reliability

- A question already active at startup alerts immediately. Repeated checks of that question do not alert again. An observed waiting/results state rearms detection for another appearance.
- Visible question IDs take precedence for deduplication. Otherwise the tool hashes normalized content, excluding standalone timers and response counts. Loading and disconnection do not clear duplicate-suppression history.
- Native screenshots use direct Chrome capture to avoid element stability waits. They cover the question panel or Wooclap main area and may include any response visible there. Images remain in memory during normal monitoring.
- If native capture fails, is obscured, or would cut off content, a controlled headless renderer creates a question card from an immutable semantic snapshot. KaTeX's MathML is retained once, including fractions, powers, and inequalities. Recreated images are labeled in the caption.
- The renderer supports text/MathML questions. Image/video/unsupported graphical questions require a successful native screenshot; unsupported graphics are not silently omitted from recreated cards. The renderer blocks scripts and external resource requests.
- Native capture has a 2-second deadline, fallback rendering 5 seconds, and the combined image operation 8 seconds. Images are checked against Telegram photo limits.
- Each successful alert contains one image and a short lecture/time/link caption. If both image paths fail, or Telegram rejects the photo, a concise notice links to Wooclap. Detailed errors and alert IDs stay in Terminal.
- Delivery is queued independently of polling. Transient errors retry up to five times per part with backoff; Telegram rate limits are honored. Confirmed parts are not resent. A lost acknowledgment can still cause a duplicate, so exactly-once delivery is not guaranteed.
- The in-memory queue holds at most 100 alerts. Stopping discards pending deliveries and deduplication history. Restarting on an active question sends a fresh alert.
- After 60 seconds of unreadable/loading checks, the tool queues one outage notice and later one recovery notice. Network loss may also prevent those notices from arriving.
- Questions or waiting/reopen transitions entirely between checks can be missed. Sleep, offline Chrome, expired login, and DOM changes can interrupt detection. There is no historical question recovery.
- The event link contains no login query parameters. Opening it on another device may require joining or signing in there.

## JSON output

`--json` emits one JSON object per line with an `event` field. It never returns credentials.

```bash
node src/cli.js --json doctor
node src/cli.js --json tabs
node src/cli.js --json watch --session ABCDEF --dry-run --once
```

`doctor` returns `ready` and separate Telegram/Chrome checks. Its exit code is 1 when setup or a matching tab is missing. `tabs` returns a `tabs` array. `watch` emits selection, check, question, delivery, and health events. Question events include `screenshot`, `imageSource` (`native` or `recreated`), and capture diagnostics. Runtime failures emit an `error` event and exit nonzero. CLI argument/help/version output is handled by the parser; interactive setup does not support `--json`.

## Development and tests

```bash
npm ci
npm run check
npm test
npm run test:browser
```

Browser tests need installed Chrome. On a development/CI machine without Chrome, install it with:

```bash
npx playwright install --with-deps chrome
```

Unit tests cover state transitions, deduplication, configuration permissions, Telegram payloads/retries, image markup, timeouts, and cancellation. Browser tests use isolated temporary Chrome profiles and synthetic intercepted NTULearn/Wooclap pages. They cover cross-origin frames, moving panels, offscreen choices, overlays, MathML rendering, screenshots, reconnection behavior, and Ctrl+C. They do not use a real NTULearn account or send Telegram messages. All quiz examples and the preview image are synthetic.

To regenerate the synthetic preview:

```bash
NTULEARN_TEST_PREVIEW=docs/example-question.jpg npm run test:browser
```

Wooclap DOM changes may require updates to `src/detection.js`. Validate a live question in dry-run mode, then confirm its image reaches your own Telegram chat before relying on a session.

## License

[MIT](LICENSE).
