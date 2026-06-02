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

// PDFアップロード用API
app.post('/upload', upload.single('pdf'), (req, res) => {
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

    // 全クライアントに新しいPDFが配信されたことを通知
    io.emit('pdf-updated', currentPdf);
    io.emit('markers-cleared');

    res.json({ success: true, pdf: currentPdf });
});

// Socket.io 通信
io.on('connection', (socket) => {
    console.log(`ユーザーが接続しました: ${socket.id}`);

    // 新規接続ユーザーに現在の状態を同期
    if (currentPdf) {
        socket.emit('pdf-initialized', { ...currentPdf, currentPage });
    }
    if (markers.length > 0) {
        socket.emit('markers-initialized', markers);
    }

    // マーカーの追加を受信
    socket.on('add-marker', (markerData) => {
        const id = `${markerData.page}-${Number(markerData.x).toFixed(2)}-${Number(markerData.y).toFixed(2)}-${markerData.reason}`;
        
        // 重複チェック
        const exists = markers.some(m => `${m.page}-${Number(m.x).toFixed(2)}-${Number(m.y).toFixed(2)}-${m.reason}` === id);
        if (!exists) {
            markers.push(markerData);
            // 送信者以外を含む全員にブロードキャスト
            io.emit('marker-added', markerData);
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

    socket.on('disconnect', () => {
        console.log(`ユーザーが切断しました: ${socket.id}`);
    });
});

server.listen(PORT, () => {
    console.log(`--------------------------------------------------`);
    console.log(`サーバーがポート ${PORT} で起動しました。`);
});
