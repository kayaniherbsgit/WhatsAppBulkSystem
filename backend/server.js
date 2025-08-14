require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const csv = require("csv-parser");
const moment = require("moment");
const mongoose = require("mongoose");
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const { createServer } = require("http");
const { Server } = require("socket.io");
const { google } = require("googleapis");

const app = express();
app.use(cors());
app.use(express.json());

// === MongoDB Connect ===
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB connection error:", err));

// === Schemas ===
const contactSchema = new mongoose.Schema({
    phone: { type: String },
    name: String
});
const ContactSetSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    contacts: [contactSchema],
    createdAt: { type: Date, default: Date.now }
});

const ContactSet = mongoose.model("ContactSet", ContactSetSchema);

const upload = multer({ dest: "uploads/" });
const server = createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// === Google OAuth Config ===
const CLIENT_ID = "914452657092-73dba1v09p9t2t1su8khkpdpa8d0bnlf.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const REDIRECT_URI = "http://localhost:5000/auth/google/callback";
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

let sock;
let latestQR = null;
let connectionStatus = "disconnected";
let sendingProgress = { total: 0, sent: 0, failed: 0 };
let sendingLogs = [];

// === Helper Functions ===
function loadHistory() {
    try {
        if (fs.existsSync("history.json")) {
            const data = fs.readFileSync("history.json", "utf8").trim();
            if (!data) return [];
            return JSON.parse(data);
        }
        return [];
    } catch (err) {
        console.error("Error loading history:", err);
        return [];
    }
}

function saveHistory(history) {
    try {
        fs.writeFileSync("history.json", JSON.stringify(history, null, 2));
    } catch (err) {
        console.error("Error saving history:", err);
    }
}

function updateStatus(status) {
    connectionStatus = status;
    io.emit("status", status);
}

function updateQR(qr) {
    latestQR = qr;
    io.emit("qr", qr);
}

// === ROUTES ===

// List all contact sets with counts
app.get("/contacts", async (req, res) => {
    const sets = await ContactSet.find({}, "name contacts");
    res.json(sets.map(s => ({ name: s.name, count: s.contacts.length })));
});

// Get all contacts in a specific set
app.get("/contacts/:setName", async (req, res) => {
    const set = await ContactSet.findOne({ name: req.params.setName });
    if (!set) return res.status(404).json({ error: "Set not found" });
    res.json(set.contacts);
});

// Upload CSV to specific set
app.post("/upload/:setName", upload.single("file"), async (req, res) => {
    const filePath = path.join(__dirname, req.file.path);
    let newContacts = [];

    fs.createReadStream(filePath)
        .pipe(csv())
        .on("data", (row) => {
            let number = Object.values(row)[0].replace(/\D/g, "");
            if (number.startsWith("0")) number = "255" + number.slice(1);
            newContacts.push({ phone: number });
        })
        .on("end", async () => {
            fs.unlinkSync(filePath);
            let set = await ContactSet.findOne({ name: req.params.setName });
            if (!set) set = new ContactSet({ name: req.params.setName, contacts: [] });

            const existingPhones = set.contacts.map(c => c.phone);
            for (let c of newContacts) {
                if (!existingPhones.includes(c.phone)) set.contacts.push(c);
            }
            await set.save();
            res.json({ message: "Contacts added to set", count: set.contacts.length });
        });
});

// Google Auth Step 1
app.get("/auth/google", (req, res) => {
    const url = oauth2Client.generateAuthUrl({
        access_type: "offline",
        scope: ["https://www.googleapis.com/auth/contacts.readonly"]
    });
    res.redirect(url);
});

// Google Auth Step 2
app.get("/auth/google/callback", async (req, res) => {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    res.redirect("http://localhost:3000/import-google");
});

// Fetch Google Contacts
app.get("/contacts/google", async (req, res) => {
    try {
        const service = google.people({ version: "v1", auth: oauth2Client });
        const response = await service.people.connections.list({
            resourceName: "people/me",
            pageSize: 500,
            personFields: "names,phoneNumbers"
        });

        const connections = response.data.connections || [];
        const contactsList = connections
            .filter(c => c.phoneNumbers && c.phoneNumbers.length > 0)
            .map(c => ({
                name: c.names ? c.names[0].displayName : "Unknown",
                phone: c.phoneNumbers[0].value.replace(/\D/g, "")
            }));

        res.json(contactsList);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch contacts" });
    }
});

// Save Google Contacts to specific set
app.post("/contacts/google/save", async (req, res) => {
    const { setName, numbers } = req.body;
    if (!Array.isArray(numbers) || !setName) {
        return res.status(400).json({ error: "Invalid input" });
    }
    let set = await ContactSet.findOne({ name: setName });
    if (!set) set = new ContactSet({ name: setName, contacts: [] });

    const existingPhones = set.contacts.map(c => c.phone);
    for (let phone of numbers) {
        if (!existingPhones.includes(phone)) set.contacts.push({ phone });
    }
    await set.save();
    res.json({ message: "Google contacts saved", count: set.contacts.length, contacts: set.contacts });
});

// Send messages to a specific set
app.post("/send/:setName", async (req, res) => {
    const { message } = req.body;
    const set = await ContactSet.findOne({ name: req.params.setName });
    if (!set) return res.status(404).json({ error: "Set not found" });

    const contacts = set.contacts.map(c => c.phone);
    if (!sock || connectionStatus !== "connected") {
        return res.status(400).json({ error: "WhatsApp not connected" });
    }

    sendingProgress = { total: contacts.length, sent: 0, failed: 0 };
    sendingLogs = [];
    io.emit("progress", sendingProgress);

    for (let number of contacts) {
        let personalized = message.replace("{{name}}", "");
        try {
            await sock.sendMessage(number + "@s.whatsapp.net", { text: personalized });
            sendingProgress.sent++;
            sendingLogs.push(`✅ Sent to ${number}`);
        } catch (err) {
            sendingProgress.failed++;
            sendingLogs.push(`❌ Failed to send to ${number}`);
        }
        io.emit("progress", sendingProgress);
        io.emit("logs", sendingLogs);
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
    }

    const history = loadHistory();
    history.unshift({
        date: moment().format("YYYY-MM-DD HH:mm:ss"),
        setName: req.params.setName,
        message,
        total: sendingProgress.total,
        sent: sendingProgress.sent,
        failed: sendingProgress.failed
    });
    saveHistory(history);

    res.json({ message: "Messages sent", stats: sendingProgress });
});

// WhatsApp connection
async function connectWA() {
    const { state, saveCreds } = await useMultiFileAuthState("auth");
    sock = makeWASocket({ auth: state });

    sock.ev.on("connection.update", (update) => {
        const { qr, connection, lastDisconnect } = update;
        if (qr) {
            updateQR(qr);
            updateStatus("disconnected");
            qrcode.generate(qr, { small: true });
        }
        if (connection === "open") {
            updateQR(null);
            updateStatus("connected");
        }
        if (connection === "close") {
            updateStatus("disconnected");
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                setTimeout(connectWA, 5000);
            }
        }
    });

    sock.ev.on("creds.update", saveCreds);
}

io.on("connection", (socket) => {
    socket.emit("status", connectionStatus);
    socket.emit("qr", latestQR);
    socket.emit("progress", sendingProgress);
    socket.emit("logs", sendingLogs);
});

connectWA();
server.listen(5000, () => console.log("🚀 Backend running on port 5000"));
