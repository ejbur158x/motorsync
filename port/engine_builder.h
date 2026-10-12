// Data-driven engine builder for the engine-sim core (replaces the Piranha .mr script layer).
// Mirrors es_script::EngineNode::buildEngine and the part nodes, but takes a plain EngineSpec
// so a UI can build engines from simple settings. Units in the spec are the friendly ones
// noted per field; everything is converted to engine-sim's SI internals here.
#ifndef ESWEB_ENGINE_BUILDER_H
#define ESWEB_ENGINE_BUILDER_H

#include <string>
#include <vector>

class Engine; class Vehicle; class Transmission; class Simulator;

struct FlowSample { double liftThou, cfm; };
struct CurveSample { double x, y; };

struct CylSpec {
    int bank = 0;            // which cylinder bank
    int journal = 0;         // which crank rod journal (V engines share journals between banks)
    int exhaust = 0;         // which exhaust system this cylinder feeds
    double fireDeg = 0;      // firing angle in the 720-degree cycle
    double primaryLenIn = 2; // header primary length to the collector (inches)
    double soundAtt = 1.0;   // how loud this cylinder is at the listener
    double blowby = 0.1;     // k_28inH2O blowby flow
};

struct ExhaustSpec {
    double lengthIn = 100, primaryTubeIn = 40, collectorRadiusIn = 2.0;
    double outletFlowCarb = 1000, primaryFlowCarb = 400;
    double audioVolume = 0.2, velocityDecay = 1.0;
    std::string irFile = "mild_exhaust_reverb.wav";
    double irVolume = 0.01;
};

struct EngineSpec {
    std::string name = "Engine";
    // geometry (mm / g / kg)
    double boreMm = 86, strokeMm = 86, rodMm = 142, compHeightMm = 32.8;
    double pistonMassG = 250, rodMassG = 500, crankMassKg = 15, flywheelMassKg = 10, flywheelRadiusIn = 7;
    double otherMomentMassKg = 20, otherMomentRadiusCm = 8;
    double frictionLbFt = 5, tdcDeg = 90;
    double crankMomentFactor = 1; // crank inertia = factor * disk(crankMass, stroke/2); the LS script uses 1.5*disk(mass, stroke) = 6
    double throttleGamma = 1.0;
    std::vector<double> bankAngleDeg = { 0 };
    std::vector<double> journalDeg;
    std::vector<CylSpec> cyl;
    std::vector<ExhaustSpec> exhaust;
    // head
    double chamberCc = 50, intakeRunnerCc = 150, intakeRunnerSideIn = 1.9, exhaustRunnerCc = 50, exhaustRunnerSideIn = 1.25;
    double flowAttenuation = 1.0;
    std::vector<FlowSample> intakeFlow, exhaustFlow;
    // cams (degrees at 50 thou / mm / degrees)
    double intakeDuration = 220, exhaustDuration = 220, intakeLiftMm = 9.78, exhaustLiftMm = 9.6, lobeGamma = 1.1;
    double intakeLobeCenter = 116, exhaustLobeCenter = 116, camBaseRadiusMm = 17, camAdvanceDeg = 0;
    // intake
    double plenumL = 1.0, plenumAreaCm2 = 10, intakeFlowCarb = 500, runnerFlowCarb = 200, runnerLenIn = 40;
    double idleFlowCarb = 0, idleThrottlePlate = 0.9965, intakeVelocityDecay = 0.25;
    // ignition (rpm, deg)
    std::vector<CurveSample> timing;
    double revLimitRpm = 6500, limiterDuration = 0.1;
    // engine + audio
    double starterTorqueLbFt = 200, starterRpm = 200, redlineRpm = 6000;
    double simFrequency = 10000, hfGain = 0.01, noise = 1.0, jitter = 0.23;
    double maxBurningEfficiency = 1.0;
    std::vector<CurveSample> flameSpeed; // turbulence -> flame speed ratio (default if empty)
    // vehicle + gearbox
    double vehicleMassLb = 3400, dragCoef = 0.4, frontalAreaIn2 = 66 * 50, diffRatio = 3.15, tireRadiusIn = 10, rollingResN = 500;
    std::vector<double> gears = { 5.25, 3.36, 2.17, 1.72, 1.32, 1.0 };
    double maxClutchTorqueLbFt = 500;
};

struct BuiltEngine {
    Engine *engine = nullptr; Vehicle *vehicle = nullptr; Transmission *transmission = nullptr; Simulator *simulator = nullptr;
    std::vector<double> gearStorage;
};

// irLoader(name, &samples) must return 16-bit mono samples for an impulse-response file name.
typedef bool (*IrLoader)(const std::string &name, std::vector<short> *out);
bool buildEngine(const EngineSpec &spec, IrLoader irLoader, BuiltEngine *out, std::string *error);

EngineSpec preset2JZ();
EngineSpec presetCrossPlaneV8();

#endif
