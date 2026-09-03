(function quietPaceBootstrap(globalScope) {
  "use strict";

  const STORAGE_KEY = "quietPace.appState.v1";
  const SCHEMA_VERSION = 1;
  const MOSCOW_TIME_ZONE = "Europe/Moscow";
  const MAX_KOPECKS = 99_999_999_999;
  const VALID_SECTIONS = new Set(["planner", "clients"]);
  const VALID_VIEWS = new Set(["day", "week", "month"]);
  const VALID_TASK_PRIORITIES = new Set(["low", "normal", "high"]);
  const VALID_TASK_PRODUCTS = new Set(["vibeCoding", "aiSkills", "other"]);
  const VALID_TASK_STATUSES = new Set(["planned", "completed", "cancelled"]);
  const VALID_REVENUE_STATUSES = new Set(["expected", "received", "cancelled"]);
  const VALID_TRASH_TYPES = new Set(["task", "revenue", "followUp"]);
  const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
  const COLLECTION_LIMITS = Object.freeze({ tasks: 5000, revenueEntries: 2000, followUps: 1000, trash: 5000 });
  const REVENUE_STATUS_ORDER = { received: 0, expected: 1, cancelled: 2 };
  const WEEKDAY_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  const TASK_PRIORITY_LABELS = { low: "Низкий", normal: "Обычный", high: "Высокий" };
  const TASK_PRODUCT_LABELS = {
    vibeCoding: "Вайб-кодинг",
    aiSkills: "ИИ-навыки",
    other: "Другое",
  };

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function getMoscowParts(date = new Date()) {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: MOSCOW_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const values = {};
    for (const part of formatter.formatToParts(date)) {
      if (part.type !== "literal") values[part.type] = part.value;
    }
    return {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day),
      hour: Number(values.hour),
      minute: Number(values.minute),
      second: Number(values.second),
    };
  }

  function getMoscowDateKey(date = new Date()) {
    const parts = getMoscowParts(date);
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  }

  function getMoscowTimeKey(date = new Date()) {
    const parts = getMoscowParts(date);
    return `${pad(parts.hour)}:${pad(parts.minute)}`;
  }

  function parseDateKey(dateKey) {
    if (typeof dateKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null;
    const [year, month, day] = dateKey.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day, 12));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    return date;
  }

  function dateToKey(date) {
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }

  function isValidDateKey(dateKey) {
    return parseDateKey(dateKey) !== null;
  }

  function isValidTimeKey(timeKey) {
    return typeof timeKey === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(timeKey);
  }

  function addDays(dateKey, amount) {
    const date = parseDateKey(dateKey);
    if (!date || !Number.isInteger(amount)) throw new TypeError("Некорректная дата или смещение");
    date.setUTCDate(date.getUTCDate() + amount);
    return dateToKey(date);
  }

  function shiftMonth(dateKey, amount) {
    const date = parseDateKey(dateKey);
    if (!date || !Number.isInteger(amount)) throw new TypeError("Некорректная дата или смещение");
    const sourceDay = date.getUTCDate();
    const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + amount, 1, 12));
    const targetDays = new Date(
      Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12),
    ).getUTCDate();
    target.setUTCDate(Math.min(sourceDay, targetDays));
    return dateToKey(target);
  }

  function startOfWeek(dateKey) {
    const date = parseDateKey(dateKey);
    if (!date) throw new TypeError("Некорректная дата");
    const mondayOffset = (date.getUTCDay() + 6) % 7;
    return addDays(dateKey, -mondayOffset);
  }

  function endOfWeek(dateKey) {
    return addDays(startOfWeek(dateKey), 6);
  }

  function getMonthKey(dateKey) {
    if (!isValidDateKey(dateKey)) throw new TypeError("Некорректная дата");
    return dateKey.slice(0, 7);
  }

  function startOfMonth(dateKey) {
    return `${getMonthKey(dateKey)}-01`;
  }

  function daysInMonth(dateKey) {
    const date = parseDateKey(dateKey);
    if (!date) throw new TypeError("Некорректная дата");
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 12)).getUTCDate();
  }

  function endOfMonth(dateKey) {
    return `${getMonthKey(dateKey)}-${pad(daysInMonth(dateKey))}`;
  }

  function getIsoWeekInfo(dateKey) {
    const source = parseDateKey(dateKey);
    if (!source) throw new TypeError("Некорректная дата");
    const thursday = new Date(source.getTime());
    const weekday = thursday.getUTCDay() || 7;
    thursday.setUTCDate(thursday.getUTCDate() + 4 - weekday);
    const isoYear = thursday.getUTCFullYear();
    const firstThursday = new Date(Date.UTC(isoYear, 0, 4, 12));
    const firstWeekday = firstThursday.getUTCDay() || 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() + 4 - firstWeekday);
    const week = 1 + Math.round((thursday - firstThursday) / 604_800_000);
    return { isoYear, week, weekKey: `${isoYear}-W${pad(week)}` };
  }

  function isDateInRange(dateKey, startKey, endKey) {
    return isValidDateKey(dateKey) && dateKey >= startKey && dateKey <= endKey;
  }

  function parseMoneyToKopecks(value) {
    if (typeof value !== "string" && typeof value !== "number") {
      return { ok: false, error: "Введите сумму" };
    }
    const normalized = String(value)
      .trim()
      .replace(/[\s\u00a0\u202f]/g, "")
      .replace(",", ".");
    if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
      return { ok: false, error: "Введите рубли и не более двух знаков копеек" };
    }
    const [rublesText, kopecksText = ""] = normalized.split(".");
    const rubles = Number(rublesText);
    const kopecks = Number(kopecksText.padEnd(2, "0"));
    if (!Number.isSafeInteger(rubles) || !Number.isInteger(kopecks)) {
      return { ok: false, error: "Сумма слишком велика" };
    }
    const amountKopecks = rubles * 100 + kopecks;
    if (!Number.isSafeInteger(amountKopecks) || amountKopecks < 1) {
      return { ok: false, error: "Сумма должна быть больше нуля" };
    }
    if (amountKopecks > MAX_KOPECKS) {
      return { ok: false, error: "Сумма превышает 999 999 999,99 ₽" };
    }
    return { ok: true, value: amountKopecks };
  }

  function formatKopecks(amountKopecks) {
    if (!Number.isInteger(amountKopecks)) throw new TypeError("Сумма должна быть в копейках");
    const hasKopecks = Math.abs(amountKopecks) % 100 !== 0;
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency: "RUB",
      minimumFractionDigits: hasKopecks ? 2 : 0,
      maximumFractionDigits: hasKopecks ? 2 : 0,
    }).format(amountKopecks / 100);
  }

  function sumEntries(entries, status, dateField, startKey, endKey) {
    if (!Array.isArray(entries)) return 0;
    return entries.reduce((sum, entry) => {
      if (
        entry &&
        entry.status === status &&
        Number.isInteger(entry.amountKopecks) &&
        entry.amountKopecks > 0 &&
        isDateInRange(entry[dateField], startKey, endKey)
      ) {
        return sum + entry.amountKopecks;
      }
      return sum;
    }, 0);
  }

  function calculateFact(entries, startKey, endKey) {
    return sumEntries(entries, "received", "receivedDate", startKey, endKey);
  }

  function calculateExpectation(entries, startKey, endKey) {
    return sumEntries(entries, "expected", "expectedDate", startKey, endKey);
  }

  function calculateCompletion(factKopecks, planKopecks) {
    if (!Number.isInteger(planKopecks) || planKopecks <= 0) return null;
    return (factKopecks / planKopecks) * 100;
  }

  function calculateRunRate(factKopecks, elapsedCalendarDays, totalCalendarDays) {
    if (
      !Number.isInteger(factKopecks) ||
      factKopecks < 0 ||
      !Number.isInteger(elapsedCalendarDays) ||
      elapsedCalendarDays < 1 ||
      !Number.isInteger(totalCalendarDays) ||
      totalCalendarDays < elapsedCalendarDays
    ) {
      return null;
    }
    const rawKopecks = (factKopecks / elapsedCalendarDays) * totalCalendarDays;
    return Math.round(rawKopecks / 100) * 100;
  }

  function createInitialState(today = getMoscowDateKey()) {
    if (!isValidDateKey(today)) throw new TypeError("Некорректная начальная дата");
    return {
      schemaVersion: SCHEMA_VERSION,
      revision: 0,
      tasks: [],
      revenueEntries: [],
      monthlyPlans: {},
      weeklyPlans: {},
      followUps: [],
      trash: [],
      settings: {
        activeSection: "planner",
        calendarView: "week",
        selectedDate: today,
        hideCompletedFollowUps: false,
      },
    };
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function isValidAppState(value) {
    return Boolean(
      isPlainObject(value) &&
        value.schemaVersion === SCHEMA_VERSION &&
        Number.isInteger(value.revision) &&
        value.revision >= 0 &&
        Array.isArray(value.tasks) &&
        Array.isArray(value.revenueEntries) &&
        isPlainObject(value.monthlyPlans) &&
        isPlainObject(value.weeklyPlans) &&
        Array.isArray(value.followUps) &&
        Array.isArray(value.trash) &&
        isPlainObject(value.settings) &&
        VALID_SECTIONS.has(value.settings.activeSection) &&
        VALID_VIEWS.has(value.settings.calendarView) &&
        isValidDateKey(value.settings.selectedDate) &&
        typeof value.settings.hideCompletedFollowUps === "boolean",
    );
  }

  function cloneState(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function inspectStoredState(storage) {
    let raw = null;
    try {
      raw = storage.getItem(STORAGE_KEY);
      if (raw === null) return { status: "missing", raw: null, state: null };
      const parsed = JSON.parse(raw);
      if (!isValidAppState(parsed)) return { status: "invalid", raw, state: null };
      return { status: "valid", raw, state: parsed };
    } catch (error) {
      return { status: "error", raw, state: null, error };
    }
  }

  function persistWithRevision(storage, memoryState, baseRevision) {
    const snapshot = inspectStoredState(storage);
    if (snapshot.status === "error") {
      return { ok: false, reason: "storage", error: snapshot.error };
    }
    if (snapshot.status === "invalid") {
      return { ok: false, reason: "corrupt" };
    }
    const storedRevision = snapshot.status === "missing" ? 0 : snapshot.state.revision;
    if (storedRevision !== baseRevision) {
      return {
        ok: false,
        reason: "conflict",
        remoteState: snapshot.status === "valid" ? snapshot.state : null,
      };
    }
    const candidate = cloneState(memoryState);
    candidate.revision = baseRevision + 1;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(candidate));
      return { ok: true, state: candidate, baseRevision: candidate.revision };
    } catch (error) {
      return { ok: false, reason: "storage", error };
    }
  }

  function serializeBackup(appState, exportedAt = new Date().toISOString()) {
    return JSON.stringify(
      {
        schemaVersion: SCHEMA_VERSION,
        exportedAt,
        data: appState,
      },
      null,
      2,
    );
  }

  function isIsoDateTime(value) {
    if (typeof value !== "string") return false;
    const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/);
    if (!match || !isValidDateKey(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return false;
    return !Number.isNaN(Date.parse(value));
  }

  function requireString(value, field, { min = 0, max = Infinity, nullable = false } = {}) {
    if (nullable && value === null) return null;
    if (typeof value !== "string" || value.length < min || value.length > max) throw new Error(`${field}: некорректная строка`);
    return value;
  }

  function normalizeTaskRecord(source, label = "Задача") {
    if (!isPlainObject(source)) throw new Error(`${label}: ожидается объект`);
    const record = {
      id: requireString(source.id, `${label}.id`, { min: 1 }),
      description: requireString(source.description, `${label}.description`, { min: 1, max: 500 }),
      date: source.date,
      time: source.time,
      priority: source.priority,
      product: source.product,
      customProduct: source.customProduct,
      status: source.status,
      contactLabel: source.contactLabel,
      contactValue: source.contactValue,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    };
    if (record.description.trim() !== record.description) throw new Error(`${label}.description: пробелы по краям`);
    if (!isValidDateKey(record.date)) throw new Error(`${label}.date: некорректная дата`);
    if (record.time !== null && !isValidTimeKey(record.time)) throw new Error(`${label}.time: некорректное время`);
    if (!VALID_TASK_PRIORITIES.has(record.priority)) throw new Error(`${label}.priority: неизвестное значение`);
    if (!VALID_TASK_PRODUCTS.has(record.product)) throw new Error(`${label}.product: неизвестное значение`);
    if (!VALID_TASK_STATUSES.has(record.status)) throw new Error(`${label}.status: неизвестное значение`);
    requireString(record.customProduct, `${label}.customProduct`, { min: record.product === "other" ? 1 : 0, max: 80, nullable: record.product !== "other" });
    if (record.product !== "other" && record.customProduct !== null) throw new Error(`${label}.customProduct: должно быть null`);
    requireString(record.contactLabel, `${label}.contactLabel`, { min: 1, max: 50, nullable: true });
    requireString(record.contactValue, `${label}.contactValue`, { min: 1, max: 500, nullable: true });
    if ((record.contactLabel === null) !== (record.contactValue === null)) throw new Error(`${label}: контакт заполняется парой`);
    if (!isIsoDateTime(record.createdAt) || !isIsoDateTime(record.updatedAt)) throw new Error(`${label}: некорректное время изменения`);
    return record;
  }

  function normalizeRevenueRecord(source, label = "Оплата") {
    if (!isPlainObject(source)) throw new Error(`${label}: ожидается объект`);
    const record = {
      id: requireString(source.id, `${label}.id`, { min: 1 }), amountKopecks: source.amountKopecks,
      product: source.product, customProduct: source.customProduct, status: source.status,
      expectedDate: source.expectedDate, receivedDate: source.receivedDate, comment: source.comment,
      createdAt: source.createdAt, updatedAt: source.updatedAt,
    };
    if (!Number.isInteger(record.amountKopecks) || record.amountKopecks < 1 || record.amountKopecks > MAX_KOPECKS) throw new Error(`${label}.amountKopecks: некорректная сумма`);
    if (!VALID_TASK_PRODUCTS.has(record.product) || !VALID_REVENUE_STATUSES.has(record.status)) throw new Error(`${label}: неизвестный продукт или статус`);
    requireString(record.customProduct, `${label}.customProduct`, { min: record.product === "other" ? 1 : 0, max: 80, nullable: record.product !== "other" });
    if (record.product !== "other" && record.customProduct !== null) throw new Error(`${label}.customProduct: должно быть null`);
    if (record.expectedDate !== null && !isValidDateKey(record.expectedDate)) throw new Error(`${label}.expectedDate: некорректная дата`);
    if (record.receivedDate !== null && !isValidDateKey(record.receivedDate)) throw new Error(`${label}.receivedDate: некорректная дата`);
    if (record.status === "expected" && (record.expectedDate === null || record.receivedDate !== null)) throw new Error(`${label}: неверные даты ожидаемой оплаты`);
    if (record.status === "received" && record.receivedDate === null) throw new Error(`${label}: нет фактической даты`);
    if (record.receivedDate && record.receivedDate > getMoscowDateKey()) throw new Error(`${label}.receivedDate: фактическая дата в будущем`);
    requireString(record.comment, `${label}.comment`, { min: 0, max: 500, nullable: true });
    if (!isIsoDateTime(record.createdAt) || !isIsoDateTime(record.updatedAt)) throw new Error(`${label}: некорректное время изменения`);
    return record;
  }

  function normalizeFollowUpRecord(source, label = "Клиент") {
    if (!isPlainObject(source)) throw new Error(`${label}: ожидается объект`);
    const record = {
      id: requireString(source.id, `${label}.id`, { min: 1 }), name: requireString(source.name, `${label}.name`, { min: 1, max: 120 }),
      date: source.date, time: source.time, comment: source.comment, contactLabel: source.contactLabel,
      contactValue: source.contactValue, completed: source.completed, completedAt: source.completedAt,
      createdAt: source.createdAt, updatedAt: source.updatedAt,
    };
    if (record.name.trim() !== record.name) throw new Error(`${label}.name: пробелы по краям`);
    if (!isValidDateKey(record.date) || !isValidTimeKey(record.time)) throw new Error(`${label}: некорректная дата или время`);
    requireString(record.comment, `${label}.comment`, { min: 0, max: 1000, nullable: true });
    requireString(record.contactLabel, `${label}.contactLabel`, { min: 1, max: 50, nullable: true });
    requireString(record.contactValue, `${label}.contactValue`, { min: 1, max: 500, nullable: true });
    if ((record.contactLabel === null) !== (record.contactValue === null)) throw new Error(`${label}: контакт заполняется парой`);
    if (typeof record.completed !== "boolean") throw new Error(`${label}.completed: ожидается boolean`);
    if ((record.completed && !isIsoDateTime(record.completedAt)) || (!record.completed && record.completedAt !== null)) throw new Error(`${label}.completedAt: не соответствует статусу`);
    if (!isIsoDateTime(record.createdAt) || !isIsoDateTime(record.updatedAt)) throw new Error(`${label}: некорректное время изменения`);
    return record;
  }

  function assertUniqueIds(records, label) {
    const ids = new Set();
    for (const record of records) {
      if (ids.has(record.id)) throw new Error(`${label}: повторяется идентификатор ${record.id}`);
      ids.add(record.id);
    }
  }

  function normalizeImportedBackup(envelope) {
    if (!isPlainObject(envelope) || envelope.schemaVersion !== SCHEMA_VERSION || !isIsoDateTime(envelope.exportedAt) || !isPlainObject(envelope.data)) throw new Error("Файл не является резервной копией версии 1");
    const source = envelope.data;
    if (source.schemaVersion !== SCHEMA_VERSION || !Number.isInteger(source.revision) || source.revision < 0) throw new Error("Версия или ревизия состояния некорректна");
    for (const key of ["tasks", "revenueEntries", "followUps", "trash"]) if (!Array.isArray(source[key])) throw new Error(`Отсутствует коллекция ${key}`);
    if (!isPlainObject(source.monthlyPlans) || !isPlainObject(source.weeklyPlans) || !isPlainObject(source.settings)) throw new Error("Отсутствуют планы или настройки");
    for (const [key, limit] of Object.entries(COLLECTION_LIMITS)) if (source[key].length > limit) throw new Error(`${key}: превышен лимит ${limit}`);
    const tasks = source.tasks.map((item, index) => normalizeTaskRecord(item, `Задача ${index + 1}`));
    const revenueEntries = source.revenueEntries.map((item, index) => normalizeRevenueRecord(item, `Оплата ${index + 1}`));
    const followUps = source.followUps.map((item, index) => normalizeFollowUpRecord(item, `Клиент ${index + 1}`));
    assertUniqueIds(tasks, "Задачи"); assertUniqueIds(revenueEntries, "Оплаты"); assertUniqueIds(followUps, "Клиенты");
    const monthlyPlans = {};
    for (const [key, item] of Object.entries(source.monthlyPlans)) {
      if (!/^\d{4}-\d{2}$/.test(key) || !isPlainObject(item) || item.monthKey !== key || !isValidDateKey(`${key}-01`) || !Number.isInteger(item.amountKopecks) || item.amountKopecks < 1 || item.amountKopecks > MAX_KOPECKS || !isIsoDateTime(item.updatedAt)) throw new Error(`Месячный план ${key}: некорректные данные`);
      monthlyPlans[key] = { monthKey: key, amountKopecks: item.amountKopecks, updatedAt: item.updatedAt };
    }
    const weeklyPlans = {};
    for (const [key, item] of Object.entries(source.weeklyPlans)) {
      if (!/^\d{4}-W\d{2}$/.test(key) || !isPlainObject(item) || item.weekKey !== key || !isValidDateKey(item.startDate) || startOfWeek(item.startDate) !== item.startDate || getIsoWeekInfo(item.startDate).weekKey !== key || !Number.isInteger(item.amountKopecks) || item.amountKopecks < 1 || item.amountKopecks > MAX_KOPECKS || !isIsoDateTime(item.updatedAt)) throw new Error(`Недельный план ${key}: некорректные данные`);
      weeklyPlans[key] = { weekKey: key, startDate: item.startDate, amountKopecks: item.amountKopecks, updatedAt: item.updatedAt };
    }
    const trash = source.trash.map((item, index) => {
      if (!isPlainObject(item) || !VALID_TRASH_TYPES.has(item.entityType) || !isIsoDateTime(item.deletedAt)) throw new Error(`Корзина ${index + 1}: некорректные данные`);
      const id = requireString(item.id, `Корзина ${index + 1}.id`, { min: 1 });
      const payload = item.entityType === "task" ? normalizeTaskRecord(item.payload, `Корзина ${index + 1}`) : item.entityType === "revenue" ? normalizeRevenueRecord(item.payload, `Корзина ${index + 1}`) : normalizeFollowUpRecord(item.payload, `Корзина ${index + 1}`);
      return { id, entityType: item.entityType, deletedAt: item.deletedAt, payload };
    });
    assertUniqueIds(trash, "Корзина");
    for (const type of VALID_TRASH_TYPES) assertUniqueIds(trash.filter((item) => item.entityType === type).map((item) => item.payload), `Корзина ${type}`);
    const settings = { activeSection: source.settings.activeSection, calendarView: source.settings.calendarView, selectedDate: source.settings.selectedDate, hideCompletedFollowUps: source.settings.hideCompletedFollowUps };
    if (!VALID_SECTIONS.has(settings.activeSection) || !VALID_VIEWS.has(settings.calendarView) || !isValidDateKey(settings.selectedDate) || typeof settings.hideCompletedFollowUps !== "boolean") throw new Error("Настройки резервной копии некорректны");
    return { schemaVersion: SCHEMA_VERSION, revision: source.revision, tasks, revenueEntries, monthlyPlans, weeklyPlans, followUps, trash, settings };
  }

  function parseBackupText(text) {
    if (typeof text !== "string") return { ok: false, error: "Файл не удалось прочитать" };
    if (new TextEncoder().encode(text).length > MAX_BACKUP_BYTES) return { ok: false, error: "Файл больше 5 МБ" };
    try { return { ok: true, value: normalizeImportedBackup(JSON.parse(text)) }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Некорректный JSON" }; }
  }

  function normalizeFollowUpInput(input) {
    const source = input && typeof input === "object" ? input : {};
    return { name: String(source.name ?? "").trim(), date: String(source.date ?? ""), time: String(source.time ?? ""), comment: String(source.comment ?? "").trim() || null, contactLabel: String(source.contactLabel ?? "").trim() || null, contactValue: String(source.contactValue ?? "").trim() || null };
  }

  function validateFollowUpInput(input) {
    const value = normalizeFollowUpInput(input); const errors = {};
    if (!value.name) errors.name = "Введите имя или обозначение"; else if (value.name.length > 120) errors.name = "Не больше 120 символов";
    if (!isValidDateKey(value.date)) errors.date = "Выберите корректную дату";
    if (!isValidTimeKey(value.time)) errors.time = "Выберите корректное время";
    if (value.comment && value.comment.length > 1000) errors.comment = "Не больше 1000 символов";
    if (value.contactLabel && value.contactLabel.length > 50) errors.contactLabel = "Не больше 50 символов";
    if (value.contactValue && value.contactValue.length > 500) errors.contactValue = "Не больше 500 символов";
    if (Boolean(value.contactLabel) !== Boolean(value.contactValue)) { if (!value.contactLabel) errors.contactLabel = "Добавьте короткую метку"; if (!value.contactValue) errors.contactValue = "Добавьте значение контакта"; }
    return { ok: Object.keys(errors).length === 0, value, errors };
  }

  function isFollowUpOverdue(item, today = getMoscowDateKey(), currentTime = getMoscowTimeKey()) { return Boolean(item && !item.completed && (item.date < today || (item.date === today && item.time < currentTime))); }
  function sortFollowUps(items, today = getMoscowDateKey(), currentTime = getMoscowTimeKey()) {
    const group = (item) => item.completed ? 3 : isFollowUpOverdue(item, today, currentTime) ? 0 : item.date === today ? 1 : 2;
    return [...items].sort((a, b) => { const order = group(a) - group(b); if (order) return order; if (group(a) === 3) return String(b.completedAt).localeCompare(String(a.completedAt)); return `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`) || String(a.createdAt).localeCompare(String(b.createdAt)); });
  }

  function moveFollowUpToTrashState(appState, followUpId, trashId, deletedAt) { const index = appState.followUps.findIndex((item) => item.id === followUpId); if (index < 0) return false; const [item] = appState.followUps.splice(index, 1); appState.trash.push({ id: trashId, entityType: "followUp", deletedAt, payload: cloneState(item) }); return true; }
  function restoreFollowUpFromTrashState(appState, trashId, replacementId = null) { const index = appState.trash.findIndex((item) => item.id === trashId && item.entityType === "followUp"); if (index < 0) return false; const restored = cloneState(appState.trash[index].payload); if (appState.followUps.some((item) => item.id === restored.id)) restored.id = replacementId; if (!restored.id) return false; appState.followUps.push(restored); appState.trash.splice(index, 1); return true; }

  function normalizeTaskInput(input) {
    const source = input && typeof input === "object" ? input : {};
    return {
      description: String(source.description ?? "").trim(),
      date: String(source.date ?? ""),
      time: String(source.time ?? "").trim() || null,
      priority: String(source.priority ?? "normal"),
      product: String(source.product ?? ""),
      customProduct: String(source.customProduct ?? "").trim() || null,
      status: String(source.status ?? "planned"),
      contactLabel: String(source.contactLabel ?? "").trim() || null,
      contactValue: String(source.contactValue ?? "").trim() || null,
    };
  }

  function validateTaskInput(input, { editing = false } = {}) {
    const value = normalizeTaskInput(input);
    const errors = {};
    if (!value.description) errors.description = "Введите описание задачи";
    else if (value.description.length > 500) errors.description = "Не больше 500 символов";
    if (!isValidDateKey(value.date)) errors.date = "Выберите корректную дату";
    if (value.time !== null && !isValidTimeKey(value.time)) errors.time = "Введите время в формате ЧЧ:ММ";
    if (!VALID_TASK_PRIORITIES.has(value.priority)) errors.priority = "Выберите приоритет";
    if (!VALID_TASK_PRODUCTS.has(value.product)) errors.product = "Выберите продукт";
    if (value.product === "other" && !value.customProduct) {
      errors.customProduct = "Введите название продукта";
    } else if (value.customProduct && value.customProduct.length > 80) {
      errors.customProduct = "Не больше 80 символов";
    }
    if (!editing && value.status !== "planned") errors.status = "Новая задача создаётся запланированной";
    if (editing && !VALID_TASK_STATUSES.has(value.status)) errors.status = "Выберите статус";
    if (value.contactLabel && value.contactLabel.length > 50) errors.contactLabel = "Не больше 50 символов";
    if (value.contactValue && value.contactValue.length > 500) errors.contactValue = "Не больше 500 символов";
    if (Boolean(value.contactLabel) !== Boolean(value.contactValue)) {
      if (!value.contactLabel) errors.contactLabel = "Добавьте короткую метку";
      if (!value.contactValue) errors.contactValue = "Добавьте значение контакта";
    }
    if (value.product !== "other") value.customProduct = null;
    return { ok: Object.keys(errors).length === 0, value, errors };
  }

  function sortTasks(tasks) {
    return [...tasks].sort((left, right) => {
      if (left.time === null && right.time !== null) return 1;
      if (left.time !== null && right.time === null) return -1;
      const timeOrder = String(left.time ?? "").localeCompare(String(right.time ?? ""));
      if (timeOrder !== 0) return timeOrder;
      return String(left.createdAt).localeCompare(String(right.createdAt));
    });
  }

  function isTaskOverdue(task, today = getMoscowDateKey(), currentTime = getMoscowTimeKey()) {
    if (!task || task.status !== "planned" || !isValidDateKey(task.date)) return false;
    if (task.date < today) return true;
    return task.date === today && task.time !== null && isValidTimeKey(task.time) && task.time < currentTime;
  }

  function moveTaskToTrashState(appState, taskId, trashId, deletedAt) {
    const index = appState.tasks.findIndex((task) => task.id === taskId);
    if (index < 0) return false;
    const [task] = appState.tasks.splice(index, 1);
    appState.trash.push({ id: trashId, entityType: "task", deletedAt, payload: cloneState(task) });
    return true;
  }

  function restoreTaskFromTrashState(appState, trashId, replacementId = null) {
    const index = appState.trash.findIndex((item) => item.id === trashId && item.entityType === "task");
    if (index < 0) return false;
    const restored = cloneState(appState.trash[index].payload);
    if (appState.tasks.some((task) => task.id === restored.id)) restored.id = replacementId;
    if (!restored.id) return false;
    appState.tasks.push(restored);
    appState.trash.splice(index, 1);
    return true;
  }

  function normalizeRevenueInput(input) {
    const source = input && typeof input === "object" ? input : {};
    return {
      amount: String(source.amount ?? "").trim(),
      product: String(source.product ?? ""),
      customProduct: String(source.customProduct ?? "").trim() || null,
      status: String(source.status ?? "expected"),
      expectedDate: String(source.expectedDate ?? "").trim() || null,
      receivedDate: String(source.receivedDate ?? "").trim() || null,
      comment: String(source.comment ?? "").trim() || null,
    };
  }

  function validateRevenueInput(input, { editing = false, today = getMoscowDateKey() } = {}) {
    const source = normalizeRevenueInput(input);
    const errors = {};
    const money = parseMoneyToKopecks(source.amount);
    if (!money.ok) errors.amount = money.error;
    if (!VALID_TASK_PRODUCTS.has(source.product)) errors.product = "Выберите продукт";
    if (source.product === "other" && !source.customProduct) errors.customProduct = "Введите название продукта";
    if (source.customProduct && source.customProduct.length > 80) errors.customProduct = "Не больше 80 символов";
    if (!VALID_REVENUE_STATUSES.has(source.status) || (!editing && source.status === "cancelled")) {
      errors.status = editing ? "Выберите статус" : "Новую оплату нельзя сразу отменить";
    }
    if (source.status === "expected") {
      if (!isValidDateKey(source.expectedDate)) errors.expectedDate = "Выберите ожидаемую дату";
      source.receivedDate = null;
    }
    if (source.status === "received") {
      if (!isValidDateKey(source.receivedDate)) errors.receivedDate = "Укажите фактическую дату вручную";
      else if (source.receivedDate > today) errors.receivedDate = "Фактическая дата не может быть в будущем";
    }
    if (source.status === "cancelled") {
      if (source.expectedDate && !isValidDateKey(source.expectedDate)) errors.expectedDate = "Некорректная ожидаемая дата";
      if (source.receivedDate && !isValidDateKey(source.receivedDate)) errors.receivedDate = "Некорректная фактическая дата";
    }
    if (source.comment && source.comment.length > 500) errors.comment = "Не больше 500 символов";
    if (source.product !== "other") source.customProduct = null;
    const value = {
      amountKopecks: money.ok ? money.value : null,
      product: source.product,
      customProduct: source.customProduct,
      status: source.status,
      expectedDate: source.expectedDate,
      receivedDate: source.receivedDate,
      comment: source.comment,
    };
    return { ok: Object.keys(errors).length === 0, value, errors };
  }

  function getRevenueRelevantDate(entry) {
    if (!entry) return null;
    if (entry.status === "received") return entry.receivedDate;
    if (entry.status === "expected") return entry.expectedDate;
    if (entry.receivedDate) return entry.receivedDate;
    if (entry.expectedDate) return entry.expectedDate;
    const created = new Date(entry.createdAt);
    return Number.isNaN(created.getTime()) ? null : getMoscowDateKey(created);
  }

  function sortRevenueEntries(entries) {
    return [...entries].sort((left, right) => {
      const statusOrder = (REVENUE_STATUS_ORDER[left.status] ?? 99) - (REVENUE_STATUS_ORDER[right.status] ?? 99);
      if (statusOrder !== 0) return statusOrder;
      return String(right.createdAt).localeCompare(String(left.createdAt));
    });
  }

  function isRevenueOverdue(entry, today = getMoscowDateKey()) {
    return Boolean(entry && entry.status === "expected" && isValidDateKey(entry.expectedDate) && entry.expectedDate < today);
  }

  function calculateDayMetrics(entries, dateKey) {
    return {
      factKopecks: calculateFact(entries, dateKey, dateKey),
      expectationKopecks: calculateExpectation(entries, dateKey, dateKey),
    };
  }

  function calculateWeekMetrics(entries, dateKey, planKopecks = null) {
    const startKey = startOfWeek(dateKey);
    const endKey = endOfWeek(dateKey);
    const factKopecks = calculateFact(entries, startKey, endKey);
    return {
      startKey,
      endKey,
      planKopecks,
      factKopecks,
      expectationKopecks: calculateExpectation(entries, startKey, endKey),
      completion: calculateCompletion(factKopecks, planKopecks),
    };
  }

  function calculateMonthMetrics(entries, dateKey, today = getMoscowDateKey(), planKopecks = null) {
    const monthKey = getMonthKey(dateKey);
    const currentMonthKey = getMonthKey(today);
    const startKey = `${monthKey}-01`;
    const endKey = endOfMonth(dateKey);
    let factEndKey = endKey;
    if (monthKey === currentMonthKey) factEndKey = today;
    const factKopecks = monthKey > currentMonthKey ? 0 : calculateFact(entries, startKey, factEndKey);
    const expectationKopecks = calculateExpectation(entries, startKey, endKey);
    const runRateKopecks = monthKey === currentMonthKey
      ? calculateRunRate(factKopecks, Number(today.slice(8, 10)), daysInMonth(today))
      : null;
    return {
      monthKey,
      startKey,
      endKey,
      factEndKey,
      planKopecks,
      factKopecks,
      expectationKopecks,
      completion: calculateCompletion(factKopecks, planKopecks),
      runRateKopecks,
      isCurrentMonth: monthKey === currentMonthKey,
    };
  }

  function moveRevenueToTrashState(appState, revenueId, trashId, deletedAt) {
    const index = appState.revenueEntries.findIndex((entry) => entry.id === revenueId);
    if (index < 0) return false;
    const [entry] = appState.revenueEntries.splice(index, 1);
    appState.trash.push({ id: trashId, entityType: "revenue", deletedAt, payload: cloneState(entry) });
    return true;
  }

  function restoreRevenueFromTrashState(appState, trashId, replacementId = null) {
    const index = appState.trash.findIndex((item) => item.id === trashId && item.entityType === "revenue");
    if (index < 0) return false;
    const restored = cloneState(appState.trash[index].payload);
    if (appState.revenueEntries.some((entry) => entry.id === restored.id)) restored.id = replacementId;
    if (!restored.id) return false;
    appState.revenueEntries.push(restored);
    appState.trash.splice(index, 1);
    return true;
  }

  const core = Object.freeze({
    STORAGE_KEY,
    SCHEMA_VERSION,
    MOSCOW_TIME_ZONE,
    MAX_KOPECKS,
    getMoscowParts,
    getMoscowDateKey,
    getMoscowTimeKey,
    parseDateKey,
    isValidDateKey,
    addDays,
    shiftMonth,
    startOfWeek,
    endOfWeek,
    getMonthKey,
    startOfMonth,
    endOfMonth,
    daysInMonth,
    getIsoWeekInfo,
    isDateInRange,
    parseMoneyToKopecks,
    formatKopecks,
    calculateFact,
    calculateExpectation,
    calculateCompletion,
    calculateRunRate,
    createInitialState,
    isValidAppState,
    cloneState,
    inspectStoredState,
    persistWithRevision,
    serializeBackup,
    isIsoDateTime,
    normalizeImportedBackup,
    parseBackupText,
    isValidTimeKey,
    normalizeTaskInput,
    validateTaskInput,
    sortTasks,
    isTaskOverdue,
    moveTaskToTrashState,
    restoreTaskFromTrashState,
    normalizeRevenueInput,
    validateRevenueInput,
    getRevenueRelevantDate,
    sortRevenueEntries,
    isRevenueOverdue,
    calculateDayMetrics,
    calculateWeekMetrics,
    calculateMonthMetrics,
    moveRevenueToTrashState,
    restoreRevenueFromTrashState,
    normalizeFollowUpInput,
    validateFollowUpInput,
    isFollowUpOverdue,
    sortFollowUps,
    moveFollowUpToTrashState,
    restoreFollowUpFromTrashState,
  });

  if (typeof module !== "undefined" && module.exports) module.exports = core;
  if (globalScope && typeof globalScope === "object") globalScope.QuietPaceCore = core;
  if (typeof document === "undefined") return;

  let state = createInitialState();
  let baseRevision = 0;
  let dirty = false;
  let corruptRaw = null;
  let pendingRemoteState = null;
  let resizeFrame = null;
  let draggingTaskId = null;
  let pendingImportedState = null;
  let pendingDataOperation = null;
  const dialogTriggers = new WeakMap();

  const elements = {};

  function getBrowserStorage() {
    try {
      return window.localStorage;
    } catch (error) {
      return {
        getItem() {
          throw error;
        },
        setItem() {
          throw error;
        },
      };
    }
  }

  function cacheElements() {
    elements.plannerSection = document.querySelector("#planner-section");
    elements.clientsSection = document.querySelector("#clients-section");
    elements.plannerHeading = document.querySelector("#planner-heading");
    elements.periodTitle = document.querySelector("#period-title");
    elements.periodCaption = document.querySelector("#period-caption");
    elements.plannerSurface = document.querySelector("#planner-surface");
    elements.storageWarning = document.querySelector("#storage-warning");
    elements.storageWarningText = document.querySelector("#storage-warning-text");
    elements.conflictWarning = document.querySelector("#conflict-warning");
    elements.toastRegion = document.querySelector("#toast-region");
    elements.settingsDialog = document.querySelector("#settings-dialog");
    elements.recoveryDialog = document.querySelector("#recovery-dialog");
    elements.taskDialog = document.querySelector("#task-dialog");
    elements.taskForm = document.querySelector("#task-form");
    elements.taskErrorSummary = document.querySelector("#task-error-summary");
    elements.customProductField = document.querySelector("#custom-product-field");
    elements.taskStatusField = document.querySelector("#task-status-field");
    elements.taskDelete = document.querySelector("#task-delete");
    elements.overdueTasks = document.querySelector("#overdue-tasks");
    elements.overdueCount = document.querySelector("#overdue-count");
    elements.overdueList = document.querySelector("#overdue-list");
    elements.taskTrashList = document.querySelector("#task-trash-list");
    elements.revenueTrashList = document.querySelector("#revenue-trash-list");
    elements.followUpTrashList = document.querySelector("#follow-up-trash-list");
    elements.followUpList = document.querySelector("#follow-up-list");
    elements.hideCompletedFollowUps = document.querySelector("#hide-completed-follow-ups");
    elements.followUpDialog = document.querySelector("#follow-up-dialog");
    elements.followUpForm = document.querySelector("#follow-up-form");
    elements.followUpErrorSummary = document.querySelector("#follow-up-error-summary");
    elements.followUpDelete = document.querySelector("#follow-up-delete");
    elements.importFileInput = document.querySelector("#import-file-input");
    elements.dataConfirmDialog = document.querySelector("#data-confirm-dialog");
    elements.dataConfirmTitle = document.querySelector("#data-confirm-title");
    elements.dataConfirmMessage = document.querySelector("#data-confirm-message");
    elements.dataOperationError = document.querySelector("#data-operation-error");
    elements.continueWithoutBackup = document.querySelector("#continue-without-backup");
    elements.overdueRevenue = document.querySelector("#overdue-revenue");
    elements.overdueRevenueCount = document.querySelector("#overdue-revenue-count");
    elements.overdueRevenueList = document.querySelector("#overdue-revenue-list");
    elements.financialSummary = document.querySelector("#financial-summary");
    elements.revenueDialog = document.querySelector("#revenue-dialog");
    elements.revenueForm = document.querySelector("#revenue-form");
    elements.revenueErrorSummary = document.querySelector("#revenue-error-summary");
    elements.revenueCustomProductField = document.querySelector("#revenue-custom-product-field");
    elements.revenueExpectedDateField = document.querySelector("#revenue-expected-date-field");
    elements.revenueReceivedDateField = document.querySelector("#revenue-received-date-field");
    elements.revenueDelete = document.querySelector("#revenue-delete");
    elements.planDialog = document.querySelector("#plan-dialog");
    elements.planForm = document.querySelector("#plan-form");
    elements.planErrorSummary = document.querySelector("#plan-error-summary");
    elements.planReset = document.querySelector("#plan-reset");
  }

  function setText(node, value) {
    if (node) node.textContent = String(value ?? "");
    return node;
  }

  function createElement(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) setText(node, text);
    return node;
  }

  function showToast(message) {
    const toast = createElement("div", "toast", message);
    toast.setAttribute("role", "status");
    elements.toastRegion.append(toast);
    window.setTimeout(() => toast.remove(), 3200);
  }

  function setDirty(value, message = "Браузер не смог записать данные.") {
    dirty = value;
    elements.storageWarning.hidden = !value;
    setText(elements.storageWarningText, message);
  }

  function showConflict(remoteState = null) {
    if (remoteState) pendingRemoteState = remoteState;
    elements.conflictWarning.hidden = false;
  }

  function hideConflict() {
    elements.conflictWarning.hidden = true;
    pendingRemoteState = null;
  }

  function saveCurrentState() {
    if (corruptRaw !== null) {
      setDirty(true, "Сначала решите, что делать с повреждёнными локальными данными.");
      return false;
    }
    const result = persistWithRevision(getBrowserStorage(), state, baseRevision);
    if (result.ok) {
      state = result.state;
      baseRevision = result.baseRevision;
      setDirty(false);
      hideConflict();
      return true;
    }
    if (result.reason === "conflict") {
      setDirty(true, "Локальная версия не сохранена: данные изменились в другой вкладке.");
      showConflict(result.remoteState);
      return false;
    }
    if (result.reason === "corrupt") {
      setDirty(true, "Сохранённые данные имеют неизвестный или повреждённый формат.");
      return false;
    }
    setDirty(true, "Браузер не смог записать данные. Повторите попытку или скачайте копию.");
    return false;
  }

  function updateState(mutator, successMessage = "") {
    const next = cloneState(state);
    mutator(next);
    state = next;
    const saved = saveCurrentState();
    render();
    if (saved && successMessage) showToast(successMessage);
    return saved;
  }

  function writeInitialState(initialState) {
    try {
      getBrowserStorage().setItem(STORAGE_KEY, JSON.stringify(initialState));
      state = initialState;
      baseRevision = initialState.revision;
      setDirty(false);
      return true;
    } catch (error) {
      state = initialState;
      baseRevision = 0;
      setDirty(true, "Начальное состояние работает в памяти, но браузер не смог его сохранить.");
      return false;
    }
  }

  function loadInitialState() {
    const snapshot = inspectStoredState(getBrowserStorage());
    if (snapshot.status === "valid") {
      state = snapshot.state;
      baseRevision = state.revision;
      return;
    }
    if (snapshot.status === "missing") {
      writeInitialState(createInitialState());
      return;
    }
    if (snapshot.status === "error") {
      state = createInitialState();
      baseRevision = 0;
      setDirty(
        true,
        "Локальное хранилище недоступно. Данные работают в памяти — повторите сохранение или скачайте копию.",
      );
      return;
    }
    state = createInitialState();
    baseRevision = 0;
    corruptRaw = snapshot.raw ?? "";
    setDirty(true, "Локальные данные повреждены и не были перезаписаны.");
    window.setTimeout(() => openDialog(elements.recoveryDialog), 0);
  }

  function getDateObject(dateKey) {
    return parseDateKey(dateKey);
  }

  function formatDate(dateKey, options) {
    return new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", ...options }).format(
      getDateObject(dateKey),
    );
  }

  function capitalize(value) {
    return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
  }

  function formatWeekRange(dateKey) {
    const start = startOfWeek(dateKey);
    const end = endOfWeek(dateKey);
    const startDate = getDateObject(start);
    const endDate = getDateObject(end);
    if (start.slice(0, 7) === end.slice(0, 7)) {
      return `${startDate.getUTCDate()}–${endDate.getUTCDate()} ${formatDate(end, {
        month: "long",
        year: "numeric",
      })}`;
    }
    return `${formatDate(start, { day: "numeric", month: "short" })} — ${formatDate(end, {
      day: "numeric",
      month: "short",
      year: "numeric",
    })}`;
  }

  function buildEmptyState(title, description) {
    const container = createElement("div", "empty-state");
    const symbol = createElement("span", "empty-state__symbol");
    symbol.setAttribute("aria-hidden", "true");
    symbol.append(createIcon("leaf"));
    container.append(symbol, createElement("h2", "", title), createElement("p", "", description));
    return container;
  }

  function createIcon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const paths = {
      plus: "M12 5v14M5 12h14",
      copy: "M8 8h10v10H8zM6 16H4V4h12v2",
      trash: "M5 7h14M9 7V5h6v2M8 10v7M12 10v7M16 10v7M7 7l1 13h8l1-13",
      grip: "M9 7h.01M15 7h.01M9 12h.01M15 12h.01M9 17h.01M15 17h.01",
      leaf: "M19 4C11 4 6 8 6 15c0 2 1 4 3 5 1-6 5-10 10-12M6 20c3-5 7-8 13-9",
    };
    path.setAttribute("d", paths[name] || paths.plus);
    svg.append(path);
    return svg;
  }

  function taskProductLabel(task) {
    return task.product === "other" ? task.customProduct : TASK_PRODUCT_LABELS[task.product];
  }

  function tasksForDate(dateKey) {
    return sortTasks(state.tasks.filter((task) => task.date === dateKey));
  }

  function makeActionButton(label, action, taskId, iconName, className = "task-action") {
    const button = createElement("button", className);
    button.type = "button";
    button.dataset.action = action;
    button.dataset.taskId = taskId;
    button.setAttribute("aria-label", label);
    button.title = label;
    if (iconName) button.append(createIcon(iconName));
    else setText(button, label);
    return button;
  }

  function buildTaskCard(task, { compact = false, showDate = false } = {}) {
    const card = createElement("article", `task-card task-card--${task.status} priority--${task.priority}`);
    card.dataset.taskId = task.id;
    if (compact) card.classList.add("task-card--compact");
    if (isTaskOverdue(task)) card.classList.add("is-overdue");

    const controls = createElement("div", "task-card__leading");
    const check = createElement("input", "task-card__check");
    check.type = "checkbox";
    check.checked = task.status === "completed";
    check.disabled = task.status === "cancelled";
    check.dataset.action = "toggle-task";
    check.dataset.taskId = task.id;
    check.setAttribute("aria-label", check.checked ? "Вернуть задачу в запланированные" : "Отметить задачу выполненной");
    controls.append(check);
    if (task.status === "planned" && window.matchMedia("(min-width: 960px)").matches) {
      const handle = makeActionButton("Перетащить задачу", "drag-task", task.id, "grip", "task-action task-drag-handle");
      handle.draggable = true;
      controls.append(handle);
    }

    const body = createElement("button", "task-card__body");
    body.type = "button";
    body.dataset.action = "edit-task";
    body.dataset.taskId = task.id;
    body.title = task.description;
    const top = createElement("span", "task-card__topline");
    top.append(
      createElement("span", "task-card__time", showDate ? formatDate(task.date, { day: "numeric", month: "short" }) : task.time || "Без времени"),
      createElement("span", `priority-label priority-label--${task.priority}`, TASK_PRIORITY_LABELS[task.priority]),
    );
    const description = createElement("span", "task-card__description", task.description);
    const meta = createElement("span", "task-card__meta");
    meta.append(createElement("span", "product-label", taskProductLabel(task)));
    if (task.status === "cancelled") meta.append(createElement("span", "status-label", "Отменено"));
    if (task.status === "completed") meta.append(createElement("span", "status-label", "Выполнено"));
    if (isTaskOverdue(task)) meta.append(createElement("span", "status-label status-label--danger", "Просрочено"));
    body.append(top, description, meta);

    const actions = createElement("div", "task-card__actions");
    if (task.contactLabel && task.contactValue) {
      const contact = createElement("button", "contact-chip", task.contactLabel);
      contact.type = "button";
      contact.dataset.action = "reveal-contact";
      contact.dataset.taskId = task.id;
      contact.setAttribute("aria-expanded", "false");
      contact.setAttribute("aria-label", `Показать контакт ${task.contactLabel}`);
      const tooltip = createElement("span", "contact-tooltip", task.contactValue);
      tooltip.setAttribute("role", "tooltip");
      contact.append(tooltip);
      actions.append(contact, makeActionButton("Копировать контакт", "copy-contact", task.id, "copy"));
    }
    actions.append(makeActionButton("Переместить задачу в корзину", "delete-task", task.id, "trash", "task-action task-action--danger"));
    card.append(controls, body, actions);
    return card;
  }

  function buildTaskList(dateKey, { compact = false } = {}) {
    const tasks = tasksForDate(dateKey);
    const wrap = createElement("div", "task-list");
    const timed = tasks.filter((task) => task.time !== null);
    const timeless = tasks.filter((task) => task.time === null);
    if (timed.length) {
      const list = createElement("div", "task-list__group");
      for (const task of timed) list.append(buildTaskCard(task, { compact }));
      wrap.append(list);
    }
    if (timeless.length) {
      wrap.append(createElement("h3", "task-list__label", "Без времени"));
      const list = createElement("div", "task-list__group");
      for (const task of timeless) list.append(buildTaskCard(task, { compact }));
      wrap.append(list);
    }
    return { node: wrap, count: tasks.length };
  }

  function revenueProductLabel(entry) {
    return entry.product === "other" ? entry.customProduct : TASK_PRODUCT_LABELS[entry.product];
  }

  function revenueStatusLabel(status) {
    return { received: "Получено", expected: "Ожидается", cancelled: "Отменено" }[status] || status;
  }

  function revenueForDate(dateKey) {
    return sortRevenueEntries(state.revenueEntries.filter((entry) => getRevenueRelevantDate(entry) === dateKey));
  }

  function buildRevenueCard(entry) {
    const card = createElement("article", `revenue-entry revenue-entry--${entry.status}`);
    const body = createElement("button", "revenue-entry__body");
    body.type = "button";
    body.dataset.action = "edit-revenue";
    body.dataset.revenueId = entry.id;
    const heading = createElement("span", "revenue-entry__heading");
    heading.append(
      createElement("strong", "revenue-entry__amount", formatKopecks(entry.amountKopecks)),
      createElement("span", `status-label revenue-status--${entry.status}`, revenueStatusLabel(entry.status)),
    );
    const meta = createElement("span", "revenue-entry__meta");
    meta.append(createElement("span", "product-label", revenueProductLabel(entry)));
    const relevantDate = getRevenueRelevantDate(entry);
    if (relevantDate) meta.append(createElement("span", "revenue-entry__date", formatDate(relevantDate, { day: "numeric", month: "short" })));
    body.append(heading, meta);
    if (entry.comment) {
      const comment = createElement("span", "revenue-entry__comment", entry.comment);
      comment.title = entry.comment;
      body.append(comment);
    }
    const remove = makeActionButton("Переместить оплату в корзину", "delete-revenue", entry.id, "trash", "task-action task-action--danger");
    remove.dataset.revenueId = entry.id;
    delete remove.dataset.taskId;
    card.append(body, remove);
    return card;
  }

  function buildRevenueList(dateKey) {
    const entries = revenueForDate(dateKey);
    const wrap = createElement("section", "revenue-list");
    if (!entries.length) return { node: wrap, count: 0 };
    wrap.append(createElement("h2", "section-heading", "Оплаты дня"));
    for (const status of ["received", "expected", "cancelled"]) {
      const groupEntries = entries.filter((entry) => entry.status === status);
      if (!groupEntries.length) continue;
      const group = createElement("div", "revenue-list__group");
      group.append(createElement("h3", "revenue-list__label", revenueStatusLabel(status)));
      for (const entry of groupEntries) group.append(buildRevenueCard(entry));
      wrap.append(group);
    }
    return { node: wrap, count: entries.length };
  }

  function buildDailyFinance(dateKey, compact = false) {
    const metrics = calculateDayMetrics(state.revenueEntries, dateKey);
    const row = createElement(compact ? "span" : "div", compact ? "daily-finance daily-finance--compact" : "daily-finance");
    row.setAttribute("aria-label", `Факт ${formatKopecks(metrics.factKopecks)}, ожидание ${formatKopecks(metrics.expectationKopecks)}`);
    if (compact) {
      const fact = createElement("span", "daily-finance__fact");
      fact.append(createElement("span", "daily-finance__label", "Факт"), createElement("span", "daily-finance__value", formatKopecks(metrics.factKopecks).replace(/[\u00a0\u202f]/g, " ")));
      const expectation = createElement("span", "daily-finance__expectation");
      expectation.append(createElement("span", "daily-finance__label", "Ожидание"), createElement("span", "daily-finance__value", formatKopecks(metrics.expectationKopecks).replace(/[\u00a0\u202f]/g, " ")));
      row.append(fact, expectation);
    } else {
      row.append(createElement("span", "daily-finance__fact", `Факт ${formatKopecks(metrics.factKopecks)}`), createElement("span", "daily-finance__expectation", `Ожидание ${formatKopecks(metrics.expectationKopecks)}`));
    }
    return row;
  }

  function formatPercent(value) {
    if (value === null || !Number.isFinite(value)) return "План не задан";
    const rounded = Math.round(value * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1).replace(".", ",")}%`;
  }

  function buildMetric(label, value, detail = "") {
    const item = createElement("div", "finance-metric");
    item.append(createElement("span", "finance-metric__label", label), createElement("strong", "finance-metric__value", value));
    if (detail) item.append(createElement("span", "finance-metric__detail", detail));
    return item;
  }

  function buildProgressBars(planKopecks, factKopecks, compact = false) {
    const bars = createElement("div", compact ? "finance-bars finance-bars--compact" : "finance-bars");
    const planRow = createElement("div", "finance-bar");
    const planHead = createElement("div", "finance-bar__head");
    planHead.append(createElement("span", "", "План"), createElement("strong", "", planKopecks ? formatKopecks(planKopecks) : "План не задан"));
    const planTrack = createElement("div", "finance-bar__track");
    const planFill = createElement("span", "finance-bar__fill finance-bar__fill--plan");
    planFill.style.width = planKopecks ? "100%" : "0%";
    planTrack.append(planFill);
    planRow.append(planHead, planTrack);

    const factRow = createElement("div", "finance-bar");
    const factHead = createElement("div", "finance-bar__head");
    factHead.append(createElement("span", "", "Факт"), createElement("strong", "", formatKopecks(factKopecks)));
    const factTrack = createElement("div", "finance-bar__track");
    const factFill = createElement("span", "finance-bar__fill finance-bar__fill--fact");
    const ratio = planKopecks ? (factKopecks / planKopecks) * 100 : 0;
    factFill.style.width = `${Math.max(0, Math.min(100, ratio))}%`;
    factTrack.append(factFill);
    factRow.append(factHead, factTrack);
    if (ratio > 100) factRow.append(createElement("span", "finance-bar__excess", `Превышение плана на ${formatPercent(ratio - 100)}`));
    bars.append(planRow, factRow);
    return bars;
  }

  function buildPlanButton(type, exists) {
    const emptyLabel = type === "month" ? "Установить план месяца" : "Задать план недели";
    const button = createElement("button", "button button--secondary", exists ? "Изменить план" : emptyLabel);
    button.type = "button";
    button.dataset.action = "open-plan";
    button.dataset.planType = type;
    return button;
  }

  function buildMonthSummary() {
    const selected = state.settings.selectedDate;
    const monthKey = getMonthKey(selected);
    const plan = state.monthlyPlans[monthKey]?.amountKopecks ?? null;
    const metrics = calculateMonthMetrics(state.revenueEntries, selected, getMoscowDateKey(), plan);
    const card = createElement("article", "summary-card summary-card--primary summary-card--finance");
    const header = createElement("div", "summary-card__header");
    const title = createElement("div");
    title.append(createElement("p", "summary-card__label", "Месяц · основной ориентир"), createElement("h2", "", capitalize(formatDate(`${monthKey}-01`, { month: "long", year: "numeric" }))));
    header.append(title, buildPlanButton("month", Boolean(plan)));
    const metricsGrid = createElement("div", "finance-metrics");
    metricsGrid.append(
      buildMetric("План", plan ? formatKopecks(plan) : "План не задан"),
      buildMetric("Факт", formatKopecks(metrics.factKopecks)),
      buildMetric("Выполнение", formatPercent(metrics.completion)),
    );
    metricsGrid.append(
      metrics.isCurrentMonth
        ? buildMetric("Ранрейт", formatKopecks(metrics.runRateKopecks), "По календарным дням")
        : buildMetric("Ранрейт", "—", "Только для текущего месяца"),
    );
    metricsGrid.append(buildMetric("Ожидание", formatKopecks(metrics.expectationKopecks)));
    card.append(header, metricsGrid, buildProgressBars(plan, metrics.factKopecks));
    return card;
  }

  function buildWeekSummary() {
    const selected = state.settings.selectedDate;
    const info = getIsoWeekInfo(selected);
    const plan = state.weeklyPlans[info.weekKey]?.amountKopecks ?? null;
    const metrics = calculateWeekMetrics(state.revenueEntries, selected, plan);
    const card = createElement("article", "summary-card summary-card--finance summary-card--week");
    const header = createElement("div", "summary-card__header");
    const title = createElement("div");
    title.append(createElement("p", "summary-card__label", "Неделя · дополнительный ориентир"), createElement("h2", "", formatWeekRange(selected)));
    header.append(title, buildPlanButton("week", Boolean(plan)));
    const metricsGrid = createElement("div", "finance-metrics finance-metrics--compact");
    metricsGrid.append(
      buildMetric("План", plan ? formatKopecks(plan) : "План не задан"),
      buildMetric("Факт", formatKopecks(metrics.factKopecks)),
      buildMetric("Выполнение", formatPercent(metrics.completion)),
      buildMetric("Ожидание", formatKopecks(metrics.expectationKopecks)),
    );
    card.append(header, metricsGrid, buildProgressBars(plan, metrics.factKopecks, true));
    return card;
  }

  function buildDaySummary() {
    const dateKey = state.settings.selectedDate;
    const metrics = calculateDayMetrics(state.revenueEntries, dateKey);
    const card = createElement("article", "summary-card summary-card--day summary-card--finance");
    const header = createElement("div", "summary-card__header");
    const title = createElement("div");
    title.append(createElement("p", "summary-card__label", "День"), createElement("h2", "", capitalize(formatDate(dateKey, { day: "numeric", month: "long" }))));
    header.append(title);
    const metricsGrid = createElement("div", "finance-metrics finance-metrics--day");
    metricsGrid.append(buildMetric("Факт", formatKopecks(metrics.factKopecks)), buildMetric("Ожидание", formatKopecks(metrics.expectationKopecks)));
    card.append(header, metricsGrid);
    return card;
  }

  function renderFinancialSummary() {
    const view = state.settings.calendarView;
    if (view === "day") {
      elements.financialSummary.className = "summary-grid summary-grid--day";
      elements.financialSummary.replaceChildren(buildDaySummary());
      return;
    }
    if (view === "month") {
      elements.financialSummary.className = "summary-grid summary-grid--month";
      elements.financialSummary.replaceChildren(buildMonthSummary());
      return;
    }
    elements.financialSummary.className = "summary-grid";
    elements.financialSummary.replaceChildren(buildMonthSummary(), buildWeekSummary());
  }

  function buildAddTaskButton(dateKey, compact = false) {
    const button = createElement("button", compact ? "day-add day-add--compact" : "button button--primary", compact ? "" : "Новая задача");
    button.type = "button";
    button.dataset.action = "new-task";
    button.dataset.date = dateKey;
    button.setAttribute("aria-label", `Добавить задачу на ${formatDate(dateKey, { dateStyle: "long" })}`);
    if (compact) button.append(createIcon("plus"));
    return button;
  }

  function buildGettingStarted() {
    const actions = [];
    const selected = state.settings.selectedDate;
    const monthKey = getMonthKey(selected);
    if (!state.tasks.length) {
      const taskButton = createElement("button", "button button--primary", "Добавить первую задачу");
      taskButton.type = "button";
      taskButton.dataset.action = "new-task";
      taskButton.dataset.date = selected;
      actions.push(taskButton);
    }
    if (!state.monthlyPlans[monthKey]) {
      const planButton = createElement("button", "button button--secondary", "Установить план месяца");
      planButton.type = "button";
      planButton.dataset.action = "open-plan";
      planButton.dataset.planType = "month";
      actions.push(planButton);
    }
    if (!state.revenueEntries.some((entry) => entry.status === "expected")) {
      const revenueButton = createElement("button", "button button--secondary", "Добавить ожидаемую оплату");
      revenueButton.type = "button";
      revenueButton.dataset.action = "new-revenue";
      revenueButton.dataset.date = selected;
      actions.push(revenueButton);
    }
    if (!actions.length) return null;
    const empty = buildEmptyState("Начните с главного", "Эти подсказки исчезнут по мере заполнения планировщика.");
    empty.classList.add("empty-state--getting-started");
    const actionBar = createElement("div", "empty-state__actions");
    actionBar.append(...actions);
    empty.append(actionBar);
    return empty;
  }

  function buildWeekDay(dateKey, index, mobile) {
    const day = createElement("article", "calendar-day calendar-day--week");
    day.dataset.dropDate = dateKey;
    if (dateKey === getMoscowDateKey()) day.classList.add("is-today");
    if (dateKey === state.settings.selectedDate) day.classList.add("is-selected");
    const header = createElement("div", "calendar-day__header");
    const button = createElement("button", "calendar-day__button");
    button.type = "button";
    button.dataset.date = dateKey;
    button.dataset.calendarVariant = "week";
    button.setAttribute("aria-label", `${mobile ? "Выбрать" : "Открыть"} ${formatDate(dateKey, { dateStyle: "long" })}`);
    button.append(
      createElement("span", "calendar-day__weekday", WEEKDAY_SHORT[index]),
      createElement("span", "calendar-day__date", String(getDateObject(dateKey).getUTCDate())),
    );
    header.append(button, buildAddTaskButton(dateKey, true));
    day.append(header, buildDailyFinance(dateKey, true));
    if (!mobile) {
      const list = buildTaskList(dateKey, { compact: true });
      if (list.count) day.append(list.node);
      else day.append(createElement("p", "calendar-day__empty", "Задач пока нет"));
    }
    return day;
  }

  function renderDayView() {
    const selected = state.settings.selectedDate;
    const view = createElement("div", "day-view");
    const heading = createElement("div", "day-view__heading");
    const titleWrap = createElement("div");
    titleWrap.append(
      createElement("h2", "", selected === getMoscowDateKey() ? "Сегодня" : capitalize(formatDate(selected, { weekday: "long" }))),
      createElement("div", "day-view__date", capitalize(formatDate(selected, { day: "numeric", month: "long", year: "numeric" }))),
    );
    const headingActions = createElement("div", "day-view__actions");
    headingActions.append(buildAddTaskButton(selected));
    heading.append(titleWrap, headingActions);
    view.append(heading);
    const list = buildTaskList(selected);
    if (list.count) view.append(list.node);
    else {
      const empty = buildEmptyState("День свободен", "Добавьте первую задачу — со временем или без него.");
      empty.append(buildAddTaskButton(selected));
      view.append(empty);
    }
    const revenueList = buildRevenueList(selected);
    if (revenueList.count) view.append(revenueList.node);
    elements.plannerSurface.replaceChildren(view);
  }

  function renderWeekView() {
    const start = startOfWeek(state.settings.selectedDate);
    const mobile = window.matchMedia("(max-width: 959px)").matches;
    const grid = createElement("div", "calendar-grid calendar-grid--week");
    for (let index = 0; index < 7; index += 1) grid.append(buildWeekDay(addDays(start, index), index, mobile));
    const children = [];
    const gettingStarted = buildGettingStarted();
    if (gettingStarted) children.push(gettingStarted);
    children.push(grid);
    if (mobile) {
      const selectedPanel = createElement("section", "mobile-selected-day");
      const heading = createElement("div", "day-view__heading");
      const title = createElement("div");
      title.append(
        createElement("h2", "", capitalize(formatDate(state.settings.selectedDate, { weekday: "long" }))),
        createElement("div", "day-view__date", formatDate(state.settings.selectedDate, { day: "numeric", month: "long" })),
      );
      const headingActions = createElement("div", "mobile-selected-day__actions");
      headingActions.append(buildAddTaskButton(state.settings.selectedDate), createElement("button", "button button--secondary", "Открыть день"));
      headingActions.lastElementChild.type = "button";
      headingActions.lastElementChild.dataset.action = "open-selected-day";
      heading.append(title, headingActions);
      selectedPanel.append(heading, buildDailyFinance(state.settings.selectedDate));
      const list = buildTaskList(state.settings.selectedDate);
      if (list.count) selectedPanel.append(list.node);
      else selectedPanel.append(buildEmptyState("В выбранный день пока пусто", "Выберите другую дату или добавьте задачу."));
      children.push(selectedPanel);
    }
    elements.plannerSurface.replaceChildren(...children);
  }

  function buildMonthDay(dateKey, outside) {
    const day = createElement("button", "calendar-day calendar-day--month");
    day.type = "button";
    day.dataset.date = dateKey;
    day.dataset.calendarVariant = "month";
    if (outside) day.classList.add("is-outside");
    if (dateKey === getMoscowDateKey()) day.classList.add("is-today");
    const plannedCount = state.tasks.filter((task) => task.date === dateKey && task.status === "planned").length;
    day.setAttribute("aria-label", `Открыть ${formatDate(dateKey, { dateStyle: "long" })}. Запланировано задач: ${plannedCount}`);
    day.append(createElement("span", "calendar-day__date", String(getDateObject(dateKey).getUTCDate())));
    if (plannedCount) day.append(createElement("span", "month-task-count", `${plannedCount} ${plannedCount === 1 ? "задача" : "задач"}`));
    day.append(buildDailyFinance(dateKey, true));
    return day;
  }

  function renderMonthView() {
    const selected = state.settings.selectedDate;
    const first = startOfMonth(selected);
    const offset = (getDateObject(first).getUTCDay() + 6) % 7;
    const gridStart = addDays(first, -offset);
    const grid = createElement("div", "calendar-grid calendar-grid--month");
    for (const weekday of WEEKDAY_SHORT) grid.append(createElement("div", "month-weekday", weekday));
    for (let index = 0; index < 42; index += 1) {
      const dateKey = addDays(gridStart, index);
      grid.append(buildMonthDay(dateKey, getMonthKey(dateKey) !== getMonthKey(selected)));
    }
    elements.plannerSurface.replaceChildren(grid);
  }

  function renderOverdueTasks() {
    const overdue = state.tasks
      .filter((task) => isTaskOverdue(task))
      .sort((left, right) => left.date.localeCompare(right.date) || String(left.time ?? "99:99").localeCompare(String(right.time ?? "99:99")));
    setText(elements.overdueCount, overdue.length);
    elements.overdueTasks.classList.toggle("has-items", overdue.length > 0);
    if (!overdue.length) {
      elements.overdueList.replaceChildren(createElement("p", "attention-panel__empty", "Просроченных задач нет."));
      return;
    }
    const list = createElement("div", "attention-list");
    for (const task of overdue) list.append(buildTaskCard(task, { showDate: true }));
    elements.overdueList.replaceChildren(list);
  }

  function renderOverdueRevenue() {
    const overdue = state.revenueEntries
      .filter((entry) => isRevenueOverdue(entry))
      .sort((left, right) => left.expectedDate.localeCompare(right.expectedDate) || right.createdAt.localeCompare(left.createdAt));
    setText(elements.overdueRevenueCount, overdue.length);
    elements.overdueRevenue.classList.toggle("has-items", overdue.length > 0);
    if (!overdue.length) {
      elements.overdueRevenueList.replaceChildren(createElement("p", "attention-panel__empty", "Просроченных ожиданий нет."));
      return;
    }
    const list = createElement("div", "attention-list");
    for (const entry of overdue) list.append(buildRevenueCard(entry));
    elements.overdueRevenueList.replaceChildren(list);
  }

  function renderTaskTrash() {
    const items = state.trash.filter((item) => item.entityType === "task");
    if (!items.length) {
      elements.taskTrashList.replaceChildren(createElement("p", "trash-list__empty", "Корзина задач пуста."));
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const item of items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))) {
      const row = createElement("div", "trash-item");
      const text = createElement("div", "trash-item__text");
      text.append(createElement("strong", "", item.payload.description), createElement("span", "", `Задача · ${formatDate(item.payload.date, { day: "numeric", month: "long", year: "numeric" })} · удалено ${formatDateTime(item.deletedAt)}`));
      const actions = createElement("div", "trash-item__actions");
      const restore = createElement("button", "button button--secondary", "Восстановить");
      restore.type = "button";
      restore.dataset.action = "restore-task";
      restore.dataset.trashId = item.id;
      const remove = createElement("button", "button button--ghost", "Удалить навсегда");
      remove.type = "button";
      remove.dataset.action = "purge-task";
      remove.dataset.trashId = item.id;
      actions.append(restore, remove);
      row.append(text, actions);
      fragment.append(row);
    }
    elements.taskTrashList.replaceChildren(fragment);
  }

  function renderRevenueTrash() {
    const items = state.trash.filter((item) => item.entityType === "revenue");
    if (!items.length) {
      elements.revenueTrashList.replaceChildren(createElement("p", "trash-list__empty", "Корзина оплат пуста."));
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const item of items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))) {
      const row = createElement("div", "trash-item");
      const text = createElement("div", "trash-item__text");
      const originalDate = getRevenueRelevantDate(item.payload);
      text.append(createElement("strong", "", `${formatKopecks(item.payload.amountKopecks)} · ${revenueProductLabel(item.payload)}`), createElement("span", "", `Оплата · ${originalDate ? formatDate(originalDate, { day: "numeric", month: "short", year: "numeric" }) : revenueStatusLabel(item.payload.status)} · удалено ${formatDateTime(item.deletedAt)}`));
      const actions = createElement("div", "trash-item__actions");
      const restore = createElement("button", "button button--secondary", "Восстановить");
      restore.type = "button";
      restore.dataset.action = "restore-revenue";
      restore.dataset.trashId = item.id;
      const remove = createElement("button", "button button--ghost", "Удалить навсегда");
      remove.type = "button";
      remove.dataset.action = "purge-revenue";
      remove.dataset.trashId = item.id;
      actions.append(restore, remove);
      row.append(text, actions);
      fragment.append(row);
    }
    elements.revenueTrashList.replaceChildren(fragment);
  }

  function formatDateTime(iso) {
    return new Intl.DateTimeFormat("ru-RU", { timeZone: MOSCOW_TIME_ZONE, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  }

  function buildFollowUpCard(item) {
    const overdue = isFollowUpOverdue(item);
    const card = createElement("article", `follow-up-card${item.completed ? " is-completed" : ""}${overdue ? " is-overdue" : ""}`);
    const check = createElement("input", "follow-up-card__check"); check.type = "checkbox"; check.checked = item.completed; check.dataset.action = "toggle-follow-up"; check.dataset.followUpId = item.id; check.setAttribute("aria-label", item.completed ? "Вернуть клиента в невыполненные" : "Отметить возврат выполненным");
    const body = createElement("button", "follow-up-card__body"); body.type = "button"; body.dataset.action = "edit-follow-up"; body.dataset.followUpId = item.id;
    const heading = createElement("span", "follow-up-card__heading"); heading.append(createElement("strong", "", item.name), createElement("span", "follow-up-card__date", `${formatDate(item.date, { day: "numeric", month: "long", year: "numeric" })} · ${item.time}`));
    body.append(heading);
    if (item.comment) body.append(createElement("span", "follow-up-card__comment", item.comment));
    const meta = createElement("div", "follow-up-card__meta");
    if (overdue) meta.append(createElement("span", "status-label status-label--overdue", "Просрочено"));
    else if (item.completed) meta.append(createElement("span", "status-label", "Выполнено"));
    else if (item.date === getMoscowDateKey()) meta.append(createElement("span", "status-label", "Сегодня"));
    if (item.contactLabel) {
      const contact = createElement("div", "contact-control");
      const reveal = createElement("button", "contact-chip", item.contactLabel); reveal.type = "button"; reveal.dataset.action = "reveal-follow-up-contact"; reveal.dataset.followUpId = item.id; reveal.setAttribute("aria-expanded", "false"); reveal.append(createElement("span", "contact-tooltip", item.contactValue));
      const copy = makeActionButton("Копировать контакт клиента", "copy-follow-up-contact", "", "copy"); copy.dataset.followUpId = item.id;
      contact.append(reveal, copy); meta.append(contact);
    }
    const remove = makeActionButton("Переместить клиента в корзину", "delete-follow-up", "", "trash", "task-action task-action--danger"); remove.dataset.followUpId = item.id;
    meta.append(remove); card.append(check, body, meta); return card;
  }

  function renderFollowUps() {
    elements.hideCompletedFollowUps.checked = state.settings.hideCompletedFollowUps;
    const visible = sortFollowUps(state.followUps).filter((item) => !state.settings.hideCompletedFollowUps || !item.completed);
    if (!visible.length) {
      const empty = buildEmptyState(state.followUps.length ? "Выполненные скрыты" : "Список пока пуст", state.followUps.length ? "Отключите переключатель, чтобы увидеть завершённые возвраты." : "Добавьте клиента и укажите точное время, когда к нему нужно вернуться.");
      if (!state.followUps.length) {
        const add = createElement("button", "button button--primary", "Добавить первого клиента");
        add.type = "button";
        add.dataset.action = "new-follow-up";
        const actions = createElement("div", "empty-state__actions");
        actions.append(add);
        empty.append(actions);
      }
      elements.followUpList.replaceChildren(empty);
      return;
    }
    const fragment = document.createDocumentFragment(); for (const item of visible) fragment.append(buildFollowUpCard(item)); elements.followUpList.replaceChildren(fragment);
  }

  function renderFollowUpTrash() {
    const items = state.trash.filter((item) => item.entityType === "followUp").sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
    if (!items.length) { elements.followUpTrashList.replaceChildren(createElement("p", "trash-list__empty", "Корзина клиентов пуста.")); return; }
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      const row = createElement("div", "trash-item"); const info = createElement("div", "trash-item__text"); info.append(createElement("strong", "", item.payload.name), createElement("span", "", `Клиент · ${formatDate(item.payload.date, { day: "numeric", month: "short", year: "numeric" })} · удалено ${formatDateTime(item.deletedAt)}`));
      const actions = createElement("div", "trash-item__actions"); const restore = createElement("button", "button button--secondary", "Восстановить"); restore.type = "button"; restore.dataset.action = "restore-follow-up"; restore.dataset.trashId = item.id; const purge = createElement("button", "button button--ghost", "Удалить навсегда"); purge.type = "button"; purge.dataset.action = "purge-follow-up"; purge.dataset.trashId = item.id; actions.append(restore, purge); row.append(info, actions); fragment.append(row);
    }
    elements.followUpTrashList.replaceChildren(fragment);
  }

  function renderPeriod() {
    const selected = state.settings.selectedDate;
    const view = state.settings.calendarView;
    if (view === "day") {
      const isToday = selected === getMoscowDateKey();
      setText(elements.plannerHeading, isToday ? "Сегодня в фокусе" : "План на день");
      setText(elements.periodTitle, capitalize(formatDate(selected, { weekday: "long", day: "numeric", month: "long" })));
      setText(elements.periodCaption, formatDate(selected, { year: "numeric" }));
      renderDayView();
      return;
    }
    if (view === "month") {
      setText(elements.plannerHeading, "Месяц целиком");
      setText(elements.periodTitle, capitalize(formatDate(selected, { month: "long", year: "numeric" })));
      setText(elements.periodCaption, "Календарный обзор");
      renderMonthView();
      return;
    }
    setText(elements.plannerHeading, "Ритм недели");
    setText(elements.periodTitle, formatWeekRange(selected));
    const info = getIsoWeekInfo(selected);
    setText(elements.periodCaption, `Неделя ${info.week} · понедельник — воскресенье`);
    renderWeekView();
  }

  function render() {
    const plannerActive = state.settings.activeSection === "planner";
    elements.plannerSection.hidden = !plannerActive;
    elements.clientsSection.hidden = plannerActive;
    document.querySelectorAll("[data-section]").forEach((button) => {
      const active = button.dataset.section === state.settings.activeSection;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    });
    document.querySelectorAll("[data-view]").forEach((button) => {
      const active = button.dataset.view === state.settings.calendarView;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    renderOverdueTasks();
    renderOverdueRevenue();
    renderTaskTrash();
    renderRevenueTrash();
    renderFollowUpTrash();
    renderFinancialSummary();
    if (plannerActive) renderPeriod(); else renderFollowUps();
  }

  function movePeriod(direction) {
    const view = state.settings.calendarView;
    updateState((next) => {
      if (view === "day") next.settings.selectedDate = addDays(next.settings.selectedDate, direction);
      if (view === "week") next.settings.selectedDate = addDays(next.settings.selectedDate, direction * 7);
      if (view === "month") next.settings.selectedDate = shiftMonth(next.settings.selectedDate, direction);
    });
  }

  function createId(prefix = "id") {
    if (globalScope.crypto?.randomUUID) return globalScope.crypto.randomUUID();
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
  }

  function getTask(taskId) {
    return state.tasks.find((task) => task.id === taskId) || null;
  }

  function clearTaskErrors() {
    elements.taskErrorSummary.hidden = true;
    elements.taskErrorSummary.replaceChildren();
    elements.taskForm.querySelectorAll(".field__error").forEach((node) => setText(node, ""));
    elements.taskForm.querySelectorAll("[aria-invalid='true']").forEach((node) => node.removeAttribute("aria-invalid"));
  }

  function setTaskProductVisibility() {
    const other = elements.taskForm.elements.product.value === "other";
    elements.customProductField.hidden = !other;
    elements.taskForm.elements.customProduct.required = other;
    if (!other) elements.taskForm.elements.customProduct.value = "";
  }

  function openTaskForm(dateKey = state.settings.selectedDate, taskId = null, trigger = document.activeElement) {
    const task = taskId ? getTask(taskId) : null;
    const form = elements.taskForm;
    form.reset();
    clearTaskErrors();
    form.elements.id.value = task?.id || "";
    form.elements.description.value = task?.description || "";
    form.elements.date.value = task?.date || dateKey;
    form.elements.time.value = task?.time || "";
    form.elements.priority.value = task?.priority || "normal";
    form.elements.product.value = task?.product || "";
    form.elements.customProduct.value = task?.customProduct || "";
    form.elements.contactLabel.value = task?.contactLabel || "";
    form.elements.contactValue.value = task?.contactValue || "";
    form.elements.status.value = task?.status || "planned";
    elements.taskStatusField.hidden = !task;
    elements.taskDelete.hidden = !task;
    setText(document.querySelector("#task-dialog-title"), task ? "Редактировать задачу" : "Новая задача");
    setTaskProductVisibility();
    openDialog(elements.taskDialog, trigger);
    window.requestAnimationFrame(() => form.elements.description.focus());
  }

  function showTaskErrors(errors) {
    const labels = {
      description: "Описание",
      date: "Дата",
      time: "Время",
      priority: "Приоритет",
      product: "Продукт",
      customProduct: "Название продукта",
      contactLabel: "Короткая метка",
      contactValue: "Значение контакта",
      status: "Статус",
    };
    const list = createElement("ul");
    for (const [field, message] of Object.entries(errors)) {
      const control = elements.taskForm.elements[field];
      const errorNode = document.querySelector(`#task-${field.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}-error`);
      if (errorNode) setText(errorNode, message);
      if (control) control.setAttribute("aria-invalid", "true");
      const item = createElement("li");
      const link = createElement("a", "", `${labels[field]}: ${message}`);
      link.href = `#${control?.id || "task-form"}`;
      item.append(link);
      list.append(item);
    }
    elements.taskErrorSummary.replaceChildren(createElement("strong", "", "Проверьте поля формы"), list);
    elements.taskErrorSummary.hidden = false;
    elements.taskErrorSummary.focus();
  }

  function submitTaskForm(event) {
    event.preventDefault();
    clearTaskErrors();
    const form = elements.taskForm;
    const taskId = form.elements.id.value;
    const result = validateTaskInput(
      {
        description: form.elements.description.value,
        date: form.elements.date.value,
        time: form.elements.time.value,
        priority: form.elements.priority.value,
        product: form.elements.product.value,
        customProduct: form.elements.customProduct.value,
        status: taskId ? form.elements.status.value : "planned",
        contactLabel: form.elements.contactLabel.value,
        contactValue: form.elements.contactValue.value,
      },
      { editing: Boolean(taskId) },
    );
    if (!result.ok) {
      showTaskErrors(result.errors);
      return;
    }
    const existing = taskId ? getTask(taskId) : null;
    const now = new Date().toISOString();
    updateState((next) => {
      if (existing) {
        const index = next.tasks.findIndex((task) => task.id === taskId);
        next.tasks[index] = { ...next.tasks[index], ...result.value, updatedAt: now };
      } else {
        next.tasks.push({ id: createId("task"), ...result.value, createdAt: now, updatedAt: now });
      }
    }, "Задача сохранена");
    closeDialog(elements.taskDialog);
  }

  function toggleTask(taskId, completed) {
    updateState((next) => {
      const task = next.tasks.find((item) => item.id === taskId);
      if (!task || task.status === "cancelled") return;
      task.status = completed ? "completed" : "planned";
      task.updatedAt = new Date().toISOString();
    }, completed ? "Задача выполнена" : "Задача возвращена в запланированные");
  }

  function deleteTask(taskId) {
    const task = getTask(taskId);
    if (!task) return;
    updateState((next) => {
      moveTaskToTrashState(next, taskId, createId("trash"), new Date().toISOString());
    }, "Перемещено в корзину");
    closeDialog(elements.taskDialog);
  }

  function restoreTask(trashId) {
    updateState((next) => {
      restoreTaskFromTrashState(next, trashId, createId("task"), new Date().toISOString());
    }, "Запись восстановлена");
  }

  function purgeTask(trashId) {
    updateState((next) => {
      next.trash = next.trash.filter((item) => item.id !== trashId);
    }, "Задача удалена навсегда");
  }

  function fallbackCopyText(value) {
    let area = null;
    try {
      if (typeof document.execCommand !== "function") return false;
      area = createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "");
      area.className = "clipboard-helper";
      document.body.append(area);
      area.select();
      return Boolean(document.execCommand("copy"));
    } catch (error) {
      return false;
    } finally {
      area?.remove();
    }
  }

  async function copyText(value) {
    try {
      if (!navigator.clipboard?.writeText) return fallbackCopyText(value);
      await navigator.clipboard.writeText(value);
      return true;
    } catch (error) {
      return fallbackCopyText(value);
    }
  }

  async function copyTaskContact(taskId) {
    const task = getTask(taskId);
    if (!task?.contactValue) return;
    const copied = await copyText(task.contactValue);
    showToast(copied ? "Контакт скопирован" : "Не удалось скопировать контакт");
  }

  function moveTaskToDate(taskId, dateKey) {
    const task = getTask(taskId);
    if (!task || task.status !== "planned" || !isValidDateKey(dateKey) || task.date === dateKey) return false;
    updateState((next) => {
      const moved = next.tasks.find((item) => item.id === taskId);
      moved.date = dateKey;
      moved.updatedAt = new Date().toISOString();
    }, "Задача перенесена");
    return true;
  }

  function formatMoneyInput(amountKopecks) {
    if (!Number.isInteger(amountKopecks)) return "";
    const rubles = Math.trunc(amountKopecks / 100);
    const kopecks = amountKopecks % 100;
    return kopecks ? `${rubles},${pad(kopecks)}` : String(rubles);
  }

  function getRevenue(revenueId) {
    return state.revenueEntries.find((entry) => entry.id === revenueId) || null;
  }

  function clearRevenueErrors() {
    elements.revenueErrorSummary.hidden = true;
    elements.revenueErrorSummary.replaceChildren();
    elements.revenueForm.querySelectorAll(".field__error").forEach((node) => setText(node, ""));
    elements.revenueForm.querySelectorAll("[aria-invalid='true']").forEach((node) => node.removeAttribute("aria-invalid"));
  }

  function setRevenueProductVisibility() {
    const other = elements.revenueForm.elements.product.value === "other";
    elements.revenueCustomProductField.hidden = !other;
    elements.revenueForm.elements.customProduct.required = other;
    if (!other) elements.revenueForm.elements.customProduct.value = "";
  }

  function setRevenueDateVisibility({ statusChanged = false } = {}) {
    const form = elements.revenueForm;
    const status = form.elements.status.value;
    const originalStatus = form.dataset.originalStatus || "";
    const previousStatus = form.dataset.visibleStatus || originalStatus;
    const expectedInput = form.elements.expectedDate;
    const receivedInput = form.elements.receivedDate;
    expectedInput.readOnly = false;
    receivedInput.readOnly = false;
    if (statusChanged && status === "received" && previousStatus !== "received") receivedInput.value = "";
    if (status === "expected") receivedInput.value = "";
    if (!originalStatus && status === "received") expectedInput.value = "";
    elements.revenueExpectedDateField.hidden = status === "received" && !expectedInput.value;
    elements.revenueReceivedDateField.hidden = status === "expected";
    expectedInput.required = status === "expected";
    receivedInput.required = status === "received";
    if (status === "cancelled") {
      elements.revenueExpectedDateField.hidden = !expectedInput.value;
      elements.revenueReceivedDateField.hidden = !receivedInput.value;
      expectedInput.required = false;
      receivedInput.required = false;
      expectedInput.readOnly = true;
      receivedInput.readOnly = true;
    }
    form.dataset.visibleStatus = status;
  }

  function openRevenueForm(dateKey = state.settings.selectedDate, revenueId = null, trigger = document.activeElement) {
    const entry = revenueId ? getRevenue(revenueId) : null;
    const form = elements.revenueForm;
    form.reset();
    clearRevenueErrors();
    let cancelledOption = form.elements.status.querySelector('option[value="cancelled"]');
    if (entry && !cancelledOption) {
      cancelledOption = createElement("option", "", "Отменено");
      cancelledOption.value = "cancelled";
      form.elements.status.append(cancelledOption);
    }
    if (!entry && cancelledOption) cancelledOption.remove();
    form.elements.id.value = entry?.id || "";
    form.elements.amount.value = entry ? formatMoneyInput(entry.amountKopecks) : "";
    form.elements.product.value = entry?.product || "";
    form.elements.customProduct.value = entry?.customProduct || "";
    form.elements.status.value = entry?.status || "expected";
    form.elements.expectedDate.value = entry?.expectedDate || dateKey;
    form.elements.receivedDate.value = entry?.receivedDate || "";
    form.elements.receivedDate.max = getMoscowDateKey();
    form.elements.comment.value = entry?.comment || "";
    form.dataset.originalStatus = entry?.status || "";
    form.dataset.visibleStatus = entry?.status || "expected";
    elements.revenueDelete.hidden = !entry;
    setText(document.querySelector("#revenue-dialog-title"), entry ? "Редактировать оплату" : "Добавить оплату");
    setRevenueProductVisibility();
    setRevenueDateVisibility();
    openDialog(elements.revenueDialog, trigger);
    window.requestAnimationFrame(() => form.elements.amount.focus());
  }

  function showRevenueErrors(errors) {
    const labels = {
      amount: "Сумма",
      product: "Продукт",
      customProduct: "Название продукта",
      status: "Статус",
      expectedDate: "Ожидаемая дата",
      receivedDate: "Фактическая дата",
      comment: "Комментарий",
    };
    const list = createElement("ul");
    for (const [field, message] of Object.entries(errors)) {
      const control = elements.revenueForm.elements[field];
      const errorNode = document.querySelector(`#revenue-${field.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}-error`);
      if (errorNode) setText(errorNode, message);
      if (control) control.setAttribute("aria-invalid", "true");
      const item = createElement("li");
      const link = createElement("a", "", `${labels[field]}: ${message}`);
      link.href = `#${control?.id || "revenue-form"}`;
      item.append(link);
      list.append(item);
    }
    elements.revenueErrorSummary.replaceChildren(createElement("strong", "", "Проверьте поля оплаты"), list);
    elements.revenueErrorSummary.hidden = false;
    elements.revenueErrorSummary.focus();
  }

  function submitRevenueForm(event) {
    event.preventDefault();
    clearRevenueErrors();
    const form = elements.revenueForm;
    const revenueId = form.elements.id.value;
    const existing = revenueId ? getRevenue(revenueId) : null;
    const result = validateRevenueInput(
      {
        amount: form.elements.amount.value,
        product: form.elements.product.value,
        customProduct: form.elements.customProduct.value,
        status: form.elements.status.value,
        expectedDate: form.elements.expectedDate.value,
        receivedDate: form.elements.receivedDate.value,
        comment: form.elements.comment.value,
      },
      { editing: Boolean(existing), today: getMoscowDateKey() },
    );
    if (!result.ok) {
      showRevenueErrors(result.errors);
      return;
    }
    const now = new Date().toISOString();
    updateState((next) => {
      if (existing) {
        const index = next.revenueEntries.findIndex((entry) => entry.id === revenueId);
        next.revenueEntries[index] = { ...next.revenueEntries[index], ...result.value, updatedAt: now };
      } else {
        next.revenueEntries.push({ id: createId("revenue"), ...result.value, createdAt: now, updatedAt: now });
      }
    }, "Запись сохранена");
    closeDialog(elements.revenueDialog);
  }

  function deleteRevenue(revenueId) {
    if (!getRevenue(revenueId)) return;
    updateState((next) => {
      moveRevenueToTrashState(next, revenueId, createId("trash"), new Date().toISOString());
    }, "Перемещено в корзину");
    closeDialog(elements.revenueDialog);
  }

  function restoreRevenue(trashId) {
    updateState((next) => {
      restoreRevenueFromTrashState(next, trashId, createId("revenue"), new Date().toISOString());
    }, "Запись восстановлена");
  }

  function purgeRevenue(trashId) {
    updateState((next) => {
      next.trash = next.trash.filter((item) => item.id !== trashId);
    }, "Оплата удалена навсегда");
  }

  function getFollowUp(id) { return state.followUps.find((item) => item.id === id) || null; }
  function clearFollowUpErrors() { elements.followUpErrorSummary.hidden = true; elements.followUpErrorSummary.replaceChildren(); elements.followUpForm.querySelectorAll(".field__error").forEach((node) => setText(node, "")); elements.followUpForm.querySelectorAll("[aria-invalid='true']").forEach((node) => node.removeAttribute("aria-invalid")); }
  function openFollowUpForm(id = null, trigger = document.activeElement) {
    const item = id ? getFollowUp(id) : null; const form = elements.followUpForm; form.reset(); clearFollowUpErrors();
    form.elements.id.value = item?.id || ""; form.elements.name.value = item?.name || ""; form.elements.date.value = item?.date || getMoscowDateKey(); form.elements.time.value = item?.time || ""; form.elements.comment.value = item?.comment || ""; form.elements.contactLabel.value = item?.contactLabel || ""; form.elements.contactValue.value = item?.contactValue || "";
    elements.followUpDelete.hidden = !item; setText(document.querySelector("#follow-up-dialog-title"), item ? "Редактировать клиента" : "Добавить клиента"); openDialog(elements.followUpDialog, trigger); window.requestAnimationFrame(() => form.elements.name.focus());
  }
  function showFollowUpErrors(errors) {
    const labels = { name: "Имя", date: "Дата", time: "Время", comment: "Комментарий", contactLabel: "Контактная метка", contactValue: "Значение контакта" }; const list = createElement("ul");
    for (const [field, message] of Object.entries(errors)) { const control = elements.followUpForm.elements[field]; const error = document.querySelector(`#follow-up-${field.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}-error`); setText(error, message); control?.setAttribute("aria-invalid", "true"); const item = createElement("li"); const link = createElement("a", "", `${labels[field]}: ${message}`); link.href = `#${control?.id || "follow-up-form"}`; item.append(link); list.append(item); }
    elements.followUpErrorSummary.replaceChildren(createElement("strong", "", "Проверьте поля клиента"), list); elements.followUpErrorSummary.hidden = false; elements.followUpErrorSummary.focus();
  }
  function submitFollowUpForm(event) {
    event.preventDefault(); clearFollowUpErrors(); const form = elements.followUpForm; const id = form.elements.id.value; const existing = id ? getFollowUp(id) : null; const result = validateFollowUpInput({ name: form.elements.name.value, date: form.elements.date.value, time: form.elements.time.value, comment: form.elements.comment.value, contactLabel: form.elements.contactLabel.value, contactValue: form.elements.contactValue.value });
    if (!result.ok) { showFollowUpErrors(result.errors); return; } const now = new Date().toISOString();
    updateState((next) => { if (existing) { const index = next.followUps.findIndex((item) => item.id === id); next.followUps[index] = { ...next.followUps[index], ...result.value, updatedAt: now }; } else next.followUps.push({ id: createId("follow-up"), ...result.value, completed: false, completedAt: null, createdAt: now, updatedAt: now }); }, existing ? "Клиент сохранён" : "Клиент добавлен"); closeDialog(elements.followUpDialog);
  }
  function toggleFollowUp(id, completed) { const now = new Date().toISOString(); updateState((next) => { const item = next.followUps.find((entry) => entry.id === id); if (!item) return; item.completed = completed; item.completedAt = completed ? now : null; item.updatedAt = now; }, completed ? "Возврат выполнен" : "Возврат снова активен"); }
  function deleteFollowUp(id) { if (!getFollowUp(id)) return; updateState((next) => { moveFollowUpToTrashState(next, id, createId("trash"), new Date().toISOString()); }, "Перемещено в корзину"); closeDialog(elements.followUpDialog); }
  function restoreFollowUp(trashId) { updateState((next) => { restoreFollowUpFromTrashState(next, trashId, createId("follow-up")); }, "Запись восстановлена"); }
  function purgeFollowUp(trashId) { updateState((next) => { next.trash = next.trash.filter((item) => item.id !== trashId); }, "Клиент удалён навсегда"); }
  async function copyFollowUpContact(id) { const item = getFollowUp(id); if (!item?.contactValue) return; const copied = await copyText(item.contactValue); showToast(copied ? "Контакт скопирован" : "Не удалось скопировать контакт"); }

  function clearPlanErrors() {
    elements.planErrorSummary.hidden = true;
    elements.planErrorSummary.replaceChildren();
    setText(document.querySelector("#plan-amount-error"), "");
    elements.planForm.elements.amount.removeAttribute("aria-invalid");
  }

  function openPlanForm(type, trigger = document.activeElement) {
    const selected = state.settings.selectedDate;
    const isMonth = type === "month";
    const info = getIsoWeekInfo(selected);
    const key = isMonth ? getMonthKey(selected) : info.weekKey;
    const plan = isMonth ? state.monthlyPlans[key] : state.weeklyPlans[key];
    const form = elements.planForm;
    form.reset();
    clearPlanErrors();
    form.elements.type.value = type;
    form.elements.key.value = key;
    form.elements.amount.value = plan ? formatMoneyInput(plan.amountKopecks) : "";
    elements.planReset.hidden = !plan;
    setText(document.querySelector("#plan-dialog-title"), plan ? "Изменить план" : "Задать план");
    setText(
      document.querySelector("#plan-period-label"),
      isMonth
        ? capitalize(formatDate(`${key}-01`, { month: "long", year: "numeric" }))
        : `${formatWeekRange(selected)} · ISO-неделя ${info.week}`,
    );
    openDialog(elements.planDialog, trigger);
    window.requestAnimationFrame(() => form.elements.amount.focus());
  }

  function submitPlanForm(event) {
    event.preventDefault();
    clearPlanErrors();
    const form = elements.planForm;
    const money = parseMoneyToKopecks(form.elements.amount.value);
    if (!money.ok) {
      const input = form.elements.amount;
      input.setAttribute("aria-invalid", "true");
      setText(document.querySelector("#plan-amount-error"), money.error);
      const link = createElement("a", "", `Сумма плана: ${money.error}`);
      link.href = "#plan-amount";
      elements.planErrorSummary.replaceChildren(createElement("strong", "", "Проверьте сумму плана"), link);
      elements.planErrorSummary.hidden = false;
      elements.planErrorSummary.focus();
      return;
    }
    const type = form.elements.type.value;
    const key = form.elements.key.value;
    const now = new Date().toISOString();
    updateState((next) => {
      if (type === "month") next.monthlyPlans[key] = { monthKey: key, amountKopecks: money.value, updatedAt: now };
      if (type === "week") next.weeklyPlans[key] = { weekKey: key, startDate: startOfWeek(next.settings.selectedDate), amountKopecks: money.value, updatedAt: now };
    }, "План сохранён");
    closeDialog(elements.planDialog);
  }

  function resetPlan() {
    const form = elements.planForm;
    const type = form.elements.type.value;
    const key = form.elements.key.value;
    if (!window.confirm("Сбросить план для этого периода?")) return;
    updateState((next) => {
      if (type === "month") delete next.monthlyPlans[key];
      if (type === "week") delete next.weeklyPlans[key];
    }, "План сброшен");
    closeDialog(elements.planDialog);
  }

  function openDialog(dialog, trigger = document.activeElement) {
    if (!dialog || dialog.open) return;
    if (trigger instanceof HTMLElement) dialogTriggers.set(dialog, trigger);
    dialog.showModal();
    window.requestAnimationFrame(() => {
      const first = dialog.querySelector("button:not([disabled]), input:not([disabled])");
      first?.focus();
    });
  }

  function closeDialog(dialog) {
    if (dialog?.open) dialog.close();
  }

  function restoreDialogFocus(event) {
    const trigger = dialogTriggers.get(event.currentTarget);
    if (trigger?.isConnected) trigger.focus();
  }

  function trapDialogFocus(event) {
    if (event.key !== "Tab" || !event.currentTarget.open) return;
    const focusable = Array.from(event.currentTarget.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((node) => !node.hidden && node.getAttribute("aria-hidden") !== "true" && node.getClientRects().length > 0);
    if (!focusable.length) {
      event.preventDefault();
      event.currentTarget.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !focusable.includes(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !focusable.includes(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  function downloadTextFile(text, fileName, type = "application/json") {
    try {
      const blob = new Blob([text], { type });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch (error) {
      return false;
    }
  }

  function backupFileName() {
    const parts = getMoscowParts();
    return `tihiy-temp-backup-${parts.year}-${pad(parts.month)}-${pad(parts.day)}-${pad(parts.hour)}${pad(parts.minute)}.json`;
  }

  function exportCurrentState() {
    const started = downloadTextFile(serializeBackup(state), backupFileName());
    showToast(started ? "Скачивание резервной копии начато" : "Не удалось подготовить резервную копию");
    return started;
  }

  function showDataConfirmation(kind, importedState = null, trigger = document.activeElement) {
    pendingDataOperation = kind; pendingImportedState = importedState; elements.dataOperationError.hidden = true; elements.continueWithoutBackup.hidden = true;
    setText(elements.dataConfirmTitle, kind === "import" ? "Заменить все данные?" : "Удалить все данные?");
    setText(elements.dataConfirmMessage, kind === "import" ? "Текущие данные будут заменены содержимым выбранной копии. Перед заменой приложение скачает текущую копию." : "Все задачи, оплаты, клиенты, планы и корзина будут удалены. Перед очисткой приложение скачает текущую копию.");
    openDialog(elements.dataConfirmDialog, trigger);
  }

  function replaceWithImportedState() {
    if (!pendingImportedState) return false;
    const previous = state; const wasDirty = dirty; const next = cloneState(pendingImportedState); next.revision = baseRevision; state = next;
    const saved = saveCurrentState(); if (!saved) { state = previous; setDirty(wasDirty, wasDirty ? "Есть несохранённые изменения" : ""); showToast("Импорт не выполнен: новое состояние не удалось сохранить"); render(); return false; }
    pendingImportedState = null; pendingDataOperation = null; closeDialog(elements.dataConfirmDialog); document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close()); render(); showToast("Данные восстановлены"); return true;
  }

  function clearAllData() {
    const previous = state;
    const initial = createInitialState();
    initial.revision = baseRevision;
    state = initial;
    const saved = saveCurrentState();
    if (!saved) {
      state = previous;
      render();
      showToast("Очистка не выполнена: данные изменились или хранилище недоступно");
      return false;
    }
    pendingDataOperation = null;
    closeDialog(elements.dataConfirmDialog);
    document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
    render();
    showToast("Все данные удалены");
    return true;
  }

  function executePendingDataOperation({ withoutBackup = false } = {}) {
    if (!pendingDataOperation) return;
    if (!withoutBackup && !downloadTextFile(serializeBackup(state), backupFileName())) {
      setText(elements.dataOperationError, "Не удалось подготовить резервную копию. Действие остановлено. Можно отменить или отдельно продолжить без копии."); elements.dataOperationError.hidden = false; elements.continueWithoutBackup.hidden = false; return;
    }
    if (pendingDataOperation === "import") replaceWithImportedState(); else clearAllData();
  }

  async function handleImportFile(file, trigger) {
    if (!file) return;
    if (file.size > MAX_BACKUP_BYTES) { showToast("Файл больше 5 МБ — данные не изменены"); return; }
    let text;
    try { text = await file.text(); } catch (error) { showToast("Не удалось прочитать файл — данные не изменены"); return; }
    const result = parseBackupText(text);
    if (!result.ok) { showToast(`Импорт отклонён: ${result.error}`); return; }
    showDataConfirmation("import", result.value, trigger);
  }

  function loadFreshState() {
    const candidate = pendingRemoteState || inspectStoredState(getBrowserStorage()).state;
    if (!isValidAppState(candidate)) {
      showToast("Свежие данные не удалось прочитать");
      return;
    }
    state = cloneState(candidate);
    baseRevision = state.revision;
    setDirty(false);
    hideConflict();
    document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
    render();
    showToast("Свежие данные загружены");
  }

  function startFreshAfterCorruption() {
    const fresh = createInitialState();
    corruptRaw = null;
    if (writeInitialState(fresh)) {
      closeDialog(elements.recoveryDialog);
      render();
      showToast("Создано пустое состояние");
    }
  }

  function bindEvents() {
    document.addEventListener("click", (event) => {
      const sectionButton = event.target.closest("[data-section]");
      if (sectionButton) {
        updateState((next) => {
          next.settings.activeSection = sectionButton.dataset.section;
        });
        return;
      }

      const actionButton = event.target.closest("[data-action]");
      if (actionButton) {
        const { action, taskId, revenueId, followUpId, date, trashId, planType } = actionButton.dataset;
        if (action === "new-task") openTaskForm(date || state.settings.selectedDate, null, actionButton);
        if (action === "edit-task") openTaskForm(undefined, taskId, actionButton);
        if (action === "toggle-task") toggleTask(taskId, actionButton.checked);
        if (action === "delete-task") deleteTask(taskId);
        if (action === "copy-contact") copyTaskContact(taskId);
        if (action === "reveal-contact") {
          const expanded = actionButton.getAttribute("aria-expanded") !== "true";
          document.querySelectorAll(".contact-chip[aria-expanded='true']").forEach((button) => button.setAttribute("aria-expanded", "false"));
          actionButton.setAttribute("aria-expanded", String(expanded));
        }
        if (action === "restore-task") restoreTask(trashId);
        if (action === "purge-task" && window.confirm("Удалить эту задачу навсегда?")) purgeTask(trashId);
        if (action === "new-revenue") openRevenueForm(date || state.settings.selectedDate, null, actionButton);
        if (action === "edit-revenue") openRevenueForm(undefined, revenueId, actionButton);
        if (action === "delete-revenue") deleteRevenue(revenueId);
        if (action === "restore-revenue") restoreRevenue(trashId);
        if (action === "purge-revenue" && window.confirm("Удалить эту оплату навсегда?")) purgeRevenue(trashId);
        if (action === "edit-follow-up") openFollowUpForm(followUpId, actionButton);
        if (action === "new-follow-up") openFollowUpForm(null, actionButton);
        if (action === "toggle-follow-up") toggleFollowUp(followUpId, actionButton.checked);
        if (action === "delete-follow-up") deleteFollowUp(followUpId);
        if (action === "copy-follow-up-contact") copyFollowUpContact(followUpId);
        if (action === "reveal-follow-up-contact") {
          const expanded = actionButton.getAttribute("aria-expanded") !== "true";
          document.querySelectorAll(".contact-chip[aria-expanded='true']").forEach((button) => button.setAttribute("aria-expanded", "false")); actionButton.setAttribute("aria-expanded", String(expanded));
        }
        if (action === "restore-follow-up") restoreFollowUp(trashId);
        if (action === "purge-follow-up" && window.confirm("Удалить этого клиента навсегда?")) purgeFollowUp(trashId);
        if (action === "open-plan") openPlanForm(planType, actionButton);
        if (action === "open-selected-day") {
          updateState((next) => {
            next.settings.calendarView = "day";
          });
        }
        return;
      }

      const viewButton = event.target.closest("[data-view]");
      if (viewButton) {
        updateState((next) => {
          next.settings.calendarView = viewButton.dataset.view;
        });
        return;
      }

      const dateButton = event.target.closest("[data-date]");
      if (dateButton) {
        const mobileWeek =
          dateButton.dataset.calendarVariant === "week" &&
          window.matchMedia("(max-width: 959px)").matches;
        updateState((next) => {
          next.settings.selectedDate = dateButton.dataset.date;
          if (!mobileWeek) next.settings.calendarView = "day";
        });
        return;
      }
    });

    document.addEventListener("dragstart", (event) => {
      const handle = event.target.closest("[data-action='drag-task']");
      if (!handle) return;
      const task = getTask(handle.dataset.taskId);
      if (!task || task.status !== "planned" || !window.matchMedia("(min-width: 960px)").matches) {
        event.preventDefault();
        return;
      }
      draggingTaskId = task.id;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", task.id);
      handle.closest(".task-card")?.classList.add("is-dragging");
    });
    document.addEventListener("dragover", (event) => {
      const target = event.target.closest("[data-drop-date]");
      if (!target || !draggingTaskId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      target.classList.add("is-drop-target");
    });
    document.addEventListener("dragleave", (event) => {
      const target = event.target.closest("[data-drop-date]");
      if (target && !target.contains(event.relatedTarget)) target.classList.remove("is-drop-target");
    });
    document.addEventListener("drop", (event) => {
      const target = event.target.closest("[data-drop-date]");
      if (!target || !draggingTaskId) return;
      event.preventDefault();
      target.classList.remove("is-drop-target");
      moveTaskToDate(draggingTaskId, target.dataset.dropDate);
      draggingTaskId = null;
    });
    document.addEventListener("dragend", () => {
      draggingTaskId = null;
      document.querySelectorAll(".is-dragging, .is-drop-target").forEach((node) => node.classList.remove("is-dragging", "is-drop-target"));
    });

    document.querySelector("#previous-period").addEventListener("click", () => movePeriod(-1));
    document.querySelector("#next-period").addEventListener("click", () => movePeriod(1));
    document.querySelector("#today-button").addEventListener("click", () => {
      updateState((next) => {
        next.settings.selectedDate = getMoscowDateKey();
      });
    });
    document.querySelector("#settings-button").addEventListener("click", (event) => {
      openDialog(elements.settingsDialog, event.currentTarget);
    });
    document.querySelector("#new-task-button").addEventListener("click", (event) => {
      openTaskForm(state.settings.selectedDate, null, event.currentTarget);
    });
    document.querySelector("#new-revenue-button").addEventListener("click", (event) => {
      openRevenueForm(state.settings.selectedDate, null, event.currentTarget);
    });
    document.querySelector("#new-follow-up-button").addEventListener("click", (event) => openFollowUpForm(null, event.currentTarget));
    document.querySelector("#settings-close").addEventListener("click", () => closeDialog(elements.settingsDialog));
    document.querySelector("#task-close").addEventListener("click", () => closeDialog(elements.taskDialog));
    document.querySelector("#task-cancel").addEventListener("click", () => closeDialog(elements.taskDialog));
    elements.taskDelete.addEventListener("click", () => deleteTask(elements.taskForm.elements.id.value));
    elements.taskForm.addEventListener("submit", submitTaskForm);
    elements.taskForm.elements.product.addEventListener("change", setTaskProductVisibility);
    document.querySelector("#revenue-close").addEventListener("click", () => closeDialog(elements.revenueDialog));
    document.querySelector("#revenue-cancel").addEventListener("click", () => closeDialog(elements.revenueDialog));
    elements.revenueDelete.addEventListener("click", () => deleteRevenue(elements.revenueForm.elements.id.value));
    elements.revenueForm.addEventListener("submit", submitRevenueForm);
    elements.revenueForm.elements.product.addEventListener("change", setRevenueProductVisibility);
    elements.revenueForm.elements.status.addEventListener("change", () => setRevenueDateVisibility({ statusChanged: true }));
    document.querySelector("#follow-up-close").addEventListener("click", () => closeDialog(elements.followUpDialog));
    document.querySelector("#follow-up-cancel").addEventListener("click", () => closeDialog(elements.followUpDialog));
    elements.followUpDelete.addEventListener("click", () => deleteFollowUp(elements.followUpForm.elements.id.value));
    elements.followUpForm.addEventListener("submit", submitFollowUpForm);
    elements.hideCompletedFollowUps.addEventListener("change", (event) => updateState((next) => { next.settings.hideCompletedFollowUps = event.currentTarget.checked; }));
    document.querySelector("#plan-close").addEventListener("click", () => closeDialog(elements.planDialog));
    document.querySelector("#plan-cancel").addEventListener("click", () => closeDialog(elements.planDialog));
    elements.planForm.addEventListener("submit", submitPlanForm);
    elements.planReset.addEventListener("click", resetPlan);
    document.querySelector("#retry-save-button").addEventListener("click", () => {
      if (saveCurrentState()) {
        render();
        showToast("Изменения сохранены");
      }
    });
    document.querySelector("#export-memory-button").addEventListener("click", exportCurrentState);
    document.querySelector("#export-conflict-button").addEventListener("click", exportCurrentState);
    document.querySelector("#export-settings-button").addEventListener("click", exportCurrentState);
    document.querySelector("#import-settings-button").addEventListener("click", () => elements.importFileInput.click());
    elements.importFileInput.addEventListener("change", (event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; handleImportFile(file, document.querySelector("#import-settings-button")); });
    document.querySelector("#empty-trash-button").addEventListener("click", () => { if (!state.trash.length) { showToast("Корзина уже пуста"); return; } if (window.confirm("Удалить все элементы корзины навсегда?")) updateState((next) => { next.trash = []; }, "Корзина очищена"); });
    document.querySelector("#clear-data-button").addEventListener("click", (event) => showDataConfirmation("clear", null, event.currentTarget));
    document.querySelector("#data-confirm-close").addEventListener("click", () => closeDialog(elements.dataConfirmDialog));
    document.querySelector("#data-confirm-cancel").addEventListener("click", () => closeDialog(elements.dataConfirmDialog));
    document.querySelector("#data-confirm-submit").addEventListener("click", () => executePendingDataOperation());
    elements.continueWithoutBackup.addEventListener("click", () => { if (window.confirm("Продолжить без резервной копии? Это действие нельзя отменить.")) executePendingDataOperation({ withoutBackup: true }); });
    document.querySelector("#load-fresh-button").addEventListener("click", loadFreshState);
    document.querySelector("#download-corrupt-button").addEventListener("click", () => {
      const started = downloadTextFile(
        corruptRaw ?? "",
        `tihiy-temp-corrupt-${getMoscowDateKey()}.txt`,
        "text/plain",
      );
      showToast(started ? "Скачивание повреждённых данных начато" : "Не удалось подготовить файл");
    });
    document.querySelector("#start-fresh-button").addEventListener("click", startFreshAfterCorruption);
    document.querySelector("#recovery-close").addEventListener("click", () => {
      closeDialog(elements.recoveryDialog);
      showToast("Повреждённые данные сохранены; приложение работает только в памяти");
    });

    elements.recoveryDialog.addEventListener("cancel", () => {
      showToast("Повреждённые данные сохранены; приложение работает только в памяти");
    });
    document.querySelectorAll("dialog").forEach((dialog) => dialog.addEventListener("keydown", trapDialogFocus));
    elements.settingsDialog.addEventListener("close", restoreDialogFocus);
    elements.taskDialog.addEventListener("close", restoreDialogFocus);
    elements.revenueDialog.addEventListener("close", restoreDialogFocus);
    elements.planDialog.addEventListener("close", restoreDialogFocus);
    elements.followUpDialog.addEventListener("close", restoreDialogFocus);
    elements.dataConfirmDialog.addEventListener("close", () => { restoreDialogFocus({ currentTarget: elements.dataConfirmDialog }); pendingImportedState = null; pendingDataOperation = null; });
    elements.recoveryDialog.addEventListener("close", restoreDialogFocus);

    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEY || event.newValue === null) return;
      let remote;
      try {
        remote = JSON.parse(event.newValue);
      } catch (error) {
        showConflict();
        return;
      }
      if (!isValidAppState(remote) || remote.revision <= baseRevision) return;
      const hasOpenDialog = Boolean(document.querySelector("dialog[open]"));
      if (dirty || hasOpenDialog) {
        showConflict(remote);
        return;
      }
      state = cloneState(remote);
      baseRevision = remote.revision;
      render();
      showToast("Данные обновлены из другой вкладки");
    });

    window.addEventListener("beforeunload", (event) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    });

    window.addEventListener("resize", () => {
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        if (state.settings.activeSection === "planner") renderPeriod();
      });
    });
    const refreshTimeSensitiveUi = () => {
      render();
    };
    window.addEventListener("focus", refreshTimeSensitiveUi);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshTimeSensitiveUi();
    });
    window.setInterval(refreshTimeSensitiveUi, 60_000);
  }

  function init() {
    cacheElements();
    bindEvents();
    loadInitialState();
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})(typeof window !== "undefined" ? window : globalThis);
