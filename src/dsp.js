/**
 * LCU DSP Engine
 *
 * Biquad filter frequency-response math (Robert Bristow-Johnson "Audio EQ
 * Cookbook"). Used to turn the decoded Section Q filter bands into a smooth
 * frequency-response (Bode) curve for the EQ view.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LCUDsp = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function biquadCoeffs(type, f0, gainDb, Q, fs) {
    const w0 = 2 * Math.PI * (f0 / fs);
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    const alpha = sin / (2 * Math.max(0.0001, Q));
    const A = Math.pow(10, (gainDb || 0) / 40);
    let b0, b1, b2, a0, a1, a2;

    switch (type) {
      case 'lowpass':
        b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
        a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
        break;
      case 'highpass':
        b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
        a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
        break;
      case 'peaking':
        b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
        break;
      case 'lowshelf': {
        const t = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) - (A - 1) * cos + t);
        b1 = 2 * A * ((A - 1) - (A + 1) * cos);
        b2 = A * ((A + 1) - (A - 1) * cos - t);
        a0 = (A + 1) + (A - 1) * cos + t;
        a1 = -2 * ((A - 1) + (A + 1) * cos);
        a2 = (A + 1) + (A - 1) * cos - t;
        break;
      }
      case 'highshelf': {
        const t = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) + (A - 1) * cos + t);
        b1 = -2 * A * ((A - 1) + (A + 1) * cos);
        b2 = A * ((A + 1) + (A - 1) * cos - t);
        a0 = (A + 1) - (A - 1) * cos + t;
        a1 = 2 * ((A - 1) - (A + 1) * cos);
        a2 = (A + 1) - (A - 1) * cos - t;
        break;
      }
      default:
        return { b0: 1, b1: 0, b2: 0, a0: 1, a1: 0, a2: 0 };
    }

    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a0: 1, a1: a1 / a0, a2: a2 / a0 };
  }

  function bandMagDb(type, f0, gainDb, Q, f, fs) {
    if ((type === 'peaking' || type === 'lowshelf' || type === 'highshelf') && Math.abs(gainDb) < 1e-6) {
      return 0;
    }
    const c = biquadCoeffs(type, f0, gainDb, Q, fs);
    const w = 2 * Math.PI * (f / fs);
    const cw = Math.cos(w), sw = Math.sin(w);
    const cw2 = Math.cos(2 * w), sw2 = Math.sin(2 * w);

    const numRe = c.b0 + c.b1 * cw + c.b2 * cw2;
    const numIm = -(c.b1 * sw + c.b2 * sw2);
    const denRe = 1 + c.a1 * cw + c.a2 * cw2;
    const denIm = -(c.a1 * sw + c.a2 * sw2);

    const mag = Math.sqrt((numRe * numRe + numIm * numIm) / (denRe * denRe + denIm * denIm));
    return 20 * Math.log10(Math.max(1e-9, mag));
  }

  function chainDb(bands, f, fs) {
    let db = 0;
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      if (!b.enabled) continue;
      const gain = (b.type === 'lowpass' || b.type === 'highpass') ? 0 : b.gain;
      db += bandMagDb(b.type, b.freq, gain, b.q, f, fs);
    }
    return db;
  }

  return {
    biquadCoeffs: biquadCoeffs,
    bandMagDb: bandMagDb,
    chainDb: chainDb
  };
}));
