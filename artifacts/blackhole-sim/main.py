"""
main.py — FastAPI application entry point for the Black Hole Light Ray Simulation.

API Routes:
  GET  /           → Serve frontend index.html
  GET  /system     → Black hole + simulation parameters
  POST /camera     → Update camera placement
  POST /rays       → Emit rays and start simulation
  POST /reset      → Clear simulation state
  WS   /live       → Real-time ray streaming WebSocket

Static files:
  /static/         → frontend/css, frontend/js
"""

from __future__ import annotations
import asyncio
import logging
import os
import sys
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from config import WS_HOST, WS_PORT
from websocket_manager import ConnectionManager, SimulationBroadcaster
from simulation import SimulationEngine
from renderer.camera import Camera

# ── Logging setup ─────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)

# ── FastAPI app ────────────────────────────────────────────────────────────────
app = FastAPI(
    title="Black Hole Light Ray Simulation",
    description="Real-time Schwarzschild photon geodesic simulation",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Mount static frontend files ───────────────────────────────────────────────
FRONTEND_DIR = Path(__file__).parent / "frontend"
app.mount(
    "/static",
    StaticFiles(directory=str(FRONTEND_DIR), html=True),
    name="static",
)

@app.middleware("http")
async def no_cache_middleware(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/static") or request.url.path == "/":
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

# ── Global singletons ─────────────────────────────────────────────────────────
manager = ConnectionManager()
broadcaster = SimulationBroadcaster(manager)
engine = SimulationEngine()
_sim_task: Optional[asyncio.Task] = None

# ── Pydantic models ───────────────────────────────────────────────────────────

class CameraRequest(BaseModel):
    position:   list[float] = Field(default=[10.0, 0.0, 0.0], min_length=3, max_length=3)
    yaw:        float = Field(default=180.0, ge=-180, le=360)
    pitch:      float = Field(default=0.0, ge=-90, le=90)
    roll:       float = Field(default=0.0, ge=-180, le=180)
    fov:        float = Field(default=60.0, ge=10, le=120)
    near:       float = Field(default=0.1, gt=0)
    far:        float = Field(default=500.0, gt=1)
    resolution: int   = Field(default=16, ge=1, le=64)


class RaysRequest(BaseModel):
    mode:  str = Field(default="fan", pattern="^(single|fan|cone|grid|random)$")
    count: int = Field(default=20, ge=1, le=5000)


class PhysicsRequest(BaseModel):
    mass:      Optional[float] = Field(default=None, ge=0.1, le=100)
    dt:        Optional[float] = Field(default=None, ge=0.001, le=0.5)
    max_steps: Optional[int]   = Field(default=None, ge=100, le=10000)
    use_adaptive: Optional[bool] = None


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def serve_frontend() -> HTMLResponse:
    """Serve the Three.js frontend."""
    index_path = FRONTEND_DIR / "index.html"
    if not index_path.exists():
        return HTMLResponse("<h1>Frontend not found</h1>", status_code=404)
    response = HTMLResponse(index_path.read_text(encoding="utf-8"))
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


@app.get("/system")
async def get_system() -> dict:
    """Return current black hole and simulation parameters."""
    return engine.get_system_info()


@app.post("/camera")
async def update_camera(req: CameraRequest) -> dict:
    """
    Place the camera at a new position with given orientation.

    The camera is a real imaging sensor that will emit rays
    when /rays is called.
    """
    engine.camera = Camera(
        position=tuple(req.position),  # type: ignore[arg-type]
        yaw=req.yaw,
        pitch=req.pitch,
        roll=req.roll,
        fov=req.fov,
        near=req.near,
        far=req.far,
        resolution=req.resolution,
    )
    logger.info("Camera updated: pos=%s yaw=%.1f pitch=%.1f fov=%.1f",
                req.position, req.yaw, req.pitch, req.fov)
    return {"success": True, "camera": engine.camera.to_dict()}


@app.post("/physics")
async def update_physics(req: PhysicsRequest) -> dict:
    """Update black hole and integrator parameters."""
    if req.mass is not None:
        engine.black_hole.mass = req.mass
    if req.dt is not None:
        engine.config.dt = req.dt
    if req.max_steps is not None:
        engine.config.max_steps = req.max_steps
    if req.use_adaptive is not None:
        engine.config.use_adaptive = req.use_adaptive
    return {"success": True, "system": engine.get_system_info()}


@app.post("/rays")
async def emit_rays(req: RaysRequest) -> dict:
    """
    Emit rays from the current camera and start the simulation.

    Stops any running simulation first, then starts a new async task
    that integrates rays and streams frames over WebSocket /live.
    """
    global _sim_task

    # Stop any existing simulation
    if _sim_task and not _sim_task.done():
        engine.stop()
        _sim_task.cancel()
        try:
            await asyncio.wait_for(_sim_task, timeout=2.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass

    engine.reset()
    broadcaster.reset()

    # Generate ray origins and directions from camera
    cam = engine.camera
    mode = req.mode.lower()
    count = req.count

    if mode == "single":
        origins, directions = cam.emit_single()
    elif mode == "fan":
        origins, directions = cam.emit_fan(count=count)
    elif mode == "cone":
        origins, directions = cam.emit_cone(count=count)
    elif mode == "grid":
        n = max(1, int(count ** 0.5))
        origins, directions = cam.emit_grid(nx=n, ny=n)
        count = n * n
    elif mode == "random":
        origins, directions = cam.emit_random(count=count)
    else:
        raise HTTPException(status_code=400, detail=f"Unknown ray mode: {mode}")

    engine.setup_rays(origins, directions)

    # Launch background integration task
    _sim_task = asyncio.create_task(engine.run_async(broadcaster))

    logger.info("Rays emitted: mode=%s count=%d", mode, len(engine.rays))
    return {
        "success": True,
        "ray_count": len(engine.rays),
        "mode": mode,
        "camera": cam.to_dict(),
    }


@app.post("/reset")
async def reset_simulation() -> dict:
    """Clear all rays and halt simulation."""
    global _sim_task
    engine.stop()
    if _sim_task and not _sim_task.done():
        _sim_task.cancel()
        try:
            await asyncio.wait_for(_sim_task, timeout=1.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
    engine.reset()
    broadcaster.reset()
    await broadcaster.push_status("reset")
    return {"success": True}


# ── WebSocket ─────────────────────────────────────────────────────────────────

@app.websocket("/live")
async def websocket_endpoint(ws: WebSocket) -> None:
    """
    WebSocket endpoint for real-time ray streaming.

    Server pushes frames:
    {
        "type": "frame",
        "frame": N,
        "rays": [{"id":0, "new_positions":[[x,y,z],...], "status":"ACTIVE", ...}],
        "active_rays": 128,
        "fps": 60.0,
        "simulation_time": 1.23
    }
    """
    await manager.connect(ws)
    try:
        # Send current system state on connect
        await ws.send_json({
            "type": "connected",
            "system": engine.get_system_info(),
        })
        # Keep connection alive (simulation pushes are handled by broadcaster)
        while True:
            try:
                data = await asyncio.wait_for(ws.receive_text(), timeout=30.0)
                # Echo pings
                if data == "ping":
                    await ws.send_text("pong")
            except asyncio.TimeoutError:
                # Send keepalive
                await ws.send_json({"type": "keepalive"})
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning("WebSocket error: %s", e)
    finally:
        await manager.disconnect(ws)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Windows: ProactorEventLoop (the default on Windows) does not support
    # the selector-based I/O that uvicorn's WebSocket handling requires.
    # Switching to WindowsSelectorEventLoopPolicy fixes WebSocket connectivity.
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    port = int(os.environ.get("PORT", WS_PORT))
    logger.info("Starting Black Hole Simulation server on port %d", port)
    uvicorn.run(
        "main:app",
        host=WS_HOST,
        port=port,
        log_level="info",
        reload=False,
    )
