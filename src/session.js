export function createSession() {
  return {
    memory: {
      cefr_guess: "A2",
      recurring_errors: {},
      vocab: [],
      vocabulary_cards: [], // Enhanced vocab with pronunciation
      session_count: 0,
      current_lesson: null,
      user_prefs: {
        explain_in_english: true,
        correction_intensity: "light" // light | medium | heavy
      }
    },
    history: [],

    addUser(text) {
      this.history.push({ role: "user", content: text });
      if (this.history.length > 20) this.history = this.history.slice(-20);
    },

    addAssistant(speech, notes) {
      this.history.push({ role: "assistant", content: speech });
      if (this.history.length > 20) this.history = this.history.slice(-20);

      // Update CEFR level
      if (notes?.cefr_guess) {
        this.memory.cefr_guess = notes.cefr_guess;
      }

      // Update vocabulary (simple list)
      if (Array.isArray(notes?.new_vocab)) {
        for (const w of notes.new_vocab.slice(0, 6)) {
          if (!this.memory.vocab.includes(w)) {
            this.memory.vocab.push(w);
          }
        }
        this.memory.vocab = this.memory.vocab.slice(-60);
      }

      // Update vocabulary cards (enhanced with pronunciation)
      if (Array.isArray(notes?.vocabulary)) {
        for (const v of notes.vocabulary) {
          if (v.french && !this.memory.vocabulary_cards.find(c => c.french === v.french)) {
            this.memory.vocabulary_cards.push({
              french: v.french,
              english: v.english || v.french,
              pronunciation: v.pronunciation || v.french,
              example: v.example || ""
            });
          }
        }
        // Keep last 50 vocab cards
        this.memory.vocabulary_cards = this.memory.vocabulary_cards.slice(-50);
      }

      // Track errors
      if (Array.isArray(notes?.corrections)) {
        for (const c of notes.corrections) {
          const key = (c || "").slice(0, 80);
          this.memory.recurring_errors[key] = (this.memory.recurring_errors[key] || 0) + 1;
        }
      }

      // Update lesson progress
      if (notes?.lesson_progress) {
        this.memory.current_lesson = {
          current_step: notes.lesson_progress.current_step || 1,
          total_steps: notes.lesson_progress.total_steps || 5,
          title: notes.lesson_progress.step_title || "Learning French",
          focus: notes.lesson_progress.next_objective || "General practice"
        };
      }
    },

    reset() {
      this.history = [];
      this.memory.vocab = [];
      this.memory.vocabulary_cards = [];
      this.memory.recurring_errors = {};
      this.memory.cefr_guess = "A2";
      this.memory.current_lesson = null;
      this.memory.session_count++;
    },

    getLessonPlan() {
      if (!this.memory.current_lesson) {
        return {
          steps: [
            { title: "Welcome & Assessment", description: "Greet the tutor and share your French level", status: "current" },
            { title: "Vocabulary Introduction", description: "Learn essential French words", status: "pending" },
            { title: "Sentence Practice", description: "Form simple sentences", status: "pending" },
            { title: "Conversation", description: "Practice a mini-dialogue", status: "pending" },
            { title: "Review", description: "Recap and next steps", status: "pending" }
          ]
        };
      }

      // Generate dynamic lesson steps based on current progress
      const steps = [];
      const totalSteps = this.memory.current_lesson.total_steps;
      const currentStep = this.memory.current_lesson.current_step;

      for (let i = 1; i <= totalSteps; i++) {
        let status = "pending";
        if (i < currentStep) status = "completed";
        if (i === currentStep) status = "current";

        steps.push({
          title: i === currentStep ? this.memory.current_lesson.title : `Step ${i}`,
          description: i === currentStep ? this.memory.current_lesson.focus : "",
          status
        });
      }

      return { steps };
    }
  };
}
