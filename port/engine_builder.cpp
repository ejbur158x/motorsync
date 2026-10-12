// Port of es_script::*Node::generate() logic onto a plain EngineSpec. See engine_builder.h.
#include "engine_builder.h"

#include "../engine-sim/include/engine.h"
#include "../engine-sim/include/vehicle.h"
#include "../engine-sim/include/transmission.h"
#include "../engine-sim/include/simulator.h"
#include "../engine-sim/include/crankshaft.h"
#include "../engine-sim/include/cylinder_bank.h"
#include "../engine-sim/include/cylinder_head.h"
#include "../engine-sim/include/piston.h"
#include "../engine-sim/include/connecting_rod.h"
#include "../engine-sim/include/camshaft.h"
#include "../engine-sim/include/standard_valvetrain.h"
#include "../engine-sim/include/intake.h"
#include "../engine-sim/include/exhaust_system.h"
#include "../engine-sim/include/ignition_module.h"
#include "../engine-sim/include/fuel.h"
#include "../engine-sim/include/function.h"
#include "../engine-sim/include/impulse_response.h"
#include "../engine-sim/include/direct_throttle_linkage.h"
#include "../engine-sim/include/combustion_chamber.h"
#include "../engine-sim/include/gas_system.h"
#include "../engine-sim/include/units.h"
#include "../engine-sim/include/constants.h"

#include <cmath>

static double deg(double d) { return d * units::deg; }

// es/actions: harmonic_cam_lobe
static Function *harmonicCamLobe(double durationAt50ThouDeg, double gamma, double lift, int steps) {
    std::vector<std::pair<double, double>> samples;
    const double angle = deg(durationAt50ThouDeg) / 4;
    const double s = std::pow(2 * units::distance(50, units::thou) / lift, 1 / gamma) - 1;
    const double k = std::acos(s) / angle;
    const double extents = constants::pi / k;
    const double step = extents / (steps - 5.0);
    for (int i = 0; i < steps; ++i) {
        if (i == 0) samples.push_back({ 0.0, lift });
        else {
            const double x = i * step;
            const double l = (x >= extents) ? 0.0 : lift * std::pow(0.5 + 0.5 * std::cos(k * x), gamma);
            samples.push_back({ x, l }); samples.push_back({ -x, l });
        }
    }
    Function *f = new Function;
    f->initialize((int)samples.size(), step);
    for (auto &p : samples) f->addSample(p.first, p.second);
    return f;
}

static Function *makeFunction(double filterRadius, const std::vector<std::pair<double, double>> &pts) {
    Function *f = new Function;
    f->initialize((int)pts.size(), filterRadius);
    for (auto &p : pts) f->addSample(p.first, p.second);
    return f;
}

bool buildEngine(const EngineSpec &S, IrLoader irLoader, BuiltEngine *out, std::string *error) {
    const int nCyl = (int)S.cyl.size(), nBanks = (int)S.bankAngleDeg.size(), nEx = (int)S.exhaust.size();
    if (nCyl == 0 || nBanks == 0 || nEx == 0 || S.journalDeg.empty()) { if (error) *error = "spec needs cylinders, banks, journals and exhausts"; return false; }

    Engine *engine = new Engine;
    DirectThrottleLinkage *throttle = new DirectThrottleLinkage;
    { DirectThrottleLinkage::Parameters tp; tp.gamma = S.throttleGamma; throttle->initialize(tp); }

    Engine::Parameters ep;
    ep.name = S.name;
    ep.crankshaftCount = 1; ep.cylinderBanks = nBanks; ep.cylinderCount = nCyl; ep.exhaustSystemCount = nEx; ep.intakeCount = 1;
    ep.starterTorque = units::torque(S.starterTorqueLbFt, units::ft_lb);
    ep.starterSpeed = units::rpm(S.starterRpm);
    ep.redline = units::rpm(S.redlineRpm);
    ep.dynoMinSpeed = units::rpm(1000); ep.dynoMaxSpeed = ep.redline; ep.dynoHoldStep = units::rpm(100);
    ep.throttle = throttle;
    ep.initialSimulationFrequency = S.simFrequency; ep.initialHighFrequencyGain = S.hfGain;
    ep.initialNoise = S.noise; ep.initialJitter = S.jitter;
    engine->initialize(ep);

    // ---- intake (one shared plenum)
    {
        Intake::Parameters ip;
        ip.volume = S.plenumL * units::L;
        ip.CrossSectionArea = S.plenumAreaCm2 * units::cm2;
        ip.InputFlowK = GasSystem::k_carb(S.intakeFlowCarb);
        ip.IdleFlowK = GasSystem::k_carb(S.idleFlowCarb);
        ip.RunnerFlowRate = GasSystem::k_carb(S.runnerFlowCarb);
        ip.MolecularAfr = 25.0 / 2.0;
        ip.IdleThrottlePlatePosition = S.idleThrottlePlate;
        ip.RunnerLength = units::distance(S.runnerLenIn, units::inch);
        ip.VelocityDecay = S.intakeVelocityDecay;
        engine->getIntake(0)->initialize(ip);
    }
    // ---- exhausts + impulse responses
    for (int i = 0; i < nEx; ++i) {
        const ExhaustSpec &E = S.exhaust[i];
        ImpulseResponse *ir = new ImpulseResponse;
        ir->initialize(E.irFile, E.irVolume);
        ExhaustSystem::Parameters xp;
        xp.length = units::distance(E.lengthIn, units::inch);
        xp.collectorCrossSectionArea = constants::pi * std::pow(units::distance(E.collectorRadiusIn, units::inch), 2);
        xp.outletFlowRate = GasSystem::k_carb(E.outletFlowCarb);
        xp.primaryTubeLength = units::distance(E.primaryTubeIn, units::inch);
        xp.primaryFlowRate = GasSystem::k_carb(E.primaryFlowCarb);
        xp.velocityDecay = E.velocityDecay;
        xp.audioVolume = E.audioVolume;
        xp.impulseResponse = ir;
        engine->getExhaustSystem(i)->initialize(xp);
    }

    // ---- crankshaft
    const double stroke = units::distance(S.strokeMm, units::mm), rodLen = units::distance(S.rodMm, units::mm);
    {
        Crankshaft::Parameters cp;
        const double crankM = S.crankMassKg * units::kg, flyM = S.flywheelMassKg * units::kg;
        const double flyR = units::distance(S.flywheelRadiusIn, units::inch);
        cp.crankThrow = stroke / 2;
        cp.flywheelMass = flyM; cp.mass = crankM;
        cp.frictionTorque = units::torque(S.frictionLbFt, units::ft_lb);
        cp.momentOfInertia = S.crankMomentFactor * 0.5 * crankM * (stroke / 2) * (stroke / 2) + 0.5 * flyM * flyR * flyR
            + 0.5 * (S.otherMomentMassKg * units::kg) * std::pow(S.otherMomentRadiusCm * units::cm, 2);
        cp.pos_x = 0; cp.pos_y = 0; cp.tdc = deg(S.tdcDeg);
        cp.rodJournals = (int)S.journalDeg.size();
        Crankshaft *crank = engine->getCrankshaft(0);
        crank->initialize(cp);
        for (int j = 0; j < cp.rodJournals; ++j) crank->setRodJournalAngle(j, deg(S.journalDeg[j]));
    }
    Crankshaft *crank = engine->getCrankshaft(0);

    // ---- port flow + cam lobes + timing (shared across banks)
    std::vector<std::pair<double, double>> inF, exF;
    for (auto &f : S.intakeFlow) inF.push_back({ f.liftThou * units::thou, GasSystem::k_28inH2O(f.cfm * S.flowAttenuation) });
    for (auto &f : S.exhaustFlow) exF.push_back({ f.liftThou * units::thou, GasSystem::k_28inH2O(f.cfm * S.flowAttenuation) });
    Function *intakeFlow = makeFunction(units::distance(50, units::thou), inF);
    Function *exhaustFlow = makeFunction(units::distance(50, units::thou), exF);
    Function *inLobe = harmonicCamLobe(S.intakeDuration, S.lobeGamma, units::distance(S.intakeLiftMm, units::mm), 100);
    Function *exLobe = harmonicCamLobe(S.exhaustDuration, S.lobeGamma, units::distance(S.exhaustLiftMm, units::mm), 100);

    // ---- banks, pistons, rods, heads
    const double compH = units::distance(S.compHeightMm, units::mm);
    int globalIdx = 0;
    std::vector<int> globalOfSpec(nCyl, -1);
    for (int b = 0; b < nBanks; ++b) {
        std::vector<int> bankCyl;
        for (int c = 0; c < nCyl; ++c) if (S.cyl[c].bank == b) bankCyl.push_back(c);
        CylinderBank *bank = engine->getCylinderBank(b);
        CylinderBank::Parameters bp;
        bp.crankshaft = crank; bp.positionX = 0; bp.positionY = 0;
        bp.angle = deg(S.bankAngleDeg[b]);
        bp.bore = units::distance(S.boreMm, units::mm);
        bp.deckHeight = stroke / 2 + rodLen + compH;
        bp.displayDepth = 0.5;
        bp.cylinderCount = (int)bankCyl.size(); bp.index = b;
        bank->initialize(bp);

        for (int i = 0; i < (int)bankCyl.size(); ++i) {
            const CylSpec &C = S.cyl[bankCyl[i]];
            const int g = globalIdx + i; globalOfSpec[bankCyl[i]] = g;
            Piston *piston = engine->getPiston(g);
            ConnectingRod *rod = engine->getConnectingRod(g);
            Piston::Parameters pp;
            pp.Bank = bank; pp.CylinderIndex = i; pp.Rod = rod;
            pp.mass = S.pistonMassG * units::g;
            pp.BlowbyFlowCoefficient = GasSystem::k_28inH2O(C.blowby);
            pp.CompressionHeight = compH; pp.WristPinPosition = 0; pp.Displacement = 0;
            piston->initialize(pp);
            ConnectingRod::Parameters rp;
            rp.mass = S.rodMassG * units::g;
            rp.momentOfInertia = (1 / 12.0) * rp.mass * rodLen * rodLen;
            rp.centerOfMass = 0; rp.length = rodLen; rp.slaveThrow = 0;
            rp.crankshaft = crank; rp.journal = C.journal; rp.piston = piston; rp.rodJournals = 0; rp.master = nullptr;
            rod->initialize(rp);
        }

        // head + valvetrain for this bank: one lobe per cylinder, offset by its firing angle
        Camshaft *inCam = new Camshaft, *exCam = new Camshaft;
        Camshaft::Parameters camp;
        camp.advance = deg(S.camAdvanceDeg); camp.baseRadius = units::distance(S.camBaseRadiusMm, units::mm);
        camp.crankshaft = crank; camp.lobes = (int)bankCyl.size();
        camp.lobeProfile = inLobe; inCam->initialize(camp);
        camp.lobeProfile = exLobe; exCam->initialize(camp);
        for (int i = 0; i < (int)bankCyl.size(); ++i) {
            const double f = S.cyl[bankCyl[i]].fireDeg;
            exCam->setLobeCenterline(i, deg(360 - S.exhaustLobeCenter + f));
            inCam->setLobeCenterline(i, deg(360 + S.intakeLobeCenter + f));
        }
        StandardValvetrain *vt = new StandardValvetrain;
        StandardValvetrain::Parameters vtp; vtp.intakeCamshaft = inCam; vtp.exhaustCamshaft = exCam;
        vt->initialize(vtp);

        CylinderHead *head = engine->getHead(b);
        CylinderHead::Parameters hp;
        hp.Bank = bank; hp.Valvetrain = vt; hp.IntakePortFlow = intakeFlow; hp.ExhaustPortFlow = exhaustFlow;
        hp.CombustionChamberVolume = S.chamberCc * units::cc;
        hp.IntakeRunnerVolume = S.intakeRunnerCc * units::cc;
        hp.IntakeRunnerCrossSectionArea = std::pow(units::distance(S.intakeRunnerSideIn, units::inch), 2);
        hp.ExhaustRunnerVolume = S.exhaustRunnerCc * units::cc;
        hp.ExhaustRunnerCrossSectionArea = std::pow(units::distance(S.exhaustRunnerSideIn, units::inch), 2);
        hp.FlipDisplay = false;
        head->initialize(hp);
        for (int i = 0; i < (int)bankCyl.size(); ++i) {
            const CylSpec &C = S.cyl[bankCyl[i]];
            head->setIntake(i, engine->getIntake(0));
            head->setExhaustSystem(i, engine->getExhaustSystem(C.exhaust));
            head->setSoundAttenuation(i, C.soundAtt);
            head->setHeaderPrimaryLength(i, units::distance(C.primaryLenIn, units::inch));
        }
        globalIdx += (int)bankCyl.size();
    }

    // ---- ignition
    {
        std::vector<std::pair<double, double>> tc;
        for (auto &s : S.timing) tc.push_back({ units::rpm(s.x), deg(s.y) });
        IgnitionModule::Parameters ip;
        ip.crankshaft = crank; ip.cylinderCount = nCyl;
        ip.revLimit = units::rpm(S.revLimitRpm); ip.limiterDuration = S.limiterDuration;
        ip.timingCurve = makeFunction(units::rpm(1000), tc);
        engine->getIgnitionModule()->initialize(ip);
        for (int c = 0; c < nCyl; ++c) engine->getIgnitionModule()->setFiringOrder(globalOfSpec[c], deg(S.cyl[c].fireDeg));
    }

    // ---- fuel + combustion chambers
    Fuel *fuel = engine->getFuel();
    {
        std::vector<std::pair<double, double>> fs;
        if (S.flameSpeed.empty()) { fs.push_back({ 0, 3 }); for (int i = 1; i <= 9; ++i) fs.push_back({ 5.0 * i, 1.5 * 5.0 * i }); }
        else for (auto &s : S.flameSpeed) fs.push_back({ s.x, s.y });
        Fuel::Parameters fp;
        fp.maxBurningEfficiency = S.maxBurningEfficiency;
        fp.maxDilutionEffect = 10.0;
        fp.turbulenceToFlameSpeedRatio = makeFunction(5.0, fs);
        fuel->initialize(fp);
    }
    Function *mps = new Function; mps->initialize(30, 1);
    for (int i = 0; i < 30; ++i) mps->addSample((double)i, i * 0.5);
    CombustionChamber::Parameters cc;
    cc.CrankcasePressure = units::pressure(1.0, units::atm);
    cc.Fuel = fuel;
    cc.StartingPressure = units::pressure(1.0, units::atm);
    cc.StartingTemperature = units::celcius(25.0);
    cc.MeanPistonSpeedToTurbulence = mps;
    for (int i = 0; i < nCyl; ++i) {
        cc.Piston = engine->getPiston(i);
        cc.Head = engine->getHead(cc.Piston->getCylinderBank()->getIndex());
        engine->getChamber(i)->initialize(cc);
    }
    engine->calculateDisplacement();

    // ---- vehicle + transmission + simulator
    Vehicle *vehicle = new Vehicle;
    { Vehicle::Parameters vp; vp.mass = S.vehicleMassLb * units::lb; vp.dragCoefficient = S.dragCoef;
      vp.crossSectionArea = S.frontalAreaIn2 * units::inch * units::inch; vp.diffRatio = S.diffRatio;
      vp.tireRadius = units::distance(S.tireRadiusIn, units::inch); vp.rollingResistance = S.rollingResN; vehicle->initialize(vp); }
    out->gearStorage = S.gears;
    Transmission *tr = new Transmission;
    { Transmission::Parameters tp; tp.GearCount = (int)out->gearStorage.size(); tp.GearRatios = out->gearStorage.data();
      tp.MaxClutchTorque = units::torque(S.maxClutchTorqueLbFt, units::ft_lb); tr->initialize(tp); }

    Simulator *sim = engine->createSimulator(vehicle, tr);
    sim->setSimulationFrequency((int)S.simFrequency);
    Synthesizer::AudioParameters ap = sim->synthesizer().getAudioParameters();
    ap.inputSampleNoise = (float)S.jitter; ap.airNoise = (float)S.noise; ap.dF_F_mix = (float)S.hfGain;
    sim->synthesizer().setAudioParameters(ap);
    for (int i = 0; i < nEx; ++i) {
        std::vector<short> ir;
        if (!irLoader || !irLoader(S.exhaust[i].irFile, &ir) || ir.empty()) { if (error) *error = "impulse response not found: " + S.exhaust[i].irFile; return false; }
        sim->synthesizer().initializeImpulseResponse((const int16_t *)ir.data(), (unsigned)ir.size(), (float)S.exhaust[i].irVolume, i);
    }
    engine->getIgnitionModule()->m_enabled = true;
    out->engine = engine; out->vehicle = vehicle; out->transmission = tr; out->simulator = sim;
    return true;
}

// ---------------------------------------------------------------- presets (straight from his .mr files)
static std::vector<FlowSample> flow(std::initializer_list<FlowSample> l) { return std::vector<FlowSample>(l); }

EngineSpec preset2JZ() {
    EngineSpec s;
    s.name = "2JZ [I6]";
    s.bankAngleDeg = { 0 };
    s.journalDeg = { 0, 480, 240, 600, 120, 360 };
    const double fire[6] = { 0, 480, 240, 600, 120, 360 };          // 1-5-3-6-2-4
    const double prim[6] = { 2.5, 2.0, 1.5, 1.5, 2.0, 2.5 };       // spacing * {5,4,3,3,4,5} at 0.5 in
    const double att[6] = { 0.9, 0.95, 0.9, 0.97, 0.98, 0.93 };
    for (int i = 0; i < 6; ++i) { CylSpec c; c.bank = 0; c.journal = i; c.exhaust = i < 3 ? 0 : 1; c.fireDeg = fire[i];
        c.primaryLenIn = prim[i]; c.soundAtt = att[i]; c.blowby = (i % 2 == 0) ? 0.1 : 0.05; s.cyl.push_back(c); }
    s.exhaust = { ExhaustSpec(), ExhaustSpec() };
    s.intakeFlow = flow({ {0,0},{50,58},{100,103},{150,156},{200,214},{250,249},{300,268},{350,280},{400,280},{450,281} });
    s.exhaustFlow = flow({ {0,0},{50,37},{100,72},{150,113},{200,160},{250,196},{300,222},{350,235},{400,245},{450,246} });
    s.flowAttenuation = 0.9;
    s.timing = { {0,12},{1000,12},{2000,20},{3000,26},{4000,30},{5000,34},{6000,38},{7000,38} };
    s.revLimitRpm = 7500; s.redlineRpm = 6000; s.limiterDuration = 0.1;
    return s;
}

EngineSpec presetCrossPlaneV8() {
    // Faithful to his 07_gm_ls.mr (GM LS, firing 1-8-7-2-6-5-4-3), the cross-plane V8 he validated in the app.
    EngineSpec s;
    s.name = "GM LS [V8]";
    s.boreMm = 3.78 * 25.4; s.strokeMm = 3.622 * 25.4; s.rodMm = 160; s.compHeightMm = 1.0 * 25.4;
    s.pistonMassG = 100; s.rodMassG = 50;
    s.crankMassKg = 60 * 0.45359237; s.crankMomentFactor = 6;            // 1.5 * disk(crank_mass, radius: stroke)
    s.flywheelMassKg = 30 * 0.45359237; s.flywheelRadiusIn = 8;
    s.otherMomentMassKg = 1; s.otherMomentRadiusCm = 1;
    s.frictionLbFt = 20; s.tdcDeg = 90 - 45; s.throttleGamma = 2.0;
    s.bankAngleDeg = { -45, 45 };
    s.journalDeg = { 0, 270, 90, 180 };
    // bank 0: cyl 1,3,5,7 on journals 0..3; bank 1: cyl 2,4,6,8 on journals 0..3
    const int num[8] = { 1, 3, 5, 7, 2, 4, 6, 8 };
    const double fire[9] = { 0, 0, 3 * 90, 7 * 90, 6 * 90, 5 * 90, 4 * 90, 2 * 90, 1 * 90 }; // indexed by cylinder number
    const double cm = 1 / 2.54;
    const double prim[8] = { 6 + 2 * cm, 4 + 1 * cm, 2 + 3 * cm, 5 * cm, 6 + 1 * cm, 4 + 5 * cm, 2 + 7 * cm, 0 };
    for (int i = 0; i < 8; ++i) { CylSpec c; c.bank = i < 4 ? 0 : 1; c.journal = i % 4; c.exhaust = c.bank; c.fireDeg = fire[num[i]];
        c.primaryLenIn = prim[i]; c.soundAtt = 1.0; c.blowby = 0.0; s.cyl.push_back(c); }
    ExhaustSpec e; e.irFile = "smooth_39.wav"; e.irVolume = 0.001; e.audioVolume = 4.0; e.lengthIn = 100;
    e.primaryTubeIn = 29; e.outletFlowCarb = 1000; e.primaryFlowCarb = 500; e.velocityDecay = 1.0;
    ExhaustSpec e2 = e; e2.lengthIn = 172;
    s.exhaust = { e, e2 };
    s.chamberCc = 90; s.intakeRunnerCc = 149.6; s.intakeRunnerSideIn = 2.2; s.exhaustRunnerCc = 50; s.exhaustRunnerSideIn = 1.75;
    s.flowAttenuation = 1.0;
    s.intakeFlow = flow({ {0,0},{50,1},{100,103},{150,156},{200,214},{250,249},{300,268},{350,280},{400,280},{450,281} });
    s.exhaustFlow = flow({ {0,0},{50,1},{100,72},{150,113},{200,160},{250,196},{300,222},{350,235},{400,245},{450,246} });
    s.intakeDuration = 234; s.exhaustDuration = 235; s.intakeLiftMm = 0.551 * 25.4; s.exhaustLiftMm = 0.551 * 25.4; s.lobeGamma = 1.1;
    s.intakeLobeCenter = 116; s.exhaustLobeCenter = 116; s.camBaseRadiusMm = 25.4;
    s.plenumL = 1.325; s.plenumAreaCm2 = 20; s.intakeFlowCarb = 700; s.runnerFlowCarb = 100; s.runnerLenIn = 12;
    s.idleFlowCarb = 0; s.idleThrottlePlate = 0.996; s.intakeVelocityDecay = 0.5;
    s.timing = { {0,12},{1000,12},{2000,20},{3000,30},{4000,40},{5000,40},{6000,40},{7000,40},{8000,40} };
    s.revLimitRpm = 6800; s.limiterDuration = 0.2; s.redlineRpm = 6500;
    s.starterTorqueLbFt = 200; s.starterRpm = 200; s.jitter = 0.6; s.noise = 1.0; s.hfGain = 0.01;
    s.flameSpeed = { {0,3},{5,7.5},{10,17.5},{15,30},{20,40},{25,50},{30,60},{35,70},{40,80},{45,90} };
    s.vehicleMassLb = 1614 / 0.45359237; s.dragCoef = 0.3; s.frontalAreaIn2 = 72 * 50; s.diffRatio = 3.42; s.tireRadiusIn = 10; s.rollingResN = 200;
    s.gears = { 2.97, 2.07, 1.43, 1.00, 0.71, 0.57 };
    return s;
}
