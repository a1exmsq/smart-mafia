const AUTH_URL = process.env.NEXT_PUBLIC_AUTH_URL || 'http://localhost:3001';
const GAME_URL = process.env.NEXT_PUBLIC_GAME_URL || 'http://localhost:3002';
const AI_URL   = process.env.NEXT_PUBLIC_AI_URL   || 'http://localhost:3003';

function getToken() {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('mafia_token');
}

async function request(baseUrl, path, options = {}) {
  const token = getToken();
  const res = await fetch(`${baseUrl}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `Error ${res.status}`);
  return data;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
// Генерируем уникальное имя и email чтобы не было конфликтов
export async function registerGuest(displayName) {
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  const username = `${displayName.replace(/\s+/g, '').substring(0, 12)}${rand}`;
  const email = `guest_${username}_${Date.now()}@mafia.local`;
  const password = `P${Date.now()}x!`;

  const data = await request(AUTH_URL, '/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, email, password }),
  });

  localStorage.setItem('mafia_token', data.accessToken);
  localStorage.setItem('mafia_userId', data.userId);
  // Сохраняем displayName отдельно — показываем его в UI
  localStorage.setItem('mafia_displayName', displayName.trim());
  return { ...data, displayName: displayName.trim() };
}

// ── Rooms ─────────────────────────────────────────────────────────────────────
export async function createRoom(maxPlayers = 15) {
  return request(GAME_URL, '/rooms', {
    method: 'POST',
    body: JSON.stringify({ maxPlayers }),
  });
}

export async function startRoom(roomId) {
  return request(GAME_URL, `/rooms/${roomId}/start`, { method: 'PATCH' });
}

// ── Players ───────────────────────────────────────────────────────────────────
export async function joinRoomByCode(roomCode) {
  return request(GAME_URL, '/players/join', {
    method: 'POST',
    body: JSON.stringify({ roomCode }),
  });
}

export async function getPlayersInRoom(roomId) {
  return request(GAME_URL, `/players/room/${roomId}`);
}

// ── Game state ────────────────────────────────────────────────────────────────
export async function advancePhase(roomId) {
  return request(GAME_URL, `/game/${roomId}/advance`, { method: 'POST' });
}

export async function resolveVotes(roomId) {
  return request(GAME_URL, `/game/${roomId}/resolve-votes`, { method: 'POST' });
}

// ── AI ────────────────────────────────────────────────────────────────────────
export async function chatWithAI(message, history = [], roomId) {
  return request(AI_URL, '/ai/chat', {
    method: 'POST',
    body: JSON.stringify({ message, history, roomId }),
  });
}
