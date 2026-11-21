// Lists the Gemini models this key can use, so MODEL in .env can be set to one that exists.
import { GoogleGenAI } from '@google/genai';

const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_API_KEY;
if (!apiKey) { console.error('Manca GEMINI_API_KEY in .env'); process.exit(1); }
const ai = new GoogleGenAI({ apiKey });
for await (const m of await ai.models.list()) {
  if (m.supportedActions?.includes('generateContent')) console.log(m.name?.replace('models/', ''), '·', m.displayName);
}
