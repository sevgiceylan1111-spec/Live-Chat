const authView = document.querySelector('#auth-view');
const chatView = document.querySelector('#chat-view');
const authForm = document.querySelector('#auth-form');
const authError = document.querySelector('#auth-error');
const nameField = document.querySelector('#name-field');
const displayNameInput = document.querySelector('#display-name');
const authTitle = document.querySelector('#auth-title');
const authSubtitle = document.querySelector('#auth-subtitle');
const authSubmit = document.querySelector('#auth-submit');
const passwordInput = document.querySelector('#password');
const messagesElement = document.querySelector('#messages');
const profileDialog = document.querySelector('#profile-dialog');
const profileForm = document.querySelector('#profile-form');
const profileError = document.querySelector('#profile-error');
const avatarFile = document.querySelector('#avatar-file');
const toast = document.querySelector('#toast');
const themeToggle = document.querySelector('#theme-toggle');

let authMode = 'login';
let currentUser = null;
let socket = null;
let selectedAvatar = null;
const renderedMessageIds = new Set();

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const dark = theme === 'dark';
  themeToggle.setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} mode`);
  themeToggle.title = `Switch to ${dark ? 'light' : 'dark'} mode`;
  document.querySelector('meta[name="theme-color"]').content = dark ? '#15151d' : '#f6f7fb';
}

let savedTheme = null;
try {
  savedTheme = localStorage.getItem('livechatty-theme');
} catch {
  // Keep the default theme when browser storage is unavailable.
}
setTheme(savedTheme === 'dark' ? 'dark' : 'light');
themeToggle.addEventListener('click', () => {
  const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  setTheme(nextTheme);
  try {
    localStorage.setItem('livechatty-theme', nextTheme);
  } catch {
    showToast('Theme changed, but this browser could not save your preference.');
  }
});

document.querySelector('#login-tab').addEventListener('click', () => setAuthMode('login'));
document.querySelector('#register-tab').addEventListener('click', () => setAuthMode('register'));

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === 'register';
  document.querySelector('#login-tab').classList.toggle('active', !registering);
  document.querySelector('#login-tab').setAttribute('aria-selected', String(!registering));
  document.querySelector('#register-tab').classList.toggle('active', registering);
  document.querySelector('#register-tab').setAttribute('aria-selected', String(registering));
  nameField.classList.toggle('hidden', !registering);
  displayNameInput.required = registering;
  passwordInput.autocomplete = registering ? 'new-password' : 'current-password';
  authTitle.textContent = registering ? 'Join the conversation' : 'Welcome back';
  authSubtitle.textContent = registering ? 'Make an account. It only takes a moment.' : 'Pick up where the conversation left off.';
  authSubmit.innerHTML = registering ? 'Create account <span aria-hidden="true">→</span>' : 'Log in <span aria-hidden="true">→</span>';
  authError.textContent = '';
}

async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    });
  } catch {
    throw new Error("Can't reach Livechatty's chat server. In the project folder, run `npm start` and open http://localhost:3000.");
  }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error(`Livechatty expected JSON from ${url}, but got HTTP ${response.status}. This page may be hosted without its chat server. Run \`npm start\` and open the server URL.`);
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Livechatty received an invalid response from ${url} (HTTP ${response.status}). Please restart the chat server and try again.`);
  }
  if (!response.ok) throw new Error(result.error || 'Something went wrong.');
  return result;
}

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  authError.textContent = '';
  authSubmit.disabled = true;
  try {
    const form = new FormData(authForm);
    const payload = {
      username: form.get('username'),
      password: form.get('password'),
    };
    if (authMode === 'register') payload.displayName = form.get('displayName');
    const result = await api(`/api/${authMode}`, { method: 'POST', body: JSON.stringify(payload) });
    await enterChat(result.user);
  } catch (error) {
    authError.textContent = error.message;
  } finally {
    authSubmit.disabled = false;
  }
});

async function enterChat(user) {
  currentUser = user;
  document.body.classList.add('chat-active');
  authView.classList.add('hidden');
  chatView.classList.remove('hidden');
  updateProfileDisplay();
  await loadMessages();
  connectSocket();
}

function updateProfileDisplay() {
  const avatar = currentUser.avatar || defaultAvatar(currentUser.displayName);
  document.querySelector('#sidebar-avatar').src = avatar;
  document.querySelector('#header-avatar').src = avatar;
  document.querySelector('#sidebar-name').textContent = currentUser.displayName;
  document.querySelector('#sidebar-username').textContent = `@${currentUser.username}`;
}

function defaultAvatar(name) {
  const initial = Array.from(name || '?')[0].toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="100%" height="100%" rx="40" fill="#eee9ff"/><text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" fill="#7658e9" font-family="sans-serif" font-size="35" font-weight="600">${escapeXml(initial)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function escapeXml(text) {
  return text.replace(/[<>&'"]/g, (character) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  })[character]);
}

async function loadMessages() {
  const { messages } = await api('/api/messages');
  messagesElement.replaceChildren();
  renderedMessageIds.clear();
  if (!messages.length) showEmptyState();
  else messages.forEach(renderMessage);
  messagesElement.scrollTop = messagesElement.scrollHeight;
}

function showEmptyState() {
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  const icon = document.createElement('span');
  icon.className = 'empty-icon';
  icon.textContent = '✳';
  const title = document.createElement('strong');
  title.textContent = 'It’s quiet in here. Start us off!';
  const subtitle = document.createElement('p');
  subtitle.textContent = 'Your message will be seen by everyone in the room.';
  empty.append(icon, title, subtitle);
  messagesElement.replaceChildren(empty);
}

function renderMessage(message) {
  if (renderedMessageIds.has(message.id)) return;
  if (messagesElement.querySelector('.empty-state')) messagesElement.replaceChildren();
  renderedMessageIds.add(message.id);

  const row = document.createElement('article');
  row.className = 'message';
  const image = document.createElement('img');
  image.className = 'avatar';
  image.alt = '';
  image.src = message.avatar || defaultAvatar(message.displayName);
  const content = document.createElement('div');
  content.className = 'message-content';
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const name = document.createElement('span');
  name.className = 'message-name';
  name.textContent = message.displayName;
  const handle = document.createElement('span');
  handle.className = 'message-handle';
  handle.textContent = `@${message.username}`;
  if (message.bio) {
    const bio = document.createElement('span');
    bio.className = 'message-bio';
    bio.textContent = message.bio;
    meta.append(name, handle, bio);
  } else {
    meta.append(name, handle);
  }
  const time = document.createElement('time');
  time.className = 'message-time';
  time.dateTime = message.createdAt;
  time.textContent = formatTime(message.createdAt);
  const text = document.createElement('p');
  text.className = 'message-body';
  text.textContent = message.body;
  meta.append(time);
  content.append(meta, text);
  row.append(image, content);
  messagesElement.append(row);
  messagesElement.scrollTop = messagesElement.scrollHeight;
}

function formatTime(date) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(date));
}

document.querySelector('#message-form').addEventListener('submit', sendMessage);
document.querySelector('#message-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    document.querySelector('#message-form').requestSubmit();
  }
});

async function sendMessage(event) {
  event.preventDefault();
  const input = document.querySelector('#message-input');
  const text = input.value.trim();
  if (!text) return;
  const submit = document.querySelector('#message-form button[type="submit"]');
  submit.disabled = true;
  try {
    const { message } = await api('/api/messages', { method: 'POST', body: JSON.stringify({ text }) });
    renderMessage(message);
    input.value = '';
  } catch (error) {
    showToast(error.message);
  } finally {
    submit.disabled = false;
  }
}

function connectSocket() {
  if (socket) socket.close();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket.addEventListener('message', (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === 'message') renderMessage(payload.message);
    } catch {
      showToast('A live update could not be displayed.');
    }
  });
  socket.addEventListener('close', () => {
    if (currentUser) window.setTimeout(connectSocket, 2000);
  });
}

document.querySelector('#edit-profile').addEventListener('click', openProfile);
document.querySelector('#mobile-profile').addEventListener('click', openProfile);
document.querySelector('#close-profile').addEventListener('click', () => profileDialog.close());
document.querySelector('#cancel-profile').addEventListener('click', () => profileDialog.close());

function openProfile() {
  selectedAvatar = currentUser.avatar;
  document.querySelector('#profile-avatar').src = currentUser.avatar || defaultAvatar(currentUser.displayName);
  document.querySelector('#profile-display-name').value = currentUser.displayName;
  document.querySelector('#profile-bio').value = currentUser.bio || '';
  profileError.textContent = '';
  avatarFile.value = '';
  profileDialog.showModal();
}

avatarFile.addEventListener('change', () => {
  const file = avatarFile.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    profileError.textContent = 'Choose a PNG, JPEG, or WebP image smaller than 2 MB.';
    avatarFile.value = '';
    return;
  }
  const reader = new FileReader();
  reader.addEventListener('load', () => {
    selectedAvatar = reader.result;
    document.querySelector('#profile-avatar').src = selectedAvatar;
    profileError.textContent = '';
  });
  reader.addEventListener('error', () => { profileError.textContent = 'Could not read that image. Please try another.'; });
  reader.readAsDataURL(file);
});

document.querySelector('#remove-avatar').addEventListener('click', () => {
  selectedAvatar = null;
  document.querySelector('#profile-avatar').src = defaultAvatar(currentUser.displayName);
});

profileForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  profileError.textContent = '';
  const submit = profileForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const result = await api('/api/profile', {
      method: 'PATCH',
      body: JSON.stringify({
        displayName: document.querySelector('#profile-display-name').value,
        bio: document.querySelector('#profile-bio').value,
        avatar: selectedAvatar,
      }),
    });
    currentUser = result.user;
    updateProfileDisplay();
    profileDialog.close();
    showToast('Profile saved.');
    await loadMessages();
  } catch (error) {
    profileError.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

document.querySelector('#logout').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST', body: '{}' });
    currentUser = null;
    if (socket) socket.close();
    socket = null;
    document.body.classList.remove('chat-active');
    chatView.classList.add('hidden');
    authView.classList.remove('hidden');
    authForm.reset();
    showToast('You’re logged out.');
  } catch (error) {
    showToast(error.message);
  }
});

let toastTimer;
function showToast(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3000);
}

api('/api/me').then(({ user }) => {
  if (user) return enterChat(user);
}).catch((error) => {
  authError.textContent = error.message;
});
