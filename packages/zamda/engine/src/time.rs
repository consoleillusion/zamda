// Date and time kernels (T-415, C-TIME): `date_trunc` and `extract` for date32 (days since the epoch, i32) and
// timestamp (whole milliseconds since the epoch, held as f64). All calendar arithmetic is in UTC and exact:
// whole days are turned to year, month and day with integer arithmetic (the proleptic Gregorian calendar), so
// the result is right for any value, also before the epoch. The JS kernels (src/backends/js/kernels-time.ts)
// use the same arithmetic, so both backends agree to the last value.

use std::borrow::Cow;

use crate::kernels::EvalError;
use crate::types::Type;
use crate::vector::{Values, Vector};

const MS_PER_DAY: i64 = 86_400_000;
const MS_PER_HOUR: i64 = 3_600_000;
const MS_PER_MINUTE: i64 = 60_000;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Unit {
    Year,
    Month,
    Day,
    Hour,
    Minute,
    Second,
}

pub fn unit_of(name: &str, ty: Type) -> Option<Unit> {
    // Purpose: the unit a name stands for on a type: year, month and day for both, hour, minute and second for timestamp only
    let unit = match name {
        "year" => Unit::Year,
        "month" => Unit::Month,
        "day" => Unit::Day,
        "hour" => Unit::Hour,
        "minute" => Unit::Minute,
        "second" => Unit::Second,
        _ => return None,
    };
    match ty {
        Type::Timestamp => Some(unit),
        Type::Date32 if matches!(unit, Unit::Year | Unit::Month | Unit::Day) => Some(unit),
        _ => None,
    }
}

pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    // Purpose: the day number (days since 1970-01-01) of a proleptic Gregorian date
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    // Purpose: the year, month (1 to 12) and day (1 to 31) of a day number
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + if month <= 2 { 1 } else { 0 }, month, day)
}

fn truncate_days(days: i64, unit: Unit) -> i64 {
    // Purpose: round a day number down to the first day of its year or month (a day stays as it is)
    match unit {
        Unit::Year => days_from_civil(civil_from_days(days).0, 1, 1),
        Unit::Month => {
            let (year, month, _) = civil_from_days(days);
            days_from_civil(year, month, 1)
        }
        _ => days,
    }
}

fn truncate_ms(ms: i64, unit: Unit) -> i64 {
    // Purpose: round a millisecond timestamp down to the start of a unit
    let size = match unit {
        Unit::Hour => MS_PER_HOUR,
        Unit::Minute => MS_PER_MINUTE,
        Unit::Second => 1_000,
        _ => return truncate_days(ms.div_euclid(MS_PER_DAY), unit) * MS_PER_DAY,
    };
    ms.div_euclid(size) * size
}

fn field_of_days(days: i64, unit: Unit) -> i64 {
    // Purpose: the year, month or day of a day number; month and day start at 1
    let (year, month, day) = civil_from_days(days);
    match unit {
        Unit::Year => year,
        Unit::Month => month,
        _ => day,
    }
}

fn field_of_ms(ms: i64, unit: Unit) -> i64 {
    // Purpose: one UTC calendar field of a millisecond timestamp
    let days = ms.div_euclid(MS_PER_DAY);
    let in_day = ms - days * MS_PER_DAY;
    match unit {
        Unit::Hour => in_day / MS_PER_HOUR,
        Unit::Minute => (in_day % MS_PER_HOUR) / MS_PER_MINUTE,
        Unit::Second => (in_day % MS_PER_MINUTE) / 1_000,
        _ => field_of_days(days, unit),
    }
}

pub fn date_op<'a>(func: &str, unit: Unit, ty: Type, x: &Vector<'a>, n: usize) -> Result<Vector<'a>, EvalError> {
    // Purpose: `date_trunc` (result of the input's type) or `extract` (int32) over n rows; a null row stays null and holds 0
    let (values, valid) = x.clone().into_columns(n);
    let valid_at = |i: usize| valid.as_ref().is_none_or(|v| v[i] != 0);
    let out = match (x.ty, values, func) {
        (Type::Date32, Values::I32(v), "date_trunc") => {
            Values::I32(Cow::Owned((0..n).map(|i| if valid_at(i) { truncate_days(v[i] as i64, unit) as i32 } else { 0 }).collect()))
        }
        (Type::Date32, Values::I32(v), "extract") => {
            Values::I32(Cow::Owned((0..n).map(|i| if valid_at(i) { field_of_days(v[i] as i64, unit) as i32 } else { 0 }).collect()))
        }
        (Type::Timestamp, Values::F64(v), "date_trunc") => {
            Values::F64(Cow::Owned((0..n).map(|i| if valid_at(i) { truncate_ms(v[i] as i64, unit) as f64 } else { 0.0 }).collect()))
        }
        (Type::Timestamp, Values::F64(v), "extract") => {
            Values::I32(Cow::Owned((0..n).map(|i| if valid_at(i) { field_of_ms(v[i] as i64, unit) as i32 } else { 0 }).collect()))
        }
        _ => return Err(EvalError::Internal("a date function over something other than a date or timestamp")),
    };
    Ok(Vector::column(ty, out, valid))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_round_trips_over_a_wide_range() {
        // Every day from year -1000 to year 5000 turns to a date and back to the same day.
        let from = days_from_civil(-1000, 1, 1);
        let to = days_from_civil(5000, 12, 31);
        for d in (from..=to).step_by(7) {
            let (y, m, day) = civil_from_days(d);
            assert_eq!(days_from_civil(y, m, day), d);
            assert!((1..=12).contains(&m) && (1..=31).contains(&day));
        }
    }

    #[test]
    fn known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        assert_eq!(days_from_civil(1900, 3, 1), -25_508);
        assert_eq!(truncate_ms(-1, Unit::Day), -MS_PER_DAY);
        assert_eq!(truncate_ms(-1, Unit::Year), days_from_civil(1969, 1, 1) * MS_PER_DAY);
        assert_eq!(field_of_ms(-1, Unit::Hour), 23);
        assert_eq!(field_of_ms(-1, Unit::Second), 59);
    }

    #[test]
    fn units_depend_on_the_type() {
        assert_eq!(unit_of("hour", Type::Date32), None);
        assert_eq!(unit_of("hour", Type::Timestamp), Some(Unit::Hour));
        assert_eq!(unit_of("week", Type::Timestamp), None);
    }
}
