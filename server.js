const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const rooms = new Map();

function makeDeck() {
  const deck = [];
  for (let i = 0; i <= 6; i++) {
    for (let j = i; j <= 6; j++) deck.push([i, j]);
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function ends(chain) {
  if (!chain.length) return [null, null];
  return [chain[0][0], chain[chain.length - 1][1]];
}

function canPlay(tile, chain) {
  if (!chain.length) return true;
  const [l, r] = ends(chain);
  return tile[0] === l || tile[1] === l || tile[0] === r || tile[1] === r;
}

function placeTile(tile, chain) {
  if (!chain.length) {
    chain.push(tile);
    return true;
  }
  const [l, r] = ends(chain);
  const [a, b] = tile;

  if (a === r) chain.push([a, b]);
  else if (b === r) chain.push([b, a]);
  else if (b === l) chain.unshift([a, b]);
  else if (a === l) chain.unshift([b, a]);
  else return false;

  return true;
}

function createRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = "";
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function publicState(room, socketId) {
  const meIndex = room.players.findIndex(p => p.id === socketId);
  const otherIndex = meIndex === 0 ? 1 : 0;
  const me = room.players[meIndex];
  const other = room.players[otherIndex];

  return {
    code: room.code,
    started: room.started,
    gameOver: room.gameOver,
    chain: room.chain,
    deckCount: room.deck.length,
    turn: room.turn,
    myIndex: meIndex,
    myHand: me ? me.hand : [],
    myName: me ? me.name : "",
    opponentName: other ? other.name : "Esperando rival...",
    opponentCount: other ? other.hand.length : 0,
    status: room.status,
    winner: room.winner
  };
}

function emitRoom(room) {
  for (const p of room.players) {
    io.to(p.id).emit("state", publicState(room, p.id));
  }
}

function startGame(room) {
  const deck = makeDeck();
  room.players[0].hand = deck.splice(0, 7);
  room.players[1].hand = deck.splice(0, 7);
  room.deck = deck;
  room.chain = [];
  room.turn = 0;
  room.started = true;
  room.gameOver = false;
  room.winner = null;
  room.status = `${room.players[0].name} comienza.`;
  emitRoom(room);
}

function finishGame(room, winnerIndex, reason) {
  room.gameOver = true;
  room.winner = winnerIndex;
  room.status = winnerIndex === null
    ? `Empate. ${reason}`
    : `${room.players[winnerIndex].name} ganó. ${reason}`;
  emitRoom(room);
}

function checkBlocked(room) {
  if (room.deck.length > 0) return false;
  const p0Can = room.players[0].hand.some(t => canPlay(t, room.chain));
  const p1Can = room.players[1].hand.some(t => canPlay(t, room.chain));
  if (p0Can || p1Can) return false;

  const s0 = room.players[0].hand.reduce((s,t) => s + t[0] + t[1], 0);
  const s1 = room.players[1].hand.reduce((s,t) => s + t[0] + t[1], 0);

  if (s0 < s1) finishGame(room, 0, "Partida cerrada por bloqueo.");
  else if (s1 < s0) finishGame(room, 1, "Partida cerrada por bloqueo.");
  else finishGame(room, null, "Partida cerrada por bloqueo.");
  return true;
}

io.on("connection", socket => {
  socket.on("createRoom", ({name}) => {
    const code = createRoomCode();
    const room = {
      code,
      players: [{ id: socket.id, name: (name || "Jugador 1").slice(0, 20), hand: [] }],
      deck: [],
      chain: [],
      turn: 0,
      started: false,
      gameOver: false,
      winner: null,
      status: "Sala creada. Comparte el código con tu rival."
    };
    rooms.set(code, room);
    socket.join(code);
    emitRoom(room);
  });

  socket.on("joinRoom", ({code, name}) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return socket.emit("errorMessage", "La sala no existe.");
    if (room.players.length >= 2) return socket.emit("errorMessage", "La sala ya está llena.");
    room.players.push({ id: socket.id, name: (name || "Jugador 2").slice(0, 20), hand: [] });
    socket.join(code);
    startGame(room);
  });

  socket.on("playTile", ({code, tileIndex}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || !room.started || room.gameOver) return;

    const pIndex = room.players.findIndex(p => p.id === socket.id);
    if (pIndex === -1 || room.turn !== pIndex) return;

    const player = room.players[pIndex];
    const idx = Number(tileIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= player.hand.length) return;

    const tile = player.hand[idx];
    if (!canPlay(tile, room.chain)) {
      return socket.emit("errorMessage", "Esa ficha no se puede jugar.");
    }

    placeTile(tile, room.chain);
    player.hand.splice(idx, 1);

    if (player.hand.length === 0) {
      finishGame(room, pIndex, "Se quedó sin fichas.");
      return;
    }

    room.turn = pIndex === 0 ? 1 : 0;
    room.status = `Turno de ${room.players[room.turn].name}.`;
    checkBlocked(room);
    if (!room.gameOver) emitRoom(room);
  });

  socket.on("drawTile", ({code}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || !room.started || room.gameOver) return;

    const pIndex = room.players.findIndex(p => p.id === socket.id);
    if (pIndex === -1 || room.turn !== pIndex) return;

    const player = room.players[pIndex];
    if (player.hand.some(t => canPlay(t, room.chain))) {
      return socket.emit("errorMessage", "Tienes una ficha que puedes jugar.");
    }

    if (room.deck.length === 0) {
      return socket.emit("errorMessage", "No quedan fichas para robar.");
    }

    player.hand.push(room.deck.pop());
    room.status = `${player.name} robó una ficha.`;
    emitRoom(room);
  });

  socket.on("passTurn", ({code}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || !room.started || room.gameOver) return;

    const pIndex = room.players.findIndex(p => p.id === socket.id);
    if (pIndex === -1 || room.turn !== pIndex) return;

    const player = room.players[pIndex];
    if (player.hand.some(t => canPlay(t, room.chain))) {
      return socket.emit("errorMessage", "No puedes pasar: tienes una ficha jugable.");
    }
    if (room.deck.length > 0) {
      return socket.emit("errorMessage", "Primero debes robar mientras queden fichas.");
    }

    room.turn = pIndex === 0 ? 1 : 0;
    room.status = `${player.name} pasó. Turno de ${room.players[room.turn].name}.`;
    if (!checkBlocked(room)) emitRoom(room);
  });

  socket.on("restartGame", ({code}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || room.players.length !== 2) return;
    startGame(room);
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms.entries()) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        if (room.players.length === 0) {
          rooms.delete(code);
        } else {
          room.started = false;
          room.gameOver = true;
          room.status = "Tu rival se desconectó.";
          emitRoom(room);
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Game Over Domino Online listo en http://localhost:${PORT}`);
});
