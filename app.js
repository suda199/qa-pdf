// --- 0. グローバルエラーキャッチャー（デバッグログ可視化） ---
window.addEventListener('error', function(e) {
    if (e.filename && (e.filename.includes('chrome-extension://') || e.filename.includes('extension'))) {
        return;
    }
    const messageStr = e.message || '';
    if (messageStr.includes('message channel closed') || messageStr.includes('A listener indicated an asynchronous response')) {
        return;
    }

    const consoleEl = document.getElementById('debug-error-console');
    const listEl = document.getElementById('debug-error-list');
    if (consoleEl && listEl) {
        consoleEl.style.display = 'block';
        listEl.innerHTML += `❌ 【JSエラー】: ${e.message}\n   場所: ${e.filename} (${e.lineno}行目:${e.colno}文字目)\n\n`;
    }
});
window.addEventListener('unhandledrejection', function(e) {
    const reasonStr = e.reason ? (e.reason.message || String(e.reason)) : '';
    if (reasonStr.includes('message channel closed') || 
        reasonStr.includes('A listener indicated an asynchronous response') ||
        (e.reason && e.reason.stack && e.reason.stack.includes('chrome-extension://'))) {
        return;
    }

    const consoleEl = document.getElementById('debug-error-console');
    const listEl = document.getElementById('debug-error-list');
    if (consoleEl && listEl) {
        consoleEl.style.display = 'block';
        listEl.innerHTML += `❌ 【非同期エラー (Promise)】: ${e.reason}\n\n`;
    }
});

// --- 1. Socket.io 初期化 ---
let socket;
if (typeof io !== 'undefined') {
    socket = io();
} else {
    console.error("Socket.io が読み込まれていません。");
    socket = { on: () => {}, emit: () => {} };
}

// --- 1.1 PDF.js 設定 ---
const pdfjsLib = window['pdfjs-dist/build/pdf'];
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// --- 2. アプリケーション状態 ---
let selectedData = { x: null, y: null };
let markers = [];
const markerIds = new Set();
let currentPdfRender = null;
let lastPdfUrl = null;
let currentPageNum = 1;
let totalPages = 0;

const sharedBoard = document.getElementById('pdf-container');
const coordDisplay = document.getElementById('coord-display');
const reasonInput = document.getElementById('reason');
const addBtn = document.getElementById('add-btn');
const pdfUpload = document.getElementById('pdf-upload');
const prevBtn = document.getElementById('prev-page');
const nextBtn = document.getElementById('next-page');
const pageInput = document.getElementById('current-page-input');
const totalPagesDisplay = document.getElementById('total-pages-display');

// --- 3. ボードのクリックによる位置選択 ---
sharedBoard.addEventListener('click', (e) => {
    // PDFが読み込まれていない場合は無視
    if (!currentPdfRender) return;

    // マーカー要素自体がクリックされた場合は新規マーカー作成処理を行わない
    if (e.target.classList.contains('marker')) {
        return;
    }

    const rect = sharedBoard.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;

    selectedData = { x, y };
    coordDisplay.innerText = `位置を選択しました (Page ${currentPageNum})`;

    // 一時マーカーの更新
    document.querySelectorAll('.temp-marker').forEach(m => m.remove());
    const temp = document.createElement("div");
    temp.className = "marker temp-marker";
    temp.style.left = x + "%"; 
    temp.style.top = y + "%";
    sharedBoard.appendChild(temp);
});

// --- 3.5 ページナビゲーションの動作 ---
prevBtn.addEventListener('click', () => {
    if (currentPageNum > 1) {
        renderPage(currentPageNum - 1);
    }
});

nextBtn.addEventListener('click', () => {
    if (currentPageNum < totalPages) {
        renderPage(currentPageNum + 1);
    }
});

pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        let val = parseInt(pageInput.value);
        if (isNaN(val) || val < 1) val = 1;
        if (val > totalPages) val = totalPages;
        renderPage(val);
    }
});

// 入力欄からフォーカスが外れたときも現在のページに戻す
pageInput.addEventListener('blur', () => {
    pageInput.value = currentPageNum;
});

// ウィンドウリサイズ時にPDFを再描画してサイズを合わせる
window.addEventListener('resize', () => {
    if (lastPdfUrl) {
        // 連続してリサイズされた時のために少し待機して実行 (デバウンス)
        clearTimeout(window.resizeTimer);
        window.resizeTimer = setTimeout(() => {
            renderPage(currentPageNum);
        }, 200);
    }
});

// --- 4. マーカー追加 (自分・他人共通) ---
function addMarkerToUI(x, y, reason, page, resolved = false) {
    const targetPage = page || currentPageNum;
    const id = `${targetPage}-${Number(x).toFixed(2)}-${Number(y).toFixed(2)}-${reason}`;
    if (markerIds.has(id)) return;
    markerIds.add(id);

    const markerData = { x, y, reason, page: targetPage, resolved };
    
    // 既存の同じ位置・内容のデータがあれば上書き、なければ追加
    const existingIdx = markers.findIndex(m => 
        m.page === targetPage && m.x === x && m.y === y && m.reason === reason
    );
    if (existingIdx !== -1) return;

    markers.push(markerData);

    refreshMarkersUI();
}

function refreshMarkersUI() {
    // 現在のボード上のマーカーを一旦クリア（一時マーカー以外）
    document.querySelectorAll('.marker:not(.temp-marker)').forEach(m => m.remove());
    
    // 現在のページに属するマーカーのみを描画
    markers.filter(m => m.page === currentPageNum).forEach(m => {
        const marker = document.createElement("div");
        marker.className = "marker";
        marker.style.left = m.x + "%";
        marker.style.top = m.y + "%";
        marker.setAttribute("data-reason", m.reason);
        
        marker.addEventListener('click', (e) => {
            e.stopPropagation();
            alert(`📍 [Page ${m.page}] 質問内容:\n${m.reason}`);
        });

        sharedBoard.appendChild(marker);
    });
    updateMarkerListUI();

    // ブラウザのローカルストレージにバックアップ保存
    localStorage.setItem('wakawaka_markers_backup', JSON.stringify(markers));
}

// --- 4.5 PDFレンダリング処理 ---
async function loadPdf(pdfUrl, startPage = 1) {
    try {
        lastPdfUrl = pdfUrl;
        const loadingTask = pdfjsLib.getDocument(pdfUrl);
        currentPdfRender = await loadingTask.promise;
        totalPages = currentPdfRender.numPages;
        renderPage(startPage);
    } catch (err) {
        console.error("PDFの読み込みに失敗しました:", err);
    }
}

async function renderPage(pageNum) {
    if (!currentPdfRender) return;
    currentPageNum = pageNum;

    try {
        const page = await currentPdfRender.getPage(pageNum);
        const canvas = document.getElementById('pdf-canvas');
        const context = canvas.getContext('2d');

        // ボードの幅（パディングを除く）に合わせてスケーリング
        const container = document.getElementById('shared-board');
        const availableWidth = container.clientWidth - 40; // 左右パディング分を引く
        
        const unscaledViewport = page.getViewport({ scale: 1 });
        const scale = availableWidth / unscaledViewport.width;
        const scaledViewport = page.getViewport({ scale: scale });

        canvas.height = scaledViewport.height;
        canvas.width = scaledViewport.width;

        const renderContext = {
            canvasContext: context,
            viewport: scaledViewport
        };
        await page.render(renderContext).promise;
        
        if (pageInput) pageInput.value = pageNum;
        if (totalPagesDisplay) totalPagesDisplay.innerText = totalPages;
        refreshMarkersUI();
    } catch (err) {
        console.error("ページの描画に失敗しました:", err);
    }
}

function updateMarkerListUI() {
    const list = document.getElementById("marker-list");
    document.getElementById("marker-count").innerText = markers.length;
    if (markers.length === 0) {
        list.innerHTML = '<div style="color:#64748b;font-style:italic;">まだマークはありません。</div>';
        return;
    }
    
    list.innerHTML = '';
    markers.forEach((m, index) => {
        const mId = `${m.page}-${Number(m.x).toFixed(2)}-${Number(m.y).toFixed(2)}-${m.reason}`;
        const item = document.createElement('div');
        item.className = `marker-item ${m.resolved ? 'resolved' : ''}`;
        item.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:start;">
                <div class="marker-info">PAGE ${m.page}</div>
                <button class="resolve-btn small-btn" style="padding: 2px 6px !important;">
                    ${m.resolved ? '↩️ 未解決に戻す' : '✅ 解決済みにする'}
                </button>
            </div>
            <div class="marker-text" style="${m.resolved ? 'text-decoration: line-through; color: var(--text-secondary);' : ''}">${m.reason}</div>
        `;

        // 解決ボタンのクリックイベント
        item.querySelector('.resolve-btn').onclick = (e) => {
            e.stopPropagation();
            socket.emit('toggle-marker-resolved', mId);
        };

        // クリックで該当ページへ移動
        item.onclick = () => { if(!m.resolved) renderPage(m.page); };
        list.appendChild(item);
    });
}

function clearAllMarkersUI() {
    markers = [];
    markerIds.clear();
    document.querySelectorAll('.marker').forEach(m => m.remove());
    updateMarkerListUI();
}

// --- 5. 自分のマーク送信 ---
addBtn.addEventListener("click", () => {
    const reason = reasonInput.value.trim();
    if (selectedData.x === null || !reason) {
        return alert("ボード上をクリックして場所を選択し、質問内容を入力してください。");
    }

    const markerData = {
        x: selectedData.x,
        y: selectedData.y,
        reason: reason,
        page: currentPageNum
    };

    // サーバーへ送信（リアルタイム共有）
    socket.emit('add-marker', markerData);

    // 入力欄をクリア
    document.querySelectorAll('.temp-marker').forEach(m => m.remove());
    reasonInput.value = "";
    selectedData = { x: null, y: null };
    coordDisplay.innerText = "ボードをクリックして場所を指定してください";
});

// PDFアップロードイベント
pdfUpload.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('pdf', file);

    try {
        const response = await fetch('/upload', {
            method: 'POST',
            body: formData
        });
        const result = await response.json();
        if (!result.success) alert("アップロードに失敗しました");
    } catch (err) {
        console.error("Upload error:", err);
    }
});

// --- 6. 同期イベント受信 ---

// 1. ネットワーク監視
socket.on('connect', () => {
    const info = document.getElementById('network-info-status');
    if (info) info.innerText = "ネットワーク: 接続中 (リアルタイム同期)";
});

socket.on('disconnect', () => {
    const info = document.getElementById('network-info-status');
    if (info) info.innerText = "ネットワーク: 切断されました。再接続中...";
});

// 2. PDF更新受信
socket.on('pdf-initialized', (pdfData) => {
    if (pdfData && pdfData.url) {
        loadPdf(pdfData.url, pdfData.currentPage || 1);
    }
});

socket.on('pdf-updated', (pdfData) => {
    loadPdf(pdfData.url, 1);
});

// 2. マーカー個別受信
socket.on('marker-added', (data) => {
    if (data) {
        addMarkerToUI(data.x, data.y, data.reason, data.page, data.resolved);
    }
});

// 3. マーカー解決状態の更新受信
socket.on('marker-resolved-updated', (data) => {
    const marker = markers.find(m => 
        `${m.page}-${Number(m.x).toFixed(2)}-${Number(m.y).toFixed(2)}-${m.reason}` === data.id
    );
    if (marker) {
        marker.resolved = data.resolved;
        refreshMarkersUI();
    }
});

// 3. 接続時：初期マーカー受信
socket.on('markers-initialized', (markersList) => {
    clearAllMarkersUI();
    if (markersList) {
        markersList.forEach(m => {
            addMarkerToUI(m.x, m.y, m.reason, m.page, m.resolved);
        });
    }

    // サーバーが空っぽで、かつブラウザにバックアップがある場合に復元ボタンを表示
    const backup = localStorage.getItem('wakawaka_markers_backup');
    const restoreArea = document.getElementById('storage-restore-area');
    if (markers.length === 0 && backup && JSON.parse(backup).length > 0) {
        restoreArea.style.display = 'block';
    } else if (restoreArea) {
        restoreArea.style.display = 'none';
    }
});

// 5. ロック状態の同期
socket.on('lock-status-updated', (isLocked) => {
    const lockUI = document.getElementById('lock-control-ui');
    const uploadInput = document.getElementById('pdf-upload');
    
    if (isLocked) {
        if (uploadInput) uploadInput.disabled = true;
        if (lockUI) lockUI.style.display = 'flex';
    } else {
        if (uploadInput) uploadInput.disabled = false;
        if (lockUI) lockUI.style.display = 'none';
    }
});

document.getElementById('unlock-btn')?.addEventListener('click', () => {
    socket.emit('unlock-pdf');
});

// 4. マーカー一括クリア
socket.on('markers-cleared', () => {
    clearAllMarkersUI();
});

// --- 7. 保存・読込 ---
document.getElementById("export-btn").addEventListener("click", () => {
    if (markers.length === 0) return alert("保存するマークがありません。");
    const blob = new Blob([JSON.stringify(markers, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "markers.json";
    a.click();
});

document.getElementById("import-btn").addEventListener("click", () => {
    document.getElementById("import-file").click();
});

document.getElementById("import-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const imported = JSON.parse(e.target.result);
            if (!Array.isArray(imported)) throw new Error("Invalid format");

            // データを一件ずつ送信
            imported.forEach(m => {
                const markerData = {
                    x: m.x,
                    y: m.y,
                    reason: m.reason,
                    page: m.page || 1
                };
                socket.emit('add-marker', markerData);
            });
        } catch(err) { 
            alert("ファイルの形式が正しくありません。正しいJSONファイルを選択してください。"); 
        }
    };
    reader.readAsText(file);
});

// --- 8. Render.com スリープ防止機能 (10分おきに通信) ---
function keepServerAlive() {
    // サーバーのルートへfetchリクエストを送信してアクティブ状態を維持
    fetch('/')
        .then(() => {
            const now = new Date().toLocaleTimeString();
            console.log(`[Keep-Alive] サーバーに信号を送信しました: ${now}`);
        })
        .catch(err => console.error("[Keep-Alive] 通信エラー:", err));
}
setInterval(keepServerAlive, 1000 * 60 * 10); // 10分ごとに実行