const express = require("express");
const http = require("http");
const net = require("net");
const { Server } = require("socket.io");
const open = require("open");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public")); // nơi chứa frontend

// Quản lý người chơi và bàn poker
let rooms = {};

const rankMap = { "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10, "J": 11, "Q": 12, "K": 13, "A": 14 };
const handRanks = {
  STRAIGHT_FLUSH: 9, FOUR_OF_A_KIND: 8, FULL_HOUSE: 7, FLUSH: 6, STRAIGHT: 5,
  THREE_OF_A_KIND: 4, TWO_PAIR: 3, PAIR: 2, HIGH_CARD: 1
};

function evaluateHand(cards) {
  const parsed = cards.map(c => ({ rank: rankMap[c.slice(0, -1)], suit: c.slice(-1) }));
  parsed.sort((a, b) => b.rank - a.rank);

  const counts = {};
  parsed.forEach(c => counts[c.rank] = (counts[c.rank] || 0) + 1);
  const sortedCounts = Object.entries(counts).sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  const suits = {};
  parsed.forEach(c => suits[c.suit] = (suits[c.suit] || 0) + 1);
  const flushSuit = Object.keys(suits).find(s => suits[s] >= 5);

  // Check Straight
  const uniqueRanks = [...new Set(parsed.map(c => c.rank))].sort((a, b) => b - a);
  let straightHigh = -1;
  for (let i = 0; i <= uniqueRanks.length - 5; i++) {
    if (uniqueRanks[i] - uniqueRanks[i + 4] === 4) { straightHigh = uniqueRanks[i]; break; }
  }
  if (straightHigh === -1 && uniqueRanks.includes(14) && uniqueRanks.includes(5) && uniqueRanks.includes(4) && uniqueRanks.includes(3) && uniqueRanks.includes(2)) straightHigh = 5;

  if (flushSuit && straightHigh !== -1) return { score: handRanks.STRAIGHT_FLUSH, high: straightHigh, name: "Sảnh Thùng" };
  if (sortedCounts[0][1] === 4) return { score: handRanks.FOUR_OF_A_KIND, high: parseInt(sortedCounts[0][0]), name: "Tứ Quý" };
  if (sortedCounts[0][1] === 3 && sortedCounts[1][1] >= 2) return { score: handRanks.FULL_HOUSE, high: parseInt(sortedCounts[0][0]), name: "Cù Lũ" };
  if (flushSuit) return { score: handRanks.FLUSH, high: parsed.find(c => c.suit === flushSuit).rank, name: "Thùng" };
  if (straightHigh !== -1) return { score: handRanks.STRAIGHT, high: straightHigh, name: "Sảnh" };
  if (sortedCounts[0][1] === 3) return { score: handRanks.THREE_OF_A_KIND, high: parseInt(sortedCounts[0][0]), name: "Sám Cô" };
  if (sortedCounts[0][1] === 2 && sortedCounts[1][1] === 2) return { score: handRanks.TWO_PAIR, high: parseInt(sortedCounts[0][0]), name: "Thú (2 Đôi)" };
  if (sortedCounts[0][1] === 2) return { score: handRanks.PAIR, high: parseInt(sortedCounts[0][0]), name: "Đôi" };
  return { score: handRanks.HIGH_CARD, high: parsed[0].rank, name: "Mậu Thầu" };
}

function handleRefunds(roomName) {
  const r = rooms[roomName];
  if (!r || !r.started) return;

  let changed = false;
  while (true) {
    const allSeated = r.seats.filter(pid => pid);
    const activePlayers = allSeated.filter(pid => !r.folded[pid]);
    if (activePlayers.length === 0) break; // Không còn ai chơi

    const maxActiveBet = Math.max(0, ...activePlayers.map(pid => r.totalBets[pid] || 0));
    const distinctBets = [...new Set(allSeated.map(pid => r.totalBets[pid] || 0))]
      .filter(b => b > 0)
      .sort((a, b) => b - a);

    if (distinctBets.length === 0) break;

    const maxBet = distinctBets[0];
    const secondMaxBet = distinctBets.length > 1 ? distinctBets[1] : 0;

    const topBettors = allSeated.filter(pid => (r.totalBets[pid] || 0) === maxBet);

    // Trường hợp 1: Mức cược cao nhất vượt quá mức cược của những người đang còn bài (thường do người tố cao đã fold)
    if (maxBet > maxActiveBet) {
      const diff = maxBet - Math.max(maxActiveBet, secondMaxBet);

      topBettors.forEach(pid => {
        r.balances[pid] += diff;
        r.totalBets[pid] -= diff;
        r.pot -= diff;
        if (r.bets && r.bets[pid] >= diff) r.bets[pid] -= diff;
        const name = r.displayNames[pid] || pid.slice(0, 6);
        io.to(roomName).emit('message', `💰 Trả lại ${diff} (Cân thừa) cho ${name}`);
      });
      changed = true;
      continue;
    }

    if (topBettors.length === 1 && maxBet > secondMaxBet) {
      const diff = maxBet - secondMaxBet;
      const pid = topBettors[0];
      r.balances[pid] += diff;
      r.totalBets[pid] -= diff;
      r.pot -= diff;
      if (r.bets && r.bets[pid] >= diff) r.bets[pid] -= diff;
      const name = r.displayNames[pid] || pid.slice(0, 6);
      io.to(roomName).emit('message', `💰 Trả lại ${diff} (Cân thừa) cho ${name}`);
      changed = true;
      continue;
    }

    break;
  }

  if (changed) {
    io.to(roomName).emit("updatePot", r.pot);
    emitSeatUpdate(roomName);
  }
}

function determineWinner(roomName) {
  const r = rooms[roomName];
  if (!r) return;

  const allSeated = r.seats.filter(pid => pid);
  const summary = {};
  allSeated.forEach(pid => {
    summary[pid] = {
      name: r.displayNames[pid] || pid.slice(0, 6),
      net: -(r.totalBets[pid] || 0)
    };
  });

  const balancesBeforeRefund = {};
  allSeated.forEach(pid => balancesBeforeRefund[pid] = r.balances[pid]);

  // 1. Trả lại tiền cược không có người theo (Uncalled bets)
  handleRefunds(roomName);

  allSeated.forEach(pid => {
    summary[pid].net += (r.balances[pid] - balancesBeforeRefund[pid]);
  });

  const activePlayers = allSeated.filter(pid => !r.folded[pid]);
  if (activePlayers.length === 0) return;

  // Nếu chỉ còn 1 người (những người khác đã fold)
  if (activePlayers.length === 1) {
    const winnerId = activePlayers[0];
    const winAmount = r.pot;
    r.balances[winnerId] = (r.balances[winnerId] || 0) + winAmount;
    summary[winnerId].net += winAmount;
    const name = r.displayNames[winnerId] || winnerId.slice(0, 6);
    io.to(roomName).emit('message', `🏆 ${name} CHIẾN THẮNG! Nhận được ${winAmount} (Đối thủ bỏ bài)`);
  } else {
    // 2. Logic Side Pot: Chia hũ dựa trên mức đóng góp của những người All-in
    // Lấy các mức cược duy nhất của những người chưa fold, sắp xếp tăng dần
    const levels = [...new Set(activePlayers.map(pid => r.totalBets[pid] || 0))].sort((a, b) => a - b);
    
    let lastLevel = 0;
    levels.forEach((currentLevel, idx) => {
      const incremental = currentLevel - lastLevel;
      if (incremental <= 0) return;

      // Tính tổng tiền trong hũ cho mức này (bao gồm cả tiền từ những người đã fold)
      let potForLevel = 0;
      allSeated.forEach(pid => {
        const contribution = Math.min(r.totalBets[pid] || 0, currentLevel) - Math.min(r.totalBets[pid] || 0, lastLevel);
        potForLevel += contribution;
      });

      if (potForLevel <= 0) return;

      // Những người chơi chưa fold và đã đóng góp ít nhất đến mức này là những người có quyền thắng hũ này
      const eligiblePlayers = activePlayers.filter(pid => (r.totalBets[pid] || 0) >= currentLevel);
      
      if (eligiblePlayers.length > 0) {
        const results = eligiblePlayers.map(pid => ({
          id: pid,
          hand: evaluateHand([...r.hands[pid], ...r.communityCards])
        }));

        results.sort((a, b) => b.hand.score - a.hand.score || b.hand.high - a.hand.high);
        const bestScore = results[0].hand.score;
        const bestHigh = results[0].hand.high;
        const winners = results.filter(res => res.hand.score === bestScore && res.hand.high === bestHigh);

        const winAmount = Math.floor(potForLevel / winners.length);
        winners.forEach(w => {
          r.balances[w.id] = (r.balances[w.id] || 0) + winAmount;
          summary[w.id].net += winAmount;
          const name = r.displayNames[w.id] || w.id.slice(0, 6);
          const potName = (idx === 0) ? "Main Pot" : `Side Pot ${idx}`;
          io.to(roomName).emit('message', `🏆 ${name} thắng ${potName} (${winAmount}) với ${w.hand.name}`);
        });
      }
      lastLevel = currentLevel;
    });
  }

  // Gửi bảng tổng kết cho tất cả người chơi
  io.to(roomName).emit('gameSummary', Object.values(summary));

  // Reveal all hands to everyone
  io.to(roomName).emit('showdown', r.hands);

  // Tự động chuyển Dealer sang người kế tiếp cho ván sau
  const currentDealerIdx = r.seats.findIndex(sid => sid === r.dealer);
  if (currentDealerIdx !== -1) {
    for (let i = 1; i < r.seats.length; i++) {
      const nextIdx = (currentDealerIdx + i) % r.seats.length;
      if (r.seats[nextIdx]) {
        r.dealer = r.seats[nextIdx];
        break;
      }
    }
  }

  // Cập nhật lại các chức danh (Dealer, Small, Big) để hiển thị trên giao diện
  const dealerIdx = r.seats.findIndex(sid => sid === r.dealer);
  if (dealerIdx !== -1) {
    const nextOccupied = (startIdx) => {
      for (let i = 1; i < r.seats.length; i++) {
        const idx = (startIdx + i) % r.seats.length;
        if (r.seats[idx]) return { idx, id: r.seats[idx] };
      }
      return null;
    };
    const small = nextOccupied(dealerIdx);
    const big = small ? nextOccupied(small.idx) : null;
    r.roles = {};
    r.roles[r.dealer] = 'Dealer';
    if (small) r.roles[small.id] = 'Small';
    if (big) r.roles[big.id] = 'Big';
    const rolesInfo = r.seats.map(sid => sid ? { id: sid, role: r.roles[sid] || null } : null);
    io.to(roomName).emit('rolesUpdate', rolesInfo);
  }

  r.started = false;
  r.pot = 0;
  r.bets = {};
  r.totalBets = {};
  r.currentMaxBet = 0;
  io.to(roomName).emit("updatePot", 0);
  io.to(roomName).emit('gameState', { started: false, dealer: r.dealer, host: r.host || null, currentTurn: null, currentMaxBet: 0, communityCards: r.communityCards, cardsDealt: false, defaultBigBlind: r.defaultBigBlind || 0 });
  emitSeatUpdate(roomName);
}

function emitPlayerList(roomName) {
  if (!rooms[roomName]) return;
  const room = rooms[roomName];
  const seated = new Set(room.seats.filter(s => s !== null));
  const list = (room.players || [])
    .filter(pid => pid && !seated.has(pid))
    .map(pid => {
      const displayName = (room.displayNames && room.displayNames[pid]) 
        ? room.displayNames[pid] 
        : ((room.playerNumbers && room.playerNumbers[pid]) ? `Player_${room.playerNumbers[pid]}` : pid.slice(0,6));
      const balance = (room.balances && typeof room.balances[pid] !== 'undefined') ? room.balances[pid] : 0;
      return { name: displayName, displayName, balance };
    });
  io.to(roomName).emit('playerList', list);
}

function emitBankUpdate(roomName) {
  if (!rooms[roomName]) return;
  const room = rooms[roomName];
  const list = (room.players || [])
    .filter(pid => pid)
    .map(pid => {
      const displayName = room.displayNames && room.displayNames[pid] ? room.displayNames[pid]
        : (room.playerNumbers && room.playerNumbers[pid]) ? `Player_${room.playerNumbers[pid]}` : pid.slice(0,6);
      const balance = room.balances && typeof room.balances[pid] !== 'undefined' ? room.balances[pid] : 0;
      const loans = room.loanCounts && typeof room.loanCounts[pid] !== 'undefined' ? room.loanCounts[pid] : 0;
      return { id: pid, name: displayName, displayName, balance, loans };
    });
  io.to(roomName).emit('bankUpdate', list);
}

function emitSeatUpdate(roomName) {
  if (!rooms[roomName]) return;
  const room = rooms[roomName];
  const info = room.seats.map(sid => {
    if (!sid) return null;
    return { 
      id: sid, 
      label: `Player_${room.playerNumbers[sid] || ''}`, 
      displayName: room.displayNames && room.displayNames[sid] || null, 
      balance: room.balances[sid] || 0,
      role: (room.roles && room.roles[sid]) ? room.roles[sid] : null,
      bet: (room.bets && room.bets[sid]) ? room.bets[sid] : 0,
      cardCount: (room.hands && room.hands[sid]) ? room.hands[sid].length : 0,
      folded: !!(room.folded && room.folded[sid])
    };
  });
  io.to(roomName).emit("seatUpdate", info);
}

io.on("connection", (socket) => {
  console.log("Người chơi kết nối:", socket.id.slice(0,6));

  socket.on('chatMessage', ({ room, message }) => {
    if (!room || !rooms[room]) return;
    const r = rooms[room];
    const name = r.displayNames[socket.id] || socket.id.slice(0, 6);
    io.to(room).emit('message', `${name}: ${message}`);
  });

  socket.on("joinRoom", (room) => {
      // room may be a string or object {room,name}
      let roomName = null;
      let playerName = null;
      if (typeof room === 'string') roomName = room;
      else if (room && typeof room === 'object') { roomName = room.room; playerName = room.name; }
      // require a player name
      if (!playerName) {
        socket.emit('joinError', 'Vui lòng nhập tên người chơi trước khi vào phòng');
        return;
      }
      if (!rooms[roomName]) {
        rooms[roomName] = { players: [], seats: Array(8).fill(null), playerNumbers: {}, displayNames: {}, roles: {}, dealer: null, host: null, pot: 0, deck: [], balances: {}, loanCounts: {}, bets: {}, totalBets: {}, currentMaxBet: 0, communityCards: [], round: 0, cardsDealt: false, hands: {}, history: [], defaultBigBlind: 0 };
      }
      // enforce unique display name within the room
      const existingNames = Object.values(rooms[roomName].displayNames || {});
      if (existingNames.includes(playerName)) {
        socket.emit('joinError', 'Tên này đã có trong phòng, vui lòng chọn tên khác');
        return;
      }
      rooms[roomName].displayNames[socket.id] = playerName;
      if (!rooms[roomName].players.includes(socket.id)) rooms[roomName].players.push(socket.id);
      socket.join(roomName);
      if (!rooms[roomName].host) {
        rooms[roomName].host = socket.id;
        io.to(roomName).emit('message', `👑 ${playerName} là Chủ phòng (Host)`);
      }
      // acknowledge join to the joining socket (client will show UI on acceptance)
      socket.emit('joinAccepted', roomName);
      // ensure initial bank state for this socket
      rooms[roomName].balances[socket.id] = rooms[roomName].balances[socket.id] || 0;
      rooms[roomName].loanCounts[socket.id] = rooms[roomName].loanCounts[socket.id] || 0;
      // emit seat info with labels
      const label = rooms[roomName].playerNumbers && rooms[roomName].playerNumbers[socket.id] ? `Player_${rooms[roomName].playerNumbers[socket.id]}` : (rooms[roomName].displayNames && rooms[roomName].displayNames[socket.id]) || socket.id.slice(0,6);
      console.log(`Người chơi vào phòng ${roomName}: ${label}`);
      io.to(roomName).emit("message", `Người chơi ${rooms[roomName].displayNames[socket.id] ? rooms[roomName].displayNames[socket.id] : label} đã vào phòng`);
      emitSeatUpdate(roomName);
      // emit roles and game state so client can update Start button and seat interactivity
      const rolesInfo = rooms[roomName].seats.map(sid => sid ? { id: sid, role: rooms[roomName].roles && rooms[roomName].roles[sid] ? rooms[roomName].roles[sid] : null } : null);
      io.to(roomName).emit('rolesUpdate', rolesInfo);
        io.to(roomName).emit('gameState', { started: !!rooms[roomName].started, dealer: rooms[roomName].dealer || null, host: rooms[roomName].host || null, currentTurn: rooms[roomName].currentTurn || null, currentMaxBet: rooms[roomName].currentMaxBet || 0, communityCards: rooms[roomName].communityCards || [], cardsDealt: !!rooms[roomName].cardsDealt, defaultBigBlind: rooms[roomName].defaultBigBlind || 0 });
        // emit player list and bank info for the room
        emitPlayerList(roomName);
        emitBankUpdate(roomName);
  });

  // Player requests to take a specific seat (0-7)
  socket.on("joinSeat", ({ room, seatIndex }) => {
    if (!room || typeof seatIndex !== 'number') return;
    if (!rooms[room]) {
      rooms[room] = { players: [], seats: Array(8).fill(null), playerNumbers: {}, displayNames: {}, roles: {}, dealer: null, host: null, pot: 0, deck: [], balances: {}, loanCounts: {}, bets: {}, totalBets: {}, currentMaxBet: 0, communityCards: [], round: 0, cardsDealt: false, hands: {}, history: [], defaultBigBlind: 0 };
    }
    const currentSeat = (socket.data && typeof socket.data.seat === 'number') ? socket.data.seat : null;
    // do not allow taking a seat when the game has already started
    if (rooms[room] && rooms[room].started && currentSeat === null) {
      socket.emit('seatError', 'Không thể ngồi vào ghế khi ván đã bắt đầu');
      return;
    }
    // Requirement: Balance must be > 0 to sit
    const playerBalance = rooms[room].balances[socket.id] || 0;
    if (currentSeat === null && playerBalance <= 0) {
      socket.emit('seatError', 'Bạn cần có tiền để ngồi vào ghế. Hãy vay tiền từ ngân hàng.');
      return;
    }
    // If player already seated and tries to take a different seat, deny
    if (currentSeat !== null && seatIndex !== currentSeat) {
      socket.emit('seatError', 'Không thể đổi ghế trực tiếp. Click lại ghế đang ngồi để rời.');
      return;
    }
    if (seatIndex < 0 || seatIndex >= rooms[room].seats.length) {
      socket.emit('seatError', 'Seat index out of range');
      return;
    }
    const seats = rooms[room].seats;
    if (seats[seatIndex] && seats[seatIndex] !== socket.id) {
      socket.emit('seatError', 'Seat already taken');
      return;
    }
    // If clicking the same seat again -> leave seat
    if (currentSeat !== null && seatIndex === currentSeat) {
      // do not allow leaving while game started
      if (rooms[room] && rooms[room].started) {
        socket.emit('seatError', 'Không thể rời ghế khi ván đang bắt đầu');
        return;
      }
      seats[seatIndex] = null;
      // free player number for this room
      if (rooms[room] && rooms[room].playerNumbers) {
        delete rooms[room].playerNumbers[socket.id];
      }
      // remove role and if dealer left, clear dealer or reassign
      if (rooms[room] && rooms[room].roles) {
        delete rooms[room].roles[socket.id];
      }
      if (rooms[room] && rooms[room].dealer === socket.id) {
        rooms[room].dealer = null;
        // assign first occupied as dealer
        const firstOcc = rooms[room].seats.find(sid => sid);
        if (firstOcc) {
          rooms[room].dealer = firstOcc;
          rooms[room].roles[firstOcc] = 'Dealer';
        }
      }
      if (!seats.some(s => s !== null)) {
        rooms[room].defaultBigBlind = 0;
      }
      delete socket.data.seat;
      // Nếu người rời ghế là Host, đảm bảo họ vẫn là Host của phòng
      if (!rooms[room].host) {
        rooms[room].host = socket.id;
      }

      emitSeatUpdate(room);
      // emit rolesUpdate as well
      const rolesInfo = rooms[room].seats.map(sid => sid ? { id: sid, role: rooms[room].roles[sid] || null } : null);
      io.to(room).emit('rolesUpdate', rolesInfo);
      // also send gameState
      io.to(room).emit('gameState', { started: !!rooms[room].started, dealer: rooms[room].dealer || null, host: rooms[room].host || null, currentTurn: rooms[room].currentTurn || null, currentMaxBet: rooms[room].currentMaxBet || 0, communityCards: rooms[room].communityCards || [], cardsDealt: !!rooms[room].cardsDealt, defaultBigBlind: rooms[room].defaultBigBlind || 0 });
      const leftLabel = rooms[room] && rooms[room].displayNames && rooms[room].displayNames[socket.id] ? rooms[room].displayNames[socket.id] : socket.id.slice(0,6);
      io.to(room).emit('message', `Người chơi ${leftLabel} rời ghế ${seatIndex+1}`);
      emitPlayerList(room);
      emitBankUpdate(room);
      return;
    }
    // assign seat
    seats[seatIndex] = socket.id;
    // assign a Player_X number if not already
    if (!rooms[room].playerNumbers[socket.id]) {
      // find smallest free number 1..8
      const used = new Set(Object.values(rooms[room].playerNumbers));
      let num = 1;
      while (used.has(num) && num <= 8) num++;
      rooms[room].playerNumbers[socket.id] = num <= 8 ? num : Object.keys(rooms[room].playerNumbers).length + 1;
    }
    // if no dealer assigned yet, make this player the dealer
    if (!rooms[room].dealer) {
      rooms[room].dealer = socket.id;
      rooms[room].roles = rooms[room].roles || {};
      rooms[room].roles[socket.id] = 'Dealer';
    }
    // Đảm bảo luôn có Host nếu phòng được tạo từ joinSeat
    if (!rooms[room].host) {
      rooms[room].host = socket.id;
      io.to(room).emit('message', `👑 ${rooms[room].displayNames[socket.id] || socket.id.slice(0,6)} là Chủ phòng (Host)`);
    }
    if (!rooms[room].players.includes(socket.id)) rooms[room].players.push(socket.id);
    socket.join(room);
    socket.data.room = room;
    socket.data.seat = seatIndex;
    emitSeatUpdate(room);
    // also emit roles info
    const rolesInfo = seats.map(sid => sid ? { id: sid, role: rooms[room].roles[sid] || null } : null);
    io.to(room).emit('rolesUpdate', rolesInfo);
    // emit game state so clients (especially dealer) can enable Start button
    io.to(room).emit('gameState', { started: !!rooms[room].started, dealer: rooms[room].dealer || null, host: rooms[room].host || null, currentTurn: rooms[room].currentTurn || null, currentMaxBet: rooms[room].currentMaxBet || 0, communityCards: rooms[room].communityCards || [], cardsDealt: !!rooms[room].cardsDealt, defaultBigBlind: rooms[room].defaultBigBlind || 0 });
    // emit player list and bank info for the room
    emitPlayerList(room);
    emitBankUpdate(room);
    const myLabel = rooms[room].playerNumbers && rooms[room].playerNumbers[socket.id] ? `Player_${rooms[room].playerNumbers[socket.id]}` : (rooms[room].displayNames && rooms[room].displayNames[socket.id]) || socket.id.slice(0,6);
    console.log(`Người chơi ngồi ghế ${seatIndex+1} trong ${room}: ${myLabel}`);
    io.to(room).emit('message', `Người chơi ${rooms[room].displayNames && rooms[room].displayNames[socket.id] ? rooms[room].displayNames[socket.id] : myLabel} ngồi ghế ${seatIndex+1}`);
  });

  socket.on("bet", ({ room, amount }) => {
    if (!rooms[room]) return;
    const r = rooms[room];
    const val = parseInt(amount) || 0;
    const currentBalance = r.balances[socket.id] || 0;
    if (val > currentBalance) {
      socket.emit('seatError', 'Bạn không đủ tiền để cược');
      return;
    }
    r.balances[socket.id] = currentBalance - val;
    r.pot += val;
    r.bets = r.bets || {};
    r.bets[socket.id] = (r.bets[socket.id] || 0) + val;
    r.totalBets = r.totalBets || {};
    r.totalBets[socket.id] = (r.totalBets[socket.id] || 0) + val;
    r.currentMaxBet = Math.max(r.currentMaxBet || 0, r.bets[socket.id]);
    const label = (r.displayNames && r.displayNames[socket.id]) ? r.displayNames[socket.id]
      : (r.playerNumbers && r.playerNumbers[socket.id]) ? `Player_${r.playerNumbers[socket.id]}`
      : socket.id.slice(0,6);
    io.to(room).emit("message", `Người chơi ${label} cược ${val}`);
    io.to(room).emit("updatePot", r.pot);
    emitSeatUpdate(room);
    emitBankUpdate(room);
    emitPlayerList(room);
  });

  socket.on("dealCards", (room) => {
    if (!room || !rooms[room]) return;
    // only dealer can trigger dealing
    if (socket.id !== rooms[room].dealer) {
      socket.emit('seatError', 'Chỉ Dealer mới được chia bài');
      return;
    }
    // only allow dealing when game has been started
    if (!rooms[room].started) {
      socket.emit('seatError', 'Chỉ có thể chia bài khi ván đã bắt đầu');
      return;
    }
    // Tạo bộ bài đơn giản
    const suits = ["♠", "♥", "♦", "♣"];
    const ranks = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
    let deck = [];
    suits.forEach(s => ranks.forEach(r => deck.push(r+s)));
    deck = deck.sort(() => Math.random() - 0.5);
    if (!rooms[room]) return;
    const r = rooms[room];
    r.deck = deck;
    r.communityCards = [];
    r.cardsDealt = true;
    // Thông báo ngay cho client là bắt đầu chia bài để kích hoạt hiển thị khung bài trên ghế
    io.to(room).emit('gameState', { started: !!r.started, dealer: r.dealer || null, host: r.host || null, currentTurn: r.currentTurn || null, currentMaxBet: r.currentMaxBet || 0, communityCards: r.communityCards || [], cardsDealt: true, defaultBigBlind: r.defaultBigBlind || 0 });
    // prepare empty hands for seated players
    r.hands = {};
    r.seats.forEach(pid => { if (pid) r.hands[pid] = []; });

    // determine dealing order: start from Small if present, otherwise seat after dealer
    let startIdx = 0;
    const smallId = Object.keys(r.roles || {}).find(id => r.roles[id] === 'Small');
    if (smallId) {
      startIdx = r.seats.findIndex(sid => sid === smallId);
      if (startIdx === -1) startIdx = 0;
    } else {
      const dealerIndex = r.seats.findIndex(sid => sid === r.dealer);
      startIdx = (dealerIndex === -1) ? 0 : (dealerIndex + 1) % r.seats.length;
    }
    const order = [];
    for (let i = 0; i < r.seats.length; i++) {
      const idx = (startIdx + i) % r.seats.length;
      const pid = r.seats[idx];
      if (pid) order.push(pid);
    }

    const delayMs = 600; // ms between each card dealt
    let maxTime = 0;
    // deal two rounds (one card per player each round)
    for (let round = 0; round < 2; round++) {
      order.forEach((playerId, idx) => {
        const time = (round * order.length + idx) * delayMs;
        setTimeout(() => {
          const card = r.deck.pop();
          if (!r.hands[playerId]) r.hands[playerId] = [];
          if (card) r.hands[playerId].push(card);
          const display = (r.displayNames && r.displayNames[playerId]) ? r.displayNames[playerId]
            : (r.playerNumbers && r.playerNumbers[playerId]) ? `Player_${r.playerNumbers[playerId]}` : playerId.slice(0,6);
          // send the partial/full hand privately as cards come in
          io.to(playerId).emit('privateDeal', { display, cards: r.hands[playerId] });
          emitSeatUpdate(room);
        }, time);
        if (time > maxTime) maxTime = time;
      });
    }
    // after dealing finished, emit full hands to room
    setTimeout(() => {
      io.to(room).emit('deal', { dealt: true });
      emitSeatUpdate(room);
      // initialize round state and folded map
      r.round = 1;
      r.folded = r.folded || {};
      // determine first to act: player after Big
      const bigId = Object.keys(r.roles || {}).find(id => r.roles[id] === 'Big');
      r.lastRaiser = bigId || r.dealer;
      let firstActId = null;
      if (bigId) {
        const bigIdx = r.seats.findIndex(sid => sid === bigId);
        for (let i = 1; i <= r.seats.length; i++) {
          const idx = (bigIdx + i) % r.seats.length;
          const pid = r.seats[idx];
          if (pid && (r.balances[pid] || 0) > 0) { firstActId = pid; break; }
        }
      } else {
        // fallback: seat after dealer
        const dealerIdx = r.seats.findIndex(sid => sid === r.dealer);
        for (let i = 1; i <= r.seats.length; i++) {
          const idx = (dealerIdx + i) % r.seats.length;
          const pid = r.seats[idx];
          if (pid && (r.balances[pid] || 0) > 0) { firstActId = pid; break; }
        }
      }
      r.currentTurn = firstActId || null;
      const turnLabel = r.currentTurn ? (r.displayNames && r.displayNames[r.currentTurn] ? r.displayNames[r.currentTurn] : (r.playerNumbers && r.playerNumbers[r.currentTurn] ? `Player_${r.playerNumbers[r.currentTurn]}` : r.currentTurn.slice(0,6))) : null;
      io.to(room).emit('turnUpdate', { currentTurn: r.currentTurn, currentLabel: turnLabel, currentMaxBet: r.currentMaxBet || 0 });
      io.to(room).emit('gameState', { started: true, dealer: r.dealer, host: r.host || null, currentTurn: r.currentTurn, currentMaxBet: r.currentMaxBet || 0, communityCards: r.communityCards || [], cardsDealt: true, defaultBigBlind: r.defaultBigBlind || 0 });
    }, maxTime + delayMs);
  });

  socket.on('startGame', (data) => {
      const room = (data && data.room) ? data.room : data;
      if (!room || !rooms[room]) return;
      const r = rooms[room];

      let bb = (data && data.bigBlind) ? parseInt(data.bigBlind) : 0;
      if (!bb && r.defaultBigBlind) bb = r.defaultBigBlind;

      // only dealer can start
      if (socket.id !== r.dealer) {
        socket.emit('seatError', 'Chỉ Dealer mới được bắt đầu ván');
        return;
      }
      if (isNaN(bb) || bb <= 0 || bb % 5 !== 0) {
        socket.emit('seatError', 'Big Blind phải là bội số của 5 và lớn hơn 0');
        return;
      }
      r.defaultBigBlind = bb;

      // ensure dealer exists
      if (!r.dealer) {
        const firstOcc = r.seats.find(sid => sid);
        if (!firstOcc) {
          socket.emit('seatError', 'Không có người chơi để bắt đầu');
          return;
        }
        r.dealer = firstOcc;
        r.roles[r.dealer] = 'Dealer';
      }
      // Requirement: All seated players must have balance > 0 to start
      const brokePlayerId = r.seats.find(sid => sid && (r.balances[sid] || 0) <= 0);
      if (brokePlayerId) {
        socket.emit('seatError', 'Tất cả người chơi đang ngồi phải có tiền mới có thể bắt đầu');
        return;
      }
      // find dealer seat index
      const dealerIndex = r.seats.findIndex(sid => sid === r.dealer);
      if (dealerIndex === -1) return;
      // find next occupied for small and big
      const nextOccupied = (startIdx) => {
        for (let i = 1; i < r.seats.length; i++) {
          const idx = (startIdx + i) % r.seats.length;
          if (r.seats[idx]) return { idx, id: r.seats[idx] };
        }
        return null;
      };
      const small = nextOccupied(dealerIndex);
      const big = small ? nextOccupied(small.idx) : null;
      // clear previous roles except dealer
      r.roles = r.roles || {};
      Object.keys(r.roles).forEach(k => delete r.roles[k]);
      r.roles[r.dealer] = 'Dealer';
      if (small) r.roles[small.id] = 'Small';
      if (big) r.roles[big.id] = 'Big';
      // emit roles update
      const rolesInfo = r.seats.map(sid => sid ? { id: sid, role: r.roles[sid] || null } : null);

      const sb = Math.floor(bb / 2);

      // Kiểm tra khả năng chi trả tiền mù
      if (small && (r.balances[small.id] < sb)) {
        socket.emit('seatError', `Người chơi Small Blind không đủ tiền (${sb}) để bắt đầu`);
        return;
      }
      if (big && (r.balances[big.id] < bb)) {
        socket.emit('seatError', `Người chơi Big Blind không đủ tiền (${bb}) để bắt đầu`);
        return;
      }

      r.started = true;
      r.bets = {};
      r.totalBets = {};
      r.folded = {};

      // Khấu trừ tiền mù
      if (small) { r.balances[small.id] -= sb; r.bets[small.id] = sb; r.totalBets[small.id] = sb; }
      if (big) { r.balances[big.id] -= bb; r.bets[big.id] = bb; r.totalBets[big.id] = bb; }
      
      r.pot = (small ? sb : 0) + (big ? bb : 0);
      r.currentMaxBet = bb;
      r.communityCards = [];
      r.round = 0;
      r.cardsDealt = false;
      r.hands = {};
      io.to(room).emit("updatePot", r.pot);
      emitSeatUpdate(room);
      io.to(room).emit('rolesUpdate', rolesInfo);
      // emit a single gameStarted event (client will show one log) including dealer id
      const dealerLabel = r.displayNames && r.displayNames[r.dealer] ? r.displayNames[r.dealer] : (r.playerNumbers[r.dealer] ? `Player_${r.playerNumbers[r.dealer]}` : r.dealer.slice(0,6));
      io.to(room).emit('gameStarted', { dealerId: r.dealer, dealerLabel, sb, bb });
        // emit gameState
        io.to(room).emit('gameState', { started: true, dealer: r.dealer, host: r.host || null, currentTurn: r.currentTurn || null, currentMaxBet: r.currentMaxBet, communityCards: [], cardsDealt: false, defaultBigBlind: r.defaultBigBlind || 0 });
  });

  socket.on('endGame', (room) => {
    if (!room || !rooms[room]) return;
    const r = rooms[room];
    // only dealer can end game
    if (socket.id !== r.dealer) {
      socket.emit('seatError', 'Chỉ Dealer mới được kết thúc ván');
      return;
    }
    // mark game as not started but KEEP roles and dealer
    r.started = false;
    r.cardsDealt = false;
    r.hands = {};
    io.to(room).emit('gameEnded', { msg: 'Game ended' });
    // notify clients of new game state so they can re-enable seat actions
    io.to(room).emit('gameState', { started: false, dealer: r.dealer || null, host: r.host || null, currentTurn: r.currentTurn || null, currentMaxBet: r.currentMaxBet || 0, communityCards: r.communityCards || [], cardsDealt: false, defaultBigBlind: r.defaultBigBlind || 0 });
  });

  socket.on('disconnect', () => {
    // remove player from any rooms and free seats
    Object.keys(rooms).forEach((r) => {
      const roomObj = rooms[r];
      if (!roomObj) return;
      // remove from players
      roomObj.players = roomObj.players.filter(pid => pid !== socket.id);
      if (roomObj.host === socket.id) {
        roomObj.host = roomObj.players.length > 0 ? roomObj.players[0] : null;
        if (roomObj.host) {
          const newHostName = roomObj.displayNames[roomObj.host] || roomObj.host.slice(0, 6);
          io.to(r).emit('message', `👑 ${newHostName} hiện là Chủ phòng (Host) mới`);
        }
      }

      if (roomObj.players.length === 0) {
        delete rooms[r];
        console.log(`Phòng ${r} không còn người chơi. Game end now.`);
        return;
      }
      // free seats
      let changed = false;
      roomObj.seats = roomObj.seats.map(sid => {
        if (sid === socket.id) { changed = true; return null; }
        return sid;
      });
      // Giải phóng dữ liệu người chơi
      if (roomObj.playerNumbers && roomObj.playerNumbers[socket.id]) { delete roomObj.playerNumbers[socket.id]; changed = true; }
      if (roomObj.displayNames && roomObj.displayNames[socket.id]) { delete roomObj.displayNames[socket.id]; changed = true; }
      if (roomObj.roles && roomObj.roles[socket.id]) { delete roomObj.roles[socket.id]; changed = true; }

      // Luôn cập nhật danh sách hàng chờ khi có người thoát
      emitPlayerList(r);
      emitBankUpdate(r);

      if (changed) {
        if (!roomObj.seats.some(s => s !== null)) {
          roomObj.defaultBigBlind = 0;
        }
        emitSeatUpdate(r);
      }
    });
  });

  // Explicit leave room request (e.g., client clicked Refresh/Leave)
  socket.on('leaveRoom', (room) => {
    if (!room || !rooms[room]) return;
    const roomObj = rooms[room];
    // remove from players
    roomObj.players = roomObj.players.filter(pid => pid !== socket.id);
    if (roomObj.host === socket.id) {
      roomObj.host = roomObj.players.length > 0 ? roomObj.players[0] : null;
      if (roomObj.host) {
        const newHostName = roomObj.displayNames[roomObj.host] || roomObj.host.slice(0, 6);
        io.to(room).emit('message', `👑 ${newHostName} hiện là Chủ phòng (Host) mới`);
      }
    }

    if (roomObj.players.length === 0) {
      delete rooms[room];
      console.log(`Phòng ${room} không còn người chơi. Game end now.`);
      socket.leave(room);
      return;
    }
    // free seats
    let changed = false;
    roomObj.seats = roomObj.seats.map(sid => {
      if (sid === socket.id) { changed = true; return null; }
      return sid;
    });
    // free player number mapping and display name and roles
    if (roomObj.playerNumbers && roomObj.playerNumbers[socket.id]) { delete roomObj.playerNumbers[socket.id]; changed = true; }
    if (roomObj.displayNames && roomObj.displayNames[socket.id]) { delete roomObj.displayNames[socket.id]; changed = true; }
    if (roomObj.roles && roomObj.roles[socket.id]) { delete roomObj.roles[socket.id]; changed = true; }
    if (roomObj.dealer === socket.id) {
      roomObj.dealer = null;
      const firstOcc = roomObj.seats.find(sid => sid);
      if (firstOcc) { roomObj.dealer = firstOcc; roomObj.roles = roomObj.roles || {}; roomObj.roles[firstOcc] = 'Dealer'; }
      changed = true;
    }
    if (changed) {
      if (!roomObj.seats.some(s => s !== null)) {
        roomObj.defaultBigBlind = 0;
      }
      emitSeatUpdate(room);
      const rolesInfo = roomObj.seats.map(sid => sid ? { id: sid, role: roomObj.roles && roomObj.roles[sid] ? roomObj.roles[sid] : null } : null);
      io.to(room).emit('rolesUpdate', rolesInfo);
      io.to(room).emit('gameState', { started: !!roomObj.started, dealer: roomObj.dealer || null, host: roomObj.host || null, currentTurn: roomObj.currentTurn || null, currentMaxBet: roomObj.currentMaxBet || 0, communityCards: roomObj.communityCards || [], cardsDealt: !!roomObj.cardsDealt, defaultBigBlind: roomObj.defaultBigBlind || 0 });
      io.to(room).emit('message', `Người chơi rời khỏi phòng`);
      // update player list and bank info
      emitPlayerList(room);
      emitBankUpdate(room);
    }
    socket.leave(room);
  });

  // Bank actions
  socket.on('bankBorrow', ({ room, amount }) => {
    if (!room || !rooms[room]) return;
    const r = rooms[room];
    if (r.started) {
      socket.emit('seatError', 'Không thể vay tiền khi ván đang diễn ra');
      return;
    }
    const val = parseInt(amount);
    if (isNaN(val) || val <= 0 || val % 5 !== 0) {
      socket.emit('seatError', 'Số tiền vay phải là bội số của 5 và lớn hơn 0');
      return;
    }
    // ensure balances and loanCounts
    r.balances = r.balances || {};
    r.loanCounts = r.loanCounts || {};
    r.balances[socket.id] = (r.balances[socket.id] || 0) + val;
    r.loanCounts[socket.id] = (r.loanCounts[socket.id] || 0) + val;
    const display = r.displayNames && r.displayNames[socket.id] ? r.displayNames[socket.id] : (r.playerNumbers && r.playerNumbers[socket.id]) ? `Player_${r.playerNumbers[socket.id]}` : socket.id.slice(0,6);
    io.to(room).emit('message', `${display} đã vay ngân hàng +${val}`);
    emitPlayerList(room);
    emitBankUpdate(room);
    emitSeatUpdate(room);
  });

  socket.on('bankRepay', ({ room, amount }) => {
    if (!room || !rooms[room]) return;
    const r = rooms[room];
    if (r.started) {
      socket.emit('seatError', 'Không thể trả nợ khi ván đang diễn ra');
      return;
    }
    const val = parseInt(amount);
    if (isNaN(val) || val <= 0 || val % 5 !== 0) {
      socket.emit('seatError', 'Số tiền trả phải là bội số của 5 và lớn hơn 0');
      return;
    }
    r.balances = r.balances || {};
    r.loanCounts = r.loanCounts || {};
    const currentDebt = r.balances[socket.id] || 0;
    if (val > currentDebt) {
      socket.emit('seatError', 'Số tiền trả không được lớn hơn số dư hiện tại của bạn');
      return;
    }
    r.balances[socket.id] = Math.max(0, currentDebt - val);
    const currentLoans = r.loanCounts[socket.id] || 0;
    r.loanCounts[socket.id] = Math.max(0, currentLoans - val);
    const display = r.displayNames && r.displayNames[socket.id] ? r.displayNames[socket.id] : (r.playerNumbers && r.playerNumbers[socket.id]) ? `Player_${r.playerNumbers[socket.id]}` : socket.id.slice(0,6);
    io.to(room).emit('message', `${display} đã trả nợ ${val}`);
    emitPlayerList(room);
    emitBankUpdate(room);
    emitSeatUpdate(room);
  });

  function advanceRound(roomName) {
    const r = rooms[roomName];
    if (!r) return;
    r.round = (r.round || 1) + 1;
    r.bets = {};
    r.currentMaxBet = 0;

    r.currentTurn = null; // Khóa lượt trong quá trình chuyển vòng

    const finalizeRound = () => {
      const activePlayers = r.seats.filter(pid => pid && !r.folded[pid]);
      const playersWhoCanAct = activePlayers.filter(pid => (r.balances[pid] || 0) > 0);

      let next = null;
      if (playersWhoCanAct.length >= 2) {
        const dealerIdx = r.seats.findIndex(sid => sid === r.dealer);
        for (let i = 1; i <= r.seats.length; i++) {
          const idx = (dealerIdx + i) % r.seats.length;
          const pid = r.seats[idx];
          if (pid && !r.folded[pid] && (r.balances[pid] || 0) > 0) {
            next = pid;
            break;
          }
        }
      }

      if (next === null && r.started && activePlayers.length >= 2) {
        r.currentTurn = null;
        io.to(roomName).emit('gameState', { started: true, dealer: r.dealer, host: r.host || null, currentTurn: null, currentMaxBet: 0, communityCards: r.communityCards, cardsDealt: !!r.cardsDealt, defaultBigBlind: r.defaultBigBlind || 0 });
        setTimeout(() => {
          if (rooms[roomName] && rooms[roomName].started) advanceRound(roomName);
        }, 1500);
      } else {
        r.currentTurn = next;
        r.lastRaiser = next;
        io.to(roomName).emit('gameState', { started: true, dealer: r.dealer, host: r.host || null, currentTurn: r.currentTurn, currentMaxBet: 0, communityCards: r.communityCards, cardsDealt: !!r.cardsDealt, defaultBigBlind: r.defaultBigBlind || 0 });
        const turnLabel = r.currentTurn ? (r.displayNames[r.currentTurn] || `Player_${r.playerNumbers[r.currentTurn]}`) : null;
        io.to(roomName).emit('turnUpdate', { currentTurn: r.currentTurn, currentLabel: turnLabel, currentMaxBet: 0 });
        emitSeatUpdate(roomName);
      }
    };

    if (r.round === 2) {
      r.communityCards = [];
      io.to(roomName).emit('message', "--- VÒNG 2: THE FLOP ---");
      for (let i = 0; i < 3; i++) {
        setTimeout(() => {
          if (!rooms[roomName]) return;
          r.communityCards.push(r.deck.pop());
          io.to(roomName).emit('gameState', { started: true, dealer: r.dealer, host: r.host || null, currentTurn: null, currentMaxBet: 0, communityCards: r.communityCards, cardsDealt: !!r.cardsDealt, defaultBigBlind: r.defaultBigBlind || 0 });
          if (i === 2) finalizeRound();
        }, (i + 1) * 1500);
      }
      return;
    } else if (r.round === 3) {
      r.communityCards.push(r.deck.pop());
      io.to(roomName).emit('message', "--- VÒNG 3: THE TURN ---");
    } else if (r.round === 4) {
      r.communityCards.push(r.deck.pop());
      io.to(roomName).emit('message', "--- VÒNG 4: THE RIVER ---");
    } else {
      return determineWinner(roomName);
    }

    finalizeRound();
  }

  // player action during a round (e.g., Check, Raise, All in)
  socket.on('playerAction', ({ room, action, amount }) => {
    if (!room || !rooms[room]) return;
    const r = rooms[room];
    if (!r.started) {
      socket.emit('seatError', 'Chưa vào vòng cược');
      return;
    }
    const seatIdx = (socket.data && typeof socket.data.seat === 'number') ? socket.data.seat : null;
    if (seatIdx === null || r.seats[seatIdx] !== socket.id) {
      socket.emit('seatError', 'Bạn không ngồi ghế để thực hiện hành động');
      return;
    }
    // enforce turn order
    if (r.currentTurn && r.currentTurn !== socket.id) {
      socket.emit('seatError', 'Chưa đến lượt bạn');
      return;
    }
    // mark folded
    if (!r.folded) r.folded = {};
    if (action === 'Bỏ bài') {
      r.folded[socket.id] = true;
    }
    let val = 0;
    if (action === 'All in') {
      val = r.balances[socket.id] || 0;
    } else if (action === 'Cân cửa') {
      const required = Math.max(0, (r.currentMaxBet || 0) - (r.bets[socket.id] || 0));
      if (required > (r.balances[socket.id] || 0)) {
        // Nếu không đủ tiền để cân hoàn toàn, tự động chuyển thành All-in (Cân thiếu)
        val = r.balances[socket.id] || 0;
        action = 'All in (Cân thiếu)';
      } else {
        val = required;
      }
    } else if (action === 'Check') {
      if ((r.bets[socket.id] || 0) < r.currentMaxBet) {
        socket.emit('seatError', 'Không thể check khi mức cược của bạn chưa bằng mức cược cao nhất (có tiền mù hoặc người khác đã tố)');
        return;
      }
      val = 0;
    } else if (action === 'Raise') {
      val = parseInt(amount) || 0;
      if ((r.bets[socket.id] || 0) + val <= r.currentMaxBet) {
        socket.emit('seatError', `Tổng tiền cược sau khi tố phải lớn hơn mức cược hiện tại (${r.currentMaxBet})`);
        return;
      }
      r.lastRaiser = socket.id;
    } else if (amount) {
      val = parseInt(amount) || 0;
    }

    if (val > 0) {
      const currentBalance = r.balances[socket.id] || 0;
      if (val > currentBalance) {
        socket.emit('seatError', 'Bạn không đủ tiền để thực hiện hành động này');
        return;
      }
      r.balances[socket.id] = currentBalance - val;
      r.pot += val;
      r.bets = r.bets || {};
      r.bets[socket.id] = (r.bets[socket.id] || 0) + val;
      r.totalBets = r.totalBets || {};
      r.totalBets[socket.id] = (r.totalBets[socket.id] || 0) + val;
      r.currentMaxBet = Math.max(r.currentMaxBet || 0, r.bets[socket.id]);
      io.to(room).emit("updatePot", r.pot);
    }

    const display = r.displayNames && r.displayNames[socket.id] ? r.displayNames[socket.id] : (r.playerNumbers && r.playerNumbers[socket.id]) ? `Player_${r.playerNumbers[socket.id]}` : socket.id.slice(0,6);
    const displayAmount = (action.includes('All in') || action === 'Cân cửa') ? val : amount;
    const msg = displayAmount ? `${display} -> ${action} ${displayAmount}` : `${display} -> ${action}`;
    io.to(room).emit('message', msg);

    // Cập nhật ghế ngồi ngay để hiện mức cược của người vừa thao tác
    emitSeatUpdate(room);

    // advance turn to next non-folded seated player
    const len = r.seats.length;
    let next = null;
    for (let i = 1; i <= len; i++) {
      const idx = (seatIdx + i) % len;
      const pid = r.seats[idx];
      if (pid && !r.folded[pid] && (r.balances[pid] || 0) > 0) { next = pid; break; }
    }

    // Check if round is over
    const activePlayers = r.seats.filter(pid => pid && !r.folded[pid]);
    if (activePlayers.length === 1) {
      r.currentTurn = null;
      io.to(room).emit('turnUpdate', { currentTurn: null, currentLabel: 'Vòng kết thúc', currentMaxBet: r.currentMaxBet });
      setTimeout(() => {
        if (rooms[room] && rooms[room].started) determineWinner(room);
      }, 1000);
      return;
    }

    const playersWhoCanAct = activePlayers.filter(pid => (r.balances[pid] || 0) > 0);
    const allMatched = playersWhoCanAct.every(pid => (r.bets[pid] || 0) === r.currentMaxBet);
    if (allMatched && (next === r.lastRaiser || next === null || playersWhoCanAct.length <= 1)) {
      r.currentTurn = null;
      io.to(room).emit('turnUpdate', { currentTurn: null, currentLabel: 'Vòng kết thúc', currentMaxBet: r.currentMaxBet });
      setTimeout(() => {
        if (rooms[room] && rooms[room].started) advanceRound(room);
      }, 1000);
      return;
    }

    r.currentTurn = next;
    const turnLabel = r.currentTurn ? (r.displayNames && r.displayNames[r.currentTurn] ? r.displayNames[r.currentTurn] : (r.playerNumbers && r.playerNumbers[r.currentTurn] ? `Player_${r.playerNumbers[r.currentTurn]}` : r.currentTurn.slice(0,6))) : null;
    io.to(room).emit('turnUpdate', { currentTurn: r.currentTurn, currentLabel: turnLabel, currentMaxBet: r.currentMaxBet || 0 });
    // emit updated gameState as well
    io.to(room).emit('gameState', { started: !!r.started, dealer: r.dealer || null, host: r.host || null, currentTurn: r.currentTurn || null, currentMaxBet: r.currentMaxBet || 0, communityCards: r.communityCards || [], cardsDealt: !!r.cardsDealt, defaultBigBlind: r.defaultBigBlind || 0 });
    // emit bank update in case balances changed
    emitPlayerList(room);
    emitBankUpdate(room);
    emitSeatUpdate(room);
  });
});

async function findFreePort(preferredPort = 3000, maxTrials = 11) {
  return new Promise((resolve, reject) => {
    let port = preferredPort;
    const tryPort = () => {
      const tester = net.createServer();
      tester.once('error', (err) => {
        tester.close();
        if (err.code === 'EADDRINUSE') {
          port += 1;
          if (port < preferredPort + maxTrials) {
            tryPort();
          } else {
            reject(new Error('No free port found'));
          }
        } else {
          reject(err);
        }
      }).once('listening', () => {
        tester.close(() => resolve(port));
      }).listen(port);
    };
    tryPort();
  });
}

// Ưu tiên cổng từ biến môi trường (cho các dịch vụ cloud) hoặc mặc định là 3000
const startPort = process.env.PORT ? parseInt(process.env.PORT) : 3000;

findFreePort(startPort, 11).then((port) => {
  server.listen(port, "0.0.0.0", () => {
    const url = `http://localhost:${port}`;
    console.log(`Server đang chạy trên cổng: ${port}`);
    // Chỉ tự động mở trình duyệt nếu đang chạy ở máy cá nhân (không có biến PORT)
    if (!process.env.PORT) {
      try { open(url); } catch (err) { /* ignore open errors */ }
    }
  });
}).catch((err) => {
  console.error('Không tìm được cổng rảnh để chạy server:', err);
  process.exit(1);
});
