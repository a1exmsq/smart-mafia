'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { io } from 'socket.io-client';
import styles from './GameRoom.module.css';
import Link from 'next/link';
import {
  startRoom, advancePhase, resolveVotes,
  getPlayersInRoom, getGameState,
} from '@/lib/api';

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:3002';

// ── Typewriter effect for AI messages ─────────────────────────────────────────
function TypewriterText({ text, speed = 28, onDone }) {
  const [displayed, setDisplayed] = useState('');
  const idxRef = useRef(0);
  const onDoneRef = useRef(onDone);

  useEffect(() => { onDoneRef.current = onDone; });

  useEffect(() => {
    idxRef.current = 0;
    setDisplayed('');
    const interval = setInterval(() => {
      idxRef.current += 1;
      setDisplayed(text.slice(0, idxRef.current));
      if (idxRef.current >= text.length) {
        clearInterval(interval);
        onDoneRef.current?.();
      }
    }, speed);
    return () => clearInterval(interval);
  }, [text, speed]);

  return (
    <span>
      {displayed}
      {displayed.length < text.length && (
        <span style={{ animation: 'blink 0.8s step-end infinite', color: '#C9A84C' }}>▎</span>
      )}
    </span>
  );
}

const PHASE_LABELS = {
  lobby: 'Lobby', intro: 'Evening — Introductions',
  night: 'Night Phase', day: 'Day Phase',
  vote: 'Voting', voting: 'Voting', game_over: 'Game Over',
};
const PHASE_ICONS = {
  lobby: '🃏', intro: '🌆', night: '🌙', day: '☀️',
  vote: '⚖️', voting: '⚖️', game_over: '🏆',
};

function PhaseIcon({ phase }) {
  return <span>{PHASE_ICONS[phase] || '🃏'}</span>;
}
function buildVoteTotals(voteMap = {}) {
  return Object.values(voteMap).reduce((acc, t) => {
    if (!t) return acc;
    acc[t] = (acc[t] || 0) + 1;
    return acc;
  }, {});
}
// Strip the 4-char random suffix appended by registerGuest (always exactly 4 chars)
function cleanName(username) {
  if (!username) return '?';
  const cleaned = username.length > 4 ? username.slice(0, -4).trim() : username;
  return cleaned || username;
}

const PLAYER_AVATARS = ['🎭','🃏','🔫','🕵️','💊','👁️','🗡️','🎩','🦊','🐍','🌙','💀'];

const NIGHT_ACTION_FOR_ROLE = {
  MAFIA: 'mafia_kill',
  DOCTOR: 'doctor_save',
  DETECTIVE: 'detective_check',
};
const NIGHT_PROMPT = {
  MAFIA: '🔫 Choose a player to eliminate tonight',
  DOCTOR: '💊 Choose a player to save tonight',
  DETECTIVE: '🔍 Choose a player to investigate tonight',
};

export default function GameRoom() {
  const router = useRouter();
  const [player, setPlayer] = useState(null);
  const [phase, setPhase] = useState('lobby');
  const [players, setPlayers] = useState([]);
  const [role, setRole] = useState(null);
  const [roleRevealed, setRoleRevealed] = useState(false);
  const [gameStarted, setGameStarted] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [aiThinking, setAiThinking] = useState(false);
  const [votingOpen, setVotingOpen] = useState(false);
  const [myVote, setMyVote] = useState(null);
  const [votes, setVotes] = useState({});
  const [connected, setConnected] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [nightActionDone, setNightActionDone] = useState(false);
  // map of { playerId: 'MAFIA' | 'NOT MAFIA' } — shown next to player names for the detective
  const [detectiveResults, setDetectiveResults] = useState({});
  const [runoffCandidates, setRunoffCandidates] = useState(null); // player ids in runoff
  // final role reveal shown on game_over
  const [finalRoles, setFinalRoles] = useState([]);
  // nominations: { [nominatorPlayerId]: targetPlayerId }
  const [nominations, setNominations] = useState({});
  // speech timer: { playerId, secondsLeft } | null
  const [speechTimer, setSpeechTimer] = useState(null);
  // avatar map: { [userId]: emoji } — populated from socket events
  const [avatarMap, setAvatarMap] = useState({});
  // count of night_action_confirmed events received this night
  const [nightActionsReceived, setNightActionsReceived] = useState(0);
  // voice narration toggle
  const [voiceEnabled, setVoiceEnabled] = useState(true);

  const socketRef = useRef(null);
  const chatEndRef = useRef(null);
  const playerRef = useRef(null);
  const pollRef = useRef(null);
  const lastWinnerRef = useRef(null);
  const joinedRef = useRef(false);
  const timerIntervalRef = useRef(null);
  const avatarMapRef = useRef({});
  const voiceEnabledRef = useRef(true);

  useEffect(() => { setMounted(true); }, []);

  const addMsg = useCallback((from, text, type = 'host') => {
    setMessages(prev => [...prev, {
      id: Date.now() + Math.random(), from, text, type,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }]);
  }, []);

  const refreshPlayers = useCallback(async (roomId, myUserId) => {
    try {
      const roomPlayers = await getPlayersInRoom(roomId);
      const me = roomPlayers.find(p => p.userId === myUserId);
      if (me?.role) setRole(prev => prev || me.role);
      const myName = playerRef.current?.name;
      setPlayers(roomPlayers.map((p, idx) => ({
        id: p.id, userId: p.userId,
        name: p.userId === myUserId ? (myName || cleanName(p.user?.username)) : cleanName(p.user?.username),
        avatar: p.userId === myUserId ? (playerRef.current?.avatar || PLAYER_AVATARS[idx % PLAYER_AVATARS.length]) : (avatarMapRef.current[p.userId] || PLAYER_AVATARS[idx % PLAYER_AVATARS.length]),
        number: idx + 1,
        status: p.isAlive !== false ? 'alive' : 'eliminated',
        isYou: p.userId === myUserId, role: p.role,
      })));
    } catch (e) { console.log('refreshPlayers:', e.message); }
  }, []);

  const applyGameState = useCallback((state) => {
    if (!state) return;
    const nextPhase = state.phase?.toLowerCase() || 'lobby';
    const snapshot = state.snapshot || {};
    const winner = snapshot.winner || null;
    setGameStarted(nextPhase !== 'lobby');
    setPhase(nextPhase);
    setVotingOpen(nextPhase === 'voting');
    if (nextPhase === 'voting') setVotes(buildVoteTotals(snapshot.votes || {}));
    else { setVotes({}); setMyVote(null); }
    if (nextPhase === 'night') setNightActionDone(false);
    // restore final roles when reconnecting to a finished game
    if (snapshot.finalRoles?.length) setFinalRoles(snapshot.finalRoles);
    if (winner && lastWinnerRef.current !== winner) {
      lastWinnerRef.current = winner;
      addMsg('AI Host', `🏆 Game over! ${winner} win!`, 'host');
    }
  }, [addMsg]);

  const loadGameState = useCallback(async (roomId) => {
    try { applyGameState(await getGameState(roomId)); } catch {}
  }, [applyGameState]);

  const copyCode = useCallback(() => {
    const code = playerRef.current?.code;
    if (!code || !navigator?.clipboard) return;
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  useEffect(() => {
    let stored;
    try { stored = JSON.parse(localStorage.getItem('mafia_player') || 'null'); }
    catch { stored = null; }
    if (!stored?.token) { router.push('/join'); return; }
    setPlayer(stored);
    playerRef.current = stored;
    addMsg('AI Host', 'Welcome to Smart Mafia. Waiting for players to join...', 'host');
    if (stored.roomId) {
      refreshPlayers(stored.roomId, stored.userId);
      loadGameState(stored.roomId);
    }
    pollRef.current = setInterval(() => {
      const p = playerRef.current;
      if (p?.roomId) refreshPlayers(p.roomId, p.userId);
    }, 4000);

    // Static io import — prevents React 18 StrictMode from creating two sockets
    const socket = io(`${SOCKET_URL}/game`, {
      auth: { token: stored.token },
      transports: ['websocket', 'polling'],
      reconnection: true, reconnectionAttempts: 10, reconnectionDelay: 2000,
    });
    socketRef.current = socket;

    {
      socket.on('connect', () => {
        setConnected(true);
        // Always emit join_room on every connect — server is idempotent (handles reconnects)
        const myAvatar = stored.avatar || '🎭';
        avatarMapRef.current[stored.userId] = myAvatar;
        setAvatarMap(prev => ({ ...prev, [stored.userId]: myAvatar }));
        socket.emit('join_room', { roomCode: stored.code, avatar: myAvatar });
      });
      socket.on('connect_error', (err) => {
        setConnected(false);
        console.error('[Socket connect_error]', err?.message);
        addMsg('System', `⚠ Connection failed: ${err?.message || 'unknown'}`, 'system');
      });
      socket.on('disconnect', reason => {
        setConnected(false);
        if (reason !== 'io client disconnect') addMsg('System', '⚠ Connection lost. Reconnecting...', 'system');
      });
      socket.on('error', data => {
        const msg = data?.message || '';
        // Session expired — redirect to re-register
        if (msg === 'session_expired') {
          addMsg('System', '⚠ Session expired. Please rejoin via /join.', 'system');
          localStorage.removeItem('mafia_player');
          setTimeout(() => router.push('/join'), 2500);
          return;
        }
        // Room not found — DB was reset or wrong code
        if (msg.includes('not found') || msg.includes('Not found')) {
          addMsg('System', `⚠ Room not found (code: ${stored.code}). Please rejoin via /join.`, 'system');
          return;
        }
        // Player not in room — they joined with a different account
        if (msg === 'Game already started or finished') {
          addMsg('System', '⚠ Could not reconnect — game already started. Please rejoin via /join.', 'system');
          return;
        }
        if (msg === 'Already in this room') return;
        // If the server rejected a vote, allow the user to try again
        setMyVote(null);
        addMsg('System', `⚠ ${msg}`, 'system');
      });
      socket.on('room_joined', data => {
        if (data.roomId) { refreshPlayers(data.roomId, stored.userId); loadGameState(data.roomId); }
      });
      socket.on('player_joined', data => {
        if (data.avatar && data.userId) {
          avatarMapRef.current[data.userId] = data.avatar;
          setAvatarMap(prev => ({ ...prev, [data.userId]: data.avatar }));
        }
        addMsg('System', `${cleanName(data.username)} joined the room.`, 'system');
        if (stored.roomId) refreshPlayers(stored.roomId, stored.userId);
      });
      socket.on('player_left', data => {
        addMsg('System', `${cleanName(data.username)} disconnected.`, 'system');
        if (stored.roomId) refreshPlayers(stored.roomId, stored.userId);
      });
      socket.on('game_started', data => {
        setGameStarted(true);
        setDetectiveResults({});
        setFinalRoles([]);
        applyGameState(data?.gameState);
        addMsg('System', '🎮 Game started! Check your secret role below.', 'system');
        if (stored.roomId) refreshPlayers(stored.roomId, stored.userId);
      });
      socket.on('your_role', data => {
        if (data?.role) { setRole(data.role); setGameStarted(true); }
      });
      socket.on('ai_narration', data => {
        setAiThinking(false);
        if (data?.text) {
          const typingMsg = {
            id: Date.now() + Math.random(),
            from: 'AI Host',
            text: data.text,
            type: 'host',
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            typing: true,
          };
          setMessages(prev => [...prev, typingMsg]);
          speakText(data.text);
        }
      });
      socket.on('system_message', data => {
        if (data?.text) addMsg('System', data.text, 'system');
      });
      socket.on('phase_changed', data => {
        const next = data.phase?.toLowerCase();
        setPhase(next); setGameStarted(true);
        setVotingOpen(next === 'voting');
        if (next !== 'voting') { setMyVote(null); setVotes({}); }
        if (next === 'night') { setNightActionDone(false); setNominations({}); setNightActionsReceived(0); }
        if (next === 'day') { setNominations({}); setSpeechTimer(null); }
        if (next !== 'voting') setRunoffCandidates(null);
        setSpeechTimer(null);
        addMsg('System', `Phase: ${data.phase} — Round ${data.round}`, 'system');
        if (stored.roomId) refreshPlayers(stored.roomId, stored.userId);
      });
      socket.on('vote_cast', data => {
        setVotes(prev => ({ ...prev, [data.targetId]: (prev[data.targetId] || 0) + 1 }));
      });
      socket.on('player_eliminated', data => {
        setPlayers(prev => prev.map(p => p.id === data.playerId ? { ...p, status: 'eliminated' } : p));
        addMsg('System', `☠ ${cleanName(data.username)} was eliminated.`, 'system');
        if (stored.roomId) refreshPlayers(stored.roomId, stored.userId);
      });
      socket.on('game_over', data => {
        if (data?.winner && lastWinnerRef.current !== data.winner) {
          lastWinnerRef.current = data.winner;
          const winnerLabel = data.winner === 'CIVILIANS' ? 'Civilians' : 'Mafia';
          addMsg('AI Host', `🏆 Game over! ${winnerLabel} win!`, 'host');
          setPhase('game_over');
        }
        if (data?.players?.length) setFinalRoles(data.players);
      });
      socket.on('night_action_confirmed', data => {
        setNightActionDone(true);
        setNightActionsReceived(prev => prev + 1);
        addMsg('System', '✓ Your night action has been recorded.', 'system');
      });
      socket.on('detective_result', data => {
        if (data?.targetId && data?.result) {
          setDetectiveResults(prev => ({ ...prev, [data.targetId]: data.result }));
        }
        const name = data?.targetName ? cleanName(data.targetName) : 'that player';
        const icon = data?.result === 'MAFIA' ? '🔴' : '🟢';
        addMsg('System', `🔍 ${icon} ${name} — ${data?.result}`, 'system');
      });
      socket.on('mafia_vote_update', data => {
        addMsg('System', `🔫 A mafia member voted.`, 'system');
      });
      socket.on('runoff_vote', data => {
        setRunoffCandidates(data.candidateIds);
        setMyVote(null); // reset vote for runoff
        addMsg('System', `⚖️ Runoff vote started between: ${data.names}`, 'system');
      });
      socket.on('chat_message', data => {
        if (data.userId !== playerRef.current?.userId)
          addMsg(cleanName(data.from), data.text, 'player');
      });
      socket.on('ready_update', data => {
        addMsg('System', `${data.ready}/${data.total} players ready.`, 'system');
      });
      // Nomination events
      socket.on('nomination_updated', data => {
        setNominations(prev => {
          const next = { ...prev };
          if (data.targetId) next[data.nominatorId] = data.targetId;
          else delete next[data.nominatorId];
          return next;
        });
        if (data.targetId) {
          addMsg('System', `🎯 ${cleanName(data.nominatorName)} nominated a player for vote.`, 'system');
        } else {
          addMsg('System', `↩ ${cleanName(data.nominatorName)} withdrew their nomination.`, 'system');
        }
      });
      // Speech timer events
      socket.on('speech_timer_started', data => {
        setSpeechTimer({ playerId: data.playerId, secondsLeft: data.seconds });
      });
      socket.on('speech_timer_stopped', () => {
        setSpeechTimer(null);
      });
    }

    return () => { clearInterval(pollRef.current); socketRef.current?.disconnect(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  // Speech timer countdown
  useEffect(() => {
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    if (!speechTimer || speechTimer.secondsLeft <= 0) {
      if (speechTimer?.secondsLeft === 0) {
        addMsg('System', "⏰ Time's up!", 'system');
        setSpeechTimer(null);
      }
      return;
    }
    timerIntervalRef.current = setInterval(() => {
      setSpeechTimer(prev => {
        if (!prev) return null;
        if (prev.secondsLeft <= 1) return { ...prev, secondsLeft: 0 };
        return { ...prev, secondsLeft: prev.secondsLeft - 1 };
      });
    }, 1000);
    return () => clearInterval(timerIntervalRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speechTimer?.playerId, speechTimer?.secondsLeft === 0]);

  const handleStartGame = async () => {
    const p = playerRef.current;
    if (!p?.roomId) return;
    try {
      const session = await startRoom(p.roomId);
      setGameStarted(true);
      applyGameState(session.gameState);
      addMsg('System', '🎮 Game started! Roles have been assigned.', 'system');
      refreshPlayers(p.roomId, p.userId);
    } catch (e) { addMsg('System', `Could not start: ${e.message}`, 'system'); }
  };

  const handleNextPhase = async (force = false) => {
    const p = playerRef.current;
    if (!p?.roomId) return;
    try { await advancePhase(p.roomId); }
    catch (e) { addMsg('System', `Phase error: ${e.message}`, 'system'); }
  };

  const handleRevertPhase = async () => {
    const p = playerRef.current;
    if (!p?.roomId) return;
    if (!window.confirm('Go back to the previous phase? This cannot be undone automatically.')) return;
    try {
      // re-use advancePhase with a revert flag — backend must support it,
      // otherwise this simply re-advances (shows error)
      await advancePhase(p.roomId, { revert: true });
    } catch (e) {
      // fallback: just show a message; revert requires backend support
      addMsg('System', `Cannot revert: ${e.message}`, 'system');
    }
  };

  const handleSend = () => {
    const msg = input.trim();
    if (!msg) return;
    setInput('');
    if (!socketRef.current?.connected) {
      addMsg('System', '⚠ No connection.', 'system');
      return;
    }
    // Show own message locally (server echoes to others only)
    addMsg(playerRef.current?.name || 'You', msg, 'player');
    socketRef.current.emit('send_message', { text: msg });
  };

  const speakText = useCallback((text) => {
    if (!voiceEnabledRef.current) return;
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel(); // stop any current speech
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = 'en-US';
    utt.rate = 0.92;
    utt.pitch = 0.85;
    utt.volume = 1;
    // prefer a deep/dramatic voice if available
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(v =>
      v.lang.startsWith('en') && /male|david|george|daniel|alex/i.test(v.name)
    ) || voices.find(v => v.lang.startsWith('en'));
    if (preferred) utt.voice = preferred;
    window.speechSynthesis.speak(utt);
  }, []);

  const toggleVoice = () => {
    const next = !voiceEnabledRef.current;
    voiceEnabledRef.current = next;
    setVoiceEnabled(next);
    if (!next) window.speechSynthesis?.cancel();
  };

  const handleAskAI = () => {
    const msg = input.trim();
    if (!msg || !socketRef.current?.connected) return;
    setInput('');
    setAiThinking(true);
    socketRef.current.emit('request_ai_narration', { prompt: msg });
  };

  // Nomination — nominate or toggle (withdraw if already nominated same player)
  const handleNominate = (targetId) => {
    if (!socketRef.current?.connected) { addMsg('System', '⚠ No connection.', 'system'); return; }
    const me = players.find(p => p.isYou);
    if (!me || me.status !== 'alive') return;
    // If already nominated this same target — withdraw
    const alreadyNominated = nominations[me.id] === targetId;
    socketRef.current.emit('nominate', { targetId: alreadyNominated ? null : targetId });
  };

  // Timer controls (host only)
  const handleStartTimer = (playerId, seconds = 60) => {
    if (!socketRef.current?.connected) return;
    socketRef.current.emit('start_speech_timer', { playerId, seconds });
  };
  const handleStopTimer = () => {
    if (!socketRef.current?.connected) return;
    socketRef.current.emit('start_speech_timer', { playerId: '', stop: true });
  };

  const handleVote = (targetId) => {
    // Send vote over socket — server uses c.roomId (reliable) not localStorage roomId
    if (myVote) { addMsg('System', '⚠ You have already voted.', 'system'); return; }
    if (!socketRef.current?.connected) {
      addMsg('System', '⚠ Not connected — reconnecting...', 'system');
      return;
    }
    setMyVote(targetId); // optimistic lock to prevent double-click
    socketRef.current.emit('cast_vote', { targetId });
    addMsg('System', 'Your vote has been cast.', 'system');
  };

  const handleNightAction = (targetId) => {
    if (nightActionDone) { addMsg('System', '⚠ You have already acted tonight.', 'system'); return; }
    if (!role) { addMsg('System', '⚠ Role not yet assigned.', 'system'); return; }
    const action = NIGHT_ACTION_FOR_ROLE[role];
    if (!action) { addMsg('System', '⚠ Your role has no night action.', 'system'); return; }
    if (!socketRef.current?.connected) {
      addMsg('System', '⚠ Not connected — reconnecting...', 'system');
      return;
    }
    // nightActionDone will be set when server sends night_action_confirmed
    socketRef.current.emit('night_action', { action, targetId });
    addMsg('System', '⏳ Submitting your night action...', 'system');
  };

  const handleEliminate = async () => {
    const p = playerRef.current;
    if (!p?.roomId) return;
    try { await resolveVotes(p.roomId); }
    catch (e) { addMsg('System', `Could not resolve: ${e.message}`, 'system'); }
  };

  const handleLeaveRoom = () => {
    socketRef.current?.emit('leave_room');
    localStorage.removeItem('mafia_player');
    router.push('/');
  };

  const isHost = player?.isHost;
  const alivePlayers = players.filter(p => p.status === 'alive');
  const isNight = phase === 'night';
  const me = players.find(p => p.isYou);
  // before the player list is loaded treat as alive so the UI doesn't flicker
  const iAmAlive = me ? me.status === 'alive' : true;
  const hasNightAction = isNight && iAmAlive && role && NIGHT_ACTION_FOR_ROLE[role] && !nightActionDone;
  const nightClickable = hasNightAction;
  const isDay = phase === 'day';
  // Nominated player IDs (unique targets from nominations map)
  const nominatedIds = [...new Set(Object.values(nominations))];
  // My player record
  const myPlayerId = players.find(p => p.isYou)?.id;
  // My current nomination target
  const myNomination = myPlayerId ? nominations[myPlayerId] : null;
  // Active timer player info
  const timerPlayer = speechTimer ? players.find(p => p.id === speechTimer.playerId) : null;

  if (!mounted) return null;

  return (
    <div className={styles.page}>
      <div className={styles.grain} />
      <header className={styles.topBar}>
        <Link href="/" className={styles.logo}>
          <span className={styles.logoIcon}>♠</span><span>SMART MAFIA</span>
        </Link>
        <div className={styles.roomInfo} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className={styles.roomLabel}>Room</span>
          <span className={styles.roomCode}>{player?.code || '......'}</span>
          <button onClick={copyCode} style={{
            background: copied ? '#4ade80' : 'rgba(201,168,76,0.2)', border: '1px solid #C9A84C',
            borderRadius: '4px', color: copied ? '#000' : '#C9A84C', cursor: 'pointer',
            fontSize: '12px', padding: '3px 8px', transition: 'all 0.2s',
          }}>{copied ? '✓ Copied' : '📋 Copy'}</button>
        </div>
        <div className={styles.phaseDisplay}>
          <PhaseIcon phase={phase} />
          <span className={styles.phaseText}>{PHASE_LABELS[phase] || phase}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginRight: '16px' }}>
          <span style={{ fontSize: '12px', color: connected ? '#4ade80' : '#f87171', fontWeight: connected ? 'normal' : 'bold' }}>
            {connected ? '● Live' : '● Offline'}
          </span>
          {!connected && (
            <button onClick={() => {
              if (socketRef.current) socketRef.current.connect();
            }} style={{
              background: '#7c3aed', border: 'none', borderRadius: '4px',
              color: '#fff', cursor: 'pointer', fontSize: '11px', padding: '3px 8px',
            }}>↺ Reconnect</button>
          )}
          <button onClick={handleLeaveRoom} style={{
            background: 'transparent', border: '1px solid #555', borderRadius: '4px',
            color: '#888', cursor: 'pointer', fontSize: '12px', padding: '3px 8px',
          }}>Leave</button>
        </div>
      </header>

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <div className={styles.sideSection}>
            <h3 className={styles.sideTitle}>
              <span>Players</span>
              <span className={styles.sideCount}>{alivePlayers.length} alive</span>
            </h3>
            {players.length === 0 && (
              <p style={{ color: '#666', fontSize: '13px', padding: '8px 0' }}>Waiting for players...</p>
            )}
            <ul className={styles.playerList}>
              {players.map(item => {
                // During voting: only nominated players can be voted on (if any nominations exist)
                const votingTargetOk = runoffCandidates
                  ? runoffCandidates.includes(item.id)
                  : (nominatedIds.length === 0 || nominatedIds.includes(item.id));
                const canVoteDay = votingOpen && !myVote && iAmAlive && item.status === 'alive' && !item.isYou && votingTargetOk;
                // During DAY: alive players can nominate others (not themselves)
                const canNominate = isDay && iAmAlive && item.status === 'alive' && !item.isYou;
                // Doctor can heal self, Mafia can target self — only Detective can't check self (useless)
                const selfOk = role === 'DOCTOR' || role === 'MAFIA';
                const canActNight = nightClickable && item.status === 'alive' && (!item.isYou || selfOk);
                const isNominated = nominatedIds.includes(item.id);
                const iMNominatedThis = myNomination === item.id;
                return (
                  <li key={item.id}
                    className={[
                      styles.playerItem,
                      item.status === 'eliminated' ? styles.eliminated : '',
                      item.isYou ? styles.youPlayer : '',
                      (canVoteDay || canActNight) ? styles.votable : '',
                      isNominated && !item.isYou ? styles.nominated : '',
                    ].join(' ')}
                    onClick={() => {
                      if (canVoteDay) handleVote(item.id);
                      else if (canActNight) handleNightAction(item.id);
                    }}
                    style={
                      speechTimer?.playerId === item.id
                        ? { border: '2px solid #f59e0b', boxShadow: '0 0 12px #f59e0b66' }
                        : item.isYou
                          ? { borderLeft: '3px solid #C9A84C', background: 'rgba(201,146,42,0.07)' }
                          : {}
                    }
                  >
                    <span style={{
                      fontSize: '18px', fontWeight: 'bold', color: '#C9A84C',
                      minWidth: '22px', textAlign: 'center', marginRight: '4px',
                    }}>{item.number}</span>
                    <span className={styles.playerAvatar}>{item.avatar}</span>
                    <div className={styles.playerMeta} style={{ flex: 1 }}>
                      <span className={styles.playerName}>
                        {item.name}
                        {item.isYou && <span style={{
                          display: 'inline-block', marginLeft: '6px', fontSize: '9px',
                          fontWeight: '800', letterSpacing: '0.1em',
                          background: '#C9A84C', color: '#000',
                          borderRadius: '3px', padding: '1px 5px', verticalAlign: 'middle',
                        }}>YOU</span>}
                        {isNominated && <span style={{ marginLeft: '5px', fontSize: '11px', color: '#f87171' }}>🎯</span>}
                        {role === 'DETECTIVE' && !item.isYou && detectiveResults[item.id] && (
                          <span style={{
                            marginLeft: '6px', fontSize: '11px', fontWeight: 'bold',
                            color: detectiveResults[item.id] === 'MAFIA' ? '#f87171' : '#4ade80',
                          }}>
                            [{detectiveResults[item.id]}]
                          </span>
                        )}
                      </span>
                      <span className={styles.playerStatus}>
                        {item.status === 'eliminated' ? '☠ Eliminated'
                          : canVoteDay ? (isNominated ? '⚖️ Click to vote' : 'Click to vote')
                          : canActNight ? 'Click to act'
                          : votes[item.id] ? `${votes[item.id]} vote(s)`
                          : '● Alive'}
                      </span>
                    </div>
                    {myVote === item.id && <span className={styles.myVoteMark}>✓</span>}
                    {/* Nominate button — shown during DAY for alive others */}
                    {canNominate && (
                      <button
                        onClick={e => { e.stopPropagation(); handleNominate(item.id); }}
                        title={iMNominatedThis ? 'Withdraw nomination' : 'Nominate for vote'}
                        style={{
                          background: iMNominatedThis ? '#7f1d1d' : 'rgba(239,68,68,0.15)',
                          border: `1px solid ${iMNominatedThis ? '#ef4444' : '#666'}`,
                          borderRadius: '4px', color: iMNominatedThis ? '#fca5a5' : '#aaa',
                          cursor: 'pointer', fontSize: '10px', padding: '2px 6px',
                          marginLeft: '6px', whiteSpace: 'nowrap',
                        }}
                      >
                        {iMNominatedThis ? '✕ Remove' : '🎯'}
                      </button>
                    )}
                    {/* Host timer button */}
                    {isHost && gameStarted && item.status === 'alive' && !isNight && phase !== 'voting' && (
                      <button
                        onClick={e => { e.stopPropagation(); handleStartTimer(item.id, 60); }}
                        title="Start speech timer (60s)"
                        style={{
                          background: 'rgba(245,158,11,0.15)', border: '1px solid #666',
                          borderRadius: '4px', color: '#aaa', cursor: 'pointer',
                          fontSize: '10px', padding: '2px 6px', marginLeft: '4px',
                        }}
                      >⏱</button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          {role && (
            <div className={styles.sideSection}>
              <h3 className={styles.sideTitle}><span>Your Role</span></h3>
              <div className={styles.roleCard}>
                {roleRevealed ? (
                  <div className={styles.roleReveal}>
                    <span className={styles.roleIcon}>
                      {{ MAFIA: '🔫', DETECTIVE: '🔎', DOCTOR: '💊', CIVILIAN: '👤' }[role] || '🎭'}
                    </span>
                    <span className={styles.roleName}>{role}</span>
                    <span className={styles.roleDesc}>
                      {{ MAFIA: 'Eliminate civilians at night.',
                         DETECTIVE: 'Investigate one player each night.',
                         DOCTOR: 'Save one player each night.',
                         CIVILIAN: 'Find and vote out the Mafia.' }[role] || ''}
                    </span>
                  </div>
                ) : (
                  <button className={styles.revealBtn} onClick={() => setRoleRevealed(true)}>
                    Tap to reveal your role
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Night action panel */}
          {isNight && iAmAlive && role && NIGHT_ACTION_FOR_ROLE[role] && (
            <div className={styles.sideSection}>
              <h3 className={styles.sideTitle}><span>Night Action</span></h3>
              {nightActionDone ? (
                <p style={{ color: '#4ade80', fontSize: '13px', padding: '8px 0' }}>
                  ✓ Action submitted. Waiting for others...
                </p>
              ) : (
                <p style={{ color: '#C9A84C', fontSize: '13px', padding: '8px 0' }}>
                  {NIGHT_PROMPT[role]}
                </p>
              )}
              {role === 'DETECTIVE' && Object.keys(detectiveResults).length > 0 && (
                <p style={{ color: '#aaa', fontSize: '12px', marginTop: '8px' }}>
                  Results shown next to each player's name.
                </p>
              )}
            </div>
          )}

          {isHost && (
            <div className={styles.sideSection}>
              <h3 className={styles.sideTitle}><span>Host Controls</span></h3>
              <div className={styles.hostControls}>
                {!gameStarted ? (
                  <>
                    <p style={{ fontSize: '12px', color: '#888', marginBottom: '8px' }}>
                      {alivePlayers.length < 4
                        ? `Need ${4 - alivePlayers.length} more player(s) to start`
                        : `${alivePlayers.length} players ready — good to go!`}
                    </p>
                    <button className={styles.startBtn} onClick={handleStartGame}
                      disabled={alivePlayers.length < 4}
                      style={{ opacity: alivePlayers.length < 4 ? 0.5 : 1, cursor: alivePlayers.length < 4 ? 'not-allowed' : 'pointer' }}>
                      ▶ Start Game
                    </button>
                  </>
                ) : (
                  <>
                    {phase === 'intro' && (
                      <p style={{ fontSize: '12px', color: '#888', marginBottom: '8px' }}>
                        Let players introduce themselves, then advance to night.
                      </p>
                    )}
                    {phase === 'night' && (
                      <div style={{ marginBottom: '8px', padding: '8px', background: 'rgba(99,102,241,0.08)', borderRadius: '6px', border: '1px solid rgba(99,102,241,0.25)' }}>
                        <p style={{ fontSize: '12px', color: '#a5b4fc', margin: '0 0 4px 0' }}>
                          🌙 Night actions received: <strong>{nightActionsReceived}</strong>
                        </p>
                        <p style={{ fontSize: '11px', color: '#666', margin: 0 }}>
                          {nightActionsReceived === 0 ? 'Waiting — no one has acted yet.' : 'Advance when all roles have acted.'}
                        </p>
                      </div>
                    )}
                    {isDay && nominatedIds.length > 0 && (
                      <div style={{ marginBottom: '8px', padding: '8px', background: 'rgba(239,68,68,0.1)', borderRadius: '6px', border: '1px solid #7f1d1d' }}>
                        <p style={{ fontSize: '11px', color: '#fca5a5', margin: '0 0 4px 0' }}>
                          🎯 Nominated: {nominatedIds.length} player(s)
                        </p>
                        <button style={{
                          width: '100%', background: 'rgba(239,68,68,0.25)', border: '1px solid #ef4444',
                          borderRadius: '5px', color: '#fca5a5', cursor: 'pointer',
                          fontSize: '12px', padding: '5px 8px',
                        }} onClick={() => handleNextPhase()}>
                          ⚖️ Proceed to Vote →
                        </button>
                      </div>
                    )}
                    <button className={styles.nextBtn} onClick={() => handleNextPhase()}>
                      Next Phase →
                    </button>
                    {votingOpen && Object.keys(votes).length > 0 && (
                      <button className={styles.eliminateBtn} onClick={handleEliminate}
                        style={{ marginTop: '8px' }}>
                        ☠ Resolve Votes
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {votingOpen && !isHost && (
            <div className={styles.voteBanner}>
              <span className={styles.voteBannerIcon}>⚖️</span>
              <p>{myVote ? 'Your vote is in. Waiting for results.' : 'Click a player in the list to cast your vote.'}</p>
            </div>
          )}
        </aside>

        <main className={styles.chatArea}>
          {phase === 'intro' && (
            <div className={styles.voteBar} style={{ borderColor: '#C9A84C' }}>
              <span>🌆</span>
              <span>Evening introductions — tell the city who you are before night falls.</span>
            </div>
          )}
          {isNight && (
            <div className={styles.voteBar} style={{ borderColor: '#6366f1' }}>
              <span>🌙</span>
              <span>
                {!iAmAlive
                  ? 'You have been eliminated — observe the rest of the game.'
                  : role && NIGHT_ACTION_FOR_ROLE[role]
                    ? (nightActionDone ? 'Action submitted. Waiting for others...' : NIGHT_PROMPT[role])
                    : 'The city sleeps... Special roles are acting.'}
              </span>
            </div>
          )}
          {isDay && (
            <div className={styles.voteBar} style={{ borderColor: '#f59e0b' }}>
              <span>☀️</span>
              <span>
                {nominatedIds.length === 0
                  ? 'Discussion — nominate a suspect by pressing 🎯 next to a player.'
                  : `${nominatedIds.length} player(s) nominated. Host will proceed to vote.`}
              </span>
            </div>
          )}
          {votingOpen && (
            <div className={styles.voteBar}>
              <span>⚖️</span>
              <span>
                {nominatedIds.length > 0
                  ? `Vote for nominated player(s) (${nominatedIds.length}) — ${myVote ? 'your vote is in.' : 'click a player on the left.'}`
                  : `Voting is open — ${myVote ? 'your vote is in.' : 'click a player to vote.'}`}
              </span>
            </div>
          )}

          {/* ── Speech timer overlay ──────────────────────────────────────── */}
          {speechTimer && speechTimer.secondsLeft > 0 && (
            <div style={{
              background: 'rgba(10,5,2,0.97)', border: '2px solid #f59e0b',
              borderRadius: '12px', padding: '16px 20px', marginBottom: '12px',
              display: 'flex', alignItems: 'center', gap: '16px',
            }}>
              {/* Circular countdown */}
              <div style={{ position: 'relative', width: '72px', height: '72px', flexShrink: 0 }}>
                <svg width="72" height="72" style={{ transform: 'rotate(-90deg)' }}>
                  <circle cx="36" cy="36" r="30" fill="none" stroke="#333" strokeWidth="5" />
                  <circle cx="36" cy="36" r="30" fill="none" stroke="#f59e0b" strokeWidth="5"
                    strokeDasharray={`${2 * Math.PI * 30}`}
                    strokeDashoffset={`${2 * Math.PI * 30 * (1 - speechTimer.secondsLeft / (speechTimer.initialSeconds || 60))}`}
                    strokeLinecap="round"
                    style={{ transition: 'stroke-dashoffset 0.8s linear' }}
                  />
                </svg>
                <span style={{
                  position: 'absolute', top: '50%', left: '50%',
                  transform: 'translate(-50%,-50%)',
                  fontSize: '22px', fontWeight: 'bold',
                  color: speechTimer.secondsLeft <= 10 ? '#ef4444' : '#f59e0b',
                }}>{speechTimer.secondsLeft}</span>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ color: '#f59e0b', fontSize: '13px', fontWeight: '600', marginBottom: '3px' }}>
                  🎤 Now speaking:
                </div>
                <div style={{ color: '#e5e7eb', fontSize: '18px', fontWeight: 'bold' }}>
                  {timerPlayer ? `#${timerPlayer.number} — ${timerPlayer.name}` : '...'}
                </div>
              </div>
              {isHost && (
                <button onClick={handleStopTimer} style={{
                  background: 'rgba(239,68,68,0.2)', border: '1px solid #ef4444',
                  borderRadius: '6px', color: '#f87171', cursor: 'pointer',
                  fontSize: '12px', padding: '6px 10px',
                }}>⏹ Stop</button>
              )}
            </div>
          )}

          {/* ── Final role reveal ─────────────────────────────────────────── */}
          {phase === 'game_over' && finalRoles.length > 0 && (
            <div style={{
              background: 'linear-gradient(135deg, rgba(20,10,5,0.95) 0%, rgba(30,18,8,0.95) 100%)',
              border: '1px solid #C9A84C',
              borderRadius: '10px',
              padding: '20px',
              marginBottom: '14px',
            }}>
              <h3 style={{
                color: '#C9A84C', margin: '0 0 4px 0',
                textAlign: 'center', fontSize: '17px', letterSpacing: '0.05em',
              }}>
                🃏 The city reveals its secrets
              </h3>
              <p style={{ color: '#888', fontSize: '12px', textAlign: 'center', margin: '0 0 14px 0' }}>
                Final roles of all players
              </p>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                gap: '10px',
              }}>
                {finalRoles.map(p => {
                  const roleIcon = { MAFIA: '🔫', DETECTIVE: '🔎', DOCTOR: '💊', CIVILIAN: '👤' }[p.role] || '🎭';
                  const roleColor = p.role === 'MAFIA' ? '#f87171'
                    : p.role === 'DETECTIVE' ? '#818cf8'
                    : p.role === 'DOCTOR' ? '#4ade80'
                    : '#9ca3af';
                  return (
                    <div key={p.id} style={{
                      background: 'rgba(255,255,255,0.04)',
                      border: `1px solid ${p.isAlive ? roleColor + '55' : '#333'}`,
                      borderRadius: '8px',
                      padding: '10px 8px',
                      textAlign: 'center',
                      opacity: p.isAlive ? 1 : 0.55,
                      transition: 'opacity 0.2s',
                    }}>
                      <div style={{ fontSize: '26px', lineHeight: 1 }}>{roleIcon}</div>
                      <div style={{
                        color: '#e5e7eb', fontSize: '12px', fontWeight: '600',
                        marginTop: '6px', wordBreak: 'break-word',
                      }}>
                        {cleanName(p.username)}
                      </div>
                      <div style={{ color: roleColor, fontSize: '10px', marginTop: '3px', fontWeight: '500' }}>
                        {p.role}
                      </div>
                      {!p.isAlive && (
                        <div style={{ color: '#6b7280', fontSize: '10px', marginTop: '2px' }}>☠ eliminated</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className={styles.chatMessages}>
            {messages.map(msg => (
              <div key={msg.id} className={`${styles.message} ${styles['msg_' + msg.type]}`}>
                {msg.type !== 'system' && (
                  <div className={styles.msgHeader}>
                    <span className={styles.msgFrom}>{msg.from}</span>
                    <span className={styles.msgTime}>{msg.time}</span>
                  </div>
                )}
                <p className={styles.msgText}>
                  {msg.typing ? (
                    <TypewriterText
                      text={msg.text}
                      speed={18}
                      onDone={() => setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, typing: false } : m))}
                    />
                  ) : msg.text}
                </p>
              </div>
            ))}
            {aiThinking && (
              <div className={`${styles.message} ${styles.msg_host}`}>
                <div className={styles.msgHeader}><span className={styles.msgFrom}>AI Host</span></div>
                <div className={styles.thinkingDots}><span /><span /><span /></div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div className={styles.chatInput}>
            <button
              onClick={toggleVoice}
              title={voiceEnabled ? 'Voice ON — click to mute' : 'Voice OFF — click to enable'}
              style={{
                background: voiceEnabled ? 'rgba(201,146,42,0.15)' : 'rgba(80,80,80,0.15)',
                border: `1px solid ${voiceEnabled ? '#C9A84C' : '#444'}`,
                borderRadius: '6px', color: voiceEnabled ? '#C9A84C' : '#555',
                cursor: 'pointer', fontSize: '16px', padding: '6px 10px',
                flexShrink: 0,
              }}
            >{voiceEnabled ? '🔊' : '🔇'}</button>
            <input className={styles.chatField} type="text"
              placeholder={aiThinking ? 'AI is thinking...' : 'Message everyone...'}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSend()}
              disabled={aiThinking}
            />
            <button className={styles.sendBtn} onClick={handleSend}
              disabled={!input.trim()} title="Send message">↑</button>
            {isHost && (
              <button onClick={handleAskAI}
                disabled={aiThinking || !input.trim()}
                title="Ask AI host"
                style={{
                  background: aiThinking ? '#333' : 'rgba(124,58,237,0.7)',
                  border: '1px solid #7c3aed', borderRadius: '6px',
                  color: '#fff', cursor: 'pointer', fontSize: '16px',
                  padding: '6px 10px', marginLeft: '6px',
                }}>🤖</button>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}