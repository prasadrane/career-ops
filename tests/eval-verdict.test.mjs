import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdict, rollup, SAMPLE_FLOOR } from '../lib/eval/verdict.mjs';

const T = { warnBelow: 0.8, failBelow: 0.6 };

test('SAMPLE_FLOOR is 5', () => assert.equal(SAMPLE_FLOOR, 5));
test('pass at or above warnBelow', () => assert.equal(verdict({ value: 0.9, n: 10, ...T }), 'pass'));
test('boundary values', () => {
  assert.equal(verdict({ value: 0.8, n: 10, ...T }), 'pass');
  assert.equal(verdict({ value: 0.6, n: 10, ...T }), 'warn');
});
test('warn between thresholds', () => assert.equal(verdict({ value: 0.7, n: 10, ...T }), 'warn'));
test('fail below failBelow', () => assert.equal(verdict({ value: 0.5, n: 10, ...T }), 'fail'));
test('insufficient-data below floor', () => {
  assert.equal(verdict({ value: 0.9, n: 3, ...T }), 'insufficient-data');
  assert.equal(verdict({ value: 0.9, n: 5, ...T }), 'pass');
});
test('custom floor honoured', () => assert.equal(verdict({ value: 0.9, n: 8, floor: 10, ...T }), 'insufficient-data'));
test('non-finite value or n is insufficient-data', () => {
  assert.equal(verdict({ value: NaN, n: 10, ...T }), 'insufficient-data');
  assert.equal(verdict({ value: 0.9, n: undefined, ...T }), 'insufficient-data');
});
test('rollup ignores insufficient-data unless all are', () => {
  assert.equal(rollup([{ verdict: 'pass' }, { verdict: 'insufficient-data' }]), 'pass');
  assert.equal(rollup([{ verdict: 'insufficient-data' }]), 'insufficient-data');
  assert.equal(rollup([]), 'insufficient-data');
});
test('rollup returns worst', () => {
  assert.equal(rollup([{ verdict: 'pass' }, { verdict: 'warn' }]), 'warn');
  assert.equal(rollup([{ verdict: 'warn' }, { verdict: 'fail' }, { verdict: 'pass' }]), 'fail');
});
