from datetime import datetime
from pathlib import Path
from uuid import uuid4

from flask import Blueprint, current_app, jsonify, request, session, url_for
from sqlalchemy.exc import IntegrityError
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

from . import db, socketio
from .models import Event, EventTag, Institution, Opinion, Tag, User


api = Blueprint("api", __name__)

ALLOWED_BANNER_EXTENSIONS = {"jpg", "jpeg", "png", "webp", "gif"}
ROLE_TEACHER = "nauczyciel"
ROLE_STUDENT = "uczen"
VALID_ROLES = {ROLE_TEACHER, ROLE_STUDENT}

# fix starych rekordow
ROLE_ALIASES = {
    "nauczyciel": ROLE_TEACHER,
    "teacher": ROLE_TEACHER,
    "user": ROLE_TEACHER,
    "uczen": ROLE_STUDENT,
    "uczeń": ROLE_STUDENT,
    "student": ROLE_STUDENT,
    "admin": ROLE_STUDENT,
    "administrator": ROLE_STUDENT,
}


def normalize_role(role):
    return str(role or "").strip().casefold()


def validate_role(role):
    raw = normalize_role(role)
    normalized = ROLE_ALIASES.get(raw)

    if normalized not in VALID_ROLES:
        raise ValueError(
            "Rola musi mieć wartość 'nauczyciel' albo 'uczen'. "
            f"Otrzymano: {role!r}."
        )

    return normalized


def get_current_user():
    user_id = session.get("user_id")
    if user_id is None:
        return None

    user = db.session.get(User, user_id)
    if user is None:
        session.clear()
    return user


def is_teacher(user):
    return user is not None and normalize_role(user.role) == ROLE_TEACHER


def require_login():
    user = get_current_user()
    if user is None:
        return None, (jsonify({"error": "Musisz być zalogowany."}), 401)
    return user, None


def require_event_manager():
    user, error = require_login()
    if error:
        return None, error

    if not is_teacher(user):
        return None, (jsonify({"error": "Tylko nauczyciel może dodawać, edytować i usuwać wydarzenia."}), 403)

    return user, None


def serialize_institution(inst):
    return {
        "id": inst.id,
        "name": inst.name,
        "description": inst.description,
        "address": inst.address,
        "website": inst.website,
        "latitude": inst.latitude,
        "longitude": inst.longitude,
        "banner_url": inst.banner_url,
    }


def serialize_event(event):
    return {
        "id": event.id,
        "institution_id": event.institution_id,
        "name": event.name,
        "description": event.description,
        "starts_at": event.starts_at.isoformat(),
        "ends_at": event.ends_at.isoformat() if event.ends_at else None,
        "address": event.address,
        "latitude": event.latitude,
        "longitude": event.longitude,
        "banner_url": event.banner_url,
        "tags": [{"id": tag.id, "name": tag.name} for tag in event.tags],
    }


def serialize_user(user):
    return {
        "id": user.id,
        "nickname": user.nickname,
        "name": user.name,
        "surname": user.surname,
        "email": user.email,
        "bio": user.bio,
        "role": user.role,
    }


def serialize_public_user(user):
    return {
        "id": user.id,
        "nickname": user.nickname,
        "name": user.name,
        "surname": user.surname,
        "bio": user.bio,
        "role": user.role,
    }


def serialize_tag(tag):
    return {"id": tag.id, "name": tag.name}


def serialize_opinion(opinion):
    return {
        "id": opinion.id,
        "author_id": opinion.author_id,
        "institution_id": opinion.institution_id,
        "event_id": opinion.event_id,
        "rating": opinion.rating,
        "content": opinion.content,
        "author": serialize_public_user(opinion.author) if opinion.author else None,
    }


def allowed_banner(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_BANNER_EXTENSIONS


def notify_data_changed(resource, action, record_id=None, **extra):
    """Powiadom wszystkie otwarte strony o zmianie danych publicznych."""
    payload = {"type": resource, "action": action}
    if record_id is not None:
        payload["id"] = record_id
    payload.update(extra)

    try:
        socketio.emit("data_changed", payload, namespace="/updates")
    except Exception:
        # Zapis do bazy już się udał. Awaria powiadomienia realtime
        # nie może zamienić poprawnego CRUD-a w błąd HTTP.
        current_app.logger.exception("Nie udało się wysłać data_changed: %r", payload)


def delete_local_banner(banner_url):
    if not banner_url or not banner_url.startswith("/static/uploads/banners/"):
        return

    filename = banner_url.rsplit("/", 1)[-1]
    path = Path(current_app.static_folder) / "uploads" / "banners" / filename

    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def parse_event_payload(data):
    institution_id = int(data["institution_id"])
    institution = db.session.get(Institution, institution_id)
    if institution is None:
        raise LookupError("Institution not found")

    name = str(data["name"]).strip()
    description = str(data["description"]).strip()
    if not name or not description:
        raise ValueError("Nazwa i opis są wymagane.")

    starts_at = datetime.fromisoformat(str(data["starts_at"]))
    ends_at = datetime.fromisoformat(str(data["ends_at"])) if data.get("ends_at") else None
    if ends_at and ends_at < starts_at:
        raise ValueError("Data zakończenia nie może być wcześniejsza niż rozpoczęcie.")

    latitude = data.get("latitude")
    longitude = data.get("longitude")
    latitude = float(latitude) if latitude not in (None, "") else None
    longitude = float(longitude) if longitude not in (None, "") else None
    if (latitude is None) != (longitude is None):
        raise ValueError("Latitude i longitude muszą być podane razem.")
    if latitude is not None and not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        raise ValueError("Niepoprawne współrzędne.")

    tag_ids = [int(item) for item in (data.get("tag_ids") or [])]
    tags = Tag.query.filter(Tag.id.in_(tag_ids)).all() if tag_ids else []
    if len(tags) != len(set(tag_ids)):
        raise LookupError("One or more tags not found")

    return {
        "institution_id": institution_id,
        "name": name,
        "description": description,
        "starts_at": starts_at,
        "ends_at": ends_at,
        "address": str(data.get("address") or "").strip() or None,
        "latitude": latitude,
        "longitude": longitude,
        "banner_url": str(data.get("banner_url") or "").strip() or None,
        "tags": tags,
    }


# =========================================================
# AUTH
# =========================================================

@api.route("/api/auth/login", methods=["POST"])
def auth_login():
    data = request.get_json(silent=True) or {}
    email = str(data.get("email", "")).strip()
    password = str(data.get("password", ""))

    if not email or not password:
        return jsonify({"error": "Email i hasło są wymagane."}), 400

    user = User.query.filter_by(email=email).first()
    if user is None or not check_password_hash(user.password_hash, password):
        return jsonify({"error": "Niepoprawny email lub hasło."}), 401

    session.clear()
    session["user_id"] = user.id
    return jsonify({"user": serialize_user(user)}), 200


@api.route("/api/auth/me", methods=["GET"])
def auth_me():
    user = get_current_user()
    if user is None:
        return jsonify({"error": "Brak autoryzacji"}), 401
    return jsonify(serialize_user(user)), 200


@api.route("/api/auth/logout", methods=["POST"])
def auth_logout():
    session.clear()
    return jsonify({"message": "Wylogowano"}), 200


@api.route("/api/users/<int:user_id>/profile", methods=["GET"])
def public_user_profile(user_id):
    user = db.session.get(User, user_id)
    if user is None:
        return jsonify({"error": "Nie znaleziono użytkownika"}), 404
    return jsonify(serialize_public_user(user)), 200


# =========================================================
# BANNER UPLOAD
# =========================================================

@api.route("/api/upload/banner", methods=["POST"])
def upload_banner():
    user, error = require_event_manager()
    if error:
        return error

    file = request.files.get("banner")
    if file is None or not file.filename:
        return jsonify({"error": "Nie wybrano pliku."}), 400

    if not allowed_banner(file.filename):
        return jsonify({"error": "Dozwolone formaty: JPG, JPEG, PNG, WEBP, GIF."}), 400

    original_name = secure_filename(file.filename)
    extension = original_name.rsplit(".", 1)[1].lower()
    filename = f"{uuid4().hex}.{extension}"

    upload_dir = Path(current_app.static_folder) / "uploads" / "banners"
    upload_dir.mkdir(parents=True, exist_ok=True)
    file.save(upload_dir / filename)

    return jsonify({
        "banner_url": url_for("static", filename=f"uploads/banners/{filename}")
    }), 201


# =========================================================
# INSTITUTIONS
# =========================================================

@api.route("/api/Institutions", methods=["GET"])
def get_institutions():
    return jsonify([serialize_institution(inst) for inst in Institution.query.order_by(Institution.name).all()])


@api.route("/api/Institutions", methods=["POST"])
def create_institution():
    data = request.get_json(silent=True) or {}
    try:
        inst = Institution(
            name=str(data["name"]).strip(),
            description=str(data["description"]).strip(),
            address=str(data["address"]).strip(),
            website=str(data["website"]).strip(),
            latitude=float(data["latitude"]),
            longitude=float(data["longitude"]),
            banner_url=data.get("banner_url"),
        )
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "Missing or invalid institution field"}), 400

    db.session.add(inst)
    db.session.commit()
    notify_data_changed("institution", "created", inst.id)
    return jsonify(serialize_institution(inst)), 201


@api.route("/api/Institutions/<int:institution_id>", methods=["PUT"])
def update_institution(institution_id):
    inst = db.session.get(Institution, institution_id)
    if inst is None:
        return jsonify({"error": "Institution not found"}), 404

    data = request.get_json(silent=True) or {}
    try:
        old_banner = inst.banner_url
        inst.name = str(data["name"]).strip()
        inst.description = str(data["description"]).strip()
        inst.address = str(data["address"]).strip()
        inst.website = str(data["website"]).strip()
        inst.latitude = float(data["latitude"])
        inst.longitude = float(data["longitude"])
        inst.banner_url = data.get("banner_url")
        db.session.commit()
        if old_banner != inst.banner_url:
            delete_local_banner(old_banner)
        notify_data_changed("institution", "updated", inst.id)
        return jsonify(serialize_institution(inst)), 200
    except (KeyError, TypeError, ValueError):
        db.session.rollback()
        return jsonify({"error": "Invalid institution data"}), 400


@api.route("/api/Institutions/<int:institution_id>", methods=["DELETE"])
def delete_institution(institution_id):
    inst = db.session.get(Institution, institution_id)
    if inst is None:
        return jsonify({"error": "Institution not found"}), 404

    events = Event.query.filter_by(institution_id=institution_id).all()
    for event in events:
        EventTag.query.filter_by(event_id=event.id).delete(synchronize_session=False)
        Opinion.query.filter_by(event_id=event.id).delete(synchronize_session=False)
        delete_local_banner(event.banner_url)
        db.session.delete(event)

    Opinion.query.filter_by(institution_id=institution_id).delete(synchronize_session=False)
    delete_local_banner(inst.banner_url)
    db.session.delete(inst)
    db.session.commit()
    notify_data_changed("institution", "deleted", institution_id)
    return jsonify({"message": "Institution deleted"}), 200


# =========================================================
# USERS
# =========================================================

@api.route("/api/Users", methods=["GET"])
def get_users():
    return jsonify([serialize_user(user) for user in User.query.order_by(User.id).all()])


@api.route("/api/Users", methods=["POST"])
def create_user():
    data = request.get_json(silent=True) or {}
    try:
        user = User(
            nickname=str(data["nickname"]).strip(),
            name=str(data["name"]).strip(),
            surname=str(data["surname"]).strip(),
            email=str(data["email"]).strip(),
            password_hash=generate_password_hash(str(data["password"])),
            bio=str(data.get("bio") or "").strip() or None,
            role=validate_role(data["role"]),
        )
    except KeyError:
        return jsonify({"error": "Missing user field"}), 400
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    db.session.add(user)
    db.session.commit()
    notify_data_changed("user", "created", user.id)
    return jsonify(serialize_user(user)), 201


@api.route("/api/Users/<int:user_id>", methods=["PUT"])
def update_user(user_id):
    user = db.session.get(User, user_id)
    if user is None:
        return jsonify({"error": "User not found"}), 404

    data = request.get_json(silent=True) or {}
    try:
        user.nickname = str(data["nickname"]).strip()
        user.name = str(data["name"]).strip()
        user.surname = str(data["surname"]).strip()
        user.email = str(data["email"]).strip()
        user.bio = str(data.get("bio") or "").strip() or None
        user.role = validate_role(data.get("role", user.role))
        if data.get("password"):
            user.password_hash = generate_password_hash(str(data["password"]))
        db.session.commit()
        notify_data_changed("user", "updated", user.id)
        return jsonify(serialize_user(user)), 200
    except KeyError:
        db.session.rollback()
        return jsonify({"error": "Missing user field"}), 400
    except (TypeError, ValueError) as exc:
        db.session.rollback()
        return jsonify({"error": str(exc)}), 400


@api.route("/api/Users/<int:user_id>", methods=["DELETE"])
def delete_user(user_id):
    user = db.session.get(User, user_id)
    if user is None:
        return jsonify({"error": "User not found"}), 404

    Opinion.query.filter_by(author_id=user_id).delete(synchronize_session=False)
    db.session.delete(user)
    db.session.commit()
    notify_data_changed("user", "deleted", user_id)
    if session.get("user_id") == user_id:
        session.clear()
    return jsonify({"message": "User deleted"}), 200


# =========================================================
# EVENTS
# =========================================================

@api.route("/api/Events", methods=["GET"])
def get_events():
    return jsonify([serialize_event(event) for event in Event.query.order_by(Event.starts_at).all()])


@api.route("/api/Events", methods=["POST"])
def create_event():
    user, error = require_event_manager()
    if error:
        return error

    data = request.get_json(silent=True) or {}
    try:
        payload = parse_event_payload(data)
        event = Event(
            institution_id=payload["institution_id"],
            name=payload["name"],
            description=payload["description"],
            starts_at=payload["starts_at"],
            ends_at=payload["ends_at"],
            address=payload["address"],
            latitude=payload["latitude"],
            longitude=payload["longitude"],
            banner_url=payload["banner_url"],
            tags=payload["tags"],
        )
        db.session.add(event)
        db.session.commit()
        notify_data_changed("event", "created", event.id)
        return jsonify(serialize_event(event)), 201
    except LookupError as exc:
        db.session.rollback()
        return jsonify({"error": str(exc)}), 404
    except (KeyError, TypeError, ValueError) as exc:
        db.session.rollback()
        return jsonify({"error": str(exc) or "Invalid event data"}), 400


@api.route("/api/Events/<int:event_id>", methods=["PUT"])
def update_event(event_id):
    user, error = require_event_manager()
    if error:
        return error

    event = db.session.get(Event, event_id)
    if event is None:
        return jsonify({"error": "Event not found"}), 404

    data = request.get_json(silent=True) or {}
    try:
        payload = parse_event_payload(data)
        old_banner = event.banner_url
        event.institution_id = payload["institution_id"]
        event.name = payload["name"]
        event.description = payload["description"]
        event.starts_at = payload["starts_at"]
        event.ends_at = payload["ends_at"]
        event.address = payload["address"]
        event.latitude = payload["latitude"]
        event.longitude = payload["longitude"]
        event.banner_url = payload["banner_url"]
        event.tags = payload["tags"]
        db.session.commit()
        if old_banner != event.banner_url:
            delete_local_banner(old_banner)
        notify_data_changed("event", "updated", event.id)
        return jsonify(serialize_event(event)), 200
    except LookupError as exc:
        db.session.rollback()
        return jsonify({"error": str(exc)}), 404
    except (KeyError, TypeError, ValueError) as exc:
        db.session.rollback()
        return jsonify({"error": str(exc) or "Invalid event data"}), 400


@api.route("/api/Events/<int:event_id>", methods=["DELETE"])
def delete_event(event_id):
    user, error = require_event_manager()
    if error:
        return error

    event = db.session.get(Event, event_id)
    if event is None:
        return jsonify({"error": "Event not found"}), 404

    EventTag.query.filter_by(event_id=event_id).delete(synchronize_session=False)
    Opinion.query.filter_by(event_id=event_id).delete(synchronize_session=False)
    delete_local_banner(event.banner_url)
    db.session.delete(event)
    db.session.commit()
    notify_data_changed("event", "deleted", event_id)
    return jsonify({"message": "Event deleted"}), 200


# =========================================================
# TAGS
# =========================================================

@api.route("/api/Tags", methods=["GET"])
def get_tags():
    return jsonify([serialize_tag(tag) for tag in Tag.query.order_by(Tag.name).all()])


@api.route("/api/Tags", methods=["POST"])
def create_tag():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    if not name:
        return jsonify({"error": "Tag name is required"}), 400
    if Tag.query.filter_by(name=name).first():
        return jsonify({"error": "Tag already exists"}), 409

    tag = Tag(name=name)
    db.session.add(tag)
    db.session.commit()
    notify_data_changed("tag", "created", tag.id)
    return jsonify(serialize_tag(tag)), 201


@api.route("/api/Tags/<int:tag_id>", methods=["PUT"])
def update_tag(tag_id):
    tag = db.session.get(Tag, tag_id)
    if tag is None:
        return jsonify({"error": "Tag not found"}), 404

    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    if not name:
        return jsonify({"error": "Tag name is required"}), 400

    existing = Tag.query.filter(Tag.name == name, Tag.id != tag_id).first()
    if existing:
        return jsonify({"error": "Tag already exists"}), 409

    tag.name = name
    db.session.commit()
    notify_data_changed("tag", "updated", tag.id)
    return jsonify(serialize_tag(tag)), 200


@api.route("/api/Tags/<int:tag_id>", methods=["DELETE"])
def delete_tag(tag_id):
    tag = db.session.get(Tag, tag_id)
    if tag is None:
        return jsonify({"error": "Tag not found"}), 404

    EventTag.query.filter_by(tag_id=tag_id).delete(synchronize_session=False)
    db.session.delete(tag)
    db.session.commit()
    notify_data_changed("tag", "deleted", tag_id)
    return jsonify({"message": "Tag deleted"}), 200


# =========================================================
# EVENT TAGS
# =========================================================

@api.route("/api/EventTags", methods=["GET"])
def get_event_tags():
    return jsonify([
        {"event_id": item.event_id, "tag_id": item.tag_id}
        for item in EventTag.query.all()
    ])


@api.route("/api/EventTags", methods=["POST"])
def create_event_tag():
    user, error = require_event_manager()
    if error:
        return error

    data = request.get_json(silent=True) or {}
    try:
        event_id = int(data["event_id"])
        tag_id = int(data["tag_id"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "Missing EventTag field"}), 400

    if db.session.get(Event, event_id) is None:
        return jsonify({"error": "Event not found"}), 404
    if db.session.get(Tag, tag_id) is None:
        return jsonify({"error": "Tag not found"}), 404
    if db.session.get(EventTag, (event_id, tag_id)):
        return jsonify({"error": "This tag is already assigned to this event"}), 409

    event_tag = EventTag(event_id=event_id, tag_id=tag_id)
    db.session.add(event_tag)
    db.session.commit()
    notify_data_changed("event", "tags_updated", event_id, tag_id=tag_id)
    return jsonify({"event_id": event_id, "tag_id": tag_id}), 201


@api.route("/api/EventTags/<int:event_id>/<int:tag_id>", methods=["DELETE"])
def delete_event_tag(event_id, tag_id):
    user, error = require_event_manager()
    if error:
        return error

    event_tag = db.session.get(EventTag, (event_id, tag_id))
    if event_tag is None:
        return jsonify({"error": "EventTag not found"}), 404

    db.session.delete(event_tag)
    db.session.commit()
    notify_data_changed("event", "tags_updated", event_id, tag_id=tag_id)
    return jsonify({"message": "EventTag deleted"}), 200


# =========================================================
# OPINIONS
# =========================================================

@api.route("/api/Opinions", methods=["GET"])
def get_opinions():
    query = Opinion.query
    institution_id = request.args.get("institution_id", type=int)
    event_id = request.args.get("event_id", type=int)
    author_id = request.args.get("author_id", type=int)

    if institution_id is not None:
        query = query.filter_by(institution_id=institution_id)
    if event_id is not None:
        query = query.filter_by(event_id=event_id)
    if author_id is not None:
        query = query.filter_by(author_id=author_id)

    return jsonify([serialize_opinion(opinion) for opinion in query.order_by(Opinion.id.desc()).all()])


def parse_opinion_payload(data):
    try:
        rating = int(data["rating"])
    except (KeyError, TypeError, ValueError):
        raise ValueError("Ocena musi być liczbą od 1 do 5.")

    content = str(data.get("content", "")).strip()
    if not content:
        raise ValueError("Treść opinii jest wymagana.")
    if len(content) > 2000:
        raise ValueError("Opinia może mieć maksymalnie 2000 znaków.")
    if not 1 <= rating <= 5:
        raise ValueError("Ocena musi być w zakresie 1-5.")

    institution_id = data.get("institution_id")
    event_id = data.get("event_id")
    institution_id = int(institution_id) if institution_id not in (None, "") else None
    event_id = int(event_id) if event_id not in (None, "") else None

    if (institution_id is None) == (event_id is None):
        raise ValueError("Opinia musi dotyczyć dokładnie jednej instytucji albo wydarzenia.")

    if institution_id is not None and db.session.get(Institution, institution_id) is None:
        raise LookupError("Institution not found")
    if event_id is not None and db.session.get(Event, event_id) is None:
        raise LookupError("Event not found")

    return institution_id, event_id, rating, content


@api.route("/api/Opinions", methods=["POST"])
def create_opinion():
    user, error = require_login()
    if error:
        return error

    data = request.get_json(silent=True) or {}
    try:
        institution_id, event_id, rating, content = parse_opinion_payload(data)
    except LookupError as exc:
        return jsonify({"error": str(exc)}), 404
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400

    author = user
    if is_teacher(user) and data.get("author_id") not in (None, ""):
        selected_author = db.session.get(User, int(data["author_id"]))
        if selected_author is None:
            return jsonify({"error": "User not found"}), 404
        author = selected_author

    query = Opinion.query.filter_by(author_id=author.id)
    existing = (
        query.filter_by(institution_id=institution_id).first()
        if institution_id is not None
        else query.filter_by(event_id=event_id).first()
    )
    if existing:
        return jsonify({"error": "Dodałeś już opinię do tego obiektu."}), 409

    opinion = Opinion(
        author_id=author.id,
        institution_id=institution_id,
        event_id=event_id,
        rating=rating,
        content=content,
    )
    db.session.add(opinion)
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return jsonify({"error": "Dodałeś już opinię do tego obiektu."}), 409

    notify_data_changed("opinion", "created", opinion.id)
    return jsonify(serialize_opinion(opinion)), 201


@api.route("/api/Opinions/<int:opinion_id>", methods=["PUT"])
def update_opinion(opinion_id):
    user, error = require_login()
    if error:
        return error

    opinion = db.session.get(Opinion, opinion_id)
    if opinion is None:
        return jsonify({"error": "Opinion not found"}), 404
    if opinion.author_id != user.id and not is_teacher(user):
        return jsonify({"error": "Nie możesz edytować cudzej opinii."}), 403

    data = request.get_json(silent=True) or {}
    try:
        institution_id, event_id, rating, content = parse_opinion_payload(data)
    except LookupError as exc:
        return jsonify({"error": str(exc)}), 404
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400

    author_id = opinion.author_id
    if is_teacher(user) and data.get("author_id") not in (None, ""):
        selected_author = db.session.get(User, int(data["author_id"]))
        if selected_author is None:
            return jsonify({"error": "User not found"}), 404
        author_id = selected_author.id

    query = Opinion.query.filter(Opinion.author_id == author_id, Opinion.id != opinion_id)
    existing = (
        query.filter(Opinion.institution_id == institution_id).first()
        if institution_id is not None
        else query.filter(Opinion.event_id == event_id).first()
    )
    if existing:
        return jsonify({"error": "Dodałeś już opinię do tego obiektu."}), 409

    opinion.author_id = author_id
    opinion.institution_id = institution_id
    opinion.event_id = event_id
    opinion.rating = rating
    opinion.content = content
    db.session.commit()
    notify_data_changed("opinion", "updated", opinion.id)
    return jsonify(serialize_opinion(opinion)), 200


@api.route("/api/Opinions/<int:opinion_id>", methods=["DELETE"])
def delete_opinion(opinion_id):
    user, error = require_login()
    if error:
        return error

    opinion = db.session.get(Opinion, opinion_id)
    if opinion is None:
        return jsonify({"error": "Opinion not found"}), 404
    if opinion.author_id != user.id and not is_teacher(user):
        return jsonify({"error": "Nie możesz usunąć cudzej opinii."}), 403

    db.session.delete(opinion)
    db.session.commit()
    notify_data_changed("opinion", "deleted", opinion_id)
    return jsonify({"message": "Opinion deleted"}), 200
