---
name: slack-bot-e2e
description: End-to-end test any Slack bot through a real Slack test channel. Posts a message (with files, in threads) that mentions the bot, delivers a correctly signed app_mention or message event to the bot's Events API URL as a chosen user, waits for the bot's reply in Slack and checks it against a regex. Use when a change touches how a Slack bot receives events, reads threads or files, or replies, or when asked for a Slack e2e, a Slack smoke test, or "test it in Slack". Works with any HTTP Events API bot (Bolt, custom, local or deployed); not for Socket Mode.
---

# Slack bot e2e

`scripts/slack-e2e.mjs` drives a Slack bot through the real Slack path with no person at the keyboard. It needs only Node 20+ and no dependencies.

A Slack app cannot trigger its own `app_mention`. `send` therefore posts the visible message with the bot's own token, then signs an `app_mention` event for that message with the app's signing secret, as `SLACK_E2E_USER_ID`, and POSTs it to the bot's Events API URL. The bot cannot tell it apart from a real event. Everything after that is real: the bot's handler, its thread and file reads from Slack, and the reply it posts back, which the script reads from the thread.

## Set up

1. Create or reuse a dedicated test Slack app and a test channel. Invite the bot to the channel. Never point this at a production channel: every command posts real messages.
2. The bot token needs `chat:write`, `files:write`, `files:read` and `channels:history` (`groups:history` for a private channel).
3. Run the bot under test so its Events API endpoint is reachable from this machine (for example `http://localhost:3000/slack/events`). Localhost works: the script posts the event itself, so no tunnel is needed.
4. Export the variables, or keep them in a `.env` and run with `node --env-file=.env`:

   | Variable | Value |
   | --- | --- |
   | `SLACK_E2E_BOT_TOKEN` | the bot under test's `xoxb-` token |
   | `SLACK_E2E_SIGNING_SECRET` | that app's signing secret |
   | `SLACK_E2E_CHANNEL_ID` | test channel ID (`C…`) |
   | `SLACK_E2E_USER_ID` | the human user the events claim to come from (`U…`) |
   | `SLACK_E2E_EVENTS_URL` | the bot's Events API URL |

5. Run `whoami` to confirm the token resolves to the expected bot, team and app.

## Commands

`S` is this skill's `scripts/slack-e2e.mjs`.

```bash
node S whoami
node S send --text "Total revenue in the attached CSV?" --file /tmp/sales.csv --expect "\\b400\\b"
node S post --text "The launch code is PELICAN" --deliver
node S send --thread <threadTs> --text "What is the launch code?" --expect pelican
node S read --thread <threadTs>
```

- `send` prefixes `<@bot>`, posts, delivers a signed `app_mention`, then polls the thread until the bot's replies after the mention stop changing and none is still streaming. It prints JSON with `eventId`, `ts`, `threadTs`, `replies`, `failures` and `passed`, and exits 1 on no reply within `--timeout` seconds (default 180) or a reply that does not match `--expect` (case-insensitive regex over all replies joined).
- `post` posts without a mention, to set up thread context. `--deliver` also sends a signed `message` event, for bots that capture channel history from events. Use its `threadTs` with `--thread` on the next `send` for a same-thread check.
- `read` prints every message in a thread with its user, files, reactions and streaming state.

## Writing a check

- Make the answer impossible to guess: exact numbers from a fixture, a code inside an image, a word only the thread contains.
- One behaviour per `send`. Put context in the thread with `post` first rather than in the mention.
- Read `failures` and the bot's own logs before changing anything.
- Paste the JSON of each passing check into the PR as evidence.

## Limits

- Only the event delivery is synthetic. Slack's retries, Event Subscriptions URL verification and button clicks (interactivity payloads) need a person and a public URL.
- The fake event carries the message's real `ts` and `files`, but `user` is whatever `SLACK_E2E_USER_ID` says; Slack itself shows the message as posted by the bot.
- Socket Mode bots have no HTTP endpoint, so `send` cannot reach them.
- Replies are matched by the bot's user ID, so a bot that replies with a different token or as another user is not seen.
