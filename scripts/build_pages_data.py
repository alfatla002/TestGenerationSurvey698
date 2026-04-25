from __future__ import annotations

import json
import re
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
FORMS_FILE = BASE_DIR / "google_forms_creator.gs"
BRIEFS_FILE = BASE_DIR / "issue_briefs_reviewer_final.json"
OUTPUT_FILE = BASE_DIR / "docs" / "data" / "survey-data.json"

ACTIVE_GROUPS = {
    "A": ["A", "B"],
    "B": ["C", "D"],
    "C": ["E", "F"],
}

INVITES = [
    {"token": "group-a-1", "group": "A", "label": "Group A Reviewer 1"},
    {"token": "group-a-2", "group": "A", "label": "Group A Reviewer 2"},
    {"token": "group-b-1", "group": "B", "label": "Group B Reviewer 1"},
    {"token": "group-b-2", "group": "B", "label": "Group B Reviewer 2"},
    {"token": "group-c-1", "group": "C", "label": "Group C Reviewer 1"},
    {"token": "group-c-2", "group": "C", "label": "Group C Reviewer 2"},
]


def load_forms() -> dict[str, object]:
    source = FORMS_FILE.read_text(encoding="utf-8")
    match = re.search(
        r"const SURVEY_DATA = (\{.*?\n\});\n\nfunction createRustForms",
        source,
        re.S,
    )
    if not match:
        raise RuntimeError("Could not locate SURVEY_DATA in google_forms_creator.gs")
    return json.loads(match.group(1))


def load_briefs() -> list[dict[str, object]]:
    return json.loads(BRIEFS_FILE.read_text(encoding="utf-8"))


def extract_code(context_text: str) -> str:
    marker = "\nGenerated Test Code:\n"
    if marker in context_text:
        return context_text.split(marker, 1)[1].strip()
    return ""


def build_output() -> dict[str, object]:
    forms = load_forms()["forms"]
    briefs = load_briefs()
    brief_lookup = {
        (str(item["repo"]), int(item["issue_number"])): item for item in briefs
    }
    source_forms = {str(form["group"]): form for form in forms}

    output_forms: dict[str, object] = {}
    for active_group, source_group_codes in ACTIVE_GROUPS.items():
        tests = []
        for source_group_code in source_group_codes:
            form = source_forms[source_group_code]
            for test in form["tests"]:
                brief = brief_lookup.get((str(test["repo"]), int(test["issueNumber"])), {})
                tests.append(
                    {
                        "number": len(tests) + 1,
                        "repo": str(test["repo"]),
                        "issueNumber": int(test["issueNumber"]),
                        "issueTitle": str(brief.get("issue_title") or test["issueTitle"]),
                        "issueUrl": str(brief.get("issue_url") or test["issueUrl"]),
                        "whatHappened": str(brief.get("what_happened", "")),
                        "whatShouldHappen": str(brief.get("what_should_happen", "")),
                        "whatTestShouldVerify": str(brief.get("what_test_should_verify", "")),
                        "manualNote": str(brief.get("manual_note", "")),
                        "context": str(brief.get("context", "")),
                        "code": extract_code(str(test.get("contextText", ""))),
                    }
                )
        output_forms[active_group] = {
            "group": active_group,
            "title": f"LLM-Generated Test Case Evaluation (Group {active_group})",
            "tests": tests,
        }

    return {
        "invites": INVITES,
        "forms": output_forms,
        "meta": {
            "testsPerGroup": 28,
            "groups": sorted(output_forms.keys()),
            "briefSource": BRIEFS_FILE.name,
        },
    }


def main() -> None:
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(
        json.dumps(build_output(), indent=2),
        encoding="utf-8",
    )
    print(f"Wrote {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
