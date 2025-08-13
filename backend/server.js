const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const csv = require("csv-parser");
const moment = require("moment");
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const { createServer } = require("http");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: "uploads/" });
const server = createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let contacts = [];
let sock;
let latestQR = null;
let connectionStatus = "disconnected";
let sendingProgress = { total: 0, sent: 0, failed: 0 };
let sendingLogs = [];

if (fs.existsSync("contacts.json")) {
    contacts = JSON.parse(fs.readFileSync("contacts.json", "utf8"));
}

function loadHistory() {
    if (fs.existsSync("history.json")) {
        return JSON.parse(fs.readFileSync("history.json", "utf8"));
    }
    return [];
}

function saveHistory(history) {
    fs.writeFileSync("history.json", JSON.stringify(history, null, 2));
}

function updateStatus(status) {
    connectionStatus = status;
    io.emit("status", status);
}

function updateQR(qr) {
    latestQR = qr;
    io.emit("qr", qr);
}

app.get("/contacts", (req, res) => {
    res.json(contacts);
});

app.post("/upload", upload.single("file"), (req, res) => {
    const filePath = path.join(__dirname, req.file.path);
    let newContacts = [];
    fs.createReadStream(filePath)
        .pipe(csv())
        .on("data", (row) => {
            let number = Object.values(row)[0].replace(/\D/g, "");
            if (number.startsWith("0")) number = "255" + number.slice(1);
            if (!contacts.includes(number)) newContacts.push(number);
        })
        .on("end", () => {
            fs.unlinkSync(filePath);
            contacts = [...new Set([...contacts, ...newContacts])];
            fs.writeFileSync("contacts.json", JSON.stringify(contacts));
            res.json({ message: "Contacts merged", count: contacts.length });
        });
});

app.get("/history", (req, res) => {
    res.json(loadHistory());
});

app.post("/send", async (req, res) => {
    const { message } = req.body;
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
        message,
        total: sendingProgress.total,
        sent: sendingProgress.sent,
        failed: sendingProgress.failed
    });
    saveHistory(history);

    res.json({ message: "Messages sent", stats: sendingProgress });
});

async function connectWA() {
    const { state, saveCreds } = await useMultiFileAuthState("auth");
    sock = makeWASocket({ auth: state });

    sock.ev.on("connection.update", (update) => {
        const { qr, connection, lastDisconnect } = update;
        if (qr) {
            updateQR(qr);
            updateStatus("disconnected");
            console.log("📲 Scan this QR to connect WhatsApp:");
            qrcode.generate(qr, { small: true });
        }
        if (connection === "open") {
            updateQR(null);
            updateStatus("connected");
            console.log("✅ WhatsApp connected");
        }
        if (connection === "close") {
            updateStatus("disconnected");
            console.log("⚠️ WhatsApp disconnected");
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
