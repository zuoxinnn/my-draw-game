const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const questionBank = ["蘋果", "皮卡丘", "殭屍", "實驗室", "小咪", "丹瑜", "外星人", "珍珠奶茶", "鋼琴", "貓咪", "巧克力", "漢堡", "腳踏車", "長頸鹿"];
const idColors = ['#FF5733', '#33FF57', '#3357FF', '#F333FF', '#FFB833', '#33FFF6', '#8D33FF', '#FF3385'];

let players = [];
let gameState = {
    status: 'LOBBY', // LOBBY, CHOOSING, PLAYING, GAMEOVER
    currentWord: "",
    currentDrawerId: null,
    roundCount: 0,
    maxRounds: 10,
    timer: 0,
    interval: null
};

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        const playerColor = idColors[players.length % idColors.length];
        players.push({ id: socket.id, name: name, color: playerColor, score: 0 });
        io.emit('update_players', players);
    });

    socket.on('start_game', () => {
        if (players.length >= 2 && gameState.status === 'LOBBY') {
            gameState.roundCount = 0;
            players.forEach(p => p.score = 0); // 重置分數
            startNewRound();
        }
    });

    socket.on('draw_data', (data) => {
        if (socket.id === gameState.currentDrawerId) socket.broadcast.emit('draw_data', data);
    });

    socket.on('clear_canvas', () => {
        if (socket.id === gameState.currentDrawerId) io.emit('clear_canvas');
    });

    socket.on('pick_word', (word) => {
        if (socket.id === gameState.currentDrawerId && gameState.status === 'CHOOSING') {
            gameState.currentWord = word;
            startDrawingPhase();
        }
    });

    socket.on('send_message', (text) => {
        const player = players.find(p => p.id === socket.id);
        if (!player) return;

        if (gameState.status === 'PLAYING' && socket.id !== gameState.currentDrawerId && text === gameState.currentWord) {
            // 計分邏輯：猜對者 +100，出題者 +50
            player.score += 100;
            const drawer = players.find(p => p.id === gameState.currentDrawerId);
            if (drawer) drawer.score += 50;

            io.emit('chat_message', { sender: '系統', text: `🎉 ${player.name} 猜對了！答案是「${gameState.currentWord}」`, color: 'green' });
            io.emit('update_players', players); // 更新排行榜
            endRound();
        } else {
            io.emit('chat_message', { sender: player.name, text: text, color: 'black' });
        }
    });

    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        io.emit('update_players', players);
    });
});

function startNewRound() {
    gameState.roundCount++;
    if (gameState.roundCount > gameState.maxRounds) {
        endGame();
        return;
    }

    clearInterval(gameState.interval);
    gameState.status = 'CHOOSING';
    
    // 輪流出題邏輯：按進入順序輪流
    const drawer = players[(gameState.roundCount - 1) % players.length];
    gameState.currentDrawerId = drawer.id;

    const options = [
        questionBank[Math.floor(Math.random() * questionBank.length)],
        questionBank[Math.floor(Math.random() * questionBank.length)]
    ];

    io.emit('clear_canvas');
    io.emit('round_start', { 
        drawerName: drawer.name, 
        round: gameState.roundCount, 
        maxRounds: gameState.maxRounds 
    });
    io.to(drawer.id).emit('select_word_options', options);

    // 10秒選題倒數
    let pickTime = 10;
    gameState.interval = setInterval(() => {
        pickTime--;
        if (pickTime <= 0) {
            gameState.currentWord = options[0];
            startDrawingPhase();
        }
    }, 1000);
}

function startDrawingPhase() {
    clearInterval(gameState.interval);
    gameState.status = 'PLAYING';
    gameState.timer = 180;
    
    io.emit('round_playing', { drawerId: gameState.currentDrawerId, timer: gameState.timer });
    io.to(gameState.currentDrawerId).emit('your_word', gameState.currentWord);

    gameState.interval = setInterval(() => {
        gameState.timer--;
        io.emit('timer_tick', gameState.timer);
        if (gameState.timer <= 0) {
            io.emit('chat_message', { sender: '系統', text: `時間到！答案是「${gameState.currentWord}」`, color: 'red' });
            endRound();
        }
    }, 1000);
}

function endRound() {
    clearInterval(gameState.interval);
    gameState.status = 'WAITING';
    setTimeout(() => startNewRound(), 3000);
}

function endGame() {
    gameState.status = 'GAMEOVER';
    // 排序找出前三名
    const winners = [...players].sort((a, b) => b.score - a.score).slice(0, 3);
    io.emit('game_over', winners);
    
    // 10秒後回到大廳
    setTimeout(() => {
        gameState.status = 'LOBBY';
        io.emit('return_to_lobby');
    }, 10000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));