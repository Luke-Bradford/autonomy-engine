import { describe, expect, it } from 'vitest';
import { keyToWords, midSentence } from './words';
import { sentenceCaseProblem } from '../testing/sentenceCase';

describe('keyToWords (#1594 OR40 S4b-2)', () => {
  it.each([
    ['source', 'Source'],
    ['onError', 'On error'],
    ['secret name', 'Secret name'],
    ['baseUrl', 'Base URL'],
    ['maxBytes', 'Max bytes'],
  ])('reads %s as %s', (key, words) => {
    expect(keyToWords(key)).toBe(words);
    expect(sentenceCaseProblem(words)).toBeNull();
  });
});

describe('midSentence (#1594 OR40 S4b-2)', () => {
  it.each([
    ['Column mapping', 'column mapping'],
    ['url', 'url'],
    ['LLM call', 'LLM call'],
    ['ForEach', 'ForEach'],
  ])('reads %s as %s inside a longer name', (title, inside) => {
    expect(midSentence(title)).toBe(inside);
  });
});
