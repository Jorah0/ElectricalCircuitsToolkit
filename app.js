// Circuit Toolkit UI: schematic editor (parts + branching traces), analysis runner, waveform plots, math console.
'use strict';
const GRID = 20;
const $ = (s) => document.querySelector(s);
const svg = $('#canvas');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const { parseSI, fmt, terms } = CT; // units, geometry and connectivity live in circuit.js
const fmtIn = (s, unit) => { const n = parseSI(s); return isNaN(n) ? s + '?' : fmt(n, unit); };
const fmtVal = (v, unit) => (unit === 'dB' || unit === '°' ? +v.toFixed(2) + ' ' + unit : unit ? fmt(v, unit, 4) : String(+v.toPrecision(5)));

// ---------- complex helpers (phasors are [re, im]) ----------
const cmag = (z) => Math.hypot(z[0], z[1]);
const cang = (z) => (Math.atan2(z[1], z[0]) * 180) / Math.PI;
const csub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const cdiv = (a, b) => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; };
const polar = (z, unit) => `${fmt(cmag(z), unit)} ∠ ${cang(z).toFixed(1)}°`;

// ---------- part library (drawn horizontally, terminals at x = ±40) ----------
const DEF = {
  R: { label: 'Resistor', unit: 'Ω', value: '1k', d: 'M-40 0H-24L-20-8L-12 8L-4-8L4 8L12-8L20 8L24 0H40' },
  C: { label: 'Capacitor', unit: 'F', value: '1u', d: 'M-40 0H-5M-5-14V14M5-14V14M5 0H40' },
  L: { label: 'Inductor', unit: 'H', value: '10m', d: 'M-40 0H-24a6 6 0 0 1 12 0a6 6 0 0 1 12 0a6 6 0 0 1 12 0a6 6 0 0 1 12 0H40' },
  V: { label: 'Voltage source (left/top terminal = +)', unit: 'V', value: '5', src: true, d: 'M-40 0H-16M16 0H40M-11 0H-5M-8-3V3M5 0H11' },
  I: { label: 'Current source (flows along arrow)', unit: 'A', value: '1m', src: true, d: 'M-40 0H-16M16 0H40M-9 0H9M3-5L9 0L3 5' },
  G: { label: 'Ground (0 V reference)', d: 'M0 0V12M-12 12H12M-7 17H7M-3 22H3' },
};
const WAVES = { dc: 'DC', sine: 'Sine', square: 'Square', triangle: 'Triangle', sawtooth: 'Sawtooth', step: 'Step (at t=0)', expr: 'Expression f(t)' };

// ---------- state ----------
let S = { parts: [], wires: [], n: 1 };
let tool = 'select', sel = null, ghostRot = 0, wireFrom = null, wireFlip = false, mouse = { x: 0, y: 0 }, drag = null, pan = null;
let view = { x: -20, y: -20, z: 1 };
let result = null;
const undoStack = [], redoStack = [];
const byId = (kind, id) => (kind === 'part' ? S.parts : S.wires).find((o) => o.id === id);
const selPart = () => sel && sel.kind === 'part' && byId('part', sel.id);
const snapshot = (state = JSON.stringify(S)) => { undoStack.push(state); if (undoStack.length > 200) undoStack.shift(); redoStack.length = 0; };
function changed() {
  try { localStorage.setItem('circuit', JSON.stringify(S)); } catch {}
  if (result) { result = null; $('#results').innerHTML = '<p class="hint">Circuit changed — re-run an analysis.</p>'; }
  render();
  updateInsights();
}
function undo(from = undoStack, to = redoStack) {
  if (!from.length) return;
  to.push(JSON.stringify(S));
  S = JSON.parse(from.pop());
  sel = null; wireFrom = null;
  changed(); showProps();
}
const redo = () => undo(redoStack, undoStack);

const nets = () => CT.nets(S.parts, S.wires);

function compileT(expr, who) {
  if (!window.nerdamer) throw new Error('Math library failed to load (needs internet for the CDN).');
  try { return nerdamer(expr).buildFunction(['t']); } catch (e) { throw new Error(`${who}: bad expression "${expr}" — ${e.message}`); }
}
function compile() {
  const N = nets();
  if (!N.hasGround) throw new Error('Add a Ground (G): the circuit needs a 0 V reference node.');
  const elements = [], idx = new Map();
  for (const p of S.parts) {
    if (p.type === 'G') continue;
    const [ta, tb] = terms(p);
    const e = { type: p.type, a: N.nodeAt(ta), b: N.nodeAt(tb), value: parseSI(p.value) };
    const isExpr = DEF[p.type].src && p.wave === 'expr';
    if (!isExpr && (!isFinite(e.value) || ('RCL'.includes(p.type) && e.value <= 0))) throw new Error(`${p.name}: invalid value "${p.value}"`);
    if (DEF[p.type].src) {
      Object.assign(e, { wave: p.wave, freq: parseSI(p.freq) || 0, phase: parseSI(p.phase) || 0, offset: parseSI(p.offset) || 0 });
      if (isExpr) e.fn = compileT(p.expr, p.name);
    }
    idx.set(p.id, elements.length);
    elements.push(e);
  }
  if (!elements.length) throw new Error('Place some parts first.');
  return { ckt: { nodeCount: N.names.length, elements }, names: N.names, idx, parts: S.parts.filter((p) => p.type !== 'G') };
}

// ---------- rendering ----------
function valueText(p) {
  const d = DEF[p.type];
  if (!d.unit) return '';
  if (!d.src || p.wave === 'dc') return fmtIn(p.value, d.unit);
  if (p.wave === 'expr') return 'f(t) = ' + p.expr;
  if (p.wave === 'step') return fmtIn(p.value, d.unit) + ' step';
  return `${fmtIn(p.value, d.unit)} ${p.wave} ${fmtIn(p.freq, 'Hz')}`;
}
function partSVG(p, cls) {
  const d = DEF[p.type];
  const hit = p.type === 'G' ? '<rect class="hitbox" x="-14" y="-4" width="28" height="30"/>' : '<rect class="hitbox" x="-40" y="-18" width="80" height="36"/>';
  let lbl = '';
  if (p.type !== 'G') {
    const vt = esc(valueText(p));
    lbl = p.rot % 180
      ? `<text class="lbl" x="${p.x + 22}" y="${p.y - 3}">${esc(p.name)}</text><text class="lbl val" x="${p.x + 22}" y="${p.y + 12}">${vt}</text>`
      : `<text class="lbl" x="${p.x}" y="${p.y - 24}" text-anchor="middle">${esc(p.name)} <tspan class="lbl val">${vt}</tspan></text>`;
  }
  return `<g class="part ${cls}" data-kind="part" data-id="${p.id}"><g transform="translate(${p.x} ${p.y}) rotate(${p.rot})">${hit}${d.src ? '<circle r="16"/>' : ''}<path d="${d.d}"/></g>${lbl}</g>`;
}
function route(a, b) { // L-shaped trace; F flips which leg comes first
  const mid = (Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)) !== wireFlip ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
  return [[a, mid], [mid, b]].filter(([p, q]) => p.x !== q.x || p.y !== q.y).map(([p, q]) => ({ x1: p.x, y1: p.y, x2: q.x, y2: q.y }));
}
function render() {
  const N = nets();
  const isSel = (kind, id) => sel && sel.kind === kind && sel.id === id;
  let h = '<defs><pattern id="gp" x="-10" y="-10" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="10" cy="10" r="1.1" style="fill:var(--axis)"/></pattern></defs><rect x="-50000" y="-50000" width="100000" height="100000" fill="url(#gp)"/>';
  for (const w of S.wires) {
    const xy = `x1="${w.x1}" y1="${w.y1}" x2="${w.x2}" y2="${w.y2}"`;
    h += `<g data-kind="wire" data-id="${w.id}"><line class="wirehit" ${xy}/><line class="wire${isSel('wire', w.id) ? ' sel' : ''}" ${xy}/></g>`;
  }
  for (const p of S.parts) h += partSVG(p, isSel('part', p.id) ? 'sel' : '');
  for (const [key, n] of N.deg) {
    const p = N.pts.get(key);
    if (n >= 3) h += `<circle class="dot" cx="${p.x}" cy="${p.y}" r="4"/>`;
    else if (n === 1 && S.parts.some((q) => terms(q).some((t) => t.x === p.x && t.y === p.y))) h += `<circle class="term" cx="${p.x}" cy="${p.y}" r="3"/>`;
  }
  N.names.forEach((nm, i) => {
    if (!i || !N.pos[i]) return;
    let txt = nm;
    if (result && result.mode === 'dc') txt += ' = ' + fmt(result.data.v[i], 'V');
    if (result && result.mode === 'ac') txt += ' = ' + polar(result.data.v[i], 'V');
    h += `<text class="netlbl" x="${N.pos[i].x + 4}" y="${N.pos[i].y - 6}">${esc(txt)}</text>`;
  });
  if (DEF[tool]) h += `<g class="ghost">${partSVG({ type: tool, x: mouse.x, y: mouse.y, rot: ghostRot, name: '', value: DEF[tool].value, wave: 'dc' }, '')}</g>`;
  if (tool === 'wire' && wireFrom) for (const s of route(wireFrom, mouse)) h += `<line class="preview" x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}"/>`;
  if (tool !== 'select') h += `<circle class="cursor" cx="${mouse.x}" cy="${mouse.y}" r="5"/>`;
  svg.innerHTML = h;
}
function setViewBox() {
  svg.setAttribute('viewBox', `${view.x} ${view.y} ${svg.clientWidth / view.z} ${svg.clientHeight / view.z}`);
}

// ---------- properties panel ----------
const field = (label, f, val) => `<label>${label}<input data-f="${f}" value="${esc(val ?? '')}"></label>`;
function partReadout(p) {
  if (!result || !result.idx.has(p.id)) return '';
  const i = result.idx.get(p.id), e = result.ckt.elements[i], d = result.data;
  if (result.mode === 'dc') {
    const V = d.v[e.a] - d.v[e.b], I = d.i[i];
    return `<table><tr><th>Voltage (a→b)</th><td>${fmt(V, 'V', 4)}</td></tr><tr><th>Current (a→b)</th><td>${fmt(I, 'A', 4)}</td></tr><tr><th>Power absorbed</th><td>${fmt(V * I, 'W', 4)}</td></tr></table>`;
  }
  if (result.mode === 'ac') {
    const V = csub(d.v[e.a], d.v[e.b]), I = d.i[i];
    const Z = cmag(I) > 1e-15 ? polar(cdiv(V, I), 'Ω') : '∞';
    return `<table><tr><th>Voltage</th><td>${polar(V, 'V')}</td></tr><tr><th>Current</th><td>${polar(I, 'A')}</td></tr><tr><th>Impedance V/I</th><td>${Z}</td></tr></table>`;
  }
  return '';
}
function showProps() {
  const el = $('#props');
  const o = sel && byId(sel.kind, sel.id);
  if (!o) { el.innerHTML = '<p class="hint">Press a part key (<kbd>R</kbd> <kbd>C</kbd> <kbd>L</kbd> <kbd>V</kbd> <kbd>I</kbd> <kbd>G</kbd>) and click to place; <kbd>E</kbd>/<kbd>Q</kbd> rotate. <kbd>W</kbd> draws traces — start or end one on another trace to branch it. <kbd>?</kbd> lists every key.</p>'; return; }
  if (sel.kind === 'wire') {
    const n = nets().nodeAt({ x: o.x1, y: o.y1 });
    let v = '';
    if (result && n !== undefined && result.mode === 'dc') v = fmt(result.data.v[n], 'V', 4);
    if (result && n !== undefined && result.mode === 'ac') v = polar(result.data.v[n], 'V');
    el.innerHTML = `<p class="hint">Trace on net <b>${esc(n === undefined ? '(unconnected)' : nets().names[n])}</b>${v ? ' = ' + v : ''}</p>
      ${field('Net label (names the node in results & plots)', 'label', o.label)}
      <div class="row" style="margin-top:8px"><button data-act="del">Delete trace</button></div>`;
    return;
  }
  const d = DEF[o.type];
  let h = `<p class="hint">${esc(d.label)}</p><div class="grid2">${field('Name', 'name', o.name)}`;
  if (d.src) {
    h += `<label>Waveform<select data-f="wave">${Object.entries(WAVES).map(([k, v]) => `<option value="${k}"${o.wave === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>`;
    if (o.wave !== 'expr') h += field(o.wave === 'dc' ? `Value (${d.unit})` : `Amplitude (${d.unit})`, 'value', o.value);
    if (['sine', 'square', 'triangle', 'sawtooth'].includes(o.wave)) h += field('Frequency (Hz)', 'freq', o.freq) + field('Phase (°)', 'phase', o.phase);
    if (o.wave !== 'dc' && o.wave !== 'expr') h += field(`DC offset (${d.unit})`, 'offset', o.offset);
    h += '</div>';
    if (o.wave === 'expr') h += field(`f(t) in ${d.unit}, t in seconds`, 'expr', o.expr) + '<p class="hint">e.g. 5*sin(2*pi*50*t)*exp(-t/0.01)</p>';
  } else if (d.unit) h += field(`Value (${d.unit})`, 'value', o.value) + '</div>';
  else h += '</div>';
  h += `<div class="row" style="margin-top:8px"><button data-act="rotl" title="Q">⟲</button><button data-act="rot" title="E / Space">⟳ Rotate</button><button data-act="flip" title="F: swap terminals">Flip</button><button data-act="dup" title="Ctrl+D">Duplicate</button><button data-act="del" title="Delete">Delete</button></div>${partReadout(o)}`;
  el.innerHTML = h;
}
$('#props').addEventListener('change', (ev) => {
  const f = ev.target.dataset.f, o = sel && byId(sel.kind, sel.id);
  if (!f || !o) return;
  snapshot();
  o[f] = ev.target.value;
  if (f === 'value' || f === 'freq' || f === 'phase' || f === 'offset') ev.target.style.borderColor = isNaN(parseSI(o[f])) ? 'var(--err)' : '';
  changed();
  if (f === 'wave') showProps();
});
$('#props').addEventListener('click', (ev) => {
  const a = ev.target.dataset.act;
  if (a === 'del') del();
  if (a === 'rot') rotate(1);
  if (a === 'rotl') rotate(-1);
  if (a === 'flip') flip();
  if (a === 'dup') duplicate();
});

// ---------- editing actions ----------
function setTool(t) {
  tool = t; wireFrom = null;
  document.querySelectorAll('#tools button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.tool === t));
  svg.style.cursor = t === 'select' ? 'default' : 'crosshair';
  render();
}
function select(kind, id) {
  sel = kind ? { kind, id } : null;
  render(); showProps();
}
function del() {
  if (!sel) return;
  snapshot();
  if (sel.kind === 'part') S.parts = S.parts.filter((p) => p.id !== sel.id);
  else S.wires = S.wires.filter((w) => w.id !== sel.id);
  sel = null; changed(); showProps();
}
// Apply a change to a part and keep the trace ends that touched each terminal attached to that terminal.
function movePart(p, change) {
  const ts = terms(p), ends = [];
  for (const w of S.wires) for (const e of [1, 2]) { const j = ts.findIndex((t) => t.x === w['x' + e] && t.y === w['y' + e]); if (j >= 0) ends.push({ w, e, j }); }
  snapshot();
  change(p);
  const nt = terms(p);
  for (const { w, e, j } of ends) { w['x' + e] = nt[j].x; w['y' + e] = nt[j].y; }
  changed(); showProps();
}
function rotate(dir = 1) {
  if (DEF[tool]) { ghostRot = (ghostRot + 90 * dir + 360) % 360; return render(); }
  const p = selPart();
  if (p) movePart(p, (q) => { q.rot = (q.rot + 90 * dir + 360) % 360; });
}
function flip() { // reverse a part in place (swaps its terminals: source polarity, current direction); while tracing, flips the bend
  if (tool === 'wire') { wireFlip = !wireFlip; return render(); }
  if (DEF[tool]) { ghostRot = (ghostRot + 180) % 360; return render(); }
  const p = selPart();
  if (!p) return;
  snapshot(); p.rot = (p.rot + 180) % 360; changed(); showProps();
}
function uniqueName(type) {
  const prefix = type === 'G' ? 'GND' : type;
  let n = 1;
  while (S.parts.some((p) => p.name === prefix + n)) n++;
  return prefix + n;
}
function duplicate() {
  const p = selPart();
  if (!p) return;
  snapshot();
  const q = { ...p, id: S.n++, x: p.x + 2 * GRID, y: p.y + 2 * GRID, name: uniqueName(p.type) };
  S.parts.push(q);
  sel = { kind: 'part', id: q.id };
  changed(); showProps();
}
function fit() {
  const b = bounds();
  if (!b) { view = { x: -20, y: -20, z: 1 }; return setViewBox(); }
  const { x0, x1, y0, y1 } = b;
  view.z = Math.min(2, Math.max(0.25, Math.min(svg.clientWidth / (x1 - x0), svg.clientHeight / (y1 - y0))));
  view.x = (x0 + x1) / 2 - svg.clientWidth / view.z / 2;
  view.y = (y0 + y1) / 2 - svg.clientHeight / view.z / 2;
  setViewBox();
}
function place(at) {
  snapshot();
  const p = { id: S.n++, type: tool, x: at.x, y: at.y, rot: ghostRot, name: uniqueName(tool), value: DEF[tool].value || '', wave: 'dc', freq: '1k', phase: '0', offset: '0', expr: '5*sin(2*pi*1000*t)' };
  S.parts.push(p);
  sel = { kind: 'part', id: p.id };
  changed(); showProps();
}
function wireClick(at) {
  if (!wireFrom) { wireFrom = at; render(); return; }
  if (at.x === wireFrom.x && at.y === wireFrom.y) { wireFrom = null; render(); return; }
  const endsHere = nets().touches(at); // landing on a terminal or trace finishes the trace
  snapshot();
  for (const s of route(wireFrom, at)) S.wires.push({ id: S.n++, ...s });
  wireFrom = endsHere ? null : at;
  changed();
}

// ---------- canvas input ----------
function svgPt(ev) {
  const pt = svg.createSVGPoint();
  pt.x = ev.clientX; pt.y = ev.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}
const snap = (p) => ({ x: Math.round(p.x / GRID) * GRID, y: Math.round(p.y / GRID) * GRID });

svg.addEventListener('pointerdown', (ev) => {
  svg.focus();
  const at = snap(svgPt(ev));
  if (ev.button === 1 || (ev.button === 0 && ev.altKey)) {
    pan = { cx: ev.clientX, cy: ev.clientY, vx: view.x, vy: view.y };
    svg.setPointerCapture(ev.pointerId); ev.preventDefault(); return;
  }
  if (ev.button !== 0) return;
  if (tool === 'wire') return wireClick(at);
  if (DEF[tool]) return place(at);
  const hit = ev.target.closest('[data-id]');
  if (!hit) { select(null); pan = { cx: ev.clientX, cy: ev.clientY, vx: view.x, vy: view.y }; svg.setPointerCapture(ev.pointerId); return; }
  select(hit.dataset.kind, +hit.dataset.id);
  if (hit.dataset.kind === 'part') {
    const part = byId('part', +hit.dataset.id), ts = terms(part);
    const ends = []; // trace ends attached to this part follow it while dragging
    for (const w of S.wires) for (const e of [1, 2]) if (ts.some((t) => t.x === w['x' + e] && t.y === w['y' + e])) ends.push({ w, e, x: w['x' + e], y: w['y' + e] });
    drag = { part, start: at, ox: part.x, oy: part.y, ends, before: JSON.stringify(S), moved: false };
    svg.setPointerCapture(ev.pointerId);
  }
});
svg.addEventListener('pointermove', (ev) => {
  if (pan) {
    view.x = pan.vx - (ev.clientX - pan.cx) / view.z;
    view.y = pan.vy - (ev.clientY - pan.cy) / view.z;
    return setViewBox();
  }
  const at = snap(svgPt(ev));
  if (at.x === mouse.x && at.y === mouse.y) return;
  mouse = at;
  if (drag) {
    const dx = at.x - drag.start.x, dy = at.y - drag.start.y;
    drag.moved = true;
    drag.part.x = drag.ox + dx; drag.part.y = drag.oy + dy;
    for (const { w, e, x, y } of drag.ends) { w['x' + e] = x + dx; w['y' + e] = y + dy; }
    return render();
  }
  if (tool !== 'select') render();
});
svg.addEventListener('pointerup', () => {
  if (drag && drag.moved) { snapshot(drag.before); changed(); showProps(); }
  drag = pan = null;
});
svg.addEventListener('dblclick', () => { if (tool === 'wire') { wireFrom = null; render(); } });
svg.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  if (tool === 'wire' && wireFrom) { wireFrom = null; render(); } else setTool('select');
});
svg.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const world = svgPt(ev), r = svg.getBoundingClientRect();
  view.z = Math.min(4, Math.max(0.25, view.z * Math.exp(-ev.deltaY * 0.0015)));
  view.x = world.x - (ev.clientX - r.left) / view.z;
  view.y = world.y - (ev.clientY - r.top) / view.z;
  setViewBox();
}, { passive: false });

// Keyboard shortcuts (full list in the "? Keys" dialog in index.html).
const TOOL_KEYS = { s: 'select', w: 'wire', r: 'R', c: 'C', l: 'L', v: 'V', i: 'I', g: 'G' };
const RUN_KEYS = { d: 'dc', a: 'ac', t: 'tran', b: 'bode' };
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
document.addEventListener('keydown', (ev) => {
  const k = ev.key, lk = k.toLowerCase(), mod = ev.ctrlKey || ev.metaKey;
  if (mod && lk === 's') { ev.preventDefault(); return save(ev.shiftKey); }
  if (mod && lk === 'o') { ev.preventDefault(); return openFile(); }
  if (ev.target.matches('input, textarea, select') || document.querySelector('dialog[open]')) return;
  if (mod && lk === 'z') { ev.preventDefault(); return ev.shiftKey ? redo() : undo(); }
  if (mod && lk === 'y') { ev.preventDefault(); return redo(); }
  if (mod && lk === 'd') { ev.preventDefault(); return duplicate(); }
  if (mod || ev.altKey) return;
  if (ARROWS[k]) {
    ev.preventDefault();
    const [dx, dy] = ARROWS[k], p = selPart();
    if (p) movePart(p, (q) => { q.x += dx * GRID; q.y += dy * GRID; });
    else { view.x += (dx * 80) / view.z; view.y += (dy * 80) / view.z; setViewBox(); }
    return;
  }
  if (k === 'Escape') { if (wireFrom) { wireFrom = null; render(); } else { setTool('select'); select(null); } }
  else if (k === ' ' || lk === 'e') { ev.preventDefault(); rotate(1); }
  else if (lk === 'q') rotate(-1);
  else if (lk === 'f') flip();
  else if (k === 'Delete' || k === 'Backspace') { ev.preventDefault(); del(); }
  else if (lk === 'h') fit();
  else if (k === '?') $('#keys').showModal();
  else if (RUN_KEYS[lk]) tryRun(RUN_KEYS[lk]);
  else if (TOOL_KEYS[lk]) setTool(TOOL_KEYS[lk]);
});
document.querySelectorAll('#tools button').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
// After clicking a toolbar/panel button, hand focus back to the canvas so Space/keys act on the schematic, not the button.
document.addEventListener('click', (ev) => { if (ev.target.closest('header button, #props button, .row > button[id^="run-"]')) svg.focus({ preventScroll: true }); });
$('#keysbtn').onclick = () => $('#keys').showModal();

// ---------- file ops ----------
$('#undo').onclick = () => undo();
$('#redo').onclick = () => redo();
$('#clear').onclick = () => { snapshot(); S = { parts: [], wires: [], n: 1 }; sel = null; fileHandle = null; changed(); showProps(); status('Cleared (Ctrl+Z to undo).'); };
function status(msg, err) { const s = $('#status'); s.textContent = msg; s.className = 'grow' + (err ? ' err' : ''); }

// ---------- files: save / open (JSON circuit or SPICE-style netlist) / export ----------
// Chrome & Edge get real file handles (Ctrl+S re-saves the same file); other browsers fall back to download/upload.
let fileHandle = null;
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function save(saveAs) {
  const blob = new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' });
  if (!window.showSaveFilePicker) { download(blob, 'circuit.json'); return status('Downloaded circuit.json'); }
  try {
    if (saveAs || !fileHandle) fileHandle = await showSaveFilePicker({ suggestedName: fileHandle?.name || 'circuit.json', types: [{ description: 'Circuit', accept: { 'application/json': ['.json'] } }] });
    const w = await fileHandle.createWritable();
    await w.write(blob); await w.close();
    status(`Saved ${fileHandle.name}`);
  } catch (e) { if (e.name !== 'AbortError') status('Save failed: ' + e.message, true); }
}
function loadCircuit(d, label) {
  if (!d || !Array.isArray(d.parts) || !Array.isArray(d.wires)) throw new Error('not a circuit file (needs "parts" and "wires")');
  snapshot();
  S = d;
  S.n = Math.max(S.n || 1, ...S.parts.map((p) => p.id + 1), ...S.wires.map((w) => w.id + 1));
  sel = null; wireFrom = null;
  changed(); showProps(); fit(); status(label);
}
function loadText(text, name) { // a JSON circuit, or a netlist that gets auto-laid-out
  if (/^\s*\{/.test(text)) return loadCircuit(JSON.parse(text), `Opened ${name}`);
  loadCircuit(CT.layout(CT.parseNetlist(text)), `Built ${name} from its netlist`);
}
async function openFile() {
  if (!window.showOpenFilePicker) return $('#import').click();
  try {
    const [h] = await showOpenFilePicker({ types: [{ description: 'Circuit or netlist', accept: { 'application/json': ['.json'], 'text/plain': ['.cir', '.net', '.sp', '.spice', '.txt'] } }] });
    const f = await h.getFile();
    loadText(await f.text(), f.name);
    fileHandle = f.name.endsWith('.json') ? h : null;
  } catch (e) { if (e.name !== 'AbortError') status('Could not open: ' + e.message, true); }
}
$('#import').onchange = async (ev) => {
  const f = ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  try { loadText(await f.text(), f.name); fileHandle = null; } catch (e) { status('Could not open file: ' + e.message, true); }
};
$('#save').onclick = () => save(false);
$('#open').onclick = openFile;
svg.addEventListener('dragover', (ev) => ev.preventDefault());
svg.addEventListener('drop', async (ev) => {
  ev.preventDefault();
  const f = ev.dataTransfer.files[0];
  if (f) try { loadText(await f.text(), f.name); fileHandle = null; } catch (e) { status('Could not open file: ' + e.message, true); }
});

function bounds() {
  const xs = [], ys = [];
  for (const p of S.parts) for (const t of [...terms(p), p]) { xs.push(t.x); ys.push(t.y); }
  for (const w of S.wires) { xs.push(w.x1, w.x2); ys.push(w.y1, w.y2); }
  if (!xs.length) return null;
  return { x0: Math.min(...xs) - 60, x1: Math.max(...xs) + 60, y0: Math.min(...ys) - 60, y1: Math.max(...ys) + 60 };
}
const EXPORT_CSS = `.part path,.part circle{fill:none;stroke:#111;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.wire{stroke:#111;stroke-width:2;stroke-linecap:round}.dot{fill:#111}.term{fill:#fff;stroke:#888;stroke-width:1.5}
text{font:12px system-ui,-apple-system,"Segoe UI",sans-serif;fill:#111}.val{fill:#52514e}.netlbl{font-size:11px;fill:#2a78d6}`;
function exportSVG() {
  const b = bounds();
  if (!b) throw new Error('Nothing to export yet.');
  const w = b.x1 - b.x0, h = b.y1 - b.y0, c = svg.cloneNode(true);
  c.querySelectorAll('defs, rect[fill^="url"], .ghost, .cursor, .preview, .wirehit, .hitbox').forEach((n) => n.remove());
  c.querySelectorAll('.sel').forEach((n) => n.classList.remove('sel'));
  c.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  c.setAttribute('viewBox', `${b.x0} ${b.y0} ${w} ${h}`);
  c.setAttribute('width', w); c.setAttribute('height', h);
  c.removeAttribute('style'); c.removeAttribute('tabindex');
  c.insertAdjacentHTML('afterbegin', `<style>${EXPORT_CSS}</style><rect x="${b.x0}" y="${b.y0}" width="${w}" height="${h}" fill="#fff"/>`);
  return { text: new XMLSerializer().serializeToString(c), w, h };
}
const csvCell = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
function exportAs(kind) {
  if (kind === 'svg') download(new Blob([exportSVG().text], { type: 'image/svg+xml' }), 'circuit.svg');
  if (kind === 'png') {
    const { text, w, h } = exportSVG(), img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = w * 2; c.height = h * 2;
      const g = c.getContext('2d');
      g.scale(2, 2); g.drawImage(img, 0, 0, w, h);
      c.toBlob((blob) => download(blob, 'circuit.png'));
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
  }
  if (kind === 'cir') download(new Blob([`* Circuit Toolkit netlist\n${CT.toNetlist(S.parts, S.wires)}\n.end\n`], { type: 'text/plain' }), 'circuit.cir');
  if (kind === 'csv') {
    if (!wave) throw new Error('Run a Transient or Bode analysis first — the CSV holds its waveforms.');
    const head = [wave.xunit === 's' ? 'time (s)' : 'frequency (Hz)', ...wave.signals.map((s) => `${s.name} (${s.unit})`)];
    const rows = wave.x.map((x, i) => [x, ...wave.signals.map((s) => s.ys[i])].join(','));
    download(new Blob([[head.map(csvCell).join(','), ...rows].join('\n')], { type: 'text/csv' }), wave.kind === 'tran' ? 'transient.csv' : 'bode.csv');
  }
  status(`Exported ${kind.toUpperCase()}`);
}
$('#exportsel').onchange = (ev) => {
  const k = ev.target.value;
  ev.target.value = '';
  try { exportAs(k); } catch (e) { status(e.message, true); }
};

// netlist dialog: view the circuit as text, edit or paste one, and rebuild the diagram from it
$('#netlist').onclick = () => {
  $('#nettext').value = S.parts.length ? CT.toNetlist(S.parts, S.wires) : 'V1 in 0 SIN(0 5 1k)\nR1 in out 1k\nC1 out 0 100n';
  $('#neterr').textContent = '';
  $('#netdlg').showModal();
};
$('#netbuild').onclick = () => {
  try { loadCircuit(CT.layout(CT.parseNetlist($('#nettext').value)), 'Built diagram from netlist (Ctrl+Z to undo)'); $('#netdlg').close(); }
  catch (e) { $('#neterr').textContent = e.message; }
};

// API used by the AI assistant (assistant.js)
window.App = {
  netlist: () => CT.toNetlist(S.parts, S.wires) || '(empty schematic)',
  insights: () => insightsText() || '(none)',
  results: () => (result ? $('#results').innerText : 'No analysis has been run since the circuit last changed.'),
  build(netlist) {
    loadCircuit(CT.layout(CT.parseNetlist(netlist)), 'Assistant built a circuit (Ctrl+Z to undo)');
    return `Loaded ${S.parts.length} parts onto the canvas.\nInsights the app detected:\n${insightsText() || '(none)'}`;
  },
  analyse(mode, setting) {
    const field = { tran: '#tstop', ac: '#acf', bode: '#sweep' }[mode];
    if (setting && field) $(field).value = setting;
    if (mode === 'tran' && setting) $('#tstep').value = '';
    run(mode);
    return $('#results').innerText;
  },
  status,
};

// ---------- analyses ----------
function run(mode) {
  try {
    const c = compile();
    const t0 = performance.now();
    if (mode === 'dc') {
      result = { mode, ...c, data: Solver.dc(c.ckt) };
    } else if (mode === 'ac') {
      const sines = c.ckt.elements.filter((e) => e.wave === 'sine');
      if (!sines.length) throw new Error('AC analysis needs at least one source set to Sine (its amplitude/phase is the input).');
      const f = parseSI($('#acf').value) || sines[0].freq;
      if (!(f > 0)) throw new Error('Enter an AC frequency > 0.');
      result = { mode, ...c, freq: f, data: Solver.ac(c.ckt, f) };
    } else if (mode === 'tran') {
      const tStop = parseSI($('#tstop').value);
      if (!(tStop > 0)) throw new Error('Enter a stop time > 0, e.g. 10m.');
      const fmax = Math.max(0, ...c.ckt.elements.map((e) => (e.wave && e.wave !== 'dc' ? e.freq : 0)));
      const dt = parseSI($('#tstep').value) || Math.min(tStop / 2000, fmax ? 1 / (100 * fmax) : Infinity);
      if (tStop / dt > 100000) throw new Error('Too many time steps (>100k): increase the step or shorten the stop time.');
      const out = Solver.transient(c.ckt, tStop, dt, $('#fromdc').checked);
      result = { mode, ...c, dt, data: out };
      setWave({
        kind: 'tran', x: out.t, xunit: 's', logx: false,
        signals: [
          ...c.names.slice(1).map((nm, j) => ({ name: `V(${nm})`, unit: 'V', ys: out.v.map((row) => row[j + 1]) })),
          ...c.parts.map((p, j) => ({ name: `I(${p.name})`, unit: 'A', ys: out.i.map((row) => row[j]) })),
        ],
      });
    } else if (mode === 'bode') {
      const src = c.ckt.elements.find((e) => e.wave === 'sine');
      if (!src || !src.value) throw new Error('Bode sweep needs a source set to Sine with a non-zero amplitude (it is the input signal).');
      const ref = Math.abs(src.value); // gains are relative to this source's amplitude
      const m = $('#sweep').value.match(/^\s*(\S+?)\s*(?:-|to|\.\.)\s*(\S+)\s*$/);
      const f1 = m && parseSI(m[1]), f2 = m && parseSI(m[2]);
      if (!(f1 > 0 && f2 > f1)) throw new Error('Sweep format: start-stop in Hz, e.g. 10-100k');
      const fs = Array.from({ length: 241 }, (_, i) => f1 * Math.pow(f2 / f1, i / 240));
      const sols = fs.map((f) => Solver.ac(c.ckt, f));
      result = { mode, ...c, data: { fs, sols, ref, refName: c.parts[c.ckt.elements.indexOf(src)].name } };
      setWave({
        kind: 'bode', x: fs, xunit: 'Hz', logx: true,
        signals: c.names.slice(1).flatMap((nm, j) => [
          { name: `|V(${nm})|`, unit: 'dB', ys: sols.map((s) => 20 * Math.log10(Math.max(cmag(s.v[j + 1]) / ref, 1e-15))) },
          { name: `∠V(${nm})`, unit: '°', ys: sols.map((s) => cang(s.v[j + 1])) },
        ]),
      });
    }
    showResults();
    render(); showProps(); updateInsights();
    status(`${mode.toUpperCase()} solved in ${(performance.now() - t0).toFixed(0)} ms`);
  } catch (e) {
    result = null;
    $('#results').innerHTML = `<p class="err">${esc(e.message)}</p>`;
    status(e.message, true);
    render();
    throw e; // callers (keyboard, buttons, the assistant) decide whether to surface it further
  }
}
function showResults() {
  const r = result, el = $('#results');
  const rows = (head, body) => `<table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${body.map((c) => `<tr>${c.map((x) => `<td>${x}</td>`).join('')}</tr>`).join('')}</table>`;
  const nodes = r.names.map((nm, i) => [i, nm]).slice(1);
  if (r.mode === 'dc') {
    el.innerHTML = '<p class="hint">DC operating point (C open, L short; sources at their DC/offset level)</p>' +
      rows(['Node', 'Voltage'], nodes.map(([i, nm]) => [esc(nm), fmt(r.data.v[i], 'V', 4)])) +
      rows(['Part', 'Current a→b', 'Power'], r.parts.map((p, j) => { const e = r.ckt.elements[j]; const I = r.data.i[j]; return [esc(p.name), fmt(I, 'A', 4), fmt((r.data.v[e.a] - r.data.v[e.b]) * I, 'W', 3)]; }));
  } else if (r.mode === 'ac') {
    el.innerHTML = `<p class="hint">AC phasors at ${fmt(r.freq, 'Hz')} (sine sources only, phase vs sine reference)</p>` +
      rows(['Node', 'Magnitude', 'Phase'], nodes.map(([i, nm]) => [esc(nm), fmt(cmag(r.data.v[i]), 'V', 4), cang(r.data.v[i]).toFixed(2) + '°'])) +
      rows(['Part', '|I|', '∠I'], r.parts.map((p, j) => [esc(p.name), fmt(cmag(r.data.i[j]), 'A', 4), cang(r.data.i[j]).toFixed(2) + '°']));
  } else if (r.mode === 'tran') {
    const k = r.data.t.length;
    el.innerHTML = `<p class="hint">Transient: ${k - 1} steps of ${fmt(r.dt, 's')} — see Waveforms below.</p>` +
      rows(['Node', 'Min', 'Max', 'Final'], nodes.map(([i, nm]) => { const ys = r.data.v.map((row) => row[i]); return [esc(nm), fmt(Math.min(...ys), 'V'), fmt(Math.max(...ys), 'V'), fmt(ys[k - 1], 'V')]; }));
  } else {
    el.innerHTML = `<p class="hint">Bode sweep ${fmt(r.data.fs[0], 'Hz')} – ${fmt(r.data.fs.at(-1), 'Hz')}, gain relative to ${esc(r.data.refName)}’s amplitude. See Waveforms below.</p>` +
      rows(['Node', 'Peak gain', '−3 dB at'], nodes.map(([i, nm]) => {
        const g = r.data.sols.map((s) => 20 * Math.log10(Math.max(cmag(s.v[i]) / r.data.ref, 1e-15)));
        const pk = Math.max(...g), j = g.findIndex((x, n) => n > g.indexOf(pk) && x <= pk - 3);
        return [esc(nm), pk.toFixed(2) + ' dB', j > 0 ? fmt(r.data.fs[j], 'Hz') : '—'];
      }));
  }
}
const tryRun = (mode) => { try { run(mode); } catch {} }; // error already shown in Results + status bar
$('#run-dc').onclick = () => tryRun('dc');
$('#run-ac').onclick = () => tryRun('ac');
$('#run-tran').onclick = () => tryRun('tran');
$('#run-bode').onclick = () => tryRun('bode');

// ---------- insights: rule-based checks + circuit recognition (circuit.js inspect) ----------
function summary() {
  const N = nets(), dcI = result && result.mode === 'dc';
  const parts = [], open = new Set();
  for (const p of S.parts) {
    const ts = terms(p);
    if (ts.some((t) => N.deg.get(N.key(t.x, t.y)) === 1)) open.add(p.name);
    if (p.type === 'G') continue;
    const [a, b] = ts.map(N.nodeAt), q = { name: p.name, type: p.type, value: p.wave === 'expr' ? NaN : parseSI(p.value), a, b, wave: p.wave };
    if (dcI && result.idx.has(p.id)) { const e = result.ckt.elements[result.idx.get(p.id)]; q.i = result.data.i[result.idx.get(p.id)]; q.v = result.data.v[e.a] - result.data.v[e.b]; }
    parts.push(q);
  }
  const termKeys = new Set(S.parts.flatMap((p) => terms(p).map((t) => N.key(t.x, t.y))));
  let dangling = 0;
  for (const [key, d] of N.deg) if (d === 1 && !termKeys.has(key)) dangling++;
  return { parts, names: N.names, hasGround: N.hasGround, open: [...open], dangling };
}
const LEVEL = { error: ['⛔', 'Problem'], warn: ['⚠', 'Check'], info: ['ℹ', 'Note'], idea: ['💡', 'Insight'] };
let insights = [];
function updateInsights() {
  insights = CT.inspect(summary());
  $('#insights').innerHTML = insights.map((x, i) => `<div class="ins ${x.level}"><b>${LEVEL[x.level][0]} ${LEVEL[x.level][1]}:</b> ${esc(x.text)}${x.fix ? `<div class="hint">${esc(x.fix)}</div>` : ''}${x.action ? `<div class="row">${x.action.tstop ? `<button data-ins="${i}" data-run="tran">Transient to ${esc(x.action.tstop)}s</button>` : ''}${x.action.sweep ? `<button data-ins="${i}" data-run="bode">Bode ${esc(x.action.sweep)} Hz</button>` : ''}</div>` : ''}</div>`).join('') || '<p class="hint">No issues found.</p>';
}
const insightsText = () => insights.map((x) => `[${LEVEL[x.level][1]}] ${x.text}${x.fix ? ' — ' + x.fix : ''}`).join('\n');
$('#insights').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-ins]');
  if (!b) return;
  const a = insights[+b.dataset.ins].action;
  if (b.dataset.run === 'tran') { $('#tstop').value = a.tstop; $('#tstep').value = ''; }
  else $('#sweep').value = a.sweep;
  tryRun(b.dataset.run);
});

// ---------- plotting ----------
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function niceTicks(lo, hi, n) {
  const raw = (hi - lo) / Math.max(1, n), p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p, out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}
// cfg: { x, xunit, logx, panels: [{ title, unit, series: [{ name, color, ys }] }], hover }
function drawPlot(cv, cfg, empty) {
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.font = '11px system-ui, sans-serif';
  if (!cfg) { c.fillStyle = css('--ink2'); c.font = '13px system-ui, sans-serif'; c.fillText(empty, 16, 28); return; }
  const L = 70, R = 16, T = 10, B = 28, gap = 24, np = cfg.panels.length;
  const ph = (H - T - B - gap * (np - 1)) / np, pw = W - L - R;
  const xs = cfg.logx ? cfg.x.map(Math.log10) : cfg.x;
  const x0 = xs[0], x1 = xs[xs.length - 1];
  const X = (v) => L + ((v - x0) / (x1 - x0 || 1)) * pw;
  Object.assign(cfg, { _xs: xs, _X: X, _L: L, _pw: pw, _Y: [] });
  const xt = cfg.logx // one tick per decade
    ? Array.from({ length: Math.max(0, Math.floor(x1) - Math.ceil(x0) + 1) }, (_, i) => Math.ceil(x0) + i)
    : niceTicks(x0, x1, Math.max(2, pw / 90));
  cfg.panels.forEach((p, pi) => {
    const top = T + pi * (ph + gap);
    let lo = Infinity, hi = -Infinity;
    for (const s of p.series) for (const y of s.ys) if (isFinite(y)) { if (y < lo) lo = y; if (y > hi) hi = y; }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-12 * Math.max(1, Math.abs(hi))) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
    const Y = (v) => top + ph - ((v - lo) / (hi - lo)) * ph;
    cfg._Y[pi] = Y;
    c.lineWidth = 1;
    c.strokeStyle = css('--grid'); c.fillStyle = css('--muted');
    c.textAlign = 'right'; c.textBaseline = 'middle';
    for (const t of niceTicks(lo, hi, Math.max(2, Math.floor(ph / 36)))) {
      const y = Math.round(Y(t)) + 0.5;
      c.beginPath(); c.moveTo(L, y); c.lineTo(W - R, y); c.stroke();
      c.fillText(fmtVal(t, p.unit), L - 6, y);
    }
    for (const t of xt) { const x = Math.round(X(t)) + 0.5; c.beginPath(); c.moveTo(x, top); c.lineTo(x, top + ph); c.stroke(); }
    c.strokeStyle = css('--axis');
    c.beginPath(); c.moveTo(L, top + ph + 0.5); c.lineTo(W - R, top + ph + 0.5); c.stroke();
    c.save(); c.beginPath(); c.rect(L, top, pw, ph); c.clip();
    c.lineWidth = 2; c.lineJoin = 'round';
    for (const s of p.series) {
      c.strokeStyle = s.color; c.beginPath();
      let pen = false;
      s.ys.forEach((y, i) => { if (!isFinite(y)) { pen = false; return; } const px = X(xs[i]), py = Y(y); pen ? c.lineTo(px, py) : c.moveTo(px, py); pen = true; });
      c.stroke();
    }
    c.restore();
    c.fillStyle = css('--ink2'); c.textAlign = 'left'; c.textBaseline = 'top';
    c.fillText(p.title, L + 6, top + 4);
    if (cfg.hover != null) {
      const i = cfg.hover, hx = X(xs[i]);
      c.strokeStyle = css('--muted'); c.lineWidth = 1;
      c.beginPath(); c.moveTo(hx + 0.5, top); c.lineTo(hx + 0.5, top + ph); c.stroke();
      for (const s of p.series) if (isFinite(s.ys[i])) {
        c.beginPath(); c.arc(hx, Y(s.ys[i]), 4, 0, 7);
        c.fillStyle = s.color; c.strokeStyle = css('--surface'); c.lineWidth = 2; c.fill(); c.stroke();
      }
    }
  });
  c.fillStyle = css('--muted'); c.textAlign = 'center'; c.textBaseline = 'top';
  for (const t of xt) c.fillText(cfg.logx ? fmt(Math.pow(10, t), cfg.xunit) : cfg.xunit ? fmt(t, cfg.xunit) : +t.toPrecision(4), X(t), H - B + 8);
}
function hoverable(cv, getCfg) {
  const tip = cv.nextElementSibling;
  cv.addEventListener('mousemove', (ev) => {
    const cfg = getCfg();
    if (!cfg || !cfg._X) return;
    const r = cv.getBoundingClientRect(), mx = ev.clientX - r.left, xs = cfg._xs;
    const xv = xs[0] + ((mx - cfg._L) / cfg._pw) * (xs[xs.length - 1] - xs[0]);
    let lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] < xv) lo = m; else hi = m; }
    const i = Math.abs(xs[lo] - xv) < Math.abs(xs[hi] - xv) ? lo : hi;
    cfg.hover = i; drawPlot(cv, cfg);
    const xr = cfg.x[i];
    tip.innerHTML = `<div>${cfg.xunit ? fmt(xr, cfg.xunit, 4) : +xr.toPrecision(5)}</div>` + cfg.panels.flatMap((p) => p.series.map((s) =>
      `<div><span class="k" style="background:${s.color}"></span>${esc(s.name)}: <b>${isFinite(s.ys[i]) ? fmtVal(s.ys[i], p.unit) : '—'}</b></div>`)).join('');
    tip.hidden = false;
    tip.style.left = (mx > r.width - 220 ? mx - tip.offsetWidth - 14 : mx + 14) + 'px';
    tip.style.top = Math.min(ev.clientY - r.top + 12, r.height - tip.offsetHeight - 4) + 'px';
  });
  cv.addEventListener('mouseleave', () => { const cfg = getCfg(); if (cfg) { cfg.hover = null; drawPlot(cv, cfg); } tip.hidden = true; });
}

// waveform tab: signal checklist (acts as legend) -> panels grouped by unit (never two y-scales on one axis)
let wave = null, waveCfg = null;
const checked = new Set(), slotOf = new Map();
const UNIT_TITLE = { V: 'Voltage (V)', A: 'Current (A)', dB: 'Gain (dB)', '°': 'Phase (°)' };
function setWave(w) {
  wave = w;
  const live = new Set(w.signals.map((s) => s.name));
  for (const n of [...checked]) if (!live.has(n)) checked.delete(n); // stale signals must not hold palette slots
  if (!w.signals.some((s) => checked.has(s.name))) w.signals.filter((s) => s.unit === 'V' || s.unit === 'dB').slice(0, 3).forEach((s) => check(s.name, true));
  renderSignals(); drawWave();
}
function check(name, on) {
  if (!on) return checked.delete(name);
  const used = new Set([...checked].map((n) => slotOf.get(n)));
  if (!slotOf.has(name) || used.has(slotOf.get(name))) slotOf.set(name, [1, 2, 3, 4, 5, 6, 7, 8].find((s) => !used.has(s)));
  checked.add(name);
}
function renderSignals() {
  const full = wave.signals.filter((s) => checked.has(s.name)).length >= 8;
  $('#signals').innerHTML = '<h2>Signals</h2>' + wave.signals.map((s) => {
    const on = checked.has(s.name);
    return `<label><input type="checkbox" data-sig="${esc(s.name)}"${on ? ' checked' : full ? ' disabled' : ''}><span class="swatch" style="background:${on ? `var(--s${slotOf.get(s.name)})` : 'transparent'};outline:1px solid var(--border)"></span>${esc(s.name)}</label>`;
  }).join('') + (full ? '<p class="hint">Max 8 at once.</p>' : '');
}
$('#signals').addEventListener('change', (ev) => {
  const n = ev.target.dataset.sig;
  if (n === undefined) return;
  check(n, ev.target.checked);
  renderSignals(); drawWave();
});
function drawWave() {
  waveCfg = null;
  if (wave) {
    const panels = [];
    for (const s of wave.signals) {
      if (!checked.has(s.name)) continue;
      let p = panels.find((q) => q.unit === s.unit);
      if (!p) panels.push((p = { unit: s.unit, title: UNIT_TITLE[s.unit], series: [] }));
      p.series.push({ name: s.name, ys: s.ys, color: css('--s' + slotOf.get(s.name)) });
    }
    if (panels.length) waveCfg = { x: wave.x, xunit: wave.xunit, logx: wave.logx, panels };
  }
  drawPlot($('#plot'), waveCfg, wave ? 'Tick a signal on the left to plot it.' : 'Run Transient (time-domain) or Bode (frequency sweep) to see waveforms here.');
}
hoverable($('#plot'), () => waveCfg);

// ---------- math console (nerdamer CAS) ----------
let mathCfg = null;
const EXAMPLES = [
  'solve(x^2-5*x+6=0, x)', 'diff(sin(w*t)*exp(-t/tau), t)', 'integrate(x^2*e^x, x)', 'defint(sin(x)^2, 0, 2*pi, x)',
  'laplace(exp(-a*t)*sin(w*t), t, s)', 'ilt(10/(s*(s+2)), s, t)', 'partfrac(1/(s*(s+1)*(s+2)), s)', 'solve(1/(2*pi*f*C)=R, f)', 'Z(w) := R + 1/(i*w*C)',
  'simplify(1/(1/R1+1/R2))', 'plot 1-exp(-t/1e-3), 0, 5e-3', 'plot sin(2*pi*t)+sin(6*pi*t)/3+sin(10*pi*t)/5, 0, 2',
];
$('#examples').innerHTML = EXAMPLES.map((e) => `<button type="button">${esc(e)}</button>`).join('');
$('#examples').addEventListener('click', (ev) => { if (ev.target.tagName === 'BUTTON') { $('#min').value = ev.target.textContent; $('#min').focus(); } });
function splitTop(s) { // split on commas outside parentheses
  const out = []; let depth = 0, cur = '';
  for (const ch of s) { if (ch === '(' || ch === '[') depth++; if (ch === ')' || ch === ']') depth--; if (ch === ',' && !depth) { out.push(cur); cur = ''; } else cur += ch; }
  return [...out, cur].map((x) => x.trim()).filter(Boolean);
}
function partVals() {
  if (!$('#usevals').checked) return {};
  const subs = {};
  for (const p of S.parts) { const v = parseSI(p.value); if (DEF[p.type].unit && isFinite(v) && /^[A-Za-z]\w*$/.test(p.name)) subs[p.name] = String(v); }
  return subs;
}
// nerdamer's ilt is unreliable with symbolic coefficients, so verify: laplace(result) must equal the input numerically.
function checkIlt(src, res, subs) {
  const m = src.match(/^ilt\((.*)\)$/s);
  if (!m) return '';
  const [F, s = 's', t = 't'] = splitTop(m[1]);
  const warn = '\n⚠ Could not verify this inverse transform (the numeric Laplace transform of the result ≠ input). nerdamer’s ilt is unreliable with symbolic coefficients: substitute numbers, or use partfrac(F, s) and a transform table.';
  try { // check F(s) = ∫₀^∞ f(t)e^(-st) dt numerically (Simpson) at random s and parameter values
    const fwd = nerdamer(F, subs), back = nerdamer(res);
    const params = [...new Set([...fwd.variables(), ...back.variables()])].filter((v) => v !== s && v !== t);
    const Fs = fwd.buildFunction([...params, s]), ft = back.buildFunction([...params, t]);
    for (let k = 0; k < 3; k++) {
      const ps = params.map(() => 0.7 + Math.random() * 2), sv = 3 + Math.random() * 2, n = 6000, h = 60 / sv / n;
      let acc = 0;
      for (let j = 0; j <= n; j++) acc += (j === 0 || j === n ? 1 : j % 2 ? 4 : 2) * ft(...ps, j * h) * Math.exp(-sv * j * h);
      const want = Fs(...ps, sv), got = (acc * h) / 3;
      if (!(Math.abs(want - got) <= 1e-4 * (1 + Math.abs(want)))) return warn;
    }
    return '\n✓ verified numerically: ∫ f(t)e^(−st) dt matches the input';
  } catch { return warn; }
}
function mathLog(input, output, err) {
  const log = $('#mlog');
  log.insertAdjacentHTML('beforeend', `<div class="in">› ${esc(input)}</div><div class="out${err ? ' err' : ''}">${esc(output)}</div>`);
  log.scrollTop = log.scrollHeight;
}
function runMath(src) {
  if (!window.nerdamer) return mathLog(src, 'Math library failed to load (needs internet for the CDN).', true);
  try {
    const subs = partVals();
    let m;
    if ((m = src.match(/^plot\s+(.+)$/i))) {
      const [expr, a = '0', b = '10'] = splitTop(m[1]);
      const ex = nerdamer(expr, subs), vars = ex.variables();
      if (vars.length > 1) throw new Error(`plot needs one variable; found ${vars.join(', ')} (define the others with name := value)`);
      const v = vars[0] || 'x', f = ex.buildFunction([v]);
      const lo = +nerdamer(a).evaluate().text('decimals'), hi = +nerdamer(b).evaluate().text('decimals');
      if (!(hi > lo)) throw new Error('plot range must be increasing: plot f(x), from, to');
      const xs = Array.from({ length: 801 }, (_, i) => lo + ((hi - lo) * i) / 800);
      mathCfg = { x: xs, xunit: '', logx: false, panels: [{ unit: '', title: `${ex.toString()}  vs  ${v}`, series: [{ name: 'f', ys: xs.map((x) => +f(x)), color: css('--s1') }] }] };
      drawPlot($('#mplot'), mathCfg);
      return mathLog(src, `plotted over ${v} ∈ [${lo}, ${hi}]`);
    }
    if ((m = src.match(/^([A-Za-z_]\w*)\s*\(([^)]*)\)\s*:=\s*(.+)$/))) {
      nerdamer.setFunction(m[1], m[2].split(',').map((s) => s.trim()), m[3]);
      return mathLog(src, `defined ${m[1]}(${m[2]})`);
    }
    if ((m = src.match(/^([A-Za-z_]\w*)\s*:=\s*(.+)$/))) {
      nerdamer.setVar(m[1], m[2]);
      return mathLog(src, `${m[1]} = ${m[2]}`);
    }
    const r = nerdamer(src, subs);
    let out = r.toString();
    const ev = r.evaluate();
    if (!ev.variables().length) { // purely numeric (incl. definite integrals nerdamer leaves unevaluated)
      const t = ev.text('decimals'), num = isNaN(Number(t)) ? t : String(Number(t));
      if (num !== out) out = out.length > 40 ? num : out + '\n≈ ' + num;
    }
    mathLog(src, out + checkIlt(src, r.toString(), subs));
  } catch (e) { mathLog(src, e.message, true); }
}
$('#mform').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const v = $('#min').value.trim();
  if (v) runMath(v);
});
hoverable($('#mplot'), () => mathCfg);

// ---------- tabs, resize, boot ----------
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', x === b));
  for (const t of ['wave', 'math', 'ai']) $('#tab-' + t).hidden = b.dataset.tab !== t;
  redrawPlots();
}));
function redrawPlots() {
  drawWave();
  drawPlot($('#mplot'), mathCfg, 'Use “plot f(x), from, to” to graph a function here.');
}
new ResizeObserver(() => { setViewBox(); redrawPlots(); }).observe(document.body);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redrawPlots);

const SAMPLE = { // RC low-pass driven by a 1 kHz sine
  n: 20,
  parts: [
    { id: 1, type: 'V', x: 100, y: 200, rot: 90, name: 'V1', value: '5', wave: 'sine', freq: '1k', phase: '0', offset: '0', expr: '' },
    { id: 2, type: 'R', x: 180, y: 120, rot: 0, name: 'R1', value: '1k', wave: 'dc', freq: '1k', phase: '0', offset: '0', expr: '' },
    { id: 3, type: 'C', x: 260, y: 200, rot: 90, name: 'C1', value: '100n', wave: 'dc', freq: '1k', phase: '0', offset: '0', expr: '' },
    { id: 4, type: 'G', x: 180, y: 280, rot: 0, name: 'GND1', value: '', wave: 'dc', freq: '', phase: '', offset: '', expr: '' },
  ],
  wires: [
    { id: 5, x1: 100, y1: 160, x2: 100, y2: 120 }, { id: 6, x1: 100, y1: 120, x2: 140, y2: 120, label: 'in' },
    { id: 7, x1: 220, y1: 120, x2: 260, y2: 120, label: 'out' }, { id: 8, x1: 260, y1: 120, x2: 260, y2: 160 },
    { id: 9, x1: 100, y1: 240, x2: 100, y2: 280 }, { id: 10, x1: 100, y1: 280, x2: 260, y2: 280 }, { id: 11, x1: 260, y1: 280, x2: 260, y2: 240 },
  ],
};
try { S = JSON.parse(localStorage.getItem('circuit')) || SAMPLE; } catch { S = SAMPLE; }
setTool('select');
setViewBox();
showProps();
updateInsights();
redrawPlots();
