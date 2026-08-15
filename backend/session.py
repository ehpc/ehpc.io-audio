import uuid

from fastapi import Request, Response
from itsdangerous import BadSignature, URLSafeTimedSerializer

from backend import config

_serializer = URLSafeTimedSerializer(config.COOKIE_SECRET)


def get_session_id(request: Request, response: Response) -> str:
    cookie = request.cookies.get(config.SESSION_COOKIE_NAME)
    if cookie is not None:
        try:
            return _serializer.loads(cookie)
        except BadSignature:
            pass

    session_id = str(uuid.uuid4())
    response.set_cookie(
        config.SESSION_COOKIE_NAME,
        _serializer.dumps(session_id),
        max_age=config.COOKIE_MAX_AGE_S,
        httponly=True,
        samesite="lax",
        secure=config.COOKIE_SECURE,
    )
    return session_id
