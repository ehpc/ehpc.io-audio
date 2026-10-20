# syntax=docker/dockerfile:1

FROM node:22-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY frontend/ ./
RUN npm run build


FROM python:3.13-slim-trixie AS audio-build
# Debian does not package libkeyfinder/keyfinder-cli. Build the maintained
# libkeyfinder 2.2.8 and CLI 1.1.2 from checksum-verified immutable commits.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake pkg-config libfftw3-dev \
    libavcodec-dev libavformat-dev libavutil-dev libswresample-dev \
    && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:6b9243c5c0c47ad9a66073c8caf41b1cd41fcf4e71f7231921a6ac3f797eac80 \
    https://codeload.github.com/mixxxdj/libkeyfinder/tar.gz/b33b5a88e04a5182dd19c38c57762925631118fd /tmp/libkeyfinder.tar.gz
ADD --checksum=sha256:201c50a27215622dc23770052c9a1094260680475a6e0e1781ccc60a0233a905 \
    https://codeload.github.com/evanpurkhiser/keyfinder-cli/tar.gz/4ca2934cbc72688d4da658645bb6c2170a58f9bb /tmp/keyfinder-cli.tar.gz
RUN mkdir /tmp/libkeyfinder /tmp/keyfinder-cli \
    && tar -xzf /tmp/libkeyfinder.tar.gz -C /tmp/libkeyfinder --strip-components=1 \
    && tar -xzf /tmp/keyfinder-cli.tar.gz -C /tmp/keyfinder-cli --strip-components=1 \
    && cmake -S /tmp/libkeyfinder -B /tmp/libkeyfinder/build \
        -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF -DBUILD_SHARED_LIBS=OFF \
        -DCMAKE_INSTALL_LIBDIR=lib \
    && cmake --build /tmp/libkeyfinder/build --parallel 2 \
    && cmake --install /tmp/libkeyfinder/build \
    && make -C /tmp/keyfinder-cli CXX="g++ -L/usr/local/lib" \
    && install -m 755 /tmp/keyfinder-cli/keyfinder-cli /usr/local/bin/keyfinder-cli \
    && strip /usr/local/bin/keyfinder-cli


FROM python:3.13-slim-trixie AS backend-build
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY separator/ ./separator/
COPY backend/ ./backend/
RUN uv sync --frozen --no-dev


FROM python:3.13-slim-trixie
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
