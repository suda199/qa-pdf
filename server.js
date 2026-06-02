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
app.use('/uploads', express.static(uploadsDir));

// pdfjs-dist のローカル静的配信 (MIMEタイプ対策付き)
app.use('/pdfjs', express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build'), serveStaticOptions));
app.use('/pdfjs-cmaps', express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'cmaps')));

// サーバー状態の管理
let currentPdf = null; 
const initialPdfPath = path.join(uploadsDir, 'shared.pdf');
console.log(`[Startup] checking initial PDF path: ${initialPdfPath}`);
if (fs.existsSync(initialPdfPath)) {
    currentPdf = {
        name: 'shared.pdf',
        url: '/uploads/shared.pdf',
        timestamp: fs.statSync(initialPdfPath).mtimeMs
    };
    console.log(`[Startup] Found initial PDF:`, currentPdf);
} else {
    console.log(`[Startup] No initial PDF found at path.`);
}
let markers = [];

// PDFアップロード用API
app.post('/upload', upload.single('pdf'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'ファイルがアップロードされませんでした。' });
    }

    // 新しいPDFがアップロードされたらマーカーをクリア
    markers = [];
    currentPdf = {
        name: req.file.originalname,
        url: '/uploads/shared.pdf',
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
        console.log(`[Socket] Sending pdf-initialized to ${socket.id}:`, currentPdf);
        socket.emit('pdf-initialized', currentPdf);
    } else {
        console.log(`[Socket] No current PDF to send to ${socket.id}`);
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

    socket.on('disconnect', () => {
        console.log(`ユーザーが切断しました: ${socket.id}`);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`--------------------------------------------------`);
    console.log(` qa-pdf サーバーが起動しました！`);
    console.log(` ローカルアクセス: http://localhost:${PORT}`);
    console.log(` 同じネットワークの他端末からアクセスする場合:`);
    console.log(` http://<あなたのPCのIPアドレス>:${PORT}`);
    console.log(`--------------------------------------------------`);
});
