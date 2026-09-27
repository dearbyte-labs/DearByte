// The Mac's Messages app: read new texts from its database (read-only) and
// send through AppleScript. Reading needs Full Disk Access for the terminal;
// the first send asks for permission to control Messages.

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const CHAT_DB = join(homedir(), "Library/Messages/chat.db");

/** One text someone else sent, in a one-to-one chat. */
export type MessageRow = { id: number; handle: string; text: string; attachments: boolean };

export interface MessagesDb {
  /** The newest message id: everything up to it counts as already there. */
  latestId(): number;
  /** Messages from others in one-to-one chats, after `id`, oldest first. */
  since(id: number): MessageRow[];
}

/** One-to-one chats; groups are 43. */
const ONE_TO_ONE = 45;
/** U+FFFC stands in for an attachment inside the text. */
const OBJECT_MARK = /￼/g;

export function openMessagesDb(path = CHAT_DB): MessagesDb {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.prepare("SELECT 1 FROM message LIMIT 1").get();
  } catch (err) {
    const message = (err as Error).message;
    if (/authori[sz]ation denied|not permitted|unable to open/i.test(message))
      throw new Error(
        "Can't read Messages: give your terminal app Full Disk Access (System Settings → Privacy & Security → Full Disk Access), then restart the terminal.",
      );
    throw err;
  }
  const latest = db.prepare("SELECT COALESCE(MAX(ROWID), 0) AS id FROM message");
  const since = db.prepare(
    `SELECT m.ROWID AS id, h.id AS handle, m.text AS text, m.attributedBody AS body, m.cache_has_attachments AS attachments
       FROM message m
       JOIN handle h ON h.ROWID = m.handle_id
       JOIN chat_message_join cm ON cm.message_id = m.ROWID
       JOIN chat c ON c.ROWID = cm.chat_id
      WHERE m.ROWID > ? AND m.is_from_me = 0 AND m.associated_message_type = 0 AND m.item_type = 0 AND c.style = ${ONE_TO_ONE}
      ORDER BY m.ROWID`,
  );
  return {
    latestId: () => Number((latest.get() as { id: number }).id),
    since: (id) =>
      (since.all(id) as Array<{ id: number; handle: string; text: string | null; body: Uint8Array | null; attachments: number }>).map((r) => ({
        id: Number(r.id),
        handle: r.handle,
        text: (r.text ?? (r.body ? textFromAttributedBody(r.body) : null) ?? "").replace(OBJECT_MARK, "").trim(),
        attachments: Boolean(r.attachments),
      })),
  };
}

/**
 * Newer macOS versions leave `text` empty and keep it in `attributedBody`, an
 * archived NSAttributedString. The string follows the NSString class name: a
 * length (one byte, or 0x81 + two bytes, or 0x82 + four bytes, little-endian),
 * then UTF-8.
 */
export function textFromAttributedBody(body: Uint8Array): string | null {
  const buf = Buffer.from(body);
  const marker = buf.indexOf("NSString");
  if (marker < 0) return null;
  let i = marker + "NSString".length + 5;
  if (i >= buf.length) return null;
  let length = buf[i++];
  if (length === 0x81) {
    length = buf.readUInt16LE(i);
    i += 2;
  } else if (length === 0x82) {
    length = buf.readUInt32LE(i);
    i += 4;
  }
  return buf.subarray(i, i + length).toString("utf8");
}

/** A phone number or an Apple ID email, in the form handles are compared in. */
export function normalizeHandle(handle: string): string {
  const h = handle.trim().toLowerCase();
  return h.includes("@") ? h : h.replace(/[^\d]/g, "");
}

/** Same person? Phone numbers match on their last 10 digits, so "+1 416…" and "416…" agree. */
export function sameHandle(a: string, b: string): boolean {
  const x = normalizeHandle(a);
  const y = normalizeHandle(b);
  if (!x || !y) return false;
  if (x.includes("@") || y.includes("@")) return x === y;
  return x === y || (x.length >= 10 && y.length >= 10 && x.slice(-10) === y.slice(-10));
}

export function validHandle(handle: string): boolean {
  const h = handle.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(h) || /^\+?[\d\s().-]{7,}$/.test(h);
}

// The recipient and text are arguments, never spliced into the script.
const SEND_SCRIPT = `on run {target, body}
  tell application "Messages"
    set svc to 1st account whose service type = iMessage
    send body to participant target of svc
  end tell
end run`;

/** Sends one iMessage. Rejects when Messages refuses (not signed in, no permission, unknown recipient). */
export function sendIMessage(to: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", SEND_SCRIPT, to, text], { timeout: 20_000 }, (err, _out, stderr) => {
      if (!err) return resolve();
      const why = String(stderr || err.message).trim();
      reject(new Error(/not allowed|-1743/.test(why) ? "not allowed to control Messages: allow it in System Settings → Privacy & Security → Automation" : why));
    });
  });
}
