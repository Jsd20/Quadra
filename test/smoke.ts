// End-to-end plumbing test of the real server: a scripted model stands in for Gemini,
// everything else (HTTP, SSE, ADK agent, tools, approval gate, profiles, store) is the real code.
// It proves the wiring and the rules in code; it says nothing about Gemini's quality.
//
// The story: the autopilot gets 5 supplier mails. Two clean invoices are registered on their own,
// a price difference goes to Acquisti, a changed IBAN (with an injection in the XML) goes to Finanza,
// a duplicate of a paid invoice is stopped. The payment batch waits for Finanza: Contabilità is refused.
import './no-mail.ts';
import { BaseLlm, type LlmRequest, type LlmResponse } from '@google/adk';
import type { AddressInfo } from 'node:net';
import { readFileSync, rmSync } from 'node:fs';
import { createApp, friendly, quotaMessage, type Step } from '../src/server.ts';
import { store } from '../src/store.ts';
import { outDir, checkInvoiceAgainstOrder, integrationDeadline, replyTarget } from '../src/tools.ts';
import { mailLive, supplierAlias } from '../src/mail.ts';

type Call = { id: string; name: string; args: Record<string, unknown> };
const turn = (...calls: Call[]) => ({ content: { role: 'model', parts: calls.map((c) => ({ functionCall: c })) } }) as LlmResponse;
const say = (text: string) => ({ content: { role: 'model', parts: [{ text }] } }) as LlmResponse;

/** What a model would read off a FatturaPA file: the test plays the model, the code still re-reads the IBAN. */
function readInvoice(file: string) {
  const xml = readFileSync(new URL(`../data/samples/${file}`, import.meta.url), 'utf8');
  const tag = (t: string, s = xml) => s.match(new RegExp(`<${t}>([^<]+)</${t}>`))?.[1] ?? '';
  const seller = xml.match(/<CedentePrestatore>[\s\S]*?<\/CedentePrestatore>/)![0];
  const lines = [...xml.matchAll(/<DettaglioLinee>([\s\S]*?)<\/DettaglioLinee>/g)].map((m) => ({
    description: tag('Descrizione', m[1]), qty: Number(tag('Quantita', m[1])), unitPrice: Number(tag('PrezzoUnitario', m[1])),
  }));
  return {
    invoiceNumber: tag('Numero'), supplier: tag('Denominazione', seller), supplierVat: tag('IdCodice', seller),
    iban: tag('IBAN'), dueDate: tag('DataScadenzaPagamento'), orderId: tag('IdDocumento'), lines,
    subtotal: Number(tag('ImponibileImporto')), vatRate: 22, vat: Number(tag('Imposta')), total: Number(tag('ImportoTotaleDocumento')),
  };
}
const mails: Record<string, string> = {
  'M-201': 'FT-gommaplast-2026-0587.xml', 'M-202': 'FT-viteria-231-2026.xml', 'M-203': 'FT-metallipo-MP-1544.xml',
  'M-204': 'FT-sangone-77B.xml', 'M-205': 'FT-viteria-118-2026.xml',
};
/** The German invoice is text from a PDF, not XML: what a model reads off it, order reference as written. */
const hessler = {
  source: 'M-206', invoiceNumber: '2026-4471', supplier: 'Hessler Antriebstechnik GmbH', supplierVat: 'DE287654321',
  iban: 'DE61 7605 0101 0012 3456 78', dueDate: '2026-12-18', orderId: 'PO 2026/0431',
  lines: [
    { description: 'KL-6204 Deep groove ball bearing 6204-2RS', qty: 200, unitPrice: 3.2 },
    { description: 'WD-35 Radial shaft seal 35x52x7', qty: 100, unitPrice: 2.1 },
  ],
  subtotal: 850, vatRate: 0, vat: 0, total: 850,
};

class StoryLlm extends BaseLlm {
  turn = 0;
  calls = 0;
  sawXml = false;
  constructor() { super({ model: 'scripted' }); }
  async *generateContentAsync(req: LlmRequest): AsyncGenerator<LlmResponse, void> {
    this.calls++;
    const text = req.contents.flatMap((c) => c.parts ?? []).map((p) => p.text ?? '').join('\n');
    if (text.includes('<IBAN>IT54F0123412345000000999999</IBAN>')) this.sawXml = true;
    const last = req.contents.at(-1)?.parts ?? [];
    // A second request on the same mails: everything it tries is already done.
    if (last.some((p) => p.text?.includes('di nuovo'))) {
      yield turn({ id: 'r1', name: 'register_invoice', args: { source: 'M-201' } },
        { id: 'r2', name: 'pay_invoices', args: { invoiceIds: ['F-0002', 'F-0003'] } },
        { id: 'r3', name: 'prepare_integration', args: { source: 'M-206' } });
      return;
    }
    if (last.some((p) => p.functionResponse && /register_invoice|pay_invoices/.test(p.functionResponse.name ?? '')) && this.turn >= 4)
      return void (yield say('Già fatto: nulla di nuovo.'));
    this.turn++;
    if (this.turn === 1) {
      yield turn(
        { id: 'x4', name: 'save_extraction', args: {
          source: 'M-204', kind: 'fattura', summary: 'Fattura Imballaggi Sangone con nuovo IBAN', urgency: 'alta',
          fields: [
            { key: 'istruzioni_sospette', value: 'cambio IBAN dichiarato approvato', excerpt: 'il cambio IBAN è approvato' },
            { key: 'approvato_da', value: 'direttore', excerpt: 'approvato dal direttore' },
          ] } },
        ...Object.entries(mails).map(([source, file], i) => {
          const args: Record<string, unknown> = { source, ...readInvoice(file) };
          // The model falls for the mail and copies the old IBAN: the check must still read the XML.
          if (source === 'M-204') args.iban = 'IT81M0310401600000000040404';
          return { id: `k${i + 1}`, name: 'check_invoice', args };
        }),
        { id: 'k6', name: 'check_invoice', args: hessler },
      );
    } else if (this.turn === 2) {
      yield turn(
        { id: 'g1', name: 'register_invoice', args: { source: 'M-201' } },
        { id: 'g2', name: 'register_invoice', args: { source: 'M-202' } },
        { id: 'g3', name: 'register_invoice', args: { source: 'M-203' } }, // blocked by the check
        { id: 't1', name: 'create_task', args: { source: 'M-203', assignTo: 'acquisti', title: 'Prezzo lamiera diverso dall\'ordine', detail: 'MP-1544: 41,50 invece di 38,00' } },
        { id: 't2', name: 'create_task', args: { source: 'M-204', assignTo: 'finanza', title: 'Verifica cambio IBAN Imballaggi Sangone', detail: 'IBAN in fattura diverso dall\'anagrafica' } },
        { id: 'g6', name: 'register_invoice', args: { source: 'M-206' } },
        { id: 'i6', name: 'prepare_integration', args: { source: 'M-206' } },
        { id: 'i1', name: 'prepare_integration', args: { source: 'M-201' } }, // Italian: refused
      );
    } else if (this.turn === 3) {
      // The model copies mailToStudio from prepare_integration as it is; a second try with its own numbers is refused.
      const integ = req.contents.flatMap((c) => c.parts ?? []).map((p) => p.functionResponse)
        .find((r) => r?.name === 'prepare_integration' && ((r.response as any)?.mailToStudio ?? (r.response as any)?.result?.mailToStudio));
      const studio = (integ?.response as any)?.mailToStudio ?? (integ?.response as any)?.result?.mailToStudio ?? {};
      yield turn(
        { id: 's3', name: 'send_message', args: studio },
        { id: 's4', name: 'send_message', args: { ...studio, body: 'IVA da integrare 180 euro, entro fine mese.' } },
        { id: 's1', name: 'send_message', args: { to: 'contabilita@metallipo.example', subject: 'Re: Fattura MP-1544', body: 'Chiediamo nota di credito di 175,00 €.', inReplyTo: 'M-203' } },
        { id: 's2', name: 'send_message', args: { to: 'pagamenti@sangone-nuovo.example', subject: 'IBAN', body: 'Confermato.', inReplyTo: 'M-204' } },
        { id: 'p1', name: 'pay_invoices', args: { invoiceIds: ['F-0002', 'F-0003', 'F-0001'] } },
      );
    } else yield say('Registrate 2 fatture per 866,20 €; eccezioni ad Acquisti e Finanza; distinta in attesa di Finanza.');
  }
  async connect(): Promise<never> { throw new Error('no live'); }
}

const llm = new StoryLlm();
rmSync(outDir, { recursive: true, force: true });
const server = createApp({ model: llm, record: false }).listen(0);
await new Promise((ok) => server.once('listening', ok));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

// Each demo user logs in and keeps their own cookie; requests go out as the current user.
const jar: Record<string, string> = {};
let current = '';
async function login(username: string, password = 'quadra-demo') {
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  if (res.ok) jar[username] = res.headers.get('set-cookie')!.split(';')[0];
  await res.text();
  return res;
}
const as = (username: string) => { current = username; };
const get = (path: string) => fetch(base + path, { headers: { cookie: jar[current] ?? '' } });
async function send(path: string, payload: unknown) {
  return fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie: jar[current] ?? '' }, body: JSON.stringify(payload) });
}
async function post(path: string, payload: unknown): Promise<Step[]> {
  const text = await (await send(path, payload)).text();
  return text.split('\n\n').filter((c) => c.startsWith('data: ')).map((c) => JSON.parse(c.slice(6)));
}
const fail = (msg: string, detail?: unknown) => { console.error('FAIL:', msg, detail ? JSON.stringify(detail, null, 1) : ''); server.close(); process.exit(1); };
const results = (steps: Step[], name: string) => steps.filter((s) => s.type === 'tool_result' && s.name === name).map((s: any) => s.response);
const inbox = (id: string) => store.data.inbox.find((m) => m.id === id)?.status;

try {
  const health = await (await fetch(base + '/api/health')).json();
  if (health.model !== 'scripted') fail('health');
  const page = await fetch(base + '/');
  if (!page.ok || !(await page.text()).includes('app.js')) fail('static page');
  if ((await fetch(base + '/..%2fpackage.json')).ok) fail('path traversal not blocked');

  // 0. Login: no cookie, no data; a wrong password is refused and audited; Acquisti cannot start runs.
  if ((await fetch(base + '/api/data')).status !== 401) fail('data without login');
  if ((await login('sara', 'sbagliata')).status !== 401) fail('wrong password accepted');
  for (const u of ['sara', 'luca', 'elena', 'marta']) if (!(await login(u)).ok) fail(`login ${u}`);
  as('luca');
  if ((await send('/api/autopilot', {})).status !== 403) fail('Acquisti started the autopilot');
  as('sara');

  // 1. The autopilot: the 6 mails with their XML or invoice text reach the model in one request.
  const run = await post('/api/autopilot', {});
  const intro = run.find((s) => s.type === 'user') as any;
  if (!/6 messaggi nuovi/.test(intro?.text) || intro.files.length !== 6) fail('autopilot intro', intro);
  if (!llm.sawXml) fail('the XML never reached the model');
  const sessionId = (run.find((s) => s.type === 'session') as any).sessionId;

  // 2. The checks, in code.
  const checks = Object.fromEntries(results(run, 'check_invoice').map((r: any) => [r.invoiceNumber, r]));
  const codesOf = (n: string) => checks[n]?.discrepancies.map((d: any) => d.code) ?? [];
  if (checks['2026/0587']?.outcome !== 'ok' || checks['231/2026']?.outcome !== 'ok') fail('clean invoices not ok', checks);
  if (!codesOf('MP-1544').includes('PREZZO_DIVERSO') || checks['MP-1544'].outcome !== 'bloccata') fail('price difference', checks['MP-1544']);
  if (!codesOf('77/B').includes('IBAN_DIVERSO')) fail('IBAN change not caught from the XML', checks['77/B']);
  if (checks['77/B'].discrepancies.find((d: any) => d.code === 'IBAN_DIVERSO').owner !== 'finanza') fail('IBAN owner');
  if (checks['118/2026']?.outcome !== 'doppione' || !codesOf('118/2026').includes('DUPLICATA')) fail('duplicate', checks['118/2026']);
  if (inbox('M-205') !== 'doppione') fail('duplicate inbox status');
  // The German invoice: order reference written their way, no VAT (reverse charge), IBAN read from the text.
  const de = checks['2026-4471'];
  if (de?.outcome !== 'ok' || de.discrepancies.length) fail('foreign invoice not matched to PO-2026-0431', de);
  if (de.ibanRead !== 'dal file INV-hessler-2026-4471.txt') fail('IBAN of the foreign invoice not read from its text', de);
  const ex = store.data.extractions?.[0] as any;
  if (ex?.fields[0].check !== 'trovato' || ex.fields[1].check !== 'non trovato') fail('excerpt check against the XML', ex?.fields);

  // 3. Clean ones registered on their own, exceptions to the right people.
  const regs = results(run, 'register_invoice');
  if (regs.filter((r: any) => r.status === 'registrata').length !== 3|| !regs.some((r: any) => r.blocked)) fail('registration', regs);
  if (inbox('M-201') !== 'registrata' || inbox('M-202') !== 'registrata') fail('registered inbox status');
  const tasks = store.data.tasks.map((t: any) => `${t.source}:${t.assignTo}`);
  if (tasks.join() !== 'M-203:acquisti,M-204:finanza,M-206:contabilita') fail('tasks', tasks);
  // The VAT integration for the German invoice: document, VAT and the 15th, computed in code, to Contabilità.
  const [integ, italian] = results(run, 'prepare_integration');
  const it6 = integ?.integration;
  if (!integ?.prepared || it6.document !== 'TD18' || it6.vat !== 187 || it6.deadline !== '2026-12-15' || it6.taxable !== 850) fail('integration', integ);
  if (!italian?.blocked) fail('integration for an Italian supplier not refused', italian);
  // The mail to the external studio, written in code from the integration.
  const toStudio = integ.mailToStudio;
  if (toStudio?.to !== 'fatture@studiocolombo.example' || !toStudio.body.includes('187,00') || !toStudio.body.includes('15/12/2026') || toStudio.inReplyTo !== 'M-206')
    fail('mail to the studio', toStudio);
  if (inbox('M-206') !== 'registrata') fail('foreign invoice inbox status', inbox('M-206'));
  if (inbox('M-203') !== 'eccezione' || inbox('M-204') !== 'eccezione') fail('exception inbox status');

  // 4. What leaves the company waits: a mail for Contabilità, the batch for Finanza. The address from the text is refused.
  const blocked = results(run, 'send_message');
  if (!blocked.some((r: any) => r.blocked && /anagrafica/.test(r.error))) fail('mail to an unknown address not blocked', blocked);
  if (!blocked.some((r: any) => r.blocked && /187,00/.test(r.error))) fail('mail to the studio with the wrong VAT not blocked', blocked);
  const cards = run.filter((s) => s.type === 'approval') as any[];
  const mail = cards.find((c) => c.name === 'send_message' && c.args?.to === 'contabilita@metallipo.example');
  const studioCard = cards.find((c) => c.name === 'send_message' && c.args?.to === 'fatture@studiocolombo.example');
  const pay = cards.find((c) => c.name === 'pay_invoices');
  if (cards.length !== 3 || mail?.requiredProfile !== 'contabilita' || studioCard?.requiredProfile !== 'contabilita' || pay?.requiredProfile !== 'finanza') fail('approval cards', cards);
  if (pay.preview.total !== 866.2 || pay.preview.count !== 2) fail('batch preview', pay.preview);
  if (pay.preview.invoices.some((i: any) => i.iban.startsWith('IT54F'))) fail('preview with the IBAN from the mail');
  if (store.data.outbox.length || store.data.payments.length) fail('wrote before approval');

  // 5. Contabilità tries to pay: 403, nothing happens, the card stays open.
  // Pending cards: Finanza sees only its own, with the session to decide it from its own login.
  as('elena');
  const waiting = await (await get('/api/pending')).json();
  if (waiting.length !== 1 || waiting[0].name !== 'pay_invoices' || waiting[0].sessionId !== sessionId) fail('pending for Finanza', waiting);
  // Sara even claims to be Finanza in the body: the profile comes from her login, so 403.
  as('sara');
  const refused = await send('/api/approve', { sessionId, confirmId: pay.confirmId, confirmed: true, profile: 'finanza' });
  const refusedBody = await refused.json();
  if (refused.status !== 403 || refusedBody.requiredProfile !== 'finanza' || !/Elena Rinaldi/.test(refusedBody.error)) fail('wrong profile', refusedBody);
  if (store.data.payments.length) fail('paid with the wrong profile');

  // 6. Finanza approves first: both cards come from one model turn, and Gemini wants both answers in one
  // message, so this decision is recorded and waits for Contabilità. No model call, nothing written.
  const callsBefore = llm.calls;
  as('elena');
  const paid = await post('/api/approve', { sessionId, confirmId: pay.confirmId, confirmed: true });
  const decision = paid.find((s) => s.type === 'decision') as any;
  if (decision?.profile !== 'finanza') fail('decision without profile', paid);
  if (llm.calls !== callsBefore || store.data.payments.length) fail('resumed before every card of the turn was decided', paid);
  if (!paid.some((s) => s.type === 'message' && /Sara Gallo/.test(s.text))) fail('no note on the decision still open', paid);

  // Contabilità approves the two mails: after the second the run resumes with every answer, each tool with its own approver.
  as('sara');
  await post('/api/approve', { sessionId, confirmId: studioCard.confirmId, confirmed: true });
  if (store.data.outbox.length || store.data.payments.length) fail('resumed with the supplier mail still open');
  const sent = await post('/api/approve', { sessionId, confirmId: mail.confirmId, confirmed: true });
  if (store.data.outbox.length !== 2 || store.data.outbox.some((o: any) => o.approvedBy !== 'Sara Gallo')) fail('mail', sent);
  if (!store.data.outbox.some((o: any) => o.to === 'fatture@studiocolombo.example' && o.body.includes('187,00'))) fail('mail to the studio not sent', store.data.outbox);
  const batch = store.data.payments[0] as any;
  if (!batch || batch.total !== 866.2 || batch.approvedBy !== 'Elena Rinaldi' || batch.profile !== 'finanza') fail('payment', store.data.payments);
  if (store.data.invoices.filter((i: any) => i.status === 'in pagamento').length !== 2) fail('invoice status after payment');
  if ((await get(`/api/files/${batch.file}`)).status !== 403) fail('Contabilità downloaded the batch');
  // A reply is keyed by the inbox message it answers: «Re: m-203» is M-203, an id outside the inbox is refused.
  if (replyTarget('Re: m-203') !== 'M-203' || replyTarget('M-203') !== 'M-203' || replyTarget('M-999') !== null) fail('reply target');
  // A card already decided takes no second answer, not even from Direzione: 404, the agent is not resumed.
  as('marta');
  const late = await send('/api/approve', { sessionId, confirmId: mail.confirmId, confirmed: true });
  if (late.status !== 404) fail('decided card answered again', late.status);
  await late.text();
  as('elena');
  const csv = await (await get(`/api/files/${batch.file}`)).text();
  if (!csv.includes('866,20') || !csv.includes('IT20W0306909606100000010101') || csv.includes('IT54F')) fail('CSV', csv);
  if ((await get('/api/files/..%2f..%2fpackage.json')).ok) fail('files traversal not blocked');

  // T7: the same batch as a SEPA credit transfer (pain.001.001.09) for the bank, computed in code.
  if (batch.sepaFile !== `distinta-${batch.id}.xml`) fail('no SEPA file on the payment', batch);
  const sepaRes = await get(`/api/files/${batch.sepaFile}`);
  const sepa = await sepaRes.text();
  if (!sepaRes.ok || !/xml/.test(sepaRes.headers.get('content-type') ?? '')) fail('SEPA file not served', sepa);
  const expect = [
    'urn:iso:std:iso:20022:tech:xsd:pain.001.001.09', '<NbOfTxs>2</NbOfTxs>', '<CtrlSum>866.20</CtrlSum>',
    '<PmtMtd>TRF</PmtMtd>', '<Cd>SEPA</Cd>', 'IT60X0542811101000000123456', 'Officine Sereno S.r.l.',
    'IT20W0306909606100000010101', `<MsgId>QUADRA-${batch.id}</MsgId>`,
  ];
  for (const e of expect) if (!sepa.includes(e)) fail(`SEPA misses ${e}`, sepa);
  if (sepa.includes('IT54F')) fail('SEPA uses an IBAN that is not in master data', sepa);
  if ((sepa.match(/<CdtTrfTxInf>/g) ?? []).length !== 2) fail('SEPA must have one transaction per invoice', sepa);
  if (!/<InstdAmt Ccy="EUR">\d+\.\d{2}<\/InstdAmt>/.test(sepa)) fail('SEPA amount format', sepa);
  for (const id of batch.invoiceIds) {
    const inv = store.data.invoices.find((i: any) => i.id === id) as any;
    if (!sepa.includes(`<Ustrd>Fattura ${inv.number}`)) fail(`SEPA remittance for ${id}`, sepa);
  }

  // 7. The audit log says who did and who approved what.
  const audit = store.data.audit as any[];
  if (!audit.some((a) => a.action === 'approvazione negata' && a.actor === 'Sara Gallo')) fail('refusal not audited', audit);
  if (!audit.some((a) => a.action === 'approvato' && a.actor === 'Elena Rinaldi' && a.profile === 'finanza')) fail('approval not audited', audit);
  if (!audit.some((a) => a.action === 'distinta emessa')) fail('batch not audited', audit);
  if (!audit.some((a) => a.action === 'accesso negato' && a.actor === 'sara')) fail('failed login not audited', audit);
  if (!audit.some((a) => a.action === 'accesso' && a.actor === 'Marta Ferrero')) fail('login not audited', audit);

  // Each profile sees its part: Acquisti no mail, no payments, no audit; only Direzione sees everything.
  const view = async (u: string) => { as(u); return (await (await get('/api/data')).json()).data; };
  const luca = await view('luca'), elena = await view('elena'), marta = await view('marta');
  if (luca.inbox || luca.payments || luca.audit || luca.tasks.map((t: any) => t.assignTo).join() !== 'acquisti') fail('Acquisti view', luca);
  if (elena.inbox || elena.audit || !elena.payments?.length || elena.tasks.map((t: any) => t.assignTo).join() !== 'finanza') fail('Finanza view', Object.keys(elena));
  if (!marta.audit?.length || marta.tasks.length !== 3 || !marta.inbox) fail('Direzione view', Object.keys(marta));
  const saraTasks = (await view('sara')).tasks;
  if (saraTasks.length !== 1 || !/TD18.*15\/12\/2026/.test(saraTasks[0].title)) fail('Contabilità does not see the integration task', saraTasks);
  as('marta');
  if (!(await get('/api/runs')).ok) fail('Direzione cannot open the recordings');
  as('sara');
  if ((await get('/api/runs')).status !== 403) fail('Contabilità opened the recordings');
  console.log(`story: 3 registered (1 German), 3 tasks (TD18 by 15/12, mail to the studio), 1 duplicate stopped, 403 for Contabilità, batch ${batch.id} by Finanza, ${audit.length} audit lines`);

  // 8. Run again: nothing is new, nothing is written twice, no card.
  const none = await send('/api/autopilot', { sessionId });
  if (none.status !== 400) fail('autopilot with nothing new');
  const again = await post('/api/run', { sessionId, text: 'Gestisci di nuovo M-201 e paga' });
  if (again.some((s) => s.type === 'approval')) fail('asked for approval again', again);
  if (!results(again, 'register_invoice')[0]?.duplicate || !results(again, 'pay_invoices')[0]?.blocked) fail('idempotency', again);
  if (!results(again, 'prepare_integration')[0]?.duplicate || store.data.tasks.length !== 3 || store.data.outbox.length !== 2) fail('integration prepared twice', results(again, 'prepare_integration'));
  if (store.data.invoices.length !== 4|| store.data.payments.length !== 1) fail('written twice');
  console.log('idempotency: second registration and payment changed nothing');

  as('marta');
  const reset = await (await send('/api/reset', {})).json();
  if (reset.data.inbox.some((m: any) => m.status !== 'nuovo') || reset.data.audit.map((a: any) => a.action).join() !== 'dati azzerati') fail('reset', reset.data.audit);
} finally {
  server.close();
  store.reset();
}

// A German supplier that charges Italian VAT: blocked, reverse charge expected. The 15th rolls over the year.
{
  const { lines, subtotal, invoiceNumber, supplierVat, orderId } = hessler;
  const r = checkInvoiceAgainstOrder({ lines, subtotal, invoiceNumber, supplierVat, orderId, vatRate: 22, vat: 187, total: 1037 });
  if (r.outcome !== 'bloccata' || !r.discrepancies.some((d) => d.code === 'IVA_ESTERA' && d.owner === 'contabilita')) fail('VAT on an EU invoice', r.discrepancies);
  if (integrationDeadline('2026-12-03T10:00:00Z') !== '2027-01-15' || integrationDeadline('2026-11-30T23:30:00') !== '2026-12-15') fail('deadline of the 15th');
}

// Quota errors: a daily limit and a per-minute one need different advice.
if (!/9:00/.test(quotaMessage('429 RESOURCE_EXHAUSTED quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier'))) fail('daily quota text');
if (!/31 secondi/.test(quotaMessage('429 RESOURCE_EXHAUSTED GenerateRequestsPerMinutePerProjectPerModel "retryDelay": "30.4s"'))) fail('per-minute quota text');
// Every other model error reaches the interface in Italian, with what to do.
if (!/non è valida/.test(friendly(new Error('400 INVALID_ARGUMENT API key not valid. Please pass a valid API key.')))) fail('invalid key text');
if (!/connessione/.test(friendly(new TypeError('fetch failed')))) fail('network text');
if (!/^Errore inatteso/.test(friendly(new Error('something odd')))) fail('fallback text');
if (!/9:00/.test(friendly(new Error('429 RESOURCE_EXHAUSTED GenerateRequestsPerDay')))) fail('quota still wins');

// Live mail, offline: a fake account. Plus addresses map to suppliers, the real mailbox never shows.
{
  process.env.GMAIL_USER = 'casella.demo@posta.example';
  if (mailLive()) fail('NO_MAIL must keep live mail off in tests');
  if (supplierAlias('contabilita@metallipo.example') !== 'casella.demo+metallipo@posta.example') fail('supplier alias');
  const xml = readFileSync(new URL('../data/samples/FT-metallipo-MP-1544.xml', import.meta.url), 'utf8');
  const mail = { messageId: '<a1@mail.gmail.com>', fromName: 'Metalli Po', from: 'casella.demo+metallipo@posta.example', subject: 'Fattura MP-1544',
    body: 'In allegato. Scrivete a casella.demo@posta.example', received: new Date().toISOString(), files: [{ name: 'FT-metallipo-MP-1544.xml', text: xml }] };
  const stranger = { ...mail, messageId: '<a2@mail.gmail.com>', from: 'casella.demo+pagamenti@posta.example', files: [] };
  const added = store.addMail([mail, mail, stranger]);
  if (added.length !== 2) fail('the same Message-ID enters once', added);
  if (added[0].from !== 'contabilita@metallipo.example') fail('known plus address shows as the supplier', added[0]);
  if (JSON.stringify(store.data.inbox).includes('casella.demo')) fail('real mailbox on screen', store.data.inbox);
  if (store.attachments(added[0].id)[0]?.text !== xml) fail('mail attachment readable by the tools');
  if (store.addMail([mail]).length) fail('second sync adds nothing');
  delete process.env.GMAIL_USER;
  store.reset();
}
console.log('SMOKE OK');
