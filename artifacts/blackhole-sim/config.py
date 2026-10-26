"""
config.py — All tuneable constants for the Black Hole Light Ray Simulation.
All physical constants use SI units internally but display in convenient units.
"""

# ─── Physical Constants ───────────────────────────────────────────────────────
G: float = 6.674e-11          # Gravitational constant (m³ kg⁻¹ s⁻²)
C: float = 2.998e8             # Speed of light (m/s)

# ─── Black Hole Defaults ──────────────────────────────────────────────────────
DEFAULT_MASS: float = 1.0      # Solar masses (scaled; dimensionless in sim units)
MIN_MASS: float = 0.1
MAX_MASS: float = 100.0

# ─── Simulation Units ─────────────────────────────────────────────────────────
# We work in "geometric units" where G = c = 1 and M = DEFAULT_MASS.
# rs = 2M in these units.

# ─── Numerical Integration ────────────────────────────────────────────────────
DEFAULT_DT: float = 0.05       # Default time step (in simulation units)
MIN_DT: float = 0.001
MAX_DT: float = 0.1
DEFAULT_MAX_STEPS: int = 2000  # Maximum integration steps per ray
MIN_STEPS: int = 100
MAX_STEPS: int = 10000

# ─── Ray Escape / Boundary ────────────────────────────────────────────────────
R_MAX: float = 200.0           # Escape radius in units of rs
R_ABSORB_FACTOR: float = 1.02  # Absorb if r < rs * this factor

# ─── Camera Defaults ──────────────────────────────────────────────────────────
DEFAULT_CAMERA_DISTANCE: float = 10.0   # In units of rs
DEFAULT_FOV: float = 60.0              # degrees
DEFAULT_YAW: float = 0.0
DEFAULT_PITCH: float = 0.0
DEFAULT_ROLL: float = 0.0
DEFAULT_NEAR: float = 0.1
DEFAULT_FAR: float = 500.0
DEFAULT_RESOLUTION: int = 64            # NxN grid resolution

# ─── Accretion Disk ───────────────────────────────────────────────────────────
DISK_INNER_RADIUS: float = 3.0   # In units of rs (ISCO ≈ 3rs for Schwarzschild)
DISK_OUTER_RADIUS: float = 15.0  # In units of rs
DISK_THICKNESS: float = 0.1
DISK_BRIGHTNESS: float = 1.0

# ─── WebSocket / Server ───────────────────────────────────────────────────────
WS_FPS_CAP: float = 60.0          # Max frames per second pushed over WebSocket
WS_HOST: str = "0.0.0.0"
WS_PORT: int = 8000
BATCH_SIZE: int = 50               # Rays per WebSocket batch

# ─── Scene ────────────────────────────────────────────────────────────────────
STAR_INTENSITY: float = 1.0
PHOTON_SPHERE_OPACITY: float = 0.35

# ─── Orbit detection ─────────────────────────────────────────────────────────
ORBIT_DETECTION_REVOLUTIONS: float = 3.0  # Flag orbit after this many turns
