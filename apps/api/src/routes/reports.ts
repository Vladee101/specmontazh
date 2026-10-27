import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Role, SystemType, TaskStatus } from '../db/types.js';
import { badRequest, parse } from '../http/errors.js';
import { isoDate, optionalId, systemType, taskStatus } from '../http/schemas.js';
import { remarksOf, reportCsv, reportRows, reportSummary, type ReportFilter } from '../services/report.js';

const manager = { config: { roles: ['manager'] as Role[] } };

const ReportQuery = z.object({
  date_from: isoDate.optional(),
  date_to: isoDate.optional(),
  object_id: optionalId,
  system_type: systemType.optional(),
  engineer_id: optionalId,
  status: taskStatus.optional(),
});

function filterOf(query: unknown): ReportFilter {
  const q = parse(ReportQuery, query);
  if (q.date_from && q.date_to && q.date_from > q.date_to) {
    throw badRequest('Начало периода позже конца', { date_to: 'Конец периода раньше начала' });
  }
  return { ...q, system_type: q.system_type as SystemType | undefined, status: q.status as TaskStatus | undefined };
}

export async function reportRoutes(app: FastifyInstance) {
  const { db, config } = app.ctx;

  app.get('/reports/maintenance', manager, async (req) => {
    const rows = await reportRows(db, filterOf(req.query));
    return {
      summary: reportSummary(rows),
      items: rows.map((row) => {
        const { check_remarks: _, ...rest } = row;
        return { ...rest, remarks: remarksOf(row) };
      }),
    };
  });

  app.get('/reports/maintenance.csv', manager, async (req, reply) => {
    const filter = filterOf(req.query);
    const rows = await reportRows(db, filter);
    const name = `maintenance-report_${filter.date_from ?? 'start'}_${filter.date_to ?? 'end'}.csv`;
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'no-store');
    return reportCsv(rows, config.timeZone);
  });
}
