import asyncio
import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from backend import auth_store, config, drain
from backend.queue import lifespan
from backend.routes import (
    auth,
    health,
    jobs,
    key_analysis,
    results,
    song_search,
    status,
)

FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)


def _expensive_work(request: Request) -> bool:
    path = request.url.path
    return request.method not in {"GET", "HEAD", "OPTIONS"} and (
        path in {"/api/jobs", "/api/song-search", "/api/key-analysis"}
        or path.endswith("/retry")
        or path.endswith("/pitch-reference/vocals")
    )


def create_app() -> FastAPI:
    fastapi_app = FastAPI(lifespan=lifespan)

    @fastapi_app.middleware("http")
    async def access_control(request: Request, call_next):
        path = request.url.path
        if not (path == "/api" or path.startswith("/api/")):
            return await call_next(request)
        unsafe = request.method not in {"GET", "HEAD", "OPTIONS"}
        if unsafe and (
            not config.AUTH_ORIGIN
            or request.headers.get("origin") != config.AUTH_ORIGIN
        ):
            return JSONResponse({"detail": "Invalid origin"}, status_code=403)
        public = path in {"/api/auth/start", "/api/auth/verify"}
        user = None
        if not public:
            token = request.cookies.get(auth.cookie_name(), "")
            user = await asyncio.to_thread(
                auth_store.authenticate, token, activity=unsafe
            )
            if user is None:
                return JSONResponse(
                    {"detail": "Authentication required"}, status_code=401
                )
            if path == "/api/status" and not user.is_admin:
                return JSONResponse(
                    {"detail": "Administrator required"}, status_code=403
                )
            request.state.principal = user
            if _expensive_work(request) and not await asyncio.to_thread(
                auth_store.reserve_work, user.id
            ):
                return JSONResponse(
                    {"detail": "Workload limit reached"}, status_code=429
                )
        response = await call_next(request)
        if user is not None and unsafe and path != "/api/auth/logout":
            response.set_cookie(
                auth.cookie_name(),
                request.cookies[auth.cookie_name()],
                max_age=auth_store.SESSION_IDLE,
                httponly=True,
                secure=config.auth_cookie_secure(),
                samesite="lax",
                path="/",
            )
        return response

    @fastapi_app.middleware("http")
    async def drain_admission(request: Request, call_next):
        if not _expensive_work(request):
            return await call_next(request)
        if not await drain.state.enter():
            return JSONResponse({"detail": "Server is draining"}, status_code=503)
        try:
            return await call_next(request)
        finally:
            drain.state.leave()

    fastapi_app.include_router(auth.router, prefix="/api")
    fastapi_app.include_router(health.router)
    fastapi_app.include_router(jobs.router, prefix="/api")
    fastapi_app.include_router(results.router, prefix="/api")
    fastapi_app.include_router(key_analysis.router, prefix="/api")
    fastapi_app.include_router(status.router, prefix="/api")
    fastapi_app.include_router(song_search.router, prefix="/api")

    if FRONTEND_DIST.is_dir():
        root = FRONTEND_DIST.resolve()
        index = (root / "index.html").resolve()

        # Serve built static files, falling back to index.html so client-side
        # routes (e.g. /status) resolve on direct navigation. Registered last, so
        # the /api and /health routes above take precedence.
        @fastapi_app.get("/{full_path:path}")
        async def spa(full_path: str) -> FileResponse:
            try:
                candidate = (root / full_path).resolve()
            except (OSError, ValueError):
                raise HTTPException(404, "not found") from None
            if not candidate.is_relative_to(root) or not index.is_relative_to(root):
                raise HTTPException(404, "not found")
            if full_path and candidate.is_file():
                return FileResponse(candidate)
            return FileResponse(index)

    return fastapi_app


app = create_app()
