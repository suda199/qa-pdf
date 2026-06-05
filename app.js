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

// --- 1. Socket.io & PDFJS ---
let socket;
if (typeof io !== 'undefined') {
    socket = io();
} else {
    console.error("Socket.io が読み込まれていません。");
    socket = { on: () => {}, off: () => {}, emit: () => {} };
}

const pdfjsLib = window['pdfjs-dist/build/pdf'];
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// --- 2. Vue アプリケーションの構築 ---
const { createApp, ref, computed, onMounted, onUnmounted } = Vue;

createApp({
    setup() {
        // --- 状態 (State) ---
        const selectedData = ref({ x: null, y: null });
        const markers = ref([]);
        const currentPageNum = ref(1);
        const totalPages = ref(0);
        const isLocked = ref(false);
        const networkStatus = ref("接続確認中...");
        const lastPingTime = ref("---");
        const showRestoreArea = ref(false);
        const reason = ref("");
        
        // --- 非リアクティブ状態 ---
        let currentPdfRender = null;
        let lastPdfUrl = null;
        let resizeTimer = null;

        // --- Template Refs ---
        const pdfCanvas = ref(null);
        const pdfContainer = ref(null);
        const sharedBoard = ref(null);
        const importFileInput = ref(null);

        // --- 計算プロパティ (Computed) ---
        const currentPageMarkers = computed(() => {
            return markers.value.filter(m => m.page === currentPageNum.value);
        });

        const markerCount = computed(() => markers.value.length);

        // IDを生成するヘルパー関数
        const getMarkerId = (m) => {
            return `${m.page}-${Number(m.x).toFixed(2)}-${Number(m.y).toFixed(2)}-${m.reason}`;
        };

        // --- メソッド (Methods) ---
        
        // PDFの読み込み
        const loadPdf = async (pdfUrl, startPage = 1) => {
            try {
                lastPdfUrl = pdfUrl;
                const loadingTask = pdfjsLib.getDocument(pdfUrl);
                currentPdfRender = await loadingTask.promise;
                totalPages.value = currentPdfRender.numPages;
                await renderPage(startPage);
            } catch (err) {
                console.error("PDFの読み込みに失敗しました:", err);
            }
        };

        // ページの描画
        const renderPage = async (pageNum) => {
            if (!currentPdfRender) return;
            currentPageNum.value = pageNum;

            try {
                const page = await currentPdfRender.getPage(pageNum);
                const canvas = pdfCanvas.value;
                if (!canvas) return;
                const context = canvas.getContext('2d');

                const container = sharedBoard.value;
                const availableWidth = container ? container.clientWidth - 40 : 800;
                
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
            } catch (err) {
                console.error("ページの描画に失敗しました:", err);
            }
        };

        // ページ入力の決定
        const handlePageInput = (e) => {
            let val = parseInt(e.target.value);
            if (isNaN(val) || val < 1) val = 1;
            if (val > totalPages.value) val = totalPages.value;
            renderPage(val);
        };

        // ページ入力のフォーカスアウト
        const handlePageBlur = (e) => {
            e.target.value = currentPageNum.value;
        };

        // 前のページへ
        const prevPage = () => {
            if (currentPageNum.value > 1) {
                renderPage(currentPageNum.value - 1);
            }
        };

        // 次のページへ
        const nextPage = () => {
            if (currentPageNum.value < totalPages.value) {
                renderPage(currentPageNum.value + 1);
            }
        };

        // ボードクリックによる位置選択
        const handleBoardClick = (e) => {
            if (!currentPdfRender) return;

            // マーカー要素自体がクリックされた場合は新規マーカー作成処理を行わない
            if (e.target.classList.contains('marker')) {
                return;
            }

            const container = pdfContainer.value;
            if (!container) return;

            const rect = container.getBoundingClientRect();
            const x = ((e.clientX - rect.left) / rect.width) * 100;
            const y = ((e.clientY - rect.top) / rect.height) * 100;

            selectedData.value = { x, y };
        };

        // マーカーのクリック時
        const showMarkerReason = (marker) => {
            alert(`📍 [Page ${marker.page}] 質問内容:\n${marker.reason}`);
        };

        // リスト内のマーククリックで該当ページに移動
        const jumpToMarker = (marker) => {
            if (!marker.resolved) {
                renderPage(marker.page);
            }
        };

        // マークの追加確定
        const addMarker = () => {
            const trimmedReason = reason.value.trim();
            if (selectedData.value.x === null || !trimmedReason) {
                return alert("ボード上をクリックして場所を選択し、質問内容を入力してください。");
            }

            const markerData = {
                x: selectedData.value.x,
                y: selectedData.value.y,
                reason: trimmedReason,
                page: currentPageNum.value
            };

            // サーバーへ送信（リアルタイム共有）
            socket.emit('add-marker', markerData);

            // 入力欄をクリア
            reason.value = "";
            selectedData.value = { x: null, y: null };
        };

        // マーカーの解決状態を切り替え
        const toggleMarkerResolved = (marker) => {
            const mId = getMarkerId(marker);
            socket.emit('toggle-marker-resolved', mId);
        };

        // ロック解除
        const unlockPdf = () => {
            socket.emit('unlock-pdf');
        };

        // PDFアップロード
        const uploadPdf = async (e) => {
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
                if (!result.success) {
                    alert(result.error || "アップロードに失敗しました");
                }
            } catch (err) {
                console.error("Upload error:", err);
                alert("通信エラーによりアップロードに失敗しました");
            } finally {
                // ファイル入力をリセット
                e.target.value = '';
            }
        };

        // エクスポート
        const exportMarkers = () => {
            if (markers.value.length === 0) return alert("保存するマークがありません。");
            const blob = new Blob([JSON.stringify(markers.value, null, 2)], { type: "application/json" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = "markers.json";
            a.click();
        };

        // インポートボタンクリック
        const triggerImportFile = () => {
            if (importFileInput.value) {
                importFileInput.value.click();
            }
        };

        // インポート処理
        const importMarkers = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = function(evt) {
                try {
                    const imported = JSON.parse(evt.target.result);
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
                } finally {
                    e.target.value = '';
                }
            };
            reader.readAsText(file);
        };

        // ローカルストレージからの復元
        const restoreFromBackup = () => {
            const backup = localStorage.getItem('wakawaka_markers_backup');
            if (backup) {
                try {
                    const parsed = JSON.parse(backup);
                    parsed.forEach(m => {
                        socket.emit('add-marker', {
                            x: m.x,
                            y: m.y,
                            reason: m.reason,
                            page: m.page || 1
                        });
                    });
                    showRestoreArea.value = false;
                } catch (err) {
                    console.error("復元に失敗しました:", err);
                }
            }
        };

        // 手動通信テスト
        const manualPingTest = (e) => {
            e.preventDefault();
            const start = Date.now();
            fetch('/?t=' + start)
                .then(() => {
                    const latency = Date.now() - start;
                    lastPingTime.value = `${latency}ms`;
                })
                .catch(err => {
                    console.error("Ping error:", err);
                    lastPingTime.value = "エラー";
                });
        };

        // --- クライアント側でマーカーを追加/更新するヘルパー ---
        const addMarkerToUI = (x, y, reasonText, page, resolved = false) => {
            const targetPage = page || currentPageNum.value;
            
            // 重複チェック
            const exists = markers.value.some(m => 
                m.page === targetPage && m.x === x && m.y === y && m.reason === reasonText
            );
            if (!exists) {
                markers.value.push({ x, y, reason: reasonText, page: targetPage, resolved });
                // バックアップ保存
                localStorage.setItem('wakawaka_markers_backup', JSON.stringify(markers.value));
            }
        };

        const clearAllMarkersUI = () => {
            markers.value = [];
            localStorage.removeItem('wakawaka_markers_backup');
        };

        // --- ライフサイクル・リスナー登録 ---
        onMounted(() => {
            // ウィンドウリサイズハンドラ
            const handleResize = () => {
                if (lastPdfUrl) {
                    clearTimeout(resizeTimer);
                    resizeTimer = setTimeout(() => {
                        renderPage(currentPageNum.value);
                    }, 200);
                }
            };
            window.addEventListener('resize', handleResize);

            // Keep alive
            const keepServerAlive = () => {
                fetch('/')
                    .then(() => {
                        const now = new Date().toLocaleTimeString();
                        console.log(`[Keep-Alive] サーバーに信号を送信しました: ${now}`);
                    })
                    .catch(err => console.error("[Keep-Alive] 通信エラー:", err));
            };
            const keepAliveInterval = setInterval(keepServerAlive, 1000 * 60 * 10);

            // Socketイベント登録
            socket.on('connect', () => {
                networkStatus.value = "接続中 (リアルタイム同期)";
            });

            socket.on('disconnect', () => {
                networkStatus.value = "切断されました。再接続中...";
            });

            socket.on('pdf-initialized', (pdfData) => {
                if (pdfData && pdfData.url) {
                    loadPdf(pdfData.url, pdfData.currentPage || 1);
                }
            });

            socket.on('pdf-updated', (pdfData) => {
                loadPdf(pdfData.url, 1);
            });

            socket.on('marker-added', (data) => {
                if (data) {
                    addMarkerToUI(data.x, data.y, data.reason, data.page, data.resolved);
                }
            });

            socket.on('marker-resolved-updated', (data) => {
                const marker = markers.value.find(m => getMarkerId(m) === data.id);
                if (marker) {
                    marker.resolved = data.resolved;
                    localStorage.setItem('wakawaka_markers_backup', JSON.stringify(markers.value));
                }
            });

            socket.on('markers-initialized', (markersList) => {
                clearAllMarkersUI();
                if (markersList) {
                    markersList.forEach(m => {
                        addMarkerToUI(m.x, m.y, m.reason, m.page, m.resolved);
                    });
                }

                // サーバーが空でローカルストレージにバックアップがある場合のみ復元ボタンを表示
                const backup = localStorage.getItem('wakawaka_markers_backup');
                if (markers.value.length === 0 && backup) {
                    try {
                        const parsed = JSON.parse(backup);
                        if (parsed.length > 0) {
                            showRestoreArea.value = true;
                        }
                    } catch (e) {}
                } else {
                    showRestoreArea.value = false;
                }
            });

            socket.on('lock-status-updated', (locked) => {
                isLocked.value = locked;
            });

            socket.on('markers-cleared', () => {
                clearAllMarkersUI();
            });

            // クリーンダウン処理
            onUnmounted(() => {
                window.removeEventListener('resize', handleResize);
                clearInterval(keepAliveInterval);
                socket.off('connect');
                socket.off('disconnect');
                socket.off('pdf-initialized');
                socket.off('pdf-updated');
                socket.off('marker-added');
                socket.off('marker-resolved-updated');
                socket.off('markers-initialized');
                socket.off('lock-status-updated');
                socket.off('markers-cleared');
            });
        });

        return {
            selectedData,
            markers,
            currentPageNum,
            totalPages,
            isLocked,
            networkStatus,
            lastPingTime,
            showRestoreArea,
            reason,
            currentPageMarkers,
            markerCount,
            pdfCanvas,
            pdfContainer,
            sharedBoard,
            importFileInput,
            
            getMarkerId,
            prevPage,
            nextPage,
            handlePageInput,
            handlePageBlur,
            handleBoardClick,
            showMarkerReason,
            jumpToMarker,
            addMarker,
            toggleMarkerResolved,
            unlockPdf,
            uploadPdf,
            exportMarkers,
            triggerImportFile,
            importMarkers,
            restoreFromBackup,
            manualPingTest
        };
    }
}).mount('#main-app');