// Campus time in Malaysia (MYT). DEMO_CLOCK="12:15" and DEMO_WEEKDAY=1..7 let you
// demo lunch rush at any time of day.

const TIME_ZONE = "Asia/Kuala_Lumpur";
const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function campusClock(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );

  let hour = Number(parts.hour);
  let minute = Number(parts.minute);
  let weekday = WEEKDAYS[parts.weekday];

  const demo = /^(\d{1,2}):(\d{2})$/.exec(process.env.DEMO_CLOCK ?? "");
  if (demo) {
    hour = Number(demo[1]);
    minute = Number(demo[2]);
  }
  const demoDay = Number(process.env.DEMO_WEEKDAY);
  if (demoDay >= 1 && demoDay <= 7) weekday = demoDay;

  return { hour, minute, weekday, isWeekend: weekday >= 6, demo: Boolean(demo) };
}

export function formatTime(fractionalHour) {
  const total = Math.round(fractionalHour * 60);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
