const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const resetBtn = document.getElementById("resetBtn");
const statusPill = document.getElementById("statusPill");
const ttsPill = document.getElementById("ttsPill");
const partialDiv = document.getElementById("partial");
const finalDiv = document.getElementById("final");
const logDiv = document.getElementById("log");

let ws;
let audioCtx;
let sourceNode;
let processorNode;
let micStream;

let playCtx;
let playQueue = [];
let isPlaying = false;

function log(line) {
  logDiv.textContent = `${line}\n` + logDiv.textContent.slice(0, 3000);
}

function setStatus(text) {
  statusPill.textContent = text;
}

function setTTS(text) {
  ttsPill.textContent = `tts: ${text}`;
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
    // average to reduce aliasing a bit
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

// Simple streaming PCM player for 48k linear16 mono
async function ensurePlayback() {
  if (!playCtx) playCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
}

function enqueuePCM16k48k(int16Buffer) {
  // int16Buffer: Int16Array at 48k
  playQueue.push(int16Buffer);
  if (!isPlaying) playNextChunk();
}

async function playNextChunk() {
  if (playQueue.length === 0) {
    isPlaying = false;
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
  node.onended = () => playNextChunk();
  node.start();
}

function clearPlaybackQueue() {
  playQueue = [];
  // can't reliably stop current bufferSource without tracking it; queue clearing is enough for this demo
}

async function start() {
  setStatus("connecting...");
  partialDiv.textContent = "";
  finalDiv.textContent = "";
  logDiv.textContent = "";

  ws = new WebSocket(`${location.origin.replace("http", "ws")}/ws`);
  ws.binaryType = "arraybuffer";

  ws.onopen = async () => {
    setStatus("connected");
    startBtn.disabled = true;
    stopBtn.disabled = false;
    resetBtn.disabled = false;
    log("ws open");

    await startMic();
  };

  ws.onclose = () => {
    setStatus("disconnected");
    setTTS("idle");
    startBtn.disabled = false;
    stopBtn.disabled = true;
    resetBtn.disabled = true;
    log("ws closed");
    stopMic();
  };

  ws.onerror = (e) => {
    log("ws error");
    console.error(e);
  };

  ws.onmessage = (evt) => {
    if (typeof evt.data === "string") {
      const msg = JSON.parse(evt.data);
      if (msg.type === "partial") {
        partialDiv.textContent = `… ${msg.text}`;
      } else if (msg.type === "final") {
        partialDiv.textContent = "";
        finalDiv.textContent = finalDiv.textContent + `\nYou: ${msg.text}`;
      } else if (msg.type === "tts_state") {
        setTTS(msg.speaking ? "speaking" : "idle");
        if (!msg.speaking && msg.reason?.startsWith("barge")) {
          clearPlaybackQueue();
        }
      } else if (msg.type === "tutor_notes") {
        log(`notes: ${JSON.stringify(msg.notes)}`);
      } else if (msg.type === "status") {
        log(`${msg.message}${msg.error ? " | " + msg.error : ""}`);
      } else if (msg.type === "vad") {
        log(`vad: ${msg.event}`);
      } else if (msg.type === "barge_in_ack") {
        clearPlaybackQueue();
      }
      return;
    }

    // Binary audio chunk from TTS (48k linear16 mono)
    const buf = new Uint8Array(evt.data);
    const int16 = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
    enqueuePCM16k48k(int16);
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
    finalDiv.textContent = "";
    partialDiv.textContent = "";
    log("session reset");
  } catch (_) {}
}

async function startMic() {
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  sourceNode = audioCtx.createMediaStreamSource(micStream);

  // ScriptProcessorNode is deprecated but still widely supported and simplest for a demo.
  // buffer size 4096 gives reasonable latency.
  processorNode = audioCtx.createScriptProcessor(4096, 1, 1);

  const inRate = audioCtx.sampleRate;

  processorNode.onaudioprocess = (e) => {
    if (!ws || ws.readyState !== 1) return;

    const input = e.inputBuffer.getChannelData(0);

    // downsample to 16k
    const down = downsampleBuffer(input, inRate, 16000);
    const pcm16 = floatTo16BitPCM(down);

    // send as raw bytes
    ws.send(pcm16.buffer);
  };

  sourceNode.connect(processorNode);
  processorNode.connect(audioCtx.destination); // required in some browsers to keep processing alive

  log(`mic started (inRate=${inRate})`);
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
  log("mic stopped");
}

startBtn.onclick = start;
stopBtn.onclick = stop;
resetBtn.onclick = resetSession;
