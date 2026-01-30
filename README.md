# French Voice Tutor
> Streaming voice agent: Deepgram STT + Deepgram TTS + LLM tutor brain

## What It Does

- **Browser client**: Press "Start", speak, see live transcript, hear the tutor respond in French
- **Server pipeline**:
  - Browser mic → WebSocket → Deepgram STT (streaming) → transcript
  - Transcript → LLM tutor brain → French response
  - Response → Deepgram TTS (streaming) → audio chunks → browser playback
- **Barge-in support**: If you speak while the tutor is talking, TTS stops immediately and listening resumes

## Requirements

- **Node.js 18+** (Node 20/22 recommended)
- **Deepgram API key** (required for STT and TTS)
- **OpenAI API key** (optional, but recommended for intelligent tutoring)

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```

Edit `.env` and add your Deepgram API key:
```env
DEEPGRAM_API_KEY=your_actual_key_here
```

Optionally add OpenAI for a smarter tutor:
```env
OPENAI_API_KEY=your_openai_key_here
OPENAI_MODEL=gpt-4o-mini
```

### 3. Start the server
```bash
npm run dev
```

You should see:
```
French Voice Tutor running at http://localhost:8080
```

### 4. Open in browser
Navigate to: **http://localhost:8080**

### 5. Test the flow
1. Click **Start** (browser will ask for mic permission)
2. Speak in French or English
3. Watch the live transcript appear
4. Hear the tutor respond with streaming audio
5. Try interrupting while tutor speaks (barge-in)
6. Click **Reset Session** to clear conversation history

## Architecture Details

### Audio Pipeline (Browser → Server)
- Browser captures mic at native sample rate (usually 48kHz)
- Downsampled to 16kHz in-browser using averaging
- Converted to Int16 linear PCM
- Sent as binary WebSocket frames to server
- Server forwards raw PCM to Deepgram STT

### Audio Pipeline (Server → Browser)
- Deepgram TTS streams 48kHz linear16 PCM chunks
- Server forwards chunks as binary WebSocket frames
- Browser converts to Float32, creates AudioBuffers
- Queued playback at 48kHz for smooth streaming

### Barge-In Implementation
- Deepgram STT emits `SpeechStarted` VAD events
- Server also detects incoming audio while `isSpeaking === true`
- Either trigger sends `Clear` + `Close` to TTS connection
- Browser clears playback queue when receiving barge-in notification

### Tutor Brain Behavior
- With `OPENAI_API_KEY`: Uses GPT for intelligent French tutoring
- Without OpenAI: Falls back to simple rule-based responses
- Returns structured JSON:
  - `speech`: What the tutor says (sent to TTS)
  - `notes`: Metadata (CEFR guess, corrections, vocab)
- Only `speech` is spoken; `notes` logged for debugging

## Configuration Options

Edit `.env` to customize:

```env
# Server port
PORT=8080

# Deepgram STT model (nova-3 is fast + accurate)
DG_STT_MODEL=nova-3
DG_STT_LANGUAGE=fr

# Deepgram TTS voice (French female voice)
DG_TTS_MODEL=aura-2-thalia-fr
```

## Customization

### Change Teaching Style
Edit `src/tutorPrompt.js` to adjust:
- Correction intensity (light/medium/heavy)
- Explanation language preference
- Lesson focus areas

### Modify Tutor Logic
Edit `src/tutorBrain.js` to:
- Change LLM parameters (temperature, model)
- Enhance fallback tutor behavior
- Add custom error handling

## Troubleshooting

### No audio output
- **Check microphone permission**: Browser must allow mic access
- **Check Deepgram API key**: Verify it's valid in `.env`
- **Check browser console**: Look for WebSocket errors

### Transcript works but no TTS
- **Check TTS model**: Ensure `DG_TTS_MODEL=aura-2-thalia-fr` in `.env`
- **Check Deepgram account**: Verify TTS is enabled for your API key
- **Check browser audio**: Ensure browser can play audio (not muted)

### Barge-in not working
- **Check VAD events**: Look in debug log for `vad: speech_started`
- **Check isSpeaking state**: Should show `tts: speaking` when tutor talks

### LLM returns invalid JSON
- **Fallback activates**: You'll see fallback tutor response
- **Check OpenAI key**: Verify key is valid and has credits
- **Check model**: `gpt-4o-mini` must support `response_format: json_object`

### Connection drops frequently
- **Network stability**: Deepgram requires stable WebSocket connection
- **Check firewall**: Ensure WebSocket connections aren't blocked

## Common Issues on New Machine

### macOS: "node" command not found
```bash
# Install Node.js via Homebrew
brew install node
```

### Port 8080 already in use
```bash
# Change PORT in .env
PORT=3000
```

### npm install fails
```bash
# Clear cache and retry
npm cache clean --force
npm install
```

## Development Notes

- Uses ScriptProcessorNode for audio capture (deprecated but widely supported)
- For production, consider migrating to AudioWorklet
- Server uses simple in-memory session (no database)
- Conversation history limited to last 20 turns for cost/latency

## File Structure

```
french-voice-tutor/
├── server.js              # HTTP + WebSocket server, Deepgram integration
├── public/
│   ├── index.html         # Browser UI
│   └── client.js          # WebSocket client, audio capture/playback
├── src/
│   ├── session.js         # Session memory and conversation history
│   ├── tutorBrain.js      # LLM integration and fallback logic
│   └── tutorPrompt.js     # System prompt for LLM tutor
├── package.json
├── .env.example
└── README.md
```

## Deployment

### Deploy to Railway (FREE - Recommended)

Railway offers $5/month free credit, perfect for this project.

**Steps:**

1. **Push to GitHub**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/yourusername/french-voice-tutor.git
   git push -u origin main
   ```

2. **Deploy on Railway**
   - Go to [railway.app](https://railway.app)
   - Click "Start a New Project"
   - Select "Deploy from GitHub repo"
   - Choose your repository
   - Railway will auto-detect Node.js and deploy

3. **Add Environment Variables**
   In Railway dashboard, go to Variables and add:
   ```
   DEEPGRAM_API_KEY=your_deepgram_key
   GROQ_API_KEY=your_groq_key
   GROQ_MODEL=llama-3.3-70b-versatile
   PORT=8080
   DG_STT_MODEL=nova-3
   DG_STT_LANGUAGE=fr
   DG_TTS_MODEL=aura-2-thalia-fr
   ```

4. **Get your URL**
   - Railway generates a public URL like `https://your-app.railway.app`
   - Visit it and start talking!

### Other Free Options

**Render.com:**
- Free tier available (app spins down after 15min inactivity)
- Deploy from GitHub
- Add environment variables in dashboard

**Fly.io:**
- 3 free VMs
- Requires Dockerfile (can be added if needed)
- Good for global edge deployment

**⚠️ Won't work: Vercel, Netlify, Cloudflare Pages** (no WebSocket support)

## License

Private educational project.
