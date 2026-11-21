// Real round trip with Gemini: needs Vertex AI (or a GEMINI_API_KEY) set in .env, see .env.example.
// Run at the venue (npm run check:gemini) so a missing project, auth or quota shows up early.
// It plays the whole demo on the fictional data: the autopilot on the 6 mails, then every approval card
// is decided by the profile it asks for (Sara the mail, Elena the batch), until the run ends.
import './no-mail.ts';
import type { AddressInfo } from 'node:net';
import { backendNote, createApp, type Step } from '../src/server.ts';
import { store } from '../src/store.ts';

const model = process.env.MODEL || 'gemini-3.8-flash';
const note = backendNote();
console.log(`Modello ${model} ${note}`);
if (/manca/.test(note)) process.exit(1);

const server = createApp({ model, record: process.env.RECORD === '1' }).listen(0);
await new Promise((ok) => server.once('listening', ok));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
const started = Date.now();
// Each profile logs in with its demo user (data/users.json); a card is decided from its own login.
const userOf: Record<string, string> = { contabilita: 'sara', finanza: 'elena', direzione: 'marta' };
const cookies: Record<string, string> = {};
async function loginAs(profile: string) {
  if (cookies[profile]) return cookies[profile];
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: userOf[profile], password: 'quadra-demo' }) });
  if (!res.ok) throw new Error(`login ${profile}: ${res.status}`);
  return (cookies[profile] = res.headers.get('set-cookie')!.split(';')[0]);
}
async function post(path: string, payload: unknown, profile = 'contabilita'): Promise<Step[]> {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie: await loginAs(profile) }, body: JSON.stringify(payload) });
  const steps: Step[] = (await res.text()).split('\n\n').filter((c) => c.startsWith('data: ')).map((c) => JSON.parse(c.slice(6)));
  for (const s of steps) if (s.type !== 'data') console.log(' ', s.type, 'name' in s ? s.name : '', 'text' in s ? String(s.text).slice(0, 120) : '', 'message' in s ? s.message : '');
  const err = steps.find((s) => s.type === 'error');
  if (err) throw new Error((err as any).message);
  return steps;
}
try {
  const steps = await post('/api/autopilot', {});
  const sessionId = (steps.find((s) => s.type === 'session') as any).sessionId;
  const results = steps.filter((s) => s.type === 'tool_result' && s.name === 'check_invoice').map((s: any) => s.response);
  console.log('  controlli:', results.map((r: any) => `${r.invoiceNumber}: ${r.outcome} ${r.discrepancies.map((d: any) => d.code).join(',')}`).join(' | '));
  const iban = results.find((r: any) => r.discrepancies.some((d: any) => d.code === 'IBAN_DIVERSO'));
  console.log('  IBAN letto', iban?.ibanRead ?? 'NON CONTROLLATO');
  if (results.length < 6) throw new Error(`il modello ha controllato ${results.length} fatture su 6`);
  const integ = steps.find((s: any) => s.type === 'tool_result' && s.name === 'prepare_integration' && s.response?.prepared) as any;
  if (!integ) throw new Error('il modello non ha preparato l\'integrazione della fattura estera');
  const i = integ.response.integration;
  console.log(`  integrazione ${i.document} ${i.invoice}: IVA ${i.vat} €, entro ${i.deadline}`);
  // As in the demo: each card is decided by its profile, the mail first, until no card is left.
  const all = [...steps];
  let open = steps.filter((s) => s.type === 'approval') as any[];
  for (let round = 0; open.length && round < 4; round++) {
    open.sort((a, b) => (a.name === 'send_message' ? -1 : 0) - (b.name === 'send_message' ? -1 : 0));
    const card = open.shift();
    console.log(`  approvazione ${card.name} da ${card.requiredProfile}:`, card.preview ? `${card.preview.count} fatture, ${card.preview.total} €` : JSON.stringify(card.args).slice(0, 160));
    const more = await post('/api/approve', { sessionId, confirmId: card.confirmId, confirmed: true }, card.requiredProfile);
    all.push(...more);
    open.push(...more.filter((s) => s.type === 'approval'));
  }
  const final = all.filter((s) => s.type === 'message' && s.author !== 'autopilota').at(-1) as any;
  if (final) console.log('  riepilogo:', final.text);
  const pay = store.data.payments?.[0] as any;
  if (!pay) throw new Error('nessuna distinta emessa');
  console.log(`  distinta ${pay.id}: ${pay.count} fatture, ${pay.total} €, approvata da ${pay.approvedBy}; mail inviate ${store.data.outbox?.length ?? 0}`);
  const studio = (store.data.outbox ?? []).find((o: any) => /studiocolombo/.test(o.to)) as any;
  if (!studio) throw new Error('nessuna mail allo studio con l\'integrazione');
  console.log(`  allo studio: ${studio.subject}`);
  const tools = all.filter((s) => s.type === 'tool_call').map((s) => (s as any).name);
  console.log(`GEMINI OK (${model}, ${((Date.now() - started) / 1000).toFixed(1)}s, ${tools.length} chiamate)`);
} catch (e) {
  console.error('GEMINI FAIL:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  server.close();
}
