import { describe, expect, it } from 'vitest';
import { DEFAULT_PAPER_SECTIONS, MAX_PAPER_SECTIONS, nextSectionKey, paperInputSchema, parseQuestionsCsv, resolveDomainSlug, slugify } from '../src/index.js';

describe('nextSectionKey', () => {
  it('returns the first unused key in A…Z, AA… order', () => {
    expect(nextSectionKey(['A', 'B', 'C', 'D', 'E'])).toBe('F');
    expect(nextSectionKey(['A', 'C'])).toBe('B');
    expect(nextSectionKey([])).toBe('A');
    const alphabet = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
    expect(nextSectionKey(alphabet)).toBe('AA');
    expect(nextSectionKey([...alphabet, 'AA'])).toBe('AB');
  });
});

describe('slugify', () => {
  it('builds URL-safe domain identifiers', () => {
    expect(slugify('Cloud & DevOps')).toBe('cloud-devops');
    expect(slugify('  Full Stack – .NET  ')).toBe('full-stack-net');
    expect(slugify('Café Analytics')).toBe('cafe-analytics');
    expect(slugify('!!!')).toBe('');
  });
});

describe('paperInputSchema (dynamic sections)', () => {
  const paper = (sections: { key: string; questionCount: number }[]) => ({
    name: 'Campus Drive',
    domainSlug: 'cloud-devops',
    sections: sections.map((s) => ({ ...s, title: `Section ${s.key}`, marksPerQuestion: null, negativeMarksPerQuestion: null })),
  });

  it('accepts any number of sections with custom keys and any domain slug', () => {
    const r = paperInputSchema.safeParse(paper(['A', 'B', 'C', 'D', 'E', 'F', 'g', 'SQL1'].map((key) => ({ key, questionCount: 2 }))));
    expect(r.success).toBe(true);
    expect(r.data!.sections.map((s) => s.key)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'SQL1']); // normalised to upper case
    expect(paperInputSchema.safeParse(paper([{ key: 'A', questionCount: 1 }])).success).toBe(true);
    expect(DEFAULT_PAPER_SECTIONS.map((s) => s.key)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('rejects duplicate keys, invalid keys, no sections and too many sections', () => {
    const dup = paperInputSchema.safeParse(paper([{ key: 'A', questionCount: 1 }, { key: 'a', questionCount: 1 }]));
    expect(dup.error?.issues[0]).toMatchObject({ path: ['sections', 1, 'key'] });
    expect(paperInputSchema.safeParse(paper([{ key: 'A B', questionCount: 1 }])).success).toBe(false);
    expect(paperInputSchema.safeParse(paper([])).success).toBe(false);
    const many = Array.from({ length: MAX_PAPER_SECTIONS + 1 }, (_, i) => ({ key: `S${i}`, questionCount: 1 }));
    expect(paperInputSchema.safeParse(paper(many)).success).toBe(false);
  });
});

describe('imports with database domains', () => {
  const domains = [
    { slug: 'ai-ml', name: 'AI/ML' },
    { slug: 'cloud-devops', name: 'Cloud & DevOps' },
  ];
  it('resolves newly added domains and custom section keys', () => {
    expect(resolveDomainSlug('cloud & devops', domains)).toBe('cloud-devops');
    expect(resolveDomainSlug('Data Analytics', domains)).toBeUndefined();
    const csv = 'domain,section,type,question,option_a,option_b,answer\nCloud & DevOps,Section f,MCQ,What is IaC?,Infrastructure as Code,Nothing,A\nData Analytics,A,MCQ,Pick one?,x,y,A\n';
    const r = parseQuestionsCsv(csv, domains);
    expect(r.items[0]!.question).toMatchObject({ domainSlug: 'cloud-devops', section: 'F' });
    expect(r.items[1]!.errors[0]).toMatch(/Unknown domain "Data Analytics" \(use one of: AI\/ML, Cloud & DevOps\)/);
  });
});
