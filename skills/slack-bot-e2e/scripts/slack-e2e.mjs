#!/usr/bin/env node
import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

const USAGE = `Usage:
  slack-e2e.mjs send --text <text> [--file <path>]... [--thread <ts>] [--expect <regex>] [--timeout <seconds>]
  slack-e2e.mjs post --text <text> [--file <path>]... [--thread <ts>] [--deliver]
  slack-e2e.mjs read --thread <ts>
  slack-e2e.mjs whoami

Env: SLACK_E2E_BOT_TOKEN, SLACK_E2E_SIGNING_SECRET, SLACK_E2E_CHANNEL_ID, SLACK_E2E_USER_ID,
     SLACK_E2E_EVENTS_URL (send and post --deliver). Optional: SLACK_API_URL.`;

const fail = (message, code = 2) => {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(code);
};

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    deliver: { type: "boolean" },
    expect: { type: "string" },
    file: { multiple: true, type: "string" },
    text: { default: "", type: "string" },
    thread: { type: "string" },
    timeout: { default: "180", type: "string" },
  },
});

const env = (name) => process.env[name] || fail(`${name} is not set.`);
const botToken = env("SLACK_E2E_BOT_TOKEN");
const channel = env("SLACK_E2E_CHANNEL_ID");
const slackApi = (process.env.SLACK_API_URL || "https://slack.com/api").replace(/\/+$/u, "");

const slack = async (method, fields) => {
  const response = await fetch(`${slackApi}/${method}`, {
    body: new URLSearchParams(fields),
    headers: { Authorization: `Bearer ${botToken}` },
    method: "POST",
  });
  const body = await response.json();
  return body.ok ? body : fail(`Slack ${method}: ${body.error}`);
};

const poll = async (attempts, ms, probe) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await probe();
    if (value !== undefined) return value;
    await sleep(ms);
  }
};

const identity = async () => {
  const auth = await slack("auth.test", {});
  const bot = auth.bot_id ? (await slack("bots.info", { bot: auth.bot_id })).bot : undefined;
  return { appId: bot?.app_id, botUserId: auth.user_id, teamId: auth.team_id };
};

const sharedFile = async (id) =>
  (await poll(30, 1000, async () => {
    const { file } = await slack("files.info", { file: id });
    const share = [
      ...(file.shares?.public?.[channel] ?? []),
      ...(file.shares?.private?.[channel] ?? []),
    ].at(-1);
    return share && file.url_private ? { file, share } : undefined;
  })) ?? fail(`Slack never shared file ${id} in ${channel}.`);

const upload = async (file) => {
  const bytes = await readFile(file);
  const staged = await slack("files.getUploadURLExternal", {
    filename: path.basename(file),
    length: String(bytes.length),
  });
  const sent = await fetch(staged.upload_url, { body: bytes, method: "POST" });
  return sent.ok ? staged.file_id : fail(`Upload of ${file} failed with HTTP ${sent.status}.`);
};

const post = async (text, files, threadTs) => {
  if (files.length === 0) {
    const { ts } = await slack("chat.postMessage", {
      channel,
      text,
      ...(threadTs && { thread_ts: threadTs }),
    });
    return { files: [], threadTs: threadTs ?? ts, ts };
  }
  const ids = await Promise.all(files.map(upload));
  await slack("files.completeUploadExternal", {
    channel_id: channel,
    files: JSON.stringify(ids.map((id) => ({ id }))),
    initial_comment: text,
    ...(threadTs && { thread_ts: threadTs }),
  });
  const shared = await Promise.all(ids.map(sharedFile));
  const { share } = shared[0];
  return {
    files: shared.map(({ file }) => file),
    threadTs: threadTs ?? share.thread_ts ?? share.ts,
    ts: share.ts,
  };
};

const read = async (threadTs) =>
  (await slack("conversations.replies", { channel, limit: "200", ts: threadTs })).messages;

const deliver = async (app, posted, text, type) => {
  const eventId = `EvE2E${randomUUID().replaceAll("-", "")}`;
  const body = JSON.stringify({
    api_app_id: app.appId,
    event: {
      channel,
      event_ts: posted.ts,
      text,
      ts: posted.ts,
      type,
      ...(type === "message" && { channel_type: "channel" }),
      user: env("SLACK_E2E_USER_ID"),
      user_team: app.teamId,
      ...(posted.threadTs !== posted.ts && { thread_ts: posted.threadTs }),
      ...(posted.files.length > 0 && { files: posted.files }),
    },
    event_id: eventId,
    event_time: Math.floor(Date.now() / 1000),
    team_id: app.teamId,
    type: "event_callback",
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", env("SLACK_E2E_SIGNING_SECRET"))
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  const response = await fetch(env("SLACK_E2E_EVENTS_URL"), {
    body,
    headers: {
      "Content-Type": "application/json",
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": `v0=${signature}`,
    },
    method: "POST",
  });
  if (!response.ok) fail(`Events URL returned HTTP ${response.status}: ${await response.text()}`);
  return eventId;
};

const pick = ({ files, reactions, streaming_state, text, ts, user }) => ({
  files: files?.map((file) => file.name),
  reactions,
  streaming_state,
  text,
  ts,
  user,
});
const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

const send = async () => {
  const app = await identity();
  const text = `<@${app.botUserId}> ${values.text}`.trim();
  const mention = await post(text, values.file ?? [], values.thread);
  const eventId = await deliver(app, mention, text, "app_mention");
  let seen = "";
  const replies =
    (await poll(Number(values.timeout) / 3, 3000, async () => {
      const found = (await read(mention.threadTs)).filter(
        (message) => message.user === app.botUserId && Number(message.ts) > Number(mention.ts),
      );
      const streaming = found.some((message) => message.streaming_state === "in_progress");
      const current = JSON.stringify(found.map(({ text: body, ts }) => [ts, body]));
      const stable = found.length > 0 && !streaming && current === seen;
      seen = current;
      return stable ? found : undefined;
    })) ?? [];
  const reply = replies.map((message) => message.text ?? "").join("\n");
  const failures = [
    ...(replies.length === 0 ? [`no settled reply within ${values.timeout}s`] : []),
    ...(values.expect && !new RegExp(values.expect, "iu").test(reply)
      ? [`reply does not match /${values.expect}/`]
      : []),
  ];
  print({
    eventId,
    failures,
    passed: failures.length === 0,
    replies: replies.map(pick),
    threadTs: mention.threadTs,
    ts: mention.ts,
  });
  process.exitCode = failures.length === 0 ? 0 : 1;
};

const [command] = positionals;
if (command === "send") {
  await send();
} else if (command === "post") {
  const posted = await post(values.text, values.file ?? [], values.thread);
  const eventId = values.deliver
    ? await deliver(await identity(), posted, values.text, "message")
    : undefined;
  print({ eventId, files: posted.files.map((file) => file.id), threadTs: posted.threadTs, ts: posted.ts });
} else if (command === "read") {
  print((await read(values.thread ?? fail("--thread is required."))).map(pick));
} else if (command === "whoami") {
  print({ ...(await identity()), channel, eventsUrl: process.env.SLACK_E2E_EVENTS_URL });
} else {
  fail(`Unknown command ${command ?? ""}.`);
}
