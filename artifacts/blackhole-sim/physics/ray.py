"""
ray.py — Ray state: position, velocity, and status tracking.

Each ray is a photon (null geodesic) emitted from the camera.
State vector: [r, phi, dr/dlambda, dphi/dlambda]
in spherical coordinates (equatorial plane, theta = pi/2).

For 3D rays we track full [x, y, z] in Cartesian for visualization,
while integrating in the u = 1/r, phi coordinate system for physics.
"""

from __future__ import annotations
import numpy as np
from enum import Enum
from dataclasses import dataclass, field
from typing import List, Tuple


class RayStatus(str, Enum):
    """Terminal and active states of a photon ray."""
    ACTIVE = "ACTIVE"        # Still being integrated
    ESCAPED = "ESCAPED"      # Ray reached r_max (escaped to infinity)
    ABSORBED = "ABSORBED"    # Ray fell inside event horizon
    ORBITING = "ORBITING"    # Detected near-stable photon orbit


@dataclass
class Ray:
    """
    A photon ray (null geodesic) in Schwarzschild spacetime.

    Physics state is tracked in spherical coordinates (r, phi) for 2D,
    and full Cartesian (x, y, z) for 3D scene rendering.

    Attributes:
        ray_id:     Unique identifier
        origin:     3D origin in Cartesian coordinates (x, y, z)
        direction:  Initial 3D direction unit vector (dx, dy, dz)
        status:     Current ray status (ACTIVE, ESCAPED, ABSORBED, ORBITING)
        positions:  Full path history as list of (x, y, z) tuples
        distance:   Total arc-length traveled (in simulation units)
        curvature:  Current geodesic curvature magnitude
        steps:      Integration steps taken
        phi_total:  Total azimuthal angle traversed (for orbit detection)
    """
    ray_id: int
    origin: Tuple[float, float, float]
    direction: Tuple[float, float, float]
    status: RayStatus = RayStatus.ACTIVE
    positions: List[Tuple[float, float, float]] = field(default_factory=list)
    distance: float = 0.0
    curvature: float = 0.0
    steps: int = 0
    phi_total: float = 0.0
    color: str = "BLUE"      # BLUE = active, WHITE = done, RED = absorbed

    def __post_init__(self) -> None:
        # Record starting position
        self.positions = [tuple(self.origin)]  # type: ignore[assignment]

    def add_position(self, x: float, y: float, z: float) -> None:
        """Append a new 3D position to the path history."""
        self.positions.append((x, y, z))

    @property
    def current_position(self) -> Tuple[float, float, float]:
        """Most recent 3D position."""
        if self.positions:
            return self.positions[-1]
        return self.origin

    @property
    def r(self) -> float:
        """Current radial distance from origin."""
        x, y, z = self.current_position
        return float(np.sqrt(x**2 + y**2 + z**2))

    def mark_escaped(self) -> None:
        self.status = RayStatus.ESCAPED
        self.color = "WHITE"

    def mark_absorbed(self) -> None:
        self.status = RayStatus.ABSORBED
        self.color = "RED"

    def mark_orbiting(self) -> None:
        self.status = RayStatus.ORBITING
        self.color = "ORANGE"

    @property
    def is_active(self) -> bool:
        return self.status == RayStatus.ACTIVE

    def to_dict(self) -> dict:
        """Serialize ray state for WebSocket transmission."""
        return {
            "id": self.ray_id,
            "positions": list(self.positions),
            "status": self.status.value,
            "curvature": round(self.curvature, 6),
            "distance": round(self.distance, 4),
            "steps": self.steps,
            "color": self.color,
        }

    def to_dict_incremental(self, from_step: int = 0) -> dict:
        """
        Serialize only new positions since `from_step` for incremental streaming.
        Reduces WebSocket bandwidth significantly.
        """
        return {
            "id": self.ray_id,
            "new_positions": list(self.positions[from_step:]),
            "status": self.status.value,
            "curvature": round(self.curvature, 6),
            "distance": round(self.distance, 4),
            "steps": self.steps,
        }


def make_ray_batch(
    origins: np.ndarray,      # (N, 3) float64
    directions: np.ndarray,   # (N, 3) float64
    start_id: int = 0,
) -> List[Ray]:
    """
    Construct a list of Ray objects from batched origin/direction arrays.

    Args:
        origins:    Nx3 array of ray origins in Cartesian coordinates.
        directions: Nx3 array of unit direction vectors.
        start_id:   Starting ray ID offset.

    Returns:
        List of N Ray objects ready for integration.
    """
    rays: List[Ray] = []
    N = origins.shape[0]
    for i in range(N):
        ray = Ray(
            ray_id=start_id + i,
            origin=(float(origins[i, 0]), float(origins[i, 1]), float(origins[i, 2])),
            direction=(float(directions[i, 0]), float(directions[i, 1]), float(directions[i, 2])),
        )
        rays.append(ray)
    return rays
