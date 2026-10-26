"""
camera.py — Camera model: a real imaging sensor that EMITS rays.

The camera is NOT simply an observer — it's a physical sensor placed
in curved spacetime. It emits photons (null geodesics) outward through
its virtual pixel grid, simulating how a real imaging device would work
near a black hole.

Coordinate system: right-handed, Y-up.
  - Camera looks along -Z (OpenGL convention)
  - Right = +X, Up = +Y

Euler angles: Yaw (Y-axis), Pitch (X-axis), Roll (Z-axis)
Applied in order: Roll → Pitch → Yaw (intrinsic Tait-Bryan)
"""

from __future__ import annotations
import numpy as np
import math
from typing import List, Tuple
from dataclasses import dataclass, field


@dataclass
class Camera:
    """
    Imaging camera that emits photon rays into curved spacetime.

    Attributes:
        position:   3D position vector (x, y, z) in simulation units
        yaw:        Rotation around Y-axis (degrees, left-right)
        pitch:      Rotation around X-axis (degrees, up-down)
        roll:       Rotation around Z-axis (degrees, tilt)
        fov:        Field of view (degrees, horizontal)
        near:       Near clipping plane (in simulation units)
        far:        Far clipping plane
        resolution: NxN pixel grid resolution for Grid mode
    """
    position: Tuple[float, float, float] = (10.0, 0.0, 0.0)
    yaw: float = 180.0    # Face toward origin by default
    pitch: float = 0.0
    roll: float = 0.0
    fov: float = 60.0
    near: float = 0.1
    far: float = 500.0
    resolution: int = 16

    camera_id: str = "default"

    def _rotation_matrix(self) -> np.ndarray:
        """
        Build 3x3 rotation matrix from Euler angles (YPR convention).

        Applied order (intrinsic): Yaw → Pitch → Roll
        Equivalent to extrinsic: Roll → Pitch → Yaw

        Each individual rotation:
          Ry(yaw):   rotates in XZ plane
          Rx(pitch): rotates in YZ plane
          Rz(roll):  rotates in XY plane

        Returns:
            R: (3,3) rotation matrix
        """
        yaw   = math.radians(self.yaw)
        pitch = math.radians(self.pitch)
        roll  = math.radians(self.roll)

        # Rotation matrices
        cy, sy = math.cos(yaw),   math.sin(yaw)
        cp, sp = math.cos(pitch), math.sin(pitch)
        cr, sr = math.cos(roll),  math.sin(roll)

        # Ry * Rx * Rz (YPR, intrinsic)
        Ry = np.array([[ cy, 0, sy],
                       [  0, 1,  0],
                       [-sy, 0, cy]])

        Rx = np.array([[1,   0,  0],
                       [0,  cp, -sp],
                       [0,  sp,  cp]])

        Rz = np.array([[cr, -sr, 0],
                       [sr,  cr, 0],
                       [ 0,   0, 1]])

        return Ry @ Rx @ Rz  # (3,3)

    @property
    def forward(self) -> np.ndarray:
        """Light emitter forward direction: strictly bound to face the black hole at (0, 0, 0)."""
        pos = np.array(self.position, dtype=np.float64)
        norm = float(np.linalg.norm(pos))
        if norm > 1e-6:
            return -pos / norm
        R = self._rotation_matrix()
        return -R[:, 2]

    @property
    def right(self) -> np.ndarray:
        """Right direction perpendicular to forward vector."""
        fwd = self.forward
        up_ref = np.array([0.0, 1.0, 0.0], dtype=np.float64)
        if abs(float(np.dot(fwd, up_ref))) > 0.98:
            up_ref = np.array([0.0, 0.0, 1.0], dtype=np.float64)
        r = np.cross(fwd, up_ref)
        norm = float(np.linalg.norm(r))
        return r / norm if norm > 1e-6 else np.array([1.0, 0.0, 0.0], dtype=np.float64)

    @property
    def up(self) -> np.ndarray:
        """Up direction perpendicular to forward and right."""
        u = np.cross(self.right, self.forward)
        norm = float(np.linalg.norm(u))
        return u / norm if norm > 1e-6 else np.array([0.0, 1.0, 0.0], dtype=np.float64)

    def emit_single(self) -> Tuple[np.ndarray, np.ndarray]:
        """
        Emit a single ray along the camera's forward direction.

        Returns:
            origins:    (1, 3) ray origin
            directions: (1, 3) unit direction
        """
        orig = np.array(self.position, dtype=np.float64).reshape(1, 3)
        dirn = self.forward.reshape(1, 3)
        return orig, dirn

    def emit_fan(self, count: int = 19) -> Tuple[np.ndarray, np.ndarray]:
        """
        Emit a 2D fan of rays spread in the camera's horizontal plane.

        Rays are spread from -FOV/2 to +FOV/2 horizontally,
        all aimed along the forward direction (no vertical spread).

        Args:
            count: Number of rays in the fan.

        Returns:
            origins:    (count, 3) ray origins (all = camera position)
            directions: (count, 3) unit directions
        """
        fwd = self.forward
        rgt = self.right
        half_fov = math.radians(self.fov / 2.0)

        angles = np.linspace(-half_fov, half_fov, count)
        directions = np.array([
            fwd * math.cos(a) + rgt * math.sin(a)
            for a in angles
        ], dtype=np.float64)
        # Normalize
        norms = np.linalg.norm(directions, axis=1, keepdims=True)
        directions /= np.maximum(norms, 1e-12)

        origins = np.tile(self.position, (count, 1)).astype(np.float64)
        return origins, directions

    def emit_cone(self, count: int = 50) -> Tuple[np.ndarray, np.ndarray]:
        """
        Emit a 3D cone of rays around the forward vector.

        Rays are distributed uniformly on a cone with half-angle FOV/2.
        Uses fibonacci sphere sampling for even distribution.

        Args:
            count: Number of rays in the cone.

        Returns:
            origins:    (count, 3) ray origins
            directions: (count, 3) unit directions
        """
        fwd = self.forward
        rgt = self.right
        up  = self.up
        half_angle = math.radians(self.fov / 2.0)

        # Fibonacci / golden-angle sampling on disk, then project to cone
        golden = (1 + math.sqrt(5)) / 2
        directions = []
        for i in range(count):
            # Polar coords in local camera space
            theta = 2 * math.pi * i / golden   # azimuth
            r_frac = math.sqrt(i / max(count - 1, 1))  # radial fraction
            spread = r_frac * half_angle         # actual half-angle

            # Local direction: fwd + right * sin(spread)*cos(theta) + up * ...
            dx = math.sin(spread) * math.cos(theta)
            dy = math.sin(spread) * math.sin(theta)
            d = fwd + rgt * dx + up * dy
            norm = np.linalg.norm(d)
            if norm > 1e-12:
                d = d / norm
            directions.append(d)

        directions_arr = np.array(directions, dtype=np.float64)
        origins = np.tile(self.position, (count, 1)).astype(np.float64)
        return origins, directions_arr

    def emit_grid(
        self, nx: Optional[int] = None, ny: Optional[int] = None
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Emit a grid of rays matching the camera's pixel grid.

        NxN (or NxM) grid covering the full FOV. Correctly computes
        per-pixel directions using perspective projection math.

        The camera's FOV is the horizontal FOV. Vertical FOV is computed
        from the aspect ratio (square pixels assumed).

        Args:
            nx: Number of rays in X (defaults to resolution)
            ny: Number of rays in Y (defaults to resolution)

        Returns:
            origins:    (nx*ny, 3) ray origins
            directions: (nx*ny, 3) unit directions
        """
        if nx is None:
            nx = self.resolution
        if ny is None:
            ny = self.resolution

        fwd = self.forward
        rgt = self.right
        up  = self.up

        half_fov_h = math.radians(self.fov / 2.0)
        # Assume square FOV (aspect = 1) for simplicity
        half_fov_v = half_fov_h

        # Pixel centers in NDC [-1, 1]
        xs = np.linspace(-1.0, 1.0, nx)
        ys = np.linspace(-1.0, 1.0, ny)
        gx, gy = np.meshgrid(xs, ys)
        gx = gx.ravel()  # (N,)
        gy = gy.ravel()  # (N,)

        # Convert NDC to world-space angles
        tan_h = math.tan(half_fov_h)
        tan_v = math.tan(half_fov_v)

        directions = (
            fwd[np.newaxis, :]                    # (1,3)
            + rgt[np.newaxis, :] * (gx[:, np.newaxis] * tan_h)   # (N,3)
            + up[np.newaxis, :]  * (gy[:, np.newaxis] * tan_v)   # (N,3)
        )  # (N, 3)

        norms = np.linalg.norm(directions, axis=1, keepdims=True)
        directions /= np.maximum(norms, 1e-12)

        origins = np.tile(self.position, (nx * ny, 1)).astype(np.float64)
        return origins, directions.astype(np.float64)

    def emit_random(self, count: int = 100) -> Tuple[np.ndarray, np.ndarray]:
        """
        Emit rays in random directions within the camera's FOV cone.

        Uses rejection sampling: sample uniformly in a square frustum,
        then keep those within the FOV cone.

        Args:
            count: Number of rays to emit.

        Returns:
            origins:    (count, 3) ray origins
            directions: (count, 3) unit directions
        """
        fwd = self.forward
        rgt = self.right
        up  = self.up
        half_fov = math.radians(self.fov / 2.0)
        tan_h = math.tan(half_fov)

        # Sample in square, reject outside cone
        directions = []
        rng = np.random.default_rng()

        while len(directions) < count:
            needed = count - len(directions)
            samples = rng.uniform(-1.0, 1.0, size=(needed * 2, 2))
            for s in samples:
                if len(directions) >= count:
                    break
                dx, dy = s[0] * tan_h, s[1] * tan_h
                d = fwd + rgt * dx + up * dy
                norm = np.linalg.norm(d)
                if norm > 1e-12:
                    directions.append(d / norm)

        directions_arr = np.array(directions[:count], dtype=np.float64)
        origins = np.tile(self.position, (count, 1)).astype(np.float64)
        return origins, directions_arr

    def to_dict(self) -> dict:
        """Serialize camera state for API responses."""
        return {
            "camera_id": self.camera_id,
            "position": list(self.position),
            "yaw": self.yaw,
            "pitch": self.pitch,
            "roll": self.roll,
            "fov": self.fov,
            "near": self.near,
            "far": self.far,
            "resolution": self.resolution,
            "forward": self.forward.tolist(),
            "right": self.right.tolist(),
            "up": self.up.tolist(),
        }


# Optional import guard for type hint below
from typing import Optional
