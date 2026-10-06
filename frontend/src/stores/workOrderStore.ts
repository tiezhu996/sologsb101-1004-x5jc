/**
 * 天窗作业单状态（Redux Toolkit slice）
 * 维护作业单编排、时间窗冲突校验、人员机具占用校验与进度推进（完成回写销号）。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  ROW_REVISION,
  listClosures,
  listFaults,
  listInspections,
  listSwitches,
  listWorkOrders,
  listYards,
  putClosures,
  putFaults,
  putWorkOrder,
  removeWorkOrder,
  type ClosureRow,
  type FaultRow,
  type InspectionRow,
  type SwitchRow,
  type WorkOrderRow,
  type YardRow,
} from '../utils/db';
import {
  WORK_ORDER_STATE_FLOW,
  buildWorkOrderCode,
  type WorkOrderDraft,
  type WorkOrderState,
  type WorkOrderView,
} from '../types/workOrder';
import {
  findConflicts,
  findMachineConflicts,
  findMemberConflicts,
  nowDateTime,
  windowMinutes,
} from '../utils/window';
import { emitChange } from '../utils/events';
import { uuid } from '../utils/format';

export interface WorkOrderStateSlice {
  workOrders: WorkOrderRow[];
  faults: FaultRow[];
  closures: ClosureRow[];
  inspections: InspectionRow[];
  switches: SwitchRow[];
  yards: YardRow[];
  /** 编排时勾选的病害 */
  selectedFaultIds: string[];
  loading: boolean;
  error: string;
}

const initialState: WorkOrderStateSlice = {
  workOrders: [],
  faults: [],
  closures: [],
  inspections: [],
  switches: [],
  yards: [],
  selectedFaultIds: [],
  loading: false,
  error: '',
};

export const loadWorkOrderData = createAsyncThunk<
  {
    workOrders: WorkOrderRow[];
    faults: FaultRow[];
    closures: ClosureRow[];
    inspections: InspectionRow[];
    switches: SwitchRow[];
    yards: YardRow[];
  },
  void,
  { rejectValue: string }
>('workOrder/load', async (_arg, { rejectWithValue }) => {
  try {
    const [workOrders, faults, closures, inspections, switches, yards] = await Promise.all([
      listWorkOrders(),
      listFaults(),
      listClosures(),
      listInspections(),
      listSwitches(),
      listYards(),
    ]);
    return { workOrders, faults, closures, inspections, switches, yards };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '作业单读取失败');
  }
});

/** 新建作业单：把勾选病害编排进同一时间窗，并回传时间窗冲突编号 */
export const createWorkOrder = createAsyncThunk<
  { created: boolean; conflicts: string[] },
  WorkOrderDraft,
  { rejectValue: string; state: { workOrder: WorkOrderStateSlice } }
>('workOrder/create', async (draft, { getState, rejectWithValue }) => {
  try {
    const state = getState().workOrder;
    const conflicts = findConflicts(
      { id: 'pending', windowStart: draft.windowStart, windowEnd: draft.windowEnd },
      state.workOrders.map((item) => ({
        id: item.id,
        code: item.code,
        windowStart: item.windowStart,
        windowEnd: item.windowEnd,
      })),
    ).map((item) => item.code);

    await putWorkOrder({
      id: `wo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      code: draft.code.trim() || buildWorkOrderCode(new Date(), state.workOrders.length + 1),
      faultIds: draft.faultIds,
      windowStart: draft.windowStart,
      windowEnd: draft.windowEnd,
      leader: draft.leader.trim(),
      machines: draft.machines,
      members: draft.members,
      state: 'planned',
      solvedFaultIds: [],
      createdAt: nowDateTime(),
      updatedAt: nowDateTime(),
      revision: ROW_REVISION,
    });
    emitChange();
    return { created: true, conflicts };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '新建作业单失败');
  }
});

export const updateWorkOrder = createAsyncThunk<
  void,
  { id: string; draft: WorkOrderDraft },
  { rejectValue: string; state: { workOrder: WorkOrderStateSlice } }
>('workOrder/update', async ({ id, draft }, { getState, rejectWithValue }) => {
  try {
    const state = getState().workOrder;
    const existing = state.workOrders.find((item) => item.id === id);
    if (!existing) return;
    await putWorkOrder({
      ...existing,
      code: draft.code.trim(),
      faultIds: draft.faultIds,
      windowStart: draft.windowStart,
      windowEnd: draft.windowEnd,
      leader: draft.leader.trim(),
      machines: draft.machines,
      members: draft.members,
      updatedAt: nowDateTime(),
    });
    emitChange();
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '更新作业单失败');
  }
});

/** 回退时需要人工核对的病害（本单关联、已销号，但缺少本单可信来源记录） */
export interface RollbackReviewItem {
  faultId: string;
  solvedAt: string | null;
  /** 推断来源（可能是旧库回填的推断记录），没有任何来源记录时为 null */
  inferredFromCode: string | null;
}

export interface AdvanceWorkOrderResult {
  state: WorkOrderState;
  /** 本次推进实际销号的病害数（推进到已完成时） */
  solvedCount: number;
  /** 本次回退实际撤销销号的病害数（回退时） */
  revokedCount: number;
  /** 回退时跳过、需要人工核对的病害 */
  review: RollbackReviewItem[];
}

/**
 * 推进作业单状态（含返工回退）。
 *
 * 推进到「已完成」：只把本单关联、当时仍为待修的病害置为已销号，并写入
 * workOrder 销号记录；原来手工销过、别的单先销过的病害保持不动。
 *
 * 回退（已完成 → 作业中 / 班组返工、已下达 → 待编排）：只撤销「本单实际带出」的
 * 销号——即在 closures 表中存在本单可信（非迁移推断）记录的病害；手工销号、
 * 其它单销号继续保留。同一病害关联多张单时，最早完成的单持有来源记录，
 * 后来的单回退只改自身状态、不再动病害。
 * 旧单没有可信来源记录时，把疑似相关病害列入 review，等人工核对，不直接撤销。
 */
export const advanceWorkOrder = createAsyncThunk<
  AdvanceWorkOrderResult,
  { id: string; next: WorkOrderState },
  { rejectValue: string; state: { workOrder: WorkOrderStateSlice } }
>('workOrder/advance', async ({ id, next }, { getState, rejectWithValue }) => {
  try {
    const state = getState().workOrder;
    const existing = state.workOrders.find((item) => item.id === id);
    if (!existing) {
      return { state: next, solvedCount: 0, revokedCount: 0, review: [] };
    }
    const allowed = WORK_ORDER_STATE_FLOW[existing.state];
    if (!allowed.includes(next)) {
      return { state: existing.state, solvedCount: 0, revokedCount: 0, review: [] };
    }

    const timestamp = nowDateTime();
    let solvedCount = 0;
    let revokedCount = 0;
    const review: RollbackReviewItem[] = [];

    if (next === 'done') {
      // 只销本单关联且仍为待修的病害；已销号（手工 / 别的单）保持原样
      const related = state.faults.filter(
        (item) => existing.faultIds.includes(item.id) && item.state === 'pending',
      );
      if (related.length > 0) {
        await putFaults(
          related.map((item) => ({
            ...item,
            state: 'solved' as const,
            solvedAt: timestamp,
            solvedByWorkOrderId: id,
          })),
        );
        await putClosures(
          related.map((item) => ({
            id: `closure-${id}-${item.id}-${uuid()}`,
            faultId: item.id,
            source: 'workOrder' as const,
            workOrderId: id,
            workOrderCode: existing.code,
            solvedAt: timestamp,
            revoked: false,
            revokedAt: null,
            inferred: false,
            createdAt: timestamp,
            revision: ROW_REVISION,
          })),
        );
        solvedCount = related.length;
      }
      await putWorkOrder({
        ...existing,
        state: next,
        solvedFaultIds: related.map((item) => item.id),
        updatedAt: timestamp,
      });
    } else {
      // 回退路径：已完成 → 作业中（班组返工）或 已下达 → 待编排
      if (existing.state === 'done') {
        const relatedFaults = state.faults.filter(
          (item) => existing.faultIds.includes(item.id) && item.state === 'solved',
        );
        const revocableFaultIds = new Set<string>();
        const reviewFaultIds = new Set<string>();

        for (const fault of relatedFaults) {
          const active = state.closures.filter(
            (item) => item.faultId === fault.id && !item.revoked,
          );
          // 本单的可信（非推断）来源记录 → 本单实际带出的销号，可自动撤销
          if (active.some((item) => item.workOrderId === id && !item.inferred)) {
            revocableFaultIds.add(fault.id);
            continue;
          }
          // 本单没有可信来源记录：旧单无留痕，或病害属最早完成的其它单。
          // 只有「没有任何可信来源」（可能是旧数据）时才列人工核对；
          // 已能确认是别的单先销的（其它单可信记录在），直接保留、不打扰。
          const hasOtherTrustedSource = active.some(
            (item) => !item.inferred && (item.source === 'manual' || item.workOrderId !== id),
          );
          if (!hasOtherTrustedSource) {
            reviewFaultIds.add(fault.id);
          }
        }

        // 撤销本单带出的销号：病害恢复待修，对应来源记录置 revoked
        const revocableFaults = relatedFaults.filter((item) => revocableFaultIds.has(item.id));
        if (revocableFaults.length > 0) {
          await putFaults(
            revocableFaults.map((item) => ({
              ...item,
              state: 'pending' as const,
              solvedAt: null,
              solvedByWorkOrderId: null,
            })),
          );
          const closureUpdates: ClosureRow[] = [];
          for (const fault of revocableFaults) {
            for (const closure of state.closures) {
              if (closure.faultId === fault.id && closure.workOrderId === id && !closure.revoked) {
                closureUpdates.push({ ...closure, revoked: true, revokedAt: timestamp });
              }
            }
          }
          if (closureUpdates.length > 0) await putClosures(closureUpdates);
          revokedCount = revocableFaults.length;
        }

        for (const fault of relatedFaults) {
          if (!reviewFaultIds.has(fault.id)) continue;
          const inferred = state.closures.find(
            (item) => item.faultId === fault.id && !item.revoked && item.inferred,
          );
          review.push({
            faultId: fault.id,
            solvedAt: fault.solvedAt,
            inferredFromCode: inferred?.workOrderCode ?? null,
          });
        }
      }

      // 离开已完成状态后本单不再持有任何销号；病害中仍标记本单为来源的，理论上已在上面清掉
      await putWorkOrder({
        ...existing,
        state: next,
        solvedFaultIds: [],
        updatedAt: timestamp,
      });
    }

    emitChange();
    return { state: next, solvedCount, revokedCount, review };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '推进作业单失败');
  }
});

export const deleteWorkOrder = createAsyncThunk<void, string, { rejectValue: string }>(
  'workOrder/delete',
  async (id, { rejectWithValue }) => {
    try {
      await removeWorkOrder(id);
      emitChange();
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '删除作业单失败');
    }
  },
);

const workOrderSlice = createSlice({
  name: 'workOrder',
  initialState,
  reducers: {
    toggleFaultSelection(state, action: PayloadAction<string>) {
      const id = action.payload;
      state.selectedFaultIds = state.selectedFaultIds.includes(id)
        ? state.selectedFaultIds.filter((item) => item !== id)
        : [...state.selectedFaultIds, id];
    },
    setFaultSelection(state, action: PayloadAction<string[]>) {
      state.selectedFaultIds = action.payload;
    },
    clearFaultSelection(state) {
      state.selectedFaultIds = [];
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadWorkOrderData.pending, (state) => {
        state.loading = true;
        state.error = '';
      })
      .addCase(loadWorkOrderData.fulfilled, (state, action) => {
        state.loading = false;
        state.workOrders = action.payload.workOrders;
        state.faults = action.payload.faults;
        state.closures = action.payload.closures;
        state.inspections = action.payload.inspections;
        state.switches = action.payload.switches;
        state.yards = action.payload.yards;
        const validIds = new Set(action.payload.faults.map((item) => item.id));
        state.selectedFaultIds = state.selectedFaultIds.filter((id) => validIds.has(id));
      })
      .addCase(loadWorkOrderData.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload ?? '作业单读取失败';
      });
  },
});

export const { toggleFaultSelection, setFaultSelection, clearFaultSelection } = workOrderSlice.actions;
export default workOrderSlice.reducer;

interface RootLike {
  workOrder: WorkOrderStateSlice;
}

/** 作业单视图：带病害标签、时长、冲突与未销号数量 */
export function selectWorkOrderViews(state: RootLike): WorkOrderView[] {
  const { workOrders, faults, inspections, switches, yards } = state.workOrder;
  const switchIdOfFault = (fault: FaultRow): string | undefined => {
    const inspection = inspections.find((row) => row.id === fault.inspectionId);
    return inspection?.switchId;
  };
  return workOrders
    .map((order) => {
      const related = faults.filter((item) => order.faultIds.includes(item.id));
      const labels = related.map((item) => {
        const switchRow = switches.find((row) => row.id === switchIdOfFault(item));
        return `${switchRow?.code ?? '-'} ${item.part}/${item.type}`;
      });
      const yardNames = [
        ...new Set(
          related
            .map((item) => switches.find((row) => row.id === switchIdOfFault(item))?.yardId)
            .map((yardId) => yards.find((row) => row.id === yardId)?.name)
            .filter((name): name is string => Boolean(name)),
        ),
      ];
      const others = workOrders.filter((item) => item.id !== order.id);
      const conflictCodes = others
        .filter((item) => item.windowStart < order.windowEnd && order.windowStart < item.windowEnd)
        .map((item) => item.code);
      const memberConflicts = findMemberConflicts(
        { id: order.id, windowStart: order.windowStart, windowEnd: order.windowEnd, members: order.members },
        others.map((item) => ({
          id: item.id,
          code: item.code,
          windowStart: item.windowStart,
          windowEnd: item.windowEnd,
          members: item.members,
        })),
      );
      const machineConflicts = findMachineConflicts(
        { id: order.id, windowStart: order.windowStart, windowEnd: order.windowEnd, machines: order.machines },
        others.map((item) => ({
          id: item.id,
          code: item.code,
          windowStart: item.windowStart,
          windowEnd: item.windowEnd,
          machines: item.machines,
        })),
      );
      return {
        ...order,
        faultLabels: labels,
        yardNames,
        durationMinutes: windowMinutes({ windowStart: order.windowStart, windowEnd: order.windowEnd }),
        conflict: conflictCodes.length > 0,
        conflictCodes,
        memberConflict: memberConflicts.length > 0,
        machineConflict: machineConflicts.length > 0,
        pendingFaultCount: related.filter((item) => item.state === 'pending').length,
      };
    })
    .sort((a, b) => a.windowStart.localeCompare(b.windowStart));
}

/** 待编排病害（未销号且未编排） */
export function selectPlanableFaults(state: {
  workOrder: WorkOrderStateSlice;
}): Array<{ id: string; label: string; severity: string; state: string }> {
  const { faults, inspections, workOrders, switches } = state.workOrder;
  const plannedIds = new Set(workOrders.flatMap((item) => item.faultIds));
  return faults
    .filter((item) => item.state === 'pending' && !plannedIds.has(item.id))
    .map((item) => {
      const inspection = inspections.find((row) => row.id === item.inspectionId);
      const switchRow = inspection ? switches.find((row) => row.id === inspection.switchId) : undefined;
      return {
        id: item.id,
        label: `${switchRow?.code ?? '-'} · ${item.part} / ${item.type}`,
        severity: item.severity,
        state: item.state,
      };
    });
}

/** 天窗占用统计 */
export function selectWindowStats(state: RootLike): {
  total: number;
  minutes: number;
  occupationRate: number;
  conflictCount: number;
  doneCount: number;
} {
  const views = selectWorkOrderViews(state);
  const minutes = views.reduce((sum, item) => sum + item.durationMinutes, 0);
  return {
    total: views.length,
    minutes,
    occupationRate: Number(((minutes / 180) * 100).toFixed(1)),
    conflictCount: views.filter((item) => item.conflict).length,
    doneCount: views.filter((item) => item.state === 'done').length,
  };
}
