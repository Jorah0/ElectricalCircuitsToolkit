# Circuit Toolkit

Browser-based schematic editor and linear circuit solver. No build step: open `index.html` (internet needed for the math library and the AI assistant).

- **Draw**: resistors, capacitors, inductors, V/I sources (DC, sine, square, triangle, sawtooth, step, f(t)), ground. Traces snap to a grid; start or end a trace on another trace to branch it. Press `?` for every shortcut (`E`/`Q` rotate, `F` flip, arrows nudge, `Ctrl+D` duplicate…).
- **Solve**: DC operating point, AC phasors, transient, Bode sweep (Modified Nodal Analysis, `solver.js`). Results show on the canvas, in the side panel and as waveforms.
- **Insights**: live rule-based checks (missing ground, open terminals, shorts, floating nodes, source loops, overloaded resistors) and recognition of common circuits (RC/RL/LC filters, dividers, series RLC, LC tanks) with their key figures, likely applications and one-click analyses (`circuit.js`).
- **Math**: algebra and calculus via nerdamer: `solve`, `diff`, `integrate`, `defint`, `laplace`, `ilt` (results checked numerically), `plot f(x), a, b`, variables `x := 5`.
- **Assistant**: paste an Anthropic API key in the Assistant tab. Claude reviews the circuit, explains results, suggests applications, and can generate circuits and run analyses itself (`assistant.js`).
- **Files**: `Ctrl+S`/`Ctrl+O` save/open `.json` circuits; open or drop SPICE-style netlists (`.cir`, `.net`, `.sp`), which get auto-laid-out; export SVG, PNG, netlist or waveform CSV. The Netlist button edits the circuit as text.

Tests: `node test.js`
