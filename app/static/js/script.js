document.addEventListener("DOMContentLoaded", () => {
    "use strict";

    const API = {
        institutions: "/api/Institutions",
        events: "/api/Events",
        tags: "/api/Tags",
        opinions: "/api/Opinions",
        authMe: "/api/auth/me",
        authLogin: "/api/auth/login",
        authLogout: "/api/auth/logout",
        bannerUpload: "/api/upload/banner",
        publicProfile: userId => `/api/users/${userId}/profile`
    };

    const state = {
        institutions: [],
        events: [],
        tags: [],
        opinions: [],
        currentUser: null,
        search: ""
    };

    const TEACHER_ROLE = "nauczyciel";
    const windows = [...document.querySelectorAll(".window")];
    const windowButtons = [...document.querySelectorAll("[data-window]")];
    const movableWindows = [...document.querySelectorAll(
        ".events-window, .past-window, .chat-window"
    )];

    const sidebar = document.getElementById("placeDetailsSidebar");
    const placeDetails = document.getElementById("placeDetailsContent");
    const appStatus = document.getElementById("appStatus");
    const addWindow = document.getElementById("addWindow");
    const closeTimers = new Map();
    const animationTime = 180;

    let draggedWindow = null;
    let offsetX = 0;
    let offsetY = 0;
    let statusTimer = null;
    let eventLocationPicking = false;
    let eventSelectionMarker = null;
    let firstMapFit = true;
    let activeDetails = null;

    // FUNKCJE POMOCNICZE

    function el(tagName, className = null, text = null) {
        const node = document.createElement(tagName);
        if (className) node.className = className;
        if (text !== null) node.textContent = text;
        return node;
    }

    function normalizeRole(role) {
        return String(role || "").trim().toLocaleLowerCase("pl-PL");
    }

    function isTeacher(user = state.currentUser) {
        return Boolean(user && normalizeRole(user.role) === TEACHER_ROLE);
    }

    function roleLabel(role) {
        const normalized = normalizeRole(role);
        if (normalized === "nauczyciel") return "Nauczyciel";
        if (normalized === "uczen") return "Uczeń";
        return "Uczeń";
    }

    function showStatus(message, type = "info") {
        clearTimeout(statusTimer);
        appStatus.textContent = message;
        appStatus.dataset.type = type;
        appStatus.hidden = false;

        statusTimer = setTimeout(() => {
            appStatus.hidden = true;
        }, 4500);
    }

    async function readResponse(response) {
        const contentType = response.headers.get("content-type") || "";
        const body = contentType.includes("application/json")
            ? await response.json()
            : await response.text();

        if (!response.ok) {
            const message = typeof body === "object" && body
                ? body.error || body.message || `HTTP ${response.status}`
                : String(body || `HTTP ${response.status}`);

            throw new Error(message);
        }

        return body;
    }

    async function apiGet(url) {
        return readResponse(await fetch(url, {
            headers: { Accept: "application/json" }
        }));
    }

    async function apiSend(url, method, payload) {
        return readResponse(await fetch(url, {
            method,
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        }));
    }

    // OKNA

    function resetPosition(element) {
        ["left", "top", "right", "bottom", "width", "transform"].forEach(property => {
            element.style.removeProperty(property);
        });
    }

    function stopDragging() {
        draggedWindow = null;
        document.body.style.userSelect = "";
    }

    function keepPosition(element) {
        const rect = element.getBoundingClientRect();
        const parentRect = element.offsetParent.getBoundingClientRect();

        element.style.width = `${rect.width}px`;
        element.style.left = `${rect.left - parentRect.left}px`;
        element.style.top = `${rect.top - parentRect.top}px`;
        element.style.right = "auto";
        element.style.bottom = "auto";
        element.style.transform = "none";
    }

    function setWindowOpen(element, isOpen) {
        if (!element) return;

        clearTimeout(closeTimers.get(element));
        closeTimers.delete(element);
        element.classList.toggle("open", isOpen);

        windowButtons.forEach(button => {
            if (`${button.dataset.window}Window` === element.id) {
                button.classList.toggle("active", isOpen);
                button.setAttribute("aria-expanded", String(isOpen));
            }
        });

        if (isOpen) return;
        if (draggedWindow === element) stopDragging();

        closeTimers.set(element, setTimeout(() => {
            element.classList.remove("minimized");
            resetPosition(element);
            closeTimers.delete(element);
        }, animationTime + 30));
    }

    function openWindow(name) {
        const element = document.getElementById(`${name}Window`);
        if (!element) return;

        element.classList.remove("minimized");
        setWindowOpen(element, true);
    }

    function toggleMinimize(element) {
        if (!element.classList.contains("minimized")) {
            keepPosition(element);
        }

        element.classList.toggle("minimized");
    }

    function closeAllWindows() {
        windows.forEach(element => {
            if (element.classList.contains("open")) {
                setWindowOpen(element, false);
            }
        });
    }

    function requestAddEventWindow() {
        if (!state.currentUser) {
            showStatus("Zaloguj się jako nauczyciel, aby dodać wydarzenie.", "warning");
            openWindow("profile");
            return;
        }

        if (!isTeacher()) {
            showStatus(
                "Na stronie głównej wydarzenia może dodawać wyłącznie nauczyciel.",
                "warning"
            );
            return;
        }

        openWindow("add");
    }

    windowButtons.forEach(button => {
        button.addEventListener("click", () => {
            const name = button.dataset.window;

            if (name === "add") {
                requestAddEventWindow();
                return;
            }

            const element = document.getElementById(`${name}Window`);
            if (!element) return;

            if (element.classList.contains("open")) {
                toggleMinimize(element);
            } else {
                element.classList.remove("minimized");
                setWindowOpen(element, true);
            }
        });
    });

    document.querySelectorAll("[data-minimize]").forEach(button => {
        button.addEventListener("click", () => {
            const element = document.getElementById(
                `${button.dataset.minimize}Window`
            );

            if (element?.classList.contains("open")) {
                toggleMinimize(element);
            }
        });
    });

    document.querySelectorAll("[data-close]").forEach(button => {
        button.addEventListener("click", () => {
            const element = document.getElementById(
                `${button.dataset.close}Window`
            );

            if (element) setWindowOpen(element, false);
        });
    });

    // PRZECIĄGANIE OKIEN

    movableWindows.forEach(element => {
        element.querySelector(".window-header")?.addEventListener("mousedown", event => {
            if (
                event.button !== 0 ||
                window.innerWidth <= 900 ||
                event.target.closest("button")
            ) return;

            if (!element.classList.contains("open")) return;

            keepPosition(element);

            const rect = element.getBoundingClientRect();
            offsetX = event.clientX - rect.left;
            offsetY = event.clientY - rect.top;
            draggedWindow = element;
            document.body.style.userSelect = "none";
            event.preventDefault();
        });
    });

    document.addEventListener("mousemove", event => {
        if (!draggedWindow) return;

        const parent = draggedWindow.offsetParent;
        const margin = 15;

        const maxLeft = Math.max(
            margin,
            parent.clientWidth - draggedWindow.offsetWidth - margin
        );

        const maxTop = Math.max(
            margin,
            parent.clientHeight - draggedWindow.offsetHeight - margin
        );

        const left = event.clientX - parent.getBoundingClientRect().left - offsetX;
        const top = event.clientY - parent.getBoundingClientRect().top - offsetY;

        draggedWindow.style.left = `${Math.max(margin, Math.min(left, maxLeft))}px`;
        draggedWindow.style.top = `${Math.max(margin, Math.min(top, maxTop))}px`;
    });

    document.addEventListener("mouseup", stopDragging);
    window.addEventListener("blur", stopDragging);

    function closeSidebar() {
        sidebar?.classList.remove("open");
        activeDetails = null;
    }

    document.getElementById("closePlaceDetails")?.addEventListener("click", closeSidebar);

    document.addEventListener("keydown", event => {
        if (event.key !== "Escape") return;

        eventLocationPicking = false;
        stopDragging();
        closeSidebar();
        closeAllWindows();
        hideMiniProfile();
    });

    // MAPA I DANE

    if (!document.getElementById("map") || typeof L === "undefined") {
        showStatus("Nie udało się uruchomić mapy Leaflet.", "error");
        return;
    }

    const map = L.map("map", {
        zoomControl: false
    }).setView([50.0647, 19.9450], 12);
    map.attributionControl.setPrefix(false);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "© OpenStreetMap contributors"
    }).addTo(map);

    L.control.zoom({ position: "topright" }).addTo(map);

    // NOWY WYGLĄD PINEZEK INSTYTUCJI
    const eduMarkerIcon = L.divIcon({
        className: "edu-marker",
        html: `
            <div class="edu-pin">
                <i class="fa-solid fa-graduation-cap"></i>
            </div>
        `,
        iconSize: [40, 40],
        iconAnchor: [20, 40],
        popupAnchor: [0, -40],
        tooltipAnchor: [0, -35]
    });
    const eduEventMarkerIcon = L.divIcon({
        className: "event-marker",
        html: `
            <div class="event-pin">
                <i class="fa-solid fa-book-bookmark"></i>
            </div>
        `,
        iconSize: [35, 35],
        iconAnchor: [20, 40],
        popupAnchor: [0, -40],
        tooltipAnchor: [0, -35]
    });

    const institutionLayer = L.layerGroup().addTo(map);
    const eventLayer = L.layerGroup().addTo(map);
    const selectionLayer = L.layerGroup().addTo(map);
    // Wybrane identyfikatory tagów
const selectedTags = new Set();

const mapFilter = document.getElementById("mapFilter");
const filterToggle = document.getElementById("filterToggle");
const filterPanel = document.getElementById("filterPanel");
const filterTags = document.getElementById("filterTags");

// Klikanie i przewijanie filtra nie obsługuje mapy
L.DomEvent.disableClickPropagation(mapFilter);
L.DomEvent.disableScrollPropagation(mapFilter);

function setFilterOpen(open) {
    filterPanel.hidden = !open;
    filterToggle.setAttribute("aria-expanded", String(open));
}

filterToggle.addEventListener("click", () => {
    setFilterOpen(filterPanel.hidden);
});

// Kliknięcie poza filtrem zamyka panel
document.addEventListener("click", event => {
    if (!mapFilter.contains(event.target)) {
        setFilterOpen(false);
    }
});

mapFilter.addEventListener("keydown", event => {
    if (event.key === "Escape") {
        setFilterOpen(false);
        filterToggle.focus();
    }
});

// Czy wydarzenie ma przynajmniej jeden wybrany tag?
function eventMatchesTags(event) {
    if (selectedTags.size === 0) return true;

    return (event.tags || []).some(tag => {
        return selectedTags.has(String(tag.id));
    });
}

function updateTagFilter() {
    const active = selectedTags.size > 0;

    filterToggle.classList.toggle("active", active);
    filterToggle.setAttribute(
        "aria-label",
        active
            ? `Filtruj wydarzenia. Wybrane tagi: ${selectedTags.size}`
            : "Filtruj wydarzenia po tagach"
    );

    renderMap();
}

// Tworzenie checkboxów z tagów pobranych z API
function renderTagFilters() {
    filterTags.replaceChildren();

    // Usuń wybór tagu, jeśli nie ma go już w bazie
    const availableIds = new Set(
        state.tags.map(tag => String(tag.id))
    );

    selectedTags.forEach(id => {
        if (!availableIds.has(id)) selectedTags.delete(id);
    });

    state.tags.forEach(tag => {
        const label = document.createElement("label");
        label.className = "map-filter-tag";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = String(tag.id);
        checkbox.checked = selectedTags.has(checkbox.value);

        const name = document.createElement("span");
        name.textContent = tag.name;

        checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
                selectedTags.add(checkbox.value);
            } else {
                selectedTags.delete(checkbox.value);
            }

            updateTagFilter();
        });

        const color = getTagColor(tag);

checkbox.style.accentColor = color;

const dot = document.createElement("span");
dot.className = "filter-tag-dot";
dot.style.backgroundColor = color;
dot.setAttribute("aria-hidden", "true");

label.append(checkbox, dot, name);
        filterTags.appendChild(label);
    });

    if (!state.tags.length) {
        filterTags.textContent = "Brak tagów w bazie.";
    }

    filterToggle.classList.toggle(
        "active",
        selectedTags.size > 0
    );
}

document.getElementById("clearTagFilters").addEventListener("click", () => {
    selectedTags.clear();

    filterTags.querySelectorAll("input").forEach(input => {
        input.checked = false;
    });

    updateTagFilter();
});

    map.on("click", event => {
        if (eventLocationPicking) {
            setEventCoordinates(event.latlng.lat, event.latlng.lng);
            eventLocationPicking = false;

            document.getElementById("eventLocationHint").textContent =
                "Punkt ustawiony. Możesz go ponownie wybrać lub wyczyścić.";

            openWindow("add");
            return;
        }

        closeSidebar();
    });

    function safeNumber(value) {
        if (value === null || value === undefined || value === "") return null;

        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function institutionById(id) {
        return state.institutions.find(item => Number(item.id) === Number(id)) || null;
    }

    function eventById(id) {
        return state.events.find(item => Number(item.id) === Number(id)) || null;
    }

    function opinionsFor(targetType, targetId) {
        const key = targetType === "institution" ? "institution_id" : "event_id";
        return state.opinions.filter(opinion => Number(opinion[key]) === Number(targetId));
    }

    function averageRating(opinions) {
        if (!opinions.length) return null;

        return (
            opinions.reduce((sum, item) => sum + Number(item.rating), 0) /
            opinions.length
        ).toFixed(1);
    }

    function eventIsPast(event) {
        const end = new Date(event.ends_at || event.starts_at);
        return !Number.isNaN(end.getTime()) && end.getTime() < Date.now();
    }

    function formatDate(value, withTime = true) {
        if (!value) return "—";

        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);

        return date.toLocaleString(
            "pl-PL",
            withTime
                ? { dateStyle: "medium", timeStyle: "short" }
                : { dateStyle: "medium" }
        );
    }

    function searchableText(event) {
        const institution = institutionById(event.institution_id);

        return [
            event.name,
            event.description,
            event.address,
            institution?.name,
            institution?.address,
            ...(event.tags || []).map(tag => tag.name)
        ].filter(Boolean).join(" ").toLocaleLowerCase("pl-PL");
    }

    function eventMatchesSearch(event) {
        return !state.search || searchableText(event).includes(state.search);
    }

    // LISTY WYDARZEŃ

    function createEventCard(event, past = false) {
        const institution = institutionById(event.institution_id);
        const card = el("article", "event");
        const info = el("div", "event-main");
        const tagsWrap = el("div", "event-tags");

        const tags = event.tags || [];
        const visibleTags = tags.slice(0, 3);

        if (visibleTags.length) {
            visibleTags.forEach(tag => {
                const tagElement = el("span", "event-type", tag.name);

                tagElement.style.backgroundColor = getTagColor(tag);
            

                tagsWrap.appendChild(tagElement);
            });

            if (tags.length > 3) {
                const more = el(
                    "span",
                    "event-type event-tag-more",
                    `+${tags.length - 3}`
                );

                tagsWrap.appendChild(more);
            }
        } else {
            tagsWrap.appendChild(
                el("span", "event-type", "Wydarzenie")
            );
        }

        info.appendChild(tagsWrap);
        info.appendChild(el("h3", null, event.name));

        const location = el("p");
        location.appendChild(el("i", "fa-solid fa-location-dot"));
        location.append(
            ` ${event.address || institution?.name || institution?.address || "Brak lokalizacji"}`
        );
        info.appendChild(location);

        const date = el("p");
        date.appendChild(el("i", "fa-regular fa-calendar"));
        date.append(` ${formatDate(event.starts_at)}`);
        info.appendChild(date);
        card.appendChild(info);

        if (past) {
            const avg = averageRating(opinionsFor("event", event.id));
            const right = el("div", "event-side");

            right.appendChild(el("div", "rating", avg ? `★ ${avg}` : "Brak ocen"));

            const button = el("button", "event-button", "Zobacz");
            button.type = "button";
            button.addEventListener("click", () => showEventDetails(event.id));

            right.appendChild(button);
            card.appendChild(right);
        } else {
            const button = el("button", "event-button", "Zobacz");
            button.type = "button";
            button.addEventListener("click", () => showEventDetails(event.id));
            card.appendChild(button);
        }

        return card;
    }

    function renderEventLists() {
        const upcoming = document.getElementById("upcomingEventsList");
        const past = document.getElementById("pastEventsList");

        upcoming.replaceChildren();
        past.replaceChildren();

        const upcomingEvents = state.events
            .filter(event => !eventIsPast(event) && eventMatchesSearch(event))
            .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));

        const pastEvents = state.events
            .filter(event => eventIsPast(event) && eventMatchesSearch(event))
            .sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at));

        if (!upcomingEvents.length) {
            upcoming.appendChild(el("p", "empty-state", "Brak nadchodzących wydarzeń."));
        }

        upcomingEvents.forEach(event => {
            upcoming.appendChild(createEventCard(event, false));
        });

        if (!pastEvents.length) {
            past.appendChild(el("p", "empty-state", "Brak minionych wydarzeń."));
        }

        pastEvents.forEach(event => {
            past.appendChild(createEventCard(event, true));
        });
    }
    const tagColors = {
    "ai/ml": "#9333EA",              // fioletowy
    "algorytmika": "#16A34A",        // zielony
    "automatyka": "#0D9488",         // turkusowy
    "cyberbezpieczeństwo": "#DC2626", // czerwony
    "elektronika": "#0891B2",        // morski
    "elektryka": "#CA8A04",          // złoty
    "fizyka": "#4F46E5",            // indygo
    "informatyka": "#EA580C",        // pomarańczowy
    "matematyka": "#BE185D",         // różowy
    "programowanie": "#000000",     // czarny
    "sieci komputerowe": "#92400E"  // brązowy
};
function getTagColor(tag) {
    const name = String(tag?.name || "")
        .trim()
        .toLocaleLowerCase("pl-PL");

    return tagColors[name] || "#52647A";
}

function getEventColor(event) {
    const tags = event.tags || [];

    const matchingTag = tags.find(tag =>
        selectedTags.has(String(tag.id))
    );

    return getTagColor(matchingTag || tags[0]);
}
function createColoredEventIcon(event) {
    const pin = document.createElement("div");
    pin.className = "edu-pin";
    pin.style.backgroundColor = getEventColor(event);

    const icon = document.createElement("i");
    icon.className = "fa-solid fa-book-bookmark";

    pin.appendChild(icon);

    return L.divIcon({
        className: "edu-marker",
        html: pin,
        iconSize: [40, 40],
        iconAnchor: [20, 40],
        popupAnchor: [0, -40],
        tooltipAnchor: [0, -35]
    });
}

    // MARKERY NA MAPIE

    function renderMap() {
        institutionLayer.clearLayers();
        eventLayer.clearLayers();

        const points = [];

        state.institutions.forEach(inst => {
            if (selectedTags.size > 0) {
                const hasMatchingEvent = state.events.some(event =>
                    Number(event.institution_id) === Number(inst.id) &&
                    !eventIsPast(event) &&
                    eventMatchesTags(event)
                );

        if (!hasMatchingEvent) return;
    }
            const lat = safeNumber(inst.latitude);
            const lng = safeNumber(inst.longitude);
            if (lat === null || lng === null) return;

            const marker = L.marker([lat, lng], {
                icon: eduMarkerIcon
            }).addTo(institutionLayer);

            marker.bindTooltip(inst.name, { direction: "top" });

            marker.on("click", leafletEvent => {
                if (leafletEvent.originalEvent) {
                    L.DomEvent.stopPropagation(leafletEvent.originalEvent);
                }

                showInstitutionDetails(inst.id);
            });

            points.push([lat, lng]);
        });

        let visibleEvents = 0;

    state.events.forEach(event => {
        if (!eventMatchesTags(event)) return;
        if (eventIsPast(event)) return;
        const lat = safeNumber(event.latitude);
        const lng = safeNumber(event.longitude);
                if (lat === null || lng === null) return;
                visibleEvents++;

                const marker = L.marker([lat, lng], {
                    icon: createColoredEventIcon(event)
                }).addTo(eventLayer);

            marker.bindTooltip(event.name, { direction: "top" });

            marker.on("click", leafletEvent => {
                if (leafletEvent.originalEvent) {
                    L.DomEvent.stopPropagation(leafletEvent.originalEvent);
                }

                showEventDetails(event.id);
            });

            points.push([lat, lng]);
        });

        if (firstMapFit && points.length) {
            firstMapFit = false;

            if (points.length === 1) {
                map.setView(points[0], 14);
            } else {
                map.fitBounds(points, {
                    padding: [50, 50],
                    maxZoom: 14
                });
            }
        }
    }

    // SZCZEGÓŁY MIEJSC I WYDARZEŃ

    function createBanner(url, alt) {
        if (!url) return null;

        const img = el("img", "details-banner");
        img.src = url;
        img.alt = alt;
        img.loading = "lazy";
        return img;
    }

    function safeExternalUrl(value) {
        try {
            const url = new URL(String(value), window.location.origin);
            return ["http:", "https:"].includes(url.protocol) ? url.href : null;
        } catch {
            return null;
        }
    }

    function createInfoLine(iconClass, label, value) {
        const p = el("p", "details-line");
        p.appendChild(el("i", iconClass));

        const strong = el("strong", null, `${label}: `);
        p.appendChild(strong);
        p.append(String(value || "—"));

        return p;
    }

    function createEventMiniItem(event) {
        const item = el("button", "sidebar-item sidebar-item-button");
        item.type = "button";
        item.appendChild(el("strong", null, event.name));
        item.appendChild(el("span", "muted-line", formatDate(event.starts_at)));
        item.addEventListener("click", () => showEventDetails(event.id));
        return item;
    }

    function createOpinionItem(opinion) {
    const item = el("article", "opinion-item");
    const header = el("div", "opinion-heading");

    const author = el(
        "strong",
        "opinion-author-label",
        opinion.author?.nickname || `Użytkownik #${opinion.author_id}`
    );

    const rating = el(
        "span",
        "opinion-score",
        `${opinion.rating}/5 ★`
    );

    header.append(author, rating);
    item.append(header, el("p", null, opinion.content));

    return item;
}
function createRatingSummary(opinions) {
    const summary = el("div", "reviews-summary");
    const average = averageRating(opinions);

    if (average === null) {
        summary.appendChild(
            el("p", "details-description", "Brak ocen. Dodaj pierwszą opinię.")
        );

        return summary;
    }

    const score = el(
        "strong",
        "reviews-average",
        String(average).replace(".", ",")
    );

    const info = el("div", "reviews-summary-info");

    // Szare gwiazdki i złote wypełnienie odpowiadające średniej
    const stars = el("div", "reviews-stars", "★★★★★");
    const fill = el("span", "reviews-stars-fill", "★★★★★");

    fill.style.width = `${Number(average) / 5 * 100}%`;
    stars.setAttribute("aria-hidden", "true");
    stars.appendChild(fill);

    info.append(
        stars,
        el("span", "reviews-count", `Liczba opinii: ${opinions.length}`)
    );

    summary.setAttribute(
        "aria-label",
        `Średnia ocena ${average} na 5. Liczba opinii: ${opinions.length}`
    );

    summary.append(score, info);

    return summary;
}

    function createOpinionForm(targetType, targetId) {
        const wrap = el("div", "opinion-compose");
        wrap.appendChild(el("h4", null, "Dodaj opinię"));

        if (!state.currentUser) {
            const note = el("p", "auth-required", "Zaloguj się, aby dodać opinię.");
            const button = el("button", "secondary-button", "Zaloguj się");

            button.type = "button";
            button.addEventListener("click", () => openWindow("profile"));

            wrap.append(note, button);
            return wrap;
        }

        const form = el("form", "opinion-form");
        const ratingLabel = el("fieldset", "rating-picker");
const legend = el("legend", null, "Twoja ocena");

ratingLabel.appendChild(legend);

// Obiekt zachowuje rating.value używane przy wysyłaniu formularza
const rating = { value: "5" };
const ratingButtons = [];

for (let value = 1; value <= 5; value++) {
    const button = el("button", "rating-star", "☆");

    button.type = "button";
    button.setAttribute("aria-label", `Oceń na ${value} z 5`);

    button.addEventListener("click", () => {
        rating.value = String(value);
        updateStars();
    });

    ratingButtons.push(button);
    ratingLabel.appendChild(button);
}

function updateStars() {
    ratingButtons.forEach((button, index) => {
        const filled = index < Number(rating.value);
        const selected = index + 1 === Number(rating.value);

        button.textContent = filled ? "★" : "☆";
        button.classList.toggle("filled", filled);
        button.setAttribute("aria-pressed", String(selected));
    });
}

updateStars();

        const contentLabel = el("label", null, "Treść");
        const textarea = el("textarea");

        textarea.name = "content";
        textarea.maxLength = 2000;
        textarea.required = true;
        textarea.placeholder = "Napisz, co sądzisz...";
        contentLabel.appendChild(textarea);

        const submit = el("button", "primary-button", "Dodaj opinię");
        submit.type = "submit";

        const status = el("p", "form-status");
        form.append(ratingLabel, contentLabel, submit, status);

        form.addEventListener("submit", async event => {
            event.preventDefault();
            submit.disabled = true;
            status.textContent = "Zapisywanie...";

            const payload = {
                rating: Number(rating.value),
                content: textarea.value.trim(),
                institution_id: targetType === "institution" ? Number(targetId) : null,
                event_id: targetType === "event" ? Number(targetId) : null
            };

            try {
                await apiSend(API.opinions, "POST", payload);
                await loadPublicData(false);
                status.textContent = "Opinia została dodana.";

                if (targetType === "institution") {
                    showInstitutionDetails(targetId, "reviews");
                } else {
                    showEventDetails(targetId, "reviews");
                }
            } catch (error) {
                status.textContent = error.message;
            } finally {
                submit.disabled = false;
            }
        });

        wrap.appendChild(form);
        return wrap;
    }

    function buildTabs(tabs, initial = "upcoming") {
        const buttons = el("div", "sidebar-options");
        const panes = el("div", "sidebar-tab-content");
        const refs = new Map();

        tabs.forEach(tab => {
            const button = el("button", "sidebar-btn", tab.label);
            button.type = "button";
            button.dataset.tab = tab.id;

            const pane = el("div", "sidebar-tab-pane");
            pane.dataset.pane = tab.id;
            tab.render(pane);

            buttons.appendChild(button);
            panes.appendChild(pane);
            refs.set(tab.id, { button, pane });

            button.addEventListener("click", () => activate(tab.id));
        });

        function activate(id) {
            refs.forEach(({ button, pane }, key) => {
                button.classList.toggle("active", key === id);
                pane.classList.toggle("active", key === id);
            });
        }

        activate(refs.has(initial) ? initial : tabs[0]?.id);

        const fragment = document.createDocumentFragment();
        fragment.append(buttons, panes);
        return fragment;
    }

    function openDetailsContainer(type, id) {
    closeAllWindows();
    activeDetails = { type, id };
    sidebar.classList.add("open");
    placeDetails.replaceChildren();

    const label = el(
        "p",
        "details-eyebrow",
        type === "event" ? "Wydarzenie" : "Instytucja"
    );

    placeDetails.appendChild(label);

    return placeDetails;
}

    function showInstitutionDetails(institutionId, initialTab = "upcoming") {
        const inst = institutionById(institutionId);
        if (!inst) return;

        const root = openDetailsContainer("institution", institutionId);
        const wrap = el("div", "info-inside");
        const banner = createBanner(inst.banner_url, `Baner ${inst.name}`);

        if (banner) wrap.appendChild(banner);

        wrap.appendChild(el("h2", null, inst.name));
        wrap.appendChild(el("p", "details-description", inst.description));
        wrap.appendChild(createInfoLine("fa-solid fa-location-dot", "Adres", inst.address));

        const websiteUrl = safeExternalUrl(inst.website);

        if (websiteUrl) {
            const line = el("p", "details-line");
            line.appendChild(el("i", "fa-solid fa-globe"));

            const link = el("a", null, " Strona internetowa");
            link.href = websiteUrl;
            link.target = "_blank";
            link.rel = "noopener noreferrer";

            line.appendChild(link);
            wrap.appendChild(line);
        }

        const events = state.events.filter(event => {
            return Number(event.institution_id) === Number(inst.id);
        });

        const upcoming = events
            .filter(event => !eventIsPast(event))
            .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));

        const past = events
            .filter(eventIsPast)
            .sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at));

        const opinions = opinionsFor("institution", inst.id);

        wrap.appendChild(buildTabs([
            {
                id: "upcoming",
                label: `Nadchodzące (${upcoming.length})`,
                render: pane => {
                    if (!upcoming.length) {
                        pane.appendChild(el("p", "empty-state", "Brak nadchodzących wydarzeń."));
                    }

                    upcoming.forEach(event => {
                        pane.appendChild(createEventMiniItem(event));
                    });
                }
            },
            {
                id: "past",
                label: `Minione (${past.length})`,
                render: pane => {
                    if (!past.length) {
                        pane.appendChild(el("p", "empty-state", "Brak minionych wydarzeń."));
                    }

                    past.forEach(event => {
                        pane.appendChild(createEventMiniItem(event));
                    });
                }
            },
            {
                id: "reviews",
                label: `Opinie (${opinions.length})`,
                render: pane => {
                    pane.appendChild(createRatingSummary(opinions));

                    opinions.forEach(opinion => {
                        pane.appendChild(createOpinionItem(opinion));
                    });

                    pane.appendChild(createOpinionForm("institution", inst.id));
                }
            }
        ], initialTab));

        root.appendChild(wrap);

        const lat = safeNumber(inst.latitude);
        const lng = safeNumber(inst.longitude);

        if (lat !== null && lng !== null) {
            map.setView([lat, lng], 16, { animate: true });

            if (window.innerWidth > 900) {
                setTimeout(() => map.panBy([-210, 0], { animate: true }), 100);
            }
        }
    }

    function showEventDetails(eventId, initialTab = "details") {
        const event = eventById(eventId);
        if (!event) return;

        const institution = institutionById(event.institution_id);
        const root = openDetailsContainer("event", eventId);
        const wrap = el("div", "info-inside");
        const banner = createBanner(event.banner_url, `Baner ${event.name}`);

        if (banner) wrap.appendChild(banner);

        wrap.appendChild(el("h2", null, event.name));

// Nazwa instytucji pod tytułem
if (institution) {
    const organizer = el(
        "button",
        "details-organizer",
        institution.name
    );

    organizer.type = "button";
    organizer.addEventListener("click", () => {
        showInstitutionDetails(institution.id);
    });

    wrap.appendChild(organizer);
}

// Opis wydarzenia
wrap.appendChild(
    el("p", "details-description", event.description)
);

// Start i koniec obok siebie
const dates = el("div", "details-dates");

function addDate(label, value) {
    const box = el("div", "details-date");

    box.appendChild(el("span", "details-date-label", label));
    box.appendChild(el("strong", null, formatDate(value)));

    dates.appendChild(box);
}

addDate("Start", event.starts_at);

if (event.ends_at) {
    addDate("Koniec", event.ends_at);
}

wrap.appendChild(dates);

// Adres
const address = el("p", "details-address");

address.appendChild(el("i", "fa-solid fa-location-dot"));
address.append(
    event.address || institution?.address || "Brak adresu"
);

wrap.appendChild(address);

// Kategorie jako zwykły tekst
if (event.tags?.length) {
    const tags = el(
        "p",
        "details-tags",
        event.tags.map(tag => tag.name).join(" · ")
    );

    wrap.appendChild(tags);
}

        const opinions = opinionsFor("event", event.id);

        wrap.appendChild(buildTabs([
            {
                id: "details",
                label: "Szczegóły",
                render: pane => {
                    if (institution) {
                        const button = el(
                            "button",
                            "secondary-button",
                            `Zobacz ${institution.name}`
                        );

                        button.type = "button";
                        button.addEventListener("click", () => {
                            showInstitutionDetails(institution.id);
                        });

                        pane.appendChild(button);
                    }
                }
            },
            {
                id: "reviews",
                label: `Opinie (${opinions.length})`,
                render: pane => {
                    pane.appendChild(createRatingSummary(opinions));

                    opinions.forEach(opinion => {
                        pane.appendChild(createOpinionItem(opinion));
                    });

                    pane.appendChild(createOpinionForm("event", event.id));
                }
            }
        ], initialTab));

        root.appendChild(wrap);

        const lat = safeNumber(event.latitude ?? institution?.latitude);
        const lng = safeNumber(event.longitude ?? institution?.longitude);

        if (lat !== null && lng !== null) {
            map.setView([lat, lng], 16, { animate: true });

            if (window.innerWidth > 900) {
                setTimeout(() => map.panBy([-210, 0], { animate: true }), 100);
            }
        }
    }

    async function loadPublicData(showErrors = true) {
        try {
            const [institutions, events, tags, opinions] = await Promise.all([
                apiGet(API.institutions),
                apiGet(API.events),
                apiGet(API.tags),
                apiGet(API.opinions)
            ]);

            state.institutions = institutions;
            state.events = events;
            state.tags = tags;
            state.opinions = opinions;

            renderTagFilters();
            renderEventLists();
            renderMap();
            renderEventFormOptions();
        } catch (error) {
            console.error(error);

            if (showErrors) {
                showStatus(`Nie udało się pobrać danych: ${error.message}`, "error");
            }
        }
    }

    const searchInput = document.getElementById("globalSearch");
const searchResults = document.getElementById("searchResults");

function showSearchResults() {
    const query = searchInput.value.trim().toLocaleLowerCase("pl-PL");

    const events = state.events.filter(event =>
        !eventIsPast(event) &&
        event.name.toLocaleLowerCase("pl-PL").includes(query)
    );

    searchResults.replaceChildren();
    searchResults.hidden = false;

    events.forEach(event => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = event.name;
        button.style.setProperty("--tag-color", getEventColor(event));

        button.addEventListener("click", () => {
            searchResults.hidden = true;
            showEventDetails(event.id);
        });

        searchResults.appendChild(button);
    });

    if (!events.length) {
        const message = document.createElement("p");
        message.textContent = "Nie znaleziono wydarzeń.";
        searchResults.appendChild(message);
    }
}

searchInput.addEventListener("focus", showSearchResults);
searchInput.addEventListener("click", showSearchResults);
searchInput.addEventListener("input", showSearchResults);

document.addEventListener("click", event => {
    if (!searchInput.closest(".search").contains(event.target)) {
        searchResults.hidden = true;
    }
});

searchInput.closest(".search").addEventListener("keydown", event => {
    if (event.key === "Escape") {
        searchInput.focus();
        searchResults.hidden = true;
    }
});

    // AUTORYZACJA I PROFIL

    const accountName = document.getElementById("accountName");
    const accountRole = document.getElementById("accountRole");
    const loginForm = document.getElementById("loginForm");
    const loginStatus = document.getElementById("loginStatus");
    const profileSummary = document.getElementById("profileSummary");
    const addEventDock = document.getElementById("addEventDock");

    function applyAuthUI() {
        const user = state.currentUser;

        accountName.textContent = user?.nickname || "Gość";
        accountRole.textContent = user ? roleLabel(user.role) : "Zaloguj się";
        loginForm.hidden = Boolean(user);
        profileSummary.hidden = !user;

        if (user) {
            document.getElementById("profileNickname").textContent = user.nickname;
            document.getElementById("profileFullName").textContent =
                `${user.name} ${user.surname}`;
            document.getElementById("profileRole").textContent = roleLabel(user.role);
            document.getElementById("profileEmail").textContent = user.email;
            document.getElementById("profileBio").textContent = user.bio || "Brak bio.";
        }

        addEventDock.classList.toggle("locked", !isTeacher(user));
        addEventDock.title = isTeacher(user)
            ? "Dodaj wydarzenie"
            : "Dodawanie wydarzeń jest dostępne dla nauczycieli";

        document.getElementById("chatLocked").hidden = Boolean(user);

        if (!user) {
            disconnectChat();
            hideMiniProfile();
        } else {
            connectChat();
        }
    }

    async function refreshAuth() {
        try {
            const response = await fetch(API.authMe, {
                headers: { Accept: "application/json" }
            });

            if (!response.ok) {
                state.currentUser = null;
                applyAuthUI();
                return false;
            }

            state.currentUser = await response.json();
            applyAuthUI();
            return true;
        } catch (error) {
            console.error(error);
            state.currentUser = null;
            applyAuthUI();
            return false;
        }
    }

    loginForm.addEventListener("submit", async event => {
        event.preventDefault();

        const loginInput = document.getElementById("schoolLogin");
        loginInput.value = loginInput.value.trim();

        if (!loginForm.reportValidity()) return;

        const email = loginInput.value + "@zse.krakow.pl";
        const password = loginForm.querySelector('[name="password"]').value;
        const submit = loginForm.querySelector('button[type="submit"]');

        submit.disabled = true;
        loginStatus.textContent = "Logowanie...";
        loginStatus.style.color = "var(--gray)";
        disconnectChat();

        try {
            const result = await apiSend(API.authLogin, "POST", {
                email,
                password
            });

            state.currentUser = result.user;
            loginForm.reset();
            loginStatus.textContent = "";
            applyAuthUI();
            showStatus(`Zalogowano jako ${result.user.nickname}.`, "success");
            loginStatus.style.color = "#0f8913";
            loginStatus.style.fontWeight = "bold";
        } catch (error) {
            state.currentUser = null;
            loginStatus.textContent = error.message;
            loginStatus.style.color = "#cc3535";
            loginStatus.style.fontWeight = "bold";
            applyAuthUI();
        } finally {
            submit.disabled = false;
        }
    });

    document.getElementById("logoutButton").addEventListener("click", async () => {
        disconnectChat();

        try {
            await fetch(API.authLogout, { method: "POST" });
        } catch (error) {
            console.error(error);
        }

        state.currentUser = null;
        applyAuthUI();
        showStatus("Wylogowano.", "success");
    });

    document.getElementById("openLoginFromChat").addEventListener("click", () => {
        openWindow("profile");
    });
    // =========================================================
// REALTIME REFRESH DANYCH
// =========================================================

let updatesSocket = null;
let realtimeRefreshTimer = null;

function refreshActiveDetailsAfterRealtime() {
    if (!activeDetails) return;

    if (activeDetails.type === "institution") {
        const institution = institutionById(activeDetails.id);

        if (!institution) {
            closeSidebar();
            return;
        }

        showInstitutionDetails(activeDetails.id);
    }

    if (activeDetails.type === "event") {
        const event = eventById(activeDetails.id);

        if (!event) {
            closeSidebar();
            return;
        }

        showEventDetails(activeDetails.id);
    }
}


function scheduleRealtimeRefresh(data = {}) {
    clearTimeout(realtimeRefreshTimer);

    realtimeRefreshTimer = setTimeout(async () => {
        try {
            await loadPublicData(false);

            refreshActiveDetailsAfterRealtime();

            if (
                data.resource === "user" &&
                state.currentUser
            ) {
                await refreshAuth();
            }
        } catch (error) {
            console.error("Realtime refresh error:", error);
        }
    }, 120);
}


    function connectUpdatesSocket() {
        if (updatesSocket) return;

        if (typeof io !== "function") {
            console.error("Socket.IO nie jest dostępne.");
            return;
        }

        updatesSocket = io("/updates", {
            forceNew: true
        });

        updatesSocket.on("connect", () => {
            console.log("[UPDATES] połączono");
        });

        updatesSocket.on("disconnect", reason => {
            console.log("[UPDATES] rozłączono:", reason);
        });

        updatesSocket.on("connect_error", error => {
            console.error("[UPDATES] błąd:", error);
        });

        updatesSocket.on("data_changed", data => {
            console.log("[UPDATES] zmiana:", data);

            scheduleRealtimeRefresh(data);
        });
    }
    // CZAT SOCKET.IO I MINIPROFIL

    const chatMessages = document.getElementById("chatMessages");
    const chatMessageForm = document.getElementById("chatMessageForm");
    const chatMessageInput = document.getElementById("chatMessageInput");
    const chatSendButton = document.getElementById("chatSendButton");
    const chatStatusDot = document.getElementById("chatStatusDot");

    let chatSocket = null;

    function setChatConnected(connected) {
        chatStatusDot.classList.toggle("connected", connected);
        chatMessageInput.disabled = !connected;
        chatSendButton.disabled = !connected;

        chatMessageInput.placeholder = state.currentUser
            ? (connected ? "Napisz wiadomość..." : "Łączenie z czatem...")
            : "Zaloguj się, aby pisać";
    }

    function addChatMessage({
        type = "message",
        user_id = null,
        nickname = null,
        message = "",
        sent_at = null
    }) {
        const article = el(
            "div",
            type === "system" ? "chat-message system" : "chat-message"
        );

        if (type === "system") {
            article.appendChild(el("div", "chat-system-label", "SYSTEM"));
            article.appendChild(el("p", null, message));
        } else {
            const meta = el("div", "chat-user");
            const userButton = el("button", "chat-user-button", nickname || "Użytkownik");
            userButton.type = "button";

            if (user_id !== null) {
                userButton.addEventListener("click", () => showMiniProfile(user_id));
            } else {
                userButton.disabled = true;
            }

            const when = sent_at ? new Date(sent_at) : new Date();
            const time = Number.isNaN(when.getTime())
                ? ""
                : when.toLocaleTimeString("pl-PL", {
                    hour: "2-digit",
                    minute: "2-digit"
                });

            meta.append(userButton, el("span", null, time));
            article.append(meta, el("p", null, message));
        }

        chatMessages.appendChild(article);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function buildChatSocket() {
        if (chatSocket) return chatSocket;

        if (typeof io !== "function") {
            showStatus("Nie załadowała się biblioteka Socket.IO.", "error");
            return null;
        }

        chatSocket = io("/chat", {
            autoConnect: false,
            forceNew: true
        });

        chatSocket.on("connect", () => setChatConnected(true));
        chatSocket.on("disconnect", () => setChatConnected(false));

        chatSocket.on("connect_error", error => {
            setChatConnected(false);

            if (state.currentUser) {
                showStatus(
                    `Czat: ${error.message || "odrzucono połączenie"}`,
                    "error"
                );
            }
        });

        chatSocket.on("chat_ready", data => {
            addChatMessage({
                type: "system",
                message: `Połączono z chatem jako ${data.nickname}.`
            });
        });

        chatSocket.on("chat_system", data => {
            addChatMessage({
                type: "system",
                message: data.message
            });
        });

        chatSocket.on("chat_message", data => addChatMessage(data));

        chatSocket.on("chat_error", data => {
            addChatMessage({
                type: "system",
                message: `Błąd: ${data.error}`
            });
        });

        return chatSocket;
    }

    function connectChat() {
        if (!state.currentUser) {
            setChatConnected(false);
            return;
        }

        const socket = buildChatSocket();

        if (socket && !socket.connected) {
            socket.connect();
        }
    }

    function disconnectChat() {
        if (chatSocket?.connected) chatSocket.disconnect();
        setChatConnected(false);
    }

    chatMessageForm.addEventListener("submit", event => {
        event.preventDefault();

        const message = chatMessageInput.value.trim();
        if (!message || !state.currentUser || !chatSocket?.connected) return;

        chatSocket.emit("chat_message", { message }, response => {
            if (response?.ok === false) {
                addChatMessage({
                    type: "system",
                    message: `Nie wysłano: ${response.error}`
                });
            }
        });

        chatMessageInput.value = "";
        chatMessageInput.focus();
    });

    async function showMiniProfile(userId) {
        const card = document.getElementById("chatProfileCard");
        card.hidden = false;

        document.getElementById("miniProfileNickname").textContent = "Ładowanie...";
        document.getElementById("miniProfileName").textContent = "";
        document.getElementById("miniProfileRole").textContent = "";
        document.getElementById("miniProfileBio").textContent = "";

        try {
            let user;

            if (state.currentUser && Number(state.currentUser.id) === Number(userId)) {
                user = state.currentUser;
            } else {
                user = await apiGet(API.publicProfile(userId));
            }

            document.getElementById("miniProfileNickname").textContent = user.nickname;
            document.getElementById("miniProfileName").textContent =
                `${user.name} ${user.surname}`;
            document.getElementById("miniProfileRole").textContent = roleLabel(user.role);
            document.getElementById("miniProfileBio").textContent = user.bio || "Brak bio.";
        } catch (error) {
            document.getElementById("miniProfileNickname").textContent =
                "Nie udało się wczytać profilu";
            document.getElementById("miniProfileBio").textContent = error.message;
        }
    }

    function hideMiniProfile() {
        document.getElementById("chatProfileCard").hidden = true;
    }

    document.getElementById("closeChatProfile").addEventListener("click", hideMiniProfile);

    // FORMULARZ WYDARZENIA DLA NAUCZYCIELA

    const addEventForm = document.getElementById("addEventForm");
    const eventBannerFile = document.getElementById("eventBannerFile");
    const eventBannerPreview = document.getElementById("eventBannerPreview");

    let bannerObjectUrl = null;

    function renderEventFormOptions() {
        const institutionSelect = document.getElementById("eventInstitution");
        const tagSelect = document.getElementById("eventTags");
        const institutionValue = institutionSelect.value;

        const selectedTags = new Set(
            [...tagSelect.selectedOptions].map(option => option.value)
        );

        institutionSelect.replaceChildren();
        tagSelect.replaceChildren();

        if (!state.institutions.length) {
            const option = el(
                "option",
                null,
                "Brak instytucji — dodaj ją w panelu zarządzania"
            );

            option.value = "";
            institutionSelect.appendChild(option);
        } else {
            state.institutions.forEach(inst => {
                const option = el("option", null, inst.name);
                option.value = String(inst.id);
                institutionSelect.appendChild(option);
            });

            if ([...institutionSelect.options].some(option => {
                return option.value === institutionValue;
            })) {
                institutionSelect.value = institutionValue;
            }
        }

        state.tags.forEach(tag => {
            const option = el("option", null, tag.name);
            option.value = String(tag.id);
            option.selected = selectedTags.has(option.value);
            tagSelect.appendChild(option);
        });
    }

    function setEventCoordinates(lat, lng) {
        document.getElementById("eventLatitude").value = Number(lat).toFixed(6);
        document.getElementById("eventLongitude").value = Number(lng).toFixed(6);

        if (eventSelectionMarker) {
            selectionLayer.removeLayer(eventSelectionMarker);
        }

        eventSelectionMarker = L.circleMarker([lat, lng], {
            radius: 9,
            weight: 3,
            fillOpacity: 0.8
        })
            .bindTooltip("Nowe wydarzenie", {
                permanent: true,
                direction: "top"
            })
            .addTo(selectionLayer);
    }

    function clearEventCoordinates() {
        document.getElementById("eventLatitude").value = "";
        document.getElementById("eventLongitude").value = "";

        if (eventSelectionMarker) {
            selectionLayer.removeLayer(eventSelectionMarker);
            eventSelectionMarker = null;
        }
    }

    document.getElementById("pickEventLocation").addEventListener("click", () => {
        if (!isTeacher()) return requestAddEventWindow();

        eventLocationPicking = true;
        document.getElementById("eventLocationHint").textContent =
            "Kliknij punkt na mapie. Formularz otworzy się ponownie po wyborze.";

        setWindowOpen(addWindow, false);
        showStatus("Kliknij na mapie, aby ustawić lokalizację wydarzenia.", "info");
    });

    document.getElementById("clearEventLocation").addEventListener("click", () => {
        eventLocationPicking = false;
        clearEventCoordinates();
        document.getElementById("eventLocationHint").textContent =
            "Współrzędne są opcjonalne.";
    });

    eventBannerFile.addEventListener("change", () => {
        if (bannerObjectUrl) URL.revokeObjectURL(bannerObjectUrl);

        const file = eventBannerFile.files[0];

        if (!file) {
            eventBannerPreview.hidden = true;
            eventBannerPreview.removeAttribute("src");
            return;
        }

        bannerObjectUrl = URL.createObjectURL(file);
        eventBannerPreview.src = bannerObjectUrl;
        eventBannerPreview.hidden = false;
    });

    document.getElementById("clearEventBanner").addEventListener("click", () => {
        eventBannerFile.value = "";
        addEventForm.elements.banner_url.value = "";

        if (bannerObjectUrl) URL.revokeObjectURL(bannerObjectUrl);

        bannerObjectUrl = null;
        eventBannerPreview.hidden = true;
        eventBannerPreview.removeAttribute("src");
    });

    async function uploadBanner(file) {
        if (!file) return null;

        const formData = new FormData();
        formData.append("banner", file);

        return readResponse(await fetch(API.bannerUpload, {
            method: "POST",
            body: formData,
            headers: { Accept: "application/json" }
        }));
    }

    addEventForm.addEventListener("submit", async event => {
        event.preventDefault();

        const status = document.getElementById("addEventStatus");
        const submit = document.getElementById("addEventSubmit");

        if (!isTeacher()) {
            status.textContent = "Tylko nauczyciel może dodać wydarzenie z tej strony.";
            return;
        }

        submit.disabled = true;
        status.textContent = "Zapisywanie...";

        try {
            const upload = await uploadBanner(eventBannerFile.files[0]);

            if (upload?.banner_url) {
                addEventForm.elements.banner_url.value = upload.banner_url;
            }

            const payload = {
                institution_id: Number(addEventForm.elements.institution_id.value),
                name: addEventForm.elements.name.value.trim(),
                description: addEventForm.elements.description.value.trim(),
                starts_at: addEventForm.elements.starts_at.value,
                ends_at: addEventForm.elements.ends_at.value || null,
                address: addEventForm.elements.address.value.trim() || null,
                latitude: addEventForm.elements.latitude.value
                    ? Number(addEventForm.elements.latitude.value)
                    : null,
                longitude: addEventForm.elements.longitude.value
                    ? Number(addEventForm.elements.longitude.value)
                    : null,
                banner_url: addEventForm.elements.banner_url.value || null,
                tag_ids: [...addEventForm.elements.tag_ids.selectedOptions].map(option => {
                    return Number(option.value);
                })
            };

            const created = await apiSend(API.events, "POST", payload);
            status.textContent = "Wydarzenie dodane.";

            addEventForm.reset();
            clearEventCoordinates();
            eventBannerPreview.hidden = true;
            eventBannerPreview.removeAttribute("src");

            if (bannerObjectUrl) URL.revokeObjectURL(bannerObjectUrl);
            bannerObjectUrl = null;

            await loadPublicData(false);
            setWindowOpen(addWindow, false);
            showStatus(`Dodano wydarzenie „${created.name}”.`, "success");
        } catch (error) {
            status.textContent = error.message;
        } finally {
            submit.disabled = false;
        }
    });

    // URUCHOMIENIE

    window.addEventListener("resize", () => {
        stopDragging();
        map.invalidateSize(false);

        if (window.innerWidth <= 900) {
            windows.forEach(resetPosition);
        }
    });

    window.addEventListener("load", () => map.invalidateSize(false));

    setChatConnected(false);
    connectUpdatesSocket();
    let lastEventTimeState = "";

    function refreshEvents() {
        const currentState = state.events
            .map(event => `${event.id}:${eventIsPast(event) ? 1 : 0}`)
            .join("|");

        if (currentState === lastEventTimeState) {
            return;
        }

        lastEventTimeState = currentState;

        renderEventLists();
        renderMap();
    };
    const notificationsList = document.getElementById("notificationsList");
const notificationDot = document.getElementById("notificationDot");

let knownEventIds = null;

async function checkNewEvents() {
    try {
        const events = await apiGet(API.events);

        // Pierwsze pobranie zapamiętuje istniejące wydarzenia.
        // Nie wysyłamy powiadomień o całej starej bazie.
        if (knownEventIds === null) {
            knownEventIds = new Set(
                events.map(event => String(event.id))
            );
            return;
        }

        const newEvents = events.filter(event =>
            !knownEventIds.has(String(event.id))
        );

        if (!newEvents.length) return;

        // Aktualizacja danych żeby kliknięcie otworzyło nowe wydarzenie.
        state.events = events;
        renderEventLists();
        renderMap();

        // Usuwanie napisu 
        notificationsList.querySelector("p")?.remove();

        newEvents.forEach(event => {
            knownEventIds.add(String(event.id));

            const button = document.createElement("button");
            button.className = "notification-item";
            button.type = "button";

            const label = document.createElement("span");
            label.textContent = "Nowe wydarzenie";

            const title = document.createElement("strong");
            title.textContent = event.name;

            button.append(label, title);

            button.addEventListener("click", () => {
                showEventDetails(event.id);
            });

            notificationsList.prepend(button);
        });

        notificationDot.hidden = false;
        document.querySelector(".bell").classList.add("has-notification");
    } catch (error) {
        console.error("Nie udało się sprawdzić powiadomień:", error);
    }
}
// Refresh stronki po kliknieciu uniradar-brand
 document.getElementById("uniradar-brand").addEventListener("click", async () => {
     window.location.reload();
 })
// Chowanie info o stronce
const notification = document.querySelector(".project-notification-box");

if (localStorage.getItem("notificationAccepted") === "true") {
    notification.style.display = "none";
}

document.getElementById("project-notification-accept").addEventListener("click", () => {
    notification.style.display = "none";
    localStorage.setItem("notificationAccepted", "true");
});
//  Usuwanie kropki przy dzwonku po otwarciu
document.querySelector('.bell[data-window="notifications"]')
    .addEventListener("click", () => {
        notificationDot.hidden = true;
        document.querySelector(".bell").classList.remove("has-notification");
    });

// Następne sprawdzenie  po zakończeniu poprzedniego.
async function watchNewEvents() {
    await checkNewEvents();
    setTimeout(watchNewEvents, 30000);
}

watchNewEvents();

    Promise.all([
        loadPublicData(),
        refreshAuth()
    ]).then(() => {
        renderEventFormOptions();
        refreshEvents();
        setInterval(refreshEvents, 30_000);
    });
});