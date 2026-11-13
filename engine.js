/*
 * 装备技能配装器 - 计算引擎
 *
 * 目标：六件装备各选一件，使 18 条能力的汇总点数尽可能接近用户设定的目标。
 * 判定顺序：
 *   1. 最大化「命中点数」Σ min(实际点数, 目标点数)，等价于最小化逐项绝对偏差。
 *   2. 并列时，优先让多余的能力落在用户选择过的技能上（减少完全不需要的能力）。
 * 另外提供 analyzeGap：目标未满足时，分析是否再补一条特定词条就能满足，并给出替换部位。
 * 提供 findFivePlusOneGaps：搜索“任意五件齐备、只缺剩余部位一件整装”的组合。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BuildEngine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ABILITIES = Object.freeze([
    Object.freeze({ id: 'dimensional_leap', label: 'Dimensional Leap', short: 'DL', accent: '#a78bfa' }),
    Object.freeze({ id: 'white_hole', label: 'White Hole', short: 'WH', accent: '#38bdf8' }),
    Object.freeze({ id: 'registry', label: 'Registry', short: 'RG', accent: '#2dd4bf' }),
    Object.freeze({ id: 'crit_damage', label: '爆伤', short: '爆', accent: '#fb7185' }),
    Object.freeze({ id: 'attack', label: '攻击', short: '攻', accent: '#fbbf24' }),
    Object.freeze({ id: 'warrior', label: '战士', short: '战', accent: '#ef4444' }),
    Object.freeze({ id: 'archer', label: '弓手', short: '弓', accent: '#a3e635' }),
    Object.freeze({ id: 'thief', label: '飞侠', short: '侠', accent: '#e879f9' }),
    Object.freeze({ id: 'mage', label: '法师', short: '法', accent: '#818cf8' }),
    Object.freeze({ id: 'pirate', label: '海盗', short: '海', accent: '#f97316' }),
    Object.freeze({ id: 'boss_damage', label: 'BD', short: 'BD', accent: '#f43f5e' }),
    Object.freeze({ id: 'ignore_defense', label: '无视', short: '无', accent: '#22d3ee' }),
    Object.freeze({ id: 'damage', label: '伤害', short: '伤', accent: '#facc15' })
  ]);

  const SLOTS = Object.freeze([
    Object.freeze({ id: 'hat', label: '帽子', key: 'hat' }),
    Object.freeze({ id: 'top', label: '衣服', key: 'top' }),
    Object.freeze({ id: 'bottom', label: '裤子', key: 'bottom' }),
    Object.freeze({ id: 'cape', label: '披风', key: 'cape' }),
    Object.freeze({ id: 'gloves', label: '手套', key: 'gloves' }),
    Object.freeze({ id: 'shoes', label: '鞋子', key: 'shoes' })
  ]);

  const ABILITY_BY_ID = new Map(ABILITIES.map((a) => [a.id, a]));
  const ABILITY_INDEX = new Map(ABILITIES.map((a, index) => [a.id, index]));
  const SLOT_BY_ID = new Map(SLOTS.map((s) => [s.id, s]));
  const MAX_PER_ABILITY = 3;
  const TOTAL_LINES = 18;
  const FIVE_ITEM_LINES = 15;
  const MAX_SAFE_WAYS = Number.MAX_SAFE_INTEGER;

  function emptyTarget() {
    const target = {};
    for (const ability of ABILITIES) target[ability.id] = 0;
    return target;
  }

  function targetTotal(target) {
    let total = 0;
    for (const ability of ABILITIES) total += Number(target && target[ability.id]) || 0;
    return total;
  }

  function validateTarget(target) {
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      return '目标点数格式不正确';
    }
    for (const ability of ABILITIES) {
      const value = target[ability.id];
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 0 || value > MAX_PER_ABILITY) {
        return `${ability.label} 的点数必须是 0–${MAX_PER_ABILITY} 的整数`;
      }
    }
    if (targetTotal(target) > TOTAL_LINES) {
      return `目标总点数不能超过 ${TOTAL_LINES} 点`;
    }
    return null;
  }

  function hasDistinctAbilities(item) {
    if (!item || !Array.isArray(item.abilities) || item.abilities.length !== 3) return false;
    return new Set(item.abilities).size === 3;
  }

  function validateState(state, options) {
    const allowDuplicateAbilities = Boolean(options && options.allowDuplicateAbilities);
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return '数据格式不正确';
    }
    const targetError = validateTarget(state.target);
    if (targetError) return targetError;
    if (!Array.isArray(state.items)) return '装备数据格式不正确';

    const ids = new Set();
    for (const item of state.items) {
      if (!item || typeof item !== 'object') return '存在无法识别的装备数据';
      if (typeof item.id !== 'string' || !item.id.trim()) return '装备缺少有效 ID';
      if (ids.has(item.id)) return `装备 ID 重复：${item.id}`;
      ids.add(item.id);
      if (!SLOT_BY_ID.has(item.slot)) return '装备部位不正确';
      if (typeof item.name !== 'string' || !item.name.trim()) return '装备名称不能为空';
      if (item.name.trim().length > 40) return '装备名称不能超过 40 个字符';
      if (!Array.isArray(item.abilities) || item.abilities.length !== 3) {
        return '每件装备必须恰好包含 3 个能力';
      }
      for (const abilityId of item.abilities) {
        if (!ABILITY_BY_ID.has(abilityId)) return `未知能力：${abilityId}`;
      }
      if (!allowDuplicateAbilities && !hasDistinctAbilities(item)) {
        return '同一件装备的 3 个能力不能重复';
      }
    }
    return null;
  }

  function countAbilities(items) {
    const counts = {};
    for (const ability of ABILITIES) counts[ability.id] = 0;
    for (const item of items) {
      if (!item || !Array.isArray(item.abilities)) continue;
      for (const abilityId of item.abilities) {
        if (Object.prototype.hasOwnProperty.call(counts, abilityId)) counts[abilityId] += 1;
      }
    }
    return counts;
  }

  function abilityKey(abilityIds) {
    return abilityIds.slice().sort(function (a, b) {
      return (ABILITY_INDEX.get(a) || 0) - (ABILITY_INDEX.get(b) || 0);
    }).join('|');
  }

  function addWays(total, addition) {
    const sum = total + addition;
    return sum > MAX_SAFE_WAYS ? MAX_SAFE_WAYS : sum;
  }

  function metricsForCounts(counts, target) {
    let matched = 0;
    let wantedLines = 0;
    let deficit = 0;
    let excess = 0;
    let totalLines = 0;

    for (const ability of ABILITIES) {
      const actual = counts[ability.id] || 0;
      const goal = target[ability.id] || 0;
      totalLines += actual;
      matched += Math.min(actual, goal);
      if (goal > 0) wantedLines += actual;
      if (actual > goal) excess += actual - goal;
      else deficit += goal - actual;
    }

    const targetSum = targetTotal(target);
    return {
      counts,
      matched,
      wantedLines,
      deficit,
      excess,
      diff: deficit + excess,
      targetTotal: targetSum,
      totalLines,
      unwanted: totalLines - wantedLines,
      accuracy: targetSum > 0 ? matched / targetSum : 0
    };
  }

  function evaluateSelection(selection, target) {
    const items = [];
    for (const slot of SLOTS) {
      const item = selection && selection[slot.id];
      if (!item) {
        return { ok: false, code: 'MISSING_SLOT', message: `${slot.label}还没有选择装备` };
      }
      items.push(item);
    }
    return Object.assign({ ok: true }, metricsForCounts(countAbilities(items), target));
  }

  /**
   * 分析当前组合距离目标还差什么，并寻找“再补一条词条就能满足”的替换位置。
   * 返回 status: met（已满足）/ one-away（只差一条）/ far（还差多条）。
   */
  function analyzeGap(selection, target) {
    const evaluation = evaluateSelection(selection, target);
    if (!evaluation.ok) return evaluation;

    const deficits = [];
    for (const ability of ABILITIES) {
      const goal = target[ability.id] || 0;
      const actual = evaluation.counts[ability.id] || 0;
      if (actual < goal) {
        deficits.push({
          ability,
          count: goal - actual,
          actual,
          target: goal
        });
      }
    }

    const totalDeficit = deficits.reduce((sum, entry) => sum + entry.count, 0);
    const base = Object.assign({}, evaluation, {
      deficits,
      totalDeficit
    });

    if (totalDeficit === 0) {
      return Object.assign(base, { status: 'met', candidates: [], recommendation: null });
    }

    if (totalDeficit > 1) {
      return Object.assign(base, { status: 'far', candidates: [], recommendation: null });
    }

    const missingAbility = deficits[0].ability;
    const candidates = [];

    SLOTS.forEach(function (slot, slotIndex) {
      const item = selection[slot.id];
      if (!item || !hasDistinctAbilities(item)) return;
      const seenRemove = new Set();

      item.abilities.forEach(function (removeId, lineIndex) {
        if (seenRemove.has(removeId)) return;
        seenRemove.add(removeId);

        const removeAbility = ABILITY_BY_ID.get(removeId);
        if (!removeAbility) return;
        if (removeId === missingAbility.id) return;
        if ((evaluation.counts[removeId] || 0) <= (target[removeId] || 0)) return;

        const newAbilities = item.abilities.slice();
        newAbilities[lineIndex] = missingAbility.id;
        if (new Set(newAbilities).size !== 3) return;

        const newCounts = Object.assign({}, evaluation.counts);
        newCounts[removeId] -= 1;
        newCounts[missingAbility.id] += 1;

        let satisfied = true;
        for (const ability of ABILITIES) {
          if ((target[ability.id] || 0) > (newCounts[ability.id] || 0)) {
            satisfied = false;
            break;
          }
        }
        if (!satisfied) return;

        const excessTypes = new Set();
        let keptTargetLines = 0;
        item.abilities.forEach(function (abilityId) {
          if ((evaluation.counts[abilityId] || 0) > (target[abilityId] || 0)) {
            excessTypes.add(abilityId);
          }
        });
        newAbilities.forEach(function (abilityId) {
          if ((target[abilityId] || 0) > 0) keptTargetLines += 1;
        });

        candidates.push({
          slot,
          slotIndex,
          item,
          addAbility: missingAbility,
          removeAbility,
          newAbilities,
          excessTypes: excessTypes.size,
          removedSurplus: (evaluation.counts[removeId] || 0) - (target[removeId] || 0),
          keptTargetLines
        });
      });
    });

    candidates.sort(function (a, b) {
      if (a.excessTypes !== b.excessTypes) return a.excessTypes - b.excessTypes;
      if (a.keptTargetLines !== b.keptTargetLines) return b.keptTargetLines - a.keptTargetLines;
      if (a.removedSurplus !== b.removedSurplus) return b.removedSurplus - a.removedSurplus;
      return a.slotIndex - b.slotIndex;
    });

    return Object.assign(base, {
      status: 'one-away',
      missingAbility,
      missingCount: 1,
      candidates,
      recommendation: candidates[0] || null
    });
  }

  /**
   * 五件齐备、缺一件整装的搜索。
   *
   * 对每个“被剩下的部位”，枚举其余五个部位各一件的五件组合；找出
   * 目标缺口恰好为 3 条词条的组合，并检查剩下的部位是否存在刚好带这
   * 3 条词条的装备。若不存在，就记录这个五件组合与缺少的整件装备。
   */
  function findFivePlusOneGaps(items, target, options) {
    const targetError = validateTarget(target);
    if (targetError) {
      return { ok: false, code: 'INVALID_TARGET', message: targetError };
    }

    const targetSum = targetTotal(target);
    if (targetSum < 3) {
      return { ok: true, cases: [], total: 0, truncated: false };
    }

    const bySlot = new Map(SLOTS.map((slot) => [slot.id, []]));
    const itemKeySets = new Map(SLOTS.map((slot) => [slot.id, new Set()]));

    for (const item of items || []) {
      if (!item || !SLOT_BY_ID.has(item.slot) || !Array.isArray(item.abilities)) continue;
      if (item.abilities.length !== 3) continue;
      if (item.abilities.some((id) => !ABILITY_BY_ID.has(id))) continue;
      if (!hasDistinctAbilities(item)) continue;
      bySlot.get(item.slot).push(item);
      itemKeySets.get(item.slot).add(abilityKey(item.abilities));
    }

    const dims = makeDims(target);
    const preparedBySlot = new Map();
    for (const slot of SLOTS) {
      preparedBySlot.set(slot.id, bySlot.get(slot.id).map((item) => prepareItem(item, dims, target)));
    }

    const maxCases = options && Number.isInteger(options.maxCases) && options.maxCases > 0
      ? options.maxCases
      : 80;
    const casesByKey = new Map();

    for (let missingSlotIndex = 0; missingSlotIndex < SLOTS.length; missingSlotIndex += 1) {
      const missingSlot = SLOTS[missingSlotIndex];
      const usedSlots = SLOTS.filter((slot) => slot.id !== missingSlot.id);
      if (usedSlots.some((slot) => bySlot.get(slot.id).length === 0)) continue;

      const layers = [
        new Map([[0, { matched: 0, ways: 1, prevState: -1, itemIndex: -1 }]])
      ];
      let impossible = false;

      for (let slotIndex = 0; slotIndex < usedSlots.length; slotIndex += 1) {
        const previous = layers[slotIndex];
        const next = new Map();
        const choices = preparedBySlot.get(usedSlots[slotIndex].id);
        const remainingAfter = usedSlots.length - (slotIndex + 1);

        for (const [state, entry] of previous) {
          for (let itemIndex = 0; itemIndex < choices.length; itemIndex += 1) {
            const choice = choices[itemIndex];
            let nextState = state;
            let gain = 0;

            for (const [dimIndex, amount] of choice.contrib) {
              const dim = dims[dimIndex];
              const oldDigit = Math.floor(state / dim.place) % dim.base;
              const newDigit = Math.min(dim.cap, oldDigit + amount);
              if (newDigit !== oldDigit) {
                nextState += (newDigit - oldDigit) * dim.place;
                gain += newDigit - oldDigit;
              }
            }

            const nextMatched = entry.matched + gain;
            const deficit = targetSum - nextMatched;
            if (deficit < 3) continue;
            if (deficit - 3 > remainingAfter * 3) continue;

            const existing = next.get(nextState);
            if (existing) {
              existing.ways = addWays(existing.ways, entry.ways);
            } else {
              next.set(nextState, {
                matched: nextMatched,
                ways: entry.ways,
                prevState: state,
                itemIndex
              });
            }
          }
        }

        layers.push(next);
        if (next.size === 0) {
          impossible = true;
          break;
        }
      }

      if (impossible) continue;

      const finalLayer = layers[usedSlots.length];
      for (const [state, entry] of finalLayer) {
        if (targetSum - entry.matched !== 3) continue;

        const missingIds = [];
        for (const dim of dims) {
          const digit = Math.floor(state / dim.place) % dim.base;
          const need = dim.cap - digit;
          for (let i = 0; i < need; i += 1) missingIds.push(dim.ability.id);
        }
        if (missingIds.length !== 3) continue;
        if (new Set(missingIds).size !== 3) continue;

        const missingKey = abilityKey(missingIds);
        if (itemKeySets.get(missingSlot.id).has(missingKey)) continue;

        const caseKey = missingSlot.id + '|' + missingKey;
        const selection = {};
        let currentState = state;
        for (let slotIndex = usedSlots.length - 1; slotIndex >= 0; slotIndex -= 1) {
          const layerEntry = layers[slotIndex + 1].get(currentState);
          if (!layerEntry) {
            currentState = -1;
            break;
          }
          selection[usedSlots[slotIndex].id] =
            preparedBySlot.get(usedSlots[slotIndex].id)[layerEntry.itemIndex].item;
          currentState = layerEntry.prevState;
        }
        if (currentState !== 0) continue;

        const selectionItems = usedSlots.map((slot) => selection[slot.id]);
        const metrics = metricsForCounts(countAbilities(selectionItems), target);
        let maxExcess = 0;
        for (const ability of ABILITIES) {
          const excess = (metrics.counts[ability.id] || 0) - (target[ability.id] || 0);
          if (excess > maxExcess) maxExcess = excess;
        }

        const missingCounts = new Map();
        for (const abilityId of missingIds) {
          missingCounts.set(abilityId, (missingCounts.get(abilityId) || 0) + 1);
        }
        const missing = [];
        for (const ability of ABILITIES) {
          const count = missingCounts.get(ability.id) || 0;
          if (count > 0) missing.push({ ability, count });
        }

        const existing = casesByKey.get(caseKey);
        if (!existing) {
          casesByKey.set(caseKey, {
            missingSlot,
            missingSlotIndex,
            missingAbilities: missingIds.map((abilityId) => ABILITY_BY_ID.get(abilityId)),
            missingKey,
            missing,
            ways: entry.ways,
            selection,
            selectionList: usedSlots.map((slot) => ({ slot, item: selection[slot.id] })),
            counts: metrics.counts,
            matched: metrics.matched,
            unwanted: metrics.unwanted,
            maxExcess,
            totalLines: FIVE_ITEM_LINES
          });
        } else {
          existing.ways = addWays(existing.ways, entry.ways);
          if (metrics.unwanted < existing.unwanted ||
              (metrics.unwanted === existing.unwanted && maxExcess < existing.maxExcess)) {
            existing.selection = selection;
            existing.selectionList = usedSlots.map((slot) => ({ slot, item: selection[slot.id] }));
            existing.counts = metrics.counts;
            existing.matched = metrics.matched;
            existing.unwanted = metrics.unwanted;
            existing.maxExcess = maxExcess;
          }
        }
      }
    }

    const cases = Array.from(casesByKey.values());
    cases.sort(function (a, b) {
      if (a.ways !== b.ways) return b.ways - a.ways;
      if (a.missingSlotIndex !== b.missingSlotIndex) return a.missingSlotIndex - b.missingSlotIndex;
      return a.missingKey.localeCompare(b.missingKey);
    });

    return {
      ok: true,
      cases: cases.slice(0, maxCases),
      total: cases.length,
      truncated: cases.length > maxCases
    };
  }

  function makeDims(target) {
    const dims = [];
    let place = 1;
    for (const ability of ABILITIES) {
      const cap = target[ability.id] || 0;
      if (cap <= 0) continue;
      dims.push({
        ability,
        cap,
        base: cap + 1,
        place
      });
      place *= cap + 1;
    }
    return dims;
  }

  function prepareItem(item, dims, target) {
    const abilityCounts = new Map();
    let wanted = 0;
    for (const abilityId of item.abilities) {
      abilityCounts.set(abilityId, (abilityCounts.get(abilityId) || 0) + 1);
      if ((target[abilityId] || 0) > 0) wanted += 1;
    }

    const contrib = [];
    for (let i = 0; i < dims.length; i += 1) {
      const count = abilityCounts.get(dims[i].ability.id) || 0;
      if (count > 0) contrib.push([i, count]);
    }
    return { item, contrib, wanted };
  }

  function better(candidate, current) {
    if (!current) return true;
    if (candidate.matched !== current.matched) return candidate.matched > current.matched;
    return candidate.wanted > current.wanted;
  }

  function solve(items, target) {
    const targetError = validateTarget(target);
    if (targetError) {
      return { ok: false, code: 'INVALID_TARGET', message: targetError };
    }

    const bySlot = new Map(SLOTS.map((slot) => [slot.id, []]));
    for (const item of items || []) {
      if (!item || !SLOT_BY_ID.has(item.slot) || !Array.isArray(item.abilities)) continue;
      if (item.abilities.length !== 3) continue;
      if (item.abilities.some((id) => !ABILITY_BY_ID.has(id))) continue;
      if (!hasDistinctAbilities(item)) continue;
      bySlot.get(item.slot).push(item);
    }

    const missing = SLOTS.filter((slot) => bySlot.get(slot.id).length === 0);
    if (missing.length > 0) {
      return {
        ok: false,
        code: 'MISSING_SLOT',
        missingSlots: missing.map((slot) => slot.id),
        message: `请先为这些部位录入装备：${missing.map((slot) => slot.label).join('、')}`
      };
    }

    const dims = makeDims(target);
    const prepared = SLOTS.map((slot) =>
      bySlot.get(slot.id).map((item) => prepareItem(item, dims, target))
    );

    const layers = [
      new Map([[0, { matched: 0, wanted: 0, prevState: -1, itemIndex: -1 }]])
    ];

    let evaluatedStates = 0;
    for (let slotIndex = 0; slotIndex < SLOTS.length; slotIndex += 1) {
      const previous = layers[slotIndex];
      const next = new Map();
      const choices = prepared[slotIndex];

      for (const [state, entry] of previous) {
        for (let itemIndex = 0; itemIndex < choices.length; itemIndex += 1) {
          const choice = choices[itemIndex];
          let nextState = state;
          let gain = 0;

          for (const [dimIndex, amount] of choice.contrib) {
            const dim = dims[dimIndex];
            const oldDigit = Math.floor(state / dim.place) % dim.base;
            const newDigit = Math.min(dim.cap, oldDigit + amount);
            if (newDigit !== oldDigit) {
              nextState += (newDigit - oldDigit) * dim.place;
              gain += newDigit - oldDigit;
            }
          }

          const candidate = {
            matched: entry.matched + gain,
            wanted: entry.wanted + choice.wanted,
            prevState: state,
            itemIndex
          };
          const existing = next.get(nextState);
          if (better(candidate, existing)) next.set(nextState, candidate);
        }
      }

      evaluatedStates += next.size;
      layers.push(next);
    }

    let bestState = null;
    let bestEntry = null;
    for (const [state, entry] of layers[SLOTS.length]) {
      if (better(entry, bestEntry)) {
        bestEntry = entry;
        bestState = state;
      }
    }

    if (!bestEntry) {
      return {
        ok: false,
        code: 'NO_SOLUTION',
        message: '没有找到可行的装备组合'
      };
    }

    const selection = {};
    let state = bestState;
    for (let slotIndex = SLOTS.length - 1; slotIndex >= 0; slotIndex -= 1) {
      const entry = layers[slotIndex + 1].get(state);
      selection[SLOTS[slotIndex].id] = prepared[slotIndex][entry.itemIndex].item;
      state = entry.prevState;
    }

    const result = evaluateSelection(selection, target);
    if (!result.ok) return result;

    let searchSpace = 1;
    for (const slot of SLOTS) searchSpace *= bySlot.get(slot.id).length;

    return Object.assign(result, {
      selection,
      selectionList: SLOTS.map((slot) => ({ slot, item: selection[slot.id] })),
      evaluatedStates,
      searchSpace,
      exact: result.diff === 0
    });
  }

  return Object.freeze({
    ABILITIES,
    SLOTS,
    ABILITY_BY_ID,
    SLOT_BY_ID,
    MAX_PER_ABILITY,
    TOTAL_LINES,
    emptyTarget,
    targetTotal,
    validateTarget,
    validateState,
    hasDistinctAbilities,
    countAbilities,
    evaluateSelection,
    analyzeGap,
    findFivePlusOneGaps,
    solve
  });
});
