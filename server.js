const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;
const UNLOCK_PIN = '8989'; // 解除用の暗証番号を設定

// uploads ディレクトリの作成
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

// Multerの設定（PDFを uploads/shared.pdf として固定名で保存）
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        cb(null, 'shared.pdf');
    }
});
const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('PDFファイルのみアップロード可能です。'), false);
        }
    }
});

// 静的ファイルの提供
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadsDir));

// サーバー状態の管理
let currentPdf = null; // { name: 'filename.pdf', url: '/uploads/shared.pdf' }
let markers = [];
let currentPage = 1;
let isLocked = false;

// PDFアップロード用API
app.post('/upload', upload.single('pdf'), (req, res) => {
    if (isLocked) {
        return res.status(403).json({ error: 'ボードがロックされています。新しいファイルをアップロードするにはロックを解除してください。' });
    }

    if (!req.file) {
        return res.status(400).json({ error: 'ファイルがアップロードされませんでした。' });
    }

    // 新しいPDFがアップロードされたらマーカーをクリア
    markers = [];
    currentPage = 1;
    currentPdf = {
        name: req.file.originalname,
        url: `/uploads/shared.pdf?t=${Date.now()}`,
        timestamp: Date.now()
    };
    isLocked = true;

    // 全クライアントに新しいPDFが配信されたことを通知
    io.emit('pdf-updated', currentPdf);
    io.emit('markers-cleared');
    io.emit('lock-status-updated', isLocked);

    res.json({ success: true, pdf: currentPdf });
});

// Socket.io 通信
const updateConnectionCount = () => {
    io.emit('connection-count-updated', io.engine.clientsCount);
};

io.on('connection', (socket) => {
    console.log(`ユーザーが接続しました: ${socket.id}`);
    updateConnectionCount();

    // 新規接続ユーザーに現在の状態を同期
    if (currentPdf) {
        socket.emit('pdf-initialized', { ...currentPdf, currentPage });
    }
    if (markers.length > 0) {
        socket.emit('markers-initialized', markers);
    }
    socket.emit('lock-status-updated', isLocked);

    // マーカーの追加を受信
    socket.on('add-marker', (markerData) => {
        const getMid = (m) => 
            `${m.page}-${m.type || 'point'}-${Number(m.x).toFixed(2)}-${Number(m.y).toFixed(2)}-` +
            `${Number(m.x2 || 0).toFixed(2)}-${Number(m.y2 || 0).toFixed(2)}-${m.reason}`;
        
        const id = getMid(markerData);
        
        // 重複チェック
        const exists = markers.some(m => getMid(m) === id);
        if (!exists) {
            const timestamp = markerData.createdAt || new Date().toLocaleString('ja-JP', {
                timeZone: 'Asia/Tokyo',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });
            const newMarker = { ...markerData, resolved: false, createdAt: timestamp };
            markers.push(newMarker);
            // 送信者以外を含む全員にブロードキャスト
            io.emit('marker-added', newMarker);
        }
    });

    // マーカーの解決状態を切り替え
    socket.on('toggle-marker-resolved', (markerId) => {
        const marker = markers.find(m => {
            const mId = `${m.page}-${m.type || 'point'}-${Number(m.x).toFixed(2)}-${Number(m.y).toFixed(2)}-` +
                        `${Number(m.x2 || 0).toFixed(2)}-${Number(m.y2 || 0).toFixed(2)}-${m.reason}`;
            return mId === markerId;
        });
        if (marker) {
            marker.resolved = !marker.resolved;
            // 更新された状態を全員に通知
            io.emit('marker-resolved-updated', { id: markerId, resolved: marker.resolved });
        }
    });

    // ページ変更を受信して全員に配信
    socket.on('change-page', (page) => {
        currentPage = page;
        io.emit('page-changed', page);
    });

    // マーカーの全削除を受信
    socket.on('clear-markers', () => {
        markers = [];
        io.emit('markers-cleared');
    });

    // ロック解除を受信
    socket.on('unlock-pdf', (pin) => {
        if (pin === UNLOCK_PIN) {
            isLocked = false;
            io.emit('lock-status-updated', isLocked);
        } else {
            socket.emit('unlock-failed', '暗証番号が正しくありません。');
        }
    });

    socket.on('disconnect', () => {
        console.log(`ユーザーが切断しました: ${socket.id}`);
        updateConnectionCount();
    });
});

server.listen(PORT, () => {
    console.log(`--------------------------------------------------`);
    console.log(`サーバーがポート ${PORT} で起動しました。`);
});
