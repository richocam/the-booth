import express from 'express';
import cors from 'cors';
import multer from 'multer';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8787;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// -----------------------------------------------------------------------------
// Storage paths
// -----------------------------------------------------------------------------

// For testing, files are stored beside server.js.
// On Render, you can later set DATA_DIR=/var/data and attach a persistent disk
// mounted at /var/data.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const uploadsDir = path.join(DATA_DIR, 'uploads');
const archivesDir = path.join(DATA_DIR, 'archives');
const dbPath = path.join(DATA_DIR, 'data.json');

// Make sure the data and uploads folders exist before Multer or the database
// tries to write to them.
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(archivesDir, { recursive: true });

// -----------------------------------------------------------------------------
// Middleware
// -----------------------------------------------------------------------------

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

// -----------------------------------------------------------------------------
// Page routes
// -----------------------------------------------------------------------------

app.get('/', (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.get(['/admin', '/admin.html'], (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html'))
);

app.get('/pass.html', (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'pass.html'))
);

app.get(['/results', '/results.html'], (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'results.html'))
);

app.get(['/research', '/research.html'], (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'research.html'))
);

// -----------------------------------------------------------------------------
// Database
// -----------------------------------------------------------------------------

const defaultDB = {
  questions: [
    {
      id: 'q1',
      text: 'Who would you vote for and why?',
      seconds: 10,
      enabled: true
    },
    {
      id: 'q2',
      text: 'Have you always voted the same way?',
      seconds: 10,
      enabled: true
    },
    {
      id: 'q3',
      text: 'What issue matters most to you right now?',
      seconds: 10,
      enabled: true
    }
  ],
  pollQuestions: [
    {
      id: 'poll1',
      text: 'Which issue matters most to you right now?',
      options: ['Cost of living', 'Health', 'Housing', 'Education', 'Other'],
      enabled: true
    },
    {
      id: 'poll2',
      text: 'How engaged are you with this issue?',
      options: ['Very engaged', 'Somewhat engaged', 'Not very engaged', 'Not at all'],
      enabled: true
    }
  ],
  pollResponses: [],
  participants: {},
  sessions: {},
  clips: [],
  archives: []
};

function loadDB() {
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify(defaultDB, null, 2));
  }

  try {
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

    // Lightweight migration so older prototype data.json files continue to work.
    if (!Array.isArray(db.questions)) db.questions = structuredClone(defaultDB.questions);
    if (!Array.isArray(db.pollQuestions)) db.pollQuestions = structuredClone(defaultDB.pollQuestions);
    if (!Array.isArray(db.pollResponses)) db.pollResponses = [];
    if (!db.participants || typeof db.participants !== 'object') db.participants = {};
    if (!db.sessions || typeof db.sessions !== 'object') db.sessions = {};
    if (!Array.isArray(db.clips)) db.clips = [];
    if (!Array.isArray(db.archives)) db.archives = [];

    return db;
  } catch (error) {
    console.error('Could not read data.json:', error);
    return structuredClone(defaultDB);
  }
}

function saveDB(db) {
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

function token() {
  return crypto.randomBytes(12).toString('hex');
}

function safeSlug(value = '') {
  return String(value)
    .trim()
    .replace(/[^a-z0-9 _-]/gi, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
    .replace(/^-|-$/g, '');
}

function csvEscape(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function directoryBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directoryBytes(full);
    else {
      try { total += fs.statSync(full).size; } catch (_) {}
    }
  }
  return total;
}

function activeDataCounts(db) {
  return {
    participants: Object.keys(db.participants || {}).length,
    sessions: Object.keys(db.sessions || {}).length,
    pollResponses: (db.pollResponses || []).length,
    clips: (db.clips || []).length
  };
}

function hasActiveResearchData(db) {
  const c = activeDataCounts(db);
  return c.participants > 0 || c.sessions > 0 || c.pollResponses > 0 || c.clips > 0;
}

function buildArchiveCSV(db) {
  const pollQuestions = db.pollQuestions || [];
  const videoQuestions = db.questions || [];
  const pollHeaders = pollQuestions.map(q => `poll:${q.text}`);
  const videoHeaders = videoQuestions.map(q => `video:${q.text}`);

  const headers = [
    'participant_id','name','mobile','email','age_bracket','postcode','gender',
    'consent','contact_permission','registered_at','session_token','poll_completed',
    'booth_ids','location_ids','device_ids','recording_frame_rates',
    ...pollHeaders,
    ...videoHeaders
  ];

  const sessionByParticipant = {};
  for (const session of Object.values(db.sessions || {})) {
    if (session?.participantId) sessionByParticipant[session.participantId] = session;
  }

  const pollByParticipant = {};
  for (const response of db.pollResponses || []) {
    pollByParticipant[response.participantId] = response;
  }

  const clipsByParticipant = {};
  for (const clip of db.clips || []) {
    (clipsByParticipant[clip.participantId] ||= []).push(clip);
  }

  const rows = Object.values(db.participants || {}).map(p => {
    const session = sessionByParticipant[p.id] || {};
    const response = pollByParticipant[p.id] || {};
    const clips = clipsByParticipant[p.id] || [];

    const videoCells = videoQuestions.map(q =>
      clips
        .filter(c => c.questionId === q.id || c.question === q.text)
        .map(c => c.filename || path.basename(String(c.url || '')))
        .filter(Boolean)
        .join('; ')
    );

    return [
      p.id, p.name, p.mobile, p.email, p.ageBracket, p.postcode, p.gender,
      p.consent ? 'Yes' : 'No', p.contactOK ? 'Yes' : 'No', p.createdAt || '',
      session.token || '', session.pollCompleted ? 'Yes' : 'No',
      [...new Set(clips.map(c => c.boothId).filter(Boolean))].join('; '),
      [...new Set(clips.map(c => c.locationId).filter(Boolean))].join('; '),
      [...new Set(clips.map(c => c.deviceId).filter(Boolean))].join('; '),
      [...new Set(clips.map(c => c.recordingFPS).filter(Boolean))].join('; '),
      ...pollQuestions.map(q => response.answers?.[q.id] || ''),
      ...videoCells
    ].map(csvEscape).join(',');
  });

  return [headers.map(csvEscape).join(','), ...rows].join('\n');
}

function resetActiveResearchData(db) {
  db.pollResponses = [];
  db.participants = {};
  db.sessions = {};
  db.clips = [];
}

// -----------------------------------------------------------------------------
// Health
// -----------------------------------------------------------------------------

app.get('/api/health', (_, res) => {
  res.json({
    ok: true,
    service: 'VoxBooth API',
    storagePath: DATA_DIR
  });
});


// -----------------------------------------------------------------------------
// Archive / storage management
// -----------------------------------------------------------------------------

app.get('/api/archive-status', (_, res) => {
  const db = loadDB();
  res.json({
    active: {
      ...activeDataCounts(db),
      videoBytes: directoryBytes(uploadsDir)
    },
    archives: (db.archives || []).map(a => ({
      ...a,
      videoBytes: directoryBytes(path.join(archivesDir, a.id, 'videos'))
    }))
  });
});

app.post('/api/archive', (req, res) => {
  try {
    const db = loadDB();

    if (!hasActiveResearchData(db)) {
      return res.status(400).json({ error: 'There is no active contributor data to archive.' });
    }

    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const label = safeSlug(req.body?.label || '') || now.toISOString().slice(0, 10);
    const archiveId = `${stamp}_${label}`;
    const archiveDir = path.join(archivesDir, archiveId);
    const videoDir = path.join(archiveDir, 'videos');

    fs.mkdirSync(videoDir, { recursive: true });

    // Create the CSV before moving/resetting anything.
    const csvName = 'responses.csv';
    fs.writeFileSync(path.join(archiveDir, csvName), buildArchiveCSV(db), 'utf8');

    // Preserve the exact question set and a non-secret snapshot of the archive.
    const manifest = {
      id: archiveId,
      label: String(req.body?.label || '').trim() || now.toISOString().slice(0, 10),
      createdAt: now.toISOString(),
      videoQuestions: db.questions,
      pollQuestions: db.pollQuestions,
      counts: activeDataCounts(db),
      videos: []
    };

    for (const clip of db.clips || []) {
      const filename = clip.filename || path.basename(String(clip.url || ''));
      if (!filename) continue;

      const source = path.join(uploadsDir, filename);
      const destination = path.join(videoDir, filename);

      if (fs.existsSync(source)) {
        fs.renameSync(source, destination);
        manifest.videos.push({
          clipId: clip.id,
          participantId: clip.participantId,
          questionId: clip.questionId || '',
          question: clip.question || '',
          filename,
          recordedAt: clip.recordedAt || '',
          boothId: clip.boothId || '',
          locationId: clip.locationId || '',
          deviceId: clip.deviceId || '',
          recordingFPS: clip.recordingFPS || 25
        });
      }
    }

    fs.writeFileSync(
      path.join(archiveDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );

    const archiveRecord = {
      id: archiveId,
      label: manifest.label,
      createdAt: manifest.createdAt,
      counts: manifest.counts,
      csv: csvName,
      videosPurgedAt: null
    };

    db.archives.push(archiveRecord);
    resetActiveResearchData(db);
    saveDB(db);

    res.json({
      ok: true,
      archive: archiveRecord,
      message: 'Archive created. Active contributor data has been reset and questions may now be changed.'
    });
  } catch (error) {
    console.error('Archive error:', error);
    res.status(500).json({ error: 'Could not create archive.' });
  }
});

app.get('/api/archives/:id/csv', (req, res) => {
  const db = loadDB();
  const archive = (db.archives || []).find(a => a.id === req.params.id);
  if (!archive) return res.status(404).send('Archive not found.');

  const file = path.join(archivesDir, archive.id, archive.csv || 'responses.csv');
  if (!fs.existsSync(file)) return res.status(404).send('Archive CSV not found.');

  res.download(file, `THE-BOOTH_${safeSlug(archive.label) || archive.id}.csv`);
});

app.delete('/api/videos/active', (_, res) => {
  try {
    const db = loadDB();
    let deleted = 0;
    let bytes = 0;

    for (const clip of db.clips || []) {
      const filename = clip.filename || path.basename(String(clip.url || ''));
      const file = filename ? path.join(uploadsDir, filename) : null;
      if (file && fs.existsSync(file)) {
        try {
          bytes += fs.statSync(file).size;
          fs.unlinkSync(file);
          deleted++;
        } catch (_) {}
      }
    }

    // Remove clip metadata too, so the UI does not retain broken video links.
    db.clips = [];
    saveDB(db);

    res.json({ ok: true, deleted, bytes });
  } catch (error) {
    console.error('Active video purge error:', error);
    res.status(500).json({ error: 'Could not purge active videos.' });
  }
});

app.delete('/api/archives/:id/videos', (req, res) => {
  try {
    const db = loadDB();
    const archive = (db.archives || []).find(a => a.id === req.params.id);
    if (!archive) return res.status(404).json({ error: 'Archive not found.' });

    const videoDir = path.join(archivesDir, archive.id, 'videos');
    const bytes = directoryBytes(videoDir);

    if (fs.existsSync(videoDir)) {
      fs.rmSync(videoDir, { recursive: true, force: true });
    }

    archive.videosPurgedAt = new Date().toISOString();
    saveDB(db);

    res.json({ ok: true, bytes });
  } catch (error) {
    console.error('Archive video purge error:', error);
    res.status(500).json({ error: 'Could not purge archived videos.' });
  }
});


app.get('/api/archives/:id', (req, res) => {
  const db = loadDB();
  const archive = (db.archives || []).find(a => a.id === req.params.id);
  if (!archive) return res.status(404).json({ error: 'Archive not found.' });

  const archiveDir = path.join(archivesDir, archive.id);
  const manifestPath = path.join(archiveDir, 'manifest.json');
  const csvPath = path.join(archiveDir, archive.csv || 'responses.csv');

  let manifest = { videoQuestions: [], pollQuestions: [], videos: [] };
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) {}
  }

  let rows = [];
  if (fs.existsSync(csvPath)) {
    // Lightweight CSV parser that handles quoted cells and embedded commas/newlines.
    const input = fs.readFileSync(csvPath, 'utf8');
    const parsed = []; let row = [], cell = '', quoted = false;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (quoted) {
        if (ch === '"' && input[i+1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else {
        if (ch === '"') quoted = true;
        else if (ch === ',') { row.push(cell); cell = ''; }
        else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); parsed.push(row); row=[]; cell=''; }
        else cell += ch;
      }
    }
    if (cell.length || row.length) { row.push(cell.replace(/\r$/, '')); parsed.push(row); }
    if (parsed.length) {
      const headers = parsed[0];
      rows = parsed.slice(1).filter(r => r.some(Boolean)).map(r =>
        Object.fromEntries(headers.map((h,i)=>[h, r[i] ?? '']))
      );
    }
  }

  res.json({
    archive: {
      ...archive,
      videoBytes: directoryBytes(path.join(archiveDir, 'videos'))
    },
    manifest,
    rows
  });
});

app.get('/api/archives/:id/videos/:filename', (req, res) => {
  const db = loadDB();
  const archive = (db.archives || []).find(a => a.id === req.params.id);
  if (!archive) return res.status(404).send('Archive not found.');

  const filename = path.basename(req.params.filename);
  const file = path.join(archivesDir, archive.id, 'videos', filename);
  if (!fs.existsSync(file)) return res.status(404).send('Video not found.');
  res.sendFile(file);
});

app.get(['/archive', '/archive.html'], (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'archive.html'))
);

// -----------------------------------------------------------------------------
// Questions
// -----------------------------------------------------------------------------

app.get('/api/questions', (_, res) => {
  const db = loadDB();
  res.json(db.questions.filter(q => q.enabled));
});

app.put('/api/questions', (req, res) => {
  const incoming = Array.isArray(req.body) ? req.body : [];

  if (!incoming.length) {
    return res
      .status(400)
      .json({ error: 'At least one question is required' });
  }

  const db = loadDB();

  if (hasActiveResearchData(db)) {
    return res.status(409).json({
      error: 'Archive the current session before changing video questions.',
      archiveRequired: true,
      counts: activeDataCounts(db)
    });
  }

  db.questions = incoming.map((q, i) => ({
    id: q.id || `q${i + 1}`,
    text: String(q.text || '').trim(),
    seconds: Math.max(5, Math.min(120, Number(q.seconds) || 10)),
    enabled: q.enabled !== false
  }));

  saveDB(db);
  res.json(db.questions);
});

// -----------------------------------------------------------------------------
// Quick poll questions and live aggregate results
// -----------------------------------------------------------------------------

app.get('/api/poll-questions', (_, res) => {
  const db = loadDB();
  res.json(db.pollQuestions.filter(q => q.enabled));
});

app.put('/api/poll-questions', (req, res) => {
  const incoming = Array.isArray(req.body) ? req.body : [];
  const db = loadDB();

  if (hasActiveResearchData(db)) {
    return res.status(409).json({
      error: 'Archive the current session before changing quick-poll questions.',
      archiveRequired: true,
      counts: activeDataCounts(db)
    });
  }

  db.pollQuestions = incoming
    .map((q, i) => ({
      id: String(q.id || `poll${i + 1}`)
        .replace(/[^a-z0-9_-]/gi, '')
        .slice(0, 40) || `poll${i + 1}`,
      text: String(q.text || '').trim(),
      options: Array.isArray(q.options)
        ? q.options.map(v => String(v).trim()).filter(Boolean).slice(0, 12)
        : String(q.options || '')
            .split(',')
            .map(v => v.trim())
            .filter(Boolean)
            .slice(0, 12),
      enabled: q.enabled !== false
    }))
    .filter(q => q.text && q.options.length >= 2);

  saveDB(db);
  res.json(db.pollQuestions);
});

app.post('/api/poll-response', async (req, res) => {
  try {
    const { participantId, sessionToken, answers } = req.body || {};
    const db = loadDB();

    const session = db.sessions[sessionToken];
    if (!participantId || !session || session.participantId !== participantId) {
      return res.status(400).json({ error: 'Invalid participant or session.' });
    }

    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({ error: 'No poll answers supplied.' });
    }

    const requiredQuestions = db.pollQuestions.filter(q => q.enabled);
    const cleanedAnswers = {};
    const missing = [];

    for (const q of requiredQuestions) {
      const answer = String(answers[q.id] || '').trim();
      if (answer && q.options.includes(answer)) {
        cleanedAnswers[q.id] = answer;
      } else {
        missing.push(q.id);
      }
    }

    // If a quick poll is configured, every enabled question must be answered
    // before the participant receives a booth QR pass.
    if (requiredQuestions.length && missing.length) {
      return res.status(400).json({
        error: 'Please answer every quick poll question before continuing.',
        missingQuestionIds: missing
      });
    }

    db.pollResponses = db.pollResponses.filter(
      r => !(r.participantId === participantId && r.sessionToken === sessionToken)
    );

    db.pollResponses.push({
      id: token(),
      participantId,
      sessionToken,
      answers: cleanedAnswers,
      createdAt: new Date().toISOString()
    });

    session.pollCompleted = true;
    session.pollCompletedAt = new Date().toISOString();
    saveDB(db);

    const qrDataURL = await QRCode.toDataURL(sessionToken, {
      width: 420,
      margin: 1
    });

    res.json({
      ok: true,
      answered: Object.keys(cleanedAnswers).length,
      pollCompleted: true,
      sessionToken,
      qrDataURL,
      qrURL: `/api/pass-qr/${encodeURIComponent(sessionToken)}`
    });
  } catch (error) {
    console.error('Poll response error:', error);
    res.status(500).json({ error: 'Could not save the quick poll.' });
  }
});

app.get('/api/poll-results', (_, res) => {
  const db = loadDB();

  const results = db.pollQuestions
    .filter(q => q.enabled)
    .map(q => {
      const counts = Object.fromEntries(q.options.map(option => [option, 0]));
      let total = 0;

      for (const response of db.pollResponses) {
        const answer = response.answers?.[q.id];
        if (answer && Object.prototype.hasOwnProperty.call(counts, answer)) {
          counts[answer] += 1;
          total += 1;
        }
      }

      return {
        id: q.id,
        text: q.text,
        total,
        options: q.options.map(option => ({
          option,
          count: counts[option],
          percent: total ? Math.round((counts[option] / total) * 1000) / 10 : 0
        }))
      };
    });

  res.json({
    updatedAt: new Date().toISOString(),
    responseCount: db.pollResponses.length,
    results
  });
});

// -----------------------------------------------------------------------------
// Research dashboard API
// -----------------------------------------------------------------------------

function safeParticipantView(p = {}) {
  return {
    ageBracket: p.ageBracket || '',
    postcode: p.postcode || '',
    gender: p.gender || '',
    contactOK: !!p.contactOK
  };
}

app.get('/api/research-data', (_, res) => {
  const db = loadDB();

  const respondents = db.pollResponses.map(r => {
    const p = db.participants[r.participantId] || {};
    const clips = db.clips.filter(c => c.participantId === r.participantId).map(c => ({
      id: c.id,
      questionId: c.questionId || '',
      question: c.question || '',
      recordedAt: c.recordedAt,
      url: c.url,
      boothId: c.boothId || '',
      locationId: c.locationId || '',
      deviceId: c.deviceId || '',
      recordingFPS: c.recordingFPS || 25
    }));

    return {
      responseId: r.id,
      participantId: r.participantId,
      createdAt: r.createdAt,
      demographics: safeParticipantView(p),
      answers: r.answers || {},
      clips
    };
  });

  res.json({
    generatedAt: new Date().toISOString(),
    pollQuestions: db.pollQuestions.filter(q => q.enabled),
    respondentCount: respondents.length,
    respondents
  });
});

app.get('/api/research-export.csv', (_, res) => {
  const db = loadDB();
  const questions = db.pollQuestions.filter(q => q.enabled);
  const headers = [
    'response_id','created_at','age_bracket','postcode','gender','contact_permission',
    ...questions.map(q => q.text)
  ];

  const csvEscape = value => {
    const str = String(value ?? '');
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const rows = db.pollResponses.map(r => {
    const p = db.participants[r.participantId] || {};
    return [
      r.id, r.createdAt, p.ageBracket || '', p.postcode || '', p.gender || '',
      p.contactOK ? 'Yes' : 'No',
      ...questions.map(q => r.answers?.[q.id] || '')
    ].map(csvEscape).join(',');
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="the-booth-research-export.csv"');
  res.send([headers.map(csvEscape).join(','), ...rows].join('\n'));
});

// -----------------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------------

app.post('/api/register', async (req, res) => {
  try {
    const {
      name,
      mobile,
      email,
      ageBracket,
      postcode,
      gender,
      consent,
      contactOK
    } = req.body;

    if (!name || (!mobile && !email) || consent !== true) {
      return res.status(400).json({
        error: 'Name, a contact method and consent are required.'
      });
    }

    const participantId = token();
    const sessionToken = token();
    const db = loadDB();
    const enabledPollQuestions = db.pollQuestions.filter(q => q.enabled);
    const pollRequired = enabledPollQuestions.length > 0;

    db.participants[participantId] = {
      id: participantId,
      name,
      mobile,
      email,
      ageBracket,
      postcode,
      gender,
      consent,
      contactOK: !!contactOK,
      createdAt: new Date().toISOString()
    };

    db.sessions[sessionToken] = {
      token: sessionToken,
      participantId,
      verified: true,
      used: false,
      pollRequired,
      pollCompleted: !pollRequired,
      createdAt: new Date().toISOString()
    };

    saveDB(db);

    // The QR is deliberately withheld until the required quick poll is complete.
    // If no poll questions are enabled, the participant can receive a pass now.
    let qrDataURL = null;
    if (!pollRequired) {
      qrDataURL = await QRCode.toDataURL(sessionToken, {
        width: 420,
        margin: 1
      });
    }

    res.json({
      participantId,
      sessionToken,
      pollRequired,
      pollCompleted: !pollRequired,
      qrDataURL,
      qrURL: `/api/pass-qr/${encodeURIComponent(sessionToken)}`,
      demoVerification:
        'Prototype auto-verifies registration. Replace with SMS/email OTP in production.'
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed.' });
  }
});

// -----------------------------------------------------------------------------
// Booth pass QR image
// -----------------------------------------------------------------------------

app.get('/api/pass-qr/:token', async (req, res) => {
  try {
    const db = loadDB();
    const session = db.sessions[req.params.token];

    if (!session || !session.verified) {
      return res.status(404).send('Pass not found.');
    }

    if (session.pollRequired && !session.pollCompleted) {
      return res.status(403).send('Quick poll must be completed before this pass is available.');
    }

    const png = await QRCode.toBuffer(session.token, {
      type: 'png',
      width: 520,
      margin: 2,
      errorCorrectionLevel: 'M'
    });

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.send(png);
  } catch (error) {
    console.error('Pass QR error:', error);
    res.status(500).send('Could not generate QR pass.');
  }
});

// -----------------------------------------------------------------------------
// Session lookup
// -----------------------------------------------------------------------------

app.get('/api/session/:token', (req, res) => {
  const db = loadDB();
  const session = db.sessions[req.params.token];

  if (!session || !session.verified) {
    return res
      .status(404)
      .json({ error: 'Pass not found or not verified.' });
  }

  if (session.pollRequired && !session.pollCompleted) {
    return res.status(403).json({
      error: 'Quick poll must be completed before this Booth pass can be used.',
      pollRequired: true,
      pollCompleted: false
    });
  }

  const participant = db.participants[session.participantId];

  if (!participant) {
    return res.status(404).json({ error: 'Participant not found.' });
  }

  res.json({
    session,
    participant: {
      id: participant.id,
      name: participant.name,
      ageBracket: participant.ageBracket,
      postcode: participant.postcode
    },
    questions: db.questions.filter(q => q.enabled)
  });
});

// -----------------------------------------------------------------------------
// Video upload
// -----------------------------------------------------------------------------

const storage = multer.diskStorage({
  destination: (_, __, cb) => {
    // Ensure folder still exists in case the runtime has been restarted.
    fs.mkdirSync(uploadsDir, { recursive: true });
    cb(null, uploadsDir);
  },

  filename: (req, file, cb) => {
    const safeSession = String(req.body.sessionToken || 'unknown')
      .replace(/[^a-z0-9_-]/gi, '')
      .slice(0, 10);

    const safeQuestion = String(req.body.questionId || 'q')
      .replace(/[^a-z0-9_-]/gi, '');

    cb(
      null,
      `${Date.now()}_${safeSession}_${safeQuestion}${path.extname(file.originalname).toLowerCase() === '.mp4' ? '.mp4' : '.mov'}`
    );
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024
  }
});

app.post('/api/upload', upload.single('video'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video supplied.' });
    }

    const db = loadDB();
    const session = db.sessions[req.body.sessionToken];

    if (!session) {
      // Remove orphaned upload if session validation fails.
      try {
        fs.unlinkSync(req.file.path);
      } catch (_) {}

      return res.status(400).json({ error: 'Invalid session token.' });
    }

    const participant = db.participants[session.participantId];

    if (!participant) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (_) {}

      return res.status(400).json({ error: 'Participant not found.' });
    }

    const question = db.questions.find(
      q => q.id === req.body.questionId
    );

    const clip = {
      id: token(),
      participantId: participant.id,
      participantName: participant.name,
      ageBracket: participant.ageBracket,
      postcode: participant.postcode,
      questionId: req.body.questionId,
      question:
        question?.text ||
        req.body.questionText ||
        '',
      filename: req.file.filename,
      url: `/uploads/${req.file.filename}`,
      recordedAt:
        req.body.recordedAt ||
        new Date().toISOString(),
      boothId:
        req.body.boothId ||
        'prototype-booth',
      locationId:
        req.body.locationId ||
        'unassigned',
      deviceId:
        req.body.deviceId ||
        '',
      recordingFPS:
        Number(req.body.recordingFPS) === 30 ? 30 : 25
    };

    db.clips.unshift(clip);
    saveDB(db);

    console.log(
      `Uploaded clip: ${clip.filename} | ${clip.participantName} | ${clip.questionId}`
    );

    res.json(clip);
  } catch (error) {
    console.error('Upload processing error:', error);
    res.status(500).json({
      error: 'Clip uploaded but could not be processed.'
    });
  }
});

// -----------------------------------------------------------------------------
// Clips
// -----------------------------------------------------------------------------

app.get('/api/clips', (_, res) => {
  res.json(loadDB().clips);
});

// -----------------------------------------------------------------------------
// Start server
// -----------------------------------------------------------------------------

app.listen(PORT, '0.0.0.0', () => {
  console.log(`VoxBooth backend running on port ${PORT}`);
  console.log(`Public URL: ${PUBLIC_BASE_URL}`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Uploads directory: ${uploadsDir}`);
});
