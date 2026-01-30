export function createSession() {
  return {
    memory: {
      cefr_guess: "A2",
      recurring_errors: {},
      vocab: [],
      user_prefs: {
        explain_in_english: true,
        correction_intensity: "light" // light | medium | heavy
      }
    },
    history: [],
    addUser(text) {
      this.history.push({ role: "user", content: text });
      // keep history bounded for cost/latency
      if (this.history.length > 20) this.history = this.history.slice(-20);
    },
    addAssistant(speech, notes) {
      this.history.push({ role: "assistant", content: speech });
      if (this.history.length > 20) this.history = this.history.slice(-20);

      // merge a little memory
      if (notes?.cefr_guess) this.memory.cefr_guess = notes.cefr_guess;
      if (Array.isArray(notes?.new_vocab)) {
        for (const w of notes.new_vocab.slice(0, 6)) {
          if (!this.memory.vocab.includes(w)) this.memory.vocab.push(w);
        }
        this.memory.vocab = this.memory.vocab.slice(-60);
      }
      if (Array.isArray(notes?.corrections)) {
        for (const c of notes.corrections) {
          const key = (c || "").slice(0, 80);
          this.memory.recurring_errors[key] = (this.memory.recurring_errors[key] || 0) + 1;
        }
      }
    },
    reset() {
      this.history = [];
      this.memory.vocab = [];
      this.memory.recurring_errors = {};
      this.memory.cefr_guess = "A2";
    }
  };
}
