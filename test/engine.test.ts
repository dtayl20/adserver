import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyMacros,
  fitsSlot,
  isEligible,
  matchesPattern,
  pageAllowed,
  selectBanner,
  weightedPick,
  type Candidate,
} from '../src/engine.ts';

const DAY = '2026-09-14';

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: 1,
    campaignId: 1,
    name: 'banner',
    type: 'image',
    imageKey: 'banners/1/a.png',
    html: '',
    targetUrl: 'https://example.com/',
    width: 728,
    height: 90,
    alt: '',
    weight: 1,
    priority: 5,
    impCap: 0,
    clickCap: 0,
    pageAllow: '',
    pageBlock: '',
    campaignImpressions: 0,
    campaignClicks: 0,
    status: 'active',
    campaignStatus: 'active',
    startsAt: '',
    endsAt: '',
    ...overrides,
  };
}

test('isEligible rejects paused, out-of-window, capped and empty creatives', () => {
  assert.equal(isEligible(candidate(), DAY), true);
  assert.equal(isEligible(candidate({ status: 'paused' }), DAY), false);
  assert.equal(isEligible(candidate({ campaignStatus: 'finished' }), DAY), false);
  assert.equal(isEligible(candidate({ startsAt: '2026-09-20' }), DAY), false);
  assert.equal(isEligible(candidate({ endsAt: '2026-09-13' }), DAY), false);
  assert.equal(isEligible(candidate({ startsAt: '2026-09-14', endsAt: '2026-09-14' }), DAY), true);
  assert.equal(isEligible(candidate({ impCap: 100, campaignImpressions: 100 }), DAY), false);
  assert.equal(isEligible(candidate({ clickCap: 5, campaignClicks: 5 }), DAY), false);
  assert.equal(isEligible(candidate({ imageKey: '', html: '' }), DAY), false);
  assert.equal(isEligible(candidate({ type: 'text', imageKey: '', html: 'hello' }), DAY), true);
});

test('fitsSlot keeps a leaderboard out of a square slot but allows a scaled square', () => {
  assert.equal(fitsSlot({ width: 728, height: 90 }, 250, 250), false);
  assert.equal(fitsSlot({ width: 300, height: 300 }, 250, 250), true);
  assert.equal(fitsSlot({ width: 728, height: 90 }, 728, 90), true);
  assert.equal(fitsSlot({ width: 300, height: 250 }, 250, 250), false);
  // Fluid slot or unrecorded creative size: never block.
  assert.equal(fitsSlot({ width: 728, height: 90 }, 0, 0), true);
  assert.equal(fitsSlot({ width: 0, height: 0 }, 250, 250), true);
  // One fixed axis compares only that axis.
  assert.equal(fitsSlot({ width: 728, height: 90 }, 728, 0), true);
  assert.equal(fitsSlot({ width: 300, height: 90 }, 728, 0), false);
});

test('selectBanner returns null when nothing is eligible', () => {
  assert.equal(selectBanner([], { rand: 0.5, day: DAY }), null);
  assert.equal(selectBanner([candidate({ status: 'draft' })], { rand: 0.5, day: DAY }), null);
});

test('priority band beats weight and count', () => {
  const low = candidate({ id: 1, priority: 9, weight: 1000 });
  const high = candidate({ id: 2, priority: 0, weight: 1 });
  for (const rand of [0, 0.2, 0.5, 0.9, 0.999]) {
    assert.equal(selectBanner([low, high], { rand, day: DAY })?.id, 2);
  }
});

test('weight controls share of voice inside one priority band', () => {
  const heavy = candidate({ id: 1, weight: 3 });
  const light = candidate({ id: 2, weight: 1 });
  assert.equal(weightedPick([heavy, light], 0.1)?.id, 1);
  assert.equal(weightedPick([heavy, light], 0.5)?.id, 1);
  assert.equal(weightedPick([heavy, light], 0.9)?.id, 2);
});

test('recently seen banners rotate out, but a lone banner still serves', () => {
  const a = candidate({ id: 1 });
  const b = candidate({ id: 2 });
  assert.equal(selectBanner([a, b], { rand: 0, day: DAY, recentIds: [1] })?.id, 2);
  assert.equal(selectBanner([a], { rand: 0, day: DAY, recentIds: [1] })?.id, 1);
});

test('matchesPattern handles hosts, wildcards, paths and full URLs', () => {
  assert.equal(matchesPattern('example.com', 'https://example.com/page'), true);
  assert.equal(matchesPattern('example.com', 'https://www.example.com/page'), true);
  assert.equal(matchesPattern('example.com', 'https://shop.example.com/x'), true);
  assert.equal(matchesPattern('example.com', 'https://notexample.com/x'), false);
  assert.equal(matchesPattern('*.example.com', 'https://shop.example.com/x'), true);
  assert.equal(matchesPattern('*.example.com', 'https://example.com/x'), false);
  assert.equal(matchesPattern('/blog*', 'https://example.com/blog/hello'), true);
  assert.equal(matchesPattern('/blog*', 'https://example.com/news'), false);
  assert.equal(matchesPattern('https://example.com/news*', 'https://example.com/news/1'), true);
  assert.equal(matchesPattern('', 'https://example.com/'), false);
});

test('pageAllowed: empty allow list means any page, block always wins', () => {
  assert.equal(pageAllowed('', '', 'https://any.example/x'), true);
  assert.equal(pageAllowed('', 'example.com', 'https://example.com/x'), false);
  assert.equal(pageAllowed('example.com', '', 'https://other.com/x'), false);
  assert.equal(pageAllowed('example.com\nnews.com', '', 'https://news.com/a'), true);
  assert.equal(pageAllowed('example.com', 'example.com/private*', 'https://example.com/private/x'), false);
});

test('applyMacros substitutes known macros only', () => {
  const out = applyMacros('{{CLICK_URL}}|{{ZONE_ID}}|{{ cachebuster }}|{{NOPE}}', {
    CLICK_URL: '/api/click?b=1',
    ZONE_ID: 3,
    CACHEBUSTER: 42,
  });
  assert.equal(out, '/api/click?b=1|3|42|{{NOPE}}');
});
