//! Its own test binary because it sets `TZ`, which the whole process sees.
//! Windows reads its zone from the system, not `TZ`.
#![cfg(unix)]

use chrono::{Local, TimeZone};
use mindstream_plugin_runtime::dates::{add, TimeUnit};

#[test]
fn a_month_ahead_can_land_in_the_hour_clocks_repeat() {
    // Clocks go back from 03:00 to 02:00 on the last Sunday of October,
    // 2026-10-25, so 02:30 that day happens twice.
    std::env::set_var("TZ", "CET-1CEST,M3.5.0,M10.5.0/3");
    let start = Local
        .with_ymd_and_hms(2026, 9, 25, 2, 30, 0)
        .single()
        .unwrap();
    let next = add(start, 1, TimeUnit::Month).unwrap();
    // The first 02:30, still in summer time.
    assert_eq!(next.to_rfc3339(), "2026-10-25T02:30:00+02:00");
}
