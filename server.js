const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const questionBank = ["蘋果", "皮卡丘", "殭屍", "實驗室", "小咪", "丹瑜", "外星人", "珍奶", "鋼琴"];

let players = [];
let gameState = {
    status: 'WAITING', // WAITING, CHOOSING, PLAYING
    currentWord: "",
    currentDrawerId: null,
    timer: 0,
    interval: null
};

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        players.push({ id: socket.id, name: name, score: 0 });
        io.emit('update_players', players);
    });

    // 處理繪圖數據廣播
    socket.on('draw_data', (data) => {
        // 只允許出題者廣播畫布數據
        if (socket.id === gameState.currentDrawerId) {
            socket.broadcast.emit('draw_data', data);
        }
    });

    // 處理清除畫布
    socket.on('clear_canvas', () => {
        if (socket.id === gameState.currentDrawerId) io.emit('clear_canvas');
    });

    // 開始新回合
    socket.on('start_game', () => startNewRound());

    // 出題者選題
    socket.on('pick_word', (word) => {
        if (socket.id === gameState.currentDrawerId && gameState.status === 'CHOOSING') {
            gameState.currentWord = word;
            startDrawingPhase();
        }
    });

    socket.on('send_message', (text) => {
        const player = players.find(p => p.id === socket.id);
        if (gameState.status === 'PLAYING' && socket.id !== gameState.currentDrawerId && text === gameState.currentWord) {
            io.emit('chat_message', { sender: '系統', text: `🎉 ${player.name} 猜對了！答案是「${gameState.currentWord}」`, color: 'green' });
            endRound();
        } else {
            io.emit('chat_message', { sender: player.name || '未知', text: text, color: 'black' });
        }
    });

    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        io.emit('update_players', players);
    });
});

function startNewRound() {
    if (players.length < 2) return;
    clearInterval(gameState.interval);
    
    // 隨機選人與選兩題
    const drawer = players[Math.floor(Math.random() * players.length)];
    gameState.currentDrawerId = drawer.id;
    gameState.status = 'CHOOSING';
    const options = [
        questionBank[Math.floor(Math.random() * questionBank.length)],
        questionBank[Math.floor(Math.random() * questionBank.length)]
    ];

    io.emit('clear_canvas');
    io.emit('round_choosing', { drawerName: drawer.name });
    io.to(drawer.id).emit('select_word_options', options);

    // 10秒內沒選就強迫開始
    let timeLeft = 10;
    gameState.interval = setInterval(() => {
        timeLeft--;
        if (timeLeft <= 0) {
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
    io.emit('round_ended');
    // 5秒後自動下一關
    setTimeout(() => startNewRound(), 5000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Running on port ${PORT}`));