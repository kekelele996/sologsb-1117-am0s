import { useMemo, useState } from 'react'
import { Button, Card, Col, Radio, Row, Space, Table, Tag, Typography, message } from 'antd'
import dayjs from 'dayjs'
import type { BeeColony, Orchard, TransitRoute } from '@/types'
import { suggestColonyBoxes } from '@/types'
import { usePersistentStore } from '@/hooks/usePersistentStore'
import { orchardStore } from '@/stores/orchardStore'
import { colonyStore } from '@/stores/colonyStore'
import { droppointStore } from '@/stores/droppointStore'
import { routeStore } from '@/stores/routeStore'
import { reconcileSchedule } from '@/utils/reconcile'
import { downloadCsv, downloadJson } from '@/utils/export'
import { bloomDays } from '@/utils/geo'

interface ScheduleExportRow {
  orchard: string
  crop: string
  areaMu: number
  bloom: string
  days: number
  suggestBoxes: number
  dropCode: string
  colonyCode: string
  status: string
  dropWindow: string
  withdrawTime: string
  owner: string
}

interface ConflictExportRow {
  colonyCode: string
  orchardA: string
  dropA: string
  windowA: string
  orchardB: string
  dropB: string
  windowB: string
  days: number
  range: string
}

/** 导出授粉安排清单与转场路线表，并提供打印视图；占用与冲突均按台账对账结果 */
export default function ExportPage(): JSX.Element {
  const orchards = usePersistentStore(orchardStore, (state) => state.rows)
  const colonies = usePersistentStore(colonyStore, (state) => state.rows)
  const dropPoints = usePersistentStore(droppointStore, (state) => state.rows)
  const routes = usePersistentStore(routeStore, (state) => state.rows)
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('landscape')

  const orchardName = (id: string): string => orchards.find((item) => item.id === id)?.name ?? '未知地块'

  /** 台账对账：导出与冲突汇总的唯一口径 */
  const reconciled = useMemo(
    () => reconcileSchedule(orchards, colonies, dropPoints, routes),
    [orchards, colonies, dropPoints, routes]
  )
  const { placements, pending, conflicts } = reconciled

  /** 授粉安排清单：已确认占用 + 退回待确认计划 + 空点待分配 + 未安排地块 */
  const scheduleRows = useMemo<ScheduleExportRow[]>(() => {
    const rows: ScheduleExportRow[] = []
    const baseOf = (orchard: Orchard) => ({
      orchard: orchard.name,
      crop: orchard.crop,
      areaMu: orchard.areaMu,
      bloom: `${orchard.bloomStart} ~ ${orchard.bloomEnd}`,
      days: bloomDays(orchard),
      suggestBoxes: suggestColonyBoxes(orchard)
    })

    placements.forEach((placement) => {
      const orchard = orchards.find((item) => item.id === placement.orchardId)
      if (!orchard) return
      const point = dropPoints.find((item) => item.id === placement.dropId)
      rows.push({
        ...baseOf(orchard),
        dropCode: placement.dropCode,
        colonyCode: placement.colonyCode,
        status: '已确认',
        dropWindow: placement.start,
        withdrawTime: placement.end,
        owner: point?.owner || '—'
      })
    })

    pending.forEach((plan) => {
      const orchard = orchards.find((item) => item.id === plan.orchardId)
      if (!orchard) return
      rows.push({
        ...baseOf(orchard),
        dropCode: plan.dropCode,
        colonyCode: plan.colonyCode,
        status: '待确认',
        dropWindow: plan.dropWindow,
        withdrawTime: plan.withdrawTime,
        owner: plan.owner || '—'
      })
    })

    dropPoints
      .filter((point) => point.colonyCodes.length === 0)
      .forEach((point) => {
        const orchard = orchards.find((item) => item.id === point.orchardId)
        if (!orchard) return
        rows.push({
          ...baseOf(orchard),
          dropCode: point.code,
          colonyCode: '待分配',
          status: '待分配',
          dropWindow: point.dropWindow,
          withdrawTime: point.withdrawTime,
          owner: point.owner || '—'
        })
      })

    orchards.forEach((orchard) => {
      const hasRow = rows.some((row) => row.orchard === orchard.name)
      if (!hasRow) {
        rows.push({
          ...baseOf(orchard),
          dropCode: '—',
          colonyCode: '—',
          status: '未安排',
          dropWindow: '—',
          withdrawTime: '—',
          owner: '—'
        })
      }
    })
    return rows
  }, [orchards, dropPoints, placements, pending])

  const conflictRows = useMemo<ConflictExportRow[]>(
    () =>
      conflicts.map((item) => ({
        colonyCode: item.colonyCode,
        orchardA: orchardName(item.a.orchardId),
        dropA: item.a.dropCode,
        windowA: `${item.a.start} ~ ${item.a.end}`,
        orchardB: orchardName(item.b.orchardId),
        dropB: item.b.dropCode,
        windowB: `${item.b.start} ~ ${item.b.end}`,
        days: item.days,
        range: item.range
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conflicts, orchards]
  )

  const routeRows = useMemo(
    () =>
      routes.map((route: TransitRoute) => {
        const from = dropPoints.find((item) => item.id === route.fromDropId)
        const to = dropPoints.find((item) => item.id === route.toDropId)
        return {
          from: from ? `${from.code}（${orchardName(from.orchardId)}）` : '—',
          to: to ? `${to.code}（${orchardName(to.orchardId)}）` : '—',
          distanceKm: route.distanceKm,
          durationH: route.durationH,
          vehicleType: route.vehicleType,
          departAt: route.departAt,
          riskNote: route.riskNote || '—',
          actualNote: route.actualNote || '—'
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routes, dropPoints, orchards]
  )

  function exportSchedule(): void {
    downloadCsv('授粉安排清单.csv', scheduleRows as unknown as Record<string, unknown>[], [
      { key: 'orchard', label: '地块' },
      { key: 'crop', label: '作物' },
      { key: 'areaMu', label: '面积(亩)' },
      { key: 'bloom', label: '盛花期' },
      { key: 'days', label: '花期天数' },
      { key: 'suggestBoxes', label: '建议箱数' },
      { key: 'dropCode', label: '投放点' },
      { key: 'colonyCode', label: '群号' },
      { key: 'status', label: '对账状态' },
      { key: 'dropWindow', label: '投放时间窗' },
      { key: 'withdrawTime', label: '撤场时间' },
      { key: 'owner', label: '责任人' }
    ])
    message.success('授粉安排清单已按台账对账结果导出')
  }

  function exportRoutes(): void {
    downloadCsv('转场路线表.csv', routeRows as unknown as Record<string, unknown>[], [
      { key: 'from', label: '出发投放点' },
      { key: 'to', label: '到达投放点' },
      { key: 'distanceKm', label: '里程(km)' },
      { key: 'durationH', label: '预计耗时(h)' },
      { key: 'vehicleType', label: '车辆' },
      { key: 'departAt', label: '出发时刻' },
      { key: 'riskNote', label: '途中风险' },
      { key: 'actualNote', label: '实际记录' }
    ])
    message.success('转场路线表已导出')
  }

  function exportBackup(): void {
    downloadJson('gbbeeroute-backup.json', {
      exportedAt: new Date().toISOString(),
      orchards,
      colonies,
      dropPoints,
      routes
    })
    message.success('全量数据已导出为 JSON 备份')
  }

  return (
    <div className="page">
      <style>{`@page { size: A4 ${orientation}; margin: 10mm; }`}</style>
      <div className="page-head">
        <div>
          <h2 className="page-title">导出与打印</h2>
          <p className="page-sub">
            占用与冲突一律按蜂群台账对账结果：已确认占用、退回待确认的计划分别标注，转场中的群只计到达的新地块。可导出清单 / 路线表或直接打印现场交底。
          </p>
        </div>
        <Space>
          <Radio.Group value={orientation} onChange={(event) => setOrientation(event.target.value)}>
            <Radio.Button value="portrait">纵向打印</Radio.Button>
            <Radio.Button value="landscape">横向打印</Radio.Button>
          </Radio.Group>
          <Button onClick={() => window.print()}>打印视图</Button>
        </Space>
      </div>

      <Card size="small">
        <Space wrap>
          <Button type="primary" onClick={exportSchedule}>
            导出授粉安排清单（CSV）
          </Button>
          <Button onClick={exportRoutes}>导出转场路线表（CSV）</Button>
          <Button onClick={exportBackup}>导出全量 JSON 备份</Button>
          <Tag>地块 {orchards.length}</Tag>
          <Tag>蜂群 {colonies.length}</Tag>
          <Tag>投放点 {dropPoints.length}</Tag>
          <Tag>路线 {routes.length}</Tag>
          <Tag color="green">已确认占用 {placements.length}</Tag>
          <Tag color="orange">待确认计划 {pending.length}</Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            生成时间 {dayjs().format('YYYY-MM-DD HH:mm')}
          </Typography.Text>
        </Space>
      </Card>

      <div className={orientation === 'landscape' ? 'print-landscape' : 'print-portrait'}>
        <Card size="small" title={`授粉安排清单（${scheduleRows.length} 行，按台账对账）`} style={{ marginBottom: 16 }}>
          <Table<ScheduleExportRow>
            dataSource={scheduleRows}
            rowKey={(record, index) => `${record.orchard}-${record.dropCode}-${record.colonyCode}-${index ?? 0}`}
            size="small"
            pagination={false}
            columns={[
              { title: '地块', dataIndex: 'orchard', key: 'orchard' },
              { title: '作物', dataIndex: 'crop', key: 'crop', width: 80 },
              { title: '面积(亩)', dataIndex: 'areaMu', key: 'area', width: 90 },
              { title: '盛花期', dataIndex: 'bloom', key: 'bloom' },
              { title: '天数', dataIndex: 'days', key: 'days', width: 70 },
              { title: '建议箱数', dataIndex: 'suggestBoxes', key: 'suggest', width: 90 },
              { title: '投放点', dataIndex: 'dropCode', key: 'drop', width: 90 },
              { title: '群号', dataIndex: 'colonyCode', key: 'colony', width: 90 },
              {
                title: '对账状态',
                dataIndex: 'status',
                key: 'status',
                width: 90,
                render: (value: string) =>
                  value === '已确认' ? (
                    <Tag color="green">{value}</Tag>
                  ) : value === '待确认' ? (
                    <Tag color="orange">{value}</Tag>
                  ) : (
                    <Tag>{value}</Tag>
                  )
              },
              { title: '投放时间窗', dataIndex: 'dropWindow', key: 'window', width: 110 },
              { title: '撤场时间', dataIndex: 'withdrawTime', key: 'withdraw', width: 110 },
              { title: '责任人', dataIndex: 'owner', key: 'owner', width: 90 }
            ]}
          />
        </Card>

        <Card
          size="small"
          title={conflictRows.length > 0 ? `冲突汇总（${conflictRows.length} 处，按台账对账）` : '冲突汇总（按台账对账：无冲突）'}
          style={{ marginBottom: 16 }}
        >
          {conflictRows.length > 0 ? (
            <Table<ConflictExportRow>
              dataSource={conflictRows}
              rowKey={(record, index) => `${record.colonyCode}-${index ?? 0}`}
              size="small"
              pagination={false}
              columns={[
                { title: '群号', dataIndex: 'colonyCode', key: 'colony', width: 90 },
                { title: '地块 A', dataIndex: 'orchardA', key: 'oa' },
                { title: '投放点 A', dataIndex: 'dropA', key: 'da', width: 100 },
                { title: '占用窗 A', dataIndex: 'windowA', key: 'wa', width: 200 },
                { title: '地块 B', dataIndex: 'orchardB', key: 'ob' },
                { title: '投放点 B', dataIndex: 'dropB', key: 'db', width: 100 },
                { title: '占用窗 B', dataIndex: 'windowB', key: 'wb', width: 200 },
                { title: '重叠天数', dataIndex: 'days', key: 'days', width: 90 },
                { title: '重叠区间', dataIndex: 'range', key: 'range', width: 200 }
              ]}
            />
          ) : (
            <Typography.Text type="secondary">对账后每群同一时间只落一块地，当前无重叠花期冲突。</Typography.Text>
          )}
        </Card>

        <Card size="small" title={`转场路线表（${routeRows.length} 段）`}>
          <Table
            dataSource={routeRows}
            rowKey={(record, index) => `${record.from}-${record.to}-${index ?? 0}`}
            size="small"
            pagination={false}
            columns={[
              { title: '出发投放点', dataIndex: 'from', key: 'from' },
              { title: '到达投放点', dataIndex: 'to', key: 'to' },
              { title: '里程(km)', dataIndex: 'distanceKm', key: 'km', width: 100 },
              { title: '耗时(h)', dataIndex: 'durationH', key: 'hour', width: 90 },
              { title: '车辆', dataIndex: 'vehicleType', key: 'vehicle', width: 100 },
              { title: '出发时刻', dataIndex: 'departAt', key: 'depart' },
              { title: '途中风险', dataIndex: 'riskNote', key: 'risk' }
            ]}
          />
        </Card>
      </div>

      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Card size="small" title="蜂群投放一览（按群号，对账后）">
            <Space direction="vertical">
              {colonies.map((colony: BeeColony) => {
                const confirmed = placements.filter((item) => item.colonyCode === colony.code)
                const pendingFor = pending.filter((item) => item.colonyCode === colony.code)
                return (
                  <Typography.Text key={colony.id}>
                    <Tag color="cyan">{colony.code}</Tag>
                    {colony.species} · {colony.strengthFrames} 足框 ·{' '}
                    {confirmed.length > 0
                      ? confirmed.map((item) => `${item.dropCode}@${orchardName(item.orchardId)}`).join('、')
                      : '无已确认占用'}
                    {pendingFor.length > 0 ? (
                      <span style={{ marginLeft: 6 }}>
                        {pendingFor.map((item) => (
                          <Tag key={`${item.dropPointId}-${item.colonyCode}`} color="orange">
                            待确认 {item.dropCode}@{orchardName(item.orchardId)}
                          </Tag>
                        ))}
                      </span>
                    ) : null}
                  </Typography.Text>
                )
              })}
            </Space>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card size="small" title="导出说明">
            <Typography.Paragraph style={{ fontSize: 13, marginBottom: 6 }}>
              1. 授粉安排清单按「台账对账结果」展开：已确认为实际占用，待确认为与台账不符、被顶掉的投放点计划，不计占用；
            </Typography.Paragraph>
            <Typography.Paragraph style={{ fontSize: 13, marginBottom: 6 }}>
              2. 转场中的蜂群只认到达的新地块，出发地花期视为无人覆盖；冲突汇总只在已确认占用之间判定；
            </Typography.Paragraph>
            <Typography.Paragraph style={{ fontSize: 13, marginBottom: 6 }}>
              3. 转场路线表包含里程、耗时、车辆与风险备注，实际执行情况可在“转场路线规划”页回填；
            </Typography.Paragraph>
            <Typography.Paragraph style={{ fontSize: 13, marginBottom: 0 }}>
              4. 点击「打印视图」后再选择打印机或另存 PDF；数据全部来自浏览器本地 IndexedDB。
            </Typography.Paragraph>
          </Card>
        </Col>
      </Row>
    </div>
  )
}
