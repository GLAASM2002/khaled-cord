// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// folders & files
const UPLOADS_DIR = path.join(__dirname, "uploads");
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const MESSAGES_FILE = path.join(DATA_DIR, "messages.json");

// ensure directories exist
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]");
if (!fs.existsSync(MESSAGES_FILE)) fs.writeFileSync(MESSAGES_FILE, "[]");

// multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.random().toString(36).slice(2,8);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// middleware
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOADS_DIR));
app.use(express.json()); // for login route

// helpers
async function readJSON(filePath) {
  try {
    const txt = await fs.promises.readFile(filePath, "utf8");
    return JSON.parse(txt || "[]");
  } catch (e) {
    return [];
  }
}
async function writeJSON(filePath, data) {
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2));
}
function hashPassword(pw) {
  return crypto.createHash("sha256").update(pw).digest("hex");
}
function randomColor() {
  return "#" + Math.floor(Math.random()*16777215).toString(16).padStart(6,"0");
}

// ---------- API Routes ----------

// Register (multipart form: fields username,password and optional file 'profile')
app.post("/api/register", upload.single("profile"), async (req, res) => {
  const username = (req.body.username || "").trim();
  const password = req.body.password || "";
  if (!username || !password) return res.status(400).json({ ok:false, error: "username & password required" });

  const users = await readJSON(USERS_FILE);
  if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(400).json({ ok:false, error: "username already taken" });
  }

  const id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2,8);
  const profile = req.file ? `/uploads/${req.file.filename}` : "";
  const user = {
    id,
    username,
    passwordHash: hashPassword(password),
    profile,
    color: randomColor(),
    createdAt: Date.now()
  };
  users.push(user);
  await writeJSON(USERS_FILE, users);

  // return user info (no password)
  const safe = { id: user.id, username: user.username, profile: user.profile, color: user.color };
  res.json({ ok:true, user: safe });
});

// Login (JSON body)
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok:false, error: "username & password required" });

  const users = await readJSON(USERS_FILE);
  const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return res.status(400).json({ ok:false, error: "invalid credentials" });

  if (user.passwordHash !== hashPassword(password)) {
    return res.status(400).json({ ok:false, error: "invalid credentials" });
  }

  const safe = { id: user.id, username: user.username, profile: user.profile, color: user.color };
  res.json({ ok:true, user: safe });
});

// Upload chat image (single file field 'chatImage') -> returns { url: '/uploads/...' }
app.post("/upload-chat", upload.single("chatImage"), (req, res) => {
  if (!req.file) return res.status(400).json({ ok:false });
  res.json({ ok:true, url: `/uploads/${req.file.filename}` });
});

// Also support profile upload separate endpoint (optional)
app.post("/upload-profile", upload.single("profile"), (req, res) => {
  if (!req.file) return res.status(400).json({ ok:false });
  res.json({ ok:true, url: `/uploads/${req.file.filename}` });
});

// Provide saved messages (client can also get via sockets)
app.get("/api/messages", async (req, res) => {
  const messages = await readJSON(MESSAGES_FILE);
  res.json({ ok:true, messages });
});

// ---------- Socket.IO ----------

let online = {}; // socket.id => user (safe user object)

io.on("connection", (socket) => {
  console.log("socket connected:", socket.id);

  // client must send 'auth' with user id after opening socket
  socket.on("auth", async (userId) => {
    const users = await readJSON(USERS_FILE);
    const user = users.find(u => u.id === userId);
    if (!user) {
      socket.emit("auth-failed");
      return;
    }

    // attach user info (safe)
    socket.user = { id: user.id, username: user.username, profile: user.profile, color: user.color };
    online[socket.id] = socket.user;

    // send the list of online users to everyone
    io.emit("update-users", Object.values(online));

    // send saved messages (last 500)
    const messages = await readJSON(MESSAGES_FILE);
    const tail = messages.slice(-500);
    socket.emit("load-messages", tail);
  });

  // send text message
  socket.on("send-message", async (text) => {
    if (!socket.user) return;
    text = String(text || "").trim();
    if (!text) return;

    const messages = await readJSON(MESSAGES_FILE);
    const msg = {
      id: Date.now().toString(36) + "-" + Math.random().toString(36,8),
      userId: socket.user.id,
      username: socket.user.username,
      profile: socket.user.profile || "",
      color: socket.user.color || "#fff",
      text,
      timestamp: Date.now()
    };
    messages.push(msg);
    // keep file to a reasonable size
    if (messages.length > 2000) messages.splice(0, messages.length - 2000);
    await writeJSON(MESSAGES_FILE, messages);

    io.emit("new-message", msg);
  });

  // send image message (url)
  socket.on("send-image", async (imageUrl) => {
    if (!socket.user) return;
    if (!imageUrl) return;

    const messages = await readJSON(MESSAGES_FILE);
    const msg = {
      id: Date.now().toString(36) + "-" + Math.random().toString(36,8),
      userId: socket.user.id,
      username: socket.user.username,
      profile: socket.user.profile || "",
      color: socket.user.color || "#fff",
      image: imageUrl,
      timestamp: Date.now()
    };
    messages.push(msg);
    if (messages.length > 2000) messages.splice(0, messages.length - 2000);
    await writeJSON(MESSAGES_FILE, messages);

    io.emit("new-message", msg);
  });

  socket.on("disconnect", () => {
    if (online[socket.id]) {
      delete online[socket.id];
      io.emit("update-users", Object.values(online));
    }
    console.log("socket disconnected:", socket.id);
  });
});

// start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
