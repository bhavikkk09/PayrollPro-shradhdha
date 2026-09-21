import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SalaryComponent } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { FormulaError, identifiers, parse } from './formula';
import { calculateSalary, CalcItem } from './salary-calculator';

const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? null : Number(d));
const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);

export interface StructureItemInput {
  componentId: string; sequence: number;
  calcMethod?: CalcItem['calcMethod']; percentage?: number; percentOf?: string; fixedAmount?: number; formula?: string;
}

@Injectable()
export class SalaryService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  // ───────── Components ─────────
  listComponents(companyId: string) {
    return this.prisma.salaryComponent.findMany({ where: { companyId }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] });
  }

  async createComponent(u: AuthUser, companyId: string, d: Record<string, any>, ip?: string) {
    this.checkComponent(d);
    try {
      const row = await this.prisma.salaryComponent.create({ data: this.componentData(d, companyId) as Prisma.SalaryComponentUncheckedCreateInput });
      await this.audit.log({ userId: u.id, companyId, action: 'SALARY_COMPONENT_CREATED', module: 'salary', recordId: row.id, newValue: row, ip });
      return row;
    } catch (e: any) {
      if (e.code === 'P2002') throw new ConflictException('A component with this code and effective date already exists');
      throw e;
    }
  }

  async updateComponent(u: AuthUser, companyId: string, id: string, d: Record<string, any>, ip?: string) {
    const old = await this.prisma.salaryComponent.findFirst({ where: { id, companyId } });
    if (!old) throw new NotFoundException('Component not found');
    if (d.code && d.code !== old.code) throw new BadRequestException('Component code cannot be changed; create a new component instead');
    this.checkComponent({ ...old, ...d, percentage: d.percentage ?? num(old.percentage), fixedAmount: d.fixedAmount ?? num(old.fixedAmount) });
    const row = await this.prisma.salaryComponent.update({ where: { id }, data: this.componentData(d) });
    // Employee salaries and past payroll store their own snapshot, so this edit never rewrites history.
    await this.audit.log({ userId: u.id, companyId, action: 'SALARY_COMPONENT_UPDATED', module: 'salary', recordId: id, oldValue: old, newValue: row, ip });
    return row;
  }

  async deleteComponent(u: AuthUser, companyId: string, id: string, ip?: string) {
    const old = await this.prisma.salaryComponent.findFirst({ where: { id, companyId } });
    if (!old) throw new NotFoundException('Component not found');
    const used = await this.prisma.salaryStructureItem.count({ where: { componentId: id } });
    if (used) throw new ConflictException(`Used in ${used} salary structure(s). Deactivate it instead.`);
    await this.prisma.salaryComponent.delete({ where: { id } });
    await this.audit.log({ userId: u.id, companyId, action: 'SALARY_COMPONENT_DELETED', module: 'salary', recordId: id, oldValue: old, ip });
    return { ok: true };
  }

  private checkComponent(d: Record<string, any>) {
    if (d.effectiveTo && d.effectiveFrom && new Date(d.effectiveTo) < new Date(d.effectiveFrom)) throw new BadRequestException('Effective To is before Effective From');
    if (d.calcMethod === 'PERCENTAGE' && d.percentage == null) throw new BadRequestException('Percentage is required for PERCENTAGE components');
    if (d.calcMethod === 'FORMULA') this.checkFormula(d.formula);
  }

  private checkFormula(f?: string | null) {
    if (!f) throw new BadRequestException('Formula is required for FORMULA components');
    try { parse(f); } catch (e) { throw new BadRequestException(`Invalid formula: ${e instanceof Error ? e.message : 'error'}`); }
  }

  private componentData(d: Record<string, any>, companyId?: string) {
    const { effectiveFrom, effectiveTo, ...rest } = d;
    const data: Record<string, any> = { ...rest };
    if (companyId) data.companyId = companyId;
    if (effectiveFrom) data.effectiveFrom = day(effectiveFrom);
    if (effectiveTo !== undefined) data.effectiveTo = effectiveTo ? day(effectiveTo) : null;
    return data;
  }

  // ───────── Structures ─────────
  listStructures(companyId: string) {
    return this.prisma.salaryStructure.findMany({
      where: { companyId }, orderBy: { name: 'asc' },
      include: { _count: { select: { items: true, employeeSalaries: true } } },
    });
  }

  async getStructure(companyId: string, id: string) {
    const s = await this.prisma.salaryStructure.findFirst({
      where: { id, companyId },
      include: { items: { orderBy: { sequence: 'asc' }, include: { component: true } } },
    });
    if (!s) throw new NotFoundException('Structure not found');
    return s;
  }

  async createStructure(u: AuthUser, companyId: string, d: { name: string; items: StructureItemInput[] }, ip?: string) {
    await this.validateItems(companyId, d.items);
    try {
      const s = await this.prisma.salaryStructure.create({
        data: { companyId, name: d.name, items: { create: d.items.map((i) => this.itemData(i)) } },
      });
      await this.audit.log({ userId: u.id, companyId, action: 'SALARY_STRUCTURE_CREATED', module: 'salary', recordId: s.id, newValue: { ...s, items: d.items }, ip });
      return this.getStructure(companyId, s.id);
    } catch (e: any) {
      if (e.code === 'P2002') throw new ConflictException('A structure with this name already exists');
      throw e;
    }
  }

  async updateStructure(u: AuthUser, companyId: string, id: string, d: { name?: string; active?: boolean; items?: StructureItemInput[] }, ip?: string) {
    const old = await this.getStructure(companyId, id);
    if (d.items) await this.validateItems(companyId, d.items);
    try {
      await this.prisma.$transaction(async (tx) => {
        if (d.items) {
          await tx.salaryStructureItem.deleteMany({ where: { structureId: id } });
          await tx.salaryStructureItem.createMany({ data: d.items!.map((i) => ({ ...this.itemData(i), structureId: id })) });
        }
        await tx.salaryStructure.update({ where: { id }, data: { name: d.name, active: d.active } });
      });
    } catch (e: any) {
      if (e.code === 'P2002') throw new ConflictException('A structure with this name already exists');
      throw e;
    }
    const fresh = await this.getStructure(companyId, id);
    await this.audit.log({ userId: u.id, companyId, action: 'SALARY_STRUCTURE_UPDATED', module: 'salary', recordId: id, oldValue: old, newValue: fresh, ip });
    return fresh;
  }

  async deleteStructure(u: AuthUser, companyId: string, id: string, ip?: string) {
    const old = await this.getStructure(companyId, id);
    const used = await this.prisma.employeeSalary.count({ where: { structureId: id } });
    if (used) throw new ConflictException(`Assigned to ${used} employee salary record(s). Deactivate it instead.`);
    await this.prisma.salaryStructure.delete({ where: { id } });
    await this.audit.log({ userId: u.id, companyId, action: 'SALARY_STRUCTURE_DELETED', module: 'salary', recordId: id, oldValue: old, ip });
    return { ok: true };
  }

  private itemData(i: StructureItemInput) {
    return {
      componentId: i.componentId, sequence: i.sequence, calcMethod: i.calcMethod ?? null,
      percentage: i.percentage ?? null, percentOf: i.percentOf?.toUpperCase() ?? null,
      fixedAmount: i.fixedAmount ?? null, formula: i.formula ?? null,
    };
  }

  /** Components must belong to this company, and a dry run with a sample gross must succeed. */
  private async validateItems(companyId: string, items: StructureItemInput[]) {
    if (!items?.length) throw new BadRequestException('A structure needs at least one component');
    const ids = items.map((i) => i.componentId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('A component appears more than once');
    if (new Set(items.map((i) => i.sequence)).size !== items.length) throw new BadRequestException('Sequence numbers must be unique');
    const comps = await this.prisma.salaryComponent.findMany({ where: { id: { in: ids }, companyId } });
    if (comps.length !== ids.length) throw new BadRequestException('Unknown component (or it belongs to another company)');
    for (const i of items) if (i.formula) this.checkFormula(i.formula);
    try { calculateSalary(100000, this.toCalcItems(items, comps)); } catch (e) {
      if (e instanceof FormulaError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  private toCalcItems(items: any[], comps: SalaryComponent[]): CalcItem[] {
    const byId = new Map(comps.map((c) => [c.id, c]));
    return items.map((i) => {
      const c = byId.get(i.componentId)!;
      const method = (i.calcMethod ?? c.calcMethod) as CalcItem['calcMethod'];
      return {
        code: c.code, name: c.name, type: c.type, calcMethod: method, sequence: i.sequence,
        percentage: num(i.percentage) ?? num(c.percentage), percentOf: i.percentOf ?? c.percentOf,
        fixedAmount: num(i.fixedAmount) ?? num(c.fixedAmount), formula: i.formula ?? c.formula,
      };
    });
  }

  async preview(companyId: string, structureId: string, gross: number, rawOverrides: Record<string, number> = {}) {
    const overrides = this.cleanOverrides(rawOverrides);
    const s = await this.getStructure(companyId, structureId);
    try { return calculateSalary(gross, this.toCalcItems(s.items as any, s.items.map((i) => i.component)), overrides); } catch (e) {
      if (e instanceof FormulaError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  private cleanOverrides(o: Record<string, unknown>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(o)) {
      if (!/^[A-Z][A-Z0-9_]{0,19}$/.test(k) || typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100000000) throw new BadRequestException(`Invalid override for ${k}`);
      out[k] = v;
    }
    return out;
  }

  // ───────── Employee salary ─────────
  async history(companyId: string, employeeId: string) {
    await this.assertEmployee(companyId, employeeId);
    return this.prisma.employeeSalary.findMany({
      where: { companyId, employeeId }, orderBy: { effectiveFrom: 'desc' }, include: { structure: { select: { name: true } } },
    });
  }

  /**
   * Assigns salary from an effective date. The computed breakup is stored as a snapshot,
   * so later edits to components/structures never change an employee's recorded salary.
   */
  async assign(u: AuthUser, companyId: string, employeeId: string,
    d: { structureId: string; grossMonthly: number; effectiveFrom: string; reason?: string; overrides?: Record<string, number> }, ip?: string) {
    await this.assertEmployee(companyId, employeeId);
    const from = day(d.effectiveFrom);
    const calc = await this.preview(companyId, d.structureId, d.grossMonthly, d.overrides ?? {});
    if (!calc.lines.some((l) => l.type === 'EARNING')) throw new BadRequestException('Structure has no earning components');

    const latest = await this.prisma.employeeSalary.findFirst({ where: { companyId, employeeId }, orderBy: { effectiveFrom: 'desc' } });
    if (latest && from <= latest.effectiveFrom) throw new BadRequestException(`Effective date must be after the current salary start (${latest.effectiveFrom.toISOString().slice(0, 10)})`);

    const created = await this.prisma.$transaction(async (tx) => {
      if (latest && !latest.effectiveTo) {
        await tx.employeeSalary.update({ where: { id: latest.id }, data: { effectiveTo: new Date(from.getTime() - 86_400_000) } });
      }
      return tx.employeeSalary.create({
        data: {
          companyId, employeeId, structureId: d.structureId, grossMonthly: d.grossMonthly, effectiveFrom: from,
          reason: d.reason ?? (latest ? 'REVISION' : 'JOINING'), createdBy: u.id,
          components: { lines: calc.lines, gross: calc.gross, deductions: calc.deductions, net: calc.net, overrides: this.cleanOverrides(d.overrides ?? {}), warnings: calc.warnings } as any,
        },
      });
    });
    await this.audit.log({
      userId: u.id, companyId, action: 'SALARY_CHANGED', module: 'salary', recordId: employeeId,
      oldValue: latest ? { grossMonthly: num(latest.grossMonthly), effectiveFrom: latest.effectiveFrom } : null,
      newValue: { grossMonthly: d.grossMonthly, effectiveFrom: from, structureId: d.structureId }, ip,
    });
    return created;
  }

  private async assertEmployee(companyId: string, employeeId: string) {
    const e = await this.prisma.employee.findFirst({ where: { id: employeeId, companyId, deletedAt: null }, select: { id: true } });
    if (!e) throw new NotFoundException('Employee not found');
  }
}
