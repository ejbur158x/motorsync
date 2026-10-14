// MOTORSYNC engine builder: turns a few simple choices (layout, cylinders, size, aspiration,
// street<->race) into a full engine-sim spec. Pure functions; used by the page and by node tests.
//
// Geometry rule (checked against Ange's 2JZ and GM LS scripts): with the crank's tdc set to
// 90 + (first bank angle), a cylinder on journal angle J in a bank at angle B reaches TDC at
//   fire ≡ J − (B − B0)  (mod 360)
// and the 720° firing slot picks which of the two TDCs is the power stroke.
(function (root) {
  const LAYOUTS = {
    I: { name: 'Inline', banks: 1, min: 1, max: 12, step: 1 },
    V: { name: 'V', banks: 2, min: 2, max: 16, step: 2 },
    VR: { name: 'VR', banks: 2, min: 4, max: 8, step: 1 },
    F: { name: 'Flat', banks: 2, min: 2, max: 12, step: 2 },
  };
  // standard inline firing orders (1-based cylinder numbers); others come from a stepped spread
  const INLINE_ORDERS = {
    1: [1], 2: [1, 2], 3: [1, 3, 2], 4: [1, 3, 4, 2], 5: [1, 2, 4, 5, 3], 6: [1, 5, 3, 6, 2, 4],
    7: [1, 3, 5, 7, 2, 4, 6], 8: [1, 6, 2, 5, 8, 3, 7, 4], 10: [1, 6, 5, 10, 2, 7, 3, 8, 4, 9], 12: [1, 7, 5, 11, 3, 9, 6, 12, 2, 8, 4, 10],
  };
  function inlineOrder(n) {
    if (INLINE_ORDERS[n]) return INLINE_ORDERS[n].map((c) => c - 1);
    let step = Math.max(1, Math.round(n / 2) + (n % 2 ? 0 : 1)); while (gcd(step, n) !== 1) step++;
    return Array.from({ length: n }, (_, k) => (k * step) % n);
  }
  function gcd(a, b) { return b ? gcd(b, a % b) : a; }
  const mod = (a, m) => ((a % m) + m) % m;

  function defaultVAngle(layout, n) {
    if (layout === 'VR') return 15;
    if (layout === 'F') return 180;
    if (layout !== 'V') return 0;
    return { 2: 90, 4: 90, 6: 60, 8: 90, 10: 72, 12: 60, 14: 51.4, 16: 45 }[n] || 90;
  }
  function crankOptions(layout, n) {
    if (LAYOUTS[layout].banks === 1 || n % 2) return ['even'];
    return n === 8 ? ['cross', 'flat', 'even'] : ['even', 'flat'];
  }

  // Geometry: banks, journals, per-cylinder bank/journal/fire angle, numbering for the diagram.
  function geometry(layout, n, vAngle, crank) {
    const L = LAYOUTS[layout];
    const banks = L.banks === 1 ? [0] : [-vAngle / 2, vAngle / 2];
    const B0 = banks[0];
    const nA = L.banks === 1 ? n : Math.ceil(n / 2), nB = n - nA;
    const cyl = [];
    for (let i = 0; i < n; i++) cyl.push({ bank: i < nA ? 0 : 1, pos: i < nA ? i : i - nA });
    // cylinder numbers: bank A gets odd numbers, bank B even (GM style); inline is 1..n
    cyl.forEach((c, i) => (c.num = L.banks === 1 ? i + 1 : (c.bank === 0 ? 2 * c.pos + 1 : 2 * c.pos + 2)));
    const shared = (crank === 'cross' || crank === 'flat') && L.banks === 2 && nA === nB;
    let journals = [];
    if (!shared) {
      // own crank pin per cylinder: even firing. Interleave the banks, each spread like an inline engine.
      const oA = inlineOrder(nA), oB = nB ? inlineOrder(nB) : [];
      const seq = [];
      for (let k = 0; k < Math.max(nA, nB); k++) { if (k < nA) seq.push(oA[k]); if (k < nB) seq.push(nA + oB[k]); }
      seq.forEach((ci, slot) => {
        const c = cyl[ci]; c.fire = (720 * slot) / n;
        c.jour = journals.length; journals.push(mod(c.fire + (banks[c.bank] - B0), 360));
      });
    } else {
      const nJ = nA;
      journals = crank === 'cross' && nJ === 4 ? [0, 90, 270, 180] : (() => {
        // flat-plane: the journals of an inline-nJ crank
        const ord = inlineOrder(nJ), js = new Array(nJ);
        ord.forEach((c, slot) => (js[c] = mod((720 * slot) / nJ, 360)));
        return js;
      })();
      cyl.forEach((c) => { c.jour = c.pos; c.tdc = mod(journals[c.jour] - (banks[c.bank] - B0), 360); });
      // pick power-stroke TDC (x or x+360) per cylinder for the most even firing
      let best = null, bestScore = Infinity;
      for (let m = 0; m < 1 << (n - 1); m++) {
        const f = cyl.map((c, i) => (i === 0 ? c.tdc : c.tdc + ((m >> (i - 1)) & 1) * 360));
        const s = f.slice().sort((a, b) => a - b);
        let mx = 0, sq = 0;
        for (let i = 0; i < n; i++) { const g = i < n - 1 ? s[i + 1] - s[i] : 720 - s[n - 1] + s[0]; mx = Math.max(mx, g); sq += g * g; }
        // tie-break: the most even pattern within each bank (a real cross-plane fires each bank 90-180-270-180)
        let bankMx = 0;
        for (let b = 0; b < 2; b++) {
          const fb = f.filter((_, i) => cyl[i].bank === b).map((v) => v % 720).sort((a, c) => a - c);
          for (let i = 0; i < fb.length; i++) bankMx += Math.pow(i < fb.length - 1 ? fb[i + 1] - fb[i] : 720 - fb[fb.length - 1] + fb[0], 2);
        }
        const score = mx * 1e8 + sq * 1e2 + bankMx * 1e-2;
        if (score < bestScore) { bestScore = score; best = f; }
      }
      cyl.forEach((c, i) => (c.fire = best[i]));
    }
    const order = cyl.slice().sort((a, b) => mod(a.fire, 720) - mod(b.fire, 720)).map((c) => c.num);
    return { banks, B0, journals, cyl, order, tdcDeg: 90 + B0 };
  }

  // Simple choices -> everything else. character: 0 = street (smooth, torquey) .. 1 = race (cams, revs, light flywheel)
  function buildSpec(cfg) {
    const layout = LAYOUTS[cfg.layout] ? cfg.layout : 'I';
    const L = LAYOUTS[layout];
    let n = Math.round(cfg.cyl || 6); n = Math.max(L.min, Math.min(L.max, n)); if (L.step === 2 && n % 2) n++;
    const D = Math.max(0.1, cfg.liters || 3.0), ch = Math.max(0, Math.min(1, cfg.character ?? 0.3));
    const asp = cfg.aspiration || 'na';
    const boosted = asp !== 'na';
    const vAngle = cfg.vAngle ?? defaultVAngle(layout, n);
    const crank = crankOptions(layout, n).includes(cfg.crank) ? cfg.crank : crankOptions(layout, n)[0];
    const g = geometry(layout, n, vAngle, crank);

    const Vc = (D * 1e6) / n;                                  // mm^3 per cylinder
    const ratio = cfg.boreStroke ?? (0.95 + 0.3 * ch);         // bore/stroke
    const bore = cfg.boreMm ?? Math.cbrt((4 * Vc * ratio) / Math.PI);
    const stroke = cfg.strokeMm ?? (4 * Vc) / (Math.PI * bore * bore);
    const Vcc = (Math.PI / 4) * bore * bore * stroke / 1000;  // actual cc per cylinder
    const Dl = Vcc * n / 1000;
    const k = Dl / 3;                                          // size relative to the 2JZ template
    const cr = cfg.compression ?? (boosted ? 9.0 : 10.2 + ch);
    const mpsLimit = 20 + 5 * ch;                              // mean piston speed at the limiter, m/s
    const rev = cfg.revLimitRpm ?? Math.round(Math.max(4500, Math.min(11000, (mpsLimit * 60) / (2 * stroke / 1000))) / 100) * 100;

    const p = {
      nCyl: n, nBanks: g.banks.length, nJour: g.journals.length,
      tdcDeg: g.tdcDeg, boreMm: bore, strokeMm: stroke, rodMm: 1.65 * stroke, compHeightMm: 0.38 * bore,
      pistonMassG: 250 * Math.pow(bore / 86, 3), rodMassG: 500 * Math.pow(bore / 86, 2) * (stroke / 86),
      crankMassKg: 15 * (n / 6) * (stroke / 86), flywheelMassKg: cfg.flywheelMassKg ?? Math.max(2, 10 * (1 - 0.55 * ch) * Math.sqrt(k)),
      otherMomentMassKg: 20 * Math.sqrt(k),
      chamberCc: Vcc / (cr - 1),
      intakeDuration: cfg.duration ?? 214 + 50 * ch, exhaustDuration: cfg.duration ?? 214 + 50 * ch,
      intakeLiftMm: cfg.liftMm ?? 9.8 * (bore / 86) * (0.95 + 0.25 * ch), exhaustLiftMm: cfg.liftMm ?? 9.6 * (bore / 86) * (0.95 + 0.25 * ch),
      intakeLobeCenter: cfg.lsa ?? 117 - 9 * ch, exhaustLobeCenter: cfg.lsa ?? 117 - 9 * ch,
      flowScale: Math.pow(bore / 86, 2) * (0.72 + 0.45 * ch),
      intakeRunnerCc: 150 * Vcc / 500, exhaustRunnerCc: 50 * Vcc / 500,
      intakeFlowCarb: 500 * k * (0.7 + 0.6 * ch) * (boosted ? 1.3 : 1), plenumL: Math.max(0.3, 1.0 * k), runnerFlowCarb: 200 * Math.max(0.4, k),
      revLimitRpm: rev, redlineRpm: rev - 400, limiterDuration: 0.08,
      frictionLbFt: Math.max(1, 5 * k), starterTorqueLbFt: 200 * Math.max(1, k), starterRpm: 200,
      idleThrottlePlate: cfg.idleThrottlePlate ?? idlePlate(500 * k * (0.7 + 0.6 * ch) * (boosted ? 1.3 : 1), k * (0.85 + 1.2 * ch * ch)), timingScale: boosted ? 0.85 : 1,
      nEx: layout === 'I' ? (n >= 5 ? 2 : 1) : 2,
      exLengthIn: cfg.exLengthIn ?? 100, exAudioVolume: cfg.exAudioVolume ?? 0.25, exIr: cfg.exIr ?? 0,
      jitter: 0.3 + 0.3 * ch,
    };
    g.banks.forEach((b, i) => (p['bank.' + i] = b));
    g.journals.forEach((j, i) => (p['jour.' + i] = j));
    const unequal = cfg.headers === 'unequal';
    g.cyl.forEach((c, i) => {
      const pre = 'cyl.' + i + '.';
      p[pre + 'bank'] = c.bank; p[pre + 'jour'] = c.jour; p[pre + 'fire'] = c.fire;
      p[pre + 'ex'] = layout === 'I' ? (n >= 5 && i >= Math.ceil(n / 2) ? 1 : 0) : c.bank;
      p[pre + 'prim'] = unequal ? 1 + ((c.pos * 3.7 + c.bank * 2.3) % 7) : 2 + 0.5 * (c.pos % 2);
      p[pre + 'att'] = i === 0 ? 1 : 0.92 + 0.06 * ((i * 7) % 3) / 2;
    });
    if (p.nEx === 2) p['ex.1.len'] = cfg.pipeSplit ?? 1.0;

    return {
      preset: 2, params: p, name: cfg.name || describe({ layout, n, Dl, asp }),
      cylNums: g.cyl.map((c) => c.num), order: g.order, layout, n, liters: Dl, crank, vAngle,
      fi: fiFor(asp, cfg, Dl, rev),
    };
  }
  // Throttle plate position that leaks the same idle air per liter as the 2JZ (plate 0.9965 on a 500 cfm body),
  // so idle stays near 900 rpm whatever the throttle body size. 'need' scales the leak (bigger cams want more).
  function idlePlate(flowCarb, need) {
    const leak = Math.cos(0.9965 * Math.PI / 2) * 500 * need;
    return (2 / Math.PI) * Math.acos(Math.min(1, leak / flowCarb));
  }
  function describe({ layout, n, Dl, asp }) {
    const a = { na: '', turbo: ' Turbo', sc: ' Supercharged', twin: ' Twin-charged' }[asp];
    return `${Dl.toFixed(1)}L ${layout === 'F' ? 'Flat-' : layout}${n}${a}`;
  }

  // Forced-induction settings for the sound + boost model (web/forced.js)
  function fiFor(asp, cfg, Dl, rev) {
    const turboSize = cfg.turboSize ?? 1;             // 0 small (snappy) .. 2 big (laggy, top end)
    const psi = cfg.boostPsi ?? (asp === 'twin' ? 20 : asp === 'sc' ? 10 : 15);
    return {
      type: asp,
      turboPsi: asp === 'turbo' || asp === 'twin' ? psi : 0,
      scPsi: asp === 'sc' ? psi : asp === 'twin' ? psi * 0.6 : 0,
      spoolStart: cfg.spoolStart ?? Math.round(rev * (0.2 + 0.1 * turboSize)),
      spoolFull: cfg.spoolFull ?? Math.round(rev * (0.45 + 0.13 * turboSize)),
      spoolTime: cfg.spoolTime ?? 0.8 + 0.5 * turboSize,
      bov: cfg.bov ?? 0, scType: cfg.scType ?? 'screw', handover: cfg.handover ?? Math.round(rev * 0.45),
      turboLevel: cfg.turboLevel ?? 1.6, scLevel: cfg.scLevel ?? 0.85, scEee: cfg.scEee ?? 2, scChop: cfg.scChop ?? 0.75,
      scOff: cfg.scOff ?? 0.07, scHalf: cfg.scHalf ?? 0.5, scPitch: cfg.scPitch ?? 1,
    };
  }

  // Standard mode: the same build, for our procedural synth (std/generic-core.js) and the simple car model.
  function stdSynth(sp, cfg) {
    const p = sp.params, n = sp.n, ch = Math.max(0, Math.min(1, cfg.character ?? 0.3));
    const fire = [], pipe = [];
    for (let i = 0; i < n; i++) { fire.push(p['cyl.' + i + '.fire']); pipe.push(p['cyl.' + i + '.ex']); }
    const lsa = cfg.lsa ?? 117 - 9 * ch, dur = cfg.duration ?? 214 + 50 * ch;
    const lumpy = Math.max(0, Math.min(1.5, (117 - lsa) / 9 * 0.6 + (dur - 214) / 50 * 0.4));
    return {
      n, fire, pipe, nPipes: p.nEx, liters: sp.liters, layout: sp.layout, crank: sp.crank,
      idleRpm: 850 - 50 * Math.min(1, Math.max(0, (sp.liters - 3) / 3)) + 150 * lumpy, redline: p.revLimitRpm,
      character: ch, thump: cfg.thump ?? 0.3 + 0.6 * lumpy, unequal: cfg.headers === 'unequal',
      exLen: Math.max(0.5, Math.min(2, (cfg.exLengthIn ?? 100) / 100)), fi: sp.fi,
      // car model: peak torque per liter (N·m), where it peaks, how fast it revs
      tqPerL: 95 + 15 * ch - 8 * Math.max(0, (cfg.compression ?? 10) < 9 ? 1 : 0), peakAt: 0.5 + 0.3 * ch,
      revUp: Math.max(0.5, Math.min(2.2, Math.sqrt(10 / p.flywheelMassKg) * Math.pow(3 / sp.liters, 0.25))),
    };
  }

  const api = { LAYOUTS, crankOptions, defaultVAngle, geometry, buildSpec, fiFor, inlineOrder, stdSynth };
  if (typeof module !== 'undefined') module.exports = api; else root.MSBuilder = api;
})(typeof self !== 'undefined' ? self : this);
