/**
 * IndexedDB 持久化层（Dexie 封装）· 铁路道岔巡检与天窗修编排台
 * - 数据结构版本号 + 升级迁移逻辑
 * - 各实体表增删改查（含级联删除）
 * - 首屏自动播种互相引用的演示数据（站场 → 道岔 → 巡检 → 病害 → 天窗作业单）
 * 纯前端应用：不依赖任何后端或数据库服务
 */
import Dexie, { type Table } from 'dexie';
import type { Yard } from '../types/yard';
import type { Switch } from '../types/switch';
import type { Inspection } from '../types/inspection';
import type { Fault } from '../types/fault';
import type { WorkOrder } from '../types/workOrder';
import type { SolveRecord } from '../types/solveRecord';
import { ROW_REVISION, type Revisioned } from '../types/persistence';
import { nowDateTime, shiftDate, todayDate, windowMinutes } from './window';
import { nowIso, uuid } from './format';

/** 浏览器 IndexedDB 库名 */
export const DB_NAME = 'gbrailswitch';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

export { ROW_REVISION };
export type { Revisioned };

/** 封锁 / 慢行条件登记（/backup 页） */
export interface SpeedRestriction extends Revisioned {
  id: string;
  /** 关联站场 */
  yardId: string;
  /** 关联道岔（可空，表示站场级） */
  switchCode: string;
  /** 限速值 km/h */
  limitKmh: number;
  /** 起止时间描述 */
  period: string;
  /** 登记原因 */
  reason: string;
  createdAt: string;
}

export type YardRow = Yard;
export type SwitchRow = Switch;
export type InspectionRow = Inspection;
export type FaultRow = Fault;
export type WorkOrderRow = WorkOrder;
export type SpeedRestrictionRow = SpeedRestriction;
export type SolveRecordRow = SolveRecord;

class RailSwitchDatabase extends Dexie {
  yards!: Table<YardRow, string>;
  switches!: Table<SwitchRow, string>;
  inspections!: Table<InspectionRow, string>;
  faults!: Table<FaultRow, string>;
  workOrders!: Table<WorkOrderRow, string>;
  restrictions!: Table<SpeedRestrictionRow, string>;
  /** 销号来源记录：一处病害同时至多一条生效记录，faultId 建唯一索引 */
  solveRecords!: Table<SolveRecordRow, string>;
  settings!: Table<{ id: string; value: string; updatedAt: string }, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（保留历史数据）
    this.version(1).stores({
      yards: 'id, name, region',
      switches: 'id, yardId, code, frogNumber',
      inspections: 'id, switchId, date',
      faults: 'id, inspectionId, part, severity, state',
      workOrders: 'id, code, state, windowStart',
    });

    // v2：新增 revision 行修订号；道岔补充轨型索引，病害补充组合索引便于按巡检批量操作，
    //     作业单补充负责人索引，并新增封锁条件表
    this.version(DB_SCHEMA_VERSION)
      .stores({
        yards: 'id, name, region, mileage',
        switches: 'id, yardId, code, frogNumber, railType, [yardId+code]',
        inspections: 'id, switchId, date, inspector, [switchId+date]',
        faults: 'id, inspectionId, part, severity, state, [inspectionId+part]',
        workOrders: 'id, code, state, windowStart, leader',
        restrictions: 'id, yardId, switchCode',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        const tables: Array<Table<Record<string, unknown>, string>> = [
          tx.table('yards'),
          tx.table('switches'),
          tx.table('inspections'),
          tx.table('faults'),
          tx.table('workOrders'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
          });
        }
        // 迁移：旧版病害字段 faultType → type，faultPart → part
        await tx.table('faults').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.type !== 'string' && typeof row.faultType === 'string') row.type = row.faultType;
          if (typeof row.part !== 'string' && typeof row.faultPart === 'string') row.part = row.faultPart;
          if (row.solvedAt === undefined) row.solvedAt = null;
          if (row.sizeMm === undefined) row.sizeMm = null;
        });
        // 迁移：旧版作业单 faultIds 为字符串时拆分为数组
        await tx.table('workOrders').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.faultIds === 'string') {
            row.faultIds = String(row.faultIds)
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean);
          }
          if (!Array.isArray(row.members)) row.members = [];
          if (!Array.isArray(row.machines)) row.machines = [];
        });
      });

    // v3：新增销号记录表，登记每处病害当前销号的来源（手工 / 作业单），
    //     支撑作业单回退时只撤销本单实际带出的销号；旧数据不回填来源，按旧单人工核对
    this.version(DB_SCHEMA_VERSION).stores({
      yards: 'id, name, region, mileage',
      switches: 'id, yardId, code, frogNumber, railType, [yardId+code]',
      inspections: 'id, switchId, date, inspector, [switchId+date]',
      faults: 'id, inspectionId, part, severity, state, [inspectionId+part]',
      workOrders: 'id, code, state, windowStart, leader',
      restrictions: 'id, yardId, switchCode',
      solveRecords: 'id, faultId, source, workOrderId',
      settings: 'id',
    });
  }
}

export const db = new RailSwitchDatabase();

/* ============================== 演示数据播种 ============================== */

function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

interface SeedSwitchSpec {
  code: string;
  frogNumber: Switch['frogNumber'];
  railType: Switch['railType'];
  turnoutType: Switch['turnoutType'];
  position: string;
}

interface SeedYardSpec {
  name: string;
  mileage: string;
  trackCount: number;
  region: string;
  switches: SeedSwitchSpec[];
}

const SEED_YARDS: SeedYardSpec[] = [
  {
    name: '沙河堡站',
    mileage: 'K312+450',
    trackCount: 6,
    region: '沙河桥工务车间',
    switches: [
      { code: '1#', frogNumber: '12', railType: '60kg/m', turnoutType: 'single', position: 'I 道东端' },
      { code: '3#', frogNumber: '12', railType: '60kg/m', turnoutType: 'single', position: 'I 道西端' },
      { code: '7#', frogNumber: '18', railType: '60kg/m', turnoutType: 'single', position: 'II 道东端渡线' },
      { code: '11#', frogNumber: '9', railType: '50kg/m', turnoutType: 'double', position: 'III 道调车线' },
    ],
  },
  {
    name: '云岭线路所',
    mileage: 'K358+120',
    trackCount: 4,
    region: '云岭线路车间',
    switches: [
      { code: '2#', frogNumber: '18', railType: '60kg/m', turnoutType: 'crossing', position: '正线交分道岔' },
      { code: '4#', frogNumber: '12', railType: '60kg/m', turnoutType: 'single', position: '到发线东端' },
      { code: '6#', frogNumber: '9', railType: '50kg/m', turnoutType: 'single', position: '货物线' },
      { code: '8#', frogNumber: '12', railType: '60kg/m', turnoutType: 'double', position: '联络线' },
    ],
  },
];

const INSPECTORS = ['赵铁军', '孙立波', '周振海', '吴长胜'];
const FAULT_PARTS: Fault['part'][] = ['pointRail', 'stockRail', 'frog', 'machine'];
const FAULT_TYPES: Fault['type'][] = ['wear', 'spalling', 'crack', 'gap', 'looseBolt'];
const FAULT_SEVERITIES: Fault['severity'][] = ['light', 'medium', 'heavy'];

/**
 * 播种：2 个站场 × 各 4 组道岔 × 1~2 次巡检 × 若干病害 + 2 张天窗作业单 + 封锁条件。
 * 数据父子互相引用（yardId / switchId / inspectionId / faultIds），全部页面打开即有内容。
 */
async function seedDatabase(): Promise<void> {
  const random = makeRandom(20260824);
  const stamp = nowIso();

  const yards: YardRow[] = [];
  const switches: SwitchRow[] = [];
  const inspections: InspectionRow[] = [];
  const faults: FaultRow[] = [];
  const workOrders: WorkOrderRow[] = [];
  const restrictions: SpeedRestrictionRow[] = [];
  const solveRecords: SolveRecordRow[] = [];

  SEED_YARDS.forEach((yardSpec, yardIndex) => {
    const yardId = `yard-${yardIndex + 1}`;
    yards.push({
      id: yardId,
      name: yardSpec.name,
      mileage: yardSpec.mileage,
      trackCount: yardSpec.trackCount,
      region: yardSpec.region,
      createdAt: stamp,
      revision: ROW_REVISION,
    });

    yardSpec.switches.forEach((switchSpec, switchIndex) => {
      const switchId = `sw-${yardIndex + 1}-${switchIndex + 1}`;
      switches.push({
        id: switchId,
        yardId,
        code: switchSpec.code,
        frogNumber: switchSpec.frogNumber,
        railType: switchSpec.railType,
        position: switchSpec.position,
        turnoutType: switchSpec.turnoutType,
        createdAt: stamp,
        revision: ROW_REVISION,
      });

      // 每道岔 1~2 次巡检
      const inspectionCount = random() > 0.45 ? 2 : 1;
      for (let inspectionIndex = 0; inspectionIndex < inspectionCount; inspectionIndex += 1) {
        const inspectionId = `insp-${switchId}-${inspectionIndex + 1}`;
        const offsetDays = inspectionIndex === 0 ? -Math.floor(random() * 6) - 2 : -Math.floor(random() * 26) - 9;
        const date = shiftDate(offsetDays);
        inspections.push({
          id: inspectionId,
          switchId,
          date,
          inspector: INSPECTORS[Math.floor(random() * INSPECTORS.length)],
          weather: (['sunny', 'rain', 'snow', 'wind'] as Inspection['weather'][])[
            Math.floor(random() * 4)
          ],
          method: (['manual', 'car', 'ride'] as Inspection['method'][])[Math.floor(random() * 3)],
          createdAt: stamp,
          revision: ROW_REVISION,
        });

        // 每次巡检挂 0~3 条病害（首次巡检病害更多）
        const faultCount = inspectionIndex === 0 ? Math.floor(random() * 3) + 1 : Math.floor(random() * 2);
        for (let faultIndex = 0; faultIndex < faultCount; faultIndex += 1) {
          const severityRoll = random();
          const severity: Fault['severity'] =
            FAULT_SEVERITIES[severityRoll > 0.82 ? 2 : severityRoll > 0.5 ? 1 : 0];
          const part = FAULT_PARTS[Math.floor(random() * FAULT_PARTS.length)];
          const type = FAULT_TYPES[Math.floor(random() * FAULT_TYPES.length)];
          const sizeMm =
            type === 'crack' || type === 'looseBolt'
              ? null
              : Number((1 + random() * 9).toFixed(1));
          const solved = severity === 'light' && random() > 0.5;
          const solvedAt = solved ? `${shiftDate(offsetDays + 2)} 15:30` : null;
          const faultId = `fault-${inspectionId}-${faultIndex + 1}`;
          faults.push({
            id: faultId,
            inspectionId,
            part,
            type,
            severity,
            sizeMm,
            state: solved ? 'solved' : 'pending',
            solvedAt,
            createdAt: stamp,
            revision: ROW_REVISION,
          });
          // 演示数据中的历史已销号病害统一登记为手工销号来源
          if (solved && solvedAt) {
            solveRecords.push({
              id: `solve-${faultId}`,
              faultId,
              source: 'manual',
              workOrderId: null,
              workOrderCode: null,
              solvedAt,
              createdAt: stamp,
              revision: ROW_REVISION,
            });
          }
        }
      }
    });
  });

  // 天窗作业单：为部分待修病害编排（同一时间窗刻意留一张不冲突、一张与人员冲突）
  const pendingFaults = faults.filter((item) => item.state === 'pending');
  const today = todayDate();
  const groups: Array<{ faults: FaultRow[]; start: string; end: string; leader: string; state: WorkOrderRow['state'] }> = [
    {
      faults: pendingFaults.filter((item) => item.severity !== 'light').slice(0, 3),
      start: `${shiftDate(0)} 09:00`,
      end: `${shiftDate(0)} 11:30`,
      leader: '赵铁军',
      state: 'issued',
    },
    {
      faults: pendingFaults.filter((item) => item.severity === 'light').slice(0, 2),
      start: `${shiftDate(0)} 10:00`,
      end: `${shiftDate(0)} 12:00`,
      leader: '孙立波',
      state: 'planned',
    },
    {
      faults: pendingFaults.slice(3, 5),
      start: `${shiftDate(1)} 13:00`,
      end: `${shiftDate(1)} 15:00`,
      leader: '周振海',
      state: 'planned',
    },
  ];

  groups.forEach((group, index) => {
    if (group.faults.length === 0) return;
    workOrders.push({
      id: `wo-${index + 1}`,
      code: `TW-${today.replace(/-/g, '')}-${String(index + 1).padStart(2, '0')}`,
      faultIds: group.faults.map((item) => item.id),
      windowStart: group.start,
      windowEnd: group.end,
      leader: group.leader,
      machines: index === 0 ? ['轨距尺', '钢轨打磨机', '扭矩扳手'] : ['道尺', '捣固镐'],
      members: index === 0 ? ['赵铁军', '孙立波'] : index === 1 ? ['孙立波', '郑小勇'] : ['周振海', '冯国栋'],
      state: group.state,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    });
  });

  restrictions.push(
    {
      id: 'restrict-1',
      yardId: 'yard-1',
      switchCode: '11#',
      limitKmh: 25,
      period: `${shiftDate(-2)} ~ ${shiftDate(5)}`,
      reason: '辙叉心磨耗超限，封锁前临时慢行',
      createdAt: stamp,
      revision: ROW_REVISION,
    },
    {
      id: 'restrict-2',
      yardId: 'yard-2',
      switchCode: '2#',
      limitKmh: 45,
      period: `${shiftDate(1)} ~ ${shiftDate(1)}`,
      reason: '交分道岔打磨作业，天窗内限速',
      createdAt: stamp,
      revision: ROW_REVISION,
    },
  );

  await db.transaction(
    'rw',
    [db.yards, db.switches, db.inspections, db.faults, db.workOrders, db.restrictions, db.solveRecords],
    async () => {
      await db.yards.bulkPut(yards);
      await db.switches.bulkPut(switches);
      await db.inspections.bulkPut(inspections);
      await db.faults.bulkPut(faults);
      await db.workOrders.bulkPut(workOrders);
      await db.restrictions.bulkPut(restrictions);
      await db.solveRecords.bulkPut(solveRecords);
    },
  );
}

/* ============================== 初始化 ============================== */

/** 打开数据库；站场表为空时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  await db.open();
  const count = await db.yards.count();
  if (count === 0) {
    await seedDatabase();
  }
}

/* ============================== 站场 ============================== */

export async function listYards(): Promise<YardRow[]> {
  const rows = await db.yards.toArray();
  return rows.sort((a, b) => a.mileage.localeCompare(b.mileage));
}

export async function putYard(row: YardRow): Promise<void> {
  await db.yards.put(row);
}

/** 删除站场并级联清理道岔 / 巡检 / 病害 / 封锁条件 */
export async function removeYard(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.yards, db.switches, db.inspections, db.faults, db.workOrders, db.restrictions, db.solveRecords],
    async () => {
      const switchRows = await db.switches.where('yardId').equals(id).toArray();
      const switchIds = switchRows.map((item) => item.id);
      const inspectionRows = switchIds.length
        ? await db.inspections.where('switchId').anyOf(switchIds).toArray()
        : [];
      const inspectionIds = inspectionRows.map((item) => item.id);
      const faultRows = inspectionIds.length
        ? await db.faults.where('inspectionId').anyOf(inspectionIds).toArray()
        : [];
      const faultIds = new Set(faultRows.map((item) => item.id));
      if (faultIds.size > 0) {
        const orders = await db.workOrders.toArray();
        for (const order of orders) {
          const remaining = order.faultIds.filter((faultId) => !faultIds.has(faultId));
          if (remaining.length !== order.faultIds.length) {
            if (remaining.length === 0) await db.workOrders.delete(order.id);
            else await db.workOrders.put({ ...order, faultIds: remaining, updatedAt: nowIso() });
          }
        }
        await db.solveRecords.where('faultId').anyOf([...faultIds]).delete();
      }
      if (inspectionIds.length) await db.faults.where('inspectionId').anyOf(inspectionIds).delete();
      if (switchIds.length) await db.inspections.where('switchId').anyOf(switchIds).delete();
      await db.switches.where('yardId').equals(id).delete();
      await db.restrictions.where('yardId').equals(id).delete();
      await db.yards.delete(id);
    },
  );
}

/* ============================== 道岔 ============================== */

export async function listSwitches(): Promise<SwitchRow[]> {
  const rows = await db.switches.toArray();
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'));
}

export async function putSwitch(row: SwitchRow): Promise<void> {
  await db.switches.put(row);
}

export async function putSwitches(rows: SwitchRow[]): Promise<void> {
  await db.switches.bulkPut(rows);
}

export async function removeSwitch(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.switches, db.inspections, db.faults, db.workOrders, db.solveRecords],
    async () => {
      const inspectionRows = await db.inspections.where('switchId').equals(id).toArray();
      const inspectionIds = inspectionRows.map((item) => item.id);
      if (inspectionIds.length > 0) {
        const faultRows = await db.faults.where('inspectionId').anyOf(inspectionIds).toArray();
        const faultIds = new Set(faultRows.map((item) => item.id));
        const orders = await db.workOrders.toArray();
        for (const order of orders) {
          const remaining = order.faultIds.filter((faultId) => !faultIds.has(faultId));
          if (remaining.length !== order.faultIds.length) {
            if (remaining.length === 0) await db.workOrders.delete(order.id);
            else await db.workOrders.put({ ...order, faultIds: remaining, updatedAt: nowIso() });
          }
        }
        if (faultIds.size > 0) await db.solveRecords.where('faultId').anyOf([...faultIds]).delete();
        await db.faults.where('inspectionId').anyOf(inspectionIds).delete();
        await db.inspections.where('switchId').equals(id).delete();
      }
      await db.switches.delete(id);
    },
  );
}

/* ============================== 巡检 ============================== */

export async function listInspections(): Promise<InspectionRow[]> {
  const rows = await db.inspections.toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

export async function putInspection(row: InspectionRow): Promise<void> {
  await db.inspections.put(row);
}

/** 删除巡检并级联删除病害，同时从作业单中摘除对应病害 */
export async function removeInspection(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.inspections, db.faults, db.workOrders, db.solveRecords],
    async () => {
      const faultRows = await db.faults.where('inspectionId').equals(id).toArray();
      const faultIds = new Set(faultRows.map((item) => item.id));
      const orders = await db.workOrders.toArray();
      for (const order of orders) {
        const remaining = order.faultIds.filter((faultId) => !faultIds.has(faultId));
        if (remaining.length !== order.faultIds.length) {
          if (remaining.length === 0) await db.workOrders.delete(order.id);
          else await db.workOrders.put({ ...order, faultIds: remaining, updatedAt: nowIso() });
        }
      }
      if (faultIds.size > 0) await db.solveRecords.where('faultId').anyOf([...faultIds]).delete();
      await db.faults.where('inspectionId').equals(id).delete();
      await db.inspections.delete(id);
    },
  );
}

/* ============================== 病害 ============================== */

export async function listFaults(): Promise<FaultRow[]> {
  return db.faults.toArray();
}

export async function putFault(row: FaultRow): Promise<void> {
  await db.faults.put(row);
}

export async function putFaults(rows: FaultRow[]): Promise<void> {
  await db.faults.bulkPut(rows);
}

export async function removeFault(id: string): Promise<void> {
  await db.transaction('rw', [db.faults, db.workOrders, db.solveRecords], async () => {
    const orders = await db.workOrders.toArray();
    for (const order of orders) {
      if (!order.faultIds.includes(id)) continue;
      const remaining = order.faultIds.filter((faultId) => faultId !== id);
      if (remaining.length === 0) await db.workOrders.delete(order.id);
      else await db.workOrders.put({ ...order, faultIds: remaining, updatedAt: nowIso() });
    }
    await db.solveRecords.where('faultId').equals(id).delete();
    await db.faults.delete(id);
  });
}

/* ============================ 天窗作业单 ============================ */

export async function listWorkOrders(): Promise<WorkOrderRow[]> {
  const rows = await db.workOrders.toArray();
  return rows.sort((a, b) => a.windowStart.localeCompare(b.windowStart));
}

export async function putWorkOrder(row: WorkOrderRow): Promise<void> {
  await db.workOrders.put(row);
}

export async function removeWorkOrder(id: string): Promise<void> {
  // 仅删作业单本身：已回写的销号保留来源记录，由病害页人工处理，不在此静默改病害
  await db.workOrders.delete(id);
}

/* ============================ 销号记录与回退 ============================ */

export async function listSolveRecords(): Promise<SolveRecordRow[]> {
  return db.solveRecords.toArray();
}

export async function putSolveRecord(row: SolveRecordRow): Promise<void> {
  await db.solveRecords.put(row);
}

/** 组装一条销号记录 id */
function solveRecordId(faultId: string): string {
  return `solve-${faultId}`;
}

/**
 * 作业单完成回写：只对仍「待修」的关联病害销号，并逐条登记来源为本单；
 * 同时落库作业单（调用方传入已置为 done 的新行）。整个过程在一个事务内。
 * 已经销过的（手工或别的单先销过）保持原状，本单不抢来源。
 */
export async function completeWorkOrderSolve(order: WorkOrderRow): Promise<{ solvedFaultIds: string[] }> {
  const solvedFaultIds: string[] = [];
  await db.transaction('rw', [db.workOrders, db.faults, db.solveRecords], async () => {
    const solvedAt = nowDateTime();
    const stamp = nowIso();
    for (const faultId of order.faultIds) {
      const fault = await db.faults.get(faultId);
      if (!fault || fault.state === 'solved') continue;
      await db.faults.put({ ...fault, state: 'solved' as const, solvedAt });
      // 防御：若无来源记录（理论上不发生），补一条登记给本单
      const existed = await db.solveRecords.get(solveRecordId(faultId));
      if (existed) continue;
      await db.solveRecords.put({
        id: solveRecordId(faultId),
        faultId,
        source: 'workOrder',
        workOrderId: order.id,
        workOrderCode: order.code,
        solvedAt,
        createdAt: stamp,
        revision: ROW_REVISION,
      });
      solvedFaultIds.push(faultId);
    }
    await db.workOrders.put(order);
  });
  return { solvedFaultIds };
}

export interface RollbackSolveResult {
  /** 本单实际带出、已撤销回「待修」的病害 */
  revertedFaultIds: string[];
  /** 关联病害中已销号但查不到本单来源记录的（手工销号 / 别的单先销 / 旧单），需人工核对 */
  unattributedFaultIds: string[];
}

/**
 * 作业单回退：只撤销本单实际带出的销号（source 为本单的记录）。
 * - 手工销过的、别的单先销过的：销号与病害状态保留；
 * - 同一病害关联多张单时，记录只属于最早完成的单，后来那张回退只改作业单状态、不碰病害；
 * - 旧单没有来源记录的已销号病害列出来等人工核对，不直接撤销。
 */
export async function rollbackWorkOrderSolve(
  order: WorkOrderRow,
  nextState: WorkOrderRow['state'],
): Promise<RollbackSolveResult> {
  const result: RollbackSolveResult = { revertedFaultIds: [], unattributedFaultIds: [] };
  await db.transaction('rw', [db.workOrders, db.faults, db.solveRecords], async () => {
    for (const faultId of order.faultIds) {
      const fault = await db.faults.get(faultId);
      if (!fault) continue;
      const record = await db.solveRecords.get(solveRecordId(faultId));
      if (record?.source === 'workOrder' && record.workOrderId === order.id) {
        await db.faults.put({ ...fault, state: 'pending' as const, solvedAt: null });
        await db.solveRecords.delete(record.id);
        result.revertedFaultIds.push(faultId);
      } else if (fault.state === 'solved') {
        // 已销号但非本单带出：手工 / 别的单 / 无来源旧数据，一律保留并列出核对
        result.unattributedFaultIds.push(faultId);
      }
    }
    await db.workOrders.put({ ...order, state: nextState, updatedAt: nowDateTime() });
  });
  return result;
}

/**
 * 手工销号：病害仍为待修时置为已销号并登记来源 manual；
 * 病害已有销号（含作业单先销）时不重复登记，返回 kept=true 供页面提示。
 */
export async function manualSolveFault(
  fault: FaultRow,
): Promise<{ solved: boolean; kept: boolean }> {
  if (fault.state === 'solved') return { solved: false, kept: true };
  const solvedAt = nowDateTime();
  await db.transaction('rw', [db.faults, db.solveRecords], async () => {
    await db.faults.put({ ...fault, state: 'solved' as const, solvedAt });
    const existed = await db.solveRecords.get(solveRecordId(fault.id));
    if (!existed) {
      await db.solveRecords.put({
        id: solveRecordId(fault.id),
        faultId: fault.id,
        source: 'manual',
        workOrderId: null,
        workOrderCode: null,
        solvedAt,
        createdAt: nowIso(),
        revision: ROW_REVISION,
      });
    }
  });
  return { solved: true, kept: false };
}

/**
 * 手工撤销销号：有来源记录才回到待修并删记录；
 * 无来源记录的历史销号数据不自动改动，返回 false 交人工核对。
 */
export async function manualUnsolveFault(fault: FaultRow): Promise<{ reverted: boolean }> {
  if (fault.state !== 'solved') return { reverted: false };
  const record = await db.solveRecords.get(solveRecordId(fault.id));
  if (!record) return { reverted: false };
  await db.transaction('rw', [db.faults, db.solveRecords], async () => {
    await db.faults.put({ ...fault, state: 'pending' as const, solvedAt: null });
    await db.solveRecords.delete(record.id);
  });
  return { reverted: true };
}

/**
 * 人工核对后的强制撤销：仅用于没有来源记录的历史已销号病害（旧单 / 旧版数据）。
 * 页面必须先把该病害列入待核对清单，由用户显式确认后调用；存在来源记录时不在此处理。
 */
export async function forceUnsolveFaultById(faultId: string): Promise<{ reverted: boolean }> {
  let reverted = false;
  await db.transaction('rw', [db.faults, db.solveRecords], async () => {
    const fault = await db.faults.get(faultId);
    if (!fault || fault.state !== 'solved') return;
    const record = await db.solveRecords.get(solveRecordId(faultId));
    if (record) return; // 有来源记录，禁止用强制通道绕过归属
    await db.faults.put({ ...fault, state: 'pending' as const, solvedAt: null });
    reverted = true;
  });
  return { reverted };
}

/* =========================== 封锁 / 慢行条件 =========================== */

export async function listRestrictions(): Promise<SpeedRestrictionRow[]> {
  const rows = await db.restrictions.toArray();
  return rows.sort((a, b) => a.yardId.localeCompare(b.yardId));
}

export async function putRestriction(row: SpeedRestrictionRow): Promise<void> {
  await db.restrictions.put(row);
}

export async function removeRestriction(id: string): Promise<void> {
  await db.restrictions.delete(id);
}

/* ========================== 整库导入导出 ========================== */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  yards: Yard[];
  switches: Switch[];
  inspections: Inspection[];
  faults: Fault[];
  workOrders: WorkOrder[];
  restrictions: SpeedRestriction[];
  /** 销号来源记录；旧备份可能没有该字段，导入时按空数组处理 */
  solveRecords?: SolveRecord[];
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [yards, switches, inspections, faults, workOrders, restrictions, solveRecords] = await Promise.all([
    listYards(),
    listSwitches(),
    listInspections(),
    listFaults(),
    listWorkOrders(),
    listRestrictions(),
    listSolveRecords(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowDateTime(),
    yards,
    switches,
    inspections,
    faults,
    workOrders,
    restrictions,
    solveRecords,
  };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.yards,
      db.switches,
      db.inspections,
      db.faults,
      db.workOrders,
      db.restrictions,
      db.solveRecords,
    ],
    async () => {
      await Promise.all([
        db.yards.clear(),
        db.switches.clear(),
        db.inspections.clear(),
        db.faults.clear(),
        db.workOrders.clear(),
        db.restrictions.clear(),
        db.solveRecords.clear(),
      ]);
      await db.yards.bulkPut(snapshot.yards ?? []);
      await db.switches.bulkPut(snapshot.switches ?? []);
      await db.inspections.bulkPut(snapshot.inspections ?? []);
      await db.faults.bulkPut(snapshot.faults ?? []);
      await db.workOrders.bulkPut(snapshot.workOrders ?? []);
      await db.restrictions.bulkPut(snapshot.restrictions ?? []);
      // 只保留能对应到现存病害的销号记录，避免脏来源
      const faultIds = new Set((snapshot.faults ?? []).map((item) => item.id));
      await db.solveRecords.bulkPut(
        (snapshot.solveRecords ?? []).filter((item) => faultIds.has(item.faultId)),
      );
    },
  );
}

/** 清空并重新播种 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.yards,
      db.switches,
      db.inspections,
      db.faults,
      db.workOrders,
      db.restrictions,
      db.solveRecords,
    ],
    async () => {
      await Promise.all([
        db.yards.clear(),
        db.switches.clear(),
        db.inspections.clear(),
        db.faults.clear(),
        db.workOrders.clear(),
        db.restrictions.clear(),
        db.solveRecords.clear(),
      ]);
    },
  );
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [yards, switches, inspections, faults, workOrders, restrictions, solveRecords] = await Promise.all([
    db.yards.count(),
    db.switches.count(),
    db.inspections.count(),
    db.faults.count(),
    db.workOrders.count(),
    db.restrictions.count(),
    db.solveRecords.count(),
  ]);
  return { yards, switches, inspections, faults, workOrders, restrictions, solveRecords };
}

/** 结构版本信息 */
export interface SchemaInfo {
  dbName: string;
  schemaVersion: number;
  rowRevision: number;
  today: string;
}

export function schemaInfo(): SchemaInfo {
  return {
    dbName: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    rowRevision: ROW_REVISION,
    today: todayDate(),
  };
}

/** 新建行的通用字段（供各 slice 组装新记录） */
export function rowMeta(): { createdAt: string; revision: number } {
  return { createdAt: nowIso(), revision: ROW_REVISION };
}

/** 新建 id */
export function newId(prefix: string): string {
  return `${prefix}-${uuid()}`;
}

/** 天窗时长（分钟）：统一走 utils/window 的口径，避免页面重复实现 */
export function durationOf(windowStart: string, windowEnd: string): number {
  return windowMinutes({ windowStart, windowEnd });
}
