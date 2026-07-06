"use strict";

/*
 * セリフボード app.js
 * 音声データ(Blob)はIndexedDBに保存する。localStorageは文字列しか
 * 保存できずサイズ上限も低いため、音声のような大きめバイナリには不向き。
 */

const DB_NAME = "serifuSoundboardDB";
const DB_VERSION = 1;
const STORE_NAME = "phrases";

let db = null;
let phrases = []; // 表示中の全セリフ(order順)
let sortMode = false;

// 録音関連のワーキング状態
let mediaStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordTimerHandle = null;
let recordSeconds = 0;
let previewBlob = null;
let previewMimeType = "";
let retakeTargetId = null; // nullなら新規保存、値があれば録り直し対象のid

// 長押し判定用
const LONG_PRESS_MS = 500;
let pressTimer = null;
let longPressFired = false;
let pressTargetId = null;

// 再生中の音声を1つだけに保つための参照。ループ再生中のセリフidも保持し、
// 同じボタンの再タップで停止できるようにする(トグル動作)
let currentAudio = null;
let currentAudioUrl = null;
let currentPlayingId = null;

// ---------- IndexedDB ----------

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, {
          keyPath: "id",
          autoIncrement: true,
        });
        store.createIndex("order", "order", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGetAll() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).put(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbDelete(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function loadPhrases() {
  const all = await dbGetAll();
  all.sort((a, b) => a.order - b.order);
  phrases = all;
  renderGrid();
}

// ---------- 描画 ----------

function renderGrid() {
  const grid = document.getElementById("grid");
  const emptyMessage = document.getElementById("emptyMessage");
  grid.innerHTML = "";

  if (phrases.length === 0) {
    emptyMessage.hidden = false;
    return;
  }
  emptyMessage.hidden = true;

  phrases.forEach((phrase, index) => {
    const cell = document.createElement("div");
    cell.className = "phrase-cell";

    const btn = document.createElement("button");
    btn.className = "phrase-btn";
    btn.type = "button";
    btn.textContent = phrase.name;
    btn.dataset.id = phrase.id;
    if (phrase.id === currentPlayingId) btn.classList.add("playing");

    // タップ=即再生、長押し=編集。pointer系イベントで両方を1つのボタンから判定する。
    btn.addEventListener("pointerdown", (e) => {
      if (sortMode) return;
      longPressFired = false;
      pressTargetId = phrase.id;
      pressTimer = setTimeout(() => {
        longPressFired = true;
        openEditModal(phrase.id);
      }, LONG_PRESS_MS);
    });
    const clearPress = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };
    btn.addEventListener("pointerup", () => {
      if (sortMode) return;
      clearPress();
      if (!longPressFired && pressTargetId === phrase.id) {
        playPhrase(phrase.id);
      }
    });
    btn.addEventListener("pointerleave", clearPress);
    btn.addEventListener("pointercancel", clearPress);

    cell.appendChild(btn);

    // 並び替えモード時だけ表示する上下ボタン
    const arrows = document.createElement("div");
    arrows.className = "sort-arrows";

    const upBtn = document.createElement("button");
    upBtn.className = "sort-arrow-btn";
    upBtn.type = "button";
    upBtn.textContent = "↑";
    upBtn.disabled = index === 0;
    upBtn.addEventListener("click", () => movePhrase(index, index - 1));

    const downBtn = document.createElement("button");
    downBtn.className = "sort-arrow-btn";
    downBtn.type = "button";
    downBtn.textContent = "↓";
    downBtn.disabled = index === phrases.length - 1;
    downBtn.addEventListener("click", () => movePhrase(index, index + 1));

    arrows.appendChild(upBtn);
    arrows.appendChild(downBtn);
    cell.appendChild(arrows);

    grid.appendChild(cell);
  });
}

async function movePhrase(fromIndex, toIndex) {
  const [moved] = phrases.splice(fromIndex, 1);
  phrases.splice(toIndex, 0, moved);
  // order値を並び直した配列のindexで振り直してDBに反映
  await Promise.all(
    phrases.map((p, i) => {
      p.order = i;
      return dbPut(p);
    })
  );
  renderGrid();
}

// ---------- 再生 ----------

function playPhrase(id) {
  // 再生中のボタンをもう一度タップしたら停止(トグル)
  if (currentPlayingId === id) {
    stopPlayback();
    return;
  }

  const phrase = phrases.find((p) => p.id === id);
  if (!phrase) return;

  // 前の再生が残っていたら止めてから新しい音声を鳴らす(子供の前での連打対策)
  stopPlayback();

  const url = URL.createObjectURL(phrase.blob);
  currentAudioUrl = url;
  const audio = new Audio(url);
  audio.loop = true;
  currentAudio = audio;
  currentPlayingId = id;
  setPlayingButton(id);
  audio.play().catch((err) => {
    console.error("再生に失敗しました", err);
    stopPlayback();
  });
}

function stopPlayback() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
  }
  currentPlayingId = null;
  setPlayingButton(null);
}

function setPlayingButton(id) {
  document.querySelectorAll(".phrase-btn").forEach((btn) => {
    btn.classList.toggle("playing", btn.dataset.id === String(id));
  });
}

// ---------- 録音まわり ----------

function pickMimeType() {
  // iOS Safariはaudio/mp4系のみ対応、それ以外はwebmが安定して使える
  const candidates = [
    "audio/mp4",
    "audio/webm;codecs=opus",
    "audio/webm",
  ];
  for (const type of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return "";
}

// 録音の前後にある無音区間(声を出す前の間・切る前の間)を自動でカットする。
// MediaRecorderの出力(webm/mp4)はそのまま波形編集できないため、一度PCMに
// デコードしてから無音判定・トリミングし、WAVとして書き出し直す。
const SILENCE_THRESHOLD = 0.02; // これ未満の振幅は無音とみなす
const SILENCE_PADDING_SEC = 0.1; // 声の前後に残す余白(息継ぎの頭切れ防止)

async function trimSilence(blob) {
  let audioCtx;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const sampleRate = audioBuffer.sampleRate;
    const channelData = audioBuffer.getChannelData(0);

    let start = 0;
    let end = channelData.length - 1;
    while (start < channelData.length && Math.abs(channelData[start]) < SILENCE_THRESHOLD) start++;
    while (end > start && Math.abs(channelData[end]) < SILENCE_THRESHOLD) end--;

    // 全部無音だった場合は削りようがないので元の録音のまま返す
    if (start >= end) return blob;

    const paddingSamples = Math.floor(SILENCE_PADDING_SEC * sampleRate);
    start = Math.max(0, start - paddingSamples);
    end = Math.min(channelData.length - 1, end + paddingSamples);
    const trimmedLength = end - start + 1;

    const trimmedBuffer = audioCtx.createBuffer(
      audioBuffer.numberOfChannels,
      trimmedLength,
      sampleRate
    );
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      trimmedBuffer.copyToChannel(audioBuffer.getChannelData(ch).slice(start, end + 1), ch);
    }

    return audioBufferToWav(trimmedBuffer);
  } catch (err) {
    console.error("無音カットに失敗したため元の録音をそのまま使います", err);
    return blob;
  } finally {
    if (audioCtx) audioCtx.close();
  }
}

// AudioBufferを16bit PCMのWAVファイルにエンコードする(圧縮フォーマットへの
// 再エンコードはブラウザ標準APIだけでは難しいため、無圧縮WAVで書き出す)
function audioBufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const blockAlign = numChannels * 2;
  const dataSize = numFrames * blockAlign;

  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);
  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

function showRecordStage(stage) {
  document.getElementById("recordStageIdle").hidden = stage !== "idle";
  document.getElementById("recordStageRecording").hidden = stage !== "recording";
  document.getElementById("recordStagePreview").hidden = stage !== "preview";
}

function openRecordModal(targetId) {
  retakeTargetId = targetId ?? null;
  document.getElementById("recordModalTitle").textContent = retakeTargetId
    ? "セリフを録り直す"
    : "新しいセリフを録音";
  document.getElementById("recordError").hidden = true;
  document.getElementById("phraseNameInput").value = "";
  previewBlob = null;
  showRecordStage("idle");
  document.getElementById("recordModal").hidden = false;
}

function closeRecordModal() {
  stopMediaStream();
  document.getElementById("recordModal").hidden = true;
}

function stopMediaStream() {
  if (recordTimerHandle) {
    clearInterval(recordTimerHandle);
    recordTimerHandle = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  mediaRecorder = null;
}

function showRecordError(message) {
  const el = document.getElementById("recordError");
  el.textContent = message;
  el.hidden = false;
}

async function startRecording() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showRecordError("マイクを使えませんでした。設定でマイク権限を許可してください。");
    return;
  }

  const mimeType = pickMimeType();
  previewMimeType = mimeType;
  recordedChunks = [];
  try {
    mediaRecorder = mimeType
      ? new MediaRecorder(mediaStream, { mimeType })
      : new MediaRecorder(mediaStream);
  } catch (err) {
    showRecordError("この端末では録音に対応していません。");
    stopMediaStream();
    return;
  }

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };
  mediaRecorder.onstop = async () => {
    const rawBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || previewMimeType });
    previewBlob = await trimSilence(rawBlob);
    previewMimeType = previewBlob.type;
    const audioEl = document.getElementById("previewAudio");
    audioEl.src = URL.createObjectURL(previewBlob);
    showRecordStage("preview");
  };

  mediaRecorder.start();
  recordSeconds = 0;
  document.getElementById("recTimer").textContent = "0:00";
  recordTimerHandle = setInterval(() => {
    recordSeconds += 1;
    const m = Math.floor(recordSeconds / 60);
    const s = String(recordSeconds % 60).padStart(2, "0");
    document.getElementById("recTimer").textContent = `${m}:${s}`;
  }, 1000);

  showRecordStage("recording");
}

function stopRecording() {
  if (recordTimerHandle) {
    clearInterval(recordTimerHandle);
    recordTimerHandle = null;
  }
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
  }
}

async function savePhrase() {
  const name = document.getElementById("phraseNameInput").value.trim();
  if (!name) {
    showRecordError("セリフの名前を入力してください。");
    return;
  }
  if (!previewBlob) {
    showRecordError("録音データがありません。");
    return;
  }

  if (retakeTargetId) {
    // 録り直し: 既存レコードの音声だけ差し替え、名前も更新できるようにする
    if (currentPlayingId === retakeTargetId) stopPlayback();
    const target = phrases.find((p) => p.id === retakeTargetId);
    target.blob = previewBlob;
    target.mimeType = previewMimeType;
    target.name = name;
    await dbPut(target);
  } else {
    const maxOrder = phrases.length ? Math.max(...phrases.map((p) => p.order)) : -1;
    const record = {
      name,
      blob: previewBlob,
      mimeType: previewMimeType,
      order: maxOrder + 1,
      createdAt: Date.now(),
    };
    await dbPut(record);
  }

  await loadPhrases();
  closeRecordModal();
}

// ---------- 編集モーダル ----------

let editTargetId = null;

function openEditModal(id) {
  editTargetId = id;
  const phrase = phrases.find((p) => p.id === id);
  document.getElementById("editNameInput").value = phrase.name;
  document.getElementById("editModal").hidden = false;
}

function closeEditModal() {
  document.getElementById("editModal").hidden = true;
  editTargetId = null;
}

async function saveEditedName() {
  const name = document.getElementById("editNameInput").value.trim();
  if (!name || editTargetId === null) return;
  const phrase = phrases.find((p) => p.id === editTargetId);
  phrase.name = name;
  await dbPut(phrase);
  await loadPhrases();
  closeEditModal();
}

async function deletePhrase() {
  if (editTargetId === null) return;
  if (!confirm("このセリフを削除しますか？")) return;
  if (currentPlayingId === editTargetId) stopPlayback();
  await dbDelete(editTargetId);
  await loadPhrases();
  closeEditModal();
}

// ---------- 並び替えモード ----------

function toggleSortMode() {
  sortMode = !sortMode;
  document.body.classList.toggle("sort-mode", sortMode);
  document.getElementById("sortModeBtn").classList.toggle("active", sortMode);
}

// ---------- 初期化 ----------

function bindEvents() {
  document.getElementById("recordOpenBtn").addEventListener("click", () => openRecordModal(null));
  document.getElementById("recordCancelBtn").addEventListener("click", closeRecordModal);
  document.getElementById("startRecBtn").addEventListener("click", startRecording);
  document.getElementById("stopRecBtn").addEventListener("click", stopRecording);
  document.getElementById("retakeBtn").addEventListener("click", () => showRecordStage("idle"));
  document.getElementById("saveBtn").addEventListener("click", savePhrase);

  document.getElementById("sortModeBtn").addEventListener("click", toggleSortMode);

  document.getElementById("editCloseBtn").addEventListener("click", closeEditModal);
  document.getElementById("editSaveNameBtn").addEventListener("click", saveEditedName);
  document.getElementById("editDeleteBtn").addEventListener("click", deletePhrase);
  document.getElementById("editRetakeBtn").addEventListener("click", () => {
    const id = editTargetId;
    closeEditModal();
    openRecordModal(id);
  });
}

async function init() {
  db = await openDB();
  await loadPhrases();
  bindEvents();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((err) => {
        console.error("Service Workerの登録に失敗しました", err);
      });
    });
  }
}

init();
