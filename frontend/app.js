const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const ROW_HEIGHT = 46;
const TITLES = {
  home: ["Desk", "Sender access, relay status, and recent campaigns"],
  recipients: ["Recipients", "Import a spreadsheet. The list stays smooth past 100,000 rows."],
  campaigns: ["Campaigns", "Pace, pauses, and delivery counts"],
  history: ["History", "Reports and Drive links for finished campaigns"],
  master: ["Master", "Accounts, approvals, limits, and the live queue"],
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
  columns: new Set(["FirstName", "LastName", "Company", "Custom1", "Email"]),
  sourceFiles: [],
  importing: false,
  importCount: 0,
  attachments: [],
  draftId: localStorage.getItem("parth.draftId") || "",
  hasGrant: false,
  otpDeadline: 0,
  otpEmail: "",
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
  if (color && !state.user) color.value = theme === "light" ? "#172033" : "#d7efe8";
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
    : status === "failed" || status === "FAILED" || status === "killed" || status === "denied" ? "danger"
      : "warn";
  return `<span class="badge ${kind}">${esc(status)}</span>`;
}

function safeUrl(url) {
  return /^https:\/\//i.test(url || "") ? url : "";
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
    if (span && labels[button.dataset.view]) span.textContent = labels[button.dataset.view];
  });
  const composeLabel = document.querySelector("#compose-button span");
  if (composeLabel && labels.compose) composeLabel.textContent = labels.compose;
  document.body.classList.toggle("is-master", state.user && state.user.role === "ROLE_MASTER");
  const who = document.getElementById("whoami");
  if (who && state.user) who.textContent = state.user.email;
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
  const views = { home: htmlHome, recipients: htmlRecipients, campaigns: htmlCampaigns, history: htmlHistory, master: htmlMaster };
  root.innerHTML = (views[state.view] || htmlHome)();
  paintChrome();
  icons();
  if (state.view === "recipients") mountRecipients();
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
      <div><strong>${esc(sender.display_name || sender.email)}</strong><div class="hint">${esc(sender.email)}</div></div>
      <div class="row">
        ${statusBadge(sender.status)}
        ${sender.status === "approved" ? "" : `<button class="btn btn-ghost" type="button" data-action="request-sender" data-id="${esc(sender.id)}">Request access to sender ID: ${esc(sender.email)}</button>`}
      </div>
    </div>`).join("") || `<p>No sender identities are configured on the relay.</p>`;
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
      <article class="card glass stat"><span class="hint">Waiting on master</span><strong>${pending.length}</strong></article>
    </div>
    <p class="hint">These counts live in the relay database. Closing the browser or the app does not reset them, and another account cannot send a second message to someone already emailed.</p>
    <section class="card glass stack"><h3>Sender identities</h3>${senders}</section>
    <section class="stack"><h3>Recent campaigns</h3>${recent}</section>`;
}

function htmlRecipients() {
  return `
    <section class="card glass stack">
      <div class="spread">
        <h3>Import Excel or CSV</h3>
        <button class="btn btn-ghost" type="button" data-action="download-sample">Sample CSV</button>
      </div>
      <div id="dropzone" class="dropzone">
        <p>Drop .xlsx, .xls, or .csv files here</p>
        <p class="hint">Parsing runs in a background worker. Only the rows you see are drawn.</p>
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
      <div class="vhead"><span>#</span><span>Email</span><span>First</span><span>Last</span><span>Company</span></div>
      <div class="vscroll" id="recipient-scroller"><div id="recipient-spacer"><div id="recipient-rows"></div></div></div>
    </section>`;
}

function campaignCard(campaign) {
  const skipped = campaign.skipped_count || 0;
  const done = (campaign.sent_count || 0) + (campaign.failed_count || 0) + (campaign.bounced_count || 0) + skipped;
  const pct = campaign.total_count ? Math.min(100, Math.round((done / campaign.total_count) * 100)) : 0;
  const upload = safeUrl(campaign.drive_upload_url);
  const report = safeUrl(campaign.drive_report_url);
  const active = ["running", "paused", "scheduled"].includes(campaign.status);
  return `
    <article class="card glass stack">
      <div class="spread">
        <div><strong>${esc(campaign.subject || "Untitled")}</strong><div class="hint">${esc(campaign.owner)} · ${esc(campaign.sender_email || campaign.sender_id || "")}</div></div>
        ${statusBadge(campaign.status)}
      </div>
      <div class="bar"><span style="width:${pct}%"></span></div>
      <div class="hint">${campaign.sent_count || 0} sent · ${campaign.failed_count || 0} failed · ${campaign.bounced_count || 0} bounced · ${skipped} already emailed · ${campaign.total_count || 0} total</div>
      ${campaign.hold_reason ? `<div class="note">${esc(campaign.hold_reason)}</div>` : ""}
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
  const rows = state.campaigns.filter((item) => !["complete", "killed"].includes(item.status));
  return `<section class="stack">${rows.map(campaignCard).join("") || `<div class="card glass"><p>No active campaigns.</p></div>`}</section>`;
}

function htmlHistory() {
  const rows = state.campaigns.filter((item) => ["complete", "killed"].includes(item.status));
  return `<section class="stack">${rows.map(campaignCard).join("") || `<div class="card glass"><p>Finished campaigns will land here with their report.</p></div>`}</section>`;
}

function htmlMaster() {
  if (!state.user || state.user.role !== "ROLE_MASTER") return `<div class="card glass"><p>Master access required.</p></div>`;
  const query = state.userQuery || "";
  const users = state.users.filter((user) => user.email.includes(query.toLowerCase())).map((user) => `
    <div class="spread">
      <div><strong>${esc(user.email)}</strong><div class="hint">${esc(user.role)} · ${user.sent_total || 0} stored · ${user.sent_today} in 24h</div></div>
      <div class="row">
        <button class="switch ${user.enabled ? "on" : ""}" type="button" data-action="toggle-user" data-email="${esc(user.email)}" data-enabled="${user.enabled}" aria-label="Enable account"></button>
        <button class="btn btn-ghost" type="button" data-action="edit-limits" data-email="${esc(user.email)}">Limits</button>
      </div>
    </div>`).join("") || `<p>No accounts yet.</p>`;
  const approvals = state.approvals.filter((item) => item.status === "pending").map((item) => `
    <div class="spread">
      <div><strong>${esc(item.email)}</strong><div class="hint">Request access to sender ID: ${esc(item.sender_email)}</div></div>
      <div class="row">
        <input class="input" style="max-width:120px" data-cap="${item.id}" type="number" min="1" placeholder="Max / day">
        <button class="btn btn-primary" type="button" data-action="decide" data-op="approve" data-id="${item.id}">Approve</button>
        <button class="btn btn-danger" type="button" data-action="decide" data-op="deny" data-id="${item.id}">Deny</button>
      </div>
    </div>`).join("") || `<p>The approval queue is clear.</p>`;
  const live = ((state.monitor && state.monitor.campaigns) || []).map(campaignCard).join("") || `<p>No live queues.</p>`;
  const boxes = ((state.monitor && state.monitor.mailboxes) || []).map((box) => `
    <article class="card glass stat"><span class="hint">${esc(box.email)}</span><strong>${box.remaining}</strong><span class="hint">${box.used_24h} of ${box.cap_24h} in 24h · ${box.live ? "live" : "simulated"}</span></article>`).join("");
  const audit = state.audit.slice(0, 30).map((item) => `
    <div class="hint">${esc(stamp(item.created_at))} · ${esc(item.actor)} · ${esc(item.action)} · ${esc(item.detail || "")}</div>`).join("") || `<p>No audit events yet.</p>`;
  return `
    <div class="stat-grid">${boxes}</div>
    <section class="card glass stack"><div class="spread"><h3>Accounts</h3><input id="user-search" class="input" style="max-width:240px" placeholder="Filter" value="${esc(query)}"></div>${users}</section>
    <section class="card glass stack"><h3>Access approval queue</h3>${approvals}</section>
    <section class="stack"><div class="spread"><h3>Live queues</h3><button class="btn btn-ghost" type="button" data-action="test-drive">Test Drive</button><button class="btn btn-ghost" type="button" data-action="test-master-smtp">Test master SMTP</button></div>${live}</section>
    <section class="card glass stack"><h3>Audit</h3>${audit}</section>
    <section class="card glass stack">
      <h3>Google sign-in</h3>
      <p class="hint">Create a Web client in Google Cloud, then paste its client ID. Add this relay address and your GitHub Pages address as authorized JavaScript origins. Only Google accounts on ${esc((state.health && state.health.domain) || "@gr-conferences.com")} can sign in.</p>
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
    ["show_compose", "Compose"],
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
      <p class="hint">These choices are stored on the relay. They stay in place after the app is closed and apply to every signed-in user. Master keeps the full desk.</p>
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
        <label>Compose label<input id="desk-label-compose" class="input" maxlength="24" value="${esc(labels.compose || "Compose")}"></label>
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
    "show_pace", "show_schedule", "show_attachments", "show_cc", "show_variables",
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
  if (authTag) authTag.textContent = ui.welcome_text || "Liquid glass desk";
  document.title = `${ui.brand_name || "Parth"} ${ui.brand_tagline || "Mailing"}`.trim();
  const master = state.user && state.user.role === "ROLE_MASTER";
  if (!master && ui.force_theme) applyTheme(ui.force_theme);
  const themeButton = document.getElementById("theme-toggle");
  if (themeButton) themeButton.classList.toggle("hidden", !master && (!!ui.force_theme || ui.allow_theme_toggle === false));
  const flags = { home: "show_desk", recipients: "show_recipients", campaigns: "show_campaigns", history: "show_history" };
  document.querySelectorAll(".nav-btn").forEach((button) => {
    const key = flags[button.dataset.view];
    if (key) button.classList.toggle("hidden", !master && ui[key] === false);
  });
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
    const allowed = { home: ui.show_desk, recipients: ui.show_recipients, campaigns: ui.show_campaigns, history: ui.show_history, master: false };
    if (allowed[state.view] === false && state.view !== "home") state.view = ui.show_desk === false ? "campaigns" : "home";
  }
}

function refreshFilter() {
  const query = state.recipientQuery.trim().toLowerCase();
  state.filtered = query
    ? state.recipients.filter((row) => `${row.email} ${row.first_name} ${row.last_name} ${row.company}`.toLowerCase().includes(query))
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
        <span>${esc(row.first_name)}</span>
        <span>${esc(row.last_name)}</span>
        <span>${esc(row.company)}</span>
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
  const names = Array.from(state.columns).slice(0, 16);
  bar.innerHTML = names.map((name) => `<button type="button" data-action="insert-var" data-token="{{${esc(name)}}}">${esc(name)}</button>`).join("");
}

function fillSenders() {
  const select = document.getElementById("from-select");
  const approved = state.catalog.filter((sender) => sender.status === "approved");
  const signature = approved.map((sender) => sender.id).join("|");
  state.hasGrant = approved.length > 0;
  if (select.dataset.sig === signature) return;
  const current = select.value;
  select.dataset.sig = signature;
  select.innerHTML = approved.length
    ? approved.map((sender) => `<option value="${esc(sender.id)}">${esc(sender.display_name || sender.email)} — ${esc(sender.email)}</option>`).join("")
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
  }, row.fields || {});
  return String(template || "").replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, key) => {
    const found = Object.keys(map).find((name) => name.toLowerCase() === key.toLowerCase());
    return found == null ? match : String(map[found] ?? "");
  });
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

async function saveDraft(manual) {
  const payload = collectComposer();
  localStorage.setItem("parth.localDraft", JSON.stringify(payload));
  if (!state.token || !state.hasGrant) {
    if (manual) toast("Saved in this browser. Sender approval is required before it syncs.");
    return;
  }
  const data = await api("/api/drafts", { method: "POST", body: JSON.stringify({ id: state.draftId || undefined, payload }) });
  state.draftId = data.id;
  localStorage.setItem("parth.draftId", data.id);
  if (manual) toast("Draft synced");
}

function paintSendLabel() {
  const button = document.getElementById("send-button");
  const on = document.getElementById("schedule-on").checked;
  button.textContent = on ? "Schedule campaign" : "Send campaign";
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

async function importFiles(fileList) {
  const files = [...fileList].filter(Boolean);
  if (!files.length) return;
  const mode = (document.querySelector('input[name="import-mode"]:checked') || {}).value || "append";
  if (mode === "replace") {
    state.recipients = [];
    state.seen = new Set();
    state.stats = { invalid: 0, duplicates: 0 };
    state.sourceFiles = [];
    state.columns = new Set(["FirstName", "LastName", "Company", "Custom1", "Email"]);
  }
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
  const csv = "Email,FirstName,LastName,Company,Custom1\nada@example.com,Ada,Lovelace,Analytical,Gold\ngrace@example.com,Grace,Hopper,Navy,Compiler\n";
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

async function sendCampaign() {
  if (state.sending) return;
  const rows = mergedRecipients();
  if (!rows.length) throw new Error("Add at least one recipient.");
  const senderId = document.getElementById("from-select").value;
  if (!senderId) throw new Error("Request an approved sender identity first.");
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
  const scheduled = document.getElementById("schedule-on").checked;
  let scheduleAt = null;
  const zone = document.getElementById("schedule-zone").value || "UTC";
  if (scheduled) {
    const date = document.getElementById("schedule-date").value;
    const time = document.getElementById("schedule-time").value;
    if (!date || !time) throw new Error("Choose a date and time.");
    scheduleAt = zonedToUnix(date, time, zone);
  }
  const pace = {
    delay_min_seconds: Number(document.getElementById("delay-min").value),
    delay_max_seconds: Number(document.getElementById("delay-max").value),
    batch_size: Number(document.getElementById("batch-size").value),
    batch_pause_minutes: Number(document.getElementById("batch-pause").value),
  };
  const sender = state.catalog.find((item) => item.id === senderId);
  const agreed = await askConfirm(
    scheduled ? "Schedule this campaign?" : "Send this campaign?",
    `${rows.length.toLocaleString()} recipients from ${sender ? sender.email : senderId}. Delay ${pace.delay_min_seconds}-${pace.delay_max_seconds}s, batches of ${pace.batch_size}.`,
    scheduled ? "Schedule" : "Send"
  );
  if (!agreed) return;
  state.sending = true;
  try {
    const created = await api("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({
        sender_id: senderId,
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
    toast(scheduled ? "Campaign scheduled" : "Campaign is sending");
    state.view = "campaigns";
    await refreshCampaigns();
    renderView();
  } finally {
    state.sending = false;
  }
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
  const scope = state.user && state.user.role === "ROLE_MASTER" ? "all" : "mine";
  const data = await api("/api/campaigns?scope=" + scope);
  state.campaigns = data.campaigns || [];
}

async function refreshCatalog() {
  const data = await api("/api/senders");
  state.catalog = data.senders || [];
  fillSenders();
}

async function refreshMaster() {
  if (!state.user || state.user.role !== "ROLE_MASTER") return;
  const [users, approvals, audit, monitor] = await Promise.all([
    api("/api/master/users"),
    api("/api/master/approvals"),
    api("/api/master/audit"),
    api("/api/master/monitor"),
  ]);
  state.users = users.users || [];
  state.approvals = approvals.approvals || [];
  state.audit = audit.audit || [];
  state.monitor = monitor;
}

function campaignSignature() {
  const ledger = state.ledger || {};
  return JSON.stringify(state.campaigns.map((item) => [item.id, item.status, item.sent_count, item.failed_count, item.bounced_count, item.skipped_count, item.hold_reason, item.drive_report_url]))
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
  await refreshUi();
  await refreshLedger();
  await refreshCatalog();
  await refreshCampaigns();
  if (state.user.role === "ROLE_MASTER") await refreshMaster();
  state.campSig = campaignSignature();
  renderVars();
  fillZones();
  const local = localStorage.getItem("parth.localDraft");
  if (local) {
    try { restoreComposer(JSON.parse(local)); } catch (error) { /* ignore broken draft */ }
  }
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

function showOtp(on) {
  document.getElementById("otp-panel").classList.toggle("hidden", !on);
  document.getElementById("otp-resend").classList.toggle("hidden", !on);
  document.getElementById("login-submit").textContent = on ? "Sign in" : "Email me a code";
}

async function requestOtp() {
  const email = normalizeEmail(document.getElementById("login-email").value);
  const data = await api("/api/auth/request-otp", { method: "POST", body: JSON.stringify({ email }) });
  state.otpEmail = email;
  state.otpDeadline = Date.now() + (data.expires_in || 300) * 1000;
  showOtp(true);
  const note = document.getElementById("dev-otp-note");
  if (data.dev_otp) {
    document.getElementById("login-code").value = data.dev_otp;
    note.classList.remove("hidden");
    note.textContent = "Master SMTP is not configured, so this sign-in code is shown here and in the relay window. Add the master mailbox password to email codes instead.";
  } else {
    note.classList.add("hidden");
    document.getElementById("login-code").value = "";
  }
  document.getElementById("login-code").focus();
}

async function verifyOtp() {
  const email = normalizeEmail(document.getElementById("login-email").value);
  const code = document.getElementById("login-code").value.trim();
  const data = await api("/api/auth/verify-otp", { method: "POST", body: JSON.stringify({ email, code }) });
  state.token = data.token;
  localStorage.setItem("parth.token", data.token);
  await enterApp();
  toast(`Signed in as ${data.user.role === "ROLE_MASTER" ? "master" : "user"}`);
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
    note.textContent = "Google sign-in turns on after the master pastes a Google client ID. Work accounts only.";
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
  toast(`Signed in with Google as ${data.user.email}`);
}

async function ping() {
  const line = document.getElementById("relay-line");
  try {
    state.health = await api("/api/health");
    await refreshUi();
    const domain = state.health.domain || "@gr-conferences.com";
    document.getElementById("login-email").placeholder = `name${domain}`;
    line.textContent = state.health.otp_delivery === "email"
      ? "Relay connected. Sign-in codes are emailed."
      : "Relay connected in simulation. Sign-in codes appear on this screen until SMTP is configured.";
    mountGoogle();
  } catch (error) {
    line.textContent = error.message;
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

const actions = {
  async nav(el) {
    state.view = el.dataset.view;
    if (state.view === "master") await refreshMaster();
    renderView();
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
  "download-sample": downloadSample,
  "add-emails": addQuickEmails,
  async "clear-recipients"() {
    const ok = await askConfirm("Clear recipients?", "This removes the list loaded in the browser.", "Clear");
    if (ok) clearRecipients();
  },
  "save-draft"() { return saveDraft(true); },
  "send-campaign": sendCampaign,
  async "request-sender"(el) {
    await api("/api/senders/request", { method: "POST", body: JSON.stringify({ sender_id: el.dataset.id }) });
    await refreshCatalog();
    renderView();
    toast("Request sent to the master");
  },
  async "campaign-control"(el) {
    await api(`/api/campaigns/${el.dataset.id}/control`, { method: "POST", body: JSON.stringify({ action: el.dataset.op }) });
    await refreshCampaigns();
    if (state.view === "master") await refreshMaster();
    renderView();
    toast(el.dataset.op === "kill" ? "Campaign stopped" : "Campaign updated");
  },
  "download-report"(el) { return downloadReport(el.dataset.id); },
  async "open-campaign"(el) {
    const data = await api(`/api/campaigns/${el.dataset.id}`);
    const campaign = data.campaign;
    const errors = (campaign.errors || []).map((item) => `<div class="hint">${esc(item.email)} · ${esc(item.status)} · ${esc(item.error || "")}</div>`).join("");
    openModal(`<h3>${esc(campaign.subject)}</h3><p>${esc(campaign.status)} · ${campaign.sent_count} sent · ${campaign.failed_count} failed · ${campaign.bounced_count} bounced</p>${errors || "<p>No failures recorded.</p>"}<button class="btn btn-ghost" type="button" data-action="modal-cancel">Close</button>`);
    state.modalResolve = null;
  },
  async "toggle-user"(el) {
    const enabled = el.dataset.enabled !== "true";
    if (el.dataset.email === state.user.email && !enabled) {
      const ok = await askConfirm("Disable your own account?", "You will not be able to sign in until another master enables it.", "Disable");
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
      toast(data.message);
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
  if (event.target.closest("#toolbar, #var-bar")) event.preventDefault();
}, true);

document.addEventListener("input", (event) => {
  if (["subject-input", "editor", "to-input"].includes(event.target.id) || event.target.id === "editor") updatePreview();
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
  if (subject && title && event.target === subject) title.textContent = subject.value.trim() || "New campaign";
});

document.addEventListener("change", async (event) => {
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
    document.getElementById("editor").focus();
    document.execCommand("styleWithCSS", false, true);
    document.execCommand("fontName", false, event.target.value);
  }
  if (event.target.id === "font-color") {
    document.getElementById("editor").focus();
    document.execCommand("styleWithCSS", false, true);
    document.execCommand("foreColor", false, event.target.value);
  }
  if (event.target.id === "font-highlight") {
    document.getElementById("editor").focus();
    document.execCommand("styleWithCSS", false, true);
    document.execCommand("hiliteColor", false, event.target.value);
  }
  if (event.target.id === "font-size") {
    document.getElementById("editor").focus();
    document.execCommand("styleWithCSS", false, true);
    document.execCommand("fontSize", false, event.target.value);
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
    if (document.getElementById("otp-panel").classList.contains("hidden")) await requestOtp();
    else await verifyOtp();
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
    showOtp(false);
  }
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
  saveDraft(false).catch(() => {});
}, 8000);
setInterval(() => { tick().catch(() => {}); }, 4000);

applyTheme(localStorage.getItem("parth.theme") || "dark");
document.getElementById("api-base").value = localStorage.getItem("parth.apiBase") || defaultBase();
fillZones();
renderVars();
icons();
ping();

if (state.token) {
  enterApp().catch(() => signOut(false));
}

window.ParthMail = { state, importFiles, apiBase };
