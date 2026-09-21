// ============================================================
// 《异议处理实战》微课 · 应用逻辑
// 数据从 #appDataJson 读取（JSON），避免转义问题
// ============================================================
const APP = JSON.parse(document.getElementById('appDataJson').textContent);
const courseData = { title: APP.title, sections: APP.sections };
const chapterQuizzes = APP.chapterQuizzes;
const PRACTICE_DIMS = APP.practiceDims;

// ---------------- 状态 ----------------
const LS_PREFIX = APP.lsPrefix;
let currentSection = 0;
let completedSections = new Set();
let chapterQuizDone = new Array(chapterQuizzes.length).fill(false);
let chapterQuizAnswers = {};   // { 'chIdx_qi': { selected, isCorrect } }
// 视频观看追踪：视频按 DOM 顺序编号，索引与所在章节一一对应
// videoMeta[i] = { idx, chIdx, src }
// videoWatched: Set<videoIdx> —— 已「完整观看」的视频
// videoMaxTime: { videoIdx: seconds } —— 已连续观看到的最高播放位置
let videoMeta = [];
let videoWatched = new Set();
let videoMaxTime = {};
const VIDEO_WATCH_RATIO = 0.95;   // 播放至 95% 即视为看完（末段黑屏/片尾不计）
let fillAnswers = {};          // { idx: { value, correct } } —— 终极考核填空题
let fillDone = false;
let practiceSubmitted = false;
let practiceScore = 0;
let finalTaskSubmitted = false;
let finalScore = 0;
let finalBreakdown = null;
let finalFeedbackText = '';
let finalConversationStarted = false;
let finalMessages = [];
let finalRound = 0;
let finalAiScoring = false;

// ---------------- AI 后端 ----------------
// A 档：密钥在构建期以 XOR+hex 混淆注入；未注入时 _rK() 返回空串 → AI 按钮置灰并降级
const LLM_API_URL = APP.aiBaseUrl + '/chat/completions';
const LLM_MODEL = APP.aiModel;
const _HEX_KEY = '__MIMO_API_KEY__';
const _SALT = 'vipthink-cn-lp-objection';
function _rK() {
  if (!_HEX_KEY || _HEX_KEY.indexOf('__') === 0) return '';
  let o = '';
  for (let i = 0; i < _HEX_KEY.length; i += 2) {
    const b = parseInt(_HEX_KEY.substr(i, 2), 16) ^ _SALT.charCodeAt((i / 2) % _SALT.length);
    o += String.fromCharCode(b);
  }
  return o;
}
function aiReady() { return _rK().length > 10; }

// 域名白名单（A 档保护：防止页面被搬运到其它站点后继续盗用额度）
const ALLOWED_HOSTS = APP.allowedHosts;
function guardHost() {
  const h = location.hostname;
  if (ALLOWED_HOSTS.indexOf(h) === -1) {
    showToast('🔒 本课程仅限官方站点使用，AI 功能已停用', 'warning');
    return false;
  }
  return true;
}

let studySeconds = 0; let timerInterval = null;

// ============================================================
// 初始化
// ============================================================
function init() {
  renderSidebar();
  renderSections();
  initVideoTracking();
  loadProgress();
  startTimer();
  loadNotes();
}

function renderSidebar() {
  const nav = document.getElementById('sidebarNav');
  nav.innerHTML = courseData.sections.map((s, i) =>
    '<div class="nav-section" data-index="' + i + '" onclick="navigateTo(' + i + ')">' +
    '<div class="nav-icon">' + s.icon + '</div>' +
    '<div class="nav-info"><div class="nav-label">' + escapeHtml(s.title) + '</div>' +
    '<div class="nav-sub">⏱ ' + s.duration + '</div></div></div>').join('');
  updateSidebarLocks();
}

function updateSidebarLocks() {
  document.querySelectorAll('.nav-section').forEach((el, i) => {
    const check = canNavigateTo(i);
    if (!check.ok && i !== currentSection) {
      el.classList.add('locked');
      el.setAttribute('title', check.msg || '尚未解锁');
    } else {
      el.classList.remove('locked');
      el.removeAttribute('title');
    }
  });
}

function renderSections() {
  const main = document.getElementById('mainContent');
  main.innerHTML = courseData.sections.map((s, i) =>
    '<div class="section" data-section="' + i + '">' +
      s.content +
      quizBlockFor(i, s) +
      '<div class="section-nav-buttons">' +
        '<div>' + (i > 0 ? '<button class="btn btn-outline" onclick="navigateTo(' + (i - 1) + ')">← 上一章</button>' : '') + '</div>' +
        '<div>' + (i < courseData.sections.length - 1
          ? '<button class="btn" onclick="goNext(' + i + ')">下一章 →</button>'
          : '<button class="btn btn-success" id="completeCourseBtn" onclick="tryCompleteCourse(' + i + ')">✓ 完成课程</button>') +
        '</div>' +
      '</div>' +
    '</div>').join('');
  // 挂载终极考核的自由对话 UI
  const rc = document.getElementById('roleplayContainer');
  if (rc) rc.innerHTML = renderRoleplayHTML();
}

// 点击「下一章」：先校验本章视频与任务是否完成，再标记完成并跳转
function goNext(i) {
  const gate = chapterGate(i);
  if (!gate.ok) {
    showToast('🔒 第 ' + (i + 1) + ' 章尚未完成：' + gate.msg, 'warning');
    return;
  }
  markComplete(i);
  navigateTo(i + 1);
}

// 有测验数据的章节渲染选择题；末章额外渲染填空题
function quizBlockFor(i, s) {
  let h = '';
  const hasQuiz = (s.type === 'content_quiz') || (chapterQuizzes[i] && chapterQuizzes[i].length > 0);
  if (hasQuiz) h += renderChapterQuiz(i);
  if (i === courseData.sections.length - 1) h += renderFillQuiz();
  return h;
}

// ============================================================
// 视频完整观看追踪（解锁前置条件之一）
// 规则：视频需播放至 95% 或触发 ended 才计为「已看完」；
//      拖动进度条被禁止，快进会被拉回已连续观看的最高位置。
// ============================================================
function initVideoTracking() {
  videoMeta = [];
  let vi = 0;
  courseData.sections.forEach((s, chIdx) => {
    const vids = document.querySelectorAll('.section[data-section="' + chIdx + '"] video');
    vids.forEach((v) => {
      const meta = { idx: vi, chIdx: chIdx, src: videoSrcName(v) };
      videoMeta.push(meta);
      attachVideoGuards(v, meta);
      vi++;
    });
  });
}

function videoSrcName(v) {
  const src = v.querySelector('source');
  return src ? src.getAttribute('src') : '';
}

function attachVideoGuards(v, meta) {
  v.dataset.videoIdx = String(meta.idx);
  // 禁止拖动：拖动后立刻回到「已连续观看的最高点」
  v.addEventListener('seeking', () => {
    const allow = videoMaxTime[meta.idx] || 0;
    // 允许极小抖动（1 秒内），其余一律拉回
    if (v.currentTime > allow + 1) {
      v.currentTime = Math.min(allow, v.duration || allow);
      if (!v.dataset.seekWarned || Date.now() - Number(v.dataset.seekWarned) > 4000) {
        v.dataset.seekWarned = String(Date.now());
        showToast('🔒 视频不可快进，请按顺序完整观看', 'warning');
      }
    }
  });
  // 记录观看进度
  v.addEventListener('timeupdate', () => {
    const t = v.currentTime;
    if (!videoMaxTime[meta.idx] || t > videoMaxTime[meta.idx]) videoMaxTime[meta.idx] = t;
    maybeMarkWatched(v, meta);
  });
  v.addEventListener('ended', () => { markVideoWatched(meta); });
  v.addEventListener('loadedmetadata', () => { renderVideoStatus(meta.chIdx); });
  // 从已看位置继续播放（刷新后不从头再来）
  v.addEventListener('play', () => {
    const allow = videoMaxTime[meta.idx] || 0;
    if (allow > 2 && Math.abs(v.currentTime - allow) > 2) v.currentTime = allow;
  });
}

function maybeMarkWatched(v, meta) {
  const dur = v.duration;
  if (!dur || !isFinite(dur) || dur <= 0) return;
  const pos = videoMaxTime[meta.idx] || v.currentTime;
  if (pos / dur >= VIDEO_WATCH_RATIO) markVideoWatched(meta);
}

function markVideoWatched(meta) {
  if (videoWatched.has(meta.idx)) return;
  videoWatched.add(meta.idx);
  renderVideoStatus(meta.chIdx);
  updateSidebarLocks();
  saveProgress();
  const left = chapterVideosLeft(meta.chIdx);
  if (left === 0) {
    showToast('🎬 第 ' + (meta.chIdx + 1) + ' 章视频已全部看完', 'success');
  } else {
    showToast('🎬 已看完 1 段视频（本章还有 ' + left + ' 段）', 'success');
  }
}

// 某章尚未看完的视频数量
function chapterVideosLeft(chIdx) {
  return videoMeta.filter(m => m.chIdx === chIdx && !videoWatched.has(m.idx)).length;
}
function chapterVideosDone(chIdx) {
  const total = videoMeta.filter(m => m.chIdx === chIdx).length;
  return total > 0 && chapterVideosLeft(chIdx) === 0;
}

// 渲染某章的视频观看状态条（标题下方）
function renderVideoStatus(chIdx) {
  const mine = videoMeta.filter(m => m.chIdx === chIdx);
  if (mine.length === 0) return;
  const watched = mine.filter(m => videoWatched.has(m.idx)).length;
  const allDone = watched === mine.length;
  // 每段视频的角标
  mine.forEach((m) => {
    const v = document.querySelector('video[data-video-idx="' + m.idx + '"]');
    if (!v) return;
    const wrap = v.closest('.video-wrapper');
    if (!wrap) return;
    let flag = wrap.querySelector('.video-flag');
    if (!flag) {
      flag = document.createElement('div');
      flag.className = 'video-flag';
      wrap.insertBefore(flag, wrap.firstChild);
    }
    flag.textContent = videoWatched.has(m.idx) ? '✅ 已看完' : '⏳ 待完整观看';
    flag.classList.toggle('done', videoWatched.has(m.idx));
  });
  // 状态条
  const section = document.querySelector('.section[data-section="' + chIdx + '"]');
  if (!section) return;
  let bar = document.getElementById('videostatus-' + chIdx);
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'video-status-bar';
    bar.id = 'videostatus-' + chIdx;
    const firstWrap = section.querySelector('.video-wrapper');
    if (firstWrap) section.insertBefore(bar, firstWrap);
    else section.appendChild(bar);
  }
  bar.innerHTML = allDone
    ? '<span class="vs-ok">🎬 本章 ' + mine.length + ' 段视频已全部完整观看</span>'
    : '<span class="vs-pending">🔒 本章 ' + mine.length + ' 段视频已看完 ' + watched + ' 段，还剩 ' + (mine.length - watched) + ' 段需完整播放（不可拖动快进）</span>';
}

function restoreVideoUI() {
  videoMeta.forEach((m) => { renderVideoStatus(m.chIdx); });
}

// ============================================================
// 章节测验（串行锁定：答对上一题才解锁下一题）
// ============================================================
function renderChapterQuiz(chIdx) {
  const qs = chapterQuizzes[chIdx];
  if (!qs || qs.length === 0) return '';
  const isFinal = (chIdx === courseData.sections.length - 1);
  const title = isFinal
    ? '🎯 综合考核题（共 ' + qs.length + ' 题，全部答对后计入考核）'
    : '📝 章节测验（共 ' + qs.length + ' 题，全部答对后解锁下一章）';
  const doneText = isFinal ? '✅ 综合考核题已全部通过！' : '✅ 本章测验已全部通过！';
  const tipText = isFinal
    ? '📋 请按顺序答完所有综合考核题（每题答对才能解锁下一题）'
    : '📋 请按顺序答完所有题目';
  // 解锁规则说明（视频 + 测验双条件）
  const unlockNote = isFinal
    ? '本章为终极考核，需完成下方全部考核环节。'
    : '🔓 解锁下一章需同时满足：① 本章视频全部完整观看（不可快进）② 本章测验全部答对。';
  return '<div class="card" style="border-top:4px solid var(--primary);" id="chquizwrap-' + chIdx + '">' +
    '<h2 style="margin-bottom:8px;">' + title + '</h2>' +
    '<p style="margin:0 0 8px 0;font-size:13px;color:var(--text-secondary);background:#EEF2FF;border-left:3px solid var(--primary);padding:8px 12px;border-radius:4px">' + unlockNote + '</p>' +
    '<p style="margin:0 0 12px 0;font-size:13px;color:var(--text-secondary);background:#FFF7ED;border-left:3px solid #F59E0B;padding:8px 12px;border-radius:4px">🔒 串行作答：第 1 题答对后才能解锁第 2 题，以此类推。答错的题可以点「重新作答」再做一次。</p>' +
    qs.map((q, qi) =>
      '<div class="quiz-card' + (qi > 0 && !isPreviousQuestionCorrect(chIdx, qi) ? ' locked' : '') + '" id="chquiz-' + chIdx + '-' + qi + '" data-answered="false">' +
        '<div class="quiz-question">第 ' + (qi + 1) + ' 题：' + escapeHtml(q.q) + '</div>' +
        '<div class="quiz-options">' + q.opts.map((opt, oi) =>
          '<div class="quiz-option" data-option="' + oi + '" onclick="selectChQuizOption(this,' + oi + ',' + chIdx + ',' + qi + ')">' +
          '<span class="quiz-option-label">' + String.fromCharCode(65 + oi) + '</span><span>' + escapeHtml(opt) + '</span></div>').join('') +
        '</div>' +
        '<div class="quiz-feedback" id="feedback-chquiz-' + chIdx + '-' + qi + '"></div>' +
        '<div class="quiz-locked-hint"><span>🔒 请先答对上一题，本题才会解锁</span></div>' +
      '</div>').join('') +
    '<div id="chquizstatus-' + chIdx + '" style="text-align:center;margin-top:8px;padding:12px;border-radius:8px;font-size:14px;background:' +
      (chapterQuizDone[chIdx] ? '#ECFDF5' : '#F8FAFC') + ';">' +
      (chapterQuizDone[chIdx]
        ? '<span style="color:#065F46;font-weight:600;">' + doneText + '</span>'
        : '<span style="color:#64748B;">' + tipText + '</span>') +
    '</div></div>';
}

function isPreviousQuestionCorrect(chIdx, qi) {
  if (qi === 0) return true;
  const prev = document.getElementById('chquiz-' + chIdx + '-' + (qi - 1));
  if (!prev) return false;
  return prev.dataset.answered === 'true' && !prev.querySelector('.quiz-option.wrong');
}

function updateChapterQuizLockState(chIdx) {
  const qs = chapterQuizzes[chIdx] || [];
  const done = chapterQuizDone[chIdx];
  qs.forEach((q, qi) => {
    const card = document.getElementById('chquiz-' + chIdx + '-' + qi);
    if (!card) return;
    // 本章已全部答对 → 清除所有锁定（否则刷新后会残留「锁定」外观）
    if (done || isPreviousQuestionCorrect(chIdx, qi)) card.classList.remove('locked');
    else card.classList.add('locked');
  });
}

function selectChQuizOption(el, oi, chIdx, qi) {
  const card = document.getElementById('chquiz-' + chIdx + '-' + qi);
  if (!card || card.dataset.answered === 'true') return;
  if (card.classList.contains('locked')) { showToast('🔒 请先答对上一题', 'warning'); return; }
  const q = chapterQuizzes[chIdx][qi];
  const isCorrect = (oi === q.correct);
  card.querySelectorAll('.quiz-option').forEach(b => {
    const optIdx = parseInt(b.dataset.option, 10);
    b.style.pointerEvents = 'none';
    if (isCorrect && optIdx === q.correct) b.classList.add('correct');
    else if (!isCorrect && optIdx === oi) b.classList.add('wrong');
    else b.classList.add('disabled');
  });
  const fb = document.getElementById('feedback-chquiz-' + chIdx + '-' + qi);
  if (isCorrect) {
    fb.innerHTML = '✅ 回答正确！';
    fb.classList.add('show', 'correct');
    card.style.borderColor = 'var(--success)';
  } else {
    // 学习者红线：不展示正确答案，只提示错误并允许重做
    fb.innerHTML = '❌ 这个选项还不对。再想一想第 ' + (qi + 1) + ' 题考的是哪个知识点，点「重新作答」再试一次。' +
      '<div class="quiz-retry"><button class="btn btn-outline btn-sm" onclick="resetChapterQuiz(' + chIdx + ',' + qi + ')">重新作答</button></div>';
    fb.classList.add('show', 'wrong');
    card.style.borderColor = 'var(--danger)';
  }
  card.dataset.answered = 'true';
  chapterQuizAnswers[chIdx + '_' + qi] = { selected: oi, isCorrect: isCorrect };
  updateChapterQuizLockState(chIdx);
  checkChapterQuizComplete(chIdx);
  saveProgress();
}

function resetChapterQuiz(chIdx, qi) {
  const card = document.getElementById('chquiz-' + chIdx + '-' + qi);
  if (!card) return;
  card.dataset.answered = 'false';
  card.querySelectorAll('.quiz-option').forEach(b => {
    b.classList.remove('correct', 'wrong', 'disabled');
    b.style.pointerEvents = '';
  });
  card.style.borderColor = '';
  const fb = document.getElementById('feedback-chquiz-' + chIdx + '-' + qi);
  fb.classList.remove('show', 'correct', 'wrong');
  fb.innerHTML = '';
  delete chapterQuizAnswers[chIdx + '_' + qi];
  updateChapterQuizLockState(chIdx);
  saveProgress();
}

function checkChapterQuizComplete(chIdx) {
  if (chapterQuizDone[chIdx]) return;
  const qs = chapterQuizzes[chIdx] || [];
  if (qs.length === 0) return;
  const allCorrect = qs.every((q, qi) => {
    const card = document.getElementById('chquiz-' + chIdx + '-' + qi);
    return card && card.dataset.answered === 'true' && !card.querySelector('.quiz-option.wrong');
  });
  if (!allCorrect) return;
  chapterQuizDone[chIdx] = true;
  refreshChapterQuizStatus(chIdx);
  updateSidebarLocks();
  const left = chapterVideosLeft(chIdx);
  if (left > 0) {
    showToast('📝 第 ' + (chIdx + 1) + ' 章测验已全部答对！还有 ' + left + ' 段视频未完整观看，看完即可解锁下一章', 'warning');
  } else {
    showToast('🎉 ' + (chIdx === courseData.sections.length - 1 ? '综合考核题' : '第 ' + (chIdx + 1) + ' 章测验') + '全部通过，且视频已看完！', 'success');
  }
  saveProgress();
}

// 刷新某章测验的底部状态条（首次渲染 / 答题完成 / 进度恢复 共用）
function refreshChapterQuizStatus(chIdx) {
  const el = document.getElementById('chquizstatus-' + chIdx);
  if (!el) return;
  const done = !!chapterQuizDone[chIdx];
  const isFinal = (chIdx === courseData.sections.length - 1);
  const left = chapterVideosLeft(chIdx);
  const total = videoMeta.filter(m => m.chIdx === chIdx).length;
  let extra = '';
  if (total > 0 && left > 0) {
    extra = '<div style="margin-top:6px;font-size:12.5px;color:#B45309;">🔒 本章还有 ' + left + ' 段视频未完整观看，看完后才能进入下一章</div>';
  }
  el.style.background = done ? '#ECFDF5' : '#F8FAFC';
  el.innerHTML = (done
    ? '<span style="color:#065F46;font-weight:600;">' + (isFinal ? '✅ 综合考核题已全部通过！' : '✅ 本章测验已全部通过！') + '</span>'
    : '<span style="color:#64748B;">' + (isFinal ? '📋 请按顺序答完所有综合考核题（每题答对才能解锁下一题）' : '📋 请按顺序答完所有题目') + '</span>') + extra;
}

// ============================================================
// 终极考核 · 填空题（关键词作答，答错可重填，不直接给答案）
// ============================================================
function normFill(s) {
  return String(s === undefined || s === null ? '' : s)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、；：！？,.;:!?"'“”‘’（）()【】\[\]《》<>·—－-]/g, '')
    .replace(/％/g, '%');
}

function renderFillQuiz() {
  const fills = APP.finalFills || [];
  if (!fills.length) return '';
  const allDone = fills.every((f, i) => fillAnswers[i] && fillAnswers[i].correct);
  return '<div class="card" style="border-top:4px solid var(--accent);" id="fillwrap">' +
    '<h2 style="margin-bottom:8px;">✏️ 考核填空（共 ' + fills.length + ' 题，全部答对后计入考核）</h2>' +
    '<p style="margin:0 0 12px 0;font-size:13px;color:var(--text-secondary);background:#FFF7ED;border-left:3px solid #F59E0B;padding:8px 12px;border-radius:4px">填写关键词即可，系统会自动忽略空格与标点。答错会给出知识点提示，可以反复重填。</p>' +
    fills.map((f, i) => {
      const rec = fillAnswers[i];
      const ok = rec && rec.correct;
      return '<div class="fill-card' + (ok ? ' ok' : '') + '" id="fill-' + i + '" data-answered="' + (ok ? 'true' : 'false') + '">' +
        '<div class="quiz-question">第 ' + (i + 1) + ' 题：' + escapeHtml(f.q) + '</div>' +
        '<div class="fill-row">' +
          '<input class="fill-input" id="fillInput-' + i + '" type="text" autocomplete="off" ' +
            'placeholder="' + escapeHtml(f.placeholder || '填写答案') + '" ' +
            (ok ? 'disabled value="' + escapeHtml(rec.value) + '"' : '') +
            ' onkeypress="if(event.key===\'Enter\')submitFill(' + i + ')">' +
          (ok ? '' : '<button class="btn" id="fillBtn-' + i + '" onclick="submitFill(' + i + ')">提交</button>') +
        '</div>' +
        '<div class="quiz-feedback' + (ok ? ' show correct' : '') + '" id="fillFeedback-' + i + '">' +
          (ok ? '✅ 回答正确！' : '') +
        '</div>' +
      '</div>';
    }).join('') +
    '<div id="fillstatus" style="text-align:center;margin-top:8px;padding:12px;border-radius:8px;font-size:14px;background:' +
      (allDone ? '#ECFDF5' : '#F8FAFC') + ';">' +
      (allDone
        ? '<span style="color:#065F46;font-weight:600;">✅ 填空题已全部通过！</span>'
        : '<span style="color:#64748B;">📋 请依次填写完成全部填空题</span>') +
    '</div></div>';
}

function submitFill(idx) {
  const f = (APP.finalFills || [])[idx];
  const card = document.getElementById('fill-' + idx);
  if (!f || !card || card.dataset.answered === 'true') return;
  const input = document.getElementById('fillInput-' + idx);
  const fb = document.getElementById('fillFeedback-' + idx);
  const raw = input.value;
  if (!normFill(raw)) {
    fb.innerHTML = '请先填写答案再提交。';
    fb.classList.add('show', 'wrong');
    input.focus();
    return;
  }
  const ok = f.answer.some(a => normFill(a) === normFill(raw));
  if (ok) {
    card.dataset.answered = 'true';
    card.classList.add('ok');
    input.disabled = true;
    fillAnswers[idx] = { value: raw, correct: true };
    fb.innerHTML = '✅ 回答正确！';
    fb.classList.remove('wrong');
    fb.classList.add('show', 'correct');
    const btn = document.getElementById('fillBtn-' + idx);
    if (btn) btn.remove();
    showToast('✅ 第 ' + (idx + 1) + ' 题回答正确', 'success');
    checkFillComplete();
    saveProgress();
  } else {
    // 学习者红线：不展示正确答案，只给知识点提示，允许反复重填
    fb.innerHTML = '❌ 这一空还不对。<span class="fill-hint">💡 ' + escapeHtml(f.hint) + '</span>' +
      '<div class="quiz-retry"><button class="btn btn-outline btn-sm" onclick="resetFill(' + idx + ')">清空重填</button></div>';
    fb.classList.remove('correct');
    fb.classList.add('show', 'wrong');
  }
}

function resetFill(idx) {
  const card = document.getElementById('fill-' + idx);
  if (!card || card.dataset.answered === 'true') return;
  const input = document.getElementById('fillInput-' + idx);
  input.value = '';
  input.focus();
  const fb = document.getElementById('fillFeedback-' + idx);
  fb.classList.remove('show', 'wrong', 'correct');
  fb.innerHTML = '';
}

function checkFillComplete() {
  const fills = APP.finalFills || [];
  const allDone = fills.length > 0 && fills.every((f, i) => fillAnswers[i] && fillAnswers[i].correct);
  const statusEl = document.getElementById('fillstatus');
  if (statusEl) {
    statusEl.style.background = allDone ? '#ECFDF5' : '#F8FAFC';
    statusEl.innerHTML = allDone
      ? '<span style="color:#065F46;font-weight:600;">✅ 填空题已全部通过！</span>'
      : '<span style="color:#64748B;">📋 请依次填写完成全部填空题</span>';
  }
  if (allDone && !fillDone) showToast('🎉 填空题已全部通过！', 'success');
  fillDone = allDone;
}

function restoreFillUI() {
  const fills = APP.finalFills || [];
  for (let i = 0; i < fills.length; i++) {
    const rec = fillAnswers[i];
    if (!rec) continue;
    const card = document.getElementById('fill-' + i);
    const input = document.getElementById('fillInput-' + i);
    const fb = document.getElementById('fillFeedback-' + i);
    if (rec.correct) {
      if (card) { card.dataset.answered = 'true'; card.classList.add('ok'); }
      if (input) { input.value = rec.value; input.disabled = true; }
      const btn = document.getElementById('fillBtn-' + i);
      if (btn) btn.remove();
      if (fb) { fb.innerHTML = '✅ 回答正确！'; fb.classList.add('show', 'correct'); }
    }
  }
  checkFillComplete();
}

// ============================================================
// 第 3 章：家长沟通模拟练习（五维关键词评分，权重和 90 + 长度加分 10）
// ============================================================
function submitPractice() {
  const ta = document.getElementById('practiceTextarea');
  const text = (ta.value || '').trim();
  const warn = document.getElementById('practiceWarn');
  if (text.length < 40) { warn.style.display = 'block'; return; }
  warn.style.display = 'none';

  let total = 0;
  const results = PRACTICE_DIMS.map(dim => {
    const matched = dim.keywords.filter(k => text.indexOf(k) !== -1);
    // 每个命中要点计 4 分，命中 5 个及以上即满该维度分
    const score = Math.min(dim.max, matched.length * 4);
    total += score;
    return { name: dim.name, score: score, max: dim.max, matched: matched };
  });

  // 长度加分：≥60字 +5，≥120字 +5（上限 100）
  let lengthBonus = 0;
  if (text.length >= 60) lengthBonus += 5;
  if (text.length >= 120) lengthBonus += 5;
  total = Math.min(100, total + lengthBonus);
  practiceScore = total;
  practiceSubmitted = true;

  const dimsEl = document.getElementById('practiceScoreDims');
  dimsEl.innerHTML = results.map((d, i) => {
    const pct = Math.round(d.score / d.max * 100);
    const color = pct >= 75 ? '#059669' : pct >= 40 ? '#D97706' : '#DC2626';
    return '<div style="margin-bottom:12px">' +
      '<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">' +
      '<span style="font-weight:600">' + (i + 1) + '. ' + d.name + '</span>' +
      '<span style="color:' + color + ';font-weight:700">' + d.score + ' / ' + d.max + '</span></div>' +
      '<div style="height:6px;background:#E2E8F0;border-radius:3px;overflow:hidden">' +
      '<div style="height:100%;width:' + pct + '%;background:' + color + ';border-radius:3px;transition:width .5s"></div></div>' +
      '<div style="font-size:11px;color:#94A3B8;margin-top:2px">命中要点：' + (d.matched.length ? d.matched.join('、') : '未覆盖') + '</div></div>';
  }).join('') +
  '<div style="font-size:12px;color:var(--text-secondary);margin-top:6px">字数：' + text.length + ' 字，长度加分 +' + lengthBonus + '</div>';

  const totalEl = document.getElementById('practiceScoreTotal');
  const passed = total >= 60;
  const vidsLeft = chapterVideosLeft(2);
  totalEl.style.background = passed ? '#ECFDF5' : '#FEF2F2';
  totalEl.style.color = passed ? '#065F46' : '#991B1B';
  totalEl.innerHTML = passed
    ? ('✅ 本次得分 ' + total + ' 分 — 已通过本章练习'
       + (vidsLeft > 0 ? '；另有 ' + vidsLeft + ' 段视频未完整观看，看完后可进入下一章' : '，且视频已看完，可进入下一章'))
    : '本次得分 ' + total + ' 分 — 尚未通过，请对照「参考要点」补充后再提交一次';

  document.getElementById('practiceScorePanel').style.display = 'block';
  document.getElementById('practiceRefPanel').classList.add('show');
  ta.disabled = true;
  document.getElementById('practiceSubmitBtn').style.display = 'none';
  saveProgress();
  updateSidebarLocks();
  showToast('本次得分：' + total + ' 分', passed ? 'success' : 'warning');
}

function resetPractice() {
  practiceSubmitted = false;
  practiceScore = 0;
  const ta = document.getElementById('practiceTextarea');
  ta.value = '';
  ta.disabled = false;
  document.getElementById('practiceScorePanel').style.display = 'none';
  document.getElementById('practiceRefPanel').classList.remove('show');
  document.getElementById('practiceSubmitBtn').style.display = 'inline-block';
  document.getElementById('practiceWarn').style.display = 'none';
  saveProgress();
  updateSidebarLocks();
}

function restorePracticeUI() {
  if (!practiceSubmitted) return;
  const ta = document.getElementById('practiceTextarea');
  if (ta) ta.disabled = true;
  const panel = document.getElementById('practiceScorePanel');
  if (panel) panel.style.display = 'block';
  const ref = document.getElementById('practiceRefPanel');
  if (ref) ref.classList.add('show');
  const btn = document.getElementById('practiceSubmitBtn');
  if (btn) btn.style.display = 'none';
  const dimsEl = document.getElementById('practiceScoreDims');
  if (dimsEl) dimsEl.innerHTML = '<div style="font-size:13px;color:var(--text-secondary)">（刷新后不再展示逐项明细，仅保留总分）</div>';
  const totalEl = document.getElementById('practiceScoreTotal');
  if (totalEl) {
    const passed = practiceScore >= 60;
    const vidsLeft = chapterVideosLeft(2);
    totalEl.style.background = passed ? '#ECFDF5' : '#FEF2F2';
    totalEl.style.color = passed ? '#065F46' : '#991B1B';
    totalEl.innerHTML = passed
      ? ('✅ 本次得分 ' + practiceScore + ' 分 — 已通过本章练习'
         + (vidsLeft > 0 ? '；另有 ' + vidsLeft + ' 段视频未完整观看，看完后可进入下一章' : '，且视频已看完，可进入下一章'))
      : '本次得分 ' + practiceScore + ' 分 — 尚未通过，请对照「参考要点」补充后再提交一次';
  }
}

// ============================================================
// 导航与解锁
// ============================================================
// 进入第 index 章的门槛：前面的每一章都必须「视频看完 + 该章任务完成」
function canNavigateTo(index) {
  if (index === 0) return { ok: true };
  for (let i = 0; i < index; i++) {
    const gate = chapterGate(i);
    if (!gate.ok) return { ok: false, msg: '请先完成第 ' + (i + 1) + ' 章：' + gate.msg };
  }
  return { ok: true };
}

// 单章通过条件：① 本章视频全部完整观看 ② 该章任务完成（测验/练习）
function chapterGate(i) {
  const left = chapterVideosLeft(i);
  if (left > 0) {
    return { ok: false, msg: '还有 ' + left + ' 段视频未完整观看（视频不可拖动快进）' };
  }
  if (i === 2) {
    // 第 3 章：沉浸式沟通练习，需提交且得分达标
    if (!practiceSubmitted) return { ok: false, msg: '家长沟通模拟练习尚未提交' };
    if (practiceScore < 60) return { ok: false, msg: '练习得分 ' + practiceScore + ' 分，尚未通过，请参考要点修改后重新提交' };
    return { ok: true };
  }
  const qs = chapterQuizzes[i] || [];
  if (qs.length === 0) return { ok: true };
  if (!chapterQuizDone[i]) return { ok: false, msg: '测验尚未全部答对（' + countChapterQuizCorrect(i) + '/' + qs.length + '）' };
  return { ok: true };
}

// 已答对的题数（用于给学员进度反馈，不泄露答案）
function countChapterQuizCorrect(chIdx) {
  const qs = chapterQuizzes[chIdx] || [];
  let n = 0;
  qs.forEach((q, qi) => {
    const rec = chapterQuizAnswers[chIdx + '_' + qi];
    if (rec && rec.isCorrect) n++;
  });
  return n;
}

function navigateTo(index) {
  const check = canNavigateTo(index);
  if (!check.ok) { showToast('🔒 ' + check.msg, 'warning'); return; }
  currentSection = index;
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-section').forEach(n => n.classList.remove('active'));
  const section = document.querySelector('.section[data-section="' + index + '"]');
  if (section) section.classList.add('active');
  const navItem = document.querySelector('.nav-section[data-index="' + index + '"]');
  if (navItem) navItem.classList.add('active');
  updateProgress(); updateNotesForSection(index); saveProgress();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('show');
  const mhTitle = document.getElementById('mhTitle');
  if (mhTitle) mhTitle.textContent = courseData.sections[index].title;
}

function markComplete(index) {
  completedSections.add(index);
  updateProgress(); saveProgress();
  showToast('「' + courseData.sections[index].title + '」已完成 ✓', 'success');
  checkCertificate();
}

// 终极考核三项：综合选择题 + 填空题 + AI 对话评分
function finalQuizDone() { return !!chapterQuizDone[courseData.sections.length - 1]; }
function finalFillsDone() {
  const fills = APP.finalFills || [];
  return fills.length > 0 && fills.every((f, i) => fillAnswers[i] && fillAnswers[i].correct);
}

function tryCompleteCourse(index) {
  if (!finalQuizDone()) { showToast('请先完成终极考核的综合选择题（全部答对）', 'warning'); return; }
  if (!finalFillsDone()) { showToast('请先完成终极考核的填空题（全部答对）', 'warning'); return; }
  if (!finalTaskSubmitted) { showToast('请先完成终极考核的 AI 家长对话并提交评分', 'warning'); return; }
  if (finalScore < 60) { showToast('AI 对话评分尚未通过，请点击「重新开始」再试一次', 'warning'); return; }
  markComplete(index);
}

function updateProgress() {
  const total = courseData.sections.length;
  const viewed = new Set([...completedSections, currentSection]);
  const pct = Math.round((viewed.size / total) * 100);
  document.getElementById('progressPercent').textContent = pct + '%';
  document.getElementById('progressFill').style.width = pct + '%';
  document.querySelectorAll('.nav-section').forEach((el, i) => {
    if (completedSections.has(i)) el.classList.add('completed');
  });
}

// ============================================================
// AI 调用（含限流 / 域名白名单 / 降级）
// ============================================================
const RATE_LIMIT_KEY = LS_PREFIX + '_llm_rate_ts';
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW = 3600000;
function checkRateLimit() {
  const now = Date.now();
  let ts = [];
  try { ts = JSON.parse(localStorage.getItem(RATE_LIMIT_KEY) || '[]'); } catch (e) { ts = []; }
  ts = ts.filter(t => now - t < RATE_LIMIT_WINDOW);
  if (ts.length >= RATE_LIMIT_MAX) {
    const resetIn = Math.ceil((ts[0] + RATE_LIMIT_WINDOW - now) / 60000);
    throw new Error('对话次数已达每小时上限，约 ' + resetIn + ' 分钟后恢复。');
  }
  ts.push(now);
  localStorage.setItem(RATE_LIMIT_KEY, JSON.stringify(ts));
}
async function callLLM(messages, options) {
  options = options || {};
  const maxTokens = options.maxTokens || 500;
  const temperature = (options.temperature === undefined) ? 0.7 : options.temperature;
  if (!aiReady()) throw new Error('AI 功能未配置');
  if (!guardHost()) throw new Error('AI 功能已停用');
  checkRateLimit();
  const res = await fetch(LLM_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _rK() },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: messages,
      thinking: { type: 'disabled' },        // mimo-v2.5-pro 必须关闭思考，否则 content 为空
      max_completion_tokens: maxTokens,      // 参数名映射：max_tokens → max_completion_tokens
      temperature: temperature
    })
  });
  if (!res.ok) {
    let err = 'AI 服务繁忙 (' + res.status + ')';
    try { const j = await res.json(); err = (j.error && j.error.message) || j.message || err; } catch (e) {}
    throw new Error(err);
  }
  return await res.json();
}

// ============================================================
// 终极考核：AI 家长自由对话
// ============================================================
function renderRoleplayHTML() {
  return '<div class="dialogue-container" id="finalDialogue">' +
    '<div class="dialogue-header"><span>📞 续费沟通 · 自由对话</span>' +
      '<div class="dialogue-meta"><span class="badge badge-primary">🔄 对话轮数：<b id="finalRound">0</b></span>' +
      '<span class="badge badge-warning" id="finalTopicBadge">📍 当前话题：-</span></div></div>' +
    '<div class="dialogue-messages" id="finalMessages">' +
      '<div class="chat-msg system" style="justify-content:center"><div class="chat-bubble" style="background:#F8FAFC;color:var(--text-secondary);max-width:90%;text-align:center">点击「开始通话」后，AI 家长将接通，对话会显示在这里。</div></div></div>' +
    '<div class="dialogue-input-area" id="finalInputArea">' +
      '<input type="text" id="finalInput" placeholder="输入你要对家长说的话..." disabled onkeypress="if(event.key===\'Enter\')sendFinalMessage()">' +
      '<button class="btn" id="finalSendBtn" onclick="sendFinalMessage()" disabled>发送</button></div>' +
    '</div>' +
    '<div class="final-actions" style="margin-top:16px;display:flex;gap:12px;justify-content:center;flex-wrap:wrap">' +
      '<button class="btn btn-success final-call-btn" id="finalStartBtn" onclick="startFinalConversation()">📞 开始通话</button>' +
      '<button class="btn" id="finalEndBtn" onclick="endFinalConversation()" disabled>🛑 结束并评分</button>' +
      '<button class="btn btn-outline" onclick="resetFinalConversation()">🔄 重新开始</button></div>' +
    '<div class="ai-feedback-panel" id="finalFeedback"></div>';
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderFinalMessage(role, text) {
  const container = document.getElementById('finalMessages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'chat-msg ' + (role === 'lp' ? 'lp' : 'parent');
  const label = role === 'lp' ? '班主任 · 我' : '乐乐妈妈';
  const avatar = role === 'lp' ? '我' : '妈';
  div.innerHTML = '<div class="chat-avatar">' + avatar + '</div><div class="chat-content">' +
    '<div class="chat-label">' + label + '</div><div class="chat-bubble">' + escapeHtml(text) + '</div></div>';
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function showFinalTyping(show) {
  let el = document.getElementById('finalTyping');
  if (!show) { if (el) el.remove(); return; }
  if (el) return;
  const container = document.getElementById('finalMessages');
  if (!container) return;
  el = document.createElement('div');
  el.id = 'finalTyping';
  el.className = 'chat-msg parent';
  el.innerHTML = '<div class="chat-avatar">妈</div><div class="chat-content"><div class="chat-label">乐乐妈妈</div>' +
    '<div class="typing-indicator"><span></span><span></span><span></span></div></div>';
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function updateFinalTopic() {
  const lastAi = finalMessages.filter(m => m.role === 'assistant').pop();
  const lastText = lastAi ? lastAi.content : '';
  let topic = '开场寒暄';
  for (const t of APP.topicTags) {
    if (t.kw && t.kw.some(k => lastText.indexOf(k) !== -1)) { topic = t.name; break; }
  }
  const badge = document.getElementById('finalTopicBadge');
  if (badge) badge.textContent = '📍 当前话题：' + topic;
  return topic;
}

function getFinalFallbackReply(userText) {
  for (const pair of APP.fallbackReplies) {
    if (pair[0].some(k => userText.indexOf(k) !== -1)) return pair[1];
  }
  return '嗯，我听明白了。不过这件事我还得再想想，你能再跟我说说具体怎么安排吗？';
}

async function startFinalConversation() {
  if (finalConversationStarted || finalAiScoring) return;
  finalConversationStarted = true;
  finalMessages = [{ role: 'system', content: APP.finalSystemPrompt }];
  finalRound = 0;
  document.getElementById('finalStartBtn').disabled = true;
  document.getElementById('finalInput').disabled = false;
  document.getElementById('finalSendBtn').disabled = false;
  document.getElementById('finalEndBtn').disabled = false;
  document.getElementById('finalMessages').innerHTML = '';
  showFinalTyping(true);
  let reply = '喂，你好，请问哪位？';
  try {
    const data = await callLLM(finalMessages, { maxTokens: 200, temperature: 0.75 });
    reply = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim() || reply;
  } catch (e) {
    showToast('AI 家长暂时无法接通，已切换为脚本模拟回复', 'warning');
  } finally {
    showFinalTyping(false);
  }
  finalMessages.push({ role: 'assistant', content: reply });
  renderFinalMessage('parent', reply);
  updateFinalTopic();
  saveProgress();
}

async function sendFinalMessage() {
  if (!finalConversationStarted || finalAiScoring || finalTaskSubmitted) return;
  const input = document.getElementById('finalInput');
  const text = (input.value || '').trim();
  if (!text) return;
  input.value = '';
  renderFinalMessage('lp', text);
  finalMessages.push({ role: 'user', content: text });
  finalRound++;
  document.getElementById('finalRound').textContent = finalRound;
  document.getElementById('finalInput').disabled = true;
  document.getElementById('finalSendBtn').disabled = true;
  showFinalTyping(true);
  let reply;
  try {
    const data = await callLLM(finalMessages, { maxTokens: 200, temperature: 0.75 });
    reply = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim() || getFinalFallbackReply(text);
  } catch (e) {
    reply = getFinalFallbackReply(text);
    showToast('AI 服务暂时不可用，已切换为脚本模拟回复', 'warning');
  } finally {
    showFinalTyping(false);
    if (!finalTaskSubmitted) {
      document.getElementById('finalInput').disabled = false;
      document.getElementById('finalSendBtn').disabled = false;
      document.getElementById('finalInput').focus();
    }
  }
  finalMessages.push({ role: 'assistant', content: reply });
  renderFinalMessage('parent', reply);
  updateFinalTopic();
  saveProgress();
}

async function endFinalConversation() {
  if (!finalConversationStarted || finalAiScoring || finalTaskSubmitted) return;
  if (finalRound < 4) { showToast('请至少完成 4 轮对话再结束评分', 'warning'); return; }
  finalAiScoring = true;
  document.getElementById('finalInput').disabled = true;
  document.getElementById('finalSendBtn').disabled = true;
  document.getElementById('finalEndBtn').disabled = true;
  showToast('正在调用 AI 评分官...', 'success');
  await scoreFinalConversation();
}

async function scoreFinalConversation() {
  const dialogue = finalMessages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => (m.role === 'user' ? '班主任' : '乐乐妈妈') + '：' + m.content).join('\n');
  const scoringPrompt = APP.scoringPrompt.replace('{dialogue}', dialogue);
  try {
    const data = await callLLM([
      { role: 'system', content: '你是一位严格而公正的评分官，只输出合法 JSON，不要任何多余文字。' },
      { role: 'user', content: scoringPrompt }
    ], { maxTokens: 800, temperature: 0.3 });
    const raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
    let result = {};
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      result = JSON.parse(m ? m[0] : raw);
    } catch (e) { console.warn('AI 评分 JSON 解析失败：', raw); }
    const sc = parseInt(result.score, 10);
    finalScore = Math.min(100, Math.max(0, isNaN(sc) ? 65 : sc));
    finalBreakdown = result.breakdown || null;
    finalFeedbackText = result.feedback || '已完成考核。';
  } catch (e) {
    console.error('AI 评分失败：', e);
    finalScore = 0;
    finalBreakdown = null;
    finalFeedbackText = 'AI 评分服务暂时不可用，本次未获得评分。请点击「重新开始」再试一次。';
  } finally {
    finalAiScoring = false;
    if (finalScore > 0) finalTaskSubmitted = true;
    renderFinalScore();
    saveProgress();
    updateSidebarLocks();
    if (finalTaskSubmitted) checkCertificate();
  }
}

function renderFinalScore() {
  const fb = document.getElementById('finalFeedback');
  if (!fb) return;
  if (!finalTaskSubmitted) {
    fb.innerHTML = '<div style="padding:16px;background:#FEF2F2;border-radius:8px;font-size:14px;color:#991B1B;text-align:center">' + escapeHtml(finalFeedbackText) + '</div>';
    fb.classList.add('show');
    return;
  }
  const score = finalScore;
  const level = score >= 80 ? 'high' : score >= 60 ? 'medium' : 'low';
  const levelText = score >= 80 ? '优秀！共情到位，异议抓得住，方案给得实。'
    : score >= 60 ? '通过！整体沟通完整，细节还可以再打磨。'
    : '还需要更多练习，建议回顾前几章后重新开始。';
  const bd = finalBreakdown || {};
  const dim = (k, label) => '<div class="final-score-card"><div class="score">' + (bd[k] === undefined ? '—' : bd[k]) + '</div><div class="label">' + label + '</div></div>';
  fb.innerHTML =
    '<div class="score-display"><div class="score-circle ' + level + '">' + score + '</div>' +
    '<div style="font-size:13px;color:var(--text-secondary);margin-top:4px">综合评分</div></div>' +
    '<p style="text-align:center;font-size:14px;margin-bottom:16px;font-weight:600">' + levelText + '</p>' +
    '<div class="final-score-grid">' + dim('共情', '共情与关系 /25') + dim('诊断', '异议识别与诊断 /25') +
    dim('说服', '方案与说服 /30') + dim('闭环', '闭环与合规 /20') + '</div>' +
    '<div class="final-feedback-text"><strong>AI 评分官点评：</strong><br>' + escapeHtml(finalFeedbackText) + '</div>' +
    (score >= 60
      ? '<div style="margin-top:16px;padding:14px;background:#ECFDF5;border-radius:8px;font-size:14px;color:#065F46;text-align:center"><strong>✅ 考核通过！</strong> 点击右下角「完成课程」即可领取结业证书。</div>'
      : '<div style="margin-top:16px;padding:14px;background:#FEF2F2;border-radius:8px;font-size:14px;color:#991B1B;text-align:center"><strong>📖 本次未通过。</strong> 请点击「重新开始」，回顾前面的章节后再试一次。</div>');
  fb.classList.add('show');
}

function resetFinalConversation() {
  finalConversationStarted = false;
  finalTaskSubmitted = false;
  finalScore = 0;
  finalBreakdown = null;
  finalFeedbackText = '';
  finalRound = 0;
  finalMessages = [];
  finalAiScoring = false;
  const c = document.getElementById('finalMessages');
  if (c) c.innerHTML = '<div class="chat-msg system" style="justify-content:center"><div class="chat-bubble" style="background:#F8FAFC;color:var(--text-secondary);max-width:90%;text-align:center">点击「开始通话」后，AI 家长将接通，对话会显示在这里。</div></div>';
  document.getElementById('finalInput').value = '';
  document.getElementById('finalInput').disabled = true;
  document.getElementById('finalSendBtn').disabled = true;
  document.getElementById('finalEndBtn').disabled = true;
  document.getElementById('finalStartBtn').disabled = false;
  document.getElementById('finalRound').textContent = '0';
  document.getElementById('finalTopicBadge').textContent = '📍 当前话题：-';
  const fb = document.getElementById('finalFeedback');
  fb.classList.remove('show'); fb.innerHTML = '';
  updateSidebarLocks(); saveProgress();
}

function restoreFinalConversation() {
  if (!finalConversationStarted) return;
  const container = document.getElementById('finalMessages');
  if (!container) return;
  container.innerHTML = '';
  finalMessages.forEach(m => {
    if (m.role === 'system') return;
    if (m.role === 'user') renderFinalMessage('lp', m.content);
    if (m.role === 'assistant') renderFinalMessage('parent', m.content);
  });
  document.getElementById('finalRound').textContent = finalRound;
  updateFinalTopic();
  if (finalTaskSubmitted) {
    document.getElementById('finalInput').disabled = true;
    document.getElementById('finalSendBtn').disabled = true;
    document.getElementById('finalEndBtn').disabled = true;
    document.getElementById('finalStartBtn').disabled = true;
    renderFinalScore();
  } else {
    document.getElementById('finalStartBtn').disabled = true;
    document.getElementById('finalInput').disabled = false;
    document.getElementById('finalSendBtn').disabled = false;
    document.getElementById('finalEndBtn').disabled = false;
  }
}

// ============================================================
// 计时器 / 标签页 / 笔记
// ============================================================
function startTimer() {
  const saved = localStorage.getItem(LS_PREFIX + '_study_seconds');
  if (saved) studySeconds = parseInt(saved, 10);
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    studySeconds++;
    updateTimerDisplay();
    if (studySeconds % 10 === 0) localStorage.setItem(LS_PREFIX + '_study_seconds', studySeconds);
  }, 1000);
}
function updateTimerDisplay() {
  const mins = Math.floor(studySeconds / 60), secs = studySeconds % 60;
  const ts = String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
  const el = document.getElementById('timerDisplay'); if (el) el.textContent = ts;
  const mt = document.getElementById('mhTimer'); if (mt) mt.textContent = '⏱ ' + ts;
}

function switchTab(btn, panelId) {
  const wrap = btn.closest('.card') || document;
  wrap.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  wrap.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById(panelId);
  if (panel) panel.classList.add('active');
}

function toggleNotes() { document.getElementById('notesPanel').classList.toggle('open'); }
function updateNotesForSection(index) {
  document.getElementById('notesChapterLabel').textContent = courseData.sections[index].title;
  const saved = JSON.parse(localStorage.getItem(LS_PREFIX + '_notes') || '{}');
  document.getElementById('notesTextarea').value = saved[index] || '';
}
function loadNotes() {
  const saved = JSON.parse(localStorage.getItem(LS_PREFIX + '_notes') || '{}');
  const ta = document.getElementById('notesTextarea');
  if (!ta) return;
  ta.value = saved[currentSection] || '';
  ta.addEventListener('input', function () {
    const all = JSON.parse(localStorage.getItem(LS_PREFIX + '_notes') || '{}');
    all[currentSection] = this.value;
    localStorage.setItem(LS_PREFIX + '_notes', JSON.stringify(all));
  });
}

// ============================================================
// 进度持久化
// ============================================================
function restoreChapterQuizUI() {
  Object.keys(chapterQuizAnswers).forEach(key => {
    const parts = key.split('_').map(Number);
    const chIdx = parts[0], qi = parts[1];
    if (isNaN(chIdx) || isNaN(qi)) return;
    const ans = chapterQuizAnswers[key];
    if (!ans) return;
    const card = document.getElementById('chquiz-' + chIdx + '-' + qi);
    if (!card) return;
    card.dataset.answered = 'true';
    card.querySelectorAll('.quiz-option').forEach(b => {
      const oi = parseInt(b.dataset.option, 10);
      b.style.pointerEvents = 'none';
      if (ans.isCorrect && oi === (chapterQuizzes[chIdx][qi] || {}).correct) b.classList.add('correct');
      else if (!ans.isCorrect && oi === ans.selected) b.classList.add('wrong');
      else b.classList.add('disabled');
    });
    const fb = document.getElementById('feedback-chquiz-' + chIdx + '-' + qi);
    if (fb) {
      if (ans.isCorrect) {
        fb.innerHTML = '✅ 回答正确！';
        fb.classList.add('show', 'correct');
        card.style.borderColor = 'var(--success)';
      } else {
        fb.innerHTML = '❌ 这个选项还不对。点「重新作答」再试一次。' +
          '<div class="quiz-retry"><button class="btn btn-outline btn-sm" onclick="resetChapterQuiz(' + chIdx + ',' + qi + ')">重新作答</button></div>';
        fb.classList.add('show', 'wrong');
        card.style.borderColor = 'var(--danger)';
      }
    }
  });
}

function saveProgress() {
  const state = {
    completedSections: [...completedSections],
    chapterQuizDone: chapterQuizDone,
    chapterQuizAnswers: chapterQuizAnswers,
    fillAnswers: fillAnswers,
    fillDone: fillDone,
    practiceSubmitted: practiceSubmitted,
    practiceScore: practiceScore,
    finalTaskSubmitted: finalTaskSubmitted,
    finalScore: finalScore,
    finalBreakdown: finalBreakdown,
    finalFeedbackText: finalFeedbackText,
    finalConversationStarted: finalConversationStarted,
    finalMessages: finalMessages,
    finalRound: finalRound,
    finalAiScoring: false,
    videoWatched: [...videoWatched],
    videoMaxTime: videoMaxTime,
    currentSection: currentSection
  };
  try { localStorage.setItem(LS_PREFIX + '_progress', JSON.stringify(state)); } catch (e) {}
}

function loadProgress() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_PREFIX + '_progress'));
    if (saved) {
      completedSections = new Set(saved.completedSections || []);
      chapterQuizDone = saved.chapterQuizDone || new Array(chapterQuizzes.length).fill(false);
      if (chapterQuizDone.length !== chapterQuizzes.length) chapterQuizDone = new Array(chapterQuizzes.length).fill(false);
      chapterQuizAnswers = saved.chapterQuizAnswers || {};
      fillAnswers = saved.fillAnswers || {};
      fillDone = false;
      practiceSubmitted = saved.practiceSubmitted || false;
      practiceScore = saved.practiceScore || 0;
      finalTaskSubmitted = saved.finalTaskSubmitted || false;
      finalScore = saved.finalScore || 0;
      finalBreakdown = saved.finalBreakdown || null;
      finalFeedbackText = saved.finalFeedbackText || '';
      finalConversationStarted = saved.finalConversationStarted || false;
      finalMessages = saved.finalMessages || [];
      finalRound = saved.finalRound || 0;
      videoWatched = new Set(saved.videoWatched || []);
      // 旧数据没有视频字段时，已通过章节视为视频已看（避免老学员被新规则卡住）
      if (!saved.videoWatched) {
        videoMeta.forEach((m) => {
          const passed = (m.chIdx === 2)
            ? (saved.practiceSubmitted && (saved.practiceScore || 0) >= 60)
            : !!(saved.chapterQuizDone || [])[m.chIdx];
          if (passed) videoWatched.add(m.idx);
        });
      }
      videoMaxTime = saved.videoMaxTime || {};
      currentSection = saved.currentSection || 0;
      // 兼容旧数据：有完成标记但没有答题记录 → 重置测验状态
      const hasDoneButNoAnswers = chapterQuizDone.some(d => d) && Object.keys(chapterQuizAnswers).length === 0;
      if (hasDoneButNoAnswers) chapterQuizDone = new Array(chapterQuizzes.length).fill(false);
      if (!canNavigateTo(currentSection).ok) currentSection = 0;
      updateProgress();
      updateSidebarLocks();
      restorePracticeUI();
      restoreChapterQuizUI();
      for (let i = 0; i < chapterQuizzes.length; i++) {
        if (chapterQuizzes[i] && chapterQuizzes[i].length > 0) {
          updateChapterQuizLockState(i);
          refreshChapterQuizStatus(i);
        }
      }
      restoreFillUI();
      restoreFinalConversation();
      restoreVideoUI();
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      const section = document.querySelector('.section[data-section="' + currentSection + '"]');
      if (section) section.classList.add('active');
      const navItem = document.querySelector('.nav-section[data-index="' + currentSection + '"]');
      if (navItem) navItem.classList.add('active');
      const mhTitle = document.getElementById('mhTitle');
      if (mhTitle) mhTitle.textContent = courseData.sections[currentSection].title;
    } else {
      navigateTo(0);
    }
  } catch (e) {
    navigateTo(0);
  }
}

// ============================================================
// 结业证书
// ============================================================
function checkCertificate() {
  const allDone = completedSections.size >= courseData.sections.length
    && finalQuizDone() && finalFillsDone()
    && finalTaskSubmitted && finalScore >= 60;
  if (!allDone) return;
  setTimeout(() => {
    showToast('🏆 恭喜完成全部课程！点击领取结业证书', 'success');
    const fills = APP.finalFills || [];
    const quizN = (chapterQuizzes[courseData.sections.length - 1] || []).length;
    const fillN = fills.filter((f, i) => fillAnswers[i] && fillAnswers[i].correct).length;
    document.getElementById('certScore').textContent =
      '综合评定：通过（选择题 ' + quizN + '/' + quizN + ' · 填空题 ' + fillN + '/' + fills.length + '）';
    document.getElementById('certFinalScore').textContent = 'AI 对话考核得分：' + finalScore + ' 分';
    document.getElementById('certDate').textContent = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
    const savedName = localStorage.getItem(LS_PREFIX + '_student_name');
    if (savedName) {
      document.getElementById('certStudentName').textContent = savedName;
      document.getElementById('certNameEdit').style.display = 'none';
    } else {
      document.getElementById('certNameEdit').style.display = 'block';
      document.getElementById('certNameInput').focus();
    }
    document.getElementById('certOverlay').style.display = 'flex';
  }, 800);
}
function saveCertName() {
  const input = document.getElementById('certNameInput');
  const name = (input.value || '').trim();
  if (!name) { showToast('请输入姓名后再确认', 'warning'); input.focus(); return; }
  localStorage.setItem(LS_PREFIX + '_student_name', name);
  document.getElementById('certStudentName').textContent = name;
  document.getElementById('certNameEdit').style.display = 'none';
  showToast('✅ 姓名已保存', 'success');
}
function closeCertificate() { document.getElementById('certOverlay').style.display = 'none'; }
function printCertificate() {
  const name = document.getElementById('certStudentName').textContent;
  if (!name || name === '请填写姓名') { showToast('请先确认姓名后再打印证书', 'warning'); return; }
  const cert = document.getElementById('certPaper');
  const win = window.open('', '_blank', 'width=750,height=600');
  win.document.write('<html><head><meta charset="UTF-8"><title>结业证书</title><style>');
  win.document.write('body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f1f5f9;}');
  win.document.write('.cert{background:#fff;width:700px;padding:48px 36px;text-align:center;border:2px solid #e2e8f0;border-radius:12px;}');
  win.document.write('.cert h1{font-size:28px;color:#3730A3;margin-bottom:4px;}');
  win.document.write('.cert .sub{font-size:12px;color:#64748b;letter-spacing:0.1em;margin-bottom:24px;}');
  win.document.write('.cert .body{font-size:15px;line-height:2;color:#1e293b;}');
  win.document.write('.cert .name{display:inline-block;border-bottom:2px solid #4F46E5;min-width:120px;padding:4px 12px;margin:0 4px;}');
  win.document.write('.cert .course{font-weight:700;color:#3730A3;margin:8px 0;}');
  win.document.write('.cert .score{margin:20px 0 4px;font-size:16px;font-weight:600;color:#10b981;}');
  win.document.write('.cert .final-score{margin:4px 0 20px;font-size:14px;font-weight:600;color:#3730A3;}');
  win.document.write('.cert .footer{display:flex;justify-content:space-between;font-size:12px;color:#64748b;margin-top:32px;border-top:1px solid #e2e8f0;padding-top:16px;}');
  win.document.write('</style></head><body><div class="cert">');
  win.document.write(cert.innerHTML.replace(/<button[^>]*>[\s\S]*?<\/button>/g, '').replace(/<div class="cert-name-edit"[\s\S]*?<\/div><\/div>/g, ''));
  win.document.write('</div></body></html>');
  win.document.close(); setTimeout(() => win.print(), 500);
}

// ============================================================
// Toast / 侧边栏
// ============================================================
function showToast(msg, type) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarOverlay').classList.toggle('show');
}

document.addEventListener('DOMContentLoaded', init);
