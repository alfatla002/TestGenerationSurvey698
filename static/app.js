function updateProgress() {
  const form = document.querySelector(".survey-form");
  if (!form) {
    return;
  }

  const totalTests = Number(form.dataset.tests || 0);
  let completed = 0;

  for (let index = 1; index <= totalTests; index += 1) {
    const fields = [
      `input[name="readability_${index}"]:checked`,
      `input[name="understandability_${index}"]:checked`,
      `input[name="specificity_${index}"]:checked`,
      `input[name="technical_soundness_${index}"]:checked`,
    ];

    if (fields.every((selector) => document.querySelector(selector))) {
      completed += 1;
    }
  }

  const percent = totalTests ? (completed / totalTests) * 100 : 0;
  const bar = document.getElementById("progressBar");
  const text = document.getElementById("progressText");
  if (bar) {
    bar.style.width = `${percent}%`;
  }
  if (text) {
    text.textContent = `${completed} of ${totalTests} tests fully scored`;
  }
}

function setDraftStatus(message, state) {
  const node = document.getElementById("draftStatus");
  if (!node) {
    return;
  }
  node.textContent = message;
  node.dataset.state = state;
}

let autosaveTimer = null;
let autosaveController = null;
let lastSavedSnapshot = "";

async function saveDraftNow(form) {
  const draftUrl = form.dataset.draftUrl;
  if (!draftUrl) {
    return;
  }

  const payload = new URLSearchParams(new FormData(form));
  const snapshot = payload.toString();
  if (snapshot === lastSavedSnapshot) {
    return;
  }

  if (autosaveController) {
    autosaveController.abort();
  }

  autosaveController = new AbortController();
  setDraftStatus("Saving draft…", "saving");

  try {
    const response = await fetch(draftUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: payload.toString(),
      signal: autosaveController.signal,
    });

    if (!response.ok) {
      throw new Error(`Draft save failed with status ${response.status}`);
    }

    lastSavedSnapshot = snapshot;
    setDraftStatus("Draft saved", "saved");
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }
    setDraftStatus("Draft not saved", "error");
  }
}

function queueDraftSave(form) {
  if (!form) {
    return;
  }
  clearTimeout(autosaveTimer);
  setDraftStatus("Saving soon…", "pending");
  autosaveTimer = window.setTimeout(() => {
    saveDraftNow(form);
  }, 350);
}

function closeExpandedCode() {
  document.querySelectorAll(".code-scroll.is-expanded").forEach((panel) => {
    panel.classList.remove("is-expanded");
  });
  document.querySelectorAll(".code-card.is-expanded").forEach((card) => {
    card.classList.remove("is-expanded");
  });
  document.querySelectorAll(".code-expand").forEach((button) => {
    button.textContent = "Maximize";
  });
  document.body.classList.remove("body-locked");
}

function toggleExpandedCode(button) {
  const targetId = button.dataset.target;
  const panel = document.getElementById(targetId);
  if (!panel) {
    return;
  }

  const card = button.closest(".code-card");
  const expanded = !panel.classList.contains("is-expanded");
  closeExpandedCode();
  panel.classList.toggle("is-expanded", expanded);
  if (card) {
    card.classList.toggle("is-expanded", expanded);
  }
  document.body.classList.toggle("body-locked", expanded);
  button.textContent = expanded ? "Restore" : "Maximize";
}

document.addEventListener("click", (event) => {
  const button = event.target.closest(".code-expand");
  if (button) {
    toggleExpandedCode(button);
    return;
  }

  const closeButton = event.target.closest(".code-close");
  if (closeButton || event.target.closest(".code-backdrop")) {
    closeExpandedCode();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }
  closeExpandedCode();
});

document.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector(".survey-form");
  updateProgress();
  if (!form) {
    return;
  }

  lastSavedSnapshot = new URLSearchParams(new FormData(form)).toString();

  form.addEventListener("input", () => {
    updateProgress();
    queueDraftSave(form);
  });

  form.addEventListener("change", () => {
    updateProgress();
    queueDraftSave(form);
  });

  form.addEventListener("submit", () => {
    setDraftStatus("Submitting…", "saving");
  });
});
