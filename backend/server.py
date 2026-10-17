#!/usr/bin/env python3
"""Parth Mailing relay.

Local HTTP service for the liquid-glass mailing desk. It signs people in with a
5-minute code, keeps mailbox passwords on this machine, and sends campaigns with
pace control, provider caps, and an Excel report.

Run: python server.py
"""

import base64
import datetime
import email.utils
import hashlib
import hmac
import html
import json
import os
import random
import re
import secrets
import shutil
import smtplib
import socket
import sqlite3
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

_db_lock = threading.RLock()
_cfg_cache = {"mtime": None, "data": None}
_pool_lock = threading.Lock()
_pool = {}
STOP_ENGINE = threading.Event()
SLEEP_UNTIL = {}
BATCH_COUNT = {}


class ApiError(Exception):
    def __init__(self, message, code=400):
        super().__init__(message)
        self.message = message
        self.code = code


def log(message):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}"
    print(line, flush=True)
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
                last_login REAL
            );
            CREATE TABLE IF NOT EXISTS otps (
                email TEXT PRIMARY KEY,
                code_hash TEXT,
                salt TEXT,
                expires_at REAL,
                attempts INTEGER,
                sent_at REAL
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
                sent_at REAL
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
        "labels": {
            "home": "Desk",
            "recipients": "Recipients",
            "campaigns": "Campaigns",
            "history": "History",
            "compose": "Compose",
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
        "show_compose", "show_pace", "show_schedule", "show_attachments", "show_cc",
        "show_variables", "block_repeat_recipients",
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


def save_google_client_id(client_id):
    data = load_config()
    data["google_sign_in"] = {"client_id": client_id}
    with open(CONFIG_PATH, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
        handle.write("\n")
    _cfg_cache["mtime"] = os.path.getmtime(CONFIG_PATH)
    _cfg_cache["data"] = data


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
    return bool(EMAIL_RE.match(email) and email.endswith(domain_suffix()))


def master_set():
    return {normalize_email(item) for item in (load_config().get("master_emails") or []) if normalize_email(item)}


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


def default_limits():
    raw = load_config().get("default_limits") or {}
    return {
        "per_minute": int(raw.get("per_minute") or 10),
        "per_hour": int(raw.get("per_hour") or 100),
        "per_day": int(raw.get("per_day") or 500),
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
    if not sender_id:
        return merged
    grant = conn.execute(
        "SELECT limits_json, status FROM grants WHERE email=? AND sender_id=?",
        (user_row["email"], sender_id),
    ).fetchone()
    if not grant or not grant["limits_json"]:
        return merged
    try:
        extra = json.loads(grant["limits_json"])
    except json.JSONDecodeError:
        return merged
    if not isinstance(extra, dict):
        return merged
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
    }


def configured_senders():
    senders = []
    for raw in load_config().get("senders") or []:
        sender = prepare_sender(raw)
        if sender and sender["id"] and sender["user"]:
            senders.append(sender)
    return senders


def sender_by_id(sender_id):
    for sender in configured_senders():
        if sender["id"] == sender_id:
            return sender
    return None


def live_delivery(sender):
    mode = dispatch_mode()
    if mode == "simulate":
        return False
    if mode == "live":
        return True
    return bool(sender and sender.get("password"))


def otp_is_live():
    return live_delivery(prepare_sender(load_config().get("master_smtp") or {}))


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
    }


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
        "total_count": row["total_count"] or 0,
        "drive_upload_url": row["drive_upload_url"] or "",
        "drive_report_url": row["drive_report_url"] or "",
        "source_name": row["source_name"] or "",
        "pace": pace,
    }


def recompute_counts(conn, campaign_id):
    counts = {"SENT": 0, "FAILED": 0, "BOUNCED": 0, "QUEUED": 0, "SKIPPED": 0}
    for row in conn.execute(
        "SELECT status, COUNT(*) AS n FROM recipients WHERE campaign_id=? GROUP BY status",
        (campaign_id,),
    ):
        counts[row["status"]] = row["n"]
    total = conn.execute("SELECT COUNT(*) AS n FROM recipients WHERE campaign_id=?", (campaign_id,)).fetchone()["n"]
    conn.execute(
        "UPDATE campaigns SET sent_count=?, failed_count=?, bounced_count=?, skipped_count=?, total_count=? WHERE id=?",
        (counts["SENT"], counts["FAILED"], counts["BOUNCED"], counts["SKIPPED"], total, campaign_id),
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


def drive_status():
    settings = drive_settings()
    if not settings["enabled"]:
        return {"ready": False, "reason": "Google Drive backup is turned off in config."}
    if not settings["path"] or not os.path.isfile(settings["path"]):
        return {"ready": False, "reason": "Service account JSON was not found."}
    if not drive_sync.cryptography_ready():
        return {"ready": False, "reason": "Install the cryptography package to sign Drive requests."}
    return {"ready": True, "reason": "Service account file is ready."}


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


def connect_smtp(sender):
    timeout = 30
    if sender["secure"] == "ssl":
        smtp = smtplib.SMTP_SSL(sender["host"], sender["port"], timeout=timeout)
    else:
        smtp = smtplib.SMTP(sender["host"], sender["port"], timeout=timeout)
        if sender["secure"] == "tls":
            smtp.starttls()
    smtp.login(sender["user"], sender["password"])
    return smtp


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
    text = str(exc)
    if any(token in text for token in ("550", "551", "553", "554")):
        return "BOUNCED", "550", text[:800]
    return "FAILED", "", text[:800]


def account_error_is_fatal(message):
    lowered = message.lower()
    needles = (
        "authentication",
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

    def replacer(match):
        key = match.group(1).strip()
        found = None
        for name, value in values.items():
            if name.lower() == key.lower():
                found = value
                break
        if found is None:
            return match.group(0)
        return html.escape(found) if escape_values else found

    return re.sub(r"\{\{\s*([^{}]+?)\s*\}\}", replacer, str(template or ""))


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
    html_body = sanitize_html(apply_variables(campaign["html"], recipient, True))
    cc_raw = field_value(recipient, "Cc", "CC", "cc") or campaign["cc"] or ""
    bcc_raw = field_value(recipient, "Bcc", "BCC", "bcc") or campaign["bcc"] or ""
    cc_list, cc_bad = split_address_list(cc_raw)
    bcc_list, bcc_bad = split_address_list(bcc_raw)
    if cc_bad or bcc_bad:
        bad = ", ".join(cc_bad + bcc_bad)
        return {"status": "FAILED", "code": "", "error": f"Invalid copy address: {bad}"}
    display = field_value(recipient, "Sender Name", "From Name", "Display Name") or sender["display_name"]
    if not live_delivery(sender):
        return {"status": "SENT", "code": "250", "error": "", "simulated": True}
    if not sender["password"]:
        return {"status": "FAILED", "code": "", "error": "SMTP password is missing for this sender."}
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
    envelope = [recipient["email"], *cc_list, *bcc_list]
    try:
        code, _detail = send_with_pool(sender, message, envelope)
        return {"status": "SENT", "code": code, "error": "", "simulated": False}
    except Exception as exc:
        status, code, detail = classify_smtp_error(exc)
        return {"status": status, "code": code, "error": detail, "simulated": False}


def provider_cap(sender):
    email = normalize_email(sender.get("user") or "")
    domain = email.split("@", 1)[1] if "@" in email else ""
    host = str(sender.get("host") or "").lower()
    if domain in ("gmail.com", "googlemail.com"):
        return GMAIL_DAILY_CAP
    if "gmail" in host or "google" in host or "googlemail" in host:
        return WORKSPACE_DAILY_CAP
    try:
        return int(load_config().get("other_daily_cap") or 500)
    except (TypeError, ValueError):
        return 500


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


def claim_recipient(campaign_id):
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM recipients WHERE campaign_id=? AND status='QUEUED' ORDER BY id LIMIT 1",
            (campaign_id,),
        ).fetchone()
        if not row:
            return None
        cur = conn.execute(
            "UPDATE recipients SET status='SENDING' WHERE id=? AND status='QUEUED'",
            (row["id"],),
        )
        if cur.rowcount != 1:
            return None
        return row


def save_outcome(campaign, recipient, outcome, sender):
    now = time.time()
    with db() as conn:
        sent_at = now if outcome["status"] == "SENT" else None
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


def after_send_delay(campaign):
    pace = normalize_pace(json.loads(campaign["pace_json"] or "{}"))
    count = BATCH_COUNT.get(campaign["id"], 0) + 1
    if count >= pace["batch_size"]:
        BATCH_COUNT[campaign["id"]] = 0
        delay = pace["batch_pause_minutes"] * 60
    else:
        BATCH_COUNT[campaign["id"]] = count
        low = pace["delay_min_seconds"]
        high = pace["delay_max_seconds"]
        delay = random.uniform(low, high) if high > low else low
    SLEEP_UNTIL[campaign["id"]] = time.time() + delay


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


def engine_tick():
    camp = select_campaign()
    if not camp:
        return False
    if camp["status"] == "scheduled":
        with db() as conn:
            conn.execute(
                "UPDATE campaigns SET status='running', started_at=?, hold_reason='' WHERE id=? AND status='scheduled'",
                (time.time(), camp["id"]),
            )
            add_audit(conn, "relay", "campaign_started", camp["id"])
        log(f"Scheduled campaign {camp['id']} is starting")
        return True
    sender = sender_by_id(camp["sender_id"])
    if not sender:
        set_hold(camp["id"], "Sender identity is no longer configured.", 30)
        with db() as conn:
            conn.execute(
                "UPDATE campaigns SET status='paused', hold_reason=? WHERE id=?",
                ("Sender identity is no longer configured.", camp["id"]),
            )
        return True
    with db() as conn:
        user_row = conn.execute("SELECT * FROM users WHERE email=?", (camp["owner"],)).fetchone()
        limits = effective_limits(conn, user_row, camp["sender_id"]) if user_row else default_limits()
        fresh = conn.execute("SELECT status FROM campaigns WHERE id=?", (camp["id"],)).fetchone()
    if not fresh or fresh["status"] != "running":
        return True
    allowed, window_message = within_window(limits)
    if not allowed:
        set_hold(camp["id"], window_message, 20)
        return True
    company_cap = int(load_desk_ui().get("global_daily_cap") or 0)
    if company_cap > 0:
        with db() as conn:
            company_used = conn.execute(
                "SELECT COUNT(*) AS n FROM recipients WHERE status='SENT' AND sent_at>=?",
                (time.time() - 86400,),
            ).fetchone()["n"]
        if company_used >= company_cap:
            set_hold(camp["id"], f"Company daily limit of {company_cap} has been reached.", 30)
            return True
    wait = rate_wait_seconds(camp["owner"], limits)
    if wait > 0:
        set_hold(camp["id"], f"Rate limit reached. Next send in {max(1, int(wait))}s.", min(wait, 30))
        return True
    if live_delivery(sender):
        used = pace_used(sender["user"])
        cap = provider_cap(sender)
        if used >= cap:
            set_hold(camp["id"], f"{sender['user']} reached the 24-hour mailbox cap of {cap}.", 60)
            return True
    clear_hold(camp["id"])
    recipient = claim_recipient(camp["id"])
    if recipient is None:
        finish_if_drained(camp["id"])
        return True
    address = normalize_email(recipient["email"])
    held = False
    if repeats_blocked():
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
            return True
    try:
        outcome = deliver(camp, recipient, sender)
    except Exception as exc:
        outcome = {"status": "FAILED", "code": "", "error": str(exc)[:800], "simulated": False}
    if outcome.get("status") != "SENT" and held:
        with db() as conn:
            release_sent(conn, address, camp["id"])
        held = False
    outcome["already_recorded"] = held
    save_outcome(camp, recipient, outcome, sender)
    after_send_delay(camp)
    log(f"{outcome['status']} {sender['user']} -> {recipient['email']} {outcome.get('code') or ''} {(outcome.get('error') or '')[:160]}")
    finish_if_drained(camp["id"])
    return True


def engine_loop():
    log("Campaign engine started")
    while not STOP_ENGINE.is_set():
        try:
            worked = engine_tick()
        except Exception:
            log(traceback.format_exc())
            worked = False
        if not worked:
            STOP_ENGINE.wait(0.4)


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


def test_sender_connection(sender):
    if not live_delivery(sender):
        return True, "No mailbox password is saved, so campaigns for this sender stay in simulation mode."
    if not sender["host"] or not sender["user"] or not sender["password"]:
        return False, "Host, username, and password are required."
    try:
        smtp = connect_smtp(sender)
        safe_quit(smtp)
        return True, f"SMTP authentication succeeded for {sender['user']}."
    except smtplib.SMTPAuthenticationError:
        return False, f"SMTP authentication failed for {sender['user']}. Check the app password."
    except socket.timeout:
        return False, f"Connection to {sender['host']}:{sender['port']} timed out."
    except Exception as exc:
        return False, f"Connection check failed: {exc}"


def send_otp_email(target, code):
    master = prepare_sender(load_config().get("master_smtp") or {})
    if not master or not master["host"] or not master["user"] or not master["password"]:
        raise ApiError("Master SMTP is not configured.", 502)
    minutes = max(1, otp_ttl() // 60)
    body = f"""<!DOCTYPE html><html><body style="margin:0;background:#0e1524;padding:28px;font-family:Segoe UI,Arial,sans-serif;">
<div style="max-width:480px;margin:0 auto;padding:28px;border-radius:24px;background:#172033;border:1px solid rgba(255,255,255,0.15);color:#f4f7fb;">
<p style="letter-spacing:.16em;text-transform:uppercase;font-size:12px;color:#9fb0c9;margin:0 0 8px;">Parth Mailing</p>
<h1 style="font-size:22px;font-weight:600;margin:0 0 8px;">Your sign-in code</h1>
<p style="color:#c5d0e0;line-height:1.5;">This code expires in {minutes} minutes. If you did not ask to sign in, ignore this email.</p>
<p style="font-size:36px;letter-spacing:10px;font-weight:700;background:#101826;border-radius:16px;padding:16px 12px;text-align:center;">{html.escape(code)}</p>
</div></body></html>"""
    message = MIMEMultipart("alternative")
    message["From"] = build_aligned_from(master["display_name"] or "Parth Mailing", master["user"])
    message["To"] = target
    message["Subject"] = "Your Parth Mailing sign-in code"
    message["Date"] = email.utils.formatdate(localtime=True)
    message.attach(MIMEText(f"Your Parth Mailing sign-in code is {code}. It expires in {minutes} minutes.", "plain", "utf-8"))
    message.attach(MIMEText(body, "html", "utf-8"))
    try:
        send_with_pool(master, message, [target])
    except Exception as exc:
        raise ApiError(f"Could not email the sign-in code: {exc}", 502) from None


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
        return bool(configured_senders())
    row = conn.execute(
        "SELECT 1 FROM grants WHERE email=? AND status='approved' LIMIT 1",
        (email,),
    ).fetchone()
    return row is not None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        request = args[0] if args else ""
        if "/api/health" in str(request):
            return
        log(fmt % args)

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
        return {
            "email": email,
            "role": role,
            "enabled": bool(row["enabled"]),
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
            raise ApiError("Master access required.", 403)
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
            log(traceback.format_exc())
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
            self.send_json(200, {
                "ok": True,
                "service": "parth-mailing",
                "version": "1.0.0",
                "domain": domain_suffix(),
                "dispatch_mode": dispatch_mode(),
                "otp_delivery": "email" if otp_is_live() else "on_screen",
                "google_client_id": google_client_id(),
                "drive": drive_status(),
                "active_campaigns": active,
            })
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
                    catalog.append(public_sender(sender, grant_status(conn, user["email"], sender["id"], user["role"])))
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
            self.send_json(200, {"ok": True, "campaigns": [public_campaign(row) for row in rows]})
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
                    users.append({
                        "email": row["email"],
                        "role": role_for(row["email"]),
                        "enabled": bool(row["enabled"]),
                        "created_at": row["created_at"],
                        "last_login": row["last_login"],
                        "limits": stored_limits(row),
                        "sent_today": sent_today,
                        "sent_total": sent_total,
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
                sender = sender_by_id(row["sender_id"])
                approvals.append({
                    "id": row["id"],
                    "email": row["email"],
                    "sender_id": row["sender_id"],
                    "sender_email": (sender or {}).get("email") or row["sender_id"],
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
                "campaigns": [public_campaign(row) for row in rows],
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
        if path == "/api/master/users/limits":
            self.set_limits(self.require_master(), data)
            return
        if path == "/api/master/approvals":
            self.decide_approval(self.require_master(), data)
            return
        if path == "/api/master/senders/test":
            self.test_sender(self.require_master(), data)
            return
        if path == "/api/master/drive/test":
            self.test_drive(self.require_master())
            return
        if path == "/api/master/ui":
            self.save_desk(self.require_master(), data)
            return
        if path == "/api/master/google":
            self.save_google(self.require_master(), data)
            return
        raise ApiError("Endpoint not found.", 404)

    def request_otp(self, data):
        email = normalize_email(data.get("email"))
        if not allowed_email(email):
            raise ApiError(f"Use a work address ending with {domain_suffix()}.")
        ttl = otp_ttl()
        now = time.time()
        code = f"{secrets.randbelow(900000) + 100000}"
        salt = secrets.token_hex(8)
        digest = hashlib.sha256(f"{salt}:{code}".encode("utf-8")).hexdigest()
        with db() as conn:
            row = ensure_user(conn, email)
            if not row["enabled"]:
                raise ApiError("This account is disabled.", 403)
            existing = conn.execute("SELECT sent_at FROM otps WHERE email=?", (email,)).fetchone()
            if existing and existing["sent_at"] and now - existing["sent_at"] < 30:
                raise ApiError("Wait a few seconds before requesting another code.", 429)
            conn.execute(
                """
                INSERT INTO otps (email, code_hash, salt, expires_at, attempts, sent_at)
                VALUES (?, ?, ?, ?, 0, ?)
                ON CONFLICT(email) DO UPDATE SET
                    code_hash=excluded.code_hash, salt=excluded.salt, expires_at=excluded.expires_at,
                    attempts=0, sent_at=excluded.sent_at
                """,
                (email, digest, salt, now + ttl, now),
            )
            add_audit(conn, email, "otp_requested", "")
        live = otp_is_live()
        if live:
            try:
                send_otp_email(email, code)
            except Exception:
                with db() as conn:
                    conn.execute("DELETE FROM otps WHERE email=?", (email,))
                raise
        else:
            print(f"[dev] sign-in code for {email}: {code}", flush=True)
        payload = {"ok": True, "expires_in": ttl, "delivery": "email" if live else "on_screen"}
        if not live:
            payload["dev_otp"] = code
        self.send_json(200, payload)

    def verify_otp(self, data):
        email = normalize_email(data.get("email"))
        code = re.sub(r"\D", "", str(data.get("code") or ""))
        if not allowed_email(email) or len(code) != 6:
            raise ApiError("Enter the 6-digit code for a work address.")
        now = time.time()
        failure = None
        failure_code = 400
        with db() as conn:
            row = conn.execute("SELECT * FROM otps WHERE email=?", (email,)).fetchone()
            user = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
            if not user or not user["enabled"]:
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
                else:
                    conn.execute("DELETE FROM otps WHERE email=?", (email,))
                    conn.execute(
                        "UPDATE users SET last_login=?, role=? WHERE email=?",
                        (now, role_for(email), email),
                    )
                    add_audit(conn, email, "signed_in", role_for(email))
        if failure:
            raise ApiError(failure, failure_code)
        self.send_json(200, {
            "ok": True,
            "token": issue_token(email),
            "user": {"email": email, "role": role_for(email)},
        })

    def google_sign_in(self, data):
        email = verify_google_credential(data.get("credential"))
        now = time.time()
        with db() as conn:
            row = ensure_user(conn, email)
            if not row["enabled"]:
                raise ApiError("This account is disabled.", 403)
            conn.execute(
                "UPDATE users SET last_login=?, role=? WHERE email=?",
                (now, role_for(email), email),
            )
            add_audit(conn, email, "signed_in_google", role_for(email))
        self.send_json(200, {
            "ok": True,
            "token": issue_token(email),
            "user": {"email": email, "role": role_for(email)},
        })

    def save_google(self, master, data):
        client_id = str(data.get("client_id") or "").strip()
        if client_id and not re.fullmatch(r"[0-9A-Za-z._-]{10,180}\.apps\.googleusercontent\.com", client_id):
            raise ApiError("Paste the client ID that ends with .apps.googleusercontent.com.")
        save_google_client_id(client_id)
        with db() as conn:
            add_audit(conn, master["email"], "google_sign_in_updated", "on" if client_id else "off")
        self.send_json(200, {"ok": True, "google_client_id": client_id})

    def request_sender(self, user, data):
        sender = sender_by_id(str(data.get("sender_id") or ""))
        if not sender:
            raise ApiError("That sender identity is not configured.")
        if user["role"] == "ROLE_MASTER":
            self.send_json(200, {"ok": True, "status": "approved"})
            return
        now = time.time()
        with db() as conn:
            existing = conn.execute(
                "SELECT * FROM grants WHERE email=? AND sender_id=?",
                (user["email"], sender["id"]),
            ).fetchone()
            if existing and existing["status"] == "approved":
                raise ApiError("You already have this sender identity.")
            if existing and existing["status"] == "pending":
                raise ApiError("This request is already waiting for the master.")
            conn.execute(
                """
                INSERT INTO grants (email, sender_id, status, limits_json, requested_at, decided_at)
                VALUES (?, ?, 'pending', NULL, ?, NULL)
                ON CONFLICT(email, sender_id) DO UPDATE SET
                    status='pending', requested_at=excluded.requested_at, decided_at=NULL
                """,
                (user["email"], sender["id"], now),
            )
            add_audit(conn, user["email"], "sender_requested", f"Request access to sender ID: {sender['email']}")
        self.send_json(200, {"ok": True, "status": "pending"})

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
        sender = sender_by_id(str(data.get("sender_id") or ""))
        if not sender:
            raise ApiError("Choose an approved sender identity.")
        subject = clean_header(data.get("subject"))[:998]
        html_body = sanitize_html(data.get("html") or "")
        if not subject or not html_to_text(html_body):
            raise ApiError("Subject and message are required.")
        pace = normalize_pace(data.get("pace") or {})
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
                    pace_json, hold_reason, created_at, total_count
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, '', ?, 0)
                """,
                (
                    campaign_id, user["email"], sender["id"], subject, html_body, cc, bcc,
                    schedule_at, timezone, json.dumps(pace), time.time(),
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
                for key, value in list(fields.items())[:40]:
                    trimmed[str(key)[:80]] = str(value if value is not None else "")[:5000]
                status = "QUEUED"
                error = ""
                code = ""
                if block_repeats and conn.execute("SELECT 1 FROM sent_people WHERE email=?", (email,)).fetchone():
                    status = "SKIPPED"
                    error = "Already emailed this person. A second message was not sent."
                    code = "DUP"
                    already_sent += 1
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
                ))
            conn.executemany(
                """
                INSERT INTO recipients (
                    campaign_id, email, first_name, last_name, company, custom1, fields_json, status, error, smtp_code
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            if not sender_allowed(conn, user["email"], user["role"], camp["sender_id"]):
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
            now = time.time()
            scheduled = camp["schedule_at"] and camp["schedule_at"] > now + 1
            status = "scheduled" if scheduled else "running"
            started = None if scheduled else now
            conn.execute(
                "UPDATE campaigns SET status=?, started_at=?, hold_reason='' WHERE id=?",
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
            conn.execute(
                "UPDATE grants SET status=?, decided_at=?, limits_json=COALESCE(?, limits_json) WHERE id=?",
                (status, now, limits_json, grant_id),
            )
            sender = sender_by_id(row["sender_id"])
            label = (sender or {}).get("email") or row["sender_id"]
            add_audit(conn, master["email"], f"sender_{status}", f"{row['email']} -> {label}")
        self.send_json(200, {"ok": True, "status": status})

    def test_sender(self, _master, data):
        sender = sender_by_id(str(data.get("sender_id") or ""))
        if not sender and data.get("target") == "master":
            sender = prepare_sender(load_config().get("master_smtp") or {})
        if not sender:
            raise ApiError("Sender not found.")
        ok, message = test_sender_connection(sender)
        self.send_json(200, {"ok": ok, "message": message})

    def save_desk(self, master, data):
        with db() as conn:
            ui = save_desk_ui(conn, data.get("ui") if isinstance(data.get("ui"), dict) else data)
            add_audit(conn, master["email"], "desk_ui_updated", ui["brand_name"])
        self.send_json(200, {"ok": True, "ui": ui})

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


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ensure_config()
    init_db()
    recover_incomplete()
    config = load_config()
    host = str((config.get("server") or {}).get("host") or "127.0.0.1")
    port = int((config.get("server") or {}).get("port") or 8787)
    engine = threading.Thread(target=engine_loop, name="campaign-engine", daemon=True)
    engine.start()
    server = RelayServer((host, port), Handler)
    url = f"http://{host}:{port}/"
    log(f"Parth Mailing relay listening on {url}")
    log(f"Domain lock: {domain_suffix()}  |  OTP delivery: {'email' if otp_is_live() else 'on screen'}")
    if os.environ.get("PARTH_NO_BROWSER") != "1":
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("Relay stopping")
    finally:
        STOP_ENGINE.set()
        server.server_close()
        with _pool_lock:
            for smtp in _pool.values():
                safe_quit(smtp)
            _pool.clear()


if __name__ == "__main__":
    main()
