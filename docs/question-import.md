# Question import formats

Admin → **Question bank → Import**. Choose a format, paste text or upload a file (≤ 1.5 MB, ≤ 2000 questions), click **Preview**, review per-row errors, then **Import**. Nothing is saved before you confirm, the server re-validates on import, and only valid, non-duplicate rows are created. Templates for each format can be downloaded from the dialog.

All formats accept the same fields:

| Field | Required | Values |
| --- | --- | --- |
| domain | yes | `AI/ML`, `Data Analytics`, `Full Stack - Java`, `Full Stack - Python` (or slugs `ai-ml`, `data-analytics`, `full-stack-java`, `full-stack-python`; case/punctuation-insensitive) |
| section | yes | Section identifier, 1–8 letters/digits (`A`, `F`, `SQL1`; `Section A` also accepted). It must match a section key of the paper that should draw the question. |
| type | yes | `MCQ` or `CODING` |
| question | yes | text, ≥ 5 characters (multi-line allowed) |
| options | MCQ only | 2–6 unique options; coding questions must have none |
| answer | MCQ only | option letter `A`–`F`, 1-based number, or the exact option text |
| marks | no (default 1) | > 0, up to 2 decimals |
| negativeMarks | no (default 0) | ≤ marks; MCQ only; applied only when the paper enables negative marking |
| difficulty | no (default MEDIUM) | `EASY`, `MEDIUM`, `HARD` |
| explanation | no | admin-only text |
| externalId | no | your stable ID, unique per domain (e.g. `AIML-A-001`) |

**Domains:** the `domain` column accepts the name or identifier of any domain that exists in Admin → Domains (including newly added ones).

**Duplicates:** a row is skipped when an identical question (same domain, section, type, normalised text and options) already exists, when its `externalId` already exists in that domain, or when it repeats an earlier row in the same file.

## CSV

Header row (column order free; `domain, section, type, question` required):

```
external_id,domain,section,type,difficulty,marks,negative_marks,question,option_a,option_b,option_c,option_d,option_e,option_f,answer,explanation
AIML-A-001,AI/ML,A,MCQ,EASY,1,0.25,"Which metric suits imbalanced data?",Accuracy,F1 score,MSE,R-squared,,,B,F1 balances precision and recall
AIML-E-001,AI/ML,E,CODING,HARD,10,0,"Write a function that normalises a list.",,,,,,,,
```

RFC 4180 quoting: wrap fields containing commas, quotes or line breaks in `"…"`, and double inner quotes (`""`). Errors are reported as `Row N` (file line number).

## JSON

```json
{
  "questions": [
    {
      "externalId": "DA-B-001",
      "domain": "Data Analytics",
      "section": "B",
      "type": "MCQ",
      "difficulty": "MEDIUM",
      "marks": 1,
      "negativeMarks": 0,
      "question": "Which SQL clause filters grouped rows?",
      "options": ["WHERE", "HAVING", "ORDER BY", "LIMIT"],
      "answer": "B",
      "explanation": "HAVING filters after GROUP BY."
    },
    { "domain": "Data Analytics", "section": "E", "type": "CODING", "marks": 10, "question": "Write a SQL query returning the top 3 customers by revenue." }
  ]
}
```

A bare array is also accepted. `negative_marks` / `external_id` / `id` are accepted as aliases. Errors are reported as `Question N`.

## Structured text

Deterministic `Key: value` blocks separated by a line containing only `---`. Lines starting with `#` between blocks are comments.

```
ID: FSJ-A-001
Domain: Full Stack - Java
Section: A
Type: MCQ
Difficulty: Easy
Marks: 1
Negative: 0
Question: Which keyword prevents a method from being overridden?
A) static
B) final
C) private
D) abstract
Answer: B
Explanation: final methods cannot be overridden.
---
Domain: Full Stack - Java
Section: E
Type: CODING
Marks: 10
Question: Implement a REST endpoint that returns a paginated list of users.
    It should accept page and size parameters.
```

Rules:

* Keys (case-insensitive): `ID`, `Domain`, `Section`, `Type`, `Difficulty`, `Marks`, `Negative` / `Negative Marks`, `Question` / `Q`, `Answer`, `Explanation`.
* Options are lines `A) text` or `A. text`, in order A, B, C…
* Lines that are not a key or option continue the previous `Question`, `Explanation` or option (multi-line text, code snippets).
* Limitation: a continuation line that itself looks like `Key: value` or `A) …` is parsed as a key/option — use JSON for such content.
* Errors are reported as `Question N (line L)` with line-level details (e.g. out-of-order options).

No AI service is used to parse imports.
