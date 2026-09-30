"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("./script.js");

function makeLegacyState() {
  return {
    schemaVersion: 1,
    revision: 7,
    tasks: [],
    revenueEntries: [],
    monthlyPlans: {
      "2026-09": {
        monthKey: "2026-09",
        amountKopecks: 1_000_000,
        updatedAt: "2026-09-04T10:00:00.000Z",
      },
    },
    weeklyPlans: {},
    followUps: [],
    trash: [],
    settings: {
      activeSection: "planner",
      calendarView: "month",
      selectedDate: "2026-09-04",
      hideCompletedFollowUps: false,
    },
  };
}

test("финансовые показатели фильтруются по продукту", () => {
  const entries = [
    { status: "received", product: "vibeCoding", amountKopecks: 120_000, receivedDate: "2026-09-03" },
    { status: "received", product: "aiSkills", amountKopecks: 80_000, receivedDate: "2026-09-03" },
    { status: "expected", product: "vibeCoding", amountKopecks: 50_000, expectedDate: "2026-09-10" },
    { status: "expected", product: "aiSkills", amountKopecks: 70_000, expectedDate: "2026-09-11" },
    { status: "expected", product: "other", amountKopecks: 90_000, expectedDate: "2026-09-12" },
  ];

  const vibe = core.calculateMonthMetrics(entries, "2026-09-04", "2026-09-04", 300_000, "vibeCoding");
  const ai = core.calculateMonthMetrics(entries, "2026-09-04", "2026-09-04", 200_000, "aiSkills");

  assert.equal(vibe.factKopecks, 120_000);
  assert.equal(vibe.expectationKopecks, 50_000);
  assert.equal(vibe.completion, 40);
  assert.equal(ai.factKopecks, 80_000);
  assert.equal(ai.expectationKopecks, 70_000);
  assert.equal(ai.completion, 40);
});

test("резервная копия версии 1 сохраняет общий план как нераспределённый", () => {
  const legacyState = makeLegacyState();
  const result = core.parseBackupText(JSON.stringify({
    schemaVersion: 1,
    exportedAt: "2026-09-04T10:05:00.000Z",
    data: legacyState,
  }));

  assert.equal(result.ok, true);
  assert.equal(result.value.schemaVersion, 2);
  assert.deepEqual(result.value.monthlyPlans["2026-09"].amountsKopecks, {});
  assert.equal(result.value.monthlyPlans["2026-09"].legacyTotalKopecks, 1_000_000);
});

test("локальное состояние версии 1 мигрирует и сохраняется с новой ревизией", () => {
  let stored = JSON.stringify(makeLegacyState());
  const storage = {
    getItem: () => stored,
    setItem: (_key, value) => { stored = value; },
  };

  const snapshot = core.inspectStoredState(storage);

  assert.equal(snapshot.status, "valid");
  assert.equal(snapshot.migrated, true);
  assert.equal(snapshot.state.schemaVersion, 2);
  assert.equal(snapshot.state.revision, 8);
  assert.equal(JSON.parse(stored).schemaVersion, 2);
});

test("ошибка записи миграции не мешает открыть старые данные", () => {
  const stored = JSON.stringify(makeLegacyState());
  const snapshot = core.inspectStoredState({
    getItem: () => stored,
    setItem: () => { throw new Error("storage unavailable"); },
  });

  assert.equal(snapshot.status, "valid");
  assert.equal(snapshot.state.schemaVersion, 2);
  assert.equal(snapshot.state.revision, 7);
  assert.ok(snapshot.migrationError);
});

test("резервная копия версии 2 проходит повторный импорт", () => {
  const state = core.createInitialState("2026-09-04");
  state.monthlyPlans["2026-09"] = {
    monthKey: "2026-09",
    amountsKopecks: { vibeCoding: 600_000, aiSkills: 400_000 },
    legacyTotalKopecks: null,
    updatedAt: "2026-09-04T10:00:00.000Z",
  };

  const result = core.parseBackupText(core.serializeBackup(state, "2026-09-04T10:05:00.000Z"));

  assert.equal(result.ok, true);
  assert.deepEqual(result.value.monthlyPlans["2026-09"].amountsKopecks, {
    vibeCoding: 600_000,
    aiSkills: 400_000,
  });
});

test("мини-календарь строит шесть недель с понедельника", () => {
  const dates = core.getMonthCalendarDates("2026-09-30");

  assert.equal(dates.length, 42);
  assert.equal(dates[0], "2026-08-31");
  assert.equal(dates[41], "2026-10-11");
});
