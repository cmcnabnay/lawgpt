// canvas-new-quiz-scrape.js
//
// Browser-automation fallbacks for canvas-routes.js's /quiz route, for the
// parts of a Canvas course that a plain HTTP fetch can't see because
// they're rendered client-side rather than being present in the initial
// HTML response:
//
//   - scrapeNewQuiz: a "New Quizzes" (Quizzes.Next / quiz-lti) quiz's actual
//     question/answer content, which lives in a separate single-page app
//     launched via an LTI handshake into a different domain.
//   - findQuizLinksViaBrowser: the Quizzes INDEX list itself, on Canvas
//     skins/themes (seen in the wild alongside custom nav wrappers) that
//     render that list via JavaScript too, not just individual New Quizzes.
//
// Both use a real, JavaScript-executing browser (Puppeteer) for exactly the
// content a raw HTTP request (canvas-routes.js's default, cheap path) can't
// see at all, and both read from EVERY frame on the page (page.frames()) --
// main document plus every iframe, at any nesting depth -- rather than
// guessing which specific iframe selector/attribute the real content lives
// behind. Content this can't see against a live instance from here is
// exactly the kind of thing a specific-selector guess would miss.
//
// Same ground rule as the classic-quiz scraper: this starts a real attempt
// (whatever "Start"/"Begin" step the player itself requires) but never
// clicks anything that submits/finishes it -- it only reads whatever
// rendered on screen after that, then closes the browser. No answers are
// selected or submitted on the user's behalf.
//
// Every run saves a full-page screenshot to DEBUG_SCREENSHOT_PATH,
// overwriting the previous one -- since nothing about this page's actual
// rendered layout could be verified from here, that screenshot (readable
// directly off disk) is the fastest way to see what really happened instead
// of guessing again from text-only diagnostics.

const path = require("path");

const MAX_TEXT_CHARS = 40000;
const DEBUG_SCREENSHOT_PATH = path.join(__dirname, "quiz-scrape-debug.png");

// Generic "does this look like a login form" check -- deliberately not
// domain-based (an off-Canvas-origin landing is EXPECTED here, since an LTI
// launch legitimately hands off to a different domain) so it doesn't
// misfire on real quiz content the way an origin check would.
async function looksLikeLoginPage(page) {
  return page.evaluate(() => {
    const hasPassword = !!document.querySelector('input[type="password"]');
    const title = (document.title || "").toLowerCase();
    return hasPassword || title.includes("sign in") || title.includes("log in");
  }).catch(() => false);
}

// Aggregates visible text and every <a>'s {text,href} across ALL frames on
// the page (main document + every iframe, any nesting depth) -- this is
// what makes the wait/extract logic below work without knowing in advance
// whether real content lives in the top frame or some nested iframe (or
// which one, if there are several).
async function collectFromAllFrames(page) {
  let text = "";
  const links = [];
  for (const frame of page.frames()) {
    try {
      const result = await frame.evaluate(() => ({
        text: document.body ? document.body.innerText : "",
        links: Array.from(document.querySelectorAll("a"))
          .map(a => ({ text: (a.textContent || "").trim(), href: a.getAttribute("href") || "" }))
          .filter(l => l.text && l.href)
      }));
      text += (result.text || "") + "\n";
      links.push(...result.links);
    } catch {
      // A cross-origin or not-yet-navigated frame can throw here -- skip it,
      // there was nothing readable in it anyway.
    }
  }
  return { text: text.trim(), links };
}

// Polls collectFromAllFrames until the aggregate text clears a threshold
// well above what static nav chrome alone typically runs (seen in practice
// around ~250 chars for this app's own Canvas instance) -- a fixed
// one-shot check right after navigation was fooled by exactly that chrome
// text on a page whose real content hadn't loaded yet, so this instead
// polls at a short interval up to `timeout`, and also returns early once
// the text stops growing between two consecutive polls (content that's
// finished streaming in, even if short).
async function waitForRealContent(page, timeout, minChars = 500) {
  const start = Date.now();
  let last = "";
  let stableCount = 0;
  while (Date.now() - start < timeout) {
    const { text } = await collectFromAllFrames(page).catch(() => ({ text: "" }));
    if (text.length >= minChars) return text;
    if (text === last && text.length > 0) {
      stableCount++;
      if (stableCount >= 3) return text; // stopped growing for ~1.5s -- likely done, even if short
    } else {
      stableCount = 0;
    }
    last = text;
    await new Promise(r => setTimeout(r, 500));
  }
  return last;
}

async function clickFirstMatchAnyFrame(page, pattern) {
  for (const frame of page.frames()) {
    const clicked = await frame.evaluate((patternSrc) => {
      const re = new RegExp(patternSrc, "i");
      const el = Array.from(document.querySelectorAll("button, a, [role='button'], [role='link']"))
        .find(e => re.test((e.textContent || "").trim()));
      if (el) { el.click(); return true; }
      return false;
    }, pattern.source).catch(() => false);
    if (clicked) return true;
  }
  return false;
}

const NEXT_BUTTON_PATTERN = /^(next|next question)$/i;

async function hasNextButton(page) {
  for (const frame of page.frames()) {
    const found = await frame.evaluate((patternSrc) => {
      const re = new RegExp(patternSrc, "i");
      return Array.from(document.querySelectorAll("button, a, [role='button']"))
        .some(el => re.test((el.textContent || "").trim()));
    }, NEXT_BUTTON_PATTERN.source).catch(() => false);
    if (found) return true;
  }
  return false;
}

async function saveDebugScreenshot(page) {
  try {
    await page.screenshot({ path: DEBUG_SCREENSHOT_PATH, fullPage: true });
    return DEBUG_SCREENSHOT_PATH;
  } catch {
    return null;
  }
}

function setCookies(page, cookieHeader, baseOrigin) {
  const cookieObjs = cookieHeader.split(";").map(s => s.trim()).filter(Boolean).map(pair => {
    const idx = pair.indexOf("=");
    return { name: pair.slice(0, idx), value: pair.slice(idx + 1), url: baseOrigin };
  });
  return cookieObjs.length ? page.setCookie(...cookieObjs) : Promise.resolve();
}

// cookieHeader is the already-built "name=value; name2=value2" string (see
// buildCookieHeader in canvas-routes.js) -- reused as-is so this stays in
// sync with whatever cookie-name fix that ever needs going forward.
async function scrapeNewQuiz(quizUrl, cookieHeader, baseOrigin) {
  const puppeteer = require("puppeteer"); // lazy -- keeps Chromium out of the main proxy's startup path
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });

  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (LawGPT import tool)");
    await page.setDefaultNavigationTimeout(45000);
    await setCookies(page, cookieHeader, baseOrigin);

    await page.goto(quizUrl, { waitUntil: "domcontentloaded" });

    if (await looksLikeLoginPage(page)) {
      const shot = await saveDebugScreenshot(page);
      return { error: `Landed on what looks like a login page (${page.url()}) instead of the quiz -- the session cookie isn't authenticated.`, finalUrl: page.url(), debugScreenshot: shot };
    }

    // Some assignment/quiz pages gate the actual content behind an explicit
    // "Load"/"Launch"/"Start" click rather than auto-loading it. Best-effort
    // only -- if there's no such button (because it auto-loaded), this just
    // finds nothing and moves on.
    let clicked = await clickFirstMatchAnyFrame(page, /^(load|launch|open|view quiz)\b/i);
    if (clicked) await new Promise(r => setTimeout(r, 1500));

    await waitForRealContent(page, 25000);

    // The one interactive step that actually starts (or resumes) the
    // attempt -- matches what clicking "Take the Quiz" does for a classic
    // quiz. "Resume" is included because a prior scrape of the same quiz
    // deliberately leaves its attempt open/unsubmitted (see the module
    // comment above), so a later run lands on a "Resume Quiz" screen
    // instead of a fresh "Start" one. Deliberately never looks for/clicks
    // anything matching submit/finish/turn in.
    const startClicked = await clickFirstMatchAnyFrame(page, /^(start|begin|resume|take the quiz|start quiz|start attempt|resume quiz|resume attempt)\b/i);
    if (startClicked) {
      await new Promise(r => setTimeout(r, 1000));
      await waitForRealContent(page, 20000);
    }

    // One-question-at-a-time quizzes only ever show one question's worth of
    // content per screen -- but clicking "Next" WITHOUT selecting an answer
    // first doesn't record/save anything (verified against a real capture:
    // the page shows "Not saved" and every question stays "Haven't Answered
    // Yet" regardless of which one is currently on screen), it just reveals
    // the next question. So it's safe to walk through every screen this
    // way, collecting each one's content, right up until there's no more
    // "Next" to click -- still without ever selecting an answer or clicking
    // Submit. MAX_SCREENS is a sanity cap, well above any real quiz's
    // question count, purely to guarantee this loop can't run forever if a
    // "Next"-shaped button turns out not to actually be one.
    const MAX_SCREENS = 40;
    const screens = [(await collectFromAllFrames(page)).text];
    let previousText = screens[0];
    while (screens.length < MAX_SCREENS && await hasNextButton(page)) {
      const clickedNext = await clickFirstMatchAnyFrame(page, NEXT_BUTTON_PATTERN);
      if (!clickedNext) break;
      await new Promise(r => setTimeout(r, 800));
      await waitForRealContent(page, 15000);
      const { text } = await collectFromAllFrames(page);
      if (text === previousText) break; // Next didn't actually change anything -- stop rather than loop forever
      screens.push(text);
      previousText = text;
    }

    const onePerPage = screens.length > 1;
    const rawText = screens.join("\n\n----- next question -----\n\n");
    const debugScreenshot = await saveDebugScreenshot(page);

    return {
      rawText: rawText.slice(0, MAX_TEXT_CHARS),
      onePerPage,
      screensRead: screens.length,
      finalUrl: page.url(),
      debugScreenshot
    };
  } catch (err) {
    return { error: `Browser automation failed: ${err.message}` };
  } finally {
    await browser.close().catch(() => {});
  }
}

// Some Canvas skins/themes (this app's own Canvas instance included, per a
// live test) render the Quizzes INDEX list itself via JavaScript -- not
// just individual New Quizzes content. A plain HTTP fetch of that page
// (canvas-routes.js's default, cheap path) then sees only the empty nav
// shell, no quiz links at all, regardless of whether any quizzes exist on
// it. This is the fallback for exactly that case: render the index page for
// real (across every frame, not just the top one -- see collectFromAllFrames)
// and read back whatever links actually show up, so canvas-routes.js's
// existing title-matching logic (kept there, not duplicated here) has real
// data to work with either way.
async function findQuizLinksViaBrowser(indexUrl, cookieHeader, baseOrigin) {
  const puppeteer = require("puppeteer"); // lazy -- see scrapeNewQuiz above
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });

  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (LawGPT import tool)");
    await page.setDefaultNavigationTimeout(45000);
    await setCookies(page, cookieHeader, baseOrigin);

    await page.goto(indexUrl, { waitUntil: "domcontentloaded" });

    if (await looksLikeLoginPage(page)) {
      const shot = await saveDebugScreenshot(page);
      return { error: `Landed on what looks like a login page (${page.url()}) instead of the quizzes list -- the session cookie isn't authenticated.`, finalUrl: page.url(), debugScreenshot: shot };
    }

    const { text, links } = await (async () => {
      await waitForRealContent(page, 25000);
      return collectFromAllFrames(page);
    })();

    const debugScreenshot = await saveDebugScreenshot(page);

    return { links, finalUrl: page.url(), bodySnippet: text.slice(0, 1200), debugScreenshot };
  } catch (err) {
    return { error: `Browser automation failed: ${err.message}` };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { scrapeNewQuiz, findQuizLinksViaBrowser, DEBUG_SCREENSHOT_PATH };
