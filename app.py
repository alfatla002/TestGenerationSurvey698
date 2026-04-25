from __future__ import annotations

import csv
import datetime as dt
import html
import io
import json
import re
import sqlite3
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = BASE_DIR / "google_forms_creator.gs"
ISSUE_BRIEFS_FILE = BASE_DIR / "issue_briefs_reviewer_final.json"
DB_FILE = BASE_DIR / "survey.db"
STATIC_DIR = BASE_DIR / "static"
HOST = "127.0.0.1"
PORT = 8000
GROUP_CODES = ["A", "B", "C", "D", "E", "F"]
TESTS_PER_GROUP = 14

RATING_FIELDS = [
    ("readability", "Readability", "The test is easy to read and well structured."),
    ("understandability", "Understandability", "The purpose of the test is clear."),
    ("specificity", "Specificity", "The test checks a specific and meaningful behavior."),
    (
        "technical_soundness",
        "Technical Soundness",
        "The test is technically correct and appropriately written.",
    ),
]
RATING_VALUES = [1, 2, 3, 4, 5]

INVITES = [
    {"token": "group-a-1", "group": "A", "label": "Group A Reviewer 1"},
    {"token": "group-a-2", "group": "A", "label": "Group A Reviewer 2"},
    {"token": "group-b-1", "group": "B", "label": "Group B Reviewer 1"},
    {"token": "group-b-2", "group": "B", "label": "Group B Reviewer 2"},
    {"token": "group-c-1", "group": "C", "label": "Group C Reviewer 1"},
    {"token": "group-c-2", "group": "C", "label": "Group C Reviewer 2"},
    {"token": "group-d-1", "group": "D", "label": "Group D Reviewer 1"},
    {"token": "group-d-2", "group": "D", "label": "Group D Reviewer 2"},
    {"token": "group-e-1", "group": "E", "label": "Group E Reviewer 1"},
    {"token": "group-e-2", "group": "E", "label": "Group E Reviewer 2"},
    {"token": "group-f-1", "group": "F", "label": "Group F Reviewer 1"},
    {"token": "group-f-2", "group": "F", "label": "Group F Reviewer 2"},
]

SURVEY_DATA: dict[str, object] | None = None
ISSUE_BRIEFS: list[dict[str, object]] | None = None


def load_survey_data() -> dict[str, object]:
    global SURVEY_DATA
    if SURVEY_DATA is not None:
        return SURVEY_DATA

    if not DATA_FILE.exists():
        SURVEY_DATA = build_survey_data_from_issue_briefs()
        return SURVEY_DATA

    source = DATA_FILE.read_text(encoding="utf-8")
    match = re.search(
        r"const SURVEY_DATA = (\{.*?\n\});\n\nfunction createRustForms",
        source,
        re.S,
    )
    if not match:
        SURVEY_DATA = build_survey_data_from_issue_briefs()
        return SURVEY_DATA

    SURVEY_DATA = json.loads(match.group(1))
    return SURVEY_DATA


def load_issue_briefs() -> list[dict[str, object]]:
    global ISSUE_BRIEFS
    if ISSUE_BRIEFS is not None:
        return ISSUE_BRIEFS
    ISSUE_BRIEFS = json.loads(ISSUE_BRIEFS_FILE.read_text(encoding="utf-8"))
    return ISSUE_BRIEFS


def build_survey_data_from_issue_briefs() -> dict[str, object]:
    briefs = load_issue_briefs()
    forms: list[dict[str, object]] = []

    if len(briefs) != len(GROUP_CODES) * TESTS_PER_GROUP:
        raise RuntimeError(
            "issue_briefs_for_webapp.json does not match the expected 6 groups x 14 tests layout."
        )

    for index, group_code in enumerate(GROUP_CODES):
        start = index * TESTS_PER_GROUP
        end = start + TESTS_PER_GROUP
        tests = []
        for number, brief in enumerate(briefs[start:end], start=1):
            tests.append(
                {
                    "number": number,
                    "repo": brief["repo"],
                    "bucket": brief.get("verification_bucket", ""),
                    "issueNumber": brief["issue_number"],
                    "issueTitle": brief["issue_title"],
                    "issueSummary": brief.get("what_happened", ""),
                    "issueUrl": brief["issue_url"],
                    "reviewerDescription": "",
                    "contextText": "",
                    "generatedTestFile": brief.get("generated_test_file", ""),
                    "suggestedPath": brief.get("suggested_path", ""),
                    "prNumber": brief.get("pr_number", ""),
                    "prTitle": brief.get("pr_title", ""),
                }
            )

        forms.append(
            {
                "group": group_code,
                "title": f"LLM-Generated Test Case Evaluation (Group {group_code})",
                "description": "Issue summaries loaded from issue_briefs_for_webapp.json.",
                "tests": tests,
            }
        )
    return {"forms": forms}


def build_issue_brief_lookup() -> dict[tuple[str, int], dict[str, object]]:
    lookup: dict[tuple[str, int], dict[str, object]] = {}
    for brief in load_issue_briefs():
        lookup[(str(brief["repo"]), int(brief["issue_number"]))] = brief
    return lookup


def get_forms() -> list[dict[str, object]]:
    forms = list(load_survey_data()["forms"])
    brief_lookup = build_issue_brief_lookup()
    merged_forms: list[dict[str, object]] = []

    for form in forms:
        merged_tests = []
        for test in form["tests"]:
            brief = brief_lookup.get((str(test["repo"]), int(test["issueNumber"])), {})
            merged_tests.append({**test, "_brief": brief})
        merged_forms.append({**form, "tests": merged_tests})
    return merged_forms


def get_group(group_code: str) -> dict[str, object] | None:
    normalized = group_code.strip().upper()
    for form in get_forms():
        if form["group"] == normalized:
            return form
    return None


def get_invite(token: str) -> dict[str, str] | None:
    for invite in INVITES:
        if invite["token"] == token:
            return invite
    return None


def init_db() -> None:
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS submissions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                invite_token TEXT NOT NULL,
                participant_label TEXT NOT NULL,
                participant_name TEXT NOT NULL,
                group_code TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS responses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                submission_id INTEGER NOT NULL,
                test_number INTEGER NOT NULL,
                repo TEXT NOT NULL,
                bucket TEXT NOT NULL,
                issue_number INTEGER NOT NULL,
                readability INTEGER NOT NULL,
                understandability INTEGER NOT NULL,
                specificity INTEGER NOT NULL,
                technical_soundness INTEGER NOT NULL,
                comment TEXT NOT NULL DEFAULT '',
                FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_responses_submission
            ON responses(submission_id)
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_submissions_group
            ON submissions(group_code)
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS drafts (
                invite_token TEXT PRIMARY KEY,
                participant_label TEXT NOT NULL,
                group_code TEXT NOT NULL,
                participant_name TEXT NOT NULL DEFAULT '',
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        ensure_submission_columns(conn)
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_invite
            ON submissions(invite_token)
            """
        )


def ensure_submission_columns(conn: sqlite3.Connection) -> None:
    existing = {row[1] for row in conn.execute("PRAGMA table_info(submissions)")}
    required = {
        "invite_token": "TEXT NOT NULL DEFAULT ''",
        "participant_label": "TEXT NOT NULL DEFAULT ''",
        "participant_name": "TEXT NOT NULL DEFAULT ''",
        "group_code": "TEXT NOT NULL DEFAULT ''",
        "created_at": "TEXT NOT NULL DEFAULT ''",
    }
    for column, definition in required.items():
        if column not in existing:
            conn.execute(f"ALTER TABLE submissions ADD COLUMN {column} {definition}")
    conn.commit()


def db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def page_shell(title: str, body: str) -> str:
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{html.escape(title)}</title>
  <link rel="stylesheet" href="/static/styles.css">
</head>
<body>
  <div class="page-glow page-glow-left"></div>
  <div class="page-glow page-glow-right"></div>
  {body}
  <script src="/static/app.js"></script>
</body>
</html>"""


def nav_bar() -> str:
    return """
    <header class="site-header">
      <a class="brand" href="/">Survey 698</a>
      <nav class="site-nav">
        <a href="/">Invites</a>
        <a href="/admin">Admin</a>
      </nav>
    </header>
    """


def landing_page() -> str:
    statuses = get_invite_statuses()

    cards = []
    for invite in INVITES:
        status = statuses.get(invite["token"], "not started")
        status_label = status.title()
        status_class = "invite-status"
        if status == "submitted":
            status_class += " done"
        elif status == "in progress":
            status_class += " active"
        cards.append(
            f"""
            <article class="invite-card">
              <div class="invite-topline">
                <div class="group-label">{html.escape(invite["label"])}</div>
                <span class="{status_class}">{status_label}</span>
              </div>
              <h2>Group {html.escape(invite["group"])}</h2>
              <p>Share this link with exactly one participant.</p>
              <a class="button" href="/invite/{html.escape(invite['token'])}">Open survey link</a>
            </article>
            """
        )

    body = f"""
    {nav_bar()}
    <main class="layout">
      <section class="hero">
        <div class="eyebrow">Participant links</div>
        <h1>Use one unique survey link per reviewer.</h1>
        <p>
          Each invite can be submitted once. Reviewers enter only their own name,
          then complete the assigned group survey.
        </p>
        <div class="hero-note">
          The app now uses the issue summaries from <code>issue_briefs_reviewer_final.json</code>
          for participant-facing explanations. There are 12 participant links total.
        </div>
      </section>
      <section class="group-grid">
        {''.join(cards)}
      </section>
    </main>
    """
    return page_shell("Survey 698", body)


def admin_page() -> str:
    with db_connection() as conn:
        submissions = conn.execute(
            """
            SELECT s.id, s.invite_token, s.participant_label, s.participant_name,
                   s.group_code, s.created_at, COUNT(r.id) AS response_count
            FROM submissions s
            LEFT JOIN responses r ON r.submission_id = s.id
            GROUP BY s.id
            ORDER BY s.created_at DESC
            """
        ).fetchall()
    statuses = get_invite_statuses()

    invite_rows = []
    for invite in INVITES:
        status = statuses.get(invite["token"], "not started")
        invite_rows.append(
            f"""
            <tr>
              <td>{html.escape(invite["label"])}</td>
              <td>{html.escape(invite["group"])}</td>
              <td><code>/invite/{html.escape(invite["token"])}</code></td>
              <td>{html.escape(status.title())}</td>
            </tr>
            """
        )

    submission_rows = []
    for row in submissions:
        submission_rows.append(
            f"""
            <tr>
              <td>{row["id"]}</td>
              <td>{html.escape(row["participant_label"])}</td>
              <td>{html.escape(row["participant_name"])}</td>
              <td>{html.escape(row["group_code"])}</td>
              <td>{row["response_count"]}</td>
              <td>{html.escape(row["created_at"])}</td>
            </tr>
            """
        )

    body = f"""
    {nav_bar()}
    <main class="layout">
      <section class="hero hero-compact">
        <div class="eyebrow">Admin</div>
        <h1>Invite status and submissions</h1>
        <p>Use the invite table to distribute reviewer-specific links and the export buttons to collect results.</p>
        <div class="button-row">
          <a class="button secondary" href="/export/submissions.csv">Export submissions CSV</a>
          <a class="button secondary" href="/export/responses.csv">Export responses CSV</a>
        </div>
      </section>
      <section class="table-panel">
        <h2>Invite links</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Invite</th>
                <th>Group</th>
                <th>Path</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {''.join(invite_rows)}
            </tbody>
          </table>
        </div>
      </section>
      <section class="table-panel">
        <h2>Recorded submissions</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Invite</th>
                <th>Name</th>
                <th>Group</th>
                <th>Responses</th>
                <th>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {''.join(submission_rows) if submission_rows else '<tr><td colspan="6">No submissions yet.</td></tr>'}
            </tbody>
          </table>
        </div>
      </section>
    </main>
    """
    return page_shell("Survey Admin", body)


def invite_taken(token: str) -> bool:
    with db_connection() as conn:
        row = conn.execute(
            "SELECT 1 FROM submissions WHERE invite_token = ? LIMIT 1",
            (token,),
        ).fetchone()
    return row is not None


def get_invite_statuses() -> dict[str, str]:
    statuses = {invite["token"]: "not started" for invite in INVITES}
    with db_connection() as conn:
        try:
            for row in conn.execute("SELECT invite_token FROM drafts"):
                statuses[row["invite_token"]] = "in progress"
        except sqlite3.OperationalError:
            pass
        for row in conn.execute("SELECT invite_token FROM submissions"):
            statuses[row["invite_token"]] = "submitted"
    return statuses


def load_draft(token: str) -> dict[str, str] | None:
    with db_connection() as conn:
        try:
            row = conn.execute(
                "SELECT payload FROM drafts WHERE invite_token = ? LIMIT 1",
                (token,),
            ).fetchone()
        except sqlite3.OperationalError:
            return None
    if not row:
        return None
    try:
        data = json.loads(row["payload"])
    except json.JSONDecodeError:
        return None
    return {str(key): str(value) for key, value in data.items()}


def save_draft(
    invite: dict[str, str],
    payload: dict[str, str],
) -> None:
    cleaned = {key: value for key, value in payload.items()}
    updated_at = dt.datetime.now(dt.timezone.utc).isoformat()
    with db_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS drafts (
                invite_token TEXT PRIMARY KEY,
                participant_label TEXT NOT NULL,
                group_code TEXT NOT NULL,
                participant_name TEXT NOT NULL DEFAULT '',
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            INSERT INTO drafts (
                invite_token, participant_label, group_code, participant_name, payload, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(invite_token) DO UPDATE SET
                participant_label=excluded.participant_label,
                group_code=excluded.group_code,
                participant_name=excluded.participant_name,
                payload=excluded.payload,
                updated_at=excluded.updated_at
            """,
            (
                invite["token"],
                invite["label"],
                invite["group"],
                cleaned.get("participant_name", "").strip(),
                json.dumps(cleaned),
                updated_at,
            ),
        )
        conn.commit()


def delete_draft(token: str) -> None:
    with db_connection() as conn:
        try:
            conn.execute("DELETE FROM drafts WHERE invite_token = ?", (token,))
        except sqlite3.OperationalError:
            return
        conn.commit()


def parse_reviewer_sections(text: str) -> dict[str, str]:
    labels = [
        "What happened",
        "What should happen",
        "What this test is trying to verify",
        "When reviewing the test",
    ]
    sections: dict[str, str] = {}
    current: str | None = None
    lines = [line.strip() for line in text.splitlines() if line.strip()]

    for line in lines:
        matched = False
        for label in labels:
            prefix = f"{label}:"
            if line.startswith(prefix):
                sections[label] = line[len(prefix) :].strip()
                current = label
                matched = True
                break
        if not matched and current:
            sections[current] = f"{sections[current]} {line}".strip()
    return sections


def survey_page(
    invite: dict[str, str],
    form: dict[str, object],
    error: str = "",
    previous: dict[str, str] | None = None,
) -> str:
    previous = previous or {}
    error_block = f'<div class="flash-error">{html.escape(error)}</div>' if error else ""
    group_code = html.escape(form["group"])

    cards = []
    tests: list[dict[str, object]] = list(form["tests"])
    for test in tests:
        number = int(test["number"])
        brief = dict(test.get("_brief", {}))
        code = html.escape(load_test_code(test))
        issue_title = html.escape(str(brief.get("issue_title", "")))
        issue_summary = html.escape(str(brief.get("what_happened", "")))
        issue_url = html.escape(str(brief.get("issue_url") or test["issueUrl"]))

        detail_blocks = []
        if brief.get("what_happened"):
            detail_blocks.append(info_line("What happened", str(brief["what_happened"])))
        if brief.get("what_should_happen"):
            detail_blocks.append(
                info_line("What should happen", str(brief["what_should_happen"]))
            )
        if brief.get("what_test_should_verify"):
            detail_blocks.append(
                info_line(
                    "What the test should verify",
                    str(brief["what_test_should_verify"]),
                )
            )
        if brief.get("manual_note"):
            detail_blocks.append(info_line("Note", str(brief["manual_note"])))

        rating_markup = []
        for field_key, label, help_text in RATING_FIELDS:
            rating_markup.append(
                f"""
                <fieldset class="rating-block">
                  <div class="rating-header">
                    <legend>{html.escape(label)}</legend>
                    <div class="field-help">{html.escape(help_text)}</div>
                  </div>
                  {render_scale(number, field_key, previous.get(f"{field_key}_{number}", ""))}
                </fieldset>
                """
            )

        cards.append(
            f"""
            <section class="test-card" id="test-{number}">
              <div class="test-header">
                <div>
                  <div class="test-count">Test {number}</div>
                  <h2>#{int(test["issueNumber"])} {issue_title or "Issue summary unavailable"}</h2>
                </div>
                <a class="inline-link" href="{issue_url}" target="_blank" rel="noreferrer">GitHub issue</a>
              </div>
              <p class="test-summary">{issue_summary or "Curated issue summary not available for this item."}</p>
              <div class="issue-details">{''.join(detail_blocks)}</div>
              <section class="code-card">
                <div class="code-toolbar">
                  <div class="code-title">Generated test code</div>
                  <div class="code-actions">
                    <button class="button secondary code-close" type="button" data-target="code-{number}" aria-label="Close expanded code view">Close</button>
                    <button class="button secondary code-expand" type="button" data-target="code-{number}">Maximize</button>
                  </div>
                </div>
                <div class="code-backdrop" data-target="code-{number}"></div>
                <pre id="code-{number}" class="code-scroll"><code>{code}</code></pre>
              </section>
              <div class="ratings-grid">{''.join(rating_markup)}</div>
              <label class="comment-block" for="comment_{number}">
                <span>Optional comment</span>
                <textarea
                  id="comment_{number}"
                  name="comment_{number}"
                  rows="3"
                  placeholder="Add a short note if something stands out."
                >{html.escape(previous.get(f"comment_{number}", ""))}</textarea>
              </label>
            </section>
            """
        )

    body = f"""
    {nav_bar()}
    <main class="layout">
      <section class="hero hero-compact">
        <div class="eyebrow">{html.escape(invite["label"])}</div>
        <h1>Group {group_code} survey</h1>
        <p>
          Keep ratings focused on the test itself. The page only shows the issue context
          you need for review, and each code block scrolls in place.
        </p>
        <div class="progress-banner">
          <span id="progressText">0 of {len(tests)} tests fully scored</span>
          <div class="progress-track"><div id="progressBar"></div></div>
          <div class="draft-status" id="draftStatus">Draft autosave ready</div>
        </div>
      </section>
      {error_block}
      <form class="survey-form" method="post" action="/submit/{html.escape(invite['token'])}" data-tests="{len(tests)}" data-draft-url="/draft/{html.escape(invite['token'])}">
        <section class="identity-card">
          <h2>Participant</h2>
          <div class="identity-grid single-column">
            <label>
              <span>Your name</span>
              <input name="participant_name" value="{html.escape(previous.get('participant_name', ''))}" required>
            </label>
          </div>
        </section>
        {''.join(cards)}
        <div class="submit-row">
          <button class="button" type="submit">Submit survey</button>
        </div>
      </form>
    </main>
    """
    return page_shell(f"Invite {invite['label']}", body)


def info_line(label: str, text: str) -> str:
    return f"""
    <div class="issue-line">
      <div class="issue-line-label">{html.escape(label)}</div>
      <p>{html.escape(text)}</p>
    </div>
    """


def already_used_page(invite: dict[str, str]) -> str:
    body = f"""
    {nav_bar()}
    <main class="layout">
      <section class="hero hero-compact">
        <div class="eyebrow">Invite already used</div>
        <h1>{html.escape(invite["label"])}</h1>
        <p>This survey link has already been submitted once, so it is locked to prevent duplicates.</p>
        <a class="button secondary" href="/admin">Open admin view</a>
      </section>
    </main>
    """
    return page_shell("Invite Used", body)


def render_scale(test_number: int, field_key: str, selected_value: str = "") -> str:
    options = []
    for value in RATING_VALUES:
        checked = ' checked' if selected_value == str(value) else ""
        options.append(
            f"""
            <label class="scale-option">
              <input type="radio" name="{field_key}_{test_number}" value="{value}" required{checked}>
              <span class="scale-value">{value}</span>
            </label>
            """
        )
    return f"""
    <div class="score-scale">
      <span class="score-edge">Strongly disagree</span>
      <div class="score-options">{''.join(options)}</div>
      <span class="score-edge">Strongly agree</span>
    </div>
    """


def extract_code_block(context_text: str) -> str:
    marker = "\nGenerated Test Code:\n"
    if marker in context_text:
        return context_text.split(marker, 1)[1].strip()
    return context_text.strip()


def load_test_code(test: dict[str, object]) -> str:
    generated_path = str(test.get("generatedTestFile") or "").strip()
    if generated_path:
        path = BASE_DIR / generated_path
        if path.exists():
            return path.read_text(encoding="utf-8").strip()

    context_text = str(test.get("contextText") or "").strip()
    if context_text:
        code = extract_code_block(context_text)
        if code:
            return code

    return (
        "# Generated test code is not available in the current workspace.\n"
        "# The survey still includes the issue summary and expected behavior.\n"
        f"# Referenced file: {generated_path or 'not provided'}"
    )


def parse_form_body(handler: BaseHTTPRequestHandler) -> dict[str, str]:
    length = int(handler.headers.get("Content-Length", "0"))
    raw = handler.rfile.read(length).decode("utf-8")
    parsed = parse_qs(raw, keep_blank_values=True)
    return {key: values[0] for key, values in parsed.items()}


def validate_submission(form: dict[str, object], payload: dict[str, str]) -> str | None:
    if not payload.get("participant_name", "").strip():
        return "Your name is required."

    for test in form["tests"]:
        number = int(test["number"])
        for field_key, _, _ in RATING_FIELDS:
            value = payload.get(f"{field_key}_{number}", "").strip()
            if value not in {"1", "2", "3", "4", "5"}:
                return f"Every rating must be completed. Missing {field_key.replace('_', ' ')} for test {number}."
    return None


def save_submission(invite: dict[str, str], form: dict[str, object], payload: dict[str, str]) -> int:
    created_at = dt.datetime.now(dt.timezone.utc).isoformat()
    with db_connection() as conn:
        cur = conn.execute(
            """
            INSERT INTO submissions (
                invite_token, participant_label, participant_name, group_code, created_at
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (
                invite["token"],
                invite["label"],
                payload["participant_name"].strip(),
                form["group"],
                created_at,
            ),
        )
        submission_id = int(cur.lastrowid)
        rows = []
        for test in form["tests"]:
            number = int(test["number"])
            rows.append(
                (
                    submission_id,
                    number,
                    str(test["repo"]),
                    str(test["bucket"]),
                    int(test["issueNumber"]),
                    int(payload[f"readability_{number}"]),
                    int(payload[f"understandability_{number}"]),
                    int(payload[f"specificity_{number}"]),
                    int(payload[f"technical_soundness_{number}"]),
                    payload.get(f"comment_{number}", "").strip(),
                )
            )
        conn.executemany(
            """
            INSERT INTO responses (
                submission_id, test_number, repo, bucket, issue_number,
                readability, understandability, specificity, technical_soundness, comment
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        conn.execute("DELETE FROM drafts WHERE invite_token = ?", (invite["token"],))
        conn.commit()
        return submission_id


def thank_you_page(invite: dict[str, str], submission_id: int) -> str:
    body = f"""
    {nav_bar()}
    <main class="layout">
      <section class="hero hero-compact">
        <div class="eyebrow">Saved</div>
        <h1>Survey submitted</h1>
        <p>
          Response {submission_id} for {html.escape(invite["label"])} is stored.
          This invite link is now closed to prevent duplicates.
        </p>
        <a class="button secondary" href="/admin">Open admin view</a>
      </section>
    </main>
    """
    return page_shell("Submission Saved", body)


def csv_response(rows: list[sqlite3.Row], headers: list[str]) -> bytes:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(headers)
    for row in rows:
        writer.writerow([row[header] for header in headers])
    return buffer.getvalue().encode("utf-8")


class SurveyHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        path = urlparse(self.path).path

        if path == "/":
            return self.respond_html(landing_page())

        if path.startswith("/static/"):
            return self.serve_static(path)

        if path == "/admin":
            return self.respond_html(admin_page())

        if path == "/export/submissions.csv":
            with db_connection() as conn:
                rows = conn.execute(
                    """
                    SELECT id, invite_token, participant_label, participant_name, group_code, created_at
                    FROM submissions
                    ORDER BY created_at DESC
                    """
                ).fetchall()
            return self.respond_bytes(
                csv_response(
                    rows,
                    ["id", "invite_token", "participant_label", "participant_name", "group_code", "created_at"],
                ),
                "text/csv; charset=utf-8",
            )

        if path == "/export/responses.csv":
            with db_connection() as conn:
                rows = conn.execute(
                    """
                    SELECT submission_id, test_number, repo, bucket, issue_number,
                           readability, understandability, specificity,
                           technical_soundness, comment
                    FROM responses
                    ORDER BY submission_id DESC, test_number ASC
                    """
                ).fetchall()
            return self.respond_bytes(
                csv_response(
                    rows,
                    [
                        "submission_id",
                        "test_number",
                        "repo",
                        "bucket",
                        "issue_number",
                        "readability",
                        "understandability",
                        "specificity",
                        "technical_soundness",
                        "comment",
                    ],
                ),
                "text/csv; charset=utf-8",
            )

        if path.startswith("/invite/"):
            token = path.rsplit("/", 1)[-1]
            invite = get_invite(token)
            if not invite:
                return self.respond_error(HTTPStatus.NOT_FOUND, "Unknown invite link")
            if invite_taken(token):
                return self.respond_html(already_used_page(invite))
            form = get_group(invite["group"])
            if not form:
                return self.respond_error(HTTPStatus.NOT_FOUND, "Missing group survey")
            draft = load_draft(token) or {}
            return self.respond_html(survey_page(invite, form, previous=draft))

        return self.respond_error(HTTPStatus.NOT_FOUND, "Not found")

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path.startswith("/draft/"):
            token = path.rsplit("/", 1)[-1]
            invite = get_invite(token)
            if not invite:
                return self.respond_error(HTTPStatus.NOT_FOUND, "Unknown invite link")
            if invite_taken(token):
                return self.respond_bytes(
                    b'{"status":"submitted"}',
                    "application/json; charset=utf-8",
                    status=HTTPStatus.CONFLICT,
                )
            payload = parse_form_body(self)
            save_draft(invite, payload)
            return self.respond_bytes(
                b'{"status":"saved"}',
                "application/json; charset=utf-8",
                status=HTTPStatus.OK,
            )

        if not path.startswith("/submit/"):
            return self.respond_error(HTTPStatus.NOT_FOUND, "Not found")

        token = path.rsplit("/", 1)[-1]
        invite = get_invite(token)
        if not invite:
            return self.respond_error(HTTPStatus.NOT_FOUND, "Unknown invite link")
        if invite_taken(token):
            return self.respond_html(already_used_page(invite), status=HTTPStatus.CONFLICT)

        form = get_group(invite["group"])
        if not form:
            return self.respond_error(HTTPStatus.NOT_FOUND, "Missing group survey")

        payload = parse_form_body(self)
        error = validate_submission(form, payload)
        if error:
            return self.respond_html(
                survey_page(invite, form, error=error, previous=payload),
                status=HTTPStatus.BAD_REQUEST,
            )

        try:
            submission_id = save_submission(invite, form, payload)
        except sqlite3.IntegrityError:
            return self.respond_html(already_used_page(invite), status=HTTPStatus.CONFLICT)
        return self.respond_html(thank_you_page(invite, submission_id), status=HTTPStatus.CREATED)

    def serve_static(self, path: str) -> None:
        target = (STATIC_DIR / path.removeprefix("/static/")).resolve()
        static_root = STATIC_DIR.resolve()
        if static_root not in target.parents and target != static_root:
            return self.respond_error(HTTPStatus.FORBIDDEN, "Forbidden")
        if not target.exists() or not target.is_file():
            return self.respond_error(HTTPStatus.NOT_FOUND, "Static asset not found")

        content_type = "text/plain; charset=utf-8"
        if target.suffix == ".css":
            content_type = "text/css; charset=utf-8"
        elif target.suffix == ".js":
            content_type = "application/javascript; charset=utf-8"
        return self.respond_bytes(target.read_bytes(), content_type)

    def respond_html(self, markup: str, status: HTTPStatus = HTTPStatus.OK) -> None:
        self.respond_bytes(markup.encode("utf-8"), "text/html; charset=utf-8", status)

    def respond_bytes(
        self,
        content: bytes,
        content_type: str,
        status: HTTPStatus = HTTPStatus.OK,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def respond_error(self, status: HTTPStatus, message: str) -> None:
        body = page_shell(
            str(status.value),
            f"""
            {nav_bar()}
            <main class="layout">
              <section class="hero hero-compact">
                <div class="eyebrow">Error</div>
                <h1>{status.value} {html.escape(status.phrase)}</h1>
                <p>{html.escape(message)}</p>
              </section>
            </main>
            """,
        )
        self.respond_html(body, status=status)

    def log_message(self, format: str, *args: object) -> None:
        return


def run() -> None:
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), SurveyHandler)
    print(f"Serving on http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    run()
