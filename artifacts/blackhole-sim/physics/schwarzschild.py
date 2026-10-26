"""
schwarzschild.py — Schwarzschild metric parameters and derived quantities.

The Schwarzschild metric in spherical coordinates (c = G = 1):
  ds² = -(1 - rs/r) dt² + (1 - rs/r)⁻¹ dr² + r² dΩ²

where rs = 2M is the Schwarzschild radius (in geometric units G = c = 1).
"""

from __future__ import annotations
import math
import logging

logger = logging.getLogger(__name__)


class BlackHole:
    """
    Represents a Schwarzschild (non-rotating, uncharged) black hole.

    All quantities are in geometric units where G = c = 1.
    Mass M is the fundamental parameter.
    """

    def __init__(self, mass: float = 1.0) -> None:
        """
        Initialize the black hole.

        Args:
            mass: Black hole mass in geometric units (G = c = 1).
                  Schwarzschild radius rs = 2M in these units.
        """
        if mass <= 0:
            raise ValueError(f"Black hole mass must be positive, got {mass}")
        self._mass = mass
        logger.info("BlackHole created: M=%.4f, rs=%.4f", mass, self.rs)

    # ── Core Properties ───────────────────────────────────────────────────────

    @property
    def mass(self) -> float:
        """Black hole mass M in geometric units."""
        return self._mass

    @mass.setter
    def mass(self, value: float) -> None:
        if value <= 0:
            raise ValueError(f"Mass must be positive, got {value}")
        self._mass = value
        logger.info("BlackHole mass updated: M=%.4f, rs=%.4f", value, self.rs)

    @property
    def rs(self) -> float:
        """
        Schwarzschild radius.

        Derivation:
          rs = 2GM/c²
          In geometric units (G = c = 1): rs = 2M
        """
        return 2.0 * self._mass

    @property
    def r_photon(self) -> float:
        """
        Photon sphere radius.

        At r = 1.5 rs = 3M, photons can orbit in unstable circular orbits.
        This is also called the light ring.

        Derivation from effective potential maximum:
          V_eff(r) = (1 - rs/r) / r² → dV_eff/dr = 0 → r = 3M = 1.5 rs
        """
        return 1.5 * self.rs  # = 3M

    @property
    def r_isco(self) -> float:
        """
        Innermost Stable Circular Orbit (ISCO).

        For Schwarzschild: r_ISCO = 6M = 3 rs.
        Inside this radius, no stable circular orbits exist (accretion disk inner edge).
        """
        return 3.0 * self.rs  # = 6M

    @property
    def escape_velocity(self) -> float:
        """
        Escape velocity at the event horizon (r = rs), in units of c.

        At the Schwarzschild radius, escape velocity = c (hence 'event horizon').
        For reference at photon sphere (r = 1.5 rs): v_esc = sqrt(2/3) c ≈ 0.816 c
        """
        return 1.0  # At event horizon, escape velocity = c (in natural units)

    # ── Metric Components ─────────────────────────────────────────────────────

    def metric_tt(self, r: float) -> float:
        """
        Time-time component of the Schwarzschild metric: g_tt = -(1 - rs/r).
        Represents gravitational time dilation.
        """
        return -(1.0 - self.rs / r)

    def metric_rr(self, r: float) -> float:
        """
        Radial-radial component: g_rr = 1/(1 - rs/r).
        Diverges at r = rs (coordinate singularity).
        """
        f = 1.0 - self.rs / r
        if abs(f) < 1e-12:
            return float("inf")
        return 1.0 / f

    def lapse_function(self, r: float) -> float:
        """
        Lapse function f(r) = 1 - rs/r.
        Appears in both g_tt and g_rr of the Schwarzschild metric.
        """
        return 1.0 - self.rs / r

    # ── Physical Quantities ───────────────────────────────────────────────────

    def gravitational_redshift(self, r: float) -> float:
        """
        Gravitational redshift factor at radius r.

        z + 1 = 1 / sqrt(1 - rs/r)

        A photon emitted at r with frequency ν_emit is observed at infinity
        with frequency ν_obs = ν_emit * sqrt(1 - rs/r).
        """
        f = self.lapse_function(r)
        if f <= 0:
            return float("inf")
        return 1.0 / math.sqrt(f) - 1.0

    def circular_orbit_velocity(self, r: float) -> float:
        """
        Orbital velocity for a circular orbit at radius r (in units of c).

        v_orb = sqrt(M / (r - rs/2)) / r  [approximate]
        Exact: v_orb = sqrt(M/r) / sqrt(1 - 3M/r) in Boyer-Lindquist coords.
        Valid only for r > r_ISCO = 6M.
        """
        if r <= self.r_isco:
            return float("nan")
        M = self._mass
        return math.sqrt(M / r) / math.sqrt(1.0 - 3.0 * M / r)

    def to_dict(self) -> dict:
        """Return all black hole parameters as a dictionary."""
        return {
            "mass": self._mass,
            "rs": self.rs,
            "r_photon": self.r_photon,
            "r_isco": self.r_isco,
            "escape_velocity": self.escape_velocity,
        }
