import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bibtex, compareCitation, normalizeDoi, searchPapers, verifyCitation, type Reference } from '../references';
const actual: Reference = {
  doi: '10.1234/test',
  title: 'A study',
  authors: ['Alice Zhang', 'Bob Li'],
  journal: 'Example Journal',
  year: 2024,
  source: 'https://doi.org/10.1234/test',
  retrievedAt: '2026-11-15',
  verification: 'metadata_retrieved',
};
test('Reference metadata comparison reports every field and preserves author order', () => {
  const result = compareCitation(
    { doi: actual.doi, title: 'A Study', authors: ['Bob Li', 'Alice Zhang'], year: 2025, journal: actual.journal },
    actual,
  );
  assert.equal(result.status, 'differences_found');
  assert.equal(result.fields.length, 5);
  assert.equal(result.fields.find((field) => field.field === 'year')?.status, 'different');
  assert.equal(result.fields.find((field) => field.field === 'authors')?.status, 'different');
});
test('Unavailable registration metadata is not reported as an incorrect citation', () => {
  assert.equal(compareCitation({ year: 2024 }, { ...actual, year: undefined }).status, 'incomplete');
});
test('Crossref discovery retains source, time, candidates and abstract boundaries', async () => {
  const results = await searchPapers('example', 2, undefined, async (url) => ({
    finalUrl: url,
    body: JSON.stringify({
      message: {
        items: [
          { DOI: '10.1234/a', title: ['First'], abstract: '<p>Abstract only</p>' },
          { DOI: '10.1234/b', title: ['Second'] },
        ],
      },
    }),
  }));
  assert.equal(results.length, 2);
  assert.match(results[0]!.source, /api.crossref.org/);
  assert.equal(results[0]!.abstract, 'Abstract only');
  assert.equal(results[0]!.verification, 'metadata_retrieved');
});
test('DOI verification negotiates CSL JSON and detects a deliberately wrong year', async () => {
  let accept: string | undefined;
  const result = await verifyCitation({ doi: actual.doi, year: 2025 }, undefined, async (url, _signal, _max, _deps, header) => {
    accept = header;
    return { finalUrl: url, body: JSON.stringify({ DOI: actual.doi, title: actual.title, issued: { 'date-parts': [[2024]] } }) };
  });
  assert.equal(result.status, 'differences_found');
  assert.equal(accept, 'application/vnd.citationstyles.csl+json');
});
test('Missing DOI, failed network and mismatched DOI remain unverified', async () => {
  assert.equal((await verifyCitation({ title: 'unknown' })).status, 'unverified');
  assert.equal(
    (
      await verifyCitation({ doi: actual.doi }, undefined, async () => {
        throw new Error('429 limited');
      })
    ).status,
    'unverified',
  );
  assert.equal(
    (await verifyCitation({ doi: actual.doi }, undefined, async (url) => ({ finalUrl: url, body: '{"DOI":"10.9999/other"}' }))).status,
    'unverified',
  );
});
test('DOI normalization and BibTeX escaping preserve literal user data', () => {
  assert.equal(normalizeDoi('https://doi.org/10.1234/TEST'), '10.1234/test');
  assert.throws(() => normalizeDoi('file:///private'));
  assert.match(bibtex({ title: 'A {B} & C', year: 2024 }), /A \\\{B\\\} \\& C/);
});
