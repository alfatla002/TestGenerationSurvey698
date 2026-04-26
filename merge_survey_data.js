#!/usr/bin/env node
/**
 * merge_survey_data.js
 *
 * Merges survey data from multiple source files and produces:
 *  1. issue_briefs_merged.json  — all 169 tests (84 non-Sherlock + 85 Sherlock) with unified fields
 *  2. docs/data/survey-data.json — updated web-app data with all 169 tests in 6 groups
 *  3. google_forms_creator_merged.gs — merged Google Apps Script with all 169 tests
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname);

// ─────────────────────────────────────────────────────────────────────────────
// 1.  LOAD SOURCE FILES
// ─────────────────────────────────────────────────────────────────────────────

console.log('Loading source files…');

// 84 non-Sherlock briefs (metadata only, snake_case)
const issueBriefs = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'issue_briefs_reviewer_final.json'), 'utf8')
);

// 85 Sherlock tests (metadata + contextText + number, snake_case, NO testCode)
const sherlockData = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'survey_data_sherlock.json'), 'utf8')
);
const sherlockTests = sherlockData.tests; // array of 85

// Current web-app data (84 non-Sherlock tests, camelCase, WITH code)
const surveyDataCurrent = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'docs/data/survey-data.json'), 'utf8')
);

// google_forms_creator.gs — we need raw content to extract functions block
const googleFormsCreatorRaw = fs.readFileSync(
  path.join(ROOT, 'google_forms_creator.gs'),
  'utf8'
);

// create_evaluation_form.gs — we eval FORM_DATA to get testCode per Sherlock test
const createEvaluationFormRaw = fs.readFileSync(
  path.join(ROOT, 'create_evaluation_form.gs'),
  'utf8'
);

// ─────────────────────────────────────────────────────────────────────────────
// 2.  EXTRACT SHERLOCK testCode FROM create_evaluation_form.gs
//     The file is valid JS, so we use vm.runInNewContext to evaluate it.
// ─────────────────────────────────────────────────────────────────────────────

console.log('Extracting Sherlock testCode from create_evaluation_form.gs…');

// Strip the comment block at the top (lines starting with // or /*)
// and any function definitions after the FORM_DATA literal — we only need the data.
// The file starts with `var FORM_DATA = { … };` followed by function definitions.
// We isolate just the var declaration by finding the last `};` that closes FORM_DATA.

// Strategy: eval the entire file in a sandboxed context.
// Functions like FormApp.create etc. don't exist but FORM_DATA is just data.
const sandbox = {};
try {
  // Wrap any unknown identifiers in a Proxy that returns undefined for everything
  const wrappedCode = `
    var FormApp = new Proxy({}, { get: () => new Proxy(()=>{}, { get: () => new Proxy(()=>{}, { get: () => () => ({}) }), apply: () => new Proxy({}, { get: () => () => ({}) }) }) });
    ${createEvaluationFormRaw}
  `;
  vm.runInNewContext(wrappedCode, sandbox, { timeout: 30000 });
} catch (e) {
  // Even if function calls fail, FORM_DATA should have been assigned already
  // because it comes before the function definitions
  if (!sandbox.FORM_DATA) {
    // Try a simpler approach: just extract the FORM_DATA assignment text
    console.warn('vm execution failed, trying regex extraction:', e.message.slice(0, 100));
  }
}

let formDataTests = null;
if (sandbox.FORM_DATA && sandbox.FORM_DATA.tests) {
  formDataTests = sandbox.FORM_DATA.tests;
  console.log(`  Extracted ${formDataTests.length} Sherlock tests from FORM_DATA via vm.`);
} else {
  // Fallback: parse testCode fields by extracting them with a careful regex
  // Each test object has a `testCode:` field. We rely on the JSON-like structure
  // but the file uses JS syntax (unquoted keys, template literals not used for these).
  // We'll try a different vm approach: just assign FORM_DATA and stop before functions.
  console.log('  Trying fallback: extracting only FORM_DATA declaration…');

  // Find the end of the FORM_DATA object literal
  // It starts at `var FORM_DATA = {` and the closing `};` appears before any `function`
  const formDataMatch = createEvaluationFormRaw.match(/^var FORM_DATA\s*=/m);
  if (!formDataMatch) {
    throw new Error('Could not find FORM_DATA in create_evaluation_form.gs');
  }
  const startIdx = formDataMatch.index;

  // Find the position of the first top-level function after FORM_DATA
  const funcMatch = createEvaluationFormRaw.match(/\nfunction\s+\w+/);
  const endIdx = funcMatch ? funcMatch.index : createEvaluationFormRaw.length;

  const formDataCode = createEvaluationFormRaw.slice(startIdx, endIdx).trim();

  const sandbox2 = {};
  vm.runInNewContext(formDataCode, sandbox2, { timeout: 10000 });

  if (!sandbox2.FORM_DATA || !sandbox2.FORM_DATA.tests) {
    throw new Error('Could not extract FORM_DATA.tests from create_evaluation_form.gs');
  }
  formDataTests = sandbox2.FORM_DATA.tests;
  console.log(`  Extracted ${formDataTests.length} Sherlock tests via fallback.`);
}

// Build a map: issue_number → testCode
const sherlockTestCodeMap = new Map();
for (const t of formDataTests) {
  sherlockTestCodeMap.set(t.issue_number, t.testCode || '');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3.  EXTRACT FUNCTIONS BLOCK FROM google_forms_creator.gs
//     Everything from `function createRustForms` to end of file.
// ─────────────────────────────────────────────────────────────────────────────

console.log('Extracting functions block from google_forms_creator.gs…');

const funcBlockMatch = googleFormsCreatorRaw.match(/\nfunction createRustForms\b/);
if (!funcBlockMatch) {
  throw new Error('Could not find function createRustForms in google_forms_creator.gs');
}
const functionsBlock = googleFormsCreatorRaw.slice(funcBlockMatch.index).trim();
console.log(`  Functions block starts at offset ${funcBlockMatch.index}.`);

// ─────────────────────────────────────────────────────────────────────────────
// 4.  EXTRACT NON-SHERLOCK TESTS FROM google_forms_creator.gs
//     The SURVEY_DATA.forms array contains 6 groups (A-F) each with 14 tests.
//     We need all 84 tests with their full fields including contextText.
// ─────────────────────────────────────────────────────────────────────────────

console.log('Extracting non-Sherlock tests from google_forms_creator.gs…');

// Parse SURVEY_DATA from google_forms_creator.gs using vm
// The file uses `const SURVEY_DATA = { ... };` — we convert `const` to `var` for vm compat
const gfcSandbox = {};
try {
  // Isolate just the const SURVEY_DATA declaration (before function definitions)
  const surveyDataMatch = googleFormsCreatorRaw.match(/^const SURVEY_DATA\s*=/m);
  if (!surveyDataMatch) throw new Error('const SURVEY_DATA not found');
  const funcStart = googleFormsCreatorRaw.search(/\nfunction createRustForms\b/);
  const surveyDataCode = googleFormsCreatorRaw.slice(
    surveyDataMatch.index,
    funcStart
  ).trim()
    .replace(/^const\s+/, 'var '); // vm.runInNewContext doesn't support `const` in strict sandbox
  vm.runInNewContext(surveyDataCode, gfcSandbox, { timeout: 10000 });
} catch (e) {
  // Fallback: the object value is valid JSON, extract and parse it directly
  console.warn('  vm parse failed, trying JSON.parse fallback:', e.message.slice(0, 80));
  try {
    const surveyDataMatch = googleFormsCreatorRaw.match(/^const SURVEY_DATA\s*=\s*/m);
    const funcStart = googleFormsCreatorRaw.search(/\nfunction createRustForms\b/);
    let jsonText = googleFormsCreatorRaw.slice(
      surveyDataMatch.index + surveyDataMatch[0].length,
      funcStart
    ).trim();
    // Remove trailing semicolon if present
    if (jsonText.endsWith(';')) jsonText = jsonText.slice(0, -1).trim();
    gfcSandbox.SURVEY_DATA = JSON.parse(jsonText);
  } catch (e2) {
    throw new Error('Could not parse SURVEY_DATA from google_forms_creator.gs: ' + e2.message);
  }
}

if (!gfcSandbox.SURVEY_DATA || !gfcSandbox.SURVEY_DATA.forms) {
  throw new Error('SURVEY_DATA.forms not found in google_forms_creator.gs');
}

// Flatten all 84 non-Sherlock tests from groups A-F of google_forms_creator.gs
const gfcTests = [];
for (const formDef of gfcSandbox.SURVEY_DATA.forms) {
  for (const t of formDef.tests) {
    gfcTests.push(t);
  }
}
console.log(`  Extracted ${gfcTests.length} non-Sherlock tests from google_forms_creator.gs.`);

// ─────────────────────────────────────────────────────────────────────────────
// 5.  COLLECT 84 non-Sherlock TESTS from the current web app data
//     (These already have camelCase fields and code)
// ─────────────────────────────────────────────────────────────────────────────

console.log('Collecting existing non-Sherlock web tests from survey-data.json…');

// Flatten the existing 3 groups (A, B, C) — 28 tests each = 84 total
const existingWebTests = [];
for (const groupKey of ['A', 'B', 'C']) {
  const groupData = surveyDataCurrent.forms[groupKey];
  if (!groupData) throw new Error(`Group ${groupKey} not found in survey-data.json`);
  for (const t of groupData.tests) {
    existingWebTests.push(t);
  }
}
console.log(`  Found ${existingWebTests.length} existing non-Sherlock web tests.`);

// ─────────────────────────────────────────────────────────────────────────────
// 6.  TASK 1: Produce issue_briefs_merged.json
//     Merge issue_briefs_reviewer_final.json (84) + survey_data_sherlock.json (85)
//     Add testCode to Sherlock tests from create_evaluation_form.gs
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nTask 1: Building issue_briefs_merged.json…');

const mergedBriefs = [];

// Add 84 non-Sherlock tests (preserve all existing fields)
let nonSherlockNum = 1;
for (const brief of issueBriefs) {
  mergedBriefs.push({
    number: nonSherlockNum++,
    ...brief,
  });
}

// Add 85 Sherlock tests (add testCode from FORM_DATA)
for (const shTest of sherlockTests) {
  const testCode = sherlockTestCodeMap.get(shTest.issue_number) || '';
  if (!testCode) {
    console.warn(`  WARNING: No testCode found for Sherlock issue_number=${shTest.issue_number}`);
  }
  mergedBriefs.push({
    ...shTest,
    testCode,
  });
}

console.log(`  Total merged briefs: ${mergedBriefs.length} (expected 169)`);

fs.writeFileSync(
  path.join(ROOT, 'issue_briefs_merged.json'),
  JSON.stringify(mergedBriefs, null, 2),
  'utf8'
);
console.log('  Written: issue_briefs_merged.json');

// ─────────────────────────────────────────────────────────────────────────────
// 7.  TASK 2: Update docs/data/survey-data.json
//     Keep existing 84 non-Sherlock tests exactly as-is.
//     Add 85 Sherlock tests converted to camelCase.
//     Renumber 1..169, distribute into 6 groups (A-E=28, F=29).
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nTask 2: Building updated docs/data/survey-data.json…');

// Helper: convert Sherlock test to web-app format (camelCase)
function sherlockToWebTest(shTest, globalNumber) {
  return {
    number: globalNumber,
    repo: shTest.repo,
    issueNumber: shTest.issue_number,
    issueTitle: shTest.issue_title,
    issueUrl: shTest.issue_url,
    whatHappened: shTest.what_happened,
    whatShouldHappen: shTest.what_should_happen,
    whatTestShouldVerify: shTest.what_test_should_verify,
    manualNote: shTest.manual_note !== undefined ? shTest.manual_note : null,
    context: shTest.context,
    code: sherlockTestCodeMap.get(shTest.issue_number) || '',
  };
}

// Build flat list of all 169 tests
const allWebTests = [];

// Tests 1-84: existing non-Sherlock (camelCase, keep exactly as-is but renumber 1-84)
let globalNum = 1;
for (const t of existingWebTests) {
  allWebTests.push({ ...t, number: globalNum++ });
}

// Tests 85-169: Sherlock tests converted
for (const shTest of sherlockTests) {
  allWebTests.push(sherlockToWebTest(shTest, globalNum++));
}

console.log(`  Total web tests: ${allWebTests.length} (expected 169)`);

// Distribute into 6 groups: A-E get 28, F gets 29
// Tests 1-28 → A, 29-56 → B, 57-84 → C, 85-112 → D, 113-140 → E, 141-169 → F
const groupSizes = { A: 28, B: 28, C: 28, D: 28, E: 28, F: 29 };
const groupLabels = {
  A: 'Group A — pytest/hermes',
  B: 'Group B — pytest/hermes',
  C: 'Group C — pytest/hermes',
  D: 'Group D — Sherlock',
  E: 'Group E — Sherlock',
  F: 'Group F — Sherlock',
};

const groupOrder = ['A', 'B', 'C', 'D', 'E', 'F'];
const newForms = {};
let offset = 0;
for (const grp of groupOrder) {
  const size = groupSizes[grp];
  const slice = allWebTests.slice(offset, offset + size);
  offset += size;
  newForms[grp] = {
    group: grp,
    title: `LLM-Generated Test Case Evaluation (${groupLabels[grp]})`,
    tests: slice,
  };
}

// Build new invites (keep existing 6, add 6 for D, E, F)
const existingInvites = surveyDataCurrent.invites; // 6 existing
const newInvites = [
  ...existingInvites,
  { token: 'group-d-1', group: 'D', label: 'Group D Reviewer 1' },
  { token: 'group-d-2', group: 'D', label: 'Group D Reviewer 2' },
  { token: 'group-e-1', group: 'E', label: 'Group E Reviewer 1' },
  { token: 'group-e-2', group: 'E', label: 'Group E Reviewer 2' },
  { token: 'group-f-1', group: 'F', label: 'Group F Reviewer 1' },
  { token: 'group-f-2', group: 'F', label: 'Group F Reviewer 2' },
];

const newSurveyData = {
  invites: newInvites,
  forms: newForms,
};

fs.writeFileSync(
  path.join(ROOT, 'docs/data/survey-data.json'),
  JSON.stringify(newSurveyData, null, 2),
  'utf8'
);
console.log('  Written: docs/data/survey-data.json');

// Verify group counts
for (const grp of groupOrder) {
  const count = newForms[grp].tests.length;
  console.log(`  Group ${grp}: ${count} tests`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8.  TASK 3: Build google_forms_creator_merged.gs
//     All 169 tests in 6 groups, Sherlock tests converted to camelCase format.
//     Keep existing functions block from google_forms_creator.gs.
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nTask 3: Building google_forms_creator_merged.gs…');

// Helper: safely JSON-stringify a string for embedding in a JS object literal
function jsStr(s) {
  if (s === null || s === undefined) return 'null';
  // JSON.stringify adds the surrounding double quotes and escapes properly
  return JSON.stringify(String(s));
}

// Helper: convert a non-Sherlock GFC test to merged format (already camelCase)
function gfcTestToMergedFormat(t, globalNumber) {
  return {
    number: globalNumber,
    repo: t.repo,
    bucket: t.bucket,
    issueNumber: t.issueNumber,
    prNumber: t.prNumber,
    prTitle: t.prTitle,
    issueTitle: t.issueTitle,
    issueSummary: t.issueSummary,
    issueUrl: t.issueUrl,
    reviewerDescription: t.reviewerDescription,
    generatedTestFile: t.generatedTestFile,
    suggestedPath: t.suggestedPath,
    contextText: t.contextText,
  };
}

// Helper: convert a Sherlock test (snake_case) to GFC merged format (camelCase)
function sherlockToGfcFormat(shTest, globalNumber) {
  const testCode = sherlockTestCodeMap.get(shTest.issue_number) || '';
  // Build contextText (same as in survey_data_sherlock.json's contextText)
  const contextText = shTest.contextText || '';
  return {
    number: globalNumber,
    repo: shTest.repo,
    bucket: shTest.verification_bucket,
    issueNumber: shTest.issue_number,
    prNumber: shTest.pr_number,
    prTitle: shTest.pr_title,
    issueTitle: shTest.issue_title,
    issueSummary: shTest.issueSummary || '',
    issueUrl: shTest.issue_url,
    reviewerDescription: shTest.reviewerDescription || '',
    generatedTestFile: shTest.generated_test_file,
    suggestedPath: shTest.suggested_path,
    contextText: contextText,
    testCode: testCode,
  };
}

// Build 169 GFC tests
const allGfcTests = [];
let gfcGlobalNum = 1;

// Non-Sherlock tests (from gfcTests which has the full data including contextText)
for (const t of gfcTests) {
  allGfcTests.push(gfcTestToMergedFormat(t, gfcGlobalNum++));
}

// Sherlock tests
for (const shTest of sherlockTests) {
  allGfcTests.push(sherlockToGfcFormat(shTest, gfcGlobalNum++));
}

console.log(`  Total GFC tests: ${allGfcTests.length} (expected 169)`);

// Distribute into 6 groups same as before
const gfcGroupSizes = { A: 28, B: 28, C: 28, D: 28, E: 28, F: 29 };
const gfcGroups = {};
let gfcOffset = 0;
for (const grp of groupOrder) {
  const size = gfcGroupSizes[grp];
  gfcGroups[grp] = allGfcTests.slice(gfcOffset, gfcOffset + size);
  gfcOffset += size;
}

// Render a test object as JS (unquoted keys, string values JSON-escaped)
function renderTestObj(t) {
  const lines = [];
  lines.push('{');
  for (const [k, v] of Object.entries(t)) {
    if (v === null || v === undefined) {
      lines.push(`          ${k}: null,`);
    } else if (typeof v === 'number') {
      lines.push(`          ${k}: ${v},`);
    } else {
      lines.push(`          ${k}: ${jsStr(v)},`);
    }
  }
  lines.push('        }');
  return lines.join('\n');
}

// Build SURVEY_DATA description text
const gfcDescription = `Repo Summary
This merged form covers:
- NousResearch/hermes-agent (non-Sherlock)
- pytest-dev/pytest (non-Sherlock)
- sherlock-project/sherlock (Sherlock)

Total tests: 169 (84 non-Sherlock + 85 Sherlock)
Groups A–C: pytest/hermes tests (28 per group)
Groups D–F: Sherlock tests (28 per group, F has 29)

RUST dimensions:
- Readability
- Understandability
- Specificity
- Technical Soundness

Rating scale:
- 1 = Strongly Disagree
- 2 = Disagree
- 3 = Neutral
- 4 = Agree
- 5 = Strongly Agree`;

// Build the merged .gs file
const gsMergedLines = [];
gsMergedLines.push('// ============================================================');
gsMergedLines.push('// Google Apps Script — LLM-Generated Test Case Evaluation Form');
gsMergedLines.push('// Merged: 84 non-Sherlock (pytest/hermes) + 85 Sherlock tests');
gsMergedLines.push('// Groups A–C: pytest/hermes | Groups D–F: Sherlock');
gsMergedLines.push('// Paste into script.google.com then run createRustForms()');
gsMergedLines.push('// ============================================================');
gsMergedLines.push('');
gsMergedLines.push('const SURVEY_DATA = {');
gsMergedLines.push('  "forms": [');

for (let gi = 0; gi < groupOrder.length; gi++) {
  const grp = groupOrder[gi];
  const isLast = gi === groupOrder.length - 1;
  const grpTests = gfcGroups[grp];
  const grpLabel = groupLabels[grp];

  gsMergedLines.push('    {');
  gsMergedLines.push(`      "group": ${jsStr(grp)},`);
  gsMergedLines.push(`      "title": ${jsStr(`LLM-Generated Test Case Evaluation (${grpLabel})`)},`);
  gsMergedLines.push(`      "description": ${jsStr(gfcDescription)},`);
  gsMergedLines.push('      "tests": [');

  for (let ti = 0; ti < grpTests.length; ti++) {
    const t = grpTests[ti];
    const isLastTest = ti === grpTests.length - 1;
    const rendered = renderTestObj(t);
    gsMergedLines.push('        ' + rendered.replace(/\n/g, '\n') + (isLastTest ? '' : ','));
  }

  gsMergedLines.push('      ]');
  gsMergedLines.push('    }' + (isLast ? '' : ','));
}

gsMergedLines.push('  ]');
gsMergedLines.push('};');
gsMergedLines.push('');
gsMergedLines.push(functionsBlock);
gsMergedLines.push('');

const mergedGsContent = gsMergedLines.join('\n');

fs.writeFileSync(
  path.join(ROOT, 'google_forms_creator_merged.gs'),
  mergedGsContent,
  'utf8'
);
console.log('  Written: google_forms_creator_merged.gs');

// ─────────────────────────────────────────────────────────────────────────────
// 9.  VERIFICATION
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n--- VERIFICATION ---');

// issue_briefs_merged.json
const merged = JSON.parse(fs.readFileSync(path.join(ROOT, 'issue_briefs_merged.json'), 'utf8'));
console.log(`issue_briefs_merged.json:   ${merged.length} entries (expected 169)`);
const sherlockInMerged = merged.filter(t => t.repo && t.repo.includes('sherlock'));
const nonSherlockInMerged = merged.filter(t => t.repo && !t.repo.includes('sherlock'));
console.log(`  Non-Sherlock: ${nonSherlockInMerged.length} (expected 84)`);
console.log(`  Sherlock:     ${sherlockInMerged.length} (expected 85)`);
const sherlockWithCode = sherlockInMerged.filter(t => t.testCode && t.testCode.length > 0);
console.log(`  Sherlock with testCode: ${sherlockWithCode.length} (expected 85)`);

// survey-data.json
const sd = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/data/survey-data.json'), 'utf8'));
console.log(`\nsurvey-data.json:`);
console.log(`  Invites: ${sd.invites.length} (expected 12)`);
let sdTotal = 0;
for (const grp of groupOrder) {
  const count = sd.forms[grp].tests.length;
  sdTotal += count;
  console.log(`  Group ${grp}: ${count} tests`);
}
console.log(`  Total tests: ${sdTotal} (expected 169)`);

// google_forms_creator_merged.gs
const gsContent = fs.readFileSync(path.join(ROOT, 'google_forms_creator_merged.gs'), 'utf8');
// Count test objects by counting occurrences of "number:" field in the tests sections
const gsTestMatches = gsContent.match(/^\s+number:\s*\d+,/gm);
console.log(`\ngoogle_forms_creator_merged.gs:`);
console.log(`  Test entries: ${gsTestMatches ? gsTestMatches.length : 'N/A'} (expected 169)`);
console.log(`  Has createRustForms: ${gsContent.includes('function createRustForms')}`);
console.log(`  Has createGroupA: ${gsContent.includes('function createGroupA')}`);
console.log(`  Has createGroupF: ${gsContent.includes('function createGroupF')}`);
console.log(`  Has addLikertQuestion_: ${gsContent.includes('function addLikertQuestion_')}`);

console.log('\nDone!');
