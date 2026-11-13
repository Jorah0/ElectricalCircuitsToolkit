// Modified Nodal Analysis for linear circuits: DC operating point, AC phasor, transient (backward Euler).
// Netlist: { nodeCount, elements: [{ type: 'R'|'C'|'L'|'V'|'I', a, b, value, wave?, freq?, phase?, offset?, fn? }] }
// Node 0 is ground. Element current is reported flowing a -> b through the element; V/I sources: a is '+'.
(function (root) {
  const GMIN = 1e-12; // tiny leak to ground so floating nodes (e.g. behind a capacitor at DC) stay solvable

  function gauss(A, b) {
    const n = b.length;
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      if (Math.abs(A[p][c]) < 1e-15) throw new Error('Circuit cannot be solved: check for a loop of voltage sources/inductors or a current source with no return path.');
      [A[c], A[p]] = [A[p], A[c]];
      [b[c], b[p]] = [b[p], b[c]];
      for (let r = c + 1; r < n; r++) {
        const f = A[r][c] / A[c][c];
        if (!f) continue;
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const x = new Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
      x[r] = s / A[r][r];
    }
    return x;
  }

  // Instantaneous source value at time t.
  function sourceValue(e, t) {
    const amp = e.value, off = e.offset || 0, f = e.freq || 0;
    const w = 2 * Math.PI * f * t + ((e.phase || 0) * Math.PI) / 180;
    switch (e.wave || 'dc') {
      case 'dc': return amp;
      case 'sine': return off + amp * Math.sin(w);
      case 'square': return off + amp * (Math.sin(w) >= 0 ? 1 : -1);
      case 'triangle': return off + amp * (2 / Math.PI) * Math.asin(Math.sin(w));
      case 'sawtooth': { const x = w / (2 * Math.PI); return off + amp * 2 * (x - Math.floor(x + 0.5)); }
      case 'step': return t > 0 ? off + amp : off;
      case 'expr': return e.fn ? e.fn(t) : 0;
    }
    return 0;
  }
  // DC operating point uses the resting level; AC uses only sine sources (amplitude∠phase, sine reference).
  const dcValue = (e) => (!e.wave || e.wave === 'dc' ? e.value : e.wave === 'expr' ? sourceValue(e, 0) : e.offset || 0);
  const acPhasor = (e) => {
    if (e.wave !== 'sine') return [0, 0];
    const ph = ((e.phase || 0) * Math.PI) / 180;
    return [e.value * Math.cos(ph), e.value * Math.sin(ph)];
  };
  const srcNow = (e, mode, o) => (mode === 'ac' ? acPhasor(e) : [mode === 'tran' ? sourceValue(e, o.t) : dcValue(e), 0]);

  // Build and solve one MNA system. mode: 'dc' | 'ac' (needs omega) | 'tran' (needs dt, t, prev).
  function solveOnce(ckt, mode, o = {}) {
    const n = ckt.nodeCount - 1;
    const branch = new Map();
    let m = 0;
    for (const e of ckt.elements) if (e.type === 'V' || e.type === 'L') branch.set(e, n + m++);
    const N = n + m;
    const Re = Array.from({ length: N }, () => new Array(N).fill(0));
    const Im = Array.from({ length: N }, () => new Array(N).fill(0));
    const zr = new Array(N).fill(0), zi = new Array(N).fill(0);
    const A = (r, c, re, im = 0) => { if (r >= 0 && c >= 0) { Re[r][c] += re; Im[r][c] += im; } };
    const Z = (r, re, im = 0) => { if (r >= 0) { zr[r] += re; zi[r] += im; } };
    const Y = (a, b, re, im = 0) => { a--; b--; A(a, a, re, im); A(b, b, re, im); A(a, b, -re, -im); A(b, a, -re, -im); };
    for (let i = 0; i < n; i++) Re[i][i] += GMIN;
    const w = o.omega || 0, dt = o.dt, prev = o.prev;

    for (const e of ckt.elements) {
      const a = e.a - 1, b = e.b - 1, k = branch.get(e);
      if (k !== undefined) { A(a, k, 1); A(b, k, -1); A(k, a, 1); A(k, b, -1); }
      switch (e.type) {
        case 'R': Y(e.a, e.b, 1 / e.value); break;
        case 'C':
          if (mode === 'ac') Y(e.a, e.b, 0, w * e.value);
          else if (mode === 'tran') { // companion model: G = C/dt in parallel with a history current
            const G = e.value / dt, vp = prev.v[e.a] - prev.v[e.b];
            Y(e.a, e.b, G); Z(a, G * vp); Z(b, -G * vp);
          }
          break;
        case 'L': // Va - Vb - Z*i = rhs ; DC: short
          if (mode === 'ac') A(k, k, 0, -w * e.value);
          else if (mode === 'tran') { A(k, k, -e.value / dt); Z(k, (-e.value / dt) * (prev.branch.get(e) || 0)); }
          break;
        case 'V': Z(k, ...srcNow(e, mode, o)); break;
        case 'I': { const [ir, ii] = srcNow(e, mode, o); Z(a, -ir, -ii); Z(b, ir, ii); break; }
      }
    }

    let xr, xi;
    if (mode === 'ac') { // complex system as a real 2N system: [Re -Im; Im Re]
      const B = [];
      for (let r = 0; r < N; r++) B.push([...Re[r], ...Im[r].map((v) => -v)]);
      for (let r = 0; r < N; r++) B.push([...Im[r], ...Re[r]]);
      const x = gauss(B, [...zr, ...zi]);
      xr = x.slice(0, N); xi = x.slice(N);
    } else { xr = gauss(Re, zr); xi = new Array(N).fill(0); }

    const v = [0, ...xr.slice(0, n)], vi = [0, ...xi.slice(0, n)];
    const br = new Map();
    for (const [e, k] of branch) br.set(e, [xr[k], xi[k]]);
    const cur = ckt.elements.map((e) => { // current through each element, a -> b
      const dr = v[e.a] - v[e.b], di = vi[e.a] - vi[e.b];
      switch (e.type) {
        case 'R': return [dr / e.value, di / e.value];
        case 'C':
          if (mode === 'ac') return [-w * e.value * di, w * e.value * dr];
          if (mode === 'tran') return [(e.value / dt) * (dr - (prev.v[e.a] - prev.v[e.b])), 0];
          return [0, 0];
        case 'I': return srcNow(e, mode, o);
        default: return br.get(e);
      }
    });
    return { v, vi, cur, branch: new Map([...br].map(([e, c]) => [e, c[0]])) };
  }

  function dc(ckt) {
    const r = solveOnce(ckt, 'dc');
    return { v: r.v, i: r.cur.map((c) => c[0]) };
  }

  // Phasors: v[k] = [re, im], i[k] = [re, im].
  function ac(ckt, freq) {
    const r = solveOnce(ckt, 'ac', { omega: 2 * Math.PI * freq });
    return { v: r.v.map((re, k) => [re, r.vi[k]]), i: r.cur };
  }

  // Transient from zero initial state (capacitors discharged, inductors at 0 A), or from the DC operating point.
  function transient(ckt, tStop, dt, fromDC = false) {
    let prev = fromDC ? solveOnce(ckt, 'dc') : { v: new Array(ckt.nodeCount).fill(0), branch: new Map() };
    const out = { t: [0], v: [prev.v.slice()], i: [ckt.elements.map(() => 0)] };
    const steps = Math.min(100000, Math.ceil(tStop / dt));
    for (let s = 1; s <= steps; s++) {
      const r = solveOnce(ckt, 'tran', { dt, t: s * dt, prev });
      out.t.push(s * dt); out.v.push(r.v); out.i.push(r.cur.map((c) => c[0]));
      prev = r;
    }
    return out;
  }

  const api = { dc, ac, transient, sourceValue };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Solver = api;
})(this);
