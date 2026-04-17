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
  localStorage.setItem('mafia_displayName', displayName.trim());
  return { ...data, displayName: displayName.trim() };
}

export async function createRoom(maxPlayers = 15) {
  return request(GAME_URL, '/rooms', { method: 'POST', body: JSON.stringify({ maxPlayers }) });
}

export async function startRoom(roomId) {
  const session = await request(GAME_URL, `/rooms/${roomId}/start`, { method: 'PATCH' });
  if (!session.gameState) {
    // Server returned room but no game state — try to fetch/init it. Surface errors clearly.
    try {
      const gameState = await request(GAME_URL, `/game/${roomId}/state`);
      return { ...session, gameState };
    } catch (e1) {
      const gameState = await request(GAME_URL, `/game/${roomId}/init`, { method: 'POST' });
      return { ...session, gameState };
    }
  }
  return session;
}

export async function joinRoomByCode(roomCode) {
  return request(GAME_URL, '/players/join', { method: 'POST', body: JSON.stringify({ roomCode }) });
}

export async function getPlayersInRoom(roomId) {
  return request(GAME_URL, `/players/room/${roomId}`);
}

export async function getGameState(roomId) {
  return request(GAME_URL, `/game/${roomId}/state`);
}

export async function advancePhase(roomId) {
  return request(GAME_URL, `/game/${roomId}/advance`, { method: 'POST' });
}

export async function resolveVotes(roomId) {
  return request(GAME_URL, `/game/${roomId}/resolve-votes`, { method: 'POST' });
}

export async function castVote(roomId, targetId) {
  return request(GAME_URL, `/game/${roomId}/vote`, {
    method: 'POST', body: JSON.stringify({ targetId }),
  });
}

export async function submitNightAction(roomId, action, targetId) {
  return request(GAME_URL, `/game/${roomId}/night-action`, {
    method: 'POST', body: JSON.stringify({ action, targetId }),
  });
}

export async function chatWithAI(message, history = [], roomId) {
  return request(AI_URL, '/ai/chat', {
    method: 'POST', body: JSON.stringify({ message, history, roomId }),
  });
}
