// Headless proof: build an engine from a preset, crank + start + rev it, write a WAV, time it.
#include "engine_builder.h"
#include "../engine-sim/include/engine.h"
#include "../engine-sim/include/simulator.h"
#include "../engine-sim/include/piston_engine_simulator.h"
#include "../engine-sim/include/transmission.h"
#include "../engine-sim/include/units.h"
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <vector>
#include <cstdlib>

static std::string g_irDir = "ir/";
static bool loadIr(const std::string &name, std::vector<short> *out) {
    std::ifstream f(g_irDir + name, std::ios::binary); if (!f) return false;
    std::vector<char> b((std::istreambuf_iterator<char>(f)), {});
    size_t p = 12;
    int ch = 1, bits = 16;
    while (p + 8 <= b.size()) {
        unsigned sz; memcpy(&sz, &b[p + 4], 4);
        if (!memcmp(&b[p], "fmt ", 4)) { short c, bb; memcpy(&c, &b[p + 10], 2); memcpy(&bb, &b[p + 22], 2); ch = c; bits = bb; }
        if (!memcmp(&b[p], "data", 4)) {
            if (bits != 16) return false;
            const short *d = (const short *)&b[p + 8]; size_t n = sz / 2 / ch;
            out->resize(n); for (size_t i = 0; i < n; ++i) (*out)[i] = d[i * ch];
            return true;
        }
        p += 8 + sz + (sz & 1);
    }
    return false;
}
static void writeWav(const char *path, const std::vector<short> &s, int sr) {
    FILE *f = fopen(path, "wb"); unsigned n = (unsigned)s.size() * 2, v;
    fwrite("RIFF", 1, 4, f); v = 36 + n; fwrite(&v, 4, 1, f); fwrite("WAVEfmt ", 1, 8, f);
    v = 16; fwrite(&v, 4, 1, f); short a = 1, c = 1, ba = 2, bps = 16; fwrite(&a, 2, 1, f); fwrite(&c, 2, 1, f);
    v = sr; fwrite(&v, 4, 1, f); v = sr * 2; fwrite(&v, 4, 1, f); fwrite(&ba, 2, 1, f); fwrite(&bps, 2, 1, f);
    fwrite("data", 1, 4, f); fwrite(&n, 4, 1, f); fwrite(s.data(), 2, s.size(), f); fclose(f);
}

int main(int argc, char **argv) {
    const char *which = argc > 1 ? argv[1] : "2jz";
    const char *outPath = argc > 2 ? argv[2] : "out.wav";
    EngineSpec spec = !strcmp(which, "v8") ? presetCrossPlaneV8() : preset2JZ();
    if (getenv("SIMF")) spec.simFrequency = atof(getenv("SIMF"));
    BuiltEngine be; std::string err;
    if (!buildEngine(spec, loadIr, &be, &err)) { printf("build failed: %s\n", err.c_str()); return 1; }
    Simulator *sim = be.simulator; Engine *eng = be.engine;
    if (getenv("FLUID")) ((PistonEngineSimulator *)sim)->setFluidSimulationSteps(atoi(getenv("FLUID")));
    printf("built %s: %d cyl, %.2f L\n", eng->getName().c_str(), eng->getCylinderCount(), eng->getDisplacement() / units::L);

    const double dt = 1.0 / 60, total = 9.0;
    std::vector<short> audio, buf(4096);
    auto t0 = std::chrono::steady_clock::now();
    double maxRpm = 0; int frames = 0;
    for (double t = 0; t < total; t += dt, ++frames) {
        static double crankS = getenv("CRANK") ? atof(getenv("CRANK")) : 1.2;
        static double crankThr = getenv("CTHR") ? atof(getenv("CTHR")) : 0.0;
        sim->m_starterMotor.m_enabled = t < crankS;
        double thr = t < crankS ? crankThr : 0;
        if (t > 3.0 && t < 4.6) thr = 1.0;                 // rev 1
        if (t > 6.0 && t < 6.3) thr = 1.0;                 // blip
        eng->setSpeedControl(thr);
        sim->startFrame(dt);
        while (sim->simulateStep()) {}
        sim->endFrame();
        sim->synthesizer().renderAudioSync();
        int n;
        while ((n = sim->readAudioOutput((int)buf.size(), buf.data())) > 0) audio.insert(audio.end(), buf.begin(), buf.begin() + n);
        const double rpm = eng->getRpm(); if (rpm > maxRpm) maxRpm = rpm;
        if (frames % 30 == 0) printf("t=%.1fs rpm=%5.0f thr=%.1f steps=%d audio=%zu\n", t, rpm, thr, sim->getFrameIterationCount(), audio.size());
    }
    const double wall = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    printf("simulated %.1fs in %.2fs wall -> %.1fx realtime, max rpm %.0f, %zu audio samples (%.2fs)\n",
        total, wall, total / wall, maxRpm, audio.size(), audio.size() / 44100.0);
    writeWav(outPath, audio, 44100);
    return 0;
}
