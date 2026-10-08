from . import db


class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    nickname = db.Column(db.String(15), nullable=False)
    name = db.Column(db.String(100), nullable=False)
    surname = db.Column(db.String(100), nullable=False)
    email = db.Column(db.String(100), nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    bio = db.Column(db.Text)
    role = db.Column(db.String(50), nullable=False, default="uczen")

    opinions = db.relationship(
        "Opinion",
        back_populates="author",
    )


class Institution(db.Model):
    __tablename__ = "institutions"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    description = db.Column(db.Text, nullable=False)
    address = db.Column(db.String(250), nullable=False)
    banner_url = db.Column(db.String(500), nullable=True)

    website = db.Column("website_url", db.String(100), nullable=False)

    latitude = db.Column(db.Float, nullable=False)

    longitude = db.Column("longitude", db.Float, nullable=False)

    events = db.relationship(
        "Event",
        back_populates="institution",
    )

    opinions = db.relationship(
        "Opinion",
        back_populates="institution",
    )


class Event(db.Model):
    __tablename__ = "events"

    id = db.Column(db.Integer, primary_key=True)

    institution_id = db.Column(
        db.Integer,
        db.ForeignKey("institutions.id"),
        nullable=False,
    )

    name = db.Column(db.String(100), nullable=False)
    description = db.Column(db.Text, nullable=False)
    starts_at = db.Column(db.DateTime, nullable=False)
    ends_at = db.Column(db.DateTime, nullable=True)
    address = db.Column(db.String(250), nullable=True)
    latitude = db.Column(db.Float, nullable=True)
    longitude = db.Column(db.Float, nullable=True)
    banner_url = db.Column(db.String(500), nullable=True)
    institution = db.relationship(
        "Institution",
        back_populates="events",
    )

    tags = db.relationship(
        "Tag",
        secondary="event_tags",
        back_populates="events",
    )

    opinions = db.relationship(
        "Opinion",
        back_populates="event",
    )


class EventTag(db.Model):
    __tablename__ = "event_tags"

    event_id = db.Column(
        db.Integer,
        db.ForeignKey("events.id"),
        primary_key=True,
    )

    tag_id = db.Column(
        db.Integer,
        db.ForeignKey("tags.id"),
        primary_key=True,
    )


class Tag(db.Model):
    __tablename__ = "tags"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False, unique=True)

    events = db.relationship(
        "Event",
        secondary="event_tags",
        back_populates="tags",
    )


class Opinion(db.Model):
    __tablename__ = "opinions"

    id = db.Column(db.Integer, primary_key=True)

    author_id = db.Column(
        db.Integer,
        db.ForeignKey("users.id"),
        nullable=False,
    )

    institution_id = db.Column(
        db.Integer,
        db.ForeignKey("institutions.id"),
        nullable=True,
    )

    event_id = db.Column(
        db.Integer,
        db.ForeignKey("events.id"),
        nullable=True,
    )

    rating = db.Column(db.Integer, nullable=False)
    content = db.Column(db.Text, nullable=False)

    author = db.relationship(
        "User",
        back_populates="opinions",
    )

    institution = db.relationship(
        "Institution",
        back_populates="opinions",
    )

    event = db.relationship(
        "Event",
        back_populates="opinions",
    )

    __table_args__ = (
        # Ocena od 1 do 5.
        db.CheckConstraint(
            "rating BETWEEN 1 AND 5",
            name="opinion_rating_range",
        ),

        # Opinia dotyczy instytucji ALBO wydarzenia.
        db.CheckConstraint(
            "(institution_id IS NOT NULL AND event_id IS NULL) OR "
            "(institution_id IS NULL AND event_id IS NOT NULL)",
            name="opinion_one_target",
        ),

        # Jedna opinia użytkownika na daną instytucję.
        db.UniqueConstraint(
            "author_id",
            "institution_id",
            name="unique_user_institution_opinion",
        ),

        # Jedna opinia użytkownika na dane wydarzenie.
        db.UniqueConstraint(
            "author_id",
            "event_id",
            name="unique_user_event_opinion",
        ),
    )