import { describe, expect, it } from 'vitest';
import { csvCell, parseCsv, parseQuestionsCsv, parseQuestionsJson, parseQuestionsText, resolveDomainSlug } from '../src/index.js';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, commas and newlines', () => {
    const rows = parseCsv('a,b,c\r\n"x, y","he said ""hi""","line1\nline2"\n');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'he said "hi"', 'line1\nline2'],
    ]);
  });
  it('reports unterminated quotes', () => {
    expect(() => parseCsv('a,"b\nc')).toThrow(/unterminated/);
  });
});

describe('csvCell', () => {
  it('neutralises spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell(-2.5)).toBe('-2.5');
    expect(csvCell(null)).toBe('');
  });
});

describe('resolveDomainSlug', () => {
  it('matches names and slugs loosely', () => {
    expect(resolveDomainSlug('AI/ML')).toBe('ai-ml');
    expect(resolveDomainSlug('full stack - java')).toBe('full-stack-java');
    expect(resolveDomainSlug('Data Analytics')).toBe('data-analytics');
    expect(resolveDomainSlug('Cloud')).toBeUndefined();
  });
});

describe('JSON import', () => {
  it('parses friendly rows and reports errors per question', () => {
    const r = parseQuestionsJson(
      JSON.stringify({
        questions: [
          { domain: 'AI/ML', section: 'A', type: 'MCQ', question: 'What is overfitting?', options: ['A', 'B', 'C'], answer: 'B', marks: 2 },
          { domain: 'AI/ML', section: 'B', type: 'CODING', question: 'Implement gradient descent.' },
          { domain: 'Space', section: 'Z', type: 'MCQ', question: 'Bad?', options: ['x'], answer: 'C' },
        ],
      }),
    );
    expect(r.fatalErrors).toEqual([]);
    expect(r.items[0]!.question?.options.find((o) => o.isCorrect)?.text).toBe('B');
    expect(r.items[1]!.question?.type).toBe('CODING');
    expect(r.items[2]!.question).toBeUndefined();
    expect(r.items[2]!.errors.join(' ')).toMatch(/Unknown domain/);
    expect(r.items[2]!.ref).toBe('Question 3');
  });
  it('reports malformed JSON', () => {
    expect(parseQuestionsJson('{nope').fatalErrors[0]).toMatch(/Invalid JSON/);
  });
});

describe('CSV import', () => {
  it('parses the documented template and points at the failing row', () => {
    const csv = [
      'external_id,domain,section,type,difficulty,marks,negative_marks,question,option_a,option_b,option_c,option_d,option_e,option_f,answer,explanation',
      'DA-1,Data Analytics,A,MCQ,EASY,1,0.25,"Which chart, best?",Bar,Pie,Line,,,,C,Trends',
      'DA-2,Data Analytics,B,MCQ,EASY,1,0,Missing answer?,Yes,No,,,,,,',
    ].join('\n');
    const r = parseQuestionsCsv(csv);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]!.question).toMatchObject({ domainSlug: 'data-analytics', externalRef: 'DA-1', negativeMarks: 0.25, text: 'Which chart, best?' });
    expect(r.items[1]!.ref).toBe('Row 3');
    expect(r.items[1]!.errors.join(' ')).toMatch(/Answer is required/);
  });
  it('requires the core columns', () => {
    expect(parseQuestionsCsv('foo,bar\n1,2').fatalErrors[0]).toMatch(/Missing required column/);
  });
});

describe('Text import', () => {
  it('parses blocks with multi-line questions', () => {
    const text = `# comment
Domain: Full Stack - Python
Section: C
Type: MCQ
Marks: 2
Question: What does this print?
print(1 + 1)
A) 1
B) 2
C) 11
Answer: B
---
Domain: Full Stack - Python
Section: E
Type: CODING
Question: Write a REST endpoint.
`;
    const r = parseQuestionsText(text);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]!.question?.text).toBe('What does this print?\nprint(1 + 1)');
    expect(r.items[0]!.question?.options.map((o) => o.isCorrect)).toEqual([false, true, false]);
    expect(r.items[1]!.question?.type).toBe('CODING');
  });
  it('reports out-of-order options with line numbers', () => {
    const r = parseQuestionsText('Domain: AI/ML\nSection: A\nType: MCQ\nQuestion: Q?\nA) x\nC) y\nAnswer: A');
    expect(r.items[0]!.errors[0]).toMatch(/Line 6: expected option B/);
  });
});
