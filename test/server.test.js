const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { after, before, test } = require('node:test');
const WebSocket = require('ws');
const { createChatServer } = require('../server');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-room-test-'));
const app = createChatServer({ databasePath: path.join(tempDir, 'chat.sqlite') });
let baseUrl;
let cookie;

before(async () => {
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function request(route, { method = 'GET', body, session = true } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(session && cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (route === '/api/register' || route === '/api/login') {
    cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie;
  }
  return { response, data };
}

test('serves the chat and health check', async () => {
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Livechatty/);
  assert.equal(html.match(/class="brand"/g)?.length, 1);
  assert.doesNotMatch(html, /class="chat-brand"/);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const icon = await fetch(`${baseUrl}/livechatty-icon.svg`);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await icon.text(), /<svg/);
  const health = await request('/healthz');
  assert.deepEqual(health.data, { ok: true });
});

test('creates an account without collecting email or address and rejects duplicate usernames', async () => {
  const registered = await request('/api/register', {
    method: 'POST',
    body: { username: 'chat_friend', password: 'a-strong-password', displayName: 'Chat Friend' },
    session: false,
  });
  assert.equal(registered.response.status, 201);
  assert.equal(registered.data.user.username, 'chat_friend');
  assert.equal('email' in registered.data.user, false);
  assert.equal('address' in registered.data.user, false);

  const duplicate = await request('/api/register', {
    method: 'POST',
    body: { username: 'CHAT_FRIEND', password: 'another-password', displayName: 'Another' },
    session: false,
  });
  assert.equal(duplicate.response.status, 409);
});

test('updates profile and persists messages for logged-in users', async () => {
  const profile = await request('/api/profile', {
    method: 'PATCH',
    body: { displayName: 'Friend Online', bio: 'Here to chat', avatar: null },
  });
  assert.equal(profile.response.status, 200);
  assert.equal(profile.data.user.displayName, 'Friend Online');
  assert.equal(profile.data.user.bio, 'Here to chat');

  const posted = await request('/api/messages', { method: 'POST', body: { text: 'Hello, world!' } });
  assert.equal(posted.response.status, 201);
  assert.equal(posted.data.message.body, 'Hello, world!');
  assert.equal(posted.data.message.bio, 'Here to chat');
  const history = await request('/api/messages');
  assert.equal(history.data.messages.length, 1);
  assert.equal(history.data.messages[0].username, 'chat_friend');
});

test('broadcasts new messages to connected chat users', async () => {
  const wsUrl = baseUrl.replace('http:', 'ws:') + '/ws';
  const client = new WebSocket(wsUrl, { headers: { Cookie: cookie } });
  await once(client, 'open');
  const messageReceived = once(client, 'message');
  const posted = await request('/api/messages', { method: 'POST', body: { text: 'Live from the room' } });
  assert.equal(posted.response.status, 201);
  const [data] = await messageReceived;
  assert.equal(JSON.parse(data.toString()).message.body, 'Live from the room');
  client.close();
  await once(client, 'close');
});

test('requires a valid login to post chat messages', async () => {
  const unauthorized = await request('/api/messages', { method: 'POST', body: { text: 'No session' }, session: false });
  assert.equal(unauthorized.response.status, 401);
  const login = await request('/api/login', {
    method: 'POST',
    body: { username: 'chat_friend', password: 'wrong-password' },
    session: false,
  });
  assert.equal(login.response.status, 401);
});

test('allows an existing user to log in and end their session', async () => {
  const login = await request('/api/login', {
    method: 'POST',
    body: { username: 'chat_friend', password: 'a-strong-password' },
    session: false,
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.data.user.username, 'chat_friend');

  const me = await request('/api/me');
  assert.equal(me.data.user.username, 'chat_friend');
  const logout = await request('/api/logout', { method: 'POST' });
  assert.equal(logout.data.ok, true);
});
