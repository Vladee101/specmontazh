import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from '../src/lib/csv.js';
import { addDays, addMonths, dateIn, dateTimeIn, isIsoDate, nextScheduledDate } from '../src/lib/dates.js';
import { hashPassword, verifyPassword } from '../src/lib/password.js';

describe('даты', () => {
  it('AT-06: ежемесячное ТО с 31 января — последний день февраля, затем 31 марта', () => {
    const anchor = '2026-01-31';
    const feb = nextScheduledDate(anchor, anchor, 1);
    const mar = nextScheduledDate(anchor, feb, 1);
    const apr = nextScheduledDate(anchor, mar, 1);
    expect([feb, mar, apr]).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
    // високосный год
    expect(nextScheduledDate('2028-01-31', '2028-01-31', 1)).toBe('2028-02-29');
  });

  it('квартальный график считается от опорной даты', () => {
    const anchor = '2026-11-30';
    const d1 = nextScheduledDate(anchor, anchor, 3);
    const d2 = nextScheduledDate(anchor, d1, 3);
    expect([d1, d2]).toEqual(['2027-02-28', '2027-05-30']);
  });

  it('прибавление дней и месяцев, проверка формата', () => {
    expect(addDays('2026-12-30', 5)).toBe('2027-01-04');
    expect(addMonths('2026-12-15', 2)).toBe('2027-02-15');
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('26-1-1')).toBe(false);
  });

  it('московский календарный день', () => {
    // 21:30 UTC — уже следующий день по Москве (UTC+3)
    expect(dateIn('Europe/Moscow', new Date('2026-10-26T21:30:00Z'))).toBe('2026-10-27');
    expect(dateTimeIn('Europe/Moscow', new Date('2026-10-25T08:20:00Z'))).toBe('2026-10-25 11:20');
  });
});

describe('CSV', () => {
  it('AT-20: опасный текст экранируется от формул, кавычки и разделители — по правилам CSV', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+79000000000')).toBe("'+79000000000");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('а;б')).toBe('"а;б"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(false)).toBe('false');
  });

  it('BOM, разделитель ; и CRLF', () => {
    const text = toCsv(['a', 'b'], [[1, 'x']]);
    expect(text.startsWith('﻿a;b\r\n1;x')).toBe(true);
  });
});

describe('пароли', () => {
  it('scrypt: верный пароль проходит, неверный — нет', async () => {
    const hash = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});
