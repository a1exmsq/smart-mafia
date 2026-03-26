'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import styles from './GameRoom.module.css';
import Link from 'next/link';
import { startRoom, advancePhase, resolveVotes, getPlayersInRoom } from '@/lib/api';

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:3002';
const GAME_URL = process.env.NEXT_PUBLIC_GAME_URL || 'http://localhost:3002';

function PhaseIcon({ phase }) {
  const map = { lobby: '🃏', night: '🌙', day: '☀️', vote: '⚖️', voting: '⚖️' };
  return <span>{map[phase] || '🃏'}</span>;
}

export default function GameRoom() {
  const router = useRouter();
  const [player, setPlayer]             = useState(null);
  const [phase, setPhase]               = useState('lobby');
  const [players, setPlayers]           = useState([]);
  const [role, setRole]                 = useState(null);
  const [roleRevealed, setRoleRevealed] = useState(false);
  const [gameStarted, setGameStarted]   = useState(false);
  const [messages, setMessages]         = useState([]);
  const [input, setInput]               = useState('');
  const [aiThinking, setAiThinking]     = useState(false);
  const [votingOpen, setVotingOpen]     = useState(false);
  const [myVote, setMyVote]             = useState(null);
  const [votes, setVotes]               = useState({});
  const [connected, setConnected]       = useState(false);
  const [copied, setCopied]             = useState(false);
  const [mounted, setMounted]           = useState(false);

  const socketRef  = useRef(null);
  const chatEndRef = useRef(null);
  const playerRef  = useRef(null);
  const pollRef    = useRef(null);

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
      setPlayers(roomPlayers.map(p => ({
        id: p.id,
        userId: p.userId,
        name: p.userId === myUserId
          ? (playerRef.current?.name || p.user?.username)
          : p.user?.username,
        avatar: '🎭',
        status: p.isAlive !== false ? 'alive' : 'eliminated',
        isYou: p.userId === myUserId,
        role: p.role,
      })));
    } catch (e) {
      console.log('refreshPlayers error:', e.message);
    }
  }, []);

  const copyCode = useCallback(() => {
    const code = playerRef.current?.code;
    if (!code) return;
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  // ── Init ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let stored;
    try {
      stored = JSON.parse(localStorage.getItem('mafia_player') || 'null');
    } catch { stored = null; }

    if (!stored?.token) { router.push('/join'); return; }

    setPlayer(stored);
    playerRef.current = stored;

    addMsg('AI Host', 'Welcome to Smart Mafia. Waiting for players to join…', 'host');

    if (stored.roomId) refreshPlayers(stored.roomId, stored.userId);

    pollRef.current = setInterval(() => {
      if (playerRef.current?.roomId) {
        refreshPlayers(playerRef.current.roomId, playerRef.current.userId);
      }
    }, 3000);

    import('socket.io-client').then(({ io }) => {
      const socket = io(`${SOCKET_URL}/game`, {
        auth: { token: stored.token },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 2000,
      });
      socketRef.current = socket;

      socket.on('connect', () => {
        setConnected(true);
        socket.emit('join_room', { roomCode: stored.code });
      });

      socket.on('disconnect', (reason) => {
        setConnected(false);
        if (reason !== 'io client disconnect') {
          addMsg('System', '🔴 Connection lost. Reconnecting…', 'system');
        }
      });

      socket.on('error', (data) => {
        const msg = data?.message || '';
        if (msg === 'Already in this room') return;
        if (msg === 'Game already started or finished') return;
        addMsg('System', `⚠ ${msg}`, 'system');
      });

      socket.on('room_joined', (data) => {
        if (data.roomId) refreshPlayers(data.roomId, stored.userId);
      });

      socket.on('player_joined', (data) => {
        addMsg('System', `${data.username} joined the room.`, 'system');
        if (stored.roomId) refreshPlayers(stored.roomId, stored.userId);
      });

      socket.on('player_left', (data) => {
        addMsg('System', `${data.username} disconnected.`, 'system');
        if (stored.roomId) refreshPlayers(stored.roomId, stored.userId);
      });

      socket.on('game_started', () => {
        setGameStarted(true);
        setPhase('night');
        clearInterval(pollRef.current);
        addMsg('System', '🎮 Game started! Check your secret role below.', 'system');
        if (stored.roomId) refreshPlayers(stored.roomId, stored.userId);
      });

      socket.on('your_role', (data) => setRole(data.role));

      socket.on('ai_narration', (data) => {
        setAiThinking(false);
        addMsg('AI Host', data.text, 'host');
      });

      socket.on('phase_changed', (data) => {
        const p = data.phase?.toLowerCase();
        setPhase(p);
        if (p === 'voting') { setVotingOpen(true); setMyVote(null); }
        else setVotingOpen(false);
        addMsg('System', `Phase: ${data.phase} — Round ${data.round}`, 'system');
      });

      socket.on('vote_cast', (data) => {
        setVotes(prev => ({ ...prev, [data.targetId]: (prev[data.targetId] || 0) + 1 }));
      });

      socket.on('player_eliminated', (data) => {
        setPlayers(prev => prev.map(p =>
          p.id === data.playerId ? { ...p, status: 'eliminated' } : p
        ));
        addMsg('System', `☠ ${data.username} was eliminated.`, 'system');
        setVotes({}); setVotingOpen(false);
      });

      socket.on('game_over', (data) => {
        addMsg('AI Host', `🏆 Game over! ${data.winner} win!`, 'host');
      });

      socket.on('chat_message', (data) => {
        if (data.userId !== playerRef.current?.userId) {
          addMsg(data.from, data.text, 'player');
        }
      });

      socket.on('ready_update', (data) => {
        addMsg('System', `${data.ready}/${data.total} players ready.`, 'system');
      });
    });

    return () => {
      clearInterval(pollRef.current);
      socketRef.current?.disconnect();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const handleStartGame = async () => {
    const p = playerRef.current;
    if (!p?.roomId) { addMsg('System', 'Error: room not found', 'system'); return; }
    try {
      await startRoom(p.roomId);
      // Init game state so phases work
      await fetch(`${GAME_URL}/game/${p.roomId}/init`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + localStorage.getItem('mafia_token'),
        },
      });
      setGameStarted(true);
      setPhase('night');
      clearInterval(pollRef.current);
      addMsg('System', '🎮 Game started! Roles have been assigned.', 'system');
      refreshPlayers(p.roomId, p.userId);
    } catch (err) {
      addMsg('System', `Could not start: ${err.message}`, 'system');
    }
  };

  const handleNextPhase = async () => {
    const p = playerRef.current;
    if (!p?.roomId) return;
    try {
      await advancePhase(p.roomId);
    } catch (err) {
      addMsg('System', `Phase error: ${err.message}`, 'system');
    }
  };

  const handleSend = () => {
    const msg = input.trim();
    if (!msg) return;
    setInput('');
    addMsg(playerRef.current?.name || 'You', msg, 'player');
    socketRef.current?.emit('send_message', { text: msg });
    setAiThinking(true);
    socketRef.current?.emit('request_ai_narration', { prompt: msg });
  };

  const handleVote = (targetId) => {
    if (myVote) return;
    setMyVote(targetId);
    setVotes(prev => ({ ...prev, [targetId]: (prev[targetId] || 0) + 1 }));
    socketRef.current?.emit('cast_vote', { voterId: playerRef.current?.userId, targetId });
    addMsg('System', 'Your vote has been cast.', 'system');
  };

  const handleEliminate = async () => {
    const p = playerRef.current;
    if (!p?.roomId) return;
    try {
      await resolveVotes(p.roomId);
    } catch (err) {
      addMsg('System', `Could not resolve votes: ${err.message}`, 'system');
    }
  };

  const handleLeaveRoom = () => {
    socketRef.current?.emit('leave_room');
    localStorage.removeItem('mafia_player');
    router.push('/');
  };

  const isHost = player?.isHost;
  const alivePlayers = players.filter(p => p.status === 'alive');

  if (!mounted) return null;

  return (
    <div className={styles.page}>
      <div className={styles.grain} />

      <header className={styles.topBar}>
        <Link href="/" className={styles.logo}>
          <span className={styles.logoIcon}>♠</span>
          <span>SMART MAFIA</span>
        </Link>

        <div className={styles.roomInfo} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className={styles.roomLabel}>Room</span>
          <span className={styles.roomCode}>{player?.code || '······'}</span>
          <button onClick={copyCode} title="Copy room code" style={{
            background: copied ? '#4ade80' : 'rgba(201,168,76,0.2)',
            border: '1px solid #C9A84C', borderRadius: '4px',
            color: copied ? '#000' : '#C9A84C', cursor: 'pointer',
            fontSize: '12px', padding: '3px 8px', transition: 'all 0.2s',
          }}>
            {copied ? '✓ Copied!' : '📋 Copy'}
          </button>
        </div>

        <div className={styles.phaseDisplay}>
          <PhaseIcon phase={phase} />
          <span className={styles.phaseText}>
            {{ lobby: 'Lobby', night: 'Night Phase', day: 'Day Phase', vote: 'Voting', voting: 'Voting' }[phase] || phase}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginRight: '16px' }}>
          <span style={{ fontSize: '12px', color: connected ? '#4ade80' : '#f87171' }}>
            {connected ? '● Live' : '● Offline'}
          </span>
          <button onClick={handleLeaveRoom} style={{
            background: 'transparent', border: '1px solid #555',
            borderRadius: '4px', color: '#888', cursor: 'pointer',
            fontSize: '12px', padding: '3px 8px',
          }}>
            ✕ Leave
          </button>
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
              <p style={{ color: '#666', fontSize: '13px', padding: '8px 0' }}>
                Waiting for players…
              </p>
            )}
            <ul className={styles.playerList}>
              {players.map(p => (
                <li key={p.id}
                  className={[
                    styles.playerItem,
                    p.status === 'eliminated' ? styles.eliminated : '',
                    p.isYou ? styles.youPlayer : '',
                    votingOpen && !myVote && p.status === 'alive' && !p.isYou ? styles.votable : '',
                  ].join(' ')}
                  onClick={() => votingOpen && !myVote && p.status === 'alive' && !p.isYou && handleVote(p.id)}
                >
                  <span className={styles.playerAvatar}>{p.avatar}</span>
                  <div className={styles.playerMeta}>
                    <span className={styles.playerName}>{p.name}{p.isYou ? ' (you)' : ''}</span>
                    <span className={styles.playerStatus}>
                      {p.status === 'eliminated' ? '☠ Eliminated'
                        : votingOpen && !myVote && !p.isYou ? '▸ Click to vote'
                        : votes[p.id] ? `${votes[p.id]} vote${votes[p.id] > 1 ? 's' : ''}`
                        : '● Alive'}
                    </span>
                  </div>
                  {myVote === p.id && <span className={styles.myVoteMark}>✓</span>}
                </li>
              ))}
            </ul>
          </div>

          {gameStarted && role && (
            <div className={styles.sideSection}>
              <h3 className={styles.sideTitle}><span>Your Role</span></h3>
              <div className={styles.roleCard}>
                {roleRevealed ? (
                  <div className={styles.roleReveal}>
                    <span className={styles.roleIcon}>
                      {{ MAFIA: '🔫', DETECTIVE: '🔍', DOCTOR: '💊', CIVILIAN: '👤' }[role] || '🎭'}
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
                    🂠 Tap to reveal your role
                  </button>
                )}
              </div>
            </div>
          )}

          {isHost && (
            <div className={styles.sideSection}>
              <h3 className={styles.sideTitle}><span>Host Controls</span></h3>
              <div className={styles.hostControls}>
                {!gameStarted ? (
                  <>
                    <p style={{ fontSize: '12px', color: '#888', marginBottom: '8px' }}>
                      {alivePlayers.length < 3
                        ? `Need ${3 - alivePlayers.length} more player(s) to start`
                        : `${alivePlayers.length} players ready — good to go!`}
                    </p>
                    <button
                      className={styles.startBtn}
                      onClick={handleStartGame}
                      disabled={alivePlayers.length < 3}
                      style={{ opacity: alivePlayers.length < 3 ? 0.5 : 1, cursor: alivePlayers.length < 3 ? 'not-allowed' : 'pointer' }}
                    >
                      ▶ Start Game
                    </button>
                  </>
                ) : (
                  <>
                    <button className={styles.nextBtn} onClick={handleNextPhase}>
                      Next Phase →
                    </button>
                    {votingOpen && Object.keys(votes).length > 0 && (
                      <button className={styles.eliminateBtn} onClick={handleEliminate}>
                        ☠ Eliminate Top Vote
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
              <p>{myVote ? 'Vote cast. Awaiting results.' : 'Click a player to cast your vote.'}</p>
            </div>
          )}

        </aside>

        <main className={styles.chatArea}>
          {votingOpen && (
            <div className={styles.voteBar}>
              <span>⚖️</span>
              <span>Voting is open — {myVote ? 'your vote is cast.' : 'select a player from the left.'}</span>
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
                <p className={styles.msgText}>{msg.text}</p>
              </div>
            ))}
            {aiThinking && (
              <div className={`${styles.message} ${styles.msg_host}`}>
                <div className={styles.msgHeader}>
                  <span className={styles.msgFrom}>AI Host</span>
                </div>
                <div className={styles.thinkingDots}><span /><span /><span /></div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div className={styles.chatInput}>
            <input
              className={styles.chatField}
              type="text"
              placeholder={aiThinking ? 'The host is speaking…' : 'Say something to the table…'}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSend()}
              disabled={aiThinking}
            />
            <button className={styles.sendBtn} onClick={handleSend} disabled={aiThinking || !input.trim()}>↑</button>
          </div>
        </main>
      </div>
    </div>
  );
}