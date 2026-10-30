import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const script = fileURLToPath(
  new URL("../skills/slack-bot-e2e/scripts/slack-e2e.mjs", import.meta.url),
);
const SECRET = "test-signing-secret";
const BOT = "UBOT";
const HUMAN = "UHUMAN";

let base;
let server;
let messages = [];
let events = [];
let nextTs = 1000;
const files = new Map();

const fakeSlack = async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const json = (value) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value));
  };
  const fields = Object.fromEntries(new URLSearchParams(body));
  const ts = () => String((nextTs += 1));

  if (req.url === "/events") {
    const stamp = req.headers["x-slack-request-timestamp"];
    const expected = `v0=${createHmac("sha256", SECRET).update(`v0:${stamp}:${body}`).digest("hex")}`;
    if (req.headers["x-slack-signature"] !== expected) {
      res.statusCode = 401;
      return res.end("invalid signature");
    }
    const { event } = JSON.parse(body);
    events.push(event);
    if (event.type === "app_mention") {
      const thread = event.thread_ts ?? event.ts;
      const context = messages.filter((message) => message.thread === thread);
      const names = (event.files ?? []).map((file) => file.name).join(",");
      setTimeout(() => {
        messages.push({
          text: `seen ${context.length} from ${event.user} files=${names}`,
          thread,
          ts: ts(),
          user: BOT,
        });
      }, 200);
    }
    return res.end("");
  }
  if (req.url.startsWith("/upload/")) {
    files.get(req.url.split("/").pop()).size = body.length;
    return res.end("ok");
  }

  switch (req.url.split("/").pop()) {
    case "auth.test":
      return json({ bot_id: "B1", ok: true, team_id: "T1", user_id: BOT });
    case "bots.info":
      return json({ bot: { app_id: "A1" }, ok: true });
    case "chat.postMessage": {
      const at = ts();
      messages.push({ text: fields.text, thread: fields.thread_ts ?? at, ts: at, user: BOT });
      return json({ ok: true, ts: at });
    }
    case "files.getUploadURLExternal": {
      const id = `F${files.size + 1}`;
      files.set(id, { id, name: fields.filename });
      return json({ file_id: id, ok: true, upload_url: `${base}/upload/${id}` });
    }
    case "files.completeUploadExternal": {
      const at = ts();
      const shared = JSON.parse(fields.files).map(({ id }) => files.get(id));
      messages.push({
        files: shared,
        text: fields.initial_comment,
        thread: fields.thread_ts ?? at,
        ts: at,
        user: BOT,
      });
      for (const file of shared) {
        file.shares = { public: { C1: [{ ts: at, ...(fields.thread_ts && { thread_ts: fields.thread_ts }) }] } };
        file.url_private = `${base}/files/${file.id}`;
      }
      return json({ ok: true });
    }
    case "files.info":
      return json({ file: files.get(fields.file), ok: true });
    case "conversations.replies":
      return json({ messages: messages.filter((message) => message.thread === fields.ts), ok: true });
    default:
      return json({ error: "unknown_method", ok: false });
  }
};

const run = async (args, env = {}) => {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [script, ...args], {
      env: {
        ...process.env,
        SLACK_API_URL: `${base}/api`,
        SLACK_E2E_BOT_TOKEN: "xoxb-test",
        SLACK_E2E_CHANNEL_ID: "C1",
        SLACK_E2E_EVENTS_URL: `${base}/events`,
        SLACK_E2E_SIGNING_SECRET: SECRET,
        SLACK_E2E_USER_ID: HUMAN,
        ...env,
      },
    });
    return { code: 0, out: JSON.parse(stdout) };
  } catch (error) {
    return { code: error.code, err: error.stderr, out: error.stdout && JSON.parse(error.stdout) };
  }
};

before(async () => {
  server = createServer(fakeSlack);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test("whoami resolves the bot, team and app from the token", async () => {
  const { code, out } = await run(["whoami"]);
  assert.equal(code, 0);
  assert.deepEqual(
    { appId: out.appId, botUserId: out.botUserId, teamId: out.teamId },
    { appId: "A1", botUserId: BOT, teamId: "T1" },
  );
});

test("send delivers a signed app_mention as the test user and passes on a matching reply", async () => {
  const { code, out } = await run(["send", "--text", "hello", "--expect", `from ${HUMAN}`]);
  assert.equal(code, 0);
  assert.equal(out.passed, true);
  assert.equal(out.replies.length, 1);
  const event = events.at(-1);
  assert.equal(event.type, "app_mention");
  assert.equal(event.user, HUMAN);
  assert.equal(event.text, `<@${BOT}> hello`);
});

test("send fails when the reply does not match --expect", async () => {
  const { code, out } = await run(["send", "--text", "hello", "--expect", "never-said"]);
  assert.equal(code, 1);
  assert.deepEqual(out.failures, ["reply does not match /never-said/"]);
});

test("send uploads files and passes them on the event", async () => {
  const fixture = path.join(tmpdir(), `slack-bot-e2e-${process.pid}.csv`);
  await writeFile(fixture, "region,revenue\nnorth,400\n");
  const { code, out } = await run(["send", "--text", "sum it", "--file", fixture, "--expect", "files=slack-bot-e2e"]);
  assert.equal(code, 0, JSON.stringify(out));
  assert.equal(events.at(-1).files[0].name, path.basename(fixture));
});

test("post --deliver seeds thread context the next send can see", async () => {
  const seeded = await run(["post", "--text", "the code is PELICAN", "--deliver"]);
  assert.equal(seeded.code, 0);
  assert.equal(events.at(-1).type, "message");
  const { code, out } = await run(["send", "--thread", seeded.out.threadTs, "--text", "code?", "--expect", "seen 2"]);
  assert.equal(code, 0, JSON.stringify(out));
  assert.equal(out.threadTs, seeded.out.threadTs);
});

test("read prints the thread", async () => {
  const seeded = await run(["post", "--text", "just context"]);
  const { code, out } = await run(["read", "--thread", seeded.out.threadTs]);
  assert.equal(code, 0);
  assert.deepEqual(out.map((message) => message.text), ["just context"]);
});

test("a wrong signing secret is rejected by the bot and exits 2", async () => {
  const { code, err } = await run(["send", "--text", "hello"], { SLACK_E2E_SIGNING_SECRET: "wrong" });
  assert.equal(code, 2);
  assert.match(err, /HTTP 401/u);
});

test("a missing variable exits 2 with usage", async () => {
  const { code, err } = await run(["whoami"], { SLACK_E2E_BOT_TOKEN: "" });
  assert.equal(code, 2);
  assert.match(err, /SLACK_E2E_BOT_TOKEN is not set/u);
});
