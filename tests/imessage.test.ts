import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { IMessageChannel, type IMessageEvent } from "../src/channels/imessage/channel.ts";
import { openMessagesDb, sameHandle, textFromAttributedBody, validHandle, type MessageRow, type MessagesDb } from "../src/channels/imessage/messages.ts";
import type { Responder } from "../src/channels/reply-loop.ts";

const ME = "+1 (416) 555-0123";

/** An archived NSAttributedString, cut down to what the decoder reads. */
function archived(text: string): Uint8Array {
  const utf8 = Buffer.from(text, "utf8");
  const length = utf8.length < 0x80 ? Buffer.from([utf8.length]) : Buffer.concat([Buffer.from([0x81]), Buffer.from([utf8.length & 0xff, utf8.length >> 8])]);
  return Buffer.concat([Buffer.from("\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString", "latin1"), Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]), length, utf8, Buffer.from([0x86, 0x84])]);
}

test("text hidden in attributedBody is read back, short or long", () => {
  expect(textFromAttributedBody(archived("我昨晚睡得如何"))).toBe("我昨晚睡得如何");
  const long = "sleep ".repeat(60);
  expect(textFromAttributedBody(archived(long))).toBe(long);
  expect(textFromAttributedBody(new Uint8Array([1, 2, 3]))).toBeNull();
});

test("handles match across phone formats, and emails exactly", () => {
  expect(sameHandle("+14165550123", ME)).toBe(true);
  expect(sameHandle("4165550123", ME)).toBe(true);
  expect(sameHandle("+14165550124", ME)).toBe(false);
  expect(sameHandle("Rick@Example.com", "rick@example.com")).toBe(true);
  expect(sameHandle("rick@example.com", "+14165550123")).toBe(false);
  expect(validHandle(ME) && validHandle("rick@example.com")).toBe(true);
  expect(validHandle("rick")).toBe(false);
});

test("the database reader returns texts from others in one-to-one chats only", () => {
  const path = join(mkdtempSync(join(tmpdir(), "chatdb-")), "chat.db");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, style INTEGER);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB, is_from_me INTEGER, handle_id INTEGER, associated_message_type INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    INSERT INTO handle VALUES (1, '+14165550123');
    INSERT INTO chat VALUES (1, 45), (2, 43);`);
  const add = (id: number, o: { text?: string | null; body?: Uint8Array; fromMe?: number; chat?: number; reaction?: number; attachments?: number }) => {
    db.prepare("INSERT INTO message (ROWID, text, attributedBody, is_from_me, handle_id, associated_message_type, cache_has_attachments) VALUES (?, ?, ?, ?, 1, ?, ?)").run(id, o.text ?? null, o.body ?? null, o.fromMe ?? 0, o.reaction ?? 0, o.attachments ?? 0);
    db.prepare("INSERT INTO chat_message_join VALUES (?, ?)").run(o.chat ?? 1, id);
  };
  add(1, { text: "old" });
  const messages = openMessagesDb(path);
  expect(messages.latestId()).toBe(1);
  add(2, { text: "how did I sleep" });
  add(3, { body: archived("and today?") });
  add(4, { text: "mine", fromMe: 1 });
  add(5, { text: "group", chat: 2 });
  add(6, { text: "Loved “how did I sleep”", reaction: 2000 });
  add(7, { text: "￼", attachments: 1 });
  expect(messages.since(1)).toEqual([
    { id: 2, handle: "+14165550123", text: "how did I sleep", attachments: false },
    { id: 3, handle: "+14165550123", text: "and today?", attachments: false },
    { id: 7, handle: "+14165550123", text: "", attachments: true },
  ]);
});

/** A channel over an in-memory inbox, answering with "reply to <text>". */
function channel(o: { mode?: "auto" | "draft"; failSend?: boolean } = {}) {
  let rows: MessageRow[] = [{ id: 1, handle: "+14165550123", text: "before start", attachments: false }];
  const db: MessagesDb = { latestId: () => rows.at(-1)?.id ?? 0, since: (id) => rows.filter((r) => r.id > id) };
  const heard: string[] = [];
  const sent: string[] = [];
  const events: IMessageEvent[] = [];
  const responder: Responder = {
    handle: async ({ text }) => (heard.push(text), { reply: { bubbles: [`reply to ${text}`] }, commit: () => {}, memory: Promise.resolve(null) }),
  };
  const c = new IMessageChannel({
    db,
    send: async (_to, text) => {
      if (o.failSend) throw new Error("not signed in");
      sent.push(text);
    },
    responder,
    handle: ME,
    mode: o.mode ?? "auto",
    attachmentNote: "(photo)",
    onEvent: (e) => events.push(e),
    sleep: async () => {},
    burstWindowMs: 0,
  });
  let next = 2;
  const arrive = (text: string, handle = "+14165550123", attachments = false) => (rows = [...rows, { id: next++, handle, text, attachments }]);
  return { c, arrive, heard, sent, events };
}

test("texts already there are never answered; new ones from the bound person are, and nobody else's", async () => {
  const { c, arrive, heard, sent } = channel();
  c.poll();
  arrive("how did I sleep");
  arrive("hi", "+19995550000");
  c.poll();
  await c.settle();
  expect(heard).toEqual(["how did I sleep"]);
  expect(sent).toEqual(["reply to how did I sleep"]);
});

test("the agent's own reply echoed back (texting yourself) is never answered", async () => {
  const { c, arrive, heard } = channel();
  c.poll();
  arrive("hello");
  c.poll();
  await c.settle();
  arrive("reply to hello");
  c.poll();
  await c.settle();
  expect(heard).toEqual(["hello"]);
});

test("a photo is noted for the agent, draft mode sends nothing, and a failed send is reported", async () => {
  const photo = channel();
  photo.c.poll();
  photo.arrive("", undefined, true);
  photo.c.poll();
  await photo.c.settle();
  expect(photo.heard).toEqual(["(photo)"]);

  const draft = channel({ mode: "draft" });
  draft.c.poll();
  draft.arrive("hi");
  draft.c.poll();
  await draft.c.settle();
  expect(draft.sent).toEqual([]);
  expect(draft.events.some((e) => e.type === "drafted")).toBe(true);

  const broken = channel({ failSend: true });
  broken.c.poll();
  broken.arrive("hi");
  broken.c.poll();
  await broken.c.settle();
  expect(broken.events.find((e) => e.type === "send_failed")).toMatchObject({ message: "not signed in" });
});

test("too many turns in a minute pauses replies", async () => {
  const { c, arrive, events } = channel();
  c.poll();
  for (let i = 0; i < 8; i++) {
    arrive(`message ${i}`);
    c.poll();
    await c.settle();
  }
  expect(c.paused).toBe(true);
  expect(events.some((e) => e.type === "skipped")).toBe(true);
});
