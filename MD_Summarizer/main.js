const { Actor, log } = require('apify');
const { google } = require('googleapis');
const pdfParse = require('pdf-parse');
const { Readable } = require('stream');
const { finished } = require('stream/promises');

// ------------------------ SETTINGS ------------------------
const OPENAI_MODEL = 'gpt-4o-mini';      // or 'gpt-4o'
const IMAGE_ONLY_MIN_CHARS = 500;        // below this => likely image-only
const PER_CURIAM_RE = /\bper\s+curiam\b/i;

const MD_COURTS_UNREPORTED_PDF_BASE =
  'https://www.mdcourts.gov/sites/default/files/unreported-opinions/';

const CHILD_SEXUAL_ABUSE_TERMS = [
  'child sexual abuse',
  'sexual abuse of a minor',
  'sexual abuse of a child',
  'child molest',
  'molestation',
  'indecent liberties',
  'indecent acts with a child',
  'sexual offense involving a minor',
  'sex offense involving a minor',
  'minor victim',
  'juvenile victim',
  'rape of a minor',
  'sexual assault of a minor',
  'sexual assault of a child',
  'sex offender registration'
];

const TAXONOMY = [
  'Criminal Law',
  'Civil Procedure',
  'Evidence',
  'Sentencing',
  'Post-Conviction',
  'Torts',
  'Contracts',
  'Family Law',
  'Administrative Law',
  'Employment',
  'Real Property',
  'Landlord-Tenant',
  'Constitutional',
  'Appellate Procedure',
  'Jurisdiction',
  'Statutory Interpretation',
  'Insurance',
  'Workers’ Compensation'
];

// ------------------------ AUTH ----------------------------
async function driveClient() {
  const mode = (process.env.AUTH_MODE || 'oauth').toLowerCase();

  if (mode === 'oauth') {
    const { GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, GDRIVE_REFRESH_TOKEN } = process.env;
    if (!GDRIVE_CLIENT_ID || !GDRIVE_CLIENT_SECRET || !GDRIVE_REFRESH_TOKEN) {
      throw new Error('Missing OAuth secrets: GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET / GDRIVE_REFRESH_TOKEN');
    }

    const oauth2 = new google.auth.OAuth2(
      GDRIVE_CLIENT_ID,
      GDRIVE_CLIENT_SECRET,
      'https://developers.google.com/oauthplayground'
    );

    oauth2.setCredentials({ refresh_token: GDRIVE_REFRESH_TOKEN });
    return google.drive({ version: 'v3', auth: oauth2 });
  }

  const saJson = process.env.GDRIVE_SA_JSON;
  if (!saJson) throw new Error('Missing secret GDRIVE_SA_JSON');

  let creds;
  try {
    creds = JSON.parse(saJson);
  } catch {
    throw new Error('GDRIVE_SA_JSON is not valid JSON');
  }

  const privateKey = (creds.private_key || '').replace(/\\n/g, '\n');
  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    privateKey,
    ['https://www.googleapis.com/auth/drive']
  );

  await auth.authorize();
  return google.drive({ version: 'v3', auth });
}

// ------------------------ DRIVE HELPERS -------------------
async function findSubfolderIdByName(drive, parentId, name) {
  const q = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and name = '${name.replace(/'/g, "\\'")}' and trashed = false`;
  const { data } = await drive.files.list({ q, fields: 'files(id,name)', pageSize: 10 });

  if (data.files?.length) return data.files[0].id;
  throw new Error(`Subfolder "${name}" not found in parent folder ${parentId}`);
}

async function listPdfsInFolder(drive, folderId, limit) {
  let files = [];
  let pageToken = undefined;

  do {
    const { data } = await drive.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/pdf' and trashed = false`,
      fields: 'nextPageToken, files(id,name,size,modifiedTime)',
      orderBy: 'name',
      pageSize: 1000,
      pageToken
    });

    files = files.concat(data.files || []);
    pageToken = data.nextPageToken;

    if (files.length >= limit) break;
  } while (pageToken);

  return files.slice(0, limit);
}

async function fileExistsByName(drive, folderId, name) {
  const q = `'${folderId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`;
  const { data } = await drive.files.list({ q, fields: 'files(id)', pageSize: 1 });
  return (data.files?.length || 0) > 0;
}

async function downloadFileToBuffer(drive, fileId) {
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  const chunks = [];

  res.data.on('data', (d) => chunks.push(d));
  await finished(res.data);

  return Buffer.concat(chunks);
}

async function uploadTextFile(drive, folderId, name, text) {
  return drive.files.create({
    requestBody: { name, parents: [folderId] },
    media: {
      mimeType: 'text/plain',
      body: Readable.from(Buffer.from(text, 'utf8'))
    },
    fields: 'id,name'
  });
}

async function uploadJsonFile(drive, folderId, name, obj) {
  return drive.files.create({
    requestBody: { name, parents: [folderId] },
    media: {
      mimeType: 'application/json',
      body: Readable.from(Buffer.from(JSON.stringify(obj, null, 2), 'utf8'))
    },
    fields: 'id,name'
  });
}

// ------------------------ TEXT HELPERS --------------------
function extractCaption(raw) {
  const head = raw.slice(0, 2500);
  const m = head.match(/([^\n]+?)\s+v\.?\s+([^\n]+?)\s*(?:\n|$)/i);

  let left = null;
  let right = null;

  if (m) {
    left = m[1].replace(/\s+/g, ' ').trim();
    right = m[2].replace(/\s+/g, ' ').trim();
  }

  const docket = (head.match(/\b(No\.|Case No\.)\s*([A-Za-z0-9\-]+)\b/) || [])[0] || null;

  let duplicateParties = false;
  if (left && right) {
    const norm = (s) => s.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
    duplicateParties = norm(left) === norm(right);
  }

  const perCuriam = PER_CURIAM_RE.test(head);

  return {
    caption: left && right ? `${left} v. ${right}` : null,
    docket,
    duplicateParties,
    perCuriam
  };
}

function extractSensitiveCaseSignals(rawText) {
  const text = (rawText || '').toLowerCase();
  const matchedTerms = CHILD_SEXUAL_ABUSE_TERMS.filter((t) => text.includes(t));

  return {
    childSexualAbuse: matchedTerms.length > 0,
    matchedTerms
  };
}

function deriveListIdFromFilename(pdfName) {
  return pdfName.replace(/\.pdf$/i, '').trim();
}

function buildMarylandCourtDecisionUrl(pdfName) {
  const fileNameOnly = String(pdfName || '').split('/').pop().trim();
  return `${MD_COURTS_UNREPORTED_PDF_BASE}${encodeURIComponent(fileNameOnly)}`;
}

function toTitleCaseName(str) {
  if (!str) return str;

  const SMALL = new Set([
    'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for',
    'in', 'nor', 'of', 'on', 'or', 'per', 'the', 'to',
    'vs', 'v'
  ]);

  const PRESERVE = new Set([
    'LLC', 'L.L.C.', 'LLP', 'L.L.P.', 'LP', 'L.P.',
    'PLC', 'P.L.C.', 'PC', 'P.C.', 'PA', 'P.A.',
    'INC', 'INC.', 'CO', 'CO.', 'CORP', 'CORP.',
    'LLC.,', 'LLP.,'
  ]);

  const isShortAcronym = (w) =>
    /^[A-Z]{2,4}$/.test(w) ||
    /^[A-Z](?:\.[A-Z])+\.?$/.test(w);

  const capPart = (part) =>
    part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part;

  const capWord = (w) => {
    if (PRESERVE.has(w)) return w;
    if (isShortAcronym(w)) return w;

    const mc = w.match(/^mc([a-z].*)$/i);
    if (mc) return 'Mc' + capPart(mc[1]);

    return w
      .split('-')
      .map((h) => h.split("'").map((seg) => capPart(seg)).join("'"))
      .join('-');
  };

  const words = String(str).trim().replace(/\s+/g, ' ').split(' ');

  return words
    .map((w, i) => {
      const raw = w;
      const upper = raw.toUpperCase();
      const lower = raw.toLowerCase();

      if (i !== 0 && i !== words.length - 1 && SMALL.has(lower)) return lower;
      return capWord(upper === raw ? raw : raw);
    })
    .join(' ');
}

function anonymizeIndividualNamesWithInitials(text) {
  const ENTITY_WORDS = /\b(State|Maryland|County|City|Town|Board|Department|Office|Administration|Commission|Court|Circuit|District|Appellate|Appeals|Police|Sheriff|University|Hospital|Medical|Center|School|Bank|Trust|Company|Co\.|Corp\.|Corporation|LLC|L\.L\.C\.|Inc\.|Insurance|Association|Authority)\b/i;

  const nameRe = /\b([A-Z][a-zA-Z'’.-]+(?:\s+(?:[A-Z]\.|[A-Z][a-zA-Z'’.-]+)){1,4})(?:,\s*(Jr\.|Sr\.|III|IV))?\b/g;

  return String(text || '').replace(nameRe, (match, name) => {
    if (ENTITY_WORDS.test(match)) return match;
    if (/\bv\.$/i.test(match)) return match;

    const parts = name
      .replace(/[’']/g, "'")
      .split(/\s+/)
      .filter(Boolean)
      .filter((p) => !/^(Jr\.|Sr\.|III|IV)$/i.test(p));

    if (parts.length < 2) return match;

    const initials = parts
      .map((p) => {
        const clean = p.replace(/[^A-Za-z]/g, '');
        return clean ? clean.charAt(0).toUpperCase() + '.' : '';
      })
      .join('');

    return initials || match;
  });
}

function enforceFourLineFormat(text) {
  const stripPrefix = (s) =>
    s
      .replace(/^\s*(?:\(\d+\)|\d+\)|\d+\.)\s*/i, '')
      .replace(/^\s*(CAPTION|TOPICS?|HOLDING|SUMMARY)\s*:\s*/i, '')
      .trim();

  let lines = (text || '')
    .split(/\r?\n/)
    .map((l) => stripPrefix(l))
    .filter(Boolean);

  lines = lines.slice(0, 4);

  if (lines[1]) {
    let cap = lines[1].replace(/\s+v(?:s\.?)?\s+/i, ' v. ').trim();
    const m = cap.match(/^(.+?)\s+v\.?\s+(.+?)\s*$/i);

    if (m) {
      const left = toTitleCaseName(m[1]);
      const right = toTitleCaseName(m[2]);
      cap = `${left} v. ${right}`;
    }

    lines[1] = cap;
  }

  return lines.join('\n');
}

function buildPromptFourLine(listId, raw, taxonomy = TAXONOMY) {
  const MAX_CHARS = 80000;
  const text = raw.length > MAX_CHARS ? raw.slice(0, MAX_CHARS) : raw;
  const taxonomyList = taxonomy.map((t) => `- ${t}`).join('\n');

  return {
    model: OPENAI_MODEL,
    temperature: 0.2,
    max_tokens: 400,
    messages: [
      {
        role: 'system',
        content:
`You are a precise legal summarizer for Maryland appellate opinions.
Output MUST be exactly 4 lines, with NO numbering, NO labels, NO bullets.`
      },
      {
        role: 'user',
        content:
`Produce EXACTLY four lines in this format (no numbering, no labels):

<LIST_ID>
<CAPTION in Title Case with " v. ">
<MAIN_TOPIC_FROM_LIST>—<Subtopic1>—<Subtopic2>
<First substantive sentence from the opinion (<= 35 words, no quotes)>

Rules:
- Main topic MUST be chosen from this fixed taxonomy (one only):
${taxonomyList}
- Subtopics: 2–4 words each; capture concrete issues (e.g., "Custody", "Legal authority", "Access schedule").
- Caption must use " v. " (lowercase v.), and proper Title Case.
- No extra lines, no blank lines, no prefixes like "1)" or "CAPTION:".
- If unsure of a detail, omit it rather than invent.
- For individual people, use initials only instead of full names.

Context:
LIST_ID: ${listId}
--- BEGIN OPINION TEXT ---
${text}
--- END OPINION TEXT ---`
      }
    ]
  };
}

// ------------------------ OPENAI --------------------------
async function summarizeWithOpenAI(promptBody) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || process.env.OPEN_AI_KEY;

  if (!apiKey) throw new Error('Missing OPENAI_API_KEY');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(promptBody)
  });

  if (!res.ok) {
    const errTxt = await res.text().catch(() => '');
    throw new Error(`OpenAI error ${res.status}: ${res.statusText} ${errTxt}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// --------------------------- MAIN -------------------------
Actor.main(async () => {
  log.setLevel(log.LEVELS.DEBUG);
  log.info('Booting Actor 2 (Summarize PDFs)…');

  const { driveSubfolderName, maxToSummarize = 100 } = (await Actor.getInput()) || {};

  if (!driveSubfolderName) throw new Error('Missing input: driveSubfolderName');

  const parentId = process.env.GDRIVE_PARENT_FOLDER_ID;

  if (!parentId) throw new Error('Missing secret GDRIVE_PARENT_FOLDER_ID');

  const drive = await driveClient();

  try {
    const about = await drive.about.get({ fields: 'user(emailAddress,displayName)' });
    const who = about.data?.user?.emailAddress || about.data?.user?.displayName || 'unknown';
    log.info(`Drive auth OK for: ${who}`);
  } catch {}

  const folderId = await findSubfolderIdByName(drive, parentId, driveSubfolderName);
  log.info(`Using Drive subfolder ID: ${folderId}`);

  const allPdfs = await listPdfsInFolder(drive, folderId, Math.max(maxToSummarize, 200));
  const availableCount = allPdfs.length;

  const candidates = [];

  let excludedAlreadySummarized = 0;
  let excludedAlreadyPerCuriamMarked = 0;
  let excludedAlreadyChildAbuseMarked = 0;
  let excludedAlreadyDuplicateMarked = 0;
  let excludedAlreadyOcrMarked = 0;

  for (const f of allPdfs) {
    const base = f.name.replace(/\.pdf$/i, '');
    const txtName = `${base}.txt`;
    const perCuriamNote = `${base}.skipped_per_curiam.txt`;
    const childAbuseNote = `${base}.skipped_child_sexual_abuse.txt`;
    const duplicatePartiesNote = `${base}.skipped_duplicate_parties.txt`;
    const ocrMarker = `${base}.needs_ocr.json`;

    const hasTxt = await fileExistsByName(drive, folderId, txtName);
    const hasPerCuriamNote = await fileExistsByName(drive, folderId, perCuriamNote);
    const hasChildAbuseNote = await fileExistsByName(drive, folderId, childAbuseNote);
    const hasDuplicatePartiesNote = await fileExistsByName(drive, folderId, duplicatePartiesNote);
    const hasOcrMarker = await fileExistsByName(drive, folderId, ocrMarker);

    if (hasTxt) {
      excludedAlreadySummarized++;
      continue;
    }

    if (hasPerCuriamNote) {
      excludedAlreadyPerCuriamMarked++;
      continue;
    }

    if (hasChildAbuseNote) {
      excludedAlreadyChildAbuseMarked++;
      continue;
    }

    if (hasDuplicatePartiesNote) {
      excludedAlreadyDuplicateMarked++;
      continue;
    }

    if (hasOcrMarker) {
      excludedAlreadyOcrMarked++;
      continue;
    }

    candidates.push(f);
  }

  const candidatesBeforeCap = candidates.length;
  const capApplied = candidatesBeforeCap > maxToSummarize;
  const cappedCandidates = capApplied ? candidates.slice(0, maxToSummarize) : candidates;

  log.info('Candidate selection breakdown', {
    folderId,
    inputFolderName: driveSubfolderName,
    availablePdfCount: availableCount,
    excludedAlreadySummarized,
    excludedAlreadyPerCuriamMarked,
    excludedAlreadyChildAbuseMarked,
    excludedAlreadyDuplicateMarked,
    excludedAlreadyOcrMarked,
    candidatesBeforeCap,
    candidatesAfterCap: cappedCandidates.length,
    cap: maxToSummarize,
    capApplied
  });

  let saved = 0;
  let skipped = 0;
  let ocrFlagged = 0;
  let perCuriamSkipped = 0;
  let dupPartySkipped = 0;
  let sensitiveSkipped = 0;
  let failed = 0;
  let considered = 0;

  for (const pdf of cappedCandidates) {
    if (saved >= maxToSummarize) break;

    considered++;

    try {
      const buf = await downloadFileToBuffer(drive, pdf.id);
      const parsed = await pdfParse(buf).catch(() => ({ text: '' }));
      const rawText = parsed && parsed.text ? parsed.text : '';

      if (!rawText || rawText.replace(/\s+/g, '').length < IMAGE_ONLY_MIN_CHARS) {
        const marker = {
          fileName: pdf.name,
          reason: 'image_only_low_text',
          note: 'Run Actor 3 (OCR) to extract text.',
          timestamp: new Date().toISOString()
        };

        const markName = pdf.name.replace(/\.pdf$/i, '') + '.needs_ocr.json';

        await uploadJsonFile(drive, folderId, markName, marker);

        ocrFlagged++;
        log.info(`Flagged for OCR: ${pdf.name}`);
        continue;
      }

      const { duplicateParties, perCuriam } = extractCaption(rawText);
      const { childSexualAbuse, matchedTerms } = extractSensitiveCaseSignals(rawText);

      if (perCuriam) {
        const noteName = pdf.name.replace(/\.pdf$/i, '') + '.skipped_per_curiam.txt';

        await uploadTextFile(drive, folderId, noteName, 'Skipped: Per Curiam opinion.');

        perCuriamSkipped++;
        skipped++;
        continue;
      }

      if (duplicateParties) {
        const noteName = pdf.name.replace(/\.pdf$/i, '') + '.skipped_duplicate_parties.txt';

        await uploadTextFile(drive, folderId, noteName, 'Skipped: duplicate party names detected in caption.');

        dupPartySkipped++;
        skipped++;
        continue;
      }

      if (childSexualAbuse) {
        const noteName = pdf.name.replace(/\.pdf$/i, '') + '.skipped_child_sexual_abuse.txt';
        const noteBody =
          `Skipped: case appears to involve alleged or charged sexual abuse of a minor.\n` +
          `Matched terms: ${matchedTerms.join(', ')}`;

        await uploadTextFile(drive, folderId, noteName, noteBody);

        sensitiveSkipped++;
        skipped++;
        continue;
      }

      const listId = deriveListIdFromFilename(pdf.name);
      const promptBody = buildPromptFourLine(listId, rawText, TAXONOMY);

      let summary = await summarizeWithOpenAI(promptBody);

      summary = enforceFourLineFormat(summary);
      summary = anonymizeIndividualNamesWithInitials(summary);

      const decisionUrl = buildMarylandCourtDecisionUrl(pdf.name);
      summary = `${summary}\nDecision: ${decisionUrl}`;

      const outName = pdf.name.replace(/\.pdf$/i, '') + '.txt';

      await uploadTextFile(drive, folderId, outName, summary);

      saved++;
      log.info(`Saved summary: ${outName}`);
    } catch (e) {
      failed++;
      log.exception(e, `Failed on PDF: ${pdf.name}`);
    }
  }

  const output = {
    folderId,
    inputFolderName: driveSubfolderName,
    availablePdfCount: availableCount,
    excludedAlreadySummarized,
    excludedAlreadyPerCuriamMarked,
    excludedAlreadyChildAbuseMarked,
    excludedAlreadyDuplicateMarked,
    excludedAlreadyOcrMarked,
    candidatesBeforeCap,
    candidatesAfterCap: cappedCandidates.length,
    processedCandidates: considered,
    saved,
    skipped,
    perCuriamSkipped,
    dupPartySkipped,
    sensitiveSkipped,
    ocrFlagged,
    failed,
    cap: maxToSummarize,
    capApplied,
    capHit: saved >= maxToSummarize
  };

  await Actor.setValue('OUTPUT', output);

  if (output.capApplied) {
    log.warning(`Candidate cap applied: ${candidatesBeforeCap} eligible PDFs trimmed to ${maxToSummarize}.`);
  }

  if (output.capHit) {
    log.warning(`Saved-summary cap hit: saved ${saved} (cap ${maxToSummarize}).`);
  }

  log.info(`Done. ${JSON.stringify(output)}`);
});