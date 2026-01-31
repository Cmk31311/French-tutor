import http from "http";
import fs from "fs";
import path from "path";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { createClient, LiveTranscriptionEvents, LiveTTSEvents } from "@deepgram/sdk";
import { createSession } from "./src/session.js";
import { tutorReply } from "./src/tutorBrain.js";

dotenv.config();

const PORT = Number(process.env.PORT || 8080);
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

if (!DEEPGRAM_API_KEY) {
  console.error("Missing DEEPGRAM_API_KEY. Copy .env.example to .env and set it.");
  process.exit(1);
}

const DG_STT_MODEL = process.env.DG_STT_MODEL || "nova-3";
const DG_STT_LANGUAGE = process.env.DG_STT_LANGUAGE || "fr";
const DG_TTS_MODEL = process.env.DG_TTS_MODEL || "aura-2-thalia-fr";

const deepgram = createClient(DEEPGRAM_API_KEY);

function serveStatic(req, res) {
  const urlPath = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(process.cwd(), "public", urlPath);

  // basic safety
  if (!filePath.startsWith(path.join(process.cwd(), "public"))) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const ct =
      ext === ".html" ? "text/html" :
      ext === ".js" ? "text/javascript" :
      ext === ".css" ? "text/css" :
      "application/octet-stream";
    res.writeHead(200, { "Content-Type": ct });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", async (client) => {
  console.log('[WebSocket] New client connected');
  const session = createSession();

  // 1) Deepgram STT live connection
  const stt = deepgram.listen.live({
    model: DG_STT_MODEL,
    language: DG_STT_LANGUAGE,
    smart_format: true,
    interim_results: true,
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1,
    // good defaults for conversational turn-taking
    vad_events: true,
    endpointing: 50,
    utterance_end_ms: 900
  });

  // 2) Deepgram TTS live connection (created per reply)
  let tts = null;
  let isSpeaking = false;

  function sendJson(obj) {
    if (client.readyState === 1) client.send(JSON.stringify(obj));
  }

  function stopTTS(reason = "stop") {
    try {
      if (tts) {
        // tell Deepgram to clear/close. If the socket is already closing, ignore errors.
        tts.send({ type: "Clear" });
        tts.send({ type: "Close" });
        tts.finish?.();
      }
    } catch (_) {}
    tts = null;
    isSpeaking = false;
    sendJson({ type: "tts_state", speaking: false, reason });
  }

  // STT events
  stt.on(LiveTranscriptionEvents.Open, () => {
    console.log('[Deepgram STT] Connection opened');
    sendJson({ type: "status", ok: true, message: "stt_connected" });
  });

  stt.on(LiveTranscriptionEvents.Close, () => {
    sendJson({ type: "status", ok: true, message: "stt_closed" });
  });

  stt.on(LiveTranscriptionEvents.Error, (e) => {
    sendJson({ type: "status", ok: false, message: "stt_error", error: String(e?.message || e) });
  });

  // Barge-in using VAD events: if user starts speaking while tutor is speaking, stop TTS.
  stt.on(LiveTranscriptionEvents.SpeechStarted, () => {
    if (isSpeaking) stopTTS("barge_in");
    sendJson({ type: "vad", event: "speech_started" });
  });

  stt.on(LiveTranscriptionEvents.SpeechEnded, () => {
    sendJson({ type: "vad", event: "speech_ended" });
  });

  stt.on(LiveTranscriptionEvents.Transcript, async (evt) => {
    try {
      // Deepgram SDK emits a LiveTranscriptionEvent
      const alt = evt?.channel?.alternatives?.[0];
      const text = (alt?.transcript || "").trim();
      const isFinal = Boolean(evt?.is_final);

      if (!text) return;

      if (!isFinal) {
        sendJson({ type: "partial", text });
        return;
      }

      // final
      sendJson({ type: "final", text });
      session.addUser(text);

      // Tutor brain
      console.log('[Transcript] Processing:', text);
      const { speech, notes } = await tutorReply(session, text);
      console.log('[Tutor Response] Speech length:', speech.length, 'chars');
      session.addAssistant(speech, notes);
      sendJson({ type: "tutor_notes", notes });
      sendJson({ type: "tutor_response", speech });

      // Send vocabulary updates if present
      if (notes?.vocabulary && Array.isArray(notes.vocabulary) && notes.vocabulary.length > 0) {
        console.log('[Vocabulary] Sending', notes.vocabulary.length, 'words');
        sendJson({ type: "vocab_update", vocab: notes.vocabulary });
      }

      // Send lesson plan updates
      sendJson({ type: "lesson_plan", lesson: session.getLessonPlan() });

      // TTS streaming back to client
      try {
        isSpeaking = true;
        sendJson({ type: "tts_state", speaking: true });

        console.log('[TTS] Creating connection for speech:', speech.slice(0, 50) + '...');
        tts = deepgram.speak.live({
          model: DG_TTS_MODEL,
          encoding: "linear16",
          sample_rate: 48000
        });

        tts.on(LiveTTSEvents.Open, () => {
          console.log('[TTS] Connection opened, sending speech');
          tts.send({ type: "Speak", text: speech });
          tts.send({ type: "Flush" });
        });

        tts.on(LiveTTSEvents.Audio, (audioChunk) => {
          // audioChunk is Buffer
          if (client.readyState === 1) client.send(audioChunk, { binary: true });
        });

        tts.on(LiveTTSEvents.Flushed, () => {
          console.log('[TTS] Flushed, playback complete');
          stopTTS("done");
        });

        tts.on(LiveTTSEvents.Error, (e) => {
          console.error('[TTS Error]:', e);
          sendJson({ type: "status", ok: false, message: "tts_error", error: String(e?.message || e) });
          stopTTS("error");
        });

        tts.on(LiveTTSEvents.Close, () => {
          console.log('[TTS] Connection closed');
          stopTTS("close");
        });
      } catch (e) {
        console.error('[TTS Exception]:', e);
        sendJson({ type: "status", ok: false, message: "tts_exception", error: String(e?.message || e) });
        stopTTS("exception");
      }
    } catch (error) {
      console.error('[STT Transcript Error]:', error);
      sendJson({
        type: "status",
        ok: false,
        message: "tutor_error",
        error: error.message
      });
      // Send fallback response
      const fallback = "Désolé, j'ai eu un problème. Pouvez-vous répéter?";
      sendJson({ type: "tutor_response", speech: fallback });
    }
  });

  client.on("message", (data, isBinary) => {
    if (!isBinary) {
      // control message
      try {
        const msg = JSON.parse(data.toString("utf8"));
        if (msg?.type === "reset") {
          session.reset();
          sendJson({ type: "status", ok: true, message: "session_reset" });
          sendJson({ type: "lesson_plan", lesson: session.getLessonPlan() });
        }
        if (msg?.type === "stop_tts") {
          stopTTS("client_stop");
        }
        if (msg?.type === "get_lesson_plan") {
          sendJson({ type: "lesson_plan", lesson: session.getLessonPlan() });
        }
        if (msg?.type === "speak_word") {
          // Speak a single vocabulary word
          const word = msg.word || "";
          if (word && tts === null) {
            try {
              isSpeaking = true;
              sendJson({ type: "tts_state", speaking: true });

              tts = deepgram.speak.live({
                model: DG_TTS_MODEL,
                encoding: "linear16",
                sample_rate: 48000
              });

              tts.on(LiveTTSEvents.Open, () => {
                tts.send({ type: "Speak", text: word });
                tts.send({ type: "Flush" });
              });

              tts.on(LiveTTSEvents.Audio, (audioChunk) => {
                if (client.readyState === 1) client.send(audioChunk, { binary: true });
              });

              tts.on(LiveTTSEvents.Flushed, () => {
                stopTTS("done");
              });

              tts.on(LiveTTSEvents.Error, (e) => {
                sendJson({ type: "status", ok: false, message: "tts_error", error: String(e?.message || e) });
                stopTTS("error");
              });

              tts.on(LiveTTSEvents.Close, () => {
                stopTTS("close");
              });
            } catch (e) {
              sendJson({ type: "status", ok: false, message: "tts_exception", error: String(e?.message || e) });
              stopTTS("exception");
            }
          }
        }
      } catch (_) {}
      return;
    }

    // binary audio frame: linear16 16kHz mono
    if (isSpeaking) {
      // If user speaks while TTS still going, barge-in
      stopTTS("barge_in_audio");
    }
    try {
      stt.send(data);
    } catch (error) {
      console.error('[STT Send Error]:', error);
      sendJson({ type: "status", ok: false, message: "stt_send_error", error: error.message });
    }
  });

  client.on("close", () => {
    console.log('[WebSocket] Client disconnected');
    try { stt.finish(); } catch (_) {}
    stopTTS("client_close");
  });
});

server.listen(PORT, () => {
  console.log(`French Voice Tutor running at http://localhost:${PORT}`);
});
