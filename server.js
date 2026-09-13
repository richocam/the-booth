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
const dbPath = path.join(DATA_DIR, 'data.json');

// Make sure the data and uploads folders exist before Multer or the database
// tries to write to them.
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

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
  clips: []
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

app.post('/api/poll-response', (req, res) => {
  const { participantId, sessionToken, answers } = req.body || {};
  const db = loadDB();

  const session = db.sessions[sessionToken];
  if (!participantId || !session || session.participantId !== participantId) {
    return res.status(400).json({ error: 'Invalid participant or session.' });
  }

  if (!answers || typeof answers !== 'object') {
    return res.status(400).json({ error: 'No poll answers supplied.' });
  }

  const cleanedAnswers = {};
  for (const q of db.pollQuestions.filter(q => q.enabled)) {
    const answer = String(answers[q.id] || '').trim();
    if (answer && q.options.includes(answer)) {
      cleanedAnswers[q.id] = answer;
    }
  }

  if (!Object.keys(cleanedAnswers).length) {
    return res.status(400).json({ error: 'Please answer at least one poll question.' });
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

  saveDB(db);
  res.json({ ok: true, answered: Object.keys(cleanedAnswers).length });
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
      url: c.url
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
      createdAt: new Date().toISOString()
    };

    saveDB(db);

    const qrPayload = `${PUBLIC_BASE_URL}/pass.html?t=${encodeURIComponent(
      sessionToken
    )}`;

    const qrDataURL = await QRCode.toDataURL(sessionToken, {
      width: 420,
      margin: 1
    });

    res.json({
      participantId,
      sessionToken,
      qrPayload,
      qrDataURL,
      demoVerification:
        'Prototype auto-verifies registration. Replace with SMS/email OTP in production.'
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed.' });
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
        'prototype-booth'
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
