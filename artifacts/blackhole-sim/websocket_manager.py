"""
websocket_manager.py — WebSocket connection manager and frame broadcaster.

Manages all connected WebSocket clients and broadcasts simulation frames
at up to WS_FPS_CAP frames per second.
"""

from __future__ import annotations
import asyncio
import json
import logging
import time
from typing import Dict, List, Any, Optional
from fastapi import WebSocket, WebSocketDisconnect

from config import WS_FPS_CAP, BATCH_SIZE

logger = logging.getLogger(__name__)


class ConnectionManager:
    """
    Manages active WebSocket connections and broadcasts frames.

    Thread-safe for asyncio — all methods are coroutines or
    synchronous operations on asyncio primitives.
    """

    def __init__(self) -> None:
        self.active: List[WebSocket] = []
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        """Accept and register a new WebSocket connection."""
        await ws.accept()
        async with self._lock:
            self.active.append(ws)
        logger.info("WebSocket connected. Total clients: %d", len(self.active))

    async def disconnect(self, ws: WebSocket) -> None:
        """Remove a disconnected WebSocket."""
        async with self._lock:
            if ws in self.active:
                self.active.remove(ws)
        logger.info("WebSocket disconnected. Total clients: %d", len(self.active))

    async def broadcast(self, payload: Dict[str, Any]) -> None:
        """
        Broadcast a JSON payload to all connected clients.

        Dead connections are removed silently.
        """
        if not self.active:
            return

        message = json.dumps(payload, default=_json_serializer)
        dead: List[WebSocket] = []

        async with self._lock:
            clients = list(self.active)

        results = await asyncio.gather(
            *[ws.send_text(message) for ws in clients],
            return_exceptions=True,
        )
        dead = [ws for ws, result in zip(clients, results) if isinstance(result, Exception)]

        if dead:
            async with self._lock:
                for ws in dead:
                    if ws in self.active:
                        self.active.remove(ws)

    async def broadcast_text(self, text: str) -> None:
        """Broadcast a pre-serialized text message."""
        if not self.active:
            return
        dead: List[WebSocket] = []
        async with self._lock:
            clients = list(self.active)
        results = await asyncio.gather(
            *[ws.send_text(text) for ws in clients],
            return_exceptions=True,
        )
        dead = [ws for ws, result in zip(clients, results) if isinstance(result, Exception)]
        if dead:
            async with self._lock:
                for ws in dead:
                    if ws in self.active:
                        self.active.remove(ws)

    @property
    def client_count(self) -> int:
        return len(self.active)


def _json_serializer(obj: Any) -> Any:
    """JSON serializer for numpy types and tuples."""
    import numpy as np
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.floating):
        return float(obj)
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if isinstance(obj, tuple):
        return list(obj)
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


class SimulationBroadcaster:
    """
    Rate-limited frame broadcaster for the running simulation.

    Caps output at WS_FPS_CAP frames per second.
    Accumulates ray position updates and pushes them per frame.
    """

    def __init__(self, manager: ConnectionManager) -> None:
        self._manager = manager
        self._frame = 0
        self._last_push = 0.0
        self._min_interval = 1.0 / WS_FPS_CAP

    def reset(self) -> None:
        self._frame = 0
        self._last_push = 0.0

    async def push_frame(
        self,
        rays_data: List[Dict],
        active_count: int,
        fps: float,
        simulation_time: float,
    ) -> None:
        """
        Push a simulation frame to all clients if enough time has elapsed.

        Args:
            rays_data:       List of serialized ray dicts (incremental or full)
            active_count:    Number of currently active rays
            fps:             Current simulation frame rate
            simulation_time: Total elapsed simulation time
        """
        now = time.monotonic()
        elapsed = now - self._last_push
        if elapsed < self._min_interval:
            await asyncio.sleep(self._min_interval - elapsed)

        self._frame += 1
        self._last_push = time.monotonic()

        payload = {
            "type": "frame",
            "frame": self._frame,
            "rays": rays_data,
            "active_rays": active_count,
            "fps": round(fps, 1),
            "simulation_time": round(simulation_time, 4),
        }

        await self._manager.broadcast(payload)

    async def push_status(self, message: str, data: Optional[Dict] = None) -> None:
        """Push a status/control message to all clients."""
        payload = {"type": "status", "message": message}
        if data:
            payload.update(data)
        await self._manager.broadcast(payload)

    async def push_complete(self, total_rays: int, stats: Dict) -> None:
        """Push simulation complete notification."""
        payload = {
            "type": "complete",
            "total_rays": total_rays,
            "stats": stats,
        }
        await self._manager.broadcast(payload)
