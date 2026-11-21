// Sends the demo's supplier mails for real: from the Gmail account in .env, with the supplier's name,
// Reply-To the supplier's plus address (…+metallipo@…), to the company's supplier mailbox (…+officine@…),
// with the invoice attached (FatturaPA XML, or the text of the foreign invoice). Then start the autopilot.
//   npm run mail:seed            all 6 messages of the story
//   npm run mail:seed -- M-204   only some
import { readFileSync } from 'node:fs';
import { alias, companyInbox, mailLive, sendMail, supplierAlias } from '../src/mail.ts';

if (!mailLive()) {
  console.error('Posta dal vivo spenta: servono MAIL_LIVE=1, GMAIL_USER e GMAIL_APP_PASSWORD in .env (vedi .env.example).');
  process.exit(1);
}
const seed = JSON.parse(readFileSync(new URL('../data/seed.json', import.meta.url), 'utf8'));
const only = process.argv.slice(2);
const inbox = (seed.inbox as any[]).filter((m) => !only.length || only.includes(m.id));
const nameOf = (email: string) => (seed.suppliers as any[]).find((s) => s.email === email)?.name ?? email.split('@')[1];

console.log(`Invio ${inbox.length} mail a ${companyInbox().replace(/^[^+]+/, '…')}`);
for (const m of inbox) {
  const attachments = (m.attachments as string[]).map((f) => ({
    filename: f, content: readFileSync(new URL(`../data/samples/${f}`, import.meta.url), 'utf8') }));
  await sendMail({ to: companyInbox(), fromName: nameOf(m.from), replyTo: supplierAlias(m.from),
    subject: m.subject, text: m.body, attachments });
  console.log(`  ${m.id}  ${nameOf(m.from)}: ${m.subject}`);
}
console.log(`Fatto. Le risposte di Quadra arrivano a ${alias('<fornitore>').replace(/^[^+]+/, '…')}.`);
