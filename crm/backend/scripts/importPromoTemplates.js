/*
 * One-off importer: read the "wahtasapp promo.docx" promo schedule and create
 * the WhatsApp Saved Templates for the Meta-Temp workspace. Media (Google Drive
 * links) are DOWNLOADED and stored on disk under uploads/templates, with the
 * template's media_url pointing at the local copy (never the raw Drive link).
 *
 * Usage:
 *   node scripts/importPromoTemplates.js parse     # dry-run: print parsed plan
 *   node scripts/importPromoTemplates.js run        # download media + insert rows
 */
const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseSendTime } = require('../utils/templateSchedule');

/* Normalize a doc "Date & Time" string to a clean 12h "h:mm AM/PM" — the doc
   prefixes some with an example date ("22 February, 5:00 pm"); keep only time. */
function cleanSendTime(raw) {
  const p = parseSendTime(raw);
  if (!p) return (raw || '').trim();
  const ap = p.hh >= 12 ? 'PM' : 'AM';
  let h12 = p.hh % 12; if (h12 === 0) h12 = 12;
  return `${h12}:${String(p.mm).padStart(2, '0')} ${ap}`;
}

const DOCX   = 'C:/Users/PRO SERV 3/Downloads/wahtasapp promo.docx';
const SOURCE = 'metatemp';
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'templates');

/* ── Unzip a single entry from the .docx (zip) via PowerShell ZipFile ──
   Extract to a temp FILE (byte-preserving) then read in Node as UTF-8, so the
   Tamil content can't be mangled by PowerShell's stdout codepage. */
function readZipEntry(zipPath, entry) {
  const tmp = path.join(require('os').tmpdir(), `docx_${Date.now()}_${Math.abs(entry.split('').reduce((a,c)=>a+c.charCodeAt(0),0))}.xml`);
  const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
    `$z=[System.IO.Compression.ZipFile]::OpenRead(${JSON.stringify(zipPath)}); ` +
    `$e=$z.Entries | Where-Object { $_.FullName -eq ${JSON.stringify(entry)} }; ` +
    `[System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, ${JSON.stringify(tmp)}, $true); ` +
    `$z.Dispose();`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { maxBuffer: 8 * 1024 * 1024 });
  const data = fs.readFileSync(tmp, 'utf8');
  try { fs.unlinkSync(tmp); } catch (_) {}
  return data;
}

const decode = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");

/* Parse document.xml into paragraphs, each carrying its text + any hyperlink rId. */
function parseParagraphs(xml) {
  const chunks = xml.split(/<\/w:p>/);
  return chunks.map(p => {
    const text = (p.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [])
      .map(m => decode(m.replace(/<[^>]+>/g, ''))).join('');
    const rid = (p.match(/<w:hyperlink[^>]*r:id="([^"]+)"/) || [])[1] || null;
    return { text: text.replace(/\s+$/g, ''), rid };
  });
}

/* rId → URL map from document.xml.rels */
function parseRels(xml) {
  const map = {};
  for (const m of xml.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    map[m[1]] = decode(m[2]);
  }
  return map;
}

/* Derive a day_offset label from a template title like "3 Days To Go". */
function dayOffsetOf(title) {
  const t = title.replace(/:$/, '').trim();
  if (/live day/i.test(t)) return 'Webinar day';
  if (/i am live/i.test(t)) return 'Webinar day';
  return t; // e.g. "3 Days To Go", "8 Hours To Go", "30 Minutes To Go"
}

/* Map "File Type: X" → msg_type used by wa_templates. */
function msgTypeOf(fileType) {
  const t = (fileType || '').toLowerCase();
  if (t.includes('video')) return 'video';
  if (t.includes('voice') || t.includes('audio')) return 'audio';
  if (t.includes('image') || t.includes('jpeg') || t.includes('jpg') || t.includes('png')) return 'image';
  return 'text';
}

/* Build the structured template plan from the docx. */
function buildPlan() {
  const doc  = parseParagraphs(readZipEntry(DOCX, 'word/document.xml'));
  const rels = parseRels(readZipEntry(DOCX, 'word/_rels/document.xml.rels'));

  // Segment by the "*****" separator paragraphs.
  const SEP = /^\*{10,}$/;
  const segments = [];
  let cur = [];
  for (const p of doc) {
    if (SEP.test(p.text.trim())) { if (cur.length) segments.push(cur); cur = []; }
    else cur.push(p);
  }
  if (cur.length) segments.push(cur);

  const templates = [];
  for (const seg of segments) {
    const lines = seg.filter(p => p.text.trim());
    if (!lines.length) continue;
    // Title = first line that isn't a known field label and isn't empty.
    const titleP = lines.find(p => /(to go|live day|i am live|announcement)/i.test(p.text) && !/file type|date & time|wa content/i.test(p.text));
    const fileTypeP = lines.find(p => /file type/i.test(p.text));
    const dateP = lines.find(p => /date & time/i.test(p.text));
    if (!titleP || !fileTypeP) continue;   // not a template segment

    const title = titleP.text.replace(/:$/, '').trim();
    const sendTime = dateP ? dateP.text.replace(/date & time:\s*/i, '').trim() : '';
    const fileTypeRaw = fileTypeP.text.replace(/file type:\s*/i, '').replace(/file link:.*/i, '').trim();
    const driveUrl = fileTypeP.rid ? rels[fileTypeP.rid] : null;
    const fileName = (fileTypeP.text.match(/file link:\s*(.+)$/i) || [])[1]?.trim() || '';

    // Body = the WA Content block (everything after the "WA Content:" line until
    // the next field/section), joined with newlines.
    const wcIdx = lines.findIndex(p => /^wa content:?/i.test(p.text.trim()));
    let body = '';
    if (wcIdx >= 0) {
      body = lines.slice(wcIdx + 1).map(p => p.text).join('\n').trim();
    }

    templates.push({
      name: title,
      day_offset: dayOffsetOf(title),
      send_time: cleanSendTime(sendTime),
      msg_type: msgTypeOf(fileTypeRaw),
      file_type_raw: fileTypeRaw,
      file_name: fileName,
      drive_url: driveUrl,
      body,
    });
  }
  return templates;
}

/* Download a Google-Drive file to UPLOAD_DIR, handling the large-file virus-scan
   interstitial. Returns { mediaUrl, size }. ext taken from the docx filename. */
async function driveDownload(driveUrl, fileName) {
  const id = (driveUrl.match(/\/d\/([^/]+)/) || driveUrl.match(/[?&]id=([^&]+)/) || [])[1];
  if (!id) throw new Error('no drive id in ' + driveUrl);
  const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

  let res = await fetch(`https://drive.google.com/uc?export=download&id=${id}`, { headers: UA, redirect: 'follow' });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  let ct = res.headers.get('content-type') || '';
  let buf = Buffer.from(await res.arrayBuffer());

  // Large files return an HTML interstitial with a confirm form — follow it.
  if (ct.includes('text/html')) {
    const html = buf.toString('utf8');
    const action = ((html.match(/action="([^"]+download[^"]*)"/) || [])[1] || 'https://drive.usercontent.google.com/download').replace(/&amp;/g, '&');
    const params = new URLSearchParams();
    for (const m of html.matchAll(/name="([^"]+)"\s+value="([^"]*)"/g)) params.set(m[1], m[2].replace(/&amp;/g, '&'));
    if (!params.get('id')) params.set('id', id);
    if (!params.get('export')) params.set('export', 'download');
    res = await fetch(`${action}?${params.toString()}`, {
      headers: { ...UA, ...(cookie ? { Cookie: cookie } : {}) }, redirect: 'follow',
    });
    ct = res.headers.get('content-type') || '';
    buf = Buffer.from(await res.arrayBuffer());
  }
  const head = buf.slice(0, 64).toString('latin1').toLowerCase();
  if (head.includes('<!doctype') || head.includes('<html')) {
    throw new Error(`still HTML (not the file) for ${id} — not public?`);
  }
  let ext = path.extname(fileName || '').toLowerCase().slice(0, 6);
  if (!ext) ext = ct.includes('mp4') ? '.mp4' : ct.includes('jpeg') ? '.jpeg' : ct.includes('ogg') ? '.ogg' : '.bin';
  const fname = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}${ext}`;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf);
  return { mediaUrl: `/uploads/templates/${fname}`, size: buf.length };
}

async function run() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const pool = require('../db');
  const plan = buildPlan();
  const { rows: existing } = await pool.query('SELECT name, send_time FROM wa_templates WHERE source = $1', [SOURCE]);
  const seen = new Set(existing.map(r => `${r.name}|${r.send_time}`));

  let made = 0, skipped = 0;
  for (const t of plan) {
    const key = `${t.name}|${t.send_time}`;
    if (seen.has(key)) { console.log(`SKIP (exists): ${t.name} @ ${t.send_time}`); skipped++; continue; }
    let mediaUrl = '';
    if (t.drive_url) {
      try {
        const dl = await driveDownload(t.drive_url, t.file_name);
        mediaUrl = dl.mediaUrl;
        console.log(`  ↓ ${t.name}: ${(dl.size / 1024 / 1024).toFixed(2)} MB → ${mediaUrl}`);
      } catch (e) {
        console.log(`  ✗ download failed for ${t.name}: ${e.message} — inserting WITHOUT media`);
      }
    }
    await pool.query(
      `INSERT INTO wa_templates (source, name, send_time, day_offset, msg_type, media_url, body, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true)`,
      [SOURCE, t.name, t.send_time, t.day_offset, mediaUrl ? t.msg_type : 'text', mediaUrl, t.body]
    );
    made++;
    console.log(`  ✓ inserted: ${t.name}`);
  }
  console.log(`\nDone. Inserted ${made}, skipped ${skipped}.`);
  await pool.end();
}

if (require.main === module) {
  const mode = process.argv[2] || 'parse';
  if (mode === 'run') { run().catch(e => { console.error('FATAL', e); process.exit(1); }); return; }
  if (mode === 'testdl') {
    // Download just ONE media (the smallest — an image) to prove the pipeline.
    (async () => {
      const plan = buildPlan();
      const img = plan.find(t => t.msg_type === 'image');
      console.log('testing download:', img.name, img.drive_url);
      const r = await driveDownload(img.drive_url, img.file_name);
      console.log('OK →', r.mediaUrl, (r.size / 1024).toFixed(0), 'KB');
    })().catch(e => { console.error('FAIL', e.message); process.exit(1); });
    return;
  }
  const plan = buildPlan();
  if (mode === 'parse') {
    console.log(`Parsed ${plan.length} templates (source=${SOURCE}):\n`);
    plan.forEach((t, i) => {
      console.log(`#${i + 1} ${t.name}`);
      console.log(`   day_offset: ${t.day_offset} | send_time: ${t.send_time} | msg_type: ${t.msg_type} (${t.file_type_raw})`);
      console.log(`   file: ${t.file_name || '(none)'}`);
      console.log(`   drive: ${t.drive_url || '(NONE — no media link!)'}`);
      console.log(`   body: ${t.body.slice(0, 70).replace(/\n/g, ' / ')}…`);
      console.log('');
    });
  }
}

module.exports = { buildPlan, UPLOAD_DIR, SOURCE };
