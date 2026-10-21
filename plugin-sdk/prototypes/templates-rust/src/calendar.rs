//! Guest-local comparison of the current host date contract.
//! Algorithms/token tables copied from plugin-runtime/src/dates.rs; intentionally
//! retains 24-hour day/week shifts and original-time fallback for DST gaps/folds.
use chrono::{DateTime, Datelike, TimeZone, Timelike};
use chrono_tz::Tz;
use std::fmt::Write as _;

pub fn render(
    timestamp: &str,
    zone: &str,
    offsets: impl Iterator<Item = (i64, u8)>,
    pattern: &str,
    locale: &str,
) -> Result<String, String> {
    let zone: Tz = zone.parse().map_err(|_| "unknown IANA timeZone")?;
    let mut time = DateTime::parse_from_rfc3339(timestamp)
        .map_err(|_| "invalid timestamp")?
        .with_timezone(&zone);
    for (amount, unit) in offsets {
        let unit = match unit {
            b'y' => TimeUnit::Year,
            b'M' => TimeUnit::Month,
            b'w' => TimeUnit::Week,
            b'd' => TimeUnit::Day,
            b'h' => TimeUnit::Hour,
            b'm' => TimeUnit::Minute,
            _ => TimeUnit::Second,
        };
        time = add(time, amount, unit).ok_or("calendar offset out of range")?;
    }
    Ok(format(&time, pattern, locale))
}

/// A calendar unit for [`add`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeUnit {
    Second,
    Minute,
    Hour,
    Day,
    Week,
    Month,
    Year,
}

/// Shift `dt` by `amount` units. Months and years clamp the day to the length
/// of the target month. `None` when the result is out of range: an amount is
/// plugin input, and chrono's operators panic on overflow.
pub fn add(dt: DateTime<Tz>, amount: i64, unit: TimeUnit) -> Option<DateTime<Tz>> {
    use chrono::TimeDelta;
    let delta = match unit {
        TimeUnit::Second => TimeDelta::try_seconds(amount),
        TimeUnit::Minute => TimeDelta::try_minutes(amount),
        TimeUnit::Hour => TimeDelta::try_hours(amount),
        TimeUnit::Day => TimeDelta::try_days(amount),
        TimeUnit::Week => TimeDelta::try_weeks(amount),
        TimeUnit::Month => return add_months(dt, amount),
        TimeUnit::Year => return add_months(dt, amount.checked_mul(12)?),
    };
    dt.checked_add_signed(delta?)
}

fn add_months(dt: DateTime<Tz>, months: i64) -> Option<DateTime<Tz>> {
    let total = (dt.year() as i64 * 12 + dt.month0() as i64).checked_add(months)?;
    let year = i32::try_from(total.div_euclid(12)).ok()?;
    let month0 = total.rem_euclid(12) as u32;
    let day = dt.day().min(days_in_month(year, month0 + 1));
    // A local time skipped by a DST change has no single answer; keep the
    // original rather than guess, as before.
    Some(
        dt.timezone()
            .with_ymd_and_hms(year, month0 + 1, day, dt.hour(), dt.minute(), dt.second())
            .single()
            .unwrap_or(dt),
    )
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => 30,
    }
}

// English month and weekday names, moment's default locale.
const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const MONTHS_SHORT: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const WEEKDAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];
const WEEKDAYS_SHORT: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// The app ships only `en` and `de`, so a locale that starts with "de" selects
// these and anything else falls back to English.
const MONTHS_DE: [&str; 12] = [
    "Januar",
    "Februar",
    "März",
    "April",
    "Mai",
    "Juni",
    "Juli",
    "August",
    "September",
    "Oktober",
    "November",
    "Dezember",
];
const MONTHS_SHORT_DE: [&str; 12] = [
    "Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez",
];
const WEEKDAYS_DE: [&str; 7] = [
    "Sonntag",
    "Montag",
    "Dienstag",
    "Mittwoch",
    "Donnerstag",
    "Freitag",
    "Samstag",
];
const WEEKDAYS_SHORT_DE: [&str; 7] = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

/// Format a local datetime with moment-style tokens (`YYYY MM DD HH mm ss`,
/// named `MMMM/MMM/dddd/ddd`, `hh h A a`, `[escaped]` literals). Other
/// characters pass through.
pub fn format(dt: &DateTime<Tz>, fmt: &str, locale: &str) -> String {
    let german = locale.starts_with("de");
    let months = if german { &MONTHS_DE } else { &MONTHS };
    let months_short = if german {
        &MONTHS_SHORT_DE
    } else {
        &MONTHS_SHORT
    };
    let weekdays = if german { &WEEKDAYS_DE } else { &WEEKDAYS };
    let weekdays_short = if german {
        &WEEKDAYS_SHORT_DE
    } else {
        &WEEKDAYS_SHORT
    };
    let chars: Vec<char> = fmt.chars().collect();
    let month0 = dt.month0() as usize;
    let weekday0 = dt.weekday().num_days_from_sunday() as usize;
    let h24 = dt.hour();
    let h12 = match h24 % 12 {
        0 => 12,
        h => h,
    };
    // Tried longest first at each position.
    const TOKENS: [&str; 20] = [
        "YYYY", "YY", "MMMM", "MMM", "MM", "M", "DD", "D", "dddd", "ddd", "HH", "H", "hh", "h",
        "mm", "m", "ss", "s", "A", "a",
    ];
    let mut out = String::new();
    let mut i = 0;
    'outer: while i < chars.len() {
        // `[literal]` is copied up to the next `]`.
        if chars[i] == '[' {
            let mut j = i + 1;
            while j < chars.len() && chars[j] != ']' {
                out.push(chars[j]);
                j += 1;
            }
            i = if j < chars.len() { j + 1 } else { j };
            continue;
        }
        for tok in TOKENS {
            let t: Vec<char> = tok.chars().collect();
            if chars[i..].starts_with(&t[..]) {
                let _ = match tok {
                    "YYYY" => write!(out, "{}", dt.year()),
                    "YY" => write!(out, "{:02}", dt.year().rem_euclid(100)),
                    "MMMM" => write!(out, "{}", months[month0]),
                    "MMM" => write!(out, "{}", months_short[month0]),
                    "MM" => write!(out, "{:02}", month0 + 1),
                    "M" => write!(out, "{}", month0 + 1),
                    "DD" => write!(out, "{:02}", dt.day()),
                    "D" => write!(out, "{}", dt.day()),
                    "dddd" => write!(out, "{}", weekdays[weekday0]),
                    "ddd" => write!(out, "{}", weekdays_short[weekday0]),
                    "HH" => write!(out, "{h24:02}"),
                    "H" => write!(out, "{h24}"),
                    "hh" => write!(out, "{h12:02}"),
                    "h" => write!(out, "{h12}"),
                    "mm" => write!(out, "{:02}", dt.minute()),
                    "m" => write!(out, "{}", dt.minute()),
                    "ss" => write!(out, "{:02}", dt.second()),
                    "s" => write!(out, "{}", dt.second()),
                    "A" => write!(out, "{}", if h24 < 12 { "AM" } else { "PM" }),
                    _ => write!(out, "{}", if h24 < 12 { "am" } else { "pm" }),
                };
                i += t.len();
                continue 'outer;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn month_clamping_and_leap_years() {
        assert_eq!(
            render(
                "2028-01-31T12:00:00Z",
                "UTC",
                [(1, b'M')].into_iter(),
                "YYYY-MM-DD",
                "en"
            )
            .unwrap(),
            "2028-02-29"
        );
        assert_eq!(
            render(
                "2026-01-31T12:00:00Z",
                "UTC",
                [(1, b'M')].into_iter(),
                "YYYY-MM-DD",
                "en"
            )
            .unwrap(),
            "2026-02-28"
        );
    }
    #[test]
    fn timezone_and_localized_token_set() {
        let pattern = "YYYY YY MMMM MMM MM M DD D dddd ddd HH H hh h mm m ss s A a [literal] [open";
        assert_eq!(
            render(
                "2026-07-25T10:05:09Z",
                "Europe/Berlin",
                [].into_iter(),
                pattern,
                "de-AT"
            )
            .unwrap(),
            "2026 26 Juli Jul 07 7 25 25 Samstag Sa 12 12 12 12 05 5 09 9 PM pm literal open"
        );
        assert_eq!(
            render(
                "2026-07-25T00:30:00Z",
                "America/New_York",
                [].into_iter(),
                "YYYY-MM-DD HH:mm",
                "en"
            )
            .unwrap(),
            "2026-07-24 20:30"
        );
    }
    #[test]
    fn current_host_day_semantics_are_24_hours_across_dst() {
        assert_eq!(
            render(
                "2026-03-28T11:00:00Z",
                "Europe/Berlin",
                [(1, b'd')].into_iter(),
                "YYYY-MM-DD HH:mm",
                "en"
            )
            .unwrap(),
            "2026-03-29 13:00"
        );
    }
    #[test]
    fn month_shift_uses_destination_zone_offset() {
        assert_eq!(
            render(
                "2026-03-01T11:00:00Z",
                "Europe/Berlin",
                [(1, b'M')].into_iter(),
                "YYYY-MM-DD HH:mm",
                "en"
            )
            .unwrap(),
            "2026-04-01 12:00"
        );
    }
    #[test]
    fn gap_and_fold_keep_original_like_host() {
        for (input, expected) in [
            ("2026-01-29T01:30:00Z", "2026-01-29 02:30"),
            ("2026-08-25T00:30:00Z", "2026-08-25 02:30"),
        ] {
            assert_eq!(
                render(
                    input,
                    "Europe/Berlin",
                    [(2, b'M')].into_iter(),
                    "YYYY-MM-DD HH:mm",
                    "en"
                )
                .unwrap(),
                expected
            );
        }
    }
    #[test]
    fn invalid_inputs_and_overflow_are_errors() {
        assert!(render("bad", "UTC", [].into_iter(), "YYYY", "en").is_err());
        assert!(render(
            "2026-01-01T00:00:00Z",
            "bad/zone",
            [].into_iter(),
            "YYYY",
            "en"
        )
        .is_err());
        for unit in b"yMwdhms" {
            for amount in [i64::MIN, i64::MAX] {
                assert!(render(
                    "2026-01-01T00:00:00Z",
                    "UTC",
                    [(amount, *unit)].into_iter(),
                    "YYYY",
                    "en"
                )
                .is_err());
            }
        }
    }
}
