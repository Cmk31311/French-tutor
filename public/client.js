const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const resetBtn = document.getElementById("resetBtn");
const statusPill = document.getElementById("statusPill");
const ttsPill = document.getElementById("ttsPill");
const conversation = document.getElementById("conversation");
const lessonSteps = document.getElementById("lessonSteps");
const vocabCards = document.getElementById("vocabCards");
const progressFill = document.getElementById("progressFill");
const audioVisualizer = document.getElementById("audioVisualizer");

let ws;
let audioCtx;
let sourceNode;
let processorNode;
let micStream;

let playCtx;
let playQueue = [];
let isPlaying = false;
let currentSource = null;  // Track current BufferSource to prevent race conditions

let currentLesson = null;
let vocabularyList = [];
let conversationHistory = [];

let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;

function setStatus(text, type = 'disconnected') {
  statusPill.textContent = text;
  statusPill.className = 'status-pill status-' + type;
}

function setTTSStatus(speaking) {
  if (speaking) {
    ttsPill.style.display = 'inline-flex';
    ttsPill.textContent = '🔊 Speaking';
    ttsPill.className = 'status-pill status-speaking';
    audioVisualizer.classList.add('active');
  } else {
    ttsPill.style.display = 'inline-flex';
    ttsPill.textContent = '👂 Listening';
    ttsPill.className = 'status-pill status-listening';
    audioVisualizer.classList.remove('active');
  }
}

function addMessage(text, isUser, isPartial = false) {
  if (isPartial) {
    // Update or create partial message
    let partial = conversation.querySelector('.message-partial');
    if (!partial) {
      partial = document.createElement('div');
      partial.className = 'message message-user message-partial';
      partial.innerHTML = `
        <div class="message-label">You (speaking...)</div>
        <div class="message-text">${text}</div>
      `;
      conversation.appendChild(partial);
    } else {
      partial.querySelector('.message-text').textContent = text;
    }
  } else {
    // Remove any partial message
    const partial = conversation.querySelector('.message-partial');
    if (partial) partial.remove();

    // Add final message
    const msg = document.createElement('div');
    msg.className = isUser ? 'message message-user' : 'message message-tutor';
    msg.innerHTML = `
      <div class="message-label">${isUser ? 'You' : '🤖 AI Tutor'}</div>
      <div class="message-text">${text}</div>
    `;
    conversation.appendChild(msg);

    conversationHistory.push({ role: isUser ? 'user' : 'tutor', text });
  }

  conversation.scrollTop = conversation.scrollHeight;
}

function updateLessonPlan(lessonData) {
  if (!lessonData || !lessonData.steps) return;

  currentLesson = lessonData;
  lessonSteps.innerHTML = '';

  lessonData.steps.forEach((step, index) => {
    const stepEl = document.createElement('div');
    let className = 'lesson-step';
    if (step.status === 'completed') className += ' completed';
    if (step.status === 'current') className += ' current';

    stepEl.className = className;
    stepEl.innerHTML = `
      <h3>${index + 1}. ${step.title}</h3>
      <p>${step.description}</p>
    `;
    lessonSteps.appendChild(stepEl);
  });

  // Update progress bar
  const totalSteps = lessonData.steps.length;
  const completedSteps = lessonData.steps.filter(s => s.status === 'completed').length;
  const progress = (completedSteps / totalSteps) * 100;
  progressFill.style.width = progress + '%';
}

function addVocabCard(vocab) {
  // Check if already exists
  if (vocabularyList.find(v => v.french === vocab.french)) return;

  vocabularyList.push(vocab);

  // Clear placeholder
  if (vocabCards.querySelector('p')) {
    vocabCards.innerHTML = '';
  }

  const card = document.createElement('div');
  card.className = 'vocab-card';
  card.innerHTML = `
    <div class="vocab-french">${vocab.french}</div>
    <div class="vocab-pronunciation">Sounds like: ${vocab.pronunciation}</div>
    <div class="vocab-english">${vocab.english}</div>
    <button class="vocab-play" data-word="${vocab.french}">🔊 Pronounce</button>
  `;

  // Add to top
  vocabCards.insertBefore(card, vocabCards.firstChild);

  // Add click handler for pronunciation
  card.querySelector('.vocab-play').onclick = () => {
    speakWord(vocab.french);
  };
}

function speakWord(word) {
  if (!ws || ws.readyState !== 1) return;
  // Send a special message to speak just this word
  ws.send(JSON.stringify({ type: 'speak_word', word }));
}

function downsampleBuffer(float32, inSampleRate, outSampleRate) {
  if (outSampleRate === inSampleRate) return float32;
  const ratio = inSampleRate / outSampleRate;
  const newLen = Math.round(float32.length / ratio);
  const result = new Float32Array(newLen);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0, count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < float32.length; i++) {
      accum += float32[i];
      count++;
    }
    result[offsetResult] = accum / Math.max(1, count);
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

async function ensurePlayback() {
  if (!playCtx) {
    try {
      playCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      console.log('[AudioContext] Created successfully');
    } catch (error) {
      console.error('[AudioContext Error]:', error);
      // Send error to server
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'client_error',
          error: 'AudioContext creation failed: ' + error.message
        }));
      }
      throw error;
    }
  }
}

function enqueuePCM16k48k(int16Buffer) {
  playQueue.push(int16Buffer);
  if (!isPlaying) playNextChunk();
}

async function playNextChunk() {
  if (playQueue.length === 0) {
    isPlaying = false;
    currentSource = null;
    return;
  }

  if (isPlaying && currentSource) {
    // Already playing, will be called again by onended
    return;
  }

  isPlaying = true;
  await ensurePlayback();

  const chunk = playQueue.shift();
  const floatBuf = new Float32Array(chunk.length);
  for (let i = 0; i < chunk.length; i++) floatBuf[i] = chunk[i] / 32768;

  const audioBuffer = playCtx.createBuffer(1, floatBuf.length, 48000);
  audioBuffer.copyToChannel(floatBuf, 0);

  const node = playCtx.createBufferSource();
  node.buffer = audioBuffer;
  node.connect(playCtx.destination);

  currentSource = node;

  node.onended = () => {
    currentSource = null;
    playNextChunk();
  };

  try {
    node.start();
  } catch (error) {
    console.error('[Audio Playback Error]:', error);
    currentSource = null;
    isPlaying = false;
  }
}

function clearPlaybackQueue() {
  playQueue = [];
  if (currentSource) {
    try {
      currentSource.stop();
    } catch (e) {
      // Already stopped
    }
    currentSource = null;
  }
  isPlaying = false;
}

async function start() {
  console.log('[Client] Starting voice tutor...');
  setStatus("Connecting...", "disconnected");
  conversation.innerHTML = '';
  conversationHistory = [];

  const wsUrl = `${location.origin.replace("http", "ws")}/ws`;
  console.log('[Client] Connecting to WebSocket:', wsUrl);
  ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.onopen = async () => {
    console.log('[Client] WebSocket connected successfully');
    reconnectAttempts = 0;  // Reset reconnect counter on successful connection
    setStatus("Connected", "connected");
    setTTSStatus(false);
    startBtn.disabled = true;
    stopBtn.disabled = false;
    resetBtn.disabled = false;

    console.log('[Client] Starting microphone...');
    await startMic();
    console.log('[Client] Microphone started, ready to listen');

    // Request initial lesson plan
    ws.send(JSON.stringify({ type: 'get_lesson_plan' }));
  };

  ws.onclose = () => {
    setStatus("Disconnected", "disconnected");
    ttsPill.style.display = 'none';
    startBtn.disabled = false;
    stopBtn.disabled = true;
    resetBtn.disabled = true;
    stopMic();

    // Optional: Auto-reconnect logic
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      console.log(`Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
      setTimeout(() => {
        if (startBtn.disabled === false) {
          // Don't auto-reconnect if user manually disconnected
          return;
        }
        start();
      }, 2000 * reconnectAttempts);  // Exponential backoff
    }
  };

  ws.onerror = (e) => {
    console.error('WebSocket error:', e);
    setStatus('Connection Error', 'disconnected');
  };

  ws.onmessage = (evt) => {
    if (typeof evt.data === "string") {
      const msg = JSON.parse(evt.data);

      if (msg.type === "partial") {
        addMessage(msg.text, true, true);
      }
      else if (msg.type === "final") {
        addMessage(msg.text, true, false);
      }
      else if (msg.type === "tutor_response") {
        addMessage(msg.speech, false, false);
      }
      else if (msg.type === "tts_state") {
        setTTSStatus(msg.speaking);
        if (!msg.speaking && msg.reason?.startsWith("barge")) {
          clearPlaybackQueue();
        }
      }
      else if (msg.type === "lesson_plan") {
        updateLessonPlan(msg.lesson);
      }
      else if (msg.type === "vocab_update") {
        if (msg.vocab && Array.isArray(msg.vocab)) {
          msg.vocab.forEach(v => addVocabCard(v));
        }
      }
      else if (msg.type === "tutor_notes") {
        // Handle notes silently or show in console
        console.log('Tutor notes:', msg.notes);

        // Extract vocabulary if present
        if (msg.notes.new_vocab && Array.isArray(msg.notes.new_vocab)) {
          msg.notes.new_vocab.forEach(word => {
            // Simple auto-vocab card (will be enhanced by server)
            if (typeof word === 'string') {
              addVocabCard({
                french: word,
                english: word,
                pronunciation: word
              });
            }
          });
        }
      }
      else if (msg.type === "status") {
        console.log('Status:', msg.message, msg.error || '');
      }
      else if (msg.type === "vad") {
        console.log('VAD:', msg.event);
      }

      return;
    }

    // Binary audio chunk from TTS (48k linear16 mono)
    try {
      if (!(evt.data instanceof ArrayBuffer)) {
        console.error('[Invalid Audio Data]: Expected ArrayBuffer, got', typeof evt.data);
        return;
      }

      const buf = new Uint8Array(evt.data);

      if (buf.byteLength === 0) {
        console.warn('[Empty Audio Chunk]: Skipping');
        return;
      }

      if (buf.byteLength % 2 !== 0) {
        console.warn('[Malformed Audio]: Byte length not divisible by 2');
      }

      const int16 = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
      enqueuePCM16k48k(int16);

    } catch (error) {
      console.error('[Audio Reception Error]:', error);
    }
  };
}

async function stop() {
  try {
    ws?.send(JSON.stringify({ type: "stop_tts" }));
  } catch (_) {}
  ws?.close();
  ws = null;
}

async function resetSession() {
  try {
    ws?.send(JSON.stringify({ type: "reset" }));
    conversation.innerHTML = '';
    conversationHistory = [];
    vocabularyList = [];
    vocabCards.innerHTML = '<p style="color: #9ca3af; text-align: center; padding: 40px 20px;">Vocabulary words will appear here as you learn</p>';
    currentLesson = null;
    lessonSteps.innerHTML = '<div class="lesson-step"><h3>Waiting for lesson plan...</h3><p>The AI will create a new personalized learning plan.</p></div>';
    progressFill.style.width = '0%';

    // Request new lesson plan
    setTimeout(() => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'get_lesson_plan' }));
      }
    }, 500);
  } catch (_) {}
}

async function startMic() {
  console.log('[Client] Requesting microphone permission...');
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  console.log('[Client] Microphone permission granted');
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  console.log('[Client] AudioContext created, sample rate:', audioCtx.sampleRate);

  sourceNode = audioCtx.createMediaStreamSource(micStream);
  processorNode = audioCtx.createScriptProcessor(4096, 1, 1);

  const inRate = audioCtx.sampleRate;

  processorNode.onaudioprocess = (e) => {
    if (!ws || ws.readyState !== 1) return;

    try {
      const input = e.inputBuffer.getChannelData(0);
      const down = downsampleBuffer(input, inRate, 16000);
      const pcm16 = floatTo16BitPCM(down);

      ws.send(pcm16.buffer);
    } catch (error) {
      console.error('[Audio Processing Error]:', error);
      // Don't stop processing, just log and continue
    }
  };

  sourceNode.connect(processorNode);
  processorNode.connect(audioCtx.destination);
}

function stopMic() {
  try { processorNode?.disconnect(); } catch (_) {}
  try { sourceNode?.disconnect(); } catch (_) {}
  if (micStream) {
    for (const t of micStream.getTracks()) t.stop();
  }
  micStream = null;

  try { audioCtx?.close(); } catch (_) {}
  audioCtx = null;
  processorNode = null;
  sourceNode = null;

  clearPlaybackQueue();
}

startBtn.onclick = start;
stopBtn.onclick = stop;
resetBtn.onclick = resetSession;
