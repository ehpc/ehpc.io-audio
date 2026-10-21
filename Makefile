SHELL := $(shell which bash)

# The project lives in a Dropbox-synced folder; a venv is platform-specific
# (absolute shebangs, native binaries), so syncing it between machines corrupts
# it. Keep it outside the synced tree. CI doesn't use make, so it's unaffected.
UV_PROJECT_ENVIRONMENT ?= $(HOME)/.cache/vocals-tools/venv
export UV_PROJECT_ENVIRONMENT

.PHONY: init lint test test-frontend test-e2e smoke dev deploy-modal update-yt-dlp dropbox-ignore

init:
	uv sync
	cd frontend && npm install
	$(MAKE) dropbox-ignore

# Keep node_modules out of Dropbox sync — syncing it between machines breaks the
# .bin symlinks (vite -> not found) and installs the wrong-platform binaries.
# (.venv lives outside the tree via UV_PROJECT_ENVIRONMENT.) macOS/Dropbox only.
dropbox-ignore:
	-command -v xattr >/dev/null 2>&1 && xattr -w com.dropbox.ignored 1 frontend/node_modules 2>/dev/null || true

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

test-e2e:
	@test -n "$${E2E_MODAL_APP_NAME:-}" || { echo "Set E2E_MODAL_APP_NAME to an isolated Modal app." >&2; exit 2; }
	@test "$${E2E_MODAL_APP_NAME}" != "audio-separator" || { echo "Refusing to run E2E against the production Modal app." >&2; exit 2; }
	npm --prefix frontend run test:e2e

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
