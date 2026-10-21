"""Google Drive backup using a service account. Optional dependency: cryptography."""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
except ImportError:  # The relay still runs; Drive backup stays off.
    hashes = None
    serialization = None
    padding = None

_TOKENS = {}
_FOLDERS = {}
DRIVE_SCOPE = "https://www.googleapis.com/auth/drive"
SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly"


def cryptography_ready():
    return padding is not None


def _b64url(raw):
    import base64
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _request(url, token=None, data=None, headers=None, method=None):
    hdrs = dict(headers or {})
    if token:
        hdrs["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            body = response.read()
            if not body:
                return {}
            return json.loads(body.decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise RuntimeError(f"Drive HTTP {exc.code}: {detail}") from None


def _access_token(service_account, scope=DRIVE_SCOPE):
    slot = _TOKENS.setdefault(scope, {"value": "", "exp": 0})
    now = time.time()
    if slot["value"] and slot["exp"] - 60 > now:
        return slot["value"]
    if padding is None:
        raise RuntimeError("The cryptography package is not installed.")
    issued = int(now)
    header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode("utf-8"))
    claim = {
        "iss": service_account["client_email"],
        "scope": scope,
        "aud": "https://oauth2.googleapis.com/token",
        "iat": issued,
        "exp": issued + 3600,
    }
    payload = _b64url(json.dumps(claim).encode("utf-8"))
    signing_input = f"{header}.{payload}".encode("ascii")
    key = serialization.load_pem_private_key(service_account["private_key"].encode("utf-8"), password=None)
    signature = key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    assertion = signing_input.decode("ascii") + "." + _b64url(signature)
    form = urllib.parse.urlencode({
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "assertion": assertion,
    }).encode("utf-8")
    data = _request(
        "https://oauth2.googleapis.com/token",
        data=form,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    slot["value"] = data["access_token"]
    slot["exp"] = issued + int(data.get("expires_in") or 3600)
    return slot["value"]


def _read_url(url, token=None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=40) as response:
            return response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        raise RuntimeError(f"Sheet HTTP {exc.code}: {detail}") from None


def fetch_sheet_matrix(service_account, spreadsheet_id, gid=""):
    """Return rows from a Google Sheet shared with the service account."""
    token = _access_token(service_account, SHEETS_SCOPE)
    meta = _request(
        f"https://sheets.googleapis.com/v4/spreadsheets/{urllib.parse.quote(spreadsheet_id)}?fields=sheets.properties",
        token=token,
        method="GET",
    )
    title = ""
    for sheet in meta.get("sheets") or []:
        props = sheet.get("properties") or {}
        if not title:
            title = str(props.get("title") or "")
        if gid and str(props.get("sheetId")) == str(gid):
            title = str(props.get("title") or title)
            break
    if not title:
        title = "Sheet1"
    safe_title = title.replace("'", "''")
    quoted = urllib.parse.quote(f"'{safe_title}'!A:AZ", safe="")
    data = _request(
        f"https://sheets.googleapis.com/v4/spreadsheets/{urllib.parse.quote(spreadsheet_id)}/values/{quoted}",
        token=token,
        method="GET",
    )
    return data.get("values") or [], title


def _escape(value):
    return str(value).replace("\\", "\\\\").replace("'", "\\'")


def _ensure_folder(token, name, parent_id):
    cache_key = (parent_id or "", name)
    if cache_key in _FOLDERS:
        return _FOLDERS[cache_key]
    query = (
        f"name = '{_escape(name)}' and mimeType = 'application/vnd.google-apps.folder' "
        "and trashed = false"
    )
    if parent_id:
        query += f" and '{_escape(parent_id)}' in parents"
    url = "https://www.googleapis.com/drive/v3/files?" + urllib.parse.urlencode({
        "q": query,
        "fields": "files(id,name)",
        "pageSize": "1",
        "supportsAllDrives": "true",
        "includeItemsFromAllDrives": "true",
    })
    found = _request(url, token=token, method="GET")
    files = found.get("files") or []
    if files:
        _FOLDERS[cache_key] = files[0]["id"]
        return files[0]["id"]
    meta = {"name": name, "mimeType": "application/vnd.google-apps.folder"}
    if parent_id:
        meta["parents"] = [parent_id]
    created = _request(
        "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id",
        token=token,
        data=json.dumps(meta).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    _FOLDERS[cache_key] = created["id"]
    return created["id"]


def upload_file(local_path, service_account, folder_names, root_name="ParthMailing_Storage", parent_folder_id=""):
    """Upload a local file and return a browser link."""
    token = _access_token(service_account)
    parent = parent_folder_id or None
    folder_id = parent
    for name in [root_name, *folder_names]:
        folder_id = _ensure_folder(token, name, folder_id)
    filename = os.path.basename(local_path)
    boundary = "parth" + _b64url(os.urandom(8))
    meta = json.dumps({"name": filename, "parents": [folder_id]})
    with open(local_path, "rb") as handle:
        content = handle.read()
    body = (
        f"--{boundary}\r\n"
        "Content-Type: application/json; charset=UTF-8\r\n\r\n"
        f"{meta}\r\n"
        f"--{boundary}\r\n"
        "Content-Type: application/octet-stream\r\n\r\n"
    ).encode("utf-8") + content + f"\r\n--{boundary}--\r\n".encode("utf-8")
    created = _request(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink",
        token=token,
        data=body,
        headers={"Content-Type": f"multipart/related; boundary={boundary}"},
        method="POST",
    )
    return created.get("webViewLink") or f"https://drive.google.com/file/d/{created['id']}/view"


def ping(service_account, root_name="ParthMailing_Storage", parent_folder_id=""):
    """Create the storage root so the operator can confirm the service account works."""
    token = _access_token(service_account)
    folder_id = _ensure_folder(token, root_name, parent_folder_id or None)
    return {"folder_id": folder_id, "email": service_account.get("client_email", "")}
