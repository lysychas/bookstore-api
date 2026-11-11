import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { safeEqual } from '../src/security.js';
import { centsToDecimal, decimalToCents } from '../src/money.js';

describe('safeEqual', () => {
  test('matches identical strings', () => {
    assert.equal(safeEqual('secret', 'secret'), true);
  });

  test('rejects different strings, including different lengths and empty', () => {
    assert.equal(safeEqual('secret', 'secreT'), false);
    assert.equal(safeEqual('secret', 'secret1'), false);
    assert.equal(safeEqual('', 'secret'), false);
  });

  test('non-string inputs never match', () => {
    assert.equal(safeEqual(undefined, undefined), false);
    assert.equal(safeEqual(null, 'x'), false);
    assert.equal(safeEqual(1, 1), false);
  });
});

describe('money', () => {
  test('centsToDecimal formats with two places', () => {
    assert.equal(centsToDecimal(0), '0.00');
    assert.equal(centsToDecimal(5), '0.05');
    assert.equal(centsToDecimal(1499), '14.99');
  });

  test('centsToDecimal rejects invalid input', () => {
    for (const bad of [-1, 1.5, NaN, '10', null]) {
      assert.throws(() => centsToDecimal(bad), TypeError);
    }
  });

  test('decimalToCents parses valid prices exactly', () => {
    assert.equal(decimalToCents('0'), 0);
    assert.equal(decimalToCents('14.99'), 1499);
    assert.equal(decimalToCents('9.5'), 950);
    assert.equal(decimalToCents('0.07'), 7);
  });

  test('decimalToCents rejects invalid prices', () => {
    for (const bad of ['', '-1', '1.234', '01', '1e2', 'abc', '1.', '.5', 14.99, null, '99999999999999999999']) {
      assert.equal(decimalToCents(bad), null, `"${bad}" must be rejected`);
    }
  });
});
