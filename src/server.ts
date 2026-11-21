// HTTP server: serves the interface, runs the agent and streams every step to the
// browser as it happens. Every run is also recorded in runs/ so a demo can be
// replayed if the venue Wi-Fi or the model quota fails during the pitch.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, readdir, appendFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryRunner, toStructuredEvents, type BaseLlm, type Event } from '@google/adk';
import type { Part } from '@google/genai';
import { buildAgent } from './agents.ts';
import { store } from './store.ts';
import { batchPlan, outDir } from './tools.ts';
import { mailLive, fetchNew, redact } from './mail.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const webDir = join(root, 'web');
const runsDir = join(root, 'runs');
const APP = 'agenthon';
const USER = 'demo';
const CONFIRM = 'adk_request_confirmation';

export type Step =
  | { type: 'session'; sessionId: string }
  | { type: 'user'; text: string; files: string[] }
  | { type: 'decision'; confirmId: string; confirmed: boolean; profile?: string }
  | { type: 'thought'; author: string; text: string }
  | { type: 'message'; author: string; text: string }
  | { type: 'tool_call'; author: string; id?: string; name: string; args: unknown }
  | { type: 'tool_result'; author: string; id?: string; name: string; response: unknown }
  | { type: 'approval'; confirmId: string; name: string; args: unknown; hint?: string;
      /** The profile id that may decide this card (profiles[].approves in the data). */
      requiredProfile?: string;
      /** pay_invoices only: the batch as the code computes it, IBANs from the supplier master data. */
      preview?: Preview }
  | { type: 'data'; snapshot: ReturnType<typeof store.snapshot> }
  | { type: 'error'; message: string }
  | { type: 'done' };

type Upload = { name: string; mimeType: string; data: string };
type Preview = { count: number; total: number; invoices: { id: string; number: string; supplier: string; iban: string; amount: number; dueDate: string }[] };
/** sees: the collections this profile may read ("*" = all, with everyone's tasks). can: run, files, replay. */
type Profile = { id: string; name: string; role: string; approves?: string[]; sees?: string[]; can?: string[] };
type Snapshot = ReturnType<typeof store.snapshot>;

const profiles = () => (store.data.profiles ?? []) as unknown as Profile[];

/** Demo accounts: scrypt hashes in data/users.json, the password is never stored. */
type User = { username: string; profile: string; hash: string };
const users: User[] = JSON.parse(readFileSync(join(root, 'data', 'users.json'), 'utf8'));
function passwordOk(user: User, password: string): boolean {
  const [salt, hex] = user.hash.split(':');
  const want = Buffer.from(hex, 'hex');
  const got = scryptSync(String(password), salt, want.length);
  return timingSafeEqual(got, want);
}
const can = (p: Profile, what: string) => !!p.can?.includes(what);

/** What one profile may see: its own collections and only its own tasks. Direzione ("*") sees everything. */
export function visibleTo(p: Profile, snap: Snapshot): Snapshot {
  const all = !!p.sees?.includes('*');
  const data: Snapshot['data'] = {};
  for (const [name, rows] of Object.entries(snap.data)) {
    if (name === 'profiles' || name === 'company') data[name] = rows;
    else if (all) data[name] = rows;
    else if (p.sees?.includes(name)) data[name] = name === 'tasks' ? rows.filter((t) => t.assignTo === p.id) : rows;
  }
  const lastChange = snap.lastChange && data[snap.lastChange.collection] ? snap.lastChange : null;
  return { ...snap, lastChange, data };
}
const LABELS: Record<string, string> = { send_message: 'la mail al fornitore', pay_invoices: 'la distinta di pagamento' };
const label = (name: string) => LABELS[name] ?? name;
/** Who must approve this action, from the profiles in the data. */
export const approverFor = (name: string) => profiles().find((p) => p.approves?.includes(name));

/** The approval card as the interface shows it: who decides it, and for a payment the batch itself. */
function enrich(step: Extract<Step, { type: 'approval' }>): Extract<Step, { type: 'approval' }> {
  const required = approverFor(step.name);
  const out: Extract<Step, { type: 'approval' }> = { ...step, requiredProfile: required?.id };
  if (step.name === 'pay_invoices') {
    const plan = batchPlan(((step.args as { invoiceIds?: string[] })?.invoiceIds) ?? []);
    out.preview = { count: plan.count, total: plan.total, invoices: plan.invoices };
  }
  return out;
}

let syncing: Promise<number> | null = null;
/** Live mail only: new mail in the real supplier mailbox enters the inbox. Returns how many arrived. */
export function syncMail(): Promise<number> {
  if (!mailLive()) return Promise.resolve(0);
  syncing ??= fetchNew(store.resetAt, store.knownMail())
    .then((list) => store.addMail(list).length)
    .finally(() => { syncing = null; });
  return syncing;
}

/** The new messages in the supplier mailbox, with their XML, as one request to the agent. */
export function autopilotParts() {
  const fresh = (store.data.inbox ?? []).filter((m) => m.status === 'nuovo');
  const parts: Part[] = [{ text:
    `Autopilota: gestisci tutti i ${fresh.length} messaggi nuovi qui sotto, uno per uno, secondo le regole. ` +
    'Alla fine, nella stessa risposta, proponi le mail ai fornitori e la distinta di pagamento, poi scrivi il riepilogo.' }];
  const files: string[] = [];
  for (const m of fresh) {
    parts.push({ text: `--- Messaggio ${m.id} da ${m.from}, ricevuto ${m.received}\nOggetto: ${m.subject}\n${m.body}` });
    for (const a of store.attachments(m.id)) {
      files.push(a.name);
      parts.push({ text: `Allegato di ${m.id}: ${a.name}\n${a.text}` });
    }
  }
  return { count: fresh.length, parts, files };
}

function toSteps(ev: Event): Step[] {
  const author = ev.author ?? 'agent';
  const steps: Step[] = [];
  for (const s of toStructuredEvents(ev)) {
    if (s.type === 'thought') steps.push({ type: 'thought', author, text: s.content });
    else if (s.type === 'content' && s.content.trim()) steps.push({ type: 'message', author, text: s.content });
    else if (s.type === 'tool_call' && s.call.name === CONFIRM) {
      const args = (s.call.args ?? {}) as { originalFunctionCall?: { name?: string; args?: unknown }; toolConfirmation?: { hint?: string } };
      steps.push({
        type: 'approval',
        confirmId: s.call.id ?? '',
        name: args.originalFunctionCall?.name ?? '?',
        args: args.originalFunctionCall?.args ?? {},
        hint: args.toolConfirmation?.hint,
      });
    } else if (s.type === 'tool_call') steps.push({ type: 'tool_call', author, id: s.call.id, name: s.call.name ?? '?', args: s.call.args ?? {} });
    else if (s.type === 'tool_result' && s.result.name !== CONFIRM)
      steps.push({ type: 'tool_result', author, id: s.result.id, name: s.result.name ?? '?', response: s.result.response ?? {} });
    else if (s.type === 'error') steps.push({ type: 'error', message: friendly(s.error.message) });
  }
  return steps;
}

/**
 * Gemini's 429 names the quota it hit: ids with PerDay reset at midnight Pacific time
 * (9:00 in Italy), ids with PerMinute clear after the retryDelay it gives.
 */
export function quotaMessage(msg: string): string {
  if (/PerDay|per day|daily/i.test(msg))
    return 'Quota giornaliera di Gemini finita per questo modello: si azzera alle 9:00 italiane. Cambia MODEL in .env (npm run models) o usa il replay di una prova registrata.';
  const delay = msg.match(/retry(?:Delay)?["'\s:]*(?:in\s*)?"?(\d+(?:\.\d+)?)s/i);
  const wait = delay ? `riprova tra ${Math.ceil(Number(delay[1]))} secondi` : 'riprova tra un minuto';
  if (/PerMinute|per minute/i.test(msg) || delay)
    return `Troppe richieste a Gemini in questo minuto: ${wait}. Se continua, cambia MODEL o usa il replay.`;
  return 'Quota Gemini superata: aspetta un minuto e riprova. Se continua è la quota del giorno (si azzera alle 9:00): metti MODEL=gemini-3.5-flash-lite in .env o usa il replay di una prova registrata.';
}

/** Every error the interface shows, in Italian and with what to do next. */
export function friendly(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/API key must be provided/i.test(msg)) return 'Manca la chiave Gemini: copia .env.example in .env e metti GEMINI_API_KEY.';
  if (/API key not valid|API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED|\b40[13]\b/i.test(msg))
    return 'La chiave Gemini non è valida o non ha accesso a questo modello: controlla GEMINI_API_KEY e MODEL in .env, o usa il replay di una prova registrata.';
  if (/429|quota|RESOURCE_EXHAUSTED/i.test(msg)) return quotaMessage(msg);
  if (/503|UNAVAILABLE|high demand|overloaded/i.test(msg))
    return 'Il modello è sovraccarico in questo momento (503, non dipende da noi): cambia MODEL in .env (es. gemini-3.5-flash-lite) o usa il replay di una prova registrata.';
  if (/404|not found/i.test(msg) && /model/i.test(msg)) return `Modello non trovato: controlla MODEL con "npm run models". (${msg})`;
  if (/fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(msg))
    return 'Gemini non risponde: controlla la connessione a internet e riprova, o usa il replay di una prova registrata.';
  return `Errore inatteso: riprova; se si ripete controlla GEMINI_API_KEY e MODEL in .env, o usa il replay di una prova registrata. (${msg})`;
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
};

export function createApp(opts: { model: string | BaseLlm; title?: string; record?: boolean }) {
  const runner = new InMemoryRunner({ agent: buildAgent(opts.model), appName: APP });
  const modelName = typeof opts.model === 'string' ? opts.model : opts.model.model;
  const busy = new Set<string>();
  const runFiles = new Map<string, string>();
  /** Approval cards still waiting, by confirmId: the server checks the profile before ADK sees the answer. */
  const pending = new Map<string, Extract<Step, { type: 'approval' }>>();
  /**
   * The cards of one pause, and the answers given so far. Gemini wants every answer to one model turn
   * in a single message, so the run resumes only when the last card of the pause is decided.
   */
  type Answer = { name: string; yes: boolean; who?: Profile };
  const pauses = new Map<string, { ids: string[]; answers: Map<string, Answer> }>();
  const pauseOf = new Map<string, string>();
  /** The agent session of each waiting card, so the approver can decide it from their own login. */
  const sessionOf = new Map<string, string>();
  let pauseCount = 0;
  /** Logged-in browsers: cookie token to profile id. In memory, like the rest of the demo. */
  const sessions = new Map<string, string>();
  const viewerOf = (req: IncomingMessage) => {
    const token = /(?:^|;\s*)quadra=([a-f0-9]{48})/.exec(req.headers.cookie ?? '')?.[1];
    const id = token ? sessions.get(token) : undefined;
    return id ? profiles().find((p) => p.id === id) : undefined;
  };
  const me = (p: Profile) => ({ id: p.id, name: p.name, role: p.role, approves: p.approves ?? [], can: p.can ?? [] });

  /** No parts: no model call, only the intro and the extra steps (an answer that waits for the others). */
  async function stream(res: ServerResponse, viewer: Profile, sessionId: string | undefined, parts: Part[], intro: Step, extra: Step[] = []) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    let runFile: string | null = null;
    const send = async (step: Step) => {
      // The screen gets only what this profile may see; the recording keeps the whole story.
      const wire = step.type === 'data' ? { ...step, snapshot: visibleTo(viewer, step.snapshot) } : step;
      // redact(): with live mail the real mailbox never reaches the screen or a recording.
      res.write(`data: ${redact(JSON.stringify(wire))}\n\n`);
      if (runFile) await appendFile(runFile, redact(JSON.stringify({ t: Date.now(), step })) + '\n').catch(() => {});
    };
    try {
      if (!sessionId) sessionId = (await runner.sessionService.createSession({ appName: APP, userId: USER })).id;
      if (busy.has(sessionId)) { await send({ type: 'error', message: 'Questa sessione sta già lavorando.' }); return; }
      busy.add(sessionId);
      if (opts.record !== false) {
        if (!runFiles.has(sessionId)) runFiles.set(sessionId, join(runsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`));
        runFile = runFiles.get(sessionId)!;
      }
      await send({ type: 'session', sessionId });
      await send(intro);
      for (const step of extra) await send(step);
      let seen = store.version;
      const pause = { id: `pausa-${++pauseCount}`, ids: [] as string[] };
      if (parts.length) for await (const ev of runner.runAsync({ userId: USER, sessionId, newMessage: { role: 'user', parts } })) {
        for (let step of toSteps(ev)) {
          if (step.type === 'approval') {
            const card = enrich(step);
            pending.set(card.confirmId, card); pauseOf.set(card.confirmId, pause.id); pause.ids.push(card.confirmId);
            sessionOf.set(card.confirmId, sessionId);
            step = card;
          }
          await send(step);
        }
        if (store.version !== seen) { seen = store.version; await send({ type: 'data', snapshot: store.snapshot() }); }
      }
      if (pause.ids.length) pauses.set(pause.id, { ids: pause.ids, answers: new Map() });
      if (store.version !== seen) await send({ type: 'data', snapshot: store.snapshot() });
    } catch (err) {
      await send({ type: 'error', message: friendly(err) });
    } finally {
      if (sessionId) busy.delete(sessionId);
      await send({ type: 'done' });
      res.end();
    }
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    try {
      if (req.method === 'GET' && url.pathname === '/api/health')
        return json(res, 200, { title: opts.title || 'Quadra · autopilota fornitori', model: modelName, mail: mailLive() ? 'gmail' : 'esempi' });
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const { username = '', password = '' } = (await body(req)) as { username?: string; password?: string };
        const user = users.find((u) => u.username === String(username).trim().toLowerCase());
        const who = user && profiles().find((p) => p.id === user.profile);
        if (!user || !who || !passwordOk(user, password)) {
          store.log({ action: 'accesso negato', actor: String(username).slice(0, 40) || 'sconosciuto', outcome: 'negato', detail: 'utente o password non validi' });
          return json(res, 401, { error: 'Utente o password non validi.' });
        }
        const token = randomBytes(24).toString('hex');
        sessions.set(token, who.id);
        store.log({ action: 'accesso', actor: who.name, profile: who.id, outcome: 'ok', detail: `login ${user.username}` });
        res.setHeader('set-cookie', `quadra=${token}; HttpOnly; SameSite=Strict; Path=/`);
        return json(res, 200, me(who));
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        const who = viewerOf(req);
        const token = /(?:^|;\s*)quadra=([a-f0-9]{48})/.exec(req.headers.cookie ?? '')?.[1];
        if (token) sessions.delete(token);
        if (who) store.log({ action: 'uscita', actor: who.name, profile: who.id, outcome: 'ok', detail: 'logout' });
        res.setHeader('set-cookie', 'quadra=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return json(res, 200, { ok: true });
      }
      // Everything else under /api needs a login, and each profile gets only its part.
      const viewer = url.pathname.startsWith('/api/') ? viewerOf(req) : undefined;
      if (url.pathname.startsWith('/api/') && !viewer) return json(res, 401, { error: 'Accedi per continuare.' });
      const forbid = () => json(res, 403, { error: `Il profilo ${viewer!.role} non può farlo.` });

      if (req.method === 'GET' && url.pathname === '/api/me') return json(res, 200, me(viewer!));
      if (req.method === 'GET' && url.pathname === '/api/pending') {
        const all = !!viewer!.sees?.includes('*');
        return json(res, 200, [...pending.values()]
          .filter((c) => all || c.requiredProfile === viewer!.id)
          .map((c) => ({ ...c, sessionId: sessionOf.get(c.confirmId) })));
      }
      if (req.method === 'POST' && url.pathname === '/api/mail/sync') {
        if (!can(viewer!, 'run')) return forbid();
        const added = await syncMail();
        return json(res, 200, { added, ...visibleTo(viewer!, store.snapshot()) });
      }
      if (req.method === 'GET' && url.pathname === '/api/data') return json(res, 200, visibleTo(viewer!, store.snapshot()));
      if (req.method === 'POST' && url.pathname === '/api/reset') {
        if (!can(viewer!, 'run')) return forbid();
        store.reset(); pending.clear(); pauses.clear(); pauseOf.clear(); sessionOf.clear();
        // Wiping the data is itself an audited act: the new log starts with who did it.
        store.log({ action: 'dati azzerati', actor: viewer!.name, profile: viewer!.id, outcome: 'ok', detail: 'dati riportati allo stato iniziale' });
        return json(res, 200, visibleTo(viewer!, store.snapshot()));
      }

      if ((url.pathname === '/api/run' || url.pathname === '/api/autopilot') && !can(viewer!, 'run')) return forbid();
      if (req.method === 'POST' && url.pathname === '/api/run') {
        const { sessionId, text = '', files = [] } = (await body(req)) as { sessionId?: string; text?: string; files?: Upload[] };
        const parts: Part[] = [];
        for (const f of files) {
          parts.push({ text: `Documento allegato: ${f.name}` });
          parts.push({ inlineData: { mimeType: f.mimeType, data: f.data } });
        }
        if (text.trim()) parts.push({ text });
        if (!parts.length) return json(res, 400, { error: 'Scrivi qualcosa o allega un documento.' });
        return stream(res, viewer!, sessionId, parts, { type: 'user', text, files: files.map((f) => f.name) });
      }

      if (req.method === 'POST' && url.pathname === '/api/approve') {
        // The profile comes from the login, never from the request body.
        const { sessionId, confirmId, confirmed } = (await body(req)) as { sessionId: string; confirmId: string; confirmed: boolean };
        const who = viewer!; const profile = who.id;
        if (!sessionId || !confirmId) return json(res, 400, { error: 'sessionId e confirmId servono entrambi.' });
        const card = pending.get(confirmId);
        // Profile-based access: the wrong person is stopped here, before the agent sees any answer.
        if (card?.requiredProfile && card.requiredProfile !== profile) {
          const need = profiles().find((p) => p.id === card.requiredProfile);
          store.log({ action: 'approvazione negata', actor: who?.name ?? 'sconosciuto', profile, outcome: 'negata',
            detail: `${card.name}: spetta a ${need?.name} (${need?.role})` });
          return json(res, 403, { error: `Questa approvazione spetta a ${need?.name} (${need?.role}).`, requiredProfile: card.requiredProfile });
        }
        const yes = confirmed === true;
        pending.delete(confirmId);
        store.log({ action: yes ? 'approvato' : 'rifiutato', actor: who?.name ?? 'operatore', profile, outcome: yes ? 'approvato' : 'rifiutato',
          detail: card ? `${card.name}${card.preview ? `: ${card.preview.count} fatture, ${card.preview.total.toFixed(2).replace('.', ',')} €` : ''}` : confirmId });
        const decision: Step = { type: 'decision', confirmId, confirmed: yes, profile };
        const pauseId = pauseOf.get(confirmId);
        const pause = pauseId ? pauses.get(pauseId) : undefined;
        const answers = pause?.answers ?? new Map<string, Answer>();
        answers.set(confirmId, { name: card?.name ?? '', yes, who });
        pauseOf.delete(confirmId);
        const open = pause ? pause.ids.filter((id) => !answers.has(id)) : [];
        if (open.length) {
          const others = open.map((id) => pending.get(id)).filter((c) => !!c)
            .map((c) => { const p = profiles().find((x) => x.id === c.requiredProfile); return p ? `${label(c.name)} (${p.name}, ${p.role})` : label(c.name); });
          return await stream(res, viewer!, sessionId, [], decision, [{ type: 'message', author: 'autopilota',
            text: `Decisione registrata. Il lavoro riprende quando è decisa anche: ${others.join('; ')}.` }]);
        }
        if (pauseId) pauses.delete(pauseId);
        for (const a of answers.values()) if (a.yes && a.who) store.approvers.set(a.name, { profile: a.who.id, name: a.who.name });
        try {
          return await stream(res, viewer!, sessionId,
            [...answers].map(([id, a]) => ({ functionResponse: { id, name: CONFIRM, response: { confirmed: a.yes } } })), decision);
        } finally { store.approvers.clear(); }
      }

      if (req.method === 'POST' && url.pathname === '/api/autopilot') {
        const { sessionId } = (await body(req)) as { sessionId?: string };
        if (mailLive()) {
          try { await syncMail(); } catch (e) { return json(res, 502, { error: `Casella Gmail non raggiungibile: ${(e as Error).message}` }); }
        }
        const run = autopilotParts();
        if (!run.count) return json(res, 400, { error: 'Nessun messaggio nuovo.' });
        return stream(res, viewer!, sessionId, run.parts, { type: 'user', text: `Autopilota: ${run.count} messaggi nuovi nella casella fornitori`, files: run.files });
      }

      if (url.pathname.startsWith('/api/files/') && !can(viewer!, 'files')) return forbid();
      if (url.pathname.startsWith('/api/runs') && !can(viewer!, 'replay')) return forbid();
      if (req.method === 'GET' && url.pathname.startsWith('/api/files/')) {
        const name = decodeURIComponent(url.pathname.slice('/api/files/'.length));
        if (!/^[\w.-]+\.(csv|xml)$/.test(name)) return json(res, 400, { error: 'nome non valido' });
        const content = await readFile(join(outDir, name)).catch(() => null);
        if (!content) return json(res, 404, { error: 'file non trovato' });
        const type = name.endsWith('.xml') ? 'application/xml' : 'text/csv';
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'content-disposition': `attachment; filename="${name}"` });
        return res.end(content);
      }

      if (req.method === 'GET' && url.pathname === '/api/runs') {
        const files = (await readdir(runsDir).catch(() => [])).filter((f) => f.endsWith('.jsonl')).sort().reverse();
        return json(res, 200, files);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/runs/')) {
        const name = url.pathname.slice('/api/runs/'.length);
        if (!/^[\w.-]+\.jsonl$/.test(name)) return json(res, 400, { error: 'nome non valido' });
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        return res.end(await readFile(join(runsDir, name)));
      }

      if (req.method === 'GET') {
        const path = normalize(url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname));
        const file = join(webDir, path);
        if (!file.startsWith(webDir)) return json(res, 403, { error: 'no' });
        const content = await readFile(file).catch(() => null);
        if (!content) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
        return res.end(content);
      }
      json(res, 404, { error: 'not found' });
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: friendly(err) });
      else res.end();
    }
  });
}

/**
 * Which Gemini backend .env points at, and what is missing for it. The event credits work only on
 * Vertex AI (GOOGLE_GENAI_USE_VERTEXAI=true + project + location, auth from Application Default
 * Credentials); an AI Studio key stays on the free tier.
 */
export function backendNote(): string {
  const flag = process.env.GOOGLE_GENAI_USE_ENTERPRISE ?? process.env.GOOGLE_GENAI_USE_VERTEXAI ?? '';
  if (/^(true|1)$/i.test(flag)) {
    const missing = ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'].filter((k) => !process.env[k]);
    return missing.length
      ? `(Vertex AI: manca ${missing.join(' e ')} in .env)`
      : `(Vertex AI, progetto ${process.env.GOOGLE_CLOUD_PROJECT}, ${process.env.GOOGLE_CLOUD_LOCATION})`;
  }
  const hasKey = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_API_KEY);
  return hasKey ? '(AI Studio, piano gratuito: i crediti non si usano)' : '(manca la configurazione di Gemini: vedi .env.example)';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const port = Number(process.env.PORT ?? 8080);
  // GA models only on the event credits (no -preview). Fallbacks: gemini-3.5-flash, gemini-3.1-flash-lite.
  const model = process.env.MODEL || 'gemini-3.8-flash';
  createApp({ model, title: process.env.APP_TITLE }).listen(port, () => {
    console.log(`Pronto su http://localhost:${port}  modello: ${model}  ${backendNote()}  posta: ${mailLive() ? 'Gmail dal vivo' : 'messaggi di esempio'}`);
    // Live mail: look at the mailbox every 20 seconds, so new mail is in the inbox before the autopilot starts.
    if (mailLive()) setInterval(() => syncMail().then((n) => { if (n) console.log(`${n} mail nuove dalla casella`); })
      .catch((e) => console.error('Gmail:', (e as Error).message)), 20_000);
  });
}
