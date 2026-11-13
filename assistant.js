// AI assistant: Claude reviews the circuit, explains results, suggests applications, and can build circuits and run
// analyses through two tools wired to the app (window.App, defined in app.js). Rule-based Insights work without it.
// Classic script (not type="module") so index.html still works when opened straight from disk; the SDK comes in via import().
(() => {
'use strict';
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm';
const MAX_STEPS = 8; // model calls per question (each tool round-trip is one)
const $ = (s) => document.querySelector(s);
let Anthropic = null, busy = false;
let history = []; // Anthropic MessageParam[]; assistant turns are stored exactly as returned

const SYSTEM = `You are the assistant inside Circuit Toolkit, a schematic editor and linear circuit simulator. The person you are helping is an engineer or student working on the circuit described at the top of each of their messages (netlist, the app's own rule-based insights, and the latest analysis results).

What the simulator supports: resistors, capacitors, inductors, independent voltage and current sources (DC, sine, square, triangle, sawtooth, step, or an expression of t), and ground. It solves linear circuits only: DC operating point, AC phasors at one frequency (sine sources only), transient (backward Euler, starting from zero unless the user chose the DC operating point), and Bode sweeps relative to the first sine source's amplitude. There are no diodes, transistors or op-amps; if a design needs one, say so and suggest a passive approximation or what to add outside the tool.

Netlist format, one part per line: NAME node+ node- value. Node 0 (or gnd) is ground. Values take SI prefixes: f p n u m k meg (m is milli, meg is mega). Sources: "V1 in 0 DC 5", "V1 in 0 SIN(offset amplitude freq 0 0 phase)", "V1 in 0 SQUARE(offset amplitude freq)", TRI(...), SAW(...), "V1 in 0 STEP(amplitude)", "V1 in 0 EXPR 5*sin(2*pi*50*t)". For a V source the first node is +; an I source pushes current from its first node through itself to the second. Give meaningful node names (in, out, mid, vcc): they become labels on the schematic.

Tools: build_circuit replaces the user's schematic, so call it only when they ask you to create, generate or change a circuit, and include every part (it is not a patch). Its result lists problems the app detects; fix real ones with another call. run_analysis simulates the current schematic and returns the results table; when numbers matter, run it rather than estimating, then quote what it returned.

Answering: lead with the answer. For reviews, list problems most severe first, each with its fix. For applications, name the most likely ones and the figures that support them. Keep replies short. The chat shows plain text, so use simple dashes for lists and no Markdown tables or headings.`;

// eager_input_streaming: inputs stream as generated; the API then doesn't validate them, so runTool validates.
const TOOLS = [
  {
    name: 'build_circuit',
    description: "Replace the schematic on the user's canvas with a new circuit, drawn automatically from a netlist. Returns how many parts were loaded and the problems the app detected.",
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        netlist: { type: 'string', description: 'Complete netlist, one part per line, in the format from the system prompt.' },
        title: { type: 'string', description: 'Short name for the circuit, e.g. "1 kHz RC low-pass".' },
      },
      required: ['netlist', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_analysis',
    description: 'Simulate the current schematic and return the results table. dc = operating point; ac = phasors at one frequency; tran = time domain; bode = frequency sweep.',
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['dc', 'ac', 'tran', 'bode'] },
        setting: { type: 'string', description: 'tran: stop time like "10m"; ac: frequency like "1k"; bode: sweep like "10-100k". Empty string keeps the current setting.' },
      },
      required: ['mode', 'setting'],
      additionalProperties: false,
    },
  },
];

// ---------- settings ----------
try {
  const k = localStorage.getItem('anthropicKey');
  if (k) { $('#akey').value = k; $('#aremember').checked = true; }
  const m = localStorage.getItem('anthropicModel');
  if (m) $('#amodel').value = m;
} catch {}
function persist() {
  try {
    if ($('#aremember').checked && $('#akey').value.trim()) localStorage.setItem('anthropicKey', $('#akey').value.trim());
    else localStorage.removeItem('anthropicKey');
    localStorage.setItem('anthropicModel', $('#amodel').value);
  } catch {}
}
for (const s of ['#akey', '#aremember', '#amodel']) $(s).addEventListener('change', persist);

// ---------- chat ----------
function addMsg(kind, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + kind;
  d.textContent = text;
  $('#alog').append(d);
  $('#alog').scrollTop = $('#alog').scrollHeight;
  return d;
}
const context = () => `<circuit_netlist>\n${App.netlist()}\n</circuit_netlist>\n<app_insights>\n${App.insights()}\n</app_insights>\n<latest_results>\n${App.results()}\n</latest_results>`;

function runTool(u) {
  const inp = u.input || {};
  const result = (content, isError) => ({ type: 'tool_result', tool_use_id: u.id, content, ...(isError ? { is_error: true } : {}) });
  try {
    if (u.name === 'build_circuit') {
      if (typeof inp.netlist !== 'string' || !inp.netlist.trim()) throw new Error('netlist must be a non-empty string');
      const out = App.build(inp.netlist);
      addMsg('tool', `🔧 Built “${inp.title || 'circuit'}” on the canvas (Ctrl+Z undoes it)`);
      return result(out);
    }
    if (u.name === 'run_analysis') {
      if (!['dc', 'ac', 'tran', 'bode'].includes(inp.mode)) throw new Error('mode must be one of dc, ac, tran, bode');
      const setting = typeof inp.setting === 'string' ? inp.setting.trim() : '';
      const out = App.analyse(inp.mode, setting);
      addMsg('tool', `▶ Ran ${inp.mode.toUpperCase()} analysis${setting ? ` (${setting})` : ''}`);
      return result(out);
    }
    throw new Error(`unknown tool ${u.name}`);
  } catch (e) {
    addMsg('tool', `⚠ ${u.name} failed: ${e.message}`);
    return result(e.message, true);
  }
}

function describe(e) {
  if (!Anthropic) return `Couldn’t load the Anthropic SDK (needs an internet connection): ${e.message}`;
  if (e instanceof Anthropic.AuthenticationError) return 'The API key was rejected. Check it in the panel on the right.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'This API key isn’t allowed to use that model.';
  if (e instanceof Anthropic.RateLimitError) return 'Rate limited. Wait a moment and try again.';
  if (e instanceof Anthropic.APIError && e.status) return `API error ${e.status}: ${e.message}`;
  return `Request failed: ${e.message}`;
}

async function ask(question) {
  if (busy || !question) return;
  const key = $('#akey').value.trim();
  if (!key) return addMsg('assistant err', 'Add your Anthropic API key in the panel on the right to use the assistant. The Insights panel works without one.');
  busy = true;
  $('#asend').disabled = true;
  const mark = history.length;
  addMsg('user', question);
  try {
    if (!Anthropic) Anthropic = (await import(SDK_URL)).default;
    const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
    const model = $('#amodel').value;
    const text = `${context()}\n\n${question}`;
    const last = history[history.length - 1];
    if (last && last.role === 'user') last.content.push({ type: 'text', text }); // previous turn ended on tool results
    else history.push({ role: 'user', content: [{ type: 'text', text }] });

    let step = 0;
    for (; step < MAX_STEPS; step++) {
      const bubble = addMsg('assistant', '…');
      let started = false;
      const params = { model, max_tokens: 32000, system: SYSTEM, tools: TOOLS, messages: history, output_config: { effort: 'medium' } };
      // Server-side refusal fallback (Opus/Sonnet 5.5): a declined request is retried on a fallback model in the same call.
      if (model !== 'claude-haiku-5-5') Object.assign(params, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
      const stream = client.beta.messages.stream(params);
      stream.on('text', (t) => {
        if (!started) { bubble.textContent = ''; started = true; }
        bubble.textContent += t;
        $('#alog').scrollTop = $('#alog').scrollHeight;
      });
      const msg = await stream.finalMessage();
      if (!started) bubble.remove();
      if (msg.stop_reason === 'refusal') {
        history.length = mark;
        addMsg('assistant err', 'The model declined this request.');
        break;
      }
      history.push({ role: 'assistant', content: msg.content });
      if (msg.stop_reason === 'max_tokens') { addMsg('assistant err', 'The reply hit the length limit and was cut off.'); break; }
      const uses = msg.content.filter((b) => b.type === 'tool_use');
      if (msg.stop_reason !== 'tool_use' || !uses.length) break;
      history.push({ role: 'user', content: uses.map(runTool) });
    }
    if (step === MAX_STEPS) addMsg('tool', `Stopped after ${MAX_STEPS} steps. Send another message to let it continue.`);
  } catch (e) {
    history.length = mark; // drop the failed turn so the conversation stays valid
    $('#alog').querySelectorAll('.msg.assistant').forEach((m) => { if (m.textContent === '…') m.remove(); });
    addMsg('assistant err', describe(e));
  } finally {
    busy = false;
    $('#asend').disabled = false;
  }
}

$('#aform').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const q = $('#ain').value.trim();
  $('#ain').value = '';
  ask(q);
});
$('#aquick').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  if (b.id === 'anew') { history = []; $('#alog').querySelectorAll('.msg').forEach((m) => m.remove()); return; }
  if (b.dataset.fill) { $('#ain').value = b.dataset.fill; $('#ain').focus(); return; }
  ask(b.dataset.q);
});
})();
