# Study

An installable web app (PWA) for iPhone and Android. The bottom bar has Feed, Desk, Papers and More; Study, Plan, Drill and Settings open from More.

- **Feed:** swipeable cards with spaced repetition (Again / Got it), plus Ask Claude.
- **Study:** read a topic in order, sit timed mini exams, see saved cards.
- **Desk:** exercise sessions with a 25-minute struggle timer, Socratic hints, a photo of your handwritten page, and Claude marking on a 0–3 rubric with disputes.
- **Papers:** one paper a week, with reading questions, a guide and an explain-it-back check.
- **Plan:** the curriculum as dated weeks, with ticks and *Delay a day / a week* buttons, plus a shareable **Progress** view (bars, checklist, checkpoint scores; image or text).
- **Drill:** timed practice drills with spaced re-tests (done on a laptop with a companion CLI that lives in the private repo), plus a course's units, ticks and mock scores.
- **Settings:** keys and sync.

This repo holds only the app code. The cards, problems and every attempt live in a separate **private** GitHub repo, read and written with a fine-grained token stored on the device. Claude calls go straight from the device to the Anthropic API with your own key.

## Install

- **iPhone / iPad:** open the site in Safari → Share → *Add to Home Screen*.
- **Android:** open it in Chrome → menu → *Install app*.

Then open Settings and add:

1. **A GitHub fine-grained token:** only your study repo, permission *Contents: Read and write*.
2. **An Anthropic API key** (optional, for hints, marking and Ask), from console.anthropic.com. Set a spend limit there.

## Data layout (in the private repo)

```
app-data/content/lemma-deck.txt       cards
app-data/content/desk-mfml.json       problems + "What you need" panels
app-data/attempts/<book>-<id>.json    written by the app
app-data/lemma-progress.json          written by the app
app-data/content/schedule.json        the week-by-week plan (built by scripts/build_schedule.py)
app-data/plan.json                    ticks and delays, written by the app
app-data/content/drills.json          drill catalog and units (optional; enables Drill)
app-data/drills/attempts.json         drill attempts, written by the laptop CLI (read-only here)
app-data/drills/app.json              unit ticks, mock scores, hand-logged attempts, written by the app
```

Changes are batched into one commit on `main` about 20 seconds after you stop, or when the app goes to the background. Offline changes wait on the device and sync later.

## Files

`index.html` (shell, tabs, settings) · `hub.js` (GitHub sync, Claude API, settings) · `bridge.js` (connects each screen to the hub) · `feed.html` (Feed and Study) · `desk.html` (Desk) · `papers.html` (Papers) · `plan.html` (Plan) · `drill.html` (Drill) · `sw.js` (offline) · `vendor/mathjax` (MathJax 3.2.2, Apache-2.0, bundled so no third-party script runs next to your keys).
