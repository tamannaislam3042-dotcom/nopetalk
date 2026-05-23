require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const DB_FILE = path.join(__dirname, 'data', 'db.json');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], rooms: [], messages: [] }, null, 2));
}

let db = readDb();
const onlineUsers = new Map(); // userId -> Set(socketId)
const userSocketRooms = new Map(); // socketId -> Set(roomId)

function readDb() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      rooms: Array.isArray(parsed.rooms) ? parsed.rooms : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages : []
    };
  } catch (err) {
    console.error('Could not read database:', err);
    return { users: [], rooms: [], messages: [] };
  }
}

let writeTimer;
function saveDbSoon() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(saveDb, 80);
}

function saveDb() {
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarColor: user.avatarColor,
    about: user.about || '',
    createdAt: user.createdAt,
    online: isOnline(user.id)
  };
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing authorization token.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.users.find(u => u.id === payload.id);
    if (!user) return res.status(401).json({ error: 'User no longer exists.' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

function isOnline(userId) {
  return onlineUsers.has(userId) && onlineUsers.get(userId).size > 0;
}

function userRoomIds(userId) {
  return db.rooms.filter(r => r.memberIds.includes(userId)).map(r => r.id);
}

function publicRoom(room, requesterId) {
  const members = room.memberIds.map(id => sanitizeUser(db.users.find(u => u.id === id))).filter(Boolean);
  const lastMessage = db.messages.filter(m => m.roomId === room.id).slice(-1)[0] || null;
  let title = room.name;
  if (room.type === 'dm') {
    const other = members.find(m => m.id !== requesterId) || members[0];
    title = other ? other.displayName : 'Direct message';
  }
  return { ...room, title, members, lastMessage };
}

function ensureDmRoom(a, b) {
  const ids = [a, b].sort();
  let room = db.rooms.find(r => r.type === 'dm' && r.memberIds.length === 2 && r.memberIds.slice().sort().join(':') === ids.join(':'));
  if (!room) {
    room = {
      id: crypto.randomUUID(),
      type: 'dm',
      name: null,
      memberIds: ids,
      createdBy: a,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    db.rooms.push(room);
    saveDbSoon();
  }
  return room;
}

function broadcastPresence(userId) {
  const payload = { userId, online: isOnline(userId) };
  io.emit('presence:update', payload);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN, methods: ['GET', 'POST'] }
});

app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ ok: true, onlineUsers: onlineUsers.size, users: db.users.length }));

app.post('/api/auth/register', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const displayName = String(req.body.displayName || '').trim();
  const password = String(req.body.password || '');
  if (!/^[a-z0-9_.-]{3,24}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-24 characters: letters, numbers, dot, underscore, dash.' });
  }
  if (displayName.length < 2 || displayName.length > 40) {
    return res.status(400).json({ error: 'Display name must be 2-40 characters.' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (db.users.some(u => u.username === username)) return res.status(409).json({ error: 'Username is already taken.' });

  const user = {
    id: crypto.randomUUID(),
    username,
    displayName,
    passwordHash: await bcrypt.hash(password, 10),
    avatarColor: req.body.avatarColor || randomColor(username),
    about: '',
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  saveDbSoon();
  res.status(201).json({ token: signToken(user), user: sanitizeUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.users.find(u => u.username === username);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  res.json({ token: signToken(user), user: sanitizeUser(user) });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: sanitizeUser(req.user) }));

app.patch('/api/me', requireAuth, (req, res) => {
  const displayName = String(req.body.displayName || req.user.displayName).trim();
  const about = String(req.body.about || '').trim().slice(0, 140);
  if (displayName.length < 2 || displayName.length > 40) return res.status(400).json({ error: 'Display name must be 2-40 characters.' });
  req.user.displayName = displayName;
  req.user.about = about;
  saveDbSoon();
  io.emit('user:update', sanitizeUser(req.user));
  res.json({ user: sanitizeUser(req.user) });
});

app.get('/api/users', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const users = db.users
    .filter(u => u.id !== req.user.id)
    .filter(u => !q || u.username.includes(q) || u.displayName.toLowerCase().includes(q))
    .slice(0, 80)
    .map(sanitizeUser);
  res.json({ users });
});

app.get('/api/rooms', requireAuth, (req, res) => {
  const rooms = db.rooms
    .filter(r => r.memberIds.includes(req.user.id))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .map(r => publicRoom(r, req.user.id));
  res.json({ rooms });
});

app.post('/api/rooms/dm', requireAuth, (req, res) => {
  const otherId = String(req.body.userId || '');
  const other = db.users.find(u => u.id === otherId);
  if (!other) return res.status(404).json({ error: 'User not found.' });
  if (other.id === req.user.id) return res.status(400).json({ error: 'Cannot DM yourself.' });
  const room = ensureDmRoom(req.user.id, other.id);
  const payload = publicRoom(room, req.user.id);
  room.memberIds.forEach(id => io.to(`user:${id}`).emit('room:upsert', publicRoom(room, id)));
  res.status(201).json({ room: payload });
});

app.post('/api/rooms/group', requireAuth, (req, res) => {
  const name = String(req.body.name || '').trim();
  const memberIds = Array.from(new Set([req.user.id, ...(Array.isArray(req.body.memberIds) ? req.body.memberIds : [])]));
  if (name.length < 2 || name.length > 50) return res.status(400).json({ error: 'Group name must be 2-50 characters.' });
  const validIds = memberIds.filter(id => db.users.some(u => u.id === id));
  if (validIds.length < 2) return res.status(400).json({ error: 'Choose at least one other member.' });
  const room = {
    id: crypto.randomUUID(),
    type: 'group',
    name,
    memberIds: validIds,
    createdBy: req.user.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.rooms.push(room);
  saveDbSoon();
  validIds.forEach(id => io.to(`user:${id}`).emit('room:upsert', publicRoom(room, id)));
  res.status(201).json({ room: publicRoom(room, req.user.id) });
});

app.get('/api/rooms/:roomId/messages', requireAuth, (req, res) => {
  const room = db.rooms.find(r => r.id === req.params.roomId && r.memberIds.includes(req.user.id));
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  const before = req.query.before ? new Date(String(req.query.before)) : null;
  let messages = db.messages.filter(m => m.roomId === room.id);
  if (before && !Number.isNaN(before.getTime())) messages = messages.filter(m => new Date(m.createdAt) < before);
  messages = messages.slice(-80);
  res.json({ messages: messages.map(publicMessage) });
});

app.post('/api/rooms/:roomId/messages', requireAuth, (req, res) => {
  const result = createMessage(req.user, req.params.roomId, String(req.body.text || ''));
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(201).json({ message: publicMessage(result.message) });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.users.find(u => u.id === payload.id);
    if (!user) return next(new Error('Unauthorized'));
    socket.user = user;
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', socket => {
  const user = socket.user;
  socket.join(`user:${user.id}`);
  if (!onlineUsers.has(user.id)) onlineUsers.set(user.id, new Set());
  const wasOffline = !isOnline(user.id);
  onlineUsers.get(user.id).add(socket.id);

  const rooms = userRoomIds(user.id);
  userSocketRooms.set(socket.id, new Set(rooms));
  rooms.forEach(roomId => socket.join(`room:${roomId}`));

  socket.emit('ready', { user: sanitizeUser(user), rooms: db.rooms.filter(r => r.memberIds.includes(user.id)).map(r => publicRoom(r, user.id)) });
  if (wasOffline) broadcastPresence(user.id);

  socket.on('message:send', ({ roomId, text }, ack) => {
    const result = createMessage(user, String(roomId || ''), String(text || ''));
    if (result.error) {
      if (typeof ack === 'function') ack({ ok: false, error: result.error });
      return;
    }
    const msg = publicMessage(result.message);
    io.to(`room:${roomId}`).emit('message:new', msg);
    const room = db.rooms.find(r => r.id === roomId);
    if (room) room.memberIds.forEach(id => io.to(`user:${id}`).emit('room:upsert', publicRoom(room, id)));
    if (typeof ack === 'function') ack({ ok: true, message: msg });
  });

  socket.on('typing:start', ({ roomId }) => {
    if (canAccessRoom(user.id, roomId)) socket.to(`room:${roomId}`).emit('typing:update', { roomId, user: sanitizeUser(user), typing: true });
  });

  socket.on('typing:stop', ({ roomId }) => {
    if (canAccessRoom(user.id, roomId)) socket.to(`room:${roomId}`).emit('typing:update', { roomId, user: sanitizeUser(user), typing: false });
  });

  socket.on('room:join', ({ roomId }) => {
    if (canAccessRoom(user.id, roomId)) {
      socket.join(`room:${roomId}`);
      if (!userSocketRooms.has(socket.id)) userSocketRooms.set(socket.id, new Set());
      userSocketRooms.get(socket.id).add(roomId);
    }
  });

  socket.on('disconnect', () => {
    const set = onlineUsers.get(user.id);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) onlineUsers.delete(user.id);
    }
    userSocketRooms.delete(socket.id);
    if (!isOnline(user.id)) broadcastPresence(user.id);
  });
});

function canAccessRoom(userId, roomId) {
  return db.rooms.some(r => r.id === roomId && r.memberIds.includes(userId));
}

function createMessage(user, roomId, text) {
  const room = db.rooms.find(r => r.id === roomId && r.memberIds.includes(user.id));
  if (!room) return { status: 404, error: 'Room not found.' };
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return { status: 400, error: 'Message cannot be empty.' };
  if (clean.length > 2000) return { status: 400, error: 'Message is too long.' };
  const message = {
    id: crypto.randomUUID(),
    roomId: room.id,
    senderId: user.id,
    text: clean,
    createdAt: new Date().toISOString(),
    editedAt: null
  };
  db.messages.push(message);
  room.updatedAt = message.createdAt;
  saveDbSoon();
  return { message };
}

function publicMessage(message) {
  return {
    ...message,
    sender: sanitizeUser(db.users.find(u => u.id === message.senderId))
  };
}

function randomColor(seed) {
  const colors = ['#1877f2', '#7c3aed', '#059669', '#f59e0b', '#e11d48', '#0891b2', '#4f46e5', '#db2777'];
  let n = 0;
  for (const char of seed) n += char.charCodeAt(0);
  return colors[n % colors.length];
}

server.listen(PORT, () => {
  console.log(`PulseChat server running on http://localhost:${PORT}`);
});
