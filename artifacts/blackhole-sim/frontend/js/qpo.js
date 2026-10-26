/**
 * qpo.js — Real-time QPO (Quasi-Periodic Oscillation) spectrum panel.
 *
 * Samples total hot-spot brightness at 30 Hz, stores a 1024-point circular buffer,
 * computes FFT via Cooley-Tukey, and renders a time-domain waveform + power
 * spectral density plot onto a 2D canvas.
 */

'use strict';

const QPO = (() => {
  const SAMPLE_RATE = 30;   // Hz — sampling frequency
  const N           = 1024; // must be power of 2

  const buffer  = new Float32Array(N);
  let writePos  = 0;
  let collected = 0;        // samples collected so far (caps at N for "ready" check)

  let canvas = null;
  let ctx    = null;
  let visible = false;
  let lastSampleMs = 0;

  // ── Cooley-Tukey in-place FFT ──────────────────────────────────────────────
  function fft(re, im) {
    const n = re.length;
    // Bit-reversal permutation
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    // Butterfly
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wRe = Math.cos(ang);
      const wIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cRe = 1, cIm = 0;
        for (let j = 0; j < (len >> 1); j++) {
          const uRe = re[i + j],               uIm = im[i + j];
          const vRe = re[i + j + (len >> 1)] * cRe - im[i + j + (len >> 1)] * cIm;
          const vIm = re[i + j + (len >> 1)] * cIm + im[i + j + (len >> 1)] * cRe;
          re[i + j]             = uRe + vRe;  im[i + j]             = uIm + vIm;
          re[i + j + (len>>1)]  = uRe - vRe;  im[i + j + (len>>1)]  = uIm - vIm;
          const nCRe = cRe * wRe - cIm * wIm;
          cIm = cRe * wIm + cIm * wRe;
          cRe = nCRe;
        }
      }
    }
  }

  // Returns magnitude spectrum (N/2 bins) with Hann window applied
  function computeSpectrum() {
    const re = new Float32Array(N);
    const im = new Float32Array(N);

    // Compute mean for DC removal
    let mean = 0;
    for (let i = 0; i < N; i++) mean += buffer[(writePos + i) & (N - 1)];
    mean /= N;

    for (let i = 0; i < N; i++) {
      const s    = buffer[(writePos + i) & (N - 1)] - mean;
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
      re[i] = s * hann;
      im[i] = 0;
    }
    fft(re, im);

    const mag = new Float32Array(N >> 1);
    for (let i = 0; i < (N >> 1); i++) {
      mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]) / N;
    }
    return mag;
  }

  // ── Peak detection ─────────────────────────────────────────────────────────
  function detectPeaks(mag, maxBin, peakMag) {
    const threshold = peakMag * 0.12;
    const peaks = [];
    for (let i = 3; i < maxBin - 3; i++) {
      if (mag[i] < threshold) continue;
      if (mag[i] >= mag[i-1] && mag[i] >= mag[i+1] &&
          mag[i] >= mag[i-2] && mag[i] >= mag[i+2]) {
        peaks.push(i);
      }
    }
    peaks.sort((a, b) => mag[b] - mag[a]);
    return peaks;
  }

  // ── Drawing ────────────────────────────────────────────────────────────────
  function draw() {
    if (!ctx || !visible) return;

    const W = canvas.width;
    const H = canvas.height;

    ctx.fillStyle = 'rgba(2, 5, 15, 0.95)';
    ctx.fillRect(0, 0, W, H);

    const PAD   = 4;
    const LABEL = 16;
    const topH  = Math.floor(H * 0.36);
    const botY  = topH + LABEL + 4;
    const botH  = H - botY - PAD;

    // ── Section labels ──────────────────────────────────────────────────────
    ctx.font = 'bold 9px monospace';
    ctx.fillStyle = 'rgba(120, 180, 255, 0.85)';
    ctx.fillText('HOT SPOT BRIGHTNESS  (arb. units)', PAD + 2, 11);
    ctx.fillText('POWER SPECTRAL DENSITY  (QPO)', PAD + 2, topH + LABEL - 2);

    // ── Background fills ────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(30, 60, 120, 0.10)';
    ctx.fillRect(PAD, LABEL, W - 2*PAD, topH - LABEL);
    ctx.fillStyle = 'rgba(30, 60, 120, 0.10)';
    ctx.fillRect(PAD, botY, W - 2*PAD, botH);

    // ── Time-domain waveform ────────────────────────────────────────────────
    const tW = W - 2*PAD;
    const tH = topH - LABEL - 4;
    const tY = LABEL;

    let minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < N; i++) {
      const v = buffer[(writePos + i) & (N - 1)];
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const range = (maxV - minV) || 1;

    // Grid
    ctx.strokeStyle = 'rgba(60, 100, 200, 0.18)';
    ctx.lineWidth = 0.5;
    for (let g = 0; g <= 4; g++) {
      const y = tY + 2 + tH - (g / 4) * tH;
      ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
    }

    // Waveform
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 140, 40, 0.95)';
    ctx.lineWidth = 1.4;
    for (let i = 0; i < N; i++) {
      const x = PAD + (i / N) * tW;
      const v = buffer[(writePos + i) & (N - 1)];
      const y = tY + 2 + tH - ((v - minV) / range) * tH;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Time axis: "0" at left, "−N/SAMPLE_RATE s" at right
    ctx.font = '7px monospace';
    ctx.fillStyle = 'rgba(80, 120, 200, 0.6)';
    ctx.fillText(`−${(N / SAMPLE_RATE).toFixed(0)} s`, PAD + 2, tY + tH + 12);
    ctx.fillText('0', W - PAD - 10, tY + tH + 12);

    // ── Spectrum ────────────────────────────────────────────────────────────
    if (collected < N) {
      // Not enough data yet — show progress
      const pct = (collected / N * 100).toFixed(0);
      ctx.fillStyle = 'rgba(100, 150, 255, 0.6)';
      ctx.font = '10px monospace';
      ctx.fillText(`Collecting samples… ${pct}%`, PAD + 10, botY + botH / 2);
      return;
    }

    const mag = computeSpectrum();

    // Display range 0–12 Hz (Nyquist is 15 Hz at SAMPLE_RATE=30)
    const MAX_FREQ = 12;
    const maxBin   = Math.min(Math.floor(MAX_FREQ * N / SAMPLE_RATE), N >> 1);

    let peakMag = 1e-12;
    for (let i = 1; i < maxBin; i++) if (mag[i] > peakMag) peakMag = mag[i];

    const sW = W - 2 * PAD;

    // Freq grid lines & labels
    ctx.lineWidth = 0.5;
    ctx.font = '7px monospace';
    for (let f = 1; f <= MAX_FREQ; f++) {
      const x = PAD + (f / MAX_FREQ) * sW;
      ctx.strokeStyle = 'rgba(60, 100, 200, 0.2)';
      ctx.beginPath(); ctx.moveTo(x, botY); ctx.lineTo(x, botY + botH); ctx.stroke();
      ctx.fillStyle = 'rgba(80, 120, 200, 0.65)';
      ctx.fillText(`${f}`, x - 3, botY + botH + 10);
    }
    ctx.fillStyle = 'rgba(80, 120, 200, 0.6)';
    ctx.fillText('Hz', W - PAD - 14, botY + botH + 10);

    // PSD bars (log-color scale)
    for (let i = 1; i < maxBin; i++) {
      const x  = PAD + ((i - 1) / maxBin) * sW;
      const bW = sW / maxBin;
      const ht = (mag[i] / peakMag) * botH * 0.92;
      const t  = mag[i] / peakMag;

      // Colour ramp: deep indigo → cyan-green → yellow → white
      let r, g, b;
      if (t < 0.25) {
        r = Math.floor(t / 0.25 * 40);      g = Math.floor(t / 0.25 * 80);  b = 180;
      } else if (t < 0.55) {
        const s = (t - 0.25) / 0.30;
        r = Math.floor(40 + s * 80);        g = Math.floor(80 + s * 150);   b = Math.floor(180 - s * 120);
      } else if (t < 0.80) {
        const s = (t - 0.55) / 0.25;
        r = Math.floor(120 + s * 135);      g = Math.floor(230 + s * 25);   b = Math.floor(60 - s * 50);
      } else {
        const s = (t - 0.80) / 0.20;
        r = 255;                             g = 255;                         b = Math.floor(10 + s * 245);
      }
      ctx.fillStyle = `rgba(${r},${g},${b},0.88)`;
      ctx.fillRect(x, botY + botH - ht, Math.max(1.2, bW - 0.4), ht);
    }

    // QPO peak markers (top 4 peaks)
    const peaks = detectPeaks(mag, maxBin, peakMag);
    peaks.slice(0, 4).forEach((bin, idx) => {
      const freq = (bin * SAMPLE_RATE / N).toFixed(2);
      const x    = PAD + (bin / maxBin) * sW;
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 80, 0.9)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, botY); ctx.lineTo(x, botY + botH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255, 255, 80, 0.95)';
      ctx.font = `bold 8px monospace`;
      const label = `▲${freq}Hz`;
      const lx    = Math.min(x - 2, W - PAD - label.length * 5.5 - 2);
      ctx.fillText(label, lx, botY + 10 + idx * 11);
      ctx.restore();
    });

    // Power axis label
    ctx.fillStyle = 'rgba(80, 120, 200, 0.55)';
    ctx.font = '7px monospace';
    ctx.fillText('PSD', PAD, botY + 10);
  }

  // ── Sampling tick ──────────────────────────────────────────────────────────
  function tick(now) {
    if (visible && now - lastSampleMs >= 1000 / SAMPLE_RATE) {
      lastSampleMs = now;
      const brightness = (typeof Scene !== 'undefined' && Scene.getBrightnessSample)
        ? Scene.getBrightnessSample()
        : 0;
      buffer[writePos & (N - 1)] = brightness;
      writePos = (writePos + 1) & (N - 1);
      if (collected < N) collected++;
    }
    draw();
    requestAnimationFrame(tick);
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  function init() {
    canvas = document.getElementById('qpo-canvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');

    function resize() {
      if (!canvas) return;
      const rect = canvas.parentElement.getBoundingClientRect();
      canvas.width  = Math.max(rect.width  || 280, 200);
      canvas.height = Math.max(rect.height || 200, 160);
    }
    resize();
    window.addEventListener('resize', resize);

    requestAnimationFrame(tick);
  }

  function setVisible(v) {
    visible = v;
    const panel = document.getElementById('qpo-panel');
    if (panel) panel.style.display = v ? 'flex' : 'none';
  }

  return { init, setVisible };
})();
