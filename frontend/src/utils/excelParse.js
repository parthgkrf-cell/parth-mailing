const EMAIL_RE = /^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$/i;

function norm(value) {
  return String(value || '').replace(/^\uFEFF/, '').trim().toLowerCase();
}

function headerMatches(header, alias) {
  const h = norm(header);
  const a = norm(alias);
  if (!h || !a || a.length < 3) return false;
  if (h === a) return true;
  const escaped = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(h);
}

function findCol(headers, aliases, exclude = new Set()) {
  const exact = headers.findIndex((header, index) => !exclude.has(index) && aliases.some((alias) => norm(header) === norm(alias)));
  if (exact >= 0) return exact;
  return headers.findIndex((header, index) => !exclude.has(index) && aliases.some((alias) => headerMatches(header, alias)));
}

function cleanEmail(value) {
  let text = String(value || '').replace(/\u00a0/g, '').trim();
  const wrapped = text.match(/<([^>]+)>/);
  if (wrapped) text = wrapped[1].trim();
  return text;
}

function parseSender(raw, rawName) {
  let sender = String(raw || '').trim();
  let senderName = String(rawName || '').trim();
  if (sender.includes('<') && sender.includes('>')) {
    const namePart = sender.split('<')[0].trim().replace(/^["']+|["']+$/g, '');
    const emailPart = sender.split('<')[1].split('>')[0].trim();
    if (!senderName && namePart) senderName = namePart;
    sender = emailPart;
  }
  return { sender, senderName };
}

export function parseSheetMatrix(matrix, fileName = 'workbook', sheetName = 'Sheet1') {
  if (!matrix || !matrix.length) return { rows: [], invalid: 0 };
  const headers = (matrix[0] || []).map((cell) => String(cell || '').trim());
  const emailCol = findCol(headers, ['Email', 'Email Address', 'Mail', 'EmailID', 'Recipient Email', 'To Email']);
  const firstCol = findCol(headers, ['FirstName', 'First Name', 'Given Name']);
  const lastCol = findCol(headers, ['LastName', 'Last Name', 'Surname']);
  const companyCol = findCol(headers, ['Affiliation', 'Company', 'Organization', 'Aff']);
  const templateCol = findCol(headers, ['Template', 'Template Name', 'TemplateID', 'Template ID', 'Mail Template', 'Email Template']);
  const senderCol = findCol(headers, [
    'Account Email', 'Sender Email', 'Sender Account', 'From Email', 'Send From', 'Sending Account', 'Mail Account'
  ]);
  const senderNameCol = findCol(headers, [
    'Sender Name', 'From Name', 'FromName', 'Display Name', 'Account Name', 'Sender Title'
  ], new Set([senderCol, emailCol].filter((i) => i >= 0)));
  const nameCol = findCol(
    headers,
    ['Name', 'First Name', 'Recipient Name', 'Full Name', 'Contact Name'],
    new Set([senderCol, senderNameCol, emailCol, firstCol, lastCol].filter((i) => i >= 0))
  );
  const ccCol = findCol(headers, ['CC', 'Cc Email']);
  const bccCol = findCol(headers, ['BCC', 'Bcc Email']);
  const dateCol = findCol(headers, ['Date', 'S_Date', 'Send Date', 'Schedule Date']);
  const timeCol = findCol(headers, ['Time', 'S_Time', 'Send Time', 'Schedule Time']);
  const sessionCol = findCol(headers, ['Session', 'tsname', 'Technical Schedule Name']);

  const rows = [];
  let invalid = 0;
  for (let i = 1; i < matrix.length; i += 1) {
    const values = matrix[i] || [];
    const cell = (index) => (index >= 0 && values[index] != null ? String(values[index]).trim() : '');
    const email = cleanEmail(cell(emailCol)).toLowerCase();
    const name = cell(nameCol) || [cell(firstCol), cell(lastCol)].filter(Boolean).join(' ').trim();
    if (!EMAIL_RE.test(email)) {
      invalid += 1;
      continue;
    }
    const parsedSender = parseSender(cell(senderCol), cell(senderNameCol));
    const fields = {};
    headers.forEach((header, index) => {
      if (header) fields[header] = cell(index);
    });
    rows.push({
      id: `${fileName}-${sheetName}-${i}-${email}`,
      email,
      name,
      first_name: cell(firstCol),
      last_name: cell(lastCol),
      company: cell(companyCol),
      affiliation: cell(companyCol),
      template: cell(templateCol) || sheetName,
      sender: parsedSender.sender,
      sender_name: parsedSender.senderName,
      cc: cell(ccCol),
      bcc: cell(bccCol),
      date: cell(dateCol),
      time: cell(timeCol),
      session: cell(sessionCol),
      source: `${fileName} / ${sheetName}`,
      fields
    });
  }
  return { rows, invalid };
}

export function loadXlsxLibrary() {
  return new Promise((resolve, reject) => {
    if (window.XLSX) {
      resolve(window.XLSX);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    script.onload = () => resolve(window.XLSX);
    script.onerror = () => reject(new Error('Could not load the Excel parser.'));
    document.body.appendChild(script);
  });
}

export async function parseExcelFile(file) {
  const XLSX = await loadXlsxLibrary();
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const collected = [];
  let invalid = 0;
  workbook.SheetNames.forEach((sheetName) => {
    const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });
    const parsed = parseSheetMatrix(matrix, file.name, sheetName);
    collected.push(...parsed.rows);
    invalid += parsed.invalid;
  });
  return { rows: collected, invalid };
}
