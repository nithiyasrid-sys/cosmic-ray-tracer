"""
integrator.py — Runge-Kutta 4 and RK45 solvers for photon geodesics.

Never use Euler integration (first-order; too inaccurate for curved spacetime).

RK4 is implemented from scratch for full control and performance.
RK45 (adaptive step) delegates to SciPy for automatic error control.

Both operate on batches of N rays simultaneously using NumPy vectorization.
"""

from __future__ import annotations
import numpy as np
import logging
from typing import Callable, Optional, Tuple
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


# ── Type alias ────────────────────────────────────────────────────────────────
# State: (pos, vel) where pos=(N,3), vel=(N,3)
StateTuple = Tuple[np.ndarray, np.ndarray]


@dataclass
class IntegratorConfig:
    """Configuration for the numerical integrator."""
    dt: float = 0.05              # Fixed time step for RK4
    max_steps: int = 2000         # Max integration steps
    use_adaptive: bool = False    # True = RK45, False = RK4
    rtol: float = 1e-6            # Relative tolerance (RK45 only)
    atol: float = 1e-9            # Absolute tolerance (RK45 only)
    steps_per_frame: int = 5      # Integration steps emitted per WebSocket frame


# ── RK4 Solver ────────────────────────────────────────────────────────────────

def rk4_step(
    pos: np.ndarray,   # (N, 3)
    vel: np.ndarray,   # (N, 3)
    acc_fn: Callable[[np.ndarray, np.ndarray], np.ndarray],
    dt: float,
    active: np.ndarray,  # (N,) bool — only integrate active rays
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Single Runge-Kutta 4th-order step for N rays simultaneously.

    Classic RK4 scheme for second-order ODE  ẍ = f(x, ẋ):
      Convert to first-order system: [x, v] where ẋ = v, v̇ = f(x, v)

      k1 = dt * f(x,       v      )
      k2 = dt * f(x+k1/2,  v+k1/2 )   [midpoint estimate]
      k3 = dt * f(x+k2/2,  v+k2/2 )   [midpoint estimate with k2]
      k4 = dt * f(x+k3,    v+k3   )   [endpoint estimate]

      Δv = (k1 + 2k2 + 2k3 + k4) / 6
      Δx = dt * (v + v_correction)

    Global truncation error: O(dt⁴) — much better than Euler O(dt¹).

    Args:
        pos:    (N,3) current positions
        vel:    (N,3) current velocities
        acc_fn: Callable(pos, vel) → (N,3) acceleration
        dt:     Time step (affine parameter step Δλ)
        active: (N,) boolean mask — only update active rays

    Returns:
        new_pos: (N,3) updated positions
        new_vel: (N,3) updated velocities
    """
    N = pos.shape[0]

    # Work only on active rays for efficiency
    if not np.any(active):
        return pos.copy(), vel.copy()

    new_pos = pos.copy()
    new_vel = vel.copy()

    p = pos[active]   # (M, 3) — M = number of active rays
    v = vel[active]   # (M, 3)

    # ── Stage 1: slope at current point ───────────────────────────────────────
    a1 = acc_fn(p, v)                           # (M,3) acceleration at (p, v)
    k1_v = dt * a1                              # velocity increment stage 1
    k1_p = dt * v                               # position increment stage 1

    # ── Stage 2: slope at midpoint using k1 estimates ─────────────────────────
    p2 = p + 0.5 * k1_p
    v2 = v + 0.5 * k1_v
    a2 = acc_fn(p2, v2)
    k2_v = dt * a2
    k2_p = dt * v2

    # ── Stage 3: slope at midpoint using k2 estimates ─────────────────────────
    p3 = p + 0.5 * k2_p
    v3 = v + 0.5 * k2_v
    a3 = acc_fn(p3, v3)
    k3_v = dt * a3
    k3_p = dt * v3

    # ── Stage 4: slope at endpoint using k3 estimates ─────────────────────────
    p4 = p + k3_p
    v4 = v + k3_v
    a4 = acc_fn(p4, v4)
    k4_v = dt * a4
    k4_p = dt * v4

    # ── Weighted combination (Simpson's rule weights: 1,2,2,1) ────────────────
    delta_v = (k1_v + 2.0 * k2_v + 2.0 * k3_v + k4_v) / 6.0
    delta_p = (k1_p + 2.0 * k2_p + 2.0 * k3_p + k4_p) / 6.0

    new_vel[active] = v + delta_v
    new_pos[active] = p + delta_p

    return new_pos, new_vel


def rk45_step_batch(
    pos: np.ndarray,
    vel: np.ndarray,
    acc_fn: Callable[[np.ndarray, np.ndarray], np.ndarray],
    dt: float,
    active: np.ndarray,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Dormand-Prince RK45 (adaptive) step — simplified fixed-step version.

    The full adaptive version uses SciPy's solve_ivp with RK45 method.
    Here we use the 6-stage Dormand-Prince tableau for a single step,
    which gives both 4th and 5th order estimates.

    Butcher tableau (Dormand-Prince):
      c:  0, 1/5, 3/10, 4/5, 8/9, 1, 1
      a:  (standard DP coefficients)
      b5: [35/384, 0, 500/1113, 125/192, -2187/6784, 11/84, 0]  ← 5th order

    For simplicity we use the fixed-dt Dormand-Prince (no adaptive step rejection).
    For full adaptive integration, see `integrate_rays_adaptive`.

    Args:
        pos, vel, acc_fn, dt, active: Same as rk4_step.

    Returns:
        new_pos: (N,3) updated positions
        new_vel: (N,3) updated velocities
    """
    # Dormand-Prince coefficients
    c2, c3, c4, c5 = 1/5, 3/10, 4/5, 8/9

    a21 = 1/5
    a31, a32 = 3/40, 9/40
    a41, a42, a43 = 44/45, -56/15, 32/9
    a51, a52, a53, a54 = 19372/6561, -25360/2187, 64448/6561, -212/729
    a61, a62, a63, a64, a65 = 9017/3168, -355/33, 46732/5247, 49/176, -5103/18656

    # 5th-order weights
    b1, b3, b4, b5, b6 = 35/384, 500/1113, 125/192, -2187/6784, 11/84

    if not np.any(active):
        return pos.copy(), vel.copy()

    new_pos = pos.copy()
    new_vel = vel.copy()

    p = pos[active]
    v = vel[active]

    # Stage 1
    k1p = dt * v
    k1v = dt * acc_fn(p, v)

    # Stage 2
    p2 = p + a21*k1p;  v2 = v + a21*k1v
    k2p = dt * v2;     k2v = dt * acc_fn(p2, v2)

    # Stage 3
    p3 = p + a31*k1p + a32*k2p;  v3 = v + a31*k1v + a32*k2v
    k3p = dt * v3;                k3v = dt * acc_fn(p3, v3)

    # Stage 4
    p4 = p + a41*k1p + a42*k2p + a43*k3p
    v4 = v + a41*k1v + a42*k2v + a43*k3v
    k4p = dt * v4;  k4v = dt * acc_fn(p4, v4)

    # Stage 5
    p5 = p + a51*k1p + a52*k2p + a53*k3p + a54*k4p
    v5 = v + a51*k1v + a52*k2v + a53*k3v + a54*k4v
    k5p = dt * v5;  k5v = dt * acc_fn(p5, v5)

    # Stage 6
    p6 = p + a61*k1p + a62*k2p + a63*k3p + a64*k4p + a65*k5p
    v6 = v + a61*k1v + a62*k2v + a63*k3v + a64*k4v + a65*k5v
    k6p = dt * v6;  k6v = dt * acc_fn(p6, v6)

    # 5th-order estimate
    new_pos[active] = p + b1*k1p + b3*k3p + b4*k4p + b5*k5p + b6*k6p
    new_vel[active] = v + b1*k1v + b3*k3v + b4*k4v + b5*k5v + b6*k6v

    return new_pos, new_vel


def compute_curvature(
    pos: np.ndarray,   # (N, 3)
    vel: np.ndarray,   # (N, 3)
    acc: np.ndarray,   # (N, 3)
) -> np.ndarray:
    """
    Compute the geodesic curvature magnitude for each ray.

    Curvature κ = |v̇ × v| / |v|³ in the Frenet-Serret sense.
    Here we approximate: κ ≈ |acc| / max(|vel|², ε)

    This gives a scalar measure of how much the ray is bending at
    each step — useful for the HUD display.

    Args:
        pos: (N,3) positions (unused here, kept for API consistency)
        vel: (N,3) velocities
        acc: (N,3) accelerations

    Returns:
        curvature: (N,) curvature magnitudes
    """
    v2 = np.sum(vel * vel, axis=1)                # (N,)
    a_mag = np.sqrt(np.sum(acc * acc, axis=1))    # (N,)
    curvature = a_mag / np.maximum(v2, 1e-12)
    return curvature
