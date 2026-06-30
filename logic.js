import { DateTime } from 'luxon';
import fetch from 'node-fetch';
import config from './config.js';
import FormData from 'form-data';
import * as cheerio from 'cheerio';
import { get, set, cacheKeys } from './utils/cache.js';
import { logInfo, logWarn } from './utils/logger.js';
import { getScheduleConfig } from './utils/scheduleConfig.js';

function getCreds(credentials) {
  return credentials || { username: config.username, password: config.password };
}

function formatDate(date) {
  return date.toFormat("yyyy-MM-dd'T'HH':'mm':'ssZZ");
}

async function login(username, password) {
  const response = await fetch(`${config.apiBaseUrl}/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Username: username, Password: password }),
  });

  if (!response.ok) {
    throw new Error(`Login failed: ${response.status}`);
  }

  const data = await response.json();
  return data.User.AccessToken;
}

// Exported for use by auth route to validate credentials
export async function loginUser(username, password) {
  return login(username, password);
}

function buildHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };
}

async function postManualRegister(token, startDate, endDate, eventTypeId) {
  const response = await fetch(`${config.apiBaseUrl}/events/manual-register`, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify({
      EventTypeId: eventTypeId,
      StartDate: startDate,
      EndDate: endDate,
    }),
  });

  return response;
}

// ─── Calendar days (festivos + vacaciones) via /calendars/get-employee-calendar

async function fetchCalendarDays(token, year) {
  const response = await fetch(`${config.apiBaseUrl}/calendars/get-employee-calendar?year=${year}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    logWarn('Failed to fetch calendar days', { status: response.status, year });
    return {};
  }

  const data = await response.json();
  const calendar = data?.Calendar ?? [];
  const map = {};

  for (const entry of calendar) {
    // Id format: "dd-MM-yyyy"
    const parts = String(entry.Id ?? '').split('-');
    if (parts.length !== 3) continue;
    const [d, m, y] = parts;
    const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;

    if (entry.Text === 'Fiesta' || entry.Color === 'FF0000') {
      map[iso] = 'holiday';
    } else if (entry.Text === 'Vacaciones' || entry.Color === '11FF11') {
      // Only mark as vacation if not already marked as holiday
      if (!map[iso]) map[iso] = 'vacation';
    }
    // DIGITALS (B40000) = días laborales normales de empresa → se ignoran
  }

  return map;
}

// ─── Leave days (permisos) via /leave-days/list-all

async function fetchLeaveDays(token) {
  const response = await fetch(`${config.apiBaseUrl}/leave-days/list-all`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    logWarn('Failed to fetch leave days', { status: response.status });
    return { map: {}, list: [] };
  }

  const data = await response.json();
  const leaveDays = data?.LeaveDays ?? [];
  const map = {};

  for (const leave of leaveDays) {
    if (!leave.Start || !leave.End) continue;
    // State 1 = pending, State 2 = cancelled, State 3 = approved
    if (leave.State === 2) continue;
    const startStr = leave.Start.split('T')[0];
    const endStr   = leave.End.split('T')[0];
    const status   = leave.State === 3 ? 'leave' : 'leave-pending';
    let cursor     = DateTime.fromISO(startStr);
    const endDt    = DateTime.fromISO(endStr);
    while (cursor <= endDt) {
      map[cursor.toISODate()] = status;
      cursor = cursor.plus({ days: 1 });
    }
  }

  return { map, list: leaveDays };
}

// ─── Vacation data via /vacations/get-vacations-and-onduty-ranges-from-employee

async function fetchVacationData(token) {
  const response = await fetch(`${config.apiBaseUrl}/vacations/get-vacations-and-onduty-ranges-from-employee`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    logWarn('Failed to fetch vacation data', { status: response.status });
    return { map: {}, ranges: [] };
  }

  const data = await response.json();
  const entries = data?.VacationsAnOnDutyCalendarDays ?? [];
  const map = {};

  for (const entry of entries) {
    if (!entry.Day) continue;
    const iso = entry.Day.split('T')[0];

    if (entry.IsHoliday) {
      map[iso] = 'holiday';
    } else if (entry.DayType === 1 && entry.State !== 2) {
      // Vacation: State 3 = approved, State 1 = pending/requested
      // State 2 = cancelled (skip — treat as regular workday)
      if (!map[iso] || map[iso] !== 'holiday') {
        map[iso] = entry.State === 3 ? 'vacation' : 'vacation-pending';
      }
    }
  }

  // Build vacation request ranges for the panel (group consecutive days by state)
  const vacationDays = entries
    .filter(e => e.DayType === 1 && !e.IsHoliday && !e.IsLeaveDay)
    .sort((a, b) => a.Day.localeCompare(b.Day));

  const ranges = [];
  let current = null;

  for (const day of vacationDays) {
    const iso = day.Day.split('T')[0];
    const state = day.State;

    if (current && current.state === state) {
      // Check if consecutive (next day)
      const prevDate = DateTime.fromISO(current.end);
      const thisDate = DateTime.fromISO(iso);
      const diff = thisDate.diff(prevDate, 'days').days;
      if (diff <= 3) { // Allow weekends in between
        current.end = iso;
        continue;
      }
    }

    // Start new range
    if (current) ranges.push(current);
    current = { start: iso, end: iso, state, year: day.YearOfApplication };
  }
  if (current) ranges.push(current);

  return { map, ranges };
}

// ─── Time-off map (combines calendar + leave days + vacation data)

export async function getTimeOffDaysDetailed(credentials) {
  const cacheKey = cacheKeys.vacationDaysDetailed();
  const cached = get(cacheKey);
  if (cached) {
    logInfo('Serving time-off days from cache');
    return cached;
  }

  logInfo('Fetching time-off days from API');
  const creds = getCreds(credentials);
  const token = await login(creds.username, creds.password);

  const [calendarMap, { map: leaveMap }, { map: vacationMap }] = await Promise.all([
    fetchCalendarDays(token, DateTime.now().year),
    fetchLeaveDays(token),
    fetchVacationData(token),
  ]);

  // Merge: vacation data provides holidays + vacation statuses,
  // calendar data fills gaps, leave days take highest priority
  const map = { ...calendarMap, ...vacationMap, ...leaveMap };

  set(cacheKey, map, 3600);
  logInfo('Cached time-off days', { count: Object.keys(map).length });
  return map;
}

// ─── Vacation requests list (for the UI panel)

export async function getVacationRequestsList(credentials) {
  const cacheKey = 'vacation_requests_list';
  const cached = get(cacheKey);
  if (cached) {
    logInfo('Serving vacation requests list from cache');
    return cached;
  }

  logInfo('Fetching vacation requests list from API');
  const creds = getCreds(credentials);
  const token = await login(creds.username, creds.password);
  const { ranges } = await fetchVacationData(token);

  const result = ranges.map(r => ({
    type: 'Vacaciones',
    state: r.state === 3 ? 'Aprobada' : r.state === 2 ? 'Cancelada' : 'Solicitada',
    stateCode: r.state,
    start: r.start,
    end: r.end,
    year: r.year,
  }));

  set(cacheKey, result, 1800);
  return result;
}

// ─── Leave days list (for the UI panel)

export async function getLeaveDaysList(credentials) {
  const cacheKey = cacheKeys.leaveDays();
  const cached = get(cacheKey);
  if (cached) {
    logInfo('Serving leave days list from cache');
    return cached;
  }

  logInfo('Fetching leave days list from API');
  const creds = getCreds(credentials);
  const token = await login(creds.username, creds.password);
  const { list } = await fetchLeaveDays(token);

  // Sort by start date ascending, keep only relevant fields
  const result = list
    .map(l => ({
      id         : l.Id,
      type       : l.Type,
      state      : l.LeaveDayState,
      stateCode  : l.State,
      start      : l.Start ? l.Start.split('T')[0] : null,
      end        : l.End   ? l.End.split('T')[0]   : null,
    }))
    .filter(l => l.start)
    .sort((a, b) => a.start.localeCompare(b.start));

  set(cacheKey, result, 1800);
  return result;
}

// ─── Get events detail for a registered day

export async function getEventsForDay(date, credentials) {
  const creds = getCreds(credentials);
  const token = await login(creds.username, creds.password);
  const formattedDate = DateTime.fromISO(date).toFormat('dd-MM-yyyy');

  const response = await fetch(
    `${config.apiBaseUrl}/events/get-events-from-day?day=${formattedDate}`,
    { headers: buildHeaders(token) }
  );

  if (!response.ok) {
    throw new Error(`No se pudieron obtener los eventos del día ${date} (${response.status})`);
  }

  const eventsData = await response.json();
  // Response shape: { Events: [{ Principal: { EventTypeId, StartDate, EndDate }, Events: [{ EventTypeId, StartDate, EndDate }] }] }
  const rawList = Array.isArray(eventsData)
    ? eventsData
    : (eventsData?.Events ?? eventsData?.events ?? eventsData?.Data ?? eventsData?.data ?? []);

  // Collect all events: Principal + nested Events[]
  const eventList = [];
  for (const item of rawList) {
    if (item?.Principal) eventList.push(item.Principal);
    else eventList.push(item);
    for (const sub of (item?.Events ?? [])) eventList.push(sub);
  }

  let workStart = null, workEnd = null, lunchStart = null, lunchEnd = null;

  for (const ev of eventList) {
    const typeId = ev.EventTypeId ?? ev.eventTypeId;
    const start = ev.StartDate ?? ev.startDate;
    const end   = ev.EndDate   ?? ev.endDate;
    if (!start || !end) continue;

    const startDT = DateTime.fromISO(start, { zone: 'Europe/Madrid' });
    const endDT   = DateTime.fromISO(end,   { zone: 'Europe/Madrid' });
    const fmt = (dt) => dt.toFormat('HH:mm');

    if (typeId === config.jornadaEventTypeId) {
      workStart = fmt(startDT);
      workEnd   = fmt(endDT);
    } else if (typeId === config.comidaEventTypeId) {
      lunchStart = fmt(startDT);
      lunchEnd   = fmt(endDT);
    }
  }

  return { date, workStart, workEnd, lunchStart, lunchEnd };
}

// ─── Disable (undo) a registered day

export async function disableDay(date, credentials, message = 'Registro equivocado') {
  const creds = getCreds(credentials);
  const token = await login(creds.username, creds.password);
  const formattedDate = DateTime.fromISO(date).toFormat('dd-MM-yyyy');

  // Fetch events registered for this day
  const eventsRes = await fetch(
    `${config.apiBaseUrl}/events/get-events-from-day?day=${formattedDate}`,
    { headers: buildHeaders(token) }
  );

  if (!eventsRes.ok) {
    throw new Error(`No se pudieron obtener los eventos del día ${date} (${eventsRes.status})`);
  }

  const eventsData = await eventsRes.json();
  // Response shape: { Events: [{ Principal: { EventId, ... }, Events: [{ EventId, ... }] }] }
  const rawList = Array.isArray(eventsData)
    ? eventsData
    : (eventsData?.Events ?? eventsData?.events ?? eventsData?.Data ?? eventsData?.data ?? []);

  const eventList = [];
  for (const item of rawList) {
    if (item?.Principal) eventList.push(item.Principal);
    else eventList.push(item);
    for (const sub of (item?.Events ?? [])) eventList.push(sub);
  }

  if (eventList.length === 0) {
    throw new Error('No se encontraron eventos registrados para este día');
  }

  const results = [];

  for (const event of eventList) {
    const eventId = event.EventId ?? event.eventId ?? event.Id ?? event.id;
    if (!eventId) continue;

    const body = new URLSearchParams();
    body.set('eventId', eventId);
    body.set('message', message);

    const res = await fetch(`${config.webBaseUrl}/disable-event`, {
      method : 'POST',
      headers: {
        'Authorization' : `Bearer ${token}`,
        'Content-Type'  : 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const json = await res.json().catch(() => ({ Success: res.ok }));
    results.push({ eventId, success: Boolean(json.Success) });
  }

  const allOk = results.length > 0 && results.every(r => r.success);
  if (!allOk && results.length > 0) {
    logWarn('Some events could not be disabled', { date, results });
  }

  return { date, disabled: results.filter(r => r.success).length, total: results.length };
}

// ─── Preview hours for a single day (no registration, no API call)

export function previewDayHours(date) {
  const scheduleConfig = getScheduleConfig();
  const currentYear = DateTime.now().year;
  const summerStart = DateTime.fromObject({ day: scheduleConfig.summerStartDay, month: scheduleConfig.summerStartMonth, year: currentYear }, { zone: 'Europe/Madrid' });
  const summerEnd   = DateTime.fromObject({ day: scheduleConfig.summerEndDay,   month: scheduleConfig.summerEndMonth,   year: currentYear }, { zone: 'Europe/Madrid' });

  const day = DateTime.fromISO(date, { zone: 'Europe/Madrid' });
  const isFriday   = day.weekday === 5;
  const isSummer   = day >= summerStart && day <= summerEnd;
  const isShortDay = isSummer || isFriday;

  let workStartRaw, workEnd, lunchStart, lunchEnd;

  if (isShortDay) {
    const t = scheduleConfig.workSchedule.summer.start;
    workStartRaw = day.set({ hour: t.hour, minute: t.minute });
    workEnd      = workStartRaw.plus(scheduleConfig.workSchedule.summer.length);
  } else {
    const t     = scheduleConfig.workSchedule.winter.start;
    const lunch = scheduleConfig.workSchedule.lunch.start;
    workStartRaw = day.set({ hour: t.hour, minute: t.minute });
    workEnd      = workStartRaw.plus(scheduleConfig.workSchedule.winter.length).plus(scheduleConfig.workSchedule.lunch.length);
    lunchStart   = day.set({ hour: lunch.hour, minute: lunch.minute });
    lunchEnd     = lunchStart.plus(scheduleConfig.workSchedule.lunch.length);
  }

  return {
    date,
    isShortDay,
    workStart:  formatTimeHHmm(workStartRaw),
    workEnd:    formatTimeHHmm(workEnd),
    lunchStart: lunchStart ? formatTimeHHmm(lunchStart) : null,
    lunchEnd:   lunchEnd   ? formatTimeHHmm(lunchEnd)   : null,
  };
}

// ─── Submit hours range

export async function submitHoursRange({ startDate, endDate, dryRun = true, credentials, overrides = {} }) {
  const scheduleConfig = getScheduleConfig();
  const currentYear = DateTime.now().year;
  const summerStart = DateTime.fromObject({
    day:   scheduleConfig.summerStartDay,
    month: scheduleConfig.summerStartMonth,
    year:  currentYear,
  }, { zone: 'Europe/Madrid' });
  const summerEnd = DateTime.fromObject({
    day:   scheduleConfig.summerEndDay,
    month: scheduleConfig.summerEndMonth,
    year:  currentYear,
  }, { zone: 'Europe/Madrid' });

  const start = DateTime.fromISO(startDate, { zone: 'Europe/Madrid' });
  const end = DateTime.fromISO(endDate, { zone: 'Europe/Madrid' });
  const days = [];
  let cursor = start;

  const timeOffMap = await getTimeOffDaysDetailed(credentials);

  while (cursor <= end) {
    const isoDate = cursor.toISODate();
    const isTimeOff = Boolean(timeOffMap[isoDate]);

    if (cursor.weekday >= 1 && cursor.weekday <= 5 && !isTimeOff) {
      logInfo('Día laborable válido', { date: isoDate, weekday: cursor.weekday });
      days.push(cursor);
    } else {
      logInfo('Saltando día (finde o festivo)', { date: isoDate, weekday: cursor.weekday });
    }

    cursor = cursor.plus({ days: 1 });
  }

  let accessToken = null;
  if (!dryRun) {
    const creds = getCreds(credentials);
    accessToken = await login(creds.username, creds.password);
  }

  const results = [];

  for (const day of days) {
    const isoDate  = day.toISODate();
    const ov       = overrides[isoDate] || {};
    const isFriday = day.weekday === 5;
    const isSummer = day >= summerStart && day <= summerEnd;
    const isShortDay = isSummer || isFriday;

    let workStartRaw, workEnd, lunchStart, lunchEnd;

    // Apply user overrides if present, otherwise use schedule + jitter
    if (ov.workStart && ov.workEnd) {
      const [wsh, wsm] = ov.workStart.split(':').map(Number);
      const [weh, wem] = ov.workEnd.split(':').map(Number);
      workStartRaw = day.set({ hour: wsh, minute: wsm });
      workEnd      = day.set({ hour: weh, minute: wem });
      if (ov.lunchStart && ov.lunchEnd) {
        const [lsh, lsm] = ov.lunchStart.split(':').map(Number);
        const [leh, lem] = ov.lunchEnd.split(':').map(Number);
        lunchStart = day.set({ hour: lsh, minute: lsm });
        lunchEnd   = day.set({ hour: leh, minute: lem });
      }
    } else if (isShortDay) {
      const t = scheduleConfig.workSchedule.summer.start;
      workStartRaw = day.set({ hour: t.hour, minute: t.minute + randomJitter() });
      workEnd = workStartRaw.plus(scheduleConfig.workSchedule.summer.length);
    } else {
      const t = scheduleConfig.workSchedule.winter.start;
      const lunch = scheduleConfig.workSchedule.lunch.start;
      workStartRaw = day.set({ hour: t.hour, minute: t.minute + randomJitter() });
      workEnd = workStartRaw.plus(scheduleConfig.workSchedule.winter.length).plus(scheduleConfig.workSchedule.lunch.length);
      lunchStart = day.set({ hour: lunch.hour, minute: lunch.minute + randomJitter() });
      lunchEnd = lunchStart.plus(scheduleConfig.workSchedule.lunch.length);
    }

    const workStart = formatDate(workStartRaw);
    const workEndStr = formatDate(workEnd);
    const lunchStartStr = lunchStart ? formatDate(lunchStart) : null;
    const lunchEndStr = lunchEnd ? formatDate(lunchEnd) : null;

    if (!dryRun) {
      await postManualRegister(accessToken, workStart, workEndStr, config.jornadaEventTypeId);
      if (lunchStartStr && lunchEndStr) {
        await postManualRegister(accessToken, lunchStartStr, lunchEndStr, config.comidaEventTypeId);
      }
    }

    results.push({
      date: isoDate,
      status: dryRun ? 'dry-run' : 'submitted',
      dryRun: dryRun,
      isHoliday: (timeOffMap[isoDate] === 'holiday'),
      isShortDay,
      workStart:  formatTimeHHmm(workStartRaw),
      workEnd:    formatTimeHHmm(workEnd),
      lunchStart: lunchStart ? formatTimeHHmm(lunchStart) : null,
      lunchEnd:   lunchEnd   ? formatTimeHHmm(lunchEnd)   : null,
    });
  }

  return results || [];
}

function randomJitter() {
  return Math.round(Math.random() * config.jitterMinutes);
}

function formatTimeHHmm(dt) {
  return dt.toFormat('HH:mm');
}

export async function getRegisteredDays(startDate, endDate, credentials) {
  const [timeOffMap, registeredFromReport] = await Promise.all([
    getTimeOffDaysDetailed(credentials),
    getRegisteredDaysFromReport(startDate, endDate, credentials)
  ]);
  const start = DateTime.fromISO(startDate);
  const end = DateTime.fromISO(endDate);
  const calendarData = [];
  let cursor = start;

  while (cursor <= end) {
    const isoDate = cursor.toISODate();
    const timeOffType = timeOffMap[isoDate];
    const isHoliday = timeOffType === 'holiday';
    const isVacation = timeOffType === 'vacation';
    const isVacationPending = timeOffType === 'vacation-pending';
    const isLeave = timeOffType === 'leave';
    const isLeavePending = timeOffType === 'leave-pending';
    const isRegistered = registeredFromReport.includes(isoDate);
    let status;
    if (isHoliday) status = 'holiday';
    else if (isVacation) status = 'vacation';
    else if (isVacationPending) status = 'vacation-pending';
    else if (isLeave) status = 'leave';
    else if (isLeavePending) status = 'leave-pending';
    else if (isRegistered) status = 'registered';
    else status = 'pending';
    calendarData.push({ date: isoDate, status, isHoliday });

    cursor = cursor.plus({ days: 1 });
  }
  return calendarData;
}

export async function getDetailedEventsByRange(startDate, endDate, credentials) {
  const registeredDays = await getRegisteredDaysFromReport(startDate, endDate, credentials);
  const results = [];

  const creds = getCreds(credentials);
  const token = await login(creds.username, creds.password);

  for (const date of registeredDays) {
    const formattedDate = DateTime.fromISO(date).toFormat('dd-MM-yyyy');
    const response = await fetch(`${config.apiBaseUrl}/events/get-events-from-day?day=${formattedDate}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      console.warn(`Fallo al obtener eventos de ${date}`);
      continue;
    }

    const events = await response.json();
    results.push({ date, events });
  }

  return results;
}

export async function getVacationDays(credentials) {
  // Backward compatibility: return array of all time-off days
  const detailed = await getTimeOffDaysDetailed(credentials);
  return Object.keys(detailed);
}

export async function getRegisteredDaysFromReport(startDate, endDate, credentials) {
  const cacheKey = cacheKeys.registeredDays(startDate, endDate);

  const cachedData = get(cacheKey);
  if (cachedData) {
    logInfo('Serving registered days from cache', { startDate, endDate });
    return cachedData;
  }

  logInfo('Fetching registered days from API', { startDate, endDate });
  const creds = getCreds(credentials);
  const token = await login(creds.username, creds.password);
  const formData = new FormData();
  formData.append('startDate', DateTime.fromISO(startDate).toFormat('dd-MM-yyyy'));
  formData.append('endDate', DateTime.fromISO(endDate).toFormat('dd-MM-yyyy'));
  const response = await fetch(`${config.reportsBaseUrl}/get-detailed-report`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
    body: formData
  });

  if (!response.ok) {
    logWarn('Failed to fetch registered days report', { status: response.status, startDate, endDate });
    return [];
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const registeredDates = [];

  $('table tbody tr').each((_, element) => {
    const dateText = $(element).find('td').first().text().trim();

    if (dateText) {
      const [day, month, year] = dateText.split('/');
      const isoDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      registeredDates.push(isoDate);
    }
  });

  set(cacheKey, registeredDates, 1800);
  logInfo('Cached registered days', { startDate, endDate, count: registeredDates.length });

  return registeredDates;
}
