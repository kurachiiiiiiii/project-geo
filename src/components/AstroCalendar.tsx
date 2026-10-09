import { useMemo, useState } from "react";
import { computeMonthSummary } from "../features/astro/astro";

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

interface Props {
  point: { lat: number; lng: number };
  selectedDate: Date;
  onSelectDate: (d: Date) => void;
}

function isSameDate(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatMinutes(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  if (h === 0) return `${m}分`;
  return `${h}時間${m}分`;
}

export default function AstroCalendar({ point, selectedDate, onSelectDate }: Props) {
  const [cursor, setCursor] = useState(
    () => new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1),
  );

  const summaries = useMemo(
    () => computeMonthSummary(point.lat, point.lng, cursor.getFullYear(), cursor.getMonth()),
    [point.lat, point.lng, cursor],
  );

  const maxMinutes = Math.max(1, ...summaries.map((s) => s.totalMinutes));
  const leadingBlanks = new Date(cursor.getFullYear(), cursor.getMonth(), 1).getDay();

  return (
    <div className="astro-calendar">
      <div className="astro-calendar__header">
        <button
          type="button"
          className="astro-calendar__nav"
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
          aria-label="前の月"
        >
          ‹
        </button>
        <span className="astro-calendar__title">
          {cursor.getFullYear()}年{cursor.getMonth() + 1}月
        </span>
        <button
          type="button"
          className="astro-calendar__nav"
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
          aria-label="次の月"
        >
          ›
        </button>
      </div>

      <div className="astro-calendar__grid astro-calendar__grid--weekdays">
        {WEEKDAY_LABELS.map((w) => (
          <span key={w} className="astro-calendar__weekday">
            {w}
          </span>
        ))}
      </div>

      <div className="astro-calendar__grid">
        {Array.from({ length: leadingBlanks }).map((_, i) => (
          <span key={`blank-${i}`} />
        ))}
        {summaries.map((s) => {
          const selected = isSameDate(s.date, selectedDate);
          const intensity = s.totalMinutes > 0 ? 0.15 + 0.85 * (s.totalMinutes / maxMinutes) : 0;
          return (
            <button
              key={s.date.toISOString()}
              type="button"
              className={`astro-calendar__day${selected ? " astro-calendar__day--selected" : ""}`}
              style={{ "--intensity": intensity } as React.CSSProperties}
              onClick={() => onSelectDate(s.date)}
              title={
                s.totalMinutes > 0
                  ? `観測可能時間: 約${formatMinutes(s.totalMinutes)}`
                  : "観測可能な時間帯はありません"
              }
            >
              <span className="astro-calendar__day-num">{s.date.getDate()}</span>
            </button>
          );
        })}
      </div>
      <p className="astro-calendar__hint">色が濃いほど、その晩の天の川観測可能時間が長いことを示します</p>
    </div>
  );
}
