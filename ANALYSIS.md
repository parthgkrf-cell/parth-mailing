# Parth Mailing — how the web app works

Super Admin (the master account) can test every mailbox from Master Panel → All Connected Accounts. Each row says working or not working, and a failure includes the SMTP reason (bad app password, connection refused, host not found, certificate rejected, or timeout).

Mailbox changes can be published as JSON on Google Drive or GitHub. In Master Panel → Gmail Policy, turn on “Live mailbox file” and paste the link. The server fetches that file about every 10 seconds. Every signed-in screen reloads the mailbox list about every 5 seconds, so a change reaches all users and admins without a manual refresh. Do not put app passwords in a public GitHub file. Use a Drive file shared as “anyone with the link”, or a private GitHub file. The shape is `config/accounts.sync.example.json`. A mailbox missing from an authoritative file is switched off, not deleted.

This document describes the React and Node web app started by `start.bat` and `start.ps1`. The same folder also contains an older Python mailing desk (`backend/server.py`, `frontend/index.html`). That older desk was not the app under test.

The web app is a local mailing desk. People sign in, a master admin connects Gmail mailboxes with Google app passwords, and users compose templates, import an Excel list, preview the merged message, and queue a campaign. A background worker sends one message at a time with a delay between sends.

Open the app at **http://127.0.0.1:5173**. The API is **http://127.0.0.1:5000**. Port 3000 on `127.0.0.1` is already taken on this computer by `EonVPNRoutingService`, so the old address did not answer. The dev server now listens on `127.0.0.1:5173`.

## How a click becomes an email

1. The browser loads the React app. Vite proxies every `/api` call to the Node server, so the browser never talks to port 5000 directly.
2. Sign-in returns a JSON Web Token. The browser stores it in `localStorage` under `parth_mailing_token` and sends it as `Authorization: Bearer …`.
3. Excel rows stay in the browser (`localStorage` key `parth_campaign_recipients`) until a campaign is queued. The server then stores the recipient list in SQLite.
4. Every five seconds the scheduler looks for campaigns whose time has arrived and whose status is `scheduled` or `sending`. It sends one recipient, waits the pacing delay, then looks again.
5. Each accepted send is written to `email_logs`, and that mailbox’s `sent_today` counter goes up by one in the database.

The database file is `backend/mailing.db`.

## Sign-in and accounts

| Function | Where | What it does |
| --- | --- | --- |
| Register | `POST /api/auth/register` | Creates a user with a bcrypt password hash. Password must be at least 6 characters and the email must look like an email. If Master Policy “requires approval” is on, the person cannot sign in until a master approves them. Otherwise they are signed in immediately. |
| Sign in | `POST /api/auth/login` | Checks the password. Disabled and not-yet-approved accounts are rejected. A valid login lasts 7 days. |
| Current user | `GET /api/auth/me` | Returns the signed-in profile. Used on every page load to restore the session. |
| Health | `GET /api/health` | Returns `ok` and the application name from Master Policy, so the header can show a renamed app. |

The first master account is created automatically if none exists. The email is `vekariyaparth127@gmail.com`. The starting password is still in `backend/database.js`. Change it. The launchers no longer print that password.

There is no screen to change a web-app password. That is listed under safety.

## Sending accounts

Only a master can add a mailbox (`POST /api/accounts`). The server strips spaces from the app password, refuses anything shorter than 8 characters, caps the daily limit at the Master Policy ceiling (never above 500), and only then asks Gmail whether the login works. A failed login is not saved.

| Function | What it does |
| --- | --- |
| List accounts | Masters see every mailbox. Other users see mailboxes they own plus mailboxes a master assigned to them. The app password is removed from the response and replaced with a mask such as `**** **** **** mnop`. |
| Test connection | Signs in to SMTP again and marks the mailbox `ready` or `error`. |
| Update | Changes the label, display name, on/off switch, daily cap, and, if a new password was typed, the app password. |
| Reset daily count | Master only. Sets `sent_today` back to 0. |
| Delete | Removes the mailbox. A user can delete a mailbox only if they own it or they are a master. |

Daily caps are counted in this app’s database. They are not Google’s live quota. A new calendar day (UTC date) resets the counter. Two sends at the same moment can no longer both write the same count: the counter is increased with `sent_today = sent_today + 1` after a fresh read.

## Composer, templates, and drafts

The Composer edits a named template: subject, HTML body, Cc, Bcc, and merge tags such as `{Name}`, `{Email}`, `{Affiliation}`, `{Sender}`, `{SenderName}`, `{Template}`, `{Date}`, `{Time}`, and `{Session}`.

| Function | What it does |
| --- | --- |
| List / save / update / delete template | Templates a master saves are shared (`is_shared = 1`). A normal user sees their own templates and shared ones, and can edit only their own. |
| Save draft | Stores the current subject, body, Cc, Bcc, and the imported recipient list. **This button did nothing before**, because the Composer ignored drafts. Edit on the Drafts page now loads that draft back into the Composer. |
| Queue campaign | Saves the template, then creates a campaign. The queue time defaults to five minutes from now. |

Excel import is local. Dropping a file works, and choosing the same file twice works again. Columns are matched by the header, not by a loose “contains” search, so a `BCC` column is no longer treated as `CC`, and `Sender Name` is no longer treated as the recipient’s name. A row whose email is not valid is counted as invalid and skipped. Addresses written as `Name <person@example.com>` are unwrapped.

If the Template column is empty, the sheet name is stored as the template name. At send time a saved template is used only when its name matches that value. A blank name no longer grabs the first template.

## Preview, tracking, and compliance

Preview asks `POST /api/emails/preview-merge`. The server fills merge tags for the chosen recipient and adds GA4 tags to `http` and `https` links. Tags are placed before the `#`, because GA4 ignores tags that sit after the hash. The preview strips `<script>`, `<iframe>`, inline event handlers, and `javascript:` URLs before drawing the HTML.

GA4 settings (`GET` and `POST /api/emails/ga4`) are global. Any signed-in user can read them. Only a master can save them. The Save button sends the text that is actually on screen. The old blur handler could save the previous value and drop the last character. The old “tag templates” button rewrote nothing; tags are applied when a message is sent, which is the right place, so that button now just saves the tracker.

`POST /api/emails/check-compliance` checks a message before send:

- Subject and body are required.
- At least one valid recipient is required.
- ALL CAPS subjects, repeated `!?$#`, and a short list of spam phrases become warnings, not hard blocks.
- The response includes a risk score and a letter grade. The grade is a local hint. It is not a Gmail verdict.

## Campaign queue and send now

`POST /api/emails/schedules` stores the campaign. The delay between messages cannot be shorter than Master Policy “minimum delay”. A mailbox id that the user is not allowed to use is rejected.

Pause only works while a campaign is `scheduled` or `sending`. Resume only works while it is `paused`. Doing either twice returns an error instead of a fake success. Delete returns 404 when the campaign is already gone. The queue page refreshes every five seconds.

`POST /api/emails/send-now` is the immediate path. More than 10 recipients are refused so a large list has to go through the paced queue. The Composer does not call send-now; only the API does. If one recipient fails, the others are still attempted and the response lists each result. The old code stopped on the first error and still described earlier sends as a total failure.

While sending, the scheduler:

- Claims the campaign with “status is still scheduled or sending”, so a pause is not overwritten.
- Uses only a mailbox that user is allowed to use. A sender name or mailbox id that does not match is not silently replaced by someone else’s mailbox.
- Pauses the whole campaign on a daily-limit or login failure, instead of failing every remaining row.
- Waits at least the Master Policy interval. A jitter of 0 adds no extra random wait. A non-zero jitter adds a random amount up to that many seconds.

## Dashboard, logs, and master panel

The dashboard shows sent-today against the daily cap, connected mailboxes, active campaigns, and drafts. The sent-today number now includes mailboxes assigned to the signed-in user, not only mailboxes they created. “Add Gmail account” is shown to masters only, because other users are sent away from that page.

Delivery logs are the signed-in user’s own rows, with search and a sent/failed filter. Search no longer crashes if a field is empty.

The master panel has four tabs:

| Tab | What it does |
| --- | --- |
| Users | Approve, suspend, change role, delete, and assign mailboxes. A master cannot suspend, demote, or delete their own account. |
| Policy | App name, daily ceiling (50–500), minimum delay (5–120 seconds), default jitter, approval required, and the unsubscribe header switch. Unknown keys are ignored. These values are now read by the sender. Before this pass they were saved and then ignored. |
| Fleet | Every mailbox, without app passwords. |
| Global logs | The latest sends for every user. |

Deleting a user also deletes their drafts, templates, campaigns, and logs because those tables use `ON DELETE CASCADE`.

## What was broken, and the retest

| Problem | Result after the fix |
| --- | --- |
| Master Policy (daily cap, minimum delay, app name, unsubscribe switch) was stored and never used | Delay, cap, app name, and the unsubscribe switch are applied. Covered by the API test. |
| Scheduler could send from a mailbox the user was not assigned | That fallback is gone. A foreign mailbox id is rejected. |
| A named sender that did not match fell through to a different mailbox | The row fails instead of changing sender. |
| Composer had no Save draft, and Edit Draft did not load the draft | Save draft works, and edit loads subject, body, Cc, and Bcc. Cc and Bcc are new draft columns. |
| GA4 save could drop the last character, and any user could overwrite global tracking | Save uses the current field values. Only a master can write. |
| “Tag templates” button did not change links | Removed. Links are tagged at send time. |
| Excel `BCC` could be read as `CC`, and `Sender Name` as the person’s name | Column matching uses the whole header. Covered by the parser test. |
| Dropping a file did nothing, and the same file could not be chosen twice | Drop works, and the file input resets. |
| Dashboard quota ignored assigned mailboxes | Stats use the mailboxes that user can send with. |
| Empty body was allowed | Compliance rejects it. |
| Send-now aborted the batch but earlier messages were already sent | Each recipient is reported on its own. |
| Daily counter could lose an increment if two sends overlapped | The database increments the stored number. |
| Pause and delete reported success even when nothing changed | They return 409 or 404. |
| A quota error failed the rest of the list one person at a time | The campaign pauses. |
| Unsubscribe advertised one-click unsubscribe with no web endpoint | Only a `mailto:` unsubscribe header is added, and only when the policy switch is on. |
| SMTP certificate checks were turned off | Certificate checks are back on. |
| Password and line breaks could be placed in the From or Subject header | Those characters are stripped before send. |
| A jitter of 0 still added up to one extra second | Zero jitter now waits exactly the base delay. |
| App name setting did not change the header | The header reads the name from `/api/health`. |
| `127.0.0.1:3000` did not serve the app | The UI is on `http://127.0.0.1:5173`. |

Automated check: `node function-test.js` from the `backend` folder. **74 of 74 passed** after the fixes. The run registers a temporary user, exercises templates, drafts, preview, a campaign dated year 2099, pause, resume, delete, approval, suspend, and role changes, then deletes that user and restores the app name, delay, and approval setting. It does not send a real email. The SMTP check points at `127.0.0.1` port 1 and expects “connection refused”.

The sign-in page and the create-account form were opened in the browser at `http://127.0.0.1:5173/`. The signed-in screens were exercised through the API. The browser tool refused to type the master password into the form, so those screens were not clicked by hand in this pass.

## Safety

What is in better shape now:

- Mailbox passwords are not sent back to the browser.
- A normal user cannot add a mailbox, reset a daily cap, change GA4, or open the master panel.
- A campaign cannot name a mailbox the user was not given.
- Login and registration errors do not reveal whether the failure was the email or the password (“Invalid email or password”).
- Unhandled server errors no longer return the internal exception text.
- The API accepts browser calls from localhost only.
- The database uses WAL mode and waits up to 5 seconds if a write is busy, so the scheduler and the API are less likely to collide.

What is still unsafe, and should be treated as unfinished:

1. **The master password is a known default in the source code.** Anyone with this project can sign in as master until it is changed. There is no change-password page.
2. **Gmail app passwords are stored in plain text** in `mailing.db`. Anyone who can read that file can send mail as those accounts. The file must stay off git and off shared disks. `.gitignore` already excludes it. The database is not encrypted.
3. **The token secret falls back to a fixed string** in `backend/middleware/auth.js` when `JWT_SECRET` is not set. With that default, anyone who has the source can forge a 7-day master token. Set `JWT_SECRET` in a `.env` file that is not committed.
4. **The token sits in `localStorage`.** A script injected into the page can read it. The preview strips the obvious script tags, but it is not a full HTML sanitizer.
5. **Registration is open by default** (`require_user_approval` is `0`). A new user cannot send until a mailbox is assigned, but they can create templates and drafts. Turn approval on if this computer is reachable by anyone else.
6. **There is no login rate limit.** A short password (6 characters) is allowed.
7. **Reset daily count** lets a master ignore the 450 cap. The cap is a local safety rail, not a lock.
8. **Send-now can still emit up to 10 messages with no delay.** The Composer does not expose it. The API does.
9. **The green “100% Google Policy” banner overclaims.** This app paces sends and stops near 500 a day. It does not check SPF, DKIM, DMARC, a real one-click unsubscribe URL, or Google’s actual remaining quota. The `mailto:` unsubscribe header is not the HTTPS one-click endpoint Gmail asks bulk senders to provide.
10. **Imported people are copied into `localStorage`.** On a shared Windows login, the recipient list remains after sign-out.
11. **Do not expose port 5000 or 5173 on a network.** The desk assumes it is alone on the machine.

## What to improve next

1. Add Change password for the master, and stop shipping a default password in source.
2. Turn on “new users need approval”, and require a longer password.
3. Set `JWT_SECRET` and encrypt mailbox app passwords with a key that is not in the database.
4. Replace the policy banner with the checks that actually run: daily cap, delay, and assigned mailboxes.
5. Add a real unsubscribe page before sending bulk mail, and keep the one-click header off until that page exists.
6. Let the master pause or stop any user’s campaign from the master panel. Today only the owner can pause their own queue.
7. Ask for confirmation with the recipient count before queueing.
8. When the Template column is blank, leave the template name blank instead of using the sheet name, so a template that happens to be named `Sheet1` cannot take over the message.
9. Offer “skip duplicate emails” on import.
10. Bundle the Excel parser instead of loading it from a CDN, so import works offline.
11. Clear the imported list from `localStorage` on sign-out.
12. Add a backup reminder for `mailing.db`. Losing that file loses the queue and the mailbox passwords.
13. Keep `node backend/function-test.js` as a regression check before the next change. It is safe to re-run: it does not send mail.
