// Checks that Quadra's replies reached the suppliers' plus addresses, in the same Gmail thread as
// the supplier's invoice. Prints no real address.   npm run mail:check
import { ImapFlow } from 'imapflow';
import { alias, mailLive, redact } from '../src/mail.ts';

if (!mailLive()) { console.error('Posta dal vivo spenta (vedi .env.example).'); process.exit(1); }
const user = process.env.GMAIL_USER!;
const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, logger: false,
  auth: { user, pass: process.env.GMAIL_APP_PASSWORD!.replace(/\s/g, '') } });
await client.connect();
const lock = await client.getMailboxLock('INBOX');
try {
  const since = new Date(Date.now() - 24 * 3600e3);
  const tag = process.argv[2] ?? 'metallipo';
  const uids = (await client.search({ to: alias(tag), since }, { uid: true })) || [];
  if (!uids.length) console.log(`Nessuna mail a …+${tag}@ nelle ultime 24 ore.`);
  // Fetch everything first: imapflow can't run another command while a fetch is being read.
  const found = uids.length ? await client.fetchAll(uids, { envelope: true, threadId: true, headers: ['in-reply-to'] }, { uid: true }) : [];
  for (const m of found) {
    const thread = (await client.search({ threadId: m.threadId! }, { uid: true })) || [];
    const reply = /in-reply-to:\s*\S/i.test(m.headers?.toString() ?? '');
    console.log(redact(`${new Date(m.envelope?.date ?? 0).toISOString()}  «${m.envelope?.subject}»  in risposta: ${reply ? 'sì' : 'no'}  messaggi nel thread: ${thread.length}`));
  }
} finally { lock.release(); await client.logout(); }
