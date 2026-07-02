import { supabase } from './supabaseClient.js';
import { escapeHtml, $ } from './utils.js';

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
loadQuizList();
