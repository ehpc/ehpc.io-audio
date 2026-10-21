# syntax=docker/dockerfile:1

FROM node:22-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY frontend/ ./
RUN npm run build


FROM python:3.15-slim-trixie AS audio-build
# Debian does not package libkeyfinder/keyfinder-cli; the shared build script
# pins and checksum-verifies upstream source archives for CI and image builds.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake pkg-config patch curl ca-certificates libfftw3-dev \
    libavcodec-dev libavformat-dev libavutil-dev libswresample-dev \
    && rm -rf /var/lib/apt/lists/*
COPY .github/scripts/build-keyfinder.sh /usr/local/bin/build-keyfinder
RUN /usr/local/bin/build-keyfinder


FROM python:3.15-slim-trixie AS backend-build
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY separator/ ./separator/
COPY backend/ ./backend/
RUN uv sync --frozen --no-dev


FROM python:3.15-slim-trixie
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg rubberband-cli libfftw3-double3 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 app
# yt-dlp needs a JS runtime to solve YouTube's anti-bot challenge on some
# downloads (returns HTTP 403 otherwise); deno is its default-supported one.
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno
COPY --from=audio-build /usr/local/bin/keyfinder-cli /usr/local/bin/keyfinder-cli
WORKDIR /app
COPY --from=backend-build /app/.venv ./.venv
COPY --from=backend-build /app/separator ./separator
COPY --from=backend-build /app/backend ./backend
COPY --from=frontend-build /app/frontend/dist ./frontend/dist
ENV PATH="/app/.venv/bin:$PATH"
USER app
EXPOSE 8000
# replicas: 1 only — the sqlite file, the in-process job-claim lock, and the SSE
# pub/sub in backend/events.py all assume a single process, so no --workers flag.
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
