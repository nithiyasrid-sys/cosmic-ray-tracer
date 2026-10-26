"""
simulation.py — Core simulation engine.

Runs photon geodesic integration asynchronously, yields batched
ray state updates for WebSocket streaming.

Architecture:
  SimulationEngine holds state (black hole, camera, active rays).
  integrate_step() advances all active rays one RK4/RK45 step.
  run_async() is an async generator that yields frame dicts.
"""

from __future__ import annotations
import asyncio
import logging
import time
from typing import AsyncGenerator, Dict, List, Optional, Tuple

import numpy as np

from physics.schwarzschild import BlackHole
from physics.ray import Ray, RayStatus, make_ray_batch
from physics.geodesic import (
    geodesic_acceleration_3d,
    check_termination,
    initial_velocity_3d,
)
from physics.integrator import rk4_step, rk45_step_batch, compute_curvature, IntegratorConfig
from renderer.camera import Camera
from config import (
    DEFAULT_MASS, DEFAULT_DT, DEFAULT_MAX_STEPS,
    R_MAX, R_ABSORB_FACTOR, WS_FPS_CAP, ORBIT_DETECTION_REVOLUTIONS,
)

logger = logging.getLogger(__name__)


class SimulationEngine:
    """
    Core simulation engine for photon ray tracing around a Schwarzschild black hole.

    Manages:
      - Black hole physics parameters
      - Active ray set (positions, velocities, status)
      - Numerical integration (RK4 or RK45)
      - Per-frame state output for WebSocket streaming
    """

    def __init__(self) -> None:
        self.black_hole = BlackHole(mass=DEFAULT_MASS)
        self.camera = Camera()
        self.config = IntegratorConfig()

        # Running simulation state
        self.rays: List[Ray] = []
        self._running = False
        self._task: Optional[asyncio.Task] = None

        # Vectorized integration state (numpy arrays)
        self._pos: Optional[np.ndarray] = None   # (N, 3)
        self._vel: Optional[np.ndarray] = None   # (N, 3)
        self._active: Optional[np.ndarray] = None  # (N,) bool

        # Statistics
        self.frame_count: int = 0
        self.sim_start_time: float = 0.0
        self.last_fps: float = 0.0

    def reset(self) -> None:
        """Clear all rays and reset simulation state."""
        self._running = False
        self.rays = []
        self._pos = None
        self._vel = None
        self._active = None
        self.frame_count = 0
        logger.info("Simulation reset")

    def setup_rays(
        self,
        origins: np.ndarray,    # (N, 3)
        directions: np.ndarray, # (N, 3)
    ) -> None:
        """
        Initialize ray state from camera-emitted origins and directions.

        Stores both the Python Ray objects (for serialization / status)
        and the NumPy arrays (for vectorized integration).

        Args:
            origins:    (N,3) ray origin positions
            directions: (N,3) ray direction unit vectors
        """
        N = origins.shape[0]
        logger.info("Setting up %d rays for integration", N)

        self.rays = make_ray_batch(origins, directions)

        # Initialize numpy integration arrays
        self._pos = origins.copy().astype(np.float64)
        self._vel = initial_velocity_3d(origins, directions,
                                        self.black_hole.mass,
                                        self.black_hole.rs)
        self._active = np.ones(N, dtype=bool)

    def _acc_fn(self, pos: np.ndarray, vel: np.ndarray) -> np.ndarray:
        """Acceleration closure over current black hole parameters."""
        return geodesic_acceleration_3d(
            pos, vel,
            self.black_hole.mass,
            self.black_hole.rs,
        )

    def _integrate_one_step(self) -> None:
        """
        Advance all active rays by one integration step (RK4 or RK45).

        Updates:
          self._pos, self._vel (numpy arrays)
          self.rays (status, positions, curvature, distance)
          self._active (mask)
        """
        if self._pos is None or not np.any(self._active):
            return

        dt = self.config.dt
        active = self._active

        # ── Integration step ──────────────────────────────────────────────────
        if self.config.use_adaptive:
            new_pos, new_vel = rk45_step_batch(
                self._pos, self._vel, self._acc_fn, dt, active
            )
        else:
            new_pos, new_vel = rk4_step(
                self._pos, self._vel, self._acc_fn, dt, active
            )

        # ── Compute curvature for active rays ─────────────────────────────────
        acc_current = self._acc_fn(self._pos, self._vel)
        curv = compute_curvature(self._pos, self._vel, acc_current)

        # ── Step distance (arc length ≈ |Δpos|) ───────────────────────────────
        delta = new_pos - self._pos   # (N,3)
        step_dist = np.sqrt(np.sum(delta * delta, axis=1))  # (N,)

        # ── Check termination conditions ──────────────────────────────────────
        still_active, absorbed, escaped = check_termination(
            new_pos,
            active,
            self.black_hole.rs,
            R_MAX * self.black_hole.rs,
            R_ABSORB_FACTOR,
        )

        # ── Update arrays ─────────────────────────────────────────────────────
        self._pos = new_pos
        self._vel = new_vel
        self._active = still_active

        # ── Sync Ray objects ──────────────────────────────────────────────────
        for i, ray in enumerate(self.rays):
            if not active[i]:
                continue  # Already terminated in a previous step

            # Append new position
            x, y, z = float(new_pos[i, 0]), float(new_pos[i, 1]), float(new_pos[i, 2])
            ray.add_position(x, y, z)
            ray.distance += float(step_dist[i])
            ray.curvature = float(curv[i])
            ray.steps += 1

            # Track azimuthal angle for orbit detection
            r_prev = np.linalg.norm(self._pos[i] - delta[i])
            dphi = abs(float(step_dist[i]) / max(r_prev, 0.01))
            ray.phi_total += dphi

            # Update status
            if absorbed[i]:
                ray.mark_absorbed()
            elif escaped[i]:
                ray.mark_escaped()
            elif ray.steps >= self.config.max_steps:
                ray.mark_escaped()
            elif ray.phi_total > 2 * 3.14159 * ORBIT_DETECTION_REVOLUTIONS:
                ray.mark_orbiting()

    async def run_async(
        self,
        broadcaster,
    ) -> None:
        """
        Run the full simulation as an async background task.

        Integrates rays step by step, pushing frame updates to the
        broadcaster at WS_FPS_CAP rate.

        Args:
            broadcaster: SimulationBroadcaster instance for WebSocket output
        """
        self._running = True
        self.sim_start_time = time.monotonic()
        self.frame_count = 0

        prev_positions = [len(r.positions) for r in self.rays]

        await broadcaster.push_status("simulation_started", {
            "ray_count": len(self.rays),
            "black_hole": self.black_hole.to_dict(),
        })

        steps_per_frame = self.config.steps_per_frame
        min_frame_interval = 1.0 / WS_FPS_CAP
        frame_start = time.monotonic()

        try:
            while self._running and (self._active is not None) and np.any(self._active):
                # ── Run several integration steps per frame ───────────────────
                for _ in range(steps_per_frame):
                    self._integrate_one_step()
                    if self._active is None or not np.any(self._active):
                        break
                # Yield to the event loop so WebSocket ping/pong and other
                # coroutines can run between frames (prevents timeout issues).
                await asyncio.sleep(0)

                # ── Build frame payload (incremental positions) ───────────────
                rays_data = []
                for i, ray in enumerate(self.rays):
                    from_step = prev_positions[i]
                    new_count = len(ray.positions)
                    if new_count > from_step or ray.status != RayStatus.ACTIVE:
                        rays_data.append(ray.to_dict_incremental(from_step))
                        prev_positions[i] = new_count

                # ── FPS accounting ────────────────────────────────────────────
                now = time.monotonic()
                elapsed = now - frame_start
                fps = 1.0 / elapsed if elapsed > 0 else WS_FPS_CAP
                self.last_fps = fps
                frame_start = now
                self.frame_count += 1

                active_count = int(np.sum(self._active)) if self._active is not None else 0

                if rays_data:
                    await broadcaster.push_frame(
                        rays_data,
                        active_count=active_count,
                        fps=fps,
                        simulation_time=now - self.sim_start_time,
                    )
                else:
                    # Sleep to avoid busy-looping when nothing changed
                    await asyncio.sleep(min_frame_interval)

        except asyncio.CancelledError:
            logger.info("Simulation task cancelled")
        except Exception as e:
            logger.exception("Simulation error: %s", e)
        finally:
            self._running = False

        # ── Final stats ───────────────────────────────────────────────────────
        stats = self._compute_stats()
        await broadcaster.push_complete(len(self.rays), stats)
        logger.info("Simulation complete: %s", stats)

    def _compute_stats(self) -> Dict:
        escaped  = sum(1 for r in self.rays if r.status == RayStatus.ESCAPED)
        absorbed = sum(1 for r in self.rays if r.status == RayStatus.ABSORBED)
        orbiting = sum(1 for r in self.rays if r.status == RayStatus.ORBITING)
        active   = sum(1 for r in self.rays if r.status == RayStatus.ACTIVE)
        avg_dist = (sum(r.distance for r in self.rays) / len(self.rays)
                    if self.rays else 0.0)
        return {
            "total":    len(self.rays),
            "escaped":  escaped,
            "absorbed": absorbed,
            "orbiting": orbiting,
            "active":   active,
            "avg_distance": round(avg_dist, 3),
            "frames":   self.frame_count,
        }

    def get_system_info(self) -> Dict:
        """Return current system parameters for GET /system."""
        return {
            "mass":      self.black_hole.mass,
            "rs":        self.black_hole.rs,
            "r_photon":  self.black_hole.r_photon,
            "r_isco":    self.black_hole.r_isco,
            "G":         6.674e-11,
            "c":         2.998e8,
            "ray_count": len(self.rays),
            "fps":       round(self.last_fps, 1),
            "step_size": self.config.dt,
            "max_steps": self.config.max_steps,
            "running":   self._running,
        }

    def stop(self) -> None:
        self._running = False
