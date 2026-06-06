const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 載入題庫
const questionBank = require('./questions.js');
const idColors = ['#FF5733', '#33FF57', '#3357FF', '#F333FF', '#FFB833', '#33FFF6', '#8D33FF', '#FF3385'];

let rooms = {}; // 房間資料庫

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

io.on('connection', (socket) => {
    socket.emit('room_list', getAllRooms());

    // 創造房間
    socket.on('create_room', (data) => {
        const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
        const roomName = (data.roomName || '').trim() || `${data.name} 的房間`;

        // 驗證私人房密碼必須是 4 位數字
        if (data.isPrivate) {
            if (!/^\d{4}$/.test(data.password)) {
                socket.emit('error_msg', '密碼必須是 4 位數字');
                return;
            }
        }

        rooms[roomId] = {
            id: roomId,
            roomName,
            owner: socket.id,
            players: [{ id: socket.id, name: data.name, score: 0, color: idColors[0] }],
            status: 'LOBBY', roundCount: 0, maxRounds: 10,
            currentWord: "", currentDrawerId: null, drawerIndex: -1,
            correctGuessers: [], timer: 0, interval: null, pickTimeout: null,
            maxPlayers: 8,
            isPrivate: !!data.isPrivate,
            password: data.isPrivate ? String(data.password) : null
        };
        socket.join(roomId);
        socket.emit('joined_room', { roomId, roomName, isOwner: true, isPrivate: !!data.isPrivate });
        updateRoomPlayers(roomId);
        io.emit('room_list', getAllRooms());
    });

    // 加入房間（遊戲進行中也可加入，但分數從 0 開始）
    socket.on('join_room', (data) => {
        const room = rooms[data.roomId];
        if (!room) {
            socket.emit('error_msg', '找不到此房間，請確認代碼是否正確');
            return;
        }
        if (room.players.length >= room.maxPlayers) {
            socket.emit('error_msg', '房間已滿（最多 8 人）');
            return;
        }
        // 私人房驗證密碼
        if (room.isPrivate) {
            if (String(data.password) !== room.password) {
                socket.emit('error_msg', '密碼錯誤，請再試一次');
                return;
            }
        }

        const pColor = idColors[room.players.length % idColors.length];
        room.players.push({ id: socket.id, name: data.name, score: 0, color: pColor });
        socket.join(data.roomId);
        socket.emit('joined_room', { roomId: data.roomId, roomName: room.roomName, isOwner: false, isPrivate: room.isPrivate });
        if (room.status !== 'LOBBY') {
            socket.emit('chat_message', { sender: '系統', text: '你已加入進行中的遊戲，本局以觀戰模式參與，下局起正式計分！', color: '#888' });
        }
        updateRoomPlayers(data.roomId);
        io.emit('room_list', getAllRooms());
    });

    // 房主控制
    socket.on('start_game', (roomId) => {
        const room = rooms[roomId];
        if (room && room.owner === socket.id && room.players.length >= 2) {
            // 清除所有可能殘留的計時器，防止舊回合干擾新遊戲
            clearInterval(room.interval);
            clearTimeout(room.pickTimeout);
            room.interval = null;
            room.pickTimeout = null;

            room.roundCount = 0;
            room.drawerIndex = -1;
            room.currentWord = "";
            room.currentDrawerId = null;
            room.correctGuessers = [];
            room.status = 'CHOOSING';
            room.players.forEach(p => p.score = 0);
            updateRoomPlayers(roomId);
            startNewRound(roomId);
            io.emit('room_list', getAllRooms());
        }
    });

    socket.on('host_end_game', (roomId) => {
        const room = rooms[roomId];
        if (room && room.owner === socket.id) endGame(roomId);
    });

    // 退出處理
    socket.on('leave_room', (roomId) => handleExit(socket, roomId));
    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            if (rooms[roomId].players.find(p => p.id === socket.id)) {
                handleExit(socket, roomId); break;
            }
        }
    });

    // 選題邏輯
    socket.on('pick_word', (data) => {
        const room = rooms[data.roomId];
        if (room && socket.id === room.currentDrawerId && room.status === 'CHOOSING') {
            room.currentWord = data.word;
            startDrawingPhase(data.roomId);
        }
    });

    // 繪圖同步
    socket.on('draw_data', (data) => socket.to(data.roomId).emit('draw_data', data));
    socket.on('fill_canvas', (data) => socket.to(data.roomId).emit('fill_canvas', data));
    socket.on('clear_canvas', (roomId) => {
        const room = rooms[roomId];
        if (room && socket.id === room.currentDrawerId) io.to(roomId).emit('clear_canvas');
    });
    socket.on('undo_canvas', (data) => {
        const room = rooms[data.roomId];
        // 只有出題者可以發送 undo，轉發給其他人
        if (room && socket.id === room.currentDrawerId) {
            socket.to(data.roomId).emit('undo_canvas', { dataURL: data.dataURL });
        }
    });

    // 聊天與猜題邏輯
    socket.on('send_message', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        // 如果遊戲正在進行且不是出題者，且猜中答案
        if (room.status === 'PLAYING' && socket.id !== room.currentDrawerId && data.text === room.currentWord) {
            if (room.correctGuessers.includes(socket.id)) return; // 已經猜中過了
            
            room.correctGuessers.push(socket.id);
            // 分數計算：越快猜中分數越高 (基礎100 + 剩餘時間)
            player.score += (100 + room.timer);
            
            const drawer = room.players.find(p => p.id === room.currentDrawerId);
            if (drawer) drawer.score += 30; // 助攻分

            io.to(data.roomId).emit('chat_message', { sender: '系統', text: `🎉 ${player.name} 猜對了！`, color: 'green' });
            updateRoomPlayers(data.roomId);

            // 檢查是否所有答題者都猜中了
            if (room.correctGuessers.length === room.players.length - 1) {
                endRoundPhase(data.roomId, "所有人都猜中啦！");
            }
        } else {
            io.to(data.roomId).emit('chat_message', { sender: player.name, text: data.text, color: player.color });
        }
    });
});

// --- 輔助函數 ---
function getAllRooms() {
    // 回傳所有房間，私人房不包含密碼
    return Object.values(rooms).map(r => ({
        id: r.id,
        roomName: r.roomName,
        count: r.players.length,
        max: r.maxPlayers,
        status: r.status,
        isPrivate: r.isPrivate
    }));
}

function updateRoomPlayers(roomId) {
    if (rooms[roomId]) io.to(roomId).emit('update_players', rooms[roomId].players);
}

function handleExit(socket, roomId) {
    const room = rooms[roomId];
    if (!room) return;

    const wasDrawer = room.currentDrawerId === socket.id;
    room.players = room.players.filter(p => p.id !== socket.id);
    socket.leave(roomId);

    if (room.players.length === 0) {
        // 房間已空，直接刪除
        clearInterval(room.interval);
        clearTimeout(room.pickTimeout);
        delete rooms[roomId];
        io.emit('room_list', getAllRooms());
        return;
    }

    // 轉移房主
    if (room.owner === socket.id) {
        room.owner = room.players[0].id;
        io.to(room.owner).emit('you_are_owner');
    }

    // 遊戲進行中且人數掉到 1 人以下 → 中止遊戲
    if (room.status !== 'LOBBY' && room.players.length < 2) {
        clearInterval(room.interval);
        clearTimeout(room.pickTimeout);
        room.interval = null;
        room.pickTimeout = null;
        room.status = 'LOBBY';
        room.currentWord = "";
        room.currentDrawerId = null;
        room.correctGuessers = [];
        io.to(roomId).emit('game_aborted'); // 通知前端
        io.to(roomId).emit('chat_message', { sender: '系統', text: '玩家人數不足，遊戲已中止，等待更多玩家加入。', color: 'orange' });
        updateRoomPlayers(roomId);
        io.emit('room_list', getAllRooms());
        return;
    }

    // 若出題者離開，且遊戲在進行中，跳過這回合
    if (wasDrawer && room.status !== 'LOBBY') {
        clearInterval(room.interval);
        clearTimeout(room.pickTimeout);
        room.interval = null;
        room.pickTimeout = null;
        io.to(roomId).emit('chat_message', { sender: '系統', text: '出題者已離開，跳過本回合。', color: 'orange' });
        setTimeout(() => startNewRound(roomId), 2000);
    }

    updateRoomPlayers(roomId);
    io.emit('room_list', getAllRooms());
}

function startNewRound(roomId) {
    const room = rooms[roomId];
    if(!room) return;
    
    room.roundCount++;
    if (room.roundCount > room.maxRounds) return endGame(roomId);

    room.status = 'CHOOSING';
    room.correctGuessers = [];
    room.drawerIndex = (room.drawerIndex + 1) % room.players.length;
    const drawer = room.players[room.drawerIndex];
    room.currentDrawerId = drawer.id;

    // 清除畫布 (在回合一開始才清)
    io.to(roomId).emit('clear_canvas');
    
    const options = [
        questionBank[Math.floor(Math.random() * questionBank.length)],
        questionBank[Math.floor(Math.random() * questionBank.length)]
    ];

    io.to(roomId).emit('round_start', { drawerName: drawer.name, round: room.roundCount, maxRounds: room.maxRounds });
    io.to(drawer.id).emit('select_word_options', options);

    // 10秒選題時間
    let pickTime = 10;
    clearInterval(room.interval);
    room.interval = setInterval(() => {
        pickTime--;
        io.to(roomId).emit('timer_tick', pickTime);
        if (pickTime <= 0) {
            clearInterval(room.interval);
            room.interval = null;
            io.to(roomId).emit('chat_message', { sender: '系統', text: `${drawer.name} 未在時間內選題，跳過回合。`, color: 'orange' });
            // 存起來，才能在必要時取消
            room.pickTimeout = setTimeout(() => {
                room.pickTimeout = null;
                startNewRound(roomId);
            }, 2000);
        }
    }, 1000);
}

function startDrawingPhase(roomId) {
    const room = rooms[roomId];
    clearInterval(room.interval);
    room.status = 'PLAYING';
    room.timer = 180;
    io.to(roomId).emit('round_playing', { drawerId: room.currentDrawerId });
    io.to(room.currentDrawerId).emit('your_word', room.currentWord);

    room.interval = setInterval(() => {
        // 每猜對一人，計時器額外多扣 1 秒（最多加速到 -4/s）
        const speedBonus = Math.min(room.correctGuessers.length, 3);
        room.timer -= (1 + speedBonus);
        if (room.timer < 0) room.timer = 0;
        io.to(roomId).emit('timer_tick', room.timer);
        if (room.timer <= 0) endRoundPhase(roomId, "時間到！");
    }, 1000);
}

function endRoundPhase(roomId, reasonMsg) {
    const room = rooms[roomId];
    clearInterval(room.interval);
    room.status = 'WAITING';
    
    // 顯示答案，進入 10 秒倒數
    io.to(roomId).emit('show_answer', { word: room.currentWord, reason: reasonMsg });
    
    let gapTime = 10;
    room.interval = setInterval(() => {
        gapTime--;
        io.to(roomId).emit('timer_tick', gapTime);
        if(gapTime <= 0) {
            clearInterval(room.interval);
            startNewRound(roomId);
        }
    }, 1000);
}

function endGame(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    clearInterval(room.interval);
    clearTimeout(room.pickTimeout);
    room.interval = null;
    room.pickTimeout = null;
    room.status = 'LOBBY'; // 關鍵：狀態改回 LOBBY，讓新玩家可以進來

    const winners = [...room.players].sort((a,b) => b.score - a.score).slice(0,3);

    // 通知所有人遊戲結束，並傳送排名
    io.to(roomId).emit('game_over', winners);

    // 立即更新大廳列表，讓其他人看到這間房現在可以進了
    io.emit('room_list', getAllRooms());
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`伺服器運行中: Port ${PORT}`));