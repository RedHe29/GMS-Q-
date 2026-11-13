'use strict';

const assert = require('assert');
const E = require('../engine.js');

function makeItem(id, slot, abilities) {
  return { id, slot, name: id, abilities };
}

function randomTarget(rng) {
  const target = E.emptyTarget();
  let remaining = 18;
  for (const ability of E.ABILITIES) {
    const max = Math.min(3, remaining);
    const value = Math.floor(rng() * (max + 1));
    target[ability.id] = value;
    remaining -= value;
  }
  return target;
}

function seeded(seed) {
  let value = seed >>> 0;
  return function rng() {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function randomAbilities(rng) {
  const pool = E.ABILITIES.slice();
  const selected = [];
  for (let i = 0; i < 3; i += 1) {
    const index = Math.floor(rng() * pool.length);
    selected.push(pool.splice(index, 1)[0].id);
  }
  return selected;
}

function bruteForce(bySlot, target) {
  let best = null;
  let bestSelection = null;
  const slots = E.SLOTS;
  const indexes = slots.map(() => 0);

  function visit(depth, selection) {
    if (depth === slots.length) {
      const metrics = E.evaluateSelection(selection, target);
      const score = { matched: metrics.matched, wanted: metrics.wantedLines };
      if (!best || score.matched > best.matched || (score.matched === best.matched && score.wanted > best.wanted)) {
        best = score;
        bestSelection = Object.assign({}, selection);
      }
      return;
    }
    const slot = slots[depth];
    for (const item of bySlot.get(slot.id)) {
      selection[slot.id] = item;
      visit(depth + 1, selection);
    }
  }
  visit(0, {});
  return { best, bestSelection };
}

// Ability catalog and backward-compatible target data.
{
  assert.strictEqual(E.ABILITIES.length, 13);
  const labels = E.ABILITIES.map((ability) => ability.label);
  ['BD', '无视', '伤害'].forEach((label) => assert(labels.includes(label)));
  const oldTarget = E.emptyTarget();
  delete oldTarget.boss_damage;
  delete oldTarget.ignore_defense;
  delete oldTarget.damage;
  assert.strictEqual(E.validateState({ target: oldTarget, items: [] }), null);
}

for (let test = 0; test < 300; test += 1) {
  const rng = seeded(1000 + test);
  const target = randomTarget(rng);
  const items = [];
  const bySlot = new Map(E.SLOTS.map((slot) => [slot.id, []]));
  for (const slot of E.SLOTS) {
    const count = 1 + Math.floor(rng() * 4);
    for (let i = 0; i < count; i += 1) {
      const abilities = randomAbilities(rng);
      const item = makeItem(`t${test}-${slot.id}-${i}`, slot.id, abilities);
      items.push(item);
      bySlot.get(slot.id).push(item);
    }
  }

  const solved = E.solve(items, target);
  const brute = bruteForce(bySlot, target);
  assert.strictEqual(solved.ok, true, `solve failed: ${solved.message}`);
  assert.strictEqual(solved.matched, brute.best.matched, `matched mismatch test ${test}`);
  assert.strictEqual(solved.wantedLines, brute.best.wanted, `wanted mismatch test ${test}`);
  assert.strictEqual(solved.diff, E.targetTotal(target) + 18 - 2 * solved.matched);
  const recomputed = E.evaluateSelection(solved.selection, target);
  assert.strictEqual(recomputed.matched, solved.matched);
  assert.strictEqual(recomputed.diff, solved.diff);
  for (const entry of solved.selectionList) {
    assert(entry.item, 'missing selected item');
    assert.strictEqual(entry.item.slot, entry.slot.id);
  }
}

// Exact-match case.
{
  const target = E.emptyTarget();
  target.crit_damage = 3;
  target.attack = 3;
  target.warrior = 3;
  target.archer = 3;
  target.thief = 3;
  target.mage = 3;
  const plan = {
    hat: ['crit_damage', 'attack', 'warrior'],
    top: ['crit_damage', 'attack', 'archer'],
    bottom: ['crit_damage', 'thief', 'mage'],
    cape: ['attack', 'thief', 'mage'],
    gloves: ['warrior', 'archer', 'mage'],
    shoes: ['warrior', 'archer', 'thief']
  };
  const items = E.SLOTS.map((slot) =>
    makeItem(`exact-${slot.id}`, slot.id, plan[slot.id])
  );
  const result = E.solve(items, target);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.exact, true);
  assert.strictEqual(result.diff, 0);
  assert.strictEqual(result.matched, 18);
}

// Gap analysis: one missing affix can complete the target.
{
  const target = E.emptyTarget();
  target.crit_damage = 3;
  target.attack = 3;
  target.warrior = 3;
  target.archer = 3;
  target.thief = 3;
  target.mage = 3;

  const basePlan = {
    hat: ['crit_damage', 'attack', 'warrior'],
    top: ['crit_damage', 'attack', 'archer'],
    bottom: ['crit_damage', 'thief', 'mage'],
    cape: ['attack', 'thief', 'mage'],
    gloves: ['warrior', 'archer', 'mage'],
    shoes: ['warrior', 'archer', 'thief']
  };

  const makeSelection = function (plan) {
    const selection = {};
    for (const slot of E.SLOTS) {
      selection[slot.id] = makeItem('gap-' + slot.id, slot.id, plan[slot.id]);
    }
    return selection;
  };

  const exact = makeSelection(basePlan);
  const exactGap = E.analyzeGap(exact, target);
  assert.strictEqual(exactGap.status, 'met');
  assert.strictEqual(exactGap.totalDeficit, 0);

  const oneAwayPlan = Object.assign({}, basePlan, {
    shoes: ['warrior', 'archer', 'attack']
  });
  const oneAway = makeSelection(oneAwayPlan);
  const gap = E.analyzeGap(oneAway, target);
  assert.strictEqual(gap.status, 'one-away');
  assert.strictEqual(gap.totalDeficit, 1);
  assert.strictEqual(gap.missingAbility.id, 'thief');
  assert(gap.candidates.length >= 1);
  assert(gap.candidates.every((candidate) => new Set(candidate.newAbilities).size === 3));
  assert(gap.recommendation);
  assert.strictEqual(gap.recommendation.addAbility.id, 'thief');
  assert.strictEqual(gap.recommendation.newAbilities.length, 3);
  assert(gap.recommendation.newAbilities.includes('thief'));

  const repaired = makeSelection(oneAwayPlan);
  repaired[gap.recommendation.slot.id] = makeItem(
    'gap-repaired',
    gap.recommendation.slot.id,
    gap.recommendation.newAbilities
  );
  const repairedMetrics = E.evaluateSelection(repaired, target);
  assert.strictEqual(repairedMetrics.matched, 18);
  assert.strictEqual(repairedMetrics.diff, 0);

  const farPlan = Object.assign({}, basePlan, {
    bottom: ['crit_damage', 'attack', 'mage'],
    shoes: ['warrior', 'archer', 'attack']
  });
  const farGap = E.analyzeGap(makeSelection(farPlan), target);
  assert.strictEqual(farGap.status, 'far');
  assert.strictEqual(farGap.totalDeficit, 2);
  assert.strictEqual(farGap.deficits[0].ability.id, 'thief');
  assert.strictEqual(farGap.deficits[0].count, 2);
}

// A target that is fully covered with a total below 18 is still "met".
{
  const target = E.emptyTarget();
  target.crit_damage = 1;
  target.attack = 1;
  const items = E.SLOTS.map((slot) =>
    makeItem('met-' + slot.id, slot.id, ['crit_damage', 'attack', 'mage'])
  );
  const selection = {};
  for (const item of items) selection[item.slot] = item;
  const gap = E.analyzeGap(selection, target);
  assert.strictEqual(gap.status, 'met');
  assert.strictEqual(gap.matched, 2);
  assert.strictEqual(gap.totalDeficit, 0);
}

// Five items are complete except for exactly one whole item's three affixes,
// and the remaining slot has no item with that exact combination.
{
  const target = E.emptyTarget();
  target.crit_damage = 3;
  target.attack = 3;
  target.warrior = 3;
  target.archer = 3;
  target.thief = 3;
  target.mage = 3;

  const five = [
    makeItem('five-hat', 'hat', ['crit_damage', 'attack', 'warrior']),
    makeItem('five-top', 'top', ['crit_damage', 'attack', 'archer']),
    makeItem('five-bottom', 'bottom', ['crit_damage', 'thief', 'mage']),
    makeItem('five-cape', 'cape', ['attack', 'thief', 'mage']),
    makeItem('five-gloves', 'gloves', ['warrior', 'archer', 'mage'])
  ];
  const badShoes = makeItem('five-shoes-bad', 'shoes', ['warrior', 'archer', 'mage']);
  const result = E.findFivePlusOneGaps(five.concat([badShoes]), target);
  assert.strictEqual(result.ok, true);
  assert(result.total >= 1);
  const shoeCase = result.cases.find((entry) => entry.missingSlot.id === 'shoes' &&
    entry.missingAbilities.map((ability) => ability.id).join('|') === 'warrior|archer|thief');
  assert(shoeCase, 'expected a shoes case missing warrior/archer/thief');
  assert.strictEqual(shoeCase.selectionList.length, 5);
  assert(!shoeCase.selectionList.some((entry) => entry.slot.id === 'shoes'));
  assert.strictEqual(shoeCase.ways, 1);
  assert.strictEqual(shoeCase.missing.length, 3);
  assert(shoeCase.missing.every((entry) => entry.count === 1));
  assert.strictEqual(shoeCase.missingAbilities.length, 3);

  const duplicateMissingCase = result.cases.find((entry) =>
    entry.missingSlot.id === 'bottom' && entry.missingKey === 'crit_damage|thief|thief');
  assert.strictEqual(duplicateMissingCase, undefined, 'duplicate-affix missing item must be excluded');
  assert(result.cases.every((entry) =>
    new Set(entry.missingAbilities.map((ability) => ability.id)).size === 3));

  const solved = E.solve(five.concat([badShoes]), target);
  assert.strictEqual(solved.matched, 17);

  const goodShoes = makeItem('five-shoes-good', 'shoes', ['warrior', 'archer', 'thief']);
  const withGoodShoes = E.findFivePlusOneGaps(five.concat([goodShoes]), target);
  const sameKey = withGoodShoes.cases.some((entry) => entry.missingSlot.id === 'shoes' &&
    entry.missingAbilities.map((ability) => ability.id).join('|') === 'warrior|archer|thief');
  assert.strictEqual(sameKey, false, 'exact shoes should suppress that missing-item case');
}

// Duplicate abilities on one item are invalid and must never enter a result.
{
  const duplicateItem = makeItem('dup-hat', 'hat', ['attack', 'attack', 'warrior']);
  assert.strictEqual(E.hasDistinctAbilities(duplicateItem), false);
  const badState = {
    target: E.emptyTarget(),
    items: [duplicateItem]
  };
  badState.target.attack = 1;
  assert(/不能重复/.test(E.validateState(badState)));
  assert.strictEqual(E.validateState(badState, { allowDuplicateAbilities: true }), null);

  const target = E.emptyTarget();
  target.attack = 1;
  const items = E.SLOTS.map((slot) =>
    makeItem('valid-' + slot.id, slot.id, ['attack', 'warrior', 'mage'])
  );
  const hatIndex = items.findIndex((item) => item.slot === 'hat');
  items[hatIndex] = duplicateItem;
  const result = E.solve(items, target);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'MISSING_SLOT');
  assert(result.missingSlots.includes('hat'));
}

// Missing slot case.
{
  const target = E.emptyTarget();
  target.attack = 1;
  const result = E.solve([], target);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'MISSING_SLOT');
  assert.strictEqual(result.missingSlots.length, 6);
}

// Zero target is allowed by the engine and returns a valid combination.
{
  const target = E.emptyTarget();
  const items = E.SLOTS.map((slot) =>
    makeItem(`zero-${slot.id}`, slot.id, ['attack', 'warrior', 'mage'])
  );
  const result = E.solve(items, target);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.matched, 0);
  assert.strictEqual(result.diff, 18);
}

// Larger randomized inventory should stay fast and stable.
{
  const rng = seeded(9999);
  const target = randomTarget(rng);
  const items = [];
  for (const slot of E.SLOTS) {
    for (let i = 0; i < 40; i += 1) {
      const abilities = randomAbilities(rng);
      items.push(makeItem(`big-${slot.id}-${i}`, slot.id, abilities));
    }
  }
  const started = Date.now();
  const result = E.solve(items, target);
  const elapsed = Date.now() - started;
  assert.strictEqual(result.ok, true);
  assert(elapsed < 2000, `large solve too slow: ${elapsed}ms`);
  console.log(`large inventory: ${elapsed}ms, search space ${result.searchSpace}, states ${result.evaluatedStates}`);
}

console.log('engine tests passed');
