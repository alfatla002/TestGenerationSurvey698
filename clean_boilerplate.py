"""
Removes GitHub issue template boilerplate from:
  - google_forms_creator_merged.gs  (literal \\r\\n JS escape sequences)
  - issue_briefs_merged.json         (actual CR+LF in JSON strings)
"""
from __future__ import annotations
import json
import re
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def strip_boilerplate_real_crlf(text: str) -> str:
    """Remove boilerplate from strings that contain REAL CR+LF bytes."""
    # Combined: WARNING comment block (properly closed) + ## Checklist section
    text = re.sub(
        r"<!--\r.*?-->\r?\n?(\r?\n)*## Checklist.*?\.\.\.",
        "",
        text,
        flags=re.DOTALL,
    )
    # Standalone ## Checklist (no preceding WARNING comment)
    text = re.sub(r"## Checklist.*?\.\.\.", "", text, flags=re.DOTALL)
    # Standalone WARNING comment block (properly closed with -->)
    text = re.sub(r"<!--\r.*?-->", "", text, flags=re.DOTALL)
    # Truncated WARNING comment block (cut off before --> ends with ...)
    text = re.sub(r"<!--\r.*?\.\.\.", "", text, flags=re.DOTALL)
    # Clean up excess CR+LF whitespace at the start
    text = text.lstrip("\r\n")
    return text


def strip_boilerplate_literal_rn(text: str) -> str:
    """Remove boilerplate from strings that contain LITERAL \\r\\n sequences."""
    # Use .*? with DOTALL which catches everything including literal backslashes
    # Combined: HTML WARNING comment block + ## Checklist section
    text = re.sub(
        r"<!--.*?-->.*?## Checklist.*?\.\.\.",
        "",
        text,
        flags=re.DOTALL,
    )
    # Standalone ## Checklist
    text = re.sub(r"## Checklist.*?\.\.\.", "", text, flags=re.DOTALL)
    # Standalone HTML WARNING comment block
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    return text


# ---------------------------------------------------------------------------
# Clean google_forms_creator_merged.gs
# ---------------------------------------------------------------------------

gs_file = BASE / "google_forms_creator_merged.gs"
if gs_file.exists():
    original = gs_file.read_text(encoding="utf-8")
    cleaned = strip_boilerplate_literal_rn(original)

    warn_remaining = cleaned.count("IGNORING THE FOLLOWING TEMPLATE")
    checklist_remaining = cleaned.count("## Checklist")
    removed = len(original) - len(cleaned)

    gs_file.write_text(cleaned, encoding="utf-8")
    print(f"google_forms_creator_merged.gs: removed {removed:,} chars")
    print(f"  remaining WARNING blocks: {warn_remaining}")
    print(f"  remaining ## Checklist:   {checklist_remaining}")
else:
    print("google_forms_creator_merged.gs not found, skipping")

# ---------------------------------------------------------------------------
# Clean issue_briefs_merged.json (what_happened field)
# ---------------------------------------------------------------------------

MARKER = "IGNORING THE FOLLOWING TEMPLATE"
TEXT_FIELDS = [
    "what_happened",
    "what_should_happen",
    "what_test_should_verify",
    "issueSummary",
    "reviewerDescription",
    "contextText",
]

briefs_file = BASE / "issue_briefs_merged.json"
if briefs_file.exists():
    briefs = json.loads(briefs_file.read_text(encoding="utf-8"))
    total_cleaned = 0
    field_counts: dict[str, int] = {}
    for entry in briefs:
        for field in TEXT_FIELDS:
            val = entry.get(field, "")
            if not isinstance(val, str):
                continue
            if MARKER in val or "## Checklist" in val:
                entry[field] = strip_boilerplate_real_crlf(val)
                field_counts[field] = field_counts.get(field, 0) + 1
                total_cleaned += 1

    # Verify nothing remains
    remaining = sum(
        1 for entry in briefs
        for field in TEXT_FIELDS
        if isinstance(entry.get(field), str) and MARKER in entry[field]
    )

    briefs_file.write_text(
        json.dumps(briefs, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\nissue_briefs_merged.json: cleaned {total_cleaned} field occurrences")
    for field, count in sorted(field_counts.items()):
        print(f"  {field}: {count}")
    print(f"  remaining WARNING blocks after cleanup: {remaining}")
else:
    print("issue_briefs_merged.json not found, skipping")
