/**
 * 巡检与病害状态（Redux Toolkit slice）
 * 维护巡检批次、病害列表、等级筛选与销号状态派生值。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  ROW_REVISION,
  listFaults,
  listInspections,
  listSolveRecords,
  listSwitches,
  listYards,
  listWorkOrders,
  forceUnsolveFaultById,
  manualSolveFault,
  manualUnsolveFault,
  putFault,
  putFaults,
  putInspection,
  removeFault,
  removeInspection,
  type FaultRow,
  type InspectionRow,
  type SolveRecordRow,
  type SwitchRow,
  type WorkOrderRow,
  type YardRow,
} from '../utils/db';
import type { FaultDraft, FaultPart, FaultSeverity, FaultState, FaultView } from '../types/fault';
import type { InspectionDraft, InspectionView } from '../types/inspection';
import { escalate } from '../utils/severity';
import { emitChange } from '../utils/events';
import { nowIso, uuid } from '../utils/format';

export interface FaultStateSlice {
  inspections: InspectionRow[];
  faults: FaultRow[];
  switches: SwitchRow[];
  yards: YardRow[];
  workOrders: WorkOrderRow[];
  /** 销号来源记录 */
  solveRecords: SolveRecordRow[];
  /** 筛选条件（跨页保留，页面只读本 slice） */
  partFilters: FaultPart[];
  severityFilters: FaultSeverity[];
  stateFilters: FaultState[];
  activeInspectionId: string | null;
  loading: boolean;
  error: string;
}

const initialState: FaultStateSlice = {
  inspections: [],
  faults: [],
  switches: [],
  yards: [],
  workOrders: [],
  solveRecords: [],
  partFilters: [],
  severityFilters: [],
  stateFilters: [],
  activeInspectionId: null,
  loading: false,
  error: '',
};

export const loadFaultData = createAsyncThunk<
  {
    inspections: InspectionRow[];
    faults: FaultRow[];
    switches: SwitchRow[];
    yards: YardRow[];
    workOrders: WorkOrderRow[];
    solveRecords: SolveRecordRow[];
  },
  void,
  { rejectValue: string }
>('fault/load', async (_arg, { rejectWithValue }) => {
  try {
    const [inspections, faults, switches, yards, workOrders, solveRecords] = await Promise.all([
      listInspections(),
      listFaults(),
      listSwitches(),
      listYards(),
      listWorkOrders(),
      listSolveRecords(),
    ]);
    return { inspections, faults, switches, yards, workOrders, solveRecords };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '病害数据读取失败');
  }
});

export const createInspection = createAsyncThunk<
  string,
  InspectionDraft & { faults: FaultDraft[] },
  { rejectValue: string }
>('fault/createInspection', async (input, { rejectWithValue }) => {
  try {
    const inspectionId = `insp-${uuid()}`;
    await putInspection({
      id: inspectionId,
      switchId: input.switchId,
      date: input.date,
      inspector: input.inspector.trim(),
      weather: input.weather,
      method: input.method,
      createdAt: nowIso(),
      revision: ROW_REVISION,
    });
    if (input.faults.length > 0) {
      await putFaults(
        input.faults.map((draft) => ({
          id: `fault-${uuid()}`,
          inspectionId,
          part: draft.part,
          type: draft.type,
          severity: draft.severity,
          sizeMm: draft.sizeMm,
          state: 'pending' as const,
          solvedAt: null,
          createdAt: nowIso(),
          revision: ROW_REVISION,
        })),
      );
    }
    emitChange();
    return inspectionId;
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '新增巡检失败');
  }
});

export const updateInspection = createAsyncThunk<
  void,
  { id: string; draft: InspectionDraft },
  { rejectValue: string }
>('fault/updateInspection', async ({ id, draft }, { getState, rejectWithValue }) => {
  try {
    const state = (getState() as { fault: FaultStateSlice }).fault;
    const existing = state.inspections.find((item) => item.id === id);
    if (!existing) return;
    await putInspection({
      ...existing,
      switchId: draft.switchId,
      date: draft.date,
      inspector: draft.inspector.trim(),
      weather: draft.weather,
      method: draft.method,
    });
    emitChange();
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '更新巡检失败');
  }
});

export const deleteInspection = createAsyncThunk<void, string, { rejectValue: string }>(
  'fault/deleteInspection',
  async (id, { rejectWithValue }) => {
    try {
      await removeInspection(id);
      emitChange();
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '删除巡检失败');
    }
  },
);

export const createFault = createAsyncThunk<void, FaultDraft, { rejectValue: string }>(
  'fault/createFault',
  async (draft, { rejectWithValue }) => {
    try {
      await putFault({
        id: `fault-${uuid()}`,
        inspectionId: draft.inspectionId,
        part: draft.part,
        type: draft.type,
        severity: draft.severity,
        sizeMm: draft.sizeMm,
        state: 'pending',
        solvedAt: null,
        createdAt: nowIso(),
        revision: ROW_REVISION,
      });
      emitChange();
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '新增病害失败');
    }
  },
);

export const updateFault = createAsyncThunk<
  void,
  { id: string; draft: FaultDraft },
  { rejectValue: string }
>('fault/updateFault', async ({ id, draft }, { getState, rejectWithValue }) => {
  try {
    const state = (getState() as { fault: FaultStateSlice }).fault;
    const existing = state.faults.find((item) => item.id === id);
    if (!existing) return;
    await putFault({
      ...existing,
      inspectionId: draft.inspectionId,
      part: draft.part,
      type: draft.type,
      severity: draft.severity,
      sizeMm: draft.sizeMm,
    });
    emitChange();
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '更新病害失败');
  }
});

/** 批量改等级 */
export const bulkSetSeverity = createAsyncThunk<
  number,
  { faultIds: string[]; severity: FaultSeverity },
  { rejectValue: string }
>('fault/bulkSetSeverity', async ({ faultIds, severity }, { getState, rejectWithValue }) => {
  try {
    const state = (getState() as { fault: FaultStateSlice }).fault;
    const rows = state.faults.filter((item) => faultIds.includes(item.id));
    if (rows.length === 0) return 0;
    await putFaults(rows.map((item) => ({ ...item, severity })));
    emitChange();
    return rows.length;
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '批量改等级失败');
  }
});

/** 批量升级一级 */
export const bulkEscalate = createAsyncThunk<number, string[], { rejectValue: string }>(
  'fault/bulkEscalate',
  async (faultIds, { getState, rejectWithValue }) => {
    try {
      const state = (getState() as { fault: FaultStateSlice }).fault;
      const rows = state.faults.filter((item) => faultIds.includes(item.id));
      if (rows.length === 0) return 0;
      await putFaults(rows.map((item) => ({ ...item, severity: escalate(item.severity) })));
      emitChange();
      return rows.length;
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '批量升级失败');
    }
  },
);

export interface SetFaultStateResult {
  faultId: string;
  state: FaultState;
  /** 本次实际生效的变化：solve=新销号，unsolve=已撤销，kept=原本已销号保持，legacyBlocked=旧数据无来源记录已拦截 */
  outcome: 'solve' | 'unsolve' | 'kept' | 'legacyBlocked';
}

/**
 * 手工销号 / 撤销销号。
 * - 销号：登记来源 manual；已被作业单或此前手工销过的保持原来源，不覆盖；
 * - 撤销：有来源记录才回到待修；旧数据没有来源记录时拦截（legacyBlocked），
 *   需走「强制撤销」人工核对后处理，不能在回退 / 撤销路径里直接抹掉无主销号。
 */
export const setFaultState = createAsyncThunk<
  SetFaultStateResult,
  { faultId: string; state: FaultState },
  { rejectValue: string }
>('fault/setState', async ({ faultId, state }, { getState, rejectWithValue }) => {
  try {
    const slice = (getState() as { fault: FaultStateSlice }).fault;
    const existing = slice.faults.find((item) => item.id === faultId);
    if (!existing) return { faultId, state, outcome: 'kept' };
    if (state === 'solved') {
      const result = await manualSolveFault(existing);
      emitChange();
      return { faultId, state, outcome: result.kept ? 'kept' : 'solve' };
    }
    const result = await manualUnsolveFault(existing);
    emitChange();
    return { faultId, state, outcome: result.reverted ? 'unsolve' : 'legacyBlocked' };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '更新销号状态失败');
  }
});

/**
 * 人工核对后的强制撤销：仅用于没有来源记录的历史已销号病害（旧单 / 旧版数据），
 * 必须由页面在待核对清单中由用户显式触发；有来源记录的病害不在此处理。
 */
export const forceUnsolveFault = createAsyncThunk<
  { faultId: string; reverted: boolean },
  string,
  { rejectValue: string }
>('fault/forceUnsolve', async (faultId, { rejectWithValue }) => {
  try {
    const result = await forceUnsolveFaultById(faultId);
    emitChange();
    return { faultId, reverted: result.reverted };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '强制撤销失败');
  }
});

export const deleteFault = createAsyncThunk<void, string, { rejectValue: string }>(
  'fault/deleteFault',
  async (id, { rejectWithValue }) => {
    try {
      await removeFault(id);
      emitChange();
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '删除病害失败');
    }
  },
);

const faultSlice = createSlice({
  name: 'fault',
  initialState,
  reducers: {
    setPartFilters(state, action: PayloadAction<FaultPart[]>) {
      state.partFilters = action.payload;
    },
    setSeverityFilters(state, action: PayloadAction<FaultSeverity[]>) {
      state.severityFilters = action.payload;
    },
    setStateFilters(state, action: PayloadAction<FaultState[]>) {
      state.stateFilters = action.payload;
    },
    setActiveInspection(state, action: PayloadAction<string | null>) {
      state.activeInspectionId = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadFaultData.pending, (state) => {
        state.loading = true;
        state.error = '';
      })
      .addCase(loadFaultData.fulfilled, (state, action) => {
        state.loading = false;
        state.inspections = action.payload.inspections;
        state.faults = action.payload.faults;
        state.switches = action.payload.switches;
        state.yards = action.payload.yards;
        state.workOrders = action.payload.workOrders;
        state.solveRecords = action.payload.solveRecords;
        if (
          !state.activeInspectionId ||
          !action.payload.inspections.some((item) => item.id === state.activeInspectionId)
        ) {
          state.activeInspectionId = action.payload.inspections[0]?.id ?? null;
        }
      })
      .addCase(loadFaultData.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload ?? '病害数据读取失败';
      });
  },
});

export const { setPartFilters, setSeverityFilters, setStateFilters, setActiveInspection } = faultSlice.actions;
export default faultSlice.reducer;

interface RootLike {
  fault: FaultStateSlice;
}

/** 病害视图：带巡检 / 道岔 / 站场上下文与作业单编排状态 */
export function selectFaultViews(state: RootLike): FaultView[] {
  const { faults, inspections, switches, yards, workOrders, solveRecords } = state.fault;
  const recordByFault = new Map(solveRecords.map((item) => [item.faultId, item]));
  return faults.map((fault) => {
    const inspection = inspections.find((item) => item.id === fault.inspectionId);
    const target = inspection ? switches.find((item) => item.id === inspection.switchId) : undefined;
    const yard = target ? yards.find((item) => item.id === target.yardId) : undefined;
    const relatedOrders = workOrders.filter((order) => order.faultIds.includes(fault.id));
    const record = recordByFault.get(fault.id);
    return {
      ...fault,
      switchId: target?.id ?? '',
      switchCode: target?.code ?? '已删除道岔',
      yardId: yard?.id ?? '',
      yardName: yard?.name ?? '未归属站场',
      inspectionDate: inspection?.date ?? '-',
      inspector: inspection?.inspector ?? '-',
      planned: relatedOrders.length > 0,
      workOrderCodes: relatedOrders.map((order) => order.code),
      solveSource: record?.source ?? null,
      solveWorkOrderCode: record?.source === 'workOrder' ? record.workOrderCode : null,
    };
  });
}

/**
 * 待人工核对的销号：已销号但没有来源记录的历史数据（旧单 / 旧版数据）。
 * 这些销号不允许在作业单回退或普通撤销时直接抹掉，需在病害页列出由人工核对后强制撤销。
 */
export function selectLegacySolvedFaults(state: RootLike): FaultView[] {
  return selectFaultViews(state).filter((item) => item.state === 'solved' && item.solveSource === null);
}

/** 巡检视图：带道岔上下文与病害统计 */
export function selectInspectionViews(state: RootLike): InspectionView[] {
  const { inspections, faults, switches, yards } = state.fault;
  return inspections.map((inspection) => {
    const target = switches.find((item) => item.id === inspection.switchId);
    const yard = target ? yards.find((item) => item.id === target.yardId) : undefined;
    const owned = faults.filter((item) => item.inspectionId === inspection.id);
    return {
      ...inspection,
      switchCode: target?.code ?? '已删除道岔',
      yardId: yard?.id ?? '',
      yardName: yard?.name ?? '未归属站场',
      frogNumber: target?.frogNumber ?? '-',
      faultCount: owned.length,
      severeCount: owned.filter((item) => item.severity === 'heavy').length,
      pendingCount: owned.filter((item) => item.state === 'pending').length,
    };
  });
}

/** 命中筛选条件的病害 */
export function selectFilteredFaults(state: RootLike): FaultView[] {
  const { partFilters, severityFilters, stateFilters } = state.fault;
  return selectFaultViews(state).filter((item) => {
    if (partFilters.length > 0 && !partFilters.includes(item.part)) return false;
    if (severityFilters.length > 0 && !severityFilters.includes(item.severity)) return false;
    if (stateFilters.length > 0 && !stateFilters.includes(item.state)) return false;
    return true;
  });
}

/** 等级 / 状态分组计数 */
export function selectFaultCounts(state: RootLike): {
  total: number;
  pending: number;
  solved: number;
  heavy: number;
  medium: number;
  light: number;
  planned: number;
} {
  const rows = selectFaultViews(state);
  return {
    total: rows.length,
    pending: rows.filter((item) => item.state === 'pending').length,
    solved: rows.filter((item) => item.state === 'solved').length,
    heavy: rows.filter((item) => item.severity === 'heavy').length,
    medium: rows.filter((item) => item.severity === 'medium').length,
    light: rows.filter((item) => item.severity === 'light').length,
    planned: rows.filter((item) => item.planned).length,
  };
}

/** 按部件分组计数 */
export function selectPartCounts(state: RootLike): Record<FaultPart, number> {
  const rows = selectFaultViews(state);
  return {
    pointRail: rows.filter((item) => item.part === 'pointRail').length,
    stockRail: rows.filter((item) => item.part === 'stockRail').length,
    frog: rows.filter((item) => item.part === 'frog').length,
    machine: rows.filter((item) => item.part === 'machine').length,
  };
}
