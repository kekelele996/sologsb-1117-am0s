import type { BeeColony, DropPoint, Orchard, TransitRoute } from '@/types'
import { flowerWindowOverlap } from '@/utils/geo'

/** 对账后的群占用：同一时间每群只落一块地（唯一占用口径） */
export interface ReconciledPlacement {
  colonyCode: string
  orchardId: string
  /** 实际占用的投放点；无计划点时为空串，表示只在台账中有地块记录 */
  dropId: string
  dropCode: string
  start: string
  end: string
  /** 占用来自台账的哪种状态 */
  kind: '在园' | '转场中'
}

/** 被顶掉、退回待确认的投放点计划（不计占用、不算冲突） */
export interface PendingPlan {
  colonyCode: string
  dropPointId: string
  dropCode: string
  orchardId: string
  dropWindow: string
  withdrawTime: string
  owner: string
  /** 退回原因 */
  reason: string
}

export interface ReconcileConflict {
  colonyCode: string
  a: ReconciledPlacement
  b: ReconciledPlacement
  days: number
  range: string
}

export interface ReconcileResult {
  /** 已确认占用（总表占用、冲突判定、导出都按它算） */
  placements: ReconciledPlacement[]
  /** 被顶掉、退回待确认的投放点计划 */
  pending: PendingPlan[]
  /** 仅在已确认占用之间检出的冲突 */
  conflicts: ReconcileConflict[]
}

interface Occupancy {
  colonyCode: string
  orchardId: string
  kind: '在园' | '转场中'
}

/**
 * 解析一群蜂当前唯一的实际占用地块。
 * - 在园：以台账「当前所在地块」为准；
 * - 转场中：只认新地块（到达点），出发地不再占用（其花期视为无人覆盖）；
 *   新地块优先由转场路线的到达投放点确定，路线不明确时取计划中唯一的非出发地块；
 * - 待投放 / 回场 / 地块无效：无占用。
 */
function resolveOccupancy(
  colony: BeeColony,
  orchardById: Map<string, Orchard>,
  dropPoints: DropPoint[],
  dropById: Map<string, DropPoint>,
  routes: TransitRoute[]
): Occupancy | null {
  if (colony.status === '在园') {
    const orchardId = colony.currentOrchardId
    if (!orchardId || !orchardById.has(orchardId)) return null
    return { colonyCode: colony.code, orchardId, kind: '在园' }
  }

  if (colony.status === '转场中') {
    const plannedDropIds = new Set(dropPoints.filter((point) => point.colonyCodes.includes(colony.code)).map((point) => point.id))
    const viaRoute = routes.find((route) => plannedDropIds.has(route.fromDropId))
    if (viaRoute) {
      const target = dropById.get(viaRoute.toDropId)
      if (target && orchardById.has(target.orchardId)) {
        return { colonyCode: colony.code, orchardId: target.orchardId, kind: '转场中' }
      }
    }
    const candidateOrchards = Array.from(
      new Set(
        dropPoints
          .filter((point) => point.colonyCodes.includes(colony.code) && point.orchardId !== colony.currentOrchardId)
          .map((point) => point.orchardId)
      )
    ).filter((id) => orchardById.has(id))
    if (candidateOrchards.length === 1) {
      return { colonyCode: colony.code, orchardId: candidateOrchards[0], kind: '转场中' }
    }
    return null
  }

  return null
}

/**
 * 台账对账：以蜂群台账（技术员记录的实际所在地）为唯一权威，核对调度在投放点上安排的群号。
 *
 * 计划点地块与群对账后地块一致 → 已确认占用；不一致 → 计划被顶掉、退回待确认。
 * 占用、冲突汇总、导出统一使用本结果，避免同一群被出发地与新地块两头计数。
 */
export function reconcileSchedule(
  orchards: Orchard[],
  colonies: BeeColony[],
  dropPoints: DropPoint[],
  routes: TransitRoute[]
): ReconcileResult {
  const orchardById = new Map(orchards.map((orchard) => [orchard.id, orchard]))
  const dropById = new Map(dropPoints.map((point) => [point.id, point]))
  const colonyByCode = new Map(colonies.map((colony) => [colony.code, colony]))

  // 1) 每群只解析出一个实际占用地块
  const occupancyByCode = new Map<string, Occupancy>()
  colonies.forEach((colony) => {
    const occupancy = resolveOccupancy(colony, orchardById, dropPoints, dropById, routes)
    if (occupancy) occupancyByCode.set(colony.code, occupancy)
  })

  // 2) 已确认占用：优先落在与对账地块一致的已计划投放点上，否则用台账地块花期占位
  const placements: ReconciledPlacement[] = []
  const chosenDropByCode = new Map<string, DropPoint>()
  Array.from(occupancyByCode.values())
    .sort((a, b) => a.colonyCode.localeCompare(b.colonyCode, 'zh-Hans-CN'))
    .forEach((occupancy) => {
      const orchard = orchardById.get(occupancy.orchardId)
      if (!orchard) return
      const planned = dropPoints.find((point) => point.orchardId === occupancy.orchardId && point.colonyCodes.includes(occupancy.colonyCode))
      if (planned) chosenDropByCode.set(occupancy.colonyCode, planned)
      placements.push({
        colonyCode: occupancy.colonyCode,
        orchardId: occupancy.orchardId,
        dropId: planned?.id ?? '',
        dropCode: planned?.code ?? '（台账所在）',
        start: planned ? planned.dropWindow : orchard.bloomStart,
        end: planned ? planned.withdrawTime : orchard.bloomEnd,
        kind: occupancy.kind
      })
    })

  // 3) 逐投放点计划对账：不符的退回待确认
  const pending: PendingPlan[] = []
  const pushPending = (point: DropPoint, code: string, reason: string): void => {
    pending.push({
      colonyCode: code,
      dropPointId: point.id,
      dropCode: point.code,
      orchardId: point.orchardId,
      dropWindow: point.dropWindow,
      withdrawTime: point.withdrawTime,
      owner: point.owner,
      reason
    })
  }

  dropPoints.forEach((point) => {
    point.colonyCodes.forEach((code) => {
      const occupancy = occupancyByCode.get(code)
      if (occupancy && occupancy.orchardId === point.orchardId) {
        // 同一地块同群被排到多个投放点时，只保留一个点，其余退回待确认
        const chosen = chosenDropByCode.get(code)
        if (chosen && chosen.id !== point.id) {
          pushPending(point, code, '同一地块内重复安排该群，已按对账保留首个投放点，其余计划退回待确认')
        }
        return
      }

      const colony = colonyByCode.get(code)
      let reason: string
      if (!colony) {
        reason = `台账中无蜂群「${code}」，计划退回待确认`
      } else if (colony.status === '转场中') {
        reason = '蜂群转场中、只认到达的新地块；该出发地（或非到达点）花期无人覆盖，计划退回待确认'
      } else if (colony.status === '待投放' || colony.status === '回场' || !colony.currentOrchardId) {
        reason = `台账状态为「${colony.status}」，无实际在园地块，计划退回待确认`
      } else {
        const actualName = orchardById.get(colony.currentOrchardId)?.name ?? '其它地块'
        reason = `台账记录蜂群实际在「${actualName}」，已从本投放点撤走，计划退回待确认`
      }
      pushPending(point, code, reason)
    })
  })
  pending.sort((a, b) =>
    a.dropCode.localeCompare(b.dropCode, 'zh-Hans-CN') || a.colonyCode.localeCompare(b.colonyCode, 'zh-Hans-CN')
  )

  // 4) 冲突只在已确认占用之间判；每群同时间只落一块地，双算不会再误报
  const conflicts: ReconcileConflict[] = []
  for (let i = 0; i < placements.length; i += 1) {
    for (let j = i + 1; j < placements.length; j += 1) {
      const a = placements[i]
      const b = placements[j]
      if (a.colonyCode !== b.colonyCode || a.orchardId === b.orchardId) continue
      const overlap = flowerWindowOverlap(a.start, a.end, b.start, b.end)
      if (overlap.overlap) {
        conflicts.push({ colonyCode: a.colonyCode, a, b, days: overlap.days, range: overlap.range })
      }
    }
  }

  return { placements, pending, conflicts }
}
