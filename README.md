# MOTORSYNC

Build any engine (inline, V, VR or flat, 1–16 cylinders, NA, turbo, supercharged or twin-charged), then rev it and drive it on your phone. Live at **https://ejbur158x.github.io/motorsync/**.

## Two sound engines

- **Standard (default).** MOTORSYNC's procedural synth, the same one behind our I6 Turbo and SLR V8 sound engines for the Godot game. The **MotorSync I6 Turbo** and **SLR Supercharged V8** presets run those exact tuned cores. Every other build runs a generic version of the same recipe (`web/std/generic-core.js`): each cylinder fires at its real angle from the builder, one or two exhaust pipes, the same resonances. Checked against the originals, a generic cross-plane V8 lands within ~3 dB of the SLR core on every engine order. It's light enough to run on anything. The car model is our original demo drivetrain (`web/std/car.js`).
- **Engine physics simulation (opt-in).** [engine-sim](https://github.com/ange-yaghi/engine-sim) by Ange Yaghi (MIT), compiled to WebAssembly: real pistons, valves, gas flow and exhaust pulses. It keeps a CPU core busy, so the app shows a warning before switching. It has the **Dyno** tab (horsepower/torque pulls). engine-sim has no turbo or supercharger, so MOTORSYNC adds one: boost pressure goes into the intake ahead of the throttle (so boost makes real power), and the turbo/blower sound comes from our synth (`web/forced.js`).

Switch with **Standard | Physics** at the top. The physics engine only starts when you pick Physics.

## Using it

Tabs: **Drive**, **Build**, **Sync**, plus **Dyno** in Physics mode.

- **Start** cranks until the engine catches. Tap again to shut it off.
- **Brake / Gas pedals**: drag up. Release and they snap back.
- **+ / −** shift. The clutch is automatic: it slips in on launch and opens before a stall. Use two fingers to shift while holding gas.
- **Dyno** (Physics mode): a 10 s full-throttle pull in neutral, the dyno holding the crank. Horsepower and torque curves; the previous run stays faded for comparison.
- **Build**: the garage (presets + your saved builds) and the engine builder. *Simple* = layout, cylinders, size, aspiration, boost, street↔race, crank. *Advanced* = bore/stroke, V angle, compression, flywheel, cams, headers, exhaust, turbo size, blow-off/flutter, supercharger type (twin-screw, roots, centrifugal), whine colour, limits, and (Standard) the drivetrain feel: shift times, clutch bite, launch, rev-up, limiter bounce, brakes.
- **Sync**: OBD-II placeholders.
- **Tune**:
  - **Sound** settings change the running engine instantly.
  - **Engine** settings rebuild the engine and restart it.
  - Settings save on your device. Use *Copy settings* to share a build.
- **Simulation quality**: if the audio has gaps, step down to *Lite*. The CPU % in the corner shows how hard the physics is working.
- **Keyboard**: W or ↑ = gas, Space = start, E/Q = shift.

Presets: **MotorSync I6 Turbo**, **SLR Supercharged V8**, stock **2JZ** and **GM LS** (from Ange's own scripts), **Twin-charged I7**, **Flat-6 boxer**, **V12**.

## How it's built

| path | what it is |
|---|---|
| `engine-sim/` | engine-sim core (physics + synthesizer), patched to build without threads or Windows headers. Every change is marked `[port]`. Renderer and UI are left out. |
| `port/engine_builder.*` | builds engines from a plain `EngineSpec` struct instead of his `.mr` scripting language. The presets live here. |
| `port/es_api.cpp` | flat C API exported from the WASM: create, throttle, starter, gear, clutch, dyno, live sound tweaks, readouts |
| `port/main_native.cpp` | headless native driver for testing (renders a WAV) |
| `web/builder.js` | engine builder: turns layout/cylinders/size/aspiration/character into a full engine (crank journals, firing angles, cams, ports…) |
| `web/forced.js` | boost model + turbo/blow-off/supercharger sound |
| `web/worker.js` | runs the sim in a Web Worker, one 1/60 s frame at a time, ~120 ms buffered. Auto-start, idle air control, automatic clutch, brakes, boost, dyno. |
| `web/worklet.js` | AudioWorklet that plays the streamed audio |
| `web/app.html`, `web/app.js` | the UI and both backends (Standard worklet + car, Physics worker) |
| `web/std/i6-core.js`, `v8-core.js` | our original I6 Turbo and SLR V8 synth cores |
| `web/std/generic-core.js` | the builder synth for any layout |
| `web/std/car.js` | Standard car model (EJ's tuned drivetrain timing) |
| `web/std/worklet-proc.js` | the Standard AudioWorklet processor |
| `web/build.js` | inlines the WASM, impulse responses and scripts into `index.html` |
| `ir/` | exhaust impulse responses from engine-sim |
| `tools/` | node tests: `std_test.js` (renders the Standard synths offline), `builder_test.js` (every layout starts, idles and makes power), `worker_test.js` (start, launch, brake, dyno), benchmarks |

Rebuild:

```sh
SDK=/path/to/wasi-sdk-24.0 ./build_wasm.sh   # -> es.wasm (only if the C++ changed)
node web/build.js                            # -> index.html
node tools/bench.js 0 7000 4 out.wav         # preset, sim Hz, fluid steps: prints the realtime factor
```

## Performance

Measured on a 2-core 2.1 GHz cloud CPU in Chromium:

| engine | speed (realtime factor) |
|---|---|
| 2JZ | 1.9× |
| LS V8 | 1.55× |

Default settings: 7 kHz physics, 4 fluid steps. These sound within about 1 dB of his 10 kHz default, at roughly half the CPU.

## License

engine-sim is © Ange Yaghi, MIT license: see `engine-sim/LICENSE`. That notice has to stay with the code.
