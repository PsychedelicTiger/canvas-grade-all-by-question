// ==UserScript==
// @name         Canvas - Grade All by Question
// @namespace    mort.canvas
// @version      0.4.9
// @description  Batch-edit scores and comments for one Classic Quiz question; save changed students with verification.
// @match        https://*.instructure.com/courses/*/gradebook/speed_grader*
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    const APP_ID = 'mort-grade-all-by-question';
    const BUTTON_ID = `${APP_ID}-button`;

    // -------------------------------------------------------------------------
    // Utilities
    // -------------------------------------------------------------------------

    function getCourseId() {
        const match = location.pathname.match(
            /^\/courses\/(\d+)\/gradebook\/speed_grader/
        );
        return match ? match[1] : null;
    }

    function getAssignmentId() {
        return new URLSearchParams(location.search).get('assignment_id');
    }

    const REQUEST_TIMEOUT_MS = 30000;
    async function request(url, options = {}, format = 'text') {
        const target = new URL(url, location.href);
        if (target.origin !== location.origin) throw new Error('Unexpected cross-site Canvas URL.');
        const controller = new AbortController();
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(new Error('Canvas request timed out. A submitted write may still have reached Canvas.'));
            }, REQUEST_TIMEOUT_MS);
        });
        try {
            return await Promise.race([timeout, (async () => {
                const response = await fetch(target.href, {
                    credentials: 'same-origin', cache: 'no-store', ...options,
                    signal: controller.signal
                });
                if (!response.ok) {
                    const error = new Error(`Canvas returned HTTP ${response.status}.`);
                    error.status = response.status;
                    // A rejection of the original POST is different from failure
                    // of its follow-up redirect or an ambiguous server/network failure.
                    error.definiteRejection = options.method === 'POST' && !response.redirected &&
                        [400, 401, 403, 404, 405, 409, 413, 415, 422, 429].includes(response.status);
                    throw error;
                }
                const value = format === 'json' ? await response.json() : await response.text();
                return { value, link: response.headers.get('Link') };
            })()]);
        } finally { clearTimeout(timer); }
    }
    async function fetchJSON(url) {
        return (await request(url, { headers: { Accept: 'application/json' } }, 'json')).value;
    }
    async function fetchText(url) {
        return (await request(url, { headers: { Accept: 'text/html' } })).value;
    }
    async function fetchAll(url, key) {
        const values = [], seen = new Set();
        while (url) {
            const absolute = new URL(url, location.href).href;
            if (seen.has(absolute)) throw new Error('Canvas returned a repeated pagination link.');
            seen.add(absolute);
            const page = await request(absolute, { headers: { Accept: 'application/json' } }, 'json');
            const rows = key ? page.value[key] : page.value;
            if (!Array.isArray(rows)) throw new Error('Unexpected Canvas list response.');
            values.push(...rows);
            url = null;
            for (const entry of (page.link || '').split(/,(?=\s*<)/)) {
                const match = entry.match(/<([^>]+)>.*?;\s*rel="([^"]+)"/);
                if (match && match[2].split(/\s+/).includes('next')) url = new URL(match[1], absolute).href;
            }
        }
        return values;
    }
    const sameScore = (a, b) => {
        a = String(a ?? '').trim(); b = String(b ?? '').trim();
        if (!a || !b) return a === b;
        return Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Number(a) === Number(b);
    };
    const sameComment = (a, b) => String(a ?? '').replace(/\r\n?/g, '\n') ===
        String(b ?? '').replace(/\r\n?/g, '\n');

    function escapeHTML(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function getQuizSubmissions(courseId, quizId) {
        return fetchAll(
            `/api/v1/courses/${courseId}/quizzes/${quizId}/submissions?per_page=100`, 'quiz_submissions');
    }
    async function getStudents(courseId) {
        return fetchAll(`/api/v1/courses/${courseId}/users?enrollment_type[]=student&per_page=100`);
    }

    // -------------------------------------------------------------------------
    // Canvas discovery
    // -------------------------------------------------------------------------

    async function discoverCanvasData() {
        const courseId = getCourseId();
        const assignmentId = getAssignmentId();

        if (!courseId || !assignmentId) {
            throw new Error(
                'Could not determine the Canvas course ID or assignment ID from this SpeedGrader URL.'
            );
        }

        const assignment = await fetchJSON(
            `/api/v1/courses/${courseId}/assignments/${assignmentId}`
        );

        if (!assignment.quiz_id) {
            throw new Error(
                'This assignment does not appear to be a Classic Canvas Quiz.'
            );
        }

        const quizId = assignment.quiz_id;

        const questions = await fetchAll(
            `/api/v1/courses/${courseId}/quizzes/${quizId}/questions?per_page=100`
        );

        return {
            courseId,
            assignmentId,
            quizId,
            assignment,
            questions: questions.filter(q => q.question_type !== 'text_only_question')
        };
    }

    // -------------------------------------------------------------------------
    // UI
    // -------------------------------------------------------------------------

    function showOverlay() {
        let overlay = document.getElementById(APP_ID);

        if (overlay) {
            return overlay;
        }

        overlay = document.createElement('div');
        overlay.id = APP_ID;

        overlay.innerHTML = `
            <div class="mort-panel" role="dialog" aria-modal="true" aria-labelledby="mort-dialog-title" tabindex="-1">
                <div class="mort-header">
                    <div>
                        <div class="mort-title" id="mort-dialog-title">Grade All by Question</div>
                        <div class="mort-subtitle">
                            Batch grading — edit locally, then Save All Changes
                        </div>
                    </div>

                    <button
                        type="button"
                        class="mort-close"
                        title="Close"
                    >×</button>
                </div>

                <div class="mort-content">
                    <div class="mort-status">
                        Reading quiz information from Canvas…
                    </div>
                </div>
            </div>
        `;

        const previousFocus = document.activeElement;
        const background = [...document.body.children].filter(el => el !== overlay);
        const inertStates = background.map(el => [el, el.inert]);
        background.forEach(el => { el.inert = true; });
        document.body.appendChild(overlay);

        overlay.mortCanLeave = () => true;
        overlay.mortClose = () => {
            if (!overlay.mortCanLeave()) return;
            overlay.mortView = null;
            overlay.remove();
            inertStates.forEach(([el, inert]) => { el.inert = inert; });
            if (previousFocus?.isConnected) previousFocus.focus();
        };
        overlay.querySelector('.mort-close').addEventListener('click', overlay.mortClose);
        overlay.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); overlay.mortClose(); }
            if (event.key !== 'Tab') return;
            const focusable = [...overlay.querySelectorAll('button, input, textarea, select, a[href], [tabindex]')]
                .filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
            const first = focusable[0], last = focusable.at(-1);
            if (!first) { event.preventDefault(); overlay.querySelector('.mort-panel').focus(); }
            else if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement))) {
                event.preventDefault(); last.focus();
            } else if (!event.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement))) {
                event.preventDefault(); first.focus();
            }
        });
        overlay.querySelector('.mort-close').focus();
        // Copied Canvas markup must never submit a native form from this view.
        overlay.addEventListener('submit', event => event.preventDefault());

        return overlay;
    }

    function showQuestionChooser(overlay, data) {
        overlay.mortView = {};
        overlay.querySelector('.mort-batch-footer')?.remove();
        overlay.mortCanLeave = () => true;
        overlay.mortHasChanges = () => false;
        const content = overlay.querySelector('.mort-content');

        const options = data.questions
            .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
            .map(q => `
                <option value="${q.id}">
                    Question ${q.position ?? '?'} —
                    ${escapeHTML(q.question_name || q.question_type)}
                    (${q.points_possible ?? '?'} pts)
                </option>
            `)
            .join('');

        content.innerHTML = `
            <p>
                <strong>${escapeHTML(data.assignment.name)}</strong>
            </p>

            <label
                class="mort-label"
                for="mort-question-select"
            >
                Select a question (latest completed current attempt per student):
            </label>

            <select
                id="mort-question-select"
                class="mort-select"
            >
                ${options}
            </select>

            <div class="mort-actions">
                <button
                    type="button"
                    class="mort-primary"
                    id="mort-load"
                >
                    Show All Responses
                </button>
            </div>

            <div class="mort-note">
                Students currently retaking the quiz are skipped. Each card shows its attempt. Edit scores and comments locally. Use Save All Changes at the bottom to save; Cancel discards unsaved edits.
            </div>
        `;

        content.querySelector('#mort-question-select').focus();
        content.querySelector('#mort-load').disabled = !data.questions.length;
        if (!data.questions.length) content.querySelector('.mort-note').textContent = 'No gradeable questions were returned by Canvas.';
        content.querySelector('#mort-load').addEventListener(
            'click',
            async () => {
                const questionId = Number(
                    content.querySelector('#mort-question-select').value
                );

                const question =
                    data.questions.find(q => q.id === questionId);

                if (!question) return;
                await loadAllResponses(
                    overlay,
                    data,
                    question
                );
            }
        );
    }

    // -------------------------------------------------------------------------
    // Clean Canvas question HTML for our grading view
    // -------------------------------------------------------------------------

    let copySequence = 0;
    function labelCopiedAnswers(clone) {
        // Only interpret Canvas's structural markers, never response wording.
        const authored = '.question_text, .user_content, .answer_text, .answer_html, .quiz_response_text';
        const structural = el => !el.closest(authored);
        const answers = [...clone.querySelectorAll('.answers')].find(structural);
        if (!answers) return;
        const wrap = (nodes, title, kind) => {
            if (!nodes.length) return;
            const box = document.createElement('div');
            box.className = `mort-answer-section mort-answer-${kind}`;
            const heading = document.createElement('div');
            heading.className = 'mort-answer-heading'; heading.textContent = title;
            box.appendChild(heading);
            if (kind === 'student') {
                // Inspect only the identified response itself, not key entries,
                // nested student-authored markup, answer text, or total points.
                const response = nodes.length === 1 && nodes[0].matches('.answer.selected_answer') && structural(nodes[0]) ? nodes[0] : null;
                const correct = !!response?.classList.contains('correct_answer');
                const incorrect = !!response?.classList.contains('wrong_answer');
                const state = correct === incorrect ? 'unknown' : correct ? 'correct' : 'incorrect';
                const status = document.createElement('div');
                status.className = `mort-answer-correctness mort-correctness-${state}`;
                status.textContent = state === 'correct' ? '✓ Canvas marks this answer correct' :
                    state === 'incorrect' ? '✗ Canvas marks this answer incorrect' : '? Correctness unavailable';
                status.title = 'Canvas marker when this response was loaded. This is not a record of individual points awarded; manual score edits do not change it. Reload responses to update.';
                box.appendChild(status);
                const note = document.createElement('div');
                note.className = 'mort-correctness-note';
                note.textContent = 'Canvas marker at load time; not points awarded.';
                box.appendChild(note);
            }
            nodes[0].before(box);
            for (const node of nodes) box.appendChild(node);
        };
        const notice = container => {
            const note = document.createElement('p');
            note.className = 'mort-answer-notice';
            note.textContent = 'Student response and answer key could not be reliably separated here. Original Canvas content is shown below; check the native quiz view if needed.';
            container.prepend(note);
        };
        const isKey = el => /^answer_\d+$/.test(el.id);
        const fullCredit = el => el.classList.contains('correct_answer') ||
            [...el.children].some(child => child.matches('.answer_weight') && Number(child.textContent.trim()) === 100);
        if (clone.matches('.fill_in_multiple_blanks_question')) {
            const groups = [...answers.querySelectorAll('.answer_group')].filter(structural);
            if (!groups.length) {notice(answers); return;}
            for (const group of groups) {
                const entries = [...group.children].filter(el => el.matches('.answer'));
                const student = entries.filter(el => el.matches('.selected_answer') && !isKey(el));
                const key = entries.filter(isKey);
                if (student.length !== 1 || entries.length !== student.length + key.length) {notice(group); continue;}
                wrap(student, "Student’s answer", 'student');
                if (key.length) {
                    // Canvas normally hides a matching key entry using .skipped.
                    // In a separately labeled key it should remain available.
                    key.forEach(el => el.classList.remove('skipped'));
                    wrap(key, key.every(fullCredit) ? 'Accepted answers' : 'Answer key (may include entries with different credit)', 'key');
                } else {
                    const note = document.createElement('p'); note.className = 'mort-answer-notice';
                    note.textContent = 'Answer key not available in this Canvas response.'; group.appendChild(note);
                }
            }
            return;
        }
        if (clone.matches('.essay_question')) {
            const responses = [...answers.querySelectorAll('.quiz_response_text')].filter(el => !el.parentElement.closest(authored));
            if (responses.length === 1) wrap(responses, "Student’s answer", 'student');
            else notice(answers);
            return;
        }
        if (clone.matches('.multiple_choice_question, .true_false_question, .multiple_answers_question')) {
            const entries = [...answers.querySelectorAll('.answer')].filter(el => structural(el) && isKey(el));
            if (!entries.length) {notice(answers); return;}
            for (const entry of entries) {
                const selected = entry.classList.contains('selected_answer');
                wrap([entry], (selected ? 'Student selected' : 'Answer option') +
                    (!selected && fullCredit(entry) ? ' — correct answer' : ''), selected ? 'student' : 'key');
            }
            return;
        }
        // Other question types can have different layouts and grading semantics.
        // Keep their original content and explicitly avoid inferred attribution.
        notice(answers);
    }

    function cleanQuestionHTML(questionElement, questionId) {
        if (!questionElement) {
            return null;
        }

        const clone = questionElement.cloneNode(true);

        // This is Canvas metadata, not an answer whose text happens to be numeric.
        // Remove only direct metadata children of native answer records.
        clone.querySelectorAll('.answer > span.hidden.id').forEach(element => {
            if (/^answer_\d+$/.test(element.parentElement.id) &&
                !element.closest('.question_text, .user_content, .answer_text, .answer_html, .quiz_response_text')) element.remove();
        });

        /*
         * Remove Canvas's native grading controls from the copied question.
         * Our own controls below the response are the authoritative controls
         * in this interface.
         */
        clone.querySelectorAll(
            [
                `[name="question_score_${questionId}"]`,
                `[name="question_score_${questionId}_visible"]`,
                `[name="question_comment_${questionId}"]`
            ].join(',')
        ).forEach(element => {
            const wrapper =
                element.closest('.question_input') ||
                element.closest('.question_comment') ||
                element.closest('.question_score') ||
                element.closest('label');

            if (wrapper && wrapper !== clone) {
                wrapper.remove();
            } else {
                element.remove();
            }
        });

        /*
         * Canvas may leave labels or containers around after the actual
         * controls are removed. Hide common grading-only elements.
         */
        clone.querySelectorAll(
            '.question_points_holder, .question_score_holder'
        ).forEach(element => element.remove());

        /*
         * Remove accessibility/reordering controls that are useful in Canvas's
         * quiz editor but not useful in this grading view.
         */
        clone.querySelectorAll(
            '.move_question, .move_question_dialog, .drag_and_drop_warning'
        ).forEach(element => element.remove());

        const protectedContent = '.question_text, .answers, .answer, .user_content, .quiz_response';
        const isContent = element => element.matches(protectedContent) ||
            element.closest(protectedContent) || element.querySelector(protectedContent);
        clone.querySelectorAll([
            '.accessibility_move', '.accessibility_move_question', '.move_question_link',
            '.move_question', '.move_question_dialog', '.drag_and_drop_warning',
            '.screenreader-only', '.screenreader_only', '.header .name',
            '.question_name', 'label', 'a', 'button', 'span', 'h2', 'h3', 'h4'
        ].join(',')).forEach(element => {
            if (isContent(element)) return;
            const text = element.textContent.trim().replace(/\s+/g, ' ');
            if (/^Question\s+\d+\s*[:.]?$/i.test(text) ||
                /^Additional Comments\s*:?$/i.test(text) ||
                /^Move To(?:\s|\.{3}|…|$)/i.test(text) ||
                /This element is a more accessible alternative/i.test(text) ||
                element.matches('.accessibility_move, .accessibility_move_question, .move_question_link')) {
                element.remove();
            }
        });
        // Some Canvas versions leave orphaned labels as bare text nodes.
        const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
        const removeText = [];
        while (walker.nextNode()) {
            const node = walker.currentNode;
            if (node.parentElement.closest(protectedContent)) continue;
            const text = node.textContent.trim().replace(/\s+/g, ' ');
            if (/^(?:Additional Comments\s*:?|Question\s+\d+\s*[:.]?|Move To(?:\.{3}|…)?)$/i.test(text) ||
                /^This element is a more accessible alternative/i.test(text)) removeText.push(node);
        }
        removeText.forEach(node => node.remove());

        labelCopiedAnswers(clone);

        const prefix = `mort-copy-${questionId}-${++copySequence}-`;
        const ids = new Map();
        [clone, ...clone.querySelectorAll('[id]')].forEach(element => {
            if (element.id) { ids.set(element.id, prefix + element.id); element.id = prefix + element.id; }
        });
        clone.querySelectorAll('*').forEach(element => {
            for (const attr of ['for', 'aria-labelledby', 'aria-describedby']) {
                if (element.hasAttribute(attr)) element.setAttribute(attr,
                    element.getAttribute(attr).split(/\s+/).map(id => ids.get(id) || id).join(' '));
            }
            if (element.matches('input, textarea, select, button')) {
                element.disabled = true;
                if (element.name) element.name = prefix + element.name;
            }
            for (const attr of [...element.attributes]) if (/^on/i.test(attr.name)) element.removeAttribute(attr.name);
        });
        clone.querySelectorAll('script').forEach(element => element.remove());
        return clone.outerHTML;
    }

    // -------------------------------------------------------------------------
    // Fetch + extract
    // -------------------------------------------------------------------------

    const completed = submission => ['complete', 'pending_review'].includes(submission.workflow_state);
    async function assertCurrentAttempt(data, submission) {
        const response = await fetchJSON(`/api/v1/courses/${data.courseId}/quizzes/${data.quizId}/submissions/${submission.id}`);
        const current = response.quiz_submissions?.find(item => String(item.id) === String(submission.id));
        if (!current || String(current.user_id) !== String(submission.user_id) ||
            Number(current.attempt) !== Number(submission.attempt) || !completed(current)) {
            throw new Error('The student’s current attempt changed or is in progress. Reload responses before grading.');
        }
    }
    function historyURL(data, result, pinned = true) {
        const url = new URL(`/courses/${data.courseId}/quizzes/${data.quizId}/history`, location.origin);
        url.searchParams.set('headless', '1');
        url.searchParams.set('user_id', result.userId);
        url.searchParams.set('quiz_submission_id', result.submission.id);
        if (pinned) url.searchParams.set('version', result.version);
        return url.href;
    }
    function preserveCommentNewlines(html) {
        // Canvas places the escaped comment immediately after its textarea tag.
        // HTML parsing discards one initial LF: supply a sacrificial LF so the
        // actual comment survives, including an initial LF or character reference.
        return html.replace(/<textarea\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, tag =>
            /\bname\s*=\s*(?:"question_comment_\d+"|'question_comment_\d+'|question_comment_\d+(?=\s|>))/i.test(tag)
                ? tag + '\n' : tag);
    }
    function parseGradingPage(html, data, question, result, pinned = true) {
        const doc = new DOMParser().parseFromString(preserveCommentNewlines(html), 'text/html');
        const element = doc.querySelector(`#question_${question.id}`);
        const form = element?.closest('form') || doc.querySelector('#update_history_form');
        if (!element) throw new Error('This question was not present in this student’s attempt.');
        if (!form) throw new Error('Canvas grading form was not found for this student.');
        const action = new URL(form.getAttribute('action') || '', location.origin);
        const expected = `/courses/${data.courseId}/quizzes/${data.quizId}/submissions/${result.submission.id}`;
        if (action.origin !== location.origin || action.pathname.replace(/\/$/, '') !== expected) {
            throw new Error('Canvas returned a grading form for an unexpected submission.');
        }
        const user = doc.querySelector('#submission_details .user_id')?.textContent.trim();
        if (user !== String(result.userId)) throw new Error('Canvas submission student could not be verified.');
        const version = form.querySelector('[name="submission_version_number"]')?.value;
        if (!/^\d+$/.test(version || '') || Number(version) < 1 || (pinned && version !== result.version)) {
            throw new Error('Canvas submission version could not be verified.');
        }
        const score = form.querySelector(`[name="question_score_${question.id}"]`);
        const comment = form.querySelector(`[name="question_comment_${question.id}"]`);
        if (!score || !comment || score.disabled || comment.disabled) throw new Error('Editable score/comment fields are missing from Canvas.');
        const pointsText = element.querySelector('.question_points')?.textContent.trim().replace(/^\s*\/\s*/, '') || 'Unknown';
        return { form, element, pointsText, action: action.href, version, score: score.value, comment: comment.value };
    }
    async function loadAllResponses(overlay, data, question) {
        const view = overlay.mortView = {};
        const active = () => overlay.isConnected && overlay.mortView === view;
        const content = overlay.querySelector('.mort-content');
        content.innerHTML = '<div class="mort-loading-title">Loading responses…</div><div class="mort-progress" role="status"></div>';
        const progress = content.querySelector('.mort-progress');
        try {
            const [submissions, students] = await Promise.all([
                getQuizSubmissions(data.courseId, data.quizId), getStudents(data.courseId)
            ]);
            if (!active()) return;
            const names = new Map(students.map(s => [String(s.id), s.sortable_name || s.name]));
            // One card per student; never fall back to an older attempt during a retake.
            const latest = new Map();
            for (const sub of submissions) {
                if (!sub.user_id) continue;
                const key = String(sub.user_id), previous = latest.get(key);
                if (!previous || Number(sub.attempt) > Number(previous.attempt)) latest.set(key, sub);
            }
            const usable = [...latest.values()].filter(completed);
            data.skippedCount = latest.size - usable.length;
            const results = [];
            for (let i = 0; i < usable.length; i++) {
                if (!active()) return;
                const submission = usable[i];
                const result = { submission, userId: submission.user_id,
                    name: names.get(String(submission.user_id)) || `User ${submission.user_id}`,
                    score: '', comment: '', html: null, formHTML: null };
                progress.textContent = `Loading ${i + 1} of ${usable.length}: ${result.name}…`;
                try {
                    await assertCurrentAttempt(data, submission);
                    const page = parseGradingPage(await fetchText(historyURL(data, result, false)), data, question, result, false);
                    // Catch an attempt change between the roster request and HTML retrieval.
                    await assertCurrentAttempt(data, submission);
                    Object.assign(result, { version: page.version, pointsText: page.pointsText, score: page.score, comment: page.comment,
                        formHTML: page.form.outerHTML, html: cleanQuestionHTML(page.element, question.id) });
                } catch (error) { result.error = error.message || String(error); }
                results.push(result);
            }
            if (active()) renderResults(overlay, data, question, results);
        } catch (error) { if (active()) showError(content, error); }
    }

    // -------------------------------------------------------------------------
    // Save
    // -------------------------------------------------------------------------

    // Retain unresolved writes across closing/reopening the overlay and page reloads.
    // These records stay in this tab's session storage; they are never auto-submitted.
    function pendingKey(data, question, result) {
        return `${APP_ID}:pending:${data.courseId}:${data.quizId}:${result.submission.id}:${result.version}:${question.id}`;
    }
    function readPending(data, question, result) {
        const value = sessionStorage.getItem(pendingKey(data, question, result));
        return value ? JSON.parse(value) : null;
    }
    function writePending(data, question, result, value) {
        const key = pendingKey(data, question, result);
        if (value) sessionStorage.setItem(key, JSON.stringify(value));
        else sessionStorage.removeItem(key);
        result.pendingWrite = value;
    }
    function validScore(score) {
        if (score === '') return true;
        if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(score)) return false;
        return Number.isFinite(Number(score)) && (score.split('.')[1] || '').replace(/0+$/, '').length <= 2;
    }
    const matchesValues = (page, values) => sameScore(page.score, values.score) && sameComment(page.comment, values.comment);
    function adoptPage(result, page) {
        result.score = page.score; result.comment = page.comment;
        result.formHTML = page.form.outerHTML; result.pointsText = page.pointsText;
    }
    function reconcilePending(data, question, result, fresh) {
        const pending = result.pendingWrite = readPending(data, question, result);
        if (!pending) return;
        // Older records lack a field mask. Keep their conservative verification
        // behavior rather than guessing which fields were originally submitted.
        const fields = pending.fields || {score: true, comment: true};
        const matchesSent = (!fields.score || sameScore(fresh.score, pending.score)) &&
            (!fields.comment || sameComment(fresh.comment, pending.comment));
        if (matchesSent) {
            // Reconcile the LAST SENT payload, not the user's possibly newer edits.
            // An unrelated field still needs its original conflict baseline:
            // another grader may have edited it while this write was unresolved.
            if (fields.score) result.score = fresh.score;
            if (fields.comment) result.comment = fresh.comment;
            result.formHTML = fresh.form.outerHTML; result.pointsText = fresh.pointsText;
            writePending(data, question, result, null);
        } else if (!pending.acknowledged) {
            throw new Error('Earlier write is still unresolved. Check Canvas again later; no new write was sent. A matching old value does not prove the earlier write was cancelled.');
        } else {
            throw new Error('The earlier request finished but Canvas differs. Use Review / Refresh to reconcile this student.');
        }
    }
    async function saveStudent(data, question, result, score, comment, intent = {score: true, comment: true}) {
        if (intent.score && !validScore(score)) throw new Error('Use a decimal score with at most two decimal places (for example, 1.25).');
        await assertCurrentAttempt(data, result.submission);
        const fresh = parseGradingPage(await fetchText(historyURL(data, result)), data, question, result);
        reconcilePending(data, question, result, fresh);
        // An untouched reopened card is verification-only. Its displayed snapshot
        // is never interpreted as an instruction to overwrite a completed write.
        if (!intent.score) score = fresh.score;
        if (!intent.comment) comment = fresh.comment;
        if (matchesValues(fresh, {score, comment})) {
            adoptPage(result, fresh);
            return {score: fresh.score, comment: fresh.comment};
        }
        if ((intent.score && !sameScore(fresh.score, result.score)) ||
            (intent.comment && !sameComment(fresh.comment, result.comment))) throw new Error('Canvas changed since loading. Use Review / Refresh to compare Canvas with your local edits.');
        const body = new URLSearchParams();
        const metadata = new Set(['authenticity_token', '_method', 'utf8', 'override_scores',
            'headless', 'hide_student_name', 'submission_version_number']);
        for (const [key, value] of new FormData(fresh.form)) {
            if (metadata.has(key) && typeof value === 'string') body.append(key, value);
        }
        if (intent.score && !sameScore(score, fresh.score)) {
            body.set(`question_score_${question.id}`, score);
            body.set(`question_score_${question.id}_visible`, score);
        }
        if (intent.comment && !sameComment(comment, fresh.comment)) body.set(`question_comment_${question.id}`, comment);
        // Storage must succeed BEFORE writing; otherwise recovery after reload is unsafe.
        const sent = {
            score, comment, acknowledged: false,
            fields: {
                score: body.has(`question_score_${question.id}`),
                comment: body.has(`question_comment_${question.id}`)
            }
        };
        // A retake may have begun while the HTML form was being fetched.
        await assertCurrentAttempt(data, result.submission);
        writePending(data, question, result, sent);
        try {
            await request(fresh.action, {method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'},
                body: body.toString(), redirect: 'follow'});
        } catch (error) {
            if (error.definiteRejection) writePending(data, question, result, null);
            throw error;
        }
        writePending(data, question, result, {...sent, acknowledged: true});
        const verified = parseGradingPage(await fetchText(historyURL(data, result)), data, question, result);
        reconcilePending(data, question, result, verified);
        adoptPage(result, verified);
        return {score: verified.score, comment: verified.comment};
    }

    function renderResults(overlay, data, question, results) {
        const view = overlay.mortView = {};
        const active = () => overlay.isConnected && overlay.mortView === view;
        const content = overlay.querySelector('.mort-content');
        content.innerHTML = `
            <div class="mort-results-toolbar">
                <div><div class="mort-results-title">Question ${escapeHTML(question.position)}</div>
                    <div class="mort-results-summary"></div></div>
                <div class="mort-toolbar-help">Edit locally · Scores: up to 2 decimal places · Save All Changes below</div>
                <button type="button" class="mort-secondary" id="mort-back">Choose Another Question</button>
            </div><div class="mort-results"></div>`;
        const list = content.querySelector('.mort-results');
        const footer = document.createElement('div');
        footer.className = 'mort-batch-footer';
        footer.innerHTML = `<div class="mort-batch-message" role="status" aria-live="polite"></div>
            <button type="button" class="mort-primary mort-save-all">Save All Changes</button>
            <button type="button" class="mort-secondary mort-cancel">Cancel</button>`;
        overlay.querySelector('.mort-panel').appendChild(footer);
        const saveAll = footer.querySelector('.mort-save-all'), cancel = footer.querySelector('.mort-cancel');
        const message = footer.querySelector('.mort-batch-message'), back = content.querySelector('#mort-back');
        const close = overlay.querySelector('.mort-close');
        let saving = false, reading = 0;
        const editors = [];
        const editIntent = e => ({
            score: !!e.scoreEdited && (e.score.validity.badInput || !!e.result.pendingWrite || !sameScore(e.score.value, e.result.score)),
            comment: !!e.commentEdited && (!!e.result.pendingWrite || !sameComment(e.comment.value, e.result.comment))
        });
        const changed = e => !!e.result.pendingWrite || (e.score && (editIntent(e).score || editIntent(e).comment));
        const pending = () => editors.filter(changed);
        function summary() {
            const loaded = editors.filter(e => e.score).length;
            content.querySelector('.mort-results-summary').textContent =
                `${loaded} loaded · ${results.length - loaded} failed · ${data.skippedCount || 0} in-progress/unsubmitted skipped · Current completed attempts`;
        }
        function update() {
            const count = pending().length;
            saveAll.disabled = saving || reading > 0 || !count;
            message.textContent = count ? `${count} student(s) with local edits or unresolved writes.` : 'No unsaved changes.';
        }
        function mark(e, state, text) {
            e.card.classList.toggle('mort-card-saved', state === 'success');
            e.card.classList.toggle('mort-card-error', state === 'error');
            e.status.textContent = text;
            e.status.className = `mort-save-status mort-save-${state}`;
        }
        function addControls(e) {
            const box = document.createElement('div');
            box.className = 'mort-grading-controls';
            box.innerHTML = `<label class="mort-score-label"><strong>Score</strong>
                <input type="number" step="0.01" class="mort-score" aria-label="Score for ${escapeHTML(e.result.name)}">
                <span class="mort-points"></span></label>
                <label class="mort-comment-label"><strong>Comment</strong><textarea class="mort-comment" rows="2"></textarea></label>`;
            e.card.insertBefore(box, e.tools);
            e.score = box.querySelector('.mort-score'); e.comment = box.querySelector('.mort-comment');
            // Leave the wheel's normal scrolling behavior intact without stepping the score.
            e.score.addEventListener('wheel', () => e.score.blur(), { passive: true });
            e.points = box.querySelector('.mort-points');
            e.score.value = e.result.score; e.comment.value = e.result.comment;
            e.scoreEdited = e.commentEdited = false;
            e.points.textContent = `/ ${e.result.pointsText || 'Unknown'} pts (this attempt)`;
            for (const field of [e.score, e.comment]) {
                field.addEventListener('input', () => {
                    if (field === e.score) e.scoreEdited = true; else e.commentEdited = true;
                    mark(e, 'working', e.result.pendingWrite ? 'Earlier write needs checking; new edits remain local.' : changed(e) ? 'Unsaved changes' : '');
                    update();
                });
                field.addEventListener('keydown', event => {
                    if (event.key === 'Enter' && (field === e.score || event.ctrlKey || event.metaKey)) {
                        event.preventDefault(); event.stopPropagation();
                    }
                });
            }
        }
        function presentComparison(e, fresh) {
            const generation = e.reviewGeneration;
            e.review.replaceChildren();
            const text = document.createElement('div');
            text.style.whiteSpace = 'pre-wrap';
            text.textContent = `Canvas now — Score: ${fresh.score || '(ungraded)'}; Comment: ${fresh.comment || '(empty)'}\nYour local edits are in the Score and Comment fields above.`;
            e.review.appendChild(text);
            const unresolved = e.result.pendingWrite && !e.result.pendingWrite.acknowledged;
            if (unresolved) {
                const note = document.createElement('p');
                note.textContent = 'The earlier write has not been observed or acknowledged. Check again later. Resolution and new writes are blocked for this student; other students can still be saved.';
                e.review.appendChild(note);
                return;
            }
            for (const [label, keep] of [['Use Canvas values', false], ['Keep my local edits', true]]) {
                const button = document.createElement('button');
                button.type = 'button'; button.className = 'mort-secondary'; button.textContent = label;
                button.addEventListener('click', () => {
                    if (!active() || saving || e.busy || generation !== e.reviewGeneration) return;
                    try {
                        const outstanding = readPending(data, question, e.result);
                        if (outstanding && !outstanding.acknowledged) throw new Error('Earlier write is still unresolved. Refresh before resolving.');
                        // An acknowledged POST has finished; the user explicitly resolves a later difference.
                        writePending(data, question, e.result, null);
                        adoptPage(e.result, fresh);
                        if (!keep) {
                            e.score.value = fresh.score; e.comment.value = fresh.comment;
                            e.scoreEdited = e.commentEdited = false;
                        } else {
                            // Explicitly retaining the displayed draft is an edit decision.
                            e.scoreEdited = e.score.validity.badInput || !sameScore(e.score.value, fresh.score);
                            e.commentEdited = !sameComment(e.comment.value, fresh.comment);
                        }
                        e.points.textContent = `/ ${fresh.pointsText} pts (this attempt)`;
                        e.review.replaceChildren();
                        mark(e, 'working', keep ? 'Local edits retained. Use Save All Changes to submit.' : 'Canvas values adopted locally.');
                        update();
                    } catch (error) {mark(e, 'error', error.message);}
                });
                e.review.appendChild(button);
            }
        }
        async function refresh(e) {
            if (!active() || saving || e.busy) return;
            e.reviewGeneration = (e.reviewGeneration || 0) + 1;
            e.review.replaceChildren();
            e.busy = true; reading++; e.refresh.disabled = true; update();
            try {
                await assertCurrentAttempt(data, e.result.submission);
                const pinned = !!e.result.version;
                const fresh = parseGradingPage(await fetchText(historyURL(data, e.result, pinned)), data, question, e.result, pinned);
                await assertCurrentAttempt(data, e.result.submission);
                if (!active()) return;
                if (!pinned) e.result.version = fresh.version;
                const wasLoaded = !!e.score;
                if (!wasLoaded) {
                    adoptPage(e.result, fresh);
                    e.result.html = cleanQuestionHTML(fresh.element, question.id);
                    e.response.innerHTML = e.result.html;
                    e.result.error = null;
                    e.result.pendingWrite = readPending(data, question, e.result);
                    addControls(e);
                    e.refresh.textContent = 'Review / Refresh';
                }
                try {
                    // Determine draft intent before reconciliation changes the baseline.
                    const intent = editIntent(e);
                    reconcilePending(data, question, e.result, fresh);
                    if (!intent.score) {
                        e.score.value = e.result.score = fresh.score;
                        e.scoreEdited = false;
                    }
                    if (!intent.comment) {
                        e.comment.value = e.result.comment = fresh.comment;
                        e.commentEdited = false;
                    }
                } catch (error) {mark(e, 'error', error.message);}
                presentComparison(e, fresh);
                if (!e.result.pendingWrite) mark(e, 'working', 'Canvas values fetched. Choose how to reconcile below.');
                summary();
            } catch (error) {if (active()) mark(e, 'error', error.message || String(error));}
            finally {
                e.busy = false; reading--;
                if (active()) {e.refresh.disabled = false; update();}
            }
        }
        for (const [index, result] of results.entries()) {
            const card = document.createElement('section'); card.className = 'mort-student-card';
            card.innerHTML = `<div class="mort-student-header"><span class="mort-student-number">${index + 1}</span>
                <strong>${escapeHTML(result.name)}</strong><span class="mort-user-id">Attempt ${escapeHTML(result.submission.attempt)}</span></div>
                <div class="mort-question-container"></div>
                <div class="mort-student-tools"><button type="button" class="mort-secondary mort-refresh"></button>
                <div class="mort-save-status" role="status"></div><div class="mort-review"></div></div>`;
            list.appendChild(card);
            const e = {result, card, tools: card.querySelector('.mort-student-tools'), response: card.querySelector('.mort-question-container'),
                refresh: card.querySelector('.mort-refresh'), status: card.querySelector('.mort-save-status'), review: card.querySelector('.mort-review')};
            editors.push(e);
            if (result.html && !result.error) {
                e.response.innerHTML = result.html; addControls(e); e.refresh.textContent = 'Review / Refresh';
                try {
                    result.pendingWrite = readPending(data, question, result);
                    if (result.pendingWrite) mark(e, 'error', 'An earlier write needs reconciliation. Use Review / Refresh.');
                } catch (error) {mark(e, 'error', `Recovery storage unavailable: ${error.message}`);}
            } else {
                e.response.textContent = result.error || 'Response could not be loaded.';
                e.refresh.textContent = 'Retry loading this student';
            }
            e.refresh.addEventListener('click', () => refresh(e));
        }
        overlay.mortHasChanges = () => saving || pending().length > 0;
        overlay.mortCanLeave = () => !saving && (!pending().length || window.confirm(
            'Discard local edits and close this view? Saved changes remain in Canvas. Unresolved writes are retained in this tab for later checking.'));
        cancel.addEventListener('click', overlay.mortClose);
        back.addEventListener('click', () => {if (overlay.mortCanLeave()) showQuestionChooser(overlay, data);});
        saveAll.addEventListener('click', async () => {
            if (!active() || saving || reading) return;
            const batch = pending().filter(e => e.score).map(e => ({e, score: e.score.value.trim(), comment: e.comment.value,
                badInput: e.score.validity.badInput, intent: editIntent(e)}));
            if (!batch.length) return;
            saving = true;
            saveAll.disabled = cancel.disabled = back.disabled = close.disabled = true;
            editors.forEach(e => {
                if (e.score) e.score.disabled = e.comment.disabled = true;
                e.refresh.disabled = true;
                e.review.querySelectorAll('button').forEach(button => {button.disabled = true;});
            });
            overlay.querySelector('.mort-panel').focus();
            let succeeded = 0, failed = 0;
            try {
                for (const [i, item] of batch.entries()) {
                    const {e, score, comment, badInput, intent} = item;
                    e.review.replaceChildren();
                    message.textContent = `Saving ${i + 1} of ${batch.length}: ${e.result.name}…`;
                    try {
                        if (intent.score && (badInput || !validScore(score))) throw new Error('Enter a decimal score with at most two decimal places.');
                        const saved = await saveStudent(data, question, e.result, score, comment, intent);
                        e.score.value = saved.score; e.comment.value = saved.comment;
                        e.scoreEdited = e.commentEdited = false;
                        e.review.replaceChildren(); mark(e, 'success', '✓ Saved and verified'); succeeded++;
                    } catch (error) {mark(e, 'error', error.message || String(error)); failed++;}
                }
            } finally {
                saving = false; cancel.disabled = back.disabled = close.disabled = false;
                editors.forEach(e => {
                    if (e.score) e.score.disabled = e.comment.disabled = false;
                    e.refresh.disabled = false;
                    e.review.querySelectorAll('button').forEach(button => {button.disabled = false;});
                });
                update(); message.textContent = `${succeeded} saved and verified; ${failed} need attention.`;
            }
        });
        summary(); update(); (editors.find(e => e.score)?.score || back).focus();
    }

    function showError(container, error) {
        console.error(
            '[Grade All by Question]',
            error
        );

        container.innerHTML = `
            <div class="mort-error">
                <strong>Canvas request failed.</strong>
                <br><br>
                ${escapeHTML(error.message || error)}
            </div>
        `;
    }

    // -------------------------------------------------------------------------
    // CSS
    // -------------------------------------------------------------------------

    function installStyles() {
        if (
            document.getElementById(
                `${APP_ID}-styles`
            )
        ) {
            return;
        }

        const style =
            document.createElement('style');

        style.id =
            `${APP_ID}-styles`;

        style.textContent = `
            #${APP_ID} .mort-score { -moz-appearance: textfield; appearance: textfield; }
            #${APP_ID} .mort-score::-webkit-inner-spin-button,
            #${APP_ID} .mort-score::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
            #${APP_ID} .mort-answer-section { margin: 10px 0; padding: 12px; border: 1px solid #aab7c4; border-radius: 5px; }
            #${APP_ID} .mort-answer-student { background: #edf6ff; border-left: 4px solid #075a8c; }
            #${APP_ID} .mort-answer-key { background: #f6f7f8; }
            #${APP_ID} .mort-answer-heading { font-weight: 700; margin-bottom: 8px; color: #17354c; }
            #${APP_ID} .mort-answer-correctness { font-weight: 700; margin: 0 0 8px; }
            #${APP_ID} .mort-correctness-correct { color: #176327; }
            #${APP_ID} .mort-correctness-incorrect { color: #a32020; }
            #${APP_ID} .mort-correctness-unknown { color: #625000; }
            #${APP_ID} .mort-correctness-note { font-size: 12px; color: #555; margin-bottom: 8px; }
            #${APP_ID} .mort-answer-notice { padding: 8px; background: #fff4d6; color: #573e00; }
            #${APP_ID} .mort-answer-key > .answer { margin: 6px 0; }
            #${APP_ID} .mort-student-tools { padding: 10px 16px; border-top: 1px solid #ddd; }
            #${APP_ID} .mort-review { margin-top: 8px; overflow-wrap: anywhere; }
            #${APP_ID} .mort-review button { margin: 8px 8px 0 0; }

            #${APP_ID} .mort-batch-footer {
                flex: 0 0 auto;
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 10px;
                padding: 12px 18px;
                border-top: 1px solid #bbb;
                background: #fff;
                box-shadow: 0 -2px 8px rgba(0,0,0,.08);
            }
            #${APP_ID} .mort-batch-message { flex: 1 1 260px; }
            #${APP_ID} .mort-content { min-height: 0; }
            #${APP_ID} button:disabled { opacity: .55; cursor: default; }
            #${APP_ID} .mort-results-toolbar { flex-wrap: wrap; }
            #${APP_ID} .mort-toolbar-help { white-space: normal !important; }
            #${APP_ID} .mort-card-error .mort-card-state { color: #b3261e; }


            #${APP_ID} {
                position: fixed;
                inset: 0;
                z-index: 999999;
                background: rgba(0,0,0,.45);
                font-family: Arial, Helvetica, sans-serif;
            }

            #${APP_ID} .mort-panel {
                position: absolute;
                inset: 18px;
                background: #fff;
                border-radius: 8px;
                box-shadow: 0 8px 40px rgba(0,0,0,.35);
                display: flex;
                flex-direction: column;
                overflow: hidden;
            }

            #${APP_ID} .mort-header {
                flex: 0 0 auto;
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px 20px;
                background: #075a8c;
                color: #fff;
            }

            #${APP_ID} .mort-title {
                font-size: 22px;
                font-weight: 700;
            }

            #${APP_ID} .mort-subtitle {
                margin-top: 2px;
                font-size: 12px;
                opacity: .85;
            }

            #${APP_ID} .mort-close {
                border: 0;
                background: transparent;
                color: #fff;
                font-size: 32px;
                cursor: pointer;
                line-height: 1;
            }

            #${APP_ID} .mort-content {
                flex: 1 1 auto;
                overflow: auto;
                padding: 18px;
            }

            #${APP_ID} .mort-label {
                display: block;
                margin: 20px 0 8px;
                font-weight: 700;
            }

            #${APP_ID} .mort-select {
                width: 420px;
                min-width: 0;
                max-width: 100%;
                padding: 10px;
                font-size: 16px;
            }

            #${APP_ID} .mort-actions {
                margin-top: 18px;
            }

            #${APP_ID} .mort-primary,
            #${APP_ID} .mort-secondary {
                padding: 8px 14px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;
            }

            #${APP_ID} .mort-primary {
                border: 1px solid #075a8c;
                background: #075a8c;
                color: #fff;
            }

            #${APP_ID} .mort-primary:disabled {
                opacity: .55;
                cursor: default;
            }

            #${APP_ID} .mort-secondary {
                border: 1px solid #888;
                background: #fff;
                color: #222;
            }

            #${APP_ID} .mort-note {
                margin-top: 20px;
                padding: 12px;
                background: #f3f5f7;
                border-left: 4px solid #075a8c;
            }

            #${APP_ID} .mort-loading-title {
                font-size: 22px;
                font-weight: 700;
                margin-bottom: 16px;
            }

            #${APP_ID} .mort-progress {
                margin-bottom: 8px;
            }

            #${APP_ID} .mort-progress-bar {
                width: 100%;
                height: 12px;
                background: #ddd;
                border-radius: 6px;
                overflow: hidden;
            }

            #${APP_ID} .mort-progress-fill {
                height: 100%;
                background: #075a8c;
                transition: width .15s linear;
            }

            #${APP_ID} .mort-results-toolbar {
                position: sticky;
                top: -18px;
                z-index: 5;
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 18px;
                margin: -18px -18px 14px;
                padding: 10px 18px;
                background: #fff;
                border-bottom: 1px solid #ccc;
            }

            #${APP_ID} .mort-results-title {
                font-size: 22px;
                font-weight: 700;
            }

            #${APP_ID} .mort-results-summary {
                margin-top: 2px;
                color: #555;
                font-size: 13px;
            }

            #${APP_ID} .mort-toolbar-help {
                margin-left: auto;
                color: #555;
                font-size: 12px;
                white-space: nowrap;
            }

            #${APP_ID} .mort-student-card {
                max-width: 1050px;
                margin: 0 auto 14px;
                border: 1px solid #aaa;
                background: #fff;
                box-shadow: 0 1px 4px rgba(0,0,0,.08);
                transition:
                    border-color .15s ease,
                    box-shadow .15s ease;
            }

            #${APP_ID} .mort-student-card.mort-card-saved {
                border-color: #299235;
                box-shadow: 0 0 0 2px rgba(41,146,53,.10);
            }

            #${APP_ID} .mort-student-card.mort-card-error {
                border-color: #b3261e;
                box-shadow: 0 0 0 2px rgba(179,38,30,.10);
            }

            #${APP_ID} .mort-student-header {
                display: flex;
                align-items: center;
                gap: 9px;
                padding: 7px 12px;
                background: #eef3f6;
                border-bottom: 1px solid #aaa;
                font-size: 15px;
            }

            #${APP_ID} .mort-student-number {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                min-width: 24px;
                height: 24px;
                border-radius: 50%;
                background: #075a8c;
                color: #fff;
                font-size: 11px;
                font-weight: 700;
            }

            #${APP_ID} .mort-student-name {
                font-size: 15px;
            }

            #${APP_ID} .mort-card-state {
                color: #18751f;
                font-weight: 700;
            }

            #${APP_ID} .mort-user-id {
                margin-left: auto;
                color: #777;
                font-size: 11px;
            }

            #${APP_ID} .mort-question-container {
                padding: 12px 16px 8px;
            }

            #${APP_ID} .display_question {
                margin: 0 !important;
                padding: 0 !important;
                border: 0 !important;
            }

            #${APP_ID} .display_question .header {
                margin: 0 0 8px !important;
            }

            #${APP_ID} .display_question .question_text {
                margin-bottom: 10px !important;
            }

            #${APP_ID} .display_question .answer {
                margin-top: 6px !important;
            }

            /*
             * Hide any Canvas grading controls that survive the HTML cleanup.
             * This is display-only. The original complete form remains stored
             * separately and is used for saving.
             */
            #${APP_ID} .mort-question-container input[name^="question_score_"],
            #${APP_ID} .mort-question-container textarea[name^="question_comment_"],
            #${APP_ID} .mort-question-container .question_points_holder,
            #${APP_ID} .mort-question-container .question_score_holder {
                display: none !important;
            }

            #${APP_ID} .mort-grading-controls {
                padding: 9px 16px 11px;
                border-top: 1px solid #ddd;
                background: #f7f9fa;
            }

            #${APP_ID} .mort-grade-line {
                display: flex;
                align-items: center;
                gap: 10px;
            }

            #${APP_ID} .mort-score-label {
                display: flex;
                align-items: center;
            }

            #${APP_ID} .mort-score {
                width: 72px;
                margin: 0 6px 0 8px;
                padding: 5px 7px;
                font-size: 15px;
            }

            #${APP_ID} .mort-points {
                color: #444;
            }

            #${APP_ID} .mort-comment-label {
                display: block;
                margin-top: 8px;
            }

            #${APP_ID} .mort-key-hint {
                margin-left: 8px;
                color: #777;
                font-size: 11px;
                font-weight: normal;
            }

            #${APP_ID} .mort-comment {
                display: block;
                box-sizing: border-box;
                width: 100%;
                min-height: 48px;
                margin-top: 4px;
                padding: 6px 8px;
                resize: vertical;
                font: inherit;
            }

            #${APP_ID} .mort-save-status {
                font-size: 13px;
                font-weight: 700;
            }

            #${APP_ID} .mort-save-working {
                color: #555;
            }

            #${APP_ID} .mort-save-success {
                color: #18751f;
            }

            #${APP_ID} .mort-save-error {
                color: #b3261e;
            }

            #${APP_ID} .mort-error {
                padding: 14px;
                border: 1px solid #b3261e;
                background: #fdecea;
                color: #7a1712;
            }

        `;

        document.head.appendChild(style);
    }

    // -------------------------------------------------------------------------
    // Button
    // -------------------------------------------------------------------------

    async function launch() {
        if (document.getElementById(APP_ID)) return;
        const overlay =
            showOverlay();

        try {
            const data =
                await discoverCanvasData();

            if (!overlay.isConnected) return;
            showQuestionChooser(
                overlay,
                data
            );

        } catch (error) {
            if (!overlay.isConnected) return;
            showError(
                overlay.querySelector('.mort-content'),
                error
            );
        }
    }

    function installButton() {
        if (
            document.getElementById(
                BUTTON_ID
            )
        ) {
            return;
        }

        const button =
            document.createElement('button');

        button.id =
            BUTTON_ID;

        button.type =
            'button';

        button.textContent =
            'Grade All by Question';

        Object.assign(
            button.style,
            {
                position: 'fixed',
                right: '18px',
                bottom: '18px',
                zIndex: '999998',
                padding: '11px 16px',
                border: '1px solid #075a8c',
                borderRadius: '5px',
                background: '#075a8c',
                color: '#fff',
                fontSize: '14px',
                fontWeight: '700',
                cursor: 'pointer',
                boxShadow:
                    '0 2px 8px rgba(0,0,0,.25)'
            }
        );

        button.addEventListener(
            'click',
            launch
        );

        document.body.appendChild(
            button
        );
    }

    // -------------------------------------------------------------------------
    // Start
    // -------------------------------------------------------------------------

    window.addEventListener('beforeunload', event => {
        if (document.getElementById(APP_ID)?.mortHasChanges?.()) {
            event.preventDefault();
            event.returnValue = '';
        }
    });

    installStyles();
    installButton();

})();
