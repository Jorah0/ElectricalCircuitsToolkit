// Solver self-check: `node test.js`
const assert = require('assert');
const S = require('./solver.js');
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: got ${a}, want ${b}`);

// DC divider: 10V -> 1k -> node2 -> 1k -> gnd
let ckt = { nodeCount: 3, elements: [
  { type: 'V', a: 1, b: 0, value: 10 },
  { type: 'R', a: 1, b: 2, value: 1000 },
  { type: 'R', a: 2, b: 0, value: 1000 },
] };
let r = S.dc(ckt);
near(r.v[2], 5, 1e-6, 'divider midpoint');
near(r.i[1], 0.005, 1e-9, 'divider current');

// DC: inductor is a short, capacitor is open
ckt = { nodeCount: 3, elements: [
  { type: 'V', a: 1, b: 0, value: 12 },
  { type: 'L', a: 1, b: 2, value: 1e-3 },
  { type: 'R', a: 2, b: 0, value: 100 },
  { type: 'C', a: 2, b: 0, value: 1e-6 },
] };
r = S.dc(ckt);
near(r.v[2], 12, 1e-6, 'inductor short');
near(r.i[1], 0.12, 1e-6, 'inductor current');

// Transient RC step: V=1 (step), R=1k, C=1u -> v(tau) = 1 - 1/e
ckt = { nodeCount: 3, elements: [
  { type: 'V', a: 1, b: 0, value: 1, wave: 'step' },
  { type: 'R', a: 1, b: 2, value: 1000 },
  { type: 'C', a: 2, b: 0, value: 1e-6 },
] };
const tr = S.transient(ckt, 1e-3, 1e-6);
near(tr.v[1000][2], 1 - Math.exp(-1), 2e-3, 'RC v(tau)');

// AC: series RLC at resonance -> full source voltage across R, zero phase
const L = 10e-3, C = 1e-6, f0 = 1 / (2 * Math.PI * Math.sqrt(L * C));
ckt = { nodeCount: 4, elements: [
  { type: 'V', a: 1, b: 0, value: 1, wave: 'sine', freq: f0 },
  { type: 'L', a: 1, b: 2, value: L },
  { type: 'C', a: 2, b: 3, value: C },
  { type: 'R', a: 3, b: 0, value: 50 },
] };
const a = S.ac(ckt, f0);
near(a.v[3][0], 1, 1e-6, 'RLC resonance |V_R|');
near(a.v[3][1], 0, 1e-6, 'RLC resonance phase');

// AC: RC low-pass at corner -> |H| = 1/sqrt2
const fc = 1 / (2 * Math.PI * 1000 * 1e-6);
ckt = { nodeCount: 3, elements: [
  { type: 'V', a: 1, b: 0, value: 1, wave: 'sine', freq: fc },
  { type: 'R', a: 1, b: 2, value: 1000 },
  { type: 'C', a: 2, b: 0, value: 1e-6 },
] };
const v = S.ac(ckt, fc).v[2];
near(Math.hypot(v[0], v[1]), Math.SQRT1_2, 1e-6, 'RC corner magnitude');

console.log('solver: all checks passed');

// ---------- circuit.js: netlist -> auto-layout -> connectivity -> netlist round trip, then solve ----------
const CT = require('./circuit.js');
near(CT.parseSI('4.7k'), 4700, 1e-9, 'parseSI k');
near(CT.parseSI('100nF'), 1e-7, 1e-20, 'parseSI n + unit');
near(CT.parseSI('1meg'), 1e6, 1e-6, 'parseSI meg');
near(CT.parseSI('2m'), 2e-3, 1e-12, 'parseSI milli');
assert(isNaN(CT.parseSI('abc')), 'parseSI rejects junk');

const src = `* bridge-ish test with a branch, a source polarity and a part between non-adjacent rails
V1 in 0 SIN(0 5 1k)
R1 in mid 1k
R2 mid out 2k
C1 out 0 100n
R3 in out 10k
L1 mid 0 10m`;
const items = CT.parseNetlist(src);
const lay = CT.layout(items);
const back = CT.parseNetlist(CT.toNetlist(lay.parts, lay.wires));
const canon = (list) => list.map((it) => [it.name, [it.a, it.b].join('-'), it.value, it.wave].join(' ')).sort().join('\n');
assert.strictEqual(canon(back), canon(items), 'layout preserves connectivity (round trip)');
const N = CT.nets(lay.parts, lay.wires);
assert(N.hasGround, 'layout adds ground');

// laid-out circuit solves the same as a hand-built netlist
const toCkt = (its) => {
  const ids = new Map([['0', 0]]);
  const node = (n) => { if (!ids.has(n)) ids.set(n, ids.size); return ids.get(n); };
  const elements = its.map((it) => ({ type: it.type, a: node(it.a), b: node(it.b), value: CT.parseSI(it.value), wave: it.wave, freq: CT.parseSI(it.freq) }));
  return { ckt: { nodeCount: ids.size, elements }, ids };
};
const A = toCkt(items), B = toCkt(back);
const va = S.ac(A.ckt, 1000).v[A.ids.get('out')], vb = S.ac(B.ckt, 1000).v[B.ids.get('out')];
near(Math.hypot(...va), Math.hypot(...vb), 1e-9, 'layout solves identically');

assert.throws(() => CT.parseNetlist('R1 a b'), /Line 1/, 'netlist error names the line');
assert.throws(() => CT.parseNetlist('R1 a b 1k\nR1 b 0 1k'), /duplicate/, 'duplicate names rejected');

// ---------- inference rules ----------
const summary = (its, extra = {}) => {
  const { ckt, ids } = toCkt(its);
  const names = [...ids.keys()];
  return { parts: its.map((it, j) => ({ ...it, value: CT.parseSI(it.value), a: ckt.elements[j].a, b: ckt.elements[j].b })), names, hasGround: true, open: [], dangling: 0, ...extra };
};
const has = (list, re) => list.some((x) => re.test(x.text));
let ins = CT.inspect(summary(CT.parseNetlist('V1 in 0 SIN(0 1 1k)\nR1 in out 1k\nC1 out 0 1u')));
assert(has(ins, /RC low-pass.*fc = 159 Hz/), 'recognises RC low-pass with fc');
assert(ins.find((x) => /RC low-pass/.test(x.text)).action.tstop === '5m', 'suggests 5τ stop time');
ins = CT.inspect(summary(CT.parseNetlist('V1 in 0 DC 12\nR1 in out 3k\nR2 out 0 1k')));
assert(has(ins, /voltage divider.*Vout\/Vin = 0\.25/), 'recognises divider ratio');
ins = CT.inspect(summary(CT.parseNetlist('V1 a 0 SIN(0 1 1k)\nR1 a b 10\nL1 b c 10m\nC1 c 0 1u')));
assert(has(ins, /Series RLC.*f₀ = 1\.59 kHz.*Q = 10/), 'recognises series RLC with f0 and Q');
ins = CT.inspect(summary(CT.parseNetlist('V1 a 0 DC 5\nV2 a 0 DC 3')));
assert(has(ins, /loop made only of voltage sources/), 'flags parallel voltage sources');
ins = CT.inspect(summary(CT.parseNetlist('V1 a 0 DC 5\nC1 a b 1u\nR1 b c 1k\nC2 c 0 1u')));
assert(has(ins, /No DC path to ground from b, c/), 'flags floating DC nodes');
ins = CT.inspect(summary(CT.parseNetlist('V1 a 0 DC 10\nR1 a 0 100'), {}));
ins = CT.inspect({ ...summary(CT.parseNetlist('V1 a 0 DC 10\nR1 a 0 100')), parts: summary(CT.parseNetlist('V1 a 0 DC 10\nR1 a 0 100')).parts.map((p) => (p.type === 'R' ? { ...p, i: 0.1, v: 10 } : p)) });
assert(has(ins, /R1 dissipates 1 W/), 'flags overloaded resistor');
console.log('circuit: all checks passed');
