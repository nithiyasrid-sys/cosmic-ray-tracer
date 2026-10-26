/**
 * websocket.js — WebSocket client for real-time ray streaming.
 *
 * Connects to ws://host/live and processes server frames:
 *   { type: "frame", frame: N, rays: [...], active_rays: N, fps: 60 }
 *   { type: "connected", system: {...} }
 *   { type: "complete", total_rays: N, stats: {...} }
 *   { type: "status", message: "..." }
 */

'use strict';

const WS = (() => {
  let socket = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  const MAX_DELAY = 10000;

  // ── Statistics ────────────────────────────────────────────────────────────
  const stats = {
    fps: 0,
    activeRays: 0,
    escaped: 0,
    absorbed: 0,
    orbiting: 0,
    simTime: 0,
    frameCount: 0,
    lastFrameTime: 0,
  };

  // ── Ray count tracking ────────────────────────────────────────────────────
  const rayStatusMap = {};  // rayId → status

  // ── Connection ────────────────────────────────────────────────────────────

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/live`;

    setIndicator('connecting');

    try {
      socket = new WebSocket(url);
    } catch (e) {
      console.error('[WS] Failed to create WebSocket:', e);
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      console.log('[WS] Connected to', url);
      setIndicator('connected');
      reconnectDelay = 1000;  // reset backoff
    };

    socket.onclose = () => {
      console.warn('[WS] Disconnected');
      setIndicator('disconnected');
      socket = null;
      scheduleReconnect();
    };

    socket.onerror = (e) => {
      console.error('[WS] Error:', e);
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch (e) {
        if (event.data !== 'pong') {
          console.warn('[WS] Failed to parse message:', event.data);
        }
      }
    };

    // Keepalive ping every 20s
    const pingInterval = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send('ping');
      } else {
        clearInterval(pingInterval);
      }
    }, 20000);
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    console.log(`[WS] Reconnecting in ${reconnectDelay}ms...`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_DELAY);
  }

  // ── Message Handler ────────────────────────────────────────────────────────

  function handleMessage(msg) {
    switch (msg.type) {
      case 'connected':
        handleConnected(msg);
        break;
      case 'frame':
        handleFrame(msg);
        break;
      case 'complete':
        handleComplete(msg);
        break;
      case 'status':
        handleStatus(msg);
        break;
      case 'keepalive':
        break;
      default:
        break;
    }
  }

  function handleConnected(msg) {
    console.log('[WS] System params:', msg.system);
    if (msg.system) {
      HUD.updateSystem(msg.system);
    }
  }

  function handleFrame(msg) {
    const now = performance.now();
    const frameTime = now - stats.lastFrameTime;
    stats.lastFrameTime = now;
    stats.fps = msg.fps || (1000 / Math.max(frameTime, 1));
    stats.activeRays = msg.active_rays || 0;
    stats.simTime = msg.simulation_time || 0;
    stats.frameCount = msg.frame || 0;

    // Process each ray update
    if (msg.rays && msg.rays.length > 0) {
      for (const ray of msg.rays) {
        const prevStatus = rayStatusMap[ray.id] || 'ACTIVE';
        const newStatus  = ray.status || prevStatus;
        rayStatusMap[ray.id] = newStatus;

        // Append new positions
        if (ray.new_positions && ray.new_positions.length > 0) {
          Scene.appendRayPositions(ray.id, ray.new_positions, newStatus);
        }

        // Count terminal statuses
        if (newStatus === 'ESCAPED' && prevStatus === 'ACTIVE')  stats.escaped++;
        if (newStatus === 'ABSORBED' && prevStatus === 'ACTIVE') stats.absorbed++;
        if (newStatus === 'ORBITING' && prevStatus === 'ACTIVE') stats.orbiting++;
      }
    }

    // Update HUD
    HUD.updateFrame({
      fps: stats.fps,
      activeRays: stats.activeRays,
      frameTime: frameTime,
      simTime: stats.simTime,
      escaped: stats.escaped,
      absorbed: stats.absorbed,
      orbiting: stats.orbiting,
    });
  }

  function handleComplete(msg) {
    console.log('[WS] Simulation complete:', msg.stats);
    HUD.setStatus('COMPLETE');
    Controls.setEmitting(false);

    // Final count update
    if (msg.stats) {
      stats.escaped  = msg.stats.escaped  || stats.escaped;
      stats.absorbed = msg.stats.absorbed || stats.absorbed;
      stats.orbiting = msg.stats.orbiting || stats.orbiting;
      HUD.updateCounters(stats.escaped, stats.absorbed, stats.orbiting);
    }
  }

  function handleStatus(msg) {
    if (msg.message === 'simulation_started') {
      // Reset counters
      stats.escaped = 0;
      stats.absorbed = 0;
      stats.orbiting = 0;
      Object.keys(rayStatusMap).forEach(k => delete rayStatusMap[k]);
      HUD.setStatus('ACTIVE');
      HUD.updateCounters(0, 0, 0);
    } else if (msg.message === 'reset') {
      HUD.setStatus('IDLE');
      Controls.setEmitting(false);
    }
  }

  // ── Indicator ─────────────────────────────────────────────────────────────

  function setIndicator(state) {
    const el = document.getElementById('ws-indicator');
    if (!el) return;
    el.className = `ws-dot ${state}`;
    el.title = `WebSocket: ${state}`;
  }

  return { connect };
})();
