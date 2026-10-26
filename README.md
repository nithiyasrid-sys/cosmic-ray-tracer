# 🌌 Black Hole Relativistic Simulation

A real-time, scientifically-inspired black hole visualization built with **Python (FastAPI)** on the backend and **Three.js / WebGL** on the frontend. The renderer simulates Schwarzschild geodesic ray-marching to produce an Interstellar-style cinematic view of a black hole and its accretion disk.

![Black Hole Simulation Preview](https://github.com/user-attachments/assets/placeholder)

---

## ✨ Features

- **Volumetric Accretion Disk** — Thick, physically-motivated disk with a hot color gradient (cream-yellow → orange → deep red) and swirling turbulent plasma filaments.
- **Gravitational Lensing** — Ray-marched Schwarzschild geodesics bend light around the event horizon, producing upper/lower lensed arcs and a rear Einstein ring.
- **Keplerian Doppler Beaming** — Approaching (left) disk side appears brighter and bluish-white; receding (right) side is dimmed and reddish.
- **Photon Ring** — Sharp Lorentzian-profile photon sphere ring at 1.5 r_s outlines the black hole shadow.
- **Live HUD Readouts** — FPS counter, Schwarzschild radius, and live gravitational time dilation / redshift computed every frame from camera distance.
- **Source Position Radar Console** — Dedicated bottom-left interactive radar minimap (top-down polar orbit view) with click-to-place navigation, live XYZ coordinates, and quick preset buttons (`Behind BH`, `Disk Edge`, `North Pole`, `Equator`).
- **Precision Light Source Controller** — Dedicated distance, orbital angle, and elevation sliders with an automatic "Lock Facing Singularity" mechanism that ensures the beam and pointer always target $(0,0,0)$.
- **Cinematic Post-Processing** — Softened bloom, tone mapping, vignette, and subtle chromatic aberration tuned to eliminate blinding white glare while preserving accretion disk textures.
- **Interactive Light Source** — Draggable 3D reticle eyepiece that dynamically turns black when inside the bright disk zone and yellow against dark sky.
- **Equatorial Spatial Grid** — Polar grid plane for spatial reference around the singularity.
- **Real-time Ray Simulation** — Python backend integrates photon geodesics (RK4/RK45) and streams results via WebSocket.
- **Tabbed Control UI** — Camera & Source, Settings, Simulation, and Help panels in a clean sci-fi sidebar.

---

## 🛠 Requirements

- **Python 3.12+**
- pip (or any package manager)

No Node.js required — all frontend assets are served directly by the FastAPI server.

---

## 🚀 Running the Project

### Option 1 — Windows (Recommended)

Double-click **`run.bat`** inside `artifacts/blackhole-sim/`, or run from a terminal:

```bat
cd artifacts\blackhole-sim
run.bat
```

### Option 2 — PowerShell

```powershell
cd artifacts\blackhole-sim
.\run.ps1
```

### Option 3 — Manual (any platform)

```bash
# 1. Move into the project folder
cd artifacts/blackhole-sim

# 2. Create and activate a virtual environment (optional but recommended)
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
source .venv/bin/activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. Start the server
python main.py
```

Then open your browser at **[http://localhost:8000](http://localhost:8000)**.

---

## 📁 Project Structure

```
artifacts/blackhole-sim/
├── main.py                 # FastAPI app — routes, WebSocket, static file serving
├── config.py               # Server host/port and simulation defaults
├── simulation.py           # Photon geodesic simulation engine
├── websocket_manager.py    # WebSocket connection and broadcast manager
├── requirements.txt        # Python dependencies
├── run.bat                 # Windows one-click launcher
├── run.ps1                 # PowerShell launcher
│
├── physics/
│   ├── geodesic.py         # Geodesic ray integrator (RK4 / RK45)
│   ├── integrator.py       # Numerical integrators
│   ├── ray.py              # Photon ray data model
│   └── schwarzschild.py    # Schwarzschild metric & equations of motion
│
├── renderer/
│   └── camera.py           # Camera placement / frustum helper
│
└── frontend/
    ├── index.html          # Cinematic HUD layout
    ├── css/
    │   └── style.css       # Sci-fi glassmorphism UI styling
    └── js/
        ├── scene.js        # Three.js renderer + GLSL ray-marching shader
        ├── controls.js     # Slider bindings → API calls
        ├── renderer.js     # HUD update module
        ├── websocket.js    # WebSocket client — receives ray stream
        ├── qpo.js          # QPO spectrum canvas
        └── recorder.js     # WebM video recorder
```

---

## 🎮 Controls

| Action | How |
|---|---|
| Orbit camera | Left-click + drag on the background |
| Zoom | Scroll wheel |
| Move light source via Radar | Click or drag on the **bottom-left Radar minimap** |
| Move light source via Sliders | Adjust `Source Dist`, `Orbit Angle`, and `Elevation` in Camera & Source panel |
| Quick Source Presets | Click `BEHIND BH`, `DISK EDGE`, `NORTH POLE`, or `EQUATOR` in the bottom-left console |
| Move light source in 3D | Left-click + drag the yellow/black reticle in the viewport |
| Reposition light source | Double-click anywhere on screen |
| Fine-tune source position | Arrow keys / WASD |
| Lock light source | Check `Lock 3D Drag` in the Camera & Source panel |
| Reset camera | Press **R** |
| Toggle panels | Camera / Settings / Simulation / Help buttons in right toolbar |

---

## 🔬 Physics Notes

- **Metric:** Schwarzschild vacuum solution ( M=1, G=c=1 units)
- **Ray bending:** Numerical integration of null geodesics using the effective potential approximation: `a = -1.5 * rs * h² * p / r⁵`
- **Disk model:** Keplerian orbital velocity profile; Doppler factor `D = 1 / (γ (1 − β·cos θ))` clamped to avoid over-brightness
- **Photon ring radius:** 1.5 rₛ (photon sphere)
- **Time dilation at camera:** `γ = 1 / √(1 − rₛ/r)` displayed live in HUD

---

## 📦 Dependencies

| Package | Purpose |
|---|---|
| `fastapi` | Web framework & API |
| `uvicorn` | ASGI server |
| `numpy` | Numerical arrays |
| `scipy` | ODE integrators (RK45) |
| `pydantic` | Request validation |
| Three.js r128 (CDN) | 3D WebGL rendering |
| UnrealBloomPass (CDN) | HDR bloom post-processing |

---

## 📄 License

MIT — free to use, modify, and distribute.
