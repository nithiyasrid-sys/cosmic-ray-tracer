/**
 * recorder.js — Screen capture via MediaRecorder API.
 * Records the WebGL canvas and downloads as .webm when stopped.
 */

'use strict';

const Recorder = (() => {
  let mediaRecorder = null;
  let chunks = [];
  let isRecording = false;
  let recTimer = null;
  let recSeconds = 0;

  function getBestMimeType() {
    const types = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    for (const t of types) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
    }
    return 'video/webm';
  }

  function start() {
    if (isRecording) return;

    const r = Scene.getRenderer();
    if (!r) { console.warn('[Rec] Scene renderer not ready'); return; }

    const canvas = r.domElement;
    let stream;
    try {
      stream = canvas.captureStream(60);
    } catch (e) {
      console.error('[Rec] captureStream failed:', e);
      return;
    }

    const mimeType = getBestMimeType();
    chunks = [];

    try {
      mediaRecorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 8_000_000,
      });
    } catch (e) {
      console.error('[Rec] MediaRecorder init failed:', e);
      return;
    }

    mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `blackhole_${new Date().toISOString().slice(0,19).replace(/[T:]/g,'-')}.webm`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      chunks = [];
    };

    mediaRecorder.start(200);
    isRecording = true;
    recSeconds  = 0;
    updateBtn(true);

    // Timer on the button
    recTimer = setInterval(() => {
      recSeconds++;
      updateBtn(true);
    }, 1000);
  }

  function stop() {
    if (!isRecording || !mediaRecorder) return;
    clearInterval(recTimer);
    mediaRecorder.stop();
    isRecording = false;
    updateBtn(false);
  }

  function toggle() {
    isRecording ? stop() : start();
  }

  function formatTime(s) {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  }

  function updateBtn(recording) {
    const btn = document.getElementById('btn-rec');
    if (!btn) return;
    if (recording) {
      btn.textContent = `⏹ ${formatTime(recSeconds)}`;
      btn.classList.add('recording');
      btn.title = 'Click to stop recording and download';
    } else {
      btn.textContent = '⏺ REC';
      btn.classList.remove('recording');
      btn.title = 'Record simulation to .webm';
    }
  }

  return { start, stop, toggle };
})();
