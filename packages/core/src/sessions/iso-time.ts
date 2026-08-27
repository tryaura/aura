/**
 * Date-free UTC timestamp arithmetic.
 *
 * Session analysis subtracts transcript timestamps from each other and from the injected clock.
 * The `Date` global is banned outside boundaries, and these two conversions are all the analysis
 * needs, so they are implemented directly: a strict ISO-8601 UTC parse and its day-key inverse,
 * both pure functions of their input.
 */

const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u;

const MS_PER_DAY = 86_400_000;

/**
 * Milliseconds since the Unix epoch for a `YYYY-MM-DDTHH:MM:SS[.mmm]Z` timestamp.
 *
 * Undefined for anything else, including offset forms: the transcripts this reads always record
 * UTC, and a lenient parse would silently misplace a malformed line instead of dropping it.
 */
export function utcTimestampMs(value: string): number | undefined {
  const match = UTC_TIMESTAMP.exec(value);
  if (match === null) {
    return undefined;
  }
  const [, year, month, day, hour, minute, second, fraction] = match;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return undefined;
  }
  const days = daysFromCivil(Number(year), Number(month), Number(day));
  const hourValue = Number(hour);
  const minuteValue = Number(minute);
  const secondValue = Number(second);
  if (days === undefined || hourValue > 23 || minuteValue > 59 || secondValue > 59) {
    return undefined;
  }
  const milliseconds = fraction === undefined ? 0 : Number(fraction.padEnd(3, "0"));
  return (
    days * MS_PER_DAY +
    hourValue * 3_600_000 +
    minuteValue * 60_000 +
    secondValue * 1000 +
    milliseconds
  );
}

/** The `YYYY-MM-DD` UTC day holding an epoch-milliseconds instant. */
export function utcDayKey(epochMs: number): string {
  const days = Math.floor(epochMs / MS_PER_DAY);
  const { year, month, day } = civilFromDays(days);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Days since 1970-01-01 for a proleptic-Gregorian civil date. Undefined when out of range. */
function daysFromCivil(year: number, month: number, day: number): number | undefined {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return undefined;
  }
  const shiftedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** The civil date holding a days-since-epoch count. Inverse of {@link daysFromCivil}. */
function civilFromDays(days: number): { year: number; month: number; day: number } {
  const shifted = days + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra - (yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthIndex = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthIndex + 2) / 5) + 1;
  const month = monthIndex + (monthIndex < 10 ? 3 : -9);
  return { day, month, year: year + (month <= 2 ? 1 : 0) };
}
