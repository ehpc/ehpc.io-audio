from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from backend.queue import lifespan
from backend.routes import health, jobs, results

FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"


def create_app() -> FastAPI:
    fastapi_app = FastAPI(lifespan=lifespan)
    fastapi_app.include_router(health.router)
    fastapi_app.include_router(jobs.router, prefix="/api")
    fastapi_app.include_router(results.router, prefix="/api")
    if FRONTEND_DIST.is_dir():
        fastapi_app.mount(
            "/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend"
        )
    return fastapi_app


app = create_app()
