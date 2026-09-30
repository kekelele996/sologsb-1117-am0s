import type { BeeColony, DropPoint, Orchard, TransitRoute } from '@/types'
import { flowerWindowOverlap } from '@/utils/geo'

/** 投放点安排的对账状态：已投放（有效占用） / 待确认（计划被顶掉，不计入占用） */
export type AssignmentStatus = 'active' | 'pending'

/** 待确认原因（用于界面提示） */
export type PendingReason =
  | 'superseded' // 被顶掉：蜂群实际已在其他地块
  | 'transit-origin' // 转场出发地：只认新地块，出发地花期无人覆盖
  | 'deploying' // 待投放：尚未落场
  | 'returned' // 回场：已撤出授粉
  | 'orphan' // 群号在台账中不存在

/** 对账后的有效占用（参与冲突判定与汇总） */
export interface ReconciledPlacement {
  colonyCode: string
  orchardId: string
  dropCode: string
  start: string
  end: string
  /** 占用来源：drop=投放点安排，ledger=台账当前所在（未设投放点） */
  source: 'drop' | 'ledger'
}

/** 待确认的投放点计划 */
export interface PendingAssignment {
  colonyCode: string
  dropPointId: string
  dropCode: string
  orchardId: string
  reason: PendingReason
}

/** 冲突项：同一蜂群同一时间落两块地 */
export interface ReconciledConflict {
  colonyCode: string
  a: ReconciledPlacement
  b: ReconciledPlacement
  days: number
  range: string
}

export interface ReconcileResult {
  /** 有效占用（一群同一时间只落一块地） */
  placements: ReconciledPlacement[]
  /** 待确认的投放点计划（被顶掉 / 待投放 / 回场 / 出发地） */
  pending: PendingAssignment[]
  /** 真实冲突（对账后仍一双占地的情况） */
  conflicts: ReconciledConflict[]
}

const PENDING_REASON_TEXT: Record<PendingReason, string> = {
  superseded: '被顶掉（蜂群实际已在其他地块）',
  'transit-origin': '转场出发地（只认新地块，出发地花期无人覆盖）',
  deploying: '待投放（尚未落场）',
  returned: '回场（已撤出授粉）',
  orphan: '群号在台账中不存在'
}

export function pendingReasonText(reason: PendingReason): string {
  return PENDING_REASON_TEXT[reason]
}

interface Assign {
  point: DropPoint
}

/**
 * 台账对账：以蜂群台账的实际所在地为准，把投放点安排对账成「有效占用」。
 * 约定：每个群同一时间只落一块地；转场中的只认新地块（出发地花期无人覆盖）；
 * 被顶掉的投放点计划退回待确认，不计入占用与冲突。
 */
export function reconcileOccupancy(
  colonies: BeeColony[],
  dropPoints: DropPoint[],
  orchards: Orchard[],
  routes: TransitRoute[]
): ReconcileResult {
  const orchardById = new Map(orchards.map((item) => [item.id, item]))
  const colonyByCode = new Map(colonies.map((item) => [item.code, item]))

  const assignmentsByColony = new Map<string, Assign[]>()
  dropPoints.forEach((point) => {
    point.colonyCodes.forEach((code) => {
      const list = assignmentsByColony.get(code) ?? []
      list.push({ point })
      assignmentsByColony.set(code, list)
    })
  })

  const placements: ReconciledPlacement[] = []
  const pending: PendingAssignment[] = []

  const pushPending = (code: string, assign: Assign, reason: PendingReason): void => {
    pending.push({
      colonyCode: code,
      dropPointId: assign.point.id,
      dropCode: assign.point.code,
      orchardId: assign.point.orchardId,
      reason
    })
  }

  colonies.forEach((colony) => {
    const assigns = assignmentsByColony.get(colony.code) ?? []

    if (colony.status === '待投放') {
      assigns.forEach((assign) => pushPending(colony.code, assign, 'deploying'))
      return
    }
    if (colony.status === '回场') {
      assigns.forEach((assign) => pushPending(colony.code, assign, 'returned'))
      return
    }

    if (colony.status === '转场中') {
      // 转场中的到新地块才改：只认新地块，出发地花期没人覆盖
      const destination = resolveTransitDestination(colony, assigns, dropPoints, routes)
      assigns.forEach((assign) => {
        if (destination && assign.point.orchardId === destination) {
          placements.push(toDropPlacement(colony.code, assign))
        } else if (colony.currentOrchardId && assign.point.orchardId === colony.currentOrchardId) {
          pushPending(colony.code, assign, 'transit-origin')
        } else {
          pushPending(colony.code, assign, 'superseded')
        }
      })
      return
    }

    // 在园：台账所在地块即有效占用，投放点安排须与台账一致，否则视为被顶掉
    const effective = colony.currentOrchardId
    assigns.forEach((assign) => {
      if (effective && assign.point.orchardId === effective) {
        placements.push(toDropPlacement(colony.code, assign))
      } else {
        pushPending(colony.code, assign, 'superseded')
      }
    })
    // 台账兜底：在园但未在该地块设投放点，仍按台账所在地计入占用
    if (effective && orchardById.has(effective)) {
      const covered = placements.some((item) => item.colonyCode === colony.code && item.orchardId === effective)
      if (!covered) {
        const orchard = orchardById.get(effective)
        if (orchard) {
          placements.push({
            colonyCode: colony.code,
            orchardId: effective,
            dropCode: '（当前所在）',
            start: orchard.bloomStart,
            end: orchard.bloomEnd,
            source: 'ledger'
          })
        }
      }
    }
  })

  // 台账里没有的群号（投放点误填）→ 待确认
  assignmentsByColony.forEach((assigns, code) => {
    if (colonyByCode.has(code)) return
    assigns.forEach((assign) => pushPending(code, assign, 'orphan'))
  })

  const conflicts = computeConflicts(placements)
  return { placements, pending, conflicts }
}

function toDropPlacement(code: string, assign: Assign): ReconciledPlacement {
  return {
    colonyCode: code,
    orchardId: assign.point.orchardId,
    dropCode: assign.point.code,
    start: assign.point.dropWindow,
    end: assign.point.withdrawTime,
    source: 'drop'
  }
}

/**
 * 转场中只认新地块：优先走转场路线到达的地块；否则取投放窗最新的安排（新计划顶掉旧计划）。
 */
function resolveTransitDestination(
  colony: BeeColony,
  assigns: Assign[],
  dropPoints: DropPoint[],
  routes: TransitRoute[]
): string {
  const origin = colony.currentOrchardId
  const candidates = assigns.filter((item) => item.point.orchardId !== origin)
  if (candidates.length === 0) return ''

  if (origin) {
    const originDropIds = new Set(dropPoints.filter((item) => item.orchardId === origin).map((item) => item.id))
    const routed = routes.find(
      (route) => originDropIds.has(route.fromDropId) && candidates.some((item) => item.point.id === route.toDropId)
    )
    if (routed) {
      const target = candidates.find((item) => item.point.id === routed.toDropId)
      if (target) return target.point.orchardId
    }
  }

  const sorted = [...candidates].sort(
    (a, b) => b.point.dropWindow.localeCompare(a.point.dropWindow) || a.point.code.localeCompare(b.point.code)
  )
  return sorted[0].point.orchardId
}

/** 由有效占用计算冲突：同一蜂群同一天落两个地块（花期交集≥1 天） */
function computeConflicts(placements: ReconciledPlacement[]): ReconciledConflict[] {
  const result: ReconciledConflict[] = []
  const codes = Array.from(new Set(placements.map((item) => item.colonyCode)))
  codes.forEach((code) => {
    const list = placements.filter((item) => item.colonyCode === code)
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (list[i].orchardId === list[j].orchardId) continue
        const overlap = flowerWindowOverlap(list[i].start, list[i].end, list[j].start, list[j].end)
        if (overlap.overlap) {
          result.push({ colonyCode: code, a: list[i], b: list[j], days: overlap.days, range: overlap.range })
        }
      }
    }
  })
  return result
}
