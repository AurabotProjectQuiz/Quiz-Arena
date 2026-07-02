import { supabase } from './supabaseClient.js';
import { escapeHtml, $ } from './utils.js';
import { requireRole } from './authGuard.js';

const OPTION_LETTERS = ['a', 'b', 'c', 'd'];
const OPTION_LABELS = ['A', 'B', 'C', 'D'];

let currentQuizId = null; // null = creating a new quiz
let questionCounter = 0;

const screens = ['list', 'editor'];
function showScreen(name) {
  for (const s of screens) {
    $(`#screen-${s}`).hidden = s !== name;
  }
}

$('#btn-sign-out').addEventListener('click', async () => {
  await supabase.auth.signOut();
  window.location.href = '/index.html';
});

// ------------------------------------------------------------
// Quiz list
// ------------------------------------------------------------
async function loadQuizList() {
  const listEl = $('#quiz-list');
  listEl.innerHTML = 'Loading quizzes…';

  const { data, error } = await supabase
    .from('quizzes')
    .select('id, title, topic')
    .order('created_at', { ascending: false });

  if (error) {
    listEl.innerHTML = `<p class="error-text">Couldn't load quizzes: ${escapeHtml(error.message)}</p>`;
    return;
  }
  if (!data || data.length === 0) {
    listEl.innerHTML = '<p class="center-text">No quizzes yet — create your first one above.</p>';
    return;
  }

  listEl.innerHTML = '';
  for (const q of data) {
    const row = document.createElement('div');
    row.className = 'quiz-pick-row';
    row.innerHTML = `
      <button type="button" class="quiz-pick">
        <span class="title">${escapeHtml(q.title)}</span>
        <span class="topic">${escapeHtml(q.topic)}</span>
      </button>
    `;
    row.querySelector('.quiz-pick').addEventListener('click', () => openEditor(q.id));
    listEl.appendChild(row);
  }
}

$('#btn-new-quiz').addEventListener('click', () => openEditor(null));

// ------------------------------------------------------------
// AI quiz generator — Step 1: build a copyable prompt for Claude
// ------------------------------------------------------------
function buildAiPrompt({ topic, ageLevel, numQuestions }) {
  return `Create a multiple-choice quiz question bank for a quiz app.

Topic: ${topic}
Audience / age level: ${ageLevel || 'general audience'}
Number of questions: ${numQuestions}

Return ONLY valid JSON — no markdown code fences, no headings, no commentary before or after it. Match this exact shape:

{
  "title": "short catchy quiz title (5 words or fewer)",
  "topic": "${topic}",
  "questions": [
    {
      "question": "question text",
      "options": ["option 1", "option 2", "option 3", "option 4"],
      "correctAnswer": "the option text that is correct, copied exactly from options",
      "timeLimitSeconds": 20
    }
  ]
}

Rules:
- Include exactly ${numQuestions} questions.
- Each question needs between 2 and 4 answer options.
- "correctAnswer" must be an exact copy of one of the strings in "options".
- Vary "timeLimitSeconds" between 10 and 45 depending on difficulty (harder questions get more time).
- Keep questions accurate and age-appropriate for: ${ageLevel || 'a general audience'}.
- Do not repeat questions or answers across the set.
- Output raw JSON only — it will be pasted directly into a program that calls JSON.parse() on it.`;
}

function resetAiModal() {
  $('#ai-topic').value = '';
  $('#ai-age-level').value = '';
  $('#ai-num-questions').value = 10;
  $('#ai-step1-error').textContent = '';
  $('#ai-prompt-output').value = '';
  $('#ai-paste-input').value = '';
  $('#ai-modal-error').textContent = '';
  $('#copy-feedback').textContent = '';
  $('#ai-prompt-section').hidden = true;
}

$('#btn-open-ai-modal').addEventListener('click', () => {
  resetAiModal();
  $('#ai-modal').hidden = false;
});

function closeAiModal() {
  $('#ai-modal').hidden = true;
}

$('#btn-close-ai-modal').addEventListener('click', closeAiModal);
$('#ai-modal').addEventListener('click', (e) => {
  if (e.target.id === 'ai-modal') closeAiModal(); // click on the dim overlay itself
});

$('#btn-generate-prompt').addEventListener('click', () => {
  const errorEl = $('#ai-step1-error');
  errorEl.textContent = '';

  const topic = $('#ai-topic').value.trim();
  const ageLevel = $('#ai-age-level').value.trim();
  const numQuestions = parseInt($('#ai-num-questions').value, 10);

  if (!topic) return (errorEl.textContent = 'Give the quiz a topic first.');
  if (!numQuestions || numQuestions < 1 || numQuestions > 30) {
    return (errorEl.textContent = 'Number of questions should be between 1 and 30.');
  }

  $('#ai-prompt-output').value = buildAiPrompt({ topic, ageLevel, numQuestions });
  $('#ai-prompt-section').hidden = false;
  $('#ai-prompt-section').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

$('#btn-copy-prompt').addEventListener('click', async () => {
  const text = $('#ai-prompt-output').value;
  const feedback = $('#copy-feedback');
  try {
    await navigator.clipboard.writeText(text);
    feedback.textContent = 'Copied! Paste it into Claude.';
  } catch {
    // Clipboard API unavailable (older browser / insecure context) — fall
    // back to select-and-copy so the user can still Cmd/Ctrl+C manually.
    const ta = $('#ai-prompt-output');
    ta.select();
    feedback.textContent = 'Press Cmd/Ctrl+C to copy the selected text.';
  }
  setTimeout(() => (feedback.textContent = ''), 4000);
});

// ------------------------------------------------------------
// AI quiz generator — Step 3: parse Claude's reply into quiz data
// ------------------------------------------------------------
function parseAiReply(raw) {
  let text = raw.trim();
  if (!text) throw new Error('Paste Claude\'s reply first.');

  // Claude sometimes wraps JSON in a ```json ... ``` fence despite
  // instructions not to — strip it if present rather than failing.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  } else {
    // Also handle stray text before/after a bare { ... } object.
    const braceStart = text.indexOf('{');
    const braceEnd = text.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd > braceStart) {
      text = text.slice(braceStart, braceEnd + 1);
    }
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That doesn\'t look like valid JSON. Make sure you copied Claude\'s entire reply and try again.');
  }

  if (!data || !Array.isArray(data.questions) || data.questions.length === 0) {
    throw new Error('The JSON is missing a non-empty "questions" array.');
  }

  const title = (data.title ?? '').toString().trim() || 'Untitled quiz';
  const topic = (data.topic ?? '').toString().trim() || 'General';

  const questions = data.questions.map((q, i) => {
    const questionText = (q?.question ?? '').toString().trim();
    const rawOptions = Array.isArray(q?.options)
      ? q.options.map((o) => (o ?? '').toString().trim()).filter(Boolean).slice(0, 4)
      : [];

    if (!questionText) throw new Error(`Question ${i + 1} is missing its question text.`);
    if (rawOptions.length < 2) throw new Error(`Question ${i + 1} ("${questionText}") needs at least 2 answer options.`);

    const options = rawOptions.map((text, idx) => ({ id: OPTION_LETTERS[idx], text }));
    const correctRaw = (q?.correctAnswer ?? '').toString().trim().toLowerCase();
    const match = options.find((o) => o.text.toLowerCase() === correctRaw);

    if (!match) {
      throw new Error(`Question ${i + 1} ("${questionText}"): correctAnswer doesn't exactly match any of its options.`);
    }

    const timeLimitSeconds = Number(q?.timeLimitSeconds);
    return {
      question_text: questionText,
      options,
      correct_option_id: match.id,
      time_limit_seconds: Number.isFinite(timeLimitSeconds)
        ? Math.min(120, Math.max(5, Math.round(timeLimitSeconds)))
        : 20,
    };
  });

  return { title, topic, questions };
}

$('#btn-import-ai').addEventListener('click', () => {
  const errorEl = $('#ai-modal-error');
  errorEl.textContent = '';

  let parsed;
  try {
    parsed = parseAiReply($('#ai-paste-input').value);
  } catch (err) {
    errorEl.textContent = err.message;
    return;
  }

  openEditorPrefilled(parsed.title, parsed.topic, parsed.questions);
});

// Prefill the editor with AI-generated quiz data, but require the same
// "Save quiz" click as manual creation — nothing is written to the
// database until the teacher reviews it and saves.
function openEditorPrefilled(title, topic, questions) {
  currentQuizId = null;
  $('#editor-error').textContent = '';
  $('#editor-heading').textContent = 'New quiz (from AI) — review before saving';
  $('#quiz-title').value = title;
  $('#quiz-topic').value = topic;
  $('#questions-container').innerHTML = '';
  $('#btn-delete-quiz').hidden = true;

  for (const q of questions) addQuestionBlock(q);

  closeAiModal();
  showScreen('editor');
}

// ------------------------------------------------------------
// Editor: load an existing quiz, or start blank
// ------------------------------------------------------------
async function openEditor(quizId) {
  currentQuizId = quizId;
  $('#editor-error').textContent = '';
  $('#quiz-title').value = '';
  $('#quiz-topic').value = '';
  $('#questions-container').innerHTML = '';

  if (!quizId) {
    $('#editor-heading').textContent = 'New quiz';
    $('#btn-delete-quiz').hidden = true;
    addQuestionBlock();
    showScreen('editor');
    return;
  }

  $('#editor-heading').textContent = 'Loading…';
  showScreen('editor');

  const [{ data: quiz, error: quizError }, { data: questions, error: qError }] = await Promise.all([
    supabase.from('quizzes').select('id, title, topic').eq('id', quizId).single(),
    supabase.from('questions').select('*').eq('quiz_id', quizId).order('order_index', { ascending: true }),
  ]);

  if (quizError || qError) {
    $('#editor-error').textContent = `Couldn't load this quiz: ${(quizError || qError).message}`;
    $('#editor-heading').textContent = 'Edit quiz';
    return;
  }

  $('#editor-heading').textContent = 'Edit quiz';
  $('#quiz-title').value = quiz.title;
  $('#quiz-topic').value = quiz.topic;
  $('#btn-delete-quiz').hidden = false;

  if (questions && questions.length > 0) {
    for (const q of questions) addQuestionBlock(q);
  } else {
    addQuestionBlock();
  }
}

$('#btn-cancel-editor').addEventListener('click', () => {
  showScreen('list');
  loadQuizList();
});

// ------------------------------------------------------------
// Question blocks
// ------------------------------------------------------------
function addQuestionBlock(existing = null) {
  questionCounter++;
  const qid = `qb-${questionCounter}`;
  const container = $('#questions-container');
  const index = container.children.length + 1;

  const block = document.createElement('div');
  block.className = 'question-block';
  block.dataset.qid = qid;

  const existingOptions = existing?.options ?? [];
  const correctId = existing?.correct_option_id ?? null;

  const optionsHtml = OPTION_LETTERS
    .map((letter, i) => {
      const opt = existingOptions.find((o) => o.id === letter);
      const text = opt ? opt.text : '';
      const checked = letter === correctId ? 'checked' : '';
      return `
        <div class="qb-option">
          <input type="radio" name="correct-${qid}" class="qb-correct" value="${letter}" ${checked} />
          <input type="text" class="qb-option-text" data-letter="${letter}" placeholder="Answer ${OPTION_LABELS[i]}" value="${escapeHtml(text)}" />
        </div>
      `;
    })
    .join('');

  block.innerHTML = `
    <div class="qb-header">
      <span class="qb-label">Question ${index}</span>
      <button type="button" class="icon-btn remove-question-btn" title="Remove question">✕</button>
    </div>
    <div class="qb-row">
      <div class="field">
        <label>Question text</label>
        <input type="text" class="qb-text" placeholder="e.g. What is the capital of France?" value="${escapeHtml(existing?.question_text ?? '')}" />
      </div>
      <div class="field time-field">
        <label>Time (sec)</label>
        <input type="number" class="qb-time" min="5" max="120" value="${existing?.time_limit_seconds ?? 20}" />
      </div>
    </div>
    <div class="qb-options">
      ${optionsHtml}
    </div>
  `;

  block.querySelector('.remove-question-btn').addEventListener('click', () => {
    block.remove();
    renumberQuestionBlocks();
  });

  container.appendChild(block);
}

function renumberQuestionBlocks() {
  const blocks = $('#questions-container').querySelectorAll('.question-block');
  blocks.forEach((block, i) => {
    block.querySelector('.qb-label').textContent = `Question ${i + 1}`;
  });
}

$('#btn-add-question').addEventListener('click', () => {
  addQuestionBlock();
  $('#questions-container').lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

// ------------------------------------------------------------
// Save
// ------------------------------------------------------------
$('#btn-save-quiz').addEventListener('click', saveQuiz);

async function saveQuiz() {
  const errorEl = $('#editor-error');
  errorEl.textContent = '';

  const title = $('#quiz-title').value.trim();
  const topic = $('#quiz-topic').value.trim();
  if (!title) return (errorEl.textContent = 'Give the quiz a title.');
  if (!topic) return (errorEl.textContent = 'Give the quiz a topic.');

  const blocks = Array.from($('#questions-container').querySelectorAll('.question-block'));
  const questionsToSave = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const text = block.querySelector('.qb-text').value.trim();
    if (!text) continue; // skip fully-blank question blocks

    const timeLimitSeconds = parseInt(block.querySelector('.qb-time').value, 10) || 20;

    const options = [];
    block.querySelectorAll('.qb-option-text').forEach((input) => {
      const value = input.value.trim();
      if (value) options.push({ id: input.dataset.letter, text: value });
    });

    if (options.length < 2) {
      errorEl.textContent = `"${text}" needs at least 2 answer options.`;
      return;
    }

    const checkedRadio = block.querySelector('.qb-correct:checked');
    const correctOptionId = checkedRadio ? checkedRadio.value : null;
    const correctOptionHasText = options.some((o) => o.id === correctOptionId);

    if (!correctOptionId || !correctOptionHasText) {
      errorEl.textContent = `Select a correct answer for "${text}" (it must have text filled in).`;
      return;
    }

    questionsToSave.push({
      order_index: questionsToSave.length,
      question_text: text,
      options,
      correct_option_id: correctOptionId,
      time_limit_seconds: timeLimitSeconds,
    });
  }

  if (questionsToSave.length === 0) {
    errorEl.textContent = 'Add at least one question.';
    return;
  }

  const saveBtn = $('#btn-save-quiz');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    let quizId = currentQuizId;

    if (quizId) {
      const { error } = await supabase.from('quizzes').update({ title, topic }).eq('id', quizId);
      if (error) throw error;
      // Simplest, safest way to support editing: replace all questions
      // for this quiz rather than trying to diff/merge them.
      const { error: delError } = await supabase.from('questions').delete().eq('quiz_id', quizId);
      if (delError) throw delError;
    } else {
      const { data, error } = await supabase.from('quizzes').insert({ title, topic }).select('id').single();
      if (error) throw error;
      quizId = data.id;
    }

    const rows = questionsToSave.map((q) => ({ ...q, quiz_id: quizId }));
    const { error: insertError } = await supabase.from('questions').insert(rows);
    if (insertError) throw insertError;

    showScreen('list');
    loadQuizList();
  } catch (err) {
    errorEl.textContent = `Couldn't save: ${err.message}`;
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save quiz';
  }
}

// ------------------------------------------------------------
// Delete
// ------------------------------------------------------------
$('#btn-delete-quiz').addEventListener('click', async () => {
  if (!currentQuizId) return;
  const confirmed = confirm('Delete this quiz and all its questions? This can\'t be undone.');
  if (!confirmed) return;

  const { error } = await supabase.from('quizzes').delete().eq('id', currentQuizId);
  if (error) {
    $('#editor-error').textContent = `Couldn't delete: ${error.message}`;
    return;
  }
  showScreen('list');
  loadQuizList();
});

// ------------------------------------------------------------
// Init
// ------------------------------------------------------------
(async () => {
  const auth = await requireRole(['teacher', 'admin']);
  if (!auth) return;
  loadQuizList();
})();
