export type AutoUpdateScheduleState = {
  due: boolean;
  lastMarkAt: Date;
};

function timeOrNull(value: Date | null | undefined): number | null {
  if (!(value instanceof Date)) return null;
  const time = value.getTime();
  return Number.isFinite(time) ? time : null;
}

export function getLastAutoUpdateScheduleMark(params: {
  createdAt: Date;
  lastUpdatedAt?: Date | null;
  lastAttemptedAt?: Date | null;
}): Date {
  const marks = [params.createdAt, params.lastUpdatedAt, params.lastAttemptedAt]
    .map(timeOrNull)
    .filter((time): time is number => typeof time === "number");
  return new Date(Math.max(...marks));
}

export function resolveAutoUpdateScheduleState(params: {
  createdAt: Date;
  lastUpdatedAt?: Date | null;
  lastAttemptedAt?: Date | null;
  now: Date;
  intervalSeconds: number;
}): AutoUpdateScheduleState {
  const intervalMs = Math.max(1, Math.floor(params.intervalSeconds)) * 1000;
  const nowMs = params.now.getTime();
  const lastMarkAt = getLastAutoUpdateScheduleMark({
    createdAt: params.createdAt,
    lastUpdatedAt: params.lastUpdatedAt,
    lastAttemptedAt: params.lastAttemptedAt,
  });
  const lastMarkMs = lastMarkAt.getTime();

  return {
    due: nowMs >= lastMarkMs + intervalMs,
    lastMarkAt,
  };
}
