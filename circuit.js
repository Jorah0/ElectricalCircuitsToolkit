// Circuit model helpers shared by the UI, the AI assistant and the tests:
// units, part geometry + connectivity, SPICE-style netlists, auto-layout, and rule-based insights.
(function (root) {
  // ---------- units ----------
  const PREFIX = { T: 1e12, G: 1e9, M: 1e6, meg: 1e6, k: 1e3, K: 1e3, m: 1e-3, u: 1e-6, 'µ': 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };
  // "4.7k", "100nF", "1meg", "2.2e-3", "-90" -> number (NaN if unparseable). m = milli, M/meg = mega.
  function parseSI(s) {
    const m = String(s ?? '').trim().match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(meg|[TGMkKmuµnpf])?\s*[a-zA-ZΩ°]*$/);
    return m ? parseFloat(m[1]) * (m[2] ? PREFIX[m[2]] : 1) : NaN;
  }
  const ENG = [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f']];
  function fmt(v, unit = '', digits = 3) {
    if (!isFinite(v)) return String(v);
    const a = Math.abs(v);
    if (a < 1e-13) return '0 ' + unit;
    const [s, p] = ENG.find(([s]) => a >= s * 0.9995) || ENG[ENG.length - 1];
    return +(v / s).toPrecision(digits) + ' ' + p + unit;
  }
  const spiceNum = (v) => fmt(v, '', 4).replace(' ', '').replace('µ', 'u').replace(/M$/, 'meg');

  // ---------- geometry: parts drawn horizontally, terminals at x = ±40, rotated in 90° steps ----------
  const rot = (x, y, r) => [[x, y], [-y, x], [-x, -y], [y, -x]][(((r / 90) % 4) + 4) % 4];
  const terms = (p) => (p.type === 'G' ? [[0, 0]] : [[-40, 0], [40, 0]]).map(([x, y]) => { const [rx, ry] = rot(x, y, p.rot); return { x: p.x + rx, y: p.y + ry }; });
  function onInterior(p, w) {
    const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
    if (dx * (p.y - w.y1) - dy * (p.x - w.x1) !== 0) return false;
    const t = (p.x - w.x1) * dx + (p.y - w.y1) * dy;
    return t > 0 && t < dx * dx + dy * dy;
  }

  // Connectivity: union-find over grid points. Coincident ends join; a point on a trace's interior joins that trace (branching).
  // Node 0 = any net touching a Ground part; other nets are numbered in part order.
  function nets(parts, wires) {
    const parent = new Map(), deg = new Map(), pts = new Map();
    const k = (x, y) => x + ',' + y;
    const find = (a) => { if (!parent.has(a)) parent.set(a, a); let r = a; while (parent.get(r) !== r) r = parent.get(r); parent.set(a, r); return r; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent.set(a, b); };
    const bump = (key, n = 1) => deg.set(key, (deg.get(key) || 0) + n);
    for (const p of parts) for (const t of terms(p)) { const key = k(t.x, t.y); find(key); bump(key); pts.set(key, t); }
    for (const w of wires) {
      const a = k(w.x1, w.y1), b = k(w.x2, w.y2);
      union(a, b); bump(a); bump(b);
      pts.set(a, { x: w.x1, y: w.y1 }); pts.set(b, { x: w.x2, y: w.y2 });
    }
    for (const w of wires) for (const [key, p] of pts) if (onInterior(p, w)) { union(key, k(w.x1, w.y1)); bump(key, 2); }

    const id = new Map(), names = ['0'];
    let hasGround = false;
    for (const p of parts) if (p.type === 'G') { id.set(find(k(p.x, p.y)), 0); hasGround = true; }
    for (const p of parts) for (const t of terms(p)) { const r = find(k(t.x, t.y)); if (!id.has(r)) { id.set(r, names.length); names.push(''); } }
    const pos = [], best = [];
    for (const w of wires) {
      const n = id.get(find(k(w.x1, w.y1)));
      if (!n) continue;
      if (w.label) names[n] = String(w.label).trim().replace(/\s+/g, '_');
      const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
      if (!(best[n] >= len)) { best[n] = len; pos[n] = { x: (w.x1 + w.x2) / 2, y: (w.y1 + w.y2) / 2 }; }
    }
    for (const p of parts) for (const t of terms(p)) { const n = id.get(find(k(t.x, t.y))); if (n && !pos[n]) pos[n] = t; }
    names.forEach((nm, i) => { if (!nm) names[i] = 'N' + i; });
    return {
      deg, pts, names, pos, hasGround, key: k,
      nodeAt: (t) => id.get(find(k(t.x, t.y))),
      touches: (p) => deg.has(k(p.x, p.y)) || wires.some((w) => onInterior(p, w)),
    };
  }

  // ---------- SPICE-style netlists ----------
  const isGnd = (n) => /^(0|gnd|ground)$/i.test(n);
  const WAVE_OF = { SIN: 'sine', SINE: 'sine', SQUARE: 'square', SQR: 'square', TRI: 'triangle', TRIANGLE: 'triangle', SAW: 'sawtooth', SAWTOOTH: 'sawtooth', STEP: 'step' };
  // Lines: "R1 in out 1k", "V1 in 0 DC 5", "V1 in 0 SIN(0 5 1k)", "I1 a b 1m", "V2 x 0 EXPR 5*sin(2*pi*t)". '*' comments, '.' directives ignored.
  function parseNetlist(text) {
    const items = [], seen = new Set();
    String(text).split(/\r?\n/).forEach((raw, ln) => {
      const line = raw.replace(/;.*$/, '').trim();
      if (!line || line[0] === '*' || line[0] === '.') return;
      const m = line.match(/^([RCLVIrclvi]\w*)\s+(\S+)\s+(\S+)\s+(.+)$/);
      if (!m) throw new Error(`Line ${ln + 1}: expected "NAME node1 node2 value", e.g. "R1 in out 1k" — got "${raw.trim()}"`);
      const type = m[1][0].toUpperCase(), name = m[1];
      if (seen.has(name.toUpperCase())) throw new Error(`Line ${ln + 1}: duplicate part name ${name}`);
      seen.add(name.toUpperCase());
      const it = { type, name, a: isGnd(m[2]) ? '0' : m[2], b: isGnd(m[3]) ? '0' : m[3], value: '', wave: 'dc', freq: '1k', phase: '0', offset: '0', expr: '' };
      const spec = m[4].trim();
      let f;
      if ('VI'.includes(type) && (f = spec.match(/^EXPR\s+(.+)$/i))) { it.wave = 'expr'; it.expr = f[1].trim(); }
      else if ('VI'.includes(type) && (f = spec.match(/^(\w+)\s*\(([^)]*)\)/)) && WAVE_OF[f[1].toUpperCase()]) {
        const args = f[2].trim().split(/[\s,]+/).filter(Boolean);
        it.wave = WAVE_OF[f[1].toUpperCase()];
        if (it.wave === 'step') it.value = args[0] || '1';
        else {
          [it.offset = '0', it.value = '1', it.freq = '1k'] = args;
          it.phase = (it.wave === 'sine' ? args[5] : args[3]) || '0';
        }
      } else if ('VI'.includes(type) && (f = spec.match(/^AC\s+(\S+)/i))) { it.wave = 'sine'; it.value = f[1]; }
      else it.value = spec.replace(/^DC\s+/i, '').split(/\s+/)[0];
      for (const fld of it.wave === 'expr' ? [] : ['value', 'freq', 'phase', 'offset']) {
        if (isNaN(parseSI(it[fld]))) throw new Error(`Line ${ln + 1}: can't read ${fld} "${it[fld]}" for ${name} (use numbers with SI prefixes like 4.7k, 100n, 1meg)`);
      }
      if ('RCL'.includes(type) && !(parseSI(it.value) > 0)) throw new Error(`Line ${ln + 1}: ${name} needs a positive value`);
      items.push(it);
    });
    if (!items.length) throw new Error('No parts found. Write one part per line, e.g. "R1 in out 1k".');
    return items;
  }
  function sourceSpec(p) {
    switch (p.wave) {
      case 'sine': return `SIN(${p.offset || 0} ${p.value} ${p.freq} 0 0 ${p.phase || 0})`;
      case 'square': return `SQUARE(${p.offset || 0} ${p.value} ${p.freq} ${p.phase || 0})`;
      case 'triangle': return `TRI(${p.offset || 0} ${p.value} ${p.freq} ${p.phase || 0})`;
      case 'sawtooth': return `SAW(${p.offset || 0} ${p.value} ${p.freq} ${p.phase || 0})`;
      case 'step': return `STEP(${p.value})`;
      case 'expr': return `EXPR ${p.expr}`;
      default: return `DC ${p.value}`;
    }
  }
  function toNetlist(parts, wires) {
    const N = nets(parts, wires);
    return parts.filter((p) => p.type !== 'G').map((p) => {
      const [a, b] = terms(p).map(N.nodeAt).map((n) => N.names[n]);
      return `${p.name} ${a} ${b} ${'VI'.includes(p.type) ? sourceSpec(p) : p.value}`;
    }).join('\n');
  }

  // Auto-layout ("ladder"): every net is a horizontal rail (ground at the bottom); every part stands vertically in its own
  // column between its two rails, joined by vertical traces. Parts never sit on a rail they don't connect to electrically.
  function layout(items) {
    const nodes = [];
    for (const it of items) for (const n of [it.a, it.b]) if (n !== '0' && !nodes.includes(n)) nodes.push(n);
    if (items.some((it) => it.a === '0' || it.b === '0')) nodes.push('0');
    const yOf = (n) => 80 + nodes.indexOf(n) * 160;
    const parts = [], wires = [], railX = new Map();
    let id = 1;
    const addX = (n, x) => { if (!railX.has(n)) railX.set(n, []); railX.get(n).push(x); };
    items.forEach((it, i) => {
      const x = 120 + i * 140, ya = yOf(it.a), yb = yOf(it.b);
      const base = { id: id++, type: it.type, x, name: it.name, value: it.value, wave: it.wave, freq: it.freq, phase: it.phase, offset: it.offset, expr: it.expr };
      if (ya === yb) { // both ends on one net: hang below the rail and loop back up beside it
        parts.push({ ...base, y: ya + 80, rot: 90 });
        wires.push({ x1: x, y1: ya + 40, x2: x, y2: ya }, { x1: x, y1: ya + 120, x2: x + 60, y2: ya + 120 }, { x1: x + 60, y1: ya + 120, x2: x + 60, y2: ya });
        addX(it.a, x); addX(it.a, x + 60);
        return;
      }
      const top = Math.min(ya, yb), bot = Math.max(ya, yb), yc = (top + bot) / 2; // rails are 160 apart, so terminals (yc±40) never land on a rail
      parts.push({ ...base, y: yc, rot: ya < yb ? 90 : 270 }); // rot 90 puts terminal a on top
      wires.push({ x1: x, y1: yc - 40, x2: x, y2: top }, { x1: x, y1: yc + 40, x2: x, y2: bot });
      addX(it.a, x); addX(it.b, x);
    });
    for (const [n, xs] of railX) {
      const y = yOf(n), x0 = Math.min(...xs), x1 = Math.max(...xs);
      const label = n === '0' || /^(\d+|N\d+)$/i.test(n) ? undefined : n;
      if (x1 > x0) wires.push({ x1: x0, y1: y, x2: x1, y2: y, label });
      else if (label) wires.find((w) => w.x1 === x0 && w.y2 === y).label = label;
      if (n === '0') parts.push({ id: id++, type: 'G', x: x0, y, rot: 0, name: 'GND1', value: '', wave: 'dc', freq: '', phase: '', offset: '', expr: '' });
    }
    wires.forEach((w) => { w.id = id++; });
    return { parts, wires, n: id };
  }

  // ---------- rule-based insights ----------
  // c = { parts: [{ name, type, value, a, b, wave, i? (DC current a→b), v? (DC voltage a→b) }], names, hasGround, open: [part names], dangling }
  const TAU = 2 * Math.PI;
  const SECTIONS = { // series part (input → output) + shunt part (output → ground)
    RC: { name: 'RC low-pass filter', uses: 'noise / anti-aliasing filtering, smoothing PWM into an analog level, switch debouncing, treble cut', fig: (R, C) => ({ tau: R * C, fc: 1 / (TAU * R * C) }) },
    CR: { name: 'RC high-pass filter', uses: 'AC coupling / DC blocking between stages, bass cut, edge detection (differentiator)', fig: (C, R) => ({ tau: R * C, fc: 1 / (TAU * R * C) }) },
    LR: { name: 'RL low-pass filter', uses: 'current smoothing in motor drives and inductive loads, crossover networks', fig: (L, R) => ({ tau: L / R, fc: R / (TAU * L) }) },
    RL: { name: 'RL high-pass filter', uses: 'high-frequency pick-off, crossover networks, inductive kick demonstrations', fig: (R, L) => ({ tau: L / R, fc: R / (TAU * L) }) },
    LC: { name: '2nd-order LC low-pass filter', uses: 'switch-mode power supply output filters, EMI filtering, audio crossovers', fig: (L, C) => ({ f0: 1 / (TAU * Math.sqrt(L * C)), z0: Math.sqrt(L / C) }) },
    CL: { name: '2nd-order LC high-pass filter', uses: 'tweeter crossovers, removing low-frequency hum, RF high-pass stages', fig: (C, L) => ({ f0: 1 / (TAU * Math.sqrt(L * C)), z0: Math.sqrt(L / C) }) },
    RR: { name: 'voltage divider', uses: 'bias points, scaling a sensor or battery voltage into an ADC range, reference voltages', fig: (R1, R2) => ({ ratio: R2 / (R1 + R2), rth: (R1 * R2) / (R1 + R2) }) },
    CC: { name: 'capacitive divider', uses: 'high-voltage AC sensing, RF impedance matching, oscillator feedback', fig: (C1, C2) => ({ ratio: C1 / (C1 + C2) }) },
  };
  const figText = (f) => [
    f.tau !== undefined && `τ = ${fmt(f.tau, 's')}`, f.fc !== undefined && `corner fc = ${fmt(f.fc, 'Hz')}`,
    f.f0 !== undefined && `f₀ = ${fmt(f.f0, 'Hz')}`, f.z0 !== undefined && `Z₀ = ${fmt(f.z0, 'Ω')}`,
    f.q !== undefined && `Q = ${+f.q.toPrecision(3)}`, f.bw !== undefined && `bandwidth = ${fmt(f.bw, 'Hz')}`,
    f.ratio !== undefined && `Vout/Vin = ${+f.ratio.toPrecision(4)} (${(20 * Math.log10(f.ratio)).toFixed(1)} dB)`,
    f.rth !== undefined && `output resistance = ${fmt(f.rth, 'Ω')}`,
  ].filter(Boolean).join(', ');
  function actionFor(f) { // analysis settings that show the behaviour
    const f0 = f.fc || f.f0, act = {};
    if (f.tau) act.tstop = spiceNum(5 * f.tau);
    else if (f0) act.tstop = spiceNum(10 / f0);
    if (f0) act.sweep = `${spiceNum(f0 / 100)}-${spiceNum(f0 * 100)}`;
    return Object.keys(act).length ? act : undefined;
  }

  function inspect(c) {
    const out = [], add = (level, text, fix, action) => out.push({ level, text, fix, action });
    const P = c.parts, N = (n) => c.names[n];
    if (!P.length) return [{ level: 'info', text: 'Empty schematic.', fix: 'Place parts from the toolbar, open Netlist to type one, or ask the Assistant to generate a circuit.' }];

    // --- problems
    if (!c.hasGround) add('error', 'No ground reference.', 'Place a Ground (G) on the negative side of your main source.');
    for (const name of c.open) add('warn', `${name} has an unconnected terminal.`, 'Draw a trace (W) from the hollow circle to the node it belongs on.');
    if (c.dangling) add('info', `${c.dangling} trace end${c.dangling > 1 ? 's go' : ' goes'} nowhere.`, 'Delete the stub or extend it to a terminal or another trace.');
    if (!P.some((p) => p.type === 'V' || p.type === 'I')) add('warn', 'No sources: every voltage and current will be zero.', 'Add a voltage (V) or current (I) source.');
    for (const p of P) {
      if (p.a === p.b) {
        if (p.type === 'V') add('error', `${p.name} is short-circuited (both terminals on ${N(p.a)}).`, 'Remove the trace across the source or put a load between its terminals.');
        else add('warn', `${p.name} is shorted out: both ends are on ${N(p.a)}, so it does nothing.`, 'Re-route one end to a different node.');
      }
      const lim = { R: [0.01, 1e9, 'Ω'], C: [1e-15, 10, 'F'], L: [1e-12, 100, 'H'] }[p.type];
      if (lim && isFinite(p.value) && p.value > 0 && (p.value < lim[0] || p.value > lim[1])) add('warn', `${p.name} = ${fmt(p.value, lim[2])} is an unusual value.`, 'Check the prefix: m = milli, M or meg = mega, u = micro, n = nano, p = pico.');
    }
    const uf = (pairs) => { // union-find over node numbers
      const par = new Map(), f = (x) => { while (par.has(x) && par.get(x) !== x) x = par.get(x); return x; };
      for (const [a, b] of pairs) { const ra = f(a), rb = f(b); if (ra !== rb) par.set(ra, rb); }
      return f;
    };
    { // loops of voltage sources / inductors: at DC these fight (undefined current)
      const par = new Map(), f = (x) => { while (par.has(x) && par.get(x) !== x) x = par.get(x); return x; };
      for (const p of P) if ((p.type === 'V' || p.type === 'L') && p.a !== p.b) {
        const ra = f(p.a), rb = f(p.b);
        if (ra === rb) add('error', `${p.name} closes a loop made only of voltage sources and inductors, so the DC current is undefined.`, 'Add a small series resistance (e.g. 0.1 Ω) inside the loop, or remove the duplicate source.');
        else par.set(ra, rb);
      }
    }
    if (c.hasGround) { // nets with no DC path to ground (only capacitors / current sources reach them)
      const f = uf(P.filter((p) => 'RLV'.includes(p.type)).map((p) => [p.a, p.b]));
      const used = [...new Set(P.flatMap((p) => [p.a, p.b]))].filter((n) => n !== 0 && f(n) !== f(0));
      if (used.length) add('warn', `No DC path to ground from ${used.map(N).join(', ')}.`, 'Their DC voltage is undefined (the solver pins it near 0 V). Add a large resistor to ground, e.g. 10 MΩ, if the DC level matters.');
    }
    for (const p of P) if (p.type === 'I') {
      const f = uf(P.filter((q) => q !== p && 'RLV'.includes(q.type)).map((q) => [q.a, q.b]));
      if (f(p.a) !== f(p.b)) add('warn', `${p.name} has no DC return path (it drives into a capacitor or an open).`, 'Its DC voltage grows without limit; add a resistor across it or a return path.');
    }
    // --- operating-point checks
    for (const p of P) {
      if (p.i === undefined) continue;
      const pw = Math.abs(p.i * p.v);
      if (p.type === 'R' && pw > 0.25) add('warn', `${p.name} dissipates ${fmt(pw, 'W')}, more than a standard ¼ W resistor.`, `Use a ${pw > 1 ? fmt(Math.ceil(pw * 2), 'W') : '½ W or 1 W'} part, or raise the resistance.`);
      if ((p.type === 'V' || p.type === 'L') && Math.abs(p.i) > 1) add('info', `${p.name} carries ${fmt(Math.abs(p.i), 'A')}.`, 'Make sure the real supply/inductor is rated for that current.');
    }

    // --- recognition (what the circuit is, its figures, likely applications)
    const passive = P.filter((p) => 'RCL'.includes(p.type) && p.value > 0 && p.a !== p.b);
    const deg = new Map();
    for (const p of P) for (const n of [p.a, p.b]) deg.set(n, (deg.get(n) || 0) + 1);
    // ponytail: "every node has degree 2 and #nodes = #parts" also matches two disjoint loops; fine for a hint
    const loop = P.length >= 3 && [...deg.values()].every((d) => d === 2) && deg.size === P.length;
    const sum = (t, f) => P.filter((p) => p.type === t).reduce((s, p) => s + f(p.value), 0);
    if (loop && passive.some((p) => p.type === 'L') && passive.some((p) => p.type === 'C')) {
      const R = sum('R', (v) => v), L = sum('L', (v) => v), C = 1 / sum('C', (v) => 1 / v), f0 = 1 / (TAU * Math.sqrt(L * C));
      const fig = R > 0 ? { f0, q: Math.sqrt(L / C) / R, bw: (f0 * R) / Math.sqrt(L / C) } : { f0 };
      add('idea', `Series ${R > 0 ? 'RLC' : 'LC'} resonant circuit: ${figText(fig)}.`, 'Likely uses: band-pass / tuned circuits (radio tuning), notch filters, resonant converters, wireless power. ' + (R > 0 ? 'Higher Q = sharper peak: lower R or raise L/C.' : 'With no resistance it rings forever; add R for damping.'), actionFor(fig));
    } else {
      const seen = new Set();
      for (const s of passive) for (const h of passive) {
        if (s === h || s.a === 0 || s.b === 0) continue;
        const hn = h.a === 0 ? h.b : h.b === 0 ? h.a : null;
        if (!hn || (hn !== s.a && hn !== s.b)) continue;
        const info = SECTIONS[s.type + h.type], key = s.name + '|' + h.name;
        if (!info || seen.has(key)) continue;
        seen.add(key);
        const inN = s.a === hn ? s.b : s.a, fig = info.fig(s.value, h.value);
        const loaded = (deg.get(hn) || 0) > 2 ? ' (other parts also load this node, so the real figures shift)' : '';
        add('idea', `${info.name}: ${s.name} then ${h.name}, ${N(inN)} → ${N(hn)}. ${figText(fig)}${loaded}.`, `Likely uses: ${info.uses}.`, actionFor(fig));
      }
    }
    for (let i = 0; i < passive.length; i++) for (let j = i + 1; j < passive.length; j++) {
      const a = passive[i], b = passive[j];
      const same = (a.a === b.a && a.b === b.b) || (a.a === b.b && a.b === b.a);
      if (!same || a.type === b.type || !'LC'.includes(a.type) || !'LC'.includes(b.type)) continue;
      const L = a.type === 'L' ? a.value : b.value, C = a.type === 'C' ? a.value : b.value, fig = { f0: 1 / (TAU * Math.sqrt(L * C)), z0: Math.sqrt(L / C) };
      add('idea', `Parallel LC tank (${a.name} ∥ ${b.name}): ${figText(fig)}.`, 'Likely uses: oscillator tank circuits, RF tuning, band-stop traps. Its impedance peaks at f₀.', actionFor(fig));
    }
    return out;
  }

  const api = { parseSI, fmt, spiceNum, rot, terms, onInterior, nets, parseNetlist, toNetlist, layout, inspect };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CT = api;
})(this);
