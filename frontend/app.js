const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const ROW_HEIGHT = 46;
const TITLES = {
  home: ["Desk", "Sender access, relay status, and recent campaigns"],
  recipients: ["Import", "Upload Excel or fetch a Google Sheet. You can use only the mailing accounts approved for you."],
  compose: ["Composer", "Write the campaign. Merge tags and Excel templates personalize each send."],
  preview: ["Preview", "See the message as a recipient will receive it, including sender name."],
  campaigns: ["Campaigns", "Pace, pauses, and delivery counts"],
  history: ["History", "Reports and Drive links for finished campaigns"],
  config: ["Configuration", "Admin only. Add sending mailboxes, then assign them to users."],
  master: ["Admin", "Add mailing accounts with 16-digit app passwords, then approve users."],
};

const state = {
  token: localStorage.getItem("parth.token") || "",
  user: null,
  health: null,
  view: "home",
  catalog: [],
  campaigns: [],
  campSig: "",
  users: [],
  approvals: [],
  audit: [],
  monitor: null,
  recipients: [],
  seen: new Set(),
  filtered: [],
  recipientQuery: "",
  stats: { invalid: 0, duplicates: 0 },
  columns: new Set(["FirstName", "LastName", "Company", "Custom1", "Email", "Name", "Template", "Sender"]),
  sourceFiles: [],
  sheetUrl: "",
  importing: false,
  importCount: 0,
  attachments: [],
  draftId: localStorage.getItem("parth.draftId") || "",
  hasGrant: false,
  otpDeadline: 0,
  otpEmail: "",
  otpPurpose: "",
  authMode: "login",
  tracking: { enabled: false, source: "parth-mailing", medium: "email", campaign: "", term: "", content: "" },
  masterSenders: [],
  mailboxSheetUrl: "",
  previewIndex: 0,
  templates: [],
  activeTemplateId: "",
  modalResolve: null,
  sending: false,
  lastInteract: 0,
  ui: null,
  ledger: null,
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function icons() {
  if (window.lucide) window.lucide.createIcons();
}

function toast(message, kind) {
  const wrap = document.getElementById("toasts");
  const item = document.createElement("div");
  item.className = `toast glass ${kind || "ok"}`;
  item.textContent = message;
  wrap.appendChild(item);
  setTimeout(() => item.remove(), 4600);
}

function apiBase() {
  const field = document.getElementById("api-base");
  const value = (field && field.value.trim()) || localStorage.getItem("parth.apiBase") || defaultBase();
  return value.replace(/\/$/, "");
}

function defaultBase() {
  if (location.protocol.startsWith("http") && location.port === "8787") return location.origin;
  return "http://127.0.0.1:8787";
}

async function api(path, options) {
  const opts = options || {};
  const headers = Object.assign({}, opts.headers || {});
  if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  if (state.token) headers.Authorization = "Bearer " + state.token;
  let response;
  try {
    response = await fetch(apiBase() + path, {
      method: opts.method || "GET",
      headers,
      body: opts.body,
    });
  } catch (error) {
    throw new Error("Relay is not running at " + apiBase());
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    signOut(false);
    throw new Error(data.error || "Sign in required.");
  }
  if (!response.ok || data.ok === false) throw new Error(data.error || data.message || "Request failed.");
  return data;
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("parth.theme", theme);
  const color = document.getElementById("font-color");
  if (color && !state.user) color.value = theme === "light" ? "#101828" : "#f5f8fd";
  const toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.title = theme === "light" ? "Switch to dark" : "Switch to light";
    toggle.innerHTML = theme === "light" ? '<i data-lucide="moon"></i>' : '<i data-lucide="sun"></i>';
    icons();
  }
}

function setComposerMode(mode) {
  const composer = document.getElementById("composer");
  composer.classList.remove("hidden", "is-min", "is-dock", "is-max");
  if (mode === "hidden") composer.classList.add("hidden");
  else composer.classList.add("is-" + mode);
}

function openModal(html) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `<div class="modal-card glass" role="dialog">${html}</div>`;
  root.classList.remove("hidden");
  icons();
}

function closeModal() {
  const root = document.getElementById("modal-root");
  root.classList.add("hidden");
  root.innerHTML = "";
}

function askConfirm(title, body, label) {
  return new Promise((resolve) => {
    state.modalResolve = resolve;
    openModal(
      `<h3>${esc(title)}</h3><p>${esc(body)}</p>
      <div class="row"><button class="btn btn-ghost" type="button" data-action="modal-cancel">Cancel</button>
      <button class="btn btn-primary" type="button" data-action="modal-ok">${esc(label || "Confirm")}</button></div>`
    );
  });
}

function askText(title, placeholder) {
  return new Promise((resolve) => {
    state.modalResolve = resolve;
    state.modalMode = "text";
    openModal(
      `<h3>${esc(title)}</h3><input id="modal-input" class="input" placeholder="${esc(placeholder || "")}">
      <div class="row"><button class="btn btn-ghost" type="button" data-action="modal-cancel">Cancel</button>
      <button class="btn btn-primary" type="button" data-action="modal-submit">Add</button></div>`
    );
    setTimeout(() => {
      const input = document.getElementById("modal-input");
      if (input) input.focus();
    }, 30);
  });
}

function finishModal(value) {
  const resolve = state.modalResolve;
  state.modalResolve = null;
  state.modalMode = "";
  closeModal();
  if (resolve) resolve(value);
}

function normalizeEmail(value) {
  let text = String(value || "").replace(/\u00a0/g, "").trim().toLowerCase();
  const wrapped = text.match(/<([^>]+)>/);
  if (wrapped) text = wrapped[1].trim().toLowerCase();
  return text;
}

function stamp(unix) {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString();
}

function statusBadge(status) {
  const kind = status === "complete" || status === "SENT" || status === "approved" ? "ok"
    : status === "failed" || status === "FAILED" || status === "killed" || status === "denied" || status === "not delivered" ? "danger"
      : "warn";
  return `<span class="badge ${kind}">${esc(status)}</span>`;
}

function safeUrl(url) {
  return /^https:\/\//i.test(url || "") ? url : "";
}

function isMasterUser() {
  const role = String((state.user && state.user.role) || "").trim().toLowerCase();
  return role === "role_master" || role === "master" || role === "admin";
}

function hideAdminNavForUsers() {
  const master = isMasterUser();
  document.body.classList.toggle("is-master", master);
  document.querySelectorAll(".master-only").forEach((button) => {
    button.classList.toggle("hidden", !master);
    button.toggleAttribute("hidden", !master);
    button.setAttribute("aria-hidden", master ? "false" : "true");
  });
  if (!master && (state.view === "master" || state.view === "config")) state.view = "home";
}

function paintChrome() {
  const title = (TITLES[state.view] || TITLES.home).slice();
  const labels = (state.ui && state.ui.labels) || {};
  if (state.view === "home" && state.ui) {
    title[0] = state.ui.welcome_title || title[0];
    title[1] = state.ui.welcome_text || title[1];
  } else if (labels[state.view]) {
    title[0] = labels[state.view];
  }
  document.getElementById("view-title").textContent = title[0];
  document.getElementById("view-sub").textContent = title[1];
  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.view);
    const span = button.querySelector("span");
    if (button.dataset.view === "master") span.textContent = "Admin";
    else if (span && labels[button.dataset.view]) span.textContent = labels[button.dataset.view];
  });
  const composeLabel = document.querySelector("#compose-button span");
  if (composeLabel && labels.compose) composeLabel.textContent = labels.compose;
  hideAdminNavForUsers();
  const who = document.getElementById("whoami");
  if (who && state.user) who.textContent = state.user.display_name || (isMasterUser() ? "Admin" : "User");
  const pill = document.getElementById("relay-pill");
  if (pill && state.health) {
    pill.textContent = state.health.otp_delivery === "email" ? "Live SMTP" : "Simulation";
  }
  const chip = document.getElementById("import-chip");
  if (chip) {
    chip.classList.toggle("hidden", !state.importing);
    chip.textContent = `Reading ${state.importCount.toLocaleString()} rows`;
  }
  applyDesk();
}

function renderView() {
  applyDesk();
  const root = document.getElementById("view");
  const views = {
    home: htmlHome,
    recipients: htmlRecipients,
    compose: htmlCompose,
    preview: htmlPreview,
    campaigns: htmlCampaigns,
    history: htmlHistory,
    config: htmlConfig,
    master: htmlMaster,
  };
  root.innerHTML = (views[state.view] || htmlHome)();
  paintChrome();
  icons();
  if (state.view === "recipients") mountRecipients();
  if (state.view === "compose") setComposerMode("dock");
  if (state.view === "preview") paintFullPreview();
}

function htmlHome() {
  const approved = state.catalog.filter((sender) => sender.status === "approved");
  const pending = state.catalog.filter((sender) => sender.status === "pending");
  const ledger = state.ledger || {};
  const limits = ledger.limits || {};
  const banner = state.ui && state.ui.banner
    ? `<section class="card glass"><p>${esc(state.ui.banner)}</p></section>`
    : "";
  const recent = state.campaigns.slice(0, 4).map(campaignCard).join("") || `<div class="card glass"><p>No campaigns yet.</p></div>`;
  const senders = state.catalog.map((sender) => `
    <div class="spread">
      <div><strong>${esc(sender.display_name || sender.email || "Mailbox")}</strong><div class="hint">${esc(sender.email || "")}</div></div>
      <div class="row">
        ${statusBadge(sender.status)}
        ${sender.status === "approved" || isMasterUser() ? "" : sender.status === "pending"
          ? `<span class="hint">Waiting on admin</span>`
          : `<button class="btn btn-ghost" type="button" data-action="request-sender" data-id="${esc(sender.id)}">Request this email</button>`}
      </div>
    </div>`).join("") || `<p>${isMasterUser() ? "Add sending emails in Configuration." : "No sending emails are listed yet. Type the mailbox you need below."}</p>`;
  const requestBox = isMasterUser() ? "" : `
    <label>Request a sending email
      <input id="request-mailbox" class="input" placeholder="sales@gr-conferences.com">
    </label>
    <div class="row"><button class="btn btn-primary" type="button" data-action="request-mailbox">Send request to admin</button></div>
    <p class="hint">You can send and draft only from mailboxes approved for this account. Admin is notified when you request another one.</p>`;
  const company = ledger.company_daily_cap
    ? `<article class="card glass stat"><span class="hint">Company left today</span><strong>${Number(ledger.company_remaining || 0).toLocaleString()}</strong><span class="hint">Shared ceiling ${Number(ledger.company_daily_cap).toLocaleString()}</span></article>`
    : "";
  return `
    ${banner}
    <div class="stat-grid">
      <article class="card glass stat"><span class="hint">All sent and stored</span><strong>${Number(ledger.sent_total || 0).toLocaleString()}</strong><span class="hint">This account ${Number(ledger.mine_total || 0).toLocaleString()} · ${Number(ledger.used_day || 0).toLocaleString()} in 24 hours</span></article>
      <article class="card glass stat"><span class="hint">Left today</span><strong>${ledger.remaining_day == null ? "—" : Number(ledger.remaining_day).toLocaleString()}</strong><span class="hint">of ${Number(limits.per_day || 0).toLocaleString()} for this account</span></article>
      <article class="card glass stat"><span class="hint">People already emailed</span><strong>${Number(ledger.unique_people || 0).toLocaleString()}</strong><span class="hint">${ledger.block_repeat_recipients === false ? "Repeat sends are allowed" : "A second email is blocked"}</span></article>
      ${company}
      <article class="card glass stat"><span class="hint">Approved senders</span><strong>${approved.length}</strong></article>
      <article class="card glass stat"><span class="hint">Waiting on admin</span><strong>${pending.length}</strong></article>
    </div>
    <p class="hint">These counts live in the relay database. Closing the browser or the app does not reset them, and another account cannot send a second message to someone already emailed.</p>
    <section class="card glass stack"><h3>Sending emails</h3>${senders}${requestBox}</section>
    <section class="stack"><h3>Recent campaigns</h3>${recent}</section>`;
}

function htmlRecipients() {
  return `
    <section class="card glass stack">
      <div class="spread">
        <h3>Import Excel or Google Sheet</h3>
        <button class="btn btn-ghost" type="button" data-action="download-sample">Sample CSV</button>
      </div>
      <label>Google Sheet link
        <input id="sheet-url" class="input" placeholder="https://docs.google.com/spreadsheets/d/…" value="${esc(state.sheetUrl || "")}">
      </label>
      <div class="row">
        <button class="btn btn-primary" type="button" data-action="fetch-sheet">Fetch sheet</button>
      </div>
      <p class="hint">Use columns Email, Name, Template, Sender Name, Account Email, S_Date, and S_Time. S_Date and S_Time set when Start Scheduling sends each row. Account Email must be a mailbox this login is allowed to use. Other mailing accounts in the sheet are left out.${state.health && state.health.drive && state.health.drive.client_email ? ` Share a private sheet with ${esc(state.health.drive.client_email)}.` : ""}</p>
      <div id="dropzone" class="dropzone">
        <p>Or drop .xlsx, .xls, or .csv files here</p>
        <p class="hint">In the message, {Affiliation} uses that column’s name and {E} uses column E. The same works for every Excel column.</p>
        <button class="btn btn-primary" type="button" data-action="browse-excel">Browse files</button>
        <input id="excel-input" class="hidden" type="file" accept=".xlsx,.xls,.csv,.txt" multiple>
      </div>
      <div class="row">
        <label class="check-line"><input type="radio" name="import-mode" value="append" checked> Append</label>
        <label class="check-line"><input type="radio" name="import-mode" value="replace"> Replace</label>
      </div>
      <label>Quick add<textarea id="quick-add" class="input" rows="3" placeholder="one@example.com, two@example.com"></textarea></label>
      <div class="row">
        <button class="btn btn-ghost" type="button" data-action="add-emails">Add recipients</button>
        <button class="btn btn-ghost" type="button" data-action="clear-recipients">Clear list</button>
      </div>
      <div class="row">
        <span class="pill" id="stat-valid">${state.recipients.length.toLocaleString()} ready</span>
        <span class="pill">${state.stats.invalid.toLocaleString()} invalid</span>
        <span class="pill">${state.stats.duplicates.toLocaleString()} duplicates removed</span>
      </div>
    </section>
    <section class="card glass">
      <div class="spread">
        <h3>Recipient window</h3>
        <input id="recipient-search" class="input" style="max-width:260px" placeholder="Search" value="${esc(state.recipientQuery)}">
      </div>
      <div class="vhead"><span>#</span><span>Email</span><span>Name</span><span>Company</span><span>Template</span><span>Sender name</span></div>
      <div class="vscroll" id="recipient-scroller"><div id="recipient-spacer"><div id="recipient-rows"></div></div></div>
    </section>`;
}

function fieldOf(row, ...names) {
  const fields = row && row.fields ? row.fields : {};
  const lowered = {};
  Object.keys(fields).forEach((key) => { lowered[key.toLowerCase()] = fields[key]; });
  for (const name of names) {
    const value = lowered[String(name).toLowerCase()];
    if (String(value || "").trim()) return String(value).trim();
  }
  return "";
}

function htmlCompose() {
  const approved = state.catalog.filter((sender) => sender.status === "approved");
  return `
    <section class="card glass stack">
      <h3>Composer</h3>
      <p class="hint">SMTP Draft saves every message to the selected mailbox Drafts folder. SMTP Send delivers one by one under Gmail policy. If you have more than one assigned mailbox, Send threads them in parallel.</p>
      <p class="hint">${approved.length ? `Approved mailboxes: ${approved.map((item) => item.display_name || "Mailbox").join(", ")}` : "No sending mailbox yet. Ask the admin to assign one to your name."}</p>
      <div class="row">
        <button class="btn btn-primary" type="button" data-action="open-composer">Open composer</button>
        <button class="btn btn-ghost" type="button" data-action="nav" data-view="preview">Open preview</button>
      </div>
    </section>`;
}

function htmlPreview() {
  const rows = mergedRecipients();
  const options = rows.slice(0, 400).map((row, index) => {
    const label = `${row.email}${row.first_name ? " · " + row.first_name : ""}`;
    return `<option value="${index}" ${index === state.previewIndex ? "selected" : ""}>${esc(label)}</option>`;
  }).join("");
  return `
    <section class="card glass stack">
      <h3>Recipient preview</h3>
      <p class="hint">Pick a row from the imported Excel list. Sender name comes from the Sender Name column when present.</p>
      <label>Recipient
        <select id="preview-pick" class="input">${options || "<option>Import Excel first</option>"}</select>
      </label>
      <p id="preview-meta" class="hint"></p>
      <iframe id="preview-frame" class="preview-frame" title="Message preview"></iframe>
    </section>`;
}

function blankSender() {
  return {
    id: "",
    email: "",
    display_name: "",
    host: "smtp.gmail.com",
    port: 465,
    secure: "ssl",
    user: "",
    has_password: false,
    daily_cap: "",
  };
}

function compactAppPassword(value) {
  return String(value || "").replace(/[\s-]+/g, "");
}

function readSenderCard(card) {
  const email = (card.querySelector("[data-sender-email]") || {}).value || "";
  return {
    id: (card.querySelector("[data-sender-id]") || {}).value || "",
    display_name: (card.querySelector("[data-sender-name]") || {}).value || "",
    email,
    user: (card.querySelector("[data-sender-user]") || {}).value || email,
    host: (card.querySelector("[data-sender-host]") || {}).value || "smtp.gmail.com",
    port: Number((card.querySelector("[data-sender-port]") || {}).value || 465),
    secure: (card.querySelector("[data-sender-secure]") || {}).value || "ssl",
    password: (card.querySelector("[data-sender-password]") || {}).value || "",
    has_password: (card.querySelector("[data-sender-saved]") || {}).value === "1",
    daily_cap: Number((card.querySelector("[data-sender-cap]") || {}).value || 0),
  };
}

function readSenderCards() {
  return [...document.querySelectorAll("[data-sender-card]")].map(readSenderCard).filter((item) => String(item.email || "").trim());
}

function htmlSenderCard(sender, index, open) {
  const item = sender || blankSender();
  const title = item.display_name || item.email || "Mailbox";
  return `
    <article class="card glass stack sender-card${open ? " is-open" : ""}" data-sender-card>
      <button class="sender-toggle" type="button" data-action="toggle-sender-card" aria-expanded="${open ? "true" : "false"}" title="${open ? "Hide mailbox" : "Show mailbox"}">
        <span class="chev" aria-hidden="true">&gt;</span>
        <span class="sender-toggle-text"><strong>${esc(title)}</strong><span class="hint">${esc(item.email || "No email yet")}</span></span>
      </button>
      <div class="sender-body${open ? "" : " hidden"}">
      <input type="hidden" data-sender-id value="${esc(item.id || "")}">
      <input type="hidden" data-sender-saved value="${item.has_password ? "1" : "0"}">
      <div class="config-grid">
        <label>From name<input class="input" data-sender-name value="${esc(item.display_name || "")}" placeholder="Parth Mailing"></label>
        <label>Mailing email<input class="input" data-sender-email value="${esc(item.email || "")}" placeholder="send@gr-conferences.com"></label>
        <label>Daily limit<input class="input" data-sender-cap type="number" min="1" max="1800" value="${esc(item.daily_cap || item.provider_cap || "")}" placeholder="400 Gmail / 1800 Workspace"></label>
      </div>
      <label>16-digit Google app password<input class="input" data-sender-password type="text" autocomplete="off" spellcheck="false" maxlength="19" placeholder="${item.has_password ? "Saved on this computer. Paste a new 16-digit code only to replace it." : "xxxx xxxx xxxx xxxx"}"></label>
      <details>
        <summary class="hint">SMTP host (leave default for Gmail / Workspace)</summary>
        <div class="config-grid" style="margin-top:12px">
          <label>SMTP username<input class="input" data-sender-user value="${esc(item.user || item.email || "")}" placeholder="same as mailing email"></label>
          <label>SMTP host<input class="input" data-sender-host value="${esc(item.host || "smtp.gmail.com")}"></label>
          <label>Port<input class="input" data-sender-port type="number" min="1" max="65535" value="${esc(item.port || 465)}"></label>
          <label>Security
            <select class="input" data-sender-secure>
              <option value="ssl" ${item.secure === "ssl" || !item.secure ? "selected" : ""}>SSL (465)</option>
              <option value="tls" ${item.secure === "tls" ? "selected" : ""}>TLS (587)</option>
              <option value="none" ${item.secure === "none" ? "selected" : ""}>None</option>
            </select>
          </label>
        </div>
      </details>
      <div class="row">
        <button class="btn btn-ghost" type="button" data-action="test-config-sender" data-index="${index}">Test mailbox</button>
        <button class="btn btn-danger" type="button" data-action="remove-sender-card">Remove</button>
      </div>
      </div>
    </article>`;
}

function htmlMailboxSetup() {
  const rows = (state.masterSenders && state.masterSenders.length) ? state.masterSenders : [blankSender()];
  return `
    <section class="card glass stack" id="mailbox-setup">
      <h3>Mailing accounts</h3>
      <p class="hint">Paste the Google Sheet with columns Label, Email, Password, Host, Port, and Secure. Passwords stay on this computer. If a mailbox stops working, fetch the sheet again or press Test mailbox and the latest row is loaded.</p>
      <label>Mailbox Google Sheet
        <input id="mailbox-sheet-url" class="input" placeholder="https://docs.google.com/spreadsheets/d/…" value="${esc(state.mailboxSheetUrl || "")}">
      </label>
      <div class="row">
        <button class="btn btn-primary" type="button" data-action="fetch-mailbox-sheet">Fetch mailing accounts</button>
      </div>
      <div id="sender-list" class="stack">${rows.map((item, index) => htmlSenderCard(item, index)).join("")}</div>
      ${rows.length > 3 ? `<button class="btn btn-ghost sender-more" type="button" data-action="toggle-sender-more" aria-expanded="false" title="Show more mailing accounts"><span class="chev" aria-hidden="true">&gt;</span><span class="more-label">Show more</span></button>` : ""}
      <div class="row">
        <button class="btn btn-ghost" type="button" data-action="add-sender-card">Add another mailbox</button>
        <button class="btn btn-primary" type="button" data-action="save-senders">Save mailing accounts</button>
      </div>
    </section>`;
}

function htmlConfig() {
  if (!isMasterUser()) return `<section class="card glass"><p>Only the admin can set sending emails.</p></section>`;
  const tracking = state.tracking || {};
  return `
    ${htmlMailboxSetup()}
    <section class="card glass stack">
      <h3>GA4 link tagging</h3>
      <p class="hint">UTM tags are added to http(s) links in the campaign before the # fragment, then used on every send.</p>
      <label class="check-line"><input id="ga4-enabled" type="checkbox" ${tracking.enabled ? "checked" : ""}> Tag links on send</label>
      <div class="config-grid">
        <label>utm_source<input id="ga4-source" class="input" value="${esc(tracking.source || "")}" placeholder="parth-mailing"></label>
        <label>utm_medium<input id="ga4-medium" class="input" value="${esc(tracking.medium || "email")}" placeholder="email"></label>
        <label>utm_campaign<input id="ga4-campaign" class="input" value="${esc(tracking.campaign || "")}" placeholder="october-invite"></label>
        <label>utm_term<input id="ga4-term" class="input" value="${esc(tracking.term || "")}"></label>
        <label>utm_content<input id="ga4-content" class="input" value="${esc(tracking.content || "")}"></label>
      </div>
      <label>Test URL<input id="ga4-test-url" class="input" placeholder="https://example.com/page#hero"></label>
      <div class="row">
        <button class="btn btn-primary" type="button" data-action="save-ga4">Save tagging</button>
        <button class="btn btn-ghost" type="button" data-action="tag-composer">Tag links in composer</button>
        <button class="btn btn-ghost" type="button" data-action="copy-tagged">Copy tagged test URL</button>
      </div>
      <p id="ga4-sample" class="hint"></p>
    </section>`;
}

function campaignCard(campaign) {
  const skipped = campaign.skipped_count || 0;
  const drafted = campaign.drafted_count || 0;
  const done = (campaign.sent_count || 0) + (campaign.failed_count || 0) + (campaign.bounced_count || 0) + skipped + drafted;
  const pct = campaign.total_count ? Math.min(100, Math.round((done / campaign.total_count) * 100)) : 0;
  const mode = campaign.dispatch_action === "draft" ? "SMTP Draft (IMAP)" : "SMTP Send";
  const upload = safeUrl(campaign.drive_upload_url);
  const report = safeUrl(campaign.drive_report_url);
  const active = ["running", "paused", "scheduled"].includes(campaign.status);
  const undelivered = !(campaign.sent_count || campaign.drafted_count) && ((campaign.failed_count || 0) + (campaign.bounced_count || 0)) > 0;
  return `
    <article class="card glass stack">
      <div class="spread">
        <div><strong>${esc(campaign.subject || "Untitled")}</strong><div class="hint">${esc(mode)}</div></div>
        ${undelivered ? statusBadge("not delivered") : statusBadge(campaign.status)}
      </div>
      <div class="bar"><span style="width:${pct}%"></span></div>
      <div class="hint">${campaign.sent_count || 0} sent · ${drafted} drafted · ${campaign.failed_count || 0} failed · ${campaign.bounced_count || 0} bounced · ${skipped} already emailed · ${campaign.total_count || 0} total</div>
      ${campaign.hold_reason && campaign.hold_reason !== campaign.last_error ? `<div class="note">${esc(campaign.hold_reason)}</div>` : ""}
      ${(campaign.last_error || ((campaign.failed_count || campaign.bounced_count) && campaign.hold_reason)) ? `<p class="fail-reason"><strong>Failed:</strong> ${esc(campaign.last_error || campaign.hold_reason)}</p>` : ""}
      ${campaign.schedule_at ? `<div class="hint">Scheduled ${esc(stamp(campaign.schedule_at))} (${esc(campaign.timezone)})</div>` : ""}
      <div class="row">
        ${active && campaign.status !== "paused" ? `<button class="btn btn-warn" type="button" data-action="campaign-control" data-op="pause" data-id="${esc(campaign.id)}">Pause</button>` : ""}
        ${campaign.status === "paused" ? `<button class="btn btn-primary" type="button" data-action="campaign-control" data-op="resume" data-id="${esc(campaign.id)}">Resume</button>` : ""}
        ${active ? `<button class="btn btn-danger" type="button" data-action="campaign-control" data-op="kill" data-id="${esc(campaign.id)}">Stop</button>` : ""}
        <button class="btn btn-ghost" type="button" data-action="download-report" data-id="${esc(campaign.id)}">campaign_report.xlsx</button>
        <button class="btn btn-ghost" type="button" data-action="open-campaign" data-id="${esc(campaign.id)}">Details</button>
        ${upload ? `<a class="btn btn-ghost" href="${esc(upload)}" target="_blank" rel="noopener">Drive upload</a>` : ""}
        ${report ? `<a class="btn btn-ghost" href="${esc(report)}" target="_blank" rel="noopener">Drive report</a>` : ""}
      </div>
    </article>`;
}

function htmlCampaigns() {
  const rows = state.campaigns.filter((item) => {
    if (!["complete", "killed"].includes(item.status)) return true;
    return (item.failed_count || 0) + (item.bounced_count || 0) > 0;
  });
  return `<section class="stack">${rows.map(campaignCard).join("") || `<div class="card glass"><p>No active campaigns.</p></div>`}</section>`;
}

function htmlHistory() {
  const rows = state.campaigns.filter((item) => ["complete", "killed"].includes(item.status));
  return `<section class="stack">${rows.map(campaignCard).join("") || `<div class="card glass"><p>Finished campaigns will land here with their report.</p></div>`}</section>`;
}

function htmlMaster() {
  if (!isMasterUser()) return "";
  const query = state.userQuery || "";
  const senderOptions = state.catalog.map((sender) => `<option value="${esc(sender.id)}">${esc(sender.display_name || sender.email || sender.id)}</option>`).join("");
  const users = state.users.filter((user) => !query || `${user.display_name || ""} ${user.email}`.toLowerCase().includes(query.toLowerCase())).map((user) => `
    <div class="spread">
      <div><strong>${esc(user.display_name || (user.email === adminEmail() ? "Admin" : "User"))}</strong><div class="hint">${esc(user.email)} · ${user.sent_total || 0} stored · ${user.sent_today} in 24h · ${user.password_set ? "password set" : "needs OTP"}</div></div>
      <div class="row">
        <select class="input" style="max-width:180px" data-assign-select="${esc(user.email)}">${senderOptions}</select>
        <button class="btn btn-primary" type="button" data-action="assign-sender" data-email="${esc(user.email)}">Give mailbox</button>
        <button class="switch ${user.enabled ? "on" : ""}" type="button" data-action="toggle-user" data-email="${esc(user.email)}" data-enabled="${user.enabled}" aria-label="Enable account"></button>
        <button class="btn btn-ghost" type="button" data-action="edit-limits" data-email="${esc(user.email)}">Limits</button>
        ${user.email === adminEmail() ? "" : `<button class="btn btn-danger" type="button" data-action="remove-user" data-email="${esc(user.email)}">Remove</button>`}
      </div>
    </div>`).join("") || `<p>No accounts yet.</p>`;
  const approvals = state.approvals.filter((item) => item.status === "pending").map((item) => `
    <div class="spread">
      <div><strong>${esc(accountLabel(item.email))}</strong><div class="hint">Request access to ${esc(item.sender_email || "a mailbox")}</div></div>
      <div class="row">
        <input class="input" style="max-width:120px" data-cap="${item.id}" type="number" min="1" placeholder="Max / day" value="${esc(item.daily_cap || "")}">
        <button class="btn btn-primary" type="button" data-action="decide" data-op="approve" data-id="${item.id}">Approve</button>
        <button class="btn btn-danger" type="button" data-action="decide" data-op="deny" data-id="${item.id}">Deny</button>
      </div>
    </div>`).join("") || `<p>The approval queue is clear.</p>`;
  const live = ((state.monitor && state.monitor.campaigns) || []).map(campaignCard).join("") || `<p>No live queues.</p>`;
  const boxes = ((state.monitor && state.monitor.mailboxes) || []).map((box) => `
    <article class="card glass stat"><span class="hint">Internal mailbox</span><strong>${box.remaining}</strong><span class="hint">${box.used_24h} of ${box.cap_24h} in 24h · ${box.live ? "live" : "simulated"}</span></article>`).join("");
  const audit = state.audit.slice(0, 30).map((item) => `
    <div class="hint">${esc(stamp(item.created_at))} · ${esc(maskAddress(item.actor))} · ${esc(item.action)} · ${esc(maskAddress(item.detail || ""))}</div>`).join("") || `<p>No audit events yet.</p>`;
  const drive = (state.health && state.health.drive) || {};
  return `
    ${htmlMailboxSetup()}
    <section class="card glass stack" id="admin-setup">
      <h3>Work setup</h3>
      <h3>Sign-in email</h3>
      ${state.health && state.health.otp_error
        ? `<p class="note">${esc(state.health.otp_error)}</p>`
        : state.health && state.health.otp_ready
        ? `<p class="note">Sign-in codes are emailed from ${esc((state.health && state.health.otp_from) || "parth@gr-conferences.com")}.</p>`
        : `<p class="hint">In the Google account for ${esc((state.health && state.health.otp_from) || "parth@gr-conferences.com")}, open Security, then App passwords, and create one for Mail. Paste that 16-character password here. It stays on this computer.</p>`}
      <label>App password<input id="otp-app-password" class="input" type="password" autocomplete="new-password" placeholder="${state.health && state.health.otp_ready ? "Already saved. Paste a new one only to replace it." : "xxxx xxxx xxxx xxxx"}"></label>
      <div class="row"><button class="btn btn-primary" type="button" data-action="save-otp-password">Save app password</button><button class="btn btn-ghost" type="button" data-action="test-master-smtp">Test sign-in mailbox</button></div>
      <h3>Google Drive</h3>
      <p class="hint">${esc(drive.reason || "Drive backup is off.")}${drive.client_email ? " Share the Drive folder with the service account." : ""}</p>
      <label class="check-line"><input id="drive-enabled" type="checkbox" ${drive.enabled ? "checked" : ""}> Turn on Drive backup</label>
      <label>Storage folder name<input id="drive-name" class="input" maxlength="80" value="${esc(drive.folder_name || "ParthMailing_Storage")}"></label>
      <label>Drive folder ID<input id="drive-folder" class="input" spellcheck="false" placeholder="From the folder URL, after /folders/" value="${esc(drive.parent_folder_id || "")}"></label>
      <label>Service account JSON<textarea id="drive-json" class="input" rows="4" spellcheck="false" placeholder="Paste the JSON key here, or leave this empty to keep the saved key."></textarea></label>
      <div class="row">
        <button class="btn btn-primary" type="button" data-action="save-drive">Save Drive</button>
        <button class="btn btn-ghost" type="button" data-action="test-drive">Test Drive</button>
      </div>
    </section>
    <div class="stat-grid">${boxes}</div>
    <section class="card glass stack"><div class="spread"><h3>Accounts</h3><input id="user-search" class="input" style="max-width:240px" placeholder="Filter" value="${esc(query)}"></div>${users}</section>
    <section class="card glass stack"><h3>Access approval queue</h3>${approvals}</section>
    <section class="stack"><div class="spread"><h3>Live queues</h3></div>${live}</section>
    <section class="card glass stack"><h3>Audit</h3>${audit}</section>
    <section class="card glass stack">
      <h3>Google sign-in</h3>
      <p class="hint">Create a Web client in Google Cloud, then paste its client ID. Add this relay address as an authorized JavaScript origin. Only Google accounts on ${esc((state.health && state.health.domain) || "@gr-conferences.com")} can sign in.</p>
      <label>Client ID<input id="google-client" class="input" spellcheck="false" placeholder="numbers-letters.apps.googleusercontent.com" value="${esc((state.health && state.health.google_client_id) || "")}"></label>
      <div class="row"><button class="btn btn-primary" type="button" data-action="save-google">Save Google sign-in</button></div>
    </section>
    ${htmlDeskForm()}`;
}

function htmlDeskForm() {
  const ui = state.ui || {};
  const labels = ui.labels || {};
  const checks = [
    ["show_desk", "Desk"],
    ["show_recipients", "Recipients"],
    ["show_campaigns", "Campaigns"],
    ["show_history", "History"],
    ["show_compose", "Composer"],
    ["show_preview", "Preview"],
    ["show_pace", "Pace controls"],
    ["show_schedule", "Scheduler"],
    ["show_attachments", "Attachments"],
    ["show_cc", "Cc and Bcc"],
    ["show_variables", "Variable buttons"],
    ["allow_theme_toggle", "Theme toggle"],
    ["block_repeat_recipients", "Block a second email to the same person"],
  ];
  const boxes = checks.map(([key, label]) => `
    <label class="check-line"><input type="checkbox" data-desk="${key}" ${ui[key] === false ? "" : "checked"}> ${esc(label)}</label>`).join("");
  return `
    <section class="card glass stack" id="desk-form">
      <h3>User desk</h3>
      <p class="hint">These choices are stored on the relay. They stay in place after the app is closed and apply to every signed-in user. Admin keeps the full desk.</p>
      <div class="desk-grid">
        <label>Brand name<input id="desk-brand" class="input" maxlength="40" value="${esc(ui.brand_name || "Parth")}"></label>
        <label>Tagline<input id="desk-tagline" class="input" maxlength="60" value="${esc(ui.brand_tagline || "Mailing")}"></label>
        <label>Welcome title<input id="desk-title" class="input" maxlength="40" value="${esc(ui.welcome_title || "Desk")}"></label>
        <label>Clock timezone<input id="desk-zone" class="input" placeholder="Empty uses this computer" value="${esc(ui.clock_timezone || "")}"></label>
        <label>Accent<input id="desk-accent" class="input" type="color" value="${esc(ui.accent || "#7dd3c7")}"></label>
        <label>Second accent<input id="desk-accent-2" class="input" type="color" value="${esc(ui.accent_2 || "#8b9dff")}"></label>
        <label>Corner radius<input id="desk-radius" class="input" type="number" min="8" max="32" value="${esc(ui.radius || 22)}"></label>
        <label>Company daily ceiling<input id="desk-cap" class="input" type="number" min="0" max="1000000" value="${esc(ui.global_daily_cap || 0)}"></label>
        <label>Locked theme
          <select id="desk-theme" class="input">
            <option value="" ${ui.force_theme ? "" : "selected"}>User choice</option>
            <option value="light" ${ui.force_theme === "light" ? "selected" : ""}>Light</option>
            <option value="dark" ${ui.force_theme === "dark" ? "selected" : ""}>Dark</option>
          </select>
        </label>
      </div>
      <label>Welcome text<textarea id="desk-welcome" class="input" maxlength="240" rows="2">${esc(ui.welcome_text || "")}</textarea></label>
      <label>Banner<textarea id="desk-banner" class="input" maxlength="400" rows="2">${esc(ui.banner || "")}</textarea></label>
      <div class="desk-grid">
        <label>Desk label<input id="desk-label-home" class="input" maxlength="24" value="${esc(labels.home || "Desk")}"></label>
        <label>Recipients label<input id="desk-label-recipients" class="input" maxlength="24" value="${esc(labels.recipients || "Recipients")}"></label>
        <label>Campaigns label<input id="desk-label-campaigns" class="input" maxlength="24" value="${esc(labels.campaigns || "Campaigns")}"></label>
        <label>History label<input id="desk-label-history" class="input" maxlength="24" value="${esc(labels.history || "History")}"></label>
        <label>Composer label<input id="desk-label-compose" class="input" maxlength="24" value="${esc(labels.compose || "Composer")}"></label>
        <label>Preview label<input id="desk-label-preview" class="input" maxlength="24" value="${esc(labels.preview || "Preview")}"></label>
      </div>
      <div class="check-grid">${boxes}</div>
      <div class="row"><button class="btn btn-primary" type="button" data-action="save-desk">Save user desk</button></div>
    </section>`;
}

function deskDirty() {
  if (!document.getElementById("desk-brand") || !state.ui) return false;
  const next = readDeskForm();
  const ui = state.ui;
  const flags = [
    "show_desk", "show_recipients", "show_campaigns", "show_history", "show_compose",
    "show_preview", "show_pace", "show_schedule", "show_attachments", "show_cc", "show_variables",
    "allow_theme_toggle", "block_repeat_recipients",
  ];
  return next.banner !== (ui.banner || "")
    || next.brand_name !== ui.brand_name
    || next.brand_tagline !== (ui.brand_tagline || "")
    || next.welcome_title !== ui.welcome_title
    || next.welcome_text !== (ui.welcome_text || "")
    || next.clock_timezone !== (ui.clock_timezone || "")
    || next.accent.toLowerCase() !== String(ui.accent || "").toLowerCase()
    || next.accent_2.toLowerCase() !== String(ui.accent_2 || "").toLowerCase()
    || Number(next.radius) !== Number(ui.radius)
    || Number(next.global_daily_cap) !== Number(ui.global_daily_cap || 0)
    || next.force_theme !== (ui.force_theme || "")
    || JSON.stringify(next.labels) !== JSON.stringify(ui.labels)
    || flags.some((key) => Boolean(next[key]) !== Boolean(ui[key]));
}

function readDeskForm() {
  const flags = {};
  document.querySelectorAll("[data-desk]").forEach((box) => { flags[box.dataset.desk] = box.checked; });
  return Object.assign(flags, {
    brand_name: document.getElementById("desk-brand").value,
    brand_tagline: document.getElementById("desk-tagline").value,
    welcome_title: document.getElementById("desk-title").value,
    welcome_text: document.getElementById("desk-welcome").value,
    banner: document.getElementById("desk-banner").value,
    accent: document.getElementById("desk-accent").value,
    accent_2: document.getElementById("desk-accent-2").value,
    radius: Number(document.getElementById("desk-radius").value),
    clock_timezone: document.getElementById("desk-zone").value.trim(),
    force_theme: document.getElementById("desk-theme").value,
    global_daily_cap: Number(document.getElementById("desk-cap").value || 0),
    labels: {
      home: document.getElementById("desk-label-home").value,
      recipients: document.getElementById("desk-label-recipients").value,
      campaigns: document.getElementById("desk-label-campaigns").value,
      history: document.getElementById("desk-label-history").value,
      compose: document.getElementById("desk-label-compose").value,
      preview: (document.getElementById("desk-label-preview") || {}).value || "Preview",
    },
  });
}

function tickClock() {
  const zone = state.ui && state.ui.clock_timezone;
  const timeOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false };
  const dateOptions = { weekday: "short", year: "numeric", month: "short", day: "2-digit" };
  if (zone) {
    timeOptions.timeZone = zone;
    dateOptions.timeZone = zone;
  }
  const now = new Date();
  let timeText = "";
  let dateText = "";
  try {
    timeText = new Intl.DateTimeFormat(undefined, timeOptions).format(now);
    dateText = new Intl.DateTimeFormat(undefined, dateOptions).format(now);
  } catch (error) {
    timeText = now.toLocaleTimeString();
    dateText = now.toLocaleDateString();
  }
  document.querySelectorAll(".clock").forEach((clock) => {
    const strong = clock.querySelector("strong");
    const span = clock.querySelector("span");
    if (strong) strong.textContent = timeText;
    if (span) span.textContent = dateText;
  });
}

function applyDesk() {
  const ui = state.ui;
  if (!ui) return;
  const root = document.documentElement;
  root.style.setProperty("--accent", ui.accent || "#7dd3c7");
  root.style.setProperty("--accent-2", ui.accent_2 || "#8b9dff");
  root.style.setProperty("--radius", `${ui.radius || 22}px`);
  const brand = document.getElementById("brand-name");
  if (brand) brand.textContent = ui.brand_name || "Parth";
  const authBrand = document.getElementById("auth-brand");
  if (authBrand) authBrand.textContent = `${ui.brand_name || "Parth"} ${ui.brand_tagline || "Mailing"}`.trim();
  const authTag = document.getElementById("auth-tag");
  const authVisible = document.getElementById("auth-screen") && !document.getElementById("auth-screen").classList.contains("hidden");
  if (authTag && !authVisible) authTag.textContent = ui.welcome_text || "Liquid glass desk";
  document.title = `${ui.brand_name || "Parth"} ${ui.brand_tagline || "Mailing"}`.trim();
  const master = isMasterUser();
  hideAdminNavForUsers();
  if (!master && ui.force_theme) applyTheme(ui.force_theme);
  const themeButton = document.getElementById("theme-toggle");
  if (themeButton) themeButton.classList.toggle("hidden", !master && (!!ui.force_theme || ui.allow_theme_toggle === false));
  const flags = {
    home: "show_desk",
    recipients: "show_recipients",
    compose: "show_compose",
    preview: "show_preview",
    campaigns: "show_campaigns",
    history: "show_history",
  };
  document.querySelectorAll(".nav-btn").forEach((button) => {
    if (button.classList.contains("master-only")) {
      button.classList.toggle("hidden", !master);
      return;
    }
    const key = flags[button.dataset.view];
    if (key) button.classList.toggle("hidden", !master && ui[key] === false);
  });
  if (!master && (state.view === "master" || state.view === "config")) state.view = "home";
  const compose = document.getElementById("compose-button");
  if (compose) compose.classList.toggle("hidden", !master && ui.show_compose === false);
  const pieces = [
    [".cc-row", ui.show_cc],
    [".pace-grid", ui.show_pace],
    [".attach-row", ui.show_attachments],
    ["#var-bar", ui.show_variables],
  ];
  pieces.forEach(([selector, shown]) => {
    const node = document.querySelector(selector);
    if (node) node.classList.toggle("hidden", !master && shown === false);
  });
  const schedule = document.getElementById("schedule-on");
  if (schedule) {
    schedule.closest("label").classList.toggle("hidden", !master && ui.show_schedule === false);
    if (!master && ui.show_schedule === false) document.getElementById("schedule-fields").classList.add("hidden");
  }
  if (!master) {
    const allowed = {
      home: ui.show_desk,
      recipients: ui.show_recipients,
      compose: ui.show_compose,
      preview: ui.show_preview,
      campaigns: ui.show_campaigns,
      history: ui.show_history,
      config: false,
      master: false,
    };
    if ((allowed[state.view] === false || state.view === "config") && state.view !== "home") {
      state.view = ui.show_desk === false ? "campaigns" : "home";
    }
  }
}

function refreshFilter() {
  const query = state.recipientQuery.trim().toLowerCase();
  state.filtered = query
    ? state.recipients.filter((row) => `${row.email} ${row.first_name} ${row.last_name} ${row.company} ${row.template || ""} ${row.sender_name || ""}`.toLowerCase().includes(query))
    : state.recipients;
  if (state.redraw) state.redraw();
}

function mountRecipients() {
  const scroller = document.getElementById("recipient-scroller");
  const spacer = document.getElementById("recipient-spacer");
  const list = document.getElementById("recipient-rows");
  if (!scroller) return;
  refreshFilter();
  const draw = () => {
    const rows = state.filtered;
    spacer.style.height = `${rows.length * ROW_HEIGHT}px`;
    const start = Math.max(0, Math.floor(scroller.scrollTop / ROW_HEIGHT) - 4);
    const count = Math.ceil(scroller.clientHeight / ROW_HEIGHT) + 10;
    const slice = rows.slice(start, start + count);
    list.style.transform = `translateY(${start * ROW_HEIGHT}px)`;
    list.innerHTML = slice.map((row, index) => `
      <div class="rrow rgrid">
        <span>${(start + index + 1).toLocaleString()}</span>
        <span>${esc(row.email)}</span>
        <span>${esc(row.first_name || fieldOf(row, "Name"))}</span>
        <span>${esc(row.company)}</span>
        <span>${esc(fieldOf(row, "Template") || row.template || "")}</span>
        <span>${esc(fieldOf(row, "Sender Name", "Sender") || row.sender_name || "")}</span>
      </div>`).join("");
    const valid = document.getElementById("stat-valid");
    if (valid) valid.textContent = `${state.recipients.length.toLocaleString()} ready`;
  };
  scroller.onscroll = draw;
  state.redraw = draw;
  draw();
}

function renderVars() {
  const bar = document.getElementById("var-bar");
  if (!bar) return;
  const names = Array.from(state.columns);
  const letters = names.filter((name) => /^[A-Z]{1,3}$/.test(name));
  const words = names.filter((name) => !/^[A-Z]{1,3}$/.test(name));
  const shown = [...words, ...letters].slice(0, 40);
  bar.innerHTML = shown.map((name) => `<button type="button" data-action="insert-var" data-token="{${esc(name)}}" title="Insert {${esc(name)}}">{${esc(name)}}</button>`).join("");
}

function fillSenders() {
  const select = document.getElementById("from-select");
  const approved = state.catalog.filter((sender) => sender.status === "approved");
  const signature = approved.map((sender) => `${sender.id}:${sender.live ? 1 : 0}`).join("|");
  state.hasGrant = approved.length > 0;
  if (select.dataset.sig === signature) return;
  const current = select.value;
  select.dataset.sig = signature;
  select.innerHTML = approved.length
    ? approved.map((sender) => `<option value="${esc(sender.id)}">${esc(sender.display_name || "Internal mailbox")}${sender.live === false ? " (simulated)" : ""}</option>`).join("")
    : `<option value="">No approved sender</option>`;
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function fillZones() {
  const select = document.getElementById("schedule-zone");
  if (select.dataset.ready) return;
  let zones = ["UTC", "America/New_York", "Europe/London", "Asia/Kolkata", "Asia/Singapore", "Australia/Sydney"];
  try {
    const supported = Intl.supportedValuesOf("timeZone");
    if (supported && supported.length) zones = supported;
  } catch (error) { /* short list remains */ }
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (!zones.includes(local)) zones.unshift(local);
  select.innerHTML = zones.map((zone) => `<option value="${esc(zone)}">${esc(zone)}</option>`).join("");
  select.value = zones.includes(local) ? local : "UTC";
  select.dataset.ready = "1";
}

function zoneOffset(utcMs, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]));
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, hour, +parts.minute, +parts.second);
  return asUtc - utcMs;
}

function zonedToUnix(dateStr, timeStr, timeZone) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  let offset = zoneOffset(guess, timeZone);
  let result = guess - offset;
  offset = zoneOffset(result, timeZone);
  result = guess - offset;
  return Math.floor(result / 1000);
}

function applyVars(template, row) {
  const map = Object.assign({
    FirstName: row.first_name || "",
    LastName: row.last_name || "",
    Company: row.company || "",
    Custom1: row.custom1 || "",
    Email: row.email || "",
    Name: row.first_name || "",
    Sender: fieldOf(row, "Sender Name", "Sender") || row.sender_name || "",
    Template: fieldOf(row, "Template") || row.template || "",
  }, row.fields || {});
  const lookup = (match, key) => {
    const needle = String(key || "").toLowerCase().replace(/\s+/g, "");
    const found = Object.keys(map).find((name) => name.toLowerCase().replace(/\s+/g, "") === needle);
    return found == null ? match : String(map[found] ?? "");
  };
  return String(template || "")
    .replace(/\{\{\s*([^{}]+?)\s*\}\}/g, lookup)
    .replace(/\{([A-Za-z][A-Za-z0-9 _]*)\}/g, lookup);
}

function updatePreview() {
  const preview = document.getElementById("merge-preview");
  if (!preview) return;
  const row = mergedRecipients()[0];
  if (!row) {
    preview.textContent = "Add recipients to preview personalization.";
    return;
  }
  const subject = applyVars(document.getElementById("subject-input").value, row);
  const body = applyVars(document.getElementById("editor").innerText, row).replace(/\s+/g, " ").trim();
  preview.textContent = `Preview for ${row.email}: ${subject || "(no subject)"} — ${body.slice(0, 180)}`;
}

function mergedRecipients() {
  const map = new Map();
  state.recipients.forEach((row) => map.set(row.email, row));
  const extra = document.getElementById("to-input");
  if (extra) {
    extra.value.split(/[\s,;]+/).forEach((part) => {
      const email = normalizeEmail(part);
      if (EMAIL_RE.test(email) && !map.has(email)) {
        map.set(email, { email, first_name: "", last_name: "", company: "", custom1: "", fields: {} });
      }
    });
  }
  return [...map.values()];
}

function collectComposer() {
  return {
    sender_id: document.getElementById("from-select").value,
    to: document.getElementById("to-input").value,
    cc: document.getElementById("cc-input").value,
    bcc: document.getElementById("bcc-input").value,
    subject: document.getElementById("subject-input").value,
    html: document.getElementById("editor").innerHTML,
    delay_min: document.getElementById("delay-min").value,
    delay_max: document.getElementById("delay-max").value,
    batch_size: document.getElementById("batch-size").value,
    batch_pause: document.getElementById("batch-pause").value,
    schedule_on: document.getElementById("schedule-on").checked,
    schedule_date: document.getElementById("schedule-date").value,
    schedule_time: document.getElementById("schedule-time").value,
    schedule_zone: document.getElementById("schedule-zone").value,
  };
}

function restoreComposer(payload) {
  if (!payload) return;
  const set = (id, value) => { const el = document.getElementById(id); if (el && value != null) el.value = value; };
  set("to-input", payload.to);
  set("cc-input", payload.cc);
  set("bcc-input", payload.bcc);
  set("subject-input", payload.subject);
  set("delay-min", payload.delay_min);
  set("delay-max", payload.delay_max);
  set("batch-size", payload.batch_size);
  set("batch-pause", payload.batch_pause);
  set("schedule-date", payload.schedule_date);
  set("schedule-time", payload.schedule_time);
  if (payload.schedule_zone) set("schedule-zone", payload.schedule_zone);
  document.getElementById("schedule-on").checked = Boolean(payload.schedule_on);
  document.getElementById("schedule-fields").classList.toggle("hidden", !payload.schedule_on);
  document.getElementById("editor").innerHTML = payload.html || "";
  if (payload.cc || payload.bcc) document.getElementById("cc-fields").classList.remove("hidden");
  paintSendLabel();
  updatePreview();
}

function templateId() {
  return Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-4);
}

function persistTemplates() {
  localStorage.setItem("parth.templates", JSON.stringify(state.templates));
  localStorage.setItem("parth.activeTemplate", state.activeTemplateId || "");
}

function loadTemplates() {
  try {
    const saved = JSON.parse(localStorage.getItem("parth.templates") || "[]");
    state.templates = Array.isArray(saved) ? saved.filter((item) => item && item.id && item.name) : [];
  } catch (error) {
    state.templates = [];
  }
  state.activeTemplateId = localStorage.getItem("parth.activeTemplate") || "";
  if (!state.templates.length) {
    state.templates = [{ id: templateId(), name: "Template 1", subject: "", html: "" }];
    state.activeTemplateId = state.templates[0].id;
  }
  if (!state.templates.some((item) => item.id === state.activeTemplateId)) {
    state.activeTemplateId = state.templates[0].id;
  }
  persistTemplates();
}

function activeTemplate() {
  return state.templates.find((item) => item.id === state.activeTemplateId) || state.templates[0] || null;
}

function captureTemplate() {
  const current = activeTemplate();
  const subject = document.getElementById("subject-input");
  const editor = document.getElementById("editor");
  if (!current || !subject || !editor) return;
  current.subject = subject.value;
  current.html = editor.innerHTML;
  persistTemplates();
}

function applyTemplate(template) {
  if (!template) return;
  const subject = document.getElementById("subject-input");
  const editor = document.getElementById("editor");
  if (subject) subject.value = template.subject || "";
  if (editor) editor.innerHTML = template.html || "";
  updatePreview();
}

function renderTemplates() {
  const list = document.getElementById("template-list");
  if (!list) return;
  const chips = state.templates.map((item) => (
    `<button type="button" class="template-chip${item.id === state.activeTemplateId ? " is-on" : ""}" data-action="template-open" data-id="${esc(item.id)}">${esc(item.name)}</button>`
  )).join("");
  const remove = state.templates.length > 1
    ? `<button type="button" class="template-chip" data-action="template-delete">Delete</button>`
    : "";
  list.innerHTML = `${chips}<button type="button" class="template-chip" data-action="template-new">New</button>${remove}`;
}

function liveCampaign() {
  const active = state.campaigns.filter((item) => ["scheduled", "running", "paused"].includes(item.status));
  const pinned = localStorage.getItem("parth.scheduleId");
  return active.find((item) => item.id === pinned) || active[0] || null;
}

function paintScheduleButton() {
  const button = document.getElementById("schedule-toggle");
  if (!button) return;
  const live = liveCampaign();
  const label = button.querySelector("span");
  button.classList.toggle("is-stop", Boolean(live));
  if (label) label.textContent = live ? "Stop" : "Start Scheduling";
  button.title = live
    ? `Stop ${live.subject || "this campaign"} (${live.status})`
    : "Start at the S_Date and S_Time from the sheet";
}

function sheetField(row, names) {
  const fields = row && row.fields ? row.fields : {};
  const lowered = {};
  Object.keys(fields).forEach((key) => {
    lowered[String(key).toLowerCase().replace(/[\s_]+/g, "")] = fields[key];
  });
  for (const name of names) {
    const value = lowered[name.toLowerCase().replace(/[\s_]+/g, "")];
    if (String(value || "").trim()) return String(value).trim();
  }
  return "";
}

function parseSheetDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d+(\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial > 20000 && serial < 80000) {
      const utc = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
      const month = String(utc.getUTCMonth() + 1).padStart(2, "0");
      const day = String(utc.getUTCDate()).padStart(2, "0");
      return `${utc.getUTCFullYear()}-${month}-${day}`;
    }
  }
  const iso = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const parts = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (!parts) {
    const named = Date.parse(text);
    if (Number.isNaN(named)) return "";
    const dt = new Date(named);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  }
  let year = Number(parts[3]);
  if (year < 100) year += 2000;
  const first = Number(parts[1]);
  const second = Number(parts[2]);
  const monthFirst = first <= 12 && second > 12;
  const day = monthFirst ? second : first;
  const month = monthFirst ? first : second;
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseSheetTime(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d+(\.\d+)?$/.test(text) && Number(text) > 0 && Number(text) < 1) {
    const total = Math.round(Number(text) * 24 * 60);
    return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  }
  const match = text.match(/(\d{1,2})[:.](\d{2})(?::(\d{2}))?\s*([ap]m)?/i);
  if (!match) return "";
  let hour = Number(match[1]);
  const minute = match[2];
  const mark = (match[4] || "").toLowerCase();
  if (mark === "pm" && hour < 12) hour += 12;
  if (mark === "am" && hour === 12) hour = 0;
  if (hour > 23 || Number(minute) > 59) return "";
  return `${String(hour).padStart(2, "0")}:${minute}`;
}

function sheetTimes(rows, zone) {
  return rows.map((row) => {
    const dateRaw = sheetField(row, ["S_Date", "SDate", "Schedule Date", "Send Date"]);
    const timeRaw = sheetField(row, ["S_Time", "STime", "Schedule Time", "Send Time"]);
    const date = parseSheetDate(dateRaw);
    const time = parseSheetTime(timeRaw) || parseSheetTime(dateRaw);
    if (!date || !time) return null;
    return { email: row.email, date, time, unix: zonedToUnix(date, time, zone) };
  }).filter(Boolean);
}

async function saveDraft(manual) {
  const payload = collectComposer();
  localStorage.setItem("parth.localDraft", JSON.stringify(payload));
  const admin = isMasterUser();
  if (!state.token || (!state.hasGrant && !admin)) {
    if (manual) toast("Saved in this browser. Sender approval is required before it syncs.");
    return;
  }
  const post = (id) => api("/api/drafts", { method: "POST", body: JSON.stringify({ id: id || undefined, payload }) });
  try {
    const data = await post(state.draftId);
    state.draftId = data.id;
    localStorage.setItem("parth.draftId", data.id);
    if (manual) toast("Draft synced");
  } catch (error) {
    const message = String(error.message || "");
    if (message.toLowerCase().includes("overwrite")) {
      state.draftId = "";
      localStorage.removeItem("parth.draftId");
      const data = await post("");
      state.draftId = data.id;
      localStorage.setItem("parth.draftId", data.id);
      if (manual) toast("Draft synced");
      return;
    }
    if (manual) toast(message, "danger");
  }
}

function paintSendLabel() {
  const send = document.getElementById("send-button");
  const draft = document.getElementById("draft-button");
  const on = document.getElementById("schedule-on") && document.getElementById("schedule-on").checked;
  if (send) send.textContent = on ? "Schedule SMTP Send" : "SMTP Send";
  if (draft) draft.textContent = on ? "Schedule SMTP Draft" : "SMTP Draft";
}

function saveRange() {
  const selection = window.getSelection();
  if (selection && selection.rangeCount && document.getElementById("editor").contains(selection.anchorNode)) {
    state.range = selection.getRangeAt(0).cloneRange();
  }
}

function restoreRange() {
  const editor = document.getElementById("editor");
  editor.focus();
  if (!state.range) return;
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(state.range);
}

function insertToken(token) {
  const editor = document.getElementById("editor");
  editor.focus();
  if (!document.execCommand("insertText", false, token)) {
    document.execCommand("insertHTML", false, esc(token));
  }
  updatePreview();
}

function resetImport(mode) {
  if (mode !== "replace") return;
  state.recipients = [];
  state.seen = new Set();
  state.stats = { invalid: 0, duplicates: 0 };
  state.sourceFiles = [];
  state.columns = new Set(["FirstName", "LastName", "Company", "Custom1", "Email"]);
}

async function fetchSheet() {
  const input = document.getElementById("sheet-url");
  const url = (input && input.value || "").trim();
  if (!url) throw new Error("Paste a Google Sheet link.");
  state.sheetUrl = url;
  const mode = (document.querySelector('input[name="import-mode"]:checked') || {}).value || "append";
  resetImport(mode);
  const data = await api("/api/sheets/fetch", { method: "POST", body: JSON.stringify({ url }) });
  (data.columns || []).forEach((column) => state.columns.add(column));
  addRows(data.rows || []);
  renderVars();
  if (state.view === "recipients") renderView();
  const ready = (data.rows || []).length.toLocaleString();
  toast(`${ready} rows fetched from ${data.title || "the sheet"}`);
  if (data.blocked) {
    const names = (data.blocked_mailboxes || []).join(", ");
    toast(`${Number(data.blocked).toLocaleString()} rows were left out because this account cannot use ${names || "that mailbox"}.`, "warn");
  }
}

async function importFiles(fileList) {
  const files = [...fileList].filter(Boolean);
  if (!files.length) return;
  const mode = (document.querySelector('input[name="import-mode"]:checked') || {}).value || "append";
  resetImport(mode);
  state.importing = true;
  paintChrome();
  for (const file of files) {
    state.sourceFiles.push(file);
    await runWorker(file);
  }
  state.importing = false;
  renderVars();
  paintChrome();
  if (state.view === "recipients") renderView();
  toast(`${state.recipients.length.toLocaleString()} recipients ready`);
}

function runWorker(file) {
  return new Promise((resolve, reject) => {
    const worker = new Worker("worker.js");
    worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === "chunk") addRows(message.rows || []);
      if (message.type === "progress") {
        state.importCount = message.scanned || 0;
        paintChrome();
      }
      if (message.type === "done") {
        state.stats.invalid += message.stats.invalid || 0;
        state.stats.duplicates += message.stats.duplicates || 0;
        (message.columns || []).forEach((column) => state.columns.add(column));
        worker.terminate();
        resolve();
      }
      if (message.type === "error") {
        worker.terminate();
        reject(new Error(message.message));
      }
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error("The spreadsheet worker stopped."));
    };
    worker.postMessage({ file });
  });
}

function addRows(rows) {
  rows.forEach((row) => {
    const email = normalizeEmail(row.email);
    if (!EMAIL_RE.test(email)) return;
    if (state.seen.has(email)) {
      state.stats.duplicates += 1;
      return;
    }
    state.seen.add(email);
    state.recipients.push(Object.assign({}, row, { email }));
    Object.keys(row.fields || {}).forEach((key) => state.columns.add(key));
  });
  state.importCount = state.recipients.length;
  if (state.view === "recipients" && state.redraw) refreshFilter();
  updatePreview();
}

function addQuickEmails() {
  const box = document.getElementById("quick-add");
  const parts = box.value.split(/[\s,;]+/).map((part) => part.trim()).filter(Boolean);
  const rows = [];
  const bad = [];
  parts.forEach((part) => {
    const email = normalizeEmail(part);
    if (EMAIL_RE.test(email)) rows.push({ email, first_name: "", last_name: "", company: "", custom1: "", fields: {} });
    else bad.push(part);
  });
  addRows(rows);
  box.value = "";
  refreshFilter();
  if (bad.length) toast(`Skipped invalid addresses: ${bad.slice(0, 3).join(", ")}`, "warn");
  else toast(`${rows.length} addresses added`);
}

function clearRecipients() {
  state.recipients = [];
  state.seen = new Set();
  state.filtered = [];
  state.stats = { invalid: 0, duplicates: 0 };
  state.sourceFiles = [];
  state.columns = new Set(["FirstName", "LastName", "Company", "Custom1", "Email"]);
  renderVars();
  if (state.view === "recipients") renderView();
  updatePreview();
}

function downloadSample() {
  const csv = "Email,Name,Company,Template,Sender Name,S_Date,S_Time\nada@example.com,Ada Lovelace,Analytical,<p>Hello {Name}</p>,Ada Events,2026-10-22,09:30\ngrace@example.com,Grace Hopper,Navy,<p>Hi {Name}</p>,Navy Desk,22/10/2026,14:00\n";
  const blob = new Blob([csv], { type: "text/csv" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "parth_recipients_sample.csv";
  link.click();
  URL.revokeObjectURL(link.href);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("Could not read " + file.name));
    reader.readAsDataURL(file);
  });
}

function paintAttachments() {
  document.getElementById("attach-list").innerHTML = state.attachments.map((file, index) =>
    `<span class="chip">${esc(file.filename)} <button type="button" data-action="remove-attachment" data-index="${index}">×</button></span>`
  ).join("");
}

async function sendCampaign(action, options) {
  if (state.sending) return;
  const mode = action === "draft" ? "draft" : "send";
  const rows = mergedRecipients();
  if (!rows.length) throw new Error("Add at least one recipient.");
  const senderId = document.getElementById("from-select").value;
  const approved = state.catalog.filter((item) => item.status === "approved");
  if (mode === "draft" && !senderId) throw new Error("Choose the mailbox that should receive the IMAP drafts.");
  if (mode === "send" && !approved.length && !senderId) {
    throw new Error("The admin has not assigned a sending mailbox to this account yet.");
  }
  const subject = document.getElementById("subject-input").value.trim();
  const html = document.getElementById("editor").innerHTML.trim();
  const plain = document.getElementById("editor").innerText.trim();
  if (!subject || !plain) throw new Error("Subject and message are required.");
  ["cc-input", "bcc-input"].forEach((id) => {
    document.getElementById(id).value.split(/[\s,;]+/).map((part) => part.trim()).filter(Boolean).forEach((part) => {
      if (!EMAIL_RE.test(normalizeEmail(part))) throw new Error("Invalid copy address: " + part);
    });
  });
  const toParts = document.getElementById("to-input").value.split(/[\s,;]+/).map((part) => part.trim()).filter(Boolean);
  const bad = toParts.filter((part) => !EMAIL_RE.test(normalizeEmail(part)));
  if (bad.length) throw new Error("Fix the To field: " + bad[0]);
  const scheduled = Boolean(options && options.schedule) || document.getElementById("schedule-on").checked;
  let scheduleAt = null;
  let scheduleNote = "";
  const zone = document.getElementById("schedule-zone").value || "UTC";
  if (scheduled) {
    const found = sheetTimes(rows, zone);
    if (!found.length) throw new Error("The sheet needs S_Date and S_Time. Use 2026-10-22 and 09:30, or 22/10/2026 and 09:30.");
    found.sort((left, right) => left.unix - right.unix);
    scheduleAt = found[0].unix;
    const dateInput = document.getElementById("schedule-date");
    const timeInput = document.getElementById("schedule-time");
    if (dateInput) dateInput.value = found[0].date;
    if (timeInput) timeInput.value = found[0].time;
    const distinct = new Set(found.map((item) => `${item.date} ${item.time}`)).size;
    const missing = rows.length - found.length;
    scheduleNote = distinct > 1
      ? `First row sends ${found[0].date} ${found[0].time}. ${distinct} different S_Date and S_Time values; each row waits for its own.`
      : `S_Date ${found[0].date} and S_Time ${found[0].time} from the sheet.`;
    if (missing) scheduleNote += ` ${missing} rows have no sheet time and use that first time.`;
  }
  const pace = {
    delay_min_seconds: Number(document.getElementById("delay-min").value),
    delay_max_seconds: Number(document.getElementById("delay-max").value),
    batch_size: Number(document.getElementById("batch-size").value),
    batch_pause_minutes: Number(document.getElementById("batch-pause").value),
  };
  const sender = state.catalog.find((item) => item.id === senderId);
  const senders = mode === "draft" ? approved.filter((item) => item.id === senderId) : (approved.length ? approved : (sender ? [sender] : []));
  const mailboxLine = mode === "draft"
    ? `IMAP drafts on ${sender && (sender.display_name || sender.email) || "the selected mailbox"}.`
    : (senders.length > 1
      ? `${senders.length} assigned mailboxes will send in parallel. Each Gmail mailbox waits at least 90 seconds between its own emails.`
      : `One-by-one SMTP from ${sender && (sender.display_name || sender.email) || "the assigned mailbox"}. Gmail policy applies.`);
  const agreed = await askConfirm(
    scheduled ? (mode === "draft" ? "Schedule SMTP Draft?" : "Schedule SMTP Send?") : (mode === "draft" ? "SMTP Draft all emails?" : "Start SMTP Send?"),
    `${rows.length.toLocaleString()} recipients. ${mailboxLine} ${scheduleNote} Delay ${pace.delay_min_seconds}-${pace.delay_max_seconds}s, batches of ${pace.batch_size}.${sender && sender.live === false ? " A mailbox with no password stays in simulation." : ""}`,
    scheduled ? "Schedule" : (mode === "draft" ? "Draft" : "Send")
  );
  if (!agreed) return;
  state.sending = true;
  try {
    const created = await api("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({
        action: mode,
        sender_id: senderId,
        sender_ids: senders.map((item) => item.id),
        subject,
        html,
        cc: document.getElementById("cc-input").value,
        bcc: document.getElementById("bcc-input").value,
        pace,
        schedule_at: scheduleAt,
        timezone: zone,
        attachments: state.attachments,
      }),
    });
    const id = created.campaign.id;
    const chunk = 2000;
    let alreadySent = 0;
    for (let index = 0; index < rows.length; index += chunk) {
      toast(`Uploading recipients ${Math.min(index + chunk, rows.length).toLocaleString()} / ${rows.length.toLocaleString()}`);
      const added = await api(`/api/campaigns/${id}/recipients`, {
        method: "POST",
        body: JSON.stringify({ rows: rows.slice(index, index + chunk), replace: index === 0 }),
      });
      alreadySent += added.already_sent || 0;
    }
    if (alreadySent) toast(`${alreadySent.toLocaleString()} people were already emailed, so they were not queued again.`, "warn");
    for (const file of state.sourceFiles) {
      const response = await fetch(apiBase() + `/api/campaigns/${id}/source`, {
        method: "POST",
        headers: { Authorization: "Bearer " + state.token, "X-Filename": file.name },
        body: file,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Could not store the spreadsheet");
      }
    }
    await api(`/api/campaigns/${id}/start`, { method: "POST", body: "{}" });
    if (scheduled) {
      localStorage.setItem("parth.scheduleId", id);
      paintScheduleButton();
      toast(mode === "draft" ? "SMTP Draft scheduled" : "SMTP Send scheduled");
    } else {
      let outcome = null;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        const detail = await api(`/api/campaigns/${id}`);
        outcome = detail.campaign;
        const settled = outcome.status === "complete" || outcome.status === "paused" || outcome.sent_count || outcome.failed_count || outcome.drafted_count;
        if (settled && outcome.status !== "running" && outcome.status !== "ready") break;
        if (outcome.sent_count || outcome.drafted_count || outcome.failed_count) break;
      }
      const problem = outcome && ((outcome.errors || [])[0] || (outcome.last_error ? { error: outcome.last_error } : null));
      const failed = outcome && ((outcome.failed_count || 0) + (outcome.bounced_count || 0));
      if (problem && failed) {
        const count = failed > 1 ? ` ${failed} messages failed.` : "";
        toast(`${problem.error || "The message was not delivered."}${count}`, "danger");
      } else if (outcome && (outcome.sent_count || outcome.drafted_count)) {
        toast(mode === "draft" ? "Draft saved in Gmail" : "Gmail accepted the message. Check the sender Sent folder.");
      } else {
        toast(mode === "draft" ? "Saving IMAP drafts one by one" : (senders.length > 1 ? `SMTP Send started on ${senders.length} mailboxes` : "SMTP Send started"));
      }
    }
    state.view = "campaigns";
    await refreshCampaigns();
    paintScheduleButton();
    renderView();
  } finally {
    state.sending = false;
  }
}

async function toggleSchedule() {
  const live = liveCampaign();
  if (live) {
    const agreed = await askConfirm(
      "Stop this schedule?",
      `${live.subject || "This campaign"} is ${live.status}. Queued messages will not be sent.`,
      "Stop"
    );
    if (!agreed) return;
    await api(`/api/campaigns/${live.id}/control`, { method: "POST", body: JSON.stringify({ action: "kill" }) });
    if (localStorage.getItem("parth.scheduleId") === live.id) localStorage.removeItem("parth.scheduleId");
    await refreshCampaigns();
    paintScheduleButton();
    if (["home", "campaigns", "history", "master"].includes(state.view)) renderView();
    toast("Schedule stopped");
    return;
  }
  const fields = document.getElementById("schedule-fields");
  const details = document.querySelector(".composer-options");
  if (fields) fields.classList.remove("hidden");
  if (details) details.open = true;
  captureTemplate();
  await sendCampaign("send", { schedule: true });
}

async function downloadReport(id) {
  const response = await fetch(apiBase() + `/api/campaigns/${id}/report`, {
    headers: { Authorization: "Bearer " + state.token },
  });
  if (!response.ok) throw new Error("The report is not available yet.");
  const blob = await response.blob();
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "campaign_report.xlsx";
  link.click();
  URL.revokeObjectURL(link.href);
}

async function refreshCampaigns() {
  const scope = isMasterUser() ? "all" : "mine";
  const data = await api("/api/campaigns?scope=" + scope);
  state.campaigns = data.campaigns || [];
}

async function refreshCatalog() {
  const data = await api("/api/senders");
  state.catalog = data.senders || [];
  fillSenders();
}

async function refreshMaster() {
  if (!isMasterUser()) return;
  const load = async (path, fallback) => {
    try {
      return await api(path);
    } catch (error) {
      console.warn(path, error);
      return fallback;
    }
  };
  const [users, approvals, audit, monitor, senders] = await Promise.all([
    load("/api/master/users", { users: [] }),
    load("/api/master/approvals", { approvals: [] }),
    load("/api/master/audit", { audit: [] }),
    load("/api/master/monitor", { campaigns: [], mailboxes: [] }),
    load("/api/master/senders", { senders: [] }),
  ]);
  state.users = users.users || [];
  state.approvals = approvals.approvals || [];
  state.audit = audit.audit || [];
  state.monitor = monitor;
  state.masterSenders = senders.senders || [];
  state.mailboxSheetUrl = senders.sheet_url || state.mailboxSheetUrl || "";
}

function campaignSignature() {
  const ledger = state.ledger || {};
  return JSON.stringify(state.campaigns.map((item) => [item.id, item.status, item.sent_count, item.failed_count, item.bounced_count, item.skipped_count, item.hold_reason, item.last_error, item.drive_report_url]))
    + [ledger.mine_total, ledger.sent_total, ledger.unique_people, ledger.used_day, ledger.company_remaining].join(":");
}

async function refreshUi() {
  const data = await api("/api/ui");
  state.ui = data.ui;
  const before = state.view;
  applyDesk();
  return before !== state.view;
}

async function refreshLedger() {
  if (!state.token) return;
  const data = await api("/api/ledger");
  state.ledger = data.ledger;
}

async function tick() {
  if (!state.token || document.hidden) return;
  try {
    state.health = await api("/api/health");
    const moved = await refreshUi();
    await refreshLedger();
    paintChrome();
    const before = state.campSig;
    await refreshCampaigns();
    paintScheduleButton();
    await refreshCatalog();
    if (state.view === "master") await refreshMaster();
    const signature = campaignSignature() + (state.monitor ? state.monitor.campaigns.length : "");
    const idle = Date.now() - state.lastInteract > 2500;
    const typing = document.activeElement && document.activeElement.closest("input, textarea, select");
    if ((signature !== before || moved) && idle && !typing && !deskDirty() && ["home", "campaigns", "history", "master"].includes(state.view)) {
      state.campSig = signature;
      renderView();
    } else state.campSig = signature;
  } catch (error) {
    const line = document.getElementById("relay-line");
    if (line && !state.user) line.textContent = error.message;
  }
}

async function enterApp() {
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  const me = await api("/api/me");
  state.user = me.user;
  try { state.tracking = (await api("/api/config/ga4")).tracking || state.tracking; } catch (error) { /* optional */ }
  await refreshUi();
  await refreshLedger();
  await refreshCatalog();
  await refreshCampaigns();
  if (isMasterUser()) await refreshMaster();
  state.campSig = campaignSignature();
  renderVars();
  fillZones();
  const local = localStorage.getItem("parth.localDraft");
  if (local) {
    try { restoreComposer(JSON.parse(local)); } catch (error) { /* ignore broken draft */ }
  }
  const chosen = activeTemplate();
  if (chosen && (chosen.subject || chosen.html)) applyTemplate(chosen);
  else captureTemplate();
  renderTemplates();
  paintScheduleButton();
  setComposerMode("min");
  renderView();
}

function signOut(announce) {
  state.token = "";
  state.user = null;
  localStorage.removeItem("parth.token");
  document.getElementById("app").classList.add("hidden");
  document.getElementById("auth-screen").classList.remove("hidden");
  setComposerMode("hidden");
  document.body.classList.remove("is-master");
  if (announce) toast("Signed out");
}

function adminEmail() {
  return normalizeEmail((state.health && state.health.admin_email) || "vekariyaparth127@gmail.com");
}

function accountLabel(email) {
  const row = (state.users || []).find((user) => normalizeEmail(user.email) === normalizeEmail(email));
  if (row && row.display_name) return `${row.display_name} · ${email}`;
  return email === adminEmail() ? `Admin · ${email}` : email;
}

function readTrackingForm() {
  return {
    enabled: !!(document.getElementById("ga4-enabled") && document.getElementById("ga4-enabled").checked),
    source: (document.getElementById("ga4-source") || {}).value || "",
    medium: (document.getElementById("ga4-medium") || {}).value || "email",
    campaign: (document.getElementById("ga4-campaign") || {}).value || "",
    term: (document.getElementById("ga4-term") || {}).value || "",
    content: (document.getElementById("ga4-content") || {}).value || "",
  };
}

function tagTrackedUrl(url, tracking) {
  const settings = tracking || state.tracking || {};
  if (!settings.enabled) return url;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return url;
    const pairs = {
      utm_source: settings.source,
      utm_medium: settings.medium || "email",
      utm_campaign: settings.campaign,
      utm_term: settings.term,
      utm_content: settings.content,
    };
    Object.entries(pairs).forEach(([key, value]) => {
      if (value && !parsed.searchParams.has(key)) parsed.searchParams.set(key, value);
    });
    return parsed.toString();
  } catch (error) {
    return url;
  }
}

function tagHtmlLinks(html, tracking) {
  const settings = tracking || readTrackingForm();
  settings.enabled = true;
  return String(html || "").replace(/href=(["'])(https?:\/\/.*?)\1/gi, (match, quote, url) => `href=${quote}${tagTrackedUrl(url, settings)}${quote}`);
}

function paintFullPreview() {
  const frame = document.getElementById("preview-frame");
  const meta = document.getElementById("preview-meta");
  if (!frame) return;
  const rows = mergedRecipients();
  const pick = document.getElementById("preview-pick");
  const index = pick ? Number(pick.value) || 0 : state.previewIndex || 0;
  state.previewIndex = index;
  const row = rows[index];
  if (!row) {
    if (meta) meta.textContent = "Import Excel, then open Preview.";
    frame.srcdoc = "<p style='font-family:sans-serif;padding:24px'>No recipients yet.</p>";
    return;
  }
  const editor = document.getElementById("editor");
  const subjectField = document.getElementById("subject-input");
  const templateField = fieldOf(row, "Template") || row.template || "";
  const source = templateField && templateField.includes("<") ? templateField : (editor ? editor.innerHTML : "");
  const html = tagHtmlLinks(applyVars(source, row), Object.assign({}, state.tracking, { enabled: !!state.tracking.enabled }));
  const subject = applyVars((subjectField && subjectField.value) || "", row);
  const fromName = fieldOf(row, "Sender Name") || row.sender_name || "Assigned mailbox";
  if (meta) meta.textContent = `From: ${fromName} · Subject: ${subject || "(no subject)"} · ${row.email}`;
  frame.srcdoc = html || "<p style='font-family:sans-serif;padding:24px'>Open Composer and write a message.</p>";
}

function maskAddress(value) {
  return String(value || "").replace(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi, (match) => (
    normalizeEmail(match) === adminEmail() ? "internal mailbox" : "user"
  ));
}

function codeDigits() {
  return String((document.getElementById("login-code") || {}).value || "").replace(/\D/g, "").slice(0, 6);
}

function paintLoginButton() {
  const button = document.getElementById("login-submit");
  if (!button) return;
  const confirming = state.otpDeadline && codeDigits().length === 6;
  if (confirming) button.textContent = state.otpPurpose === "reset" ? "Reset password" : "Confirm code";
  else if (state.authMode === "register") button.textContent = "Create account";
  else if (state.authMode === "forgot") button.textContent = "Email reset code";
  else button.textContent = "Sign in";
  const resend = document.getElementById("otp-resend");
  if (resend) resend.textContent = state.otpDeadline ? "Resend code" : "Email me a code";
}

function setAuthMode(mode) {
  state.authMode = mode || "login";
  document.querySelectorAll(".auth-tab").forEach((tab) => {
    tab.classList.toggle("is-on", tab.dataset.mode === state.authMode);
  });
  const namePanel = document.getElementById("name-panel");
  const passwordPanel = document.getElementById("password-panel");
  const passwordLabel = document.getElementById("password-label");
  const forgot = document.getElementById("forgot-link");
  const showName = state.authMode === "register" || state.authMode === "login";
  if (namePanel) namePanel.classList.toggle("hidden", state.authMode === "forgot");
  if (passwordPanel) passwordPanel.classList.remove("hidden");
  if (passwordLabel) {
    passwordLabel.textContent = state.authMode === "forgot" || state.otpPurpose === "reset" ? "New password" : "Password";
  }
  if (forgot) forgot.classList.toggle("hidden", state.authMode === "forgot");
  const tag = document.getElementById("auth-tag");
  if (tag) {
    tag.textContent = state.authMode === "register"
      ? "Enter your name, email, and password. Paste the 6-digit code emailed from parth@gr-conferences.com."
      : state.authMode === "forgot"
        ? "Paste the 6-digit code from parth@gr-conferences.com, then choose a new password."
        : "Existing accounts sign in with email and password. A new account also pastes the 6-digit code from parth@gr-conferences.com.";
  }
  paintLoginButton();
}

function showOtp(on, purpose) {
  if (purpose) state.otpPurpose = purpose;
  const panel = document.getElementById("otp-panel");
  if (panel) panel.classList.remove("hidden");
  const code = document.getElementById("login-code");
  if (code && !on) code.value = "";
  if (code) code.autocomplete = on ? "one-time-code" : "off";
  const passwordPanel = document.getElementById("password-panel");
  if (passwordPanel) passwordPanel.classList.remove("hidden");
  setAuthMode(state.authMode);
  const line = document.getElementById("relay-line");
  if (line && on) line.textContent = "Paste the 6-digit code from the email sent by parth@gr-conferences.com.";
  if (code && on) code.focus();
}

async function finishAuth(data, message) {
  state.token = data.token;
  localStorage.setItem("parth.token", data.token);
  state.user = data.user || null;
  await enterApp();
  toast(message || `Signed in as ${state.user && state.user.display_name ? state.user.display_name : "user"}`);
}

async function requestOtp() {
  const email = normalizeEmail(document.getElementById("login-email").value);
  const purpose = state.authMode === "forgot" ? "reset" : state.authMode === "register" ? "register" : "login";
  const data = await api("/api/auth/request-otp", { method: "POST", body: JSON.stringify({ email, purpose }) });
  state.otpEmail = email;
  state.otpDeadline = Date.now() + (data.expires_in || 300) * 1000;
  showOtp(true, data.purpose || purpose);
  document.getElementById("login-code").value = "";
  document.getElementById("login-code").focus();
  toast("The 6-digit code was emailed from parth@gr-conferences.com. Paste it below.");
}

async function verifyOtp() {
  const email = normalizeEmail(document.getElementById("login-email").value);
  const code = codeDigits();
  const password = document.getElementById("login-password").value;
  const body = { email, code };
  if (state.otpPurpose === "reset") body.password = password;
  const data = await api("/api/auth/verify-otp", { method: "POST", body: JSON.stringify(body) });
  await finishAuth(data, "Signed in");
}

async function submitAuth() {
  const email = normalizeEmail(document.getElementById("login-email").value);
  const password = document.getElementById("login-password").value;
  const name = document.getElementById("login-name").value.trim();
  const code = codeDigits();
  if (state.authMode === "login") {
    if (state.otpDeadline && code.length === 6) {
      await verifyOtp();
      return;
    }
    if (code.length && code.length < 6 && state.otpDeadline) {
      throw new Error("Paste the full 6-digit code from the email.");
    }
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password, display_name: name }),
    });
    if (data.needs_otp) {
      state.otpEmail = email;
      state.otpDeadline = Date.now() + (data.expires_in || 300) * 1000;
      showOtp(true, data.purpose || "first");
      toast("A 6-digit code was emailed from parth@gr-conferences.com. Paste it below.");
      return;
    }
    await finishAuth(data);
    return;
  }
  if (code.length && code.length < 6) throw new Error("Paste the full 6-digit code from the email.");
  if (code.length === 6) {
    await verifyOtp();
    return;
  }
  if (state.authMode === "register") {
    const data = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, display_name: name }),
    });
    state.otpEmail = email;
    state.otpDeadline = Date.now() + (data.expires_in || 300) * 1000;
    showOtp(true, "register");
    toast("We emailed a 6-digit code from parth@gr-conferences.com. Enter it to finish creating the account.");
    return;
  }
  if (state.authMode === "forgot") {
    const data = await api("/api/auth/forgot", { method: "POST", body: JSON.stringify({ email }) });
    state.otpEmail = email;
    state.otpDeadline = Date.now() + (data.expires_in || 300) * 1000;
    showOtp(true, "reset");
    toast("Enter the 6-digit code emailed from parth@gr-conferences.com and your new password.");
    return;
  }
}

function mountGoogle() {
  const note = document.getElementById("google-note");
  const slot = document.getElementById("google-signin");
  const clientId = state.health && state.health.google_client_id;
  const domain = (state.health && state.health.domain) || "@gr-conferences.com";
  if (!note || !slot) return;
  if (!clientId) {
    slot.innerHTML = "";
    slot.dataset.ready = "";
    note.textContent = "Google sign-in turns on after the admin pastes a Google client ID. Work accounts only.";
    return;
  }
  if (!window.google || !google.accounts || !google.accounts.id) {
    note.textContent = "Loading Google sign-in…";
    setTimeout(mountGoogle, 400);
    return;
  }
  if (slot.dataset.ready === clientId) return;
  slot.innerHTML = "";
  google.accounts.id.initialize({
    client_id: clientId,
    hosted_domain: domain.replace(/^@/, ""),
    callback: (response) => {
      signInWithGoogle(response).catch((error) => toast(error.message, "danger"));
    },
  });
  google.accounts.id.renderButton(slot, {
    theme: "outline",
    size: "large",
    text: "signin_with",
    shape: "pill",
    width: 320,
  });
  slot.dataset.ready = clientId;
  note.textContent = `Google accounts must end with ${domain}.`;
}

async function signInWithGoogle(response) {
  const data = await api("/api/auth/google", {
    method: "POST",
    body: JSON.stringify({ credential: response && response.credential }),
  });
  state.token = data.token;
  localStorage.setItem("parth.token", data.token);
  await enterApp();
  toast("Signed in with Google");
}

async function ping() {
  const line = document.getElementById("relay-line");
  try {
    state.health = await api("/api/health");
    await refreshUi();
    const domain = state.health.domain || "@gr-conferences.com";
    document.getElementById("login-email").placeholder = `name${domain}`;
    if (line) line.textContent = "";
    paintLoginButton();
    mountGoogle();
  } catch (error) {
    if (line) line.textContent = error.message;
  }
}

function openLimits(email) {
  const user = state.users.find((item) => item.email === email);
  if (!user) return;
  const limits = user.limits || {};
  openModal(`
    <h3>Limits for ${esc(email)}</h3>
    <div class="limits-grid">
      <label>Per minute<input id="lim-minute" class="input" type="number" value="${esc(limits.per_minute)}"></label>
      <label>Per hour<input id="lim-hour" class="input" type="number" value="${esc(limits.per_hour)}"></label>
      <label>Per day<input id="lim-day" class="input" type="number" value="${esc(limits.per_day)}"></label>
      <label>Max batch<input id="lim-batch" class="input" type="number" value="${esc(limits.max_batch)}"></label>
      <label>Window start<input id="lim-start" class="input" value="${esc(limits.window_start)}"></label>
      <label>Window end<input id="lim-end" class="input" value="${esc(limits.window_end)}"></label>
    </div>
    <label>Timezone<input id="lim-tz" class="input" value="${esc(limits.window_tz || "UTC")}"></label>
    <label class="check-line"><input id="lim-window" type="checkbox" ${limits.enforce_window ? "checked" : ""}> Enforce sending window</label>
    <div class="row">
      <button class="btn btn-ghost" type="button" data-action="modal-cancel">Cancel</button>
      <button class="btn btn-primary" type="button" data-action="save-limits" data-email="${esc(email)}">Save limits</button>
    </div>`);
}

function applyEditorStyle(declarations) {
  const editor = document.getElementById("editor");
  editor.focus();
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return;
  const span = document.createElement("span");
  span.setAttribute("style", declarations);
  if (range.collapsed) {
    span.appendChild(document.createTextNode("\u200b"));
    range.insertNode(span);
    const caret = document.createRange();
    caret.setStart(span.firstChild, 1);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);
    return;
  }
  span.appendChild(range.extractContents());
  range.insertNode(span);
  selection.removeAllRanges();
  const after = document.createRange();
  after.selectNodeContents(span);
  after.collapse(false);
  selection.addRange(after);
}

function cssFontFamily(name) {
  const safe = String(name || "Arial").replace(/["\\]/g, "");
  return `"${safe}", Arial, sans-serif`;
}

function applyFontSize(size) {
  const pixels = Math.max(8, Math.min(120, Number(size) || 14));
  const menu = document.getElementById("font-size");
  const custom = document.getElementById("font-size-custom");
  if (menu && [...menu.options].some((option) => option.value === String(pixels))) menu.value = String(pixels);
  if (custom) custom.value = String(pixels);
  applyEditorStyle(`font-size: ${pixels}px`);
}

const actions = {
  async nav(el) {
    const next = el.dataset.view;
    if ((next === "master" || next === "config") && !isMasterUser()) {
      state.view = "home";
      renderView();
      return;
    }
    state.view = next;
    if (state.view === "master" || state.view === "config") await refreshMaster();
    renderView();
  },
  "auth-mode"(el) {
    showOtp(false, "");
    state.otpPurpose = "";
    setAuthMode(el.dataset.mode);
  },
  "add-sender-card"() {
    const list = document.getElementById("sender-list");
    if (!list) return;
    list.classList.add("is-expanded");
    const more = document.querySelector("[data-action='toggle-sender-more']");
    if (more) {
      more.classList.add("is-open");
      more.setAttribute("aria-expanded", "true");
      const label = more.querySelector(".more-label");
      if (label) label.textContent = "Hide";
    }
    list.insertAdjacentHTML("beforeend", htmlSenderCard(blankSender(), list.children.length, true));
    icons();
  },
  "toggle-sender-card"(el) {
    const card = el.closest("[data-sender-card]");
    if (!card) return;
    const body = card.querySelector(".sender-body");
    const open = body.classList.toggle("hidden") === false;
    card.classList.toggle("is-open", open);
    el.setAttribute("aria-expanded", open ? "true" : "false");
    el.title = open ? "Hide mailbox" : "Show mailbox";
  },
  "toggle-sender-more"(el) {
    const list = document.getElementById("sender-list");
    if (!list) return;
    const open = list.classList.toggle("is-expanded");
    el.classList.toggle("is-open", open);
    el.setAttribute("aria-expanded", open ? "true" : "false");
    el.title = open ? "Hide extra mailing accounts" : "Show more mailing accounts";
    const label = el.querySelector(".more-label");
    if (label) label.textContent = open ? "Hide" : "Show more";
  },
  "remove-sender-card"(el) {
    const card = el.closest("[data-sender-card]");
    if (card) card.remove();
  },
  async "save-senders"() {
    const senders = readSenderCards();
    if (!senders.length) throw new Error("Add at least one mailing email.");
    senders.forEach((item) => {
      const code = compactAppPassword(item.password);
      if (code && !/^[A-Za-z0-9]{16}$/.test(code)) {
        throw new Error("Each app password must be 16 characters. Spaces are fine.");
      }
      if (!code && !item.has_password) {
        throw new Error("Paste the 16-digit Google app password for " + (item.email || "each new mailbox") + ".");
      }
    });
    const data = await api("/api/master/senders", { method: "POST", body: JSON.stringify({ senders }) });
    state.masterSenders = data.senders || [];
    await refreshCatalog();
    renderView();
    toast("Mailing accounts saved. Approve users in the queue below.");
  },
  async "fetch-mailbox-sheet"() {
    const input = document.getElementById("mailbox-sheet-url");
    const url = (input && input.value || state.mailboxSheetUrl || "").trim();
    if (!url) throw new Error("Paste the Google Sheet link.");
    const data = await api("/api/master/senders/sheet", { method: "POST", body: JSON.stringify({ url }) });
    state.mailboxSheetUrl = data.sheet_url || url;
    state.masterSenders = data.senders || [];
    await refreshCatalog();
    renderView();
    const skipped = (data.skipped || []).length ? ` Skipped ${data.skipped.join(", ")}.` : "";
    toast(`Fetched ${data.added || 0} new and updated ${data.updated || 0} mailing accounts.${skipped}`);
  },
  async "test-config-sender"(el) {
    const card = el.closest("[data-sender-card]");
    if (!card) return;
    const payload = readSenderCard(card);
    const data = await api("/api/master/senders/test", { method: "POST", body: JSON.stringify(payload) });
    if (data.refreshed) {
      await refreshMaster();
      await refreshCatalog();
      renderView();
    }
    toast(data.message || (data.ok ? "Mailbox is ready." : "Mailbox test failed"), data.ok === false ? "warn" : "");
  },
  async "save-ga4"() {
    const tracking = readTrackingForm();
    const data = await api("/api/config/ga4", { method: "POST", body: JSON.stringify({ tracking }) });
    state.tracking = data.tracking;
    toast("GA4 tagging saved");
    renderView();
  },
  "tag-composer"() {
    const editor = document.getElementById("editor");
    if (!editor) return;
    editor.innerHTML = tagHtmlLinks(editor.innerHTML, Object.assign(readTrackingForm(), { enabled: true }));
    toast("Links in the composer now include UTM tags");
  },
  async "copy-tagged"() {
    const tracking = Object.assign(readTrackingForm(), { enabled: true });
    const url = (document.getElementById("ga4-test-url") || {}).value || "";
    if (!url) throw new Error("Paste a URL to tag.");
    const tagged = tagTrackedUrl(url, tracking);
    const sample = document.getElementById("ga4-sample");
    if (sample) sample.textContent = tagged;
    try {
      await navigator.clipboard.writeText(tagged);
      toast("Tagged URL copied");
    } catch (error) {
      toast(tagged);
    }
  },
  async "assign-sender"(el) {
    const select = document.querySelector(`[data-assign-select="${CSS.escape(el.dataset.email)}"]`) || document.querySelector(`[data-assign-select="${el.dataset.email}"]`);
    const senderId = select ? select.value : "";
    if (!senderId) throw new Error("Pick a sending mailbox.");
    await api("/api/master/senders/assign", { method: "POST", body: JSON.stringify({ email: el.dataset.email, sender_id: senderId }) });
    await refreshMaster();
    await refreshCatalog();
    renderView();
    toast("Mailbox assigned");
  },
  "toggle-theme"() {
    applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
  },
  logout() { signOut(true); },
  async "save-google"() {
    const clientId = document.getElementById("google-client").value.trim();
    const data = await api("/api/master/google", { method: "POST", body: JSON.stringify({ client_id: clientId }) });
    state.health.google_client_id = data.google_client_id;
    toast(data.google_client_id ? "Google sign-in is on for work accounts." : "Google sign-in is off.");
  },
  async "save-desk"() {
    const data = await api("/api/master/ui", { method: "POST", body: JSON.stringify({ ui: readDeskForm() }) });
    state.ui = data.ui;
    applyDesk();
    renderView();
    toast("User desk saved. It stays after the app is closed.");
  },
  "open-composer"() { setComposerMode("dock"); document.getElementById("subject-input").focus(); },
  "composer-min"(el, event) { event.stopPropagation(); setComposerMode("min"); },
  "composer-dock"(el, event) { event.stopPropagation(); setComposerMode("dock"); },
  "composer-max"(el, event) { event.stopPropagation(); setComposerMode("max"); },
  "composer-bar"(el, event) {
    if (event.target.closest("button")) return;
    const composer = document.getElementById("composer");
    if (composer.classList.contains("is-min")) setComposerMode("dock");
  },
  async "composer-close"(el, event) {
    event.stopPropagation();
    const dirty = document.getElementById("subject-input").value || document.getElementById("editor").innerText.trim();
    if (dirty) {
      const ok = await askConfirm("Close the composer?", "The current text stays in the local draft.", "Close");
      if (!ok) return;
    }
    setComposerMode("hidden");
  },
  format(el) {
    document.getElementById("editor").focus();
    document.execCommand("styleWithCSS", false, true);
    document.execCommand(el.dataset.cmd, false, null);
  },
  async "save-drive"() {
    const body = {
      enabled: document.getElementById("drive-enabled").checked,
      folder_name: document.getElementById("drive-name").value,
      parent_folder_id: document.getElementById("drive-folder").value,
    };
    const pasted = document.getElementById("drive-json").value.trim();
    if (pasted) body.service_account_json = pasted;
    const data = await api("/api/master/drive", { method: "POST", body: JSON.stringify(body) });
    state.health = await api("/api/health");
    if (state.health) state.health.drive = data.drive;
    toast(data.drive && data.drive.ready ? "Drive is ready" : (data.drive && data.drive.reason) || "Drive settings saved");
    renderView();
  },
  async "save-otp-password"() {
    const field = document.getElementById("otp-app-password");
    const data = await api("/api/master/otp-password", { method: "POST", body: JSON.stringify({ password: field.value }) });
    field.value = "";
    state.health = await api("/api/health");
    if (state.health) state.health.otp_ready = data.otp_ready !== false;
    toast(data.message || "App password saved");
    renderView();
  },
  async "insert-link"() {
    saveRange();
    const url = await askText("Link address", "https://");
    if (!url) return;
    restoreRange();
    document.execCommand("createLink", false, url);
  },
  "insert-var"(el) { insertToken(el.dataset.token); },
  "toggle-cc"() { document.getElementById("cc-fields").classList.toggle("hidden"); },
  "pick-image"() { document.getElementById("image-input").click(); },
  "pick-attachment"() { document.getElementById("attach-input").click(); },
  "remove-attachment"(el) {
    state.attachments.splice(Number(el.dataset.index), 1);
    paintAttachments();
  },
  "browse-excel"() { document.getElementById("excel-input").click(); },
  "fetch-sheet": fetchSheet,
  "download-sample": downloadSample,
  "add-emails": addQuickEmails,
  async "clear-recipients"() {
    const ok = await askConfirm("Clear recipients?", "This removes the list loaded in the browser.", "Clear");
    if (ok) clearRecipients();
  },
  "save-draft"() { return saveDraft(true); },
  "smtp-send"() { return sendCampaign("send"); },
  "smtp-draft"() { return sendCampaign("draft"); },
  "schedule-toggle"() { return toggleSchedule(); },
  async "template-open"(el) {
    const id = el.dataset.id;
    if (!id || id === state.activeTemplateId) return;
    captureTemplate();
    state.activeTemplateId = id;
    applyTemplate(activeTemplate());
    persistTemplates();
    renderTemplates();
    document.getElementById("subject-input").focus();
  },
  async "template-new"() {
    if (state.templates.length >= 30) throw new Error("30 templates is the limit. Delete one to add another.");
    const name = await askText("Template name", "Follow-up");
    if (!name) return;
    captureTemplate();
    const template = { id: templateId(), name: name.slice(0, 40), subject: "", html: "" };
    state.templates.push(template);
    state.activeTemplateId = template.id;
    applyTemplate(template);
    persistTemplates();
    renderTemplates();
    document.getElementById("subject-input").focus();
  },
  async "template-delete"() {
    if (state.templates.length < 2) return;
    const current = activeTemplate();
    const agreed = await askConfirm("Delete this template?", `${current ? current.name : "This template"} is removed from this browser.`, "Delete");
    if (!agreed) return;
    state.templates = state.templates.filter((item) => item.id !== state.activeTemplateId);
    state.activeTemplateId = state.templates[0].id;
    applyTemplate(state.templates[0]);
    persistTemplates();
    renderTemplates();
  },
  "send-campaign"() { return sendCampaign("send"); },
  async "request-sender"(el) {
    const data = await api("/api/senders/request", { method: "POST", body: JSON.stringify({ sender_id: el.dataset.id }) });
    await refreshCatalog();
    renderView();
    toast(data.emailed ? "Request sent. The admin got an email." : "Request saved. The approval email could not be sent.");
  },
  async "request-mailbox"() {
    const email = (document.getElementById("request-mailbox") || {}).value || "";
    if (!email.trim()) throw new Error("Type the sending email you want to use.");
    const data = await api("/api/senders/request", { method: "POST", body: JSON.stringify({ email: email.trim() }) });
    await refreshCatalog();
    renderView();
    toast(data.emailed ? "Request sent. The admin got an email." : "Request saved. The approval email could not be sent.");
  },
  async "campaign-control"(el) {
    await api(`/api/campaigns/${el.dataset.id}/control`, { method: "POST", body: JSON.stringify({ action: el.dataset.op }) });
    await refreshCampaigns();
    paintScheduleButton();
    if (state.view === "master") await refreshMaster();
    renderView();
    toast(el.dataset.op === "kill" ? "Campaign stopped" : "Campaign updated");
  },
  "download-report"(el) { return downloadReport(el.dataset.id); },
  async "open-campaign"(el) {
    const data = await api(`/api/campaigns/${el.dataset.id}`);
    const campaign = data.campaign;
    const errors = (campaign.errors || []).map((item) => `<p class="fail-reason"><strong>${esc(item.email)}:</strong> ${esc(item.error || item.status)}</p>`).join("");
    openModal(`<h3>${esc(campaign.subject)}</h3><p>${esc(campaign.status)} · ${campaign.sent_count} sent · ${campaign.failed_count} failed · ${campaign.bounced_count} bounced</p>${errors || "<p>No failures recorded.</p>"}<button class="btn btn-ghost" type="button" data-action="modal-cancel">Close</button>`);
    state.modalResolve = null;
  },
  async "remove-user"(el) {
    const email = el.dataset.email;
    const ok = await askConfirm(
      "Remove this user?",
      `${email} will lose sign-in and mailbox access. Live campaigns for that account will stop.`,
      "Remove user"
    );
    if (!ok) return;
    await api("/api/master/users/remove", { method: "POST", body: JSON.stringify({ email }) });
    await refreshMaster();
    renderView();
    toast("User removed");
  },
  async "toggle-user"(el) {
    const enabled = el.dataset.enabled !== "true";
    if (el.dataset.email === state.user.email && !enabled) {
      const ok = await askConfirm("Disable your own account?", "You will not be able to sign in until an admin enables it.", "Disable");
      if (!ok) return;
    }
    await api("/api/master/users/enabled", { method: "POST", body: JSON.stringify({ email: el.dataset.email, enabled }) });
    await refreshMaster();
    renderView();
  },
  "edit-limits"(el) { openLimits(el.dataset.email); },
  async "save-limits"(el) {
    const limits = {
      per_minute: Number(document.getElementById("lim-minute").value),
      per_hour: Number(document.getElementById("lim-hour").value),
      per_day: Number(document.getElementById("lim-day").value),
      max_batch: Number(document.getElementById("lim-batch").value),
      window_start: document.getElementById("lim-start").value,
      window_end: document.getElementById("lim-end").value,
      window_tz: document.getElementById("lim-tz").value,
      enforce_window: document.getElementById("lim-window").checked,
    };
    await api("/api/master/users/limits", { method: "POST", body: JSON.stringify({ email: el.dataset.email, limits }) });
    closeModal();
    await refreshMaster();
    renderView();
    toast("Limits saved");
  },
  async decide(el) {
    const capField = document.querySelector(`[data-cap="${el.dataset.id}"]`);
    const body = { id: Number(el.dataset.id), action: el.dataset.op };
    if (capField && capField.value) body.limits = { per_day: Number(capField.value) };
    await api("/api/master/approvals", { method: "POST", body: JSON.stringify(body) });
    await refreshMaster();
    renderView();
    toast(el.dataset.op === "approve" ? "Sender approved" : "Request denied");
  },
  async "test-drive"() {
    try {
      const data = await api("/api/master/drive/test", { method: "POST", body: "{}" });
      toast("Drive folder ready for " + (data.email || "the service account"));
    } catch (error) {
      toast(error.message, "warn");
    }
  },
  async "test-master-smtp"() {
    try {
      const data = await api("/api/master/senders/test", { method: "POST", body: JSON.stringify({ target: "master" }) });
      toast(data.message, data.ok === false ? "warn" : "");
    } catch (error) {
      toast(error.message, "warn");
    }
  },
  "resend-otp": requestOtp,
  "modal-ok"() { finishModal(true); },
  "modal-cancel"() { finishModal(state.modalMode === "text" ? "" : false); },
  "modal-submit"() {
    const input = document.getElementById("modal-input");
    finishModal(input ? input.value.trim() : "");
  },
};

document.addEventListener("click", async (event) => {
  const el = event.target.closest("[data-action]");
  if (!el || !actions[el.dataset.action]) return;
  try {
    await actions[el.dataset.action](el, event);
  } catch (error) {
    toast(error.message, "danger");
  }
});

document.addEventListener("mousedown", (event) => {
  state.lastInteract = Date.now();
  if (!event.target.closest("#toolbar, #var-bar")) return;
  saveRange();
  if (event.target.closest("select, input, textarea, label")) return;
  event.preventDefault();
}, true);

document.addEventListener("input", (event) => {
  if (["subject-input", "editor", "to-input"].includes(event.target.id) || event.target.id === "editor") updatePreview();
  if (event.target.id === "subject-input" || event.target.id === "editor") captureTemplate();
  if (event.target.id === "recipient-search") {
    state.recipientQuery = event.target.value;
    refreshFilter();
  }
  if (event.target.id === "user-search") {
    state.userQuery = event.target.value.trim();
    renderView();
    const box = document.getElementById("user-search");
    if (box) {
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }
  }
  if (event.target.id === "composer-title") return;
  const subject = document.getElementById("subject-input");
  const title = document.getElementById("composer-title");
  if (subject && title && event.target === subject) title.textContent = subject.value.trim() || "New Message";
});

document.addEventListener("change", async (event) => {
  if (event.target.id === "preview-pick") paintFullPreview();
  if (event.target.id === "excel-input") {
    const files = [...event.target.files];
    event.target.value = "";
    try { await importFiles(files); } catch (error) { toast(error.message, "danger"); }
  }
  if (event.target.id === "schedule-on") {
    document.getElementById("schedule-fields").classList.toggle("hidden", !event.target.checked);
    paintSendLabel();
  }
  if (event.target.id === "font-name") {
    restoreRange();
    applyEditorStyle(`font-family: ${cssFontFamily(event.target.value)}`);
  }
  if (event.target.id === "font-color") {
    restoreRange();
    document.execCommand("styleWithCSS", false, true);
    document.execCommand("foreColor", false, event.target.value);
  }
  if (event.target.id === "font-highlight") {
    restoreRange();
    document.execCommand("styleWithCSS", false, true);
    document.execCommand("hiliteColor", false, event.target.value);
  }
  if (event.target.id === "font-size" || event.target.id === "font-size-custom") {
    applyFontSize(event.target.value);
  }
  if (event.target.id === "api-base") {
    localStorage.setItem("parth.apiBase", event.target.value.trim());
    ping();
  }
  if (event.target.id === "image-input" && event.target.files[0]) {
    const dataUrl = await fileToBase64(event.target.files[0]).then((raw) => `data:${event.target.files[0].type};base64,${raw}`);
    document.getElementById("editor").focus();
    document.execCommand("insertHTML", false, `<img src="${dataUrl}" alt="" style="max-width:100%">`);
    event.target.value = "";
  }
  if (event.target.id === "attach-input") {
    for (const file of event.target.files) {
      if (file.size > 8_000_000) {
        toast(file.name + " is larger than 8 MB", "warn");
        continue;
      }
      state.attachments.push({ filename: file.name, mime: file.type || "application/octet-stream", data_base64: await fileToBase64(file) });
    }
    event.target.value = "";
    paintAttachments();
  }
});

document.addEventListener("dragover", (event) => {
  if (event.target.closest("#dropzone")) {
    event.preventDefault();
    event.target.closest("#dropzone").classList.add("hot");
  }
});
document.addEventListener("dragleave", (event) => {
  const zone = event.target.closest("#dropzone");
  if (zone) zone.classList.remove("hot");
});
document.addEventListener("drop", async (event) => {
  const zone = event.target.closest("#dropzone");
  if (!zone) return;
  event.preventDefault();
  zone.classList.remove("hot");
  try { await importFiles(event.dataTransfer.files); } catch (error) { toast(error.message, "danger"); }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.modalResolve) finishModal(state.modalMode === "text" ? "" : false);
  else if (event.key === "Escape") closeModal();
});

document.getElementById("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.getElementById("login-submit");
  button.disabled = true;
  try {
    await submitAuth();
  } catch (error) {
    toast(error.message, "danger");
  } finally {
    button.disabled = false;
  }
});

document.getElementById("login-email").addEventListener("input", () => {
  const email = normalizeEmail(document.getElementById("login-email").value);
  if (state.otpEmail && email !== state.otpEmail) {
    state.otpEmail = "";
    state.otpDeadline = 0;
    const code = document.getElementById("login-code");
    if (code) code.value = "";
  }
  paintLoginButton();
});

document.getElementById("login-code").addEventListener("input", () => {
  const field = document.getElementById("login-code");
  const digits = String(field.value || "").replace(/\D/g, "").slice(0, 6);
  if (field.value !== digits) field.value = digits;
  paintLoginButton();
});

document.getElementById("editor").addEventListener("input", updatePreview);

setInterval(tickClock, 250);
tickClock();

setInterval(() => {
  if (!state.otpDeadline) return;
  const left = Math.max(0, Math.ceil((state.otpDeadline - Date.now()) / 1000));
  const label = document.getElementById("otp-timer");
  if (!label) return;
  const minutes = Math.floor(left / 60);
  const seconds = String(left % 60).padStart(2, "0");
  label.textContent = left ? `Code expires in ${minutes}:${seconds}` : "Code expired. Request a new one.";
}, 250);

setInterval(() => {
  if (!state.user) return;
  const subject = document.getElementById("subject-input").value.trim();
  const text = document.getElementById("editor").innerText.trim();
  if (!subject && !text) return;
  captureTemplate();
  saveDraft(false).catch(() => {});
}, 8000);
setInterval(() => { tick().catch(() => {}); }, 4000);

applyTheme(localStorage.getItem("parth.theme") || "dark");
document.getElementById("api-base").value = localStorage.getItem("parth.apiBase") || defaultBase();
setAuthMode("login");
fillZones();
loadTemplates();
renderTemplates();
renderVars();
icons();
ping();

if (state.token) {
  enterApp().catch(() => signOut(false));
}

window.ParthMail = { state, importFiles, apiBase };
