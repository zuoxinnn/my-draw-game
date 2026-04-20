// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 👇 👇 👇 你的專屬題庫填寫區 👇 👇 👇
const questionBank = [
    "蘋果", 
    "皮卡丘", 
    "殭屍", 
    "實驗室", 
    "小咪", 
    "丹瑜", 
    "外星人"
];
// 👆 👆 👆 你可以在這裡隨意新增或修改字串 👆 👆 👆

let players = [];
let currentWord = "";
let currentDrawerId = null;

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

io.on('connection', (socket) => {
    console.log('新玩家加入:', socket.id);
    
    // 玩家設定暱稱並加入房間
    socket.on('join', (name) => {
        players.push({ id: socket.id, name: name });
        io.emit('update_players', players);
    });

    // 任何人按下「開始/下一回合」
    socket.on('start_round', () => {
        if (players.length < 2) {
            socket.emit('chat_message', { sender: '系統', text: '至少需要 2 人才能開始遊戲！', color: 'red' });
            return;
        }

        // 隨機抽題目與出題者
        currentWord = questionBank[Math.floor(Math.random() * questionBank.length)];
        const drawerIndex = Math.floor(Math.random() * players.length);
        currentDrawerId = players[drawerIndex].id;
        const drawerName = players[drawerIndex].name;

        // 廣播給所有人遊戲開始的訊息
        io.emit('round_started', { drawerName: drawerName });

        // 【核心邏輯】只把題目發給出題者！
        io.to(currentDrawerId).emit('your_word', currentWord);
    });

    // 處理聊天與猜題
    socket.on('send_message', (text) => {
        const player = players.find(p => p.id === socket.id);
        if (!player) return;

        // 檢查是否猜中 (出題者不能自己猜)
        if (socket.id !== currentDrawerId && text === currentWord) {
            io.emit('chat_message', { 
                sender: '系統', 
                text: `🎉 恭喜 ${player.name} 猜對了！答案是「${currentWord}」`, 
                color: 'green' 
            });
            currentWord = ""; // 重置題目防止重複猜
            currentDrawerId = null;
        } else {
            // 一般對話
            io.emit('chat_message', { sender: player.name, text: text, color: 'black' });
        }
    });

    // 玩家離開
    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        io.emit('update_players', players);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`伺服器運行中，連接埠：${PORT}`);
});