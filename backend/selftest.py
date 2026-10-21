#!/usr/bin/env python3
"""Exercise the relay: domain lock, OTP, approval, pace, pause, and the Excel report."""

import io
import json
import time
import urllib.error
import urllib.request
import zipfile

BASE = "http://127.0.0.1:8787"
MASTER = "vekariyaparth127@gmail.com"
USER = "agent.user@gr-conferences.com"
LOCKED = "locked.user@gr-conferences.com"


class TestFailure(Exception):
    pass


def request(method, path, body=None, token=None, raw=None, headers=None):
    data = raw if raw is not None else (None if body is None else json.dumps(body).encode("utf-8"))
    hdrs = {"Content-Type": "application/json"} if raw is None and body is not None else {}
    hdrs.update(headers or {})
    if token:
        hdrs["Authorization"] = "Bearer " + token
    req = urllib.request.Request(BASE + path, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            payload = response.read()
            content_type = response.headers.get("Content-Type", "")
            if "json" in content_type:
                return response.status, json.loads(payload.decode("utf-8"))
            return response.status, payload
    except urllib.error.HTTPError as exc:
        payload = exc.read()
        try:
            parsed = json.loads(payload.decode("utf-8"))
        except json.JSONDecodeError:
            parsed = {"ok": False, "error": payload.decode("utf-8", "replace")}
        return exc.code, parsed


def expect(condition, message):
    if not condition:
        raise TestFailure(message)


def login(email):
    if email == MASTER:
        status, session = request("POST", "/api/auth/admin", {"email": email})
        expect(status == 200 and session.get("token"), f"Admin sign-in failed: {session}")
        return session["token"], session["user"]["role"]
    for _ in range(3):
        status, data = request("POST", "/api/auth/request-otp", {"email": email})
        if status == 429:
            time.sleep(31)
            continue
        expect(status == 200 and data.get("dev_otp"), f"OTP for {email} failed: {data}")
        status, session = request("POST", "/api/auth/verify-otp", {"email": email, "code": "000000"})
        expect(status == 400, "A wrong code was accepted")
        status, session = request("POST", "/api/auth/verify-otp", {"email": email, "code": data["dev_otp"]})
        expect(status == 200 and session.get("token"), f"Verify failed for {email}: {session}")
        return session["token"], session["user"]["role"]
    raise TestFailure("OTP cooldown did not clear")


def wait_campaign(token, campaign_id, wanted, timeout):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        status, data = request("GET", f"/api/campaigns/{campaign_id}", token=token)
        expect(status == 200, f"Campaign read failed: {data}")
        last = data["campaign"]
        if last["status"] in wanted:
            return last
        time.sleep(0.25)
    raise TestFailure(f"Campaign stayed {last and last['status']}, wanted {wanted}")


def main():
    stamp = str(int(time.time() * 1000))
    ada = f"ada.{stamp}@example.com"
    grace = f"grace.{stamp}@example.com"
    status, health = request("GET", "/api/health")
    expect(status == 200 and health.get("ok"), health)
    expect(health.get("domain") == "@gr-conferences.com", health)

    status, denied = request("POST", "/api/auth/request-otp", {"email": "person@gmail.com"})
    expect(status == 400, denied)

    master_token, master_role = login(MASTER)
    expect(master_role == "ROLE_MASTER", master_role)
    user_token, user_role = login(USER)
    expect(user_role == "ROLE_USER", user_role)

    status, blocked = request("POST", "/api/campaigns", {
        "sender_id": "info", "subject": "Early", "html": "<p>Hello</p>",
    }, token=user_token)
    if status == 403:
        status, blocked = request("POST", "/api/drafts", {"payload": {"subject": "Draft"}}, token=user_token)
        expect(status == 403, blocked)
    else:
        expect(status == 200, blocked)

    status, requested = request("POST", "/api/senders/request", {"sender_id": "info"}, token=user_token)
    expect(status in (200, 400), requested)
    status, queue = request("GET", "/api/master/approvals", token=master_token)
    expect(status == 200, queue)
    pending = [item for item in queue["approvals"] if item["email"] == USER and item["sender_id"] == "info" and item["status"] == "pending"]
    if pending:
        status, decision = request("POST", "/api/master/approvals", {
            "id": pending[0]["id"], "action": "approve", "limits": {"per_day": 400},
        }, token=master_token)
        expect(status == 200 and decision.get("status") == "approved", decision)

    status, draft = request("POST", "/api/drafts", {"payload": {"subject": "Hello {{FirstName}}"}}, token=user_token)
    expect(status == 200 and draft.get("id"), draft)

    status, created = request("POST", "/api/campaigns", {
        "sender_id": "info",
        "subject": "Hello {{FirstName}}",
        "html": "<p>Welcome {{FirstName}} from {{Company}}.</p>",
        "cc": "",
        "pace": {"delay_min_seconds": 0, "delay_max_seconds": 0, "batch_size": 50, "batch_pause_minutes": 0},
        "attachments": [{"filename": "note.txt", "mime": "text/plain", "data_base64": "aGVsbG8="}],
    }, token=user_token)
    expect(status == 200, created)
    campaign_id = created["campaign"]["id"]
    status, added = request("POST", f"/api/campaigns/{campaign_id}/recipients", {
        "rows": [
            {"email": ada, "first_name": "Ada", "last_name": "Lovelace", "company": "Analytical", "custom1": "Gold"},
            {"email": "not-an-email", "first_name": "Nope"},
            {"email": ada, "first_name": "Ada"},
            {"email": grace, "first_name": "Grace", "last_name": "Hopper", "company": "Navy"},
        ],
        "replace": True,
    }, token=user_token)
    expect(added.get("added") == 2 and added.get("invalid") == 1 and added.get("duplicates") == 1, added)
    status, uploaded = request(
        "POST", f"/api/campaigns/{campaign_id}/source",
        token=user_token,
        raw=f"Email,FirstName\n{ada},Ada\n".encode("utf-8"),
        headers={"X-Filename": "people.csv", "Content-Type": "application/octet-stream"},
    )
    expect(status == 200, uploaded)
    status, started = request("POST", f"/api/campaigns/{campaign_id}/start", {}, token=user_token)
    expect(status == 200, started)
    finished = wait_campaign(user_token, campaign_id, {"complete"}, 20)
    expect(finished["sent_count"] == 2 and finished["failed_count"] == 0, finished)

    status, report = request("GET", f"/api/campaigns/{campaign_id}/report", token=user_token)
    expect(status == 200 and report[:2] == b"PK", "Report is not an xlsx file")
    with zipfile.ZipFile(io.BytesIO(report)) as workbook:
        sheet = workbook.read("xl/worksheets/sheet1.xml").decode("utf-8")
    expect("SENT" in sheet and ada in sheet and grace in sheet, "Report rows missing")

    status, _limits = request("POST", "/api/master/users/limits", {
        "email": USER,
        "limits": {"per_minute": 10, "per_hour": 100, "per_day": 500, "max_batch": 1, "enforce_window": False},
    }, token=master_token)
    expect(status == 200, _limits)
    status, tiny = request("POST", "/api/campaigns", {
        "sender_id": "info", "subject": "Too many", "html": "<p>Hi</p>",
        "pace": {"delay_min_seconds": 0, "delay_max_seconds": 0, "batch_size": 10, "batch_pause_minutes": 0},
    }, token=user_token)
    tiny_id = tiny["campaign"]["id"]
    request("POST", f"/api/campaigns/{tiny_id}/recipients", {
        "rows": [{"email": f"a.{stamp}@example.com"}, {"email": f"b.{stamp}@example.com"}],
    }, token=user_token)
    status, refused = request("POST", f"/api/campaigns/{tiny_id}/start", {}, token=user_token)
    expect(status == 400 and "at most 1" in refused.get("error", ""), refused)
    request("POST", "/api/master/users/limits", {
        "email": USER,
        "limits": {"per_minute": 10, "per_hour": 100, "per_day": 500, "max_batch": 5000, "enforce_window": False},
    }, token=master_token)

    status, paced = request("POST", "/api/campaigns", {
        "sender_id": "info", "subject": "Pause me", "html": "<p>Queue</p>",
        "pace": {"delay_min_seconds": 2, "delay_max_seconds": 2, "batch_size": 10, "batch_pause_minutes": 0},
    }, token=user_token)
    paced_id = paced["campaign"]["id"]
    request("POST", f"/api/campaigns/{paced_id}/recipients", {
        "rows": [{"email": f"p{i}.{stamp}@example.com"} for i in range(4)],
    }, token=user_token)
    status, running = request("POST", f"/api/campaigns/{paced_id}/start", {}, token=user_token)
    expect(status == 200, running)
    time.sleep(0.4)
    status, paused = request("POST", f"/api/campaigns/{paced_id}/control", {"action": "pause"}, token=user_token)
    expect(status == 200, paused)
    held = wait_campaign(user_token, paced_id, {"paused"}, 10)
    expect(held["status"] == "paused", held)
    request("POST", f"/api/campaigns/{paced_id}/control", {"action": "resume"}, token=user_token)
    time.sleep(0.2)
    status, killed = request("POST", f"/api/campaigns/{paced_id}/control", {"action": "kill"}, token=master_token)
    expect(status == 200, killed)
    stopped = wait_campaign(master_token, paced_id, {"killed"}, 10)
    expect(stopped["status"] == "killed", stopped)

    status, later = request("POST", "/api/campaigns", {
        "sender_id": "info", "subject": "Later {{FirstName}}", "html": "<p>Scheduled</p>",
        "schedule_at": time.time() + 3, "timezone": "UTC",
        "pace": {"delay_min_seconds": 0, "delay_max_seconds": 0, "batch_size": 5, "batch_pause_minutes": 0},
    }, token=user_token)
    later_id = later["campaign"]["id"]
    request("POST", f"/api/campaigns/{later_id}/recipients", {"rows": [{"email": f"later.{stamp}@example.com", "first_name": "Pat"}]}, token=user_token)
    status, scheduled = request("POST", f"/api/campaigns/{later_id}/start", {}, token=user_token)
    expect(scheduled.get("status") == "scheduled", scheduled)
    done = wait_campaign(user_token, later_id, {"complete"}, 20)
    expect(done["sent_count"] == 1, done)

    login(LOCKED)
    status, disabled = request("POST", "/api/master/users/enabled", {"email": LOCKED, "enabled": False}, token=master_token)
    expect(status == 200, disabled)
    status, blocked = request("POST", "/api/auth/request-otp", {"email": LOCKED})
    expect(status == 403, blocked)
    request("POST", "/api/master/users/enabled", {"email": LOCKED, "enabled": True}, token=master_token)

    status, forbidden = request("GET", "/api/master/users", token=user_token)
    expect(status == 403, forbidden)
    status, drive = request("POST", "/api/master/drive/test", {}, token=master_token)
    expect(status == 400, drive)

    status, ui_before = request("GET", "/api/ui")
    expect(status == 200 and ui_before.get("ui", {}).get("brand_name"), ui_before)
    original_ui = ui_before["ui"]
    status, saved = request("POST", "/api/master/ui", {"ui": {
        "brand_name": "Relay Desk",
        "accent": "#112233",
        "clock_timezone": "Asia/Kolkata",
        "block_repeat_recipients": True,
        "global_daily_cap": 0,
        "labels": {"home": "Home Desk"},
    }}, token=master_token)
    expect(status == 200 and saved["ui"]["brand_name"] == "Relay Desk", saved)
    expect(saved["ui"]["accent"] == "#112233" and saved["ui"]["labels"]["home"] == "Home Desk", saved)
    expect(saved["ui"]["clock_timezone"] == "Asia/Kolkata", saved)
    status, ui_after = request("GET", "/api/ui")
    expect(ui_after["ui"]["brand_name"] == "Relay Desk", ui_after)
    status, denied_ui = request("POST", "/api/master/ui", {"ui": original_ui}, token=user_token)
    expect(status == 403, denied_ui)
    status, restored = request("POST", "/api/master/ui", {"ui": original_ui}, token=master_token)
    expect(status == 200 and restored["ui"]["brand_name"] == original_ui["brand_name"], restored)

    status, ledger = request("GET", "/api/ledger", token=user_token)
    expect(status == 200 and ledger["ledger"]["mine_total"] >= 2, ledger)
    expect(ledger["ledger"]["unique_people"] >= ledger["ledger"]["mine_total"] or ledger["ledger"]["unique_people"] >= 2, ledger)
    expect(ledger["ledger"]["remaining_day"] <= ledger["ledger"]["limits"]["per_day"], ledger)
    expect(ledger["ledger"]["block_repeat_recipients"] is True, ledger)

    fresh = f"fresh.{stamp}@example.com"
    status, repeat = request("POST", "/api/campaigns", {
        "sender_id": "info", "subject": "Repeat guard", "html": "<p>Once</p>",
        "pace": {"delay_min_seconds": 0, "delay_max_seconds": 0, "batch_size": 10, "batch_pause_minutes": 0},
    }, token=user_token)
    expect(status == 200, repeat)
    repeat_id = repeat["campaign"]["id"]
    status, repeat_rows = request("POST", f"/api/campaigns/{repeat_id}/recipients", {
        "rows": [{"email": ada}, {"email": fresh}],
    }, token=user_token)
    expect(repeat_rows.get("already_sent") == 1 and repeat_rows.get("added") == 2, repeat_rows)
    status, repeat_start = request("POST", f"/api/campaigns/{repeat_id}/start", {}, token=user_token)
    expect(status == 200, repeat_start)
    repeat_done = wait_campaign(user_token, repeat_id, {"complete"}, 20)
    expect(repeat_done["sent_count"] == 1 and repeat_done["skipped_count"] == 1, repeat_done)

    status, master_repeat = request("POST", "/api/campaigns", {
        "sender_id": "info", "subject": "Other account", "html": "<p>No</p>",
        "pace": {"delay_min_seconds": 0, "delay_max_seconds": 0, "batch_size": 5, "batch_pause_minutes": 0},
    }, token=master_token)
    expect(status == 200, master_repeat)
    other_id = master_repeat["campaign"]["id"]
    status, other_rows = request("POST", f"/api/campaigns/{other_id}/recipients", {"rows": [{"email": ada}]}, token=master_token)
    expect(other_rows.get("already_sent") == 1, other_rows)
    status, other_start = request("POST", f"/api/campaigns/{other_id}/start", {}, token=master_token)
    expect(status == 400 and "already emailed" in other_start.get("error", ""), other_start)

    status, ledger_now = request("GET", "/api/ledger", token=master_token)
    used_today = ledger_now["ledger"]["sent_today"]
    expect(used_today > 0, ledger_now)
    capped = dict(original_ui)
    capped["global_daily_cap"] = used_today
    capped["block_repeat_recipients"] = True
    status, cap_saved = request("POST", "/api/master/ui", {"ui": capped}, token=master_token)
    expect(status == 200 and cap_saved["ui"]["global_daily_cap"] == used_today, cap_saved)
    status, capped_campaign = request("POST", "/api/campaigns", {
        "sender_id": "info", "subject": "Over the company cap", "html": "<p>Cap</p>",
        "pace": {"delay_min_seconds": 0, "delay_max_seconds": 0, "batch_size": 5, "batch_pause_minutes": 0},
    }, token=user_token)
    cap_id = capped_campaign["campaign"]["id"]
    request("POST", f"/api/campaigns/{cap_id}/recipients", {"rows": [{"email": f"cap.{stamp}@example.com"}]}, token=user_token)
    status, cap_start = request("POST", f"/api/campaigns/{cap_id}/start", {}, token=user_token)
    expect(status == 200, cap_start)
    held = None
    deadline = time.time() + 12
    while time.time() < deadline:
        status, reading = request("GET", f"/api/campaigns/{cap_id}", token=user_token)
        held = reading["campaign"]
        if "Company daily" in (held.get("hold_reason") or ""):
            break
        if held["status"] in ("complete", "killed"):
            break
        time.sleep(0.25)
    expect(held and "Company daily" in (held.get("hold_reason") or ""), held)
    request("POST", f"/api/campaigns/{cap_id}/control", {"action": "kill"}, token=master_token)
    status, cap_off = request("POST", "/api/master/ui", {"ui": original_ui}, token=master_token)
    expect(status == 200 and cap_off["ui"]["global_daily_cap"] == original_ui.get("global_daily_cap", 0), cap_off)

    status, ledger_again = request("GET", "/api/ledger", token=user_token)
    expect(ledger_again["ledger"]["unique_people"] >= 1, ledger_again)
    status, google = request("POST", "/api/auth/google", {"credential": "not-a-token"})
    expect(status == 400 and google.get("error"), google)
    status, health = request("GET", "/api/health")
    expect("google_client_id" in health, health)
    print("All relay checks passed.")


if __name__ == "__main__":
    try:
        main()
    except TestFailure as exc:
        raise SystemExit(f"SELFTEST FAILED: {exc}")
