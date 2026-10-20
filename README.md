# Parth Mailing

Liquid-glass mailing desk for `@gr-conferences.com`, with a local relay that keeps mailbox passwords on the machine that sends.

## Run it

1. Install Python 3.11 or newer.
2. Double-click `Start-Mailing-Suite.bat`, or run `python server.py` from the `backend` folder.
3. Open the address the relay prints, usually `http://127.0.0.1:8787/`.
4. Sign in with a `@gr-conferences.com` address. Until the master SMTP password is set, the 6-digit code appears on the sign-in screen and in the relay window. It expires in 5 minutes.
5. The master address in a fresh config is `vekariyaparth127@gmail.com`.

Edit `config/config.json` after the first launch:

- `master_emails`: who receives the Master desk.
- `master_smtp`: mailbox that sends sign-in codes.
- `senders`: identities people can request. The From address is always the authenticated mailbox.
- `dispatch_mode`: `auto` simulates any mailbox with a blank password and sends for real once a password is saved. Set `live` only after passwords are filled in.
- `default_limits`: per-minute, per-hour, per-day, batch size, and the optional UTC window.
- `google_drive`: set `enabled` to true and point `service_account_file` at a real service-account JSON. Share the Drive folder with that service account. Uploads go to `ParthMailing_Storage/Uploads/YYYY-MM-DD/` and reports go to `ParthMailing_Storage/Campaign_Reports/YYYY-MM-DD/`.

`pip install -r backend/requirements.txt` is only needed for Google Drive signing and for building the executable.

## What you can do

- Masters enable or disable accounts, approve sender requests, set limits, and pause, resume, or stop any live campaign.
- Users compose from approved senders only, in a docked window that can minimize or fill the screen.
- Spreadsheets parse in a worker. The on-screen list only draws the visible rows.
- Pace is the delay between messages plus a pause after each batch. Gmail mailboxes also keep a 24-hour cap.
- Each campaign can download `campaign_report.xlsx` with status, timestamp, SMTP code, and error.

## GitHub

The project repository is public (`parthgkrf-cell/parth-mailing`). Mailbox passwords, the live `config/config.json`, campaign files, and the relay database stay on this computer and are not committed.

Pushing `main` runs `.github/workflows/pages.yml` and publishes the static desk. In the repo, **Settings → Pages** should use Source **GitHub Actions**.

The workflow copies `frontend/index.html`, `app.js`, `style.css`, `worker.js`, and `xlsx.js`. A GitHub Pages site is HTTPS, and browsers block calls from it to a local `http://` relay. The supported desk is the page served by the relay itself at `http://127.0.0.1:8787/`.

## Locked executable

From `backend`, run `build_locked_binary.bat`. It writes `dist/relay_engine.exe` and `dist/Setup-Mailing-Agent.exe`. Give people that `dist` folder. They edit `config.json` next to the exe; the Python source stays with you. Code signing runs only if you add your own `signtool` certificate.
