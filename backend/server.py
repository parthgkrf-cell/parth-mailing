#!/usr/bin/env python3
"""Parth Mailing relay.

Local HTTP service for the liquid-glass mailing desk. It signs people in with a
5-minute code, keeps mailbox passwords on this machine, and sends campaigns with
pace control, provider caps, and an Excel report.

Run: python server.py
"""

import base64
import csv
import datetime
import io
import email.utils
import hashlib
import hmac
import html
import imaplib
import json
import os
import random
import re
import secrets
import shutil
import smtplib
import socket
import sqlite3
import ssl
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from contextlib import contextmanager
from email import encoders
from email.header import Header
from email.mime.base import MIMEBase
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo

import drive_sync
import xlsx_writer

GMAIL_DAILY_CAP = 400
WORKSPACE_DAILY_CAP = 1800
GMAIL_CONSUMER_GAP = 90.0
EMAIL_RE = re.compile(r"^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$", re.I)
REPORT_HEADERS = [
    "Email", "First Name", "Last Name", "Company", "Custom1",
    "Status", "Timestamp (UTC)", "SMTP Code", "Error",
]

if getattr(sys, "frozen", False):
    BUNDLE = sys._MEIPASS
    ROOT = os.path.dirname(sys.executable)
else:
    BUNDLE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    ROOT = BUNDLE

FRONTEND = os.path.join(BUNDLE, "frontend")
if not os.path.isdir(FRONTEND):
    FRONTEND = os.path.join(ROOT, "frontend")
CONFIG_DIR = os.path.join(ROOT, "config")
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.json")
DATA_DIR = os.path.join(ROOT, "data")
DB_PATH = os.path.join(DATA_DIR, "parth_mailing.db")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
REPORT_DIR = os.path.join(DATA_DIR, "reports")
ATTACH_DIR = os.path.join(DATA_DIR, "attachments")
LOG_PATH = os.path.join(DATA_DIR, "relay.log")
MAILBOX_STATUS_PATH = os.path.join(DATA_DIR, "mailbox_status.json")

_db_lock = threading.RLock()
_cfg_cache = {"mtime": None, "data": None}
_pool_lock = threading.Lock()
_pool = {}
STOP_ENGINE = threading.Event()
SLEEP_UNTIL = {}
BATCH_COUNT = {}
DISPATCH_LOCK = threading.Lock()
DISPATCH_BUSY = set()


class ApiError(Exception):
    def __init__(self, message, code=400):
        super().__init__(message)
        self.message = message
        self.code = code


def log(message):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}"
    # A closed console must not abort the HTTP response. send_response logs
    # before any bytes are written, so a failed print used to look like
    # ERR_EMPTY_RESPONSE in the browser.
    try:
        print(line, flush=True)
    except Exception:
        pass
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def ensure_dirs():
    for path in (CONFIG_DIR, DATA_DIR, UPLOAD_DIR, REPORT_DIR, ATTACH_DIR):
        os.makedirs(path, exist_ok=True)


def example_config_path():
    for path in (
        os.path.join(CONFIG_DIR, "config.example.json"),
        os.path.join(BUNDLE, "config", "config.example.json"),
    ):
        if os.path.isfile(path):
            return path
    return ""


def ensure_config():
    ensure_dirs()
    if not os.path.isfile(CONFIG_PATH):
        source = example_config_path()
        if not source:
            raise SystemExit("config.example.json is missing.")
        shutil.copy(source, CONFIG_PATH)
        log(f"Created {CONFIG_PATH}")
    with open(CONFIG_PATH, "r", encoding="utf-8") as handle:
        config = json.load(handle)
    if config.get("token_secret") in (None, "", "change-me"):
        config["token_secret"] = secrets.token_hex(32)
        with open(CONFIG_PATH, "w", encoding="utf-8") as handle:
            json.dump(config, handle, indent=2)
        log("Wrote a new session secret into config.json.")
    _cfg_cache["mtime"] = os.path.getmtime(CONFIG_PATH)
    _cfg_cache["data"] = config
    return config


def load_config():
    try:
        mtime = os.path.getmtime(CONFIG_PATH)
    except OSError:
        return ensure_config()
    if _cfg_cache["data"] is None or _cfg_cache["mtime"] != mtime:
        with open(CONFIG_PATH, "r", encoding="utf-8") as handle:
            _cfg_cache["data"] = json.load(handle)
        _cfg_cache["mtime"] = mtime
    data = _cfg_cache["data"]
    if not isinstance(data.get("google_sign_in"), dict):
        data["google_sign_in"] = {"client_id": ""}
        with open(CONFIG_PATH, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2)
            handle.write("\n")
        _cfg_cache["mtime"] = os.path.getmtime(CONFIG_PATH)
        _cfg_cache["data"] = data
    return data


@contextmanager
def db():
    _db_lock.acquire()
    conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
        _db_lock.release()


def init_db():
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                email TEXT PRIMARY KEY,
                role TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                limits_json TEXT,
                created_at REAL,
                last_login REAL,
                display_name TEXT,
                password_hash TEXT,
                password_salt TEXT,
                password_set INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS otps (
                email TEXT PRIMARY KEY,
                code_hash TEXT,
                salt TEXT,
                expires_at REAL,
                attempts INTEGER,
                sent_at REAL,
                purpose TEXT
            );
            CREATE TABLE IF NOT EXISTS grants (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL,
                sender_id TEXT NOT NULL,
                status TEXT NOT NULL,
                limits_json TEXT,
                requested_at REAL,
                decided_at REAL,
                UNIQUE(email, sender_id)
            );
            CREATE TABLE IF NOT EXISTS campaigns (
                id TEXT PRIMARY KEY,
                owner TEXT NOT NULL,
                sender_id TEXT,
                subject TEXT,
                html TEXT,
                cc TEXT,
                bcc TEXT,
                status TEXT,
                schedule_at REAL,
                timezone TEXT,
                pace_json TEXT,
                hold_reason TEXT DEFAULT '',
                created_at REAL,
                started_at REAL,
                finished_at REAL,
                source_name TEXT DEFAULT '',
                source_path TEXT DEFAULT '',
                report_path TEXT DEFAULT '',
                drive_upload_url TEXT DEFAULT '',
                drive_report_url TEXT DEFAULT '',
                sent_count INTEGER DEFAULT 0,
                failed_count INTEGER DEFAULT 0,
                bounced_count INTEGER DEFAULT 0,
                total_count INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS recipients (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                campaign_id TEXT NOT NULL,
                email TEXT NOT NULL,
                first_name TEXT DEFAULT '',
                last_name TEXT DEFAULT '',
                company TEXT DEFAULT '',
                custom1 TEXT DEFAULT '',
                fields_json TEXT DEFAULT '{}',
                status TEXT NOT NULL,
                error TEXT DEFAULT '',
                smtp_code TEXT DEFAULT '',
                sent_at REAL,
                sender_id TEXT DEFAULT '',
                ready_at REAL
            );
            CREATE INDEX IF NOT EXISTS idx_rec_camp ON recipients(campaign_id, status);
            CREATE INDEX IF NOT EXISTS idx_rec_sent ON recipients(status, sent_at);
            CREATE TABLE IF NOT EXISTS drafts (
                id TEXT PRIMARY KEY,
                owner TEXT NOT NULL,
                payload_json TEXT,
                updated_at REAL
            );
            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                campaign_id TEXT NOT NULL,
                filename TEXT,
                mime TEXT,
                path TEXT
            );
            CREATE TABLE IF NOT EXISTS audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor TEXT,
                action TEXT,
                detail TEXT,
                created_at REAL
            );
            CREATE TABLE IF NOT EXISTS pace (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sender_email TEXT,
                sent_at REAL
            );
            CREATE INDEX IF NOT EXISTS idx_pace ON pace(sender_email, sent_at);
            CREATE TABLE IF NOT EXISTS sent_people (
                email TEXT PRIMARY KEY,
                first_sent_at REAL,
                last_sent_at REAL,
                send_count INTEGER NOT NULL DEFAULT 1,
                last_owner TEXT,
                last_campaign_id TEXT
            );
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        columns = {row[1] for row in conn.execute("PRAGMA table_info(campaigns)")}
        if "skipped_count" not in columns:
            conn.execute("ALTER TABLE campaigns ADD COLUMN skipped_count INTEGER DEFAULT 0")
        if "dispatch_action" not in columns:
            conn.execute("ALTER TABLE campaigns ADD COLUMN dispatch_action TEXT DEFAULT 'send'")
        if "sender_ids_json" not in columns:
            conn.execute("ALTER TABLE campaigns ADD COLUMN sender_ids_json TEXT DEFAULT '[]'")
        if "drafted_count" not in columns:
            conn.execute("ALTER TABLE campaigns ADD COLUMN drafted_count INTEGER DEFAULT 0")
        rec_cols = {row[1] for row in conn.execute("PRAGMA table_info(recipients)")}
        if "sender_id" not in rec_cols:
            conn.execute("ALTER TABLE recipients ADD COLUMN sender_id TEXT DEFAULT ''")
        if "ready_at" not in rec_cols:
            conn.execute("ALTER TABLE recipients ADD COLUMN ready_at REAL")
        existing = conn.execute("SELECT 1 FROM app_settings WHERE key='desk_ui'").fetchone()
        if not existing:
            conn.execute(
                "INSERT INTO app_settings (key, value) VALUES ('desk_ui', ?)",
                (json.dumps(default_desk_ui()),),
            )
        conn.execute(
            """
            INSERT OR IGNORE INTO sent_people (email, first_sent_at, last_sent_at, send_count, last_owner, last_campaign_id)
            SELECT r.email, MIN(r.sent_at), MAX(r.sent_at), COUNT(*), '', ''
            FROM recipients r
            WHERE r.status='SENT' AND r.email != ''
            GROUP BY r.email
            """
        )
        existing = {row[1] for row in conn.execute("PRAGMA table_info(users)")}
        for name, spec in (
            ("display_name", "TEXT"),
            ("password_hash", "TEXT"),
            ("password_salt", "TEXT"),
            ("password_set", "INTEGER NOT NULL DEFAULT 0"),
        ):
            if name not in existing:
                conn.execute(f"ALTER TABLE users ADD COLUMN {name} {spec}")
        otp_cols = {row[1] for row in conn.execute("PRAGMA table_info(otps)")}
        if "purpose" not in otp_cols:
            conn.execute("ALTER TABLE otps ADD COLUMN purpose TEXT")
        conn.execute(
            "UPDATE users SET enabled=1 WHERE IFNULL(enabled,1)=0 AND IFNULL(password_set,0)=0"
        )


def default_desk_ui():
    return {
        "brand_name": "Parth",
        "brand_tagline": "Mailing",
        "welcome_title": "Desk",
        "welcome_text": "Sender access, relay status, and recent campaigns",
        "banner": "",
        "accent": "#7dd3c7",
        "accent_2": "#8b9dff",
        "radius": 22,
        "force_theme": "",
        "allow_theme_toggle": True,
        "show_desk": True,
        "show_recipients": True,
        "show_campaigns": True,
        "show_history": True,
        "show_compose": True,
        "show_pace": True,
        "show_schedule": True,
        "show_attachments": True,
        "show_cc": True,
        "show_variables": True,
        "clock_timezone": "",
        "block_repeat_recipients": True,
        "global_daily_cap": 0,
        "show_preview": True,
        "show_config": True,
        "labels": {
            "home": "Desk",
            "recipients": "Import Excel",
            "compose": "Composer",
            "preview": "Preview",
            "campaigns": "Campaigns",
            "history": "History",
            "config": "Configuration",
        },
    }


def _hex_color(value, fallback):
    text = str(value or "").strip()
    if re.fullmatch(r"#[0-9A-Fa-f]{6}", text):
        return text.lower()
    return fallback


def normalize_desk_ui(raw):
    base = default_desk_ui()
    incoming = raw if isinstance(raw, dict) else {}
    ui = dict(base)
    ui.update({key: incoming.get(key, base[key]) for key in base})
    ui["brand_name"] = str(ui.get("brand_name") or "Parth").strip()[:40] or "Parth"
    ui["brand_tagline"] = str(ui.get("brand_tagline") or "").strip()[:60]
    ui["welcome_title"] = str(ui.get("welcome_title") or "Desk").strip()[:40] or "Desk"
    ui["welcome_text"] = str(ui.get("welcome_text") or "").strip()[:240]
    ui["banner"] = str(ui.get("banner") or "").strip()[:400]
    ui["accent"] = _hex_color(ui.get("accent"), base["accent"])
    ui["accent_2"] = _hex_color(ui.get("accent_2"), base["accent_2"])
    try:
        ui["radius"] = max(8, min(32, int(ui.get("radius") or 22)))
    except (TypeError, ValueError):
        ui["radius"] = 22
    theme = str(ui.get("force_theme") or "").lower()
    ui["force_theme"] = theme if theme in ("light", "dark") else ""
    zone = str(ui.get("clock_timezone") or "").strip()
    if zone:
        try:
            ZoneInfo(zone)
        except Exception:
            zone = ""
    ui["clock_timezone"] = zone
    try:
        ui["global_daily_cap"] = max(0, min(1_000_000, int(ui.get("global_daily_cap") or 0)))
    except (TypeError, ValueError):
        ui["global_daily_cap"] = 0
    for key in (
        "allow_theme_toggle", "show_desk", "show_recipients", "show_campaigns", "show_history",
        "show_compose", "show_preview", "show_config", "show_pace", "show_schedule",
        "show_attachments", "show_cc", "show_variables", "block_repeat_recipients",
    ):
        ui[key] = bool(ui.get(key))
    labels = dict(base["labels"])
    supplied = incoming.get("labels") if isinstance(incoming.get("labels"), dict) else {}
    for key in labels:
        text = str(supplied.get(key) or labels[key]).strip()[:24]
        labels[key] = text or base["labels"][key]
    ui["labels"] = labels
    return ui


def desk_ui_from_conn(conn):
    row = conn.execute("SELECT value FROM app_settings WHERE key='desk_ui'").fetchone()
    if not row:
        return default_desk_ui()
    try:
        return normalize_desk_ui(json.loads(row["value"]))
    except json.JSONDecodeError:
        return default_desk_ui()


def load_desk_ui():
    with db() as conn:
        return desk_ui_from_conn(conn)


def save_desk_ui(conn, ui):
    clean = normalize_desk_ui(ui)
    conn.execute(
        """
        INSERT INTO app_settings (key, value) VALUES ('desk_ui', ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
        """,
        (json.dumps(clean),),
    )
    return clean


def repeats_blocked(conn=None):
    ui = desk_ui_from_conn(conn) if conn is not None else load_desk_ui()
    return bool(ui.get("block_repeat_recipients"))


def count_sent(conn, owner=None, since=None):
    sql = """
        SELECT COUNT(*) AS n FROM recipients r
        JOIN campaigns c ON c.id = r.campaign_id
        WHERE r.status='SENT'
    """
    args = []
    if owner:
        sql += " AND c.owner=?"
        args.append(owner)
    if since is not None:
        sql += " AND r.sent_at>=?"
        args.append(since)
    return conn.execute(sql, args).fetchone()["n"]


def ledger_snapshot(user):
    now = time.time()
    ui = load_desk_ui()
    with db() as conn:
        user_row = conn.execute("SELECT * FROM users WHERE email=?", (user["email"],)).fetchone()
        limits = stored_limits(user_row) if user_row else default_limits()
        used_minute = count_sent(conn, user["email"], now - 60)
        used_hour = count_sent(conn, user["email"], now - 3600)
        used_day = count_sent(conn, user["email"], now - 86400)
        mine_total = count_sent(conn, user["email"])
        sent_total = count_sent(conn)
        sent_today = count_sent(conn, since=now - 86400)
        unique_people = conn.execute("SELECT COUNT(*) AS n FROM sent_people").fetchone()["n"]
    company_cap = int(ui.get("global_daily_cap") or 0)
    return {
        "sent_total": sent_total,
        "sent_today": sent_today,
        "unique_people": unique_people,
        "mine_total": mine_total,
        "used_minute": used_minute,
        "used_hour": used_hour,
        "used_day": used_day,
        "remaining_minute": max(0, limits["per_minute"] - used_minute),
        "remaining_hour": max(0, limits["per_hour"] - used_hour),
        "remaining_day": max(0, limits["per_day"] - used_day),
        "limits": limits,
        "company_daily_cap": company_cap,
        "company_remaining": None if company_cap <= 0 else max(0, company_cap - sent_today),
        "block_repeat_recipients": bool(ui.get("block_repeat_recipients")),
    }


def remember_sent(conn, email, owner, campaign_id, exclusive=False):
    now = time.time()
    address = normalize_email(email)
    if exclusive:
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO sent_people
                (email, first_sent_at, last_sent_at, send_count, last_owner, last_campaign_id)
            VALUES (?, ?, ?, 1, ?, ?)
            """,
            (address, now, now, owner, campaign_id),
        )
        return cur.rowcount == 1
    conn.execute(
        """
        INSERT INTO sent_people (email, first_sent_at, last_sent_at, send_count, last_owner, last_campaign_id)
        VALUES (?, ?, ?, 1, ?, ?)
        ON CONFLICT(email) DO UPDATE SET
            last_sent_at=excluded.last_sent_at,
            send_count=sent_people.send_count + 1,
            last_owner=excluded.last_owner,
            last_campaign_id=excluded.last_campaign_id
        """,
        (address, now, now, owner, campaign_id),
    )
    return True


def release_sent(conn, email, campaign_id):
    conn.execute(
        "DELETE FROM sent_people WHERE email=? AND last_campaign_id=? AND send_count=1",
        (normalize_email(email), campaign_id),
    )


def add_audit(conn, actor, action, detail=""):
    conn.execute(
        "INSERT INTO audit (actor, action, detail, created_at) VALUES (?, ?, ?, ?)",
        (actor or "", action, str(detail)[:2000], time.time()),
    )


def new_id():
    return secrets.token_hex(8)


def google_client_id():
    raw = load_config().get("google_sign_in") or {}
    return str(raw.get("client_id") or "").strip()


ADMIN_EMAIL = "vekariyaparth127@gmail.com"
OTP_FROM = "parth@gr-conferences.com"
PBKDF2_ROUNDS = 120_000


def write_config(data):
    with open(CONFIG_PATH, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
        handle.write("\n")
    _cfg_cache["mtime"] = os.path.getmtime(CONFIG_PATH)
    _cfg_cache["data"] = data


def save_google_client_id(client_id):
    data = load_config()
    data["google_sign_in"] = {"client_id": client_id}
    write_config(data)


def verify_google_credential(credential):
    client_id = google_client_id()
    if not client_id:
        raise ApiError("Google sign-in is not configured yet.")
    token = str(credential or "").strip()
    if not token or len(token) > 8000:
        raise ApiError("Google did not return a sign-in token.")
    url = "https://oauth2.googleapis.com/tokeninfo?" + urllib.parse.urlencode({"id_token": token})
    try:
        with urllib.request.urlopen(url, timeout=12) as response:
            info = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError:
        raise ApiError("Google could not confirm that account.") from None
    except Exception:
        raise ApiError("The relay could not reach Google to confirm the account.") from None
    if str(info.get("aud") or "") != client_id:
        raise ApiError("That Google sign-in is for a different app.")
    if str(info.get("email_verified")).lower() not in ("true", "1"):
        raise ApiError("Google has not verified this email.")
    email = normalize_email(info.get("email"))
    if not allowed_email(email):
        raise ApiError(f"Use a work Google account ending with {domain_suffix()}.")
    return email


def domain_suffix():
    suffix = str(load_config().get("domain_suffix") or "@gr-conferences.com").strip().lower()
    if not suffix.startswith("@"):
        suffix = "@" + suffix
    return suffix


def normalize_email(value):
    text = str(value or "").replace("\xa0", "").replace("\u200b", "").strip().lower()
    if "<" in text and ">" in text:
        text = text.split("<", 1)[1].split(">", 1)[0].strip().lower()
    return text


def allowed_email(value):
    email = normalize_email(value)
    if not EMAIL_RE.match(email):
        return False
    if email.endswith(domain_suffix()):
        return True
    return email == normalize_email(ADMIN_EMAIL) or email in master_set()


def require_display_name(value):
    text = " ".join(str(value or "").split())
    if len(text) < 2 or len(text) > 80:
        raise ApiError("Enter your name, for example Parth Vekariya.")
    return text


def require_password(value):
    text = str(value or "")
    if len(text) < 6 or len(text) > 200:
        raise ApiError("Password must be at least 6 characters.")
    return text


def hash_password(password):
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        require_password(password).encode("utf-8"),
        salt.encode("utf-8"),
        PBKDF2_ROUNDS,
    ).hex()
    return salt, digest


def verify_password(password, salt, digest):
    if not password or not salt or not digest:
        return False
    check = hashlib.pbkdf2_hmac(
        "sha256",
        str(password).encode("utf-8"),
        str(salt).encode("utf-8"),
        PBKDF2_ROUNDS,
    ).hex()
    return hmac.compare_digest(check, digest)


def password_saved(row):
    if row is None:
        return False
    try:
        return bool(row["password_hash"]) and bool(row["password_salt"])
    except (IndexError, KeyError):
        return False


def user_password_ready(row):
    if row is None:
        return False
    try:
        return bool(row["password_set"]) and password_saved(row)
    except (IndexError, KeyError):
        return False


def public_account(email, row=None):
    display = ""
    ready = False
    if row is not None:
        try:
            display = str(row["display_name"] or "").strip()
        except (IndexError, KeyError):
            display = ""
        ready = user_password_ready(row)
    return {
        "email": email,
        "role": role_for(email),
        "display_name": display,
        "password_set": ready,
    }


def email_tracking_settings():
    raw = load_config().get("email_tracking") or {}
    if not isinstance(raw, dict):
        raw = {}
    return {
        "enabled": bool(raw.get("enabled")),
        "source": str(raw.get("source") or "").strip()[:80],
        "medium": str(raw.get("medium") or "email").strip()[:80] or "email",
        "campaign": str(raw.get("campaign") or "").strip()[:120],
        "term": str(raw.get("term") or "").strip()[:80],
        "content": str(raw.get("content") or "").strip()[:80],
    }


def save_email_tracking(data):
    incoming = data if isinstance(data, dict) else {}
    tracking = {
        "enabled": bool(incoming.get("enabled")),
        "source": str(incoming.get("source") or "").strip()[:80],
        "medium": str(incoming.get("medium") or "email").strip()[:80] or "email",
        "campaign": str(incoming.get("campaign") or "").strip()[:120],
        "term": str(incoming.get("term") or "").strip()[:80],
        "content": str(incoming.get("content") or "").strip()[:80],
    }
    config = load_config()
    config["email_tracking"] = tracking
    write_config(config)
    return tracking


def tag_tracked_url(url, settings):
    text = str(url or "").strip()
    if not settings or not settings.get("enabled"):
        return text
    try:
        parts = urllib.parse.urlsplit(text)
    except ValueError:
        return text
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return text
    query = dict(urllib.parse.parse_qsl(parts.query, keep_blank_values=True))
    for key, value in (
        ("utm_source", settings.get("source")),
        ("utm_medium", settings.get("medium") or "email"),
        ("utm_campaign", settings.get("campaign")),
        ("utm_term", settings.get("term")),
        ("utm_content", settings.get("content")),
    ):
        if value and key not in query:
            query[key] = value
    return urllib.parse.urlunsplit((
        parts.scheme, parts.netloc, parts.path,
        urllib.parse.urlencode(query), parts.fragment,
    ))


def apply_email_tracking(html_body):
    settings = email_tracking_settings()
    if not settings.get("enabled"):
        return html_body

    def replacer(match):
        quote = match.group(1)
        url = tag_tracked_url(match.group(2), settings)
        return f"href={quote}{url}{quote}"

    return re.sub(r'(?i)href=(["\'])(https?://[^"\']+)\1', replacer, str(html_body or ""))


def issue_otp(email, purpose):
    email = normalize_email(email)
    purpose = str(purpose or "login").strip().lower() or "login"
    if purpose not in ("login", "register", "first", "reset"):
        purpose = "login"
    if not allowed_email(email):
        raise ApiError(f"Use a work address ending with {domain_suffix()}.")
    if is_admin_email(email) and purpose == "login":
        raise ApiError("The admin signs in with name and password after the first OTP.")
    if not otp_is_live():
        refresh_otp_sender()
    if not otp_is_live():
        raise ApiError("Sign-in codes are not sending yet. Ask the admin to check the sign-in mailbox.", 503)
    ttl = otp_ttl()
    now = time.time()
    code = f"{secrets.randbelow(900000) + 100000}"
    salt = secrets.token_hex(8)
    digest = hashlib.sha256(f"{salt}:{code}".encode("utf-8")).hexdigest()
    with db() as conn:
        row = ensure_user(conn, email)
        if purpose in ("register", "first", "reset") and not user_password_ready(row):
            conn.execute("UPDATE users SET enabled=1 WHERE email=?", (email,))
            row = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        elif not account_enabled(row):
            raise ApiError("This account is disabled.", 403)
        existing = conn.execute("SELECT sent_at FROM otps WHERE email=?", (email,)).fetchone()
        if existing and existing["sent_at"] and now - existing["sent_at"] < 30:
            raise ApiError("Wait a few seconds before requesting another code.", 429)
        conn.execute(
            """
            INSERT INTO otps (email, code_hash, salt, expires_at, attempts, sent_at, purpose)
            VALUES (?, ?, ?, ?, 0, ?, ?)
            ON CONFLICT(email) DO UPDATE SET
                code_hash=excluded.code_hash, salt=excluded.salt, expires_at=excluded.expires_at,
                attempts=0, sent_at=excluded.sent_at, purpose=excluded.purpose
            """,
            (email, digest, salt, now + ttl, now, purpose),
        )
        add_audit(conn, email, "otp_requested", purpose)
    try:
        send_otp_email(email, code, purpose)
    except Exception:
        with db() as conn:
            conn.execute("DELETE FROM otps WHERE email=?", (email,))
        raise
    return ttl


def master_set():
    return {normalize_email(item) for item in (load_config().get("master_emails") or []) if normalize_email(item)}


def is_admin_email(email):
    return normalize_email(email) == ADMIN_EMAIL and ADMIN_EMAIL in master_set()


def role_for(email):
    return "ROLE_MASTER" if normalize_email(email) in master_set() else "ROLE_USER"


def session_seconds():
    try:
        hours = float(load_config().get("session_hours") or 12)
    except (TypeError, ValueError):
        hours = 12
    return int(max(1, min(hours, 24 * 14)) * 3600)


def otp_ttl():
    try:
        ttl = int(load_config().get("otp_ttl_seconds") or 300)
    except (TypeError, ValueError):
        ttl = 300
    return max(60, min(ttl, 900))


def token_secret():
    return str(load_config().get("token_secret") or "")


def b64e(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def b64d(text):
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def issue_token(email):
    payload = {"sub": normalize_email(email), "exp": int(time.time()) + session_seconds()}
    body = b64e(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signature = hmac.new(token_secret().encode("utf-8"), body.encode("ascii"), hashlib.sha256).hexdigest()
    return body + "." + signature


def read_token(token):
    if not token or "." not in token:
        return None
    body, signature = token.rsplit(".", 1)
    expected = hmac.new(token_secret().encode("utf-8"), body.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        return None
    try:
        payload = json.loads(b64d(body))
    except (ValueError, json.JSONDecodeError):
        return None
    if float(payload.get("exp") or 0) < time.time():
        return None
    return payload


def account_enabled(row):
    if row is None:
        return True
    try:
        value = row["enabled"]
    except (KeyError, IndexError, TypeError):
        return True
    if value is None:
        return True
    return str(value).strip().lower() not in ("0", "false", "")


def default_limits():
    raw = load_config().get("default_limits") or {}
    return {
        "per_minute": int(raw.get("per_minute") or 10),
        "per_hour": int(raw.get("per_hour") or 100),
        "per_day": int(raw.get("per_day") or GMAIL_DAILY_CAP),
        "max_batch": int(raw.get("max_batch") or 5000),
        "window_start": raw.get("window_start") or "09:00",
        "window_end": raw.get("window_end") or "18:00",
        "window_tz": raw.get("window_tz") or "UTC",
        "enforce_window": bool(raw.get("enforce_window")),
    }


def valid_hhmm(value, fallback):
    text = str(value or "").strip()
    match = re.fullmatch(r"(\d{1,2}):(\d{2})", text)
    if not match:
        return fallback
    hour, minute = int(match.group(1)), int(match.group(2))
    if hour > 23 or minute > 59:
        return fallback
    return f"{hour:02d}:{minute:02d}"


def normalize_limits(raw):
    merged = default_limits()
    if isinstance(raw, dict):
        merged.update(raw)
    bounds = (("per_minute", 1, 5000), ("per_hour", 1, 100000), ("per_day", 1, 500000), ("max_batch", 1, 200000))
    for key, low, high in bounds:
        try:
            merged[key] = max(low, min(high, int(merged[key])))
        except (TypeError, ValueError):
            merged[key] = default_limits()[key]
    merged["enforce_window"] = bool(merged.get("enforce_window"))
    merged["window_start"] = valid_hhmm(merged.get("window_start"), "09:00")
    merged["window_end"] = valid_hhmm(merged.get("window_end"), "18:00")
    zone = str(merged.get("window_tz") or "UTC")
    try:
        ZoneInfo(zone)
    except Exception:
        zone = "UTC"
    merged["window_tz"] = zone
    return merged


def stored_limits(row):
    custom = {}
    if row and row["limits_json"]:
        try:
            custom = json.loads(row["limits_json"])
        except json.JSONDecodeError:
            custom = {}
    return normalize_limits(custom if isinstance(custom, dict) else {})


def effective_limits(conn, user_row, sender_id):
    merged = stored_limits(user_row)
    sender = sender_by_id(sender_id) if sender_id else None
    cap = mailbox_daily_cap(sender)
    custom = {}
    if user_row and user_row["limits_json"]:
        try:
            parsed = json.loads(user_row["limits_json"])
            if isinstance(parsed, dict):
                custom = parsed
        except json.JSONDecodeError:
            custom = {}
    if custom.get("per_day") not in (None, ""):
        try:
            merged["per_day"] = min(int(custom["per_day"]), cap)
        except (TypeError, ValueError):
            merged["per_day"] = cap
    else:
        merged["per_day"] = cap
    if not sender_id:
        return normalize_limits(merged)
    grant = conn.execute(
        "SELECT limits_json, status FROM grants WHERE email=? AND sender_id=?",
        (user_row["email"], sender_id),
    ).fetchone()
    extra = {}
    if grant and grant["limits_json"]:
        try:
            parsed = json.loads(grant["limits_json"])
            if isinstance(parsed, dict):
                extra = parsed
        except json.JSONDecodeError:
            extra = {}
    for key in ("per_minute", "per_hour", "per_day", "max_batch"):
        if extra.get(key) not in (None, ""):
            try:
                merged[key] = min(int(merged[key]), int(extra[key]))
            except (TypeError, ValueError):
                pass
    if extra.get("enforce_window"):
        merged["enforce_window"] = True
        for key in ("window_start", "window_end", "window_tz"):
            if extra.get(key):
                merged[key] = extra[key]
    merged["per_day"] = min(int(merged["per_day"]), cap)
    return normalize_limits(merged)


def hhmm_to_minutes(value):
    hour, minute = value.split(":")
    return int(hour) * 60 + int(minute)


def within_window(limits):
    if not limits.get("enforce_window"):
        return True, ""
    now = datetime.datetime.now(ZoneInfo(limits["window_tz"]))
    start = hhmm_to_minutes(limits["window_start"])
    end = hhmm_to_minutes(limits["window_end"])
    current = now.hour * 60 + now.minute
    if start <= end:
        ok = start <= current <= end
    else:
        ok = current >= start or current <= end
    if ok:
        return True, ""
    return False, (
        f"Sending is allowed only between {limits['window_start']} and "
        f"{limits['window_end']} {limits['window_tz']}."
    )


def sanitize_password(raw):
    if not raw:
        return ""
    clean = str(raw).replace("\xa0", "").replace("\u200b", "").replace("\r", "").replace("\n", "").strip().strip("'\"")
    compact = re.sub(r"[\s\-]+", "", clean)
    if len(compact) == 16:
        return compact
    return clean


def sanitize_smtp_host_and_port(raw_host, raw_port=None):
    if not raw_host:
        return "", raw_port
    host = str(raw_host).strip().strip("'\"`")
    host = re.sub(r"^(?:[a-z0-9+\-.]+://)", "", host, flags=re.I)
    host = host.split("/")[0].split("?")[0].strip()
    port = raw_port
    if ":" in host:
        left, right = host.split(":", 1)
        host = left.strip()
        if right.strip().isdigit():
            port = int(right.strip())
    lowered = host.lower()
    aliases = {
        "gmail.com": "smtp.gmail.com",
        "googlemail.com": "smtp.gmail.com",
        "outlook.com": "smtp.office365.com",
        "hotmail.com": "smtp.office365.com",
        "live.com": "smtp.office365.com",
        "office365.com": "smtp.office365.com",
        "yahoo.com": "smtp.mail.yahoo.com",
        "zoho.com": "smtp.zoho.com",
        "icloud.com": "smtp.mail.me.com",
    }
    host = aliases.get(lowered, host)
    return host, port


def dispatch_mode():
    return str(load_config().get("dispatch_mode") or "auto").strip().lower()


def prepare_sender(raw):
    if not raw:
        return None
    secure = str(raw.get("secure") or "ssl").lower()
    if secure not in ("ssl", "tls", "none"):
        secure = "ssl"
    host, port = sanitize_smtp_host_and_port(raw.get("host"), raw.get("port"))
    if not port:
        port = 465 if secure == "ssl" else 587
    user = str(raw.get("user") or raw.get("email") or "").strip()
    return {
        "id": raw.get("id") or "",
        "email": normalize_email(raw.get("email") or user),
        "user": user,
        "password": sanitize_password(raw.get("password") or raw.get("pass") or ""),
        "display_name": str(raw.get("display_name") or raw.get("from_name") or "").strip(),
        "host": host,
        "port": int(port),
        "secure": secure,
        "daily_cap": int(raw.get("daily_cap") or 0) if str(raw.get("daily_cap") or "").strip().isdigit() else 0,
    }


def make_sender_id(raw, email):
    text = str(raw or "").strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{2,40}", text):
        return text
    local = (email or "mailbox").split("@", 1)[0]
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "-", local).strip("-")[:32]
    return cleaned or new_id()


def configured_senders():
    senders = []
    seen = set()
    for raw in load_config().get("senders") or []:
        sender = prepare_sender(raw)
        if not sender or not sender["user"]:
            continue
        address = normalize_email(sender.get("email") or sender.get("user") or "")
        if not EMAIL_RE.match(address):
            continue
        sender["id"] = make_sender_id(sender.get("id"), address)
        if sender["id"] in seen:
            continue
        seen.add(sender["id"])
        senders.append(sender)
    return senders


def sender_by_id(sender_id):
    for sender in configured_senders():
        if sender["id"] == sender_id:
            return sender
    return None


def sender_by_address(value):
    wanted = normalize_email(value)
    if not wanted:
        return None
    for sender in configured_senders():
        if wanted in (normalize_email(sender.get("email")), normalize_email(sender.get("user"))):
            return sender
    return None


def resolve_requested_sender(sender_id):
    found = sender_by_id(sender_id)
    if found:
        return found
    text = str(sender_id or "")
    if text.startswith("ask:"):
        return sender_by_address(text[4:])
    return sender_by_address(text)


def requested_mailbox_label(sender_id):
    sender = resolve_requested_sender(sender_id)
    if sender:
        return sender.get("email") or sender.get("user") or sender_id
    text = str(sender_id or "")
    if text.startswith("ask:"):
        return text[4:]
    return text


def live_delivery(sender):
    mode = dispatch_mode()
    if mode == "simulate":
        return False
    if mode == "live":
        return True
    return bool(sender and sender.get("password"))


def remember_otp_sender(config, sender):
    if not sender:
        return
    email = normalize_email(sender.get("email") or sender.get("user"))
    if email != OTP_FROM:
        return
    password = sanitize_password(sender.get("password") or "")
    if not password:
        return
    config["otp_smtp"] = {
        "host": sender.get("host") or "smtp.gmail.com",
        "port": int(sender.get("port") or 587),
        "secure": sender.get("secure") or "tls",
        "user": OTP_FROM,
        "password": password,
        "from_name": sender.get("display_name") or sender.get("from_name") or "Parth Mailing",
    }


def upsert_otp_sender(config, sender):
    email = OTP_FROM
    senders = [dict(item) for item in (config.get("senders") or []) if isinstance(item, dict)]
    fields = {
        "email": email,
        "user": email,
        "host": sender.get("host") or "smtp.gmail.com",
        "port": int(sender.get("port") or 587),
        "secure": sender.get("secure") or "tls",
        "password": sanitize_password(sender.get("password") or ""),
        "display_name": sender.get("display_name") or sender.get("from_name") or "Parth Mailing",
    }
    updated = False
    for raw in senders:
        if normalize_email(raw.get("email") or raw.get("user")) != email:
            continue
        raw.update(fields)
        raw.setdefault("id", "parth-otp")
        updated = True
    if not updated:
        fields["id"] = "parth-otp"
        senders.append(fields)
    config["senders"] = senders
    remember_otp_sender(config, fields)


def otp_sender():
    found = sender_by_address(OTP_FROM)
    if found and found.get("password"):
        found = dict(found)
        found["user"] = OTP_FROM
        found["email"] = OTP_FROM
        return found
    prepared = prepare_sender(load_config().get("otp_smtp") or {})
    if prepared and normalize_email(prepared.get("user") or prepared.get("email")) == OTP_FROM and prepared.get("password"):
        prepared["user"] = OTP_FROM
        prepared["email"] = OTP_FROM
        return prepared
    return None


def refresh_otp_sender():
    url = str(load_config().get("mailbox_sheet_url") or "").strip()
    if not url:
        return otp_sender()
    try:
        apply_mailbox_sheet(url, OTP_FROM)
    except ApiError as exc:
        log(f"Sign-in mailbox refresh failed: {exc.message}")
    return otp_sender()


def otp_is_live():
    return live_delivery(otp_sender())


def clean_header(value):
    return re.sub(r"[\r\n]+", " ", str(value or "")).strip()


def sanitize_display_name(raw, mailbox):
    name = clean_header(str(raw or "").replace("\xa0", " ").replace("\u200b", "").replace("\ufeff", ""))
    if not name or name.lower() == str(mailbox or "").lower():
        return ""
    if "@" in name and " " not in name:
        return ""
    return name[:120]


def build_aligned_from(display_name, mailbox):
    name = sanitize_display_name(display_name, mailbox)
    if name and mailbox:
        safe = name.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{safe}" <{mailbox}>'
    return mailbox


def default_pace():
    raw = load_config().get("pace") or {}
    return {
        "delay_min_seconds": float(raw.get("delay_min_seconds") if raw.get("delay_min_seconds") is not None else 4),
        "delay_max_seconds": float(raw.get("delay_max_seconds") if raw.get("delay_max_seconds") is not None else 12),
        "batch_size": int(raw.get("batch_size") or 20),
        "batch_pause_minutes": float(raw.get("batch_pause_minutes") if raw.get("batch_pause_minutes") is not None else 2),
    }


def normalize_pace(raw):
    pace = default_pace()
    if isinstance(raw, dict):
        pace.update(raw)
    try:
        low = float(pace.get("delay_min_seconds"))
    except (TypeError, ValueError):
        low = 4
    try:
        high = float(pace.get("delay_max_seconds"))
    except (TypeError, ValueError):
        high = max(low, 12)
    low = max(0, min(low, 300))
    high = max(low, min(high, 300))
    try:
        batch = int(pace.get("batch_size") or 20)
    except (TypeError, ValueError):
        batch = 20
    try:
        pause = float(pace.get("batch_pause_minutes") or 0)
    except (TypeError, ValueError):
        pause = 0
    return {
        "delay_min_seconds": low,
        "delay_max_seconds": high,
        "batch_size": max(1, min(batch, 5000)),
        "batch_pause_minutes": max(0, min(pause, 180)),
    }


def public_sender(sender, status):
    return {
        "id": sender["id"],
        "email": sender["email"] or normalize_email(sender["user"]),
        "display_name": sender["display_name"],
        "status": status,
        "live": live_delivery(sender),
    }


def master_sender_view(sender):
    return {
        "id": sender["id"],
        "email": sender["email"] or normalize_email(sender["user"]),
        "display_name": sender["display_name"],
        "host": sender["host"],
        "port": sender["port"],
        "secure": sender["secure"],
        "user": sender["user"],
        "has_password": bool(sender.get("password")),
        "live": live_delivery(sender),
        "daily_cap": mailbox_daily_cap(sender),
        "provider_cap": provider_cap(sender),
    }


def upsert_admin_sender(config, password):
    """Use the admin mailbox as a real campaign sender once its app password is saved."""
    senders = [dict(item) for item in (config.get("senders") or []) if isinstance(item, dict)]
    updated = False
    for raw in senders:
        email = normalize_email(raw.get("email") or raw.get("user") or "")
        if email != ADMIN_EMAIL:
            continue
        raw.update({
            "email": ADMIN_EMAIL,
            "user": ADMIN_EMAIL,
            "host": "smtp.gmail.com",
            "port": 465,
            "secure": "ssl",
            "password": password,
        })
        raw.setdefault("id", "admin")
        raw.setdefault("display_name", "Parth Mailing")
        updated = True
    if not updated:
        senders.insert(0, {
            "id": "admin",
            "email": ADMIN_EMAIL,
            "display_name": "Parth Mailing",
            "host": "smtp.gmail.com",
            "port": 465,
            "secure": "ssl",
            "user": ADMIN_EMAIL,
            "password": password,
        })
    config["senders"] = senders


def sync_admin_sender():
    config = load_config()
    smtp = config.get("master_smtp") or {}
    password = sanitize_password(smtp.get("password") or "")
    if len(password) != 16:
        return
    for raw in config.get("senders") or []:
        if not isinstance(raw, dict):
            continue
        email = normalize_email(raw.get("email") or raw.get("user") or "")
        saved = sanitize_password(raw.get("password") or "")
        if email == ADMIN_EMAIL and len(saved) == 16:
            return
    before = json.dumps(config.get("senders") or [], sort_keys=True)
    upsert_admin_sender(config, password)
    if json.dumps(config.get("senders") or [], sort_keys=True) != before:
        write_config(config)
        log(f"Campaign mailbox {ADMIN_EMAIL} is ready to send.")


def campaign_payloads(conn, rows):
    ids = [row["id"] for row in rows]
    errors = {}
    if ids:
        marks = ",".join("?" for _ in ids)
        for item in conn.execute(
            f"""
            SELECT campaign_id, error FROM recipients
            WHERE campaign_id IN ({marks}) AND status IN ('FAILED','BOUNCED') AND error!=''
            ORDER BY id DESC
            """,
            ids,
        ):
            errors.setdefault(item["campaign_id"], item["error"])
    payloads = []
    for row in rows:
        payload = public_campaign(row)
        payload["last_error"] = errors.get(row["id"], "")
        payloads.append(payload)
    return payloads


def public_campaign(row):
    sender = sender_by_id(row["sender_id"])
    try:
        pace = json.loads(row["pace_json"] or "{}")
    except json.JSONDecodeError:
        pace = {}
    return {
        "id": row["id"],
        "owner": row["owner"],
        "sender_id": row["sender_id"],
        "sender_email": (sender or {}).get("email") or "",
        "subject": row["subject"],
        "status": row["status"],
        "schedule_at": row["schedule_at"],
        "timezone": row["timezone"] or "UTC",
        "hold_reason": row["hold_reason"] or "",
        "created_at": row["created_at"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
        "sent_count": row["sent_count"] or 0,
        "failed_count": row["failed_count"] or 0,
        "bounced_count": row["bounced_count"] or 0,
        "skipped_count": row["skipped_count"] or 0 if "skipped_count" in row.keys() else 0,
        "drafted_count": row["drafted_count"] or 0 if "drafted_count" in row.keys() else 0,
        "dispatch_action": (row["dispatch_action"] if "dispatch_action" in row.keys() else "send") or "send",
        "total_count": row["total_count"] or 0,
        "drive_upload_url": row["drive_upload_url"] or "",
        "drive_report_url": row["drive_report_url"] or "",
        "source_name": row["source_name"] or "",
        "pace": pace,
    }


def recompute_counts(conn, campaign_id):
    counts = {"SENT": 0, "FAILED": 0, "BOUNCED": 0, "QUEUED": 0, "SKIPPED": 0, "DRAFTED": 0}
    for row in conn.execute(
        "SELECT status, COUNT(*) AS n FROM recipients WHERE campaign_id=? GROUP BY status",
        (campaign_id,),
    ):
        counts[row["status"]] = row["n"]
    total = conn.execute("SELECT COUNT(*) AS n FROM recipients WHERE campaign_id=?", (campaign_id,)).fetchone()["n"]
    conn.execute(
        """
        UPDATE campaigns
        SET sent_count=?, failed_count=?, bounced_count=?, skipped_count=?, drafted_count=?, total_count=?
        WHERE id=?
        """,
        (
            counts["SENT"], counts["FAILED"], counts["BOUNCED"], counts["SKIPPED"],
            counts["DRAFTED"], total, campaign_id,
        ),
    )
    return counts, total


def drive_settings():
    raw = load_config().get("google_drive") or {}
    path = str(raw.get("service_account_file") or "")
    if path and not os.path.isabs(path):
        path = os.path.join(ROOT, path)
    return {
        "enabled": bool(raw.get("enabled")),
        "path": path,
        "parent": str(raw.get("parent_folder_id") or ""),
        "root_name": str(raw.get("folder_name") or "ParthMailing_Storage"),
    }


def drive_account_email(path):
    if not path or not os.path.isfile(path):
        return ""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError, TypeError):
        return ""
    return str(data.get("client_email") or "") if isinstance(data, dict) else ""


def drive_status():
    settings = drive_settings()
    saved = bool(settings["path"] and os.path.isfile(settings["path"]))
    email = drive_account_email(settings["path"])
    if not settings["enabled"]:
        ready, reason = False, "Google Drive backup is turned off."
    elif not saved:
        ready, reason = False, "Paste the service account JSON key."
    elif not drive_sync.cryptography_ready():
        ready, reason = False, "Install the cryptography package to sign Drive requests."
    else:
        ready, reason = True, "Service account file is ready."
    return {
        "ready": ready,
        "reason": reason,
        "enabled": settings["enabled"],
        "parent_folder_id": settings["parent"],
        "folder_name": settings["root_name"],
        "service_account_saved": saved,
        "client_email": email,
    }


def load_service_account():
    settings = drive_settings()
    if not settings["enabled"] or not os.path.isfile(settings["path"]):
        return None, settings
    with open(settings["path"], "r", encoding="utf-8") as handle:
        return json.load(handle), settings


def queue_drive_upload(local_path, segments, campaign_id, column):
    def runner():
        try:
            account, settings = load_service_account()
            if not account:
                return
            link = drive_sync.upload_file(
                local_path,
                account,
                segments,
                root_name=settings["root_name"],
                parent_folder_id=settings["parent"],
            )
            with db() as conn:
                conn.execute(f"UPDATE campaigns SET {column}=? WHERE id=?", (link, campaign_id))
                add_audit(conn, "relay", "drive_upload", f"{column} {campaign_id}")
            log(f"Drive backup stored for {campaign_id}")
        except Exception as exc:
            log(f"Drive backup skipped for {campaign_id}: {exc}")

    if column not in ("drive_upload_url", "drive_report_url"):
        return
    threading.Thread(target=runner, daemon=True).start()


def ipv4_socket(host, port, timeout):
    last = None
    for family in (socket.AF_INET, socket.AF_INET6):
        try:
            infos = socket.getaddrinfo(host, port, family, socket.SOCK_STREAM)
        except socket.gaierror as exc:
            last = exc
            continue
        for family_id, socktype, proto, _canon, address in infos:
            sock = socket.socket(family_id, socktype, proto)
            try:
                sock.settimeout(timeout)
                sock.connect(address)
                return sock
            except OSError as exc:
                last = exc
                sock.close()
    if last:
        raise last
    raise OSError(f"Could not reach {host}:{port}")


class IPv4SMTP(smtplib.SMTP):
    def _get_socket(self, host, port, timeout):
        return ipv4_socket(host, port, timeout)


class IPv4SMTP_SSL(smtplib.SMTP_SSL):
    def _get_socket(self, host, port, timeout):
        raw = ipv4_socket(host, port, timeout)
        hostname = self._host or host
        return self.context.wrap_socket(raw, server_hostname=hostname)


def smtp_attempts(sender):
    host = str(sender.get("host") or "").strip()
    secure = sender.get("secure") or "ssl"
    port = int(sender.get("port") or (465 if secure == "ssl" else 587))
    plan = []

    def add(mode, target, target_port):
        item = (mode, target, int(target_port))
        if target and item not in plan:
            plan.append(item)

    if secure == "none":
        add("none", host, port or 25)
        return plan
    add("ssl" if secure == "ssl" else "tls", host, port)
    google = host.endswith("gmail.com") or host.endswith("googlemail.com")
    if google:
        add("ssl", host, 465)
        add("tls", host, 587)
    return plan


def friendly_smtp_error(exc):
    text = str(exc)
    lowered = text.lower()
    if isinstance(exc, smtplib.SMTPAuthenticationError) or any(
        token in text for token in ("535", "534", "Username and Password not accepted", "Application-specific password")
    ):
        return "Gmail refused this app password. Create a new 16-character app password in the Google account and save it again."
    if isinstance(exc, (smtplib.SMTPServerDisconnected, ConnectionResetError, ConnectionAbortedError, TimeoutError, socket.timeout)) or "unexpectedly closed" in lowered or "timed out" in lowered:
        return "Gmail closed the connection. Create a new 16-character app password and save it again. If it still fails, Google is blocking SMTP for this mailbox."
    return text[:400]


def exception_text(exc):
    detail = exc.args[0] if getattr(exc, "args", None) else exc
    if isinstance(detail, (bytes, bytearray)):
        detail = detail.decode("utf-8", "replace")
    return str(detail or exc)


def friendly_imap_error(exc):
    text = exception_text(exc)
    lowered = text.lower()
    if any(token in text for token in ("AUTHENTICATIONFAILED", "Invalid credentials", "535", "534", "Application-specific password")):
        return "Gmail refused this app password, so the draft was not saved. Create a new 16-character app password in the Google account and save it on this mailbox."
    if "imap" in lowered and "disabled" in lowered:
        return "IMAP is turned off for this mailbox. In Gmail, open Settings, then Forwarding and POP/IMAP, enable IMAP, and try the draft again."
    if "could not parse" in lowered or "trycreate" in lowered:
        return "Gmail could not open the Drafts folder. Enable IMAP in Gmail settings and try again."
    return text[:400]


def connect_smtp(sender):
    context = ssl.create_default_context()
    timeout = 30
    last = None
    for mode, host, port in smtp_attempts(sender):
        smtp = None
        try:
            if mode == "ssl":
                smtp = IPv4SMTP_SSL(host, port, timeout=timeout, context=context)
            else:
                smtp = IPv4SMTP(host, port, timeout=timeout)
                smtp.ehlo()
                if mode == "tls":
                    smtp.starttls(context=context)
                    smtp.ehlo()
            smtp.login(sender["user"], sender["password"])
            return smtp
        except Exception as exc:
            last = exc
            safe_quit(smtp)
    if last is None:
        raise OSError("SMTP host is missing.")
    raise last


def safe_quit(smtp):
    if not smtp:
        return
    try:
        smtp.quit()
    except Exception:
        try:
            smtp.close()
        except Exception:
            pass


def send_with_pool(sender, message, recipients):
    key = (sender["host"], int(sender["port"]), sender["user"].lower())
    last_error = None
    for attempt in (1, 2):
        smtp = None
        discard = False
        try:
            with _pool_lock:
                smtp = None if attempt == 2 else _pool.get(key)
                if smtp is None:
                    smtp = connect_smtp(sender)
                    _pool[key] = smtp
            refused = smtp.sendmail(sender["user"], recipients, message.as_bytes())
            if refused:
                raise smtplib.SMTPRecipientsRefused(refused)
            return "250", "OK"
        except Exception as exc:
            last_error = exc
            discard = True
        finally:
            if discard:
                with _pool_lock:
                    current = _pool.pop(key, None)
                    safe_quit(current if current is not None else smtp)
    raise last_error


def classify_smtp_error(exc):
    if isinstance(exc, smtplib.SMTPRecipientsRefused):
        code = ""
        detail = []
        for address, payload in exc.recipients.items():
            if isinstance(payload, tuple) and payload:
                code = str(payload[0])
                detail.append(f"{address}: {payload[-1]}")
            else:
                detail.append(f"{address}: {payload}")
        text = "; ".join(str(item) for item in detail) or str(exc)
        if code.startswith("5") or any(token in text for token in ("550", "551", "552", "553", "554")):
            return "BOUNCED", code or "550", text[:800]
        return "FAILED", code or "450", text[:800]
    if isinstance(exc, smtplib.SMTPResponseException):
        code = str(exc.smtp_code)
        text = str(exc.smtp_error or exc)
        if code in ("550", "551", "552", "553", "554"):
            return "BOUNCED", code, text[:800]
        return "FAILED", code, text[:800]
    text = friendly_smtp_error(exc)
    if any(token in text for token in ("550", "551", "553", "554")):
        return "BOUNCED", "550", text[:800]
    return "FAILED", "", text[:800]


def account_error_is_fatal(message):
    lowered = message.lower()
    needles = (
        "authentication",
        "app password",
        "closed the connection",
        "unexpectedly closed",
        "timed out",
        "getaddrinfo",
        "name or service not known",
        "connection refused",
        "password missing",
    )
    return any(needle in lowered for needle in needles)


def html_to_text(value):
    text = re.sub(r"(?i)<br\s*/?>", "\n", str(value or ""))
    text = re.sub(r"(?i)</p>", "\n\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    return html.unescape(text).strip()


def sanitize_html(value):
    text = str(value or "")
    text = re.sub(r"(?is)<(script|iframe|object|embed|link|meta)[^>]*>.*?</\1>", "", text)
    text = re.sub(r"(?is)<(script|iframe|object|embed)[^>]*/?>", "", text)
    text = re.sub(r"(?i)\son\w+\s*=\s*(\".*?\"|'.*?'|[^\s>]+)", "", text)

    def href_replacer(match):
        quote, url = match.group(1), match.group(2).strip()
        if url.lower().startswith(("http://", "https://", "mailto:")):
            return match.group(0)
        return f"href={quote}#{quote}"

    return re.sub(r"(?i)href=([\"'])(.*?)\1", href_replacer, text)


def apply_variables(template, recipient, escape_values):
    try:
        fields = json.loads(recipient["fields_json"] or "{}")
    except json.JSONDecodeError:
        fields = {}
    values = {
        "FirstName": recipient["first_name"] or "",
        "LastName": recipient["last_name"] or "",
        "Company": recipient["company"] or "",
        "Custom1": recipient["custom1"] or "",
        "Email": recipient["email"] or "",
    }
    if isinstance(fields, dict):
        for key, value in fields.items():
            values[str(key)] = "" if value is None else str(value)
    if not any(name.lower() == "name" for name in values):
        values["Name"] = values.get("FirstName") or ""
    if not any(name.lower() == "sender" for name in values):
        values["Sender"] = values.get("Sender Name") or values.get("sender_name") or ""

    def replacer(match):
        key = match.group(1).strip()
        found = None
        for name, value in values.items():
            if name.lower() == key.lower() or name.lower().replace(" ", "") == key.lower().replace(" ", ""):
                found = value
                break
        if found is None:
            return match.group(0)
        return html.escape(found) if escape_values else found

    text = re.sub(r"\{\{\s*([^{}]+?)\s*\}\}", replacer, str(template or ""))
    return re.sub(r"\{([A-Za-z][A-Za-z0-9 _]*)\}", replacer, text)


def field_value(recipient, *names):
    try:
        fields = json.loads(recipient["fields_json"] or "{}")
    except json.JSONDecodeError:
        return ""
    if not isinstance(fields, dict):
        return ""
    lowered = {str(key).lower(): value for key, value in fields.items()}
    for name in names:
        if name.lower() in lowered and str(lowered[name.lower()] or "").strip():
            return str(lowered[name.lower()]).strip()
    return ""


def extract_inline_images(value):
    images = []
    pattern = re.compile(r'src=(["\'])(data:image/([a-zA-Z0-9.+-]+);base64,([^"\']+))\1', re.I)

    def replacer(match):
        if len(images) >= 8:
            return 'src=""'
        subtype = match.group(3).split("+")[0].lower()
        if subtype == "jpg":
            subtype = "jpeg"
        try:
            raw = base64.b64decode(match.group(4), validate=False)
        except Exception:
            return 'src=""'
        if len(raw) > 1_500_000:
            return 'src=""'
        cid = f"img{len(images)}@parth-mailing.local"
        images.append((cid, raw, subtype))
        return f'src="cid:{cid}"'

    return pattern.sub(replacer, value), images


def split_address_list(raw):
    good = []
    bad = []
    for part in re.split(r"[;,\n]", str(raw or "")):
        part = normalize_email(part)
        if not part:
            continue
        if EMAIL_RE.match(part):
            good.append(part)
        else:
            bad.append(part)
    return good, bad


def build_message(sender, recipient_email, subject, html_body, cc_list, attachments):
    html_body, images = extract_inline_images(html_body)
    plain = html_to_text(html_body) or " "
    alternative = MIMEMultipart("alternative")
    alternative.attach(MIMEText(plain, "plain", "utf-8"))
    alternative.attach(MIMEText(html_body, "html", "utf-8"))
    if images:
        related = MIMEMultipart("related")
        related.attach(alternative)
        for cid, raw, subtype in images:
            try:
                image = MIMEImage(raw, _subtype=subtype)
            except TypeError:
                image = MIMEImage(raw)
            image.add_header("Content-ID", f"<{cid}>")
            image.add_header("Content-Disposition", "inline", filename=f"{cid}.{subtype}")
            related.attach(image)
        body = related
    else:
        body = alternative
    if attachments:
        mixed = MIMEMultipart("mixed")
        mixed.attach(body)
        for item in attachments:
            mime = item["mime"] if "/" in (item["mime"] or "") else "application/octet-stream"
            maintype, subtype = mime.split("/", 1)
            part = MIMEBase(maintype, subtype)
            with open(item["path"], "rb") as handle:
                part.set_payload(handle.read())
            encoders.encode_base64(part)
            part.add_header("Content-Disposition", "attachment", filename=item["filename"])
            mixed.attach(part)
        message = mixed
    else:
        message = body
    message["To"] = recipient_email
    if cc_list:
        message["Cc"] = ", ".join(cc_list)
    clean_subject = clean_header(subject)[:998]
    if any(ord(char) > 127 for char in clean_subject):
        message["Subject"] = Header(clean_subject, "utf-8")
    else:
        message["Subject"] = clean_subject
    message["Date"] = email.utils.formatdate(localtime=True)
    domain = sender["user"].split("@", 1)[1] if "@" in sender["user"] else "localhost"
    message["Message-ID"] = email.utils.make_msgid(domain=domain)
    message["List-Unsubscribe"] = f"<mailto:{sender['user']}?subject=unsubscribe>"
    return message


def deliver(campaign, recipient, sender, limits_ignored=False):
    del limits_ignored
    fields_subject = field_value(recipient, "Subject", "subject")
    subject = apply_variables(fields_subject or campaign["subject"], recipient, False)
    template_html = field_value(recipient, "Template", "Body", "HTML", "Message")
    source_html = campaign["html"]
    if template_html and ("<" in template_html or not str(source_html or "").strip()):
        source_html = template_html
    html_body = sanitize_html(apply_variables(source_html, recipient, True))
    html_body = apply_email_tracking(html_body)
    cc_raw = field_value(recipient, "Cc", "CC", "cc") or campaign["cc"] or ""
    bcc_raw = field_value(recipient, "Bcc", "BCC", "bcc") or campaign["bcc"] or ""
    cc_list, cc_bad = split_address_list(cc_raw)
    bcc_list, bcc_bad = split_address_list(bcc_raw)
    if cc_bad or bcc_bad:
        bad = ", ".join(cc_bad + bcc_bad)
        return {"status": "FAILED", "code": "", "error": f"Invalid copy address: {bad}"}
    display = field_value(recipient, "Sender Name", "From Name", "Display Name") or sender["display_name"]
    action = campaign_action(campaign)
    done_status = "DRAFTED" if action == "draft" else "SENT"
    if not live_delivery(sender):
        return {"status": done_status, "code": "250", "error": "", "simulated": True}
    if not sender["password"]:
        return {"status": "FAILED", "code": "", "error": "Mailbox password is missing for this sender."}
    if not sender["host"]:
        return {"status": "FAILED", "code": "", "error": "SMTP host is missing for this sender."}
    with db() as conn:
        attachments = [dict(row) for row in conn.execute(
            "SELECT filename, mime, path FROM files WHERE campaign_id=?",
            (campaign["id"],),
        )]
    message = build_message(sender, recipient["email"], subject, html_body, cc_list, attachments)
    message["From"] = build_aligned_from(display, sender["user"])
    message["Reply-To"] = message["From"]
    if action == "draft":
        if bcc_list:
            message["Bcc"] = ", ".join(bcc_list)
        try:
            save_imap_draft(sender, message)
            return {"status": "DRAFTED", "code": "IMAP", "error": "", "simulated": False}
        except Exception as exc:
            return {"status": "FAILED", "code": "IMAP", "error": friendly_imap_error(exc), "simulated": False}
    envelope = [recipient["email"], *cc_list, *bcc_list]
    try:
        code, _detail = send_with_pool(sender, message, envelope)
        return {"status": "SENT", "code": code, "error": "", "simulated": False}
    except Exception as exc:
        status, code, detail = classify_smtp_error(exc)
        return {"status": status, "code": code, "error": detail, "simulated": False}


def campaign_action(campaign):
    try:
        action = str(campaign["dispatch_action"] or "send").strip().lower()
    except (KeyError, IndexError, TypeError):
        action = "send"
    return "draft" if action == "draft" else "send"


def is_consumer_gmail(sender):
    email = normalize_email((sender or {}).get("user") or (sender or {}).get("email") or "")
    domain = email.split("@", 1)[1] if "@" in email else ""
    host = str((sender or {}).get("host") or "").lower()
    return domain in ("gmail.com", "googlemail.com") or "gmail.com" in host


def imap_host_for(sender):
    host = str((sender or {}).get("host") or "").strip().lower()
    if "gmail" in host or "google" in host:
        return "imap.gmail.com"
    if "yahoo" in host:
        return "imap.mail.yahoo.com"
    if "office365" in host or "outlook" in host or "live.com" in host:
        return "outlook.office365.com"
    if host.startswith("smtp."):
        return "imap." + host[5:]
    if host.startswith("imap."):
        return host
    return "imap.gmail.com"


def quote_mailbox(name):
    text = str(name or "Drafts").strip().strip('"')
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def parse_list_entry(item):
    if isinstance(item, tuple) and item:
        raw_flags = item[0]
        raw_name = item[-1]
        flags = (raw_flags.decode("utf-8", "ignore") if isinstance(raw_flags, (bytes, bytearray)) else str(raw_flags)).lower()
        name = raw_name.decode("utf-8", "ignore") if isinstance(raw_name, (bytes, bytearray)) else str(raw_name)
        return flags, name.strip().strip('"')
    text = item.decode("utf-8", "ignore") if isinstance(item, (bytes, bytearray)) else str(item or "")
    flags = ""
    match = re.match(r"\s*\(([^)]*)\)", text)
    if match:
        flags = match.group(1).lower()
    quoted = [part for part in re.findall(r'"([^"]*)"', text) if part not in ("/", ".")]
    if quoted:
        return flags, quoted[-1]
    parts = text.split()
    return flags, (parts[-1].strip('"') if parts else "")


def pick_drafts_folder(mail, sender=None):
    host = imap_host_for(sender or {})
    fallback = "[Gmail]/Drafts" if "gmail.com" in host or "google" in host else "Drafts"
    try:
        typ, folders = mail.list()
    except Exception:
        return fallback
    if str(typ).upper() != "OK":
        return fallback
    ranked = []
    for item in folders or []:
        if not item:
            continue
        flags, name = parse_list_entry(item)
        if not name or name.upper() in ("INBOX", "/"):
            continue
        lowered = name.lower()
        if "\\drafts" in flags:
            score = 100
        elif lowered == "[gmail]/drafts" or lowered.endswith("/drafts"):
            score = 80
        elif "draft" in lowered:
            score = 40
        else:
            continue
        ranked.append((score, name))
    if not ranked:
        return fallback
    ranked.sort(key=lambda pair: pair[0], reverse=True)
    return ranked[0][1]


def imap_authenticate(mail, user, password):
    caps = {str(cap).upper() for cap in (mail.capabilities or ())}
    if "AUTH=PLAIN" in caps:
        typ, data = mail.authenticate("PLAIN", lambda _response: f"\0{user}\0{password}".encode("utf-8"))
        if str(typ).upper() != "OK":
            detail = data[-1] if data else "Gmail refused the mailbox login."
            raise imaplib.IMAP4.error(detail)
        return
    mail.login(user, password)


def open_imap(sender):
    host = imap_host_for(sender)
    user = normalize_email(sender.get("email") or sender.get("user"))
    password = sender.get("password") or ""
    if not user or not password:
        raise imaplib.IMAP4.error("Mailbox password is missing.")
    mail = imaplib.IMAP4_SSL(host, 993, timeout=25)
    try:
        imap_authenticate(mail, user, password)
    except Exception:
        try:
            mail.logout()
        except Exception:
            try:
                mail.shutdown()
            except Exception:
                pass
        raise
    return mail


def save_imap_draft(sender, message):
    mail = open_imap(sender)
    try:
        folder = pick_drafts_folder(mail, sender)
        fallback = "[Gmail]/Drafts" if "gmail.com" in imap_host_for(sender) else folder
        payload = message.as_bytes()
        typ, data = mail.append(
            quote_mailbox(folder),
            "\\Draft",
            imaplib.Time2Internaldate(time.time()),
            payload,
        )
        if str(typ).upper() != "OK" and folder != fallback:
            typ, data = mail.append(
                quote_mailbox(fallback),
                "\\Draft",
                imaplib.Time2Internaldate(time.time()),
                payload,
            )
        if str(typ).upper() != "OK":
            detail = data[-1] if data else ""
            if isinstance(detail, (bytes, bytearray)):
                detail = detail.decode("utf-8", "replace")
            raise RuntimeError(str(detail or "Gmail did not store the draft."))
    finally:
        try:
            mail.logout()
        except Exception:
            pass


def approved_senders_for(conn, user):
    found = []
    for sender in configured_senders():
        if sender_allowed(conn, user["email"], user["role"], sender["id"]):
            found.append(sender)
    return found


def row_mailbox(item, fields):
    fields = fields or {}
    candidates = [
        item.get("sender") if isinstance(item, dict) else "",
        item.get("sender_id") if isinstance(item, dict) else "",
        fields.get("Account Email"),
        fields.get("Mailing Email"),
        fields.get("Mailbox"),
        fields.get("Sender Email"),
        fields.get("From Email"),
        fields.get("Sender"),
        fields.get("sender"),
        fields.get("From"),
    ]
    for value in candidates:
        email = normalize_email(value)
        if EMAIL_RE.match(email):
            return email
    return ""


def match_row_sender(pool, item, fields):
    wanted = row_mailbox(item, fields)
    if wanted:
        for sender in pool:
            if wanted in (
                normalize_email(sender.get("email")),
                normalize_email(sender.get("user")),
                str(sender.get("id") or "").lower(),
            ):
                return sender
    return None


SHEET_ID_RE = re.compile(r"/spreadsheets/d/([a-zA-Z0-9-_]+)")
SHEET_GID_RE = re.compile(r"[?#&]gid=(\d+)")
SHEET_HEADERS = {
    "email": {"email", "e-mail", "email address", "emailaddress", "mail", "recipient", "recipient email", "to"},
    "first": {"firstname", "first name", "first", "given name", "givenname", "name"},
    "last": {"lastname", "last name", "last", "surname", "family name"},
    "company": {"company", "organization", "organisation", "org", "affiliation", "institution"},
    "custom": {"custom1", "custom", "note", "tag", "segment"},
    "template": {"template", "html", "body", "message", "email body"},
    "sender": {"sender", "from", "from email", "sender email", "mailbox", "account email", "mailing email", "sending email", "from address"},
    "sender_name": {"sender name", "from name", "displayname", "display name", "sendername"},
}


def parse_sheet_link(value):
    text = str(value or "").strip()
    match = SHEET_ID_RE.search(text)
    if match:
        gid = ""
        gid_match = SHEET_GID_RE.search(text)
        if gid_match:
            gid = gid_match.group(1)
        return match.group(1), gid
    if re.fullmatch(r"[a-zA-Z0-9-_]{20,}", text):
        return text, ""
    raise ApiError("Paste a Google Sheet link, like https://docs.google.com/spreadsheets/d/…")


def load_sheet_account():
    settings = drive_settings()
    path = settings.get("path") or ""
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or not data.get("private_key") or not data.get("client_email"):
        return None
    return data


def sheet_matrix_from_csv(raw):
    text = raw.decode("utf-8-sig", "replace")
    if "<html" in text[:400].lower():
        raise RuntimeError("Google returned a sign-in page instead of the sheet.")
    rows = list(csv.reader(io.StringIO(text)))
    return rows


def download_sheet_matrix(url):
    spreadsheet_id, gid = parse_sheet_link(url)
    account = load_sheet_account()
    errors = []
    if account and drive_sync.cryptography_ready():
        try:
            matrix, title = drive_sync.fetch_sheet_matrix(account, spreadsheet_id, gid)
            return matrix, title or "Google Sheet"
        except Exception as exc:
            errors.append(str(exc))
        try:
            query = urllib.parse.urlencode({"mimeType": "text/csv"})
            export = f"https://www.googleapis.com/drive/v3/files/{urllib.parse.quote(spreadsheet_id)}/export?{query}"
            token = drive_sync._access_token(account)
            matrix = sheet_matrix_from_csv(drive_sync._read_url(export, token))
            return matrix, "Google Sheet"
        except Exception as exc:
            errors.append(str(exc))
    public = f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}/export?format=csv"
    if gid:
        public += f"&gid={urllib.parse.quote(gid)}"
    try:
        matrix = sheet_matrix_from_csv(drive_sync._read_url(public))
        return matrix, "Google Sheet"
    except Exception as exc:
        errors.append(str(exc))
    email = (account or {}).get("client_email") or drive_status().get("client_email") or "the service account"
    detail = errors[-1] if errors else "The sheet could not be read."
    if "403" in detail or "404" in detail or "sign-in" in detail.lower() or "401" in detail:
        raise ApiError(f"Share that Google Sheet with {email}, or set the sheet to anyone with the link. {detail[:180]}")
    raise ApiError(detail[:300] or "The Google Sheet could not be read.")


def column_letter(index):
    number = index + 1
    letters = ""
    while number > 0:
        number, rem = divmod(number - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def sheet_field(fields, *names):
    wanted = {re.sub(r"[\s_]+", "", name.lower()) for name in names}
    for key, value in (fields or {}).items():
        if re.sub(r"[\s_]+", "", str(key).lower()) in wanted and str(value or "").strip():
            return str(value).strip()
    return ""


def parse_sheet_date(value):
    text = str(value or "").strip()
    if not text:
        return None
    if re.fullmatch(r"\d+(?:\.\d+)?", text):
        serial = float(text)
        if 20000 < serial < 80000:
            return (datetime.datetime(1899, 12, 30) + datetime.timedelta(days=int(serial))).date()
    iso = re.match(r"^(\d{4})[-/](\d{1,2})[-/](\d{1,2})", text)
    if iso:
        try:
            return datetime.date(int(iso.group(1)), int(iso.group(2)), int(iso.group(3)))
        except ValueError:
            return None
    parts = re.match(r"^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})", text)
    if not parts:
        return None
    year = int(parts.group(3))
    if year < 100:
        year += 2000
    first = int(parts.group(1))
    second = int(parts.group(2))
    month_first = first <= 12 and second > 12
    day = second if month_first else first
    month = first if month_first else second
    try:
        return datetime.date(year, month, day)
    except ValueError:
        return None


def parse_sheet_time(value):
    text = str(value or "").strip()
    if not text:
        return None
    if re.fullmatch(r"\d+(?:\.\d+)?", text):
        number = float(text)
        if 0 < number < 1:
            total = int(round(number * 24 * 60))
            return (total // 60) % 24, total % 60
    match = re.search(r"(\d{1,2})[:.](\d{2})(?::\d{2})?\s*([ap]m)?", text, re.I)
    if not match:
        return None
    hour = int(match.group(1))
    minute = int(match.group(2))
    mark = (match.group(3) or "").lower()
    if mark == "pm" and hour < 12:
        hour += 12
    if mark == "am" and hour == 12:
        hour = 0
    if hour > 23 or minute > 59:
        return None
    return hour, minute


def row_ready_unix(fields, timezone, fallback):
    date_raw = sheet_field(fields, "S_Date", "SDate", "Schedule Date", "Send Date")
    time_raw = sheet_field(fields, "S_Time", "STime", "Schedule Time", "Send Time")
    if not date_raw and not time_raw:
        return fallback
    day = parse_sheet_date(date_raw)
    clock = parse_sheet_time(time_raw) or parse_sheet_time(date_raw)
    if not day or not clock:
        return "invalid"
    try:
        zone = ZoneInfo(timezone or "UTC")
    except Exception:
        zone = datetime.timezone.utc
    local = datetime.datetime(day.year, day.month, day.day, clock[0], clock[1], tzinfo=zone)
    return local.timestamp()


def rows_from_sheet(matrix):
    if not matrix:
        return [], [], 0
    headers = [str(cell or "").replace("\ufeff", "").strip() for cell in matrix[0]]
    indexes = {name: -1 for name in SHEET_HEADERS}
    for index, header in enumerate(headers):
        key = header.lower()
        for name, names in SHEET_HEADERS.items():
            if indexes[name] < 0 and key in names:
                indexes[name] = index
                break
    if indexes["email"] < 0:
        best_index = -1
        best_score = 0
        width = max((len(row) for row in matrix[1:31]), default=0)
        for column in range(width):
            score = 0
            for row in matrix[1:31]:
                if column < len(row) and EMAIL_RE.match(normalize_email(row[column])):
                    score += 1
            if score > best_score:
                best_score = score
                best_index = column
        indexes["email"] = best_index
    rows = []
    invalid = 0
    columns = []
    for header in headers:
        if header and header not in columns:
            columns.append(header[:80])
    for raw in matrix[1:]:
        if not any(str(cell or "").strip() for cell in raw):
            continue

        def cell(index):
            if index < 0 or index >= len(raw):
                return ""
            return str(raw[index] or "").strip()[:5000]

        email = normalize_email(cell(indexes["email"]))
        if not EMAIL_RE.match(email):
            invalid += 1
            continue
        fields = {}
        width = max(len(headers), len(raw))
        for index in range(width):
            value = cell(index)
            header = headers[index][:80] if index < len(headers) else ""
            if not header and not value:
                continue
            if header:
                fields[header] = value
            fields[column_letter(index)] = value
        sender = cell(indexes["sender"])
        sender_name = cell(indexes["sender_name"])
        if sender:
            fields["Sender"] = sender
        if sender_name:
            fields["Sender Name"] = sender_name
        first = cell(indexes["first"])
        if first:
            fields.setdefault("Name", first)
        rows.append({
            "email": email,
            "first_name": first[:200],
            "last_name": cell(indexes["last"])[:200],
            "company": cell(indexes["company"])[:200],
            "custom1": cell(indexes["custom"])[:500],
            "template": cell(indexes["template"]),
            "sender": sender,
            "sender_name": sender_name,
            "fields": fields,
        })
        if len(rows) >= 20000:
            break
    return rows, columns, invalid


MAILBOX_HEADERS = {
    "label": {"label", "name", "from name", "display name", "sender name"},
    "email": {"email", "mailing email", "account email", "user", "username", "smtp user"},
    "password": {"password", "pass", "app password", "apppassword", "smtp password"},
    "host": {"host", "smtp host", "smtp", "server"},
    "port": {"port", "smtp port"},
    "secure": {"secure", "security", "encryption", "ssl", "tls"},
}


def sheet_header_index(headers, names):
    for index, header in enumerate(headers):
        if header.lower() in names:
            return index
    return -1


def port_number(port, default):
    try:
        number = int(str(port or "").strip() or default)
    except (TypeError, ValueError):
        number = default
    if number < 1 or number > 65535:
        return default
    return number


def normalize_secure(value, port):
    text = str(value or "").strip().lower()
    if text in ("ssl", "smtps", "ssl/tls", "465"):
        return "ssl", port_number(port, 465)
    if text in ("tls", "starttls", "start tls", "587"):
        return "tls", port_number(port, 587)
    if text in ("none", "plain", "off"):
        return "none", port_number(port, 25)
    number = port_number(port, 0)
    if number == 587:
        return "tls", 587
    if number == 25:
        return "none", 25
    return "ssl", number or 465


def mailboxes_from_sheet(matrix):
    if not matrix:
        raise ApiError("The Google Sheet is empty.")
    headers = [str(cell or "").replace("\ufeff", "").strip() for cell in matrix[0]]
    indexes = {name: sheet_header_index(headers, names) for name, names in MAILBOX_HEADERS.items()}
    if indexes["email"] < 0 or indexes["password"] < 0:
        raise ApiError("The sheet needs Email and Password columns. Expected headers: Label, Email, Password, Host, Port, Secure.")
    found = []
    skipped = []
    for raw in matrix[1:]:
        if not any(str(cell or "").strip() for cell in raw):
            continue

        def cell(index):
            if index < 0 or index >= len(raw):
                return ""
            return str(raw[index] or "").strip()

        email = normalize_email(cell(indexes["email"]))
        if not EMAIL_RE.match(email):
            skipped.append(cell(indexes["email"]) or "blank row")
            continue
        password = sanitize_password(cell(indexes["password"]))
        if len(password) < 8:
            skipped.append(email)
            continue
        host = cell(indexes["host"]) or ("smtp.gmail.com" if email.endswith("@gmail.com") or email.endswith("@googlemail.com") else "")
        if not host:
            skipped.append(email)
            continue
        secure, port = normalize_secure(cell(indexes["secure"]), cell(indexes["port"]))
        found.append({
            "display_name": cell(indexes["label"])[:80],
            "email": email,
            "user": email,
            "password": password,
            "host": host,
            "port": port,
            "secure": secure,
        })
        if len(found) >= 80:
            break
    if not found:
        raise ApiError("No mailing accounts could be read. Check Email, Password, and Host.")
    return found, skipped[:8]


def stored_sender_record(sender):
    return {
        "id": sender["id"],
        "email": sender["email"],
        "display_name": sender["display_name"],
        "host": sender["host"],
        "port": sender["port"],
        "secure": sender["secure"],
        "user": sender["user"],
        "password": sender["password"],
        "daily_cap": sender.get("daily_cap") or 0,
    }


def apply_mailbox_sheet(url, only_email=""):
    matrix, title = download_sheet_matrix(url)
    rows, skipped = mailboxes_from_sheet(matrix)
    wanted = normalize_email(only_email)
    if wanted:
        rows = [row for row in rows if row["email"] == wanted]
        if not rows:
            raise ApiError(f"{wanted} is not in that Google Sheet.")
    config = load_config()
    current = []
    by_email = {}
    for raw in config.get("senders") or []:
        sender = prepare_sender(raw)
        if not sender or not EMAIL_RE.match(sender.get("email") or ""):
            continue
        sender["id"] = make_sender_id(sender.get("id"), sender["email"])
        current.append(sender)
        by_email[sender["email"]] = sender
    added = 0
    updated = 0
    changed = False
    for row in rows:
        existing = by_email.get(row["email"])
        same = False
        if existing:
            same = (
                existing.get("password") == row["password"]
                and str(existing.get("host") or "") == row["host"]
                and int(existing.get("port") or 0) == int(row["port"])
                and str(existing.get("secure") or "") == row["secure"]
                and str(existing.get("display_name") or "") == row["display_name"]
            )
            existing.update({
                "display_name": row["display_name"] or existing.get("display_name") or "",
                "user": row["email"],
                "password": row["password"],
                "host": row["host"],
                "port": row["port"],
                "secure": row["secure"],
            })
            updated += 1
            changed = changed or not same
        else:
            prepared = prepare_sender({
                "id": make_sender_id("", row["email"]),
                "email": row["email"],
                "user": row["email"],
                "display_name": row["display_name"],
                "password": row["password"],
                "host": row["host"],
                "port": row["port"],
                "secure": row["secure"],
            })
            current.append(prepared)
            by_email[prepared["email"]] = prepared
            added += 1
            changed = True
    config["senders"] = [stored_sender_record(item) for item in current]
    config["mailbox_sheet_url"] = str(url or "").strip()[:500]
    for item in config["senders"]:
        if normalize_email(item.get("email")) == ADMIN_EMAIL and len(item.get("password") or "") == 16:
            master = dict(config.get("master_smtp") or {})
            master.update({
                "host": item.get("host") or "smtp.gmail.com",
                "port": item.get("port") or 465,
                "secure": item.get("secure") or "ssl",
                "user": ADMIN_EMAIL,
                "password": item["password"],
                "from_name": item.get("display_name") or master.get("from_name") or "Parth Mailing",
            })
            config["master_smtp"] = master
    for item in config["senders"]:
        remember_otp_sender(config, item)
    write_config(config)
    return {
        "title": title,
        "added": added,
        "updated": updated,
        "changed": changed,
        "skipped": skipped,
        "sheet_url": config["mailbox_sheet_url"],
    }


def provider_cap(sender=None, email=""):
    if isinstance(sender, str):
        email = sender
        sender = None
    sender = sender if isinstance(sender, dict) else {}
    email = normalize_email(email or sender.get("user") or sender.get("email") or "")
    domain = email.split("@", 1)[1] if "@" in email else ""
    host = str(sender.get("host") or "").lower()
    if domain in ("gmail.com", "googlemail.com"):
        return GMAIL_DAILY_CAP
    if domain or "gmail" in host or "google" in host or "googlemail" in host:
        return WORKSPACE_DAILY_CAP
    try:
        return int(load_config().get("other_daily_cap") or WORKSPACE_DAILY_CAP)
    except (TypeError, ValueError):
        return WORKSPACE_DAILY_CAP


def mailbox_daily_cap(sender=None, email=""):
    sender = sender if isinstance(sender, dict) else None
    cap = provider_cap(sender, email)
    try:
        custom = int((sender or {}).get("daily_cap") or 0)
    except (TypeError, ValueError):
        custom = 0
    if custom > 0:
        return max(1, min(custom, cap))
    return cap


def grant_daily_cap(row):
    sender = resolve_requested_sender(row["sender_id"])
    return mailbox_daily_cap(sender, requested_mailbox_label(row["sender_id"]))


def pace_used(sender_email):
    cutoff = time.time() - 86400
    with db() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM pace WHERE sender_email=? AND sent_at>=?",
            (normalize_email(sender_email), cutoff),
        ).fetchone()
    return int(row["n"])


def mark_pace(sender_email):
    with db() as conn:
        conn.execute(
            "INSERT INTO pace (sender_email, sent_at) VALUES (?, ?)",
            (normalize_email(sender_email), time.time()),
        )
        conn.execute("DELETE FROM pace WHERE sent_at < ?", (time.time() - 86400 * 2,))


def recent_sends(owner, since):
    with db() as conn:
        rows = conn.execute(
            """
            SELECT r.sent_at FROM recipients r
            JOIN campaigns c ON c.id = r.campaign_id
            WHERE c.owner=? AND r.status='SENT' AND r.sent_at>=?
            """,
            (owner, since),
        ).fetchall()
    return [row["sent_at"] for row in rows]


def rate_wait_seconds(owner, limits):
    now = time.time()
    sent = recent_sends(owner, now - 86400)
    waits = []
    for key, window in (("per_minute", 60), ("per_hour", 3600), ("per_day", 86400)):
        cap = int(limits.get(key) or 0)
        if cap <= 0:
            continue
        in_window = [stamp for stamp in sent if stamp >= now - window]
        if len(in_window) >= cap:
            waits.append(min(in_window) + window - now)
    return max(waits) if waits else 0


def set_hold(campaign_id, reason, delay):
    SLEEP_UNTIL[campaign_id] = time.time() + delay
    with db() as conn:
        conn.execute("UPDATE campaigns SET hold_reason=? WHERE id=?", (reason[:500], campaign_id))


def clear_hold(campaign_id):
    with db() as conn:
        conn.execute("UPDATE campaigns SET hold_reason='' WHERE id=? AND hold_reason!=''", (campaign_id,))


def select_campaign():
    now = time.time()
    with db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM campaigns
            WHERE status='running' OR (status='scheduled' AND schedule_at<=?)
            ORDER BY created_at
            """,
            (now,),
        ).fetchall()
    ready = [row for row in rows if SLEEP_UNTIL.get(row["id"], 0) <= now]
    return ready[0] if ready else None


def claim_recipient(campaign_id, sender_id=None):
    now = time.time()
    with db() as conn:
        if sender_id:
            row = conn.execute(
                """
                SELECT * FROM recipients
                WHERE campaign_id=? AND status='QUEUED' AND IFNULL(sender_id,'')=?
                  AND (ready_at IS NULL OR ready_at<=?)
                ORDER BY id LIMIT 1
                """,
                (campaign_id, sender_id, now),
            ).fetchone()
        else:
            row = conn.execute(
                """
                SELECT * FROM recipients
                WHERE campaign_id=? AND status='QUEUED' AND (ready_at IS NULL OR ready_at<=?)
                ORDER BY id LIMIT 1
                """,
                (campaign_id, now),
            ).fetchone()
        if not row:
            return None
        cur = conn.execute(
            "UPDATE recipients SET status='SENDING' WHERE id=? AND status='QUEUED'",
            (row["id"],),
        )
        if cur.rowcount != 1:
            return None
        return dict(row)


def next_ready_at(campaign_id, sender_id=None):
    with db() as conn:
        if sender_id:
            row = conn.execute(
                """
                SELECT MIN(ready_at) AS n FROM recipients
                WHERE campaign_id=? AND status='QUEUED' AND IFNULL(sender_id,'')=? AND ready_at IS NOT NULL
                """,
                (campaign_id, sender_id),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT MIN(ready_at) AS n FROM recipients WHERE campaign_id=? AND status='QUEUED' AND ready_at IS NOT NULL",
                (campaign_id,),
            ).fetchone()
    return row["n"] if row and row["n"] else None


def save_outcome(campaign, recipient, outcome, sender):
    now = time.time()
    with db() as conn:
        sent_at = now if outcome["status"] in ("SENT", "DRAFTED") else None
        conn.execute(
            "UPDATE recipients SET status=?, error=?, smtp_code=?, sent_at=? WHERE id=?",
            (outcome["status"], outcome.get("error") or "", outcome.get("code") or "", sent_at, recipient["id"]),
        )
        recompute_counts(conn, campaign["id"])
        if outcome["status"] == "SENT" and not outcome.get("already_recorded"):
            remember_sent(conn, recipient["email"], campaign["owner"], campaign["id"])
        if outcome["status"] == "SENT" and not outcome.get("simulated"):
            conn.execute(
                "INSERT INTO pace (sender_email, sent_at) VALUES (?, ?)",
                (normalize_email(sender["user"]), now),
            )
        if outcome["status"] != "SENT" and account_error_is_fatal(outcome.get("error") or ""):
            conn.execute(
                "UPDATE campaigns SET status='paused', hold_reason=? WHERE id=? AND status='running'",
                (outcome.get("error") or "Sending paused", campaign["id"]),
            )
            add_audit(conn, "relay", "campaign_paused", f"{campaign['id']} {outcome.get('error') or ''}")
    if outcome["status"] == "SENT" and not outcome.get("simulated"):
        with db() as conn:
            conn.execute("DELETE FROM pace WHERE sent_at < ?", (time.time() - 86400 * 2,))


def sleep_key(campaign_id, sender_id):
    return f"{campaign_id}:{sender_id or 'default'}"


def after_send_delay(campaign, sender):
    key = sleep_key(campaign["id"], (sender or {}).get("id"))
    if campaign_action(campaign) == "draft":
        SLEEP_UNTIL[key] = time.time() + random.uniform(1.2, 3.0)
        return
    pace = normalize_pace(json.loads(campaign["pace_json"] or "{}"))
    batch_key = key
    count = BATCH_COUNT.get(batch_key, 0) + 1
    if count >= pace["batch_size"]:
        BATCH_COUNT[batch_key] = 0
        delay = pace["batch_pause_minutes"] * 60
    else:
        BATCH_COUNT[batch_key] = count
        low = pace["delay_min_seconds"]
        high = pace["delay_max_seconds"]
        delay = random.uniform(low, high) if high > low else low
    if is_consumer_gmail(sender):
        delay = max(delay, GMAIL_CONSUMER_GAP)
    else:
        delay = max(delay, 4.0)
    SLEEP_UNTIL[key] = time.time() + delay


def report_rows(conn, campaign_id):
    rows = []
    for rec in conn.execute("SELECT * FROM recipients WHERE campaign_id=? ORDER BY id", (campaign_id,)):
        stamp = ""
        if rec["sent_at"]:
            stamp = datetime.datetime.utcfromtimestamp(rec["sent_at"]).strftime("%Y-%m-%d %H:%M:%S")
        rows.append([
            rec["email"], rec["first_name"], rec["last_name"], rec["company"], rec["custom1"],
            rec["status"], stamp, rec["smtp_code"], rec["error"],
        ])
    return rows


def write_report(campaign_id):
    with db() as conn:
        camp = conn.execute("SELECT * FROM campaigns WHERE id=?", (campaign_id,)).fetchone()
        if not camp:
            return
        rows = report_rows(conn, campaign_id)
    payload = xlsx_writer.workbook_bytes(REPORT_HEADERS, rows)
    path = os.path.join(REPORT_DIR, f"{campaign_id}.xlsx")
    with open(path, "wb") as handle:
        handle.write(payload)
    with db() as conn:
        conn.execute("UPDATE campaigns SET report_path=? WHERE id=?", (path, campaign_id))
        add_audit(conn, "relay", "report_ready", campaign_id)
    day = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    queue_drive_upload(path, ["Campaign_Reports", day], campaign_id, "drive_report_url")
    log(f"Report ready for {campaign_id}")


def finish_if_drained(campaign_id):
    with db() as conn:
        camp = conn.execute("SELECT status FROM campaigns WHERE id=?", (campaign_id,)).fetchone()
        if not camp or camp["status"] != "running":
            return False
        left = conn.execute(
            "SELECT COUNT(*) AS n FROM recipients WHERE campaign_id=? AND status='QUEUED'",
            (campaign_id,),
        ).fetchone()["n"]
        if left:
            return False
        cur = conn.execute(
            "UPDATE campaigns SET status='complete', finished_at=?, hold_reason='' WHERE id=? AND status='running'",
            (time.time(), campaign_id),
        )
        changed = cur.rowcount == 1
        if changed:
            add_audit(conn, "relay", "campaign_complete", campaign_id)
    if changed:
        SLEEP_UNTIL.pop(campaign_id, None)
        BATCH_COUNT.pop(campaign_id, None)
        write_report(campaign_id)
        log(f"Campaign {campaign_id} complete")
    return changed


def load_campaign(campaign_id):
    with db() as conn:
        row = conn.execute("SELECT * FROM campaigns WHERE id=?", (campaign_id,)).fetchone()
        return dict(row) if row else None


def account_worker(campaign_id, sender_id):
    key = sleep_key(campaign_id, sender_id)
    try:
        process_account_send(campaign_id, sender_id)
    except Exception:
        log(traceback.format_exc())
        SLEEP_UNTIL[key] = time.time() + 8
    finally:
        with DISPATCH_LOCK:
            DISPATCH_BUSY.discard(key)


def process_account_send(campaign_id, sender_id):
    camp = load_campaign(campaign_id)
    if not camp or camp["status"] != "running":
        return
    sender = sender_by_id(sender_id) or sender_by_id(camp.get("sender_id"))
    key = sleep_key(campaign_id, sender_id)
    if not sender:
        SLEEP_UNTIL[key] = time.time() + 30
        return
    with db() as conn:
        user_row = conn.execute("SELECT * FROM users WHERE email=?", (camp["owner"],)).fetchone()
        limits = effective_limits(conn, user_row, sender["id"]) if user_row else default_limits()
        fresh = conn.execute("SELECT status FROM campaigns WHERE id=?", (camp["id"],)).fetchone()
    if not fresh or fresh["status"] != "running":
        return
    allowed, window_message = within_window(limits)
    if not allowed:
        SLEEP_UNTIL[key] = time.time() + 20
        set_hold(camp["id"], window_message, 20)
        return
    company_cap = int(load_desk_ui().get("global_daily_cap") or 0)
    if company_cap > 0:
        with db() as conn:
            company_used = conn.execute(
                "SELECT COUNT(*) AS n FROM recipients WHERE status='SENT' AND sent_at>=?",
                (time.time() - 86400,),
            ).fetchone()["n"]
        if company_used >= company_cap:
            SLEEP_UNTIL[key] = time.time() + 30
            set_hold(camp["id"], f"Company daily limit of {company_cap} has been reached.", 30)
            return
    wait = rate_wait_seconds(camp["owner"], limits)
    if wait > 0:
        SLEEP_UNTIL[key] = time.time() + min(wait, 30)
        return
    if live_delivery(sender) and campaign_action(camp) != "draft":
        used = pace_used(sender["user"])
        cap = min(mailbox_daily_cap(sender), int(limits.get("per_day") or mailbox_daily_cap(sender)))
        if used >= cap:
            SLEEP_UNTIL[key] = time.time() + 120
            log(f"{sender['user']} reached the 24-hour mailbox cap of {cap}")
            return
    clear_hold(camp["id"])
    recipient = claim_recipient(camp["id"], sender["id"])
    if recipient is None:
        nxt = next_ready_at(camp["id"], sender["id"])
        if nxt and nxt > time.time():
            SLEEP_UNTIL[key] = nxt
            return
        finish_if_drained(camp["id"])
        return
    address = normalize_email(recipient["email"])
    held = False
    if repeats_blocked() and campaign_action(camp) != "draft":
        with db() as conn:
            held = remember_sent(conn, address, camp["owner"], camp["id"], exclusive=True)
        if not held:
            save_outcome(camp, recipient, {
                "status": "SKIPPED",
                "code": "DUP",
                "error": "Already emailed this person. A second message was not sent.",
                "simulated": False,
                "already_recorded": True,
            }, sender)
            finish_if_drained(camp["id"])
            log(f"SKIPPED {sender['user']} -> {address} already emailed")
            return
    try:
        outcome = deliver(camp, recipient, sender)
    except Exception as exc:
        outcome = {"status": "FAILED", "code": "", "error": str(exc)[:800], "simulated": False}
    if outcome.get("status") not in ("SENT", "DRAFTED") and held:
        with db() as conn:
            release_sent(conn, address, camp["id"])
        held = False
    outcome["already_recorded"] = held
    save_outcome(camp, recipient, outcome, sender)
    after_send_delay(camp, sender)
    label = "SIMULATED" if outcome.get("simulated") else outcome["status"]
    verb = "draft" if campaign_action(camp) == "draft" else "send"
    log(f"{label} [{verb}] {sender['user']} -> {recipient['email']} {outcome.get('code') or ''} {(outcome.get('error') or '')[:160]}")
    finish_if_drained(camp["id"])


def engine_dispatch():
    now = time.time()
    launched = 0
    with db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM campaigns
            WHERE status='running' OR (status='scheduled' AND schedule_at<=?)
            ORDER BY created_at
            """,
            (now,),
        ).fetchall()
        camps = [dict(row) for row in rows]
    for camp in camps:
        if camp["status"] == "scheduled":
            with db() as conn:
                conn.execute(
                    "UPDATE campaigns SET status='running', started_at=?, hold_reason='' WHERE id=? AND status='scheduled'",
                    (time.time(), camp["id"]),
                )
                add_audit(conn, "relay", "campaign_started", camp["id"])
            log(f"Scheduled campaign {camp['id']} is starting")
            launched += 1
            continue
        with db() as conn:
            sender_ids = [
                row["sender_id"] or camp.get("sender_id") or ""
                for row in conn.execute(
                    "SELECT DISTINCT sender_id FROM recipients WHERE campaign_id=? AND status='QUEUED'",
                    (camp["id"],),
                )
            ]
        sender_ids = [item for item in sender_ids if item]
        if not sender_ids:
            finish_if_drained(camp["id"])
            continue
        for sender_id in sender_ids:
            key = sleep_key(camp["id"], sender_id)
            if SLEEP_UNTIL.get(key, 0) > now:
                continue
            with DISPATCH_LOCK:
                if key in DISPATCH_BUSY:
                    continue
                DISPATCH_BUSY.add(key)
            threading.Thread(
                target=account_worker,
                args=(camp["id"], sender_id),
                name=f"mail-{sender_id[:12]}",
                daemon=True,
            ).start()
            launched += 1
    return launched


def engine_loop():
    log("Campaign engine started")
    while not STOP_ENGINE.is_set():
        try:
            worked = engine_dispatch()
        except Exception:
            log(traceback.format_exc())
            worked = False
        if not worked:
            STOP_ENGINE.wait(0.35)


def recover_incomplete():
    with db() as conn:
        conn.execute(
            """
            UPDATE recipients
            SET status='FAILED', error='Relay restarted before this send finished', smtp_code='RESTART'
            WHERE status='SENDING'
            """
        )
        running = [row["id"] for row in conn.execute("SELECT id FROM campaigns WHERE status='running'")]
    for campaign_id in running:
        finish_if_drained(campaign_id)


def read_mailbox_status():
    try:
        with open(MAILBOX_STATUS_PATH, encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, dict):
            return {"ok": bool(data.get("ok")), "message": str(data.get("message") or "")[:400]}
    except (OSError, json.JSONDecodeError):
        pass
    return {"ok": None, "message": ""}


def write_mailbox_status(ok, message):
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(MAILBOX_STATUS_PATH, "w", encoding="utf-8") as handle:
            json.dump({"ok": bool(ok), "message": str(message or "")[:400]}, handle)
    except OSError:
        pass


def test_sender_connection(sender):
    if not live_delivery(sender):
        return True, "No mailbox password is saved, so campaigns for this sender stay in simulation mode."
    if not sender["host"] or not sender["user"] or not sender["password"]:
        return False, "Host, username, and password are required."
    smtp_message = ""
    try:
        smtp = connect_smtp(sender)
        safe_quit(smtp)
        smtp_message = f"SMTP authentication succeeded for {sender['user']}."
    except Exception as exc:
        smtp_message = friendly_smtp_error(exc)
    imap_message = ""
    imap_ok = False
    try:
        mail = open_imap(sender)
        folder = pick_drafts_folder(mail, sender)
        try:
            mail.logout()
        except Exception:
            pass
        imap_ok = True
        imap_message = f"Gmail Drafts is ready in {folder}."
    except Exception as exc:
        imap_message = friendly_imap_error(exc)
    ok = bool(smtp_message.startswith("SMTP authentication succeeded")) and imap_ok
    message = imap_message if not imap_ok else f"{smtp_message} {imap_message}"
    if not ok and not imap_ok:
        message = imap_message
    if normalize_email(sender.get("user")) == ADMIN_EMAIL:
        write_mailbox_status(ok, message)
    return ok, message


def deliver_fresh_smtp(sender, message, target):
    smtp = connect_smtp(sender)
    try:
        refused = smtp.sendmail(sender["user"], [target], message.as_bytes())
        if refused:
            raise smtplib.SMTPRecipientsRefused(refused)
    finally:
        safe_quit(smtp)


def send_otp_email(target, code, purpose="login"):
    master = otp_sender() or refresh_otp_sender()
    if not master or not master["host"] or not master["user"] or not master["password"]:
        raise ApiError(f"The sign-in mailbox {OTP_FROM} is not ready to email codes.", 502)
    minutes = max(1, otp_ttl() // 60)
    labels = {
        "register": "Confirm your Parth Mailing account",
        "first": "Confirm your Parth Mailing password",
        "reset": "Reset your Parth Mailing password",
        "login": "Your Parth Mailing sign-in code",
    }
    headline = labels.get(purpose, labels["login"])
    body = f"""<!DOCTYPE html><html><body style="margin:0;background:#0e1524;padding:28px;font-family:Segoe UI,Arial,sans-serif;">
<div style="max-width:480px;margin:0 auto;padding:28px;border-radius:24px;background:#172033;border:1px solid rgba(255,255,255,0.15);color:#f4f7fb;">
<p style="letter-spacing:.16em;text-transform:uppercase;font-size:12px;color:#9fb0c9;margin:0 0 8px;">Parth Mailing</p>
<h1 style="font-size:22px;font-weight:600;margin:0 0 8px;">{html.escape(headline)}</h1>
<p style="color:#c5d0e0;line-height:1.5;">Your code is below. It expires in {minutes} minutes. If you did not ask for it, ignore this email.</p>
<p style="font-size:36px;letter-spacing:10px;font-weight:700;background:#101826;border-radius:16px;padding:16px 12px;text-align:center;">{html.escape(code)}</p>
</div></body></html>"""
    message = MIMEMultipart("alternative")
    message["From"] = build_aligned_from(master["display_name"] or "Parth Mailing", OTP_FROM)
    message["To"] = target
    message["Subject"] = f"{code} is your Parth Mailing code"
    message["Date"] = email.utils.formatdate(localtime=True)
    message["Message-ID"] = email.utils.make_msgid(domain="gr-conferences.com")
    message.attach(MIMEText(f"Your Parth Mailing code is {code}. It expires in {minutes} minutes.", "plain", "utf-8"))
    message.attach(MIMEText(body, "html", "utf-8"))

    def deliver(sender):
        deliver_fresh_smtp(sender, message, target)

    try:
        deliver(master)
    except Exception as first:
        refreshed = refresh_otp_sender()
        if refreshed and refreshed.get("password") and refreshed.get("password") != master.get("password"):
            try:
                deliver(refreshed)
                write_mailbox_status(True, f"Sign-in codes send from {OTP_FROM}.")
                log(f"Sign-in code emailed to {target} from {OTP_FROM}.")
                return
            except Exception as exc:
                first = exc
        detail = friendly_smtp_error(first)
        write_mailbox_status(False, detail)
        raw = str(first)
        for hidden in (master.get("password") or "", (refreshed or {}).get("password") or ""):
            if hidden and hidden in raw:
                raw = raw.replace(hidden, "[redacted]")
        log(f"Sign-in email to {target} failed: {type(first).__name__}: {raw[:240]}")
        raise ApiError("The 6-digit sign-in code could not be emailed. Wait a moment and try again.", 502) from None
    write_mailbox_status(True, f"Sign-in codes send from {OTP_FROM}.")
    log(f"Sign-in code emailed to {target} from {OTP_FROM}.")


def notify_admin_mailbox_request(user_email, display_name, mailbox):
    sender = otp_sender() or refresh_otp_sender()
    from_address = OTP_FROM
    if not sender or not sender.get("password"):
        sender = prepare_sender(load_config().get("master_smtp") or {})
        from_address = (sender or {}).get("user") or ADMIN_EMAIL
    if not sender or not sender.get("password") or not sender.get("host"):
        log(f"Mailbox request from {user_email} for {mailbox} (admin email not sent: mailbox not ready)")
        return False
    who = display_name or user_email
    subject = f"Approve mailbox access: {mailbox}"
    body = f"""<!DOCTYPE html><html><body style="margin:0;background:#0e1524;padding:28px;font-family:Segoe UI,Arial,sans-serif;">
<div style="max-width:480px;margin:0 auto;padding:28px;border-radius:24px;background:#172033;border:1px solid rgba(255,255,255,0.15);color:#f4f7fb;">
<p style="letter-spacing:.16em;text-transform:uppercase;font-size:12px;color:#9fb0c9;margin:0 0 8px;">Parth Mailing</p>
<h1 style="font-size:22px;font-weight:600;margin:0 0 8px;">Access approval queue</h1>
<p style="color:#c5d0e0;line-height:1.5;">{html.escape(who)} ({html.escape(user_email)}) asked to send from <strong>{html.escape(mailbox)}</strong>.</p>
<p style="color:#c5d0e0;line-height:1.5;">Open the desk, then Admin, then Access approval queue. Approve or deny it there.</p>
</div></body></html>"""
    message = MIMEMultipart("alternative")
    message["From"] = build_aligned_from("Parth Mailing", from_address)
    message["To"] = ADMIN_EMAIL
    message["Subject"] = subject
    message["Date"] = email.utils.formatdate(localtime=True)
    message["Message-ID"] = email.utils.make_msgid(domain="gr-conferences.com")
    message.attach(MIMEText(
        f"{who} ({user_email}) asked to send from {mailbox}. Open Admin, then Access approval queue.",
        "plain",
        "utf-8",
    ))
    message.attach(MIMEText(body, "html", "utf-8"))
    try:
        deliver_fresh_smtp(sender, message, ADMIN_EMAIL)
    except Exception as exc:
        raw = str(exc)
        hidden = sender.get("password") or ""
        if hidden and hidden in raw:
            raw = raw.replace(hidden, "[redacted]")
        log(f"Admin request notice failed: {type(exc).__name__}: {raw[:240]}")
        return False
    log(f"Approval email sent to {ADMIN_EMAIL} for {user_email} -> {mailbox}")
    return True


def ensure_user(conn, email):
    email = normalize_email(email)
    role = role_for(email)
    row = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    now = time.time()
    if row is None:
        conn.execute(
            "INSERT INTO users (email, role, enabled, limits_json, created_at, last_login) VALUES (?, ?, 1, NULL, ?, NULL)",
            (email, role, now),
        )
        add_audit(conn, email, "account_registered", role)
        row = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    elif row["role"] != role:
        conn.execute("UPDATE users SET role=? WHERE email=?", (role, email))
        row = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    return row


def grant_status(conn, email, sender_id, role):
    if role == "ROLE_MASTER":
        return "approved"
    row = conn.execute(
        "SELECT status FROM grants WHERE email=? AND sender_id=?",
        (email, sender_id),
    ).fetchone()
    return row["status"] if row else "none"


def sender_allowed(conn, email, role, sender_id):
    return grant_status(conn, email, sender_id, role) == "approved"


def safe_filename(name):
    base = os.path.basename(str(name or "file"))
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._")[:80]
    return cleaned or "file"


def decode_base64(value):
    text = str(value or "")
    if "," in text and text.strip().lower().startswith("data:"):
        text = text.split(",", 1)[1]
    text = re.sub(r"\s+", "", text)
    if not text:
        return b""
    text += "=" * (-len(text) % 4)
    try:
        return base64.b64decode(text)
    except Exception as exc:
        raise ApiError("An attachment could not be read.") from exc


def parse_when(value):
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if re.fullmatch(r"\d+(\.\d+)?", text):
        return float(text)
    try:
        parsed = datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ApiError("Schedule time is not valid.") from exc
    return parsed.timestamp()


def campaign_for(conn, user, campaign_id):
    row = conn.execute("SELECT * FROM campaigns WHERE id=?", (campaign_id,)).fetchone()
    if not row:
        raise ApiError("Campaign not found.", 404)
    if user["role"] != "ROLE_MASTER" and row["owner"] != user["email"]:
        raise ApiError("You cannot open this campaign.", 403)
    return row


def has_any_grant(conn, email, role):
    if role == "ROLE_MASTER":
        return True
    row = conn.execute(
        "SELECT 1 FROM grants WHERE email=? AND status='approved' LIMIT 1",
        (email,),
    ).fetchone()
    return row is not None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        try:
            request = args[0] if args else ""
            if "/api/health" in str(request):
                return
            log(fmt % args)
        except Exception:
            pass

    def end_headers(self):
        self.close_connection = True
        self.send_header("Connection", "close")
        super().end_headers()

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Filename")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")

    def send_json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, code, body, content_type, filename=None):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if not filename:
            self.send_header("Cache-Control", "no-cache")
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def read_body(self, limit):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError as exc:
            raise ApiError("Invalid content length.") from exc
        if length < 0 or length > limit:
            raise ApiError("Upload is too large.", 413)
        return self.rfile.read(length) if length else b""

    def read_json(self):
        raw = self.read_body(40_000_000)
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError("Invalid JSON.") from exc
        if not isinstance(data, dict):
            raise ApiError("JSON object expected.")
        return data

    def current_user(self):
        header = self.headers.get("Authorization") or ""
        token = header[7:].strip() if header.startswith("Bearer ") else ""
        payload = read_token(token)
        if not payload:
            return None
        email = normalize_email(payload.get("sub"))
        with db() as conn:
            row = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
            if not row:
                return None
            role = role_for(email)
            if row["role"] != role:
                conn.execute("UPDATE users SET role=? WHERE email=?", (role, email))
        account = public_account(email, row)
        return {
            "email": email,
            "role": role,
            "display_name": account["display_name"],
            "password_set": account["password_set"],
            "enabled": account_enabled(row),
            "limits": stored_limits(row),
            "created_at": row["created_at"],
            "last_login": row["last_login"],
        }

    def require_user(self):
        user = self.current_user()
        if not user:
            raise ApiError("Sign in required.", 401)
        if not user["enabled"]:
            raise ApiError("This account is disabled.", 403)
        return user

    def require_master(self):
        user = self.require_user()
        if user["role"] != "ROLE_MASTER":
            raise ApiError("Admin access required.", 403)
        return user

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self._guard(self.handle_get)

    def do_POST(self):
        self._guard(self.handle_post)

    def _guard(self, method):
        try:
            method()
        except ApiError as exc:
            self.send_json(exc.code, {"ok": False, "error": exc.message})
        except Exception:
            try:
                log(traceback.format_exc())
            except Exception:
                pass
            try:
                self.send_json(500, {"ok": False, "error": "Unexpected relay error."})
            except Exception:
                pass

    def handle_get(self):
        path, query = split_path(self.path)
        if path == "/api/ui":
            self.send_json(200, {"ok": True, "ui": load_desk_ui()})
            return
        if path == "/api/health":
            with db() as conn:
                active = conn.execute(
                    "SELECT COUNT(*) AS n FROM campaigns WHERE status IN ('running','scheduled','paused')"
                ).fetchone()["n"]
            mailbox = read_mailbox_status()
            self.send_json(200, {
                "ok": True,
                "service": "parth-mailing",
                "version": "1.0.0",
                "domain": domain_suffix(),
                "dispatch_mode": dispatch_mode(),
                "otp_delivery": "email" if otp_is_live() else "off",
                "otp_ready": otp_is_live(),
                "otp_from": OTP_FROM,
                "otp_error": "" if mailbox.get("ok") is not False else mailbox.get("message") or "",
                "admin_email": ADMIN_EMAIL,
                "google_client_id": google_client_id(),
                "drive": drive_status(),
                "active_campaigns": active,
            })
            return
        if path == "/api/config/ga4":
            self.require_user()
            self.send_json(200, {"ok": True, "tracking": email_tracking_settings()})
            return
        if path == "/api/master/senders":
            self.require_master()
            self.send_json(200, {"ok": True, "senders": [master_sender_view(item) for item in configured_senders()], "sheet_url": str(load_config().get("mailbox_sheet_url") or "")})
            return
        if path == "/api/me":
            user = self.require_user()
            with db() as conn:
                approved = []
                for sender in configured_senders():
                    status = grant_status(conn, user["email"], sender["id"], user["role"])
                    if status == "approved":
                        approved.append(public_sender(sender, status))
            self.send_json(200, {"ok": True, "user": user, "approved_senders": approved})
            return
        if path == "/api/senders":
            user = self.require_user()
            with db() as conn:
                catalog = []
                for sender in configured_senders():
                    status = grant_status(conn, user["email"], sender["id"], user["role"])
                    if user["role"] != "ROLE_MASTER" and status not in ("approved", "pending"):
                        continue
                    catalog.append(public_sender(sender, status))
            self.send_json(200, {"ok": True, "senders": catalog})
            return
        if path == "/api/drafts":
            user = self.require_user()
            with db() as conn:
                if not has_any_grant(conn, user["email"], user["role"]):
                    raise ApiError("An approved sender identity is required before drafts can be saved.", 403)
                rows = conn.execute(
                    "SELECT id, payload_json, updated_at FROM drafts WHERE owner=? ORDER BY updated_at DESC",
                    (user["email"],),
                ).fetchall()
            drafts = []
            for row in rows:
                try:
                    payload = json.loads(row["payload_json"] or "{}")
                except json.JSONDecodeError:
                    payload = {}
                drafts.append({"id": row["id"], "payload": payload, "updated_at": row["updated_at"]})
            self.send_json(200, {"ok": True, "drafts": drafts})
            return
        if path == "/api/ledger":
            user = self.require_user()
            self.send_json(200, {"ok": True, "ledger": ledger_snapshot(user)})
            return
        if path == "/api/campaigns":
            user = self.require_user()
            scope = query.get("scope") or "mine"
            with db() as conn:
                if user["role"] == "ROLE_MASTER" and scope == "all":
                    rows = conn.execute("SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 300").fetchall()
                else:
                    rows = conn.execute(
                        "SELECT * FROM campaigns WHERE owner=? ORDER BY created_at DESC LIMIT 300",
                        (user["email"],),
                    ).fetchall()
                payloads = campaign_payloads(conn, rows)
            self.send_json(200, {"ok": True, "campaigns": payloads})
            return
        detail = re.fullmatch(r"/api/campaigns/([a-f0-9]+)", path)
        if detail:
            user = self.require_user()
            with db() as conn:
                camp = campaign_for(conn, user, detail.group(1))
                errors = conn.execute(
                    """
                    SELECT email, status, error, smtp_code, sent_at FROM recipients
                    WHERE campaign_id=? AND status IN ('FAILED','BOUNCED')
                    ORDER BY id DESC LIMIT 12
                    """,
                    (camp["id"],),
                ).fetchall()
            payload = public_campaign(camp)
            payload["html"] = camp["html"]
            payload["cc"] = camp["cc"]
            payload["bcc"] = camp["bcc"]
            payload["errors"] = [dict(row) for row in errors]
            payload["last_error"] = errors[0]["error"] if errors else ""
            self.send_json(200, {"ok": True, "campaign": payload})
            return
        report = re.fullmatch(r"/api/campaigns/([a-f0-9]+)/report", path)
        if report:
            user = self.require_user()
            with db() as conn:
                campaign_for(conn, user, report.group(1))
                rows = report_rows(conn, report.group(1))
            payload = xlsx_writer.workbook_bytes(REPORT_HEADERS, rows)
            self.send_bytes(
                200,
                payload,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "campaign_report.xlsx",
            )
            return
        if path == "/api/master/users":
            self.require_master()
            with db() as conn:
                users = []
                for row in conn.execute("SELECT * FROM users ORDER BY created_at DESC"):
                    sent_today = conn.execute(
                        """
                        SELECT COUNT(*) AS n FROM recipients r
                        JOIN campaigns c ON c.id = r.campaign_id
                        WHERE c.owner=? AND r.status='SENT' AND r.sent_at>=?
                        """,
                        (row["email"], time.time() - 86400),
                    ).fetchone()["n"]
                    sent_total = conn.execute(
                        """
                        SELECT COUNT(*) AS n FROM recipients r
                        JOIN campaigns c ON c.id = r.campaign_id
                        WHERE c.owner=? AND r.status='SENT'
                        """,
                        (row["email"],),
                    ).fetchone()["n"]
                    granted = [
                        item["sender_id"]
                        for item in conn.execute(
                            "SELECT sender_id FROM grants WHERE email=? AND status='approved'",
                            (row["email"],),
                        )
                    ]
                    users.append({
                        "email": row["email"],
                        "role": role_for(row["email"]),
                        "display_name": str(row["display_name"] or "").strip(),
                        "password_set": user_password_ready(row),
                        "enabled": account_enabled(row),
                        "created_at": row["created_at"],
                        "last_login": row["last_login"],
                        "limits": stored_limits(row),
                        "sent_today": sent_today,
                        "sent_total": sent_total,
                        "sender_ids": granted,
                    })
            self.send_json(200, {"ok": True, "users": users})
            return
        if path == "/api/master/approvals":
            self.require_master()
            with db() as conn:
                rows = conn.execute(
                    "SELECT * FROM grants ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, requested_at DESC LIMIT 400"
                ).fetchall()
            approvals = []
            for row in rows:
                approvals.append({
                    "id": row["id"],
                    "email": row["email"],
                    "sender_id": row["sender_id"],
                    "sender_email": requested_mailbox_label(row["sender_id"]),
                    "daily_cap": grant_daily_cap(row),
                    "status": row["status"],
                    "requested_at": row["requested_at"],
                    "decided_at": row["decided_at"],
                })
            self.send_json(200, {"ok": True, "approvals": approvals})
            return
        if path == "/api/master/audit":
            self.require_master()
            with db() as conn:
                rows = conn.execute("SELECT * FROM audit ORDER BY id DESC LIMIT 200").fetchall()
            self.send_json(200, {"ok": True, "audit": [dict(row) for row in rows]})
            return
        if path == "/api/master/monitor":
            self.require_master()
            with db() as conn:
                rows = conn.execute(
                    """
                    SELECT * FROM campaigns
                    WHERE status IN ('running','paused','scheduled')
                    ORDER BY created_at DESC LIMIT 100
                    """
                ).fetchall()
                payloads = campaign_payloads(conn, rows)
            mailboxes = []
            for sender in configured_senders():
                used = pace_used(sender["user"]) if live_delivery(sender) else 0
                cap = provider_cap(sender)
                mailboxes.append({
                    "email": sender["email"] or sender["user"],
                    "used_24h": used,
                    "cap_24h": cap,
                    "remaining": max(0, cap - used),
                    "live": live_delivery(sender),
                })
            self.send_json(200, {
                "ok": True,
                "campaigns": payloads,
                "mailboxes": mailboxes,
            })
            return
        if path.startswith("/api/"):
            raise ApiError("Endpoint not found.", 404)
        self.serve_static(path)

    def handle_post(self):
        path, _query = split_path(self.path)
        if path == "/api/auth/request-otp":
            self.request_otp(self.read_json())
            return
        if path == "/api/auth/register":
            self.register_account(self.read_json())
            return
        if path == "/api/auth/login":
            self.login_account(self.read_json())
            return
        if path == "/api/auth/forgot":
            self.forgot_password(self.read_json())
            return
        if path == "/api/auth/admin":
            self.admin_sign_in(self.read_json())
            return
        if path == "/api/auth/verify-otp":
            self.verify_otp(self.read_json())
            return
        if path == "/api/auth/google":
            self.google_sign_in(self.read_json())
            return
        source = re.fullmatch(r"/api/campaigns/([a-f0-9]+)/source", path)
        if source:
            self.upload_source(self.require_user(), source.group(1))
            return
        data = self.read_json()
        if path == "/api/senders/request":
            self.request_sender(self.require_user(), data)
            return
        if path == "/api/sheets/fetch":
            self.fetch_sheet(self.require_user(), data)
            return
        if path == "/api/drafts":
            self.save_draft(self.require_user(), data)
            return
        if path == "/api/drafts/delete":
            self.delete_draft(self.require_user(), data)
            return
        if path == "/api/campaigns":
            self.create_campaign(self.require_user(), data)
            return
        recipients = re.fullmatch(r"/api/campaigns/([a-f0-9]+)/recipients", path)
        if recipients:
            self.add_recipients(self.require_user(), recipients.group(1), data)
            return
        start = re.fullmatch(r"/api/campaigns/([a-f0-9]+)/start", path)
        if start:
            self.start_campaign(self.require_user(), start.group(1))
            return
        control = re.fullmatch(r"/api/campaigns/([a-f0-9]+)/control", path)
        if control:
            self.control_campaign(self.require_user(), control.group(1), data)
            return
        if path == "/api/master/users/enabled":
            self.set_enabled(self.require_master(), data)
            return
        if path == "/api/master/users/remove":
            self.remove_user(self.require_master(), data)
            return
        if path == "/api/master/users/limits":
            self.set_limits(self.require_master(), data)
            return
        if path == "/api/master/approvals":
            self.decide_approval(self.require_master(), data)
            return
        if path == "/api/master/senders/sheet":
            self.import_mailbox_sheet(self.require_master(), data)
            return
        if path == "/api/master/senders/test":
            self.test_sender(self.require_master(), data)
            return
        if path == "/api/master/drive/test":
            self.test_drive(self.require_master())
            return
        if path == "/api/master/drive":
            self.save_drive(self.require_master(), data)
            return
        if path == "/api/master/ui":
            self.save_desk(self.require_master(), data)
            return
        if path == "/api/master/google":
            self.save_google(self.require_master(), data)
            return
        if path == "/api/master/otp-password":
            self.save_otp_password(self.require_master(), data)
            return
        if path == "/api/master/senders/assign":
            self.assign_sender(self.require_master(), data)
            return
        if path == "/api/master/senders":
            self.save_senders(self.require_master(), data)
            return
        if path == "/api/config/ga4":
            self.save_ga4(self.require_master(), data)
            return
        raise ApiError("Endpoint not found.", 404)

    def admin_sign_in(self, data):
        email = normalize_email(data.get("email"))
        if not is_admin_email(email):
            raise ApiError("Only the admin address can sign in without a code.", 403)
        now = time.time()
        with db() as conn:
            row = ensure_user(conn, email)
            if user_password_ready(row) and not account_enabled(row):
                raise ApiError("This account is disabled.", 403)
            conn.execute(
                "UPDATE users SET last_login=?, role=?, enabled=1 WHERE email=?",
                (now, role_for(email), email),
            )
            add_audit(conn, email, "signed_in_admin", "")
        with db() as conn:
            row = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        self.send_json(200, {
            "ok": True,
            "token": issue_token(email),
            "user": public_account(email, row),
        })

    def register_account(self, data):
        email = normalize_email(data.get("email"))
        name = require_display_name(data.get("display_name") or data.get("name"))
        salt, digest = hash_password(data.get("password"))
        if not allowed_email(email):
            raise ApiError(f"Use a work address ending with {domain_suffix()}.")
        with db() as conn:
            row = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
            if row and user_password_ready(row):
                raise ApiError("This account already has a password. Sign in, or use Forgot password.")
            row = ensure_user(conn, email)
            if user_password_ready(row) and not account_enabled(row):
                raise ApiError("This account is disabled.", 403)
            conn.execute(
                """
                UPDATE users
                SET display_name=?, password_hash=?, password_salt=?, password_set=0, role=?, enabled=1
                WHERE email=?
                """,
                (name, digest, salt, role_for(email), email),
            )
        ttl = issue_otp(email, "register")
        self.send_json(200, {
            "ok": True,
            "needs_otp": True,
            "purpose": "register",
            "expires_in": ttl,
            "delivery": "email",
        })

    def login_account(self, data):
        email = normalize_email(data.get("email"))
        password = str(data.get("password") or "")
        name = str(data.get("display_name") or data.get("name") or "").strip()
        if not allowed_email(email):
            raise ApiError(f"Use a work address ending with {domain_suffix()}.")
        with db() as conn:
            row = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
            if row and password_saved(row) and not account_enabled(row):
                raise ApiError("This account is disabled.", 403)
            if row and password_saved(row):
                if not verify_password(password, row["password_salt"], row["password_hash"]):
                    raise ApiError("Email or password is incorrect.")
                conn.execute(
                    "UPDATE users SET last_login=?, role=?, password_set=1, enabled=1 WHERE email=?",
                    (time.time(), role_for(email), email),
                )
                add_audit(conn, email, "signed_in", "password")
                fresh = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
                self.send_json(200, {
                    "ok": True,
                    "token": issue_token(email),
                    "user": public_account(email, fresh),
                })
                return
        if len(password) < 6:
            raise ApiError("First-time login needs your name, a password of at least 6 characters, then the emailed code.")
        if not name:
            raise ApiError("Enter your name, for example Parth Vekariya, then we will email a code.")
        salt, digest = hash_password(password)
        with db() as conn:
            ensure_user(conn, email)
            conn.execute(
                """
                UPDATE users
                SET display_name=?, password_hash=?, password_salt=?, password_set=0, role=?, enabled=1
                WHERE email=?
                """,
                (require_display_name(name), digest, salt, role_for(email), email),
            )
        ttl = issue_otp(email, "first")
        self.send_json(200, {
            "ok": True,
            "needs_otp": True,
            "purpose": "first",
            "expires_in": ttl,
            "delivery": "email",
        })

    def forgot_password(self, data):
        email = normalize_email(data.get("email"))
        ttl = issue_otp(email, "reset")
        self.send_json(200, {
            "ok": True,
            "needs_otp": True,
            "purpose": "reset",
            "expires_in": ttl,
            "delivery": "email",
        })

    def request_otp(self, data):
        email = normalize_email(data.get("email"))
        purpose = str(data.get("purpose") or "login").strip().lower() or "login"
        if purpose not in ("login", "register", "first", "reset"):
            purpose = "login"
        with db() as conn:
            row = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        if purpose in ("login", "first") and password_saved(row):
            purpose = "login"
        elif purpose == "login" and not password_saved(row):
            raise ApiError("Create an account with your name and a password. A 6-digit code will be emailed.")
        ttl = issue_otp(email, purpose)
        self.send_json(200, {"ok": True, "expires_in": ttl, "delivery": "email", "purpose": purpose})

    def verify_otp(self, data):
        email = normalize_email(data.get("email"))
        code = re.sub(r"\D", "", str(data.get("code") or ""))
        if not allowed_email(email) or len(code) != 6:
            raise ApiError("Enter the 6-digit code for a work address.")
        now = time.time()
        failure = None
        failure_code = 400
        account = None
        with db() as conn:
            row = conn.execute("SELECT * FROM otps WHERE email=?", (email,)).fetchone()
            user = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
            purpose = ""
            try:
                purpose = str((row["purpose"] if row else "") or "login")
            except (IndexError, KeyError):
                purpose = "login"
            if not user:
                failure, failure_code = "This account is disabled.", 403
            elif not account_enabled(user) and user_password_ready(user):
                failure, failure_code = "This account is disabled.", 403
            elif not row or row["expires_at"] < now:
                failure = "That code has expired. Request a new one."
            elif row["attempts"] >= 5:
                conn.execute("DELETE FROM otps WHERE email=?", (email,))
                failure = "Too many attempts. Request a new code."
            else:
                expected = hashlib.sha256(f"{row['salt']}:{code}".encode("utf-8")).hexdigest()
                if not hmac.compare_digest(expected, row["code_hash"]):
                    conn.execute("UPDATE otps SET attempts=attempts+1 WHERE email=?", (email,))
                    failure = "That code does not match."
                elif purpose == "reset":
                    salt, digest = hash_password(data.get("password"))
                    conn.execute("DELETE FROM otps WHERE email=?", (email,))
                    conn.execute(
                        """
                        UPDATE users
                        SET password_hash=?, password_salt=?, password_set=1, last_login=?, role=?, enabled=1
                        WHERE email=?
                        """,
                        (digest, salt, now, role_for(email), email)
                    )
                    add_audit(conn, email, "password_reset", "")
                    account = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
                elif purpose in ("register", "first"):
                    if not user["password_hash"]:
                        failure = "Set your name and password, then request a new code."
                    else:
                        conn.execute("DELETE FROM otps WHERE email=?", (email,))
                        conn.execute(
                            """
                            UPDATE users
                            SET password_set=1, last_login=?, role=?, enabled=1
                            WHERE email=?
                            """,
                            (now, role_for(email), email)
                        )
                        add_audit(conn, email, "signed_in", purpose)
                        account = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
                else:
                    conn.execute("DELETE FROM otps WHERE email=?", (email,))
                    conn.execute(
                        "UPDATE users SET last_login=?, role=? WHERE email=?",
                        (now, role_for(email), email),
                    )
                    add_audit(conn, email, "signed_in", "otp")
                    account = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        if failure:
            raise ApiError(failure, failure_code)
        self.send_json(200, {
            "ok": True,
            "token": issue_token(email),
            "user": public_account(email, account),
        })

    def google_sign_in(self, data):
        email = verify_google_credential(data.get("credential"))
        now = time.time()
        with db() as conn:
            row = ensure_user(conn, email)
            if user_password_ready(row) and not account_enabled(row):
                raise ApiError("This account is disabled.", 403)
            conn.execute(
                "UPDATE users SET last_login=?, role=?, enabled=1 WHERE email=?",
                (now, role_for(email), email),
            )
            add_audit(conn, email, "signed_in_google", role_for(email))
            row = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        self.send_json(200, {
            "ok": True,
            "token": issue_token(email),
            "user": public_account(email, row),
        })

    def save_google(self, master, data):
        client_id = str(data.get("client_id") or "").strip()
        if client_id and not re.fullmatch(r"[0-9A-Za-z._-]{10,180}\.apps\.googleusercontent\.com", client_id):
            raise ApiError("Paste the client ID that ends with .apps.googleusercontent.com.")
        save_google_client_id(client_id)
        with db() as conn:
            add_audit(conn, master["email"], "google_sign_in_updated", "on" if client_id else "off")
        self.send_json(200, {"ok": True, "google_client_id": client_id})

    def save_otp_password(self, admin, data):
        compact = re.sub(r"[^A-Za-z0-9]", "", str(data.get("password") or ""))
        current = otp_sender() or {}
        if not compact:
            if current.get("password"):
                self.send_json(200, {
                    "ok": True,
                    "otp_ready": True,
                    "message": f"The app password for {OTP_FROM} is already saved.",
                })
                return
            raise ApiError(f"Paste the 16-character Google app password for {OTP_FROM}. Spaces and dashes are removed automatically.")
        if len(compact) != 16:
            raise ApiError(
                f"That password is {len(compact)} characters after removing spaces. A Google app password is 16."
            )
        sender = {
            "id": current.get("id") or "parth-otp",
            "email": OTP_FROM,
            "user": OTP_FROM,
            "display_name": current.get("display_name") or "Parth Mailing",
            "host": current.get("host") or "smtp.gmail.com",
            "port": current.get("port") or 587,
            "secure": current.get("secure") or "tls",
            "password": compact,
        }
        try:
            smtp = connect_smtp(prepare_sender(sender))
            safe_quit(smtp)
        except Exception as exc:
            raise ApiError(friendly_smtp_error(exc))
        config = load_config()
        upsert_otp_sender(config, sender)
        write_config(config)
        message = f"Sign-in codes send from {OTP_FROM}."
        write_mailbox_status(True, message)
        with db() as conn:
            add_audit(conn, admin["email"], "otp_mailbox_saved", OTP_FROM)
        self.send_json(200, {"ok": True, "otp_ready": True, "message": message})

    def fetch_sheet(self, user, data):
        matrix, title = download_sheet_matrix(data.get("url") or data.get("link") or "")
        headers = [str(cell or "").strip().lower() for cell in (matrix[0] if matrix else [])]
        if "password" in headers and ("host" in headers or "smtp host" in headers):
            raise ApiError("That sheet contains mailbox passwords. Open Admin and use Fetch mailing accounts.")
        rows, columns, invalid = rows_from_sheet(matrix)
        with db() as conn:
            allowed = set()
            for sender in approved_senders_for(conn, user):
                allowed.add(normalize_email(sender.get("email")))
                allowed.add(normalize_email(sender.get("user")))
        kept = []
        blocked = []
        for row in rows:
            mailbox = row_mailbox(row, row.get("fields"))
            if user["role"] != "ROLE_MASTER" and mailbox and mailbox not in allowed:
                blocked.append(mailbox)
                continue
            kept.append(row)
        self.send_json(200, {
            "ok": True,
            "title": title,
            "rows": kept,
            "columns": columns,
            "invalid": invalid,
            "blocked": len(blocked),
            "blocked_mailboxes": sorted(set(blocked))[:8],
        })

    def request_sender(self, user, data):
        sender = sender_by_id(str(data.get("sender_id") or ""))
        wanted = normalize_email(data.get("email") or data.get("sender_email") or "")
        if not sender and wanted:
            sender = sender_by_address(wanted)
        if user["role"] == "ROLE_MASTER" and sender:
            self.send_json(200, {"ok": True, "status": "approved"})
            return
        grant_key = sender["id"] if sender else (f"ask:{wanted}" if wanted else "")
        mailbox = (sender.get("email") if sender else wanted) or grant_key
        if not grant_key:
            raise ApiError("Choose or type the sending email you want to use.")
        now = time.time()
        display = ""
        with db() as conn:
            existing = conn.execute(
                "SELECT * FROM grants WHERE email=? AND sender_id=?",
                (user["email"], grant_key),
            ).fetchone()
            if existing and existing["status"] == "approved":
                raise ApiError("You already have this sending mailbox.")
            if existing and existing["status"] == "pending":
                raise ApiError("This request is already waiting for the admin.")
            conn.execute(
                """
                INSERT INTO grants (email, sender_id, status, limits_json, requested_at, decided_at)
                VALUES (?, ?, 'pending', NULL, ?, NULL)
                ON CONFLICT(email, sender_id) DO UPDATE SET
                    status='pending', requested_at=excluded.requested_at, decided_at=NULL
                """,
                (user["email"], grant_key, now),
            )
            row = conn.execute("SELECT display_name FROM users WHERE email=?", (user["email"],)).fetchone()
            display = str((row["display_name"] if row else "") or "")
            add_audit(conn, user["email"], "sender_requested", mailbox)
        emailed = notify_admin_mailbox_request(user["email"], display, mailbox)
        self.send_json(200, {"ok": True, "status": "pending", "mailbox": mailbox, "emailed": emailed})

    def save_draft(self, user, data):
        payload = data.get("payload")
        if not isinstance(payload, dict):
            raise ApiError("Draft payload is missing.")
        encoded = json.dumps(payload)
        if len(encoded) > 2_000_000:
            raise ApiError("Draft is too large.")
        draft_id = str(data.get("id") or "") or new_id()
        if not re.fullmatch(r"[a-f0-9]{8,32}", draft_id):
            draft_id = new_id()
        with db() as conn:
            if not has_any_grant(conn, user["email"], user["role"]):
                raise ApiError("An approved sender identity is required before drafts can be saved.", 403)
            own = conn.execute("SELECT owner FROM drafts WHERE id=?", (draft_id,)).fetchone()
            if own and own["owner"] != user["email"]:
                raise ApiError("You cannot overwrite that draft.", 403)
            conn.execute(
                """
                INSERT INTO drafts (id, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json, updated_at=excluded.updated_at
                """,
                (draft_id, user["email"], encoded, time.time()),
            )
        self.send_json(200, {"ok": True, "id": draft_id})

    def delete_draft(self, user, data):
        draft_id = str(data.get("id") or "")
        with db() as conn:
            conn.execute("DELETE FROM drafts WHERE id=? AND owner=?", (draft_id, user["email"]))
        self.send_json(200, {"ok": True})

    def create_campaign(self, user, data):
        action = "draft" if str(data.get("action") or "send").strip().lower() == "draft" else "send"
        selected = sender_by_id(str(data.get("sender_id") or ""))
        with db() as conn:
            approved = approved_senders_for(conn, user)
        approved_ids = {item["id"]: item for item in approved}
        pool = []
        requested = data.get("sender_ids")
        if action == "draft":
            if not selected or selected["id"] not in approved_ids:
                raise ApiError("Choose an assigned sending mailbox for SMTP Draft.")
            pool = [selected]
        else:
            if isinstance(requested, list) and requested:
                pool = [approved_ids[item] for item in requested if item in approved_ids]
            if not pool:
                pool = list(approved)
            if selected and selected["id"] in approved_ids and selected["id"] not in {item["id"] for item in pool}:
                pool.insert(0, selected)
        if not pool:
            raise ApiError("The admin has not assigned a sending mailbox to this account yet.")
        sender = selected if selected and selected["id"] in {item["id"] for item in pool} else pool[0]
        subject = clean_header(data.get("subject"))[:998]
        html_body = sanitize_html(data.get("html") or "")
        if not subject or not html_to_text(html_body):
            raise ApiError("Subject and message are required.")
        pace = normalize_pace(data.get("pace") or {})
        if any(is_consumer_gmail(item) for item in pool):
            pace["delay_min_seconds"] = max(pace["delay_min_seconds"], GMAIL_CONSUMER_GAP)
            pace["delay_max_seconds"] = max(pace["delay_max_seconds"], pace["delay_min_seconds"])
        schedule_at = parse_when(data.get("schedule_at"))
        timezone = str(data.get("timezone") or "UTC")
        try:
            ZoneInfo(timezone)
        except Exception:
            timezone = "UTC"
        cc = str(data.get("cc") or "")[:4000]
        bcc = str(data.get("bcc") or "")[:4000]
        attachments = data.get("attachments") or []
        if not isinstance(attachments, list):
            raise ApiError("Attachments must be a list.")
        campaign_id = new_id()
        stored = []
        total_bytes = 0
        for item in attachments:
            if not isinstance(item, dict):
                continue
            raw = decode_base64(item.get("data_base64") or "")
            if not raw:
                continue
            if len(raw) > 8_000_000:
                raise ApiError("Each attachment must be 8 MB or smaller.")
            total_bytes += len(raw)
            if total_bytes > 20_000_000:
                raise ApiError("Attachments exceed 20 MB.")
            filename = safe_filename(item.get("filename") or "file")
            mime = str(item.get("mime") or "application/octet-stream").split(";", 1)[0].strip()[:100]
            if not re.fullmatch(r"[\w.+-]+/[\w.+-]+", mime):
                mime = "application/octet-stream"
            path = os.path.join(ATTACH_DIR, f"{new_id()}_{filename}")
            with open(path, "wb") as handle:
                handle.write(raw)
            stored.append((filename, mime, path))
        with db() as conn:
            if not sender_allowed(conn, user["email"], user["role"], sender["id"]):
                raise ApiError("That sender identity is not approved for your account.", 403)
            conn.execute(
                """
                INSERT INTO campaigns (
                    id, owner, sender_id, subject, html, cc, bcc, status, schedule_at, timezone,
                    pace_json, hold_reason, created_at, total_count, dispatch_action, sender_ids_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, '', ?, 0, ?, ?)
                """,
                (
                    campaign_id, user["email"], sender["id"], subject, html_body, cc, bcc,
                    schedule_at, timezone, json.dumps(pace), time.time(), action,
                    json.dumps([item["id"] for item in pool]),
                ),
            )
            for filename, mime, path in stored:
                conn.execute(
                    "INSERT INTO files (campaign_id, filename, mime, path) VALUES (?, ?, ?, ?)",
                    (campaign_id, filename, mime, path),
                )
            add_audit(conn, user["email"], "campaign_created", campaign_id)
            row = conn.execute("SELECT * FROM campaigns WHERE id=?", (campaign_id,)).fetchone()
        self.send_json(200, {"ok": True, "campaign": public_campaign(row)})

    def add_recipients(self, user, campaign_id, data):
        rows = data.get("rows") or []
        if not isinstance(rows, list):
            raise ApiError("Rows must be a list.")
        if len(rows) > 5000:
            raise ApiError("Send at most 5000 rows in one request.")
        replace = bool(data.get("replace"))
        with db() as conn:
            camp = campaign_for(conn, user, campaign_id)
            if camp["status"] != "ready":
                raise ApiError("Recipients can only be added before the campaign starts.")
            try:
                pool_ids = json.loads(camp["sender_ids_json"] or "[]")
            except (KeyError, TypeError, json.JSONDecodeError):
                pool_ids = []
            if not isinstance(pool_ids, list) or not pool_ids:
                pool_ids = [camp["sender_id"]] if camp["sender_id"] else []
            pool = [sender_by_id(item) for item in pool_ids]
            pool = [item for item in pool if item]
            if not pool and camp["sender_id"]:
                found = sender_by_id(camp["sender_id"])
                if found:
                    pool = [found]
            cursor = 0
            draft_job = campaign_action(camp) == "draft"
            if replace:
                conn.execute("DELETE FROM recipients WHERE campaign_id=?", (campaign_id,))
            seen = {
                row["email"]
                for row in conn.execute("SELECT email FROM recipients WHERE campaign_id=?", (campaign_id,))
            }
            existing_count = len(seen)
            prepared = []
            invalid = 0
            duplicates = 0
            already_sent = 0
            block_repeats = repeats_blocked(conn)
            for item in rows:
                if not isinstance(item, dict):
                    invalid += 1
                    continue
                email = normalize_email(item.get("email"))
                if not EMAIL_RE.match(email):
                    invalid += 1
                    continue
                if email in seen:
                    duplicates += 1
                    continue
                if existing_count + len(prepared) >= 200000:
                    raise ApiError("This campaign exceeds 200,000 recipients.")
                seen.add(email)
                fields = item.get("fields") if isinstance(item.get("fields"), dict) else {}
                trimmed = {}
                extra = {
                    "Template": item.get("template") or fields.get("Template") or fields.get("template"),
                    "Sender": item.get("sender") or fields.get("Sender") or fields.get("sender"),
                    "Sender Name": item.get("sender_name") or fields.get("Sender Name") or fields.get("sender_name"),
                    "Name": item.get("first_name") or fields.get("Name") or fields.get("name"),
                }
                merged = dict(fields)
                for key, value in extra.items():
                    if value:
                        merged[key] = value
                for key, value in list(merged.items())[:120]:
                    trimmed[str(key)[:80]] = str(value if value is not None else "")[:5000]
                for key, value in extra.items():
                    if value and key not in trimmed:
                        trimmed[str(key)[:80]] = str(value)[:5000]
                status = "QUEUED"
                error = ""
                code = ""
                if (not draft_job) and block_repeats and conn.execute("SELECT 1 FROM sent_people WHERE email=?", (email,)).fetchone():
                    status = "SKIPPED"
                    error = "Already emailed this person. A second message was not sent."
                    code = "DUP"
                    already_sent += 1
                matched = match_row_sender(pool, item, trimmed) if pool else None
                mailbox = row_mailbox(item, trimmed)
                if mailbox and not matched and status == "QUEUED":
                    status = "SKIPPED"
                    error = f"This account cannot use {mailbox}."
                    code = "ACCESS"
                    assigned = ""
                elif matched:
                    assigned = matched["id"]
                elif pool:
                    assigned = pool[cursor % len(pool)]["id"]
                    cursor += 1
                else:
                    assigned = camp["sender_id"] or ""
                ready_at = None
                if camp["schedule_at"]:
                    ready = row_ready_unix(trimmed, camp["timezone"] or "UTC", camp["schedule_at"])
                    if ready == "invalid" and status == "QUEUED":
                        status = "SKIPPED"
                        error = "S_Date or S_Time could not be read."
                        code = "TIME"
                    elif isinstance(ready, (int, float)):
                        ready_at = ready
                prepared.append((
                    campaign_id,
                    email,
                    str(item.get("first_name") or "")[:200],
                    str(item.get("last_name") or "")[:200],
                    str(item.get("company") or "")[:200],
                    str(item.get("custom1") or "")[:500],
                    json.dumps(trimmed),
                    status,
                    error,
                    code,
                    assigned,
                    ready_at,
                ))
            conn.executemany(
                """
                INSERT INTO recipients (
                    campaign_id, email, first_name, last_name, company, custom1, fields_json, status, error, smtp_code, sender_id, ready_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                prepared,
            )
            _counts, total = recompute_counts(conn, campaign_id)
        self.send_json(200, {
            "ok": True,
            "added": len(prepared),
            "invalid": invalid,
            "duplicates": duplicates,
            "already_sent": already_sent,
            "total": total,
        })

    def upload_source(self, user, campaign_id):
        filename = safe_filename(urllib.parse.unquote(self.headers.get("X-Filename") or "upload.bin"))
        raw = self.read_body(25_000_000)
        if not raw:
            raise ApiError("The uploaded file is empty.")
        path = os.path.join(UPLOAD_DIR, f"{campaign_id}_{new_id()}_{filename}")
        with open(path, "wb") as handle:
            handle.write(raw)
        with db() as conn:
            camp = campaign_for(conn, user, campaign_id)
            names = [part for part in (camp["source_name"] or "").split(", ") if part]
            names.append(filename)
            conn.execute(
                "UPDATE campaigns SET source_name=?, source_path=? WHERE id=?",
                (", ".join(names)[:500], path, campaign_id),
            )
            add_audit(conn, user["email"], "source_uploaded", filename)
        day = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
        queue_drive_upload(path, ["Uploads", day], campaign_id, "drive_upload_url")
        self.send_json(200, {"ok": True, "drive": "queued" if drive_status()["ready"] else "local"})

    def start_campaign(self, user, campaign_id):
        with db() as conn:
            camp = campaign_for(conn, user, campaign_id)
            if camp["status"] != "ready":
                raise ApiError("This campaign has already started.")
            try:
                pool_ids = json.loads(camp["sender_ids_json"] or "[]")
            except (KeyError, TypeError, json.JSONDecodeError):
                pool_ids = [camp["sender_id"]]
            if not isinstance(pool_ids, list) or not pool_ids:
                pool_ids = [camp["sender_id"]]
            for sender_id in pool_ids:
                if sender_id and not sender_allowed(conn, user["email"], user["role"], sender_id):
                    raise ApiError("That sender identity is not approved.", 403)
            user_row = conn.execute("SELECT * FROM users WHERE email=?", (user["email"],)).fetchone()
            limits = effective_limits(conn, user_row, camp["sender_id"])
            queued = conn.execute(
                "SELECT COUNT(*) AS n FROM recipients WHERE campaign_id=? AND status='QUEUED'",
                (campaign_id,),
            ).fetchone()["n"]
            skipped = conn.execute(
                "SELECT COUNT(*) AS n FROM recipients WHERE campaign_id=? AND status='SKIPPED'",
                (campaign_id,),
            ).fetchone()["n"]
            if queued <= 0:
                if skipped:
                    raise ApiError("Everyone on this list was already emailed. No second message was queued.")
                raise ApiError("Add at least one recipient.")
            if queued > limits["max_batch"]:
                raise ApiError(f"This account can send at most {limits['max_batch']} new recipients in one campaign.")
            draft_sender = sender_by_id(camp["sender_id"]) if campaign_action(camp) == "draft" else None
            schedule_at = camp["schedule_at"]
        if draft_sender is not None:
            if not draft_sender.get("password"):
                raise ApiError("Save the 16-character Google app password for this mailbox before drafting.")
            try:
                probe = open_imap(draft_sender)
                try:
                    probe.logout()
                except Exception:
                    pass
            except Exception as exc:
                raise ApiError(friendly_imap_error(exc))
        with db() as conn:
            fresh = conn.execute("SELECT status FROM campaigns WHERE id=?", (campaign_id,)).fetchone()
            if not fresh or fresh["status"] != "ready":
                raise ApiError("This campaign has already started.")
            now = time.time()
            scheduled = schedule_at and schedule_at > now + 1
            status = "scheduled" if scheduled else "running"
            started = None if scheduled else now
            conn.execute(
                "UPDATE campaigns SET status=?, started_at=?, hold_reason='' WHERE id=? AND status='ready'",
                (status, started, campaign_id),
            )
            add_audit(conn, user["email"], "campaign_queued", f"{campaign_id} {status}")
        SLEEP_UNTIL.pop(campaign_id, None)
        BATCH_COUNT.pop(campaign_id, None)
        self._ensure_csv_backup(campaign_id)
        self.send_json(200, {"ok": True, "status": status})

    def _ensure_csv_backup(self, campaign_id):
        with db() as conn:
            camp = conn.execute("SELECT source_path FROM campaigns WHERE id=?", (campaign_id,)).fetchone()
            if camp and camp["source_path"]:
                return
            rows = conn.execute(
                "SELECT email, first_name, last_name, company, custom1 FROM recipients WHERE campaign_id=? ORDER BY id",
                (campaign_id,),
            ).fetchall()
        path = os.path.join(UPLOAD_DIR, f"{campaign_id}_recipients.csv")
        lines = ["Email,FirstName,LastName,Company,Custom1"]
        for row in rows:
            lines.append(",".join('"' + str(row[key] or "").replace('"', '""') + '"' for key in row.keys()))
        with open(path, "w", encoding="utf-8", newline="") as handle:
            handle.write("\n".join(lines))
        with db() as conn:
            conn.execute("UPDATE campaigns SET source_path=? WHERE id=? AND source_path=''", (path, campaign_id))
        day = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
        queue_drive_upload(path, ["Uploads", day], campaign_id, "drive_upload_url")

    def control_campaign(self, user, campaign_id, data):
        action = str(data.get("action") or "").lower()
        if action not in ("pause", "resume", "kill"):
            raise ApiError("Action must be pause, resume, or kill.")
        with db() as conn:
            camp = campaign_for(conn, user, campaign_id)
            status = camp["status"]
            if action == "pause":
                if status not in ("running", "scheduled"):
                    raise ApiError("Only a running campaign can be paused.")
                conn.execute("UPDATE campaigns SET status='paused', hold_reason='Paused by operator' WHERE id=?", (campaign_id,))
            elif action == "resume":
                if status != "paused":
                    raise ApiError("Only a paused campaign can resume.")
                conn.execute("UPDATE campaigns SET status='running', hold_reason='' WHERE id=?", (campaign_id,))
                if not camp["started_at"]:
                    conn.execute("UPDATE campaigns SET started_at=? WHERE id=?", (time.time(), campaign_id))
            else:
                if status in ("complete", "killed"):
                    raise ApiError("This campaign is already finished.")
                conn.execute(
                    "UPDATE campaigns SET status='killed', finished_at=?, hold_reason='Stopped by operator' WHERE id=?",
                    (time.time(), campaign_id),
                )
                conn.execute(
                    "UPDATE recipients SET status='CANCELLED' WHERE campaign_id=? AND status IN ('QUEUED','SENDING')",
                    (campaign_id,),
                )
                recompute_counts(conn, campaign_id)
            add_audit(conn, user["email"], f"campaign_{action}", campaign_id)
        if action == "resume":
            SLEEP_UNTIL.pop(campaign_id, None)
        if action == "kill":
            SLEEP_UNTIL.pop(campaign_id, None)
            write_report(campaign_id)
        self.send_json(200, {"ok": True, "action": action})

    def remove_user(self, master, data):
        email = normalize_email(data.get("email"))
        if not email:
            raise ApiError("Account email is missing.")
        if email == normalize_email(master["email"]) or email in master_set():
            raise ApiError("The admin account cannot be removed.")
        now = time.time()
        with db() as conn:
            row = conn.execute("SELECT email FROM users WHERE email=?", (email,)).fetchone()
            if not row:
                raise ApiError("Account not found.", 404)
            conn.execute(
                """
                UPDATE campaigns
                SET status='killed', finished_at=?, hold_reason='Account removed'
                WHERE owner=? AND status NOT IN ('complete','killed')
                """,
                (now, email),
            )
            conn.execute("DELETE FROM grants WHERE email=?", (email,))
            conn.execute("DELETE FROM otps WHERE email=?", (email,))
            conn.execute("DELETE FROM drafts WHERE owner=?", (email,))
            conn.execute("DELETE FROM users WHERE email=?", (email,))
            add_audit(conn, master["email"], "user_removed", email)
        self.send_json(200, {"ok": True})

    def set_enabled(self, master, data):
        email = normalize_email(data.get("email"))
        enabled = 1 if data.get("enabled") else 0
        with db() as conn:
            row = conn.execute("SELECT email FROM users WHERE email=?", (email,)).fetchone()
            if not row:
                raise ApiError("Account not found.", 404)
            conn.execute("UPDATE users SET enabled=? WHERE email=?", (enabled, email))
            add_audit(conn, master["email"], "user_enabled" if enabled else "user_disabled", email)
        self.send_json(200, {"ok": True, "enabled": bool(enabled)})

    def set_limits(self, master, data):
        email = normalize_email(data.get("email"))
        limits = normalize_limits(data.get("limits") or {})
        with db() as conn:
            row = conn.execute("SELECT email FROM users WHERE email=?", (email,)).fetchone()
            if not row:
                raise ApiError("Account not found.", 404)
            conn.execute("UPDATE users SET limits_json=? WHERE email=?", (json.dumps(limits), email))
            add_audit(conn, master["email"], "limits_updated", email)
        self.send_json(200, {"ok": True, "limits": limits})

    def save_senders(self, master, data):
        incoming = data.get("senders")
        if not isinstance(incoming, list):
            raise ApiError("Senders must be a list.")
        if len(incoming) > 40:
            raise ApiError("Save at most 40 sending mailboxes.")
        existing = {item["id"]: item for item in configured_senders()}
        saved = []
        used = set()
        for item in incoming:
            if not isinstance(item, dict):
                continue
            email = normalize_email(item.get("email") or item.get("user"))
            if not EMAIL_RE.match(email):
                raise ApiError("Each sending mailbox needs a valid email address.")
            sender_id = make_sender_id(item.get("id"), email)
            if sender_id in used:
                sender_id = f"{sender_id}-{new_id()[:6]}"
            used.add(sender_id)
            password = sanitize_password(item.get("password") or "")
            if password and not re.fullmatch(r"[A-Za-z0-9]{16}", re.sub(r"[\s\-]+", "", password)):
                raise ApiError(f"Paste the 16-digit Google app password for {email}.")
            if not password and sender_id in existing:
                password = existing[sender_id].get("password") or ""
            if not password:
                raise ApiError(f"Paste the 16-digit Google app password for {email}.")
            display = str(item.get("display_name") or item.get("from_name") or "").strip()[:80]
            user = str(item.get("user") or email).strip()
            prepared = prepare_sender({
                "id": sender_id,
                "email": email,
                "user": user,
                "display_name": display,
                "host": item.get("host") or "smtp.gmail.com",
                "port": item.get("port") or 465,
                "secure": item.get("secure") or "ssl",
                "password": password,
                "daily_cap": item.get("daily_cap"),
            })
            if not prepared or not prepared["host"]:
                raise ApiError(f"SMTP host is missing for {email}.")
            saved.append({
                "id": prepared["id"],
                "email": prepared["email"],
                "display_name": prepared["display_name"],
                "host": prepared["host"],
                "port": prepared["port"],
                "secure": prepared["secure"],
                "user": prepared["user"],
                "password": prepared["password"],
                "daily_cap": mailbox_daily_cap(prepared),
            })
        config = load_config()
        config["senders"] = saved
        for item in saved:
            if normalize_email(item.get("email")) == ADMIN_EMAIL and len(item.get("password") or "") == 16:
                master = dict(config.get("master_smtp") or {})
                master.update({
                    "host": item.get("host") or "smtp.gmail.com",
                    "port": item.get("port") or 465,
                    "secure": item.get("secure") or "ssl",
                    "user": ADMIN_EMAIL,
                    "password": item["password"],
                    "from_name": item.get("display_name") or master.get("from_name") or "Parth Mailing",
                })
                config["master_smtp"] = master
        for item in saved:
            remember_otp_sender(config, item)
        write_config(config)
        with db() as conn:
            add_audit(conn, master["email"], "senders_updated", str(len(saved)))
        self.send_json(200, {"ok": True, "senders": [master_sender_view(prepare_sender(item)) for item in saved], "sheet_url": str(config.get("mailbox_sheet_url") or "")})

    def import_mailbox_sheet(self, master, data):
        url = str(data.get("url") or data.get("link") or load_config().get("mailbox_sheet_url") or "").strip()
        if not url:
            raise ApiError("Paste the Google Sheet link that has Label, Email, Password, Host, Port, and Secure.")
        result = apply_mailbox_sheet(url, data.get("email") or "")
        with db() as conn:
            add_audit(conn, master["email"], "mailbox_sheet_imported", f"{result['added']} added, {result['updated']} updated")
        self.send_json(200, {
            "ok": True,
            "title": result["title"],
            "added": result["added"],
            "updated": result["updated"],
            "changed": result["changed"],
            "skipped": result["skipped"],
            "sheet_url": result["sheet_url"],
            "senders": [master_sender_view(item) for item in configured_senders()],
        })

    def assign_sender(self, master, data):
        email = normalize_email(data.get("email"))
        sender = sender_by_id(str(data.get("sender_id") or ""))
        if not allowed_email(email):
            raise ApiError("That user email is not allowed.")
        if not sender:
            raise ApiError("Sender not found.")
        now = time.time()
        with db() as conn:
            ensure_user(conn, email)
            conn.execute(
                """
                INSERT INTO grants (email, sender_id, status, limits_json, requested_at, decided_at)
                VALUES (?, ?, 'approved', NULL, ?, ?)
                ON CONFLICT(email, sender_id) DO UPDATE SET
                    status='approved', decided_at=excluded.decided_at
                """,
                (email, sender["id"], now, now),
            )
            add_audit(conn, master["email"], "sender_assigned", f"{email} -> {sender.get('email') or sender['id']}")
        self.send_json(200, {"ok": True, "status": "approved"})

    def save_ga4(self, user, data):
        tracking = save_email_tracking(data.get("tracking") if isinstance(data.get("tracking"), dict) else data)
        with db() as conn:
            add_audit(conn, user["email"], "ga4_updated", tracking.get("campaign") or "")
        self.send_json(200, {"ok": True, "tracking": tracking})

    def decide_approval(self, master, data):
        try:
            grant_id = int(data.get("id"))
        except (TypeError, ValueError) as exc:
            raise ApiError("Approval id is missing.") from exc
        action = str(data.get("action") or "").lower()
        if action not in ("approve", "deny"):
            raise ApiError("Action must be approve or deny.")
        limits = data.get("limits")
        limits_json = json.dumps(normalize_limits(limits)) if isinstance(limits, dict) and limits else None
        now = time.time()
        status = "approved" if action == "approve" else "denied"
        with db() as conn:
            row = conn.execute("SELECT * FROM grants WHERE id=?", (grant_id,)).fetchone()
            if not row:
                raise ApiError("Request not found.", 404)
            sender = resolve_requested_sender(row["sender_id"])
            real_id = sender["id"] if sender else row["sender_id"]
            if action == "approve" and not sender:
                raise ApiError("Add that sending email in Configuration first, then approve.")
            if action == "approve" and not limits_json:
                limits_json = json.dumps({"per_day": mailbox_daily_cap(sender)})
            conn.execute(
                """
                UPDATE grants
                SET status=?, decided_at=?, limits_json=COALESCE(?, limits_json), sender_id=?
                WHERE id=?
                """,
                (status, now, limits_json, real_id, grant_id),
            )
            label = (sender or {}).get("email") or row["sender_id"]
            add_audit(conn, master["email"], f"sender_{status}", f"{row['email']} -> {label}")
        self.send_json(200, {"ok": True, "status": status})

    def test_sender(self, _master, data):
        sender = sender_by_id(str(data.get("sender_id") or data.get("id") or ""))
        if not sender and data.get("target") == "master":
            sender = otp_sender() or refresh_otp_sender()
            if sender:
                try:
                    smtp = connect_smtp(sender)
                    safe_quit(smtp)
                except Exception as exc:
                    detail = friendly_smtp_error(exc)
                    write_mailbox_status(False, detail)
                    self.send_json(200, {"ok": False, "message": detail, "refreshed": False})
                    return
                message = f"Sign-in codes can send from {OTP_FROM}."
                write_mailbox_status(True, message)
                self.send_json(200, {"ok": True, "message": message, "refreshed": False})
                return
        if not sender and (data.get("email") or data.get("user")):
            existing = sender_by_id(make_sender_id(data.get("id"), normalize_email(data.get("email") or data.get("user"))))
            password = sanitize_password(data.get("password") or "")
            if not password and existing:
                password = existing.get("password") or ""
            sender = prepare_sender({
                "id": data.get("id") or "test",
                "email": data.get("email"),
                "user": data.get("user") or data.get("email"),
                "display_name": data.get("display_name"),
                "host": data.get("host") or "smtp.gmail.com",
                "port": data.get("port") or 465,
                "secure": data.get("secure") or "ssl",
                "password": password,
            })
        if not sender:
            raise ApiError("Sender not found.")
        ok, message = test_sender_connection(sender)
        refreshed = False
        sheet_url = str(load_config().get("mailbox_sheet_url") or "").strip()
        if not ok and sheet_url and sender.get("email"):
            try:
                result = apply_mailbox_sheet(sheet_url, sender["email"])
                refreshed = True
                fresh = sender_by_address(sender["email"]) or sender
                if result.get("changed"):
                    ok, again = test_sender_connection(fresh)
                    message = again if ok else f"Loaded the latest row from the Google Sheet, but the mailbox still failed. {again}"
                else:
                    message = f"{message} The Google Sheet has the same details. Update the password there, then test again."
            except ApiError as exc:
                message = f"{message} {exc.message}"
        self.send_json(200, {"ok": ok, "message": message, "refreshed": refreshed})

    def save_desk(self, master, data):
        with db() as conn:
            ui = save_desk_ui(conn, data.get("ui") if isinstance(data.get("ui"), dict) else data)
            add_audit(conn, master["email"], "desk_ui_updated", ui["brand_name"])
        self.send_json(200, {"ok": True, "ui": ui})

    def save_drive(self, admin, data):
        config = load_config()
        drive = dict(config.get("google_drive") or {})
        parent = str(data.get("parent_folder_id") or "").strip()
        if parent and not re.fullmatch(r"[A-Za-z0-9_-]{10,120}", parent):
            raise ApiError("Paste only the folder ID from the Google Drive folder address.")
        name = re.sub(r"\s+", " ", str(data.get("folder_name") or "ParthMailing_Storage")).strip()[:80]
        raw = data.get("service_account_json")
        if raw:
            if isinstance(raw, str):
                try:
                    account = json.loads(raw)
                except json.JSONDecodeError:
                    raise ApiError("That is not valid service-account JSON.")
            elif isinstance(raw, dict):
                account = raw
            else:
                raise ApiError("Paste the service-account JSON key.")
            if account.get("type") != "service_account" or not str(account.get("private_key") or "").strip() or not str(account.get("client_email") or "").strip():
                raise ApiError("Use the JSON key downloaded for a Google service account.")
            path = os.path.join(CONFIG_DIR, "drive_service_account.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(account, handle, indent=2)
                handle.write("\n")
            drive["service_account_file"] = "config/drive_service_account.json"
        drive["enabled"] = bool(data.get("enabled"))
        drive["parent_folder_id"] = parent
        drive["folder_name"] = name or "ParthMailing_Storage"
        config["google_drive"] = drive
        write_config(config)
        status = drive_status()
        with db() as conn:
            detail = "off" if not status["enabled"] else (status.get("client_email") or "on")
            add_audit(conn, admin["email"], "drive_settings_saved", detail)
        self.send_json(200, {"ok": True, "drive": status})

    def test_drive(self, master):
        status = drive_status()
        if not status["ready"]:
            raise ApiError(status["reason"])
        account, settings = load_service_account()
        try:
            result = drive_sync.ping(account, settings["root_name"], settings["parent"])
        except Exception as exc:
            raise ApiError(f"Drive check failed: {exc}", 502) from None
        with db() as conn:
            add_audit(conn, master["email"], "drive_tested", result.get("email") or "")
        self.send_json(200, {"ok": True, "folder_id": result.get("folder_id"), "email": result.get("email")})

    def serve_static(self, path):
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        rel = urllib.parse.unquote(rel)
        root = os.path.realpath(FRONTEND)
        full = os.path.realpath(os.path.join(root, rel))
        try:
            inside = os.path.commonpath([root, full]) == root
        except ValueError:
            inside = False
        if not inside or not os.path.isfile(full):
            self.send_response(404)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", "14")
            self._cors()
            self.end_headers()
            self.wfile.write(b"File not found")
            return
        kind = "application/octet-stream"
        if full.endswith(".html"):
            kind = "text/html; charset=utf-8"
        elif full.endswith(".css"):
            kind = "text/css; charset=utf-8"
        elif full.endswith(".js"):
            kind = "application/javascript; charset=utf-8"
        elif full.endswith(".json"):
            kind = "application/json; charset=utf-8"
        elif full.endswith(".svg"):
            kind = "image/svg+xml"
        with open(full, "rb") as handle:
            body = handle.read()
        self.send_bytes(200, body, kind)


def split_path(raw):
    parsed = urllib.parse.urlsplit(raw)
    query = {key: values[0] for key, values in urllib.parse.parse_qs(parsed.query).items()}
    return urllib.parse.unquote(parsed.path), query


class RelayServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def server_bind(self):
        if self.address_family == socket.AF_INET6:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        super().server_bind()

    def handle_error(self, request, client_address):
        # A browser that disconnects mid-response is not a relay failure.
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, TimeoutError)):
            return
        super().handle_error(request, client_address)


def open_when_ready(url):
    for _ in range(40):
        try:
            with urllib.request.urlopen(url, timeout=0.5) as response:
                body = response.read(12000)
            if response.status == 200 and b"Parth Mailing" in body:
                webbrowser.open(url)
                return
        except Exception:
            time.sleep(0.25)


def bind_servers(host, port):
    class IPv6Relay(RelayServer):
        address_family = socket.AF_INET6

    targets = []
    cleaned = str(host or "127.0.0.1").strip() or "127.0.0.1"
    if cleaned in ("127.0.0.1", "localhost", "::1"):
        targets = [("127.0.0.1", RelayServer), ("::1", IPv6Relay)]
    else:
        kind = IPv6Relay if ":" in cleaned else RelayServer
        targets = [(cleaned, kind)]
    servers = []
    errors = []
    for address, kind in targets:
        try:
            servers.append(kind((address, port), Handler))
        except OSError as exc:
            errors.append(f"{address}:{port} ({exc})")
    return servers, errors


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ensure_config()
    init_db()
    sync_admin_sender()
    recover_incomplete()
    config = load_config()
    host = str((config.get("server") or {}).get("host") or "127.0.0.1")
    port = int((config.get("server") or {}).get("port") or 8787)
    engine = threading.Thread(target=engine_loop, name="campaign-engine", daemon=True)
    engine.start()
    servers, errors = bind_servers(host, port)
    if not servers:
        log("Cannot listen. " + "; ".join(errors))
        log("Close the other Parth Mailing window, then start this file again.")
        raise SystemExit(1)
    for extra in errors:
        log(f"Extra listener skipped: {extra}")
    url = f"http://127.0.0.1:{port}/"
    for extra in servers[1:]:
        threading.Thread(target=extra.serve_forever, name="relay-ipv6", daemon=True).start()
    log(f"Parth Mailing relay listening on {url}")
    log(f"Domain lock: {domain_suffix()}  |  Sign-in email: {'on' if otp_is_live() else 'waiting for the admin app password'}")
    if os.environ.get("PARTH_NO_BROWSER") != "1":
        threading.Thread(target=open_when_ready, args=(url,), name="open-browser", daemon=True).start()
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        log("Relay stopping")
    finally:
        STOP_ENGINE.set()
        for item in servers:
            try:
                item.shutdown()
            except Exception:
                pass
            item.server_close()
        with _pool_lock:
            for smtp in _pool.values():
                safe_quit(smtp)
            _pool.clear()


if __name__ == "__main__":
    main()
