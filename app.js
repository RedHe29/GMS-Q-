'use strict';

(function () {
  const E = window.BuildEngine;
  if (!E) {
    console.error('BuildEngine 未加载');
    return;
  }

  const STORAGE_KEY = 'maple-loadout-v1';
  const PARAM_DEMO = new URLSearchParams(window.location.search).get('demo') === '1';

  const state = {
    version: 1,
    target: E.emptyTarget(),
    items: []
  };

  const refs = {};
  let currentResult = null;
  let resultStale = false;
  let editing = null;
  let fiveExpanded = false;
  let toastTimer = null;
  let toastActionHandler = null;
  let saveStatusTimer = null;

  const SLOT_SAMPLES = {
    hat: '赤月之冠',
    top: '暗影战甲',
    bottom: '狂徒护腿',
    cape: '夜幕披风',
    gloves: '裁决手甲',
    shoes: '疾风战靴'
  };

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $$(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[character];
    });
  }

  function icon(name, className) {
    return '<svg class="' + (className || 'icon') + '" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
  }

  function formatNumber(value) {
    return new Intl.NumberFormat('zh-CN').format(value);
  }

  function formatClock(date) {
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  }

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'item-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
  }

  function abilityById(id) {
    return E.ABILITY_BY_ID.get(id);
  }

  function slotById(id) {
    return E.SLOT_BY_ID.get(id);
  }

  function chipMarkup(abilityId) {
    const ability = abilityById(abilityId);
    if (!ability) return '';
    return '<span class="ability-chip" style="--accent:' + ability.accent + '">' +
      '<i class="chip-dot"></i>' + escapeHtml(ability.label) +
      '</span>';
  }

  function slotIconMarkup(slot) {
    return '<span class="slot-icon" aria-hidden="true">' + icon(slot.key) + '</span>';
  }

  function hasData() {
    return state.items.length > 0 || E.targetTotal(state.target) > 0;
  }

  function readySlotCount() {
    return E.SLOTS.filter(function (slot) {
      return state.items.some(function (item) {
        return item.slot === slot.id && E.hasDistinctAbilities(item);
      });
    }).length;
  }

  function setSaveStatus(text, isError) {
    refs.saveStatus.textContent = text;
    refs.saveStatus.classList.toggle('is-error', Boolean(isError));
  }

  function persist() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: 1,
        target: state.target,
        items: state.items
      }));
      setSaveStatus('已自动保存 · ' + formatClock(new Date()));
      if (saveStatusTimer) window.clearTimeout(saveStatusTimer);
      saveStatusTimer = window.setTimeout(function () {
        setSaveStatus('自动保存已开启');
      }, 2600);
      return true;
    } catch (error) {
      setSaveStatus('本地保存不可用', true);
      return false;
    }
  }

  function loadState() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        setSaveStatus('自动保存已开启');
        return;
      }
      const parsed = JSON.parse(raw);
      const error = E.validateState(parsed, { allowDuplicateAbilities: true });
      if (error) throw new Error(error);
      state.target = Object.assign(E.emptyTarget(), parsed.target);
      state.items = parsed.items.map(function (item) {
        return {
          id: item.id,
          slot: item.slot,
          name: item.name.trim(),
          abilities: item.abilities.slice(0, 3)
        };
      });
      const invalidCount = state.items.filter(function (item) {
        return !E.hasDistinctAbilities(item);
      }).length;
      setSaveStatus(invalidCount
        ? '有 ' + invalidCount + ' 件装备含重复词条'
        : '已读取本机数据');
      if (invalidCount) {
        window.setTimeout(function () {
          showToast('有 ' + invalidCount + ' 件装备含重复词条，已从计算中排除，请编辑修正');
        }, 450);
      }
    } catch (error) {
      console.warn('无法读取本地数据', error);
      setSaveStatus('本地数据读取失败', true);
      window.setTimeout(function () {
        showToast('本地保存的数据无法读取，已从空白开始');
      }, 350);
    }
  }

  function buildTargetScale() {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < E.TOTAL_LINES; i += 1) {
      const tick = document.createElement('span');
      tick.className = 'scale-tick';
      fragment.appendChild(tick);
    }
    refs.targetScale.appendChild(fragment);
  }

  function buildTargetRows() {
    const fragment = document.createDocumentFragment();
    E.ABILITIES.forEach(function (ability) {
      const row = document.createElement('div');
      row.className = 'target-row';
      row.dataset.skill = ability.id;
      row.innerHTML =
        '<span class="ability-mark" style="--accent:' + ability.accent + '">' + escapeHtml(ability.short) + '</span>' +
        '<span class="ability-label" title="' + escapeHtml(ability.label) + '">' + escapeHtml(ability.label) + '</span>' +
        '<span class="stepper">' +
          '<button class="step-btn" type="button" data-delta="-1" aria-label="减少 ' + escapeHtml(ability.label) + ' 的点数">−</button>' +
          '<span class="step-value">0</span>' +
          '<button class="step-btn" type="button" data-delta="1" aria-label="增加 ' + escapeHtml(ability.label) + ' 的点数">+</button>' +
        '</span>';
      fragment.appendChild(row);
    });
    refs.targetList.appendChild(fragment);
  }

  function populateAbilitySelects() {
    const options = '<option value="">选择能力</option>' + E.ABILITIES.map(function (ability) {
      return '<option value="' + ability.id + '">' + escapeHtml(ability.label) + '</option>';
    }).join('');
    refs.abilitySelects.forEach(function (select) {
      select.innerHTML = options;
    });
  }

  function updateTargetUI() {
    const total = E.targetTotal(state.target);

    refs.targetUsed.textContent = String(total);
    $$('.target-row').forEach(function (row) {
      const skillId = row.dataset.skill;
      const value = state.target[skillId];
      const plus = $('[data-delta="1"]', row);
      const minus = $('[data-delta="-1"]', row);
      row.classList.toggle('is-active', value > 0);
      $('.step-value', row).textContent = String(value);
      plus.disabled = value >= E.MAX_PER_ABILITY || total >= E.TOTAL_LINES;
      minus.disabled = value <= 0;
    });

    $$('.scale-tick').forEach(function (tick, index) {
      tick.classList.toggle('is-on', index < total);
    });

    refs.targetState.textContent = total === 0 ? '等待设定' : (total === E.TOTAL_LINES ? '目标已完整' : '目标未满 18 点');
    refs.targetRemain.textContent = total === E.TOTAL_LINES ? '已分配满 18 点' : '还剩 ' + (E.TOTAL_LINES - total) + ' 点';
    refs.targetNote.classList.toggle('is-ready', total === E.TOTAL_LINES);

    if (total === 0) {
      refs.targetNote.textContent = '先为想要的能力加点，系统才知道该往哪个方向找。';
    } else if (total === E.TOTAL_LINES) {
      refs.targetNote.textContent = '18 点已分配完整，可以追求逐项完全一致。';
    } else {
      refs.targetNote.textContent = '已选 ' + total + ' 点，还差 ' + (E.TOTAL_LINES - total) +
        ' 点。目标未满时，多出的能力会优先落在已选择的技能上。';
    }

    refs.computeBtn.classList.toggle('is-disabled', total === 0);
    updateReadiness();
  }

  function updateReadiness() {
    const ready = readySlotCount();
    const invalidCount = state.items.filter(function (item) {
      return !E.hasDistinctAbilities(item);
    }).length;
    refs.readyPill.textContent = ready + ' / 6 部位';
    refs.itemCount.textContent = state.items.length + ' 件装备' +
      (invalidCount ? ' · ' + invalidCount + ' 件已排除' : '');
    refs.computeHint.textContent = '已录入 ' + ready + ' / 6 个有效部位';

    $$('.slot-card').forEach(function (card) {
      const slotId = card.dataset.slot;
      const validCount = state.items.filter(function (item) {
        return item.slot === slotId && E.hasDistinctAbilities(item);
      }).length;
      card.classList.toggle('is-missing', validCount === 0);
    });
  }

  function itemCardMarkup(item) {
    const valid = E.hasDistinctAbilities(item);
    const abilities = item.abilities.map(chipMarkup).join('');
    return '<article class="item-card' + (valid ? '' : ' is-invalid') + '" data-item-id="' + escapeHtml(item.id) + '">' +
      '<div class="item-top">' +
        '<span class="item-name" title="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + '</span>' +
        '<span class="item-actions">' +
          '<button class="icon-btn" type="button" data-action="edit" aria-label="编辑 ' + escapeHtml(item.name) + '">' + icon('edit') + '</button>' +
          '<button class="icon-btn is-danger" type="button" data-action="delete" aria-label="删除 ' + escapeHtml(item.name) + '">' + icon('trash') + '</button>' +
        '</span>' +
      '</div>' +
      (valid ? '' : '<p class="item-invalid">重复词条，不参与计算</p>') +
      '<div class="abilities">' + abilities + '</div>' +
    '</article>';
  }

  function slotCardMarkup(slot) {
    const items = state.items.filter(function (item) { return item.slot === slot.id; });
    const validItems = items.filter(function (item) { return E.hasDistinctAbilities(item); });
    const status = items.length === 0
      ? '尚未录入'
      : (validItems.length === 0
        ? items.length + ' 件 · 重复词条已排除'
        : (validItems.length === items.length
          ? validItems.length + ' 件候选'
          : validItems.length + ' 有效 / ' + items.length + ' 件'));
    const body = items.length
      ? '<div class="item-list">' + items.map(itemCardMarkup).join('') + '</div>'
      : '<div class="slot-empty">还没有' + escapeHtml(slot.label) + '，' +
          '<button type="button" data-action="add">录入第一件</button></div>';

    return '<article class="slot-card' + (validItems.length ? '' : ' is-missing') + '" data-slot="' + slot.id + '">' +
      '<div class="slot-head">' +
        slotIconMarkup(slot) +
        '<div class="slot-title">' +
          '<h3>' + escapeHtml(slot.label) + '</h3>' +
          '<p>' + status + '</p>' +
        '</div>' +
        '<button class="add-btn" type="button" data-action="add">' + icon('plus') + '<span>添加</span></button>' +
      '</div>' +
      body +
    '</article>';
  }

  function renderInventory() {
    refs.slotGrid.innerHTML = E.SLOTS.map(slotCardMarkup).join('');
    updateReadiness();
  }

  function renderAll() {
    renderInventory();
    updateTargetUI();
  }

  function changeTarget(skillId, delta) {
    const current = state.target[skillId];
    const total = E.targetTotal(state.target);
    if (delta > 0 && total >= E.TOTAL_LINES) {
      showToast('18 点已经分配满了，先减少其他能力再继续');
      return;
    }
    const next = Math.max(0, Math.min(E.MAX_PER_ABILITY, current + delta));
    if (next === current) return;
    state.target[skillId] = next;
    hideTargetError();
    persist();
    updateTargetUI();
    markStale();
  }

  function showTargetError(message) {
    refs.targetError.textContent = message;
    refs.targetError.hidden = false;
  }

  function hideTargetError() {
    refs.targetError.hidden = true;
    refs.targetError.textContent = '';
  }

  function showToast(message, options) {
    const opts = options || {};
    if (toastTimer) window.clearTimeout(toastTimer);
    refs.toastMessage.textContent = message;
    toastActionHandler = null;

    if (opts.actionLabel && typeof opts.onAction === 'function') {
      refs.toastAction.hidden = false;
      refs.toastAction.textContent = opts.actionLabel;
      toastActionHandler = opts.onAction;
    } else {
      refs.toastAction.hidden = true;
    }

    refs.toast.classList.add('is-visible');
    toastTimer = window.setTimeout(function () {
      hideToast();
    }, opts.duration || (toastActionHandler ? 6500 : 3400));
  }

  function hideToast() {
    refs.toast.classList.remove('is-visible');
    if (toastTimer) {
      window.clearTimeout(toastTimer);
      toastTimer = null;
    }
    window.setTimeout(function () {
      if (!refs.toast.classList.contains('is-visible')) {
        toastActionHandler = null;
        refs.toastAction.hidden = true;
      }
    }, 200);
  }

  function openItemDialog(slotId, item) {
    const slot = slotById(slotId);
    if (!slot) return;

    editing = {
      slotId: slotId,
      itemId: item ? item.id : null
    };

    refs.dialogKicker.textContent = slot.label + ' · 3 条能力';
    refs.dialogTitle.textContent = item ? '编辑' + slot.label : '添加' + slot.label;
    refs.itemName.value = item ? item.name : '';
    refs.itemName.placeholder = '例如：' + (SLOT_SAMPLES[slotId] || slot.label);
    const abilities = item ? item.abilities : ['', '', ''];
    refs.abilitySelects.forEach(function (select, index) {
      select.value = abilities[index] || '';
    });
    refs.formError.hidden = true;
    updateSelectAvailability();
    updatePreview();
    refs.itemDialog.showModal();
    window.requestAnimationFrame(function () {
      refs.itemName.focus();
    });
  }

  function updateSelectAvailability() {
    const values = refs.abilitySelects.map(function (select) { return select.value; });
    refs.abilitySelects.forEach(function (select, index) {
      const otherValues = values.filter(function (value, valueIndex) {
        return valueIndex !== index && value;
      });
      Array.prototype.forEach.call(select.options, function (option) {
        option.disabled = Boolean(option.value && otherValues.indexOf(option.value) !== -1);
      });
    });
  }

  function updatePreview() {
    const values = refs.abilitySelects.map(function (select) { return select.value; });
    refs.abilityPreview.innerHTML = '';

    const selected = values.filter(Boolean);
    if (selected.length === 0) {
      const placeholder = document.createElement('span');
      placeholder.className = 'preview-placeholder';
      placeholder.textContent = '选择 3 个能力后预览';
      refs.abilityPreview.appendChild(placeholder);
    } else {
      selected.forEach(function (abilityId) {
        const ability = abilityById(abilityId);
        if (!ability) return;
        const chip = document.createElement('span');
        chip.className = 'ability-chip';
        chip.style.setProperty('--accent', ability.accent);
        const dot = document.createElement('i');
        dot.className = 'chip-dot';
        chip.appendChild(dot);
        chip.appendChild(document.createTextNode(ability.label));
        refs.abilityPreview.appendChild(chip);
      });
    }

    const duplicate = new Set(selected).size !== selected.length;
    refs.formHint.textContent = duplicate
      ? '同一件装备不能重复选择同一能力，请更换其中一条。'
      : '一件装备的 3 个能力必须互不相同。';
    refs.formHint.classList.toggle('is-error', duplicate);
    refs.formHint.classList.toggle('is-warning', false);
    refs.dialogSaveBtn.disabled = selected.length !== 3 || duplicate;
  }

  function defaultItemName(slotId) {
    const slot = slotById(slotId);
    const count = state.items.filter(function (item) { return item.slot === slotId; }).length + 1;
    return slot.label + ' ' + count;
  }

  function handleItemSubmit(event) {
    event.preventDefault();
    if (!editing) return;

    const abilities = refs.abilitySelects.map(function (select) { return select.value; });
    if (abilities.some(function (value) { return !value; })) {
      refs.formError.textContent = '请为 3 个能力都做出选择。';
      refs.formError.hidden = false;
      return;
    }
    if (new Set(abilities).size !== 3) {
      refs.formError.textContent = '同一件装备的 3 个能力不能重复。';
      refs.formError.hidden = false;
      return;
    }

    const name = refs.itemName.value.trim() || defaultItemName(editing.slotId);
    if (name.length > 40) {
      refs.formError.textContent = '装备名称不能超过 40 个字符。';
      refs.formError.hidden = false;
      return;
    }

    const wasEditing = Boolean(editing.itemId);
    if (wasEditing) {
      const item = state.items.find(function (entry) { return entry.id === editing.itemId; });
      if (!item) {
        refs.formError.textContent = '这件装备已经不存在了。';
        refs.formError.hidden = false;
        return;
      }
      item.name = name;
      item.abilities = abilities.slice();
    } else {
      state.items.push({
        id: makeId(),
        slot: editing.slotId,
        name: name,
        abilities: abilities.slice()
      });
    }

    refs.itemDialog.close();
    persist();
    renderInventory();
    hideTargetError();
    markStale();
    showToast(wasEditing ? '装备已更新' : '已添加「' + name + '」');
  }

  function deleteItem(item) {
    if (!item) return;
    const index = state.items.findIndex(function (entry) { return entry.id === item.id; });
    if (index < 0) return;
    const removed = state.items.splice(index, 1)[0];
    renderInventory();
    persist();
    hideTargetError();
    markStale();
    showToast('已删除「' + removed.name + '」', {
      actionLabel: '撤销',
      onAction: function () {
        state.items.splice(Math.min(index, state.items.length), 0, removed);
        renderInventory();
        persist();
        hideTargetError();
        markStale();
        showToast('已恢复「' + removed.name + '」');
      },
      duration: 7000
    });
  }

  function hideResults() {
    currentResult = null;
    resultStale = false;
    refs.resultsSection.hidden = true;
    refs.staleNotice.hidden = true;
    refs.resultPanel.classList.remove('is-stale');
  }

  function markStale() {
    if (!currentResult || refs.resultsSection.hidden) return;
    resultStale = true;
    refs.staleNotice.hidden = false;
    refs.resultPanel.classList.add('is-stale');
  }

  function compute(options) {
    const opts = options || {};
    hideTargetError();
    const total = E.targetTotal(state.target);
    if (total === 0) {
      showTargetError('请先设置至少 1 点目标，再计算装备组合。');
      return;
    }

    const missing = E.SLOTS.filter(function (slot) {
      return !state.items.some(function (item) {
        return item.slot === slot.id && E.hasDistinctAbilities(item);
      });
    });

    if (missing.length > 0) {
      const labels = missing.map(function (slot) {
        const hasAny = state.items.some(function (item) { return item.slot === slot.id; });
        return slot.label + (hasAny ? '（重复词条已排除）' : '');
      });
      showTargetError('还缺 ' + labels.join('、') + '，请先录入或修正这些部位的装备。');
      showToast('还有 ' + missing.length + ' 个部位没有有效装备');
      const first = $('.slot-card[data-slot="' + missing[0].id + '"]');
      if (first) {
        first.scrollIntoView({ behavior: 'smooth', block: 'center' });
        window.setTimeout(function () {
          const add = $('[data-action="add"]', first);
          if (add) add.focus({ preventScroll: true });
        }, 420);
      }
      return;
    }

    const result = E.solve(state.items, state.target);
    if (!result.ok) {
      showTargetError(result.message || '没有找到可行的装备组合。');
      return;
    }

    result.targetSnapshot = Object.assign({}, state.target);
    result.gap = E.analyzeGap(result.selection, result.targetSnapshot);
    result.fivePlusOne = result.gap.status === 'met'
      ? { ok: true, cases: [], total: 0, truncated: false }
      : E.findFivePlusOneGaps(state.items, result.targetSnapshot, { maxCases: 80 });
    currentResult = result;
    resultStale = false;
    renderResults(result);
    refs.staleNotice.hidden = true;
    refs.resultPanel.classList.remove('is-stale');
    refs.resultsSection.hidden = false;

    if (opts.scroll !== false) {
      window.requestAnimationFrame(function () {
        refs.resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  function resultNarrative(result, gap) {
    const total = result.targetTotal;
    if (gap.status === 'met') {
      if (result.exact) {
        return {
          title: '完全命中',
          badge: '精确匹配',
          description: '目标 ' + total + ' 点全部命中，18 条能力与目标逐项一致。'
        };
      }
      return {
        title: '目标全部覆盖',
        badge: '最优覆盖',
        description: '目标 ' + total + ' 点已全部命中。目标未满 18 点，因此仍有 ' +
          (E.TOTAL_LINES - total) + ' 条额外能力，系统已优先把它们放在你选择过的技能上。'
      };
    }

    if (gap.status === 'one-away' && gap.missingAbility) {
      const missing = gap.missingAbility.label;
      const recommendation = gap.recommendation;
      return {
        title: '只差 1 条词条',
        badge: '差 1 条词条',
        description: recommendation
          ? '这套组合只差 1 条「' + missing + '」。换一件带「' + missing + '」的「' +
            recommendation.slot.label + '」即可满足目标。'
          : '这套组合只差 1 条「' + missing + '」，补齐后即可满足目标。'
      };
    }

    return {
      title: '最接近的一组',
      badge: '最优近似',
      description: '目标共 ' + total + ' 点，命中 ' + result.matched + ' 点，' +
        (total - result.matched) + ' 点尚未覆盖。已检查全部 ' +
        formatNumber(result.searchSpace) + ' 种组合，没有只差 1 条词条即可满足的方案。'
    };
  }

  function renderGap(gap) {
    if (!gap || gap.status === 'met') {
      refs.gapPanel.hidden = true;
      return;
    }

    refs.gapPanel.hidden = false;
    const oneAway = gap.status === 'one-away';
    refs.gapPanel.classList.toggle('is-one-away', oneAway);
    refs.gapPanel.classList.toggle('is-far', !oneAway);

    if (oneAway) {
      const missing = gap.missingAbility;
      const recommendation = gap.recommendation;
      refs.gapIcon.textContent = '+1';
      refs.gapKicker.textContent = '单条词条缺口';
      refs.gapTitle.textContent = '补 1 条「' + missing.label + '」即可满足';
      refs.gapDesc.textContent = '当前组合只差这 1 条词条。补齐后，目标点数将全部覆盖。';

      if (recommendation) {
        refs.missingCard.hidden = false;
        refs.missingSlot.textContent = recommendation.slot.label;
        refs.missingTitle.textContent = '带「' + missing.label + '」的' + recommendation.slot.label;
        refs.missingAbilities.innerHTML = recommendation.newAbilities.map(chipMarkup).join('');
        refs.missingSub.textContent = '替换建议：将「' + recommendation.item.name + '」的「' +
          recommendation.removeAbility.label + '」换成「' + missing.label + '」';
      } else {
        refs.missingCard.hidden = true;
      }

      const alternatives = gap.candidates.slice(1, 4).map(function (candidate) {
        return candidate.slot.label + '（' + candidate.removeAbility.label + ' → ' + missing.label + '）';
      });
      refs.gapAlt.textContent = alternatives.length
        ? '其他可行位置：' + alternatives.join(' · ')
        : '';
      return;
    }

    refs.gapIcon.textContent = '!';
    refs.gapKicker.textContent = '无法单条补齐';
    refs.gapTitle.textContent = '还差 ' + gap.totalDeficit + ' 条词条';
    refs.gapDesc.textContent = '已检查全部组合，没有只差 1 条词条就能满足的方案。';
    refs.gapAlt.textContent = '缺少：' + gap.deficits.map(function (entry) {
      return entry.ability.label + ' ×' + entry.count;
    }).join(' · ');
    refs.missingCard.hidden = true;
  }

  function fiveCaseMarkup(entry) {
    const missingChips = entry.missingAbilities.map(function (ability) {
      return chipMarkup(ability.id);
    }).join('');
    const itemCards = entry.selectionList.map(function (selection) {
      const item = selection.item;
      const fullAbilities = item.abilities.map(function (abilityId) {
        return abilityById(abilityId).label;
      }).join(' / ');
      const shortAbilities = item.abilities.map(function (abilityId) {
        return abilityById(abilityId).short;
      }).join(' · ');
      return '<div class="five-item" title="' + escapeHtml(item.name + '：' + fullAbilities) + '">' +
        '<span class="five-item-slot">' + escapeHtml(selection.slot.label) + '</span>' +
        '<span class="five-item-name">' + escapeHtml(item.name) + '</span>' +
        '<span class="five-item-abilities">' + escapeHtml(shortAbilities) + '</span>' +
      '</div>';
    }).join('');
    const waysText = entry.ways === 1
      ? '1 种五件组合'
      : formatNumber(entry.ways) + ' 种五件组合';

    return '<article class="five-case">' +
      '<div class="five-case-head">' +
        '<span class="five-slot">缺：' + escapeHtml(entry.missingSlot.label) + '</span>' +
        '<span class="five-ways">' + waysText + '</span>' +
      '</div>' +
      '<div class="five-case-body">' +
        '<div class="five-missing">' +
          '<span class="five-missing-label">需要一件带</span>' +
          '<div class="abilities">' + missingChips + '</div>' +
          '<span class="five-missing-label">的' + escapeHtml(entry.missingSlot.label) + '</span>' +
        '</div>' +
        '<div class="five-combo">' +
          '<span class="five-combo-label">示例五件</span>' +
          '<div class="five-items">' + itemCards + '</div>' +
        '</div>' +
      '</div>' +
    '</article>';
  }

  function paintFiveCases(five, expanded) {
    const visibleCount = expanded ? five.cases.length : Math.min(6, five.cases.length);
    refs.fiveList.innerHTML = five.cases.slice(0, visibleCount).map(fiveCaseMarkup).join('');
    const showToggle = five.cases.length > 6;
    refs.fiveToggleBtn.hidden = !showToggle;
    if (expanded) {
      refs.fiveToggleBtn.textContent = '收起';
    } else if (five.truncated) {
      refs.fiveToggleBtn.textContent = '展开更多（最多 ' + formatNumber(five.cases.length) + ' 种）';
    } else {
      refs.fiveToggleBtn.textContent = '展开全部（' + formatNumber(five.total) + ' 种）';
    }
  }

  function renderFivePlusOne(five) {
    const hasCases = five && five.ok && five.cases && five.cases.length > 0;
    if (!hasCases) {
      refs.fivePanel.hidden = true;
      fiveExpanded = false;
      return;
    }

    refs.fivePanel.hidden = false;
    fiveExpanded = false;
    refs.fiveTitle.textContent = '找到 ' + formatNumber(five.total) + ' 种缺件情况';
    refs.fiveDesc.textContent = '以下每组五件装备都已满足其余目标，只差一件带指定 3 条词条的装备；但剩下的那个部位里没有这种组合。';
    refs.fiveTotal.textContent = formatNumber(five.total) + ' 种';
    refs.fiveNote.textContent = five.truncated
      ? '共 ' + formatNumber(five.total) + ' 种，当前最多展示前 ' + formatNumber(five.cases.length) + ' 种。'
      : '这些缺口都已按“剩余部位没有对应三词条装备”验证。';
    paintFiveCases(five, false);
  }

  function toggleFiveCases() {
    if (!currentResult || !currentResult.fivePlusOne) return;
    fiveExpanded = !fiveExpanded;
    paintFiveCases(currentResult.fivePlusOne, fiveExpanded);
  }

  function renderResults(result) {
    const target = result.targetSnapshot || state.target;
    const total = result.targetTotal;
    const percentage = total > 0 ? Math.round((result.matched / total) * 100) : 0;
    const gap = result.gap || E.analyzeGap(result.selection, target);
    const five = result.fivePlusOne || { ok: true, cases: [], total: 0, truncated: false };
    const narrative = resultNarrative(result, gap);

    refs.scorePct.textContent = percentage + '%';
    refs.scoreRing.style.setProperty('--pct', String(percentage));
    refs.scoreRing.classList.toggle('is-exact', result.exact);
    refs.resultTitle.textContent = narrative.title;
    refs.resultBadge.textContent = narrative.badge;
    refs.resultBadge.classList.toggle('is-exact', result.exact);
    let description = narrative.description;
    if (five.total > 0) {
      description += ' 另列出 ' + formatNumber(five.total) + ' 种五件齐备的缺件情况。';
    }
    refs.resultDesc.textContent = description;
    renderFivePlusOne(five);
    renderGap(gap);

    refs.statMatched.textContent = result.matched + ' / ' + total;
    refs.statDiff.textContent = String(result.diff);
    refs.statSpace.textContent = formatNumber(result.searchSpace);

    refs.resultSelection.innerHTML = result.selectionList.map(function (entry) {
      const slot = entry.slot;
      const item = entry.item;
      return '<article class="result-item">' +
        '<div class="result-item-head">' +
          slotIconMarkup(slot) +
          '<div class="result-item-copy">' +
            '<span>' + escapeHtml(slot.label) + '</span>' +
            '<strong title="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + '</strong>' +
          '</div>' +
        '</div>' +
        '<div class="abilities">' + item.abilities.map(chipMarkup).join('') + '</div>' +
      '</article>';
    }).join('');

    refs.compareBody.innerHTML = E.ABILITIES.map(function (ability) {
      const goal = target[ability.id] || 0;
      const actual = result.counts[ability.id] || 0;
      const idle = goal === 0 && actual === 0;
      const pips = [0, 1, 2].map(function (index) {
        return '<i class="pip' + (index < goal ? ' is-on' : '') + '"></i>';
      }).join('');

      let delta;
      if (idle) {
        delta = '<span class="delta delta-idle">—</span>';
      } else if (actual === goal) {
        delta = '<span class="delta delta-hit">命中</span>';
      } else if (actual > goal) {
        delta = '<span class="delta delta-over">+' + (actual - goal) + '</span>';
      } else {
        delta = '<span class="delta delta-under">−' + (goal - actual) + '</span>';
      }

      return '<tr class="' + (idle ? 'is-idle' : '') + '">' +
        '<td><span class="compare-ability"><i class="compare-dot" style="--accent:' + ability.accent + '"></i>' +
          '<span>' + escapeHtml(ability.label) + '</span></span></td>' +
        '<td><span class="pips" aria-label="目标 ' + goal + ' 点">' + pips + '</span></td>' +
        '<td><span class="actual-count' + (actual === 0 ? ' is-zero' : '') + '">' + actual + '</span></td>' +
        '<td>' + delta + '</td>' +
      '</tr>';
    }).join('');

    refs.resultNote.textContent = '偏差值 = 各项能力 |实际点数 − 目标点数| 的总和。本次共 ' +
      result.totalLines + ' 条能力，其中 ' + result.unwanted + ' 条落在未选择的技能上；' +
      '命中数并列时优先减少这种溢出。';
    refs.resultExact.textContent = result.exact
      ? '逐项完全一致'
      : (gap.status === 'one-away' ? '只差 1 条词条 · 已取最优' : '偏差值 ' + result.diff + ' · 已取最优');
  }

  function buildCopyText(result) {
    const lines = [];
    const target = result.targetSnapshot || state.target;
    const gap = result.gap || E.analyzeGap(result.selection, target);
    lines.push('六装 · 技能配装结果');
    lines.push('命中 ' + result.matched + ' / ' + result.targetTotal + ' 点｜偏差 ' + result.diff);

    if (gap.status === 'one-away' && gap.recommendation) {
      const missing = gap.missingAbility.label;
      lines.push('只差 1 条「' + missing + '」即可满足');
      lines.push('缺少的装备：' + gap.recommendation.slot.label + '，带「' + missing + '」');
      lines.push('替换建议：将「' + gap.recommendation.item.name + '」的「' +
        gap.recommendation.removeAbility.label + '」换成「' + missing + '」');
      lines.push('目标装备词条：' + gap.recommendation.newAbilities.map(function (abilityId) {
        return abilityById(abilityId).label;
      }).join(' / '));
    } else if (gap.status === 'far') {
      lines.push('还差 ' + gap.totalDeficit + ' 条词条，无法只靠单条词条补齐');
      lines.push('缺少：' + gap.deficits.map(function (entry) {
        return entry.ability.label + ' ×' + entry.count;
      }).join(' · '));
    }

    const five = result.fivePlusOne;
    if (five && five.ok && five.cases.length > 0) {
      lines.push('');
      lines.push('五件齐备、缺一件装备（共 ' + five.total + ' 种）：');
      five.cases.slice(0, 5).forEach(function (entry) {
        const missing = entry.missingAbilities.map(function (ability) {
          return ability.label;
        }).join(' + ');
        const combo = entry.selectionList.map(function (selection) {
          return selection.slot.label + ' ' + selection.item.name;
        }).join(' / ');
        lines.push('缺【' + entry.missingSlot.label + '】' + missing + '；五件：' + combo);
      });
      if (five.total > 5) lines.push('……其余 ' + (five.total - 5) + ' 种见网页结果。');
    }

    lines.push('');
    result.selectionList.forEach(function (entry) {
      const abilities = entry.item.abilities.map(function (abilityId) {
        return abilityById(abilityId).label;
      }).join(' / ');
      lines.push(entry.slot.label + '：' + entry.item.name + '（' + abilities + '）');
    });
    lines.push('');
    lines.push('点数对照（实际 / 目标）：');
    E.ABILITIES.forEach(function (ability) {
      const actual = result.counts[ability.id] || 0;
      const goal = target[ability.id] || 0;
      if (actual > 0 || goal > 0) {
        lines.push(ability.label + ' ' + actual + ' / ' + goal);
      }
    });
    return lines.join('\n');
  }

  function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).then(function () {
        return true;
      }).catch(function () {
        return fallbackCopy(text);
      });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (error) {
      ok = false;
    }
    document.body.removeChild(textarea);
    return ok;
  }

  function applySampleState() {
    const target = E.emptyTarget();
    target.crit_damage = 3;
    target.attack = 3;
    target.warrior = 2;
    target.archer = 2;
    target.thief = 2;
    target.mage = 2;
    target.dimensional_leap = 1;
    target.white_hole = 1;
    target.registry = 1;
    target.pirate = 1;

    const make = function (slot, name, abilities) {
      return {
        id: 'sample-' + slot + '-' + name,
        slot: slot,
        name: name,
        abilities: abilities
      };
    };

    const items = [
      make('hat', '赤月之冠', ['crit_damage', 'attack', 'warrior']),
      make('hat', '星轨礼帽', ['mage', 'thief', 'archer']),
      make('hat', '旅人之帽', ['dimensional_leap', 'attack', 'pirate']),
      make('top', '暗影战甲', ['crit_damage', 'attack', 'archer']),
      make('top', '风语长袍', ['mage', 'archer', 'thief']),
      make('top', '白洞外衣', ['white_hole', 'registry', 'attack']),
      make('bottom', '狂徒护腿', ['crit_damage', 'thief', 'mage']),
      make('bottom', '星辉裤装', ['mage', 'thief', 'archer']),
      make('bottom', '拾荒长裤', ['registry', 'pirate', 'dimensional_leap']),
      make('cape', '夜幕披风', ['attack', 'thief', 'mage']),
      make('cape', '苍穹斗篷', ['archer', 'mage', 'white_hole']),
      make('cape', '旅团披风', ['attack', 'pirate', 'registry']),
      make('gloves', '裁决手甲', ['warrior', 'archer', 'dimensional_leap']),
      make('gloves', '灵歌手套', ['mage', 'archer', 'thief']),
      make('gloves', '拓荒手套', ['dimensional_leap', 'white_hole', 'attack']),
      make('shoes', '疾风战靴', ['white_hole', 'registry', 'pirate']),
      make('shoes', '星界便鞋', ['mage', 'archer', 'crit_damage']),
      make('shoes', '远行靴', ['registry', 'pirate', 'white_hole'])
    ];

    state.target = target;
    state.items = items;
  }

  function loadSample(force) {
    if (!force && hasData() && !window.confirm('载入示例会替换当前的目标和装备库。确定继续吗？')) {
      return false;
    }
    applySampleState();
    persist();
    renderAll();
    hideResults();
    hideTargetError();
    showToast('示例已载入，点击「计算最佳组合」查看结果');
    return true;
  }

  function clearAll() {
    if (!hasData()) {
      showToast('当前已经是空白状态');
      return;
    }
    if (!window.confirm('确定清空目标点数与全部装备吗？此操作无法撤销。')) return;
    state.target = E.emptyTarget();
    state.items = [];
    persist();
    renderAll();
    hideResults();
    hideTargetError();
    showToast('已清空目标和装备库');
  }

  function exportData() {
    if (!hasData()) {
      showToast('还没有可导出的数据');
      return;
    }
    const payload = {
      app: 'maple-loadout',
      version: 1,
      exportedAt: new Date().toISOString(),
      target: state.target,
      items: state.items
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const now = new Date();
    const stamp = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') + '-' + String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0');
    link.href = url;
    link.download = 'maple-loadout-' + stamp + '.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast('数据已导出');
  }

  function handleImportFile(file) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      showToast('文件太大了，请选择 2MB 以内的 JSON 文件');
      return;
    }
    const reader = new FileReader();
    reader.onload = function () {
      try {
        const parsed = JSON.parse(String(reader.result));
        const error = E.validateState(parsed);
        if (error) throw new Error(error);
        if (hasData() && !window.confirm('导入会替换当前的目标和装备库。确定继续吗？')) return;

        state.target = Object.assign(E.emptyTarget(), parsed.target);
        state.items = parsed.items.map(function (item) {
          return {
            id: item.id,
            slot: item.slot,
            name: item.name.trim(),
            abilities: item.abilities.slice(0, 3)
          };
        });
        persist();
        renderAll();
        hideResults();
        hideTargetError();
        showToast('已导入 ' + state.items.length + ' 件装备');
      } catch (error) {
        showToast('导入失败：' + error.message);
      }
    };
    reader.onerror = function () {
      showToast('文件读取失败');
    };
    reader.readAsText(file, 'utf-8');
  }

  function bindEvents() {
    refs.fiveToggleBtn.addEventListener('click', toggleFiveCases);

    refs.targetList.addEventListener('click', function (event) {
      const button = event.target.closest('.step-btn');
      if (!button) return;
      const row = button.closest('.target-row');
      if (!row) return;
      changeTarget(row.dataset.skill, Number(button.dataset.delta));
    });

    refs.slotGrid.addEventListener('click', function (event) {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const card = button.closest('.slot-card');
      if (!card) return;
      const slotId = card.dataset.slot;
      const action = button.dataset.action;

      if (action === 'add') {
        openItemDialog(slotId, null);
        return;
      }

      const itemCard = button.closest('.item-card');
      if (!itemCard) return;
      const item = state.items.find(function (entry) { return entry.id === itemCard.dataset.itemId; });
      if (!item) return;
      if (action === 'edit') openItemDialog(slotId, item);
      if (action === 'delete') deleteItem(item);
    });

    refs.computeBtn.addEventListener('click', function () {
      compute({ scroll: true });
    });

    refs.sampleBtn.addEventListener('click', function () {
      loadSample(false);
    });

    refs.clearBtn.addEventListener('click', clearAll);
    refs.exportBtn.addEventListener('click', exportData);

    refs.importBtn.addEventListener('click', function () {
      refs.importInput.click();
    });

    refs.importInput.addEventListener('change', function () {
      const file = refs.importInput.files && refs.importInput.files[0];
      refs.importInput.value = '';
      handleImportFile(file);
    });

    refs.abilitySelects.forEach(function (select) {
      select.addEventListener('change', function () {
        refs.formError.hidden = true;
        updateSelectAvailability();
        updatePreview();
      });
    });

    refs.itemForm.addEventListener('submit', handleItemSubmit);

    refs.dialogCloseBtn.addEventListener('click', function () {
      refs.itemDialog.close();
    });

    refs.dialogCancelBtn.addEventListener('click', function () {
      refs.itemDialog.close();
    });

    refs.itemDialog.addEventListener('click', function (event) {
      if (event.target === refs.itemDialog) {
        refs.itemDialog.close();
      }
    });

    refs.itemDialog.addEventListener('close', function () {
      editing = null;
      refs.formError.hidden = true;
    });

    refs.toastAction.addEventListener('click', function () {
      const handler = toastActionHandler;
      hideToast();
      if (handler) handler();
    });

    refs.copyBtn.addEventListener('click', function () {
      if (!currentResult) return;
      copyText(buildCopyText(currentResult)).then(function (ok) {
        showToast(ok ? '结果已复制到剪贴板' : '复制失败，请手动选择结果文本');
      });
    });

    refs.backToTargetBtn.addEventListener('click', function () {
      refs.targetPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    refs.recomputeBtn.addEventListener('click', function () {
      compute({ scroll: false });
    });
  }

  function init() {
    refs.targetPanel = $('.target-panel');
    refs.targetScale = $('#targetScale');
    refs.targetList = $('#targetList');
    refs.targetUsed = $('#targetUsed');
    refs.targetState = $('#targetState');
    refs.targetRemain = $('#targetRemain');
    refs.targetNote = $('#targetNote');
    refs.targetError = $('#targetError');
    refs.computeBtn = $('#computeBtn');
    refs.computeHint = $('#computeHint');
    refs.slotGrid = $('#slotGrid');
    refs.itemCount = $('#itemCount');
    refs.readyPill = $('#readyPill');
    refs.resultsSection = $('#resultsSection');
    refs.resultPanel = $('#resultPanel');
    refs.staleNotice = $('#staleNotice');
    refs.recomputeBtn = $('#recomputeBtn');
    refs.scoreRing = $('#scoreRing');
    refs.scorePct = $('#scorePct');
    refs.resultTitle = $('#resultTitle');
    refs.resultBadge = $('#resultBadge');
    refs.resultDesc = $('#resultDesc');
    refs.statMatched = $('#statMatched');
    refs.statDiff = $('#statDiff');
    refs.statSpace = $('#statSpace');
    refs.resultSelection = $('#resultSelection');
    refs.compareBody = $('#compareBody');
    refs.resultNote = $('#resultNote');
    refs.resultExact = $('#resultExact');
    refs.gapPanel = $('#gapPanel');
    refs.gapIcon = $('#gapIcon');
    refs.gapKicker = $('#gapKicker');
    refs.gapTitle = $('#gapTitle');
    refs.gapDesc = $('#gapDesc');
    refs.gapAlt = $('#gapAlt');
    refs.missingCard = $('#missingCard');
    refs.missingSlot = $('#missingSlot');
    refs.missingTitle = $('#missingTitle');
    refs.missingAbilities = $('#missingAbilities');
    refs.missingSub = $('#missingSub');
    refs.fivePanel = $('#fivePanel');
    refs.fiveTitle = $('#fiveTitle');
    refs.fiveDesc = $('#fiveDesc');
    refs.fiveTotal = $('#fiveTotal');
    refs.fiveList = $('#fiveList');
    refs.fiveNote = $('#fiveNote');
    refs.fiveToggleBtn = $('#fiveToggleBtn');
    refs.copyBtn = $('#copyBtn');
    refs.backToTargetBtn = $('#backToTargetBtn');
    refs.sampleBtn = $('#sampleBtn');
    refs.importBtn = $('#importBtn');
    refs.exportBtn = $('#exportBtn');
    refs.clearBtn = $('#clearBtn');
    refs.importInput = $('#importInput');
    refs.itemDialog = $('#itemDialog');
    refs.itemForm = $('#itemForm');
    refs.dialogKicker = $('#dialogKicker');
    refs.dialogTitle = $('#dialogTitle');
    refs.itemName = $('#itemName');
    refs.abilitySelects = $$('.ability-select');
    refs.abilityPreview = $('#abilityPreview');
    refs.formHint = $('#formHint');
    refs.formError = $('#formError');
    refs.dialogSaveBtn = $('#dialogSaveBtn');
    refs.dialogCloseBtn = $('#dialogCloseBtn');
    refs.dialogCancelBtn = $('#dialogCancelBtn');
    refs.toast = $('#toast');
    refs.toastMessage = $('#toastMessage');
    refs.toastAction = $('#toastAction');
    refs.saveStatus = $('#saveStatus');

    buildTargetScale();
    buildTargetRows();
    populateAbilitySelects();
    bindEvents();
    loadState();

    if (PARAM_DEMO) {
      applySampleState();
      persist();
      renderAll();
      compute({ scroll: false });
    } else {
      renderAll();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
