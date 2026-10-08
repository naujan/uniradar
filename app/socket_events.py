from datetime import datetime, timezone

from flask import request, session
from flask_socketio import emit, join_room

from . import db, socketio
from .models import User


MAIN_ROOM = "main"
CHAT_NAMESPACE = "/chat"
UPDATES_NAMESPACE = "/updates"


def get_logged_user():
    user_id = session.get("user_id")

    if user_id is None:
        return None

    return db.session.get(User, user_id)


# =========================================================
# PUBLICZNE AKTUALIZACJE STRONY
# =========================================================

@socketio.on("connect", namespace=UPDATES_NAMESPACE)
def handle_updates_connect(auth=None):
    # Ten kanał jest publiczny.
    # Gość też musi dostawać informacje o zmianach na mapie.
    emit(
        "updates_ready",
        {"ok": True},
        to=request.sid,
    )


@socketio.on("disconnect", namespace=UPDATES_NAMESPACE)
def handle_updates_disconnect(reason=None):
    pass


# =========================================================
# CZAT - TYLKO ZALOGOWANI
# =========================================================

@socketio.on("connect", namespace=CHAT_NAMESPACE)
def handle_chat_connect(auth=None):
    user = get_logged_user()

    if user is None:
        return False

    join_room(MAIN_ROOM)

    emit(
        "chat_ready",
        {
            "room": MAIN_ROOM,
            "user_id": user.id,
            "nickname": user.nickname,
            "role": user.role,
        },
        to=request.sid,
    )




@socketio.on("chat_message", namespace=CHAT_NAMESPACE)
def handle_chat_message(data):
    user = get_logged_user()

    if user is None:
        emit(
            "chat_error",
            {"error": "Musisz być zalogowany."},
            to=request.sid,
        )

        return {
            "ok": False,
            "error": "Not authenticated",
        }

    if not isinstance(data, dict):
        return {
            "ok": False,
            "error": "Invalid payload",
        }

    message = str(data.get("message", "")).strip()

    if not message:
        return {
            "ok": False,
            "error": "Wiadomość nie może być pusta.",
        }

    if len(message) > 500:
        return {
            "ok": False,
            "error": "Maksymalnie 500 znaków.",
        }

    payload = {
        "user_id": user.id,
        "nickname": user.nickname,
        "role": user.role,
        "message": message,
        "sent_at": datetime.now(timezone.utc).isoformat(),
    }

    emit(
        "chat_message",
        payload,
        to=MAIN_ROOM,
    )

    return {"ok": True}


@socketio.on("disconnect", namespace=CHAT_NAMESPACE)
def handle_chat_disconnect(reason=None):
    user = get_logged_user()

    if user is None:
        return
