const questionBank = require('./questions.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const idColors = ['#FF5733', '#33FF57', '#3357FF', '#F333FF', '#FFB833', '#33FFF6', '#8D33FF', '#FF3385'];

let rooms = {}; // 存放所有房間資料

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

io.on('connection', (socket) => {
    console.log('連線:', socket.id);

    // 傳送目前的房間列表給新進玩家
    socket.emit('room_list', getPublicRooms());

    // 創造房間
    socket.on('create_room', (data) => {
        const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[roomId] = {
            id: roomId,
            owner: socket.id,
            players: [{ id: socket.id, name: data.name, score: 0, color: idColors[0] }],
            status: 'LOBBY',
            currentWord: "",
            currentDrawerId: null,
            round: 0,
            timer: 0,
            interval: null
        };
        socket.join(roomId);
        socket.emit('joined_room', { roomId, isOwner: true });
        io.emit('room_list', getPublicRooms());
        updateRoomPlayers(roomId);
    });

    // 加入房間
    socket.on('join_room', (data) => {
        const room = rooms[data.roomId];
        if (room && room.players.length < 5 && room.status === 'LOBBY') {
            const playerColor = idColors[room.players.length % idColors.length];
            room.players.push({ id: socket.id, name: data.name, score: 0, color: playerColor });
            socket.join(data.roomId);
            socket.emit('joined_room', { roomId: data.roomId, isOwner: false });
            updateRoomPlayers(data.roomId);
            io.emit('room_list', getPublicRooms());
        } else {
            socket.emit('error_msg', '房間不存在、已滿員或遊戲已開始');
        }
    });

    // 房主開始遊戲
    socket.on('start_game', (roomId) => {
        const room = rooms[roomId];
        if (room && room.owner === socket.id && room.players.length >= 2) {
            room.round = 0;
            room.players.forEach(p => p.score = 0);
            startNewRound(roomId);
        }
    });

    // 房主強制結束遊戲
    socket.on('host_end_game', (roomId) => {
        const room = rooms[roomId];
        if (room && room.owner === socket.id) endGame(roomId);
    });

    // 退出/斷線處理
    socket.on('leave_room', (roomId) => handleExit(socket, roomId));
    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const index = rooms[roomId].players.findIndex(p => p.id === socket.id);
            if (index !== -1) {
                handleExit(socket, roomId);
                break;
            }
        }
    });

    // 繪圖與對話 (需帶上 roomId)
    socket.on('draw_data', (data) => {
        socket.to(data.roomId).emit('draw_data', data);
    });

    socket.on('clear_canvas', (roomId) => {
        io.to(roomId).emit('clear_canvas');
    });

    socket.on('send_message', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        
        if (room.status === 'PLAYING' && socket.id !== room.currentDrawerId && data.text === room.currentWord) {
            player.score += 100;
            const drawer = room.players.find(p => p.id === room.currentDrawerId);
            if (drawer) drawer.score += 50;
            io.to(data.roomId).emit('chat_message', { sender: '系統', text: `🎉 ${player.name} 猜對了！`, color: 'green' });
            updateRoomPlayers(data.roomId);
            endRound(data.roomId);
        } else {
            io.to(data.roomId).emit('chat_message', { sender: player.name, text: data.text, color: 'black' });
        }
    });

    socket.on('pick_word', (data) => {
        const room = rooms[data.roomId];
        if (room && socket.id === room.currentDrawerId) {
            room.currentWord = data.word;
            startDrawingPhase(data.roomId);
        }
    });
});

// --- 輔助函數 ---

function getPublicRooms() {
    return Object.values(rooms).map(r => ({ id: r.id, count: r.players.length, status: r.status }));
}

function updateRoomPlayers(roomId) {
    const room = rooms[roomId];
    if (room) io.to(roomId).emit('update_players', room.players);
}

function handleExit(socket, roomId) {
    const room = rooms[roomId];
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    socket.leave(roomId);

    if (room.players.length === 0) {
        clearInterval(room.interval);
        delete rooms[roomId];
    } else if (room.owner === socket.id) {
        room.owner = room.players[0].id; // 移交房主
        io.to(room.owner).emit('you_are_owner');
    }
    updateRoomPlayers(roomId);
    io.emit('room_list', getPublicRooms());
}

function startNewRound(roomId) {
    const room = rooms[roomId];
    room.round++;
    if (room.round > 10) return endGame(roomId);

    clearInterval(room.interval);
    room.status = 'CHOOSING';
    const drawer = room.players[(room.round - 1) % room.players.length];
    room.currentDrawerId = drawer.id;

    const options = [questionBank[Math.floor(Math.random() * questionBank.length)], questionBank[Math.floor(Math.random() * questionBank.length)]];
    io.to(roomId).emit('clear_canvas');
    io.to(roomId).emit('round_start', { drawerName: drawer.name, round: room.round });
    io.to(drawer.id).emit('select_word_options', options);

    let pickTime = 10;
    room.interval = setInterval(() => {
        pickTime--;
        if (pickTime <= 0) { room.currentWord = options[0]; startDrawingPhase(roomId); }
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
        room.timer--;
        io.to(roomId).emit('timer_tick', room.timer);
        if (room.timer <= 0) endRound(roomId);
    }, 1000);
}

function endRound(roomId) {
    const room = rooms[roomId];
    clearInterval(room.interval);
    setTimeout(() => { if(rooms[roomId]) startNewRound(roomId); }, 3000);
}

function endGame(roomId) {
    const room = rooms[roomId];
    clearInterval(room.interval);
    const winners = [...room.players].sort((a,b) => b.score - a.score).slice(0,3);
    io.to(roomId).emit('game_over', winners);
    room.status = 'LOBBY';
    setTimeout(() => io.to(roomId).emit('return_to_lobby'), 8000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server Ready'));