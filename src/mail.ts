// Real mail, off by default. With MAIL_LIVE=1 and a Gmail app password in .env, Quadra reads the
// supplier mailbox over IMAP and sends approved mail over SMTP. One Gmail account plays every role
// through plus addresses: <user>+officine@ is the company's supplier mailbox, <user>+metallipo@ a
// supplier. The real address lives only in .env and never on screen or in a recording.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';

const env = (k: string) => (process.env[k] ?? '').trim();
/** Read at call time, so a test can turn it off with NO_MAIL=1 after the imports. */
export const mailLive = () => env('MAIL_LIVE') === '1' && !env('NO_MAIL') && !!env('GMAIL_USER') && !!env('GMAIL_APP_PASSWORD');

const user = () => env('GMAIL_USER');
const pass = () => env('GMAIL_APP_PASSWORD').replace(/\s/g, '');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** <local>+<tag>@<domain> on the configured account. */
export function alias(tag: string) {
  const [local, domain] = user().split('@');
  return `${local}+${slug(tag)}@${domain}`;
}
export const companyInbox = () => alias(env('MAIL_INBOX_TAG') || 'officine');
/** The tag a master-data address maps to: contabilita@metallipo.example → metallipo. */
export const tagOf = (email: string) => slug(String(email).split('@')[1]?.split('.')[0] ?? 'fornitore');
export const supplierAlias = (email: string) => alias(tagOf(email));
/** The tag of a plus address on our account (…+metallipo@… → metallipo), or null. */
export function tagOfAlias(address: string) {
  const [local, domain] = user().toLowerCase().split('@');
  const m = address.toLowerCase().match(/^([^+@]+)\+([^@]+)@(.+)$/);
  return m && m[1] === local && m[3] === domain ? m[2] : null;
}

/** Hide the real mailbox in anything that leaves the machine or goes on screen. */
export function redact(text: string) {
  const local = user().split('@')[0];
  return local ? text.split(local).join('quadra.demo') : text;
}

export async function sendMail(m: { to: string; subject: string; text: string; fromName?: string; replyTo?: string;
  inReplyTo?: string; attachments?: { filename: string; content: string }[] }) {
  const smtp = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: user(), pass: pass() } });
  const info = await smtp.sendMail({
    from: { name: m.fromName ?? 'Contabilità fornitori · Officine Sereno', address: user() },
    to: m.to, replyTo: m.replyTo, subject: m.subject, text: m.text, attachments: m.attachments,
    ...(m.inReplyTo ? { inReplyTo: m.inReplyTo, references: [m.inReplyTo] } : {}),
  });
  return info.messageId as string;
}

export type Incoming = { messageId: string; fromName: string; from: string; subject: string; body: string;
  received: string; files: { name: string; text: string }[] };

/**
 * Mail to the company's supplier mailbox received after `sinceMs` and not in `known` (Message-IDs).
 * Does not rely on the unread flag: mail sent to yourself can arrive already read.
 */
export async function fetchNew(sinceMs: number, known: Set<string>): Promise<Incoming[]> {
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, logger: false, auth: { user: user(), pass: pass() } });
  await client.connect();
  const out: Incoming[] = [];
  const lock = await client.getMailboxLock('INBOX');
  try {
    const since = new Date(sinceMs - 24 * 3600e3); // IMAP SINCE is by day: filter by the exact time below
    const uids = (await client.search({ to: companyInbox(), since }, { uid: true })) || [];
    if (!uids.length) return out;
    const fresh: number[] = [];
    for await (const msg of client.fetch(uids, { envelope: true, internalDate: true }, { uid: true })) {
      const id = msg.envelope?.messageId ?? `uid-${msg.uid}`;
      const at = new Date(msg.internalDate ?? msg.envelope?.date ?? 0).getTime();
      if (at >= sinceMs - 5000 && !known.has(id)) fresh.push(msg.uid);
    }
    for (const uid of fresh) {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) continue;
      const p = await simpleParser(msg.source);
      const from = p.from?.value?.[0];
      const replyTo = (p.replyTo?.value?.[0] as { address?: string } | undefined)?.address;
      out.push({
        messageId: p.messageId ?? `uid-${uid}`,
        fromName: from?.name || '',
        from: (replyTo ?? from?.address ?? '').toLowerCase(),
        subject: p.subject ?? '',
        body: (p.text ?? '').trim().slice(0, 4000),
        received: (p.date ?? new Date()).toISOString(),
        // XML FatturaPA from Italian suppliers, the invoice text from foreign ones.
        files: p.attachments.filter((a) => /\.(xml|txt)$/i.test(a.filename ?? '')).map((a) => ({ name: a.filename!, text: a.content.toString('utf8') })),
      });
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }).catch(() => {});
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return out;
}
