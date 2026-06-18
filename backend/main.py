"""
FastAPI Main Application - iOS Location Spoofing Service.

Serves:
- Web frontend (map interface for selecting locations)
- REST API for location management
- PAC file for proxy auto-configuration
- .mobileconfig profile download
- Static files
"""

import os
import sys
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware

from backend.routes.api import router as api_router
from backend.routes.pac import router as pac_router
from backend.routes.config_profile import router as config_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup/shutdown lifecycle."""
    print("[LocSpoof] Service starting...")
    print("[LocSpoof] API:  http://0.0.0.0:8000")
    print("[LocSpoof] Web:  http://0.0.0.0:8000/")
    print("[LocSpoof] PAC:  https://0.0.0.0:8000/proxy.pac")
    print("[LocSpoof] Profile: https://0.0.0.0:8000/install.mobileconfig")
    yield
    print("[LocSpoof] Service stopped.")


app = FastAPI(
    title="LocSpoof - iOS Location Spoofing Service",
    description="Virtual location service for iOS via VPN + MITM proxy",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS for development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
app.include_router(api_router)
app.include_router(pac_router)
app.include_router(config_router)

# Mount static files
static_dir = Path(__file__).parent.parent / "frontend" / "static"
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/", response_class=HTMLResponse)
async def serve_frontend():
    """Serve the web frontend."""
    index_path = Path(__file__).parent.parent / "frontend" / "index.html"
    if index_path.exists():
        return HTMLResponse(content=index_path.read_text(encoding="utf-8"))
    return HTMLResponse(content="<h1>LocSpoof</h1><p>Frontend not found.</p>")


@app.get("/health")
async def health_check():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "backend.main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
    )
