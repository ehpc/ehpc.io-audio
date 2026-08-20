import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse

from backend.queue import lifespan
from backend.routes import health, jobs, results, status

FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)


def create_app() -> FastAPI:
    fastapi_app = FastAPI(lifespan=lifespan)
    fastapi_app.include_router(health.router)
    fastapi_app.include_router(jobs.router, prefix="/api")
    fastapi_app.include_router(results.router, prefix="/api")
    fastapi_app.include_router(status.router, prefix="/api")

    if FRONTEND_DIST.is_dir():
        index = FRONTEND_DIST / "index.html"

        # Serve built static files, falling back to index.html so client-side
        # routes (e.g. /status) resolve on direct navigation. Registered last, so
        # the /api and /health routes above take precedence.
        @fastapi_app.get("/{full_path:path}")
        async def spa(full_path: str) -> FileResponse:
            candidate = FRONTEND_DIST / full_path
            if full_path and candidate.is_file():
                return FileResponse(candidate)
            return FileResponse(index)

    return fastapi_app


app = create_app()
