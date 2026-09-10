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

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Explicit page routes make the prototype easier to run from any folder.
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get(['/admin', '/admin.html'], (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/pass.html', (_, res) => res.sendFile(path.join(__dirname, 'public', 'pass.html')));

const dbPath = path.join(__dirname, 'data.json');
const defaultDB = {
  questions: [
    { id: 'q1', text: 'Who would you vote for and why?', seconds: 10, enabled: true },
    { id: 'q2', text: 'Have you always voted the same way?', seconds: 10, enabled: true },
    { id: 'q3', text: 'What issue matters most to you right now?', seconds: 10, enabled: true }
  ],
  participants: {},
  sessions: {},
  clips: []
};
function loadDB() {
  if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, JSON.stringify(defaultDB, null, 2));
  return JSON.parse(fs.readFileSync(dbPath));
}
function saveDB(db) { fs.writeFileSync(dbPath, JSON.stringify(db, null, 2)); }
function token() { return crypto.randomBytes(12).toString('hex'); }

app.get('/api/health', (_, res) => res.json({ ok: true, service: 'VoxBooth API' }));
app.get('/api/questions', (_, res) => {
  const db = loadDB();
  res.json(db.questions.filter(q => q.enabled));
});
app.put('/api/questions', (req, res) => {
  const incoming = Array.isArray(req.body) ? req.body : [];
  if (!incoming.length) return res.status(400).json({ error: 'At least one question is required' });
  const db = loadDB();
  db.questions = incoming.map((q, i) => ({
    id: q.id || `q${i+1}`,
    text: String(q.text || '').trim(),
    seconds: Math.max(5, Math.min(120, Number(q.seconds) || 10)),
    enabled: q.enabled !== false
  }));
  saveDB(db);
  res.json(db.questions);
});

app.post('/api/register', async (req, res) => {
  const { name, mobile, email, ageBracket, postcode, gender, consent, contactOK } = req.body;
  if (!name || (!mobile && !email) || consent !== true) {
    return res.status(400).json({ error: 'Name, a contact method and consent are required.' });
  }
  const participantId = token();
  const sessionToken = token();
  const db = loadDB();
  db.participants[participantId] = { id: participantId, name, mobile, email, ageBracket, postcode, gender, consent, contactOK: !!contactOK, createdAt: new Date().toISOString() };
  db.sessions[sessionToken] = { token: sessionToken, participantId, verified: true, used: false, createdAt: new Date().toISOString() };
  saveDB(db);
  const qrPayload = `${PUBLIC_BASE_URL}/pass.html?t=${encodeURIComponent(sessionToken)}`;
  const qrDataURL = await QRCode.toDataURL(sessionToken, { width: 420, margin: 1 });
  res.json({ participantId, sessionToken, qrPayload, qrDataURL, demoVerification: 'Prototype auto-verifies registration. Replace with SMS/email OTP in production.' });
});

app.get('/api/session/:token', (req, res) => {
  const db = loadDB();
  const s = db.sessions[req.params.token];
  if (!s || !s.verified) return res.status(404).json({ error: 'Pass not found or not verified.' });
  const p = db.participants[s.participantId];
  res.json({ session: s, participant: { id: p.id, name: p.name, ageBracket: p.ageBracket, postcode: p.postcode }, questions: db.questions.filter(q => q.enabled) });
});

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => {
    const safe = (req.body.sessionToken || 'unknown').slice(0, 10);
    const q = (req.body.questionId || 'q').replace(/[^a-z0-9_-]/gi, '');
    cb(null, `${Date.now()}_${safe}_${q}.mov`);
  }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

app.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video supplied.' });
  const db = loadDB();
  const s = db.sessions[req.body.sessionToken];
  if (!s) return res.status(400).json({ error: 'Invalid session token.' });
  const p = db.participants[s.participantId];
  const q = db.questions.find(x => x.id === req.body.questionId);
  const clip = {
    id: token(), participantId: p.id, participantName: p.name,
    ageBracket: p.ageBracket, postcode: p.postcode,
    questionId: req.body.questionId, question: q?.text || req.body.questionText || '',
    filename: req.file.filename, url: `/uploads/${req.file.filename}`,
    recordedAt: req.body.recordedAt || new Date().toISOString(),
    boothId: req.body.boothId || 'prototype-booth'
  };
  db.clips.unshift(clip);
  saveDB(db);
  res.json(clip);
});

app.get('/api/clips', (_, res) => res.json(loadDB().clips));
app.listen(PORT, '0.0.0.0', () => console.log(`VoxBooth backend: ${PUBLIC_BASE_URL}`));
