const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// Windowsのレジストリ破損等による「.jsがtext/plainと誤認識されてブラウザにブロックされる問題」の対策
const serveStaticOptions = {
    setHeaders: (res, filepath) => {
        const ext = path.extname(filepath).toLowerCase();
        if (ext === '.js' || filepath.endsWith('.mjs')) {
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        } else if (ext === '.css') {
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
        } else if (ext === '.json') {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
        }
    }
};

// 静的ファイルの提供 (MIMEタイプ対策付き)
app.use(express.static(__dirname, serveStaticOptions));

// サーバー状態の管理
let markers = [];

// Socket.io 通信
io.on('connection', (socket) => {
    console.log(`ユーザーが接続しました: ${socket.id}`);

    // 新規接続ユーザーに現在の状態を同期
    if (markers.length > 0) {
        socket.emit('markers-initialized', markers);
    }

    // マーカーの追加を受信
    socket.on('add-marker', (markerData) => {
        const id = `${Number(markerData.x).toFixed(2)}-${Number(markerData.y).toFixed(2)}-${markerData.reason}`;
        
        // 重複チェック
        const exists = markers.some(m => `${Number(m.x).toFixed(2)}-${Number(m.y).toFixed(2)}-${m.reason}` === id);
        if (!exists) {
            markers.push(markerData);
            // 送信者を含む全員に共有
            io.emit('marker-added', markerData);
        }
    });

    socket.on('disconnect', () => {
        console.log(`ユーザーが切断しました: ${socket.id}`);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`--------------------------------------------------`);
    console.log(` 不明点共有ボード サーバーが起動しました！`);
    console.log(` ローカルアクセス: http://localhost:${PORT}`);
    console.log(` 同じネットワークの他端末からアクセスする場合:`);
    console.log(` http://<あなたのPCのIPアドレス>:${PORT}`);
    console.log(`--------------------------------------------------`);
});
