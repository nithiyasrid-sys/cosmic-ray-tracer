/**
 * controls.js — Control panel bindings.
 * Includes new Ray Visuals, Emitter, Follow Source, and Continuous Emit sliders.
 */
'use strict';

const Controls = (() => {
  let isEmitting  = false;
  let currentMass = 1.0;
  let continuousTimer = null;

  async function api(path, body) {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { console.error(`[API] ${path} failed:`, await res.text()); return null; }
      return await res.json();
    } catch (e) {
      console.error(`[API] ${path} error:`, e);
      return null;
    }
  }

  function bindSlider(id, valId, onChange) {
    const slider = document.getElementById(id);
    const label  = document.getElementById(valId);
    if (!slider) return;
    const update = () => {
      const v = parseFloat(slider.value);
      if (label) label.textContent = v;
      updateSliderFill(slider);
      onChange(v);
    };
    slider.addEventListener('input', update);
    updateSliderFill(slider);
  }

  function updateSliderFill(slider) {
    const min = parseFloat(slider.min);
    const max = parseFloat(slider.max);
    const val = parseFloat(slider.value);
    const pct = ((val - min) / (max - min)) * 100;
    slider.style.background =
      `linear-gradient(to right, var(--accent) ${pct}%, rgba(61,126,255,0.2) ${pct}%)`;
  }

  function getCameraParams() {
    const dist  = parseFloat(document.getElementById('ctrl-dist')?.value  || 10);
    const yaw   = parseFloat(document.getElementById('ctrl-yaw')?.value   || 0);
    const pitch = parseFloat(document.getElementById('ctrl-pitch')?.value || 0);
    const fov   = parseFloat(document.getElementById('ctrl-fov')?.value   || 60);
    const yawRad   = (yaw   * Math.PI) / 180;
    const pitchRad = (pitch * Math.PI) / 180;
    const rs = 2.0 * currentMass;
    const r  = dist * rs;
    const x  = r * Math.cos(pitchRad) * Math.sin(yawRad);
    const y  = r * Math.sin(pitchRad);
    const z  = r * Math.cos(pitchRad) * Math.cos(yawRad);
    return { position: [x, y, z], yaw, pitch, roll: 0, fov, near: 0.01, far: 1000, resolution: 8 };
  }

  function syncSlidersFromPosition(pos, yaw, pitch, dist_rs) {
    const rs = 2.0 * currentMass;
    const distVal = dist_rs / rs;
    const distSlider  = document.getElementById('ctrl-dist');
    const yawSlider   = document.getElementById('ctrl-yaw');
    const pitchSlider = document.getElementById('ctrl-pitch');
    if (distSlider && document.activeElement !== distSlider) {
      distSlider.value  = distVal.toFixed(1);
      if (document.getElementById('val-dist'))  document.getElementById('val-dist').textContent  = distVal.toFixed(1);
      updateSliderFill(distSlider);
    }
    if (yawSlider && document.activeElement !== yawSlider) {
      yawSlider.value   = yaw.toFixed(0);
      if (document.getElementById('val-yaw'))   document.getElementById('val-yaw').textContent   = yaw.toFixed(0);
      updateSliderFill(yawSlider);
    }
    if (pitchSlider && document.activeElement !== pitchSlider) {
      pitchSlider.value = pitch.toFixed(0);
      if (document.getElementById('val-pitch')) document.getElementById('val-pitch').textContent = pitch.toFixed(0);
      updateSliderFill(pitchSlider);
    }
  }

  async function doEmitRays() {
    const mode  = document.getElementById('ctrl-mode')?.value  || 'fan';
    const count = parseInt(document.getElementById('ctrl-count')?.value || 50);
    setEmitting(true);
    HUD.setStatus('EMITTING');
    // Update camera API with latest emitter position
    const emPos = Scene.getEmitterPosition ? Scene.getEmitterPosition() : null;
    if (emPos) {
      const r = Math.sqrt(emPos.x*emPos.x + emPos.y*emPos.y + emPos.z*emPos.z);
      const theta = Math.atan2(emPos.x, emPos.z);
      const phi = Math.acos(Math.max(-1, Math.min(1, emPos.y / r)));
      const yaw = (theta * 180 / Math.PI);
      const pitch = 90 - (phi * 180 / Math.PI);
      await api('/camera', {
        position: [emPos.x, emPos.y, emPos.z],
        yaw: yaw, pitch: pitch, roll: 0, fov: 60, near: 0.01, far: 1000, resolution: 8
      });
    } else {
      const camParams = getCameraParams();
      await api('/camera', camParams);
    }
    Scene.clearRays();
    // Show preview while waiting for rays
    if (Scene.showPreviewFromEmitter) Scene.showPreviewFromEmitter(count, 0.55);
    const res = await api('/rays', { mode, count });
    if (!res || !res.success) { setEmitting(false); HUD.setStatus('ERROR'); }
  }

  function startContinuous() {
    stopContinuous();
    continuousTimer = setInterval(() => {
      if (isEmitting) return;
      doEmitRays();
    }, 500);
  }

  function stopContinuous() {
    if (continuousTimer) { clearInterval(continuousTimer); continuousTimer = null; }
  }

  function init() {
    // ── Physics sliders ──────────────────────────────────────────────────
    bindSlider('ctrl-mass', 'val-mass', async (v) => {
      currentMass = v;
      await api('/physics', { mass: v });
      try { const sys = await (await fetch('/system')).json(); HUD.updateSystem(sys); } catch (_) {}
    });
    bindSlider('ctrl-dt',       'val-dt',       async (v) => { await api('/physics', { dt: v }); });
    bindSlider('ctrl-maxsteps', 'val-maxsteps', async (v) => { await api('/physics', { max_steps: Math.round(v) }); });
    document.getElementById('ctrl-integrator')?.addEventListener('change', async (e) => {
      await api('/physics', { use_adaptive: e.target.value === 'rk45' });
    });

    // ── Camera and Source sliders ────────────────────────────────────────
    const updateCamera = async () => {
      const dist = parseFloat(document.getElementById('ctrl-dist')?.value || 10);
      const yaw = parseFloat(document.getElementById('ctrl-yaw')?.value || 0);
      const pitch = parseFloat(document.getElementById('ctrl-pitch')?.value || 0);
      if (Scene.setEmitterSpherical) {
        Scene.setEmitterSpherical(dist, yaw, pitch);
      }
      const params = getCameraParams();
      await api('/camera', params);
    };
    bindSlider('ctrl-dist',  'val-dist',  updateCamera);
    bindSlider('ctrl-yaw',   'val-yaw',   updateCamera);
    bindSlider('ctrl-pitch', 'val-pitch', updateCamera);
    bindSlider('ctrl-fov',   'val-fov',   async () => {
      const params = getCameraParams();
      await api('/camera', params);
    });

    document.getElementById('ctrl-autoface')?.addEventListener('change', (e) => {
      if (Scene.setAutoFaceBH) Scene.setAutoFaceBH(e.target.checked);
      const lockStatus = document.getElementById('source-lock-status');
      if (lockStatus) {
        lockStatus.textContent = e.target.checked ? '● AIMED AT SINGULARITY' : '○ MANUAL ORIENTATION';
        lockStatus.style.color = e.target.checked ? '#22ff88' : '#ffe173';
      }
    });

    document.getElementById('ctrl-lockdrag')?.addEventListener('change', (e) => {
      if (Scene.setLockEmitterDrag) Scene.setLockEmitterDrag(e.target.checked);
    });

    // ── Ray sliders ──────────────────────────────────────────────────────
    bindSlider('ctrl-count', 'val-count', () => {});

    // ── Scene sliders ────────────────────────────────────────────────────
    bindSlider('ctrl-diskbright', 'val-diskbright', (v) => { Scene.setDiskBrightness(v); });
    document.getElementById('ctrl-showph')?.addEventListener('change', (e) => { Scene.setPhotonSphereVisible(e.target.checked); });
    document.getElementById('ctrl-trails')?.addEventListener('change', (e) => { Scene.setTrailsVisible(e.target.checked); });
    document.getElementById('ctrl-heatmap')?.addEventListener('change', (e) => { Scene.setHeatmapVisible(e.target.checked); });
    document.getElementById('ctrl-hotspots')?.addEventListener('change', (e) => { Scene.setHotSpotsVisible(e.target.checked); });

    // ── Ray Visuals sliders ──────────────────────────────────────────────
    bindSlider('ctrl-raybright',  'val-raybright',  (v) => { Scene.setRayBrightness(v); });
    bindSlider('ctrl-raythick',   'val-raythick',   (v) => { Scene.setRayThickness(Math.round(v)); });
    bindSlider('ctrl-trail-len',  'val-trail-len',  (v) => { Scene.setTrailLength(Math.round(v)); });

    // ── Emitter sliders ──────────────────────────────────────────────────
    bindSlider('ctrl-srcsize', 'val-srcsize', (v) => { Scene.setSourceSize(v); });
    bindSlider('ctrl-srcglow', 'val-srcglow', (v) => { Scene.setSourceGlow(v); });

    document.getElementById('ctrl-continuous')?.addEventListener('change', (e) => {
      Scene.setContinuousEmit(e.target.checked);
      if (e.target.checked) startContinuous();
      else stopContinuous();
    });

    document.getElementById('ctrl-follow')?.addEventListener('change', (e) => {
      Scene.setFollowSource(e.target.checked);
    });

    // ── QPO & Record ─────────────────────────────────────────────────────
    document.getElementById('btn-rec')?.addEventListener('click', () => { Recorder.toggle(); });
    document.getElementById('ctrl-qpo')?.addEventListener('change', (e) => { QPO.setVisible(e.target.checked); });

    // ── Source-drag callback ─────────────────────────────────────────────
    Scene.setOnSourceMoved(async (pos, yaw, pitch, distRs) => {
      syncSlidersFromPosition(pos, yaw, pitch, distRs);
      const fov = parseFloat(document.getElementById('ctrl-fov')?.value || 60);
      const res = await api('/camera', { position: pos, yaw, pitch, roll: 0, fov, near: 0.01, far: 1000, resolution: 8 });
      if (res?.camera) Scene.updateCameraFrustum(res.camera.position, res.camera.yaw, res.camera.pitch, res.camera.fov);
    });

    // ── Emit button ──────────────────────────────────────────────────────
    document.getElementById('btn-emit')?.addEventListener('click', async () => {
      await doEmitRays();
    });

    // ── Reset button ─────────────────────────────────────────────────────
    document.getElementById('btn-reset')?.addEventListener('click', async () => {
      stopContinuous();
      Scene.clearRays();
      setEmitting(false);
      await api('/reset', {});
      HUD.setStatus('IDLE');
      HUD.updateCounters(0, 0, 0);
    });

    setTimeout(updateCamera, 500);
    document.querySelectorAll('input[type="range"]').forEach(updateSliderFill);
  }

  function setEmitting(v) {
    isEmitting = v;
    const btn = document.getElementById('btn-emit');
    if (!btn) return;
    if (v) { btn.textContent = 'EMITTING…'; btn.classList.add('emitting'); }
    else   { btn.textContent = 'EMIT RAYS'; btn.classList.remove('emitting'); }
  }

  // Drag-to-move the control panel by its title bar
  function initDraggable() {
    const panel  = document.getElementById('controls');
    const handle = panel?.querySelector('.panel-title');
    if (!panel || !handle) return;
    let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
    function toLeftAnchored() {
      const rect = panel.getBoundingClientRect();
      panel.style.right = 'auto';
      panel.style.left  = rect.left + 'px';
      panel.style.top   = rect.top  + 'px';
    }
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      toLeftAnchored();
      dragging = true; startX = e.clientX; startY = e.clientY;
      startLeft = parseFloat(panel.style.left); startTop = parseFloat(panel.style.top);
      handle.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, startLeft + e.clientX - startX)) + 'px';
      panel.style.top  = Math.max(0, Math.min(window.innerHeight - 40, startTop + e.clientY - startY)) + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (dragging) { dragging = false; handle.style.cursor = 'grab'; }
    });
  }

  return { init, setEmitting, initDraggable };
})();
