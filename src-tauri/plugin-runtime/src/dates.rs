//! Local dates for plugins: the moment-style formatter and calendar arithmetic
//! behind `clock.format`, `clock.add` and Luau's `ms.date`.
//!
//! The tokens match the frontend template engine (`YYYY-MM-DD`, `HH:mm`,
//! `dddd`, ...), so a plugin's dates read the same as `{{date:...}}`. A guest
//! has no time zone database, which is why this lives in the host.

use std::fmt::Write as _;

use chrono::{DateTime, Datelike, Local, TimeZone, Timelike};

/// A point in time as a plugin hands it over.
#[derive(Debug, Clone, PartialEq)]
pub enum DateInput {
    Rfc3339(String),
    EpochSeconds(i64),
}

impl DateInput {
    /// The local datetime, or `None` for an unparseable timestamp.
    pub fn to_local(&self) -> Option<DateTime<Local>> {
        match self {
            DateInput::Rfc3339(s) => DateTime::parse_from_rfc3339(s)
                .ok()
                .map(|dt| dt.with_timezone(&Local)),
            DateInput::EpochSeconds(secs) => {
                DateTime::from_timestamp(*secs, 0).map(|dt| dt.with_timezone(&Local))
            }
        }
    }
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

impl TimeUnit {
    /// `second` .. `year`, singular or plural.
    pub fn parse(unit: &str) -> Option<Self> {
        Some(match unit.trim_end_matches('s') {
            "second" => Self::Second,
            "minute" => Self::Minute,
            "hour" => Self::Hour,
            "day" => Self::Day,
            "week" => Self::Week,
            "month" => Self::Month,
            "year" => Self::Year,
            _ => return None,
        })
    }
}

/// The current local time.
pub fn now() -> DateTime<Local> {
    Local::now()
}

/// Shift `dt` by `amount` units. Months and years clamp the day to the length
/// of the target month. `None` when the result is out of range: an amount is
/// plugin input, and chrono's operators panic on overflow.
pub fn add(dt: DateTime<Local>, amount: i64, unit: TimeUnit) -> Option<DateTime<Local>> {
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

fn add_months(dt: DateTime<Local>, months: i64) -> Option<DateTime<Local>> {
    let total = (dt.year() as i64 * 12 + dt.month0() as i64).checked_add(months)?;
    let year = i32::try_from(total.div_euclid(12)).ok()?;
    let month0 = total.rem_euclid(12) as u32;
    let day = dt.day().min(days_in_month(year, month0 + 1));
    // A local time skipped by a DST change has no single answer; keep the
    // original rather than guess, as before.
    Some(
        Local
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
pub fn format(dt: &DateTime<Local>, fmt: &str, locale: &str) -> String {
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

    fn fixed() -> DateTime<Local> {
        Local
            .with_ymd_and_hms(2026, 7, 25, 14, 5, 9)
            .single()
            .unwrap()
    }

    #[test]
    fn format_covers_the_token_set() {
        let dt = fixed();
        assert_eq!(
            format(&dt, "YYYY-MM-DD HH:mm:ss", "en"),
            "2026-07-25 14:05:09"
        );
        assert_eq!(format(&dt, "dddd, MMMM D", "en"), "Saturday, July 25");
        assert_eq!(format(&dt, "hh:mm A", "en"), "02:05 PM");
        assert_eq!(format(&dt, "h:m:s a", "en"), "2:5:9 pm");
        assert_eq!(format(&dt, "YY M ddd MMM H", "en"), "26 7 Sat Jul 14");
        assert_eq!(format(&dt, "[Week] YYYY", "en"), "Week 2026");
        assert_eq!(format(&dt, "[open", "en"), "open");
    }

    #[test]
    fn format_localizes_names_for_german() {
        let dt = fixed();
        assert_eq!(format(&dt, "dddd, D. MMMM", "de"), "Samstag, 25. Juli");
        assert_eq!(format(&dt, "ddd MMM", "de-AT"), "Sa Jul");
        assert_eq!(format(&dt, "YYYY-MM-DD", "de"), "2026-07-25");
    }

    #[test]
    fn midnight_and_noon_read_as_twelve() {
        let midnight = Local
            .with_ymd_and_hms(2026, 1, 1, 0, 0, 0)
            .single()
            .unwrap();
        assert_eq!(format(&midnight, "h A", "en"), "12 AM");
        let noon = Local
            .with_ymd_and_hms(2026, 1, 1, 12, 0, 0)
            .single()
            .unwrap();
        assert_eq!(format(&noon, "hh a", "en"), "12 pm");
    }

    #[test]
    fn units_parse_singular_and_plural() {
        assert_eq!(TimeUnit::parse("day"), Some(TimeUnit::Day));
        assert_eq!(TimeUnit::parse("months"), Some(TimeUnit::Month));
        assert_eq!(TimeUnit::parse("seconds"), Some(TimeUnit::Second));
        assert_eq!(TimeUnit::parse("fortnight"), None);
    }

    #[test]
    fn adding_months_clamps_to_the_target_month() {
        let jan31 = Local
            .with_ymd_and_hms(2026, 1, 31, 9, 0, 0)
            .single()
            .unwrap();
        let shifted = |dt, n, unit| format(&add(dt, n, unit).unwrap(), "YYYY-MM-DD HH:mm:ss", "en");
        assert_eq!(shifted(jan31, 1, TimeUnit::Month), "2026-02-28 09:00:00");
        let leap = Local
            .with_ymd_and_hms(2028, 1, 31, 9, 0, 0)
            .single()
            .unwrap();
        assert_eq!(shifted(leap, 1, TimeUnit::Month), "2028-02-29 09:00:00");
        assert_eq!(shifted(jan31, -1, TimeUnit::Year), "2025-01-31 09:00:00");
        assert_eq!(shifted(jan31, 2, TimeUnit::Week), "2026-02-14 09:00:00");
        let dt = fixed();
        assert_eq!(shifted(dt, 1, TimeUnit::Hour), "2026-07-25 15:05:09");
        assert_eq!(shifted(dt, 1, TimeUnit::Minute), "2026-07-25 14:06:09");
        assert_eq!(shifted(dt, 1, TimeUnit::Second), "2026-07-25 14:05:10");
        assert_eq!(shifted(dt, 1, TimeUnit::Day), "2026-07-26 14:05:09");
    }

    #[test]
    fn out_of_range_shifts_are_refused_rather_than_panicking() {
        let dt = fixed();
        for unit in [
            TimeUnit::Second,
            TimeUnit::Minute,
            TimeUnit::Hour,
            TimeUnit::Day,
            TimeUnit::Week,
            TimeUnit::Month,
            TimeUnit::Year,
        ] {
            assert!(add(dt, i64::MAX, unit).is_none(), "{unit:?}");
            assert!(add(dt, i64::MIN, unit).is_none(), "{unit:?}");
        }
    }

    #[test]
    fn days_in_month_follows_the_gregorian_rules() {
        assert_eq!(days_in_month(2026, 4), 30);
        assert_eq!(days_in_month(2000, 2), 29);
        assert_eq!(days_in_month(1900, 2), 28);
        assert_eq!(days_in_month(2026, 13), 30);
    }

    #[test]
    fn inputs_parse_from_rfc3339_or_epoch_seconds() {
        let iso = DateInput::Rfc3339("2026-07-25T14:05:09Z".into());
        assert_eq!(iso.to_local().unwrap().timestamp(), 1_784_988_309);
        let epoch = DateInput::EpochSeconds(1_784_988_309);
        assert_eq!(epoch.to_local(), iso.to_local());
        assert!(DateInput::Rfc3339("yesterday".into()).to_local().is_none());
        assert!(DateInput::EpochSeconds(i64::MAX).to_local().is_none());
    }
}
