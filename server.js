const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const { WebSocketServer, WebSocket } = require('ws');

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = 'openroom_session';
const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 30;
const MAX_BODY_BYTES = 3 * 1024 * 1024;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME_TYPES = {
  '/': 'text/html; charset=utf-8',
  '/index.html': 'text/html; charset=utf-8',
  '/styles.css': 'text/css; charset=utf-8',
  '/app.js': 'text/javascript; charset=utf-8',
  '/livechatty-icon.svg': 'image/svg+xml',
};

function createChatServer({ databasePath = path.join(__dirname, '.data', 'chat.sqlite') } = {}) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      bio TEXT NOT NULL DEFAULT '',
      avatar TEXT,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS messages_created_at ON messages(id DESC);
    CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
  `);
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      console.error('Request failed:', error);
      if (!res.headersSent) {
        const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
        sendJson(res, status, { error: status === 500 ? 'Something went wrong. Please try again.' : error.message });
      }
      else res.destroy();
    });
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    void authenticateUpgrade(req)
      .then((user) => {
        if (!user || req.url !== '/ws') {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.user = user;
          wss.emit('connection', ws, req);
        });
      })
      .catch((error) => {
        console.error('WebSocket authentication failed:', error);
        socket.destroy();
      });
  });

  function broadcast(message) {
    const data = JSON.stringify({ type: 'message', message });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz' && req.method === 'GET') return sendJson(res, 200, { ok: true });

    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && !isSameOrigin(req)) {
        return sendJson(res, 403, { error: 'Request origin was not accepted.' });
      }

      if (url.pathname === '/api/register' && req.method === 'POST') {
        const body = await readJson(req);
        const username = typeof body.username === 'string' ? body.username.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : username;
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
          return sendJson(res, 400, { error: 'Username must be 3–20 letters, numbers, or underscores.' });
        }
        if (password.length < 8 || password.length > 200) {
          return sendJson(res, 400, { error: 'Password must be between 8 and 200 characters.' });
        }
        if (!displayName || displayName.length > 40) {
          return sendJson(res, 400, { error: 'Name must be between 1 and 40 characters.' });
        }
        const salt = crypto.randomBytes(16);
        const passwordHash = await scrypt(password, salt, 64);
        try {
          const result = db.prepare(`
            INSERT INTO users (username, display_name, password_hash, password_salt)
            VALUES (?, ?, ?, ?)
          `).run(username, displayName, passwordHash.toString('hex'), salt.toString('hex'));
          const user = findUserById(Number(result.lastInsertRowid));
          createSession(user.id, res);
          return sendJson(res, 201, { user });
        } catch (error) {
          if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/i.test(error.message)) {
            return sendJson(res, 409, { error: 'That username is already taken.' });
          }
          throw error;
        }
      }

      if (url.pathname === '/api/login' && req.method === 'POST') {
        const body = await readJson(req);
        const username = typeof body.username === 'string' ? body.username.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        const stored = db.prepare(`
          SELECT id, password_hash, password_salt FROM users WHERE username = ?
        `).get(username);
        if (!stored || password.length > 200) return sendJson(res, 401, { error: 'Incorrect username or password.' });
        const candidate = await scrypt(password, Buffer.from(stored.password_salt, 'hex'), 64);
        if (!crypto.timingSafeEqual(candidate, Buffer.from(stored.password_hash, 'hex'))) {
          return sendJson(res, 401, { error: 'Incorrect username or password.' });
        }
        const user = findUserById(stored.id);
        createSession(user.id, res);
        return sendJson(res, 200, { user });
      }

      if (url.pathname === '/api/logout' && req.method === 'POST') {
        const token = readCookie(req, SESSION_COOKIE);
        if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookie()}`);
        return sendJson(res, 200, { ok: true });
      }

      const currentUser = getSessionUser(req);
      if (url.pathname === '/api/me' && req.method === 'GET') {
        return sendJson(res, 200, { user: currentUser });
      }
      if (!currentUser) return sendJson(res, 401, { error: 'Please log in to continue.' });

      if (url.pathname === '/api/profile' && req.method === 'PATCH') {
        const body = await readJson(req);
        const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
        const bio = typeof body.bio === 'string' ? body.bio.trim() : '';
        const avatar = body.avatar === null ? null : typeof body.avatar === 'string' ? body.avatar : undefined;
        if (!displayName || displayName.length > 40) {
          return sendJson(res, 400, { error: 'Name must be between 1 and 40 characters.' });
        }
        if (bio.length > 160) return sendJson(res, 400, { error: 'Bio must be 160 characters or fewer.' });
        if (avatar !== undefined && avatar !== null) {
          const match = /^data:image\/(png|jpeg|webp);base64,([a-zA-Z0-9+/]+=*)$/.exec(avatar);
          if (!match || Buffer.from(match[2], 'base64').length > MAX_AVATAR_BYTES) {
            return sendJson(res, 400, { error: 'Choose a PNG, JPEG, or WebP image smaller than 2 MB.' });
          }
        }
        if (avatar === undefined) {
          db.prepare('UPDATE users SET display_name = ?, bio = ? WHERE id = ?')
            .run(displayName, bio, currentUser.id);
        } else {
          db.prepare('UPDATE users SET display_name = ?, bio = ?, avatar = ? WHERE id = ?')
            .run(displayName, bio, avatar, currentUser.id);
        }
        return sendJson(res, 200, { user: findUserById(currentUser.id) });
      }

      if (url.pathname === '/api/messages' && req.method === 'GET') {
        const messages = db.prepare(`
          SELECT m.id, m.body, m.created_at AS createdAt,
                 u.username, u.display_name AS displayName, u.bio, u.avatar
          FROM messages m JOIN users u ON u.id = m.user_id
          ORDER BY m.id DESC LIMIT 100
        `).all().reverse();
        return sendJson(res, 200, { messages });
      }
      if (url.pathname === '/api/messages' && req.method === 'POST') {
        const body = await readJson(req);
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text || text.length > 2000) {
          return sendJson(res, 400, { error: 'Message must be between 1 and 2,000 characters.' });
        }
        const result = db.prepare('INSERT INTO messages (user_id, body) VALUES (?, ?)')
          .run(currentUser.id, text);
        const message = db.prepare(`
          SELECT m.id, m.body, m.created_at AS createdAt,
                 u.username, u.display_name AS displayName, u.bio, u.avatar
          FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?
        `).get(Number(result.lastInsertRowid));
        broadcast(message);
        return sendJson(res, 201, { message });
      }
      return sendJson(res, 404, { error: 'Not found.' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 404, { error: 'Not found.' });
    const filePath = MIME_TYPES[url.pathname] && path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!filePath) return sendJson(res, 404, { error: 'Not found.' });
    try {
      const contents = await fs.promises.readFile(filePath);
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[url.pathname],
        'Content-Length': contents.length,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' ws: wss:; base-uri 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
      });
      res.end(req.method === 'HEAD' ? undefined : contents);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      sendJson(res, 404, { error: 'Not found.' });
    }
  }

  function getSessionUser(req) {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return null;
    const session = db.prepare(`
      SELECT user_id AS userId FROM sessions WHERE token_hash = ? AND expires_at > ?
    `).get(hashToken(token), Date.now());
    return session ? findUserById(session.userId) : null;
  }

  async function authenticateUpgrade(req) {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return null;
    return getSessionUser(req);
  }

  function findUserById(id) {
    return db.prepare(`
      SELECT id, username, display_name AS displayName, bio, avatar
      FROM users WHERE id = ?
    `).get(id) || null;
  }

  function createSession(userId, res) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(hashToken(token), userId, Date.now() + SESSION_LIFETIME_SECONDS * 1000);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_LIFETIME_SECONDS}${secureCookie()}`);
  }

  function secureCookie() {
    return process.env.NODE_ENV === 'production' ? '; Secure' : '';
  }

  function close() {
    for (const client of wss.clients) client.terminate();
    wss.close();
    if (!server.listening) {
      db.close();
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      server.close((error) => {
        db.close();
        if (error) reject(error);
        else resolve();
      });
      server.closeAllConnections();
    });
  }

  return { server, close };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function readCookie(req, name) {
  const cookies = req.headers.cookie || '';
  for (const cookie of cookies.split(';')) {
    const separator = cookie.indexOf('=');
    if (separator >= 0 && cookie.slice(0, separator).trim() === name) {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    }
  }
  return null;
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

if (require.main === module) {
  const { server } = createChatServer();
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => {
    console.log(`Livechatty is running on port ${port}`);
  });
}

module.exports = { createChatServer };
