const appNode = document.getElementById("app");
const config = window.SURVEY_CONFIG || {};
const dataUrl = "./data/survey-data.json";

let surveyData = null;
let autosaveTimer = null;
let autosaveAbort = null;
let lastSavedSnapshot = "";

function route() {
  return window.location.hash.replace(/^#/, "") || "/";
}

function inviteRoute(token) {
  return `#/invite/${token}`;
}

function edgeUrl(path = "") {
  return `${config.supabaseUrl}/functions/v1/${config.functionName}${path}`;
}

async function apiRequest(method, payload) {
  const response = await fetch(edgeUrl(), {
    method,
    headers: {
      "Content-Type": "application/json",
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${config.supabaseAnonKey}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(json.error || `Request failed (${response.status})`);
  }
  return json;
}

async function loadData() {
  if (surveyData) return surveyData;
  const response = await fetch(dataUrl);
  surveyData = await response.json();
  return surveyData;
}

function shell(inner) {
  appNode.innerHTML = `
    <header class="site-header">
      <a class="brand" href="#/">Survey 698</a>
      <nav class="site-nav">
        <a href="#/">Invites</a>
      </nav>
    </header>
    <main class="layout">${inner}</main>
  `;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buttonScale(name, selected = "") {
  return `
    <div class="score-scale">
      <span class="score-edge">Strongly disagree</span>
      <div class="score-options">
        ${[0, 1, 2, 3, 4, 5]
          .map(
            (value) => `
              <label class="scale-option">
                <input type="radio" name="${name}" value="${value}" ${String(selected) === String(value) ? "checked" : ""} required>
                <span class="scale-value">${value}</span>
              </label>
            `,
          )
          .join("")}
      </div>
      <span class="score-edge">Strongly agree</span>
    </div>
  `;
}

function progressText(form) {
  const totalTests = Number(form.dataset.tests || 0);
  let completed = 0;
  for (let index = 1; index <= totalTests; index += 1) {
    const names = [
      `readability_${index}`,
      `understandability_${index}`,
      `specificity_${index}`,
      `technical_soundness_${index}`,
    ];
    if (names.every((name) => form.querySelector(`input[name="${name}"]:checked`))) {
      completed += 1;
    }
  }
  return { completed, totalTests };
}

function updateProgress(form) {
  const { completed, totalTests } = progressText(form);
  const bar = document.getElementById("progressBar");
  const text = document.getElementById("progressText");
  const percent = totalTests ? (completed / totalTests) * 100 : 0;
  if (bar) bar.style.width = `${percent}%`;
  if (text) text.textContent = `${completed} of ${totalTests} tests fully scored`;
}

function setDraftStatus(message, state) {
  const node = document.getElementById("draftStatus");
  if (!node) return;
  node.textContent = message;
  node.dataset.state = state;
}

function currentFormSnapshot(form) {
  return new URLSearchParams(new FormData(form)).toString();
}

async function saveDraft(token, form) {
  const snapshot = currentFormSnapshot(form);
  if (snapshot === lastSavedSnapshot) return;

  if (autosaveAbort) autosaveAbort.abort();
  autosaveAbort = new AbortController();
  setDraftStatus("Saving draft…", "saving");

  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    await fetch(edgeUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${config.supabaseAnonKey}`,
      },
      body: JSON.stringify({ action: "save", token, payload }),
      signal: autosaveAbort.signal,
    }).then(async (response) => {
      const text = await response.text();
      const json = text ? JSON.parse(text) : {};
      if (!response.ok) throw new Error(json.error || `Save failed (${response.status})`);
      return json;
    });
    lastSavedSnapshot = snapshot;
    setDraftStatus("Draft saved", "saved");
  } catch (error) {
    if (error.name === "AbortError") return;
    setDraftStatus("Draft not saved", "error");
  }
}

function queueSave(token, form) {
  clearTimeout(autosaveTimer);
  setDraftStatus("Saving soon…", "pending");
  autosaveTimer = window.setTimeout(() => saveDraft(token, form), 350);
}

function closeExpandedCode() {
  document.querySelectorAll(".code-scroll.is-expanded").forEach((panel) => panel.classList.remove("is-expanded"));
  document.querySelectorAll(".code-card.is-expanded").forEach((card) => card.classList.remove("is-expanded"));
  document.body.classList.remove("body-locked");
}

function bindGlobalInteractions() {
  document.addEventListener("click", (event) => {
    const expandButton = event.target.closest(".code-expand");
    if (expandButton) {
      const card = expandButton.closest(".code-card");
      const panel = document.getElementById(expandButton.dataset.target);
      const expanded = card.classList.toggle("is-expanded");
      panel.classList.toggle("is-expanded", expanded);
      card.classList.toggle("is-expanded", expanded);
      document.body.classList.toggle("body-locked", expanded);
      return;
    }

    if (event.target.closest(".code-close") || event.target.closest(".code-backdrop")) {
      closeExpandedCode();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeExpandedCode();
  });
}

function renderHome(data, statusMap) {
  shell(`
    <section class="hero">
      <div class="eyebrow">GitHub Pages + Supabase</div>
      <h1>Invite links for your 12 reviewers.</h1>
      <p>Each reviewer gets a dedicated link. Progress autosaves per link and can be resumed later.</p>
      <div class="hero-note">Brief text comes from <code>${escapeHtml(data.meta.briefSource)}</code>. Code comes from the forms source file.</div>
    </section>
    <section class="group-grid">
      ${data.invites
        .map((invite) => {
          const status = statusMap[invite.token] || "not started";
          const statusClass = status === "submitted" ? "invite-status done" : status === "in progress" ? "invite-status active" : "invite-status";
          return `
            <article class="invite-card">
              <div class="invite-topline">
                <div class="group-label">${escapeHtml(invite.label)}</div>
                <span class="${statusClass}">${escapeHtml(status)}</span>
              </div>
              <h2>Group ${escapeHtml(invite.group)}</h2>
              <p><a class="inline-link" href="${inviteRoute(invite.token)}">${window.location.origin}${window.location.pathname}${inviteRoute(invite.token)}</a></p>
              <a class="button" href="${inviteRoute(invite.token)}">Open survey</a>
            </article>
          `;
        })
        .join("")}
    </section>
  `);
}

function renderSubmitted(invite, state) {
  shell(`
    <section class="hero hero-compact">
      <div class="eyebrow">Submitted</div>
      <h1>${escapeHtml(invite.label)}</h1>
      <p>This invite has already been submitted by ${escapeHtml(state.participant_name || "the assigned reviewer")}.</p>
      <a class="button secondary" href="#/">Back to invite list</a>
    </section>
  `);
}

function renderInvite(data, invite, state) {
  const form = data.forms[invite.group];
  const draft = state.draft_payload || {};
  const participantName = state.participant_name || draft.participant_name || "";
  const participantProfession = draft.participant_profession || "";
  shell(`
    <section class="hero hero-compact">
      <div class="eyebrow">${escapeHtml(invite.label)}</div>
      <h1>Group ${escapeHtml(invite.group)} survey</h1>
      <p>Review the generated test, rate it, and continue later from the same invite link.</p>
      <div class="progress-banner">
        <span id="progressText">0 of ${form.tests.length} tests fully scored</span>
        <div class="progress-track"><div id="progressBar"></div></div>
        <div class="draft-status" id="draftStatus">Draft autosave ready</div>
      </div>
    </section>
    <form class="survey-form" data-tests="${form.tests.length}">
      <section class="identity-card">
        <h2>Participant</h2>
        <div class="identity-grid single-column">
          <label>
            <span>Your name</span>
            <input name="participant_name" value="${escapeHtml(participantName)}" required>
          </label>
          <label>
            <span>Profession</span>
            <input name="participant_profession" value="${escapeHtml(participantProfession)}" placeholder="Optional">
          </label>
        </div>
      </section>
      ${form.tests
        .map(
          (test) => `
            <section class="test-card" id="test-${test.number}">
              <div class="test-header">
                <div>
                  <div class="test-count">Test ${test.number}</div>
                  <h2>#${test.issueNumber} ${escapeHtml(test.issueTitle)}</h2>
                </div>
                <a class="inline-link" href="${escapeHtml(test.issueUrl)}" target="_blank" rel="noreferrer">GitHub issue</a>
              </div>
              <p class="test-summary">${escapeHtml(test.whatHappened || "Issue summary unavailable.")}</p>
              <div class="issue-details">
                ${test.context ? `<div class="issue-line"><div class="issue-line-label">Context</div><p>${escapeHtml(test.context)}</p></div>` : ""}
                ${test.whatShouldHappen ? `<div class="issue-line"><div class="issue-line-label">What should happen</div><p>${escapeHtml(test.whatShouldHappen)}</p></div>` : ""}
                ${test.whatTestShouldVerify ? `<div class="issue-line"><div class="issue-line-label">What the test should verify</div><p>${escapeHtml(test.whatTestShouldVerify)}</p></div>` : ""}
                ${test.manualNote ? `<div class="issue-line"><div class="issue-line-label">Note</div><p>${escapeHtml(test.manualNote)}</p></div>` : ""}
              </div>
              <section class="code-card">
                <div class="code-toolbar">
                  <div class="code-title">Generated test code</div>
                  <div class="code-actions">
                    <button class="button secondary code-close" type="button" data-target="code-${test.number}">Close</button>
                    <button class="button secondary code-expand" type="button" data-target="code-${test.number}">Maximize</button>
                  </div>
                </div>
                <div class="code-backdrop"></div>
                <pre id="code-${test.number}" class="code-scroll"><code>${escapeHtml(test.code || "# Code unavailable")}</code></pre>
              </section>
              <div class="ratings-grid">
                ${[
                  ["readability", "Readability", "The test is easy to read and well structured."],
                  ["understandability", "Understandability", "The purpose of the test is clear."],
                  ["specificity", "Specificity", "The test checks a specific and meaningful behavior."],
                  ["technical_soundness", "Technical Soundness", "The test is technically correct and appropriately written."],
                ]
                  .map(
                    ([key, title, help]) => `
                      <fieldset class="rating-block">
                        <div class="rating-header">
                          <legend>${title}</legend>
                          <div class="field-help">${help}</div>
                        </div>
                        ${buttonScale(`${key}_${test.number}`, draft[`${key}_${test.number}`] || "")}
                      </fieldset>
                    `,
                  )
                  .join("")}
              </div>
              <label class="comment-block">
                <span>Optional comment</span>
                <textarea name="comment_${test.number}" rows="3" placeholder="Add a short note if something stands out.">${escapeHtml(draft[`comment_${test.number}`] || "")}</textarea>
              </label>
            </section>
          `,
        )
        .join("")}
      <div class="submit-row">
        <button class="button" type="submit">Submit survey</button>
      </div>
    </form>
  `);

  const formNode = document.querySelector(".survey-form");
  lastSavedSnapshot = currentFormSnapshot(formNode);
  updateProgress(formNode);

  formNode.addEventListener("input", () => {
    updateProgress(formNode);
    queueSave(invite.token, formNode);
  });

  formNode.addEventListener("change", () => {
    updateProgress(formNode);
    queueSave(invite.token, formNode);
  });

  formNode.addEventListener("submit", async (event) => {
    event.preventDefault();
    setDraftStatus("Submitting…", "saving");
    const payload = Object.fromEntries(new FormData(formNode).entries());
    try {
      await apiRequest("POST", { action: "submit", token: invite.token, payload });
      window.location.hash = "#/";
      await init();
    } catch (error) {
      setDraftStatus(error.message, "error");
    }
  });
}

async function init() {
  const data = await loadData();
  if (!config.supabaseUrl || !config.supabaseAnonKey || !config.functionName) {
    shell(`
      <section class="hero hero-compact">
        <div class="eyebrow">Configuration needed</div>
        <h1>Set up Supabase config first.</h1>
        <p>Copy <code>docs/app-config.example.js</code> to <code>docs/app-config.js</code> and fill in your project URL, anon key, and function name.</p>
      </section>
    `);
    return;
  }

  const current = route();
  if (current.startsWith("/invite/")) {
    const token = current.split("/").pop();
    const invite = data.invites.find((item) => item.token === token);
    if (!invite) {
      shell(`<section class="hero hero-compact"><div class="eyebrow">Error</div><h1>Unknown invite</h1></section>`);
      return;
    }
    const state = await apiRequest("POST", { action: "load", token });
    if (state.status === "submitted") {
      renderSubmitted(invite, state);
    } else {
      renderInvite(data, invite, state);
    }
    return;
  }

  const list = await apiRequest("POST", { action: "list" });
  renderHome(data, Object.fromEntries(list.invites.map((invite) => [invite.invite_token, invite.status])));
}

window.addEventListener("hashchange", () => init().catch(renderFatal));

function renderFatal(error) {
  shell(`
    <section class="hero hero-compact">
      <div class="eyebrow">Error</div>
      <h1>App failed to load</h1>
      <p>${escapeHtml(error.message || String(error))}</p>
    </section>
  `);
}

bindGlobalInteractions();
init().catch(renderFatal);
