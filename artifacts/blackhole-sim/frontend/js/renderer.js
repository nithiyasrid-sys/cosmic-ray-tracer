/**
 * renderer.js — Application bootstrap and HUD update logic.
 *
 * Initializes all modules, connects WebSocket, starts the Three.js
 * render loop, and manages the HUD readout.
 */

'use strict';

// ── HUD Module ────────────────────────────────────────────────────────────────
const HUD = (() => {
  const $ = id => document.getElementById(id);

  let _system = {};

  function updateSystem(sys) {
    _system = sys;

    const rsEl = $('hud-rs');
    if (rsEl && sys.rs !== undefined) rsEl.textContent = `${sys.rs.toFixed(2)} RS`;

    const rsSpecs = $('hud-rs-specs');
    if (rsSpecs && sys.rs !== undefined) rsSpecs.textContent = `${sys.rs.toFixed(3)} M`;

    const rphEl = $('hud-rph');
    if (rphEl && sys.r_photon !== undefined) rphEl.textContent = `${sys.r_photon.toFixed(3)} M`;

    const dtEl = $('hud-dt');
    if (dtEl && sys.step_size !== undefined) dtEl.textContent = sys.step_size.toFixed(4);
  }

  function updateFrame(data) {
    const fpsEl = $('hud-fps');
    if (fpsEl && data.fps !== undefined) fpsEl.textContent = `${data.fps.toFixed(1)} Hz`;

    const raysEl = $('hud-rays');
    if (raysEl && data.activeRays !== undefined) raysEl.textContent = data.activeRays;

    const ftEl = $('hud-ft');
    if (ftEl && data.frameTime !== undefined) ftEl.textContent = `${data.frameTime.toFixed(1)} ms`;

    updateCounters(data.escaped, data.absorbed, data.orbiting);
  }

  function updateCounters(escaped, absorbed, orbiting) {
    const e = $('cnt-escaped');
    const a = $('cnt-absorbed');
    const o = $('cnt-orbiting');
    if (e && escaped  !== undefined) e.textContent = escaped;
    if (a && absorbed !== undefined) a.textContent = absorbed;
    if (o && orbiting !== undefined) o.textContent = orbiting;
  }

  function setStatus(status) {
    const el = $('hud-status');
    if (!el) return;
    el.textContent = status;
    el.style.color = {
      IDLE:      'var(--text-dim)',
      ACTIVE:    '#88ffcc',
      EMITTING:  '#4488ff',
      COMPLETE:  '#aaffaa',
      ERROR:     '#ff4444',
    }[status] || 'var(--text)';
  }

  return { updateSystem, updateFrame, updateCounters, setStatus };
})();

// ── Main bootstrap ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // 1. Initialize Three.js scene
  Scene.init();

  // 2. Initialize control panel
  Controls.init();
  Controls.initDraggable();

  // 3. Connect WebSocket for live streaming
  WS.connect();

  // 4. Fetch initial system state
  try {
    const res = await fetch('/system');
    if (res.ok) {
      const sys = await res.json();
      HUD.updateSystem(sys);
      HUD.setStatus('IDLE');
    }
  } catch (e) {
    console.warn('[Boot] Could not fetch /system:', e);
    HUD.setStatus('CONNECTING…');
  }

  console.log('%c⬤ Black Hole Light Ray Simulation', 'color:#4488ff;font-size:16px;font-weight:bold');
  console.log('%c  Schwarzschild geodesic ray tracer | RK4/RK45', 'color:#5a6a8a;font-size:11px');
});
