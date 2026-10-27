/* Spreadsheet parser. Runs off the UI thread so large lists do not freeze the desk. */

try {
  importScripts("xlsx.js");
} catch (error) {
  try {
    importScripts("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js");
  } catch (fallbackError) {
    self.xlsxMissing = true;
  }
}

const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const HEADER_SETS = {
  email: new Set(["email", "e-mail", "email address", "emailaddress", "mail", "recipient", "recipient email", "recipientemail", "to", "to email", "email to", "receiver", "receiver email", "receivers email", "reciver", "reciver email", "recivers email"]),
  first: new Set(["firstname", "first name", "first", "given name", "givenname", "name"]),
  last: new Set(["lastname", "last name", "last", "surname", "family name", "familyname"]),
  company: new Set(["company", "organization", "organisation", "org", "affiliation", "institution"]),
  custom: new Set(["custom1", "custom", "note", "tag", "segment"]),
  template: new Set(["template", "templates", "template name", "templatename", "template_name", "template id", "templateid", "email template", "emailtemplate", "html", "body", "message", "email body", "emailbody"]),
  sender: new Set(["sender", "from", "from email", "sender email", "mailbox", "account email", "mailing email", "sending email", "from address", "send from", "send using", "sending account", "from account", "mail from", "sender account", "from mailbox", "email account"]),
  sender_name: new Set(["sender name", "from name", "displayname", "display name", "sendername", "sender display name", "name of sender"]),
  cc: new Set(["cc", "cc email", "cc mail", "cc address", "carbon copy", "copy to", "email cc"]),
  bcc: new Set(["bcc", "bcc email", "bcc mail", "bcc address", "blind carbon copy", "blind copy"]),
};

function normHeader(value) {
  return String(value || "").replace(/^\uFEFF/, "").trim().toLowerCase();
}

function cleanEmail(value) {
  let text = String(value || "").replace(/\u00a0/g, "").replace(/\u200b/g, "").trim().toLowerCase();
  const wrapped = text.match(/<([^>]+)>/);
  if (wrapped) text = wrapped[1].trim().toLowerCase();
  return text;
}

function cell(row, index) {
  if (index < 0 || index == null) return "";
  const value = row[index];
  return value == null ? "" : String(value).trim().slice(0, 5000);
}

function headerHit(name, set) {
  if (set.has(name)) return true;
  const compact = name.replace(/[^a-z0-9]+/g, "");
  if (!compact) return false;
  for (const item of set) {
    if (item.replace(/[^a-z0-9]+/g, "") === compact) return true;
  }
  return false;
}

function buildMapper(headers) {
  const mapper = { email: -1, first: -1, last: -1, company: -1, custom: -1, template: -1, sender: -1, sender_name: -1, cc: -1, bcc: -1, fields: [] };
  headers.forEach((header, index) => {
    const name = normHeader(header);
    if (!name) return;
    if (mapper.email < 0 && headerHit(name, HEADER_SETS.email)) mapper.email = index;
    else if (mapper.first < 0 && headerHit(name, HEADER_SETS.first)) mapper.first = index;
    else if (mapper.last < 0 && headerHit(name, HEADER_SETS.last)) mapper.last = index;
    else if (mapper.company < 0 && headerHit(name, HEADER_SETS.company)) mapper.company = index;
    else if (mapper.custom < 0 && headerHit(name, HEADER_SETS.custom)) mapper.custom = index;
    else if (mapper.template < 0 && headerHit(name, HEADER_SETS.template)) mapper.template = index;
    else if (mapper.sender_name < 0 && headerHit(name, HEADER_SETS.sender_name)) mapper.sender_name = index;
    else if (mapper.cc < 0 && headerHit(name, HEADER_SETS.cc)) mapper.cc = index;
    else if (mapper.bcc < 0 && headerHit(name, HEADER_SETS.bcc)) mapper.bcc = index;
    else if (mapper.sender < 0 && headerHit(name, HEADER_SETS.sender)) mapper.sender = index;
    else mapper.fields.push(index);
  });
  return mapper;
}

function detectEmailColumn(sampleRows, width, headers) {
  let best = -1;
  let bestScore = 0;
  for (let column = 0; column < width; column += 1) {
    const label = normHeader((headers || [])[column] || "");
    if (label && headerHit(label, HEADER_SETS.sender)) continue;
    let score = 0;
    for (const row of sampleRows) {
      if (EMAIL_RE.test(cleanEmail(row[column]))) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = column;
    }
  }
  return bestScore > 0 ? best : -1;
}

function createSink() {
  const seen = new Set();
  const columns = new Set(["FirstName", "LastName", "Company", "Custom1", "Email", "Template", "Sender", "Sender Name"]);
  const stats = { scanned: 0, valid: 0, invalid: 0, duplicates: 0 };
  let batch = [];
  function flush() {
    if (!batch.length) return;
    self.postMessage({ type: "chunk", rows: batch });
    batch = [];
  }
  function push(row) {
    stats.scanned += 1;
    const email = cleanEmail(row.email);
    const mailbox = cleanEmail((row.fields && (row.fields["Sender email"] || row.fields["Account Email"])) || row.sender || "");
    const slot = EMAIL_RE.test(mailbox) ? `${email}\n${mailbox}` : email;
    if (!EMAIL_RE.test(email)) {
      stats.invalid += 1;
    } else if (seen.has(slot)) {
      stats.duplicates += 1;
    } else {
      seen.add(slot);
      stats.valid += 1;
      row.email = email;
      Object.keys(row.fields || {}).forEach((key) => columns.add(key));
      batch.push(row);
      if (batch.length >= 4000) flush();
    }
    if (stats.scanned % 4000 === 0) {
      self.postMessage({ type: "progress", scanned: stats.scanned, valid: stats.valid });
    }
  }
  return { push, flush, stats, columns };
}

function columnLetter(index) {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function rowFrom(values, mapper, headers, extraFields) {
  const fields = Object.assign({}, extraFields || {});
  const width = Math.max(headers.length, values.length);
  for (let index = 0; index < width; index += 1) {
    const value = cell(values, index);
    const name = String(headers[index] || "").trim();
    if (!name && !value) continue;
    if (name) fields[name] = value;
    fields[columnLetter(index)] = value;
  }
  const firstName = cell(values, mapper.first);
  let template = cell(values, mapper.template);
  if (!template) {
    for (const key of Object.keys(fields)) {
      const k = key.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      if (["template", "templates", "templatename", "templateid", "emailtemplate"].includes(k)) {
        template = String(fields[key] || "").trim();
        break;
      }
    }
  }
  let sender = cell(values, mapper.sender);
  let senderName = cell(values, mapper.sender_name);
  const copy = cell(values, mapper.cc);
  const blind = cell(values, mapper.bcc);
  if (sender && !EMAIL_RE.test(cleanEmail(sender))) {
    if (!senderName) senderName = sender;
    sender = "";
  }
  if (firstName) fields.Name = firstName;
  if (template) fields.Template = template;
  const receiver = cleanEmail(cell(values, mapper.email));
  if (EMAIL_RE.test(receiver)) fields["Receiver email"] = receiver;
  if (sender) {
    fields.Sender = sender;
    fields["Sender email"] = cleanEmail(sender);
  }
  if (senderName) fields["Sender Name"] = senderName;
  if (copy) fields.CC = copy;
  if (blind) fields.BCC = blind;
  return {
    email: cell(values, mapper.email),
    first_name: firstName,
    last_name: cell(values, mapper.last),
    company: cell(values, mapper.company),
    custom1: cell(values, mapper.custom),
    template,
    sender,
    sender_name: senderName,
    fields,
  };
}

function emailHits(rows, index) {
  let score = 0;
  for (const row of rows) {
    if (EMAIL_RE.test(cleanEmail(row[index]))) score += 1;
  }
  return score;
}

function repairEmailColumn(headers, sample, mapper) {
  if (mapper.email >= 0 && emailHits(sample, mapper.email) > 0) return;
  const detected = detectEmailColumn(sample, Math.max(headers.length, ...sample.map((row) => row.length), 0), headers);
  if (detected < 0) return;
  if (mapper.first === detected) mapper.first = mapper.email >= 0 ? mapper.email : -1;
  mapper.email = detected;
}

function consumeMatrix(matrix, sheetName, sheetCount, sink) {
  if (!matrix.length) return;
  const headers = (matrix[0] || []).map((value) => String(value || "").trim());
  const mapper = buildMapper(headers);
  repairEmailColumn(headers, matrix.slice(1, 31), mapper);
  const extra = sheetCount > 1 ? { Sheet: sheetName } : null;
  for (let index = 1; index < matrix.length; index += 1) {
    const values = matrix[index] || [];
    if (!values.some((value) => String(value || "").trim())) continue;
    sink.push(rowFrom(values, mapper, headers, extra));
  }
}

async function parseCsv(file, sink) {
  const reader = file.stream().getReader();
  const decoder = new TextDecoder("utf-8");
  const ctx = { row: [], cur: "", quotes: false, headers: null, mapper: null, line: 0, sample: [], repaired: false };
  const finishRow = () => {
    ctx.row.push(ctx.cur);
    ctx.cur = "";
    const values = ctx.row;
    ctx.row = [];
    if (values.every((value) => !String(value || "").trim())) return;
    if (!ctx.headers) {
      ctx.headers = values.map((value) => String(value || "").replace(/^\uFEFF/, "").trim());
      ctx.mapper = buildMapper(ctx.headers);
      return;
    }
    if (!ctx.repaired) {
      ctx.sample.push(values);
      if (ctx.sample.length >= 25) repairCsvSample(ctx, sink);
      return;
    }
    sink.push(rowFrom(values, ctx.mapper, ctx.headers));
  };
  const feed = (chunk) => {
    for (let index = 0; index < chunk.length; index += 1) {
      const char = chunk[index];
      if (ctx.quotes) {
        if (char === '"') {
          if (chunk[index + 1] === '"') {
            ctx.cur += '"';
            index += 1;
          } else ctx.quotes = false;
        } else ctx.cur += char;
      } else if (char === '"') ctx.quotes = true;
      else if (char === ",") {
        ctx.row.push(ctx.cur);
        ctx.cur = "";
      } else if (char === "\n") finishRow();
      else if (char !== "\r") ctx.cur += char;
    }
  };
  let first = true;
  while (true) {
    const step = await reader.read();
    let text = decoder.decode(step.value || new Uint8Array(), { stream: !step.done });
    if (first) {
      text = text.replace(/^\uFEFF/, "");
      first = false;
    }
    feed(text);
    if (step.done) break;
  }
  if (ctx.cur || ctx.row.length) finishRow();
  repairCsvSample(ctx, sink);
}

function repairCsvSample(ctx, sink) {
  if (ctx.repaired || !ctx.mapper) return;
  repairEmailColumn(ctx.headers, ctx.sample, ctx.mapper);
  ctx.sample.forEach((values) => sink.push(rowFrom(values, ctx.mapper, ctx.headers)));
  ctx.sample = [];
  ctx.repaired = true;
}

async function parseWorkbook(file, sink) {
  if (typeof XLSX === "undefined") {
    throw new Error("The Excel parser did not load. CSV files still work offline.");
  }
  const buffer = await file.arrayBuffer();
  const book = XLSX.read(buffer, { type: "array" });
  const names = book.SheetNames.slice();
  for (const name of names) {
    const sheet = book.Sheets[name];
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });
    delete book.Sheets[name];
    consumeMatrix(matrix, name, names.length, sink);
  }
}

self.onmessage = async (event) => {
  const file = event.data && event.data.file;
  if (!file) {
    self.postMessage({ type: "error", message: "No file was received." });
    return;
  }
  const sink = createSink();
  try {
    const name = String(file.name || "").toLowerCase();
    if (name.endsWith(".csv") || name.endsWith(".txt")) await parseCsv(file, sink);
    else await parseWorkbook(file, sink);
    sink.flush();
    self.postMessage({
      type: "done",
      stats: sink.stats,
      columns: Array.from(sink.columns),
    });
  } catch (error) {
    self.postMessage({ type: "error", message: error.message || "Could not read that file." });
  }
};
