document.addEventListener('DOMContentLoaded', async function () {
  const form = document.getElementById('hours-form');
  const submitBtn = document.getElementById('submit-btn');
  const submitText = document.getElementById('submit-text');
  const submitIcon = document.getElementById('submit-icon');
  const loadingOverlay = document.getElementById('loading-overlay');
  const alertContainer = document.getElementById('alert-container');
  const startDateInput = document.getElementById('startDate');
  const endDateInput = document.getElementById('endDate');
  const dryRunCheckbox = document.getElementById('dryRun');

  // --- Global simulation toggle ---

  const simulationToggleBtn = document.getElementById('simulation-toggle-btn');
  if (simulationToggleBtn && dryRunCheckbox) {
    function syncToggleUI() {
      const active = dryRunCheckbox.checked;
      simulationToggleBtn.classList.toggle('toggle-switch--active', active);
      simulationToggleBtn.setAttribute('aria-pressed', String(active));
      if (submitText) submitText.textContent = active ? 'Simular' : 'Registrar';
      if (submitIcon) {
        submitIcon.className = active ? 'fas fa-eye' : 'fas fa-paper-plane';
      }
    }

    simulationToggleBtn.addEventListener('click', function () {
      dryRunCheckbox.checked = !dryRunCheckbox.checked;
      syncToggleUI();
    });

    syncToggleUI();
  }

  // --- Alert helpers ---

  function showAlert(message, type = 'info') {
    const iconMap = { success: 'check-circle', error: 'exclamation-circle', warning: 'exclamation-triangle' };
    const icon = iconMap[type] || 'info-circle';
    const el = document.createElement('div');
    el.className = `alert alert-${type}`;
    el.innerHTML = `<i class="fas fa-${icon}"></i><div>${message}</div>`;
    alertContainer.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.remove(); }, 5000);
  }

  function clearAlerts() {
    alertContainer.innerHTML = '';
  }

  // --- Form validation ---

  function validateForm() {
    clearAlerts();
    let isValid = true;

    if (!startDateInput.value) {
      showAlert('La fecha de inicio es obligatoria', 'error');
      isValid = false;
    }
    if (!endDateInput.value) {
      showAlert('La fecha de fin es obligatoria', 'error');
      isValid = false;
    }
    if (startDateInput.value && endDateInput.value && startDateInput.value > endDateInput.value) {
      showAlert('La fecha de inicio no puede ser posterior a la fecha de fin', 'error');
      isValid = false;
    }
    return isValid;
  }

  function validateDateRange() {
    const start = new Date(startDateInput.value);
    const end = new Date(endDateInput.value);
    const today = new Date();

    if (start > end) {
      endDateInput.setCustomValidity('La fecha de fin debe ser posterior a la fecha de inicio');
    } else if (end > today) {
      endDateInput.setCustomValidity('La fecha de fin no puede ser futura');
    } else {
      endDateInput.setCustomValidity('');
    }
  }

  startDateInput.addEventListener('change', validateDateRange);
  endDateInput.addEventListener('change', validateDateRange);

  // Mark form invalid only after first submit attempt
  form.addEventListener('submit', function () {
    if (!validateForm()) form.classList.add('validated');
  }, { capture: true });

  // Show loading on valid submit
  form.addEventListener('submit', function (e) {
    if (!validateForm()) {
      e.preventDefault();
      return;
    }
    submitBtn.disabled = true;
    submitBtn.classList.add('btn-loading');
    submitText.textContent = 'Procesando...';
    loadingOverlay.style.display = 'flex';

    setTimeout(() => {
      if (submitBtn.disabled) {
        showAlert('La solicitud está tardando más de lo esperado. Por favor, espera...', 'warning');
      }
    }, 10000);
  });

  // Auto-hide loading on back-navigation
  window.addEventListener('load', function () {
    loadingOverlay.style.display = 'none';
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.classList.remove('btn-loading');
      submitText.textContent = 'Enviar Registro';
    }
  });

  // --- Single-day click-to-register + undo registered days ---

  const calendarContainer = document.querySelector('.calendar-container');
  const undoTooltip       = document.getElementById('undo-tooltip');
  const undoConfirmBtn    = document.getElementById('undo-confirm-btn');
  const undoCancelBtn     = document.getElementById('undo-cancel-btn');
  let   undoTargetDay     = null;

  const undoMessageInput = document.getElementById('undo-message-input');

  function hideUndoTooltip() {
    if (undoTooltip) undoTooltip.hidden = true;
    if (undoMessageInput) undoMessageInput.value = '';
    undoTargetDay = null;
  }

  const undoHoursEl = document.getElementById('undo-tooltip__hours');

  function positionUndoTooltip(dayEl) {
    const rect = dayEl.getBoundingClientRect();
    const tooltipW = 190;
    let left = rect.left + rect.width / 2 - tooltipW / 2;
    let top  = rect.bottom + 6;
    left = Math.max(8, Math.min(left, window.innerWidth - tooltipW - 8));
    undoTooltip.style.left = `${left}px`;
    undoTooltip.style.top  = `${top}px`;
  }

  async function showUndoTooltip(dayEl) {
    if (!undoTooltip) return;
    undoTargetDay = dayEl;

    // Show skeleton immediately so tooltip has stable size before data arrives
    if (undoHoursEl) {
      undoHoursEl.innerHTML =
        `<div class="undo-tooltip__hours-row undo-tooltip__hours-row--skeleton"><span></span></div>` +
        `<div class="undo-tooltip__hours-row undo-tooltip__hours-row--skeleton"><span></span></div>`;
      undoHoursEl.hidden = false;
    }

    // Position after skeleton is visible (stable size)
    positionUndoTooltip(dayEl);
    undoTooltip.hidden = false;
    undoConfirmBtn.focus();

    // Fetch and replace skeleton with real hours
    const date = dayEl.dataset.date;
    if (date && undoHoursEl) {
      try {
        const res = await fetch(`/day-detail?date=${encodeURIComponent(date)}`);
        const json = await res.json().catch(() => ({}));
        if (json.success && json.workStart) {
          const lunchRow = json.lunchStart
            ? `<div class="undo-tooltip__hours-row"><i class="fas fa-utensils"></i>${json.lunchStart} – ${json.lunchEnd}</div>`
            : '';
          undoHoursEl.innerHTML =
            `<div class="undo-tooltip__hours-row"><i class="fas fa-sign-in-alt"></i>${json.workStart}</div>` +
            `<div class="undo-tooltip__hours-row"><i class="fas fa-sign-out-alt"></i>${json.workEnd}</div>` +
            lunchRow;
        } else {
          undoHoursEl.hidden = true;
        }
      } catch {
        undoHoursEl.hidden = true;
      }
    }
  }

  if (undoCancelBtn) undoCancelBtn.addEventListener('click', hideUndoTooltip);

  // Close tooltip when clicking outside
  document.addEventListener('click', function (e) {
    if (undoTooltip && !undoTooltip.hidden &&
        !undoTooltip.contains(e.target) &&
        !e.target.closest('.calendar-day.registered')) {
      hideUndoTooltip();
    }
  });

  if (undoConfirmBtn) {
    undoConfirmBtn.addEventListener('click', async function () {
      if (!undoTargetDay) return;
      const dayEl  = undoTargetDay;
      const date   = dayEl.dataset.date;
      const message = (undoMessageInput?.value.trim()) || 'Registro equivocado';
      hideUndoTooltip();

      undoConfirmBtn.disabled = true;
      clearAlerts();

      try {
        const body = new URLSearchParams();
        body.set('date', date);
        body.set('message', message);

        const response = await fetch('/disable-day', {
          method : 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body   : body.toString(),
        });

        const json = await response.json().catch(() => ({}));

        if (json.success) {
          dayEl.classList.replace('registered', 'pending');
          dayEl.dataset.status = 'pending';
          showAlert(`Registro del ${date} eliminado correctamente`, 'success');
        } else {
          showAlert(json.error ?? 'No se pudo eliminar el registro', 'error');
        }
      } catch {
        showAlert('Error al eliminar el registro', 'error');
      } finally {
        undoConfirmBtn.disabled = false;
      }
    });
  }

  if (calendarContainer) {
    calendarContainer.addEventListener('click', async function (event) {
      const dayEl = event.target.closest('.calendar-day');
      if (!dayEl) return;

      const status = dayEl.dataset.status;
      const date   = dayEl.dataset.date;
      if (!date) return;

      // Registered day → show undo tooltip
      if (status === 'registered') {
        showUndoTooltip(dayEl);
        return;
      }

      // Pending day → show confirm tooltip
      if (status !== 'pending') return;
      showConfirmTooltip(dayEl);
    });
  }

  // --- Confirm register tooltip ---

  const confirmTooltip     = document.getElementById('confirm-tooltip');
  const confirmRegisterBtn = document.getElementById('confirm-register-btn');
  const confirmCancelBtn   = document.getElementById('confirm-cancel-btn');
  const confirmWorkStart   = document.getElementById('confirm-work-start');
  const confirmWorkEnd     = document.getElementById('confirm-work-end');
  const confirmLunchStart  = document.getElementById('confirm-lunch-start');
  const confirmLunchEnd    = document.getElementById('confirm-lunch-end');
  const confirmLunchRow    = document.getElementById('confirm-lunch-row');
  const confirmLunchLabel  = document.getElementById('confirm-lunch-label');
  const confirmDateLabel   = document.getElementById('confirm-date-label');
  let   confirmTargetDay   = null;

  function hideConfirmTooltip() {
    if (confirmTooltip) confirmTooltip.hidden = true;
    confirmTargetDay = null;
  }

  function positionConfirmTooltip(dayEl) {
    const rect     = dayEl.getBoundingClientRect();
    const tooltipW = 230;
    let left = rect.left + rect.width / 2 - tooltipW / 2;
    let top  = rect.bottom + 6;
    left = Math.max(8, Math.min(left, window.innerWidth - tooltipW - 8));
    confirmTooltip.style.left = `${left}px`;
    confirmTooltip.style.top  = `${top}px`;
  }

  async function showConfirmTooltip(dayEl) {
    if (!confirmTooltip) return;
    confirmTargetDay = dayEl;

    // Reset fields
    confirmWorkStart.value  = '';
    confirmWorkEnd.value    = '';
    confirmLunchStart.value = '';
    confirmLunchEnd.value   = '';
    if (confirmLunchRow)  confirmLunchRow.hidden  = true;
    if (confirmLunchLabel) confirmLunchLabel.hidden = true;

    positionConfirmTooltip(dayEl);
    confirmTooltip.hidden = false;
    confirmRegisterBtn.focus();

    // Show formatted date in title
    const date = dayEl.dataset.date;
    if (confirmDateLabel && date) {
      const [y, m, d] = date.split('-');
      confirmDateLabel.textContent = `${d}/${m}/${y}`;
    }

    // Fetch preview hours and populate fields
    try {
      const res  = await fetch(`/day-preview?date=${encodeURIComponent(date)}`);
      const json = await res.json().catch(() => ({}));
      if (json.success) {
        confirmWorkStart.value = json.workStart || '';
        confirmWorkEnd.value   = json.workEnd   || '';
        if (json.lunchStart) {
          confirmLunchStart.value = json.lunchStart;
          confirmLunchEnd.value   = json.lunchEnd;
          if (confirmLunchRow)   confirmLunchRow.hidden   = false;
          if (confirmLunchLabel) confirmLunchLabel.hidden = false;
        }
        positionConfirmTooltip(dayEl);
      }
    } catch { /* show empty fields on error */ }
  }

  if (confirmCancelBtn) confirmCancelBtn.addEventListener('click', hideConfirmTooltip);

  document.addEventListener('click', function (e) {
    if (confirmTooltip && !confirmTooltip.hidden &&
        !confirmTooltip.contains(e.target) &&
        !e.target.closest('.calendar-day.pending')) {
      hideConfirmTooltip();
    }
  });

  if (confirmRegisterBtn) {
    confirmRegisterBtn.addEventListener('click', async function () {
      if (!confirmTargetDay) return;
      const dayEl    = confirmTargetDay;
      const date     = dayEl.dataset.date;
      const isDryRun = document.getElementById('dryRun').checked;
      hideConfirmTooltip();

      confirmRegisterBtn.disabled = true;
      clearAlerts();

      startDateInput.value = date;
      endDateInput.value   = date;

      try {
        const body = new URLSearchParams();
        body.set('startDate', date);
        body.set('endDate',   date);
        if (isDryRun) body.set('dryRun', 'on');
        if (confirmWorkStart.value) body.set('workStart', confirmWorkStart.value);
        if (confirmWorkEnd.value)   body.set('workEnd',   confirmWorkEnd.value);
        if (confirmLunchStart.value) body.set('lunchStart', confirmLunchStart.value);
        if (confirmLunchEnd.value)   body.set('lunchEnd',   confirmLunchEnd.value);

        const response = await fetch('/submit-day', {
          method : 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body   : body.toString(),
        });

        if (response.status === 200) {
          const data = await response.json().catch(() => ({}));
          if (!isDryRun) {
            dayEl.classList.replace('pending', 'registered');
            dayEl.dataset.status = 'registered';
          } else {
            dayEl.classList.add('simulated');
            dayEl.dataset.status = 'simulated';
          }
          const r = data.results && data.results[0];
          if (r && r.workStart) showScheduleTooltip(dayEl, r);
        }
      } catch {
        showAlert('Error al registrar el día', 'error');
      } finally {
        confirmRegisterBtn.disabled = false;
      }
    });
  }

  // --- Schedule tooltip ---

  const scheduleTooltip = document.getElementById('schedule-tooltip');
  let scheduleTooltipTimer = null;

  function showScheduleTooltip(dayEl, r) {
    if (!scheduleTooltip) return;
    clearTimeout(scheduleTooltipTimer);

    const lunchRow = r.lunchStart
      ? `<div class="schedule-tooltip__row"><i class="fas fa-utensils"></i>${r.lunchStart} – ${r.lunchEnd}</div>`
      : '';
    const badge = r.isShortDay ? 'Intensiva' : 'Partida';

    scheduleTooltip.querySelector('.schedule-tooltip__content').innerHTML =
      `<div class="schedule-tooltip__row"><i class="fas fa-sign-in-alt"></i>${r.workStart}</div>` +
      `<div class="schedule-tooltip__row"><i class="fas fa-sign-out-alt"></i>${r.workEnd}</div>` +
      lunchRow +
      `<div class="schedule-tooltip__badge">${badge}</div>`;

    const tooltipW = 150;
    const rect = dayEl.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tooltipW / 2;
    let top  = rect.bottom + 6;
    left = Math.max(8, Math.min(left, window.innerWidth - tooltipW - 8));

    scheduleTooltip.style.left  = `${left}px`;
    scheduleTooltip.style.top   = `${top}px`;
    scheduleTooltip.hidden      = false;

    scheduleTooltipTimer = setTimeout(() => { scheduleTooltip.hidden = true; }, 4000);
  }

  // --- Fill-pending button ---

  const fillPendingBtn = document.getElementById('fill-pending-btn');
  if (fillPendingBtn) {
    fillPendingBtn.addEventListener('click', function () {
      const firstPending = fillPendingBtn.dataset.firstPending;
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayISO = yesterday.toISOString().split('T')[0];
      if (firstPending) {
        startDateInput.value = firstPending;
        endDateInput.value = yesterdayISO;
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        form.submit();
      }
    });
  }

  // --- Legend filters ---

  const legendItems = Array.from(document.querySelectorAll('.legend .legend-item'));
  const defaultStatuses = ['registered', 'pending', 'holiday', 'vacation', 'vacation-pending', 'leave', 'leave-pending', 'simulated'];
  const stored = (() => { try { return JSON.parse(localStorage.getItem('calendarFilters') || '[]'); } catch { return []; } })();
  const activeStatuses = new Set(Array.isArray(stored) && stored.length ? stored : defaultStatuses);
  // Auto-enable new statuses that didn't exist when filters were saved
  for (const s of defaultStatuses) { if (!stored.includes(s)) activeStatuses.add(s); }

  function applyCalendarFilters() {
    document.querySelectorAll('.calendar-day').forEach(day => {
      // Weekend and empty cells are structural grid elements — never hide them
      // (hiding them with display:none removes them from the CSS grid and breaks alignment)
      if (day.classList.contains('weekend') || day.classList.contains('future') || day.classList.contains('calendar-day--empty')) return;
      const visible = Array.from(activeStatuses).some(s => day.classList.contains(s));
      day.style.visibility = visible ? '' : 'hidden';
    });
  }

  function toggleLegendItem(item) {
    const status = item.getAttribute('data-status');
    const next = item.getAttribute('aria-pressed') !== 'true';
    if (!next && activeStatuses.size === 1 && activeStatuses.has(status)) return;

    item.setAttribute('aria-pressed', String(next));
    if (next) activeStatuses.add(status); else activeStatuses.delete(status);
    try { localStorage.setItem('calendarFilters', JSON.stringify(Array.from(activeStatuses))); } catch {}
    applyCalendarFilters();
  }

  legendItems.forEach(item => {
    const status = item.getAttribute('data-status');
    item.setAttribute('aria-pressed', String(activeStatuses.has(status)));
    item.addEventListener('click', () => toggleLegendItem(item));
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleLegendItem(item); }
    });
  });

  applyCalendarFilters();

  // --- Keyboard navigation for calendar ---

  document.addEventListener('keydown', function (e) {
    const focused = document.activeElement;
    if (!focused.classList.contains('calendar-day')) return;

    const days = Array.from(document.querySelectorAll('.calendar-day'));
    const idx = days.indexOf(focused);
    const moves = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 7, ArrowUp: -7 };

    if (e.key in moves) {
      e.preventDefault();
      const next = idx + moves[e.key];
      if (next >= 0 && next < days.length) days[next].focus();
    }
  });

  // --- 401 redirect helper ---

  function guardedFetch(url, options) {
    return fetch(url, options).then(res => {
      if (res.status === 401) { window.location.href = '/login'; }
      return res;
    });
  }

  // Patch existing fetch calls to use guardedFetch — replace references on calendarContainer
  // and undoConfirmBtn by overriding window.fetch for internal calls.
  // (Simpler: just patch window.fetch for same-origin calls)
  const _origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    if (url && !url.startsWith('http')) {
      return _origFetch(input, init).then(res => {
        if (res.status === 401) { window.location.href = '/login'; }
        return res;
      });
    }
    return _origFetch(input, init);
  };

  // --- Vacation cancel tooltip ---

  const vacationCancelTooltip    = document.getElementById('vacation-cancel-tooltip');
  const vacationCancelConfirmBtn = document.getElementById('vacation-cancel-confirm-btn');
  const vacationCancelDismissBtn = document.getElementById('vacation-cancel-dismiss-btn');
  const vacationCancelDatesEl    = document.getElementById('vacation-cancel-dates');
  let   vacationCancelTarget     = null;

  function hideVacationCancelTooltip() {
    if (vacationCancelTooltip) vacationCancelTooltip.hidden = true;
    vacationCancelTarget = null;
  }

  function positionVacationCancelTooltip(btn) {
    const rect = btn.getBoundingClientRect();
    const w = 210;
    let left = rect.left + rect.width / 2 - w / 2;
    let top  = rect.bottom + 6;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    vacationCancelTooltip.style.left = `${left}px`;
    vacationCancelTooltip.style.top  = `${top}px`;
  }

  document.addEventListener('click', function (e) {
    const btn = e.target.closest('.vacation-cancel-btn');
    if (btn) {
      e.stopPropagation();
      vacationCancelTarget = btn;
      if (vacationCancelDatesEl) {
        const start = btn.dataset.start || '';
        const end   = btn.dataset.end   || '';
        vacationCancelDatesEl.textContent = start === end ? start : `${start} → ${end}`;
      }
      positionVacationCancelTooltip(btn);
      vacationCancelTooltip.hidden = false;
      vacationCancelConfirmBtn.focus();
      return;
    }
    if (vacationCancelTooltip && !vacationCancelTooltip.hidden &&
        !vacationCancelTooltip.contains(e.target)) {
      hideVacationCancelTooltip();
    }
  });

  if (vacationCancelDismissBtn) vacationCancelDismissBtn.addEventListener('click', hideVacationCancelTooltip);

  if (vacationCancelConfirmBtn) {
    vacationCancelConfirmBtn.addEventListener('click', async function () {
      if (!vacationCancelTarget) return;
      const btn        = vacationCancelTarget;
      const vacationId = btn.dataset.vacationId;
      const start      = btn.dataset.start;
      const end        = btn.dataset.end;
      hideVacationCancelTooltip();

      vacationCancelConfirmBtn.disabled = true;
      clearAlerts();

      try {
        const body = new URLSearchParams();
        body.set('vacationId', vacationId);
        body.set('start', start);
        if (end) body.set('end', end);

        const res  = await fetch('/cancel-vacation', {
          method : 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body   : body.toString(),
        });
        const json = await res.json().catch(() => ({}));

        if (json.success) {
          showAlert('Cancelación de vacaciones solicitada correctamente', 'success');
          setTimeout(() => window.location.reload(), 1200);
        } else {
          showAlert(json.error ?? 'No se pudo cancelar la vacación', 'error');
        }
      } catch {
        showAlert('Error al solicitar la cancelación', 'error');
      } finally {
        vacationCancelConfirmBtn.disabled = false;
      }
    });
  }

  // --- Vacation request form ---

  const vacationRequestBtn   = document.getElementById('vacation-request-btn');
  const vacationRequestStart = document.getElementById('vacation-request-start');
  const vacationRequestEnd   = document.getElementById('vacation-request-end');

  if (vacationRequestBtn) {
    vacationRequestBtn.addEventListener('click', async function () {
      const start = vacationRequestStart?.value;
      const end   = vacationRequestEnd?.value || start;
      if (!start) {
        showAlert('Selecciona la fecha de inicio', 'error');
        return;
      }
      if (end && end < start) {
        showAlert('La fecha de fin no puede ser anterior al inicio', 'error');
        return;
      }

      vacationRequestBtn.disabled = true;
      clearAlerts();

      try {
        const body = new URLSearchParams();
        body.set('start', start);
        if (end) body.set('end', end);

        const res  = await fetch('/request-vacation', {
          method : 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body   : body.toString(),
        });
        const json = await res.json().catch(() => ({}));

        if (json.success) {
          showAlert(json.message || 'Vacaciones solicitadas correctamente', 'success');
          setTimeout(() => window.location.reload(), 1500);
        } else {
          showAlert(json.error ?? 'No se pudo solicitar las vacaciones', 'error');
        }
      } catch {
        showAlert('Error al solicitar las vacaciones', 'error');
      } finally {
        vacationRequestBtn.disabled = false;
      }
    });
  }

  // --- Settings modal ---

  const settingsBtn      = document.getElementById('settings-btn');
  const settingsOverlay  = document.getElementById('settings-overlay');
  const settingsCloseBtn = document.getElementById('settings-close-btn');
  const settingsCancelBtn= document.getElementById('settings-cancel-btn');
  const settingsSaveBtn  = document.getElementById('settings-save-btn');
  const settingsResetBtn = document.getElementById('settings-reset-btn');
  const settingsAlert    = document.getElementById('settings-alert');

  function showSettingsAlert(msg, type = 'error') {
    if (!settingsAlert) return;
    settingsAlert.innerHTML = `<div class="alert alert-${type}" style="margin-bottom:1rem;"><i class="fas fa-${type === 'success' ? 'check-circle' : 'exclamation-circle'}"></i><div>${msg}</div></div>`;
    setTimeout(() => { settingsAlert.innerHTML = ''; }, 4000);
  }

  function populateForm(cfg) {
    const s = id => document.getElementById(id);
    s('s-winter-start-hour').value    = cfg.workSchedule.winter.start.hour;
    s('s-winter-start-minute').value  = cfg.workSchedule.winter.start.minute;
    s('s-winter-length-hours').value  = cfg.workSchedule.winter.length.hours;
    s('s-winter-length-minutes').value= cfg.workSchedule.winter.length.minutes;
    s('s-lunch-start-hour').value     = cfg.workSchedule.lunch.start.hour;
    s('s-lunch-start-minute').value   = cfg.workSchedule.lunch.start.minute;
    s('s-lunch-length-hours').value   = cfg.workSchedule.lunch.length.hours;
    s('s-lunch-length-minutes').value = cfg.workSchedule.lunch.length.minutes;
    s('s-summer-start-hour').value    = cfg.workSchedule.summer.start.hour;
    s('s-summer-start-minute').value  = cfg.workSchedule.summer.start.minute;
    s('s-summer-length-hours').value  = cfg.workSchedule.summer.length.hours;
    s('s-summer-length-minutes').value= cfg.workSchedule.summer.length.minutes;
    s('s-summer-start-day').value     = cfg.summerStartDay;
    s('s-summer-start-month').value   = cfg.summerStartMonth;
    s('s-summer-end-day').value       = cfg.summerEndDay;
    s('s-summer-end-month').value     = cfg.summerEndMonth;
  }

  function collectForm() {
    const g = id => parseInt(document.getElementById(id).value, 10);
    return {
      workSchedule: {
        winter: {
          start:  { hour: g('s-winter-start-hour'),  minute: g('s-winter-start-minute') },
          length: { hours: g('s-winter-length-hours'), minutes: g('s-winter-length-minutes') },
        },
        lunch: {
          start:  { hour: g('s-lunch-start-hour'),   minute: g('s-lunch-start-minute') },
          length: { hours: g('s-lunch-length-hours'),  minutes: g('s-lunch-length-minutes') },
        },
        summer: {
          start:  { hour: g('s-summer-start-hour'),  minute: g('s-summer-start-minute') },
          length: { hours: g('s-summer-length-hours'), minutes: g('s-summer-length-minutes') },
        },
      },
      summerStartDay:   g('s-summer-start-day'),
      summerStartMonth: g('s-summer-start-month'),
      summerEndDay:     g('s-summer-end-day'),
      summerEndMonth:   g('s-summer-end-month'),
    };
  }

  async function openSettings() {
    if (!settingsOverlay) return;
    settingsOverlay.hidden = false;
    try {
      const res = await fetch('/api/schedule-config');
      const json = await res.json();
      if (json.success) populateForm(json.config);
    } catch {
      showSettingsAlert('No se pudo cargar la configuración');
    }
  }

  function closeSettings() {
    if (settingsOverlay) settingsOverlay.hidden = true;
    if (settingsAlert) settingsAlert.innerHTML = '';
  }

  if (settingsBtn)       settingsBtn.addEventListener('click', openSettings);
  if (settingsCloseBtn)  settingsCloseBtn.addEventListener('click', closeSettings);
  if (settingsCancelBtn) settingsCancelBtn.addEventListener('click', closeSettings);

  if (settingsOverlay) {
    settingsOverlay.addEventListener('click', function (e) {
      if (e.target === settingsOverlay) closeSettings();
    });
  }

  if (settingsSaveBtn) {
    settingsSaveBtn.addEventListener('click', async function () {
      settingsSaveBtn.disabled = true;
      try {
        const body = collectForm();
        const res = await fetch('/api/schedule-config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (json.success) {
          showSettingsAlert('Configuración guardada correctamente', 'success');
          setTimeout(closeSettings, 1200);
        } else {
          showSettingsAlert(json.error || 'Error al guardar');
        }
      } catch {
        showSettingsAlert('Error al guardar la configuración');
      } finally {
        settingsSaveBtn.disabled = false;
      }
    });
  }

  if (settingsResetBtn) {
    settingsResetBtn.addEventListener('click', async function () {
      if (!confirm('¿Restaurar los valores por defecto del .env?')) return;
      settingsResetBtn.disabled = true;
      try {
        const res = await fetch('/api/schedule-config', {
          method: 'DELETE',
          headers: { 'Accept': 'application/json' },
        });
        const json = await res.json();
        if (json.success) {
          populateForm(json.config);
          showSettingsAlert('Valores restaurados a los valores por defecto', 'success');
        } else {
          showSettingsAlert(json.error || 'Error al restaurar la configuración');
        }
      } catch {
        showSettingsAlert('Error al restaurar la configuración');
      } finally {
        settingsResetBtn.disabled = false;
      }
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && settingsOverlay && !settingsOverlay.hidden) {
      closeSettings();
    }
  });
});
