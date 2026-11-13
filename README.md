# Circuit Toolkit

Schematic editor and linear circuit solver. Run it as a desktop app (`dist\CircuitToolkit.exe`) or open `index.html` in a browser. Everything works offline except the AI assistant.

**Desktop app**: a small Windows window around the same web app, using the Edge WebView2 engine built into Windows 10/11. Build it with
`dotnet publish desktop -c Release -o dist` (needs the .NET 8 SDK; the exe needs the .NET 8 Desktop Runtime).
For an exe that runs on PCs without .NET, add `-p:SelfContained=true -p:EnableCompressionInSingleFile=true` (~60 MB).
Rebuild after changing the web files, because they are embedded in the exe. The icon is drawn by `desktop/make-icon.ps1` (writes `desktop/icon.ico` and `icon.png`).

**Layout**: drag any panel edge to resize it (or focus it and use the arrow keys; double-click to reset). Sizes are remembered. `Ctrl` + `+` / `−` / `0` scales the whole interface.

- **Draw**: resistors, capacitors, inductors, V/I sources (DC, sine, square, triangle, sawtooth, step, f(t)), ground. Traces snap to a grid; start or end a trace on another trace to branch it. Press `?` for every shortcut (`E`/`Q` rotate, `F` flip, arrows nudge, `Ctrl+D` duplicate…).
- **Solve**: DC operating point, AC phasors, transient, Bode sweep (Modified Nodal Analysis, `solver.js`). Results show on the canvas, in the side panel and as waveforms.
- **Insights**: live rule-based checks (missing ground, open terminals, shorts, floating nodes, source loops, overloaded resistors) and recognition of common circuits (RC/RL/LC filters, dividers, series RLC, LC tanks) with their key figures, likely applications and one-click analyses (`circuit.js`).
- **Math**: algebra and calculus via nerdamer: `solve`, `diff`, `integrate`, `defint`, `laplace`, `ilt` (results checked numerically), `plot f(x), a, b`, variables `x := 5`.
- **Assistant**: paste an Anthropic API key in the Assistant tab. Claude reviews the circuit, explains results, suggests applications, and can generate circuits and run analyses itself (`assistant.js`).
- **Files**: `Ctrl+S`/`Ctrl+O` save/open `.json` circuits; open or drop SPICE-style netlists (`.cir`, `.net`, `.sp`), which get auto-laid-out; export SVG, PNG, netlist or waveform CSV. The Netlist button edits the circuit as text.

Tests: `node test.js`
