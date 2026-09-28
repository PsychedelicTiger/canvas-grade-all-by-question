# Canvas — Grade All by Question

A Tampermonkey userscript for batch grading one Classic Canvas Quiz question across students in SpeedGrader.

Current version: **0.4.9**.

## Install

In the browser you use for Canvas, click its store link below (or type the address into the address bar):

- **Chrome:** [Chrome Web Store](https://chromewebstore.google.com/) — `chromewebstore.google.com`
- **Edge:** [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/) — `microsoftedge.microsoft.com/addons`
- **Firefox:** [Firefox Add-ons](https://addons.mozilla.org/) — `addons.mozilla.org`

Search the store for **Tampermonkey**, open its listing, and click **Add to Chrome**, **Get**, or **Add to Firefox**, then confirm installation. Click the Tampermonkey icon in your browser's Extensions menu and choose **Create a new script**.

Open `Canvas-Grade-All-by-Question.user.js` in a text editor (e.g., Notepad or Textedit), copy its full contents into a new Tampermonkey script, and save. Enable only one copy of the script. Refresh SpeedGrader after saving or discarding any unsaved edits.

The script currently matches HTTPS Canvas domains under `instructure.com` and Classic Quiz assignments in SpeedGrader. It does not support New Quizzes.

## Use

1. Open a Classic Quiz in SpeedGrader and select **Grade All by Question**.
2. Choose a question and load the responses.
3. Edit scores and comments locally.
4. Select **Save All Changes** to save changed students sequentially. Each save is re-fetched and verified; an individual failure does not stop the remaining students.

Cancel, close, and question changes warn about unsaved edits. They never save automatically. Successfully saving a batch keeps the interface open.

Scrolling over a score box removes focus from it so the mouse wheel scrolls without changing the score. Click the box again to continue typing or adjusting the score with the keyboard.

## Response labels

Fill-in-the-blank responses separate the student's answer from accepted answer-key entries. Internal answer IDs are removed. Essays and selected multiple-choice answers are labeled where supported. Ambiguous or unsupported layouts retain their original content and display a notice.

Correctness labels use Canvas's explicit markers on the identified student response. Missing or conflicting markers display **Correctness unavailable**. These are markers at response load time, not a record of points awarded to each blank. Manual score edits do not change them; reload responses to update the displayed content.

## Verification and limitations

The script has passed local browser tests with simulated Canvas responses and regression tests for saving, recovery, conflicts, navigation warnings, and response labeling. These tests do not establish compatibility with every live Canvas deployment.

Start with a small batch and verify the results in Canvas. Conflict checks are not an atomic lock against simultaneous grading. An uncertain write remains blocked until it can be reconciled; do not assume a timeout cancelled a server-side write.

The script runs in the browser and sends requests to the current Canvas origin. Unresolved-write recovery records, including submitted scores and comments, are stored in the tab's session storage. Ordinary unsaved drafts stay in memory. This repository contains the userscript and documentation, not student records.
