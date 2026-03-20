// ── Numeric slider helpers ──────────────────────────────────
function isPow2Int(v) {
  return Number.isInteger(v) && v > 0 && (v & (v - 1)) === 0;
}

function isSliderField(origVal) {
  return typeof origVal === 'number';
}

function fmtTickLabel(v, mode) {
  if (mode === 'pow2') return v === 0 ? '1' : '2^' + v;
  if (mode === 'int') return Math.round(v).toString();
  if (!isFinite(v)) return '?';
  const abs = Math.abs(v);
  if (abs >= 10000) return (v / 1000).toFixed(0) + 'k';
  if (abs >= 100 || Number.isInteger(v)) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(1);
  return parseFloat(v.toPrecision(2)).toString();
}

function buildTickRuler(minVal, maxVal, mode) {
  const W = 100;
  let lines = '';
  if (mode === 'pow2') {
    const range = maxVal - minVal;
    for (let n = Math.ceil(minVal); n <= Math.floor(maxVal); n++) {
      const x = parseFloat(((n - minVal) / range * W).toFixed(2));
      lines += `<line x1="${x}" y1="0" x2="${x}" y2="4" stroke="currentColor" stroke-width="0.3"/>`;
    }
  } else {
    const nMajor = 10, nMinor = 4, total = nMajor * nMinor;
    for (let i = 0; i <= total; i++) {
      const x = parseFloat(((i / total) * W).toFixed(2));
      const big = i % nMinor === 0;
      lines += `<line x1="${x}" y1="0" x2="${x}" y2="${big ? 4 : 2}" stroke="currentColor" stroke-width="0.3"/>`;
    }
  }
  return `<div class="slider-ruler">` +
    `<svg class="tick-svg" viewBox="0 0 ${W} 5" preserveAspectRatio="none">${lines}</svg>` +
    `<div class="tick-labels">` +
    `<span>${fmtTickLabel(minVal, mode)}</span>` +
    `<span>${fmtTickLabel(maxVal, mode)}</span>` +
    `</div></div>`;
}

function buildLogTickRuler(logMin, logMax) {
  const realMin = Math.exp(logMin);
  const realMax = Math.exp(logMax);
  const logRange = logMax - logMin;
  const W = 100;
  const minExp = Math.floor(Math.log10(realMin));
  const maxExp = Math.ceil(Math.log10(realMax));
  let lines = '';
  for (let e = minExp; e <= maxExp; e++) {
    for (const [m, big] of [[1,true],[2,false],[3,false],[4,false],[5,false],[6,false],[7,false],[8,false],[9,false]]) {
      const v = m * Math.pow(10, e);
      if (v < realMin * 0.999 || v > realMax * 1.001) continue;
      const x = parseFloat(((Math.log(v) - logMin) / logRange * W).toFixed(2));
      lines += `<line x1="${x}" y1="0" x2="${x}" y2="${big ? 4 : 2}" stroke="currentColor" stroke-width="0.3"/>`;
    }
  }
  return `<div class="slider-ruler">` +
    `<svg class="tick-svg" viewBox="0 0 ${W} 5" preserveAspectRatio="none">${lines}</svg>` +
    `<div class="tick-labels">` +
    `<span>${fmtTickLabel(realMin, 'float')}</span>` +
    `<span>${fmtTickLabel(realMax, 'float')}</span>` +
    `</div></div>`;
}

function niceIntStep(range) {
  if (range <= 0) return 1;
  const raw = range / 8;
  const candidates = [1, 2, 4, 5, 8, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  for (const c of candidates) if (c >= raw) return c;
  return candidates[candidates.length - 1];
}

function buildIntTickRuler(min, max) {
  const range = max - min;
  const step = niceIntStep(range);
  const ticks = [];
  const first = Math.ceil(min / step) * step;
  for (let v = first; v <= max; v += step) ticks.push(v);
  if (!ticks.length || ticks[0] > min) ticks.unshift(min);
  if (ticks[ticks.length - 1] < max) ticks.push(max);
  const W = 100;
  let lines = '';
  for (const v of ticks) {
    const x = parseFloat(((v - min) / range * W).toFixed(2));
    lines += `<line x1="${x}" y1="0" x2="${x}" y2="4" stroke="currentColor" stroke-width="0.3"/>`;
  }
  return {
    step,
    html: `<div class="slider-ruler">` +
      `<svg class="tick-svg" viewBox="0 0 ${W} 5" preserveAspectRatio="none">${lines}</svg>` +
      `<div class="tick-labels"><span>${fmtTickLabel(min, 'int')}</span><span>${fmtTickLabel(max, 'int')}</span></div>` +
      `</div>`
  };
}

// ── Editor slider builder ──────────────────────────────────
function buildSliderHtml(fid, currentVal, origVal) {
  // Check generic fieldOverrides from hooks (agent-created tools)
  const entry = state.fieldMap[fid];
  if (entry && state.hooks && state.hooks.fieldOverrides) {
    const key = entry.file + ':' + JSON.stringify(entry.path);
    const ovr = state.hooks.fieldOverrides[key];
    if (ovr && ovr.min !== undefined && ovr.max !== undefined) {
      const oMin = ovr.min, oMax = ovr.max;
      if (ovr.logScale && oMin > 0 && oMax > 0) {
        // Log-scale slider: slider position is log10(value)
        const logMin = Math.log10(oMin), logMax = Math.log10(oMax);
        const logStep = (logMax - logMin) / 200;
        const curVal = typeof currentVal === 'number' && currentVal > 0 ? currentVal : origVal;
        const logCur = Math.max(logMin, Math.min(logMax, Math.log10(Math.max(curVal, oMin))));
        return `<div class="num-slider-wrap">
          <div class="slider-col">
            <input type="range" class="num-slider" data-action="num-slider"
              data-fid="${fid}" data-mode="log10" data-orig="${origVal}"
              min="${logMin}" max="${logMax}" step="${logStep}" value="${logCur}">
            ${buildTickRuler(oMin, oMax, 'float')}
          </div>
        </div>`;
      }
      const step = ovr.step || (oMax - oMin) / 200;
      const cur = Math.max(oMin, Math.min(oMax, typeof currentVal === 'number' ? currentVal : origVal));
      return `<div class="num-slider-wrap">
        <div class="slider-col">
          <input type="range" class="num-slider" data-action="num-slider"
            data-fid="${fid}" data-mode="linear" data-orig="${origVal}"
            min="${oMin}" max="${oMax}" step="${step}" value="${cur}">
          ${buildTickRuler(oMin, oMax, 'float')}
        </div>
      </div>`;
    }
  }
  if (Number.isInteger(origVal)) {
    const v = origVal;
    const startPow2 = isPow2Int(v);
    let sliderMin, sliderMax, sliderStep, sliderVal, sliderMode, tickHtml;
    if (startPow2) {
      const n = Math.round(Math.log2(v));
      sliderMin = Math.max(0, n - 5);
      sliderMax = n + 5;
      sliderStep = 1;
      sliderMode = 'pow2';
      sliderVal = (typeof currentVal === 'number' && currentVal > 0)
        ? Math.max(sliderMin, Math.min(sliderMax, Math.round(Math.log2(currentVal)))) : n;
      tickHtml = buildTickRuler(sliderMin, sliderMax, 'pow2');
    } else {
      const span = Math.abs(v) || 10;
      sliderMin = v >= 0 ? 0 : v - span;
      sliderMax = v + span;
      const intTicks = buildIntTickRuler(sliderMin, sliderMax);
      sliderStep = intTicks.step;
      sliderMode = 'int';
      sliderVal = Math.max(sliderMin, Math.min(sliderMax, typeof currentVal === 'number'
        ? Math.round(currentVal / sliderStep) * sliderStep : v));
      tickHtml = intTicks.html;
    }
    const log2Toggle = v >= 0
      ? `<label class="log-toggle-wrap" title="Log\u2082 scale">
          <input type="checkbox" data-action="toggle-log2-cb" data-fid="${fid}"${startPow2 ? ' checked' : ''}>
          <span class="log-track"></span>
          <span class="log-label">log\u2082</span>
        </label>`
      : '';
    return `<div class="num-slider-wrap">
      <div class="slider-col">
        <input type="range" class="num-slider" data-action="num-slider"
          data-fid="${fid}" data-mode="${sliderMode}" data-orig="${v}"
          min="${sliderMin}" max="${sliderMax}" step="${sliderStep}" value="${sliderVal}">
        ${tickHtml}
      </div>
      ${log2Toggle}
    </div>`;
  }
  // float — linear by default, log toggle if positive
  const v = origVal;
  const span = Math.abs(v) || 1;
  const min = v - span;
  const max = v + span;
  const step = (2 * span) / 100;
  const cur = Math.max(min, Math.min(max, typeof currentVal === 'number' ? currentVal : v));
  const logToggle = v > 0
    ? `<label class="log-toggle-wrap" title="Log scale">
        <input type="checkbox" data-action="toggle-log-cb" data-fid="${fid}">
        <span class="log-track"></span>
        <span class="log-label">log</span>
      </label>`
    : '';
  return `<div class="num-slider-wrap">
    <div class="slider-col">
      <input type="range" class="num-slider" data-action="num-slider"
        data-fid="${fid}" data-mode="linear" data-orig="${v}"
        min="${min}" max="${max}" step="${step}" value="${cur}">
      ${buildTickRuler(min, max, 'float')}
    </div>
    ${logToggle}
  </div>`;
}

// ── Pin slider builder ─────────────────────────────────────
function buildPinSliderHtml(fData, pData, currentVal, origVal) {
  if (Number.isInteger(origVal)) {
    const v = origVal;
    const startPow2 = isPow2Int(v);
    let sliderMin, sliderMax, sliderStep, sliderVal, sliderMode, tickHtml;
    if (startPow2) {
      const n = Math.round(Math.log2(v));
      sliderMin = Math.max(0, n - 5); sliderMax = n + 5; sliderStep = 1; sliderMode = 'pow2';
      sliderVal = (typeof currentVal === 'number' && currentVal > 0)
        ? Math.max(sliderMin, Math.min(sliderMax, Math.round(Math.log2(currentVal)))) : n;
      tickHtml = buildTickRuler(sliderMin, sliderMax, 'pow2');
    } else {
      const span = Math.abs(v) || 10;
      sliderMin = v >= 0 ? 0 : v - span; sliderMax = v + span;
      const intTicks = buildIntTickRuler(sliderMin, sliderMax);
      sliderStep = intTicks.step; sliderMode = 'int';
      sliderVal = Math.max(sliderMin, Math.min(sliderMax, typeof currentVal === 'number'
        ? Math.round(currentVal / sliderStep) * sliderStep : v));
      tickHtml = intTicks.html;
    }
    const log2Toggle = v >= 0
      ? `<label class="log-toggle-wrap" title="Log\u2082 scale">` +
          `<input type="checkbox" data-pa="pin-log2-cb" data-pf="${fData}" data-pp="${pData}"${startPow2 ? ' checked' : ''}>` +
          `<span class="log-track"></span><span class="log-label">log\u2082</span>` +
        `</label>`
      : '';
    return `<div class="num-slider-wrap">` +
      `<div class="pin-slider-col">` +
        `<input type="range" class="num-slider" data-pa="pin-slider"` +
          ` data-pf="${fData}" data-pp="${pData}" data-mode="${sliderMode}" data-orig="${v}"` +
          ` min="${sliderMin}" max="${sliderMax}" step="${sliderStep}" value="${sliderVal}">` +
        tickHtml +
      `</div>` +
      log2Toggle +
    `</div>`;
  }
  const v = origVal;
  const span = Math.abs(v) || 1;
  const min = v - span, max = v + span;
  const step = (2 * span) / 100;
  const val = Math.max(min, Math.min(max, currentVal));
  const logToggle = v > 0
    ? `<label class="log-toggle-wrap" title="Log scale">` +
        `<input type="checkbox" data-pa="pin-log-cb" data-pf="${fData}" data-pp="${pData}">` +
        `<span class="log-track"></span><span class="log-label">log</span>` +
      `</label>`
    : '';
  return `<div class="num-slider-wrap">` +
    `<div class="pin-slider-col">` +
      `<input type="range" class="num-slider" data-pa="pin-slider"` +
        ` data-pf="${fData}" data-pp="${pData}" data-mode="linear" data-orig="${v}"` +
        ` min="${min}" max="${max}" step="${step}" value="${val}">` +
      buildTickRuler(min, max, 'float') +
    `</div>` +
    logToggle +
  `</div>`;
}

// ── Slider interaction helpers ──────────────────────────────
function syncSlider(fid, numVal) {
  const slider = document.querySelector(`.num-slider[data-fid="${fid}"]`);
  if (!slider || typeof numVal !== 'number' || isNaN(numVal)) return;
  const mode = slider.dataset.mode;
  const min = parseFloat(slider.min), max = parseFloat(slider.max);
  let sv;
  if (mode === 'pow2')        sv = numVal > 0 ? Math.round(Math.log2(numVal)) : min;
  else if (mode === 'log')    sv = numVal > 0 ? Math.log(numVal) : min;
  else if (mode === 'log10')  sv = numVal > 0 ? Math.log10(numVal) : min;
  else if (mode === 'int')    sv = Math.round(numVal);
  else                        sv = numVal;
  slider.value = Math.max(min, Math.min(max, sv));
}

function onSliderInput(slider) {
  const { fid, mode } = slider.dataset;
  const sv = parseFloat(slider.value);
  let val;
  if (mode === 'pow2')        val = Math.pow(2, Math.round(sv));
  else if (mode === 'log')    val = parseFloat(Math.exp(sv).toPrecision(4));
  else if (mode === 'log10')  val = parseFloat(Math.pow(10, sv).toPrecision(4));
  else if (mode === 'int')    val = Math.round(sv);
  else                        val = parseFloat(sv.toPrecision(6));
  const input = document.getElementById(fid);
  if (input) input.value = String(val);
  const { path, file } = state.fieldMap[fid];
  setNestedValue(state.configs[file].current, path, val);
  state.configs[file].dirty = true;
  refreshFieldState(fid);
  updateButtons();
  renderTabs();
}

function replaceRuler(sliderCol, newHtml) {
  const tmp = document.createElement('div');
  tmp.innerHTML = newHtml;
  const oldRuler = sliderCol.querySelector('.slider-ruler');
  if (oldRuler) oldRuler.replaceWith(tmp.firstElementChild);
  else sliderCol.appendChild(tmp.firstElementChild);
}

function toggleLogScale(cb) {
  const { fid } = cb.dataset;
  const sliderCol = cb.closest('.num-slider-wrap').querySelector('.slider-col');
  const slider = sliderCol.querySelector('.num-slider');
  const origVal = parseFloat(slider.dataset.orig);
  const textInput = document.getElementById(fid);
  const curVal = textInput ? parseFloat(textInput.value) : origVal;
  if (cb.checked) {
    slider.dataset.mode = 'log';
    const logMin = Math.log(origVal / 10);
    const logMax = Math.log(origVal * 10);
    slider.min = logMin; slider.max = logMax;
    slider.step = (logMax - logMin) / 100;
    slider.value = curVal > 0 ? Math.log(curVal) : logMin;
    replaceRuler(sliderCol, buildLogTickRuler(logMin, logMax));
  } else {
    slider.dataset.mode = 'linear';
    const span = Math.abs(origVal) || 1;
    const linMin = origVal - span, linMax = origVal + span;
    slider.min = linMin; slider.max = linMax;
    slider.step = (2 * span) / 100;
    slider.value = Math.max(linMin, Math.min(linMax, curVal));
    replaceRuler(sliderCol, buildTickRuler(linMin, linMax, 'float'));
  }
}

function toggleLog2Scale(cb) {
  const { fid } = cb.dataset;
  const sliderCol = cb.closest('.num-slider-wrap').querySelector('.slider-col');
  const slider = sliderCol.querySelector('.num-slider');
  const origVal = parseInt(slider.dataset.orig);
  const textInput = document.getElementById(fid);
  const curVal = textInput ? Number(textInput.value) : origVal;
  if (cb.checked) {
    const refN = curVal > 0 ? Math.round(Math.log2(curVal))
               : origVal > 0 ? Math.round(Math.log2(origVal)) : 3;
    const minN = Math.max(0, refN - 5);
    const maxN = refN + 5;
    const curN = curVal > 0 ? Math.max(minN, Math.min(maxN, Math.round(Math.log2(curVal)))) : minN;
    slider.dataset.mode = 'pow2';
    slider.min = minN; slider.max = maxN; slider.step = 1; slider.value = curN;
    replaceRuler(sliderCol, buildTickRuler(minN, maxN, 'pow2'));
  } else {
    slider.dataset.mode = 'int';
    const span = Math.abs(origVal) || 10;
    const min = origVal >= 0 ? 0 : origVal - span;
    const max = origVal + span;
    const intTicks = buildIntTickRuler(min, max);
    slider.min = min; slider.max = max; slider.step = intTicks.step;
    slider.value = Math.max(min, Math.min(max, Math.round(curVal / intTicks.step) * intTicks.step));
    replaceRuler(sliderCol, intTicks.html);
  }
}
