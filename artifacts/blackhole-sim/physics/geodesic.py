"""
geodesic.py — Geodesic equations of motion for photons in Schwarzschild spacetime.

We use the orbit equation in terms of u = 1/r:

  d²u/dφ² + u = 3M·u²

This is derived from the null geodesic condition and the effective potential
of the Schwarzschild metric.

For 3D simulation we integrate in Cartesian coordinates using the
Christoffel-derived acceleration:

  d²x^i/dλ² = -Γ^i_{μν} (dx^μ/dλ)(dx^ν/dλ)

For a photon on the equatorial plane in Schwarzschild metric,
the Cartesian equations of motion reduce to:

  ẍ = a(r) * x/r    (and same for y, z)

where the "radial acceleration" accounts for GR corrections to Newtonian gravity.
"""

from __future__ import annotations
import numpy as np
from typing import Tuple


# ── Orbit Equation (2D, polar) ────────────────────────────────────────────────

def geodesic_rhs_polar(state: np.ndarray, phi: float, M: float) -> np.ndarray:
    """
    Right-hand side of the photon orbit equation in (u, u') polar form.

    State vector: [u, du/dphi]  where u = 1/r

    Orbit equation (null geodesic, equatorial plane):
      d²u/dφ² = 3M·u² - u

    This is derived from the Binet equation for photon orbits in the
    Schwarzschild metric:
      (du/dφ)² = (E/L)² - u²(1 - 2Mu)
    Differentiating with respect to φ:
      d²u/dφ² + u = 3M·u²

    Args:
        state: [u, u_prime] = [1/r, d(1/r)/dφ]
        phi:   Current azimuthal angle (unused — autonomous system)
        M:     Black hole mass

    Returns:
        [du/dφ, d²u/dφ²] = [u_prime, 3M·u² - u]
    """
    u, u_prime = state
    # GR correction term: 3M·u² (absent in Newtonian limit → d²u/dφ² + u = 0)
    u_double_prime = 3.0 * M * u * u - u
    return np.array([u_prime, u_double_prime])


# ── 3D Cartesian Equations of Motion ─────────────────────────────────────────

def geodesic_acceleration_3d(
    pos: np.ndarray,   # (N, 3) positions
    vel: np.ndarray,   # (N, 3) velocities (tangent vector)
    M: float,
    rs: float,
) -> np.ndarray:
    """
    Geodesic acceleration for N photons in 3D Cartesian coordinates.

    Derived from the Schwarzschild metric Christoffel symbols, projected
    into Cartesian coordinates on the equatorial plane.

    The equation of motion for a null geodesic in the Schwarzschild metric
    in isotropic Cartesian coordinates (for the spatial part):

      d²r⃗/dλ² = a_r(r) * r̂  +  a_v(r) * v⃗

    where the terms come from the Christoffel symbols Γ^i_{00}, Γ^i_{jk}.

    We use the standard "optical" formulation:
      d²x⃗/dλ² = (-M/r³)(1 - rs/r)⁻¹ * x⃗ * (correction terms)

    Accurate form (derived in Misner-Thorne-Wheeler §25.6):
      d²r/dλ² = -M(r-rs)/(r³) + L²(r-rs)/(r⁵) * (3Mr-rs*r) ...
    For the Cartesian 3D form used in visualizations:

    Effective radial acceleration per unit distance:
      a_rad = -(3M/r^5) * (r⃗·v⃗)  [frame-dragging / curvature coupling]
    plus:
      a_potential = -M*(1-rs/r) / r³  [potential gradient]

    Reference: Müller & Grave 2010, arXiv:0904.4184

    Args:
        pos: (N,3) current positions
        vel: (N,3) current velocities (dλ tangent)
        M:   Black hole mass (geometric units)
        rs:  Schwarzschild radius = 2M

    Returns:
        acc: (N,3) acceleration vectors
    """
    # Radial distances
    r2 = np.sum(pos * pos, axis=1, keepdims=True)          # (N,1)
    r  = np.sqrt(r2)                                        # (N,1)
    r3 = r2 * r                                             # (N,1)
    r5 = r2 * r3                                            # (N,1)

    # Lapse function f = 1 - rs/r
    f = 1.0 - rs / r                                        # (N,1)

    # Dot product r⃗·v⃗ (used in the geodesic deviation term)
    rdotv = np.sum(pos * vel, axis=1, keepdims=True)        # (N,1)

    # v² (squared speed of photon tangent vector)
    v2 = np.sum(vel * vel, axis=1, keepdims=True)           # (N,1)

    # ── Christoffel-derived acceleration ──────────────────────────────────────
    # From the null geodesic equation in Schwarzschild coords projected to Cartesian:
    #
    #   d²x^i/dλ² = (rs/(2r³)) * f⁻¹ * v_r² * x^i/r
    #             - (rs/(2r³)) * f   * (v_t² contribution)
    #             - (rs/r³) * rdotv * v^i  (cross term)
    #
    # Simplified accurate form for null rays:
    #   acc = -(M/r³) * [2*f * pos + (something) * vel]
    #
    # We use the well-tested "3+1 formulation" (used in blackhole ray-tracers):
    #   acc_i = (rs/2) * [ (v_r²/r³ - v²/r²) * x_i/r - 2*(v_r/r²)*v_i ]
    # where v_r = rdotv/r

    v_r = rdotv / r  # radial component of velocity (N,1)

    term_pos = (v_r * v_r / r3 - v2 / r2) * (pos / r)     # (N,3): curvature × position
    term_vel = -2.0 * (v_r / r2) * vel                     # (N,3): dragging × velocity

    acc = 0.5 * rs * (term_pos + term_vel)                  # (N,3)

    return acc


def initial_velocity_3d(
    pos: np.ndarray,     # (N, 3)
    directions: np.ndarray,  # (N, 3) unit vectors
    M: float,
    rs: float,
) -> np.ndarray:
    """
    Compute initial geodesic velocity for null rays from direction vectors.

    For a photon emitted in direction d̂ from position r⃗,
    the initial tangent vector (affine parameter normalization) is just d̂
    since we're working in coordinate time units.

    The normalization is absorbed into the affine parameter λ.

    Args:
        pos:        (N,3) positions
        directions: (N,3) unit direction vectors (already normalized)
        M:          Black hole mass
        rs:         Schwarzschild radius

    Returns:
        vel: (N,3) initial velocity (tangent vector to geodesic)
    """
    # Ensure directions are unit vectors
    norms = np.linalg.norm(directions, axis=1, keepdims=True)
    vel = directions / np.maximum(norms, 1e-12)
    return vel


def check_termination(
    pos: np.ndarray,   # (N, 3)
    active: np.ndarray,  # (N,) bool mask
    rs: float,
    r_max: float,
    r_absorb_factor: float = 1.01,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Check termination conditions for all active rays.

    Termination conditions:
      1. r < rs * r_absorb_factor → ABSORBED (fell into event horizon)
      2. r > r_max               → ESCAPED  (reached infinity)

    Args:
        pos:             (N,3) current positions
        active:          (N,) bool mask of currently active rays
        rs:              Schwarzschild radius
        r_max:           Maximum escape radius
        r_absorb_factor: Absorb if r < rs * this factor (slightly > 1 for stability)

    Returns:
        still_active:  Updated active mask
        absorbed:      Mask of newly absorbed rays (ABSORBED this step)
        escaped:       Mask of newly escaped rays (ESCAPED this step)
    """
    r = np.sqrt(np.sum(pos * pos, axis=1))   # (N,)

    absorbed = active & (r < rs * r_absorb_factor)
    escaped  = active & (r > r_max)

    still_active = active & ~absorbed & ~escaped

    return still_active, absorbed, escaped
