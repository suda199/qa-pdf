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
    const errorMsg = "⚠️ サーバー経由でアクセスされていません。\n\n" +
                     "ブラウザのURL入力欄に以下を入力してアクセスしてください：\n\n" +
                     "http://localhost:3000";
    alert(errorMsg);
    console.error(errorMsg);
    socket = { on: () => {}, emit: () => {} };
}

// --- 2. アプリケーション状態 ---
let selectedData = { x: null, y: null };
let markers = [];
const markerIds = new Set();

const sharedBoard = document.getElementById('shared-board');
const coordDisplay = document.getElementById('coord-display');
const reasonInput = document.getElementById('reason');
const addBtn = document.getElementById('add-btn');

// --- 3. ボードのクリックによる位置選択 ---
sharedBoard.addEventListener('click', (e) => {
    // マーカー要素自体がクリックされた場合は新規マーカー作成処理を行わない
    if (e.target.classList.contains('marker')) {
        return;
    }

    const rect = sharedBoard.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;

    selectedData = { x, y };
    coordDisplay.innerText = `X: ${x.toFixed(1)}%, Y: ${y.toFixed(1)}%`;

    // 一時マーカーの更新
    document.querySelectorAll('.temp-marker').forEach(m => m.remove());
    const temp = document.createElement("div");
    temp.className = "marker temp-marker";
    temp.style.left = x + "%"; 
    temp.style.top = y + "%";
    sharedBoard.appendChild(temp);
});

// --- 4. マーカー追加 (自分・他人共通) ---
function addMarkerToUI(x, y, reason) {
    const id = `${Number(x).toFixed(2)}-${Number(y).toFixed(2)}-${reason}`;
    if (markerIds.has(id)) return;
    markerIds.add(id);

    const markerData = { x, y, reason };
    markers.push(markerData);

    // ボード上にマーカーを配置
    const marker = document.createElement("div");
    marker.className = "marker";
    marker.style.left = x + "%";
    marker.style.top = y + "%";
    marker.setAttribute("data-reason", reason);
    
    // マーカークリック時に内容をアラート表示
    marker.addEventListener('click', (e) => {
        e.stopPropagation();
        alert(`📍 質問内容:\n${reason}`);
    });

    sharedBoard.appendChild(marker);
    updateMarkerListUI();
}

function updateMarkerListUI() {
    const list = document.getElementById("marker-list");
    document.getElementById("marker-count").innerText = markers.length;
    if (markers.length === 0) {
        list.innerHTML = '<div style="color:#64748b;font-style:italic;">まだマークはありません。</div>';
        return;
    }
    list.innerHTML = markers.map(m => `
        <div class="marker-item">
            <strong>座標 (X:${Number(m.x).toFixed(1)}%, Y:${Number(m.y).toFixed(1)}%):</strong> ${m.reason}
        </div>
    `).join('');
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
        reason: reason
    };

    // サーバーへ送信（リアルタイム共有）
    socket.emit('add-marker', markerData);

    // 入力欄をクリア
    document.querySelectorAll('.temp-marker').forEach(m => m.remove());
    reasonInput.value = "";
    selectedData = { x: null, y: null };
    coordDisplay.innerText = "未選択 (ボードをクリック)";
});

// --- 6. 同期イベント受信 ---

// 1. ネットワーク監視
socket.on('connect', () => {
    const info = document.getElementById('network-info');
    if (info) info.innerText = "ネットワーク: 接続中 (リアルタイム同期)";
});

socket.on('disconnect', () => {
    const info = document.getElementById('network-info');
    if (info) info.innerText = "ネットワーク: 切断されました。再接続中...";
});

// 2. マーカー個別受信
socket.on('marker-added', (data) => {
    if (data) {
        addMarkerToUI(data.x, data.y, data.reason);
    }
});

// 3. 接続時：初期マーカー受信
socket.on('markers-initialized', (markersList) => {
    clearAllMarkersUI();
    if (markersList) {
        markersList.forEach(m => {
            addMarkerToUI(m.x, m.y, m.reason);
        });
    }
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
            imported.forEach(m => {
                const markerData = {
                    x: m.x,
                    y: m.y,
                    reason: m.reason
                };
                socket.emit('add-marker', markerData);
            });
        } catch(err) { alert("形式が正しくありません"); }
    };
    reader.readAsText(file);
});