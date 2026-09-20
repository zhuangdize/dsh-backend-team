import { parse } from 'pgsql-ast-parser'

export type SqlRisk = 'standard' | 'high' | 'destructive'
export interface SqlRiskResult { readonly risk: SqlRisk; readonly reasons: readonly string[]; readonly statementCount: number }

export class SqlRiskAnalyzer {
  analyze(sql: string): SqlRiskResult {
    let statements: unknown[]
    try { statements = parse(sql) } catch { return { risk: 'high', reasons: ['SQL could not be parsed safely'], statementCount: 0 } }
    const reasons: string[] = []; let risk: SqlRisk = 'standard'
    for (const statement of statements) {
      const type = String((statement as { type?: unknown }).type ?? '')
      if (/drop table|drop schema|drop database|truncate|drop index|drop view/i.test(type)) { risk = 'destructive'; reasons.push(type) }
      else if (/alter table/i.test(type)) {
        const changes = (statement as { changes?: Array<{ type?: string; alter?: { type?: string } }> }).changes ?? []
        for (const change of changes) {
          if (/drop column|drop constraint|drop primary|drop foreign/i.test(change.type ?? '')) { risk = 'destructive'; reasons.push(change.type ?? 'destructive alter') }
          else if (/set type|set not null|rewrite|enum/i.test(`${change.type ?? ''} ${change.alter?.type ?? ''}`)) { if (risk !== 'destructive') risk = 'high'; reasons.push(change.type ?? 'high-risk alter') }
        }
      } else if (/delete|update/i.test(type)) { if (risk !== 'destructive') risk = 'high'; reasons.push(`${type} requires a bounded predicate`) }
      else if (/do|create function|create procedure/i.test(type)) { if (risk !== 'destructive') risk = 'high'; reasons.push('procedural SQL requires review') }
    }
    return { risk, reasons, statementCount: statements.length }
  }
}
