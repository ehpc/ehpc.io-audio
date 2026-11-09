"""Submit authentication messages through the local, restricted SMTP socket."""

import smtplib
import socket
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

from backend import config


class UnixSMTP(smtplib.SMTP):
    def _get_socket(self, host: str, port: int, timeout: float) -> socket.socket:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        try:
            sock.connect(config.AUTH_SMTP_SOCKET)
        except BaseException:
            sock.close()
            raise
        return sock


def send_code(recipient: str, code: str) -> None:
    message = EmailMessage()
    message["From"] = "no-reply@auth.ehpc.io"
    message["To"] = recipient
    message["Subject"] = "Your audio tools verification code"
    message["Date"] = formatdate(localtime=False)
    message["Message-ID"] = make_msgid(domain="auth.ehpc.io")
    message.set_content(
        f"Your verification code is {code}. It expires in 10 minutes.\n"
    )
    with UnixSMTP("localhost", timeout=10) as smtp:
        smtp.send_message(
            message, from_addr="bounce@auth.ehpc.io", to_addrs=[recipient]
        )
