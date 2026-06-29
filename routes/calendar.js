import { Router } from 'express';
import { submitHoursRange, getRegisteredDays, getLeaveDaysList, getVacationRequestsList, disableDay, getEventsForDay, previewDayHours, cancelVacation, requestVacation } from '../logic.js';
import { catchAsync, validateDateRange } from '../middleware/errorHandler.js';
import { get as cacheGet, set as cacheSet, del as cacheDel, cacheKeys } from '../utils/cache.js';

// Returns a local YYYY-MM-DD string without UTC conversion
function localDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function buildCalendarData(registered, startDate, today) {
  const calendarData = [];
  const todayStr = localDateStr(today);
  const endOfYear = new Date(today.getFullYear(), 11, 31);
  const endStr = localDateStr(endOfYear);
  let cursor = new Date(startDate);
  cursor.setHours(12, 0, 0, 0); // noon to avoid UTC midnight timezone drift
  while (localDateStr(cursor) <= endStr) {
    const iso = localDateStr(cursor);
    const day = cursor.getDay(); // 0=Sun, 6=Sat
    const isWeekend = day === 0 || day === 6;
    const isFuture = iso >= todayStr;
    const find = registered.find(r => r.date === iso);
    const isHoliday = !isWeekend && !!find?.isHoliday;
    let status;
    if (isWeekend) {
      status = 'weekend';
    } else if (isHoliday) {
      status = 'holiday';
    } else if (find?.status === 'vacation' || find?.status === 'vacation-pending' || find?.status === 'vacation-cancel-pending' || find?.status === 'leave' || find?.status === 'leave-pending') {
      status = find.status;
    } else if (isFuture) {
      status = 'future';
    } else {
      status = find?.status || 'pending';
    }
    calendarData.push({ date: iso, status, isHoliday });
    cursor.setDate(cursor.getDate() + 1);
  }
  return calendarData;
}

function computeStats(calendarData) {
  return {
    registered: calendarData.filter(d => d.status === 'registered').length,
    pending: calendarData.filter(d => d.status === 'pending').length,
    holiday: calendarData.filter(d => d.status === 'holiday').length,
    vacation: calendarData.filter(d => d.status === 'vacation' || d.status === 'vacation-pending' || d.status === 'vacation-cancel-pending').length,
  };
}

export default function createCalendarRouter() {
  const router = Router();

  router.get('/', catchAsync(async (req, res) => {
    const today = new Date();
    const startDate = new Date(today.getFullYear(), 0, 1);
    const startISO = localDateStr(startDate);
    const endOfYear = new Date(today.getFullYear(), 11, 31);
    const endISO = localDateStr(endOfYear);

    const credentials = req.session.credentials;
    const [registered, leaveDays, vacationRequests] = await Promise.all([
      getRegisteredDays(startISO, endISO, credentials),
      getLeaveDaysList(credentials),
      getVacationRequestsList(credentials),
    ]);

    const calendarData = buildCalendarData(registered, startDate, today);
    const stats = computeStats(calendarData);
    const firstPending = calendarData.find(d => d.status === 'pending')?.date ?? '';

    const { submitted, start: qsStart, end: qsEnd, dry, job } = req.query || {};
    const startPrefill = typeof qsStart === 'string' ? qsStart : '';
    const endPrefill = typeof qsEnd === 'string' ? qsEnd : '';
    const showSubmitted = submitted === '1';
    const dryRun = (typeof dry === 'undefined') ? true : (dry === '1');

    let synthesizedResults = [];
    if (showSubmitted && job) {
      const cached = cacheGet(`job_results_${job}`);
      if (Array.isArray(cached)) {
        synthesizedResults = cached;
      } else if (req.session.lastJobId === job && Array.isArray(req.session.lastJobResults)) {
        synthesizedResults = req.session.lastJobResults;
        delete req.session.lastJobId;
        delete req.session.lastJobResults;
      }
    }
    if (showSubmitted && dryRun && startPrefill && endPrefill && synthesizedResults.length === 0) {
      try {
        const rangeEndStr = endPrefill;
        let cursorSim = new Date(startPrefill);
        cursorSim.setHours(12, 0, 0, 0);
        while (localDateStr(cursorSim) <= rangeEndStr) {
          const iso = localDateStr(cursorSim);
          const dow = cursorSim.getDay();
          const find = calendarData.find(d => d.date === iso);
          const status = find?.status;
          const isPending = status === 'pending';
          if (dow >= 1 && dow <= 5 && isPending) {
            synthesizedResults.push({ date: iso, dryRun: true, status: 'dry-run', isHoliday: false });
          }
          cursorSim.setDate(cursorSim.getDate() + 1);
        }
      } catch {}
    }

    res.render('index', {
      results: synthesizedResults,
      calendarData,
      leaveDays,
      vacationRequests,
      startDate: startPrefill,
      endDate: endPrefill,
      isLoading: false,
      submitted: showSubmitted,
      dryRun,
      stats,
      firstPending,
      currentUser: credentials?.username ?? '',
    });
  }));

  router.post('/submit', validateDateRange, catchAsync(async (req, res) => {
    const { dryRun } = req.body;
    const { startISO, endISO } = req.validatedDates;
    const isDryRunActive = dryRun === 'on';

    const results = await submitHoursRange({ startDate: startISO, endDate: endISO, dryRun: isDryRunActive, credentials: req.session.credentials });

    const today = new Date();
    const yearStart = new Date(today.getFullYear(), 0, 1);
    const calendarStartISO = localDateStr(yearStart);
    const calendarEndISO = localDateStr(today);

    try {
      cacheDel(cacheKeys.registeredDays(startISO, endISO));
      cacheDel(cacheKeys.registeredDays(calendarStartISO, calendarEndISO));
    } catch {}

    const jobId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try { cacheSet(`job_results_${jobId}`, results, 600); } catch {}
    // Store in session as fallback for when cache is disabled
    req.session.lastJobId = jobId;
    req.session.lastJobResults = results;

    return res.redirect(303, `/?submitted=1&start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}&dry=${dryRun === 'on' ? '1' : '0'}&job=${encodeURIComponent(jobId)}`);
  }));

  router.post('/submit-day', validateDateRange, catchAsync(async (req, res) => {
    const { dryRun, workStart, workEnd, lunchStart, lunchEnd } = req.body;
    const { startISO, endISO } = req.validatedDates;
    const isDryRun = dryRun === 'on';

    // Build per-day overrides if custom hours were provided
    const overrides = {};
    if (workStart && workEnd && /^\d{2}:\d{2}$/.test(workStart) && /^\d{2}:\d{2}$/.test(workEnd)) {
      overrides[startISO] = { workStart, workEnd };
      if (lunchStart && lunchEnd && /^\d{2}:\d{2}$/.test(lunchStart) && /^\d{2}:\d{2}$/.test(lunchEnd)) {
        overrides[startISO].lunchStart = lunchStart;
        overrides[startISO].lunchEnd   = lunchEnd;
      }
    }

    const results = await submitHoursRange({ startDate: startISO, endDate: endISO, dryRun: isDryRun, credentials: req.session.credentials, overrides });

    try {
      const today = new Date();
      const yearStart = new Date(today.getFullYear(), 0, 1);
      cacheDel(cacheKeys.registeredDays(startISO, endISO));
      cacheDel(cacheKeys.registeredDays(localDateStr(yearStart), localDateStr(today)));
    } catch {}

    return res.json({ success: true, dryRun: isDryRun, results });
  }));

  // Preview hours for a pending day (no registration)
  router.get('/day-preview', (req, res) => {
    const { date } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, error: 'Fecha inválida' });
    }
    const preview = previewDayHours(date);
    return res.json({ success: true, ...preview });
  });

  // Detail for a registered day (hours)
  router.get('/day-detail', catchAsync(async (req, res) => {
    const { date } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, error: 'Fecha inválida' });
    }
    const detail = await getEventsForDay(date, req.session.credentials);
    return res.json({ success: true, ...detail });
  }));

  // Cancel an approved vacation (full range or partial)
  router.post('/cancel-vacation', catchAsync(async (req, res) => {
    const { vacationId, start, end, wholeRange } = req.body;
    if (!vacationId || !start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
      return res.status(400).json({ success: false, error: 'Parámetros inválidos' });
    }
    await cancelVacation(req.session.credentials, vacationId, start, end ?? start, wholeRange !== 'false');
    try {
      cacheDel(cacheKeys.vacationDaysDetailed());
      cacheDel('vacation_requests_list');
    } catch {}
    return res.json({ success: true });
  }));

  // Request new vacation days
  router.post('/request-vacation', catchAsync(async (req, res) => {
    const { start, end } = req.body;
    if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
      return res.status(400).json({ success: false, error: 'Fecha inválida' });
    }
    const result = await requestVacation(req.session.credentials, start, end ?? start);
    try {
      cacheDel(cacheKeys.vacationDaysDetailed());
      cacheDel('vacation_requests_list');
    } catch {}
    return res.json({ success: true, message: result.Message });
  }));

  // Undo a registered day — calls disable-event for all events of that date
  router.post('/disable-day', catchAsync(async (req, res) => {
    const { date, message } = req.body;

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, error: 'Fecha inválida' });
    }

    const result = await disableDay(date, req.session.credentials, message);

    // Invalidate registered days cache so the calendar refreshes
    try {
      const today = new Date();
      const yearStart = new Date(today.getFullYear(), 0, 1);
      cacheDel(cacheKeys.registeredDays(date, date));
      cacheDel(cacheKeys.registeredDays(localDateStr(yearStart), localDateStr(today)));
      cacheDel(cacheKeys.vacationDaysDetailed());
    } catch {}

    return res.json({ success: result.disabled > 0, ...result });
  }));

  return router;
}
