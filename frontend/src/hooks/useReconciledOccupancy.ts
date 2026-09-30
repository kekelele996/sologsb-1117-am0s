import { useMemo } from 'react'
import { usePersistentStore } from '@/hooks/usePersistentStore'
import { orchardStore } from '@/stores/orchardStore'
import { colonyStore } from '@/stores/colonyStore'
import { droppointStore } from '@/stores/droppointStore'
import { routeStore } from '@/stores/routeStore'
import { reconcileOccupancy, type ReconcileResult } from '@/utils/reconcile'

/**
 * 总表占用按台账对账后的结果：有效占用 + 待确认投放点计划 + 真实冲突。
 * SchedulePage 的冲突汇总与 ExportPage 的导出都以这份对账结果为准。
 */
export function useReconciledOccupancy(): ReconcileResult {
  const orchards = usePersistentStore(orchardStore, (state) => state.rows)
  const colonies = usePersistentStore(colonyStore, (state) => state.rows)
  const dropPoints = usePersistentStore(droppointStore, (state) => state.rows)
  const routes = usePersistentStore(routeStore, (state) => state.rows)

  return useMemo(
    () => reconcileOccupancy(colonies, dropPoints, orchards, routes),
    [colonies, dropPoints, orchards, routes]
  )
}
