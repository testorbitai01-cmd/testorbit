import { describe, expect, it } from 'vitest';
import { registrationSchema, type RegistrationInput } from '../src/index.js';

const valid: RegistrationInput = {
  fullName: 'Ananya Rao',
  registrationNumber: 'reg-2026/001',
  mobileNumber: '+91 98765 43210',
  collegeEmail: 'Ananya@College.edu',
  personalEmail: 'ananya@gmail.com',
  collegeName: 'Orbit Institute',
  location: 'Bengaluru',
  department: 'CSE',
  yearOfPassing: 2026,
  domainSlug: 'data-analytics',
  education: {
    SSC: { institutionName: 'High School', yearOfCompletion: 2020, gradeType: 'PERCENTAGE', score: 95 },
    HSC: { institutionName: 'Junior College', yearOfCompletion: 2022, major: 'Science', gradeType: 'PERCENTAGE', score: 90 },
    UG: { institutionName: 'Orbit Institute', yearOfCompletion: 2026, major: 'B.Tech CSE', gradeType: 'CGPA_10', score: 8.75 },
    PG: null,
  },
};

const errorsOf = (input: unknown) => {
  const r = registrationSchema.safeParse(input);
  return r.success ? {} : Object.fromEntries(r.error.issues.map((i) => [i.path.join('.'), i.message]));
};

describe('registrationSchema', () => {
  it('accepts a valid registration and normalises identifiers', () => {
    const r = registrationSchema.parse(valid);
    expect(r.mobileNumber).toBe('9876543210');
    expect(r.registrationNumber).toBe('REG-2026/001');
    expect(r.collegeEmail).toBe('ananya@college.edu');
  });

  it('makes PG optional but validates it when provided', () => {
    expect(registrationSchema.safeParse({ ...valid, education: { ...valid.education, PG: undefined } }).success).toBe(true);
    const withPg = {
      ...valid,
      yearOfPassing: 2028,
      education: { ...valid.education, PG: { institutionName: 'Uni', yearOfCompletion: 2028, major: 'M.Tech', gradeType: 'CGPA_10', score: 9 } },
    };
    expect(registrationSchema.safeParse(withPg).success).toBe(true);
    const badPg = { ...withPg, education: { ...withPg.education, PG: { ...withPg.education.PG!, major: '' } } };
    expect(errorsOf(badPg)['education.PG.major']).toBeDefined();
  });

  it('rejects invalid email, phone and missing fields', () => {
    const e = errorsOf({ ...valid, collegeEmail: 'not-an-email', mobileNumber: '12345', fullName: '' });
    expect(e.collegeEmail).toMatch(/valid/i);
    expect(e.mobileNumber).toMatch(/10-digit/);
    expect(e.fullName).toBeDefined();
  });

  it('validates score ranges per grading type', () => {
    expect(errorsOf({ ...valid, education: { ...valid.education, UG: { ...valid.education.UG, score: 10.5 } } })['education.UG.score']).toMatch(
      /between 0 and 10/,
    );
    expect(errorsOf({ ...valid, education: { ...valid.education, SSC: { ...valid.education.SSC, score: 101 } } })['education.SSC.score']).toMatch(
      /between 0 and 100/,
    );
    expect(errorsOf({ ...valid, education: { ...valid.education, SSC: { ...valid.education.SSC, score: 88.123 } } })['education.SSC.score']).toMatch(
      /2 decimal/,
    );
  });

  it('validates year ordering and year of passing', () => {
    const e = errorsOf({ ...valid, education: { ...valid.education, HSC: { ...valid.education.HSC, yearOfCompletion: 2019 } } });
    expect(e['education.HSC.yearOfCompletion']).toBeDefined();
    expect(errorsOf({ ...valid, yearOfPassing: 2025 }).yearOfPassing).toMatch(/match/);
    expect(errorsOf({ ...valid, education: { ...valid.education, SSC: { ...valid.education.SSC, yearOfCompletion: 1980 } } })['education.SSC.yearOfCompletion']).toBeDefined();
  });

  it('requires a well-formed domain identifier (existence is checked against the database on the server)', () => {
    expect(errorsOf({ ...valid, domainSlug: '' }).domainSlug).toBe('Select an assessment domain');
    expect(errorsOf({ ...valid, domainSlug: 'Dev Ops!' }).domainSlug).toBeDefined();
    expect(errorsOf({ ...valid, domainSlug: 'cloud-devops' }).domainSlug).toBeUndefined();
  });
});
