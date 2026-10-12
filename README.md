# MotorSync

A real engine physics simulator running on your phone. Pick an engine, rev it, shift it, tune it, and hear what the physics makes. Live at **https://ejbur158x.github.io/motorsync/**.

The sound isn't samples. It comes from [engine-sim](https://github.com/ange-yaghi/engine-sim) by Ange Yaghi (MIT), which simulates the pistons, valves, gas flow and exhaust pulses. Here it's compiled to WebAssembly and runs on your device.

**Next up: OBD-II sync.** The sim's dyno gets locked to your real car's rpm and fed your real throttle position, so the custom engine follows your actual engine in real time.

## Using it

- **Start** cranks until the engine catches. Tap again to shut it off.
- **Gas pedal**: drag up on the right. Release and it snaps back.
- **+ / −** shift. The clutch is automatic. Use two fingers to shift while holding the pedal.
- **Tune**:
  - **Sound** settings change the running engine instantly.
  - **Engine** settings rebuild the engine and restart it.
  - Settings save on your device. Use *Copy settings* to share a build.
- **Simulation quality**: if the audio has gaps, step down to *Lite*. The CPU % in the corner shows how hard the physics is working.
- **Keyboard**: W or ↑ = gas, Space = start, E/Q = shift.

Presets: **2JZ I6** and **GM LS V8**, both taken from Ange's own engine scripts.

## How it's built

| path | what it is |
|---|---|
| `engine-sim/` | engine-sim core (physics + synthesizer), patched to build without threads or Windows headers. Every change is marked `[port]`. Renderer and UI are left out. |
| `port/engine_builder.*` | builds engines from a plain `EngineSpec` struct instead of his `.mr` scripting language. The presets live here. |
| `port/es_api.cpp` | flat C API exported from the WASM: create, throttle, starter, gear, clutch, dyno, live sound tweaks, readouts |
| `port/main_native.cpp` | headless native driver for testing (renders a WAV) |
| `web/worker.js` | runs the sim in a Web Worker, one 1/60 s frame at a time. Keeps about 120 ms of audio buffered. Handles auto-start and the clutch. |
| `web/worklet.js` | AudioWorklet that plays the streamed audio |
| `web/app.html` | the UI |
| `web/build.js` | inlines the WASM, impulse responses and scripts into `index.html` |
| `ir/` | exhaust impulse responses from engine-sim |
| `tools/` | node test scripts (benchmarks, idle, gear launch) |

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
