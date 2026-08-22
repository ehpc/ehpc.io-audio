SHELL := $(shell which bash)

.PHONY: init lint test test-frontend smoke dev deploy-modal update-yt-dlp dropbox-ignore

init:
	uv sync
	cd frontend && npm install
	$(MAKE) dropbox-ignore

# Keep build artifacts out of Dropbox sync. When this repo lives in a synced
# folder, Dropbox strips the executable bit off .venv scripts (uvicorn ->
# "Permission denied") and breaks node_modules symlinks (vite -> not found).
# macOS/Dropbox only; a no-op everywhere else.
dropbox-ignore:
	-command -v xattr >/dev/null 2>&1 && xattr -w com.dropbox.ignored 1 .venv frontend/node_modules 2>/dev/null || true

update-yt-dlp:
	uv lock --upgrade-package yt-dlp
	uv sync

lint:
	uv run ruff format .
	uv run ruff check --fix .
	uv run ty check

test:
	uv run pytest

test-frontend:
	cd frontend && npm run test

smoke:
	uv run pytest -m smoke

dev:
	mkdir -p dev-data
	@test -d frontend/node_modules || (cd frontend && npm install)
	trap 'kill 0' EXIT; \
	(DATA_DIR=$(CURDIR)/dev-data QUEUE_CONCURRENCY=1 uv run uvicorn backend.main:app --reload --reload-dir backend --reload-dir separator --port 8000 2>&1 | sed -e 's/^/[backend] /') & \
	(cd frontend && npm run dev 2>&1 | sed -e 's/^/[frontend] /') & \
	wait

deploy-modal:
	uv run modal deploy separator/modal_app.py
