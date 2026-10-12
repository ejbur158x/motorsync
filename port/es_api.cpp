// Flat C API around the engine-sim core for WebAssembly (and native testing).
// JS flow: es_ir_alloc/es_ir_commit for each impulse response -> es_create(preset) ->
// per audio block: es_set_* then es_render(n) -> read es_audio_ptr().
#include "engine_builder.h"
#include "../engine-sim/include/engine.h"
#include "../engine-sim/include/simulator.h"
#include "../engine-sim/include/piston_engine_simulator.h"
#include "../engine-sim/include/transmission.h"
#include "../engine-sim/include/vehicle.h"
#include "../engine-sim/include/units.h"
#include "../engine-sim/include/exhaust_system.h"
#include "../engine-sim/include/ignition_module.h"
#include <cstring>
#include <map>
#include <string>
#include <vector>
#include <algorithm>

#define API extern "C" __attribute__((visibility("default")))

static std::map<std::string, std::vector<short>> g_ir;
static std::vector<unsigned char> g_irStage;
static BuiltEngine g_be;
static EngineSpec g_spec;
static std::vector<short> g_pcm;      // sim output, 44.1 kHz int16
static std::vector<float> g_out;      // block handed to JS
static size_t g_pcmRead = 0;
static double g_throttle = 0;
static std::string g_err;
static int g_fluid = 4;
static int g_presetIdx = 0;

static bool loadIr(const std::string &name, std::vector<short> *out) {
    auto it = g_ir.find(name); if (it == g_ir.end()) it = g_ir.find("mild_exhaust_reverb.wav");
    if (it == g_ir.end()) return false; *out = it->second; return true;
}

// Parse a 16-bit WAV (any channel count; takes channel 0).
static bool parseWav(const unsigned char *b, size_t len, std::vector<short> *out) {
    size_t p = 12; int ch = 1, bits = 16;
    while (p + 8 <= len) {
        unsigned sz; memcpy(&sz, b + p + 4, 4);
        if (!memcmp(b + p, "fmt ", 4)) { short c, bb; memcpy(&c, b + p + 10, 2); memcpy(&bb, b + p + 22, 2); ch = c; bits = bb; }
        if (!memcmp(b + p, "data", 4)) {
            if (bits != 16 || p + 8 + sz > len) return false;
            size_t n = sz / 2 / ch; out->resize(n);
            for (size_t i = 0; i < n; ++i) memcpy(&(*out)[i], b + p + 8 + i * ch * 2, 2);
            return true;
        }
        p += 8 + sz + (sz & 1);
    }
    return false;
}

API unsigned char *es_ir_alloc(int bytes) { g_irStage.assign(bytes, 0); return g_irStage.data(); }
static char g_name[128];
API char *es_name_buf() { return g_name; }
API int es_ir_commit() { std::vector<short> s; if (!parseWav(g_irStage.data(), g_irStage.size(), &s)) return 0; g_ir[g_name] = s; return (int)s.size(); }

static void destroy() {
    if (g_be.simulator) { g_be.simulator->destroy(); delete g_be.simulator; }
    // engine/vehicle/transmission are owned by the simulator in the original app; leak-safe enough for a demo
    g_be = BuiltEngine(); g_pcm.clear(); g_pcmRead = 0;
}

// Spec overrides are set as key/value pairs before es_create (see es_param).
static std::map<std::string, double> g_over;
API void es_param(double v) { g_over[g_name] = v; }
API void es_params_clear() { g_over.clear(); }

// key -> field table shared by es_param (override before build) and es_get (read the built spec).
// Exhaust keys apply to every exhaust; "bank2Volume" scales exhaust 1 only.
static const char *kIrs[] = { "mild_exhaust_reverb.wav", "mild_exhaust.wav", "minimal_muffling_01.wav", "minimal_muffling_02.wav", "minimal_muffling_03.wav", "smooth_39.wav" };
static double *field(EngineSpec &s, const std::string &k) {
#define F(name, expr) if (k == name) return &(expr);
    F("boreMm", s.boreMm) F("strokeMm", s.strokeMm) F("rodMm", s.rodMm)
    F("flywheelMassKg", s.flywheelMassKg) F("crankMassKg", s.crankMassKg) F("pistonMassG", s.pistonMassG)
    F("intakeDuration", s.intakeDuration) F("exhaustDuration", s.exhaustDuration)
    F("intakeLiftMm", s.intakeLiftMm) F("exhaustLiftMm", s.exhaustLiftMm)
    F("intakeLobeCenter", s.intakeLobeCenter) F("exhaustLobeCenter", s.exhaustLobeCenter) F("camAdvanceDeg", s.camAdvanceDeg)
    F("revLimitRpm", s.revLimitRpm) F("limiterDuration", s.limiterDuration) F("redlineRpm", s.redlineRpm)
    F("idleThrottlePlate", s.idleThrottlePlate) F("intakeFlowCarb", s.intakeFlowCarb) F("plenumL", s.plenumL) F("runnerLenIn", s.runnerLenIn)
    F("frictionLbFt", s.frictionLbFt) F("starterTorqueLbFt", s.starterTorqueLbFt) F("starterRpm", s.starterRpm)
    F("simFrequency", s.simFrequency) F("noise", s.noise) F("jitter", s.jitter) F("hfGain", s.hfGain)
    F("flowAttenuation", s.flowAttenuation) F("chamberCc", s.chamberCc) F("throttleGamma", s.throttleGamma)
#undef F
    if (!s.exhaust.empty()) {
        ExhaustSpec &e = s.exhaust[0];
        if (k == "exLengthIn") return &e.lengthIn; if (k == "exPrimaryTubeIn") return &e.primaryTubeIn;
        if (k == "exAudioVolume") return &e.audioVolume; if (k == "exVelocityDecay") return &e.velocityDecay;
        if (k == "exOutletFlow") return &e.outletFlowCarb; if (k == "exIrVolume") return &e.irVolume;
        if (k == "exPrimaryFlow") return &e.primaryFlowCarb;
    }
    return nullptr;
}
static double g_timingScale = 1, g_bank2 = 1, g_primary = -1, g_irSel = -1, g_fluidOver = -1;
static double *special(const std::string &k) {
    if (k == "timingScale") return &g_timingScale; if (k == "bank2Volume") return &g_bank2;
    if (k == "primaryLenIn") return &g_primary; if (k == "exIr") return &g_irSel; if (k == "fluidSteps") return &g_fluidOver;
    return nullptr;
}

static void applyOverrides(EngineSpec &s) {
    g_timingScale = 1; g_bank2 = 1; g_primary = -1; g_irSel = -1; g_fluidOver = -1;
    // exhaust keys: remember each exhaust's offset from exhaust 0 so per-pipe differences (e.g. the LS's 100/172 in) survive
    std::vector<ExhaustSpec> base = s.exhaust;
    for (auto &kv : g_over) {
        if (double *p = special(kv.first)) { *p = kv.second; continue; }
        if (double *p = field(s, kv.first)) *p = kv.second;
    }
    for (size_t i = 1; i < s.exhaust.size(); ++i) {
        ExhaustSpec &e = s.exhaust[i]; const ExhaustSpec &e0 = s.exhaust[0], &b0 = base[0], &bi = base[i];
        e.lengthIn = bi.lengthIn * (e0.lengthIn / b0.lengthIn); e.primaryTubeIn = bi.primaryTubeIn * (e0.primaryTubeIn / b0.primaryTubeIn);
        e.audioVolume = e0.audioVolume * (bi.audioVolume / b0.audioVolume) * g_bank2;
        e.velocityDecay = e0.velocityDecay; e.outletFlowCarb = e0.outletFlowCarb; e.primaryFlowCarb = e0.primaryFlowCarb; e.irVolume = e0.irVolume;
    }
    if (g_irSel >= 0 && g_irSel < 6) for (auto &e : s.exhaust) e.irFile = kIrs[(int)g_irSel];
    if (g_timingScale != 1) for (auto &c : s.timing) c.y *= g_timingScale;
    if (g_primary >= 0) { double mx = 0; for (auto &c : s.cyl) mx = std::max(mx, c.primaryLenIn); for (auto &c : s.cyl) c.primaryLenIn = mx > 0 ? c.primaryLenIn * g_primary / mx : g_primary; }
    if (g_fluidOver > 0) g_fluid = (int)g_fluidOver;
}

// Read a value from the current (built) spec, or the preset's default before any build.
API double es_get(int preset) {
    EngineSpec tmp; EngineSpec &s = preset < 0 ? g_spec : (tmp = preset == 1 ? presetCrossPlaneV8() : preset2JZ());
    std::string k = g_name;
    if (k == "primaryLenIn") { double mx = 0; for (auto &c : s.cyl) mx = std::max(mx, c.primaryLenIn); return mx; }
    if (k == "exIr") { for (int i = 0; i < 6; ++i) if (!s.exhaust.empty() && s.exhaust[0].irFile == kIrs[i]) return i; return 0; }
    if (k == "timingScale" || k == "bank2Volume") return 1;
    if (k == "fluidSteps") return g_fluid;
    if (double *p = field(s, k)) return *p;
    return -1;
}

// Apply a sound/limiter setting to the running engine without a rebuild. Returns 1 if handled live
// (the value is also kept for the next rebuild), 0 if the key needs es_create.
API int es_live(double v) {
    std::string k = g_name; g_over[k] = v;
    if (!g_be.simulator) return 0;
    Synthesizer &syn = g_be.simulator->synthesizer();
    if (k == "jitter" || k == "noise" || k == "hfGain") {
        *field(g_spec, k) = v;
        Synthesizer::AudioParameters ap = syn.getAudioParameters();
        ap.inputSampleNoise = (float)g_spec.jitter; ap.airNoise = (float)g_spec.noise; ap.dF_F_mix = (float)g_spec.hfGain;
        syn.setAudioParameters(ap); return 1;
    }
    if (k == "exAudioVolume" || k == "bank2Volume") {
        EngineSpec fresh = g_spec; // recompute per-pipe volumes from the overrides
        double base0 = (g_presetIdx == 1 ? presetCrossPlaneV8() : preset2JZ()).exhaust[0].audioVolume;
        double vol = g_over.count("exAudioVolume") ? g_over["exAudioVolume"] : base0;
        double b2 = g_over.count("bank2Volume") ? g_over["bank2Volume"] : 1;
        for (int i = 0; i < (int)g_spec.exhaust.size(); ++i) {
            g_spec.exhaust[i].audioVolume = vol * (i ? b2 : 1);
            g_be.engine->getExhaustSystem(i)->setAudioVolume(g_spec.exhaust[i].audioVolume);
        }
        return 1;
    }
    if (k == "exIr" || k == "exIrVolume") {
        if (k == "exIr" && v >= 0 && v < 6) for (auto &e : g_spec.exhaust) e.irFile = kIrs[(int)v];
        if (k == "exIrVolume") for (auto &e : g_spec.exhaust) e.irVolume = v;
        for (int i = 0; i < (int)g_spec.exhaust.size(); ++i) {
            std::vector<short> ir; if (!loadIr(g_spec.exhaust[i].irFile, &ir)) return 0;
            syn.replaceImpulseResponse((const int16_t *)ir.data(), (unsigned)ir.size(), (float)g_spec.exhaust[i].irVolume, i);
        }
        return 1;
    }
    if (k == "revLimitRpm" || k == "limiterDuration") {
        *field(g_spec, k) = v;
        g_be.engine->getIgnitionModule()->setRevLimit(units::rpm(g_spec.revLimitRpm), g_spec.limiterDuration); return 1;
    }
    return 0;
}

API int es_create(int preset) {
    g_presetIdx = preset;
    destroy();
    g_spec = preset == 1 ? presetCrossPlaneV8() : preset2JZ();
    g_fluid = 4; g_spec.simFrequency = 7000;
    applyOverrides(g_spec);
    if (!buildEngine(g_spec, loadIr, &g_be, &g_err)) return 0;
    ((PistonEngineSimulator *)g_be.simulator)->setFluidSimulationSteps(g_fluid);
    return g_be.engine->getCylinderCount();
}
API const char *es_error() { return g_err.c_str(); }

API void es_set_throttle(double t) { g_throttle = t < 0 ? 0 : t > 1 ? 1 : t; }
API void es_set_starter(int on) { if (g_be.simulator) g_be.simulator->m_starterMotor.m_enabled = on != 0; }
API void es_set_ignition(int on) { if (g_be.engine) g_be.engine->getIgnitionModule()->m_enabled = on != 0; }
API void es_set_gear(int g) { if (g_be.transmission) g_be.transmission->changeGear(g); }
API void es_set_clutch(double p) { if (g_be.transmission) g_be.transmission->setClutchPressure(p); }
API void es_set_dyno(int on, double rpm) {
    if (!g_be.simulator) return; g_be.simulator->m_dyno.m_enabled = on != 0; g_be.simulator->m_dyno.m_hold = on != 0;
    g_be.simulator->m_dyno.m_rotationSpeed = units::rpm(rpm);
}

// Advance the sim by one frame of `dt` seconds and buffer its audio.
API int es_step(double dt) {
    Simulator *sim = g_be.simulator; if (!sim) return 0;
    g_be.engine->setSpeedControl(g_throttle);
    sim->startFrame(dt);
    while (sim->simulateStep()) {}
    sim->endFrame();
    sim->synthesizer().renderAudioSync();
    short buf[2048]; int n, total = 0;
    if (g_pcmRead > 1 << 16) { g_pcm.erase(g_pcm.begin(), g_pcm.begin() + g_pcmRead); g_pcmRead = 0; }
    while ((n = sim->readAudioOutput(2048, buf)) > 0) { g_pcm.insert(g_pcm.end(), buf, buf + n); total += n; }
    return total;
}
API int es_available() { return (int)(g_pcm.size() - g_pcmRead); }
// Pop up to n samples as float into the out buffer; returns count.
API int es_pop(int n) {
    int a = es_available(); if (n > a) n = a; g_out.resize(n > 0 ? n : 1);
    for (int i = 0; i < n; ++i) g_out[i] = g_pcm[g_pcmRead + i] / 32768.0f;
    g_pcmRead += n; return n;
}
API float *es_out_ptr() { return g_out.data(); }

API double es_rpm() { return g_be.engine ? g_be.engine->getRpm() : 0; }
API double es_cycle_deg() { return g_be.engine ? g_be.engine->getCrankshaft(0)->getCycleAngle() / units::deg : 0; }
// Set crank speed directly (used to keep the engine spinning across a rebuild so it catches without a crank).
API void es_spin(double rpm) { if (g_be.engine) g_be.engine->getCrankshaft(0)->m_body.v_theta = -units::rpm(rpm); }
// Override starter speed/torque (rpm, lb-ft); pass 0 to restore the spec's values. A fast "kick" restarts after a rebuild.
API void es_starter_params(double rpm, double torque) {
    if (!g_be.simulator) return; auto &m = g_be.simulator->m_starterMotor;
    m.m_rotationSpeed = -units::rpm(rpm > 0 ? rpm : g_spec.starterRpm);
    m.m_maxTorque = units::torque(torque > 0 ? torque : g_spec.starterTorqueLbFt, units::ft_lb);
}
API int es_gear() { return g_be.transmission ? g_be.transmission->getGear() : -1; }
API double es_manifold_pressure() { return g_be.engine ? units::convert(g_be.engine->getManifoldPressure(), units::inHg) : 0; }
API double es_speed_mph() { return g_be.vehicle ? units::convert(g_be.vehicle->getSpeed(), units::mile / units::hour) : 0; }
API double es_torque_lbft() { return g_be.simulator ? units::convert(g_be.simulator->getFilteredDynoTorque(), units::ft_lb) : 0; }
API double es_displacement_l() { return g_be.engine ? g_be.engine->getDisplacement() / units::L : 0; }
API int es_cyl_count() { return g_be.engine ? g_be.engine->getCylinderCount() : 0; }
API double es_redline() { return g_spec.redlineRpm; }
API double es_fire_deg(int i) { return i < (int)g_spec.cyl.size() ? g_spec.cyl[i].fireDeg : 0; }
API int es_cyl_bank(int i) { return i < (int)g_spec.cyl.size() ? g_spec.cyl[i].bank : 0; }
