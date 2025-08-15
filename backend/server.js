require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const csv = require('csv-parser');
const moment = require('moment');
const mongoose = require('mongoose');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { google } = require('googleapis');

// === Models ===
const ContactSet = require('./models/ContactSet');
const GoogleToken = require('./models/GoogleToken');

const app = express();

// --- CORS & JSON ---
app.use(
  cors({
    origin: ['http://localhost:3000', 'http://127.0.0.1:3000', '*'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
  })
);
app.use(express.json({ limit: '2mb' }));

// === MongoDB Connect ===
mongoose
  .connect(process.env.MONGO_URI, {
    autoIndex: true,
  })
  .then(() => console.log('✅ MongoDB connected'))
  .catch((err) => console.error('❌ MongoDB connection error:', err));

// (optional) surface hidden crashes
process.on('unhandledRejection', (err) => console.error('🧯 Unhandled Rejection:', err));
process.on('uncaughtException', (err) => console.error('🧯 Uncaught Exception:', err));

// === Ensure uploads folder exists ===
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// === Multer Upload Config ===
const upload = multer({ dest: UPLOAD_DIR });

// === Socket.IO Server ===
const server = createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// === Google OAuth Config ===
const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);

// === WhatsApp Variables ===
let sock;
let latestQR = null;
let connectionStatus = 'disconnected';
let sendingProgress = { total: 0, sent: 0, failed: 0 };
let sendingLogs = [];

// === Helper Functions ===
function loadHistory() {
  if (fs.existsSync('history.json')) {
    const data = fs.readFileSync('history.json', 'utf8').trim();
    return data ? JSON.parse(data) : [];
  }
  return [];
}
function saveHistory(history) {
  fs.writeFileSync('history.json', JSON.stringify(history, null, 2));
}
function updateStatus(status) {
  connectionStatus = status;
  io.emit('status', status);
}
function updateQR(qr) {
  latestQR = qr;
  io.emit('qr', qr);
}

// Normalize phone numbers to TZ format 2557XXXXXXX etc.
function normalizeTZ(raw) {
  let n = String(raw || '').replace(/\D/g, '');
  if (!n) return null;
  if (n.startsWith('00')) n = n.slice(2);
  if (n.startsWith('0')) n = '255' + n.slice(1);
  if (!n.startsWith('255') && n.length === 9) n = '255' + n;
  return n;
}

// === ROUTES ===
//
// ===== Contact Set Listing =====

// List all contact sets (name + count)
app.get('/contacts/sets', async (req, res) => {
  try {
    const sets = await ContactSet.find({}, 'name contacts updatedAt createdAt').sort({ updatedAt: -1 });
    res.json(sets.map((s) => ({ name: s.name, count: s.contacts.length, updatedAt: s.updatedAt, createdAt: s.createdAt })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to list contact sets' });
  }
});

// Back-compat alias for older frontend code
app.get('/contacts', async (req, res) => {
  try {
    const sets = await ContactSet.find({}, 'name contacts');
    res.json(sets.map((s) => ({ name: s.name, count: s.contacts.length })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to list contact sets' });
  }
});

// ===== CSV Upload (smart parser) =====

// Upload CSV contacts (smart: supports name+phone, only phone, with/without headers)
app.post('/upload/:setName', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded' });

  const filePath = req.file.path; // absolute from Multer
  const newContacts = [];

  // --- helpers ---
  const cleanHeader = (h) => (h || '').replace(/\uFEFF/g, '').trim(); // strip BOM + spaces

  const getDigits = (v) => String(v ?? '').replace(/\D/g, '');
  const looksLikePhone = (v) => getDigits(v).length >= 7; // loose gate; normalization enforces format

  const extractFromRow = (row, state) => {
    // Normalize header keys once
    if (!state._normalized) {
      state.keys = Object.keys(row || {});
      state.nkeys = state.keys.map(cleanHeader);
      // Try find named columns first
      state.phoneKey =
        state.keys[
          state.nkeys.findIndex((k) => /^phone(s)?$/i.test(k) || /phone/i.test(k))
        ] ?? null;
      state.nameKey =
        state.keys[
          state.nkeys.findIndex((k) => /^name(s)?$/i.test(k))
        ] ?? null;
      state._normalized = true;
    }

    let rawPhone = null;
    let rawName = '';

    // 1) Preferred: explicit phone column
    if (state.phoneKey && row[state.phoneKey] != null) {
      rawPhone = row[state.phoneKey];
    }

    // 2) If no explicit phone, scan values: pick the first value that looks like a phone
    if (!rawPhone) {
      for (const v of Object.values(row)) {
        if (looksLikePhone(v)) {
          rawPhone = v;
          break;
        }
      }
    }

    // 3) If still nothing and there’s one string cell that might be "Name,Phone", split it
    if (!rawPhone) {
      const values = Object.values(row).filter((v) => v != null && String(v).trim() !== '');
      if (values.length === 1) {
        const parts = String(values[0]).split(',');
        if (parts.length >= 2) {
          // try rightmost as phone (handles "name, phone" or "something, something, phone")
          const candidate = parts[parts.length - 1];
          if (looksLikePhone(candidate)) {
            rawPhone = candidate;
            // name is everything before last comma, trimmed
            rawName = parts.slice(0, -1).join(',').trim();
          }
        }
      }
    }

    // 4) Name column (if present) overrides parsed name
    if (state.nameKey && row[state.nameKey] != null) {
      rawName = String(row[state.nameKey]).trim();
    } else if (!rawName) {
      // If no name column, try to pick a non-phone, non-empty value as name
      for (const [, v] of Object.entries(row)) {
        if (!looksLikePhone(v) && String(v || '').trim() !== '') {
          rawName = String(v).trim();
          break;
        }
      }
    }

    // Normalize phone to your TZ format
    const normalized = normalizeTZ(rawPhone);
    if (!normalized) return null; // skip invalid rows

    return {
      phone: normalized,
      name: rawName || '', // always store a string
    };
  };

  // --- parse CSV ---
  const state = { _normalized: false, keys: [], nkeys: [], phoneKey: null, nameKey: null };
  try {
    await new Promise((resolve, reject) => {
      fs.createReadStream(filePath)
        .pipe(
          csv({
            mapHeaders: ({ header }) => cleanHeader(header),
            mapValues: ({ value }) => (typeof value === 'string' ? value.trim() : value),
          })
        )
        .on('data', (row) => {
          const contact = extractFromRow(row, state);
          if (contact) newContacts.push(contact);
        })
        .on('end', resolve)
        .on('error', reject);
    });
  } catch (err) {
    console.error('CSV parse error', err);
    try { fs.unlinkSync(filePath); } catch {}
    return res.status(400).json({ error: 'Failed to parse CSV' });
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }

  if (newContacts.length === 0) {
    return res.status(400).json({ error: 'No valid phone numbers found in CSV' });
  }

  // --- save to DB (dedupe) ---
  try {
    let set = await ContactSet.findOne({ name: req.params.setName });
    if (!set) set = new ContactSet({ name: req.params.setName, contacts: [] });

    const existingPhones = new Set(set.contacts.map((c) => c.phone));
    let added = 0;

    for (const c of newContacts) {
      if (!existingPhones.has(c.phone)) {
        set.contacts.push({ phone: c.phone, name: c.name || '' });
        existingPhones.add(c.phone);
        added++;
      }
    }

    if (added === 0 && set.isNew) {
      return res.status(400).json({ error: 'No new numbers to add (all duplicates or invalid)' });
    }

    await set.save();
    res.json({ message: 'Contacts added', added, count: set.contacts.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to save contacts' });
  }
});

// ===== Set & Contact Management (CRUD) =====

// Export a set as CSV
app.get('/contacts/:setName/export.csv', async (req, res) => {
  try {
    const set = await ContactSet.findOne({ name: req.params.setName });
    if (!set) return res.status(404).send('Set not found');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(set.name)}.csv"`);

    res.write('name,phone\n');
    for (const c of set.contacts) {
      const safeName = (c.name || '').replace(/"/g, '""');
      const safePhone = (c.phone || '').replace(/"/g, '""');
      res.write(`"${safeName}","${safePhone}"\n`);
    }
    res.end();
  } catch (e) {
    console.error(e);
    res.status(500).send('Failed to export CSV');
  }
});

// Get contacts from a specific set
app.get('/contacts/:setName', async (req, res) => {
  try {
    const set = await ContactSet.findOne({ name: req.params.setName });
    if (!set) return res.status(404).json({ error: 'Set not found' });
    res.json(set.contacts);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load contacts' });
  }
});

// Add a contact manually to a set
app.post('/contacts/:setName/add', async (req, res) => {
  try {
    const { name = '', phone } = req.body || {};
    const normalized = normalizeTZ(phone);
    if (!normalized) return res.status(400).json({ error: 'Invalid phone' });

    let set = await ContactSet.findOne({ name: req.params.setName });
    if (!set) set = new ContactSet({ name: req.params.setName, contacts: [] });

    const exists = set.contacts.some((c) => c.phone === normalized);
    if (exists) return res.status(409).json({ error: 'Phone already exists in this set' });

    set.contacts.push({ name: String(name || ''), phone: normalized });
    await set.save();

    res.json({ message: 'Contact added', contact: set.contacts[set.contacts.length - 1], count: set.contacts.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to add contact' });
  }
});

// Update a contact in a set (by subdocument _id)
app.put('/contacts/:setName/:contactId', async (req, res) => {
  try {
    const { name, phone } = req.body || {};
    const set = await ContactSet.findOne({ name: req.params.setName });
    if (!set) return res.status(404).json({ error: 'Set not found' });

    const sub = set.contacts.id(req.params.contactId);
    if (!sub) return res.status(404).json({ error: 'Contact not found' });

    // If phone provided, normalize and ensure not duplicate
    if (typeof phone !== 'undefined') {
      const normalized = normalizeTZ(phone);
      if (!normalized) return res.status(400).json({ error: 'Invalid phone' });

      const dup = set.contacts.some((c) => c._id.toString() !== sub._id.toString() && c.phone === normalized);
      if (dup) return res.status(409).json({ error: 'Phone already exists in this set' });

      sub.phone = normalized;
    }
    if (typeof name !== 'undefined') {
      sub.name = String(name || '');
    }

    await set.save();
    res.json({ message: 'Contact updated', contact: sub, count: set.contacts.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// Delete a contact from a set
app.delete('/contacts/:setName/:contactId', async (req, res) => {
  try {
    const set = await ContactSet.findOne({ name: req.params.setName });
    if (!set) return res.status(404).json({ error: 'Set not found' });

    const sub = set.contacts.id(req.params.contactId);
    if (!sub) return res.status(404).json({ error: 'Contact not found' });

    sub.deleteOne(); // remove subdoc
    await set.save();

    res.json({ message: 'Contact deleted', count: set.contacts.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

// Rename a set
app.patch('/contacts/:setName/rename', async (req, res) => {
  try {
    const { newName } = req.body || {};
    if (!newName || !String(newName).trim()) {
      return res.status(400).json({ error: 'newName is required' });
    }
    const existing = await ContactSet.findOne({ name: newName.trim() });
    if (existing) return res.status(409).json({ error: 'Target set name already exists' });

    const set = await ContactSet.findOne({ name: req.params.setName });
    if (!set) return res.status(404).json({ error: 'Set not found' });

    set.name = newName.trim();
    await set.save();

    res.json({ message: 'Set renamed', name: set.name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to rename set' });
  }
});

// Delete an entire set
app.delete('/contacts/:setName', async (req, res) => {
  try {
    const result = await ContactSet.findOneAndDelete({ name: req.params.setName });
    if (!result) return res.status(404).json({ error: 'Set not found' });
    res.json({ message: 'Set deleted', name: req.params.setName });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to delete set' });
  }
});

// ===== Google OAuth & Contacts =====

app.get('/auth/google', (req, res) => {
  try {
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/contacts.readonly'],
    });
    res.redirect(url);
  } catch (e) {
    console.error(e);
    res.status(500).send('Google auth init failed');
  }
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    await GoogleToken.deleteMany({});
    await GoogleToken.create(tokens);
    console.log('✅ Google tokens saved');
    res.redirect('http://localhost:3000/import-google');
  } catch (err) {
    console.error(err);
    res.status(500).send('Google auth failed');
  }
});

app.get('/contacts/google', async (req, res) => {
  try {
    const tokenDoc = await GoogleToken.findOne();
    if (!tokenDoc) return res.status(401).json({ error: 'Not authenticated' });

    oauth2Client.setCredentials(tokenDoc.toObject());

    // Refresh if expiring
    if (oauth2Client.isTokenExpiring && oauth2Client.isTokenExpiring()) {
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);
      await GoogleToken.updateOne({}, credentials);
      console.log('♻️ Token refreshed');
    }

    const service = google.people({ version: 'v1', auth: oauth2Client });
    const response = await service.people.connections.list({
      resourceName: 'people/me',
      pageSize: 500,
      personFields: 'names,phoneNumbers',
    });

    const contactsList = (response.data.connections || [])
      .filter((c) => c.phoneNumbers?.length)
      .map((c) => {
        const raw = c.phoneNumbers[0].value;
        const phone = normalizeTZ(raw);
        return {
          name: c.names?.[0]?.displayName || 'Unknown',
          phone,
        };
      })
      .filter((x) => !!x.phone);

    res.json(contactsList);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

app.post('/contacts/google/save', async (req, res) => {
  try {
    const { setName, numbers } = req.body;
    if (!Array.isArray(numbers) || !setName) {
      return res.status(400).json({ error: 'Invalid input' });
    }

    let set = await ContactSet.findOne({ name: setName });
    if (!set) set = new ContactSet({ name: setName, contacts: [] });

    const existingPhones = new Set(set.contacts.map((c) => c.phone));
    for (let phone of numbers) {
      const normalized = normalizeTZ(phone);
      if (normalized && !existingPhones.has(normalized)) {
        set.contacts.push({ phone: normalized });
        existingPhones.add(normalized);
      }
    }
    await set.save();
    res.json({ message: 'Saved', count: set.contacts.length, contacts: set.contacts });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to save Google contacts' });
  }
});

// ===== Sending via WhatsApp =====

app.post('/send/:setName', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const set = await ContactSet.findOne({ name: req.params.setName });
    if (!set) return res.status(404).json({ error: 'Set not found' });

    const contacts = set.contacts.map((c) => c.phone);
    if (!sock || connectionStatus !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp not connected' });
    }

    sendingProgress = { total: contacts.length, sent: 0, failed: 0 };
    sendingLogs = [];
    io.emit('progress', sendingProgress);

    for (const number of contacts) {
      const jid = `${number}@s.whatsapp.net`;
      try {
        await sock.sendMessage(jid, { text: message });
        sendingProgress.sent++;
        sendingLogs.push(`✅ Sent to ${number}`);
      } catch (err) {
        sendingProgress.failed++;
        sendingLogs.push(`❌ Failed to send to ${number}`);
      }
      io.emit('progress', sendingProgress);
      io.emit('logs', sendingLogs);

      // Basic rate control with jitter
      await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));
    }

    const history = loadHistory();
    history.unshift({
      date: moment().format('YYYY-MM-DD HH:mm:ss'),
      setName: req.params.setName,
      message,
      total: sendingProgress.total,
      sent: sendingProgress.sent,
      failed: sendingProgress.failed,
    });
    saveHistory(history);

    res.json({ message: 'Done', stats: sendingProgress });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to send messages' });
  }
});

// ===== Test Mongo =====

app.get('/test-mongo', async (req, res) => {
  try {
    await new ContactSet({
      name: 'TestSet',
      contacts: [{ phone: '255700000000', name: 'Test' }],
    }).save();
    res.send('✅ Mongo insert success');
  } catch (e) {
    console.error(e);
    res.status(500).send('❌ Mongo insert failed');
  }
});

// === WhatsApp Connection ===
async function connectWA() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  sock = makeWASocket({ auth: state });

  sock.ev.on('connection.update', (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      updateQR(qr);
      updateStatus('disconnected');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      updateQR(null);
      updateStatus('connected');
    }

    if (connection === 'close') {
      updateStatus('disconnected');
      const shouldReconnect =
        !lastDisconnect?.error ||
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        setTimeout(connectWA, 5000);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

io.on('connection', (socket) => {
  socket.emit('status', connectionStatus);
  socket.emit('qr', latestQR);
  socket.emit('progress', sendingProgress);
  socket.emit('logs', sendingLogs);
});

connectWA();
const PORT = process.env.PORT || 5000;
server.on('error', (e) => console.error('💥 Server listen error:', e));
server.listen(PORT, () => console.log(`🚀 Backend running on port ${PORT}`));
