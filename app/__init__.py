import os

from flask import Flask, render_template
from flask_socketio import SocketIO
from flask_sqlalchemy import SQLAlchemy


db = SQLAlchemy()
socketio = SocketIO(async_mode="threading")


def create_app(test_config=None):
    app = Flask(__name__)

    app.config.update(
        SECRET_KEY=os.environ.get("SECRET_KEY", "dev-secret-change-me"),
        SQLALCHEMY_DATABASE_URI=os.environ.get(
            "DATABASE_URL",
            "sqlite:///EduRadar.db",
        ),
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        MAX_CONTENT_LENGTH=6 * 1024 * 1024,
    )

    if test_config:
        app.config.update(test_config)

    db.init_app(app)
    socketio.init_app(app)

    # Import modeli jest wymagany przed create_all().
    from . import models  # noqa: F401
    from .models import User

    with app.app_context():
        db.create_all()

        # Starsze wersje formularza używały technicznych wartości
        # "user" dla nauczyciela i "admin" dla ucznia. Po migracji
        # w bazie istnieją tylko dwie właściwe role: nauczyciel / uczen.
        legacy_roles = {
            "user": "nauczyciel",
            "teacher": "nauczyciel",
            "nauczyciel": "nauczyciel",
            "admin": "uczen",
            "administrator": "uczen",
            "student": "uczen",
            "uczeń": "uczen",
            "uczen": "uczen",
        }
        roles_changed = False
        for user in User.query.all():
            old_role = str(user.role or "").strip().casefold()
            new_role = legacy_roles.get(old_role, "uczen")
            if user.role != new_role:
                user.role = new_role
                roles_changed = True

        if roles_changed:
            db.session.commit()

    from .routes import api
    app.register_blueprint(api)

    # Rejestruje handlery @socketio.on(...).
    from . import socket_events  # noqa: F401

    @app.route("/")
    def home():
        return render_template("index.html")

    @app.route("/admin")
    def admin():
        return render_template("admin.html")

    @app.route("/test")
    def test():
        return render_template("test.html")

    return app
