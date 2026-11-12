import asyncio
import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import TypeAdapter, ValidationError

from backend import auth_store, config, drain
from backend.queue import lifespan
from backend.routes import (
    admin_cache,
    auth,
    health,
    jobs,
    key_analysis,
    results,
    song_search,
    status,
)

FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
_JOB_ID = TypeAdapter(int)

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


class CacheAdmission:
    """Keep admission until the ASGI response body has finished streaming."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request = Request(scope)
        playback = (
            request.method in {"GET", "HEAD"}
            and request.url.path.startswith("/api/jobs/")
            and "playback" in request.query_params
        )
        path = request.url.path
        deletion = (
            request.method == "DELETE"
            and len(path.rstrip("/").split("/")) == 4
            and path.startswith("/api/jobs/")
        )
        if not (_expensive_work(request) or playback or deletion):
            await self.app(scope, receive, send)
            return
        if not await drain.state.enter():
            await JSONResponse({"detail": "Server is draining"}, status_code=503)(
                scope, receive, send
            )
            return
        try:
            await self.app(scope, receive, send)
        finally:
            drain.state.leave()


class JobAccess:
    """Track job-file requests through the final ASGI response body."""

    def __init__(self, app):
        self.app = app
        self.active: dict[int, int] = {}
        self.deleting: set[int] = set()

    def begin_delete(self, job_id: int) -> bool:
        if self.active.get(job_id, 0) or job_id in self.deleting:
            return False
        self.deleting.add(job_id)
        return True

    def end_delete(self, job_id: int) -> None:
        self.deleting.remove(job_id)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        scope.setdefault("state", {})["job_access"] = self
        parts = scope["path"].strip("/").split("/")
        if (
            len(parts) < 4
            or parts[:2] != ["api", "jobs"]
            or parts[3] not in {"original", "results", "pitch-reference", "retry"}
        ):
            await self.app(scope, receive, send)
            return
        try:
            job_id = _JOB_ID.validate_python(parts[2])
        except ValidationError:
            await self.app(scope, receive, send)
            return
        if job_id in self.deleting:
            await JSONResponse({"detail": "Job not found"}, status_code=404)(
                scope, receive, send
            )
            return
        self.active[job_id] = self.active.get(job_id, 0) + 1
        try:
            await self.app(scope, receive, send)
        finally:
            count = self.active[job_id] - 1
            if count:
                self.active[job_id] = count
            else:
                del self.active[job_id]


def create_app() -> FastAPI:
    fastapi_app = FastAPI(lifespan=lifespan)
    fastapi_app.add_middleware(JobAccess)

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

    fastapi_app.add_middleware(CacheAdmission)

    fastapi_app.include_router(admin_cache.router, prefix="/api")
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
