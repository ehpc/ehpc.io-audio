"""HTTP response flushing while real Unix SMTP submission is blocked."""

import socket
import socketserver
import threading

import httpx
import uvicorn

from backend import auth_store, config
from backend.main import app


class BlockedServer(socketserver.UnixStreamServer):
    entered: threading.Event
    release: threading.Event


class BlockedSMTP(socketserver.StreamRequestHandler):
    def handle(self):
        assert isinstance(self.server, BlockedServer)
        self.server.entered.set()
        self.server.release.wait(5)
        self.wfile.write(b"220 fixture ready\r\n")
        while self.rfile.readline():
            self.wfile.write(b"250 ok\r\n")


def test_start_flushes_before_smtp_reply(tmp_path, monkeypatch):
    monkeypatch.undo()  # use the real Unix adapter, not the ordinary test capture
    monkeypatch.setattr(config, "AUTH_SMTP_SOCKET", str(tmp_path / "blocked.sock"))
    smtp = BlockedServer(config.AUTH_SMTP_SOCKET, BlockedSMTP)
    smtp.entered, smtp.release = threading.Event(), threading.Event()
    smtp_thread = threading.Thread(target=smtp.serve_forever, daemon=True)
    smtp_thread.start()
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    port = listener.getsockname()[1]
    monkeypatch.setattr(config, "AUTH_ORIGIN", f"http://127.0.0.1:{port}")
    server = uvicorn.Server(uvicorn.Config(app, lifespan="off", log_level="error"))
    thread = threading.Thread(
        target=server.run, kwargs={"sockets": [listener]}, daemon=True
    )
    thread.start()
    try:
        _, code = auth_store.create_invite(None)
        with httpx.Client(
            base_url=config.AUTH_ORIGIN,
            headers={"origin": config.AUTH_ORIGIN},
            timeout=3,
        ) as client:
            response = client.post(
                "/api/auth/start",
                json={"email": "blocked@example.com", "invite_code": code},
            )
            assert response.status_code == 202
            assert smtp.entered.wait(2)
    finally:
        smtp.release.set()
        server.should_exit = True
        thread.join(10)
        smtp.shutdown()
        smtp.server_close()
        smtp_thread.join(5)
        listener.close()
