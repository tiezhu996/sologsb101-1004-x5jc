import type { Revisioned } from './persistence';

/**
 * 销号来源：
 * - manual：病害评定页手工销号
 * - workOrder：天窗作业单推进到「已完成」时带出的销号
 */
export type SolveSource = 'manual' | 'workOrder';

export const SOLVE_SOURCE_LABEL: Record<SolveSource, string> = {
  manual: '手工销号',
  workOrder: '作业单销号',
};

/**
 * 销号记录（一条记录对应一处病害当前生效的一次销号）。
 * 病害回到「待修」时该记录删除；同一病害同时至多存在一条生效记录，
 * 因此「最早完成的单认定销号来源」天然成立——后来的单只能对仍待修的病害销号。
 *
 * 历史数据（本功能上线前已销号、无记录）按旧单处理：回退作业单时不自动撤销，
 * 列出交人工核对（见 workOrderStore.rollbackWorkOrder 返回的 unattributedFaultIds）。
 */
export interface SolveRecord extends Revisioned {
  id: string;
  /** 被销号的病害 id（唯一：同一病害同时至多一条生效记录） */
  faultId: string;
  /** 销号来源 */
  source: SolveSource;
  /** 来源作业单 id（source === 'workOrder' 时有值） */
  workOrderId: string | null;
  /** 来源作业单编号快照，便于作业单删除后仍可核对 */
  workOrderCode: string | null;
  /** 销号时间 yyyy-MM-dd HH:mm */
  solvedAt: string;
  createdAt: string;
}

/** 找出某张作业单实际带出的销号记录（只认本单 source） */
export function findOrderSolveRecords(records: SolveRecord[], workOrderId: string): SolveRecord[] {
  return records.filter((item) => item.source === 'workOrder' && item.workOrderId === workOrderId);
}
