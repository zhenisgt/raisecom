/* app.js — логика SPA для видеоконференции на Agora RTC
   Файлы: index.html, styles.css и этот app.js находятся в папке web/.

   Примечание безопасности: APP_ID и TOKEN захардкожены для удобства теста.
   В продакшне токен следует генерировать на сервере и давать клиенту с ограниченным TTL.
*/

// Конфигурация
const APP_ID = 'e1f025384185b5c2c84e5fe755843a32838c671a542e544049c6329ea179b38d';
const TOKEN  = 'e1f025384185b5c2c84e5fe755843a32838c671a542e544049c6329ea179b38d';
const MAX_PARTICIPANTS = 10;
const ROOM_PREFIX = 'room-';

// DOM
const homeScreen = document.getElementById('homeScreen');
const callScreen = document.getElementById('callScreen');
const stage = document.getElementById('stage');
const roomLabel = document.getElementById('roomLabel');
const statusEl = document.getElementById('status');

const createBtn = document.getElementById('createBtn');
const joinBtn = document.getElementById('joinBtn');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const leaveBtn = document.getElementById('leaveBtn');
const toggleAudioBtn = document.getElementById('toggleAudioBtn');
const toggleVideoBtn = document.getElementById('toggleVideoBtn');

// State
let currentRoom = null;
let localUid = null;
let joined = false;
let audioEnabled = true;
let videoEnabled = true;
let localAudioTrack = null;
let localVideoTrack = null;
const tiles = new Map();

// Agora client
let client = null;
if (window.AgoraRTC) {
  client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
} else {
  console.warn('AgoraRTC SDK not found. Ensure <script src="https://agora.io"></script> is available.');
}

// UI helpers
function setStatus(text, type = 'info', timeout = 0) {
  statusEl.textContent = text;
  statusEl.className = 'status show';

  statusEl.classList.remove('success', 'error');
  if (type === 'success') statusEl.classList.add('success');
  if (type === 'error') statusEl.classList.add('error');

  if (timeout > 0) {
    clearTimeout(setStatus._timer);
    setStatus._timer = setTimeout(() => { statusEl.className = 'status'; }, timeout);
  }
}

function showHome() {
  homeScreen.classList.remove('hidden');
  callScreen.classList.add('hidden');
  updateGridLayout();
}
function showCall() {
  homeScreen.classList.add('hidden');
  callScreen.classList.remove('hidden');
}

function generateRoomId(length = 8) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < length; i++) text += alphabet[Math.floor(Math.random() * alphabet.length)];
  return text;
}
function getRoomFromUrl() { const p = new URLSearchParams(window.location.search); return p.get('room'); }
function updateRoomLabel() { roomLabel.textContent = currentRoom ? 'Комната: ' + currentRoom : 'Комната: —'; }
function updateUrlWithRoom(room) { const url = new URL(window.location.href); url.searchParams.set('room', room); window.history.pushState({}, '', url.toString()); }
function clearRoomFromUrl() { const url = new URL(window.location.href); url.searchParams.delete('room'); window.history.pushState({}, '', url.toString()); }
function getInviteLink() { return window.location.href; }

async function copyCurrentLink() {
  try {
    await navigator.clipboard.writeText(getInviteLink());
    setStatus('Ссылка комнаты успешно скопирована.', 'success', 2200);
  } catch (err) {
    setStatus('Не удалось скопировать ссылку автоматически. Скопируйте её вручную: ' + getInviteLink(), 'error', 5000);
  }
}

function createTile(uid, label, isLocal = false) {
  const tile = document.createElement('div');
  tile.className = 'tile' + (isLocal ? ' local' : '');
  tile.dataset.uid = String(uid);

  const badge = document.createElement('div');
  badge.className = 'tile-badge';
  badge.textContent = isLocal ? 'Вы' : 'Участник';

  const labelEl = document.createElement('div');
  labelEl.className = 'tile-label';
  labelEl.innerHTML = '<span class="signal"></span><span>' + label + '</span>';

  const placeholder = document.createElement('div');
  placeholder.className = 'tile-placeholder';
  placeholder.textContent = isLocal ? 'Камера выключена' : 'Видео недоступно';

  tile.appendChild(badge);
  tile.appendChild(labelEl);
  tile.appendChild(placeholder);

  stage.appendChild(tile);
  tiles.set(uid, tile);
  return tile;
}
function removeTile(uid) { const tile = tiles.get(uid); if (!tile) return; tile.remove(); tiles.delete(uid); }
function clearStage() { tiles.forEach((t)=>t.remove()); tiles.clear(); stage.innerHTML = ''; }

function updateGridLayout() {
  const count = Math.min(Math.max(tiles.size, 1), MAX_PARTICIPANTS);
  let cols = 3;
  if (count === 1) cols = 1;
  else if (count === 2) cols = 2;
  else if (count === 3 || count === 4) cols = 2;
  else if (count <= 6) cols = 3;
  else if (count <= 9) cols = 3;
  else cols = 4;
  document.documentElement.style.setProperty('--cols', String(cols));
}

function renderLocalTile() {
  const localKey = String(localUid || 'local');
  if (tiles.has(localKey)) removeTile(localKey);
  const tile = createTile(localKey, 'Вы', true);

  if (localVideoTrack) {
    const videoWrap = document.createElement('div');
    videoWrap.style.width = '100%'; videoWrap.style.height = '100%';
    tile.querySelector('.tile-placeholder').remove();
    const videoNode = document.createElement('video');
    videoNode.autoplay = true; videoNode.playsInline = true; videoNode.muted = true;
    tile.appendChild(videoNode);
    localVideoTrack.play(videoNode);
  } else {
    const placeholder = tile.querySelector('.tile-placeholder');
    placeholder.textContent = videoEnabled ? 'Камера выключена' : 'Камера отключена';
  }
  updateGridLayout();
}

async function joinRoom(roomName) {
  if (!window.AgoraRTC) {
    setStatus('Agora SDK не подключён. Проверьте наличие <script src="https://agora.io"></script>.', 'error', 5000);
    return;
  }

  try {
    currentRoom = roomName; updateRoomLabel(); setupClientEvents();

    try {
      const tracks = await AgoraRTC.createMicrophoneAndCameraTracks();
      localAudioTrack = tracks[0]; localVideoTrack = tracks[1]; audioEnabled = true; videoEnabled = true; syncAudioButton(); syncVideoButton();
    } catch (mediaErr) {
      console.warn('Media access failed', mediaErr);
      try { localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack(); localVideoTrack = null; audioEnabled = true; videoEnabled = false; syncAudioButton(); syncVideoButton(); }
      catch (audioErr) { console.warn('No audio', audioErr); localAudioTrack = null; localVideoTrack = null; audioEnabled = false; videoEnabled = false; syncAudioButton(); syncVideoButton(); }
    }

    const uid = await client.join(APP_ID, currentRoom, TOKEN || null, null);
    localUid = uid; joined = true;

    const publishTracks = [];
    if (localAudioTrack) publishTracks.push(localAudioTrack);
    if (localVideoTrack) publishTracks.push(localVideoTrack);
    if (publishTracks.length) await client.publish(publishTracks);

    renderLocalTile(); setStatus('Вы успешно подключились к комнате.', 'success', 2000);
  } catch (err) {
    console.error('Join error:', err);
    setStatus('Не удалось подключиться к комнате. Проверьте комнату и доступ к камере/микрофону.', 'error', 5000);
  }
}

function setupClientEvents() {
  client.off('user-published', onRemoteUserPublished);
  client.off('user-unpublished', onRemoteUserUnpublished);
  client.off('user-left', onRemoteUserLeft);
  client.on('user-published', onRemoteUserPublished);
  client.on('user-unpublished', onRemoteUserUnpublished);
  client.on('user-left', onRemoteUserLeft);
}

async function onRemoteUserPublished(user, mediaType) {
  try { await client.subscribe(user, mediaType); } catch (e) { console.error('Subscribe error', e); return; }
  const uid = String(user.uid);
  if (!tiles.has(uid)) { const tile = createTile(uid, uid, false); const placeholder = tile.querySelector('.tile-placeholder'); if (placeholder) placeholder.textContent = 'Подключение...'; }
  const tile = tiles.get(uid);
  if (mediaType === 'video') {
    const videoNode = document.createElement('video'); videoNode.autoplay = true; videoNode.playsInline = true; videoNode.muted = false;
    const existingPlaceholder = tile.querySelector('.tile-placeholder'); if (existingPlaceholder) existingPlaceholder.remove();
    tile.appendChild(videoNode); user.videoTrack.play(videoNode);
  }
  if (mediaType === 'audio') { if (user.audioTrack) user.audioTrack.play(); }
  updateGridLayout();
}

function onRemoteUserUnpublished(user, mediaType) {
  const uid = String(user.uid); const tile = tiles.get(uid); if (!tile) return;
  if (mediaType === 'video') {
    const existingVideo = tile.querySelector('video'); if (existingVideo) existingVideo.remove();
    let placeholder = tile.querySelector('.tile-placeholder');
    if (!placeholder) { placeholder = document.createElement('div'); placeholder.className = 'tile-placeholder'; placeholder.textContent = 'Видео отключено'; tile.appendChild(placeholder); }
    else { placeholder.textContent = 'Видео отключено'; }
  }
}

function onRemoteUserLeft(user) { removeTile(String(user.uid)); updateGridLayout(); }

function syncAudioButton() { toggleAudioBtn.classList.toggle('muted', !audioEnabled); toggleAudioBtn.innerHTML = `<span class="icon">${audioEnabled ? '🎙️' : '🔇'}</span><span>${audioEnabled ? 'Выкл. микрофон' : 'Вкл. микрофон'}</span>`; }
function syncVideoButton() { toggleVideoBtn.classList.toggle('muted', !videoEnabled); toggleVideoBtn.innerHTML = `<span class="icon">${videoEnabled ? '📹' : '🚫'}</span><span>${videoEnabled ? 'Выкл. камеру' : 'Вкл. камеру'}</span>`; }

async function toggleAudio() {
  if (!localAudioTrack) { setStatus('Микрофон недоступен. Проверьте разрешение на использование микрофона.', 'error', 3000); return; }
  const enabled = await localAudioTrack.getEnabled(); const next = !enabled; await localAudioTrack.setEnabled(next); audioEnabled = next; syncAudioButton(); setStatus(next ? 'Микрофон включён.' : 'Микрофон отключён.', next ? 'success' : 'info', 1500);
}
async function toggleVideo() {
  if (!localVideoTrack) { setStatus('Камера недоступна. Проверьте разрешение на использование камеры.', 'error', 3000); return; }
  const enabled = await localVideoTrack.getEnabled(); const next = !enabled; await localVideoTrack.setEnabled(next); videoEnabled = next; syncVideoButton(); renderLocalTile(); setStatus(next ? 'Камера включена.' : 'Камера отключена.', next ? 'success' : 'info', 1500);
}

async function leaveConference() {
  try { if (client && joined) await client.leave(); } catch (e) { console.warn('client.leave error:', e); }
  try { if (localAudioTrack) { localAudioTrack.close(); localAudioTrack = null; } } catch (e) {}
  try { if (localVideoTrack) { localVideoTrack.close(); localVideoTrack = null; } } catch (e) {}
  joined = false; localUid = null; audioEnabled = true; videoEnabled = true; syncAudioButton(); syncVideoButton(); clearStage(); clearRoomFromUrl(); currentRoom = null; updateRoomLabel(); setStatus('Вы вышли из комнаты.', 'success', 1800); showHome(); }

// Events
createBtn.addEventListener('click', () => { const room = ROOM_PREFIX + generateRoomId(8); updateUrlWithRoom(room); showCall(); joinRoom(room); });
joinBtn.addEventListener('click', () => { const room = getRoomFromUrl(); if (!room) { setStatus('В URL нет параметра room. Сначала создайте комнату или используйте ссылку от организатора.', 'error', 4500); return; } showCall(); joinRoom(room); });
copyLinkBtn.addEventListener('click', copyCurrentLink);
leaveBtn.addEventListener('click', leaveConference);
toggleAudioBtn.addEventListener('click', toggleAudio);
toggleVideoBtn.addEventListener('click', toggleVideo);

window.addEventListener('load', () => {
  const roomParam = getRoomFromUrl(); updateRoomLabel(); if (roomParam) { currentRoom = roomParam; updateRoomLabel(); showCall(); joinRoom(roomParam); } else { showHome(); }
});

window.addEventListener('popstate', () => { const roomParam = getRoomFromUrl(); if (!roomParam && callScreen && !callScreen.classList.contains('hidden')) { leaveConference(); } });

// initial ui
syncAudioButton(); syncVideoButton();
