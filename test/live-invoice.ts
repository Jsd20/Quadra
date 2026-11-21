// Real Gemini on the sample invoice: does it call check_invoice with the document's numbers,
// copy the excerpts word for word, and how long does each step take? Needs GEMINI_API_KEY.
// Run: node --env-file=.env test/live-invoice.ts  (MODEL=... to try another model,
// RECORD=1 to keep the run in runs/ for the replay menu)
import './no-mail.ts';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createApp, type Step } from '../src/server.ts';

const model = process.env.MODEL || 'gemini-3.5-flash';
const pdf = readFileSync(new URL('../data/samples/fattura-ricambi-dora.pdf', import.meta.url)).toString('base64');
const server = createApp({ model, record: process.env.RECORD === '1' }).listen(0);
await new Promise((ok) => server.once('listening', ok));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
const t0 = Date.now();
const sec = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';
try {
  const res = await fetch(base + '/api/run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'È arrivata questa fattura, controllala.', files: [{ name: 'fattura-ricambi-dora.pdf', mimeType: 'application/pdf', data: pdf }] }),
  });
  const reader = res.body!.getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    const chunks = buf.split('\n\n'); buf = chunks.pop()!;
    for (const c of chunks.filter((c) => c.startsWith('data: '))) {
      const s = JSON.parse(c.slice(6)) as Step;
      const name = 'name' in s ? s.name : '';
      const detail = s.type === 'tool_call' && ['check_invoice', 'save_extraction'].includes(name) ? JSON.stringify(s.args)
        : s.type === 'tool_result' && name === 'check_invoice' ? JSON.stringify((s.response as any)?.discrepancies?.map((d: any) => d.code) ?? s.response)
        : s.type === 'tool_result' && name === 'save_extraction' ? JSON.stringify((s.response as any)?.fields?.map((f: any) => f.check))
        : s.type === 'message' || s.type === 'error' ? ('text' in s ? s.text : s.message)
        : s.type === 'approval' ? JSON.stringify(s.args) : '';
      console.log(sec(), s.type, name, detail.slice(0, 900));
    }
  }
} finally {
  server.close();
}
