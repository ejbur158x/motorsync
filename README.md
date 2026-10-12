# MOTORSYNC

A real engine physics simulator running on your phone. Build any engine (inline, V, VR or flat, 1–16 cylinders, NA, turbo, supercharged or twin-charged), then rev it, drive it and put it on the dyno. Live at **https://ejbur158x.github.io/motorsync/**.

The sound isn't samples. It comes from [engine-sim](https://github.com/ange-yaghi/engine-sim) by Ange Yaghi (MIT), which simulates the pistons, valves, gas flow and exhaust pulses. Here it's compiled to WebAssembly and runs on your device.

**Next up: OBD-II sync.** The sim's dyno gets locked to your real car's rpm and fed your real throttle position, so the custom engine follows your actual engine in real time.

## Using it

Tabs: **Drive**, **Dyno**, **Build**, **Sync**.

- **Start** cranks until the engine catches. Tap again to shut it off.
- **Brake / Gas pedals**: drag up. Release and they snap back.
- **+ / −** shift. The clutch is automatic: it slips in on launch and opens before a stall. Use two fingers to shift while holding gas.
- **Dyno**: a 10 s full-throttle pull in neutral, the dyno holding the crank. Horsepower and torque curves; the previous run stays faded for comparison.
- **Build**: the garage (presets + your saved builds) and the engine builder. *Simple* = layout, cylinders, size, aspiration, boost, street↔race, crank. *Advanced* = bore/stroke, V angle, compression, flywheel, cams, headers, exhaust, turbo size, blow-off/flutter, supercharger type (twin-screw, roots, centrifugal), whine colour, limits.
- **Sync**: OBD-II placeholders.
- **Tune**:
  - **Sound** settings change the running engine instantly.
  - **Engine** settings rebuild the engine and restart it.
  - Settings save on your device. Use *Copy settings* to share a build.
- **Simulation quality**: if the audio has gaps, step down to *Lite*. The CPU % in the corner shows how hard the physics is working.
- **Keyboard**: W or ↑ = gas, Space = start, E/Q = shift.

Presets: **MotorSync I6 Turbo**, **SLR Supercharged V8**, stock **2JZ** and **GM LS** (from Ange's own scripts), **Twin-charged I7**, **Flat-6 boxer**, **V12**.

**Forced induction.** engine-sim has no turbo or supercharger, so MOTORSYNC adds one: boost pressure is pushed into the intake ahead of the throttle (so boost makes real power), from a turbo spool model or a supercharger curve that follows rpm. The turbo whistle, blow-off/flutter and the blower whine (the SLR twin-screw "eee" with engine chop) come from our earlier I6 Turbo and SLR V8 synths (`web/forced.js`).

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
| `web/app.html` | the UI |
| `web/build.js` | inlines the WASM, impulse responses and scripts into `index.html` |
| `ir/` | exhaust impulse responses from engine-sim |
| `tools/` | node tests: `builder_test.js` (every layout starts, idles and makes power), `worker_test.js` (start, launch, brake, dyno), benchmarks |

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
