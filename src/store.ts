// The business data the agent works on: plain collections of records, loaded from
// data/seed.json at boot. Swap this file for real systems (a DB, an API) on the day.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { mailLive, tagOf, tagOfAlias, redact, type Incoming } from './mail.ts';

export type Rec = Record<string, unknown> & { id: string };
type Data = Record<string, Rec[]>;
/** What check_invoice saw: the invoice is registered with these values, not the model's. */
export type InvoiceCheck = {
  key: string; invoice: string; supplier: string; supplierId: string | null; orderId: string;
  subtotal: number; vat: number; total: number; dueDate: string; outcome: string;
};
/** Who approved an action: set by the server, by tool name, while the approved tools run. */
export type Approver = { profile: string; name: string };

const seedPath = new URL('../data/seed.json', import.meta.url);
const samplesDir = new URL('../data/samples/', import.meta.url);

export class Store {
  data: Data = {};
  version = 0;
  /** The ids touched by the last write, so the interface can highlight them. */
  lastChange: { collection: string; id: string } | null = null;
  /** The last check_invoice outcome for each source (file name or message id), set by the tool. */
  invoiceChecks = new Map<string, InvoiceCheck>();
  approvers = new Map<string, Approver>();
  /** With live mail, only mail received after the last reset enters the inbox. */
  resetAt = Date.now();

  constructor() { this.reset(); }

  reset() {
    this.data = JSON.parse(readFileSync(seedPath, 'utf8'));
    // Live mail: the supplier mailbox is the real one (Gmail), not the sample messages.
    if (mailLive()) this.data.inbox = [];
    this.resetAt = Date.now();
    this.invoiceChecks.clear();
    this.approvers.clear();
    this.version++;
    this.lastChange = null;
  }

  collections() { return Object.keys(this.data); }

  /** The attachments of an inbox message, read from data/samples/ (the mail server, in a real system). */
  attachments(messageId: string): { name: string; text: string }[] {
    const msg = this.data.inbox?.find((m) => m.id.toLowerCase() === messageId.trim().toLowerCase());
    if (Array.isArray(msg?.files)) return msg.files as { name: string; text: string }[]; // arrived by mail
    const names = Array.isArray(msg?.attachments) ? (msg.attachments as string[]) : [];
    return names.flatMap((n) => {
      try { return [{ name: n, text: readFileSync(new URL(basename(n), samplesDir), 'utf8') }]; } catch { return []; }
    });
  }

  /** Message-IDs of the mail already in the inbox. */
  knownMail() { return new Set((this.data.inbox ?? []).map((m) => String(m.messageId ?? ''))); }

  /**
   * Mail fetched from the real mailbox, as inbox messages. A plus address that matches a supplier
   * in master data shows as that supplier's address: the real mailbox never reaches the screen.
   */
  addMail(list: Incoming[]) {
    const rows = (this.data.inbox ??= []);
    const known = this.knownMail();
    const added: Rec[] = [];
    for (const m of list) {
      if (known.has(m.messageId)) continue;
      known.add(m.messageId);
      const tag = tagOfAlias(m.from);
      const supplier = tag ? (this.data.suppliers ?? []).find((s) => tagOf(String(s.email)) === tag) : undefined;
      const rec: Rec = {
        id: `M-${300 + rows.length + 1}`, from: supplier ? String(supplier.email) : redact(m.from), fromName: m.fromName,
        subject: m.subject, body: redact(m.body), attachments: m.files.map((f) => f.name), files: m.files,
        received: m.received, status: 'nuovo', messageId: m.messageId, via: 'gmail',
      };
      rows.push(rec);
      added.push(rec);
      this.log({ action: 'mail ricevuta', source: rec.id, outcome: 'nuovo', detail: `da ${rec.from}: ${m.subject}` });
    }
    if (added.length) this.touch('inbox', added[added.length - 1].id);
    return added;
  }

  /** One line in the audit log: what happened, on which input, who did or approved it. */
  log(entry: { action: string; source?: string; detail: string; outcome?: string; actor?: string; profile?: string }) {
    // Not through create(): the interface highlights the business record just written, not its log line.
    const rows = (this.data.audit ??= []);
    const rec: Rec = { id: `A-${String(rows.length + 1).padStart(4, '0')}`, at: new Date().toISOString(), actor: 'autopilota', ...entry };
    rows.push(rec);
    this.version++;
    return rec;
  }

  search(collection: string, query = '') {
    const rows = this.data[collection];
    if (!rows) return { error: `collezione sconosciuta: ${collection}`, collections: this.collections() };
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = rows.filter((r) => {
      const text = JSON.stringify(r).toLowerCase();
      return words.every((w) => text.includes(w));
    });
    return { collection, count: hits.length, records: hits.slice(0, 20) };
  }

  /** The record already written for this key, if any. */
  findByKey(collection: string, key: string) {
    return this.data[collection]?.find((r) => r.idempotencyKey === key);
  }

  /**
   * Writes once per key: the same action on the same source (a message, a document) returns
   * the record already there instead of a second copy. The key is built in code by the tool,
   * never by the model, so a retried run or a request that arrives twice changes nothing.
   */
  createOnce(collection: string, key: string, fields: Record<string, unknown>) {
    const existing = this.findByKey(collection, key);
    if (existing) return { duplicate: true, note: 'Esiste già: non ho creato una seconda copia.', record: existing };
    return this.create(collection, { ...fields, idempotencyKey: key });
  }

  create(collection: string, fields: Record<string, unknown>) {
    const rows = (this.data[collection] ??= []);
    const prefix = collection.slice(0, 1).toUpperCase();
    const id = typeof fields.id === 'string' ? fields.id : `${prefix}-${String(rows.length + 1).padStart(4, '0')}`;
    const rec: Rec = { ...fields, id };
    rows.push(rec);
    this.touch(collection, id);
    return rec;
  }

  update(collection: string, id: string, fields: Record<string, unknown>) {
    const rec = this.data[collection]?.find((r) => r.id === id);
    if (!rec) return { error: `nessun record ${id} in ${collection}` };
    Object.assign(rec, fields, { id });
    this.touch(collection, id);
    return rec;
  }

  private touch(collection: string, id: string) {
    this.version++;
    this.lastChange = { collection, id };
  }

  snapshot() { return { version: this.version, lastChange: this.lastChange, data: this.data }; }
}

export const store = new Store();
