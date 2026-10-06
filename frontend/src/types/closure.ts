import type { Revisioned } from './persistence';

/** 销号来源：天窗作业单回写，或病害页手工销号 */
export type ClosureSource = 'workOrder' | 'manual';

/**
 * 销号记录：病害每一次「销号」动作的来源留痕，是判断某张作业单
 * 「本单实际带出的销号」的唯一依据。
 * - 作业单推进到已完成时，仅对本单关联、当时仍为待修的病害写入 workOrder 记录；
 * - 病害页手工销号写入 manual 记录；
 * - 作业单回退 / 手工撤销销号时把对应记录置为 revoked，不物理删除，便于追溯。
 *
 * 不变量：病害处于 solved 当且仅当存在至少一条 active（revoked=false）记录。
 */
export interface Closure extends Revisioned {
  id: string;
  /** 被销号的病害 id */
  faultId: string;
  /** 销号来源 */
  source: ClosureSource;
  /** 来源作业单 id；手工销号为 null */
  workOrderId: string | null;
  /** 来源作业单编号（留档，作业单删除后仍可读）；手工销号为 null */
  workOrderCode: string | null;
  /** 销号时间 yyyy-MM-dd HH:mm */
  solvedAt: string;
  /** 是否已撤销 */
  revoked: boolean;
  /** 撤销时间 */
  revokedAt: string | null;
  /**
   * 是否为旧库迁移时回填的推断记录：旧版没有销号来源表，
   * 仅按「已完成单关联了已销号病害」推断。推断记录不参与回退自动撤销，
   * 回退时改为列入人工核对清单。
   */
  inferred: boolean;
  createdAt: string;
}
