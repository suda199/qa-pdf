// --- 1. pdf.js 初期化 (ローカルに切り替えてオフライン対応を完全保証) ---
if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.js';
} else {
    console.error("pdfjsLib が読み込まれていません。自サーバーの /pdfjs/pdf.min.js が正しく読み込まれているか確認してください。");
}

// --- 2. Socket.io 初期化（file://アクセス対策） ---
let socket;
if (typeof io !== 'undefined') {
    socket = io();
} else {
    const errorMsg = "⚠️ サーバー経由でアクセスされていません。\n\n" +
                     "HTMLファイルを直接ダブルクリック（file://）で開くと動作しません。\n" +
                     "ブラウザのURL入力欄に以下を入力してアクセスしてください：\n\n" +
                     "http://localhost:3000";
    alert(errorMsg);
    console.error(errorMsg);
    // スクリプト継続のためのモック
    socket = {
        on: () => {},
        emit: () => {}
    };
}

// --- 3. アプリケーション状態 ---
let currentPdf = null;
let selectedData = { page: null, x: null, y: null };
let markers = []; // 受信したマーカー
let isPdfLoading = false;
const renderedPages = new Set();
const markerIds = new Set();

// 遅延レンダリング用の監視インスタンス
let pageObserver = null;

// --- 4. ドラッグ＆ドロップ ＆ ファイル選択による自動共有 ---
const shareBox = document.getElementById('pdf-share-box');
const fileInput = document.getElementById('pdf-upload');

// ドラッグホバー時のエフェクト
shareBox.addEventListener('dragover', (e) => {
    e.preventDefault();
    shareBox.classList.add('dragover');
});

shareBox.addEventListener('dragleave', () => {
    shareBox.classList.remove('dragover');
});

shareBox.addEventListener('drop', (e) => {
    e.preventDefault();
    shareBox.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0 && files[0].type === 'application/pdf') {
        uploadAndSharePdf(files[0]);
    } else {
        alert("PDFファイルのみドロップ可能です。");
    }
});

// ファイル選択時
fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        uploadAndSharePdf(file);
    }
});

// PDFファイルをアップロードして全員に自動共有
async function uploadAndSharePdf(file) {
    // 1. ローカルプレビュー
    // 最もブラウザ互換性が高く、メモリ消費量が少ない ArrayBuffer 方式を採用
    const reader = new FileReader();
    reader.onload = async function() {
        const arrayBuffer = this.result;
        // ArrayBufferを直接 pdf.js に渡して一瞬でロード
        await loadPdf({ data: arrayBuffer });
        document.getElementById('lock-indicator').style.display = 'block';
        document.getElementById('shared-pdf-name').innerText = file.name;
    };
    reader.readAsArrayBuffer(file);

    // 2. サーバーにアップロードして他のメンバーへ自動共有
    const formData = new FormData();
    formData.append('pdf', file);

    const shareText = shareBox.querySelector('.share-text');
    const originalText = shareText.innerHTML;
    shareText.innerHTML = "<strong>PDFを自動配信中... 🚀</strong>";

    try {
        const response = await fetch('/upload', {
            method: 'POST',
            body: formData
        });
        if (response.ok) {
            shareText.innerHTML = originalText;
            // サーバー側で Socket.io の 'pdf-updated' が配信され、他全員に自動描画されます
        } else {
            const errData = await response.json();
            alert("自動共有エラー: " + (errData.error || "アップロードに失敗しました。"));
            shareText.innerHTML = originalText;
        }
    } catch (err) {
        console.error(err);
        alert("サーバーとの通信に失敗しました。");
        shareText.innerHTML = originalText;
    }
}

// --- 5. PDF描画ロジック（超軽量遅延ロード対応） ---
async function loadPdf(pdfSource) {
    if (isPdfLoading) return;
    isPdfLoading = true;
    try {
        // PDFが読み込まれたらマーク作成用フォームを表示
        document.getElementById('form-content').style.display = 'block';
        
        const container = document.getElementById("pdf-container");
        container.innerHTML = '<div style="color:#94a3b8;text-align:center;padding:20px;">PDFを解析中...</div>';
        
        renderedPages.clear();

        // 既存の Observer があれば切断
        if (pageObserver) {
            pageObserver.disconnect();
        }

        const loadingTask = pdfjsLib.getDocument(pdfSource);
        currentPdf = await loadingTask.promise;
        container.innerHTML = ""; 

        // 遅延レンダリング用の IntersectionObserver の初期化
        // 画面外 600px に入った時点で先行レンダリングを開始し、ユーザーを待たせないようにする
        const observerOptions = {
            root: container,
            rootMargin: "600px 0px",
            threshold: 0.01
        };

        pageObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const pageNum = parseInt(entry.target.dataset.page, 10);
                    renderPage(pageNum, entry.target);
                    pageObserver.unobserve(entry.target); // 描画完了したら監視を解除して負荷低減
                }
            });
        }, observerOptions);

        // まず全ページの「プレースホルダー枠」を一瞬で作成し、スクロールバーを完成させる
        for (let i = 1; i <= currentPdf.numPages; i++) {
            const pageContainer = document.createElement("div");
            pageContainer.className = "pdf-page-container";
            pageContainer.dataset.page = i;
            
            // 初期の仮サイズを設定 (A4に近いアスペクト比)
            pageContainer.style.width = "100%";
            pageContainer.style.maxWidth = "800px";
            pageContainer.style.height = "1130px"; 
            pageContainer.style.display = "flex";
            pageContainer.style.justifyContent = "center";
            pageContainer.style.alignItems = "center";
            pageContainer.style.background = "#1e293b";
            pageContainer.innerHTML = `<div style="color:#64748b; font-size:0.9rem;">${i} / ${currentPdf.numPages} ページ目を読み込み中...</div>`;
            
            container.appendChild(pageContainer);

            // このプレースホルダーのスクロール監視を開始
            pageObserver.observe(pageContainer);
        }
    } catch (err) {
        console.error(err);
        alert("PDFの読み込みに失敗しました。ファイルが破損しているか、対応していない形式です。");
    } finally {
        isPdfLoading = false;
    }
}

// 画面内に入った特定のページのみを実描画する関数
async function renderPage(pageNum, pageContainer) {
    if (renderedPages.has(pageNum)) return;
    renderedPages.add(pageNum);

    try {
        const page = await currentPdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1.5 });

        // コンテナのサイズを実アスペクト比に修正し、中央揃えをリセット
        pageContainer.style.width = viewport.width + "px";
        pageContainer.style.height = viewport.height + "px";
        pageContainer.style.display = "block";
        pageContainer.style.background = "white";
        pageContainer.innerHTML = ""; // 読み込み中文字をクリア

        const canvas = document.createElement("canvas");
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        pageContainer.appendChild(canvas);

        const context = canvas.getContext("2d");
        await page.render({ canvasContext: context, viewport: viewport }).promise;
        
        // 描画完了後、既存のマーカーを上に配置
        renderExistingMarkersForPage(pageNum, pageContainer);

        // ページクリックによるマーカー追加ハンドラー登録
        pageContainer.addEventListener("click", (e) => {
            const rect = pageContainer.getBoundingClientRect();
            const x = ((e.clientX - rect.left) / rect.width) * 100;
            const y = ((e.clientY - rect.top) / rect.height) * 100;
            selectedData = { page: pageNum, x, y, container: pageContainer };
            document.getElementById("page-display").innerText = pageNum + "ページ目";
            
            // 一時マーカーの更新
            document.querySelectorAll('.temp-marker').forEach(m => m.remove());
            const temp = document.createElement("div");
            temp.className = "marker temp-marker";
            temp.style.left = x + "%"; 
            temp.style.top = y + "%";
            pageContainer.appendChild(temp);
        });

    } catch (err) {
        console.error(`ページ ${pageNum} レンダリングエラー:`, err);
        pageContainer.innerHTML = `<div style="color:#ef4444; font-size:0.85rem; padding: 20px;">ページの描画に失敗しました。</div>`;
    }
}

// --- 6. マーカー追加 (自分・他人共通) ---
function addMarkerToUI(page, x, y, reason) {
    const id = `${page}-${Number(x).toFixed(2)}-${Number(y).toFixed(2)}-${reason}`;
    if (markerIds.has(id)) return;
    markerIds.add(id);

    const markerData = { page, x, y, reason };
    markers.push(markerData);

    // 該当ページがすでに描画済みなら即座に配置
    const container = document.querySelector(`.pdf-page-container[data-page="${page}"]`);
    // 描画済み（かつ読み込み中テキストがクリアされている場合のみ追加可能）
    if (container && renderedPages.has(page)) {
        const marker = document.createElement("div");
        marker.className = "marker";
        marker.style.left = x + "%";
        marker.style.top = y + "%";
        marker.setAttribute("data-reason", reason);
        container.appendChild(marker);
    }
    updateMarkerListUI();
}

function renderExistingMarkersForPage(pageNum, container) {
    markers.forEach(m => {
        if (m.page === pageNum) {
            const marker = document.createElement("div");
            marker.className = "marker";
            marker.style.left = m.x + "%";
            marker.style.top = m.y + "%";
            marker.setAttribute("data-reason", m.reason);
            container.appendChild(marker);
        }
    });
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
            <strong>P.${m.page}:</strong> ${m.reason}
        </div>
    `).join('');
}

function clearAllMarkersUI() {
    markers = [];
    markerIds.clear();
    document.querySelectorAll('.marker').forEach(m => m.remove());
    updateMarkerListUI();
}

// --- 7. 自分のマーク送信 ---
document.getElementById("add-btn").addEventListener("click", () => {
    const reason = document.getElementById("reason").value;
    if (!selectedData.page || !reason) return alert("場所を選択し、理由を入力してください。");

    const markerData = {
        page: selectedData.page,
        x: selectedData.x,
        y: selectedData.y,
        reason: reason
    };

    // サーバーへ送信（サーバー経由で全員に共有される）
    socket.emit('add-marker', markerData);

    document.querySelectorAll('.temp-marker').forEach(m => m.remove());
    document.getElementById("reason").value = "";
    selectedData = { page: null, x: null, y: null };
    document.getElementById("page-display").innerText = "未選択";
});

// --- 8. 同期イベント受信 ---

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
    if (data && typeof data.page === 'number') {
        addMarkerToUI(data.page, data.x, data.y, data.reason);
    }
});

// 3. 接続時：初期マーカー受信
socket.on('markers-initialized', (markersList) => {
    markersList.forEach(m => {
        addMarkerToUI(m.page, m.x, m.y, m.reason);
    });
});

// 4. マーカー一括クリア
socket.on('markers-cleared', () => {
    clearAllMarkersUI();
});

// 5. 接続時：すでに配信中のPDFがある場合
socket.on('pdf-initialized', async (pdf) => {
    if (pdf && pdf.url) {
        document.getElementById('lock-indicator').style.display = 'block';
        document.getElementById('shared-pdf-name').innerText = pdf.name;
        await loadPdf(pdf.url);
    }
});

// 6. 新しいPDFが共有された場合
socket.on('pdf-updated', async (pdf) => {
    document.getElementById('lock-indicator').style.display = 'block';
    document.getElementById('shared-pdf-name').innerText = pdf.name;

    const status = document.getElementById("sync-status");
    if (status) {
        status.style.display = "block";
        status.innerText = `🔄 新しいPDF「${pdf.name}」を受信しました。描画中...`;
    }
    
    // マーカーの初期化
    clearAllMarkersUI();

    await loadPdf(pdf.url);
    
    if (status) {
        status.innerText = "✅ 同期完了";
        setTimeout(() => status.style.display = "none", 3000);
    }
});

// --- 9. 保存・読込 ---
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
                    page: m.page,
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