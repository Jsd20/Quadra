// The interface: sends work to the agent and draws every step it streams back.
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const LABELS = {
  search_records: 'Cerca nei dati', save_extraction: 'Ha letto e capito', create_record: 'Crea un record',
  update_record: 'Aggiorna un record', send_message: 'Invia una risposta', writer: 'Chiede al redattore',
  check_invoice: 'Controlla la fattura', register_invoice: 'Registra la fattura',
  create_task: 'Assegna un task', pay_invoices: 'Prepara la distinta di pagamento',
};
const label = (name) => LABELS[name] ?? name;

const PROFILE_ROLES = { contabilita: 'Contabilità', acquisti: 'Acquisti', finanza: 'Finanza', direzione: 'Direzione' };
const COLLECTIONS = {
  tasks: 'I miei task', audit: 'Registro', payments: 'Distinte', company: 'Azienda',
  profiles: 'Profili', suppliers: 'Fornitori', orders: 'Ordini', receipts: 'DDT',
  invoices: 'Fatture', inbox: 'Posta in arrivo', extractions: 'Estrazioni', outbox: 'Posta inviata',
  customers: 'Clienti',
};
const COLUMNS = {
  id: 'Codice', name: 'Nome', vat: 'IVA', city: 'Città', iban: 'IBAN', email: 'Email',
  phone: 'Telefono', terms: 'Termini', supplier: 'Fornitore', supplierId: 'Codice fornitore',
  date: 'Data', status: 'Stato', lines: 'Righe', order: 'Ordine', orderId: 'Ordine',
  number: 'Numero', subtotal: 'Imponibile', amount: 'Importo', dueDate: 'Scadenza',
  from: 'Mittente', to: 'Destinatario', subject: 'Oggetto', body: 'Testo', attachments: 'Allegati',
  received: 'Ricevuto il', source: 'Fonte', kind: 'Tipo', urgency: 'Urgenza', summary: 'Riepilogo',
  fields: 'Campi', role: 'Ruolo', approves: 'Può approvare',
};
const STATE_COLORS = new Map([
  ['nuovo', 'blue'], ['registrata', 'bassa'], ['eccezione', 'media'], ['doppione', 'neutral'],
  ['ok', 'bassa'], ['da verificare', 'media'], ['bloccata', 'alta'],
  ['negato', 'alta'], ['negata', 'alta'], ['approvato', 'bassa'], ['rifiutato', 'media'],
]);
const money = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
const date = new Intl.DateTimeFormat('it-IT');
const time = new Intl.DateTimeFormat('it-IT', { timeStyle: 'medium' });
const amount = (value) => Number.isFinite(value) ? money.format(value) : '—';
const formatDate = (value, formatter = date) => value && !Number.isNaN(Date.parse(value)) ? formatter.format(new Date(value)) : '—';
const pill = (value) => `<span class="pill ${STATE_COLORS.get(value) ?? 'neutral'}">${esc(value)}</span>`;
const state = { sessionId: null, busy: false, files: [], data: {}, me: null, tab: null, calls: new Map(), replaying: null, beforeReplay: null, auditFilter: 'all' };
const isBoss = () => state.me?.id === 'direzione';
const can = (what) => !!state.me?.can?.includes(what);
const isDenied = (r) => r.outcome === 'negato' || r.outcome === 'negata';

// Every API call goes through here: a lost session sends the user back to the login.
async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('Sessione scaduta: accedi di nuovo.'); }
  return res;
}

function profileRole(id) {
  return Object.hasOwn(PROFILE_ROLES, id) ? PROFILE_ROLES[id] : state.data.profiles?.find((p) => p.id === id)?.role ?? id;
}

function profileName(id) {
  const person = state.data.profiles?.find((p) => p.id === id);
  return person ? `${person.name} (${profileRole(id)})` : profileRole(id);
}

// ---------- data panel ----------
// The server sends each profile only its part; the tabs follow what arrived.
function renderData(snapshot) {
  state.data = snapshot.data;
  const first = isBoss() ? ['audit', 'tasks', 'payments'] : ['tasks', 'payments'];
  const hidden = isBoss() ? ['company'] : ['company', 'profiles'];
  const names = [...first, ...Object.keys(state.data)].filter((n, i, all) => all.indexOf(n) === i && Object.hasOwn(state.data, n) && !hidden.includes(n));
  if (!state.tab || !names.includes(state.tab)) state.tab = names[0];
  const changed = snapshot.lastChange;
  const title = (n) => n === 'tasks' && isBoss() ? 'Task' : COLLECTIONS[n] ?? n;
  $('tabs').innerHTML = names.map((n) =>
    `<button data-tab="${esc(n)}" aria-pressed="${n === state.tab}" class="${n === state.tab ? 'on' : ''} ${changed?.collection === n ? 'flash' : ''}">${esc(title(n))} ${state.data[n]?.length ?? 0}</button>`).join('');
  $('exportAudit').hidden = !(isBoss() && state.tab === 'audit');
  renderTable(changed);
  renderInbox();
}

function paymentLink(file, label = `Scarica ${file}`) {
  return file ? `<a href="/api/files/${encodeURIComponent(file)}" download>${esc(label)}</a>` : '';
}

function paymentDetails(payment) {
  return `<div class="payment-amount">${amount(payment.total)}</div>
    <div>${esc(payment.count)} ${payment.count === 1 ? 'fattura' : 'fatture'}${payment.approvedBy ? ` · ${esc(payment.approvedBy)}` : ''}</div>
    <div class="payment-links">
      ${paymentLink(payment.file)}
      ${paymentLink(payment.sepaFile, 'Scarica bonifico SEPA (XML)')}
    </div>`;
}

function renderPanelCards(rows, render, empty) {
  $('table').innerHTML = rows.length
    ? rows.map((row) => `<article class="data-card">${render(row)}</article>`).join('')
    : `<div class="empty">${empty}</div>`;
}

function renderTable(changed) {
  const rows = state.data[state.tab] ?? [];
  if (state.tab === 'tasks') {
    renderPanelCards(rows, (row) =>
      `${isBoss() ? `<span class="assignee">${esc(profileName(row.assignTo))}</span>` : ''}
      <h3>${esc(row.title)}</h3><p>${esc(row.detail)}</p><div class="data-meta">Da ${esc(row.source)}, ${esc(row.status)}</div>`,
    isBoss() ? 'Nessun task aperto' : '<strong>Niente per te, per ora.</strong>Quando una pratica ha bisogno di te, arriva qui.');
    return;
  }
  if (state.tab === 'audit') { renderLedger(rows); return; }
  if (state.tab === 'payments') {
    renderPanelCards([...rows].reverse(), (row) =>
      `<h3>Distinta ${esc(row.id)}</h3>${paymentDetails(row)}`, 'Nessuna distinta di pagamento');
    return;
  }
  if (!rows.length) { $('table').innerHTML = '<div class="empty">Vuota</div>'; return; }
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, 7);
  const cell = (v) => esc(typeof v === 'object' ? JSON.stringify(v) : v);
  $('table').innerHTML = `<table><thead><tr>${cols.map((c) => `<th>${esc(COLUMNS[c] ?? c)}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr class="${changed && changed.collection === state.tab && changed.id === r.id ? 'flash' : ''}">${cols.map((c) => `<td title="${cell(r[c])}">${cell(r[c])}</td>`).join('')}</tr>`).join('')
  }</tbody></table>`;
}
$('tabs').addEventListener('click', (e) => {
  const t = e.target.closest('button')?.dataset.tab; if (!t) return;
  state.tab = t; renderData({ data: state.data, lastChange: null });
});

// Direzione's audit log: who did what, on which message, with which profile, and the refusals.
const actorName = (a) => a === 'autopilota' ? 'Autopilota' : a;
function auditRows() {
  const rows = [...(state.data.audit ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return state.auditFilter === 'denied' ? rows.filter((r) => isDenied(r)) : rows;
}
function renderLedger(all) {
  const rows = auditRows();
  const denied = all.filter((r) => isDenied(r)).length;
  const filter = `<div class="panel-head" style="padding:0"><div class="ledger-filter">
      <button data-filter="all" aria-pressed="${state.auditFilter === 'all'}">Tutto ${all.length}</button>
      <button data-filter="denied" aria-pressed="${state.auditFilter === 'denied'}">Negati ${denied}</button></div>
      <span class="ledger-note">Solo aggiunte, mai modifiche</span></div>`;
  $('table').innerHTML = filter + (rows.length ? `<table class="ledger"><thead><tr><th>Ora</th><th>Chi</th><th>Cosa</th></tr></thead><tbody>${
    rows.map((r) => `<tr class="${isDenied(r) ? 'denied' : ''}">
      <td class="when">${formatDate(r.at, time)}</td>
      <td>${esc(actorName(r.actor))}${r.profile ? `<div class="data-meta">${esc(profileRole(r.profile))}</div>` : ''}</td>
      <td class="what">${esc(label(r.action))}${r.outcome ? pill(r.outcome) : ''}${r.source ? ` <span class="src">· ${esc(r.source)}</span>` : ''}<div class="data-meta detail">${esc(r.detail)}</div></td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">Nessuna attività nel registro</div>');
}
$('table').addEventListener('click', (e) => {
  const f = e.target.closest('[data-filter]')?.dataset.filter; if (!f) return;
  state.auditFilter = f; renderTable();
});
$('exportAudit').addEventListener('click', () => {
  const cols = ['at', 'actor', 'profile', 'action', 'source', 'outcome', 'detail'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(';'), ...(state.data.audit ?? []).map((r) => cols.map((c) => cell(r[c])).join(';'))].join('\r\n');
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })),
    download: `registro-quadra-${new Date().toISOString().slice(0, 10)}.csv`,
  });
  a.click(); URL.revokeObjectURL(a.href);
});

function renderInbox() {
  const hasInbox = Object.hasOwn(state.data, 'inbox');
  $('inboxPanel').hidden = !hasInbox;
  $('grid').classList.toggle('no-inbox', !hasInbox);
  const mails = state.data.inbox ?? [];
  const urgency = Object.fromEntries((state.data.extractions ?? []).map((x) => [x.source, x.urgency]));
  $('inboxCount').textContent = mails.length ? `${mails.length} messaggi` : '';
  const handled = mails.filter((m) => m.status && m.status !== 'nuovo').length;
  const alone = mails.filter((m) => m.status === 'registrata' || m.status === 'doppione').length;
  const people = mails.filter((m) => m.status === 'eccezione').length;
  $('metrics').hidden = !hasInbox || !handled;
  $('metrics').innerHTML = `
    <div><strong>${alone} <em>di ${mails.length}</em></strong>chiuse da sole</div>
    <div><strong>${people}</strong>alla persona giusta</div>
    <div><strong>${handled * 12} min</strong>risparmiati, stima a 12 min l'una</div>`;
  $('inbox').innerHTML = mails.map((m) => `
    <button class="mail" type="button" data-id="${esc(m.id)}">
      <span class="from">${esc(m.from)}</span>
      <span class="subj">${esc(m.subject)}</span>
      <span class="meta"><span>${esc(m.id)}</span>${pill(m.status)}${urgency[m.id] ? `<span class="pill ${esc(urgency[m.id])}">${esc(urgency[m.id])}</span>` : ''}</span>
    </button>`).join('');
}
$('inbox').addEventListener('click', (e) => {
  const id = e.target.closest('.mail')?.dataset.id; if (!id) return;
  const m = state.data.inbox.find((x) => x.id === id);
  run(`Gestisci questa richiesta in arrivo.\nid: ${m.id}\nda: ${m.from}\noggetto: ${m.subject}\n\n${m.body}`);
});
$('autopilot').addEventListener('click', async () => {
  if (state.busy) return;
  leaveReplay();
  await streamFrom('/api/autopilot', { sessionId: state.sessionId ?? undefined });
});

// ---------- trace ----------
function add(html, cls) {
  const trace = $('trace');
  trace.querySelector('.empty')?.remove();
  const el = document.createElement('div');
  el.className = `step ${cls}`;
  el.innerHTML = html;
  trace.appendChild(el);
  trace.scrollTop = trace.scrollHeight;
  return el;
}
function argsText(args, maxLength = 300) {
  if (!args || typeof args !== 'object') return esc(args);
  return Object.entries(args).map(([key, value]) => {
    let text = String(value);
    if (maxLength !== Infinity && Array.isArray(value) && value.every((p) => p && typeof p === 'object' && 'key' in p && 'value' in p)) {
      text = value.map((p) => p.key + '=' + p.value).join(', ');
    } else if (typeof value === 'object') {
      text = JSON.stringify(value, null, maxLength === Infinity ? 2 : 0);
    }
    return `${esc(key)}: ${esc(text.length > maxLength ? text.slice(0, maxLength) + '…' : text)}`;
  }).join('\n');
}

function emailDomain(email) {
  return typeof email === 'string'
    ? email.trim().match(/^[^\s@<>,;]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i)?.[1].toLowerCase()
    : undefined;
}

function approvalDetails(step) {
  const heading = `<div class="head"><b>${esc(step.name === 'pay_invoices' ? 'Distinta da approvare' : label(step.name))}</b></div>
    ${step.requiredProfile ? `<div class="required-profile">Serve: ${esc(profileName(step.requiredProfile))}</div>` : ''}`;
  if (step.name === 'pay_invoices' && step.preview) {
    const { invoices, count, total } = step.preview;
    return `${heading}
      <div class="payment-preview" tabindex="0" role="region" aria-label="Fatture nella distinta">
        <table><thead><tr><th>Fornitore</th><th>Fattura</th><th>IBAN</th><th>Scadenza</th><th>Importo</th></tr></thead>
        <tbody>${invoices.map((row) => `<tr>
          <td>${esc(row.supplier)}</td><td><strong>${esc(row.id)}</strong><br>${esc(row.number)}</td>
          <td class="iban">${esc(row.iban)}</td><td>${formatDate(row.dueDate)}</td><td>${amount(row.amount)}</td>
        </tr>`).join('')}</tbody></table>
      </div>
      <div class="preview-total"><span>Totale · ${count} ${count === 1 ? 'fattura' : 'fatture'}</span><strong>${amount(total)}</strong></div>
      <div class="preview-note">IBAN dall'anagrafica fornitori</div>`;
  }
  let args = step.args;
  let recipient = '';
  if (step.name === 'send_message') {
    const { to, ...rest } = args ?? {};
    args = rest;
    const domain = emailDomain(to);
    // Suppliers, plus the company's external accountant (the studio that files the VAT integration).
    const studio = (state.data.company ?? []).map((c) => ({ email: c.accountantEmail })).filter((c) => c.email);
    const contacts = [...(state.data.suppliers ?? []), ...(state.data.customers ?? []), ...studio];
    const known = domain && contacts.some((contact) => emailDomain(contact.email) === domain);
    recipient = `<div class="recipient">A: ${esc(to)}</div>${
      known ? '' : '<div class="recipient-warning">Destinatario non presente in anagrafica</div>'}`;
  }
  return `${heading}${recipient}
    <div class="args" tabindex="0" role="region" aria-label="Argomenti da approvare">${argsText(args, Infinity)}</div>`;
}

function extractionFields(fields) {
  return fields.map(({ key, value, excerpt, check }) => {
    const mark = check === 'trovato'
      ? '<span class="excerpt-found" aria-label="Estratto trovato">✓</span>'
      : check === 'non trovato'
        ? '<span class="excerpt-missing" title="L\'estratto non è nel messaggio originale" aria-label="Estratto non trovato">⚠</span>'
        : '';
    return `<dt>${esc(key)}</dt><dd>${esc(value)} ${mark}${
      excerpt ? `<div class="excerpt">«${esc(excerpt)}»</div>` : ''}</dd>`;
  }).join('');
}

function invoiceCard(orderId, result) {
  const discrepancies = result?.discrepancies;
  const outcome = result?.outcome;
  let body = 'Controllo in corso…';
  if (Array.isArray(discrepancies)) {
    body = discrepancies.length
      ? `<ul>${discrepancies.map(({ code, severity, detail, owner }) =>
        `<li><div class="${severity === 'blocca' ? 'blocking' : 'warning'}"><code>${esc(code)}</code>${owner ? ` · ${esc(profileName(owner))}` : ''}</div>${esc(detail)}</li>`).join('')}</ul>`
      : outcome === 'ok' ? 'Fattura coerente con l\'ordine' : '';
  } else if (result) {
    body = esc(result.error ?? 'Esito del controllo non disponibile');
  }
  const summary = [result?.supplier, result?.invoiceNumber, Number.isFinite(result?.total) ? amount(result.total) : ''].filter(Boolean).map(esc).join(' · ');
  return `<div class="head"><b>Controllo fattura</b>${outcome ? pill(outcome) : ''}</div>
    ${summary ? `<div class="invoice-summary">${summary}</div>` : ''}
    ${orderId ? `<div class="data-meta">Ordine ${esc(orderId)}</div>` : ''}
    <div class="body">${body}</div>`;
}

const RESULT_CARDS = new Map([
  ['register_invoice', ['invoice', (r) => `<b>${r.id ? `Registrata ${esc(r.id)}` : 'Fattura registrata'}${r.supplier ? ` · ${esc(r.supplier)}` : ''}${Number.isFinite(r.amount) ? ` · ${amount(r.amount)}` : ''}</b>`]],
  ['create_task', ['task', (r) => `<b>${r.assignTo ? `Task a ${esc(profileName(r.assignTo))}` : 'Task creato'}${r.title ? `: ${esc(r.title)}` : ''}</b>${r.detail ? `<div class="body">${esc(r.detail)}</div>` : ''}`]],
  ['pay_invoices', ['payment', (r) => `<b>Distinta ${esc(r.id)}</b><div class="body">${paymentDetails(r)}</div>`]],
]);

function resultCard(name, response) {
  const [key, render] = RESULT_CARDS.get(name);
  if (response?.error || response?.blocked || response?.ok === false) {
    return { html: `<b>${esc(label(name))}</b><div class="body">${esc(response.error ?? 'Operazione non riuscita')}</div>`, cls: 'record-blocked' };
  }
  const row = response?.[key] ?? response?.record ?? response;
  if (!row || typeof row !== 'object') return { html: `<b>${esc(label(name))}</b><div class="body">Esito non disponibile</div>`, cls: 'error' };
  return { html: `${render(row)}${response.duplicate ? '<div class="data-meta">Già eseguita</div>' : ''}`, cls: 'result-card' };
}

function showDuplicate(el, record) {
  el.classList.add('duplicate');
  const note = document.createElement('div');
  note.className = 'duplicate-note';
  const existing = [record?.id, record?.title || record?.subject].filter(Boolean).join(' · ');
  note.textContent = `Già fatto: nessuna seconda copia${existing ? ` — ${existing}` : ''}`;
  const previous = el.querySelector('.duplicate-note');
  if (previous) previous.replaceWith(note);
  else el.querySelector('.result').before(note);
}

function draw(step, { live = true } = {}) {
  switch (step.type) {
    case 'session': state.sessionId = step.sessionId; break;
    case 'user':
      add(`<div class="head"><b>${state.replaying ? 'Richiesta' : esc(state.me?.name ?? 'Tu')}</b></div><div class="body">${esc(step.text).replace(/\n/g, '<br>')}${
        step.files.length ? `<div class="chips">${step.files.map((f) => `<span class="chip">${esc(f)}</span>`).join('')}</div>` : ''}</div>`, 'user');
      break;
    case 'thought': add(`<div class="head">${esc(step.text)}</div>`, 'thought'); break;
    case 'message':
      add(`<div class="head"><b>${step.author === 'coordinator' ? 'Quadra' : step.author === 'autopilota' ? 'Autopilota' : esc(step.author)}</b></div><div class="body">${esc(step.text)}</div>`, 'message');
      break;
    case 'tool_call': {
      if (step.name === 'save_extraction') {
        const a = step.args ?? {};
        const el = add(`<div class="head"><b>${esc(a.kind)}</b> <span class="pill ${esc(a.urgency)}">${esc(a.urgency)}</span><span class="who">${esc(a.source)}</span></div>
          <div class="summary">${esc(a.summary)}</div>
          <dl class="kv">${extractionFields(a.fields ?? [])}</dl>`, 'extraction');
        el.dataset.tool = step.name;
        state.calls.set(step.id, el);
        break;
      }
      if (step.name === 'check_invoice') {
        const el = add(invoiceCard(step.args?.orderId), 'invoice-check');
        el.dataset.tool = step.name;
        state.calls.set(step.id, el);
        break;
      }
      const el = add(`<div class="head"><span class="spin"></span><b>${esc(label(step.name))}</b><span class="who">${esc(step.name)}</span></div>
        <div class="args">${argsText(step.args)}</div><div class="result"></div>`, 'tool');
      el.addEventListener('click', () => {
        if (el.classList.contains('tool')) el.classList.toggle('open');
      });
      el.dataset.tool = step.name;
      state.calls.set(step.id, el);
      break;
    }
    case 'tool_result': {
      const call = state.calls.get(step.id);
      const el = call?.dataset.tool === step.name ? call : null;
      if (step.name === 'save_extraction' && el?.classList.contains('extraction') && Array.isArray(step.response?.fields)) {
        el.querySelector('.kv').innerHTML = extractionFields(step.response.fields);
      } else if (step.name === 'check_invoice') {
        const html = invoiceCard(step.response?.orderId, step.response);
        if (el?.classList.contains('invoice-check')) el.innerHTML = html;
        else add(html, 'invoice-check');
      } else if (RESULT_CARDS.has(step.name)) {
        const { html, cls } = resultCard(step.name, step.response);
        if (el) {
          el.className = `step ${cls}`;
          el.innerHTML = html;
        } else add(html, cls);
      } else if (step.name === 'create_record' && step.response?.blocked === true) {
        const html = `<div class="head"><b>Registrazione fattura bloccata</b></div>
          <div class="body">${esc(step.response.error)}</div>`;
        if (el?.classList.contains('tool')) {
          el.className = 'step record-blocked';
          el.innerHTML = html;
        } else add(html, 'record-blocked');
      } else if (el?.classList.contains('tool')) {
        el.classList.add('ok');
        el.querySelector('.result').textContent = JSON.stringify(step.response, null, 2);
        if (step.response?.duplicate === true) showDuplicate(el, step.response.record);
      }
      break;
    }
    case 'approval': {
      const el = add(`${approvalDetails(step)}
        <div class="approval-error" role="alert" hidden></div>
        <div class="actions"><button class="primary yes">Approva</button><button class="no">Rifiuta</button></div>`, 'approval');
      el.dataset.confirmId = step.confirmId;
      if (live === 'watch' || (live && !state.replaying && isBoss())) {
        // Direzione sees what is waiting, but signs nothing: separation of duties.
        el.classList.add('waiting');
        el.querySelector('.actions').innerHTML = `<span class="pill blue">In attesa</span><span class="data-meta">la firma spetta a ${esc(profileName(step.requiredProfile))}</span>`;
      } else if (live && !state.replaying) {
        el.querySelector('.yes').onclick = () => decide(el, true);
        el.querySelector('.no').onclick = () => decide(el, false);
      } else el.querySelectorAll('button').forEach((b) => (b.disabled = true));
      break;
    }
    case 'decision': {
      const el = [...document.querySelectorAll('.step.approval')].find((x) => x.dataset.confirmId === step.confirmId);
      if (el) markDecided(el, step.confirmed, step.profile);
      else add(decisionDetails(step.confirmed, step.profile), 'result-card');
      break;
    }
    case 'data': renderData(step.snapshot); break;
    case 'error': add(`<div class="head"><b>${esc(step.message)}</b></div>`, 'error'); break;
    case 'done': break;
  }
}
function decisionDetails(yes, profile) {
  return `<span class="pill ${yes ? 'bassa' : 'alta'}">${yes ? 'Approvato' : 'Rifiutato'}</span>${profile ? `<strong>${esc(profileName(profile))}</strong>` : ''}`;
}
function markDecided(el, yes, profile) {
  el.classList.add('decided');
  el.querySelector('.approval-error').hidden = true;
  el.querySelector('.actions').innerHTML = decisionDetails(yes, profile);
}

// ---------- talking to the server ----------
function setBusy(b) {
  state.busy = b;
  $('status').textContent = b ? 'sta lavorando' : '';
  $('status').classList.toggle('busy', b);
  $('send').disabled = b; $('autopilot').disabled = b; $('replay').disabled = b; $('reset').disabled = b; $('logout').disabled = b;
}
async function streamFrom(path, payload, onError) {
  setBusy(true);
  const reportError = onError ?? ((message) => draw({ type: 'error', message }));
  try {
    const res = await api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok || !res.body) {
      reportError((await res.json().catch(() => ({}))).error ?? `Errore ${res.status}`);
      return;
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        if (chunk.startsWith('data: ')) draw(JSON.parse(chunk.slice(6)));
      }
    }
  } catch (err) {
    reportError(`Connessione persa: ${err.message}`);
  } finally { setBusy(false); loadRuns(); }
}
function run(text) {
  if (state.busy) return;
  leaveReplay();
  const files = state.files; state.files = []; $('chips').innerHTML = '';
  return streamFrom('/api/run', { sessionId: state.sessionId, text, files });
}
function decide(el, confirmed) {
  if (state.busy || el.classList.contains('decided')) return;
  const error = el.querySelector('.approval-error');
  error.hidden = true;
  return streamFrom('/api/approve', {
    sessionId: el.dataset.sessionId || state.sessionId, confirmId: el.dataset.confirmId, confirmed,
  }, (message) => {
    if (el.classList.contains('decided')) {
      draw({ type: 'error', message });
      return;
    }
    error.textContent = message;
    error.hidden = false;
    error.scrollIntoView({ block: 'nearest' });
  });
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('text').value.trim();
  if (!text && !state.files.length) return;
  $('text').value = '';
  run(text || 'Analizza il documento allegato e gestiscilo.');
});
$('file').addEventListener('change', async (e) => {
  for (const f of e.target.files) {
    const data = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.readAsDataURL(f); });
    state.files.push({ name: f.name, mimeType: f.type || 'application/pdf', data });
  }
  $('chips').innerHTML = state.files.map((f) => `<span class="chip">${esc(f.name)}</span>`).join('');
  e.target.value = '';
});
$('reset').addEventListener('click', async () => {
  if (state.busy) return;
  leaveReplay();
  renderData(await (await api('/api/reset', { method: 'POST' })).json());
  state.sessionId = null; state.calls.clear();
  emptyTrace();
});
$('newSession').addEventListener('click', () => {
  if (state.busy && !state.replaying) return;
  if (state.replaying) {
    state.replaying = null;
    setBusy(false);
  }
  leaveReplay();
  state.sessionId = null; state.calls.clear();
  emptyTrace();
});

// ---------- replay of a recorded run ----------
function showRecording(name) {
  const text = `Registrazione di una prova (${name}), non è un'esecuzione dal vivo`;
  $('recording').hidden = false;
  $('recording').textContent = text;
  $('trace').title = text;
}

function clearRecording() {
  $('recording').hidden = true;
  $('recording').textContent = '';
  $('trace').removeAttribute('title');
}

function leaveReplay() {
  if ($('recording').hidden) return;
  clearRecording();
  $('trace').replaceChildren();
  state.calls.clear();
  state.sessionId = null;
  renderData({ data: state.beforeReplay });
  state.beforeReplay = null;
}

// Filled at boot and after every run, never while the menu is open.
async function loadRuns() {
  if (!can('replay')) return;
  const runs = await api('/api/runs').then((res) => res.json()).catch(() => []);
  $('replay').innerHTML = '<option value="">Registrazioni</option>' + runs.map((r) => `<option>${esc(r)}</option>`).join('');
}
$('replay').addEventListener('change', async (e) => {
  const name = e.target.value;
  if (!name || state.busy) return;
  e.target.value = '';
  const replay = { name };
  state.beforeReplay ??= state.data;
  state.replaying = replay;
  setBusy(true);
  $('trace').replaceChildren();
  state.calls.clear();
  showRecording(name);
  try {
    const response = await api(`/api/runs/${encodeURIComponent(name)}`);
    if (!response.ok) throw new Error(`Errore ${response.status}`);
    const text = (await response.text()).trim();
    if (!text) throw new Error('La registrazione è vuota');
    const lines = text.split('\n').map((line) => JSON.parse(line));
    if (state.replaying !== replay) return;
    renderData({ data: state.beforeReplay });
    let prev = lines[0].t;
    for (const { t, step } of lines) {
      await new Promise((ok) => setTimeout(ok, Math.min(1500, Math.max(120, (t - prev) / 2))));
      if (state.replaying !== replay) return;
      prev = t;
      if (step.type !== 'session') draw(step, { live: false });
    }
  } catch (err) {
    if (state.replaying === replay) draw({ type: 'error', message: `Replay non riuscito: ${err.message}` });
  } finally {
    if (state.replaying === replay) {
      state.replaying = null;
      setBusy(false);
    }
  }
});

// ---------- login ----------
const DEMO_USERS = [
  ['sara', 'Sara Gallo', 'Contabilità fornitori'], ['luca', 'Luca Bertone', 'Acquisti'],
  ['elena', 'Elena Rinaldi', 'Responsabile finanza'], ['marta', 'Marta Ferrero', 'Direzione'],
];
$('demoUsers').innerHTML = DEMO_USERS.map(([u, name, role]) =>
  `<button type="button" data-user="${u}">${esc(name)} <span>${esc(role)}</span></button>`).join('');
$('demoUsers').addEventListener('click', (e) => {
  const u = e.target.closest('[data-user]')?.dataset.user; if (!u) return;
  // Demo accounts only: the shared demo password is printed on this page, so a click logs straight in.
  $('username').value = u; $('password').value = 'quadra-demo';
  $('loginForm').requestSubmit();
});

// A quiet starfield, the same every time (seeded), behind the constellation.
(function stars() {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  $('dust').innerHTML = Array.from({ length: 140 }, () =>
    `<circle cx="${(rnd() * 1440).toFixed(0)}" cy="${(rnd() * 900).toFixed(0)}" r="${(rnd() * 1.1 + .3).toFixed(2)}" opacity="${(rnd() * .5 + .15).toFixed(2)}"/>`).join('');
})();

function showLogin(message) {
  state.me = null; state.sessionId = null; state.data = {}; state.calls.clear(); state.tab = null;
  $('app').hidden = true; $('login').hidden = false;
  $('loginError').hidden = !message; $('loginError').textContent = message ?? '';
  document.title = 'Quadra · accedi';
  setTimeout(() => $('username').focus(), 0);
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginButton').disabled = true;
  try {
    const res = await api('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: $('username').value, password: $('password').value }) });
    const body = await res.json();
    if (!res.ok) { $('loginError').textContent = body.error ?? 'Accesso non riuscito.'; $('loginError').hidden = false; $('password').select(); return; }
    $('password').value = '';
    await enterApp(body);
  } finally { $('loginButton').disabled = false; }
});

$('logout').addEventListener('click', async () => {
  if (state.busy) return;
  leaveReplay();
  await fetch('/api/logout', { method: 'POST' });
  $('trace').replaceChildren();
  showLogin();
});

function emptyTrace() {
  const text = can('run')
    ? '<strong>Pronto.</strong>Avvia l\'autopilota sulla casella fornitori, oppure scegli una mail o scrivi qui sotto.'
    : isBoss() ? '' : '<strong>Niente da firmare.</strong>Quando una decisione spetta a te, la trovi qui.';
  $('trace').innerHTML = text ? `<div class="empty">${text}</div>` : '';
}

// Cards waiting for this profile: drawn live, each with the session it belongs to.
async function loadPending() {
  const cards = await api('/api/pending').then((r) => r.json()).catch(() => []);
  if (!cards.length) return;
  add(`<div class="head"><b>Quadra</b></div><div class="body">${isBoss()
    ? `${cards.length} ${cards.length === 1 ? 'decisione aspetta' : 'decisioni aspettano'} una firma.`
    : `${cards.length === 1 ? 'Una decisione aspetta' : `${cards.length} decisioni aspettano`} la tua firma.`}</div>`, 'message');
  for (const card of cards) {
    draw(card, { live: isBoss() ? 'watch' : true });
    const el = [...document.querySelectorAll('.step.approval')].at(-1);
    if (el && card.sessionId) el.dataset.sessionId = card.sessionId;
    if (card.sessionId) state.sessionId = card.sessionId;
  }
}

async function enterApp(me) {
  state.me = me;
  $('login').hidden = true; $('app').hidden = false;
  $('meName').textContent = me.name; $('meRole').textContent = me.role;
  document.title = `Quadra · ${me.name}`;
  $('composer').hidden = !can('run');
  $('autopilot').hidden = !can('run');
  $('reset').hidden = !can('run');
  $('newSession').hidden = !can('run');
  $('replay').hidden = !can('replay');
  $('traceTitle').textContent = can('run') ? 'L\'agente al lavoro' : isBoss() ? 'In corso' : 'Da firmare';
  $('dataTitle').textContent = isBoss() ? 'Tutta l\'azienda' : 'La tua parte';
  state.tab = null; state.auditFilter = 'all';
  renderData(await (await api('/api/data')).json());
  emptyTrace();
  await loadPending();
  loadRuns();
}

// ---------- boot ----------
const health = await (await fetch('/api/health')).json();
$('model').textContent = health.model;
const who = await fetch('/api/me');
if (who.ok) await enterApp(await who.json());
else showLogin();
